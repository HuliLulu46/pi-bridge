#!/usr/bin/env node
// 模拟 qoderclicn 的无头 advisor：`-p --output-format stream-json`，按消息内容决定行为。
// 事件结构对齐真实 qoderclicn（system/assistant/user/result）。
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_QODER_CALLS, JSON.stringify({ argv, cwd: process.cwd() }) + "\n");

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const message = argv.at(-1);
const at = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const sessionId = at("--session-id") ?? at("--resume") ?? "";

if (message === "fail") {
  process.stderr.write("Error: boom\n");
  process.exit(1);
}

// 模拟 rm 后底层会话文件仍在：--session-id 建会话撞已存在的 UUID（稍作停留，给取消测试留窗口）
if (message === "inuse" && argv.includes("--session-id")) {
  process.stderr.write(`Error: Session ID ${sessionId} is already in use.\n`);
  setTimeout(() => process.exit(1), 800);
} else if (message.startsWith("portuse:")) {
  // 模拟无关的占用错误（如端口）：stderr 同时含本次 UUID 与 already in use，但不是会话冲突句式，不应触发回退
  process.stderr.write(`session_id=${message.slice("portuse:".length)}\nError: bind: address already in use\n`);
  process.exit(1);
} else if (message === "nostart") {
  // 模拟初始化前失败：有 stdout 诊断输出，但没有 init 事件（会话未创建）
  process.stdout.write("diagnostic: warming up\n");
  process.stderr.write("Error: init failed before session creation\n");
  process.exit(1);
} else {
  emit({ type: "system", subtype: "init", session_id: sessionId, tools: ["Read", "Grep", "Glob"], permissionMode: "default" });

  if (message === "blocked") {
    emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf build" } }] },
    });
    emit({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Blocked: needs permission" }] },
    });
  }

  if (message === "error") {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "", session_id: sessionId, num_turns: 1 });
  } else {
    emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "text", text: `echo:${message}` }], stop_reason: "end_turn" },
    });
    emit({ type: "result", subtype: "success", is_error: false, result: `echo:${message}`, session_id: sessionId, num_turns: 1 });
  }
}
