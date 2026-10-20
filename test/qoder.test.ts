import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, test } from "node:test";
import { CLI, env, initRepo, piCalls, qoderCalls, qoderSessionIdOf, run, setEnv, setup } from "./helpers.ts";
import { createQoderRunTracker, isSessionIdConflict, nameToUuid, reasoningEffort } from "../plugins/pi-bridge/src/qoder.ts";

let home: string;
let work: string;

beforeEach(() => {
  ({ home, work } = setup({ PI_BRIDGE_ENGINE: "qoder" }));
});

test("advisor send 走 qoderclicn：stream-json、只读工具、session-id 为会话名派生的 UUID", () => {
  const result = run(["send", "s1", "hello"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "echo:hello\n");

  const [call] = qoderCalls();
  const argv = call!.argv;
  assert.equal(call!.cwd, work);
  assert.ok(argv.includes("-p"));
  assert.deepEqual(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2), [
    "--output-format",
    "stream-json",
  ]);
  assert.deepEqual(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 4), ["--tools", "Read", "Grep", "Glob"]);
  assert.deepEqual(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2), [
    "--permission-mode",
    "bypass_permissions",
  ]);
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.ok(argv.includes("--session-id"));
  assert.equal(qoderSessionIdOf(argv), nameToUuid("s1"));
  assert.deepEqual(argv.slice(-2), ["--", "hello"]);
});

test("同一会话第二次 send 用 --resume 续接同一 UUID", () => {
  assert.equal(run(["send", "s1", "hello"]).code, 0);
  assert.equal(run(["send", "s1", "again"]).code, 0);
  const [a, b] = qoderCalls();
  assert.ok(a!.argv.includes("--session-id"));
  assert.ok(!a!.argv.includes("--resume"));
  assert.ok(b!.argv.includes("--resume"));
  assert.equal(qoderSessionIdOf(a!.argv), nameToUuid("s1"));
  assert.equal(qoderSessionIdOf(b!.argv), nameToUuid("s1"));
});

test("--model 透传、--thinking 映射为 qoderclicn 的 --reasoning-effort", () => {
  run(["send", "s1", "--model", "m1", "--thinking", "high", "hello"]);
  const argv = qoderCalls()[0]!.argv;
  assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2), ["--model", "m1"]);
  assert.ok(!argv.includes("--thinking"));
  assert.deepEqual(argv.slice(argv.indexOf("--reasoning-effort"), argv.indexOf("--reasoning-effort") + 2), [
    "--reasoning-effort",
    "high",
  ]);
});

test("pi 独有的 thinking 等级映射：off→none、minimal→low，qoder 独有等级原样透传", () => {
  assert.equal(reasoningEffort("off"), "none");
  assert.equal(reasoningEffort("minimal"), "low");
  assert.equal(reasoningEffort("medium"), "medium");
  assert.equal(reasoningEffort("xhigh"), "xhigh");
  assert.equal(reasoningEffort("max"), "max");
  assert.equal(reasoningEffort("auto"), "auto");
  assert.equal(reasoningEffort("ultracode"), "ultracode");
});

test("result 非 success 时返回非零并带上 subtype", () => {
  const result = run(["send", "s1", "error"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /error_during_execution/);
});

test("qoderclicn 启动失败时返回非零并带 stderr", () => {
  const result = run(["send", "s1", "fail"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /boom/);
});

test("出错或被拦截的工具调用附在回复末尾", () => {
  const result = run(["send", "s1", "blocked"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1 次工具调用出错或被拦截/);
  assert.match(result.stdout, /- Bash: Blocked: needs permission/);
});

test("qoder 引擎下 executor 被拒绝（常驻进程与中途提问仍归 pi）", () => {
  const result = run(["send", "s1", "--role", "executor", "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /暂不支持 executor/);
  assert.deepEqual(qoderCalls(), []);
});

test("--role editor：工具集加 Edit/Write，权限用 accept_edits，仍是一次性 print 运行", () => {
  const result = run(["send", "s1", "--role", "editor", "改一下 README"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "echo:改一下 README\n");
  const argv = qoderCalls()[0]!.argv;
  assert.deepEqual(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 6), [
    "--tools",
    "Read",
    "Grep",
    "Glob",
    "Edit",
    "Write",
  ]);
  assert.deepEqual(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2), [
    "--permission-mode",
    "accept_edits",
  ]);
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.ok(argv.includes("-p"));
  assert.equal(qoderSessionIdOf(argv), nameToUuid("s1"));
});

test("--role editor 续接同一会话：第二次 send 用 --resume，且 advisor/editor 可混用同一会话", () => {
  assert.equal(run(["send", "s1", "--role", "editor", "先改文件"]).code, 0);
  assert.equal(run(["send", "s1", "再看看改得对不对"]).code, 0);
  const [a, b] = qoderCalls();
  assert.ok(a!.argv.includes("--session-id"));
  assert.ok(b!.argv.includes("--resume"));
  assert.equal(qoderSessionIdOf(a!.argv), qoderSessionIdOf(b!.argv));
  assert.ok(a!.argv.includes("Write"));
  assert.deepEqual(b!.argv.slice(b!.argv.indexOf("--tools"), b!.argv.indexOf("--tools") + 4), ["--tools", "Read", "Grep", "Glob"]);
});

test("advisor 与 editor 都以 --setting-sources 置空隔离用户/项目设置（含 hook）", () => {
  assert.equal(run(["send", "s1", "hello"]).code, 0);
  assert.equal(run(["send", "s2", "--role", "editor", "hello"]).code, 0);
  for (const call of qoderCalls()) {
    const argv = call.argv;
    assert.deepEqual(argv.slice(argv.indexOf("--setting-sources"), argv.indexOf("--setting-sources") + 2), [
      "--setting-sources",
      "",
    ]);
  }
});

test("首次启动失败不写 sessionStarted：修好后重试仍用 --session-id 建会话", () => {
  setEnv({ PI_BRIDGE_ENGINE: "qoder", QODER_BIN: "/nonexistent/qoderclicn" });
  const failed = run(["send", "s1", "hello"]);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /无法启动 qoderclicn/);
  const record = JSON.parse(readFileSync(join(home, "sessions", "s1.json"), "utf8")) as { sessionStarted?: boolean };
  assert.equal(record.sessionStarted, undefined);

  setEnv({ PI_BRIDGE_ENGINE: "qoder" });
  const retried = run(["send", "s1", "hello"]);
  assert.equal(retried.code, 0, retried.stderr);
  const argv = qoderCalls()[0]!.argv;
  assert.ok(argv.includes("--session-id"));
  assert.ok(!argv.includes("--resume"));
  const after = JSON.parse(readFileSync(join(home, "sessions", "s1.json"), "utf8")) as { sessionStarted?: boolean };
  assert.equal(after.sessionStarted, true);
});

test("建会话撞已存在的 UUID（rm 后底层会话仍在）时回退 --resume 续接", () => {
  const result = run(["send", "s1", "inuse"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "echo:inuse\n");
  const calls = qoderCalls();
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.argv.includes("--session-id"));
  assert.ok(calls[1]!.argv.includes("--resume"));
  assert.equal(qoderSessionIdOf(calls[0]!.argv), qoderSessionIdOf(calls[1]!.argv));
});

test("初始化前失败（有 stdout 但没有 init 事件）不写 sessionStarted，重试仍走 --session-id", () => {
  const failed = run(["send", "s1", "nostart"]);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /init failed/);
  const record = JSON.parse(readFileSync(join(home, "sessions", "s1.json"), "utf8")) as { sessionStarted?: boolean };
  assert.equal(record.sessionStarted, undefined);

  assert.equal(run(["send", "s1", "hello"]).code, 0);
  const argv = qoderCalls()[1]!.argv;
  assert.ok(argv.includes("--session-id"));
  assert.ok(!argv.includes("--resume"));
});

test("回退只认本次 UUID 的会话冲突句式：UUID 出现在无关占用错误里也不触发重试", () => {
  const result = run(["send", "s1", `portuse:${nameToUuid("s1")}`]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /already in use/);
  assert.equal(qoderCalls().length, 1);
});

test("isSessionIdConflict 只匹配 'Session ID <uuid> is already in use' 句式", () => {
  const id = nameToUuid("s1");
  assert.equal(isSessionIdConflict(`Error: Session ID ${id} is already in use.`, id), true);
  assert.equal(isSessionIdConflict(`session_id=${id}\nError: bind: address already in use`, id), false);
  assert.equal(isSessionIdConflict("Error: address already in use", id), false);
  assert.equal(isSessionIdConflict(`Session ID ${nameToUuid("other")} is already in use.`, id), false);
  assert.equal(isSessionIdConflict(undefined, id), false);
});

test("取消后不回退：建会话冲突期间 SIGTERM 终止，不再发起 --resume 重试", async () => {
  const child = spawn("node", [CLI, "send", "s1", "inuse"], { cwd: work, env: env() });
  await sleep(300);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("close", resolve));
  await sleep(300);
  const calls = qoderCalls();
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.argv.includes("--session-id"));
});

test("旧记录（无 engine 字段）在 PI_BRIDGE_ENGINE=qoder 下按 pi 处理，跑完回填 engine", () => {
  const now = new Date().toISOString();
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions", "old.json"), JSON.stringify({ name: "old", cwd: work, createdAt: now, updatedAt: now }));
  setEnv({ PI_BRIDGE_ENGINE: "qoder" });

  const executor = run(["send", "old", "--role", "executor", "hello"]);
  assert.equal(executor.code, 0, executor.stderr);
  assert.equal(piCalls().length, 1);

  const editor = run(["send", "old", "--role", "editor", "hello"]);
  assert.equal(editor.code, 1);
  assert.match(editor.stderr, /--role editor 仅 qoder 引擎可用/);

  assert.equal(run(["stop", "old"]).code, 0);
  assert.equal(run(["send", "old", "hello"]).code, 0);
  const record = JSON.parse(readFileSync(join(home, "sessions", "old.json"), "utf8")) as { engine?: string };
  assert.equal(record.engine, "pi");
});

test("常驻进程存活时，显式 --engine 与绑定引擎冲突会被拒绝", () => {
  setup();
  const first = run(["send", "s1", "--role", "executor", "hello"]);
  assert.equal(first.code, 0, first.stderr);
  const conflict = run(["send", "s1", "--role", "executor", "--engine", "qoder", "again"]);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /绑定的引擎是 pi，不能改用 qoder/);
  assert.equal(run(["stop", "s1"]).code, 0);
});

test("review 也走 qoderclicn：只读工具、stream-json、评审会话名派生 UUID", () => {
  initRepo(work);
  writeFileSync(join(work, "a.txt"), "changed\n");
  const result = run(["review"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^echo:你是代码评审者/);
  const argv = qoderCalls()[0]!.argv;
  assert.ok(argv.includes("--session-id"));
  assert.deepEqual(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 4), ["--tools", "Read", "Grep", "Glob"]);
  assert.match(qoderSessionIdOf(argv)!, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("nameToUuid 稳定、合法、不同名不同 UUID", () => {
  const u = nameToUuid("review-20261001T013000-4242");
  assert.equal(u, nameToUuid("review-20261001T013000-4242"));
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(u, nameToUuid("other"));
});

test("事件解析：tool_use/tool_result/text/result 映射成 RunResult 与进度行", () => {
  const lines: string[] = [];
  const tracker = createQoderRunTracker((line) => lines.push(line));
  tracker.handle({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Read", input: { file_path: "/a" } }] },
  });
  tracker.handle({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", is_error: true, content: "denied" }] },
  });
  tracker.handle({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
  tracker.handle({ type: "result", subtype: "success", is_error: false, result: "final answer" });

  const result = tracker.result(() => "fallback");
  assert.equal(result.ok, true);
  assert.equal(result.reply, "final answer");
  assert.deepEqual(result.failedTools, ["Read: denied"]);
  assert.deepEqual(lines, ['[tool] Read {"file_path":"/a"}', "[tool-error] Read: denied"]);
});

test("事件解析：没有 result 事件时用 fallback 错误", () => {
  const tracker = createQoderRunTracker(() => {});
  tracker.handle({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "half" }] } });
  const result = tracker.result(() => "process crashed");
  assert.equal(result.ok, false);
  assert.equal(result.error, "process crashed");
  assert.equal(result.reply, "half");
});

// ---------- --engine 选择与会话级绑定 ----------

test("--engine qoder 建会话即用 qoderclicn，并把引擎写进记录", () => {
  const { home } = setup();
  const result = run(["send", "s1", "--engine", "qoder", "hello"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(qoderCalls().length, 1);
  assert.equal(piCalls().length, 0);
  const record = JSON.parse(readFileSync(join(home, "sessions", "s1.json"), "utf8")) as { engine?: string };
  assert.equal(record.engine, "qoder");
});

test("--engine 优先于 PI_BRIDGE_ENGINE：env=qoder 但 --engine pi 时走 pi", () => {
  setup({ PI_BRIDGE_ENGINE: "qoder" });
  const result = run(["send", "s1", "--engine", "pi", "hello"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(piCalls().length, 1);
  assert.equal(qoderCalls().length, 0);
});

test("会话绑定引擎后续接忽略 env：pi 会话在 env=qoder 下仍走 pi", () => {
  setup();
  assert.equal(run(["send", "s1", "hello"]).code, 0);
  assert.equal(piCalls().length, 1);
  setEnv({ PI_BRIDGE_ENGINE: "qoder" });
  assert.equal(run(["send", "s1", "again"]).code, 0);
  assert.equal(piCalls().length, 2);
  assert.equal(qoderCalls().length, 0);
});

test("显式 --engine 与会话已绑定引擎不一致时报错，不调用另一个引擎", () => {
  setup();
  assert.equal(run(["send", "s1", "hello"]).code, 0);
  const result = run(["send", "s1", "--engine", "qoder", "again"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /绑定的引擎是 pi/);
  assert.equal(qoderCalls().length, 0);
});

test("--engine 只接受 pi 或 qoder", () => {
  setup();
  const result = run(["send", "s1", "--engine", "boss", "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /只能是 pi 或 qoder/);
});

test("--engine qoder 下 executor 被拒绝（executor 仍归 pi）", () => {
  setup();
  const result = run(["send", "s1", "--role", "executor", "--engine", "qoder", "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /暂不支持 executor/);
  assert.equal(qoderCalls().length, 0);
});

test("review --engine qoder 走 qoderclicn，不走 pi", () => {
  const { work } = setup();
  initRepo(work);
  writeFileSync(join(work, "a.txt"), "changed\n");
  const result = run(["review", "--engine", "qoder"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(qoderCalls().length, 1);
  assert.equal(piCalls().length, 0);
});
