import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { createLineSplitter } from "./events.ts";
import { runPath } from "./store.ts";

/** 日志与 watch 输出中一次运行的结束标记 */
export const DONE = "[done]";
export const FAILED = "[failed]";

export type AskMethod = "select" | "confirm" | "input" | "editor";

/** pi 发来的、需要回答的对话框 */
export interface Ask {
  id: string;
  method: AskMethod;
  title: string;
  message?: string;
  options?: string[];
}

/** 每个连接只发一条请求；常驻进程回完最后一条消息后关闭连接 */
export type ClientRequest =
  | { type: "prompt"; message: string }
  | { type: "steer" | "follow_up"; message: string }
  | { type: "answer"; id: string; value?: string; cancelled?: boolean }
  | { type: "abort" }
  | { type: "stop" }
  | { type: "watch"; waitStartMs: number };

export type DaemonMessage =
  | { type: "ok"; text: string }
  | { type: "error"; error: string }
  | { type: "line"; line: string }
  | { type: "ask"; ask: Ask }
  | { type: "done"; text: string }
  | { type: "failed"; error: string; text: string };

export function formatAsk(name: string, ask: Ask): string {
  const lines = [`[ask] ${ask.id} ${ask.method}: ${ask.title}`];
  if (ask.message) lines.push(ask.message);
  ask.options?.forEach((option, index) => lines.push(`  ${index + 1}) ${option}`));
  const value = { select: "<序号或选项原文>", confirm: "yes|no", input: "<文本|->", editor: "<文本|->" }[ask.method];
  lines.push(`回答：pi-bridge answer ${name} ${ask.id} ${value}（或 --cancel 取消）`);
  return lines.join("\n");
}

/** 连接常驻进程；没有常驻进程或 socket 已失效时返回 undefined */
export function openDaemon(name: string): Promise<Socket | undefined> {
  const path = runPath(name, "sock");
  if (!existsSync(path)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => resolve(undefined));
  });
}

export async function* request(socket: Socket, req: ClientRequest): AsyncGenerator<DaemonMessage> {
  socket.write(`${JSON.stringify(req)}\n`);
  const split = createLineSplitter();
  for await (const chunk of socket) {
    for (const line of split(chunk as Buffer)) yield JSON.parse(line) as DaemonMessage;
  }
}
