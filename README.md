# agent-bridge

Claude Code plugin marketplace，目前提供一个 plugin：`pi-bridge`，让 Claude Code 调用 [pi](https://github.com/earendil-works/pi) coding agent。

- skill `pi-bridge`：指导 Claude 何时、如何把任务交给 pi
- 命令 `pi-bridge`：按会话名续接 pi 会话，按角色运行——advisor 只读、跑完即退出；executor 在常驻进程中改代码，支持 pi 中途提问、任务中途插话与中止；另有只读评审 `review`
- 斜杠命令 `/pi-review`：让 pi 评审当前改动，Claude 逐条核实后汇报

## 运行要求

- Node.js 22.18 或更高（直接运行 `.ts` 源码，依赖 Node 的类型擦除）
- 已安装 `pi`，且在 PATH 中

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
  skills/pi-bridge/SKILL.md
  src/                            TypeScript 源码
test/                             测试（pnpm test）
```
