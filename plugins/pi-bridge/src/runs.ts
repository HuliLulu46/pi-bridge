// 运行记录与全局事件日志：给机器读（mod、脚本），文本模式的输出不受影响
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { preview } from "./events.ts";
import type { Ask } from "./protocol.ts";

export type RunStatus = "running" | "asking" | "done" | "failed";

export interface RunRecord {
  runId: string;
  session: string;
  role: string;
  cwd: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  /** 本次运行的消息摘要 */
  message?: string;
  /** 完整回复（含末尾的工具出错与改动清单），仅 done/failed 时有 */
  reply?: string;
  error?: string;
  /** status 为 asking 时，待回答的提问 */
  ask?: Ask;
  /** 与文本模式一致：0 成功，1 失败，2 有待回答的提问 */
  exitCode?: number;
}

export type EventType =
  | "start"
  | "tool"
  | "tool-error"
  | "retry"
  | "model"
  | "steer"
  | "ask"
  | "answered"
  | "ask-timeout"
  | "confirm-denied"
  | "done"
  | "failed";

/** 全局事件日志的一行。不含回复正文，正文在运行记录里按 runId 取 */
export interface BridgeEvent {
  /** ISO 时间。读者用字节偏移定位，不依赖序号 */
  ts: string;
  session: string;
  runId: string;
  type: EventType;
  /** 一行摘要 */
  text?: string;
  /** type 为 ask 时的结构化提问 */
  ask?: Ask;
}

/**
 * 本次运行动作记录（runs/<runId>.activity.ndjson）的一行：全局事件的不截断版，
 * 外加 tracker 给的 tool（带调用 id 和完整入参）、tool-end、note
 */
export interface ActivityEvent extends Omit<BridgeEvent, "type"> {
  type: EventType | "tool-end" | "note";
  /** tool / tool-end 的调用 id */
  id?: string;
  /** tool-end：工具出错或被拦截 */
  error?: boolean;
}

const EVENT_TEXT_MAX = 300;
const ACTIVITY_TEXT_MAX = 4000;
/** 事件日志超过这个大小就轮转：旧的改名为 .1（只留一份），读者发现偏移超出文件大小会从头读新文件 */
const EVENTS_MAX_BYTES = Number(process.env.PI_BRIDGE_EVENTS_MAX_BYTES ?? 4 * 1024 * 1024);
/** 运行记录与后台输出保留的天数 */
const RUN_KEEP_MS = Number(process.env.PI_BRIDGE_RUN_KEEP_DAYS ?? 14) * 86_400_000;

function homeDir(): string {
  return process.env.PI_BRIDGE_HOME ?? join(homedir(), ".pi-bridge");
}

export function runsDir(): string {
  const dir = join(homeDir(), "runs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function eventsPath(): string {
  mkdirSync(homeDir(), { recursive: true });
  return join(homeDir(), "events.ndjson");
}

export function newRunId(): string {
  return `r-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** runId 同时是文件名，只认自己生成的格式 */
export function assertRunId(runId: string | undefined): asserts runId is string {
  if (!runId || !/^r-[a-z0-9]+-[a-f0-9]{6}$/.test(runId)) throw new Error(`runId 格式不对：${runId ?? "(空)"}`);
}

export function runRecordPath(runId: string): string {
  return join(runsDir(), `${runId}.json`);
}

export function readRun(runId: string): RunRecord | undefined {
  assertRunId(runId);
  const path = runRecordPath(runId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
}

/** 先写临时文件再改名，读者永远看到完整的 JSON */
export function writeRun(record: RunRecord): void {
  const path = runRecordPath(record.runId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

export function activityPath(runId: string): string {
  return join(runsDir(), `${runId}.activity.ndjson`);
}

/**
 * 每次运行只有一个写入者（它的常驻进程或前台进程），行长不受全局日志的 300 字限制，文本最长 ACTIVITY_TEXT_MAX；
 * 随运行记录一起被 pruneRuns 清理。只给界面看：写不进去就算了，不能打断运行，也不能挡住全局日志
 */
export function appendActivity(event: Omit<ActivityEvent, "ts">): void {
  const line: ActivityEvent = {
    ts: new Date().toISOString(),
    ...event,
    ...(event.text !== undefined ? { text: event.text.slice(0, ACTIVITY_TEXT_MAX) } : {}),
  };
  try {
    appendFileSync(activityPath(event.runId), `${JSON.stringify(line)}\n`);
  } catch {
    // 磁盘满、权限不对：界面退回全局日志里能看到的部分
  }
}

/**
 * 写全局日志，同时把文本更长的版本写进本次运行的动作记录（tool 除外：tracker 另写带调用 id 和入参的版本）。
 * 全局日志一次 O_APPEND 写入一整行；行长受 EVENT_TEXT_MAX 限制，并发写入不会交错
 */
export function appendEvent(event: Omit<BridgeEvent, "ts">): void {
  if (event.type !== "tool") appendActivity(event);
  const line: BridgeEvent = {
    ts: new Date().toISOString(),
    ...event,
    ...(event.text !== undefined ? { text: preview(event.text).slice(0, EVENT_TEXT_MAX) } : {}),
  };
  const path = eventsPath();
  try {
    if (statSync(path).size > EVENTS_MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // 文件还不存在，或被别的进程抢先轮转：照常追加
  }
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}

/** 删除超过保留期的运行记录与后台输出；失败不影响运行 */
export function pruneRuns(now = Date.now()): void {
  try {
    const dir = runsDir();
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      try {
        if (now - statSync(path).mtimeMs > RUN_KEEP_MS) rmSync(path, { force: true });
      } catch {
        // 已被别的进程删除
      }
    }
  } catch {
    // 目录读取失败：下次再清
  }
}

/** 每个会话最近一次运行（按 startedAt）；读不了的记录跳过 */
export function latestRunsBySession(): Map<string, RunRecord> {
  const latest = new Map<string, RunRecord>();
  let files: string[];
  try {
    files = readdirSync(runsDir()).filter((file) => /^r-[a-z0-9]+-[a-f0-9]{6}\.json$/.test(file));
  } catch {
    return latest;
  }
  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(join(runsDir(), file), "utf8")) as RunRecord;
      const prev = latest.get(record.session);
      if (prev === undefined || record.startedAt > prev.startedAt) latest.set(record.session, record);
    } catch {
      // 正在被改名或已被清理
    }
  }
  return latest;
}

const PROGRESS_RE = /^\[(tool-error|tool|retry|model|steer|answered|ask-timeout|confirm-denied)\] ?(.*)$/;

/** 把会话日志里的进度行转成事件；不认识的行（回复正文、结束标记、提问块）返回 undefined */
export function eventFromProgress(session: string, runId: string, line: string): Omit<BridgeEvent, "ts"> | undefined {
  const match = PROGRESS_RE.exec(line);
  if (!match) return undefined;
  return { session, runId, type: match[1] as EventType, text: match[2] };
}

/** 读事件日志里从 offset 起的完整行，返回事件与新的 offset（只推进到最后一个换行之后）；只读 offset 之后的字节 */
export function readEvents(offset: number): { events: BridgeEvent[]; offset: number } {
  const path = eventsPath();
  if (!existsSync(path)) return { events: [], offset: 0 };
  const fd = openSync(path, "r");
  let content: Buffer;
  let start: number;
  try {
    const size = fstatSync(fd).size;
    start = offset > size ? 0 : offset;
    content = Buffer.alloc(size - start);
    let read = 0;
    while (read < content.length) {
      const n = readSync(fd, content, read, content.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    content = content.subarray(0, read);
  } finally {
    closeSync(fd);
  }
  const end = content.lastIndexOf(0x0a) + 1;
  if (end === 0) return { events: [], offset: start };
  const events = content
    .subarray(0, end)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as BridgeEvent];
      } catch {
        return [];
      }
    });
  return { events, offset: start + end };
}
