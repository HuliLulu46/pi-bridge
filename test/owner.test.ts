import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { initRepo, piCalls, run, sessionIdOf, setEnv, setup } from "./helpers.ts";

// 主会话归属：同名会话属于别的主会话时，后来者分出副本续接，不共用、不叠加
const A = "aaaaaa11-0000-0000-0000-000000000000";
const B = "bbbbbb22-0000-0000-0000-000000000000";
let home: string;
let work: string;

const json = (stdout: string): any => JSON.parse(stdout.trim().split("\n").at(-1)!);

function start(): void {
  ({ home, work } = setup());
  setEnv({ PI_CODING_AGENT_DIR: join(home, "pi-agent") });
}

/** 与 pi 的缺省会话目录规则一致 */
function piDir(): string {
  return join(home, "pi-agent", "sessions", `--${work.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/** 真 pi 第一次运行时建的会话文件；fake pi 不建，测试自己放 */
function seed(id: string): string {
  mkdirSync(piDir(), { recursive: true });
  const path = join(piDir(), `2026-11-17T00-00-00-000Z_${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: "2026-11-17T00:00:00.000Z", cwd: work };
  const message = { type: "message", id: "m1", parentId: null, message: { role: "user", content: "A 的上下文" } };
  writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
  return path;
}

async function waitIdle(name: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const row = json(run(["list", "--json"]).stdout).find((r: any) => r.name === name);
    if (row?.status === "idle" && row.lastRun?.status === "done") return;
    if (Date.now() > deadline) throw new Error("等待超时");
    await sleep(100);
  }
}

test("别的主会话 send 同名会话：分出副本、复制上下文，之后同名都进副本；原主会话照常续接", () => {
  start();
  assert.equal(run(["send", "s1", "--owner", A, "hello"]).code, 0);
  const source = seed("s1");

  const out = json(run(["send", "s1", "--owner", B, "--json", "hi"]).stdout);
  assert.equal(out.status, "done");
  assert.equal(out.session, "s1.bbbbbb");
  assert.equal(sessionIdOf(piCalls().at(-1)!.argv), "s1.bbbbbb");
  const forkFile = readdirSync(piDir()).find((f) => f.endsWith("_s1.bbbbbb.jsonl"))!;
  const lines = readFileSync(join(piDir(), forkFile), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].id, "s1.bbbbbb");
  assert.equal(lines[0].parentSession, source);
  assert.equal(lines[1].message.content, "A 的上下文");

  // B 再派：还是那份副本，不再分
  assert.equal(json(run(["send", "s1", "--owner", B, "--json", "again"]).stdout).session, "s1.bbbbbb");
  assert.equal(readdirSync(piDir()).filter((f) => f.includes("s1.bbbbbb")).length, 1);
  // A 照常续接原会话
  assert.equal(json(run(["send", "s1", "--owner", A, "--json", "more"]).stdout).session, "s1");

  const rows = json(run(["list", "--json"]).stdout);
  const fork = rows.find((r: any) => r.name === "s1.bbbbbb");
  assert.equal(fork.owner, B);
  assert.equal(fork.forkOf, "s1");
  assert.equal(rows.find((r: any) => r.name === "s1").owner, A);
});

test("无主的会话：第一个带 --owner 的主会话认领，不分副本；不带 --owner 的调用照旧", () => {
  start();
  run(["send", "s1", "hello"]);
  assert.equal(json(run(["list", "--json"]).stdout)[0].owner, undefined);
  assert.equal(json(run(["send", "s1", "--owner", A, "--json", "hi"]).stdout).session, "s1");
  assert.equal(json(run(["list", "--json"]).stdout)[0].owner, A);
  assert.equal(run(["send", "s1", "plain"]).stdout, "echo:plain\n");
});

test("别的主会话的会话正在运行：拒绝；结束后再派就分副本", async () => {
  start();
  run(["send", "s1", "--owner", A, "hello"]);
  seed("s1");
  assert.equal(run(["send", "s1", "--owner", A, "--detach", "slow"]).code, 0);
  const busy = run(["send", "s1", "--owner", B, "--json", "hi"]);
  assert.equal(busy.code, 1);
  assert.match(json(busy.stdout).error, /正在运行任务/);
  await waitIdle("s1");
  assert.equal(json(run(["send", "s1", "--owner", B, "--json", "hi"]).stdout).session, "s1.bbbbbb");
});

test("别的主会话的 worktree 会话不分副本；找不到 pi 会话文件也不分", () => {
  start();
  initRepo(work);
  assert.equal(run(["send", "w1", "--owner", A, "--worktree", "hello"]).code, 0);
  const wt = run(["send", "w1", "--owner", B, "--json", "hi"]);
  assert.equal(wt.code, 1);
  assert.match(json(wt.stdout).error, /worktree/);

  run(["send", "s1", "--owner", A, "hello"]);
  const missing = run(["send", "s1", "--owner", B, "--json", "hi"]);
  assert.equal(missing.code, 1);
  assert.match(json(missing.stdout).error, /找不到 pi 会话/);
});

test("steer、abort、stop、answer 不能作用于别的主会话的会话", () => {
  start();
  run(["send", "s1", "--owner", A, "hello"]);
  for (const args of [
    ["steer", "s1", "--owner", B, "--json", "x"],
    ["abort", "s1", "--owner", B, "--json"],
    ["stop", "s1", "--owner", B, "--json"],
    ["answer", "s1", "ask-1", "x", "--owner", B, "--json"],
  ]) {
    const r = run(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(json(r.stdout).error, /属于另一个主会话/);
  }
});

test("cwd 经过符号链接：按真实路径找 pi 会话目录（pi 也是这么建的），照样分出副本", () => {
  start();
  const link = join(home, "link-to-work");
  symlinkSync(work, link);
  assert.equal(run(["send", "s1", "--owner", A, "--cwd", link, "hello"]).code, 0);
  seed("s1");
  const out = json(run(["send", "s1", "--owner", B, "--json", "hi"]).stdout);
  assert.equal(out.status, "done", JSON.stringify(out));
  assert.equal(out.session, "s1.bbbbbb");
});

test("无主的会话正在跑：先不认领，等它结束后再认领", async () => {
  start();
  assert.equal(run(["send", "s1", "--detach", "slow"]).code, 0);
  const busy = run(["send", "s1", "--owner", A, "--json", "hi"]);
  assert.equal(busy.code, 1);
  assert.equal(json(run(["list", "--json"]).stdout)[0].owner, undefined);
  await waitIdle("s1");
  assert.equal(json(run(["send", "s1", "--owner", A, "--json", "hi"]).stdout).session, "s1");
  assert.equal(json(run(["list", "--json"]).stdout)[0].owner, A);
});
