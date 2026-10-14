import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createLineSplitter, preview, type RunResult } from "./events.ts";

export interface QoderRunOptions {
  /** qoderclicn 的 --session-id / --resume 取值，必须是合法 UUID */
  sessionId: string;
  cwd: string;
  message: string;
  /** 首次运行用 --session-id 建会话，之后用 --resume 续接 */
  isNew: boolean;
  /** advisor 只读；editor 可写文件（Edit/Write），不给 Bash */
  role: PrintRole;
  model?: string;
  thinking?: string;
  systemPrompt?: string;
  /** qoderclicn 产出本次会话的 init 事件时触发：底层会话已确实存在（--session-id 已落盘） */
  onStarted?: () => void;
  /** 收到 SIGINT/SIGTERM（用户取消）或进程被信号终止时触发；取消后不允许回退重试 */
  onCancelled?: () => void;
  onProgress: (line: string) => void;
}

/** print 模式（一次性运行）下的角色：advisor 只读，editor 可编辑文件 */
export type PrintRole = "advisor" | "editor";

/** advisor 只读工具集：qoderclicn 的工具名是 PascalCase，没有 find/ls，用 Glob 覆盖查找 */
const ADVISOR_TOOLS = ["Read", "Grep", "Glob"];
/** editor 工具集：只读三件套 + 文件编辑。不含 Bash——权限被整体放行，执行命令风险太大 */
const EDITOR_TOOLS = [...ADVISOR_TOOLS, "Edit", "Write"];

function toolsOf(role: PrintRole): string[] {
  return role === "editor" ? EDITOR_TOOLS : ADVISOR_TOOLS;
}

export function qoderBin(): string {
  return process.env.QODER_BIN ?? "qoderclicn";
}

/**
 * 会话名 → 确定性 UUID。qoderclicn 的 --session-id 要求合法 UUID（pi 允许任意字符串），
 * 用 SHA-256 派生并置成 version 5 / variant 10xx 的形状，保证同名恒定、可跨进程 --resume。
 */
export function nameToUuid(name: string): string {
  const bytes = Uint8Array.from(createHash("sha256").update(`pi-bridge/qoder:${name}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/** stream-json 里 assistant / user 消息的内容块（只声明用到的字段） */
export interface QoderBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  /** 成功时为 null 或 false，失败时为 true */
  is_error?: boolean | null;
  content?: unknown;
}

/** qoderclicn `--output-format stream-json` 的一行事件（只声明用到的字段） */
export interface QoderEvent {
  type: string;
  subtype?: string;
  is_error?: boolean;
  /** result 事件里的最终回复文本 */
  result?: string;
  /** system/init 与 result 事件携带的会话 UUID */
  session_id?: string;
  message?: { role?: string; content?: string | QoderBlock[] };
}

function blocksOf(event: QoderEvent): QoderBlock[] {
  const content = event.message?.content;
  return Array.isArray(content) ? content : [];
}

/**
 * 跟踪一次 qoderclicn 运行：assistant 的 tool_use 转成 [tool] 进度行，user 的失败 tool_result
 * 转成 [tool-error] 并计入 failedTools；最终回复直接取 result 事件的 result 字段。
 */
export function createQoderRunTracker(onProgress: (line: string) => void) {
  const toolNames = new Map<string, string>();
  const failedTools: string[] = [];
  const texts: string[] = [];
  let finalText = "";
  let sawResult = false;
  let ok = false;
  let subtype = "";

  return {
    handle(event: QoderEvent): void {
      switch (event.type) {
        case "assistant":
          for (const block of blocksOf(event)) {
            if (block.type === "tool_use") {
              if (block.id) toolNames.set(block.id, block.name ?? "?");
              onProgress(`[tool] ${block.name ?? "?"} ${preview(block.input)}`);
            } else if (block.type === "text" && block.text) {
              texts.push(block.text);
            }
          }
          break;
        case "user":
          for (const block of blocksOf(event)) {
            if (block.type !== "tool_result" || block.is_error !== true) continue;
            const name = (block.tool_use_id && toolNames.get(block.tool_use_id)) || "?";
            const summary = `${name}: ${preview(block.content)}`;
            failedTools.push(summary);
            onProgress(`[tool-error] ${summary}`);
          }
          break;
        case "result":
          sawResult = true;
          finalText = event.result ?? "";
          subtype = event.subtype ?? "unknown";
          ok = subtype === "success" && event.is_error !== true;
          break;
      }
    },
    result(fallbackError: () => string): RunResult {
      const reply = finalText.trim() !== "" ? finalText : texts.join("\n\n").trim();
      if (sawResult && ok) return { ok: true, reply, failedTools };
      if (sawResult) return { ok: false, reply, error: `qoderclicn 运行未成功（${subtype}）`, failedTools };
      return { ok: false, reply, error: fallbackError(), failedTools };
    },
  };
}

/**
 * 以 print 模式跑一轮 qoderclicn（advisor 只读 / editor 可写文件）；进程结束（result 事件后自行退出）即完成。
 * 建会话时 UUID 已被占用（rm 删了 bridge 记录但底层会话文件还在）则回退为 --resume 重试一次，
 * 兑现“rm 后同名再 send 会续接”。回退只在首次尝试尚未开始（没有 init 事件）、未被取消
 * （没有收到 SIGINT/SIGTERM，也没有被信号终止）且错误明确是本次 UUID 的会话冲突时才发生，
 * 避免把无关的占用错误、跑了一半或用户刚取消的任务重放。
 */
export async function runQoder(opts: QoderRunOptions): Promise<RunResult> {
  let started = false;
  const markStarted = (): void => {
    started = true;
    opts.onStarted?.();
  };
  let cancelled = false;
  const attemptOpts: QoderRunOptions = {
    ...opts,
    onStarted: markStarted,
    onCancelled: () => (cancelled = true),
  };
  const result = await qoderAttempt(attemptOpts);
  if (opts.isNew && !started && !cancelled && !result.ok && isSessionIdConflict(result.error, opts.sessionId)) {
    return qoderAttempt({ ...attemptOpts, isNew: false });
  }
  return result;
}

/** qoderclicn 建会话撞已有 UUID 的报错形如：Error: Session ID <uuid> is already in use. */
export function isSessionIdConflict(error: string | undefined, sessionId: string): boolean {
  return error !== undefined && error.includes(`Session ID ${sessionId} is already in use`);
}

function qoderAttempt(opts: QoderRunOptions): Promise<RunResult> {
  const sessionArgs = opts.isNew ? ["--session-id", opts.sessionId] : ["--resume", opts.sessionId];
  const editor = opts.role === "editor";
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    ...sessionArgs,
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.thinking ? ["--thinking", opts.thinking] : []),
    ...(opts.systemPrompt ? ["--append-system-prompt", opts.systemPrompt] : []),
    // advisor 只读隔离：工具已被限制为只读三件套，没有写入/执行能力可绕过，因此放行权限确认
    // 能让读操作（含工作目录外的绝对路径）像 pi 的顾问一样免打断。
    // editor 用 accept_edits：工作目录内的 Edit/Write 自动放行、目录外仍被拒；没有 Bash，
    // 无头模式下需要确认的操作会被自动拒绝并作为 tool-error 汇报，不会卡住。
    // --strict-mcp-config 不加载外部 MCP server；--setting-sources 置空不加载用户/项目/local 设置，
    // 否则其中的 hook（如 PreToolUse）会在工具白名单之外执行任意命令，绕过只读隔离。
    "--permission-mode",
    editor ? "accept_edits" : "bypass_permissions",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--tools",
    ...toolsOf(opts.role),
    "--",
    opts.message,
  ];
  const child = spawn(qoderBin(), args, { cwd: opts.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });

  const tracker = createQoderRunTracker(opts.onProgress);
  const split = createLineSplitter();
  const stderr: Buffer[] = [];
  let sawInit = false;

  child.stdout.on("data", (chunk: Buffer) => {
    for (const line of split(chunk)) {
      let event: QoderEvent;
      try {
        event = JSON.parse(line) as QoderEvent;
      } catch {
        continue;
      }
      // 会话确实建好的标志：init 事件且 UUID 是本次的。启动诊断等杂散输出不算
      if (!sawInit && event.type === "system" && event.subtype === "init" && event.session_id === opts.sessionId) {
        sawInit = true;
        opts.onStarted?.();
      }
      tracker.handle(event);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const forward = (signal: NodeJS.Signals): void => {
    opts.onCancelled?.();
    child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  const cleanup = (): void => {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  };

  return new Promise((resolve) => {
    child.on("error", (err) => {
      cleanup();
      resolve({ ok: false, reply: "", error: `无法启动 qoderclicn：${err.message}`, failedTools: [] });
    });
    child.on("close", (code, signal) => {
      cleanup();
      // 被信号终止视同取消（如 shell 直接向子进程发信号），不允许回退重试
      if (signal) opts.onCancelled?.();
      resolve(
        tracker.result(
          () => Buffer.concat(stderr).toString("utf8").trim() || `qoderclicn 异常退出（${signal ?? `退出码 ${code}`}）`,
        ),
      );
    });
  });
}
