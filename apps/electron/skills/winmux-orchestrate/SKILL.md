---
name: winmux-orchestrate
description: Orchestrate sibling Claude Code sessions in WinMux tabs — spawn worker sessions, track their jobs, wait for and collect results. Use when running inside WinMux (the WINMUX_SID environment variable is set) and asked to delegate, spawn, or coordinate other Claude/AI sessions.
---

# WinMux orchestration

You are running inside a WinMux tab (`WINMUX_SID` = your tab id, `WINMUX_PORT` = the control port). WinMux ships a control CLI. All commands below are Bash commands.

## Spawn a worker session (the main move)

Use the bundled spawner — it opens a new WinMux tab, registers a job for it, launches a real Claude Code session there with your task, and wires up completion reporting automatically:

    node "C:/Users/EDWAR/Dropbox/AI_Projects_Claude/projects/winmux/apps/electron/scripts/spawn-claude-worker.cjs" --name "<short label>" --cwd "<working directory>" --task "<what the worker should do>"

It prints ONLY the worker's jobId. The worker writes its final answer to a result file and marks its own job done when finished — you do not manage that part.

Keep `--task` on one line. Put any safety constraints (for example "read-only on the repo: do not modify, create, or commit anything") inside the task text — the worker only knows what you tell it.

## Wait for a worker

    node "C:/Users/EDWAR/Dropbox/AI_Projects_Claude/projects/winmux/apps/electron/bin/winmux.cjs" agent wait --job <jobId> --timeout 300

Exit codes: 0 = done, 2 = failed, 3 = still working (run the same command again), 4 = unknown job.

## Read a worker's result

    node "C:/Users/EDWAR/Dropbox/AI_Projects_Claude/projects/winmux/apps/electron/bin/winmux.cjs" agent result --job <jobId>

## Report your own status (usually automatic via hooks)

    node "C:/Users/EDWAR/Dropbox/AI_Projects_Claude/projects/winmux/apps/electron/bin/winmux.cjs" agent working
    node "C:/Users/EDWAR/Dropbox/AI_Projects_Claude/projects/winmux/apps/electron/bin/winmux.cjs" agent done
    node "C:/Users/EDWAR/Dropbox/AI_Projects_Claude/projects/winmux/apps/electron/bin/winmux.cjs" agent needs-you "<message>"

## Rules

- Wait for every job you spawn and read its result — never leave one unread.
- Do not close tabs you did not create.
- Spawn workers in parallel when the tasks are independent, then wait on each job in turn.
