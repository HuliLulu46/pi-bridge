// 常驻进程：持有会话锁，运行 `pi --mode rpc`，通过 unix socket 接收 pi-bridge 命令
import { spawn } from "node:child_process";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { createLineSplitter, createRunTracker, parseEvent, preview, toolNotice, type PiEvent } from "./events.ts";
import { PI_ENV, piBin } from "./pi.ts";
import { confirmText, DONE, FAILED, formatAsk, type Ask, type AskMethod, type ClientRequest, type DaemonMessage } from "./protocol.ts";
import { acquireLock, logPath, readRecord, runPath, writeRecord } from "./store.ts";

export interface DaemonOptions {
  isNew: boolean;
  model?: string;
  allowConfirm: boolean;
  piArgs: string[];
}

const ASK_TIMEOUT_MS = Number(process.env.PI_BRIDGE_ASK_TIMEOUT_MS ?? 10 * 60_000);
const IDLE_EXIT_MS = Number(process.env.PI_BRIDGE_IDLE_MS ?? 30 * 60_000);
const STOP_GRACE_MS = 5000;
const SYSTEM_PROMPT =
  "你由 Claude Code 通过 pi-bridge 调用，对话另一端是 Claude 而不是人。需要澄清或做选择时，使用 question 工具提问。";
const DIALOG_METHODS = new Set<string>(["select", "confirm", "input", "editor"]);

const [name, optionsJson] = process.argv.slice(2) as [string, string];
const options = JSON.parse(optionsJson) as DaemonOptions;
const found = readRecord(name);
if (!found) throw new Error(`会话不存在：${name}`);
const record = found;
const release = acquireLock(name);
const socketFile = runPath(name, "sock");
const log = logPath(name);

const pi = spawn(
  piBin(),
  [
    "--mode",
    "rpc",
    "--session-id",
    record.id,
    ...(options.isNew ? ["--name", name] : []),
    ...(options.model ? ["--model", options.model] : []),
    "--append-system-prompt",
    SYSTEM_PROMPT,
    ...options.piArgs,
  ],
  { cwd: record.cwd, env: PI_ENV, stdio: ["pipe", "pipe", "inherit"] },
);

let busy = false;
let tracker = createRunTracker(emit);
let runLines: string[] = [];
const pending = new Map<string, Ask & { timer: NodeJS.Timeout }>();
/** send/answer 的连接：等到下一个提问或本次运行结束 */
const waiters = new Set<Socket>();
/** watch 的连接：接收进度行直到本次运行结束 */
const watchers = new Set<Socket>();
const awaitingStart = new Map<Socket, NodeJS.Timeout>();
const commandReplies = new Map<string, (event: PiEvent) => void>();
let commandSeq = 0;
let idleTimer: NodeJS.Timeout | undefined;
let stopping = false;

function send(socket: Socket, message: DaemonMessage, end = true): void {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(message)}\n`);
  if (end) socket.end();
}

function notifyWaiters(message: DaemonMessage): void {
  for (const socket of waiters) send(socket, message);
  waiters.clear();
}

function emit(line: string): void {
  runLines.push(line);
  appendFileSync(log, `${line}\n`);
  for (const socket of watchers) send(socket, { type: "line", line }, false);
}

function piCommand(command: Record<string, unknown>): Promise<PiEvent> {
  const id = `bridge-${++commandSeq}`;
  pi.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
  return new Promise((resolve) => commandReplies.set(id, resolve));
}

function respondDialog(id: string, response: Record<string, unknown>): void {
  pi.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...response })}\n`);
}

function scheduleIdleExit(): void {
  clearTimeout(idleTimer);
  if (IDLE_EXIT_MS > 0) idleTimer = setTimeout(stop, IDLE_EXIT_MS);
}

function startRun(message: string): void {
  busy = true;
  clearTimeout(idleTimer);
  tracker = createRunTracker(emit);
  runLines = [];
  writeFileSync(log, "");
  for (const [socket, timer] of awaitingStart) {
    clearTimeout(timer);
    watchers.add(socket);
  }
  awaitingStart.clear();
  emit(`[start] ${new Date().toISOString()} ${preview(message)}`);
}

function endRun(ok: boolean, text: string, error: string): void {
  busy = false;
  for (const ask of pending.values()) clearTimeout(ask.timer);
  pending.clear();
  writeRecord({ ...record, updatedAt: new Date().toISOString() });
  if (ok) {
    emit("[reply]");
    emit(text);
    emit(DONE);
    notifyWaiters({ type: "done", text });
  } else {
    emit("[error]");
    emit(error);
    emit(FAILED);
    notifyWaiters({ type: "failed", error, text });
  }
  for (const socket of watchers) socket.end();
  watchers.clear();
  scheduleIdleExit();
}

function finishRun(): void {
  const result = tracker.result(() => "pi 没有给出回复");
  const notice = toolNotice(result.failedTools);
  endRun(result.ok, result.ok ? `${result.reply}${notice}` : result.reply, `${result.error}${notice}`);
}

function onDialog(event: PiEvent): void {
  const ask: Ask = {
    id: event.id!,
    method: event.method as AskMethod,
    title: event.title ?? "",
    message: event.message as unknown as string | undefined,
    options: event.options,
  };
  if (ask.method === "confirm" && !options.allowConfirm) {
    respondDialog(ask.id, { confirmed: false });
    emit(`[confirm-denied] ${preview(`${ask.title} ${ask.message ?? ""}`)}`);
    return;
  }
  const timer = setTimeout(() => {
    pending.delete(ask.id);
    respondDialog(ask.id, { cancelled: true });
    emit(`[ask-timeout] ${ask.id}`);
  }, ASK_TIMEOUT_MS);
  pending.set(ask.id, { ...ask, timer });
  emit(formatAsk(name, ask));
  notifyWaiters({ type: "ask", ask });
}

function onPiEvent(event: PiEvent): void {
  if (event.type === "response" && event.id && commandReplies.has(event.id)) {
    commandReplies.get(event.id)!(event);
    commandReplies.delete(event.id);
    return;
  }
  if (event.type === "extension_ui_request") {
    if (busy && DIALOG_METHODS.has(event.method ?? "")) onDialog(event);
    return;
  }
  if (!busy) return;
  tracker.handle(event);
  if (event.type === "agent_settled") finishRun();
}

function answerResponse(ask: Ask, value: string): Record<string, unknown> {
  switch (ask.method) {
    case "select": {
      const options = ask.options ?? [];
      const index = Number(value);
      const option = Number.isInteger(index) && index >= 1 ? options[index - 1] : options.find((item) => item === value);
      if (option === undefined) throw new Error(`没有这个选项：${value}；可选 1-${options.length} 或选项原文`);
      return { value: option };
    }
    case "confirm":
      if (/^(y|yes|true|是)$/i.test(value)) return { confirmed: true };
      if (/^(n|no|false|否)$/i.test(value)) return { confirmed: false };
      throw new Error(`confirm 只接受 yes 或 no：${value}`);
    default:
      return { value };
  }
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

function assertActionMatches(ask: Ask, action: string | undefined): void {
  if (action === undefined) throw new Error("同意权限确认时必须用 --action 附上确认内容原文");
  if (normalize(action) !== normalize(confirmText(ask))) {
    throw new Error("--action 与待确认的内容不一致，请原样复制确认内容");
  }
}

async function handleRequest(socket: Socket, req: ClientRequest): Promise<void> {
  switch (req.type) {
    case "prompt": {
      if (busy) {
        throw new Error(
          `会话 ${name} 正在运行任务。补充指示用 steer（当前这轮工具执行完后送达），追加任务用 follow-up（整个任务结束后执行）`,
        );
      }
      startRun(req.message);
      waiters.add(socket);
      const response = await piCommand({ type: "prompt", message: req.message });
      if (!response.success) endRun(false, "", `pi 拒绝了这条消息：${response.error}`);
      return;
    }
    case "steer":
    case "follow_up": {
      if (!busy) throw new Error(`会话 ${name} 没有运行中的任务，请用 send`);
      const response = await piCommand({ type: req.type, message: req.message });
      if (!response.success) throw new Error(response.error ?? `${req.type} 失败`);
      emit(`[${req.type === "steer" ? "steer" : "follow-up"}] ${preview(req.message)}`);
      send(socket, {
        type: "ok",
        text: req.type === "steer" ? "已送达，当前这轮工具执行完后生效" : "已排队，当前任务结束后执行",
      });
      return;
    }
    case "answer": {
      const ask = pending.get(req.id);
      if (!ask) throw new Error(`没有待回答的提问：${req.id}`);
      const response = req.cancelled ? { cancelled: true } : answerResponse(ask, req.value ?? "");
      if (response.confirmed === true) assertActionMatches(ask, req.action);
      clearTimeout(ask.timer);
      pending.delete(req.id);
      emit(`[answered] ${req.id} ${preview(response)}`);
      waiters.add(socket);
      respondDialog(req.id, response);
      return;
    }
    case "abort": {
      if (!busy) throw new Error(`会话 ${name} 没有运行中的任务`);
      await piCommand({ type: "abort" });
      send(socket, { type: "ok", text: "已中止" });
      return;
    }
    case "stop":
      send(socket, { type: "ok", text: "正在停止" });
      stop();
      return;
    case "watch": {
      for (const line of runLines) send(socket, { type: "line", line }, false);
      if (busy) {
        watchers.add(socket);
        return;
      }
      awaitingStart.set(
        socket,
        setTimeout(() => {
          awaitingStart.delete(socket);
          socket.end();
        }, req.waitStartMs),
      );
      return;
    }
  }
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  pi.stdin.end();
  setTimeout(() => pi.kill("SIGTERM"), STOP_GRACE_MS).unref();
}

const server = createServer((socket) => {
  const split = createLineSplitter();
  socket.on("error", () => {});
  socket.on("data", (chunk: Buffer) => {
    for (const line of split(chunk)) {
      handleRequest(socket, JSON.parse(line) as ClientRequest).catch((err: Error) =>
        send(socket, { type: "error", error: err.message }),
      );
    }
  });
});

const splitPi = createLineSplitter();
pi.stdout.on("data", (chunk: Buffer) => {
  for (const line of splitPi(chunk)) {
    const event = parseEvent(line);
    if (event) onPiEvent(event);
  }
});

pi.on("close", (code, signal) => {
  if (busy) endRun(false, "", `pi 进程退出（${signal ?? `退出码 ${code}`}）`);
  for (const socket of awaitingStart.keys()) socket.end();
  server.close();
  rmSync(socketFile, { force: true });
  release();
  process.exit(stopping ? 0 : 1);
});
pi.on("error", (err) => {
  process.stderr.write(`无法启动 pi：${err.message}\n`);
});

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

await piCommand({ type: "get_state" });
rmSync(socketFile, { force: true });
server.listen(socketFile, () => {
  process.stdout.write(`ready pid=${process.pid}\n`);
  scheduleIdleExit();
});
