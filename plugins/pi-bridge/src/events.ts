interface ContentBlock {
  type: string;
  text?: string;
}

interface PiMessage {
  role: string;
  content?: ContentBlock[] | string;
  stopReason?: string;
  errorMessage?: string;
  /** 本条回复实际用的模型与思考等级，pi 在 assistant 消息里带上 */
  provider?: string;
  model?: string;
  thinkingLevel?: string;
}

/** pi 在 stdout 上输出的记录：会话事件、RPC 命令响应、扩展 UI 请求 */
export interface PiEvent {
  type: string;
  id?: string;
  message?: PiMessage;
  /** 工具开始与结束靠它配对：pi 可以并行执行工具 */
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: { content?: ContentBlock[] };
  isError?: boolean;
  attempt?: number;
  maxAttempts?: number;
  errorMessage?: string;
  success?: boolean;
  error?: string;
  method?: string;
  title?: string;
  options?: string[];
}

export interface RunResult {
  ok: boolean;
  reply: string;
  error?: string;
  /** 出错或被扩展拦截的工具调用，每项为「工具名: 结果摘要」 */
  failedTools: string[];
}

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

export function toolNotice(failedTools: string[]): string {
  if (failedTools.length === 0) return "";
  return `\n\n[pi-bridge] ${failedTools.length} 次工具调用出错或被拦截：\n${failedTools.map((item) => `- ${item}`).join("\n")}`;
}

/** 按 LF 切分字节流；不用 readline，它会把 JSON 字符串里的 U+2028/U+2029 当成换行 */
export function createLineSplitter(): (chunk: Buffer) => string[] {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const lines: string[] = [];
    let newline: number;
    while ((newline = pending.indexOf(0x0a)) !== -1) {
      lines.push(pending.subarray(0, newline).toString("utf8").replace(/\r$/, ""));
      pending = pending.subarray(newline + 1);
    }
    return lines;
  };
}

export function parseEvent(line: string): PiEvent | undefined {
  try {
    return JSON.parse(line) as PiEvent;
  } catch {
    return undefined;
  }
}

/** 只进本次运行动作记录的条目：带调用 id 和完整入参的工具开始、工具结束、pi 在工具调用之间写的话 */
export interface Activity {
  type: "tool" | "tool-end" | "note";
  text: string;
  id?: string;
  error?: boolean;
}

/**
 * 跟踪一次运行：把工具调用与重试转成进度行，把动作明细交给 onActivity；
 * 回复为本次运行中每条正常结束的 assistant 文本（含 steer 引出的回复）
 */
export function createRunTracker(onProgress: (line: string) => void, onActivity: (activity: Activity) => void) {
  let lastAssistant: PiMessage | undefined;
  let settled = false;
  const replies: string[] = [];
  const failedTools: string[] = [];
  let modelReported = false;

  return {
    handle(event: PiEvent): void {
      switch (event.type) {
        case "message_end": {
          if (event.message?.role !== "assistant") break;
          lastAssistant = event.message;
          // 每次运行上报一次实际的模型与思考等级，界面据此显示
          if (!modelReported && lastAssistant.model) {
            modelReported = true;
            const name = lastAssistant.provider ? `${lastAssistant.provider}/${lastAssistant.model}` : lastAssistant.model;
            onProgress(`[model] ${name}${lastAssistant.thinkingLevel ? ` ${lastAssistant.thinkingLevel}` : ""}`);
          }
          const text = textOf(lastAssistant.content).trim();
          if (lastAssistant.stopReason === "stop" && text) replies.push(text);
          // 正常结束的是回复，运行记录里已有；其余（调工具前的说明、出错或中止前写了一半的）进动作记录
          else if (text) onActivity({ type: "note", text });
          break;
        }
        case "tool_execution_start":
          onProgress(`[tool] ${event.toolName} ${preview(event.args)}`);
          onActivity({ type: "tool", id: event.toolCallId, text: `${event.toolName} ${JSON.stringify(event.args ?? {})}` });
          break;
        case "tool_execution_end":
          onActivity({ type: "tool-end", id: event.toolCallId, text: event.toolName ?? "", ...(event.isError ? { error: true } : {}) });
          if (event.isError) {
            const summary = `${event.toolName}: ${preview(textOf(event.result?.content))}`;
            failedTools.push(summary);
            onProgress(`[tool-error] ${summary}`);
          }
          break;
        case "auto_retry_start":
          onProgress(`[retry] ${event.attempt}/${event.maxAttempts} ${event.errorMessage}`);
          break;
        case "agent_settled":
          settled = true;
          break;
      }
    },
    result(fallbackError: () => string): RunResult {
      const reply = replies.length > 0 ? replies.join("\n\n") : textOf(lastAssistant?.content).trim();
      const stopReason = lastAssistant?.stopReason;
      if (settled && lastAssistant && stopReason !== "error" && stopReason !== "aborted") {
        return { ok: true, reply, failedTools };
      }
      return { ok: false, reply, error: lastAssistant?.errorMessage ?? fallbackError(), failedTools };
    },
  };
}
