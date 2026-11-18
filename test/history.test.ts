import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, test } from "node:test";
import { findPiSession, historyToPiSession } from "../plugins/pi-bridge/src/fork.ts";
import { initRepo, piCalls, run, setEnv, setup } from "./helpers.ts";

let home: string;
let work: string;
let dir: string;
let historyFile: string;
const messages = [{ role: "user" as const, text: "暗号是 蓝鲸42" }, { role: "assistant" as const, text: "记住了" }];
const entries = (text: string): any[] => text.trim().split("\n").map((line) => JSON.parse(line));

beforeEach(() => {
  ({ home, work } = setup());
  dir = join(home, "pi-sessions");
  setEnv({ PI_CODING_AGENT_SESSION_DIR: dir });
  historyFile = join(home, "history.json");
  writeFileSync(historyFile, JSON.stringify({ messages }));
});

test("历史转换生成 v3 会话头、唯一 8 位 hex id、完整 parentId 链与消息字段", () => {
  const alias = join(home, "alias");
  symlinkSync(work, alias);
  const converted = historyToPiSession([...messages, { role: "user", text: "最后一条\n多行" }], "forked", alias);
  assert.ok(converted.endsWith("\n"));
  const [header, ...rows] = entries(converted);
  assert.deepEqual(header, { type: "session", version: 3, id: "forked", timestamp: header.timestamp, cwd: realpathSync(work) });
  assert.equal(new Date(header.timestamp).toISOString(), header.timestamp);
  assert.equal(new Set(rows.map((row) => row.id)).size, 3);
  rows.forEach((row, index) => {
    assert.equal(row.type, "message");
    assert.match(row.id, /^[0-9a-f]{8}$/);
    assert.equal(row.parentId, index === 0 ? null : rows[index - 1].id);
    assert.equal(new Date(row.timestamp).toISOString(), row.timestamp);
    assert.equal(row.message.timestamp, Date.parse(row.timestamp));
  });
  assert.deepEqual(rows[0].message, { role: "user", content: "暗号是 蓝鲸42", timestamp: rows[0].message.timestamp });
  assert.deepEqual(rows[1].message, {
    role: "assistant", content: [{ type: "text", text: "记住了" }],
    api: "pi-virtual", provider: "pi-bridge", model: "imported-history",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: rows[1].message.timestamp,
  });
  assert.equal(rows[2].message.content, "最后一条\n多行");
});

for (const role of ["advisor", "executor"]) {
  test(`${role} 首次启动 pi 前已写入历史，stdin、owner 与后续普通续接正常`, () => {
    setEnv({ PI_CODING_AGENT_SESSION_DIR: dir, FAKE_PI_EXPECT_HISTORY: "1" });
    try {
      const result = run(["send", "fresh", "--role", role, "--owner", "owner-a", "--history-file", historyFile, "-"], { input: "暗号是什么？" });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /echo:暗号是什么？/);
      const snapshot = entries(readFileSync(join(home, "calls.jsonl.history.jsonl"), "utf8"));
      assert.equal(snapshot[0].id, "fresh");
      assert.equal(snapshot[0].cwd, work);
      assert.equal(snapshot[1].message.content, messages[0].text);
      assert.equal(snapshot[2].message.content[0].text, messages[1].text);
      assert.equal(snapshot.length, 3);
      assert.equal(piCalls().length, 1);
      assert.ok(!piCalls()[0]!.argv.includes("--model"));
      const recordPath = join(home, "sessions", "fresh.json");
      assert.equal(JSON.parse(readFileSync(recordPath, "utf8")).owner, "owner-a");
      const file = findPiSession(dir, "fresh")!;
      const before = readFileSync(file, "utf8");
      const repeated = run(["send", "fresh", "--role", role, "--history-file", historyFile, "--json", "again"]);
      assert.equal(repeated.code, 1);
      assert.match(JSON.parse(repeated.stdout).error, /fork 只能用于新的会话名/);
      assert.equal(readFileSync(file, "utf8"), before);
      assert.equal(run(["send", "fresh", "--role", role, "again"]).code, 0);
    } finally {
      if (role === "executor") run(["stop", "fresh"]);
    }
  });
}

test("advisor --detach 转发 history-file 并在后台启动前导入", async () => {
  setEnv({ PI_CODING_AGENT_SESSION_DIR: dir, FAKE_PI_EXPECT_HISTORY: "1" });
  const started = run(["send", "detached", "--role", "advisor", "--detach", "--owner", "owner-a", "--history-file", historyFile, "-"], { input: "from stdin" });
  assert.equal(started.code, 0, started.stderr || started.stdout);
  const { runId, session } = JSON.parse(started.stdout);
  assert.equal(session, "detached");
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = JSON.parse(run(["result", runId]).stdout);
    if (result.status !== "running") {
      assert.equal(result.status, "done", JSON.stringify(result));
      assert.equal(result.reply, "echo:from stdin");
      break;
    }
    assert.ok(Date.now() < deadline, "等待 detach 超时");
    await sleep(50);
  }
  assert.equal(entries(readFileSync(join(home, "calls.jsonl.history.jsonl"), "utf8"))[0].id, "detached");
});

test("已有记录（包括无主、同 owner、其他 owner 和已有副本）拒绝导入且不改记录", () => {
  const now = new Date().toISOString();
  mkdirSync(join(home, "sessions"), { recursive: true });
  for (const owner of [undefined, "owner-a", "owner-b"]) {
    const record = { name: "taken", cwd: work, createdAt: now, updatedAt: now, ...(owner ? { owner } : {}) };
    const path = join(home, "sessions", "taken.json");
    const original = JSON.stringify(record);
    writeFileSync(path, original);
    for (const role of ["advisor", "executor"]) {
      const result = run(["send", "taken", "--owner", "owner-a", "--role", role, "--history-file", historyFile, "--json", "hi"]);
      assert.equal(result.code, 1);
      assert.deepEqual(JSON.parse(result.stdout), { status: "error", error: "fork 只能用于新的会话名：bridge 会话记录已存在" });
      assert.equal(readFileSync(path, "utf8"), original);
      assert.deepEqual(readdirSync(join(home, "sessions")), ["taken.json"]);
    }
  }
  writeFileSync(join(home, "sessions", "taken.ownera.json"), JSON.stringify({ name: "taken.ownera", cwd: work, createdAt: now, updatedAt: now, owner: "owner-a", forkOf: "taken" }));
  assert.equal(run(["send", "taken", "--owner", "owner-a", "--history-file", historyFile, "--detach", "hi"]).code, 1);
  assert.equal(piCalls().length, 0);
});

test("仅有 pi 会话文件也拒绝导入，不覆盖、不建立 bridge 记录", () => {
  mkdirSync(dir, { recursive: true });
  // 文件名故意不含会话 id，必须按会话头查找。
  const old = join(dir, "unrelated-name.jsonl");
  const original = historyToPiSession(messages, "orphan", work);
  writeFileSync(old, original);
  for (const role of ["advisor", "executor"]) {
    const result = run(["send", "orphan", "--role", role, "--history-file", historyFile, "--json", "hello"]);
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stdout).error, /fork 只能用于新的会话名/);
    assert.equal(readFileSync(old, "utf8"), original);
    assert.deepEqual(readdirSync(dir), ["unrelated-name.jsonl"]);
    assert.equal(existsSync(join(home, "sessions", "orphan.json")), false);
  }
  assert.equal(piCalls().length, 0);
});

test("history-file 校验绝对路径、文件读取、JSON、非空数组和 role/text，错误兼容 JSON 与 detach", () => {
  for (const [path, expected] of [["relative.json", /绝对路径/], [join(home, "missing.json"), /无法读取/], [home, /无法读取/]] as const) {
    const result = run(["send", "invalid", "--history-file", path, "--json", "hello"]);
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stdout).error, expected);
  }
  for (const [payload, expected] of [
    ["{", /不是合法 JSON/], ["null", /非空数组/], ["{}", /非空数组/],
    ['{"messages":{}}', /非空数组/], ['{"messages":[]}', /非空数组/],
    ...[null, "user", {}, { role: "system", text: "hi" }, { role: "user", text: 42 }, { role: "assistant" }]
      .map((message) => [JSON.stringify({ messages: [message] }), /messages\[0\]/] as const),
  ] as const) {
    writeFileSync(historyFile, payload);
    const result = run(["send", "invalid", "--history-file", historyFile, "--json", "hello"]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).status, "error");
    assert.match(JSON.parse(result.stdout).error, expected);
    assert.equal(existsSync(join(home, "sessions", "invalid.json")), false);
  }
  const detached = run(["send", "invalid", "--history-file", historyFile, "--detach", "hello"]);
  assert.equal(detached.code, 1);
  assert.equal(JSON.parse(detached.stdout).status, "error");
  assert.match(JSON.parse(detached.stdout).error, /messages\[0\]/);
  assert.equal(piCalls().length, 0);
  assert.equal(existsSync(dir), false);
});

test("worktree 历史使用最终运行目录，失败时回滚本次 worktree", () => {
  initRepo(work);
  setEnv({ PI_CODING_AGENT_SESSION_DIR: dir, FAKE_PI_EXPECT_HISTORY: "1" });
  const result = run(["send", "branched", "--worktree", "--history-file", historyFile, "hello"]);
  try {
    assert.equal(result.code, 0, result.stderr);
    const record = JSON.parse(readFileSync(join(home, "sessions", "branched.json"), "utf8"));
    const snapshot = entries(readFileSync(join(home, "calls.jsonl.history.jsonl"), "utf8"));
    assert.equal(snapshot[0].cwd, realpathSync(record.cwd));
    assert.equal(piCalls()[0]!.cwd, record.cwd);
  } finally {
    run(["rm", "branched"]);
  }
  writeFileSync(join(dir, "existing.jsonl"), historyToPiSession(messages, "blocked", work));
  const blocked = run(["send", "blocked", "--worktree", "--history-file", historyFile, "--json", "hello"]);
  assert.equal(blocked.code, 1);
  assert.match(JSON.parse(blocked.stdout).error, /fork 只能用于新的会话名/);
  assert.equal(existsSync(join(work, ".pi-bridge", "worktrees", "blocked")), false);
  assert.equal(existsSync(join(home, "sessions", "blocked.json")), false);
});
