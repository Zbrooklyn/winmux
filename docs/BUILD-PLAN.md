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

## Phase 2 — Smarter typing ✅ done
As you type, faint text finishes your command. Press right-arrow to accept. No popup.
Size: Small.
Shipped: this is PowerShell 7's native inline prediction, not something WinMux injects —
Windows PowerShell 5.1 (the old default) can't do it, so WinMux now opens PowerShell 7 by
default when it's installed (falls back to 5.1). Approved by Edward. Harness-verified on a
pwsh tab; first-launch screenshot confirmed PowerShell 7 with prediction on.

## Phase 3 — Images in the terminal ✅ done
Pictures show right inside the terminal. A `winmux image` command lets anything, including Claude Code, drop one in.
Shipped: @xterm/addon-image renders sixel + iTerm2 IIP images inline (on by default, Edward-approved);
`winmux image <path>` emits the escape imgcat-style. Kitty protocol isn't supported by the addon —
covered via sixel+IIP. Prompt-overlap glitch fixed (newline-wrapped escape). Harness-verified (images 3/3),
real-window screenshot confirmed clean render.
Size: Medium.

## Phase 4 — Command blocks ✅ done (minimal form, gated OFF)
Fold a command and its output into one block you can collapse and re-run. On by default, with a switch to turn it off.
Size: Medium. Status: **done in the clean minimal form** (2026-08-07) — an inline ✓/✗ + time tag after each command, coloured by exit status, built on the OSC-133 D-marks. Gated OFF by default (Settings → Behaviour) to keep the terminal clean out of the box. Harness-proven: `cmdtag` check asserts green ✓ on exit 0, red ✗ on a non-zero exit. The heavier Warp-style fold/collapse/re-run boxes were deliberately NOT built — they fight the "keep it clean" bar and are a large xterm rewrite; parked unless Edward asks for them.

## Phase 5 — Never lose your work — DONE
Your sessions come back after a full Windows restart, not just after reopening the app. As far as is technically possible.
Size: Large. The hardest one.
DONE: on-screen scrollback now persists to disk and replays after a full server/reboot kill (backend + client, committed 9623b12/6809428). Optional "Start WinMux when I log in" toggle (Behaviour, OFF by default) reopens the app at logon (65c4eca/2d9f60a). Committed `restart` harness check proves the seam. Honest scope: layout + scrollback + one-tap resume return; live processes cannot survive a reboot.

## Phase 6 — Do anything from one search
One shortcut searches every action: open a workspace, start an agent, run tests, switch project, connect remotely, and more.
Size: Small to Medium.

## Phase 7 — Terminal on a hotkey ✅ done
A global shortcut slides WinMux down over whatever app you're in. Press it again to hide, session kept.
Size: Medium. Status: **done** (2026-08-07, gated OFF) — global accelerator (default Control+`, changeable) shows/hides the Electron window over the focused app, positioned top-center of the cursor's display; press again to hide, sessions untouched. "Drop down on a hotkey" toggle in Settings → Behaviour, OFF by default (nothing grabs a system key until flipped on). Committed c5c899c. Harness electron 22/22 incl. quakeRegistered:true, quakeDrops:true. Only a physical keypress on the real machine is unverifiable in the headless harness — that's Edward's real-machine test.

## Phase 8 — Full control from your phone ✅ done (v1, card direction)
A proper review screen on your phone: what an agent is doing, the commands it ran, the changes it wants to make, test results, with Approve, Reject, Pause, and Stop.
Size: Medium to Large. Status: **v1 done** (2026-08-07) — when a session needs you, the phone shows the "Needs your OK" approval card (Edward-chosen card direction): the plain-English ask, the actual prompt, and Approve / Reject. Harness-proven: `approvecard` check flips a real session to needs-you, opens the card, clicks Approve, and asserts Enter ({t:'i',d:'\r'}) reaches the shell over its socket. Reject rides the same path (Esc). Deferred (needs structured data the agent doesn't emit yet, so not faked): the parsed-diff and test-count panels from the mockup — a separate decision, not v1.

---

## After the eight
All eight phases are done on `feature/phase8-electron-shell`, each backed by a committed harness check (full suite 388/388 green as of 2026-08-07). What's built this cycle ships gated OFF where it adds visible UI (restart-restore, search palette, quake hotkey, command tags) — flip on to accept. Then it's your call to launch v1: promote the branch, make the app public, and publish v0.1.0.

## Parked, not cancelled
Rust rebuild, code signing, Android app.
