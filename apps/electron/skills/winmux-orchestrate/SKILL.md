---
name: winmux-orchestrate
description: Orchestrate sibling Claude Code sessions in WinMux tabs — spawn worker sessions, track their jobs, wait for and collect results. Use when running inside WinMux (the WINMUX_SID environment variable is set) and asked to delegate, spawn, or coordinate other Claude/AI sessions.
---

# WinMux orchestration

You are running inside a WinMux tab (`WINMUX_SID` = your tab id, `WINMUX_PORT` = the control port). WinMux gives you three moves: spawn a worker session, wait for its job, read its result. The worker streams live in its own pane, writes its final answer to a result file, and marks its own job done — you never manage that part.

## Preferred: the winmux MCP tools

If tools named `winmux_agent_spawn`, `winmux_agent_wait`, and `winmux_agent_result` are available, use them — no shell commands needed:

1. `winmux_agent_spawn` with `{ task, name, cwd, split }` → returns `{ jobId }`. `split: "right"` for the first worker and `"down"` for later ones opens them in split panes of the current tab (use when the user wants to watch sessions side by side); omit `split` for new tabs.
2. `winmux_agent_wait` with `{ jobId, timeoutSec: 300 }` → job state. `"working"` means the timeout elapsed — call it again with the same jobId.
3. `winmux_agent_result` with `{ jobId }` → the worker's full result.

## Fallback: the winmux CLI (Bash)

    node "C:/Users/EDWAR/Dropbox/AI_Projects_Claude/projects/winmux/apps/electron/bin/winmux.cjs" agent spawn "<task>" --tui --name "<short label>" --cwd "<dir>" [--split right|down] --json

Returns `{"jobId": ...}`. Then wait / read with the same CLI:

    node ".../bin/winmux.cjs" agent wait --job <jobId> --timeout 300     (exit 3 = still working, run again)
    node ".../bin/winmux.cjs" agent result --job <jobId>

## Rules

- Put any safety constraints (e.g. "read-only on the repo: do not modify, create, or commit anything") inside the task text — the worker only knows what you tell it.
- Wait for every job you spawn and read its result — never leave one unread.
- Spawn workers back-to-back when their tasks are independent, then wait on each job in turn.
- Do not close tabs you did not create.
