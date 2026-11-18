import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { gitIn, initRepo, piCalls, recordId, run, setup } from "./helpers.ts";

let home: string;
let work: string;

beforeEach(() => {
  ({ home, work } = setup());
  initRepo(work);
});

afterEach(() => {
  for (const name of ["w1", "s1", "s2"]) run(["stop", name]);
});

const worktreeOf = (name: string): string => join(work, ".pi-bridge", "worktrees", name);

test("会话名：拒绝首尾不是字母或数字、含 ..、以 .lock 结尾的名字，且不留下记录", () => {
  for (const name of [".", "..", ".x", "_task", "task-", "task.", "a..b", "x.lock"]) {
    const result = run(["send", name, "hi"]);
    assert.equal(result.code, 1, name);
    assert.match(result.stderr, /会话名/, name);
  }
  assert.equal(run(["list"]).stdout, "（没有会话）\n");
  assert.equal(piCalls().length, 0);
});

test("send --worktree 创建 worktree 与分支，pi 在 worktree 中运行", () => {
  const result = run(["send", "w1", "--worktree", "hello"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "echo:hello\n");

  const path = worktreeOf("w1");
  assert.equal(piCalls()[0]!.cwd, path);
  assert.equal(gitIn(path, "branch", "--show-current").trim(), "pi/w1");
  const exclude = readFileSync(join(work, ".git", "info", "exclude"), "utf8");
  assert.ok(exclude.split("\n").includes("/.pi-bridge/"));
  assert.equal(gitIn(work, "status", "--porcelain"), "");

  const base = gitIn(work, "rev-parse", "HEAD").trim();
  assert.match(run(["list"]).stdout, new RegExp(`^w1\\tidle\\t.*\\tpi/w1@${base.slice(0, 12)}$`, "m"));

  assert.equal(run(["send", "w1", "again"]).code, 0);
  assert.equal(piCalls()[1]!.cwd, path);
});

test("list 从主仓库根、worktree 内、子目录内都看到同一主仓库的全部会话", () => {
  assert.equal(run(["send", "w1", "--worktree", "hello"]).code, 0);
  const sub = join(work, "sub");
  mkdirSync(sub, { recursive: true });
  assert.equal(run(["send", "s1", "--cwd", sub, "hello"]).code, 0);

  const wt = worktreeOf("w1");
  // worktree 会话归到主仓库，主仓库子目录会话也在同一身份下：三处都应同时看到 w1 与 s1
  for (const cwd of [work, wt, sub]) {
    const out = run(["list"], { cwd }).stdout;
    assert.match(out, /^w1\t/m, `from ${cwd}`);
    assert.match(out, /^s1\t/m, `from ${cwd}`);
  }
  // 都 idle 时 --active 为空，并提示去掉 --active
  assert.match(run(["list", "--active"], { cwd: wt }).stdout, /都不活跃；去掉 --active/);
});

test("list 把绑定在外置 linked worktree 的会话归到主仓库，从主仓库或该 worktree 都能看到", () => {
  const ext = join(dirname(work), `${basename(work)}-ext`);
  gitIn(work, "worktree", "add", "-b", "feat-ext", ext, "HEAD");
  const now = new Date().toISOString();
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions", "ext.json"), JSON.stringify({ name: "ext", cwd: ext, createdAt: now, updatedAt: now }));

  // 记录侧也按主仓库归属：从外置 worktree 自身、从主仓库根都能看到 ext
  assert.match(run(["list"], { cwd: ext }).stdout, /^ext\t/m);
  assert.match(run(["list"], { cwd: work }).stdout, /^ext\t/m);
});

test("list 对 --separate-git-dir 仓库：主工作区与其 linked worktree 共享身份", () => {
  const base = dirname(work);
  const w = join(base, `${basename(work)}-sep`);
  const gitDir = join(base, `${basename(work)}-sep.git`);
  const wt = join(base, `${basename(work)}-sep-wt`);
  gitIn(base, "init", "-q", `--separate-git-dir=${gitDir}`, w);
  writeFileSync(join(w, "a.txt"), "a\n");
  gitIn(w, "add", ".");
  gitIn(w, "commit", "-q", "-m", "init");
  gitIn(w, "worktree", "add", "-q", "-b", "feat", wt, "HEAD");

  const now = new Date().toISOString();
  mkdirSync(join(home, "sessions"), { recursive: true });
  const wrec = (name: string, cwd: string): void =>
    writeFileSync(join(home, "sessions", `${name}.json`), JSON.stringify({ name, cwd, createdAt: now, updatedAt: now }));
  wrec("main-sess", w);
  wrec("wt-sess", wt);

  // worktree list 首条此时是 git 目录而非工作区，靠共享 git-common-dir 归一：两处都看到两个会话
  for (const cwd of [w, wt]) {
    const out = run(["list"], { cwd }).stdout;
    assert.match(out, /^main-sess\t/m, `from ${cwd}`);
    assert.match(out, /^wt-sess\t/m, `from ${cwd}`);
  }
});

test("list 对子模块：从子模块只列自身，从父仓库按子树纳入", () => {
  const base = dirname(work);
  const donor = join(base, `${basename(work)}-donor`);
  mkdirSync(donor, { recursive: true });
  gitIn(donor, "init", "-q", "-b", "main");
  writeFileSync(join(donor, "d.txt"), "d\n");
  gitIn(donor, "add", ".");
  gitIn(donor, "commit", "-q", "-m", "d");
  gitIn(work, "-c", "protocol.file.allow=always", "submodule", "add", "-q", donor, "sub");
  gitIn(work, "commit", "-q", "-m", "add sub");
  const sub = join(work, "sub");

  const now = new Date().toISOString();
  mkdirSync(join(home, "sessions"), { recursive: true });
  const wrec = (name: string, cwd: string): void =>
    writeFileSync(join(home, "sessions", `${name}.json`), JSON.stringify({ name, cwd, createdAt: now, updatedAt: now }));
  wrec("parent-sess", work);
  wrec("sub-sess", sub);

  // 子模块是独立仓库身份：从子模块执行不反向拉入父仓库会话
  const fromSub = run(["list"], { cwd: sub }).stdout;
  assert.match(fromSub, /^sub-sess\t/m);
  assert.doesNotMatch(fromSub, /^parent-sess\t/m);
  // 从父仓库执行：子模块按子树单向纳入
  const fromParent = run(["list"], { cwd: work }).stdout;
  assert.match(fromParent, /^parent-sess\t/m);
  assert.match(fromParent, /^sub-sess\t/m);
});

test("已存在的会话加 --worktree 报错", () => {
  run(["send", "w1", "hello"]);
  const result = run(["send", "w1", "--worktree", "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /只能在创建会话时指定/);
});

test("非 git 目录、空仓库、分支已存在时报错且不留下记录或 worktree", () => {
  const plain = run(["send", "w1", "--worktree", "--cwd", home, "hello"]);
  assert.match(plain.stderr, /不在 git 仓库内/);

  gitIn(work, "branch", "pi/w1");
  const branchExists = run(["send", "w1", "--worktree", "hello"]);
  assert.match(branchExists.stderr, /分支已存在/);
  assert.ok(!existsSync(worktreeOf("w1")));

  rmSync(join(work, ".git"), { recursive: true });
  gitIn(work, "init", "-q");
  const empty = run(["send", "w1", "--worktree", "hello"]);
  assert.match(empty.stderr, /还没有任何提交/);

  assert.equal(run(["list"]).stdout, "（没有会话）\n");
  assert.deepEqual(piCalls(), []);
});

test("写会话记录失败时回滚 worktree 与分支", () => {
  run(["list"]);
  chmodSync(join(home, "sessions"), 0o555);
  let result;
  try {
    result = run(["send", "w1", "--worktree", "hello"]);
  } finally {
    chmodSync(join(home, "sessions"), 0o755);
  }
  assert.equal(result.code, 1);
  assert.ok(!existsSync(worktreeOf("w1")));
  assert.equal(gitIn(work, "branch", "--list", "pi/w1"), "");
});

test("从 linked worktree 中创建时，排除规则写入共享的 info/exclude", () => {
  const linked = join(home, "linked");
  gitIn(work, "worktree", "add", "-q", linked);
  const result = run(["send", "w1", "--worktree", "--cwd", linked, "hello"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(piCalls()[0]!.cwd, join(linked, ".pi-bridge", "worktrees", "w1"));
  assert.ok(readFileSync(join(work, ".git", "info", "exclude"), "utf8").includes("/.pi-bridge/"));
});

test("rm：有未提交改动时拒绝，--force 删除 worktree 且保留分支", () => {
  run(["send", "w1", "--worktree", "write:x.txt"]);
  const refused = run(["rm", "w1"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /未提交的改动/);
  assert.ok(existsSync(worktreeOf("w1")));
  assert.match(run(["list"]).stdout, /^w1\t/);

  const forced = run(["rm", "w1", "--force"]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /分支 pi\/w1 保留/);
  assert.ok(!existsSync(worktreeOf("w1")));
  assert.equal(gitIn(work, "branch", "--list", "pi/w1").trim(), "pi/w1");
});

test("rm：worktree 会话给出 pi 会话文件的绝对路径（worktree 删除后无法回到原 cwd 用 --session-id）", () => {
  run(["send", "w1", "--worktree", "hello"]);
  const id = recordId("w1");
  const dir = join(home, "pi-agent", "sessions", `--${worktreeOf("w1").replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-11-18T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-18T00:00:00.000Z", cwd: worktreeOf("w1") })}\n`);

  const removed = run(["rm", "w1"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(
    removed.stdout,
    `已删除会话 w1，同名再 send 会新建 pi 会话；pi 会话文件仍保留，pi --session '${file}' 可打开旧历史；worktree 已删除，分支 pi/w1 保留\n`,
  );
  assert.equal(existsSync(worktreeOf("w1")), false);
});

test("rm：worktree 当前提交不在任何分支上时，即使 --force 也拒绝删除", () => {
  run(["send", "w1", "--worktree", "hello"]);
  const path = worktreeOf("w1");
  gitIn(path, "checkout", "-q", "--detach");
  writeFileSync(join(path, "lost.txt"), "only here\n");
  gitIn(path, "add", "lost.txt");
  gitIn(path, "commit", "-q", "-m", "detached");
  const result = run(["rm", "w1", "--force"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /不在任何本地分支上/);
  assert.ok(existsSync(path));
  assert.match(run(["list"]).stdout, /^w1\t/);
});

test("worktree add 本身失败时回滚分支与 worktree", () => {
  const hook = join(work, ".git", "hooks", "post-checkout");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const result = run(["send", "w1", "--worktree", "hello"]);
  assert.equal(result.code, 1);
  assert.ok(!existsSync(worktreeOf("w1")));
  assert.equal(gitIn(work, "branch", "--list", "pi/w1"), "");
  assert.doesNotMatch(gitIn(work, "worktree", "list"), /w1/);
  assert.deepEqual(piCalls(), []);
});

test("常驻进程中 pi 异常退出时，失败信息附改动清单", () => {
  const result = run(["send", "s1", "--role", "executor", "crash:z.txt"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /pi 进程退出[\s\S]*本次运行改动了 1 个文件：\n\?\? z\.txt/);
});

test("rm：worktree 目录已被删除、登记的提交不在任何分支上时拒绝，登记保留", () => {
  run(["send", "w1", "--worktree", "hello"]);
  const path = worktreeOf("w1");
  gitIn(path, "checkout", "-q", "--detach");
  writeFileSync(join(path, "lost.txt"), "only here\n");
  gitIn(path, "add", "lost.txt");
  gitIn(path, "commit", "-q", "-m", "detached");
  const head = gitIn(path, "rev-parse", "HEAD").trim();
  rmSync(path, { recursive: true });

  const result = run(["rm", "w1", "--force"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /目录已不存在，但它登记的提交/);
  assert.match(result.stderr, new RegExp(`branch <分支名> ${head}`));
  assert.match(gitIn(work, "worktree", "list", "--porcelain"), new RegExp(`HEAD ${head}`));
  assert.match(run(["list"]).stdout, /^w1\t/);
});

test("rm：只清理本会话的 worktree 登记，不影响仓库中其他已删除的 worktree", () => {
  const other = join(home, "other-wt");
  gitIn(work, "worktree", "add", "-q", "-b", "other", other);
  rmSync(other, { recursive: true });
  run(["send", "w1", "--worktree", "hello"]);
  rmSync(worktreeOf("w1"), { recursive: true });

  assert.equal(run(["rm", "w1"]).code, 0);
  const list = gitIn(work, "worktree", "list", "--porcelain");
  assert.match(list, new RegExp(`worktree ${other}`));
  assert.doesNotMatch(list, /w1/);
});

test("rm：worktree 已被手动删除时正常完成", () => {
  run(["send", "w1", "--worktree", "hello"]);
  rmSync(worktreeOf("w1"), { recursive: true });
  const result = run(["rm", "w1"]);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(gitIn(work, "worktree", "list"), /w1/);
});

test("改动清单：同一目录下附上 executor 本次运行改动的文件，无改动时不输出", () => {
  assert.equal(run(["send", "s1", "--role", "executor", "hello"]).stdout, "echo:hello\n");
  const result = run(["send", "s1", "--role", "executor", "write:new.txt"]);
  assert.equal(result.stdout, "echo:write:new.txt\n\n[pi-bridge] 本次运行改动了 1 个文件：\n?? new.txt\n");
});

test("改动清单：worktree 中 pi 提交的文件标为已提交", () => {
  const result = run(["send", "w1", "--worktree", "--role", "executor", "commit:c.txt"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /本次运行改动了 1 个文件：\nA c\.txt \(已提交\)\n$/);
});

test("executor --worktree：常驻进程在 worktree 中运行，每次 send 附改动清单", () => {
  const result = run(["send", "w1", "--worktree", "--role", "executor", "write:d.txt"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(piCalls()[0]!.cwd, worktreeOf("w1"));
  assert.match(result.stdout, /本次运行改动了 1 个文件：\n\?\? d\.txt\n$/);
  assert.equal(run(["send", "w1", "--role", "executor", "hello"]).stdout, "echo:hello\n");
});

test("advisor 运行不附改动清单", () => {
  const result = run(["send", "s1", "write:new.txt"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "echo:write:new.txt\n");
});

test("非 git 目录不附改动清单", () => {
  writeFileSync(join(home, "marker"), "");
  const result = run(["send", "s2", "--role", "executor", "--cwd", home, "write:y.txt"]);
  assert.equal(result.stdout, "echo:write:y.txt\n");
});
