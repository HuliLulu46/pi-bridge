import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { openDaemon, request } from "../plugins/pi-bridge/src/protocol.ts";
import { piCalls, run, runAsync, setup } from "./helpers.ts";

const DAEMON = fileURLToPath(new URL("../plugins/pi-bridge/src/daemon.ts", import.meta.url));

let home: string;

function begin(env: NodeJS.ProcessEnv = {}, startArgs: string[] = []): void {
  ({ home } = setup(env));
  const started = run(["start", "s1", ...startArgs]);
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

test("start 后 send 走常驻进程，pi 以 rpc 模式运行并带系统提示", () => {
  begin();
  const result = run(["send", "s1", "hello"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "echo:hello\n");
  assert.match(run(["list"]).stdout, /^s1\tdaemon\t/);

  const [call] = piCalls();
  assert.ok(call!.argv.includes("rpc"));
  assert.ok(call!.argv.includes("--append-system-prompt"));
  assert.ok(call!.argv.includes("--name"));
  assert.equal(call!.subagent, "1");
});

test("pi 提问时 send 以退出码 2 打印提问，answer 按序号回答后拿到回复", () => {
  begin();
  const asked = run(["send", "s1", "ask"]);
  assert.equal(asked.code, 2, asked.stderr);
  assert.match(asked.stdout, /  2\) 2\. B/);
  assert.match(asked.stdout, /pi-bridge answer s1 ask-1 /);

  const answered = run(["answer", "s1", askId(asked.stdout), "2"]);
  assert.equal(answered.code, 0, answered.stderr);
  assert.equal(answered.stdout, "chose:2. B\n");
});

test("select 的回答不在选项里时报错，提问仍可再回答", () => {
  begin();
  const asked = run(["send", "s1", "ask"]);
  const bad = run(["answer", "s1", askId(asked.stdout), "9"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /没有这个选项/);
  assert.equal(run(["answer", "s1", "ask-1", "1. A"]).stdout, "chose:1. A\n");
});

test("权限确认默认自动拒绝并在回复末尾报告", () => {
  begin();
  const result = run(["send", "s1", "confirm"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^declined/);
  assert.match(result.stdout, /2 次工具调用出错或被拦截/);
  assert.match(result.stdout, /- 权限确认被拒绝：Auto mode permission ask rm -rf build/);
});

test("提问超时后自动取消，pi 继续跑完，watch 等待期满后回放这次运行", async () => {
  begin({ PI_BRIDGE_ASK_TIMEOUT_MS: "300", PI_BRIDGE_WATCH_WAIT_MS: "300" });
  assert.equal(run(["send", "s1", "ask"]).code, 2);
  await sleep(600);
  const watched = run(["watch", "s1"]);
  assert.equal(watched.code, 0);
  assert.match(watched.stdout, /^\[idle\] 会话 s1 当前没有任务在运行，以下是上一次运行的记录\n\[start\] /);
  assert.match(watched.stdout, /\[ask-timeout\] ask-1/);
  assert.match(watched.stdout, /chose:cancelled\n\[done\]\n$/);
});

test("运行中 send 被拒绝并提示 steer，steer 送达 pi", async () => {
  begin();
  const slow = runAsync(["send", "s1", "slow"]);
  await sleep(400);
  const busy = run(["send", "s1", "hi"]);
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

test("abort 中止运行中的任务，send 以失败返回", async () => {
  begin();
  const slow = runAsync(["send", "s1", "slow"]);
  await sleep(400);
  assert.equal(run(["abort", "s1"]).code, 0);
  const result = await slow;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /aborted/);
  assert.equal(result.stdout, "");
});

test("watch 跟随常驻进程的任务直到 [done]", async () => {
  begin();
  const slow = runAsync(["send", "s1", "slow"]);
  const watched = await runAsync(["watch", "s1"]);
  assert.equal(watched.code, 0);
  assert.match(watched.stdout, /^\[start\] /);
  assert.match(watched.stdout, /\[reply\]\necho:slow steer:\n\[done\]\n$/);
  await slow;
});

test("等待期内开始的新运行被 watch 跟随，不输出上一次运行的记录", async () => {
  begin({ PI_BRIDGE_WATCH_WAIT_MS: "5000" });
  assert.equal(run(["send", "s1", "hello"]).code, 0);
  const watched = runAsync(["watch", "s1"]);
  await sleep(300);
  const slow = runAsync(["send", "s1", "slow"]);
  const result = await watched;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^\[start\] .*slow/);
  assert.doesNotMatch(result.stdout, /echo:hello/);
  assert.match(result.stdout, /echo:slow steer:\n\[done\]\n$/);
  await slow;
});

test("停止中的常驻进程拒绝新请求", async () => {
  begin({ FAKE_PI_RPC_EXIT_DELAY_MS: "1500" });
  process.env.PI_BRIDGE_HOME = home;
  const replies = [];
  for await (const message of request((await openDaemon("s1"))!, { type: "stop" })) replies.push(message);
  assert.deepEqual(replies, [{ type: "ok", text: "正在停止" }]);

  const result = run(["send", "s1", "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /常驻进程正在停止/);
  assert.match(run(["steer", "s1", "x"]).stderr, /常驻进程正在停止/);
});

test("没有任务时 pi 弹出的对话框被立即取消并记入日志", async () => {
  begin({ FAKE_PI_RPC_STARTUP_DIALOG: "1" });
  const uiFile = join(home, "calls.jsonl.ui.jsonl");
  for (let i = 0; i < 20 && !existsSync(uiFile); i++) await sleep(100);
  assert.deepEqual(JSON.parse(readFileSync(uiFile, "utf8").trim()), {
    type: "extension_ui_response",
    id: "startup-1",
    cancelled: true,
  });
  assert.match(readFileSync(join(home, "logs", "s1.log"), "utf8"), /\[dialog-cancelled\] select 启动时的提问/);
  assert.equal(run(["send", "s1", "hello"]).stdout, "echo:hello\n");
});

test("常驻进程先拿锁再读记录：记录不存在时以一行原因退出并释放锁", () => {
  ({ home } = setup());
  const result = spawnSync("node", [DAEMON, "nosuch", JSON.stringify({ isNew: false, piArgs: [] })], {
    env: { ...process.env, PI_BRIDGE_HOME: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "会话不存在：nosuch\n");
  assert.ok(!existsSync(join(home, "locks", "nosuch.lock")));
});

test("重复 start 报错；常驻进程运行时 rm 被拒绝；stop 后回到 print 模式", () => {
  begin();
  assert.match(run(["start", "s1"]).stderr, /已在运行/);
  assert.match(run(["rm", "s1"]).stderr, /正被占用/);

  assert.equal(run(["stop", "s1"]).code, 0);
  assert.ok(!existsSync(join(home, "run", "s1.sock")));
  assert.match(run(["list"]).stdout, /^s1\tidle\t/);

  assert.equal(run(["send", "s1", "hello"]).stdout, "echo:hello\n");
  assert.ok(piCalls().at(-1)!.argv.includes("-p"));
});

test("空闲超时后常驻进程自动退出", async () => {
  begin({ PI_BRIDGE_IDLE_MS: "300" });
  await sleep(1000);
  assert.match(run(["list"]).stdout, /^s1\tidle\t/);
  assert.ok(!existsSync(join(home, "run", "s1.sock")));
});

test("pi 启动失败时 start 报错并带上输出", () => {
  ({ home } = setup({ FAKE_PI_RPC_FAIL: "1" }));
  const result = run(["start", "s1"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /常驻进程启动失败[\s\S]*boom/);
});
