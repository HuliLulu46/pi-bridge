---
name: pi-bridge
description: 通过 pi-bridge 命令把任务交给 pi coding agent：以只读顾问身份做方案评审、方向判断、代码评审，或以执行者身份改代码（常驻进程，支持中途提问、任务中途插话或中止），按会话名多轮续接，可在 worktree 中隔离运行。当用户要求“让 pi 做 / 交给 pi / 问问 pi / 让 pi 评审 / 用 pi agent”，需要把任务委托给 pi，或跨多个文件的改动在提交前需要第二意见时使用。
---

# pi-bridge

`pi-bridge` 按会话名续接 pi 会话，stdout 只输出 pi 的最终回复。每次 `send` 用 `--role` 选择角色：

| | advisor（缺省） | executor |
|---|---|---|
| 用途 | 讨论、方案评审、方向判断、代码评审、领域知识 | 改文件、跑命令 |
| 运行方式 | 跑完即退出 | 常驻进程：该会话没有常驻进程时自动启动，空闲 30 分钟自动退出 |
| 能力 | 只读：pi 只有 read、grep、find、ls；不加载扩展/skill，不能联网 | 完整环境：pi 的扩展、Claude 的 skill 与 MCP |
| 中途提问 | 不能。疑问写在回复里，Claude 在下一次 `send` 中回答 | 能，见“回答 pi 的提问” |
| 权限确认 | 不涉及 | 一律自动拒绝，列在回复末尾 |

同一会话可以先以 advisor 讨论，再以 executor 动手，上下文不断。

## 命令

| 命令 | 作用 |
|---|---|
| `pi-bridge send <会话名> [--role advisor\|executor] [--cwd <目录>] [--model <模型>] [--thinking <等级>] [--worktree] [--history-file <绝对路径>] <消息\|->` | 发送一条消息并等待回复；会话不存在时创建 |
| `pi-bridge review [--staged \| --base <分支>] [--cwd <目录>] [--focus <关注点>] [--model <模型>] [--thinking <等级>]` | 以只读方式评审当前改动，见“让 pi 评审” |
| `pi-bridge watch <会话名>` | 跟随该会话正在进行的运行 |
| `pi-bridge list [--all \| --here] [--active]` | 列出会话：名字、状态（idle / running / daemon）、更新时间、目录、session-id；worktree 会话另附 `分支@base`。默认只列当前项目（git 主仓库根；worktree 会话与主仓库算同一项目），`--all` 列全部项目，`--active` 只列 running/daemon |
| `pi-bridge rm <会话名> [--force]` | 删除会话记录与 worktree（分支保留）；有常驻进程时先停止它，正在执行的任务随之中止；pi 的会话文件保留，同名再 `send` 新建 pi 会话 |
| `pi-bridge steer <会话名> <消息\|->` | executor 任务中途插话：当前这轮工具执行完后送达，pi 据此调整 |
| `pi-bridge answer <会话名> <提问 id> <回答\|->` / `--cancel` | 回答 pi 的提问，然后继续等待 |
| `pi-bridge abort <会话名>` | 中止 executor 当前任务，会话保留 |
| `pi-bridge stop <会话名>` | 停止常驻进程，正在执行的任务随之中止 |

## 机器可读接口（供 mod、脚本；人用文本模式即可）

- `send`、`answer`、`review`、`list` 加 `--json`：输出 JSON，退出码不变（0 成功，1 失败，2 有待回答的提问）；运行之外的错误也是一行 `{"status":"error","error":...}`。
- `send`、`answer`、`review` 加 `--detach`（隐含 `--json`）：立即返回 `{"session","runId","status"}`，任务在后台继续。运行记录写出之后才返回，所以随后的 `result` 一定查得到；会话被占用等失败直接报错，不会假装开始。
- `pi-bridge result <runId>`：一次运行的完整记录（状态、完整回复、待回答的提问），在 `~/.pi-bridge/runs/<runId>.json`，保留 14 天（`PI_BRIDGE_RUN_KEEP_DAYS` 调整）。
- 全局事件日志 `~/.pi-bridge/events.ndjson`：每行一个事件 `{ts, session, runId, type, text?, ask?}`，type 为 start / tool / tool-error / retry / steer / ask / answered / ask-timeout / confirm-denied / done / failed；不含回复正文，正文按 runId 取。超过 4 MB 轮转为 `.1`（`PI_BRIDGE_EVENTS_MAX_BYTES` 调整）：读者记字节偏移，偏移超出文件大小就从头读。`pi-bridge events [--since <偏移>] [--follow]` 读取它。
- `list --json` 的每个会话带 `lastRun`（最近一次运行的 `runId`、`status`、`startedAt`、`endedAt`，失败时附截短的 `error`）：会话的 `status` 只说进程是否在跑，idle 不代表上次成功。
- 运行记录里 `status` 为 running 但会话已不持锁（`list` 显示 idle）说明运行异常中断。
- 主会话归属（`--owner <主会话 id>`，PiAgent mod 用；不带时行为不变）：会话记录里的 `owner` 是它所属的主会话，无主的会话被第一个带 `--owner` 派发的主会话认领。同名会话属于别的主会话时，`send` 自动分出本主会话的副本 `<会话名>.<id 前 6 位>`（复制当时的全部上下文，`forkOf` 记来源），之后同名都进副本，两边不再互相叠加；对方正在运行或会话带 worktree 时拒绝。`steer`、`answer`、`abort`、`stop` 只能作用于本主会话的会话或副本。`list --json` 带 `owner`、`forkOf`。
- 委托方的系统提示（行为对齐原生 subagent：结论先行、如实汇报、不扩大范围、advisor 不反问）在 `src/prompts.ts`。

Claude Code 里可用本仓库之外的 `pi` mod（`PiAgent` 工具）封装这套接口：后台派发、完成时自动唤醒、pi 提问走原生对话框。

## 调用方式

- **等待 pi 的命令一律在后台执行**：`send`、`answer`、`review` 都用 Bash 的 `run_in_background` 执行，不在前台等待，也不放进 subagent。执行后结束当前回合，任务结束或 pi 提问时会收到通知；用 Read 读取该后台任务的输出文件，再按“读结果”处理（通知里的退出码即命令的退出码）。
- 需要实时进度时：**先启动后台命令，再**用 Monitor 执行 `pi-bridge watch <会话名>`（`timeout_ms` 设为 1800000），然后结束当前回合。Monitor 到期而任务未结束时重新启动 watch。watch 每次工具调用输出一行，预计工具调用很多的任务不开 watch（事件过多时 Monitor 会被自动停止），只等后台任务的通知。
- 立即返回的命令（`list`、`rm`、`steer`、`abort`、`stop`）直接执行。

watch 最多等 70 秒让运行开始，可以先于 `send` 启动。等不到时以 `[idle] 会话 <名> 当前没有任务在运行，以下是上一次运行的记录` 开头回放上一次运行并退出，退出码随上一次运行的结果。

watch 输出的行格式：`[start]` 本次消息摘要、`[tool]` 工具调用、`[tool-error]` 工具出错或被拦截、`[retry]` 模型重试、`[steer]` 插话、`[ask]` pi 的提问、`[answered]` 已回答、`[ask-timeout]` 提问超时、`[confirm-denied]` 权限确认被自动拒绝；成功以 `[reply]`、回复正文、`[done]` 结束，失败以 `[error]`、原因、`[failed]` 结束。

## 写消息

- pi 看不到 Claude 的对话上下文。消息要自包含：目标、相关文件的精确路径（避免 pi 扫描整个仓库）、完成标准，以及希望 pi 在回复里汇报什么（改了哪些文件、命令执行结果等），因为 Claude 只能拿到最终回复。
- executor 会加载 Claude 的 skill 和规则，消息开头写明：“这是被委托的子任务，不走 brainstorming、tdd 等流程，直接完成并按要求汇报。”
- 需要 executor 修改文件或提交时，写明授权范围：“授权修改 <目录绝对路径> 中的 <文件>，可以/不可以提交”。pi-automode 会拦截授权里没有点名目录的修改；worktree 会话写 worktree 的路径。
- advisor 不能联网。需要外部资料时，Claude 自己检索后把要点写进消息。
- 长消息用 `-` 从 stdin 传入：

  ```bash
  pi-bridge send refactor-auth --role executor - <<'EOF'
  这是被委托的子任务，不走 brainstorming、tdd 等流程，直接完成并按要求汇报。
  把 src/auth 下的 session 校验改为……授权修改 /path/to/repo/src/auth 中的文件，不可以提交。
  完成后列出改动的文件和测试结果。
  EOF
  ```

- 因额度用尽等原因中断时，在同一会话里发“从断点继续”，不必重复背景。

## 读结果

- 退出码 0：stdout 是 pi 的最终回复。
- 退出码 2：pi 在提问（只有 executor 会），见“回答 pi 的提问”。
- 退出码 1：stderr 以 `pi-bridge:` 开头给出原因；pi 已产生部分回复时输出在 stdout。
- 回复末尾出现 `[pi-bridge] N 次工具调用出错或被拦截` 时，有操作没做成；其中 `权限确认被拒绝：` 是 pi 想做、但需要人工确认的操作。根据原因决定：由 Claude 自己完成、调整任务后重发，或告知用户。

## 回答 pi 的提问（executor）

- 后台的 `send` 或 `answer` 以退出码 2 结束时，输出是 pi 的提问：第一行是 `[ask] <id> <类型>: <问题>`，接着是选项和回答用的命令。
- `answer` 同样在后台执行：回答后它会继续等待，直到下一个提问（再次退出码 2）或任务结束（退出码 0 / 1）。
  - `select`：回答序号或选项原文。选“Type something.”之后，pi 会再发一个 `input` 提问，用来填写内容。
  - `input` / `editor`：回答文本，长文本用 `-` 从 stdin 传入。
- 能根据用户的意图回答的问题，由 Claude 直接回答；涉及用户偏好、且无法从对话推断的，先问用户再回答。
- 提问 10 分钟没人回答会自动取消，pi 按“取消”的情况继续执行；之后用 `watch` 拿到这次运行的结果。

## 会话规则

- 同一件事的多轮对话复用同一个会话名，pi 记得之前的内容，后续消息不必重复背景。不同任务用不同会话名。
- 会话名只能包含字母、数字和 `. _ -`，首尾必须是字母或数字。
- 工作目录在首次 `send` 时绑定（默认为当前目录），之后在哪里调用都在该目录运行；传入不同的 `--cwd` 会报错。要换目录就换一个会话名。
- `send <新会话名> --history-file <绝对路径> <消息|->`：首次运行前导入对话历史，文件为 UTF-8 JSON `{"messages":[{"role":"user","text":"之前的问题"},{"role":"assistant","text":"之前的回答"}]}`。`messages` 必须非空，每条 `role` 只能为 `user` 或 `assistant`，`text` 为字符串；调用方保证第一条为 user、连续同角色消息已合并。本次消息仍由位置参数或 stdin 提供。导入成功后删除该文件，导入失败时保留。支持 advisor、executor、`--detach`、`--worktree`；不指定 `--model` 时使用默认模型。已有 bridge 记录、属于其他 owner 的同名会话均报错“fork 只能用于新的会话名”，不会自动分副本或重复导入。
- 角色每次 `send` 单独指定，不写就是 advisor：
  - executor 会话的后续消息同样要写 `--role executor`。漏写时，常驻进程还在则报错，补上即可；常驻进程已空闲退出则本轮以只读方式运行，pi 会说明无法修改。
  - 从 executor 切到 advisor 前先 `stop`。
- 同一会话同一时间只能运行一个任务：advisor 运行中再 `send` 会因会话锁报错；executor 运行中再 `send` 会报错并提示改用 `steer`。需要并行时用不同会话名。
- `--model` 一经指定就记入会话，之后不写时沿用；指定的模型不可用时该会话的每一轮都会失败，要显式换一个模型。executor 的 `--model` 与 `--thinking` 只在启动常驻进程的那次生效。
- 会话名只在会话存在期间对应同一个 pi 会话：新会话的 pi session-id 是 `<会话名>-<随机后缀>`（旧会话可能是会话名本身或 UUID）。`rm` 后同名 `send` 新建 pi 会话，不会接上旧历史；pi 会话文件仍保留，`rm` 的输出给出 `pi --session <文件路径>`，可在终端打开。评审会话不再追问时用 `rm` 删除。
- 用户想在终端里查看会话时：先用 `list` 确认该会话没有常驻进程和运行中的任务，再在会话目录执行 `pi --session-id <list 显示的 session-id>`。

## 工作目录：同一目录还是 worktree

- **同一目录**（默认）：pi 直接在当前工作目录工作。适合小改动，且 Claude 在 pi 运行期间不改同一仓库。
- **worktree**：创建会话时加 `--worktree`，pi 在 `<仓库>/.pi-bridge/worktrees/<会话名>` 中工作，分支为 `pi/<会话名>`，起点为当时的 HEAD。适合与 Claude 并行改代码、多个 pi 任务并行、或改动较大需要整体验收的任务。只能在创建会话时指定；要求当前目录在 git 仓库内且已有提交。
- worktree 只含 git 跟踪的文件。仓库忽略 `.claude/` 时，worktree 中的 executor 不加载项目级 skill、hook 与 MCP 配置；依赖这些配置的任务不用 `--worktree`，或在消息里写明相关约定。

验收并合并 worktree 中的改动：

1. 查看累计改动：`git -C <worktree> diff <base>` 与 `git -C <worktree> status`（`base` 见 `pi-bridge list` 的 `分支@base`）；
2. 需要第二意见时，执行 `pi-bridge review --cwd <worktree> --base <原分支>`；
3. 确认后在 worktree 中提交，回到原仓库合并分支 `pi/<会话名>`；
4. `pi-bridge rm <会话名>` 删除会话与 worktree；分支保留，合并后自行删除。

## 改动清单（executor）

executor 每次运行结束，回复末尾会附上 `[pi-bridge] 本次运行改动了 N 个文件：`，每行是 `git status --porcelain` 的状态码与路径；`(已提交)` 表示运行期间提交的文件，`删除未跟踪文件` 表示运行前就存在的未跟踪文件被删除，`恢复` 表示文件恢复为与 HEAD 一致。

- 清单表示“运行期间变化的文件”，不表示“pi 改动的文件”：同一目录模式下，运行期间 Claude 对同一仓库的改动也会列入。需要严格区分时用 `--worktree`。
- 只改文件权限位的变化不会被识别。
- 文件名含控制字符等特殊字符时，以带双引号的转义形式显示，每个文件只占一行。
- 验收时以清单为线索，自己查看 diff，不要只依据 pi 的描述。
- 不在 git 仓库内时不附清单；出现 `改动统计失败` 时，自己用 git 检查改动。

## 让 pi 评审

`pi-bridge review` 以 advisor 身份在仓库根目录运行，pi 只有 read、grep、find、ls 工具。

| 参数 | 评审范围 |
|---|---|
| 无 | 工作区相对 HEAD 的全部改动，含未跟踪文件 |
| `--staged` | 已暂存的改动 |
| `--base <分支>` | 相对该分支分叉点的全部改动，含未提交部分与未跟踪文件 |

- **用户发起**：`/pi-review` 斜杠命令。
- **Claude 主动发起**：跨多个文件的逻辑改动之后、提交之前执行 `pi-bridge review`；小改动不评审。用 `--focus` 指出希望重点检查的方面。
- 回复末尾给出评审会话名（如 `review-20261001T013000-4242`），对某一条有疑问时用 `pi-bridge send <评审会话名> <消息>` 追问；补丁超过 200 KB 时补丁文件在评审结束后删除，追问时 pi 只能依据会话历史和仓库代码。
- 处理结果：逐条对照代码核实 pi 的结论，标注认同、不认同或待确认并说明理由，呈现给用户；不要未经用户同意就按评审意见修改代码。
- 按“调用方式”在后台执行。
