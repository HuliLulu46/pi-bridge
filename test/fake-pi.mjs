#!/usr/bin/env node
// 模拟 pi：`-p --mode json` 按消息内容决定行为，`--mode rpc` 交给 fake-pi-rpc.mjs
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_PI_CALLS, JSON.stringify({ argv, cwd: process.cwd(), subagent: process.env.PI_CODE_SUBAGENT }) + "\n");

if (argv[argv.indexOf("--mode") + 1] === "rpc") {
  await import("./fake-pi-rpc.mjs");
} else {
  const message = argv.at(-1);
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  const assistant = (extra) => emit({ type: "message_end", message: { role: "assistant", ...extra } });

  if (message === "fail") {
    process.stderr.write("Error: boom\n");
    process.exit(1);
  }
  if (message === "slow") await new Promise((r) => setTimeout(r, 1500));

  emit({ type: "session", id: argv[argv.indexOf("--session-id") + 1] });
  emit({ type: "agent_start" });

  if (message === "blocked") {
    emit({ type: "tool_execution_start", toolName: "bash", args: { command: "rm -rf build" } });
    emit({
      type: "tool_execution_end",
      toolName: "bash",
      isError: true,
      result: { content: [{ type: "text", text: "Blocked: matched permissions.ask but no UI is available" }] },
    });
  }

  if (message === "error") {
    assistant({ content: [], stopReason: "error", errorMessage: "rate limited" });
  } else {
    assistant({ content: [{ type: "thinking", thinking: "..." }, { type: "text", text: `echo:${message}` }], stopReason: "stop" });
  }
  emit({ type: "agent_end", messages: [] });
  emit({ type: "agent_settled" });

  if (message === "hang") setInterval(() => {}, 1000);
}
