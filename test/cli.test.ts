import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("--role 只接受 advisor、editor 或 executor", () => {
  const result = run(["send", "s1", "--role", "boss", "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--role 只能是 advisor、editor 或 executor/);
  assert.equal(run(["list"]).stdout, "（没有会话）\n");
});

test("--role editor 仅 qoder 引擎可用：pi 会话（含已绑定 pi）被拒绝", () => {
  const result = run(["send", "s1", "--role", "editor", "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--role editor 仅 qoder 引擎可用/);
  assert.deepEqual(piCalls(), []);
  assert.equal(run(["list"]).stdout, "（没有会话）\n");

  run(["send", "s2", "hello"]);
  const bound = run(["send", "s2", "--role", "editor", "--engine", "qoder", "hello"]);
  assert.equal(bound.code, 1);
  assert.match(bound.stderr, /--role editor 仅 qoder 引擎可用/);
  assert.equal(piCalls().length, 1);
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

test("没有运行时 watch 等待期满后回放上一次运行，退出码随上一次的结果", () => {
  run(["send", "s1", "fail"]);
  const failed = run(["watch", "s1"]);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /^\[idle\] 会话 s1 当前没有任务在运行，以下是上一次运行的记录\n\[start\] /);
  assert.match(failed.stdout, /\[failed\]\n$/);

  run(["send", "s1", "hello"]);
  const done = run(["watch", "s1"]);
  assert.equal(done.code, 0);
  assert.match(done.stdout, /echo:hello\n\[done\]\n$/);
});

test("两次查找之间开始并结束的运行，watch 立即回放，不等到等待期满", async () => {
  run(["send", "s1", "hello"]);
  const started = Date.now();
  const watched = runAsync(["watch", "s1"]);
  await sleep(500);
  writeFileSync(join(home, "logs", "s1.log"), "[start] fast\n[reply]\necho:fast\n[done]\n");
  const result = await watched;
  assert.equal(result.code, 0);
  assert.ok(Date.now() - started < 2500);
  assert.doesNotMatch(result.stdout, /\[idle\]/);
  assert.match(result.stdout, /echo:fast\n\[done\]\n$/);
});

test("上一次运行没有结束标记时，回放后以 [failed] 结束", () => {
  run(["send", "s1", "hello"]);
  writeFileSync(join(home, "logs", "s1.log"), "[start] crashed\n[tool] read {}\n");
  const result = run(["watch", "s1"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\[tool\] read \{\}\n\[failed\] 上一次运行没有结束标记，可能异常中断\n$/);
});

test("watch 可以先于首次 send 启动；等待期满仍没有会话时报错", async () => {
  const watched = runAsync(["watch", "s1"]);
  await sleep(300);
  const sent = runAsync(["send", "s1", "slow"]);
  const result = await watched;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^\[start\] .*slow[\s\S]*echo:slow\n\[done\]\n$/);
  await sent;

  const missing = run(["watch", "nosuch"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /会话不存在：nosuch/);
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

  const removed = run(["rm", "old"]);
  assert.equal(removed.code, 0);
  assert.ok(removed.stdout.includes(`这是旧格式会话，同名再 send 会新建会话，旧历史在 ${work} 执行 pi --session-id ${id} 打开`));
});

test("list 默认按当前项目过滤，--all 看全部，--here 等同默认", () => {
  const now = new Date().toISOString();
  mkdirSync(join(home, "sessions"), { recursive: true });
  const write = (name: string, cwd: string): void =>
    writeFileSync(join(home, "sessions", `${name}.json`), JSON.stringify({ name, cwd, createdAt: now, updatedAt: now }));
  write("inwork", work);
  write("elsewhere", home);

  const here = run(["list"]);
  assert.match(here.stdout, /^inwork\t/m);
  assert.doesNotMatch(here.stdout, /^elsewhere\t/m);
  assert.equal(run(["list", "--here"]).stdout, here.stdout);

  const all = run(["list", "--all"]);
  assert.match(all.stdout, /^inwork\t/m);
  assert.match(all.stdout, /^elsewhere\t/m);

  const fromHome = run(["list"], { cwd: home });
  assert.match(fromHome.stdout, /^elsewhere\t/m);
  assert.doesNotMatch(fromHome.stdout, /^inwork\t/m);

  const conflict = run(["list", "--all", "--here"]);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /--all 与 --here 不能同时使用/);
});

test("list 把 worktree 会话归到其主仓库，从主仓库根能看到并附 分支@base", () => {
  const now = new Date().toISOString();
  mkdirSync(join(home, "sessions"), { recursive: true });
  const wt = join(work, ".pi-bridge", "worktrees", "w1");
  mkdirSync(wt, { recursive: true });
  writeFileSync(
    join(home, "sessions", "w1.json"),
    JSON.stringify({
      name: "w1",
      cwd: wt,
      createdAt: now,
      updatedAt: now,
      worktree: { repo: work, branch: "pi/w1", base: "0".repeat(40) },
    }),
  );

  // 会话 cwd 在 worktree 深处，但以 worktree.repo（主仓库）归属，从主仓库根即可命中
  const fromRepo = run(["list"]);
  assert.match(fromRepo.stdout, /^w1\tidle\t/m);
  assert.ok(fromRepo.stdout.includes("pi/w1@000000000000"));
  // 真实 worktree（git 共享仓库身份）下从 worktree 内也能命中，见 worktree.test.ts
});

test("list --engine 按引擎过滤，--active 只列活跃会话，空范围给出对应提示", () => {
  const now = new Date().toISOString();
  mkdirSync(join(home, "sessions"), { recursive: true });
  const write = (name: string, extra: object = {}): void =>
    writeFileSync(join(home, "sessions", `${name}.json`), JSON.stringify({ name, cwd: work, createdAt: now, updatedAt: now, ...extra }));
  write("p1");
  write("q1", { engine: "qoder" });

  const onlyQoder = run(["list", "--engine", "qoder"]);
  assert.match(onlyQoder.stdout, /^q1\t/m);
  assert.doesNotMatch(onlyQoder.stdout, /^p1\t/m);

  const onlyPi = run(["list", "--engine", "pi"]);
  assert.match(onlyPi.stdout, /^p1\t/m);
  assert.doesNotMatch(onlyPi.stdout, /^q1\t/m);

  const bad = run(["list", "--engine", "nope"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--engine 只能是 pi 或 qoder/);

  // 两个都是 idle：--active 过滤后为空
  assert.equal(run(["list", "--active"]).stdout, "（当前范围有 2 个会话，但都不活跃；去掉 --active 查看）\n");
  // 当前项目里没有会话（都在 work，却从 home 列）
  assert.equal(run(["list"], { cwd: home }).stdout, "（当前范围没有会话，全部 2 个；试试 --all 看全部项目）\n");
});

test("list 项目范围解析符号链接、区分同前缀目录、接受 .. 开头的合法子目录名", () => {
  const now = new Date().toISOString();
  mkdirSync(join(home, "sessions"), { recursive: true });
  const write = (name: string, cwd: string): void =>
    writeFileSync(join(home, "sessions", `${name}.json`), JSON.stringify({ name, cwd, createdAt: now, updatedAt: now }));

  // 子目录名以 .. 开头，仍是 work 的合法子目录，不应被当成越界
  mkdirSync(join(work, "..cache"), { recursive: true });
  write("cache", join(work, "..cache"));
  // 与 work 同前缀的兄弟目录（work vs workX），不属于当前项目
  const sibling = `${work}X`;
  mkdirSync(sibling, { recursive: true });
  write("sib", sibling);
  // 指向 work 的符号链接别名下登记的会话：解析后应归到 work
  const alias = join(home, "alias");
  symlinkSync(work, alias);
  mkdirSync(join(work, "nested"), { recursive: true });
  write("aliased", join(alias, "nested"));

  const out = run(["list"]).stdout; // 从 work 执行
  assert.match(out, /^cache\t/m);
  assert.match(out, /^aliased\t/m);
  assert.doesNotMatch(out, /^sib\t/m);
});
