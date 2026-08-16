# WinMux agent integration (Phase 11)

Make the WinMux cockpit reflect the **real** state of a Claude Code agent running
inside a terminal — *working*, *needs you*, *done* — instead of guessing from output.
When a background agent blocks on a permission prompt, its session row flips to
**NEEDS YOU** with an inline **Approve**; when it finishes, the row goes quiet. Across a
fleet of terminals you see, at a glance, exactly which one wants you.

## How it works

Every shell WinMux spawns carries two environment variables (the tmux `$TMUX_PANE`
precedent):

- `WINMUX_SID` — this session's id
- `WINMUX_PORT` — the WinMux server's port

Anything running inside that terminal — including a Claude Code hook, which is a child
of the `claude` process, which is a child of the shell — inherits them. So a hook can
call `winmux agent <state>` and it addresses **exactly this session**, with no
per-terminal setup. Outside a WinMux terminal (`$WINMUX_SID` unset) the command no-ops
silently, so the same settings are safe everywhere.

## The `winmux agent` command

```
winmux agent working              # this session is busy → WORKING lane
winmux agent needs-you "message"  # blocked on you → NEEDS YOU + Approve + notification
winmux agent done                 # finished → back to idle
winmux agent idle                 # alias for done
```

Targeting: `--sid <id>` (defaults to `$WINMUX_SID`), or `--id <n>`, or — only when one
of those is given — that exact session. No target and no `$WINMUX_SID` → no-op.

The same surface is available as the `winmux_agent` MCP tool and over `POST /rpc`
(`{ cmd: "agent", args: { state, message, sid } }`).

## Install the Claude Code hooks

Merge the `hooks` block from [`agent/claude-code-hooks.json`](../agent/claude-code-hooks.json)
into your Claude Code settings (`~/.claude/settings.json` for all projects, or a
project's `.claude/settings.json`). It wires three lifecycle events:

| Claude Code event  | WinMux state       | Effect in the cockpit                          |
|--------------------|--------------------|------------------------------------------------|
| `UserPromptSubmit` | `winmux agent working`   | row → WORKING                            |
| `Notification`     | `winmux agent needs-you` | row → NEEDS YOU + Approve + notification  |
| `Stop`             | `winmux agent done`      | row → idle                               |

Requirements: the `winmux` CLI must be on `PATH` (it is when WinMux is installed;
otherwise `npm link` in the repo, or use the full path to `bin/winmux.cjs`).

That's the whole setup. Start `claude` in any WinMux terminal and the cockpit follows
its lifecycle — including the phone over Tailscale, so you can approve a blocked agent
from anywhere.

## Orchestration: one session drives another

The states above let the cockpit *watch* an agent. WinMux can also let one agent
**run** another and use what it produces. A session opens a second session, gives it a
task, waits until it finishes, and gets the result back as data.

```
winmux agent spawn "fix the failing test in verify.cjs"   # open a session, run the task, get a job id
winmux agent wait --job <id>                              # block until it finishes; prints its result
winmux agent result --job <id>                            # read a finished job's result later
```

`spawn` mints a server-side **job id**, opens a fresh session, and launches the task in
it (a Claude prompt by default, or any command with `--cmd`). The task's output is
captured to a file and the session reports its own completion back to the server. `wait`
blocks on that job and returns its result the moment it lands.

How it fits together:

- **The job id is the unit of work, not the session id.** A session id addresses a
  terminal; a job id addresses one task run in it. Report, wait, and result all carry the
  job id, so a stale report can never satisfy a newer wait.
- **Completion is cooperative.** The spawned task reports `done` (or `failed`) with its
  result by calling `winmux agent done --job <id> --result-file <file>` when it finishes.
  The `spawn` launcher wires this up automatically. WinMux does not guess that a
  session "finished" from its output, because the shell stays alive at a prompt after the
  task ends.
- **The result is data.** Up to 64 KB of the task's captured output, stored verbatim and
  returned as one JSON envelope (`jobId`, `sid`, `state`, `result`, `exitCode`, and
  timestamps). The shape is identical on the Node and Rust engines.
- **The wait never hangs.** It resolves within about a second of the report, defaults to a
  90-second bound, and is resumable: on timeout it returns the current state so the caller
  can wait again or go do other work. Exit codes are `0` done, `2` failed, `3` still
  working, `4` unknown job.
- **Local only.** Orchestration verbs run at the PC over the local RPC surface; the phone
  link cannot drive them.

**Supervision (P6, built 2026-08-15) — a crashed worker can no longer hang a wait.**
Two layers, both detect-and-surface only:

- **Engine watchdog** (Rust core): jobs are registered by the engine's session sid, and a
  2-second watchdog fails any non-terminal job whose session is gone or whose shell
  process has exited — the job flips to `failed` with `worker session exited (code N)
  before reporting a result` and every waiter wakes immediately. (A reader-EOF hook does
  the same when ConPTY delivers EOF; the watchdog covers the cases where it doesn't.)
- **Launcher failsafe** (job.ps1): if the `claude` process itself exits without the Stop
  hook having reported (hard crash, failed launch), the launcher reports the job `failed`
  with claude's exit code. Harmless after a normal finish — the first terminal report
  wins and later reports are ignored.

**Auto-restart is deliberately not built.** Restarting a task can repeat its side
effects, so any restart remains a safety-sensitive, off-by-default, opt-in follow-on.

## Scope

This is the hooks → cockpit-state bridge plus the orchestration verbs above. A richer
**transcript/fleet reader** (parsing Claude Code session `.jsonl` for per-turn history) is
a separate, larger follow-on and is not part of this integration.
