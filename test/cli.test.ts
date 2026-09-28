import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

let home: string;
let work: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-bridge-home-")));
  work = realpathSync(mkdtempSync(join(tmpdir(), "pi-bridge-work-")));
});

function env(): NodeJS.ProcessEnv {
  return { ...process.env, PI_BIN: FAKE_PI, PI_BRIDGE_HOME: home, FAKE_PI_CALLS: join(home, "calls.jsonl") };
}

function run(args: string[], opts: { input?: string; cwd?: string } = {}): Result {
  const result = spawnSync("node", [CLI, ...args], { cwd: opts.cwd ?? work, env: env(), input: opts.input, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAsync(args: string[]): Promise<Result> {
  const child = spawn("node", [CLI, ...args], { cwd: work, env: env() });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

function piCalls(): Array<{ argv: string[]; cwd: string; subagent?: string }> {
  return readFileSync(join(home, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function sessionIdOf(argv: string[]): string | undefined {
  return argv[argv.indexOf("--session-id") + 1];
}

test("首次 send 创建会话，之后在任意目录 send 都复用同一 id 与 cwd", () => {
  const first = run(["send", "s1", "hello"]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, "echo:hello\n");

  const second = run(["send", "s1", "again"], { cwd: home });
  assert.equal(second.code, 0, second.stderr);

  const [a, b] = piCalls();
  assert.equal(sessionIdOf(a!.argv), sessionIdOf(b!.argv));
  assert.equal(a!.cwd, work);
  assert.equal(b!.cwd, work);
  assert.ok(a!.argv.includes("--name"));
  assert.ok(!b!.argv.includes("--name"));
  assert.equal(a!.subagent, "1");
});

test("--cwd 与已绑定目录不一致时拒绝", () => {
  run(["send", "s1", "hello"]);
  const result = run(["send", "s1", "--cwd", home, "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /绑定在/);
});

test("消息为 - 时从 stdin 读取，-- 之后的参数透传给 pi", () => {
  const result = run(["send", "s1", "-", "--", "--thinking", "low"], { input: "from stdin" });
  assert.equal(result.stdout, "echo:from stdin\n");
  assert.deepEqual(piCalls()[0]!.argv.slice(-4), ["--thinking", "low", "--", "from stdin"]);
});

test("同一会话运行中再次 send 会被锁拒绝", async () => {
  const slow = runAsync(["send", "s1", "slow"]);
  await sleep(500);
  const blocked = run(["send", "s1", "hi"]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /正在运行/);
  assert.equal((await slow).code, 0);
});

test("pi 启动失败时返回非零并带上 stderr", () => {
  const result = run(["send", "s1", "fail"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /boom/);
});

test("最后一条回复 stopReason 为 error 时返回非零", () => {
  const result = run(["send", "s1", "error"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /rate limited/);
});

test("pi 在 agent_settled 后不退出时被主动结束", () => {
  const started = Date.now();
  const result = run(["send", "s1", "hang"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "echo:hang\n");
  assert.ok(Date.now() - started < 10_000);
});

test("出错或被拦截的工具调用附在回复末尾", () => {
  const result = run(["send", "s1", "blocked"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1 次工具调用出错或被拦截/);
  assert.match(result.stdout, /- bash: Blocked: .*no UI is available/);
});

test("watch 跟随进度直到 [done]", async () => {
  run(["send", "s1", "hello"]);
  const slow = runAsync(["send", "s1", "slow"]);
  const watched = await runAsync(["watch", "s1"]);
  assert.equal(watched.code, 0);
  assert.match(watched.stdout, /\[reply\]\necho:slow\n\[done\]\n$/);
  assert.equal((await slow).code, 0);
});

test("watch 跟随到失败任务时以 [failed] 结束", () => {
  run(["send", "s1", "fail"]);
  const result = run(["watch", "s1"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\[failed\]/);
});

test("list 列出会话，rm 后再 send 会新建会话", () => {
  run(["send", "s1", "hello"]);
  assert.match(run(["list"]).stdout, /^s1\tidle\t/);

  assert.equal(run(["rm", "s1"]).code, 0);
  assert.equal(run(["list"]).stdout, "（没有会话）\n");

  run(["send", "s1", "hello"]);
  const [a, b] = piCalls();
  assert.notEqual(sessionIdOf(a!.argv), sessionIdOf(b!.argv));
});
