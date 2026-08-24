# PROJECT-STATE — winmux

**Last verified:** 2026-08-24 · **By:** `/reanchor` (session "WinMux/Obsidian (check)")

## What this project is

WinMux: a Windows terminal multiplexer (Electron shell + Rust core, plus Node/Tauri
identities) with split panes, per-pane tab bars, saved layouts, phone access over
Tailscale, and agent hooks. Shipped as v0.2.7 on `master`.

## Current objective

One question, this session: WinMux passes its checks and still feels like a prototype
in use — 8 panes across is unpleasant, 12 looks broken. Establish what a quality product
does at the split limit, measure our own app in pixels (controls first, characters
second), compare against tmux / Windows Terminal / iTerm2 / Zellij / WezTerm / Warp,
and propose the standard. Edward decides the final limit and the at-limit behaviour.
The test harness is explicitly NOT the work.

## Governing requirements and decisions

- `master` is owner-gated; do not promote to it. (Edward, this session.)
- Do not treat the 671-check suite as evidence of quality; do not work on it. (Edward.)
- The limit is pixel/controls-first, character width second. (Edward's reframe.)
- Final limit and at-limit behaviour are Edward's decisions; bring pictures + one
  recommendation, not a menu.

## Repository

| | |
|---|---|
| Root | `C:/Users/EDWAR/Dropbox/AI_Projects_Claude/projects/winmux` — `git rev-parse --show-toplevel` |
| Git common dir | `…/winmux/.git` — `git rev-parse --path-format=absolute --git-common-dir` |
| Remote | `https://github.com/Zbrooklyn/winmux.git` — `git remote -v` |

**Worktrees** — `git worktree list --porcelain`

| Path | Branch | Commit | Notes |
|---|---|---|---|
| `…/projects/winmux` | `feature/phase8-electron-shell` | `a834a30` | canonical; clean except untracked `apps/electron/.verify-out/` |
| `C:/dev/winmux-replay` | `replay/port-to-feature` | `a834a30` | scratch (Edward); same commit; clean |

## Remote and pull requests

- `feature/phase8-electron-shell` tracks origin, **0 ahead / 0 behind** — `git branch -vv`.
- No stash (`git stash list`), no unpushed commits (`git log --branches --not --remotes`).
- PR state not checked: `gh` is not installed on this machine.
- Other branches: `chore/omni-monorepo`, `evidence/original-path`, `replay/guarded-loop` — all tracking origin.

## Deployed / installed

- Released: v0.2.7 = `master` `051d3f9` (memory/open-loops + `git branch -vv`).
- Installed on this PC and serving Edward's live sessions: `winmux-core.exe` pid 92004 on
  `127.0.0.1:9920` (his WinMux Rust) and pid 77392 on `:9921` (Tauri) — `tasklist` + `netstat -ano`.
- **The installed 0.2.7 UI has no split floor at all** — `grep MIN_COLS` on
  `C:\Users\EDWAR\AppData\Local\WinMux Tauri\public\app.js` returns nothing. The 24-column
  floor (`6112c4c`) exists only on `feature/phase8-electron-shell` (and its replay/evidence
  copies) — `git branch -r --contains 6112c4c`.

## Work that exists outside a pushed branch

- Untracked: `apps/electron/.verify-out/` — harness output, not work.
- Nothing stashed, unpushed, or orphaned found (`git stash list`, `git log --branches --not --remotes`).
  `git fsck --unreachable` not run this session (no sign of lost work; low value here).

## Measurements this session (primary evidence — screenshots in the session scratchpad)

Method: isolated scratch engines (port 9970 = feature-branch UI, 9971 = installed 0.2.7 UI,
own workspace files, Edward's live engines untouched), driven in a 1280×690 browser
viewport — which is Edward's real logical window: 2560×1440 at 200% DPI (`Screen.AllScreens`,
`AppliedDPI=192`). Sidebar open (default) leaves a 1016 px pane row.

- Pane chrome: 40 px tab bar in every pane. Chrome share of pane area: 10% (1 pane),
  15% (4), 18% (6), 22% (8), 28% (12).
- Installed 0.2.7, panes across at 1016 px: 1→1016, 2→508, 3→338, 4→254, 6→169, 8→126, 12→84 px.
- Where a control first breaks (2-pane window-width sweep, `elementFromPoint` occlusion +
  bounding-box clipping):
  - Ordinary pane: tab title overlapped by the overflow chip at **258 px**; tab covered by
    the New/Zoom/Close buttons at **218 px**.
  - Rightmost pane (also reserves 133 px for the window's min/max/close corner): tab
    overlapped at **398 px**; "changes" button under the window controls at 308, Close at
    268, Zoom at 238, New-tab at 208.
- Consequence at Edward's size: **3 panes** is the first layout with a pane missing its tab
  (rightmost, 338 px). At 8 panes no pane shows a tab or a close button; at 12 the prompt
  `PS C:\Users\EDWAR>` wraps.
- Below a 620 px window the app flips to the phone layout (one pane) — that fallback works.
- 10 tabs in a 254 px pane: one tab visible, chip shows "10" (the chip shows the total, not
  the hidden count).
- 30,000 lines of scrollback: fine — scroll-to-top ≈ 0.5 s, nothing broken.
- Feature-branch floor (24 cols × 6 rows): permits 5 panes at 203 px (every tab already
  covered by buttons); refusing the 6th split shows **nothing on screen** except a "1" on
  the bell — the message lives only in the notifications panel (`notify()` app.js:909).
- Character floor vs control floor: 24 cols ≈ 216 px text + 18 px padding ≈ 234 px, i.e.
  **below** the control floor (258 / 398). The characters were never the binding constraint.

## Peer terminals (verified from source/docs by a research agent this session)

- Floors are tiny and hard-coded: tmux 1 cell + border (`PANE_MINIMUM 1`, layout.c);
  WezTerm 1 cell + divider (mux/src/tab.rs); iTerm2 2×2 cells → pixels (VT100Screen.m,
  PTYTab.m); Windows Terminal one font cell + scrollbar + 2 px borders (Pane.cpp,
  TermControl.cpp); Zellij 5 cells, split needs 2× (tab/mod.rs), auto-place wants 30 cols;
  Warp: unverifiable (closed source, undocumented).
- Refusal: tmux errors "no space for a new pane"; Zellij paints "CAN'T SPLIT!" on the
  pane; iTerm2 beeps; Windows Terminal and WezTerm silently no-op. None disables the menu
  item; none falls back to a tab.
- Escape hatch everywhere: zoom/maximize; then move-to-tab/window and swap. Only Zellij has
  a structural overflow answer: stacked panes (one-line title rows) + swap layouts.
- Headers are opt-in or absent (WT/WezTerm have none); where a title exists it is
  clipped/truncated, never removed.

## Contradictions and unknowns

- Commit `6112c4c`'s comment says "tmux, Zellij, iTerm2 and Windows Terminal all refuse long
  before that point." Verified: they refuse at 1–5 cells, i.e. *later* than 24 columns, not
  before. The 24 was not derived from peers; it was chosen.
- Memory/open-loops still describes the last WinMux arc as v0.2.7 + Android; the branch's
  last 15 commits are harness work. The recorded arc is stale; this session's question is
  the real current mission.
- Edward's reported "8 across / 12 broken" was seen on the installed app (no floor); the
  feature branch would have stopped him at 5 — both states are broken, differently.
- The 0.2.7 keymap differs from the branch (Ctrl+D vs Ctrl+Shift+R for split; Ctrl+B vs
  Ctrl+Shift+B for the sidebar) — not investigated; noted so a future session isn't misled.

## Lifecycle phase

Objective "pane-limit standard": **Discover → Define** — discovery done this session
(measurements + peer research); Define is the proposed standard awaiting Edward's two
decisions (the floor, the at-limit behaviour). No Plan/Design/Build has started.
Recovered from: this session only — no prior phase state existed for this objective.

## Proposed standard (recommendation, not decided)

1. A pane is legal only when every control in its chrome is fully visible and hittable
   and its tab shows at least a readable title stub (~100 px). Character width is a
   second check on top.
2. Remove the two chrome taxes that make the floor high: give the window controls their
   own strip (no 133 px reservation in the rightmost pane) and, below ~320 px, collapse
   New/Zoom/Changes into one "⋯" menu, keeping tab + close. The measured floor then
   lands at ≈ **240 px per pane, 150 px tall** (24 cols + 6 rows fit inside it), which is
   4 across on Edward's 1016 px row, 6–7 across at 1920 px.
3. At the floor, never shrink further and never refuse silently: the split opens as a
   **tab in the same pane** with an in-pane message ("No room for another pane — opened
   as a tab"), reusing the existing fold-into-tabs mechanism. Zoom stays the escape hatch.

Decisions for Edward: (a) accept ≈240 px as the floor (≈4 across on his monitor), and
(b) at the limit, open-as-tab (recommended) vs. visible refusal only.
