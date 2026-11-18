# Changelog

## 0.3.1

- PiAgent UI text is now English: the status line above the prompt, the `/pi` pane, toasts, question dialogs, tool results and completion notices. The instructions given to the model are unchanged.

## 0.3.0

First public release.

- One marketplace, `pi-bridge`, with two plugins: `pi-bridge` (CLI, daemon, skill, `/pi-review`) and `pi-agent` (the `PiAgent` tool, notices, native question dialogs, `/pi` pane).
- `pi-agent` locates the `pi-bridge` CLI from its own plugin directory instead of a fixed path.
