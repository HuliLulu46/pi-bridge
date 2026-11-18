# Changelog

## Unreleased

- pi-bridge writes a per-run activity log, `~/.pi-bridge/runs/<runId>.activity.ndjson`: the run's events, tool calls with their call id and arguments, tool completions, and what pi writes between tool calls, each text up to 4000 characters (the global log keeps 300). It is pruned together with the run record, and a failed write is skipped without affecting the run or the global log. The global event log is unchanged and still carries no pi-written text.
- The `/pi` pane detail page now shows an activity feed: a timeline of what pi is doing (pi's notes, tool calls with their arguments and durations, tool errors, retries, steers, questions). For a running task the tools still running are marked as the current action with how long they have run (kept in view even when many tools ran after them), or "thinking" when no tool is running; a finished task shows its feed above the reply. Runs from older pi-bridge versions fall back to the global event log.
- Tool arguments in the pane are now readable even when the logged call was truncated (long `bash` commands, `grep` patterns).
- Fixed: a detail page left open on a running task no longer sticks on "Loading…" (or jumps to another task) when that task finishes; it follows the task to the Finished tab and loads its reply.

## 0.3.2

- New sessions and owner forks get their own pi session-id, `<name>-<6 random chars>`, so reusing a name after `pi-bridge rm` starts a fresh pi session instead of resuming the old history. Existing sessions keep their id.
- `rm` prints `pi --session <file>` to reopen the old history, which also works for worktree sessions whose directory is gone.
- A leftover pi session file with the bare session name no longer blocks `--history-file` imports.

## 0.3.1

- PiAgent UI text is now English: the status line above the prompt, the `/pi` pane, toasts, question dialogs, tool results and completion notices. The instructions given to the model are unchanged.

## 0.3.0

First public release.

- One marketplace, `pi-bridge`, with two plugins: `pi-bridge` (CLI, daemon, skill, `/pi-review`) and `pi-agent` (the `PiAgent` tool, notices, native question dialogs, `/pi` pane).
- `pi-agent` locates the `pi-bridge` CLI from its own plugin directory instead of a fixed path.
