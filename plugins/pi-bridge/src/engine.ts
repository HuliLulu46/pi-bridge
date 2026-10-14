import type { RunResult } from "./events.ts";
import { ADVISOR_ARGS, modelArgs, runPi } from "./pi.ts";
import { nameToUuid, runQoder, type PrintRole } from "./qoder.ts";

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
  /** print 模式角色：advisor 只读，editor 可写文件（仅 qoder 支持 editor） */
  role: PrintRole;
  /** pi-bridge 会话名：用作 pi 的 --name，以及 qoder UUID 的派生源 */
  sessionName: string;
  /** pi 的 session-id（会话名，或旧记录里的 UUID） */
  sessionId: string;
  cwd: string;
  message: string;
  isNew: boolean;
  model?: string;
  thinking?: string;
  /** 仅 qoder：底层会话确认已创建时触发（首启失败不会触发），用于把 sessionStarted 写回记录 */
  onStarted?: () => void;
  onProgress: (line: string) => void;
}

/** 以 print 模式跑一轮（advisor 只读 / editor 可写文件）；具体由谁承接取决于 opts.engine */
export function runAdvisor(opts: AdvisorRunOptions): Promise<RunResult> {
  if (opts.engine === "qoder") {
    return runQoder({
      sessionId: nameToUuid(opts.sessionName),
      cwd: opts.cwd,
      message: opts.message,
      isNew: opts.isNew,
      role: opts.role,
      model: opts.model,
      thinking: opts.thinking,
      onStarted: opts.onStarted,
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
