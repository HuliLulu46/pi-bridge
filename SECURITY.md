# Security

## What each role can do

| Role | Access |
|---|---|
| advisor (default) | Read-only: pi gets only `read`, `grep`, `find`, `ls`, no extensions, no network tools |
| executor | pi's full environment in your working directory: it can edit files and run commands, with whatever extensions, skills and MCP servers you have configured for pi. Permission prompts are denied automatically and listed in the reply |
| `--worktree` | The executor works in a separate git worktree on branch `pi/<session>`; it still runs as your user |

Treat an executor run like running a coding agent yourself: say in the message which directories it may change and whether it may commit, and review the diff it reports.

pi-bridge stores session records, run records (including full replies) and an event log under `~/.pi-bridge/`. With `fork=true`, `pi-agent` writes the current conversation to `~/.pi-bridge/history/` and pi-bridge deletes the file after importing it.

## Reporting a vulnerability

Please report privately through [GitHub security advisories](https://github.com/HuliLulu46/pi-bridge/security/advisories/new) rather than a public issue.
