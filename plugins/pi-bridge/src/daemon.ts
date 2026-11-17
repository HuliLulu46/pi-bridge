// 常驻进程：持有会话锁，运行 `pi --mode rpc`，通过 unix socket 接收 pi-bridge 命令
import { spawn } from "node:child_process";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { createLineSplitter, createRunTracker, parseEvent, preview, toolNotice, type PiEvent } from "./events.ts";
import { trackChanges } from "./git.ts";
import { modelArgs, PI_ENV, piBin } from "./pi.ts";
import { DONE, FAILED, formatAsk, type Ask, type AskMethod, type ClientRequest, type DaemonMessage } from "./protocol.ts";
import { appendEvent, eventFromProgress, newRunId, pruneRuns, writeRun, type RunRecord } from "./runs.ts";
import { subagentPrompt } from "./prompts.ts";
import { acquireLock, logPath, readRecord, runPath, sessionIdOf, writeRecord } from "./store.ts";

export interface DaemonOptions {
  isNew: boolean;
  /** 启动方看到的记录的创建时间，用来确认拿锁后读到的是同一个会话 */
  createdAt: string;
  model?: string;
  thinking?: string;
}

const ASK_TIMEOUT_MS = Number(process.env.PI_BRIDGE_ASK_TIMEOUT_MS ?? 10 * 60_000);
const IDLE_EXIT_MS = Number(process.env.PI_BRIDGE_IDLE_MS ?? 30 * 60_000);
const STOP_GRACE_MS = 5000;
const SYSTEM_PROMPT = subagentPrompt("executor");
const DIALOG_METHODS = new Set<string>(["select", "confirm", "input", "editor"]);

const [name, optionsJson] = process.argv.slice(2) as [string, string];
const options = JSON.parse(optionsJson) as DaemonOptions;

/** 启动失败的原因写到 stderr，由启动方转告给用户 */
function fatal(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function lockOrExit(): () => void {
  try {
    return acquireLock(name);
  } catch (err) {
    return fatal((err as Error).message);
  }
}

// 先拿锁再读记录：启动方释放锁之后、这里拿到锁之前，记录可能被 rm 删掉或重建
const release = lockOrExit();
const found = readRecord(name);
if (!found) {
  release();
  fatal(`会话不存在：${name}`);
}
if (found.createdAt !== options.createdAt) {
  release();
  fatal(`会话 ${name} 在常驻进程启动期间被删除并重建，请重试`);
}
const record = found;
const socketFile = runPath(name, "sock");
const log = logPath(name);

const pi = spawn(
  piBin(),
  [
    "--mode",
    "rpc",
    "--session-id",
    sessionIdOf(record),
    ...(options.isNew ? ["--name", name] : []),
    ...modelArgs(options.model, options.thinking),
    "--append-system-prompt",
    SYSTEM_PROMPT,
  ],
  { cwd: record.cwd, env: PI_ENV, stdio: ["pipe", "pipe", "inherit"] },
);

let busy = false;
/** 当前（或上一次）运行的记录，写进 ~/.pi-bridge/runs/<runId>.json */
let run: RunRecord | undefined;
let tracker = createRunTracker(emit);
let finishChanges = (): string => "";
let runLines: string[] = [];
/** 本次运行中被自动拒绝的权限确认，附在回复末尾 */
let denied: string[] = [];
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

function updateRun(patch: Partial<RunRecord>): void {
  if (!run) return;
  run = { ...run, ...patch };
  writeRun(run);
}

/** 运行记录里的状态跟着待回答的提问走：还有提问未答就是 asking，否则回到 running */
function syncAskState(): void {
  const first = pending.values().next().value;
  if (first) {
    const { timer: _timer, ...ask } = first;
    updateRun({ status: "asking", ask, exitCode: 2 });
  } else {
    updateRun({ status: "running", ask: undefined, exitCode: undefined });
  }
}

function emit(line: string): void {
  runLines.push(line);
  appendFileSync(log, `${line}\n`);
  if (run) {
    const event = eventFromProgress(name, run.runId, line);
    if (event) appendEvent(event);
  }
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
  finishChanges = trackChanges(record.cwd);
  runLines = [];
  denied = [];
  run = {
    runId: newRunId(),
    session: name,
    role: "executor",
    cwd: record.cwd,
    status: "running",
    startedAt: new Date().toISOString(),
    message: preview(message),
  };
  pruneRuns();
  writeRun(run);
  appendEvent({ session: name, runId: run.runId, type: "start", text: message });
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
  const runId = run?.runId;
  const endedAt = new Date().toISOString();
  // 先落运行记录与事件，再通知等待者：任何人收到完成通知后读记录都读得到
  if (ok) {
    updateRun({ status: "done", endedAt, reply: text, exitCode: 0, ask: undefined });
    if (runId) appendEvent({ session: name, runId, type: "done" });
    emit("[reply]");
    emit(text);
    emit(DONE);
    notifyWaiters({ type: "done", text, runId });
  } else {
    updateRun({ status: "failed", endedAt, reply: text, error, exitCode: 1, ask: undefined });
    if (runId) appendEvent({ session: name, runId, type: "failed", text: error });
    emit("[error]");
    emit(error);
    emit(FAILED);
    notifyWaiters({ type: "failed", error, text, runId });
  }
  for (const socket of watchers) socket.end();
  watchers.clear();
  scheduleIdleExit();
}

function runNotice(failedTools: string[]): string {
  return `${toolNotice([...failedTools, ...denied])}${finishChanges()}`;
}

function finishRun(): void {
  const result = tracker.result(() => "pi 没有给出回复");
  const notice = runNotice(result.failedTools);
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
  if (ask.method === "confirm") {
    respondDialog(ask.id, { confirmed: false });
    const summary = preview(`${ask.title} ${ask.message ?? ""}`);
    denied.push(`权限确认被拒绝：${summary}`);
    emit(`[confirm-denied] ${summary}`);
    return;
  }
  const timer = setTimeout(() => {
    pending.delete(ask.id);
    respondDialog(ask.id, { cancelled: true });
    syncAskState();
    emit(`[ask-timeout] ${ask.id}`);
  }, ASK_TIMEOUT_MS);
  pending.set(ask.id, { ...ask, timer });
  syncAskState();
  if (run) appendEvent({ session: name, runId: run.runId, type: "ask", text: `${ask.title}`, ask });
  emit(formatAsk(name, ask));
  notifyWaiters({ type: "ask", ask, runId: run?.runId });
}

function onPiEvent(event: PiEvent): void {
  if (event.type === "response" && event.id && commandReplies.has(event.id)) {
    commandReplies.get(event.id)!(event);
    commandReplies.delete(event.id);
    return;
  }
  if (event.type === "extension_ui_request") {
    if (!DIALOG_METHODS.has(event.method ?? "")) return;
    if (busy) {
      onDialog(event);
    } else {
      // 启动期与空闲期没有人能回答，不取消的话 pi 会一直等待
      respondDialog(event.id!, { cancelled: true });
      process.stderr.write(`[dialog-cancelled] ${event.method} ${preview(event.title ?? "")}\n`);
    }
    return;
  }
  if (!busy) return;
  tracker.handle(event);
  if (event.type === "agent_settled") finishRun();
}

function answerResponse(ask: Ask, value: string): Record<string, unknown> {
  if (ask.method !== "select") return { value };
  const options = ask.options ?? [];
  const index = Number(value);
  const option = Number.isInteger(index) && index >= 1 ? options[index - 1] : options.find((item) => item === value);
  if (option === undefined) throw new Error(`没有这个选项：${value}；可选 1-${options.length} 或选项原文`);
  return { value: option };
}

async function handleRequest(socket: Socket, req: ClientRequest): Promise<void> {
  if (stopping && req.type !== "watch") throw new Error(`会话 ${name} 的常驻进程正在停止`);
  switch (req.type) {
    case "prompt": {
      if (busy) throw new Error(`会话 ${name} 正在运行任务，补充指示用 steer（当前这轮工具执行完后送达）`);
      startRun(req.message);
      if (req.detach) {
        send(socket, { type: "started", runId: run!.runId });
      } else {
        send(socket, { type: "started", runId: run!.runId }, false);
        waiters.add(socket);
      }
      const response = await piCommand({ type: "prompt", message: req.message });
      if (!response.success) endRun(false, "", `pi 拒绝了这条消息：${response.error}`);
      return;
    }
    case "steer": {
      if (!busy) throw new Error(`会话 ${name} 没有运行中的任务，请用 send`);
      const response = await piCommand({ type: "steer", message: req.message });
      if (!response.success) throw new Error(response.error ?? "steer 失败");
      emit(`[steer] ${preview(req.message)}`);
      send(socket, { type: "ok", text: "已送达，当前这轮工具执行完后生效" });
      return;
    }
    case "answer": {
      const ask = pending.get(req.id);
      if (!ask) throw new Error(`没有待回答的提问：${req.id}`);
      const response = req.cancelled ? { cancelled: true } : answerResponse(ask, req.value ?? "");
      clearTimeout(ask.timer);
      pending.delete(req.id);
      syncAskState();
      emit(`[answered] ${req.id} ${preview(response)}`);
      if (req.detach) send(socket, { type: "ok", text: "已回答" });
      else waiters.add(socket);
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
      if (busy) {
        for (const line of runLines) send(socket, { type: "line", line }, false);
        watchers.add(socket);
        return;
      }
      // 空闲时先等新运行开始，等不到再交出上一次运行的记录，避免把上一次的结束标记当成本次结果
      awaitingStart.set(
        socket,
        setTimeout(() => {
          awaitingStart.delete(socket);
          send(socket, { type: "idle", lines: runLines });
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
  if (busy) {
    const { failedTools } = tracker.result(() => "");
    endRun(false, "", `pi 进程退出（${signal ?? `退出码 ${code}`}）${runNotice(failedTools)}`);
  }
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
