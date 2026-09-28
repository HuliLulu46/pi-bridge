import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WorktreeInfo {
  /** 创建 worktree 的仓库根目录 */
  repo: string;
  branch: string;
  /** 起点提交的完整哈希 */
  base: string;
}

export interface SessionRecord {
  name: string;
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  worktree?: WorktreeInfo;
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;

function bridgeDir(sub: string): string {
  const dir = join(process.env.PI_BRIDGE_HOME ?? join(homedir(), ".pi-bridge"), sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** 会话名同时用作文件名、目录名和 git 分支名的一部分 */
export function assertName(name: string | undefined): asserts name is string {
  if (!name || !NAME_RE.test(name) || name.startsWith(".") || name.includes("..") || name.endsWith(".lock")) {
    throw new Error(`会话名只能包含字母、数字和 . _ -，且不能以 . 开头、不能包含 ..、不能以 .lock 结尾：${name ?? "(空)"}`);
  }
}

function recordPath(name: string): string {
  return join(bridgeDir("sessions"), `${name}.json`);
}

function lockPath(name: string): string {
  return join(bridgeDir("locks"), `${name}.lock`);
}

export function logPath(name: string): string {
  return join(bridgeDir("logs"), `${name}.log`);
}

/** 进程号与随机后缀避免并发评审互相覆盖 */
export function reviewPatchPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(bridgeDir("reviews"), `${stamp}-${process.pid}-${randomBytes(4).toString("hex")}.patch`);
}

/** 常驻进程的 unix socket（sock）与 stdout/stderr 输出（err） */
export function runPath(name: string, kind: "sock" | "err"): string {
  return join(bridgeDir("run"), `${name}.${kind}`);
}

export function readRecord(name: string): SessionRecord | undefined {
  try {
    return JSON.parse(readFileSync(recordPath(name), "utf8")) as SessionRecord;
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

export function writeRecord(record: SessionRecord): void {
  const path = recordPath(record.name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, path);
}

export function removeRecord(name: string): boolean {
  try {
    rmSync(recordPath(name));
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
  rmSync(logPath(name), { force: true });
  rmSync(runPath(name, "err"), { force: true });
  return true;
}

export function listRecords(): SessionRecord[] {
  return readdirSync(bridgeDir("sessions"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => readRecord(file.slice(0, -".json".length)))
    .filter((record): record is SessionRecord => record !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 锁文件是临时文件的硬链接，其修改时间即本次拿到锁的时间；无锁时返回 undefined */
export function lockCreatedAt(name: string): number | undefined {
  try {
    return statSync(lockPath(name)).mtimeMs;
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

export function lockHolder(name: string): number | undefined {
  try {
    const pid = Number(readFileSync(lockPath(name), "utf8"));
    return isAlive(pid) ? pid : undefined;
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

/** 返回释放函数；同名会话已在运行时抛错，持有者进程已退出的残留锁会被回收。 */
export function acquireLock(name: string): () => void {
  const path = lockPath(name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, String(process.pid));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, path);
        return () => rmSync(path, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const holder = lockHolder(name);
        if (holder !== undefined) {
          throw new Error(`会话 ${name} 正被占用（pid ${holder}）：有任务在运行，或常驻进程未停止`);
        }
        rmSync(path, { force: true });
      }
    }
    throw new Error(`无法获取会话锁：${name}`);
  } finally {
    rmSync(tmp, { force: true });
  }
}
