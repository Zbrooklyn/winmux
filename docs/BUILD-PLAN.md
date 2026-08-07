# WinMux — Build Plan

_Finalized 2026-08-06. Eight phases, in order. Each phase ships on its own, fully tested, before the next starts._

How each phase works:
- I build it, then run the test suite so nothing already working breaks.
- Anything you'll see on screen, I show you first for your OK before it goes live.
- Nothing merges to the public app until you say launch.

Sizes are rough effort, not time: Small, Medium, Large.

---

## Phase 1 — Tabs for everything ✅ done
Open a browser, a markdown file, or a git diff as a tab across the top, next to your terminals. The old side panels go away.
Size: Large. Status: **done** (2026-08-06) — browser / markdown / diff all open as pane tabs from the New-tab menu, docks retired, tabs survive reload. Harness 363/363. See PLAN.md → Phase 15.

## Phase 2 — Smarter typing
As you type, faint text finishes your command. Press right-arrow to accept. No popup.
Size: Small.

## Phase 3 — Images in the terminal
Pictures show right inside the terminal. A `winmux image` command lets anything, including Claude Code, drop one in.
Size: Medium.

## Phase 4 — Command blocks
Fold a command and its output into one block you can collapse and re-run. On by default, with a switch to turn it off.
Size: Medium.

## Phase 5 — Never lose your work
Your sessions come back after a full Windows restart, not just after reopening the app. As far as is technically possible.
Size: Large. The hardest one.

## Phase 6 — Do anything from one search
One shortcut searches every action: open a workspace, start an agent, run tests, switch project, connect remotely, and more.
Size: Small to Medium.

## Phase 7 — Terminal on a hotkey
A global shortcut slides WinMux down over whatever app you're in. Press it again to hide, session kept.
Size: Medium.

## Phase 8 — Full control from your phone
A proper review screen on your phone: what an agent is doing, the commands it ran, the changes it wants to make, test results, with Approve, Reject, Pause, and Stop.
Size: Medium to Large.

---

## After the eight
Then it's your call to launch v1: make the app public and publish it.

## Parked, not cancelled
Rust rebuild, code signing, Android app.
