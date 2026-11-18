# Changelog

## Unreleased

- The `/pi` pane detail page now shows an activity feed: a timeline of what pi is doing (tool calls with their arguments, tool errors, retries, steers, questions). For a running task the last entry is marked as the current action with how long ago it started; a finished task shows its feed above the reply.
- Tool arguments in the pane are now readable even when the logged call was truncated (long `bash` commands, `grep` patterns).
- Fixed: a detail page left open on a running task no longer sticks on "Loading…" (or jumps to another task) when that task finishes; it follows the task to the Finished tab and loads its reply.

## 0.3.1

- PiAgent UI text is now English: the status line above the prompt, the `/pi` pane, toasts, question dialogs, tool results and completion notices. The instructions given to the model are unchanged.

## 0.3.0

First public release.

- One marketplace, `pi-bridge`, with two plugins: `pi-bridge` (CLI, daemon, skill, `/pi-review`) and `pi-agent` (the `PiAgent` tool, notices, native question dialogs, `/pi` pane).
- `pi-agent` locates the `pi-bridge` CLI from its own plugin directory instead of a fixed path.
