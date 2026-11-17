import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, test } from "node:test";
import { initRepo, run, setup } from "./helpers.ts";

let home: string;

afterEach(() => {
  run(["stop", "s1"]);
});

const json = (stdout: string): any => JSON.parse(stdout.trim().split("\n").at(-1)!);

function events(): any[] {
  const file = join(home, "events.ndjson");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("等待超时");
    await sleep(50);
  }
}

test("文本模式不变：advisor send 只输出回复，同时落下运行记录与事件", () => {
  ({ home } = setup());
  const result = run(["send", "s1", "hello"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "echo:hello\n");
  const log = events();
  assert.deepEqual(
    log.map((e) => e.type),
    ["start", "done"],
  );
  assert.equal(log[0].session, "s1");
  assert.equal(log[0].runId, log[1].runId);
});

test("send --json：输出运行记录，含 runId、状态与完整回复", () => {
  ({ home } = setup());
  const result = run(["send", "s1", "--json", "hello"]);
  assert.equal(result.code, 0, result.stderr);
  const out = json(result.stdout);
  assert.equal(out.status, "done");
  assert.equal(out.session, "s1");
  assert.equal(out.role, "advisor");
  assert.equal(out.reply, "echo:hello");
  assert.match(out.runId, /^r-/);
  assert.deepEqual(json(run(["result", out.runId]).stdout), out);
});

test("send --json 失败：stdout 是 status failed 的 JSON，退出码 1", () => {
  ({ home } = setup());
  const result = run(["send", "s1", "--json", "fail"]);
  assert.equal(result.code, 1);
  const out = json(result.stdout);
  assert.equal(out.status, "failed");
  assert.match(out.error, /boom/);
  assert.equal(events().at(-1).type, "failed");
});

test("--json 下运行之外的错误也是一行 JSON", () => {
  ({ home } = setup());
  const result = run(["send", "s1", "--role", "boss", "--json", "hi"]);
  assert.equal(result.code, 1);
  assert.equal(json(result.stdout).status, "error");
});

test("send --detach：立即返回 runId，运行在后台继续，结果用 result 取", async () => {
  ({ home } = setup());
  const started = run(["send", "s1", "--detach", "slow"]);
  assert.equal(started.code, 0, started.stderr);
  const { runId, session } = json(started.stdout);
  assert.equal(session, "s1");
  // 返回时运行还没结束（slow 要 1.5 秒），会话仍持锁
  assert.equal(json(run(["result", runId]).stdout).status, "running");
  assert.match(run(["list", "--json"]).stdout, /"status":"running"/);

  const done = await waitFor(() => {
    const record = json(run(["result", runId]).stdout);
    return record.status === "done" ? record : undefined;
  });
  assert.equal(done.reply, "echo:slow");
  assert.deepEqual(
    events().map((e) => e.type),
    ["start", "done"],
  );
});

test("send --detach：会话被占用时返回错误而不是假装开始", () => {
  ({ home } = setup());
  assert.equal(run(["send", "s1", "--detach", "slow"]).code, 0);
  const second = run(["send", "s1", "--detach", "hello"]);
  assert.equal(second.code, 1);
  assert.match(json(second.stdout).error, /正被占用/);
});

test("list --json：每个会话一个对象，带状态与引擎", () => {
  ({ home } = setup());
  run(["send", "s1", "hello"]);
  const rows = json(run(["list", "--json"]).stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "s1");
  assert.equal(rows[0].status, "idle");
});

test("list --json：带每个会话最近一次运行的状态，失败时附原因；文本模式不变", () => {
  ({ home } = setup());
  run(["send", "s1", "hello"]);
  const failed = json(run(["send", "s1", "--json", "fail"]).stdout);
  run(["send", "s2", "hello"]);
  const rows = json(run(["list", "--json"]).stdout);
  const s1 = rows.find((r: any) => r.name === "s1");
  assert.equal(s1.status, "idle");
  assert.equal(s1.lastRun.runId, failed.runId);
  assert.equal(s1.lastRun.status, "failed");
  assert.match(s1.lastRun.error, /boom/);
  assert.ok(s1.lastRun.endedAt);
  const s2 = rows.find((r: any) => r.name === "s2");
  assert.equal(s2.lastRun.status, "done");
  assert.equal(s2.lastRun.error, undefined);
  assert.doesNotMatch(run(["list"]).stdout, /failed|done/);
});

test("executor --json 与 --detach：runId 贯穿 start、ask、answered、done", async () => {
  ({ home } = setup());
  const started = run(["send", "s1", "--role", "executor", "--detach", "ask"]);
  assert.equal(started.code, 0, started.stderr);
  const { runId } = json(started.stdout);

  const asking = await waitFor(() => {
    const record = json(run(["result", runId]).stdout);
    return record.status === "asking" ? record : undefined;
  });
  assert.equal(asking.ask.id, "ask-1");
  assert.deepEqual(asking.ask.options, ["1. A", "2. B"]);

  const answered = run(["answer", "s1", "ask-1", "2", "--detach"]);
  assert.equal(answered.code, 0, answered.stderr);
  assert.equal(json(answered.stdout).status, "running");

  const done = await waitFor(() => {
    const record = json(run(["result", runId]).stdout);
    return record.status === "done" ? record : undefined;
  });
  assert.equal(done.reply, "chose:2. B");
  const types = events().map((e) => e.type);
  assert.deepEqual(
    types.filter((t) => ["start", "ask", "answered", "done"].includes(t)),
    ["start", "ask", "answered", "done"],
  );
  assert.ok(events().every((e) => e.runId === runId));
  assert.ok(!JSON.stringify(events()).includes("chose:2"), "事件日志不放回复正文");
});

test("executor send --json 遇到提问：退出码 2，stdout 是带结构化 ask 的 JSON", () => {
  ({ home } = setup());
  const result = run(["send", "s1", "--role", "executor", "--json", "ask"]);
  assert.equal(result.code, 2, result.stderr);
  const out = json(result.stdout);
  assert.equal(out.status, "asking");
  assert.equal(out.ask.id, "ask-1");
  assert.match(out.runId, /^r-/);
  const answered = run(["answer", "s1", "ask-1", "1", "--json"]);
  assert.equal(answered.code, 0, answered.stderr);
  assert.equal(json(answered.stdout).reply, "chose:1. A");
});

test("events：--since 从字节偏移读取，只给完整的行", () => {
  ({ home } = setup());
  run(["send", "s1", "hello"]);
  const all = run(["events"]).stdout.trim().split("\n");
  assert.equal(all.length, 2);
  const firstLine = readFileSync(join(home, "events.ndjson"), "utf8").split("\n")[0]!;
  const rest = run(["events", "--since", String(Buffer.byteLength(firstLine) + 1)]).stdout.trim().split("\n");
  assert.equal(rest.length, 1);
  assert.equal(JSON.parse(rest[0]!).type, "done");
});

test("result：runId 格式不对或不存在时报错", () => {
  ({ home } = setup());
  assert.equal(run(["result", "../x"]).code, 1);
  assert.equal(run(["result", "r-abc-abcdef"]).code, 1);
});

test("review --detach：后台准备补丁并评审，立即返回 runId 与评审会话名", async () => {
  const { work } = setup();
  initRepo(work);
  writeFileSync(join(work, "a.txt"), "changed\n");
  const started = run(["review", "--detach"], { cwd: work });
  assert.equal(started.code, 0, started.stderr);
  const { runId, session } = json(started.stdout);
  assert.match(session, /^review-/);
  const done = await waitFor(() => {
    const record = json(run(["result", runId]).stdout);
    return record.status === "done" ? record : undefined;
  });
  assert.match(done.reply, /评审会话：review-/);
});

test("事件日志超过上限时轮转：旧的留作 .1，新事件进新文件，读者偏移超出文件大小时从头读", () => {
  ({ home } = setup({ PI_BRIDGE_EVENTS_MAX_BYTES: "200" }));
  run(["send", "s1", "first"]);
  run(["send", "s1", "second"]);
  assert.ok(existsSync(join(home, "events.ndjson.1")), "应当轮转出 .1");
  const tail = run(["events", "--since", "999999"]).stdout.trim().split("\n");
  assert.ok(tail.length >= 1 && tail.every((l) => JSON.parse(l).session === "s1"));
});

test("旧的运行记录按保留期清理，新的不动", async () => {
  ({ home } = setup({ PI_BRIDGE_RUN_KEEP_DAYS: "0.00001" }));
  const first = json(run(["send", "s1", "--json", "one"]).stdout).runId;
  await sleep(1500);
  const second = json(run(["send", "s1", "--json", "two"]).stdout).runId;
  assert.notEqual(run(["result", first]).code, 0, "first 应已被清理");
  assert.equal(run(["result", second]).code, 0);
});

test("实际使用的模型与思考等级只上报一次：事件日志里有 model 事件，watch 日志里有 [model] 行", () => {
  ({ home } = setup({ FAKE_PI_MODEL: "m1" }));
  const out = json(run(["send", "s1", "--json", "hello"]).stdout);
  const model = events().filter((e) => e.type === "model");
  assert.equal(model.length, 1);
  assert.equal(model[0].runId, out.runId);
  assert.equal(model[0].text, "fake/m1 low");
  assert.match(readFileSync(join(home, "logs", "s1.log"), "utf8"), /^\[model\] fake\/m1 low$/m);
});

test("没有模型信息时不产生 model 事件，文本输出不变", () => {
  ({ home } = setup());
  assert.equal(run(["send", "s1", "hello"]).stdout, "echo:hello\n");
  assert.equal(events().filter((e) => e.type === "model").length, 0);
});
