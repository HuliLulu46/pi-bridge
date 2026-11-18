// 分出 pi 会话的副本：与 pi 的 --fork 相同（复制全部条目，新文件头换 id 并记下 parentSession），由 bridge 在派发前同步完成
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const HEADER_SCAN_MAX = 1024 * 1024;

interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export function readHistoryFile(path: string): HistoryMessage[] {
  if (!isAbsolute(path)) throw new Error("--history-file 必须是绝对路径");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`无法读取 --history-file ${path}：${(err as Error).message}`);
  }
  let history: unknown;
  try {
    history = JSON.parse(text);
  } catch (err) {
    throw new Error(`--history-file 不是合法 JSON（${path}）：${(err as Error).message}`);
  }
  const messages = history !== null && typeof history === "object" && "messages" in history ? history.messages : undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("--history-file 的 messages 必须是非空数组");
  }
  return messages.map((message: unknown, index) => {
    if (message === null || typeof message !== "object" || !("role" in message) ||
        (message.role !== "user" && message.role !== "assistant") || !("text" in message) || typeof message.text !== "string") {
      throw new Error(`--history-file 的 messages[${index}] 必须包含 role（user 或 assistant）和字符串 text`);
    }
    return { role: message.role, text: message.text };
  });
}

/** pi-virtual 历史保留文本，但不会被 pi 当作需要恢复的物理模型。 */
export function historyToPiSession(messages: HistoryMessage[], id: string, cwd: string): string {
  const timestamp = Date.now();
  const iso = new Date(timestamp).toISOString();
  const entries: unknown[] = [{ type: "session", version: 3, id, timestamp: iso, cwd: realDir(cwd) }];
  const ids = new Set<string>();
  let parentId: string | null = null;
  for (const { role, text } of messages) {
    let entryId: string;
    do { entryId = randomBytes(4).toString("hex"); } while (ids.has(entryId));
    ids.add(entryId);
    const message = role === "user"
      ? { role, content: text, timestamp }
      : {
          role, content: [{ type: "text", text }], api: "pi-virtual", provider: "pi-bridge", model: "imported-history",
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop", timestamp,
        };
    entries.push({ type: "message", id: entryId, parentId, timestamp: iso, message });
    parentId = entryId;
  }
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** 调用方持有会话锁；仅创建全新的历史文件，pi 只能看到完整的 jsonl。 */
export function importPiHistory(messages: HistoryMessage[], id: string, cwd: string): string {
  const dir = piSessionDir(cwd);
  if (findPiSession(dir, id)) throw new Error("fork 只能用于新的会话名：pi 会话文件已存在");
  const content = historyToPiSession(messages, id, cwd);
  const timestamp = new Date().toISOString();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  return target;
}

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

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * 新会话（含副本）的 pi session-id：会话名加 6 位随机后缀，并避开 cwd 下已有的 pi 会话。
 * 会话名删除后再用，得到的是全新的 pi 会话，不会接上同名的旧历史
 */
export function newSessionId(name: string, cwd: string): string {
  const dir = piSessionDir(cwd);
  for (;;) {
    const suffix = Array.from(randomBytes(6), (byte) => ID_CHARS[byte % ID_CHARS.length]).join("");
    const id = `${name}-${suffix}`;
    if (!findPiSession(dir, id)) return id;
  }
}

/** 把 sourceId 的 pi 会话复制成 newId。先写临时文件再改名：pi 只认 .jsonl，读不到写了一半的副本 */
export function forkPiSession(sourceId: string, newId: string, cwd: string): string {
  const dir = piSessionDir(cwd);
  const source = findPiSession(dir, sourceId);
  if (!source) throw new Error(`找不到 pi 会话 ${sourceId} 的会话文件（${dir}），无法分出副本；请换一个新会话名`);
  // findPiSession 已确认首行是会话头；pi 只往文件末尾追加
  const [first, ...rest] = readFileSync(source, "utf8").split("\n").filter((line) => line.trim() !== "");
  const header = JSON.parse(first!) as { version?: number; cwd?: string };
  const timestamp = new Date().toISOString();
  const newHeader = { type: "session", version: header.version, id: newId, timestamp, cwd: header.cwd ?? realDir(cwd), parentSession: source };
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${newId}.jsonl`);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${[JSON.stringify(newHeader), ...rest].join("\n")}\n`, { flag: "wx" });
  renameSync(tmp, target);
  return target;
}
