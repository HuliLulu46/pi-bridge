import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { DaemonOptions } from "./daemon.ts";
import { currentEngine, runAdvisor } from "./engine.ts";
import { preview, toolNotice } from "./events.ts";
import { createWorktree, removeWorktree, rollbackError, type ReviewScope } from "./git.ts";
import type { Role } from "./pi.ts";
import { prepareReview } from "./review.ts";
import { DONE, FAILED, formatAsk, openDaemon, request, type ClientRequest, type DaemonMessage } from "./protocol.ts";
import {
  acquireLock,
  assertName,
  listRecords,
  lockCreatedAt,
  lockHolder,
  logPath,
  readRecord,
  removeRecord,
  runPath,
  sessionIdOf,
  writeRecord,
  type SessionRecord,
} from "./store.ts";

const USAGE = `用法：
  pi-bridge send <会话名> [--role advisor|executor] [--cwd <目录>] [--model <模型>] [--thinking <等级>] [--worktree] <消息|->
  pi-bridge watch <会话名>
  pi-bridge list
  pi-bridge rm <会话名> [--force]
  pi-bridge review [--staged | --base <分支>] [--cwd <目录>] [--focus <关注点>] [--model <模型>] [--thinking <等级>]

常驻进程（executor 会话的任务中途干预、回答 pi 的提问）：
  pi-bridge steer <会话名> <消息|->
  pi-bridge answer <会话名> <提问 id> <回答|->
  pi-bridge answer <会话名> <提问 id> --cancel
  pi-bridge abort <会话名>
  pi-bridge stop <会话名>

消息写 - 时从 stdin 读取。首次 send 创建会话并绑定 cwd（默认当前目录），之后固定在该目录运行。
--role 缺省为 advisor：只读，跑完即退出。executor 在常驻进程中运行，没有常驻进程时自动启动，空闲 30 分钟自动退出；
pi 提问时 send 打印提问并以退出码 2 退出，用 answer 回答后继续等待。会话有常驻进程时，先 stop 才能以 advisor 发送。
创建会话时加 --worktree，会在 <仓库>/.pi-bridge/worktrees/<会话名> 建立分支为 pi/<会话名> 的 worktree 并在其中运行。`;

const EXIT_ASK = 2;
/** watch 启动后等待任务开始的时长，覆盖 send 与 watch 同时启动时的先后顺序，以及常驻进程的启动超时 */
const WATCH_START_WAIT_MS = Number(process.env.PI_BRIDGE_WATCH_WAIT_MS ?? 70_000);
const WATCH_POLL_MS = 500;
const DAEMON_READY_TIMEOUT_MS = 60_000;
const DAEMON_STOP_TIMEOUT_MS = 10_000;
/** macOS 的 unix socket 路径上限为 104 字节 */
const SOCKET_PATH_MAX = 103;
const DAEMON_ENTRY = fileURLToPath(new URL("./daemon.ts", import.meta.url));

function print(text: string): void {
  process.stdout.write(`${text}\n`);
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
function ensureRecord(
  name: string,
  cwdOption: string | undefined,
  worktree: boolean,
): { record: SessionRecord; isNew: boolean } {
  const existing = readRecord(name);
  if (existing && worktree) throw new Error(`会话 ${name} 已存在，worktree 只能在创建会话时指定`);
  const cwd = resolve(cwdOption ?? existing?.cwd ?? process.cwd());
  if (existing && existing.cwd !== cwd) throw new Error(`会话 ${name} 绑定在 ${existing.cwd}，不能改到 ${cwd}`);
  if (existing) return { record: existing, isNew: false };
  if (!existsSync(cwd)) throw new Error(`目录不存在：${cwd}`);
  const now = new Date().toISOString();
  const base = { name, createdAt: now, updatedAt: now };
  if (!worktree) {
    const record = { ...base, cwd };
    writeRecord(record);
    return { record, isNew: true };
  }
  const created = createWorktree(cwd, name);
  const record = { ...base, cwd: created.path, worktree: created.info };
  try {
    writeRecord(record);
  } catch (err) {
    throw rollbackError(err, created.rollback());
  }
  return { record, isNew: true };
}

async function requireDaemon(name: string): Promise<Socket> {
  const socket = await openDaemon(name);
  if (!socket) throw new Error(`会话 ${name} 没有运行中的常驻进程，用 send --role executor 启动`);
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

interface SendOptions {
  cwd?: string;
  model?: string;
  thinking?: string;
  worktree: boolean;
}

async function send(argv: string[]): Promise<number> {
  if (argv.includes("--")) throw new Error("不支持透传 pi 参数，模型与思考等级用 --model、--thinking 指定");
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      role: { type: "string", default: "advisor" },
      cwd: { type: "string" },
      model: { type: "string" },
      thinking: { type: "string" },
      worktree: { type: "boolean" },
    },
  });
  const [name, raw] = positionals;
  assertName(name);
  if (positionals.length !== 2) throw new Error("需要恰好一条消息，含空格时请加引号，或用 - 从 stdin 读取");
  const role = values.role as Role;
  if (role !== "advisor" && role !== "executor") throw new Error(`--role 只能是 advisor 或 executor：${role}`);
  if (role === "executor" && currentEngine() === "qoder") {
    throw new Error("PI_BRIDGE_ENGINE=qoder 第一版只支持 advisor（含 review）；要用 executor 请去掉该环境变量走 pi");
  }
  const message = await readMessage(raw);
  const opts: SendOptions = {
    cwd: values.cwd,
    model: values.model,
    thinking: values.thinking,
    worktree: values.worktree ?? false,
  };
  return role === "advisor" ? sendAdvisor(name, message, opts) : sendExecutor(name, message, opts);
}

async function sendAdvisor(name: string, message: string, opts: SendOptions): Promise<number> {
  const daemon = await openDaemon(name);
  if (daemon) {
    daemon.destroy();
    throw new Error(`会话 ${name} 有常驻进程，先 pi-bridge stop ${name}（正在执行的任务会被中止），再以 advisor 发送`);
  }
  const release = acquireLock(name);
  try {
    const { record, isNew } = ensureRecord(name, opts.cwd, opts.worktree);
    return await runPrint(record, isNew, message, { model: opts.model, thinking: opts.thinking });
  } finally {
    release();
  }
}

interface PrintOptions {
  model?: string;
  thinking?: string;
}

/** 以只读顾问身份运行一轮（引擎由 PI_BRIDGE_ENGINE 决定）；调用方须持有会话锁。footer 附在回复与错误信息末尾 */
async function runPrint(
  record: SessionRecord,
  isNew: boolean,
  message: string,
  opts: PrintOptions,
  footer = "",
): Promise<number> {
  const log = logPath(record.name);
  writeFileSync(log, `[start] ${new Date().toISOString()} ${preview(message)}\n`);
  const progress = (line: string): void => appendFileSync(log, `${line}\n`);
  const result = await runAdvisor({
    sessionName: record.name,
    sessionId: sessionIdOf(record),
    cwd: record.cwd,
    message,
    isNew,
    model: opts.model,
    thinking: opts.thinking,
    onProgress: progress,
  });
  writeRecord({ ...record, updatedAt: new Date().toISOString() });

  const notice = `${toolNotice(result.failedTools)}${footer}`;
  if (result.ok) {
    progress(`[reply]\n${result.reply}${notice}\n${DONE}`);
    print(`${result.reply}${notice}`);
    return 0;
  }
  progress(`[error]\n${result.error}${notice}\n${FAILED}`);
  if (result.reply) print(result.reply);
  process.stderr.write(`pi-bridge: ${result.error}${notice}\n`);
  return 1;
}

async function sendExecutor(name: string, message: string, opts: SendOptions): Promise<number> {
  let daemon = await openDaemon(name);
  if (daemon) {
    const boundCwd = readRecord(name)?.cwd;
    const conflict = opts.worktree
      ? `会话 ${name} 已存在，worktree 只能在创建会话时指定`
      : opts.cwd && resolve(opts.cwd) !== boundCwd
        ? `会话 ${name} 绑定在 ${boundCwd}，不能改到 ${resolve(opts.cwd)}`
        : opts.model || opts.thinking
          ? "常驻进程运行中，--model 与 --thinking 只在启动常驻进程时生效"
          : undefined;
    if (conflict) {
      daemon.destroy();
      throw new Error(conflict);
    }
  } else {
    daemon = await startDaemon(name, opts);
  }
  return awaitRun(name, request(daemon, { type: "prompt", message }));
}

/**
 * 启动常驻进程并返回与它的连接。记录在会话锁内创建，释放锁后由常驻进程自己拿锁；
 * 中间被其他命令抢先拿锁或删掉记录时，常驻进程退出，错误原因来自它的输出
 */
async function startDaemon(name: string, opts: SendOptions): Promise<Socket> {
  const socketFile = runPath(name, "sock");
  if (Buffer.byteLength(socketFile) > SOCKET_PATH_MAX) throw new Error(`会话名过长，socket 路径超过 ${SOCKET_PATH_MAX} 字节：${socketFile}`);

  const release = acquireLock(name);
  let ensured: ReturnType<typeof ensureRecord>;
  try {
    ensured = ensureRecord(name, opts.cwd, opts.worktree);
  } finally {
    release();
  }

  const options: DaemonOptions = {
    isNew: ensured.isNew,
    createdAt: ensured.record.createdAt,
    model: opts.model,
    thinking: opts.thinking,
  };
  // 每次启动先写各自的输出文件，就绪后才改名为会话的输出文件：同时启动的常驻进程不会互相覆盖输出
  const errFile = runPath(name, "err");
  const startErr = `${errFile}.${process.pid}`;
  const fd = openSync(startErr, "w");
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
    // 常驻进程先拿锁再监听 socket：持锁者是自己启动的进程，才说明连上的是它，而不是同时启动的另一个
    if (socket && lockHolder(name) === child.pid) {
      renameSync(startErr, errFile);
      return socket;
    }
    socket?.destroy();
    if (exited) {
      const output = readFileSync(startErr, "utf8").trim();
      rmSync(startErr, { force: true });
      throw new Error(`常驻进程启动失败：\n${output}`);
    }
    await sleep(100);
  }
  child.kill();
  throw new Error(`常驻进程 ${DAEMON_READY_TIMEOUT_MS / 1000} 秒内未就绪，输出见 ${startErr}`);
}

/** 请求常驻进程停止，等到它释放会话锁 */
/** 请求常驻进程停止，等到它释放会话锁；之后被别的命令接手的锁不算在内 */
async function stopDaemon(name: string): Promise<void> {
  const holder = lockHolder(name);
  await simpleRequest(name, { type: "stop" });
  const deadline = Date.now() + DAEMON_STOP_TIMEOUT_MS;
  while (holder !== undefined && lockHolder(name) === holder) {
    if (Date.now() > deadline) throw new Error(`常驻进程 ${DAEMON_STOP_TIMEOUT_MS / 1000} 秒内未退出`);
    await sleep(100);
  }
}

async function stop(argv: string[]): Promise<number> {
  const [name] = argv;
  assertName(name);
  await stopDaemon(name);
  print(`已停止常驻进程 ${name}`);
  return 0;
}

async function steer(argv: string[]): Promise<number> {
  const [name, raw] = argv;
  assertName(name);
  if (argv.length !== 2) throw new Error("需要恰好一条消息，含空格时请加引号，或用 - 从 stdin 读取");
  print(await simpleRequest(name, { type: "steer", message: await readMessage(raw) }));
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
    options: { cancel: { type: "boolean" } },
  });
  const [name, id, raw] = positionals;
  assertName(name);
  if (!id) throw new Error("缺少提问 id");
  const req: ClientRequest = values.cancel
    ? { type: "answer", id, cancelled: true }
    : { type: "answer", id, value: await readMessage(raw) };
  return awaitRun(name, request(await requireDaemon(name), req));
}

/**
 * 等待期内反复查找正在进行的运行：常驻进程能连上就交给它（它在空闲时会继续等新运行开始），
 * print 模式的日志属于当前持锁的运行就跟随日志。等待期覆盖常驻进程的启动超时，
 * 也容许 watch 先于首次 send 创建会话记录
 */
/**
 * 等待期内反复查找正在进行的运行：常驻进程能连上就交给它（它在空闲时会继续等新运行开始，
 * 等待中退出则回到这里继续找）；print 模式的日志属于当前持锁的运行就跟随日志；
 * 两次查找之间开始并结束的运行，从日志回放。等待期覆盖常驻进程的启动超时，
 * 也容许 watch 先于首次 send 创建会话记录
 */
async function watch(argv: string[]): Promise<number> {
  const [name] = argv;
  assertName(name);
  const startedAt = Date.now();
  const deadline = startedAt + WATCH_START_WAIT_MS;
  const log = logPath(name);
  for (;;) {
    const daemon = await openDaemon(name);
    if (daemon) {
      const code = await watchDaemon(name, daemon, Math.max(0, deadline - Date.now()));
      if (code !== undefined) return code;
    } else if (lockHolder(name) !== undefined && logBelongsToCurrentRun(name, log)) {
      return followLog(name);
    } else if (finishedSince(log, startedAt)) {
      return followLog(name);
    }
    if (Date.now() >= deadline) break;
    await sleep(200);
  }
  if (!readRecord(name)) throw new Error(`会话不存在：${name}`);
  return printLastRun(name, lastLogLines(name));
}

/** 日志在 since 之后被重写且已有结束标记：一次在两次查找之间开始并结束的运行 */
function finishedSince(log: string, since: number): boolean {
  if (!existsSync(log) || statSync(log).mtimeMs < since) return false;
  const lines = readFileSync(log, "utf8").split("\n");
  return lines.includes(DONE) || lines.includes(FAILED);
}

/** 返回 undefined 表示常驻进程在等待新运行期间退出，由调用方继续查找 */
async function watchDaemon(name: string, daemon: Socket, waitStartMs: number): Promise<number | undefined> {
  let last: string | undefined;
  for await (const message of request(daemon, { type: "watch", waitStartMs })) {
    if (message.type === "idle") return printLastRun(name, message.lines);
    if (message.type !== "line") continue;
    print(message.line);
    last = message.line;
  }
  if (last === undefined) return undefined;
  if (last === DONE) return 0;
  if (last === FAILED) return 1;
  print(`${FAILED} 与常驻进程的连接中断`);
  return 1;
}

/** 等待期内没有新运行时回放上一次运行，退出码随上一次运行的结果 */
function printLastRun(name: string, lines: string[]): number {
  if (lines.length === 0) {
    print(`[idle] 会话 ${name} 当前没有任务在运行`);
    return 0;
  }
  print(`[idle] 会话 ${name} 当前没有任务在运行，以下是上一次运行的记录`);
  for (const line of lines) print(line);
  const done = lines.lastIndexOf(DONE);
  const failed = lines.lastIndexOf(FAILED);
  if (done === -1 && failed === -1) {
    print(`${FAILED} 上一次运行没有结束标记，可能异常中断`);
    return 1;
  }
  return failed > done ? 1 : 0;
}

/**
 * 日志在当前这把锁创建之后被重写过，才属于正在进行的运行。send 拿到锁与重写日志之间有空档，
 * 空档内读到的是上一次运行留下的日志，其中的结束标记会让 watch 误以为本次已结束
 */
function logBelongsToCurrentRun(name: string, log: string): boolean {
  const lockedAt = lockCreatedAt(name);
  return lockedAt !== undefined && existsSync(log) && statSync(log).mtimeMs >= lockedAt;
}

/** 跟随 print 模式正在进行的运行，直到结束标记 */
async function followLog(name: string): Promise<number> {
  const log = logPath(name);
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

function lastLogLines(name: string): string[] {
  const log = logPath(name);
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").slice(0, -1);
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
    const worktree = record.worktree ? [`${record.worktree.branch}@${record.worktree.base.slice(0, 12)}`] : [];
    print([record.name, status, record.updatedAt, record.cwd, sessionIdOf(record), ...worktree].join("\t"));
  }
  return 0;
}

async function rm(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { force: { type: "boolean" } } });
  const [name] = positionals;
  assertName(name);
  const daemon = await openDaemon(name);
  if (daemon) {
    daemon.destroy();
    await stopDaemon(name);
  }
  const release = acquireLock(name);
  try {
    const record = readRecord(name);
    if (!record) throw new Error(`会话不存在：${name}`);
    if (record.worktree) removeWorktree(record.worktree, record.cwd, values.force ?? false);
    removeRecord(name);
    const worktreeNote = record.worktree ? `；worktree 已删除，分支 ${record.worktree.branch} 保留` : "";
    // 旧格式记录的 UUID 只存在于这份记录里，删除后同名 send 会以会话名新建会话
    const resumeNote = record.id
      ? `；这是旧格式会话，同名再 send 会新建会话，旧历史在 ${record.cwd} 执行 pi --session-id ${record.id} 打开`
      : "，同名再 send 会续接";
    print(`已删除会话 ${name}，pi 会话文件（${sessionIdOf(record)}）仍保留${resumeNote}${worktreeNote}`);
    return 0;
  } finally {
    release();
  }
}

async function review(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      staged: { type: "boolean" },
      base: { type: "string" },
      cwd: { type: "string" },
      focus: { type: "string" },
      model: { type: "string" },
      thinking: { type: "string" },
    },
  });
  if (values.staged && values.base) throw new Error("--staged 与 --base 不能同时使用");
  const scope: ReviewScope = values.staged
    ? { kind: "staged" }
    : values.base
      ? { kind: "base", ref: values.base }
      : { kind: "head" };
  const prepared = prepareReview({ cwd: resolve(values.cwd ?? process.cwd()), scope, focus: values.focus });
  try {
    const name = reviewSessionName();
    const release = acquireLock(name);
    try {
      const now = new Date().toISOString();
      const record: SessionRecord = { name, cwd: prepared.root, createdAt: now, updatedAt: now };
      writeRecord(record);
      const footer = `\n\n[pi-bridge] 评审会话：${name}，追问用 pi-bridge send ${name} <消息>`;
      return await runPrint(record, true, prepared.message, { model: values.model, thinking: values.thinking }, footer);
    } finally {
      release();
    }
  } finally {
    prepared.cleanup();
  }
}

/** 如 review-20261001T013000-4242：进程号避免同一秒内的两次评审撞名 */
function reviewSessionName(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  return `review-${stamp}-${process.pid}`;
}

const commands: Record<string, (argv: string[]) => number | Promise<number>> = {
  send,
  watch,
  list,
  rm,
  stop,
  steer,
  answer,
  abort,
  review,
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
