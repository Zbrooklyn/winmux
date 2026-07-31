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

## Scope

This is the hooks → cockpit-state bridge. A richer **transcript/fleet reader** (parsing
Claude Code session `.jsonl` for per-turn history) is a separate, larger follow-on and
is not part of this integration.
