import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { DaemonOptions } from "./daemon.ts";
import { preview, toolNotice } from "./events.ts";
import { runPi } from "./pi.ts";
import { DONE, FAILED, formatAsk, openDaemon, request, type ClientRequest, type DaemonMessage } from "./protocol.ts";
import {
  acquireLock,
  assertName,
  listRecords,
  lockHolder,
  logPath,
  readRecord,
  removeRecord,
  runPath,
  writeRecord,
  type SessionRecord,
} from "./store.ts";

const USAGE = `用法：
  pi-bridge send <会话名> [--cwd <目录>] [--model <模型>] <消息|-> [-- <pi 参数>...]
  pi-bridge watch <会话名>
  pi-bridge list
  pi-bridge rm <会话名>

常驻进程（任务中途干预、回答 pi 的提问）：
  pi-bridge start <会话名> [--cwd <目录>] [--model <模型>] [--allow-confirm] [-- <pi 参数>...]
  pi-bridge steer <会话名> <消息|->
  pi-bridge follow-up <会话名> <消息|->
  pi-bridge answer <会话名> <提问 id> <回答|-> [--action <确认内容原文|->]
  pi-bridge answer <会话名> <提问 id> --cancel
  pi-bridge abort <会话名>
  pi-bridge stop <会话名>

消息写 - 时从 stdin 读取。首次 send 或 start 创建会话并绑定 cwd（默认当前目录），之后固定在该目录运行。
常驻进程运行时 send 自动转给它：拿到回复时退出码为 0；pi 提问时打印提问并以退出码 2 退出，用 answer 回答后继续等待。`;

const EXIT_ASK = 2;
/** watch 启动后等待任务开始的时长，覆盖 send 与 watch 同时启动时的先后顺序 */
const WATCH_START_WAIT_MS = 10_000;
const WATCH_POLL_MS = 500;
const DAEMON_READY_TIMEOUT_MS = 60_000;
const DAEMON_STOP_TIMEOUT_MS = 10_000;
/** macOS 的 unix socket 路径上限为 104 字节 */
const SOCKET_PATH_MAX = 103;
const DAEMON_ENTRY = fileURLToPath(new URL("./daemon.ts", import.meta.url));

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function splitPassthrough(argv: string[]): [string[], string[]] {
  const separator = argv.indexOf("--");
  return separator === -1 ? [argv, []] : [argv.slice(0, separator), argv.slice(separator + 1)];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readMessage(raw: string | undefined): Promise<string> {
  if (raw === undefined) throw new Error("缺少消息");
  const message = raw === "-" ? await readStdin() : raw;
  if (!message.trim()) throw new Error("消息为空");
  return message;
}

/** 需在会话锁内调用 */
function ensureRecord(name: string, cwdOption: string | undefined): { record: SessionRecord; isNew: boolean } {
  const existing = readRecord(name);
  const cwd = resolve(cwdOption ?? existing?.cwd ?? process.cwd());
  if (existing && existing.cwd !== cwd) throw new Error(`会话 ${name} 绑定在 ${existing.cwd}，不能改到 ${cwd}`);
  if (existing) return { record: existing, isNew: false };
  if (!existsSync(cwd)) throw new Error(`目录不存在：${cwd}`);
  const now = new Date().toISOString();
  const record = { name, id: randomUUID(), cwd, createdAt: now, updatedAt: now };
  writeRecord(record);
  return { record, isNew: true };
}

async function requireDaemon(name: string): Promise<Socket> {
  const socket = await openDaemon(name);
  if (!socket) throw new Error(`会话 ${name} 没有运行中的常驻进程，先用 pi-bridge start 启动`);
  return socket;
}

/** 等到 pi 提问或本次运行结束 */
async function awaitRun(name: string, stream: AsyncGenerator<DaemonMessage>): Promise<number> {
  for await (const message of stream) {
    switch (message.type) {
      case "ask":
        print(formatAsk(name, message.ask));
        return EXIT_ASK;
      case "done":
        print(message.text);
        return 0;
      case "failed":
        if (message.text) print(message.text);
        throw new Error(message.error);
      case "error":
        throw new Error(message.error);
    }
  }
  throw new Error("与常驻进程的连接中断");
}

async function simpleRequest(name: string, req: ClientRequest): Promise<string> {
  for await (const message of request(await requireDaemon(name), req)) {
    if (message.type === "ok") return message.text;
    if (message.type === "error") throw new Error(message.error);
  }
  throw new Error("与常驻进程的连接中断");
}

async function send(argv: string[]): Promise<number> {
  const [own, passthrough] = splitPassthrough(argv);
  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: { cwd: { type: "string" }, model: { type: "string" } },
  });
  const [name, raw] = positionals;
  assertName(name);
  if (positionals.length !== 2) throw new Error("需要恰好一条消息，含空格时请加引号，或用 - 从 stdin 读取");
  const message = await readMessage(raw);

  const daemon = await openDaemon(name);
  if (daemon) {
    const boundCwd = readRecord(name)?.cwd;
    if (values.cwd && resolve(values.cwd) !== boundCwd) {
      daemon.destroy();
      throw new Error(`会话 ${name} 绑定在 ${boundCwd}，不能改到 ${resolve(values.cwd)}`);
    }
    if (values.model || passthrough.length > 0) {
      daemon.destroy();
      throw new Error("常驻进程运行中，--model 和 pi 参数只能在 start 时指定");
    }
    return awaitRun(name, request(daemon, { type: "prompt", message }));
  }

  const release = acquireLock(name);
  try {
    const log = logPath(name);
    writeFileSync(log, `[start] ${new Date().toISOString()} ${preview(message)}\n`);
    const progress = (line: string): void => appendFileSync(log, `${line}\n`);

    const { record, isNew } = ensureRecord(name, values.cwd);
    const result = await runPi({
      sessionId: record.id,
      cwd: record.cwd,
      message,
      piArgs: [...(isNew ? ["--name", name] : []), ...(values.model ? ["--model", values.model] : []), ...passthrough],
      onProgress: progress,
    });
    writeRecord({ ...record, updatedAt: new Date().toISOString() });

    const notice = toolNotice(result.failedTools);
    if (result.ok) {
      progress(`[reply]\n${result.reply}${notice}\n${DONE}`);
      print(`${result.reply}${notice}`);
      return 0;
    }
    progress(`[error]\n${result.error}${notice}\n${FAILED}`);
    if (result.reply) print(result.reply);
    process.stderr.write(`pi-bridge: ${result.error}${notice}\n`);
    return 1;
  } finally {
    release();
  }
}

async function start(argv: string[]): Promise<number> {
  const [own, passthrough] = splitPassthrough(argv);
  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: { cwd: { type: "string" }, model: { type: "string" }, "allow-confirm": { type: "boolean" } },
  });
  const [name] = positionals;
  assertName(name);
  if (positionals.length !== 1) throw new Error("start 只接受一个会话名");
  const socketFile = runPath(name, "sock");
  if (Buffer.byteLength(socketFile) > SOCKET_PATH_MAX) throw new Error(`会话名过长，socket 路径超过 ${SOCKET_PATH_MAX} 字节：${socketFile}`);
  const running = await openDaemon(name);
  if (running) {
    running.destroy();
    throw new Error(`会话 ${name} 的常驻进程已在运行`);
  }

  const release = acquireLock(name);
  let ensured: ReturnType<typeof ensureRecord>;
  try {
    ensured = ensureRecord(name, values.cwd);
  } finally {
    release();
  }

  const options: DaemonOptions = {
    isNew: ensured.isNew,
    model: values.model,
    allowConfirm: values["allow-confirm"] ?? false,
    piArgs: passthrough,
  };
  const errFile = runPath(name, "err");
  const fd = openSync(errFile, "w");
  const child = spawn(process.execPath, [DAEMON_ENTRY, name, JSON.stringify(options)], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  let exited = false;
  child.on("exit", () => (exited = true));
  child.unref();

  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const socket = await openDaemon(name);
    if (socket) {
      socket.destroy();
      const confirmNote = options.allowConfirm ? "，权限确认转给 Claude" : "";
      print(`已启动常驻进程 ${name}（pid ${child.pid}，目录 ${ensured.record.cwd}${confirmNote}）`);
      return 0;
    }
    if (exited) throw new Error(`常驻进程启动失败：\n${readFileSync(errFile, "utf8").trim()}`);
    await sleep(100);
  }
  child.kill();
  throw new Error(`常驻进程 ${DAEMON_READY_TIMEOUT_MS / 1000} 秒内未就绪，输出见 ${errFile}`);
}

async function stop(argv: string[]): Promise<number> {
  const [name] = argv;
  assertName(name);
  await simpleRequest(name, { type: "stop" });
  const deadline = Date.now() + DAEMON_STOP_TIMEOUT_MS;
  while (lockHolder(name) !== undefined) {
    if (Date.now() > deadline) throw new Error(`常驻进程 ${DAEMON_STOP_TIMEOUT_MS / 1000} 秒内未退出`);
    await sleep(100);
  }
  print(`已停止常驻进程 ${name}`);
  return 0;
}

async function queueMessage(type: "steer" | "follow_up", argv: string[]): Promise<number> {
  const [name, raw] = argv;
  assertName(name);
  if (argv.length !== 2) throw new Error("需要恰好一条消息，含空格时请加引号，或用 - 从 stdin 读取");
  print(await simpleRequest(name, { type, message: await readMessage(raw) }));
  return 0;
}

async function abort(argv: string[]): Promise<number> {
  const [name] = argv;
  assertName(name);
  print(await simpleRequest(name, { type: "abort" }));
  return 0;
}

async function answer(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { cancel: { type: "boolean" }, action: { type: "string" } },
  });
  const [name, id, raw] = positionals;
  assertName(name);
  if (!id) throw new Error("缺少提问 id");
  if (raw === "-" && values.action === "-") throw new Error("回答与 --action 不能同时从 stdin 读取");
  const req: ClientRequest = values.cancel
    ? { type: "answer", id, cancelled: true }
    : {
        type: "answer",
        id,
        value: await readMessage(raw),
        action: values.action === "-" ? await readStdin() : values.action,
      };
  return awaitRun(name, request(await requireDaemon(name), req));
}

async function watch(argv: string[]): Promise<number> {
  const [name] = argv;
  assertName(name);
  if (!readRecord(name)) throw new Error(`会话不存在：${name}`);
  const daemon = await openDaemon(name);
  return daemon ? watchDaemon(name, daemon) : watchLog(name);
}

async function watchDaemon(name: string, daemon: Socket): Promise<number> {
  let last: string | undefined;
  for await (const message of request(daemon, { type: "watch", waitStartMs: WATCH_START_WAIT_MS })) {
    if (message.type !== "line") continue;
    print(message.line);
    last = message.line;
  }
  if (last === DONE) return 0;
  if (last === FAILED) return 1;
  if (last === undefined) {
    print(`[idle] 会话 ${name} 当前没有任务在运行`);
    return 0;
  }
  print(`${FAILED} 与常驻进程的连接中断`);
  return 1;
}

async function watchLog(name: string): Promise<number> {
  const log = logPath(name);
  const waitUntil = Date.now() + WATCH_START_WAIT_MS;
  while (lockHolder(name) === undefined && Date.now() < waitUntil) await sleep(200);

  let offset = 0;
  for (;;) {
    const running = lockHolder(name) !== undefined;
    const content = existsSync(log) ? readFileSync(log) : Buffer.alloc(0);
    const end = content.lastIndexOf(0x0a) + 1;
    if (end > offset) {
      for (const line of content.subarray(offset, end).toString("utf8").split("\n").slice(0, -1)) {
        print(line);
        if (line === DONE) return 0;
        if (line === FAILED) return 1;
      }
      offset = end;
    }
    if (!running) {
      print(`${FAILED} 会话 ${name} 没有在运行，日志也没有结束标记`);
      return 1;
    }
    await sleep(WATCH_POLL_MS);
  }
}

function list(): number {
  const records = listRecords();
  if (records.length === 0) {
    print("（没有会话）");
    return 0;
  }
  for (const record of records) {
    const held = lockHolder(record.name) !== undefined;
    const status = !held ? "idle" : existsSync(runPath(record.name, "sock")) ? "daemon" : "running";
    print([record.name, status, record.updatedAt, record.cwd, record.id].join("\t"));
  }
  return 0;
}

function rm(argv: string[]): number {
  const [name] = argv;
  assertName(name);
  const release = acquireLock(name);
  try {
    const record = readRecord(name);
    if (!record || !removeRecord(name)) throw new Error(`会话不存在：${name}`);
    print(`已删除会话映射 ${name}，pi 会话文件（${record.id}）仍保留`);
    return 0;
  } finally {
    release();
  }
}

const commands: Record<string, (argv: string[]) => number | Promise<number>> = {
  send,
  watch,
  list,
  rm,
  start,
  stop,
  steer: (argv) => queueMessage("steer", argv),
  "follow-up": (argv) => queueMessage("follow_up", argv),
  answer,
  abort,
};

const [command, ...rest] = process.argv.slice(2);
const handler = command === undefined ? undefined : commands[command];
if (!handler) {
  print(USAGE);
  process.exitCode = command === undefined || command === "help" || command === "--help" ? 0 : 1;
} else {
  try {
    process.exitCode = await handler(rest);
  } catch (err) {
    process.stderr.write(`pi-bridge: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
