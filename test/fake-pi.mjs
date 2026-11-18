#!/usr/bin/env node
// 模拟 pi：`-p --mode json` 按消息内容决定行为，`--mode rpc` 交给 fake-pi-rpc.mjs
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_PI_CALLS, JSON.stringify({ argv, cwd: process.cwd(), subagent: process.env.PI_CODE_SUBAGENT }) + "\n");

if (process.env.FAKE_PI_EXPECT_HISTORY) {
  const id = argv[argv.indexOf("--session-id") + 1];
  const dir = process.env.PI_CODING_AGENT_SESSION_DIR;
  const histories = readdirSync(dir).filter((name) => name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .filter((text) => JSON.parse(text.split("\n")[0]).id === id);
  if (histories.length !== 1) throw new Error(`启动时应有唯一的历史文件：${id}`);
  writeFileSync(`${process.env.FAKE_PI_CALLS}.history.jsonl`, histories[0]);
}

if (argv[argv.indexOf("--mode") + 1] === "rpc") {
  await import("./fake-pi-rpc.mjs");
} else {
  const message = argv.at(-1);
  // 评审的补丁文件在评审结束后会被删除，这里记下运行时看到的内容与权限
  const patchFile = /完整内容在文件 (\S+\.patch)/.exec(message)?.[1];
  if (patchFile) {
    const patch = { mode: statSync(patchFile).mode & 0o777, content: readFileSync(patchFile, "utf8") };
    writeFileSync(`${process.env.FAKE_PI_CALLS}.patch.json`, JSON.stringify(patch));
  }
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  // FAKE_PI_MODEL 打开时，assistant 消息像真 pi 一样带上实际的模型与思考等级
const modelInfo = process.env.FAKE_PI_MODEL ? { provider: "fake", model: process.env.FAKE_PI_MODEL, thinkingLevel: "low" } : {};
  const assistant = (extra) => emit({ type: "message_end", message: { role: "assistant", ...modelInfo, ...extra } });

  if (message === "fail") {
    process.stderr.write("Error: boom\n");
    process.exit(1);
  }
  if (message === "slow") await new Promise((r) => setTimeout(r, 1500));
  const { applyFileAction } = await import("./fake-actions.mjs");
  applyFileAction(message);

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
