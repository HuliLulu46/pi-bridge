import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import {
  collectReview,
  describeChanges,
  displayPath,
  takeSnapshot,
  trackChanges,
} from "../plugins/pi-bridge/src/git.ts";
import { GIT_ENV, gitIn, initRepo } from "./helpers.ts";

Object.assign(process.env, GIT_ENV);

let repo: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "pi-bridge-git-")));
  initRepo(repo);
});

function changesDuring(action: () => void): string[] {
  const before = takeSnapshot(repo);
  action();
  return describeChanges(repo, before, takeSnapshot(repo));
}

test("快照对比识别修改、新增、删除原有未跟踪文件与运行中的提交", () => {
  writeFileSync(join(repo, "keep.txt"), "untracked before\n");
  const lines = changesDuring(() => {
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "c.txt"), "new\n");
    unlinkSync(join(repo, "keep.txt"));
    writeFileSync(join(repo, "d.txt"), "committed\n");
    gitIn(repo, "add", "d.txt");
    gitIn(repo, "commit", "-q", "-m", "d");
  });
  assert.deepEqual(lines, [" M a.txt", "?? c.txt", "A d.txt (已提交)", "删除未跟踪文件 keep.txt"]);
});

test("已改动的文件再次修改会被识别，恢复干净的文件标为恢复", () => {
  writeFileSync(join(repo, "a.txt"), "first\n");
  assert.deepEqual(
    changesDuring(() => writeFileSync(join(repo, "a.txt"), "second\n")),
    [" M a.txt"],
  );
  assert.deepEqual(
    changesDuring(() => gitIn(repo, "checkout", "--", "a.txt")),
    ["恢复 a.txt"],
  );
});

test("没有改动时清单为空", () => {
  writeFileSync(join(repo, "a.txt"), "dirty\n");
  assert.deepEqual(changesDuring(() => {}), []);
});

test("重命名表现为一删一增", () => {
  assert.deepEqual(
    changesDuring(() => gitIn(repo, "mv", "a.txt", "r.txt")),
    ["D  a.txt", "A  r.txt"],
  );
});

test("嵌套仓库等目录路径不会导致快照失败", () => {
  const sub = join(repo, "sub");
  mkdirSync(sub);
  initRepo(sub);
  assert.deepEqual(changesDuring(() => {}), []);
});

test("无提交的仓库在运行中产生首次提交，提交的文件列为已提交", () => {
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "pi-bridge-empty-")));
  gitIn(empty, "init", "-q");
  const before = takeSnapshot(empty);
  writeFileSync(join(empty, "first.txt"), "first\n");
  gitIn(empty, "add", "first.txt");
  gitIn(empty, "commit", "-q", "-m", "first");
  assert.deepEqual(describeChanges(empty, before, takeSnapshot(empty)), ["A first.txt (已提交)"]);
});

test("FIFO 等特殊文件不会让快照或评审收集阻塞（git 不把它们列为未跟踪文件）", () => {
  execFileSync("mkfifo", [join(repo, "pipe")]);
  assert.deepEqual(changesDuring(() => writeFileSync(join(repo, "a.txt"), "x\n")), [" M a.txt"]);
  assert.deepEqual(collectReview(repo, { kind: "head" })!.untracked, []);
});

/** 生成 \uXXXX 形式的转义文本，源码中不直接写转义序列 */
const escaped = (code: number): string => `${String.fromCharCode(92)}u${code.toString(16).padStart(4, "0")}`;

test("改动清单中的特殊文件名以转义形式输出，不能伪造或隐藏清单行", () => {
  const forged = `evil${String.fromCharCode(0x0a)} M fake.txt`;
  const colored = `color${String.fromCharCode(0x1b)}[31mred.txt`;
  const separated = `sep${String.fromCharCode(0x2028)}x.txt`;
  const finish = trackChanges(repo);
  for (const name of [forged, colored, separated, "plain.txt"]) writeFileSync(join(repo, name), "x\n");
  const [, , header, ...lines] = finish().split("\n");
  assert.equal(header, "[pi-bridge] 本次运行改动了 4 个文件：");
  assert.deepEqual(lines, [
    `?? "color${escaped(0x1b)}[31mred.txt"`,
    `?? "evil${escaped(0x0a)} M fake.txt"`,
    "?? plain.txt",
    `?? "sep${escaped(0x2028)}x.txt"`,
  ]);
});

test("displayPath：普通路径原样输出，引号与反斜杠在转义形式中也被转义", () => {
  assert.equal(displayPath("src/普通 文件.ts"), "src/普通 文件.ts");
  const tricky = `a"b${String.fromCharCode(92)}c${String.fromCharCode(0x09)}`;
  assert.equal(displayPath(tricky), `"a${String.fromCharCode(92)}"b${String.fromCharCode(92, 92)}c${escaped(0x09)}"`);
});

test("trackChanges：非 git 目录输出为空；统计失败只附一行提示", () => {
  const plain = mkdtempSync(join(tmpdir(), "pi-bridge-plain-"));
  assert.equal(trackChanges(plain)(), "");

  const finish = trackChanges(repo);
  rmSync(join(repo, ".git"), { recursive: true });
  assert.match(finish(), /^\n\n\[pi-bridge\] 改动统计失败：/);
});

test("trackChanges：有改动时输出清单", () => {
  const finish = trackChanges(repo);
  writeFileSync(join(repo, "n.txt"), "n\n");
  assert.equal(finish(), "\n\n[pi-bridge] 本次运行改动了 1 个文件：\n?? n.txt");
});

test("collectReview：默认范围含已跟踪改动与未跟踪文件内容", () => {
  writeFileSync(join(repo, "a.txt"), "changed\n");
  writeFileSync(join(repo, "new.txt"), "hello new\n");
  const review = collectReview(repo, { kind: "head" })!;
  assert.match(review.patch, /\+changed/);
  assert.match(review.patch, /未跟踪的新文件：new\.txt ===\nhello new/);
  assert.deepEqual(review.untracked, ["?? new.txt"]);
  assert.match(review.stat, /a\.txt/);
});

test("collectReview：--staged 只含暂存改动，不含未跟踪文件", () => {
  writeFileSync(join(repo, "a.txt"), "staged\n");
  gitIn(repo, "add", "a.txt");
  writeFileSync(join(repo, "new.txt"), "x\n");
  const review = collectReview(repo, { kind: "staged" })!;
  assert.match(review.patch, /\+staged/);
  assert.doesNotMatch(review.patch, /new\.txt/);
  assert.deepEqual(review.untracked, []);
});

test("collectReview：--base 含分叉点以来的提交、未提交改动与未跟踪文件", () => {
  gitIn(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "f.txt"), "feature commit\n");
  gitIn(repo, "add", "f.txt");
  gitIn(repo, "commit", "-q", "-m", "f");
  writeFileSync(join(repo, "a.txt"), "uncommitted\n");
  writeFileSync(join(repo, "u.txt"), "untracked\n");
  const review = collectReview(repo, { kind: "base", ref: "main" })!;
  assert.match(review.patch, /\+feature commit/);
  assert.match(review.patch, /\+uncommitted/);
  assert.deepEqual(review.untracked, ["?? u.txt"]);
});

test("collectReview：二进制、超大、符号链接的未跟踪文件只列出不内联", () => {
  writeFileSync(join(repo, "bin.dat"), Buffer.from([1, 0, 2]));
  writeFileSync(join(repo, "big.txt"), "x".repeat(60 * 1024));
  symlinkSync("a.txt", join(repo, "link"));
  const review = collectReview(repo, { kind: "head" })!;
  assert.deepEqual(review.untracked, [
    "?? big.txt（61440 字节，未内联）",
    "?? bin.dat（二进制，3 字节，未内联）",
    "?? link（符号链接，指向 a.txt）",
  ]);
  assert.equal(review.patch, "");
});

test("collectReview：没有改动返回 undefined；不在仓库或仓库无提交时报错", () => {
  assert.equal(collectReview(repo, { kind: "head" }), undefined);
  assert.throws(() => collectReview(mkdtempSync(join(tmpdir(), "pi-bridge-plain-")), { kind: "head" }), /不在 git 仓库内/);
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "pi-bridge-empty-")));
  gitIn(empty, "init", "-q");
  writeFileSync(join(empty, "x.txt"), "x\n");
  assert.throws(() => collectReview(empty, { kind: "head" }), /还没有任何提交/);
});
