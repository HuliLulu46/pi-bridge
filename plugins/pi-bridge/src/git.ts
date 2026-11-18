import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WorktreeInfo } from "./store.ts";

const MAX_BUFFER = 512 * 1024 * 1024;
const UNTRACKED_INLINE_LIMIT = 50 * 1024;
const EXCLUDE_RULE = "/.pi-bridge/";

function run(cwd: string, args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", input, maxBuffer: MAX_BUFFER });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: (result.stderr || result.error?.message || "").trim() };
}

function git(cwd: string, args: string[], input?: string): string {
  const result = run(cwd, args, input);
  if (!result.ok) throw new Error(`git ${args.join(" ")} 失败：${result.stderr}`);
  return result.stdout;
}

function tryGit(cwd: string, args: string[]): string | undefined {
  const result = run(cwd, args);
  return result.ok ? result.stdout.trim() : undefined;
}

/** 不在 git 仓库内时返回 undefined */
export function repoRoot(cwd: string): string | undefined {
  return tryGit(cwd, ["rev-parse", "--show-toplevel"]);
}

export interface RepoIdentity {
  /** 本工作区根；不在 git 仓库内时为 undefined */
  toplevel?: string;
  /** 共享 Git 目录：同一仓库的主工作区、子目录与所有 linked worktree（含 --separate-git-dir）都一致；子模块为其 .git/modules/<名>，必在祖先仓库 common 之下 */
  common?: string;
}

/** 单个 rev-parse 字段：只去掉输出末尾的换行，保留路径内部的空白与换行 */
function revParseField(cwd: string, flag: string): string | undefined {
  const result = run(cwd, ["rev-parse", flag]);
  if (!result.ok) return undefined;
  return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
}

/** 解析符号链接使 .git 被软链到别处时身份仍可比；不存在时原样返回 */
function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * 解析一个目录的 Git 身份，供 list 判定“同一项目”。
 * 以 common（共享 Git 目录）识别仓库：它对普通仓库、子目录、内置/外置 linked worktree、--separate-git-dir 都一致，
 * 且子模块的 common 必在祖先仓库 common 之下，因此“同一仓库或嵌套”可直接由 common 的包含关系判定，与各 worktree 的 toplevel 无关。
 * 不依赖 worktree list（--separate-git-dir 下其首条是 Git 目录而非工作区）或 dirname(common)（子模块下错误）。
 * 不在 git 仓库内时两个字段都为 undefined。
 */
export function projectIdentity(cwd: string): RepoIdentity {
  const toplevel = revParseField(cwd, "--show-toplevel");
  if (toplevel === undefined || toplevel === "") return {};
  const commonDir = revParseField(cwd, "--git-common-dir");
  // 经 resolve 归一后再解析符号链接：.git 被软链到别处时，主工作区与 linked worktree 报出的 common 才能一致
  const common = commonDir === undefined || commonDir === "" ? undefined : realPathOrSelf(resolve(cwd, commonDir));
  return { toplevel, common };
}

function headCommit(root: string): string | undefined {
  return tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
}

function splitNul(output: string): string[] {
  return output.split("\0").filter((item) => item !== "");
}

/** 控制字符、行分隔符与双向文本控制符能伪造或隐藏输出行；以码点区间表示，源码中不出现这些字符本身 */
const UNSAFE_CODE_POINTS: Array<[number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x7f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

function isUnsafe(char: string): boolean {
  const code = char.codePointAt(0)!;
  return UNSAFE_CODE_POINTS.some(([low, high]) => code >= low && code <= high);
}

/** 含上述字符的路径输出为带引号的转义形式，其余原样输出 */
export function displayPath(path: string): string {
  if (![...path].some(isUnsafe)) return path;
  let quoted = '"';
  for (const char of path) {
    if (char === '"' || char === "\\") quoted += `\\${char}`;
    else if (isUnsafe(char)) quoted += `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`;
    else quoted += char;
  }
  return `${quoted}"`;
}

// ---------- 改动清单 ----------

interface Snapshot {
  head: string | undefined;
  /** 路径（相对仓库根目录） → 两位状态码与内容哈希（文件不存在或是目录时为空串） */
  entries: Map<string, { code: string; hash: string }>;
}

export function takeSnapshot(root: string): Snapshot {
  const entries = new Map<string, { code: string; hash: string }>();
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  for (const item of splitNul(status)) entries.set(item.slice(3), { code: item.slice(0, 2), hash: "" });

  // 只对普通文件取内容哈希：目录（如子模块）只比较状态码，FIFO 等特殊文件读取会阻塞
  const files: string[] = [];
  for (const path of entries.keys()) {
    const full = join(root, path);
    if (!existsSync(full)) continue;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) entries.get(path)!.hash = `link:${readlinkSync(full)}`;
    else if (stat.isFile()) files.push(path);
  }
  // --stdin-paths 以换行分隔路径，含换行的路径单独计算
  const batch = files.filter((path) => !path.includes("\n"));
  if (batch.length > 0) {
    const hashes = git(root, ["hash-object", "--no-filters", "--stdin-paths"], `${batch.join("\n")}\n`).trim().split("\n");
    batch.forEach((path, index) => (entries.get(path)!.hash = hashes[index] ?? ""));
  }
  for (const path of files.filter((item) => item.includes("\n"))) {
    entries.get(path)!.hash = git(root, ["hash-object", "--no-filters", "--", path]).trim();
  }
  return { head: headCommit(root), entries };
}

function committedChanges(root: string, before: string | undefined, after: string | undefined): Array<[string, string]> {
  if (!after || before === after) return [];
  if (!before) {
    return splitNul(git(root, ["ls-tree", "-r", "--name-only", "-z", after])).map((path) => [
      path,
      `A ${displayPath(path)} (已提交)`,
    ]);
  }
  const items = splitNul(git(root, ["diff", "--name-status", "--no-renames", "-z", before, after]));
  const changes: Array<[string, string]> = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    changes.push([items[i + 1]!, `${items[i]} ${displayPath(items[i + 1]!)} (已提交)`]);
  }
  return changes;
}

export function describeChanges(root: string, before: Snapshot, after: Snapshot): string[] {
  const lines = new Map<string, string>(committedChanges(root, before.head, after.head));
  for (const [path, entry] of after.entries) {
    const previous = before.entries.get(path);
    if (!previous || previous.code !== entry.code || previous.hash !== entry.hash) {
      lines.set(path, `${entry.code} ${displayPath(path)}`);
    }
  }
  for (const [path, entry] of before.entries) {
    if (after.entries.has(path) || lines.has(path)) continue;
    const deletedUntracked = entry.code === "??" && !existsSync(join(root, path));
    lines.set(path, `${deletedUntracked ? "删除未跟踪文件" : "恢复"} ${displayPath(path)}`);
  }
  return [...lines.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, line]) => line);
}

/** 运行前调用，返回在运行结束时生成改动清单的函数。不在 git 仓库内时清单为空；统计失败只体现为一行提示 */
export function trackChanges(cwd: string): () => string {
  const failure = (err: unknown): string => `\n\n[pi-bridge] 改动统计失败：${(err as Error).message}`;
  let root: string | undefined;
  let before: Snapshot;
  try {
    root = repoRoot(cwd);
    if (!root) return () => "";
    before = takeSnapshot(root);
  } catch (err) {
    return () => failure(err);
  }
  return () => {
    try {
      const lines = describeChanges(root!, before, takeSnapshot(root!));
      return lines.length > 0 ? `\n\n[pi-bridge] 本次运行改动了 ${lines.length} 个文件：\n${lines.join("\n")}` : "";
    } catch (err) {
      return failure(err);
    }
  };
}

// ---------- worktree ----------

function ensureExcluded(repo: string): void {
  const file = resolve(repo, git(repo, ["rev-parse", "--git-path", "info/exclude"]).trim());
  const content = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (content.split("\n").includes(EXCLUDE_RULE)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${content === "" || content.endsWith("\n") ? "" : "\n"}${EXCLUDE_RULE}\n`);
}

interface CreatedWorktree {
  path: string;
  info: WorktreeInfo;
  /** 撤销本次创建的 worktree 与分支，返回未能完成的清理步骤 */
  rollback: () => string[];
}

/** git 为该路径登记的 worktree；目录已被删除时登记仍在，HEAD 同样可读 */
function registeredWorktree(repo: string, path: string): { head: string | undefined } | undefined {
  for (const record of git(repo, ["worktree", "list", "--porcelain", "-z"]).split("\0\0")) {
    const fields = splitNul(record);
    if (fields[0] !== `worktree ${path}`) continue;
    return { head: fields.find((field) => field.startsWith("HEAD "))?.slice("HEAD ".length) };
  }
  return undefined;
}

function onSomeBranch(repo: string, commit: string): boolean {
  return git(repo, ["branch", "--contains", commit, "--format=%(refname:short)"]).trim() !== "";
}

/** 只清理指定 worktree 的登记；git worktree prune 会连带清理仓库中其他已删除 worktree 的登记 */
function unregisterWorktree(repo: string, path: string): { ok: boolean; stderr: string } {
  return run(repo, ["worktree", "remove", "--force", path]);
}

function rollbackWorktree(repo: string, path: string, branch: string): string[] {
  const failures: string[] = [];
  if (existsSync(path) || registeredWorktree(repo, path)) {
    const removed = unregisterWorktree(repo, path);
    if (!removed.ok) failures.push(`删除 worktree ${path} 失败：${removed.stderr}`);
  }
  if (tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== undefined) {
    const deleted = run(repo, ["branch", "-D", branch]);
    if (!deleted.ok) failures.push(`删除分支 ${branch} 失败：${deleted.stderr}`);
  }
  return failures;
}

/** 把回滚中未完成的步骤附到原始错误上 */
export function rollbackError(err: unknown, failures: string[]): Error {
  const message = (err as Error).message;
  return new Error(failures.length > 0 ? `${message}；回滚未完成：${failures.join("；")}` : message);
}

export function createWorktree(cwd: string, name: string): CreatedWorktree {
  const repo = repoRoot(cwd);
  if (!repo) throw new Error(`不在 git 仓库内，无法创建 worktree：${cwd}`);
  const base = headCommit(repo);
  if (!base) throw new Error(`仓库还没有任何提交，无法创建 worktree：${repo}`);
  const branch = `pi/${name}`;
  if (tryGit(repo, ["check-ref-format", `refs/heads/${branch}`]) === undefined) throw new Error(`不能用作分支名：${branch}`);
  if (tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== undefined) {
    throw new Error(`分支已存在：${branch}`);
  }
  const path = join(repo, ".pi-bridge", "worktrees", name);
  if (existsSync(path)) throw new Error(`worktree 路径已存在：${path}`);

  // 前面已确认分支与路径都不存在，回滚时删除它们不会误删已有内容
  const rollback = (): string[] => rollbackWorktree(repo, path, branch);
  try {
    git(repo, ["worktree", "add", "--quiet", "-b", branch, path, base]);
    ensureExcluded(repo);
  } catch (err) {
    throw rollbackError(err, rollback());
  }
  return { path, info: { repo, branch, base }, rollback };
}

/**
 * 删除 worktree，分支保留。worktree 目录已被手动删除时只清理它的登记。
 * 当前（或登记的）提交不在任何本地分支上时，无论是否 force 都拒绝，避免提交变得不可达。
 */
export function removeWorktree(info: WorktreeInfo, path: string, force: boolean): void {
  if (!existsSync(path)) {
    const registered = registeredWorktree(info.repo, path);
    if (!registered) return;
    if (registered.head && !onSomeBranch(info.repo, registered.head)) {
      throw new Error(
        `worktree 目录已不存在，但它登记的提交 ${registered.head.slice(0, 12)} 不在任何本地分支上，清理登记后会丢失；` +
          `先建分支保存：git -C ${info.repo} branch <分支名> ${registered.head}`,
      );
    }
    const removed = unregisterWorktree(info.repo, path);
    if (!removed.ok) throw new Error(`清理 worktree 登记失败：${removed.stderr}`);
    return;
  }
  const head = git(path, ["rev-parse", "HEAD"]).trim();
  if (!onSomeBranch(info.repo, head)) {
    throw new Error(
      `worktree 当前提交 ${head.slice(0, 12)} 不在任何本地分支上，删除后会丢失；先建分支保存：git -C ${path} branch <分支名>`,
    );
  }
  if (!force && git(path, ["status", "--porcelain", "--untracked-files=all"]).trim() !== "") {
    throw new Error(`worktree 中有未提交的改动：${path}；先处理，或加 --force 删除`);
  }
  git(info.repo, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
}

// ---------- 评审补丁 ----------

export type ReviewScope = { kind: "head" } | { kind: "staged" } | { kind: "base"; ref: string };

export interface ReviewPatch {
  root: string;
  /** diff 加上内联的未跟踪文件内容 */
  patch: string;
  stat: string;
  /** 未跟踪文件清单，未内联的附带原因 */
  untracked: string[];
}

function rangeArgs(root: string, scope: ReviewScope): string[] {
  switch (scope.kind) {
    case "head":
      if (!headCommit(root)) throw new Error("仓库还没有任何提交，请改用 --staged");
      return ["HEAD"];
    case "staged":
      return ["--cached"];
    case "base":
      return [git(root, ["merge-base", scope.ref, "HEAD"]).trim()];
  }
}

function untrackedFiles(root: string): { sections: string[]; summary: string[] } {
  const sections: string[] = [];
  const summary: string[] = [];
  for (const path of splitNul(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
    const full = join(root, path);
    const shown = displayPath(path);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      summary.push(`?? ${shown}（符号链接，指向 ${displayPath(readlinkSync(full))}）`);
    } else if (!stat.isFile()) {
      summary.push(`?? ${shown}（特殊文件，未内联）`);
    } else if (stat.size > UNTRACKED_INLINE_LIMIT) {
      summary.push(`?? ${shown}（${stat.size} 字节，未内联）`);
    } else {
      const content = readFileSync(full);
      if (content.includes(0)) {
        summary.push(`?? ${shown}（二进制，${stat.size} 字节，未内联）`);
      } else {
        summary.push(`?? ${shown}`);
        sections.push(`=== 未跟踪的新文件：${shown} ===\n${content.toString("utf8")}`);
      }
    }
  }
  return { sections, summary };
}

/** NUL 不能出现在传给 pi 的命令行参数中。git 只按前 8000 字节判断二进制，其后的 NUL 会以文本形式出现在 diff 里 */
export const NUL_MARKER = "␀";

/** 没有可评审的改动时返回 undefined */
export function collectReview(cwd: string, scope: ReviewScope): ReviewPatch | undefined {
  const root = repoRoot(cwd);
  if (!root) throw new Error(`不在 git 仓库内：${cwd}`);
  const range = rangeArgs(root, scope);
  // 不让仓库配置的外部 diff 与文本转换程序参与：它们会执行任意命令，并让补丁与真实内容不符
  const diff = git(root, ["diff", ...range, "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv"]);
  const stat = git(root, ["diff", ...range, "--no-renames", "--no-color", "--no-textconv", "--stat"]);
  const { sections, summary } = scope.kind === "staged" ? { sections: [], summary: [] } : untrackedFiles(root);
  if (diff.trim() === "" && summary.length === 0) return undefined;
  const patch = [diff, ...sections].filter((part) => part !== "").join("\n").replaceAll("\0", NUL_MARKER);
  return { root, patch, stat, untracked: summary };
}
