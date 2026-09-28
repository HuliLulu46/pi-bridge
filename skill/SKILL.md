---
name: pi-bridge
description: 通过 pi-bridge 命令把任务交给 pi coding agent 执行，并按会话名管理 pi 会话（多轮续接、Monitor 跟随进度、列出与删除）。当用户要求“让 pi 做 / 交给 pi / 问问 pi / 用 pi agent”，或需要把任务委托给 pi 时使用。
---

# pi-bridge

`pi-bridge` 以非交互方式调用 `pi -p --mode json`，按会话名记住 pi 的 session-id 和工作目录，stdout 只输出 pi 的最终回复。

## 命令

| 命令 | 作用 |
|---|---|
| `pi-bridge send <会话名> [--cwd <目录>] [--model <模型>] <消息\|-> [-- <pi 参数>...]` | 发送一条消息并等待回复；会话不存在时创建 |
| `pi-bridge watch <会话名>` | 跟随该会话当前任务的进度，任务结束后退出 |
| `pi-bridge list` | 列出会话：名字、状态（running/idle）、更新时间、目录、session-id |
| `pi-bridge rm <会话名>` | 删除会话映射；pi 自己的会话文件保留 |

## 选择调用方式

1. **直接调用**（预计几分钟内完成）：Bash 执行 `send`，`timeout` 设为 600000。
2. **长任务或需要看进度**：Bash 以 `run_in_background` 执行 `send`，结束时会收到通知，回复在该后台任务的输出里。需要实时进度时，**先启动 send，再**用 Monitor 执行 `pi-bridge watch <会话名>`，`timeout_ms` 设为 1800000；Monitor 到期而任务未结束时重新启动 watch。watch 每次工具调用输出一行，预计工具调用很多的任务不要开 watch（事件过多时 Monitor 会被自动停止），只等后台任务的结束通知。
3. **在 subagent 里调用**：与直接调用相同，让 subagent 只回传 pi 的结论。

watch 输出的行格式：`[start]` 本次消息摘要、`[tool]` 工具调用、`[tool-error]` 工具出错或被拦截、`[retry]` 模型重试；成功以 `[reply]`、回复正文、`[done]` 结束，失败以 `[error]`、原因、`[failed]` 结束。

## 会话规则

- 同一件事的多轮对话复用同一个会话名，pi 记得之前的内容，后续消息不必重复背景。不同任务用不同会话名。
- 会话名只能包含字母、数字和 `. _ -`。
- 工作目录在首次 `send` 时绑定（默认为当前目录），之后固定在该目录运行，传入不同的 `--cwd` 会报错。要换目录就换一个会话名。
- 同一会话同一时间只能运行一个 `send`，第二个会因会话锁报错；需要并行时用不同会话名。

## 写消息

- pi 看不到 Claude 的对话上下文。消息要自包含：目标、相关文件路径、完成标准，以及希望 pi 在回复里汇报什么（改了哪些文件、命令执行结果等），因为 Claude 只能拿到最终回复。
- 长消息用 `-` 从 stdin 传入：

  ```bash
  pi-bridge send refactor-auth - <<'EOF'
  把 src/auth 下的 session 校验改为……
  完成后列出改动的文件和测试结果。
  EOF
  ```

- 需要透传给 pi 的参数写在 `--` 之后，如 `-- --thinking high`、`-- --tools read,bash`。

## 读结果

- 退出码为 0：stdout 是 pi 的最终回复。
- 回复末尾出现 `[pi-bridge] N 次工具调用出错或被拦截` 时，说明有操作没做成。pi 在非交互模式下没有确认界面，需要用户确认的操作（例如 pi-automode 的 `permissions.ask` 规则）会被直接拒绝。根据列出的原因决定：由 Claude 自己完成、调整任务后重发，或告知用户。
- 退出码非 0：stderr 以 `pi-bridge:` 开头给出原因；如果 pi 已产生部分回复，会输出在 stdout。
