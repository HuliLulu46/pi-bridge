import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { initRepo, piCalls, qoderCalls, qoderSessionIdOf, run, setEnv, setup } from "./helpers.ts";
import { createQoderRunTracker, nameToUuid } from "../plugins/pi-bridge/src/qoder.ts";

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

test("--model 与 --thinking 透传给 qoderclicn", () => {
  run(["send", "s1", "--model", "m1", "--thinking", "enabled", "hello"]);
  const argv = qoderCalls()[0]!.argv;
  assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2), ["--model", "m1"]);
  assert.deepEqual(argv.slice(argv.indexOf("--thinking"), argv.indexOf("--thinking") + 2), ["--thinking", "enabled"]);
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

test("qoder 引擎下 executor 被拒绝（第一版只做 advisor）", () => {
  const result = run(["send", "s1", "--role", "executor", "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /只支持 advisor/);
  assert.deepEqual(qoderCalls(), []);
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

test("--engine qoder 下 executor 被拒绝（第一版 executor 仍归 pi）", () => {
  setup();
  const result = run(["send", "s1", "--role", "executor", "--engine", "qoder", "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /只支持 advisor/);
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
