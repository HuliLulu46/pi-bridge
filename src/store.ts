import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionRecord {
  name: string;
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
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

export function assertName(name: string | undefined): asserts name is string {
  if (!name || !NAME_RE.test(name)) {
    throw new Error(`会话名只能包含字母、数字和 . _ -：${name ?? "(空)"}`);
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
        if (holder !== undefined) throw new Error(`会话 ${name} 正在运行（pid ${holder}），请等待结束后再发送`);
        rmSync(path, { force: true });
      }
    }
    throw new Error(`无法获取会话锁：${name}`);
  } finally {
    rmSync(tmp, { force: true });
  }
}
