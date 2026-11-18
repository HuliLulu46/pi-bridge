import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { DaemonOptions } from "./daemon.ts";
import { ADVISOR_ARGS, modelArgs, runPi, type Role } from "./pi.ts";
import { subagentPrompt } from "./prompts.ts";
import { preview, toolNotice } from "./events.ts";
import { createWorktree, projectIdentity, removeWorktree, rollbackError, type RepoIdentity, type ReviewScope } from "./git.ts";
import { forkPiSession, importPiHistory, readHistoryFile } from "./fork.ts";
import { prepareReview } from "./review.ts";
import {
  appendEvent,
  assertRunId,
  eventFromProgress,
  latestRunsBySession,
  newRunId,
  pruneRuns,
  readEvents,
  readRun,
  runsDir,
  writeRun,
  type RunRecord,
} from "./runs.ts";
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
  pi-bridge send <会话名> [--role advisor|executor] [--cwd <目录>] [--model <模型>] [--thinking <等级>] [--worktree] [--history-file <绝对路径>] <消息|->
  pi-bridge watch <会话名>
  pi-bridge list [--all | --here] [--active] [--json]
  pi-bridge rm <会话名> [--force]
  pi-bridge review [--staged | --base <分支>] [--cwd <目录>] [--focus <关注点>] [--model <模型>] [--thinking <等级>]
  pi-bridge result <运行编号>
  pi-bridge events [--since <字节偏移>] [--follow]

机器可读：send / answer / review / list 加 --json 输出 JSON（退出码不变：0 成功，1 失败，2 有待回答的提问）；
send / answer / review 加 --detach 立即返回 {"session","runId"}（隐含 --json），任务在后台继续，
结果用 result <运行编号> 取，状态变化追加在 ~/.pi-bridge/events.ndjson，events 命令读取它。

常驻进程（executor 会话的任务中途干预、回答 pi 的提问）：
  pi-bridge steer <会话名> <消息|->
  pi-bridge answer <会话名> <提问 id> <回答|->
  pi-bridge answer <会话名> <提问 id> --cancel
  pi-bridge abort <会话名>
  pi-bridge stop <会话名>

主会话归属（供 PiAgent mod 等调用方使用）：send、review、steer、answer、abort、stop 可加 --owner <主会话 id>。
同名会话属于别的主会话时：send 自动分出本主会话的副本（<会话名>.<id 前 6 位>）在副本上续接，之后同名都进副本；
对方正在运行或会话带 worktree 时拒绝；steer、answer、abort、stop 只作用于本主会话的会话或副本。steer、abort、stop 加 --json 输出一行 JSON

消息写 - 时从 stdin 读取。首次 send 创建会话并绑定 cwd（默认当前目录），之后固定在该目录运行。
--history-file 从 JSON {"messages":[{"role":"user","text":"..."}]} 导入历史，role 允许 user 或 assistant，只允许用于全新会话名。
--role 缺省为 advisor：只读，跑完即退出。
executor 在常驻进程中运行，没有常驻进程时自动启动，空闲 30 分钟自动退出；
pi 提问时 send 打印提问并以退出码 2 退出，用 answer 回答后继续等待。会话有常驻进程时，先 stop 才能以 advisor 发送。
创建会话时加 --worktree，会在 <仓库>/.pi-bridge/worktrees/<会话名> 建立分支为 pi/<会话名> 的 worktree 并在其中运行。
list 默认只列当前项目（git 主仓库根；worktree 会话与主仓库算同一项目）的会话：--all 列全部，--here 等同默认，--active 只列 running/daemon。`;

const EXIT_ASK = 2;
/** watch 启动后等待任务开始的时长，覆盖 send 与 watch 同时启动时的先后顺序，以及常驻进程的启动超时 */
const WATCH_START_WAIT_MS = Number(process.env.PI_BRIDGE_WATCH_WAIT_MS ?? 70_000);
const WATCH_POLL_MS = 500;
const DAEMON_READY_TIMEOUT_MS = 60_000;
const DAEMON_STOP_TIMEOUT_MS = 10_000;
/** macOS 的 unix socket 路径上限为 104 字节 */
const SOCKET_PATH_MAX = 103;
const DAEMON_ENTRY = fileURLToPath(new URL("./daemon.ts", import.meta.url));
const CLI_ENTRY = fileURLToPath(import.meta.url);
/** detach 后等后台进程写出运行记录的时限 */
const DETACH_READY_TIMEOUT_MS = 60_000;

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function printJson(value: unknown): void {
  print(JSON.stringify(value));
}

/** list --json 里会话最近一次运行的摘要：状态、时间、失败原因（截短），全文用 result 取 */
function lastRunOf(run: RunRecord | undefined): { lastRun?: Record<string, unknown> } {
  if (run === undefined) return {};
  return {
    lastRun: {
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      ...(run.error ? { error: run.error.slice(0, 200) } : {}),
    },
  };
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
  owner?: string,
  historyFile?: string,
): { record: SessionRecord; isNew: boolean } {
  const existing = readRecord(name);
  if (existing && historyFile !== undefined) throw new Error("fork 只能用于新的会话名：bridge 会话记录已存在");
  if (existing && worktree) throw new Error(`会话 ${name} 已存在，worktree 只能在创建会话时指定`);
  const cwd = resolve(cwdOption ?? existing?.cwd ?? process.cwd());
  if (existing && existing.cwd !== cwd) throw new Error(`会话 ${name} 绑定在 ${existing.cwd}，不能改到 ${cwd}`);
  if (existing) return { record: existing, isNew: false };
  if (!existsSync(cwd)) throw new Error(`目录不存在：${cwd}`);
  const history = historyFile !== undefined ? readHistoryFile(historyFile) : undefined;
  const now = new Date().toISOString();
  const base = { name, createdAt: now, updatedAt: now, ...(owner !== undefined ? { owner } : {}) };
  const created = worktree ? createWorktree(cwd, name) : undefined;
  const record = created ? { ...base, cwd: created.path, worktree: created.info } : { ...base, cwd };
  let imported: string | undefined;
  try {
    if (history) imported = importPiHistory(history, sessionIdOf(record), record.cwd);
    writeRecord(record);
  } catch (err) {
    if (imported) rmSync(imported, { force: true });
    throw created ? rollbackError(err, created.rollback()) : err;
  }
  return { record, isNew: true };
}

async function requireDaemon(name: string): Promise<Socket> {
  const socket = await openDaemon(name);
  if (!socket) throw new Error(`会话 ${name} 没有运行中的常驻进程，用 send --role executor 启动`);
  return socket;
}

/** 等到 pi 提问或本次运行结束 */
async function awaitRun(name: string, stream: AsyncGenerator<DaemonMessage>, json = false): Promise<number> {
  for await (const message of stream) {
    switch (message.type) {
      case "ask":
        if (json) printJson({ status: "asking", session: name, runId: message.runId, ask: message.ask });
        else print(formatAsk(name, message.ask));
        return EXIT_ASK;
      case "done":
        if (json) printJson({ status: "done", session: name, runId: message.runId, reply: message.text });
        else print(message.text);
        return 0;
      case "failed":
        if (json) {
          printJson({ status: "failed", session: name, runId: message.runId, error: message.error, reply: message.text });
          return 1;
        }
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

type OwnerOp = "send" | "steer" | "answer" | "abort" | "stop";

/** 副本名后缀：主会话 id 去掉非字母数字后的前 6 位 */
function ownerTag(owner: string): string {
  const tag = owner.replace(/[^A-Za-z0-9]/g, "").slice(0, 6);
  if (tag === "") throw new Error(`--owner 需要字母或数字：${owner}`);
  return tag;
}

/**
 * 带 --owner（主会话 id）时，决定实际作用的会话：
 * - 会话不存在、无主或属于这个主会话：就用它（send 时无主的记到这个主会话名下）
 * - 属于别的主会话：本主会话从它分出过副本就用副本；send 时没有副本就分一份
 * - 别的主会话的会话正在运行、带 worktree，或 steer/answer/abort/stop 而没有副本：拒绝
 */
function resolveOwned(name: string, owner: string | undefined, op: OwnerOp): string {
  if (owner === undefined) return name;
  const record = readRecord(name);
  if (!record) return name;
  if (record.owner === undefined) {
    // 正在跑（旧版调用方派发的、或终端里直接跑的）先不认领，免得真正在用它的一方之后被分到副本
    if (op === "send" && !isBusy(name)) writeRecord({ ...record, owner });
    return name;
  }
  if (record.owner === owner) return name;
  const mine = listRecords().find((r) => r.forkOf === name && r.owner === owner);
  if (mine) return mine.name;
  if (op !== "send") throw new Error(`会话 ${name} 属于另一个主会话，不能 ${op}`);
  if (record.worktree) throw new Error(`会话 ${name} 属于另一个主会话且带 worktree，不能分出副本；请换一个新会话名`);
  const running = isBusy(name);
  if (running) {
    throw new Error(`会话 ${name} 属于另一个主会话，正在运行任务（${running}）；等它结束后再派发会自动分出本主会话的副本，或换一个新会话名`);
  }
  const fork = `${name}.${ownerTag(owner)}`;
  assertName(fork);
  if (readRecord(fork)) throw new Error(`副本名 ${fork} 已被别的会话占用；请换一个新会话名`);
  forkPiSession(sessionIdOf(record), fork, record.cwd);
  const now = new Date().toISOString();
  writeRecord({ name: fork, cwd: record.cwd, createdAt: now, updatedAt: now, owner, forkOf: name });
  return fork;
}

/** 有任务在跑：持锁且最近一次运行是 running/asking，返回它的 runId。常驻进程空闲时也持锁，不算 */
function isBusy(name: string): string | undefined {
  if (lockHolder(name) === undefined) return undefined;
  const latest = latestRunsBySession().get(name);
  return latest?.status === "running" || latest?.status === "asking" ? latest.runId : undefined;
}

/** steer、abort、stop 的参数：只取 --owner 与 --json，其余原样作为位置参数（消息可能以 - 开头） */
function takeFlags(argv: string[]): { owner?: string; json: boolean; rest: string[] } {
  const rest: string[] = [];
  let owner: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--owner") owner = argv[++i];
    else if (argv[i] === "--json") json = true;
    else rest.push(argv[i]!);
  }
  return { owner, json, rest };
}

interface SendOptions {
  cwd?: string;
  historyFile?: string;
  model?: string;
  thinking?: string;
  worktree: boolean;
  /** 以 JSON 输出结果 */
  json: boolean;
  /** 立即返回运行编号，任务在后台继续（隐含 json） */
  detach: boolean;
  /** 归属的主会话，新建会话时记入记录 */
  owner?: string;
}

async function send(argv: string[]): Promise<number> {
  if (argv.includes("--")) throw new Error("不支持透传 pi 参数，模型与思考等级用 --model、--thinking 指定");
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      role: { type: "string", default: "advisor" },
      cwd: { type: "string" },
      "history-file": { type: "string" },
      model: { type: "string" },
      thinking: { type: "string" },
      worktree: { type: "boolean" },
      json: { type: "boolean" },
      detach: { type: "boolean" },
      owner: { type: "string" },
    },
  });
  const [requested, raw] = positionals;
  assertName(requested);
  if (positionals.length !== 2) throw new Error("需要恰好一条消息，含空格时请加引号，或用 - 从 stdin 读取");
  const role = values.role as Role;
  if (role !== "advisor" && role !== "executor") {
    throw new Error(`--role 只能是 advisor 或 executor：${role}`);
  }
  const owner = values.owner;
  const historyFile = values["history-file"];
  // 导入历史不能认领已有记录，也不能触发 owner 副本的创建。
  if (historyFile !== undefined && readRecord(requested)) throw new Error("fork 只能用于新的会话名：bridge 会话记录已存在");
  const name = historyFile !== undefined ? requested : resolveOwned(requested, owner, "send");
  const message = await readMessage(raw);
  const opts: SendOptions = {
    cwd: values.cwd,
    historyFile,
    model: values.model,
    thinking: values.thinking,
    worktree: values.worktree ?? false,
    json: (values.json ?? false) || (values.detach ?? false),
    detach: values.detach ?? false,
    owner,
  };
  if (opts.detach && role !== "executor") {
    // 后台子进程自己拿会话锁、跑完整个 send；这里只负责等它写出运行记录
    const args = [
      "send",
      name,
      "--role",
      role,
      ...(values.cwd ? ["--cwd", resolve(values.cwd)] : []),
      ...(values.model ? ["--model", values.model] : []),
      ...(values.thinking ? ["--thinking", values.thinking] : []),
      ...(opts.worktree ? ["--worktree"] : []),
      ...(historyFile !== undefined ? ["--history-file", historyFile] : []),
      ...(owner !== undefined ? ["--owner", owner] : []),
      "--json",
      "-",
    ];
    return detachChild(args, message);
  }
  return role === "executor" ? sendExecutor(name, message, opts) : sendPrint(name, message, opts);
}

async function sendPrint(name: string, message: string, opts: SendOptions): Promise<number> {
  const daemon = await openDaemon(name);
  if (daemon) {
    daemon.destroy();
    throw new Error(`会话 ${name} 有常驻进程，先 pi-bridge stop ${name}（正在执行的任务会被中止），再以 advisor 发送`);
  }
  const release = acquireLock(name);
  try {
    const { record, isNew } = ensureRecord(name, opts.cwd, opts.worktree, opts.owner, opts.historyFile);
    return await runPrint(record, isNew, message, { model: opts.model, thinking: opts.thinking, json: opts.json });
  } finally {
    release();
  }
}

interface PrintOptions {
  model?: string;
  thinking?: string;
  json?: boolean;
}

/** detach 的后台子进程由父进程预先分配运行编号，经环境变量传入；取走后清掉，不让它漏给下游进程 */
function takeRunId(): string {
  const given = process.env.PI_BRIDGE_RUN_ID;
  delete process.env.PI_BRIDGE_RUN_ID;
  if (given) {
    assertRunId(given);
    return given;
  }
  return newRunId();
}

/** 以 print 模式运行一轮；调用方须持有会话锁。footer 附在回复与错误信息末尾 */
async function runPrint(
  record: SessionRecord,
  isNew: boolean,
  message: string,
  opts: PrintOptions,
  footer = "",
): Promise<number> {
  const log = logPath(record.name);
  let run: RunRecord = {
    runId: takeRunId(),
    session: record.name,
    role: "advisor",
    cwd: record.cwd,
    status: "running",
    startedAt: new Date().toISOString(),
    message: preview(message),
  };
  pruneRuns();
  // 运行记录先于事件、事件先于会话日志：读者看到任何一处，前面的都已落盘
  writeRun(run);
  appendEvent({ session: record.name, runId: run.runId, type: "start", text: message });
  writeFileSync(log, `[start] ${new Date().toISOString()} ${preview(message)}\n`);
  const progress = (line: string): void => {
    appendFileSync(log, `${line}\n`);
    const event = eventFromProgress(record.name, run.runId, line);
    if (event) appendEvent(event);
  };
  let result: Awaited<ReturnType<typeof runPi>>;
  try {
    result = await runPi({
      sessionId: sessionIdOf(record),
      cwd: record.cwd,
      message,
      piArgs: [...(isNew ? ["--name", record.name] : []), ...ADVISOR_ARGS, "--append-system-prompt", subagentPrompt("advisor"), ...modelArgs(opts.model, opts.thinking)],
      onProgress: progress,
    });
  } catch (err) {
    run = { ...run, status: "failed", endedAt: new Date().toISOString(), error: (err as Error).message, exitCode: 1 };
    writeRun(run);
    appendEvent({ session: record.name, runId: run.runId, type: "failed", text: run.error });
    throw err;
  }
  writeRecord({ ...record, updatedAt: new Date().toISOString() });

  const notice = `${toolNotice(result.failedTools)}${footer}`;
  const endedAt = new Date().toISOString();
  if (result.ok) {
    run = { ...run, status: "done", endedAt, reply: `${result.reply}${notice}`, exitCode: 0 };
    writeRun(run);
    appendEvent({ session: record.name, runId: run.runId, type: "done" });
    progress(`[reply]\n${result.reply}${notice}\n${DONE}`);
    if (opts.json) printJson(run);
    else print(`${result.reply}${notice}`);
    return 0;
  }
  run = { ...run, status: "failed", endedAt, reply: result.reply, error: `${result.error}${notice}`, exitCode: 1 };
  writeRun(run);
  appendEvent({ session: record.name, runId: run.runId, type: "failed", text: run.error });
  progress(`[error]\n${result.error}${notice}\n${FAILED}`);
  if (opts.json) {
    printJson(run);
  } else {
    if (result.reply) print(result.reply);
    process.stderr.write(`pi-bridge: ${result.error}${notice}\n`);
  }
  return 1;
}

/**
 * 在后台子进程里重新执行本命令（args 是子进程的完整参数，stdin 可选），等它写出运行记录后返回 {session, runId}。
 * 子进程自己拿会话锁、跑完整个运行，父进程退出不影响它；子进程在写出记录前失败（锁被占用、参数不合法等），
 * 把它的输出作为错误抛出
 */
async function detachChild(args: string[], stdin?: string): Promise<number> {
  const runId = newRunId();
  const outFile = join(runsDir(), `${runId}.out`);
  const fd = openSync(outFile, "w");
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    detached: true,
    stdio: [stdin === undefined ? "ignore" : "pipe", fd, fd],
    env: { ...process.env, PI_BRIDGE_RUN_ID: runId },
  });
  closeSync(fd);
  let exited = false;
  child.on("exit", () => (exited = true));
  child.on("error", () => (exited = true));
  if (stdin !== undefined) child.stdin!.end(stdin);
  child.unref();

  const deadline = Date.now() + DETACH_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = readRun(runId);
    if (run) {
      printJson({ session: run.session, runId, status: run.status });
      return 0;
    }
    if (exited) {
      // 退出与记录的写入之间可能隔一拍，再查一次
      const late = readRun(runId);
      if (late) {
        printJson({ session: late.session, runId, status: late.status });
        return 0;
      }
      throw new Error(detachFailure(outFile));
    }
    await sleep(50);
  }
  throw new Error(`后台进程 ${DETACH_READY_TIMEOUT_MS / 1000} 秒内没有开始运行，输出见 ${outFile}`);
}

/** 后台子进程的输出：json 模式的错误是一行 {"status":"error","error":...}，其余原样 */
function detachFailure(outFile: string): string {
  const text = readFileSync(outFile, "utf8").trim();
  rmSync(outFile, { force: true });
  for (const line of text.split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line) as { error?: string };
      if (typeof parsed.error === "string") return parsed.error;
    } catch {
      // 不是 JSON 行
    }
  }
  return text || "后台进程启动失败";
}

async function sendExecutor(name: string, message: string, opts: SendOptions): Promise<number> {
  let daemon = await openDaemon(name);
  if (daemon) {
    const record = readRecord(name);
    const boundCwd = record?.cwd;
    const conflict = opts.historyFile !== undefined
      ? "fork 只能用于新的会话名：会话已有常驻进程"
      : opts.worktree
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
  if (opts.detach) {
    for await (const msg of request(daemon, { type: "prompt", message, detach: true })) {
      if (msg.type === "started") {
        printJson({ session: name, runId: msg.runId, status: "running" });
        return 0;
      }
      if (msg.type === "error") throw new Error(msg.error);
    }
    throw new Error("与常驻进程的连接中断");
  }
  return awaitRun(name, request(daemon, { type: "prompt", message }), opts.json);
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
    ensured = ensureRecord(name, opts.cwd, opts.worktree, opts.owner, opts.historyFile);
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

/** steer、abort、stop 的输出：--json 时一行 {status, session, text}，session 是实际作用的会话 */
function printOk(name: string, text: string, json: boolean): number {
  if (json) printJson({ status: "ok", session: name, text });
  else print(text);
  return 0;
}

async function stop(argv: string[]): Promise<number> {
  const { owner, json, rest } = takeFlags(argv);
  const [requested] = rest;
  assertName(requested);
  const name = resolveOwned(requested, owner, "stop");
  await stopDaemon(name);
  return printOk(name, `已停止常驻进程 ${name}`, json);
}

async function steer(argv: string[]): Promise<number> {
  const { owner, json, rest } = takeFlags(argv);
  const [requested, raw] = rest;
  assertName(requested);
  if (rest.length !== 2) throw new Error("需要恰好一条消息，含空格时请加引号，或用 - 从 stdin 读取");
  const name = resolveOwned(requested, owner, "steer");
  return printOk(name, await simpleRequest(name, { type: "steer", message: await readMessage(raw) }), json);
}

async function abort(argv: string[]): Promise<number> {
  const { owner, json, rest } = takeFlags(argv);
  const [requested] = rest;
  assertName(requested);
  const name = resolveOwned(requested, owner, "abort");
  return printOk(name, await simpleRequest(name, { type: "abort" }), json);
}

async function answer(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { cancel: { type: "boolean" }, json: { type: "boolean" }, detach: { type: "boolean" }, owner: { type: "string" } },
  });
  const [requested, id, raw] = positionals;
  assertName(requested);
  if (!id) throw new Error("缺少提问 id");
  const name = resolveOwned(requested, values.owner, "answer");
  const detach = values.detach ?? false;
  const req: ClientRequest = values.cancel
    ? { type: "answer", id, cancelled: true, detach }
    : { type: "answer", id, value: await readMessage(raw), detach };
  const stream = request(await requireDaemon(name), req);
  if (!detach) return awaitRun(name, stream, values.json ?? false);
  for await (const msg of stream) {
    if (msg.type === "ok") {
      printJson({ session: name, status: "running" });
      return 0;
    }
    if (msg.type === "error") throw new Error(msg.error);
  }
  throw new Error("与常驻进程的连接中断");
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

/** 规范化并解析符号链接，使别名路径与真实路径可比；目录已删除时退回词法绝对路径 */
function realDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** child 等于 parent 或在 parent 之下；按路径段判断，避免 /ab 命中 /abc，也避免 ..cache 被误判为越界 */
function isUnderOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

interface DirIdentity {
  /** 解析符号链接后的目录本身，git 不可用时的兜底身份 */
  real: string;
  git: RepoIdentity;
}

/**
 * 两处是否属于同一项目。都在 Git 仓库内时按共享 Git 目录的包含关系判定：
 * common 相等即同一仓库（覆盖其子目录与内置/外置 worktree、--separate-git-dir）；record 的 common 在 current 的 common
 * 之下即嵌套（现代子模块的 common 为 <父>/.git/modules/<名>）——只依赖 worktree 无关的 common，故从任一 worktree 结果一致。
 * 有一方不在 Git 仓库内时，退回工作区路径的单向包含（record 在 current 之下）。
 * 已知限制：old-form 子模块（保留内嵌 <sub>/.git、未 absorbgitdirs）其 common 不在父 common 之下，会被当作独立项目——
 * 从父仓库执行 list 看不到它，需进入该子模块目录才可见。要精确识别须读 .gitmodules 登记，成本远高于此便利过滤的收益，故不做。
 */
function sameProject(record: DirIdentity, current: DirIdentity): boolean {
  const recordCommon = record.git.common;
  const currentCommon = current.git.common;
  if (recordCommon !== undefined && currentCommon !== undefined) return isUnderOrEqual(recordCommon, currentCommon);
  return isUnderOrEqual(record.git.toplevel ?? record.real, current.git.toplevel ?? current.real);
}

function list(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      all: { type: "boolean" },
      here: { type: "boolean" },
      active: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  if (values.all && values.here) throw new Error("--all 与 --here 不能同时使用");

  const all = listRecords();
  // 解析符号链接后取目录的 Git 身份（同一仓库的所有 worktree 共享 common，子模块/独立仓库各异）；按目录缓存，避免逐条记录重复调用 git
  const identityCache = new Map<string, DirIdentity>();
  const identityOf = (dir: string): DirIdentity => {
    const real = realDir(dir);
    let entry = identityCache.get(real);
    if (entry === undefined) {
      entry = { real, git: projectIdentity(real) };
      identityCache.set(real, entry);
    }
    return entry;
  };
  // 默认按当前项目过滤；--all 关闭过滤
  const current = values.all ? undefined : identityOf(process.cwd());
  const scoped = all.filter(
    (record) => current === undefined || sameProject(identityOf(record.worktree?.repo ?? record.cwd), current),
  );
  const rows = scoped.map((record) => {
    const held = lockHolder(record.name) !== undefined;
    const status = !held ? "idle" : existsSync(runPath(record.name, "sock")) ? "daemon" : "running";
    return { record, status };
  });
  const visible = values.active ? rows.filter((row) => row.status !== "idle") : rows;

  if (values.json) {
    const latest = latestRunsBySession();
    printJson(
      visible.map(({ record, status }) => ({
        name: record.name,
        status,
        updatedAt: record.updatedAt,
        cwd: record.cwd,
        sessionId: sessionIdOf(record),
        ...(record.worktree ? { worktree: { branch: record.worktree.branch, base: record.worktree.base } } : {}),
        ...(record.owner ? { owner: record.owner } : {}),
        ...(record.forkOf ? { forkOf: record.forkOf } : {}),
        ...lastRunOf(latest.get(record.name)),
      })),
    );
    return 0;
  }
  if (visible.length === 0) {
    if (all.length === 0) {
      print("（没有会话）");
    } else if (scoped.length === 0) {
      print(`（当前范围没有会话，全部 ${all.length} 个${current !== undefined ? "；试试 --all 看全部项目" : ""}）`);
    } else {
      print(`（当前范围有 ${scoped.length} 个会话，但都不活跃；去掉 --active 查看）`);
    }
    return 0;
  }
  for (const { record, status } of visible) {
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
    const historyNote = `pi 会话文件（${sessionIdOf(record)}）仍保留`;
    print(`已删除会话 ${name}，${historyNote}${resumeNote}${worktreeNote}`);
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
      json: { type: "boolean" },
      detach: { type: "boolean" },
      owner: { type: "string" },
    },
  });
  if (values.staged && values.base) throw new Error("--staged 与 --base 不能同时使用");
  const scope: ReviewScope = values.staged
    ? { kind: "staged" }
    : values.base
      ? { kind: "base", ref: values.base }
      : { kind: "head" };
  if (values.detach) {
    // 补丁与评审会话都由后台子进程自己准备，父进程只等运行记录
    const args = [
      "review",
      ...(values.staged ? ["--staged"] : []),
      ...(values.base ? ["--base", values.base] : []),
      "--cwd",
      resolve(values.cwd ?? process.cwd()),
      ...(values.focus ? ["--focus", values.focus] : []),
      ...(values.model ? ["--model", values.model] : []),
      ...(values.thinking ? ["--thinking", values.thinking] : []),
      ...(values.owner !== undefined ? ["--owner", values.owner] : []),
      "--json",
    ];
    return detachChild(args);
  }
  const prepared = prepareReview({ cwd: resolve(values.cwd ?? process.cwd()), scope, focus: values.focus });
  try {
    const name = reviewSessionName();
    const release = acquireLock(name);
    try {
      const now = new Date().toISOString();
      const record: SessionRecord = {
        name,
        cwd: prepared.root,
        createdAt: now,
        updatedAt: now,
        ...(values.owner !== undefined ? { owner: values.owner } : {}),
      };
      writeRecord(record);
      const footer = `\n\n[pi-bridge] 评审会话：${name}，追问用 pi-bridge send ${name} <消息>`;
      return await runPrint(record, true, prepared.message, { model: values.model, thinking: values.thinking, json: values.json }, footer);
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

function result(argv: string[]): number {
  const [runId] = argv;
  assertRunId(runId);
  const run = readRun(runId);
  if (!run) throw new Error(`没有这个运行：${runId}`);
  printJson(run);
  return 0;
}

/** 把全局事件日志里 --since 偏移之后的事件按行输出；--follow 持续跟随。每行一个 JSON 对象 */
async function events(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { since: { type: "string" }, follow: { type: "boolean" } } });
  let offset = values.since === undefined ? 0 : Number(values.since);
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`--since 要一个非负整数（字节偏移）：${values.since}`);
  for (;;) {
    const next = readEvents(offset);
    for (const event of next.events) printJson(event);
    offset = next.offset;
    if (!values.follow) return 0;
    await sleep(WATCH_POLL_MS);
  }
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
  result,
  events,
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
    const message = (err as Error).message;
    // 机器可读模式下错误也是一行 JSON，调用方不必同时解析 stderr
    if (rest.includes("--json") || rest.includes("--detach")) printJson({ status: "error", error: message });
    else process.stderr.write(`pi-bridge: ${message}\n`);
    process.exitCode = 1;
  }
}
