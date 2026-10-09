import type { RunResult } from "./events.ts";
import { ADVISOR_ARGS, modelArgs, runPi } from "./pi.ts";
import { nameToUuid, runQoder } from "./qoder.ts";

export type Engine = "pi" | "qoder";

/**
 * 解析建会话时用的引擎：--engine 优先，其次 PI_BRIDGE_ENGINE，最后缺省 pi。
 * 会话一旦建立就把引擎绑定进记录，续接时以记录为准（见 store.ensureRecord）。
 */
export function resolveEngine(flag?: string): Engine {
  const value = flag ?? process.env.PI_BRIDGE_ENGINE;
  if (value === undefined || value === "" || value === "pi") return "pi";
  if (value === "qoder") return "qoder";
  throw new Error(`引擎只能是 pi 或 qoder：${value}`);
}

export interface AdvisorRunOptions {
  /** 由谁承接这一轮 */
  engine: Engine;
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

/** 以只读顾问身份跑一轮；具体由谁承接取决于 opts.engine */
export function runAdvisor(opts: AdvisorRunOptions): Promise<RunResult> {
  if (opts.engine === "qoder") {
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
