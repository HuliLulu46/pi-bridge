// 模拟 `pi --mode rpc`：从 stdin 读命令，按 prompt 内容决定行为，stdin 关闭即退出
import { appendFileSync } from "node:fs";
import { applyFileAction } from "./fake-actions.mjs";

if (process.env.FAKE_PI_RPC_FAIL) {
  process.stderr.write("Error: boom\n");
  process.exit(1);
}

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const respond = (cmd, extra = {}) => emit({ type: "response", id: cmd.id, command: cmd.type, success: true, ...extra });

let running = false;
let aborted = false;
let steers = [];
let wakeSlow;
let answerDialog;

function end() {
  emit({ type: "agent_end", messages: [] });
  running = false;
  emit({ type: "agent_settled" });
}

function settle(message) {
  emit({ type: "message_end", message: { role: "assistant", ...message } });
  end();
}

const finish = (text) => settle({ content: [{ type: "text", text }], stopReason: "stop" });

function dialog(request) {
  emit({ type: "extension_ui_request", ...request });
  return new Promise((resolve) => (answerDialog = resolve));
}

async function run(message) {
  running = true;
  aborted = false;
  steers = [];
  emit({ type: "agent_start" });
  emit({ type: "extension_ui_request", id: "noise", method: "setStatus", statusKey: "demo", statusText: "busy" });

  if (message === "activity") {
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "先看看 cli.ts" }], stopReason: "toolUse" } });
    emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "grep", args: { path: "/a/cli.ts", pattern: "x".repeat(400) } });
    emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "grep", isError: false, result: { content: [{ type: "text", text: "1 match" }] } });
    return finish("echo:activity");
  }
  if (message === "ask") {
    emit({ type: "tool_execution_start", toolName: "question", args: { question: "选 A 还是 B？" } });
    const res = await dialog({ id: "ask-1", method: "select", title: "选 A 还是 B？", options: ["1. A", "2. B"] });
    return finish(res.cancelled ? "chose:cancelled" : `chose:${res.value}`);
  }
  if (message === "confirm" || message.startsWith("confirm:")) {
    const text = message === "confirm" ? "rm -rf build" : message.slice("confirm:".length);
    const res = await dialog({ id: "confirm-1", method: "confirm", title: "Auto mode permission ask", message: text });
    if (res.confirmed) return finish("confirmed");
    emit({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "Declined permissions.ask" }] } });
    return finish("declined");
  }
  if (message === "slow") {
    await new Promise((resolve) => {
      wakeSlow = resolve;
      setTimeout(resolve, 1500);
    });
    if (aborted) return settle({ content: [], stopReason: "aborted", errorMessage: "Request was aborted" });
    return finish(`echo:slow steer:${steers.join(",")}`);
  }
  if (message.startsWith("crash:")) {
    applyFileAction(`write:${message.slice("crash:".length)}`);
    process.exit(1);
  }
  applyFileAction(message);
  finish(`echo:${message}`);
}

if (process.env.FAKE_PI_RPC_STARTUP_DIALOG) {
  emit({ type: "extension_ui_request", id: "startup-1", method: "select", title: "启动时的提问", options: ["a", "b"] });
}

let pending = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  let newline;
  while ((newline = pending.indexOf(0x0a)) !== -1) {
    const cmd = JSON.parse(pending.subarray(0, newline).toString("utf8"));
    pending = pending.subarray(newline + 1);
    switch (cmd.type) {
      case "prompt":
        if (running) {
          emit({ type: "response", id: cmd.id, command: "prompt", success: false, error: "Agent is already processing" });
          break;
        }
        respond(cmd);
        run(cmd.message);
        break;
      case "steer":
        steers.push(cmd.message);
        respond(cmd);
        break;
      case "abort":
        aborted = true;
        wakeSlow?.();
        setImmediate(() => respond(cmd));
        break;
      case "get_state":
        respond(cmd, { data: {} });
        break;
      case "extension_ui_response":
        appendFileSync(`${process.env.FAKE_PI_CALLS}.ui.jsonl`, JSON.stringify(cmd) + "\n");
        answerDialog?.(cmd);
        break;
    }
  }
});
process.stdin.on("end", () => {
  if (process.env.FAKE_PI_RPC_DIALOG_ON_EOF) {
    emit({ type: "extension_ui_request", id: "eof-1", method: "select", title: "退出前的提问", options: ["a"] });
  }
  setTimeout(() => process.exit(0), Number(process.env.FAKE_PI_RPC_EXIT_DELAY_MS ?? 0));
});
