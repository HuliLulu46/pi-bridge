import { spawn } from "node:child_process";
import { createLineSplitter, createRunTracker, parseEvent, type RunResult } from "./events.ts";

export interface RunOptions {
  /** 缺省时以 --no-session 运行，不留下会话记录 */
  sessionId?: string;
  cwd: string;
  message: string;
  piArgs: string[];
  onProgress: (line: string) => void;
}

/** 代理的 keep-alive 连接会让 pi 在 agent_settled 之后仍不退出 */
const SETTLE_GRACE_MS = 2000;

/** pi-code 按子代理处理：跳过 SessionStart/UserPromptSubmit/Stop 等会话级 hook（openviking 召回与记忆写入），保留工具级 hook */
export const PI_ENV = { ...process.env, PI_CODE_SUBAGENT: "1" };

export function piBin(): string {
  return process.env.PI_BIN ?? "pi";
}

export function runPi(opts: RunOptions): Promise<RunResult> {
  const session = opts.sessionId ? ["--session-id", opts.sessionId] : ["--no-session"];
  const args = ["-p", "--mode", "json", ...session, ...opts.piArgs, "--", opts.message];
  const child = spawn(piBin(), args, { cwd: opts.cwd, env: PI_ENV, stdio: ["ignore", "pipe", "pipe"] });

  const tracker = createRunTracker(opts.onProgress);
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
