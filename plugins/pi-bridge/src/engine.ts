import type { RunResult } from "./events.ts";
import { ADVISOR_ARGS, modelArgs, runPi } from "./pi.ts";
import { nameToUuid, runQoder } from "./qoder.ts";

export type Engine = "pi" | "qoder";

/**
 * 选择被调用方引擎。缺省 pi；PI_BRIDGE_ENGINE=qoder 时改由 qoderclicn 承接 advisor 与 review
 * （第一版只做只读顾问路径，executor 仍走 pi）。
 */
export function currentEngine(): Engine {
  const value = process.env.PI_BRIDGE_ENGINE;
  if (value === undefined || value === "" || value === "pi") return "pi";
  if (value === "qoder") return "qoder";
  throw new Error(`PI_BRIDGE_ENGINE 只能是 pi 或 qoder：${value}`);
}

export interface AdvisorRunOptions {
  /** pi-bridge 会话名：用作 pi 的 --name，以及 qoder UUID 的派生源 */
  sessionName: string;
  /** pi 的 session-id（会话名，或旧记录里的 UUID） */
  sessionId: string;
  cwd: string;
  message: string;
  isNew: boolean;
  model?: string;
  thinking?: string;
  onProgress: (line: string) => void;
}

/** 以只读顾问身份跑一轮；具体由谁承接取决于 PI_BRIDGE_ENGINE */
export function runAdvisor(opts: AdvisorRunOptions): Promise<RunResult> {
  if (currentEngine() === "qoder") {
    return runQoder({
      sessionId: nameToUuid(opts.sessionName),
      cwd: opts.cwd,
      message: opts.message,
      isNew: opts.isNew,
      model: opts.model,
      thinking: opts.thinking,
      onProgress: opts.onProgress,
    });
  }
  return runPi({
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    message: opts.message,
    piArgs: [...(opts.isNew ? ["--name", opts.sessionName] : []), ...ADVISOR_ARGS, ...modelArgs(opts.model, opts.thinking)],
    onProgress: opts.onProgress,
  });
}
