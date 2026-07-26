# cockpit-terminal — PLAN

> A real terminal for Windows that wears the wmux cockpit design.

Status: Phase 1 verified — 22/22 checks pass in the real app
Version: v1.0
Goal: The cockpit mockup, made real, around actual PowerShell — every visible control does something.
Constraint: The server runs real shell commands, so it binds 127.0.0.1 only and is never exposed to the network.

## What this project is

`cockpit-terminal` takes the design mockup at `wmux-amirlehmam/design-spec/cockpit.html` — which is a
click-through demo with fake terminal rows — and makes it a working terminal. Real shells (PowerShell,
Command Prompt, Git Bash, WSL) run behind xterm.js inside the mockup's chrome. You open it in a browser
at `http://127.0.0.1:8799`.

**The scope is the mockup's terminal chrome, made real.** Nothing else.

- `server.cjs` — static files locked to `public/`, plus a WebSocket at `/pty` that spawns one `node-pty`
  shell per connection. Binds `127.0.0.1` only, deliberately, because it executes real commands.
- `public/cockpit.css` — lines 8–399 of the mockup, verbatim. **Never edited.** It is the design contract.
- `public/index.html` + `public/app.js` — the real app: the mockup's markup, wired to live terminals.

## Explicitly out of scope

These exist in the mockup because it is a demo of *wmux the AI-agent cockpit*, not of a terminal. They
were never discussed for this project and are not being built here:

- Projects sidebar (a Claude session-fleet browser)
- Orchestration panel (multi-agent run tracking)
- Browser tab, markdown tab, diff-as-a-tab
- Tutorial / onboarding overlay

If any of these is wanted later it is a new decision, not a leftover from this build.

## Already done (working, verified)

Real PTY shells · tabs · 2D splits (right/down) with drag dividers · zoom · close pane/tab with confirm ·
find in scrollback (Ctrl+F) · copy/paste · rename tab · context menus · broadcast input · command palette ·
settings (theme/font/cursor/scrollback/behaviour) · keyboard cheat sheet (F1) · diagnostics · notifications
with badge · changes dock (git diff) · save/load layout · sidebar terminal list with live status deck ·
light/dark themes.

## Phase 1 — Remaining UI parity

Objective: close the last ten gaps between the mockup's terminal chrome and the app.
Gate: each item works in the real app, measured (computed values), screenshot shipped.

- [x] Tab overflow menu — chevron with a hidden-tab count, listing tabs that don't fit
      Uses the mockup's `.tab-of` / `.ofmenu` pattern; unread dot when a hidden tab needs you.
- [x] Ctrl+Tab tab switching, MRU order, and reopen-closed-tab
      Ctrl+Tab / Ctrl+Shift+Tab cycle most-recently-used; Ctrl+Shift+T reopens the last closed tab.
- [x] Copy mode — keyboard scrollback selection with an on-screen hint bar
      The mockup's `.copymode` bar; arrows/PageUp move, Esc exits.
- [x] Drag a tab to a pane edge to split, with a live split-preview overlay
      The mockup's `.dragging` / `.drop` / `.split-preview` classes.
- [x] Per-tab busy underline — a progress line under a tab while its shell is producing output
      The mockup's `.tprog`.
- [x] Attention ring on the pane that needs you, dimming the others
      The mockup's `.nring` / `.has-ring`, driven by the real terminal bell.
- [x] Tab type icons — the shell's own icon per tab, not one generic prompt glyph
      PowerShell / Command Prompt / Git Bash / WSL each get their own mark.
- [x] Pin a pane so layout changes leave it alone
      The mockup's `.ppin`; a pinned pane can't be closed by accident.
- [x] Save/load layouts as an inline popover instead of a modal
      The mockup's `.sessmenu`: named entries, tab counts, age, delete ×. Same stored data.
- [x] Half-width and phone layouts
      `≥1120px` full · `620–1120px` half (inactive tabs collapse to icons) · `<620px` phone
      (list of terminals, tap one to open it full screen, back button).

## Decisions

- Design contract (resolved: `public/cockpit.css` is the mockup verbatim and is never edited — all app-specific CSS lives in the `<style>` block in `index.html`)
- Network exposure (resolved: 127.0.0.1 only, permanently — it runs real shell commands)
- Agent-cockpit features (declined: out of scope, see above)
- Mockup's auto-drop tab limit (declined: it kills a running shell without asking)
- Bell while you are watching the tab (resolved: logged to notifications only; the attention ring is reserved for a tab you are NOT watching, so it never nags about output you can already see)

## Risks

- Scope drift back into the agent-cockpit demo (medium) — containment: this file is the scope; anything not listed above is a new decision.
- Mockup CSS drift (medium) — containment: `cockpit.css` stays byte-identical to the mockup so the design can be re-diffed at any time.

## Resources

- [Design mockup](../wmux-amirlehmam/design-spec/cockpit.html)
- [Repo](https://github.com/Zbrooklyn/cockpit-terminal)
