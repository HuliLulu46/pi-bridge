import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, test } from "node:test";
import { piCalls, run, runAsync, sessionIdOf, setup } from "./helpers.ts";

let home: string;
let work: string;

beforeEach(() => {
  ({ home, work } = setup());
});

test("首次 send 创建会话，之后在任意目录 send 都以会话名作为 session-id 并复用 cwd", () => {
  const first = run(["send", "s1", "hello"]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, "echo:hello\n");

  const second = run(["send", "s1", "again"], { cwd: home });
  assert.equal(second.code, 0, second.stderr);

  const [a, b] = piCalls();
  assert.equal(sessionIdOf(a!.argv), "s1");
  assert.equal(sessionIdOf(b!.argv), "s1");
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

test("消息为 - 时从 stdin 读取；不接受透传的 pi 参数", () => {
  const result = run(["send", "s1", "-"], { input: "from stdin" });
  assert.equal(result.stdout, "echo:from stdin\n");
  assert.deepEqual(piCalls()[0]!.argv.slice(-2), ["--", "from stdin"]);

  const rejected = run(["send", "s1", "hi", "--", "--tools", "bash"]);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /不支持透传 pi 参数/);
  assert.equal(piCalls().length, 1);
});

test("缺省以 advisor 运行：print 模式、只读参数，--model 与 --thinking 按次拼接", () => {
  const result = run(["send", "s1", "--model", "m1", "--thinking", "low", "hello"]);
  assert.equal(result.code, 0, result.stderr);
  const argv = piCalls()[0]!.argv;
  assert.ok(argv.includes("-p"));
  assert.deepEqual(argv.slice(argv.indexOf("--no-extensions"), argv.indexOf("--no-extensions") + 3), [
    "--no-extensions",
    "--tools",
    "read,grep,find,ls",
  ]);
  assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 4), ["--model", "m1", "--thinking", "low"]);

  run(["send", "s1", "--role", "advisor", "again"]);
  assert.ok(!piCalls()[1]!.argv.includes("--model"));
});

test("--role 只接受 advisor 或 executor", () => {
  const result = run(["send", "s1", "--role", "boss", "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--role 只能是 advisor 或 executor/);
  assert.equal(run(["list"]).stdout, "（没有会话）\n");
});

test("同一会话运行中再次 send 会被锁拒绝", async () => {
  const slow = runAsync(["send", "s1", "slow"]);
  await sleep(500);
  const blocked = run(["send", "s1", "hi"]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /正被占用/);
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

test("watch 不会把上一次运行的日志当成本次结果（拿到锁与重写日志之间的空档）", async () => {
  assert.equal(run(["send", "s1", "hello"]).code, 0);
  await sleep(20);
  // 模拟新的 send 刚拿到锁、还没重写日志：日志里仍是上一次运行的结束标记
  const lock = join(home, "locks", "s1.lock");
  writeFileSync(lock, String(process.pid));
  const watched = runAsync(["watch", "s1"]);
  await sleep(700);
  writeFileSync(join(home, "logs", "s1.log"), "[start] new run\n[reply]\necho:new\n[done]\n");
  const result = await watched;
  rmSync(lock);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /echo:hello/);
  assert.match(result.stdout, /echo:new/);
});

test("watch 跟随到失败任务时以 [failed] 结束", () => {
  run(["send", "s1", "fail"]);
  const result = run(["watch", "s1"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\[failed\]/);
});

test("list 列出会话，rm 后同名 send 续接同一 session-id", () => {
  run(["send", "s1", "hello"]);
  assert.match(run(["list"]).stdout, /^s1\tidle\t.*\ts1$/m);

  const removed = run(["rm", "s1"]);
  assert.equal(removed.code, 0);
  assert.match(removed.stdout, /同名再 send 会续接/);
  assert.equal(run(["list"]).stdout, "（没有会话）\n");

  run(["send", "s1", "hello"]);
  const [a, b] = piCalls();
  assert.equal(sessionIdOf(a!.argv), "s1");
  assert.equal(sessionIdOf(b!.argv), "s1");
});

test("含 id 字段的旧记录以该 id 作为 session-id", () => {
  const id = "4c42ca73-2913-487d-81f4-525b8d8f6d62";
  const now = new Date().toISOString();
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(
    join(home, "sessions", "old.json"),
    JSON.stringify({ name: "old", id, cwd: work, createdAt: now, updatedAt: now }),
  );

  const result = run(["send", "old", "hello"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(sessionIdOf(piCalls()[0]!.argv), id);
  assert.match(run(["list"]).stdout, new RegExp(`^old\\tidle\\t.*\\t${id}$`, "m"));
});
