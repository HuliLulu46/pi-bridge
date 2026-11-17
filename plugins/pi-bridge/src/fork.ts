// 分出 pi 会话的副本：与 pi 的 --fork 相同（复制全部条目，新文件头换 id 并记下 parentSession），
// 但由 bridge 在派发前同步完成，之后每次运行照常用 --session-id，print 与常驻进程两条路径都不用改
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HEADER_SCAN_MAX = 1024 * 1024;

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** pi 按真实路径建会话目录（macOS 的 /tmp 是 /private/tmp 的链接）；目录不在了就按字面 */
function realDir(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

/** 与 pi 的会话目录规则一致：PI_CODING_AGENT_SESSION_DIR > settings.json 的 sessionDir > <agentDir>/sessions/--<真实 cwd>-- */
export function piSessionDir(cwd: string): string {
  const fromEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (fromEnv) return resolve(expandHome(fromEnv));
  const agentDir = resolve(expandHome(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")));
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { sessionDir?: unknown };
    if (typeof settings.sessionDir === "string" && settings.sessionDir !== "") return resolve(expandHome(settings.sessionDir));
  } catch {
    // 没有设置文件或读不了：用缺省目录
  }
  return join(agentDir, "sessions", `--${realDir(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/** 文件第一行（会话头），最多读 1MB */
function firstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(64 * 1024);
    while (total < HEADER_SCAN_MAX) {
      const n = readSync(fd, buf, 0, buf.length, total);
      if (n === 0) break;
      const chunk = buf.subarray(0, n);
      const nl = chunk.indexOf(0x0a);
      if (nl !== -1) {
        chunks.push(Buffer.from(chunk.subarray(0, nl)));
        break;
      }
      chunks.push(Buffer.from(chunk));
      total += n;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function headerId(path: string): string | undefined {
  try {
    const header = JSON.parse(firstLine(path)) as { type?: string; id?: string };
    return header.type === "session" ? header.id : undefined;
  } catch {
    return undefined;
  }
}

/** 按会话头里的 id 找会话文件（pi 也是这么找的）；pi 建的文件名以 _<id>.jsonl 结尾，先查这些 */
export function findPiSession(dir: string, id: string): string | undefined {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
  } catch {
    return undefined;
  }
  const suffix = `_${id}.jsonl`;
  const ordered = [...files.filter((f) => f.endsWith(suffix)), ...files.filter((f) => !f.endsWith(suffix))];
  for (const file of ordered) {
    const path = join(dir, file);
    if (headerId(path) === id) return path;
  }
  return undefined;
}

/**
 * 把 sourceId 的 pi 会话复制成 newId；newId 已存在（上次分出后没来得及写记录）就直接用它。
 * 先写临时文件再改名：pi 只认 .jsonl，读不到写了一半的副本
 */
export function forkPiSession(sourceId: string, newId: string, cwd: string): string {
  const dir = piSessionDir(cwd);
  const existing = findPiSession(dir, newId);
  if (existing) return existing;
  const source = findPiSession(dir, sourceId);
  if (!source) throw new Error(`找不到 pi 会话 ${sourceId} 的会话文件（${dir}），无法分出副本；请换一个新会话名`);
  const lines = readFileSync(source, "utf8").split("\n").filter((line) => line.trim() !== "");
  let header: { version?: number; cwd?: string } | undefined;
  const rest: string[] = [];
  for (const line of lines) {
    if (header === undefined) {
      try {
        const entry = JSON.parse(line) as { type?: string; version?: number; cwd?: string };
        if (entry.type === "session") {
          header = entry;
          continue;
        }
      } catch {
        // 坏行原样保留，pi 读取时自己跳过
      }
    }
    rest.push(line);
  }
  if (header === undefined) throw new Error(`pi 会话文件没有会话头，无法分出副本：${source}`);
  const timestamp = new Date().toISOString();
  const newHeader = { type: "session", version: header.version, id: newId, timestamp, cwd: header.cwd ?? realDir(cwd), parentSession: source };
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${newId}.jsonl`);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${[JSON.stringify(newHeader), ...rest].join("\n")}\n`, { flag: "wx" });
  renameSync(tmp, target);
  return target;
}
