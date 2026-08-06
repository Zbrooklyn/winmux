# WinMux — Features We're Adding

_Finalized 2026-08-06. Everything here is approved by Edward. Order is the build order._
_Ground rule: no new on-screen clutter — features live in the terminal or behind a toggle. Nothing new hits the screen without Edward's OK; these are the ones he's OK'd._

---

## Building now

**1. Browser, Markdown & Diff as tabs**
Open a web browser, a markdown file, or a git-diff as a tab across the top — right next to your PowerShell tabs. The old side-panels go away. New-tab menu becomes: Terminal · Browser · Markdown.
_Status: in progress._

---

## Confirmed next

**2. Inline command suggestions**
As you type, the likely rest of the command appears as faint ghost text; press → to accept. No dropdown, no popup — it sits right in the line. (Uses the shell's own predictor, e.g. PowerShell's.)

**3. Inline images**
Show a picture right inside the terminal — no popup, no separate viewer. Includes a `winmux image <file>` command so anything (including Claude Code) can drop an image into the terminal on demand.

**4. Command blocks**
Group a command with its output into one tidy block you can collapse, jump between, and re-run. Optional, **on by default**, with a switch to turn it off.

**5. Reboot-proof sessions**
Today your tabs, layout, folders, scrollback, and agent conversations survive closing and reopening WinMux. This adds the missing piece: bringing your live sessions back after a full **Windows restart**, not just an app restart — as far as is technically possible.

**6. A complete command palette**
One shortcut, search everything WinMux can do: open a workspace, restore a session, switch project, start an agent, run tests, change theme, connect remotely, open settings. (The palette exists; this fills in every action.)

**7. Drop-down (Quake-style) terminal**
A global shortcut slides WinMux down over whatever app you're in; press it again and it hides — without losing your session.

**8. Phone agent-review card**
From your phone, a proper review screen for an agent that needs you: what it's doing, the commands it ran, the file changes it's proposing, test results — with Approve / Reject / Pause / Stop. (Today the phone can see "needs you" and approve/reject; this makes it a full review.)

---

## Already have — no work needed

**Saved project workspaces.** `winmux open <recipe>` already opens a named set of terminals — a project folder, dev server, test watcher, Claude, git, logs — from one file. (The browser-testing pane joins it once #1 lands.)

---

## Not doing (parked by Edward)

Rebuilding the engine in Rust (v2) · code signing · a standalone Android app. Deferred, not cancelled.
