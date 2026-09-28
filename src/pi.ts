import { spawn } from "node:child_process";

export interface RunOptions {
  sessionId: string;
  cwd: string;
  message: string;
  piArgs: string[];
  onProgress: (line: string) => void;
}

export interface RunResult {
  ok: boolean;
  reply: string;
  error?: string;
  /** 出错或被扩展拦截的工具调用，每项为「工具名: 结果摘要」 */
  failedTools: string[];
}

interface ContentBlock {
  type: string;
  text?: string;
}

interface PiMessage {
  role: string;
  content?: ContentBlock[] | string;
  stopReason?: string;
  errorMessage?: string;
}

interface PiEvent {
  type: string;
  message?: PiMessage;
  toolName?: string;
  args?: unknown;
  result?: { content?: ContentBlock[] };
  isError?: boolean;
  attempt?: number;
  maxAttempts?: number;
  errorMessage?: string;
}

/** 代理的 keep-alive 连接会让 pi 在 agent_settled 之后仍不退出 */
const SETTLE_GRACE_MS = 2000;
const PREVIEW_LEN = 200;

export function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_LEN ? `${oneLine.slice(0, PREVIEW_LEN)}…` : oneLine;
}

function textOf(content: ContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

export function runPi(opts: RunOptions): Promise<RunResult> {
  const args = ["-p", "--mode", "json", "--session-id", opts.sessionId, ...opts.piArgs, "--", opts.message];
  const child = spawn(process.env.PI_BIN ?? "pi", args, {
    cwd: opts.cwd,
    // pi-code 按子代理处理：跳过 SessionStart/UserPromptSubmit/Stop 等会话级 hook（openviking 召回与记忆写入），保留工具级 hook
    env: { ...process.env, PI_CODE_SUBAGENT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let lastAssistant: PiMessage | undefined;
  let settled = false;
  const failedTools: string[] = [];
  const stderr: Buffer[] = [];
  let pending = Buffer.alloc(0);

  const handle = (event: PiEvent): void => {
    switch (event.type) {
      case "message_end":
        if (event.message?.role === "assistant") lastAssistant = event.message;
        break;
      case "tool_execution_start":
        opts.onProgress(`[tool] ${event.toolName} ${preview(event.args)}`);
        break;
      case "tool_execution_end":
        if (event.isError) {
          const summary = `${event.toolName}: ${preview(textOf(event.result?.content))}`;
          failedTools.push(summary);
          opts.onProgress(`[tool-error] ${summary}`);
        }
        break;
      case "auto_retry_start":
        opts.onProgress(`[retry] ${event.attempt}/${event.maxAttempts} ${event.errorMessage}`);
        break;
      case "agent_settled":
        settled = true;
        setTimeout(() => child.kill("SIGTERM"), SETTLE_GRACE_MS).unref();
        break;
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    let newline: number;
    while ((newline = pending.indexOf(0x0a)) !== -1) {
      const line = pending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      pending = pending.subarray(newline + 1);
      try {
        handle(JSON.parse(line) as PiEvent);
      } catch {
        // 非 JSON 行不属于协议记录
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const forward = (signal: NodeJS.Signals): void => {
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
      resolve({ ok: false, reply: "", error: `无法启动 pi：${err.message}`, failedTools });
    });
    child.on("close", (code, signal) => {
      cleanup();
      const reply = textOf(lastAssistant?.content).trim();
      const stopReason = lastAssistant?.stopReason;
      if (settled && lastAssistant && stopReason !== "error" && stopReason !== "aborted") {
        resolve({ ok: true, reply, failedTools });
        return;
      }
      const error =
        lastAssistant?.errorMessage ??
        (Buffer.concat(stderr).toString("utf8").trim() || `pi 异常退出（${signal ?? `退出码 ${code}`}）`);
      resolve({ ok: false, reply, error, failedTools });
    });
  });
}
