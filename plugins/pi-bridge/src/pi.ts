import { spawn } from "node:child_process";
import { createLineSplitter, createRunTracker, parseEvent, type Activity, type RunResult } from "./events.ts";

export interface RunOptions {
  /** 缺省时以 --no-session 运行，不留下会话记录 */
  sessionId?: string;
  cwd: string;
  message: string;
  piArgs: string[];
  onProgress: (line: string) => void;
  /** 必填：mod 有动作记录就只读它，漏写会让详情页丢掉工具行 */
  onActivity: (activity: Activity) => void;
}

/** 代理的 keep-alive 连接会让 pi 在 agent_settled 之后仍不退出 */
const SETTLE_GRACE_MS = 2000;

/** pi-code 按子代理处理：跳过 SessionStart/UserPromptSubmit/Stop 等会话级 hook（记忆召回与写入），保留工具级 hook */
export const PI_ENV = { ...process.env, PI_CODE_SUBAGENT: "1" };

export type Role = "advisor" | "executor";

/** 顾问只读：不加载扩展（pi-code 注入的 Claude skill 也随之关闭），只给只读的内置工具 */
export const ADVISOR_ARGS = ["--no-extensions", "--tools", "read,grep,find,ls"];

export function modelArgs(model: string | undefined, thinking: string | undefined): string[] {
  return [...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : [])];
}

export function piBin(): string {
  return process.env.PI_BIN ?? "pi";
}

export function runPi(opts: RunOptions): Promise<RunResult> {
  const session = opts.sessionId ? ["--session-id", opts.sessionId] : ["--no-session"];
  const args = ["-p", "--mode", "json", ...session, ...opts.piArgs, "--", opts.message];
  const child = spawn(piBin(), args, { cwd: opts.cwd, env: PI_ENV, stdio: ["ignore", "pipe", "pipe"] });

  const tracker = createRunTracker(opts.onProgress, opts.onActivity);
  const split = createLineSplitter();
  const stderr: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    for (const line of split(chunk)) {
      const event = parseEvent(line);
      if (!event) continue;
      tracker.handle(event);
      if (event.type === "agent_settled") setTimeout(() => child.kill("SIGTERM"), SETTLE_GRACE_MS).unref();
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
      resolve({ ok: false, reply: "", error: `无法启动 pi：${err.message}`, failedTools: [] });
    });
    child.on("close", (code, signal) => {
      cleanup();
      resolve(
        tracker.result(
          () => Buffer.concat(stderr).toString("utf8").trim() || `pi 异常退出（${signal ?? `退出码 ${code}`}）`,
        ),
      );
    });
  });
}
