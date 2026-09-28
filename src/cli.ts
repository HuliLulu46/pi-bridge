import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { preview, runPi } from "./pi.ts";
import {
  acquireLock,
  assertName,
  listRecords,
  lockHolder,
  logPath,
  readRecord,
  removeRecord,
  writeRecord,
} from "./store.ts";

const USAGE = `用法：
  pi-bridge send <会话名> [--cwd <目录>] [--model <模型>] <消息|-> [-- <pi 参数>...]
  pi-bridge watch <会话名>
  pi-bridge list
  pi-bridge rm <会话名>

消息写 - 时从 stdin 读取。首次 send 创建会话并绑定 cwd（默认当前目录），之后固定在该目录运行。`;

const DONE = "[done]";
const FAILED = "[failed]";
/** watch 启动后等待 send 拿到锁的时长，覆盖两者同时启动时的先后顺序 */
const WATCH_START_WAIT_MS = 10_000;
const WATCH_POLL_MS = 500;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function send(argv: string[]): Promise<number> {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1);
  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: { cwd: { type: "string" }, model: { type: "string" } },
  });
  const [name, rawMessage] = positionals;
  assertName(name);
  if (positionals.length !== 2) throw new Error("需要恰好一条消息，含空格时请加引号，或用 - 从 stdin 读取");
  const message = rawMessage === "-" ? await readStdin() : rawMessage!;
  if (!message.trim()) throw new Error("消息为空");

  const release = acquireLock(name);
  try {
    const now = new Date().toISOString();
    const log = logPath(name);
    writeFileSync(log, `[start] ${now} ${preview(message)}\n`);
    const progress = (line: string): void => appendFileSync(log, `${line}\n`);

    const existing = readRecord(name);
    const cwd = resolve(values.cwd ?? existing?.cwd ?? process.cwd());
    if (existing && existing.cwd !== cwd) throw new Error(`会话 ${name} 绑定在 ${existing.cwd}，不能改到 ${cwd}`);
    if (!existing && !existsSync(cwd)) throw new Error(`目录不存在：${cwd}`);
    const record = existing ?? { name, id: randomUUID(), cwd, createdAt: now, updatedAt: now };
    writeRecord(record);

    const result = await runPi({
      sessionId: record.id,
      cwd,
      message,
      piArgs: [...(existing ? [] : ["--name", name]), ...(values.model ? ["--model", values.model] : []), ...passthrough],
      onProgress: progress,
    });
    writeRecord({ ...record, updatedAt: new Date().toISOString() });

    const notice = result.failedTools.length
      ? `\n\n[pi-bridge] ${result.failedTools.length} 次工具调用出错或被拦截：\n${result.failedTools.map((item) => `- ${item}`).join("\n")}`
      : "";
    if (result.ok) {
      progress(`[reply]\n${result.reply}${notice}\n${DONE}`);
      process.stdout.write(`${result.reply}${notice}\n`);
      return 0;
    }
    progress(`[error]\n${result.error}${notice}\n${FAILED}`);
    if (result.reply) process.stdout.write(`${result.reply}\n`);
    process.stderr.write(`pi-bridge: ${result.error}${notice}\n`);
    return 1;
  } finally {
    release();
  }
}

async function watch(argv: string[]): Promise<number> {
  const [name] = argv;
  assertName(name);
  if (!readRecord(name)) throw new Error(`会话不存在：${name}`);
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
        process.stdout.write(`${line}\n`);
        if (line === DONE) return 0;
        if (line === FAILED) return 1;
      }
      offset = end;
    }
    if (!running) {
      process.stdout.write(`${FAILED} 会话 ${name} 没有在运行，日志也没有结束标记\n`);
      return 1;
    }
    await sleep(WATCH_POLL_MS);
  }
}

function list(): number {
  const records = listRecords();
  if (records.length === 0) {
    process.stdout.write("（没有会话）\n");
    return 0;
  }
  for (const record of records) {
    const status = lockHolder(record.name) === undefined ? "idle" : "running";
    process.stdout.write(`${[record.name, status, record.updatedAt, record.cwd, record.id].join("\t")}\n`);
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
    process.stdout.write(`已删除会话映射 ${name}，pi 会话文件（${record.id}）仍保留\n`);
    return 0;
  } finally {
    release();
  }
}

const commands: Record<string, (argv: string[]) => number | Promise<number>> = { send, watch, list, rm };

const [command, ...rest] = process.argv.slice(2);
const handler = command === undefined ? undefined : commands[command];
if (!handler) {
  process.stdout.write(`${USAGE}\n`);
  process.exitCode = command === undefined || command === "help" || command === "--help" ? 0 : 1;
} else {
  try {
    process.exitCode = await handler(rest);
  } catch (err) {
    process.stderr.write(`pi-bridge: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
