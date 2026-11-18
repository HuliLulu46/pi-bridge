# Contributing

Issues and pull requests are welcome, in English or Chinese.

## Setup

- Node.js 22.18+, [pnpm](https://pnpm.io), [pi](https://github.com/earendil-works/pi), Claude Code
- `pnpm install`

## Checks

| Command | What it checks |
|---|---|
| `pnpm typecheck` | TypeScript for `plugins/pi-bridge/src` and `test/` |
| `pnpm test` | pi-bridge tests (`node --test`, uses fake pi processes, no real model calls) |
| `pnpm test:agent` | pi-agent mod tests (`claude plugin test`, needs Claude Code installed) |
| `pnpm validate` | marketplace and both plugin manifests (`claude plugin validate`) |

CI runs `typecheck` and `test`. Run `test:agent` and `validate` locally before opening a PR that touches `plugins/pi-agent` or any manifest.

## Running your working copy

- pi-bridge CLI: `node plugins/pi-bridge/src/cli.ts <command> ...`
- Both plugins in a Claude Code session: `claude --plugin-dir plugins/pi-bridge --plugin-dir plugins/pi-agent`. Loaded from the repository, `pi-agent` calls `../pi-bridge/src/cli.ts`, so the two always match.

pi-bridge keeps state in `~/.pi-bridge/` (sessions, run records, event log). Use throwaway session names when smoke-testing and remove them with `pi-bridge rm <name>`.

## Changes

- Keep `pi-bridge` and `pi-agent` versions equal in their `plugin.json`: an installed `pi-agent` finds `pi-bridge` by the shared version directory.
- When the CLI's JSON output or the event log format changes, update `plugins/pi-agent/hooks/register.tsx` in the same PR.
- Add an entry to [CHANGELOG.md](CHANGELOG.md).
