import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { gitIn, initRepo, piCalls, run, setup } from "./helpers.ts";

let home: string;
let work: string;

beforeEach(() => {
  ({ home, work } = setup());
  initRepo(work);
});

afterEach(() => {
  run(["stop", "w1"]);
  run(["stop", "s1"]);
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
  assert.equal(run(["start", "s1"]).code, 0);
  const result = run(["send", "s1", "crash:z.txt"]);
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

test("改动清单：同一目录下附上本次运行改动的文件，无改动时不输出", () => {
  assert.equal(run(["send", "s1", "hello"]).stdout, "echo:hello\n");
  const result = run(["send", "s1", "write:new.txt"]);
  assert.equal(result.stdout, "echo:write:new.txt\n\n[pi-bridge] 本次运行改动了 1 个文件：\n?? new.txt\n");
});

test("改动清单：worktree 中 pi 提交的文件标为已提交", () => {
  const result = run(["send", "w1", "--worktree", "commit:c.txt"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /本次运行改动了 1 个文件：\nA c\.txt \(已提交\)\n$/);
});

test("start --worktree：常驻进程在 worktree 中运行，每次 send 附改动清单", () => {
  assert.equal(run(["start", "w1", "--worktree"]).code, 0);
  assert.equal(piCalls()[0]!.cwd, worktreeOf("w1"));
  const result = run(["send", "w1", "write:d.txt"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /本次运行改动了 1 个文件：\n\?\? d\.txt\n$/);
  assert.equal(run(["send", "w1", "hello"]).stdout, "echo:hello\n");
});

test("非 git 目录不附改动清单", () => {
  writeFileSync(join(home, "marker"), "");
  const result = run(["send", "s2", "--cwd", home, "write:y.txt"]);
  assert.equal(result.stdout, "echo:write:y.txt\n");
});
