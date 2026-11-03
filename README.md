# agent-bridge

Claude Code plugin marketplace，目前提供一个 plugin：**`pi-bridge`**。它让 Claude Code 把 [pi](https://github.com/earendil-works/pi) coding agent 当成第二个大脑来用：pi 可以背后跑另一家的模型，以只读顾问的身份给方案和代码提意见，也可以以执行者的身份接手编码任务。Claude 始终是主控，负责拆任务、回答 pi 的提问、核实 pi 的结论。

日常使用不需要手敲命令。在 Claude Code 里说“问问 pi 这个方案”“交给 pi 改”“让 pi 评审一下”，`pi-bridge` skill 会让 Claude 选好角色、在后台运行、读结果，并逐条核实后再汇报给你。

## 能做什么

### 1. 只读顾问：随时拿到第二意见

```bash
pi-bridge send auth-design - <<'EOF'
下面是登录模块改造方案（.draft/auth.md），请指出风险最高的三处，只读，不要改文件。
EOF
```

顾问（`--role advisor`，缺省角色）只有 read、grep、find、ls 四个只读工具，不加载 pi 的扩展和 Claude 的 skill，跑完即退出。同一个会话名可以多轮讨论，pi 记得前文，Claude 不必每次重复背景。

### 2. 执行者：把编码任务交出去，pi 卡住时会回头问

```bash
pi-bridge send fix-login --role executor "……修复登录页空密码的校验，授权修改 /repo/src/login 中的文件，不可以提交。"
```

执行者（`--role executor`）在常驻进程中运行，拥有 pi 的完整环境。任务进行到一半遇到需要拍板的地方，pi 会停下来提问，`send` 以退出码 2 结束并打印问题：

```
[ask] 3f2a… select: 空密码时的提示文案用哪一个？
  1) 请输入密码
  2) 密码不能为空
回答：pi-bridge answer fix-login 3f2a… <序号或选项原文>（或 --cancel 取消）
```

Claude 能根据你的意图回答的直接回答，拿不准的再问你；`pi-bridge answer fix-login 3f2a… 2` 之后 pi 接着干。任务完成时，回复末尾附上这次运行改动了哪些文件：

```
已修复空密码校验，并补充了对应测试。

[pi-bridge] 本次运行改动了 2 个文件：
 M src/login/form.ts
 M src/login/form.test.ts
```

任务进行中还可以：

- `pi-bridge steer fix-login "顺便把错误提示统一成中文"`：不打断任务，在当前这轮工具执行完后把补充指示送给 pi；
- `pi-bridge abort fix-login`：中止当前任务，会话保留，可以接着发消息。

### 3. 先讨论、再动手，上下文不断

同一个会话可以先以顾问身份讨论方案，`stop` 之后改用 `--role executor` 让 pi 按讨论结果动手。pi 记得之前的讨论，不需要把方案再讲一遍。

### 4. 提交前让 pi 评审

在 Claude Code 里输入 `/pi-review`（或 `/pi-review --base main`），pi 以只读方式评审当前改动，Claude 打开代码逐条核实，标注认同、不认同或待确认后用表格汇报，**不会未经你同意就按评审意见改代码**。评审结果末尾给出评审会话名，对某一条有疑问时可以接着追问。

### 5. 隔离运行与进度跟随

- `--worktree`：创建会话时加上，pi 在独立的 git worktree 和分支 `pi/<会话名>` 中工作，可以和 Claude 并行改同一个仓库，完成后整体验收再合并。
- `pi-bridge watch <会话名>`：每次工具调用输出一行进度，可以交给 Claude Code 的 Monitor 实时跟随。

## 为什么不直接在 Bash 里调用 pi

`pi -p` 本身就能按会话名续接，直接调用适合一次性的简单问题。但在 Claude Code 里长期使用，会反复踩到下面这些问题，`pi-bridge` 把它们都处理掉了：

| 直接调用会遇到的问题 | pi-bridge 的处理 |
|---|---|
| pi 中途提问需要一个长期运行、标准输入一直开着的进程，而 Claude 每次调用 Bash 都是一条独立的命令，`pi -p` 遇到要提问的情况只能放弃 | 常驻进程托管 pi，Claude 的每条命令通过 unix socket 与它通信，所以能提问、插话、中止 |
| 装了 pi-code 等扩展时，pi 会加载 Claude 的全部 skill，被 brainstorming、tdd 之类的流程带偏；`--no-skills` 关不掉这些 skill | 顾问用 `--no-extensions` 加只读工具白名单，彻底隔离，也保证只读 |
| 完整环境的 pi 会读写 pi-code 的记忆、触发会话级 hook | 执行者统一设置 `PI_CODE_SUBAGENT=1`，关掉这些副作用 |
| 在错误的目录下用 `--session-id` 续接，pi 只打一行警告就新建一个空会话，之前的上下文悄悄丢了 | 会话名首次使用时绑定工作目录，之后在哪里调用都回到同一个会话 |
| 两个 pi 进程可以同时写同一个会话文件 | 会话锁；常驻进程在运行时，拒绝以顾问身份发消息 |
| `--mode json` 的事件流很冗长，两次工具调用就有约 500 行、48 KB；在 Claude Code 的 Bash 里不关闭标准输入，pi 还可能一直卡住 | stdout 只输出最终回复，末尾附上出错或被拦截的工具调用；watch 每次工具调用只输出一行 |
| pi 要求权限确认时，没有人能回答 | 常驻进程一律拒绝并列在回复末尾，由 Claude 判断自己做还是转告你 |

这些规则写在 SKILL.md 里让 Claude 每次手动照做也行，但规则多、漏一条也不会报错；写成代码则每次都能做对。

## 运行要求

- Node.js 22.18 或更高（直接运行 `.ts` 源码，依赖 Node 的类型擦除）
- 已安装 `pi`，且在 PATH 中
- 用 `--engine qoder` 时，另需已安装 `qoderclicn`（或用 `QODER_BIN` 指定其路径）
- 用 `--model qoder-local/<模型>` 让 pi 调 Qoder 的模型时，另需本机 qoder2api 服务在运行，并在 `~/.pi/agent/models.json` 配好 `qoder-local` provider

## 被调用方引擎：缺省 pi，显式声明才用 qoderclicn

被调用方（“第二个大脑”）缺省是 pi。pi 已接入 Qoder 的模型，只要 Qoder 的模型能力时仍走 pi：

```bash
pi-bridge send design-review --model qoder-local/Qwen3.8-Max "只读评审这份方案，指出风险最高的三处"
```

只有明确要用 [Qoder CLI（qoderclicn）](https://docs.qoder.cn/cli) 这个独立 agent 时，才用 `--engine qoder`：

```bash
pi-bridge send design-review --engine qoder "只读评审这份方案，指出风险最高的三处"
pi-bridge review --engine qoder --base main
```

也可用环境变量 `PI_BRIDGE_ENGINE=pi|qoder` 设**新建会话**的缺省（`--engine` 优先于它）。引擎在会话首次创建时绑定，续接以绑定为准；对已存在的会话传入不同的 `--engine` 会报错，要换引擎就换一个会话名。qoder 引擎支持 **advisor、editor 与 review**；executor（常驻进程、中途提问）仍由 pi 承接。

qoder 的编辑模式用 `--role editor`：

```bash
pi-bridge send fix-login --role editor --engine qoder "把 src/login/form.ts 的空密码校验补上，并更新对应测试"
```

editor 在只读三件套之外加 `Edit`/`Write`，可以编辑会话工作目录内的文件；没有 Bash（不能跑命令、不能提交），不加载外部 MCP。权限用 `accept_edits`：目录内的编辑自动放行，目录外或需要确认的操作被自动拒绝并列在回复末尾。和 advisor 一样是一次性运行（跑完即退出），没有常驻进程，因此不支持 steer/answer/abort，进度用 `watch` 看；同一会话可以 advisor/editor 混用，上下文不断。

实现方式：`pi-bridge` 会话名被确定性地映射成一个 UUID（qoderclicn 的 `--session-id` 要求合法 UUID），首次用 `--session-id` 建会话、之后用 `--resume` 续接；每轮以 `-p --output-format stream-json` 运行，解析 `assistant`/`user`/`result` 事件得到回复与工具进度。只读隔离用 `--tools Read Grep Glob` + `--strict-mcp-config`，并加 `--permission-mode bypass_permissions`——工具已被限制为只读三件套、没有写入或执行能力可绕过，放行权限确认只是让读操作（含工作目录外的绝对路径）免打断。editor 则用 `--tools Read Grep Glob Edit Write` + `--permission-mode accept_edits`。可用 `QODER_BIN` 指定 qoderclicn 的路径。

当前的边界：

- **executor 仍归 pi**。`--role executor` 在 qoder 引擎下会直接报错；`--role editor` 反过来只对 qoder 会话可用（pi 侧改代码用 executor）。
- **没有“中途提问”**。pi 的 executor 能卡住回头问，靠的是它专有的对话协议；qoderclicn 侧要用 SDK 的进程内 MCP 工具复刻，留待后续版本。因此 qoder advisor/editor 的疑问只会写在最终回复里，由主控在下一轮回答（与 pi 的 advisor 一致）。
- **editor 没有 Bash，也没有改动清单**。不能跑测试、不能提交；验收时自己看 `git diff`（回复末尾不附 executor 那样的改动文件清单）。

## 安装

```bash
claude plugin marketplace add /path/to/agent-bridge
claude plugin install pi-bridge@agent-bridge
```

安装时 plugin 目录会被复制到 `~/.claude/plugins/cache/`，以 git 提交号作为版本。已打开的会话执行 `/reload-plugins` 或重启后生效。

## 更新

提交改动后执行：

```bash
claude plugin marketplace update agent-bridge
claude plugin update pi-bridge@agent-bridge
```

未提交的改动不会产生新版本。开发时可以用 `claude --plugin-dir plugins/pi-bridge` 直接从源码目录加载。

## 目录

```
.claude-plugin/marketplace.json   marketplace 清单
plugins/pi-bridge/                plugin 本体（安装时只复制这个目录）
  .claude-plugin/plugin.json
  bin/pi-bridge                   加入 PATH 的命令
  commands/pi-review.md           /pi-review 斜杠命令
  skills/pi-bridge/SKILL.md       指导 Claude 何时、如何把任务交给 pi
  src/                            TypeScript 源码
test/                             测试（pnpm test）
```

完整的命令说明与使用规则见 [SKILL.md](plugins/pi-bridge/skills/pi-bridge/SKILL.md)。
