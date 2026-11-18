import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { openDaemon, request } from "../plugins/pi-bridge/src/protocol.ts";
import { acquireLock, lockHolder } from "../plugins/pi-bridge/src/store.ts";
import { piCalls, run, runAsync, setup } from "./helpers.ts";

const DAEMON = fileURLToPath(new URL("../plugins/pi-bridge/src/daemon.ts", import.meta.url));

let home: string;

/** 以 executor 角色向 s1 发送；没有常驻进程时自动启动 */
const exec = (...args: string[]) => run(["send", "s1", "--role", "executor", ...args]);
const execAsync = (...args: string[]) => runAsync(["send", "s1", "--role", "executor", ...args]);

/** 新建隔离环境，并以第一条 executor 消息启动常驻进程 */
function begin(env: NodeJS.ProcessEnv = {}): void {
  ({ home } = setup(env));
  const started = exec("hello");
  assert.equal(started.code, 0, started.stderr);
}

afterEach(() => {
  run(["stop", "s1"]);
});

function askId(stdout: string): string {
  const match = /^\[ask\] (\S+) /m.exec(stdout);
  assert.ok(match, stdout);
  return match[1]!;
}

test("executor send 自动启动常驻进程，pi 以 rpc 模式运行并带系统提示", () => {
  ({ home } = setup());
  const result = exec("hello");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "echo:hello\n");
  assert.match(run(["list"]).stdout, /^s1\tdaemon\t/);

  assert.equal(exec("again").stdout, "echo:again\n");
  const calls = piCalls();
  assert.equal(calls.length, 1);
  const argv = calls[0]!.argv;
  assert.ok(argv.includes("rpc"));
  assert.match(argv[argv.indexOf("--session-id") + 1]!, /^s1-[a-z0-9]{6}$/);
  assert.ok(argv.includes("--append-system-prompt"));
  assert.ok(argv.includes("--name"));
  assert.ok(!argv.includes("--no-extensions"));
  assert.equal(calls[0]!.subagent, "1");
});

test("executor 启动常驻进程时拼接 --model 与 --thinking；常驻进程运行中再传入报错", () => {
  ({ home } = setup());
  assert.equal(exec("--model", "m1", "--thinking", "low", "hello").code, 0);
  const argv = piCalls()[0]!.argv;
  assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 4), ["--model", "m1", "--thinking", "low"]);

  const result = exec("--model", "m2", "again");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /只在启动常驻进程时生效/);
});

test("pi 提问时 send 以退出码 2 打印提问，answer 按序号回答后拿到回复", () => {
  begin();
  const asked = exec("ask");
  assert.equal(asked.code, 2, asked.stderr);
  assert.match(asked.stdout, /  2\) 2\. B/);
  assert.match(asked.stdout, /pi-bridge answer s1 ask-1 /);

  const answered = run(["answer", "s1", askId(asked.stdout), "2"]);
  assert.equal(answered.code, 0, answered.stderr);
  assert.equal(answered.stdout, "chose:2. B\n");
});

test("select 的回答不在选项里时报错，提问仍可再回答", () => {
  begin();
  const asked = exec("ask");
  const bad = run(["answer", "s1", askId(asked.stdout), "9"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /没有这个选项/);
  assert.equal(run(["answer", "s1", "ask-1", "1. A"]).stdout, "chose:1. A\n");
});

test("权限确认自动拒绝并在回复末尾报告", () => {
  begin();
  const result = exec("confirm");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^declined/);
  assert.match(result.stdout, /2 次工具调用出错或被拦截/);
  assert.match(result.stdout, /- 权限确认被拒绝：Auto mode permission ask rm -rf build/);
});

test("提问超时后自动取消，pi 继续跑完，watch 等待期满后回放这次运行", async () => {
  begin({ PI_BRIDGE_ASK_TIMEOUT_MS: "300", PI_BRIDGE_WATCH_WAIT_MS: "300" });
  assert.equal(exec("ask").code, 2);
  await sleep(600);
  const watched = run(["watch", "s1"]);
  assert.equal(watched.code, 0);
  assert.match(watched.stdout, /^\[idle\] 会话 s1 当前没有任务在运行，以下是上一次运行的记录\n\[start\] /);
  assert.match(watched.stdout, /\[ask-timeout\] ask-1/);
  assert.match(watched.stdout, /chose:cancelled\n\[done\]\n$/);
});

test("运行中 send 被拒绝并提示 steer，steer 送达 pi", async () => {
  begin();
  const slow = execAsync("slow");
  await sleep(400);
  const busy = exec("hi");
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /steer/);

  assert.equal(run(["steer", "s1", "left"]).code, 0);
  const result = await slow;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "echo:slow steer:left\n");
});

test("没有任务在运行时 steer 报错", () => {
  begin();
  const result = run(["steer", "s1", "left"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /没有运行中的任务/);
});

test("没有常驻进程时 steer、abort、answer 提示用 executor 启动", () => {
  ({ home } = setup());
  for (const args of [["steer", "s1", "x"], ["abort", "s1"], ["answer", "s1", "ask-1", "x"]]) {
    const result = run(args);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, /send --role executor 启动/, args.join(" "));
  }
});

test("abort 中止运行中的任务，send 以失败返回", async () => {
  begin();
  const slow = execAsync("slow");
  await sleep(400);
  assert.equal(run(["abort", "s1"]).code, 0);
  const result = await slow;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /aborted/);
  assert.equal(result.stdout, "");
});

test("watch 跟随常驻进程的任务直到 [done]", async () => {
  begin();
  const slow = execAsync("slow");
  const watched = await runAsync(["watch", "s1"]);
  assert.equal(watched.code, 0);
  assert.match(watched.stdout, /^\[start\] /);
  assert.match(watched.stdout, /\[reply\]\necho:slow steer:\n\[done\]\n$/);
  await slow;
});

test("等待期内开始的新运行被 watch 跟随，不输出上一次运行的记录", async () => {
  begin({ PI_BRIDGE_WATCH_WAIT_MS: "5000" });
  const watched = runAsync(["watch", "s1"]);
  await sleep(300);
  const slow = execAsync("slow");
  const result = await watched;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^\[start\] .*slow/);
  assert.doesNotMatch(result.stdout, /echo:hello/);
  assert.match(result.stdout, /echo:slow steer:\n\[done\]\n$/);
  await slow;
});

test("watch 先于首次 executor send 启动时，跟随自动启动的常驻进程直到 [done]", async () => {
  ({ home } = setup());
  const watched = runAsync(["watch", "s1"]);
  await sleep(300);
  const sent = execAsync("slow");
  const result = await watched;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^\[start\] .*slow[\s\S]*echo:slow steer:\n\[done\]\n$/);
  assert.equal((await sent).code, 0);
});

test("跟随中的常驻进程被 stop 时，watch 以 [failed] 结束", async () => {
  begin();
  const sent = execAsync("slow");
  await sleep(300);
  const watched = runAsync(["watch", "s1"]);
  await sleep(300);
  assert.equal(run(["stop", "s1"]).code, 0);
  const result = await watched;
  assert.equal(result.code, 1);
  assert.match(result.stdout, /pi 进程退出[\s\S]*\[failed\]\n$/);
  assert.equal((await sent).code, 1);
});

test("停止中的常驻进程拒绝新请求", async () => {
  begin({ FAKE_PI_RPC_EXIT_DELAY_MS: "1500" });
  process.env.PI_BRIDGE_HOME = home;
  const replies = [];
  for await (const message of request((await openDaemon("s1"))!, { type: "stop" })) replies.push(message);
  assert.deepEqual(replies, [{ type: "ok", text: "正在停止" }]);

  const result = exec("hello");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /常驻进程正在停止/);
  assert.match(run(["steer", "s1", "x"]).stderr, /常驻进程正在停止/);
});

test("没有任务时 pi 弹出的对话框被立即取消，并写入常驻进程的输出", async () => {
  begin({ FAKE_PI_RPC_STARTUP_DIALOG: "1" });
  const uiFile = join(home, "calls.jsonl.ui.jsonl");
  for (let i = 0; i < 20 && !existsSync(uiFile); i++) await sleep(100);
  assert.deepEqual(JSON.parse(readFileSync(uiFile, "utf8").trim()), {
    type: "extension_ui_response",
    id: "startup-1",
    cancelled: true,
  });
  assert.match(readFileSync(join(home, "run", "s1.err"), "utf8"), /\[dialog-cancelled\] select 启动时的提问/);
});

test("常驻进程先拿锁再读记录：拿锁失败、记录不存在或已被重建时以一行原因退出", () => {
  ({ home } = setup());
  const spawnDaemon = (name: string, createdAt = "") =>
    spawnSync("node", [DAEMON, name, JSON.stringify({ isNew: false, createdAt })], {
      env: { ...process.env, PI_BRIDGE_HOME: home },
      encoding: "utf8",
      timeout: 5000,
    });

  assert.equal(run(["send", "rebuilt", "hello"]).code, 0);
  const rebuilt = spawnDaemon("rebuilt", "1970-01-01T00:00:00.000Z");
  assert.equal(rebuilt.status, 1);
  assert.equal(rebuilt.stderr, "会话 rebuilt 在常驻进程启动期间被删除并重建，请重试\n");
  assert.ok(!existsSync(join(home, "locks", "rebuilt.lock")));

  const missing = spawnDaemon("nosuch");
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, "会话不存在：nosuch\n");
  assert.ok(!existsSync(join(home, "locks", "nosuch.lock")));

  process.env.PI_BRIDGE_HOME = home;
  const release = acquireLock("held");
  try {
    const held = spawnDaemon("held");
    assert.equal(held.status, 1);
    assert.match(held.stderr, /^会话 held 正被占用（pid \d+）[^\n]*\n$/);
  } finally {
    release();
  }
});

test("两个 executor 同时自动启动时只有一个成功，另一个报错而不是连上对方的常驻进程", async () => {
  ({ home } = setup());
  const results = await Promise.all([
    runAsync(["send", "s1", "--role", "executor", "--model", "m1", "hello"]),
    runAsync(["send", "s1", "--role", "executor", "--model", "m2", "hello"]),
  ]);
  const codes = results.map((result) => result.code).sort();
  assert.deepEqual(codes, [0, 1], results.map((result) => result.stderr).join("\n"));
  const loser = results.find((result) => result.code === 1)!;
  assert.match(loser.stderr, /会话 s1 正被占用（pid \d+）|只在启动常驻进程时生效/);
  assert.equal(piCalls().filter((call) => call.argv.includes("rpc")).length, 1);
});

test("停止过程中 pi 弹出的对话框不影响常驻进程正常退出", async () => {
  begin({ FAKE_PI_RPC_EXIT_DELAY_MS: "500", FAKE_PI_RPC_DIALOG_ON_EOF: "1" });
  assert.equal(run(["stop", "s1"]).code, 0);
  await sleep(200);
  assert.ok(!existsSync(join(home, "run", "s1.sock")), "常驻进程没有正常走完退出流程");
  assert.doesNotMatch(readFileSync(join(home, "run", "s1.err"), "utf8"), /Error|ERR_/);
});

test("stop 只等目标常驻进程释放锁，不受随后接手锁的进程影响", async () => {
  begin();
  process.env.PI_BRIDGE_HOME = home;
  const started = Date.now();
  const stopping = runAsync(["stop", "s1"]);
  while (lockHolder("s1") !== undefined && Date.now() - started < 5000) await sleep(5);
  const release = acquireLock("s1");
  try {
    const result = await stopping;
    assert.equal(result.code, 0, result.stderr);
    assert.ok(Date.now() - started < 5000);
  } finally {
    release();
  }
});

test("watch 等待期间常驻进程空闲退出时继续查找，跟随随后自动启动的新常驻进程", async () => {
  begin({ PI_BRIDGE_IDLE_MS: "1000" });
  const watched = runAsync(["watch", "s1"]);
  await sleep(1500);
  const sent = execAsync("slow");
  const result = await watched;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^\[start\] .*slow[\s\S]*\[done\]\n$/);
  assert.doesNotMatch(result.stdout, /\[idle\]/);
  assert.equal((await sent).code, 0);
});

test("watch 等待期间常驻进程空闲退出且没有新运行时，期满后回放上一次运行", async () => {
  begin({ PI_BRIDGE_IDLE_MS: "800" });
  const result = await runAsync(["watch", "s1"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^\[idle\] 会话 s1 当前没有任务在运行，以下是上一次运行的记录\n/);
  assert.match(result.stdout, /echo:hello\n\[done\]\n$/);
});

test("会话锁被占用时 executor send 报错，不启动常驻进程", () => {
  ({ home } = setup());
  process.env.PI_BRIDGE_HOME = home;
  const release = acquireLock("s1");
  try {
    const result = exec("hello");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /正被占用/);
    assert.deepEqual(piCalls(), []);
  } finally {
    release();
  }
});

test("常驻进程运行时 advisor send 报错；stop 后 advisor 走 print 模式；rm 先停止常驻进程", () => {
  begin();
  const advisor = run(["send", "s1", "hello"]);
  assert.equal(advisor.code, 1);
  assert.match(advisor.stderr, /有常驻进程，先 pi-bridge stop s1/);

  assert.equal(run(["stop", "s1"]).code, 0);
  assert.ok(!existsSync(join(home, "run", "s1.sock")));
  assert.match(run(["list"]).stdout, /^s1\tidle\t/);

  assert.equal(run(["send", "s1", "hello"]).stdout, "echo:hello\n");
  const printArgv = piCalls().at(-1)!.argv;
  assert.ok(printArgv.includes("-p"));
  assert.ok(printArgv.includes("--no-extensions"));

  assert.equal(exec("again").code, 0);
  assert.match(run(["list"]).stdout, /^s1\tdaemon\t/);
  const removed = run(["rm", "s1"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.ok(!existsSync(join(home, "run", "s1.sock")));
  assert.equal(run(["list"]).stdout, "（没有会话）\n");
});

test("空闲超时后常驻进程自动退出", async () => {
  begin({ PI_BRIDGE_IDLE_MS: "300" });
  await sleep(1000);
  assert.match(run(["list"]).stdout, /^s1\tidle\t/);
  assert.ok(!existsSync(join(home, "run", "s1.sock")));
});

test("pi 启动失败时 executor send 报错并带上输出", () => {
  ({ home } = setup({ FAKE_PI_RPC_FAIL: "1" }));
  const result = exec("hello");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /常驻进程启动失败[\s\S]*boom/);
});
