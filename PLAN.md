# WinMux — PLAN

> A real terminal multiplexer for Windows that wears the wmux cockpit design.

Status: Phase 1 verified — 22/22 checks pass in the real app
Version: v1.0
Goal: The cockpit mockup, made real, around actual PowerShell — every visible control does something.
Constraint: The server runs real shell commands. It binds 127.0.0.1 always; phone access is a switch in Settings, Tailscale-only, and key-gated.

## What this project is

`WinMux` takes the design mockup at `wmux-amirlehmam/design-spec/cockpit.html` — which is a
click-through demo with fake terminal rows — and makes it a working terminal. Real shells (PowerShell,
Command Prompt, Git Bash, WSL) run behind xterm.js inside the mockup's chrome. You open it in a browser
at `http://127.0.0.1:8799`.

**The scope is the mockup's terminal chrome, made real.** Nothing else.

- `server.cjs` — static files locked to `public/`, plus a WebSocket at `/pty` that spawns one `node-pty`
  shell per connection. Binds `127.0.0.1` only by default, deliberately, because it executes real commands.
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

## Using it from your phone — Settings → Phone (off by default)

Opening this page gives you a shell on this PC, so reaching it *is* controlling the machine. It
therefore listens at **two separate doors**, never one merged one:

- **The desk door** — always open, always `127.0.0.1`. No key, because only this PC can knock.
- **The phone door** — closed until you flip **Settings → Phone → "Use on my phone."** It then binds
  the **Tailscale address only** (never `0.0.0.0`), every request must carry a key, and the panel shows
  a **QR code** you scan with your phone camera plus a Copy-link button. Flip it off and the link dies
  immediately, dropping any phone terminals with it.

**The phone door can only be opened or closed at the PC.** Loading the page over the phone link shows
the switch greyed out and `POST /api/phone` returns 403 — so someone holding the link can never widen
their own access.

Tailscale already encrypts the traffic and only admits your own devices; the key is the second lock in
case a device is lost. The key is new every time you switch it on. `CT_REMOTE=1 node server.cjs` just
pre-opens the same door at startup — it is a shortcut, not a separate mode.

**Verified in the real app (12/12):** the switch starts off and says so · flipping it on renders a real
152×152 QR and a `http://100.120.237.49:<port>/?k=<32-hex>` link · that link ran a real PowerShell
command from a phone-sized browser (`phone says MINISFORUM`) · the phone got 403 on the toggle and a
disabled switch that explains why · the label never contradicts the switch · flipping off killed the
link. Auth matrix separately verified: no key 401, wrong key 401, right key 200 + HttpOnly cookie,
asset without cookie 401, path traversal 404, `/pty` without key 401, with key 101.

**If the phone door can't open, the app says so and stays up.** Two defects found while verifying the
rename, both fixed and re-verified:

- **It used to kill the whole app.** If something else already held the Tailscale side of the port,
  the failure went unhandled and the server exited — losing every open terminal. Now the failure is
  caught on both listeners, the desk door keeps serving, and the switch stays off instead of lying.
  Regression 6/6 under the real condition.
- **The reason was invisible.** The failure only bumped the notification bell, while the person was
  standing in Settings → Phone watching a switch that appeared to do nothing. The reason now renders
  beside the switch in plain English, clears when you come back to the tab, and is still logged to the
  bell. Measured 7/7 (renders 460×57 at the error colour, `role="alert"`, under the switch).

On this machine `tailscaled` itself listens on `100.120.237.49:8799`, so phone access can't be turned
on while WinMux runs on the default port — that is exactly the case the message above explains.
Verified free for the tailnet listener: 9911, 9912, 9913.

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
- Network exposure (resolved: 127.0.0.1 always — it runs real shell commands)
- Phone access (resolved: a switch in Settings → Phone, not a startup flag — @edward expected a setting and he was right. Two separate listeners: the desk door always on 127.0.0.1, the phone door bound to the Tailscale address only and key-gated on every request; never `0.0.0.0`. Built and verified 12/12; turning it on is @edward's call, because the link is a shell on his PC)
- Onboarding the phone (resolved: a scanned QR code, not a typed 32-character key — nobody types a key correctly on a phone)
- Who may open the phone door (resolved: the PC only. The phone link renders the switch disabled and the API returns 403, so a leaked link can never widen its own access)
- Agent-cockpit features (declined: out of scope, see above)
- Mockup's auto-drop tab limit (declined: it kills a running shell without asking)
- Name (resolved: **WinMux** — @edward's call. A terminal multiplexer for Windows, in the tmux lineage. Renamed across the app, the package, the plan, and the repo)
- Where the name shows on the desktop (resolved: the browser tab title and the `v1.0` chip only. The mockup reserves no brand slot in the sidebar footer — measured 51px of spare room against a ~50px word — so the in-app brand mark lives in the phone header, exactly as the design does it)
- A failure the person can't see (resolved: any refusal to flip the phone switch renders its reason beside the switch, not only in the bell)
- Bell while you are watching the tab (resolved: logged to notifications only; the attention ring is reserved for a tab you are NOT watching, so it never nags about output you can already see)

## Risks

- Scope drift back into the agent-cockpit demo (medium) — containment: this file is the scope; anything not listed above is a new decision.
- Mockup CSS drift (medium) — containment: `cockpit.css` stays byte-identical to the mockup so the design can be re-diffed at any time.

## Resources

- [Design mockup](../wmux-amirlehmam/design-spec/cockpit.html)
- [Repo](https://github.com/Zbrooklyn/winmux)
