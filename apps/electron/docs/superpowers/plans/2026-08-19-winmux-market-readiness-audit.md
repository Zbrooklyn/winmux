# WinMux v0.2.6 — adversarial market-readiness audit

Commissioned 2026-08-19 after Edward hit a bug the 471-check harness never saw
("when I minimized it to a certain size, the x / minimize / maximize buttons
started to disappear") and named the real problem: we have been verifying
assumptions instead of confirming the product.

Method: four parallel read-only code audits (dead controls, failure paths,
user-flow gaps, responsive breakage) plus four live reproduction probes run
against the **installed** app and against **both engines**. Every item below is
either reproduced live (marked PROVEN) or read in the shipped source with a
file:line citation.

## Status: all ten are closed (2026-08-20)

Every item in the Top 10 has been repaired, and each carries a committed check
that goes red with the repair removed. Six more defects were found *while*
fixing these and are closed too (02b, 04b, 06b, 06c, 11, 12) — several of them
found by the new checks rather than by looking, which is the point.

Two lessons outlived the individual fixes and are worth more than this list:

- **Item 2 was undercounted here.** It names Ctrl+F, Ctrl+B and Ctrl+D as keys
  that do nothing, but treats Ctrl+B as a spare key. It was Toggle sidebar —
  a third stranded action. The guard listed its keys in one place and the
  defaults listed the same keys in another, and nothing connected the two, so
  nobody comparing them noticed they overlapped. The fix puts that list in one
  place; the check compares defaults against it structurally, so a fourth
  instance fails without anyone thinking to test for it.
- **Item 9 is the shape to remember.** Like item 5, it worked perfectly from a
  source checkout and existed only in the build we ship. Source-green is not
  evidence for anything that differs when packaged. Its fix was proven by
  building a real installer and running the command out of the packaged tree.

Live state, statuses and evidence for everything still open:
`scratchpad/winmux-problem-register.html` (published as "Every problem we have").

## Why the harness said 471/471

Three structural blind spots, all mine:

1. **The tests encode my expectations.** Every check was written by the same
   person who wrote the feature, so a case I never imagined is a case that is
   never tested. `exit` — the most basic terminal action there is — is not
   typed anywhere in 471 checks.
2. **The tests exercise the paths both engines share.** We ship the Rust
   engine; the Node engine is the fallback. Several defects below exist *only*
   on the shipped engine (missing routes, no shell-exit notifier), and the
   harness passes on both because it never touches the divergent behaviour.
3. **Symptoms were explained away.** During the FB arc I recorded "Ctrl+D
   keyboard split didn't work in probe → use the CLI instead" and moved on.
   That was defect #2 below, reported by the product to me, and I filed it as a
   test artifact.

Fixing the tests is not the fix. The fix is that a claim of readiness has to
come from adversarial use of the built artifact, not from a suite that agrees
with its author.

## Top 10, ranked by likelihood x damage

### 1. Typing `exit` leaves a fake-alive tab (shipping engine only) — CLOSED (034c35f, check `exittruth`)
Rust core has no shell-exit notifier: the meta frame carries no `exited` field
and the socket is never closed (`core/rust/crates/winmux-core/src/main.rs:608-611`,
`:537-560`). Node does it correctly (`server.cjs:1799-1809`), so the client's
`[session ended]` path (`app.js:2326`, `:2391-2396`) is dead code in production.
Measured: after `exit`, terminal shows no end marker, engine session count stays
1 -> 1, sidebar still reads "1 session · idle", keystrokes vanish into a dead
PTY. Reload replays a corpse as a live session.

### 2. Ctrl+F, Ctrl+B and Ctrl+D do nothing, and the app teaches all three — CLOSED (a0339b1, check `keytruth`) — and it was THREE actions, not two: Ctrl+B was Toggle sidebar
`app.js:4927-4931` hands those three chords to the shell whenever the terminal
has focus — which is always, since `activateTerm` focuses it (`:1644`). The
dispatch at `:4936` is never reached. They are advertised in the F1 cheat sheet
(`:4561`, `:4563`, `:4565`), the palette (`:4689`-`:4698`) and Settings ->
Shortcuts, which even offers Rebind. The pane buttons the code comment claims
are the fallback were hidden by `index.html:192`. Measured: Ctrl+F no find bar,
Ctrl+B no sidebar toggle, Ctrl+D no split; Alt+T works (method is sound).
In a WSL/bash tab Ctrl+D reaches the shell as EOF and ends the session.

### 3. Splitting a small window pushes the window controls off-screen — FIXED in v0.2.7
Edward's bug. The window is frameless (`electron/main.ts:111-116`), so `.wc` is
the only close button that exists. `.ptabs` has no wrap and no overflow, and
`.pane` clips (`cockpit.css:94`). At the enforced 720px minimum, one split
leaves ~228px per pane against ~285px of unshrinkable chrome. Measured at 720px:
close button's right edge lands at 841px — 121px past the window edge. Two
splits: 909px. No close, no minimize, no maximize; Alt+F4 only.
Note the narrow-mode rule `index.html:277` is NOT the cause here (720px min
never reaches narrow) but is a live trap on touch-primary hardware, where
`isPhone()` keys off *height* (`app.js:4962-4966`).

**Fix (e059cfc, shipped v0.2.7).** `placeWinctl()` no longer appends `.wc` into
the rightmost pane's control cluster; it appends to `.cockpit` itself, absolutely
positioned top-right, out of reach of any pane geometry. The rightmost pane gets
`.wc-host` and reserves `--wcw + 1px` of right padding on its `.ptabs` so tabs
never slide underneath. Pass-after on the installed 0.2.7 at 720px with five
panes: min/max/close all inside the viewport and each is the element hit at its
own centre; close right edge = 720/720. New `winctl` harness check (12
assertions) walks 720x480 / 900x620 / 1440x900 x 1..4 panes so this cannot
regress silently.

### 4. A slow health check silently strands every running shell — CLOSED (5f5eb4e, check `nostrand`)
`electron/server-host.ts:35` gives `/api/info` 1200ms. Miss it (AV scan, Dropbox
sync, cold page-in) and a second engine spawns; the Rust core walks to the next
free port instead of failing (`main.rs:377-388`) and overwrites `instance.json`
— the one file in the codebase that skips the tmp+rename pattern (`:456`).
Result: empty workspace, every shell/agent/unsaved scrollback stranded on an
unreachable detached engine that nothing will ever kill, both engines then
fighting over the same workspace and backlog.

### 5. Four visible features are broken only in the shipped build — CLOSED (46a9ad5, check `shipped05`)
The Rust engine is missing routes and fields the UI calls, and every call site
fails silently: **Changes tab** shows "Could not read changes" (no `/api/git`
in Rust at all); **"Start when I log in"** is a switch that cannot move (no
`/api/autostart`, empty catch at `app.js:4381`); **Diagnostics** — the screen we
send confused users to — prints "undefined · undefined" and "NaNm NaNs"
(`main.rs:910-942` omits the fields `app.js:4632-4671` renders unguarded);
**the update badge can never light** (`main.rs:881-891` hardcodes
`updateAvailable:false`). None of this reproduces from a source checkout,
because `npm start` runs the Node engine.

### 6. Saving a project can silently overwrite a different project — CLOSED
The path is a slug of the name with no existence check (`server.cjs:962-973`);
`:967` reads the old file's `created` back out, so the code knows a file is
there and overwrites anyway, reporting "Project saved". "Client A / Prod" and
"Client A Prod" collide. Worse unattended: `migrateLayoutsOnce()`
(`app.js:3777-3789`) runs on first boot after upgrade and re-saves every legacy
layout by name, overwriting same-slug project files with no prompt.

### 7. Dismissing the Rebind dialog by clicking outside it kills the keyboard — CLOSED
`rebindShortcut()` (`app.js:3532-3557`) wires its `cleanup()` to Escape, Cancel
and success — but not to the shared `.ovl` backdrop dismiss (`:3447-3449`) that
every other dialog uses. Click the dimmed area: the dialog closes looking
normal, `rebindCapture` stays true, and a document-level capture listener keeps
swallowing every keystroke app-wide. The first modified chord pressed to escape
— Ctrl+C by reflex — is written into the keymap and persisted, and from then on
Ctrl+C never reaches any shell again, across restarts.

### 8. Closing a reconnecting tab spawns invisible orphan shells — CLOSED
`killShell` (`app.js:1569-1573`) only sends the kill if the socket is OPEN — it
isn't, during a reconnect — and never clears the retry timer armed at `:2420`.
`connect()` has no `t.closing` guard (`:2288`), though two of the three sites
that need it have one. Restart the engine, tidy up 10 dead tabs, get 10
invisible PowerShells with no tab, no sidebar row, and no way to reach them.

### 9. The CLI the onboarding teaches does not exist on an installed copy — CLOSED (c71a2c1, check `clihere`), proven from a packaged build
The agents guide presents `winmux agent spawn "..."` as a core pillar
(`index.html:1044`) and `docs/agent-integration.md:50` states the CLI "is on
PATH when WinMux is installed". Nothing puts it there: no NSIS include, no
shim, and `bin/**` isn't in `asarUnpack` (`package.json:60-71`) so it's sealed
inside `app.asar` and can't even be run by full path. Confirmed against the
real install directory — no `bin/`, no `winmux.cmd`.

### 10. A corrupt config is silently replaced instead of reported — CLOSED
`readConfig()` swallows parse errors and returns `{}` (`server.cjs:298-301`);
the next settings change merges onto that empty base and atomically writes it
(`:879-885`), destroying every imported theme and keybinding — and answers
`{ok:true}`. The file is explicitly advertised as hand-editable (`:288-289`).
An unparseable file and an absent file are treated as the same state, and
recovery overwrites the evidence. Same on the Rust side (`main.rs:1340-1342`).

## Also real, below the line

- node-pty failing to load kills the app before any error UI can run — a
  top-level `require` in `electron/main.ts:10` runs before `whenReady`, so the
  "could not start its engine" dialog at `:135-140` never fires. Affects Rust
  builds too, which never use node-pty.
- `spawn()` for the engine has no `error` listener (`server-host.ts:79-91`); an
  AV-blocked binary throws an uncaught exception past the try/catch that was
  written to show the friendly dialog.
- Two immortal OS threads leak per closed tab on the Rust core, against a
  documented-unreliable ConPTY EOF (`main.rs:537-575`, admission at `:420-422`).
- The control websocket reconnects forever at a flat 1500ms with no backoff —
  ~57,600 failed connects/day after an engine dies (`app.js:5540-5559`), while
  the pty socket next to it does exponential backoff correctly.
- Split has no visible button anywhere (`index.html:192`) in a multiplexer.
- The fleet list — the product's core claim — ships collapsed and never
  remembers being expanded (`app.js:982`, never persisted).
- The agents guide's own "Show me the sidebar" button does nothing when the
  sidebar is already open, which is the shipped default (`app.js:5236-5240`).
- Onboarding promises "Approve or Deny right from the sidebar"; only Approve is
  rendered there (`app.js:1101`), Deny lives a click deeper and is called
  "Reject".
- Nothing in the UI ever says which of the four side-by-side apps you are
  running — so the update badge would send a Rust/Tauri/Node user to install a
  different app rather than upgrade theirs.
- A project whose folder moved opens silently in your home directory with no
  warning (`server.cjs:1859-1860`).
- README contradicts itself on the engine (line 16 vs 44), on Node being
  required (line 30 vs 87), and documents `winmux open <file.json>` for a file
  format the CLI rejects. CHANGELOG stops at 0.1.0 while tags run to 0.2.6.

## What has to change in how we work

- **Readiness is proven against the installed artifact, on the shipped engine,
  by trying to break it** — not by a suite whose author also wrote the feature.
- **Every silent failure becomes a visible one.** Items 1, 5, 7, 8 and 10 all
  share one shape: something fails and the UI keeps looking healthy. A control
  whose endpoint 404s should disable itself; a write that didn't happen should
  never report success.
- **Divergence between the two engines is a first-class test axis.** Passing on
  both proves nothing when the check only exercises what they share.
- **A symptom seen during development is a bug report until proven otherwise.**
  Item 2 was in my own notes as a probe quirk.

No code was changed in this audit. Nothing here is scheduled — Edward decides
what gets fixed and in what order.
