---
name: pi-bridge
description: 通过 pi-bridge 命令把任务交给 pi coding agent 执行，并按会话名管理 pi 会话（多轮续接、worktree 隔离、Monitor 跟随进度、任务中途插话或中止、回答 pi 的提问），或让 pi 以只读方式评审当前改动。当用户要求“让 pi 做 / 交给 pi / 问问 pi / 让 pi 评审 / 用 pi agent”，需要把任务委托给 pi，或跨多个文件的改动在提交前需要第二意见时使用。
---

# pi-bridge

`pi-bridge` 按会话名记住 pi 的 session-id 和工作目录，stdout 只输出 pi 的最终回复。有两种运行方式：

- **print 模式**（默认）：每次 `send` 启动一次 `pi -p`，跑完即退出。pi 无法中途提问，需要确认的操作会被直接拒绝。
- **常驻进程**：`start` 后 pi 以 RPC 模式常驻。可以在任务中途插话（steer）、追加任务（follow-up）、中止（abort），pi 也能用 question 工具向 Claude 提问。常驻进程运行期间，`send` 自动转给它。

## 命令

| 命令 | 作用 |
|---|---|
| `pi-bridge send <会话名> [--cwd <目录>] [--model <模型>] [--worktree] <消息\|-> [-- <pi 参数>...]` | 发送一条消息并等待回复；会话不存在时创建 |
| `pi-bridge watch <会话名>` | 跟随该会话当前任务的进度，任务结束后退出 |
| `pi-bridge list` | 列出会话：名字、状态（idle / running / daemon）、更新时间、目录、session-id；worktree 会话另附 `分支@base` |
| `pi-bridge rm <会话名> [--force]` | 删除会话映射与 worktree（分支保留）；pi 自己的会话文件保留 |
| `pi-bridge review [--staged \| --base <分支>] [--cwd <目录>] [--focus <关注点>] [--model <模型>] [--thinking <等级>]` | pi 以只读方式评审当前改动，见“让 pi 评审” |
| `pi-bridge start <会话名> [--cwd <目录>] [--model <模型>] [--allow-confirm] [--worktree] [-- <pi 参数>...]` | 启动常驻进程 |
| `pi-bridge steer <会话名> <消息\|->` | 任务中途插话：当前这轮工具执行完后送达，pi 据此调整 |
| `pi-bridge follow-up <会话名> <消息\|->` | 追加任务：当前任务全部结束后接着执行，结果并入同一次回复 |
| `pi-bridge answer <会话名> <提问 id> <回答\|->` / `--cancel` | 回答 pi 的提问，然后继续等待 |
| `pi-bridge abort <会话名>` | 中止当前任务 |
| `pi-bridge stop <会话名>` | 停止常驻进程 |

## 选择运行方式

- 一次性、目标明确的任务：直接 `send`，用 print 模式。
- 可能需要中途纠偏、pi 可能需要问清需求、或要分几步追加指示的任务：先 `start`，再 `send`。用完 `stop`；常驻进程空闲 30 分钟后也会自动退出。

## 工作目录：同一目录还是 worktree

- **同一目录**（默认）：pi 直接改当前工作目录。适合小改动，且 Claude 在 pi 运行期间不改同一仓库。
- **worktree**：创建会话时加 `--worktree`，pi 在 `<仓库>/.pi-bridge/worktrees/<会话名>` 中工作，分支为 `pi/<会话名>`，起点为当时的 HEAD。适合与 Claude 并行改代码、多个 pi 任务并行、或改动较大需要整体验收的任务。只能在创建会话时指定；要求当前目录在 git 仓库内且已有提交。

验收并合并 worktree 中的改动：

1. 查看累计改动：`git -C <worktree> diff <base>` 与 `git -C <worktree> status`（`base` 见 `pi-bridge list` 的 `分支@base`）；
2. 需要第二意见时，在 worktree 中执行 `pi-bridge review --cwd <worktree> --base <原分支>`；
3. 确认后在 worktree 中提交，回到原仓库合并分支 `pi/<会话名>`；
4. `pi-bridge rm <会话名>` 删除会话与 worktree；分支保留，合并后自行删除。

## 改动清单

每次运行结束，回复末尾会附上 `[pi-bridge] 本次运行改动了 N 个文件：`，每行是 `git status --porcelain` 的状态码与路径；`(已提交)` 表示运行期间提交的文件，`删除未跟踪文件` 表示运行前就存在的未跟踪文件被删除，`恢复` 表示文件恢复为与 HEAD 一致。

- 清单表示“运行期间变化的文件”，不表示“pi 改动的文件”：同一目录模式下，运行期间 Claude 对同一仓库的改动也会列入。需要严格区分时用 `--worktree`。
- 只改文件权限位的变化不会被识别。
- 文件名含控制字符等特殊字符时，以带双引号的转义形式显示，每个文件只占一行。
- 验收时以清单为线索，自己查看 diff，不要只依据 pi 的描述。
- 不在 git 仓库内时不附清单；出现 `改动统计失败` 时，自己用 git 检查改动。

## 让 pi 评审

`pi-bridge review` 让 pi 以只读方式评审改动：pi 只有 read、grep、find、ls 工具，不加载扩展，不写会话记录。

| 参数 | 评审范围 |
|---|---|
| 无 | 工作区相对 HEAD 的全部改动，含未跟踪文件 |
| `--staged` | 已暂存的改动 |
| `--base <分支>` | 相对该分支分叉点的全部改动，含未提交部分与未跟踪文件 |

- **用户发起**：`/pi-review` 斜杠命令。
- **Claude 主动发起**：跨多个文件的逻辑改动之后、提交之前执行 `pi-bridge review`；小改动不评审。用 `--focus` 指出希望重点检查的方面。
- 处理结果：逐条对照代码核实 pi 的结论，标注认同、不认同或待确认并说明理由，呈现给用户；不要未经用户同意就按评审意见修改代码。
- Bash `timeout` 设为 600000。

## 选择调用方式

1. **直接调用**（预计几分钟内完成）：Bash 执行 `send`，`timeout` 设为 600000。
2. **长任务或需要看进度**：Bash 以 `run_in_background` 执行 `send`，结束或 pi 提问时会收到通知，输出在该后台任务的输出文件里。需要实时进度时，**先启动 send，再**用 Monitor 执行 `pi-bridge watch <会话名>`，`timeout_ms` 设为 1800000；Monitor 到期而任务未结束时重新启动 watch。watch 每次工具调用输出一行，预计工具调用很多的任务不要开 watch（事件过多时 Monitor 会被自动停止），只等后台任务的通知。
3. **在 subagent 里调用**：与直接调用相同，让 subagent 只回传 pi 的结论。

watch 输出的行格式：`[start]` 本次消息摘要、`[tool]` 工具调用、`[tool-error]` 工具出错或被拦截、`[retry]` 模型重试、`[steer]` / `[follow-up]` 插话与追加、`[ask]` pi 的提问、`[answered]` 已回答、`[ask-timeout]` 提问超时、`[confirm-denied]` 权限确认被自动拒绝；成功以 `[reply]`、回复正文、`[done]` 结束，失败以 `[error]`、原因、`[failed]` 结束。

## 回答 pi 的提问（常驻进程）

- `send` 或 `answer` 以**退出码 2** 结束时，stdout 是 pi 的提问：第一行是 `[ask] <id> <类型>: <问题>`，接着是选项和回答用的命令。
- 回答后 `answer` 会继续等待，直到下一个提问（再次退出码 2）或任务结束（退出码 0 / 1）。
  - `select`：回答序号或选项原文。选“Type something.”之后，pi 会再发一个 `input` 提问，用来填写内容。
  - `confirm`：见“权限确认”。
  - `input` / `editor`：回答文本，长文本用 `-` 从 stdin 传入。
- 能根据用户的意图回答的问题，由 Claude 直接回答；涉及用户偏好、且无法从对话推断的，先问用户再回答。
- 提问 10 分钟没人回答会自动取消，pi 按“取消”的情况继续执行。

## 权限确认（常驻进程）

- pi-automode 等扩展要求人工确认的操作，默认由常驻进程自动拒绝，并在回复末尾报告，与 print 模式一致。
- 只有用户明确同意由 Claude 代为确认时，才用 `start --allow-confirm` 启动。此时确认请求以 `confirm` 提问的形式交给 Claude。
- **硬规则：以下情况 Claude 不得自行同意，必须把确认内容转述给用户，按用户的答复回答：**
  - 删除或覆盖文件、目录、数据（`rm`、`git reset --hard`、`git clean`、覆盖写入已有文件等）；
  - 推送或对外发送（`git push`、发布包、调用会修改外部状态的接口、发消息或邮件）；
  - 访问或修改工作目录以外的路径、读取密钥或凭据；
  - 安装软件、修改系统或全局配置；
  - 其他不可逆的操作，或超出用户已授权范围的操作；
  - Claude 拿不准是否属于以上情况时。

  auto 模式的分类器和下面的把关 hook 都不能代替这条规则：实测中，同意 `rm -rf ~` 的 answer 命令被分类器放行了。
- 拒绝：`pi-bridge answer <会话名> <id> no`。
- 同意：必须用 `--action` 把确认内容原文放进命令，照抄提问里给出的命令模板，不要改写或摘要：

  ```bash
  pi-bridge answer <会话名> <id> yes --action - <<'EOF'
  （确认内容原文）
  EOF
  ```

  这样 Claude Code auto 模式的分类器和把关 hook 审查这条命令时，能看到被批准的实际操作。常驻进程会核对 `--action` 与待确认内容是否一致（忽略空白差异），不一致则拒绝。
- 把关 hook（本插件的 PreToolUse hook，脚本为 `${CLAUDE_PLUGIN_ROOT}/src/confirm-guard.ts`）审查每条同意命令：被批准的操作命中高风险规则，或经 Sonnet 复核认为危险、复核失败，就在 Claude Code 里弹窗请用户确认。用户拒绝后，回答 `no`。
- 分类器拦下这条命令时，同样回答 `no`，或把确认内容转述给用户，由用户决定。

## 会话规则

- 同一件事的多轮对话复用同一个会话名，pi 记得之前的内容，后续消息不必重复背景。不同任务用不同会话名。
- 会话名只能包含字母、数字和 `. _ -`。
- 工作目录在首次 `send` 或 `start` 时绑定（默认为当前目录），之后固定在该目录运行，传入不同的 `--cwd` 会报错。要换目录就换一个会话名。
- 同一会话同一时间只能运行一个任务。print 模式下第二个 `send` 会因会话锁报错；常驻进程下第二个 `send` 会报错并提示改用 `steer` 或 `follow-up`。需要并行时用不同会话名。
- 常驻进程运行时，`--model` 和透传的 pi 参数只能在 `start` 时指定。

## 写消息

- pi 看不到 Claude 的对话上下文。消息要自包含：目标、相关文件路径、完成标准，以及希望 pi 在回复里汇报什么（改了哪些文件、命令执行结果等），因为 Claude 只能拿到最终回复。
- 需要 pi 修改文件或提交时，消息里写明授权范围：“授权修改 <目录绝对路径> 中的 <文件>，可以/不可以提交”。pi-automode 会拦截授权里没有点名目录的修改；worktree 会话写 worktree 的路径。
- 长消息用 `-` 从 stdin 传入：

  ```bash
  pi-bridge send refactor-auth - <<'EOF'
  把 src/auth 下的 session 校验改为……
  完成后列出改动的文件和测试结果。
  EOF
  ```

- 需要透传给 pi 的参数写在 `--` 之后，如 `-- --thinking high`、`-- --tools read,bash`。

## 读结果

- 退出码 0：stdout 是 pi 的最终回复。
- 退出码 2：pi 在提问，见“回答 pi 的提问”。
- 回复末尾出现 `[pi-bridge] N 次工具调用出错或被拦截` 时，说明有操作没做成，其中包括被自动拒绝的权限确认。根据列出的原因决定：由 Claude 自己完成、调整任务后重发，或告知用户。
- 退出码 1：stderr 以 `pi-bridge:` 开头给出原因；如果 pi 已产生部分回复，会输出在 stdout。
