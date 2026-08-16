---
name: winmux-orchestrate
description: Orchestrate sibling Claude Code sessions in WinMux tabs — spawn worker sessions, track their jobs, wait for and collect results. Use when running inside WinMux (the WINMUX_SID environment variable is set) and asked to delegate, spawn, or coordinate other Claude/AI sessions.
---

# WinMux orchestration

You are running inside a WinMux tab (`WINMUX_SID` = your tab id, `WINMUX_PORT` = the control port). WinMux gives you three moves: spawn a worker session, wait for its job, read its result. The worker streams live in its own pane, writes its final answer to a result file, and marks its own job done — you never manage that part.

## Preferred: the winmux MCP tools

If tools named `winmux_agent_spawn`, `winmux_agent_wait`, and `winmux_agent_result` are available, use them — no shell commands needed:

1. `winmux_agent_spawn` with `{ task, name, cwd, split, model }` → returns `{ jobId }`. `split: "right"` for the first worker and `"down"` for later ones opens them in split panes of the current tab (use when the user wants to watch sessions side by side); omit `split` for new tabs.
2. `winmux_agent_wait` with `{ jobId, timeoutSec: 300 }` → job state. `"working"` means the timeout elapsed — call it again with the same jobId.
3. `winmux_agent_result` with `{ jobId }` → the worker's full result.

## Fallback: the winmux CLI (Bash)

    node "C:/Users/EDWAR/Dropbox/AI_Projects_Claude/projects/winmux/apps/electron/bin/winmux.cjs" agent spawn "<task>" --tui --name "<short label>" --cwd "<dir>" [--split right|down] [--model sonnet|haiku|opus|inherit] --json

Returns `{"jobId": ...}`. Then wait / read with the same CLI:

    node ".../bin/winmux.cjs" agent wait --job <jobId> --timeout 300     (exit 3 = still working, run again)
    node ".../bin/winmux.cjs" agent result --job <jobId>

## Choose each worker's model (token budget)

Pick `model` per task — spawning every worker on the account-default top-tier model burns the budget:

- **Omit / `"sonnet"` (the default)** — reviews, plans, audits, research, code reading, routine builds. Use this unless you have a reason not to.
- **`"haiku"`** — trivial mechanical tasks: run a command and summarize, format, extract, simple checks.
- **`"opus"` or `"inherit"` (account default)** — ONLY when the task genuinely needs top-tier reasoning (hard debugging, subtle architecture, high-stakes judgment), and say so in your summary.

If the user names a model, that wins.

## Drive a live session with slash commands

`winmux_slash` with `{ command, id }` types a slash command into a running session's terminal (it waits until that session is idle). CLI fallback: `node ".../bin/winmux.cjs" slash "/model haiku" --id <sid>`. Uses:

- `/model haiku` (or sonnet/opus) — switch a session's model mid-flight; applies to its next turns. Downshift a worker whose remaining work got easier; upshift only with a stated reason.
- `/compact` — shrink a long-running session's context instead of letting it bloat.

This is for model/context management of sessions you spawned — it is NOT a way to give a worker new tasks or authorize work beyond the user's mandate (the no-sends rule below still stands).

## Rules

- Put any safety constraints (e.g. "read-only on the repo: do not modify, create, or commit anything") inside the task text — the worker only knows what you tell it.
- Wait for every job you spawn and read its result — never leave one unread.
- `failed` is a first-class outcome: a worker that crashes, whose pane is closed, or whose claude process dies is auto-failed by WinMux with the reason and exit code in the result — a wait never hangs past its timeout. Read the failure reason, decide whether to respawn the task yourself (nothing restarts automatically), and say what happened in your summary.
- Spawn workers back-to-back when their tasks are independent, then wait on each job in turn.
- Do not close tabs you did not create.
- Workers are driven ONLY by their spawn task. Never use winmux_send (or the CLI send verb) on a worker's terminal — no follow-up questions, no pre-staged "go ahead" commands, not even unsubmitted text left in its input box. If a worker's result suggests further work, put that recommendation in YOUR OWN final answer; the user decides and issues any follow-up themselves.
