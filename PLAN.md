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

## Correction — the sidebar is groups, and always was (2026-07-26)

An earlier version of this file listed the sidebar as out of scope, calling it "a Claude session-fleet
browser … never discussed for this project." **That was wrong**, and it is the reason WinMux shipped a
flat terminal list where a group list belongs.

The design contract says otherwise, in three places:

- The mockup's sidebar is titled **Projects**. Each `.prow` is a *container*, not a terminal: it carries
  `data-switch="<name>"`, a folder glyph with an aggregate status dot, a sub-line reading
  `"N sessions · M working"`, and a `.pexpand` chevron that reveals that group's session rows inline.
- `switchProject()` (`cockpit.html:625`) rewrites the **top tab strip** to the clicked group's sessions,
  capped at `MAX_TABS = 10`. Side = groups, top = that group's terminals.
- `design-spec/GAP-ANALYSIS.md` calls the sidebar model "**the single highest-leverage decision**" and
  records it **resolved**: project-grouped, collapsed by default, row-click filters tabs, arrow expands
  sessions inline.

So the two-level model is a settled decision, not a new feature. **It is in scope.** One owner decision
refines it: a group is **just a name** — a named container the user creates and renames, not a folder.

Still genuinely out of scope (agent-cockpit demo features, never discussed for a terminal):

- Orchestration panel (multi-agent run tracking)
- Browser tab, markdown tab, diff-as-a-tab
- Tutorial / onboarding overlay

If any of those is wanted later it is a new decision, not a leftover from this build.

## Already done (working, verified)

Real PTY shells · tabs · 2D splits (right/down) with drag dividers · zoom · close pane/tab with confirm ·
find in scrollback (Ctrl+F) · copy/paste · rename tab · context menus · broadcast input · command palette ·
settings (theme/font/cursor/scrollback/behaviour) · keyboard cheat sheet (F1) · diagnostics · notifications
with badge · changes dock (git diff) · save/load layout · sidebar list with live status deck (currently a
**flat terminal list — not the group list the contract calls for**, see Correction above) ·
light/dark themes.

## Proving it still works — `npm run verify`

One command, **no arguments**:

```
npm run verify          # everything
npm run verify -- phone # one group
npm run verify -- --headed
```

`verify.cjs` starts its own servers (borrowing one that's already listening rather than killing it),
picks the right port for each scenario, drives the real app in one shared browser, and writes
screenshots to `verify-out/`. It exits non-zero if anything fails, and prints **SKIP with a reason**
rather than a false pass when a scenario can't be reproduced on this machine.

The three ports are deliberate. `8799` is the *busy* one — tailscaled already owns its Tailscale side,
which is exactly what makes it the fixture for "turning phone access on must fail politely instead of
killing the app." `9912` is the *free* one, where the phone flow is proven end to end against a real
shell. `9911` belongs to the `remote` group alone, which really opens the phone door — sharing a port
would have two groups fighting over one switch.

**67/67 as of Phase 2.** The `remote` group is the one that talks to the Tailscale address rather than
`127.0.0.1`, because a remote claim proved on the desk door is not proved at all.

A test that needs an argument is a defect: every argument is a chance to invoke it wrong and burn a
whole browser run. If you add a behaviour, add its check here in the same commit.

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

## Phase 2 — Remote access that actually works

Objective: the phone link is something Edward can genuinely use, not a feature that demos once.
Gate: a real command runs on this PC from a phone-shaped browser over the Tailscale address, and the
server is still there an hour later.

Three defects stood between "the feature exists" and "he can use it":

- [x] **The default port could never open the phone door.** Binding `127.0.0.1:8799` succeeds, which
      says nothing about `100.120.237.49:8799` — and `tailscaled` permanently owns that one. So the
      default gave a healthy-looking app whose phone switch could never turn on. With no `PORT` set the
      server now checks **both faces** of each candidate and moves to the first port that can host both
      doors, saying why it moved. An explicit `PORT` is still obeyed exactly — `verify.cjs` depends on
      actually getting the busy port to test the polite failure.
- [x] **Nothing stayed running.** Every server died with the shell that launched it, so a link never
      survived long enough to be worth scanning. `winmux.ps1 start` launches node hidden and detached,
      reads the port back out of its own log rather than assuming one, and records pid+port so `status`,
      `link`, and `stop` work from any other shell. Proved by asking a shell that did *not* start it:
      `pid 29392  http://127.0.0.1:9912`, `phone access: ON (bound to 100.120.237.49:9912)`.
- [x] **No proof from the tailnet side.** The old checks drove the link but never tested a missing or
      wrong key, so "it works remotely" rested on the happy path. The `remote` group now does the whole
      matrix over the Tailscale address: 401 bare · 401 wrong key · 200 + HttpOnly, SameSite=Strict
      cookie with the real one · cookie alone authenticates · 403 when the link tries to widen its own
      access · QR served as real SVG · `tailnet says MINISFORUM` from a real PowerShell shell · the
      address stops answering entirely once the switch is off.
- [x] **The harness was photographing the key.** `phone-on.png` captured both the printed link and a
      scannable QR. Both are blanked before the shutter and an assertion fails if anything key-shaped
      survives — these images get shown to people.

A fourth surfaced the moment @edward actually used it:

- [x] **The refusal was a dead end.** He typed the tailnet address by hand rather than scanning the QR
      and got `WinMux: this link needs its access key.` — correct security, useless instruction: it
      names the problem and hides the fix. A person (`Accept: text/html`) now gets a branded page that
      says where the key lives — Settings → Phone → scan the QR — and warns that the key rotates every
      time the switch is flipped, so a saved bookmark stops working. Scripts, assets, and the websocket
      still get the one-line refusal, so nothing downstream changed. The page loads no external asset
      on purpose: everything is behind the same door it is refusing. Measured on a 384px phone —
      3 steps, accent `rgb(138, 92, 245)`, no sideways scroll. (proof: `verify-out/remote-needs-key.png`)

Left to @edward (not a task): starting WinMux automatically at logon needs a one-time elevated command,
which cannot be self-granted. Until then it runs until the next reboot, or until `.\winmux.ps1 stop`.

## Phase 3 — Who gets in, and on whose word

Objective: @edward stops re-scanning a QR after every restart, without quietly handing a shell to every
device on his tailnet.
Gate: a device that has scanned once still gets in after a restart and a key rotation; a device that
never scanned still gets the "One step left" page; the tailnet-trust switch is OFF on a fresh install,
can only be flipped at the PC, and says plainly what it does.

The question that started it: *"If you're using Tailscale, it's always secure because it only works if
you're on that network — so we should have a switch that it always works on the Tailscale network."*
Half right, and the half that is wrong is measurable. `tailscale status` on this machine lists **seven**
devices, and one of them — `rugking-pad-pro-1`, `100.104.238.81` — belongs to `davidshamosh16@`, not to
@edward. A personal tailnet is a room he shares, not a room he owns. So "no key on the tailnet" is not
"only me"; it is "me, David, and every device either of us adds later."

The real complaint underneath was never about keys. It was that the key **rotates on every start**, so a
scanned QR dies with the next restart. That is fixable without widening anything.

- [x] **Trusted devices — scan once, not once per restart.** @claude
      A phone that presents a valid key gets a second, longer-lived cookie identifying the *device*
      (`ct_dev`), recorded in `.winmux-devices.json`. Auth becomes: key, **or** a known device, **or**
      tailnet-trust. Device ids survive restarts and key rotation — that is the entire point — so the QR
      is a one-time act per phone rather than a ritual. Devices are listed in Settings → Phone with when
      they were first and last seen, and can be forgotten individually or all at once; forgetting closes
      that device's live terminals rather than leaving a session running behind a revoked trust.
      Files: `server.cjs` (`trust` store + `authed()` + `/api/phone/devices`), `public/index.html`
      (device list + Forget), `.gitignore`.
      (need: nothing from @edward — the default behaviour is unchanged for a device that never scanned)
      (proof: `verify.cjs` group `trust` — the scan mints `ct_dev` with `Max-Age=31536000`, the same
      phone is still admitted after a key rotation *and* after the server process is really killed and
      restarted, and forgetting it closes its live terminal and sends its next request back to 401)

- [x] **The tailnet-trust switch, off by default.** @claude
      A second switch in Settings → Phone: *any device on your Tailscale network gets in without a key*.
      Persisted, so flipping it is a decision and not a chore, but **OFF on a fresh install** and only
      changeable from the desk door — the phone door returns 403 exactly as it already does for the phone
      switch, so a leaked link can never widen its own access. The label names the consequence in the
      owner's words, including the count of devices currently on the tailnet, because "7 devices" is the
      fact that makes the choice real. Turning it back off must not evict devices that scanned properly.
      Files: `server.cjs` (`trustTailnet` in the trust store + POST handler), `public/index.html`.
      (need: @edward decided — build both, tailnet switch ships OFF)
      (proof: `verify.cjs` group `trust` — OFF on a fresh trust store, 403 from the phone door, and the
      rendered line counts the tailnet ("all 6 other devices … without scanning anything") and warns
      rather than reassures. **Not proved: a keyless request actually being admitted with the switch ON.**
      It was flipped with the phone door shut on purpose — the tailnet holds a device that is not
      @edward's, and no test is worth opening a real keyless shell to a stranger's iPad)

- [x] **Refuse a port that Tailscale already tunnels into.** @claude
      Found while answering the question, and worse than the thing being asked about: an existing
      `tailscale serve` rule maps `talkos.tail9f5d16.ts.net:8810` → `127.0.0.1:8799`. Port 8799 is
      WinMux's **default desk-door port** — the door with no key that can flip the phone switch. Bound
      there, the desk door is reachable by the whole tailnet, David's iPad included, and the
      `bindable()` check cannot see it because the proxy terminates on loopback. Proved rather than
      assumed: a probe server on `127.0.0.1:8799` answered `PROBE-REACHED-LOOPBACK` through
      `https://talkos.tail9f5d16.ts.net:8810/`. WinMux dodged it today only by accident. `pickPort()`
      must skip any port that `tailscale serve`/`funnel status` names as a proxy target, and an explicit
      `PORT` that is tunnelled must refuse to start — the one case where an explicit port is not obeyed,
      because obeying it hands out a keyless shell.
      Files: `server.cjs` (`tunnelledPorts()` + `pickPort()` + startup refusal), `verify.cjs` (fixture).
      (need: nothing — @edward's other `tailscale serve` rules belong to other projects and are not
      touched; WinMux moves out of their way rather than rewriting his config)
      (proof: `verify.cjs` groups `port` and `reason` — a tunnelled port is skipped by `pickPort()`, an
      explicit tunnelled `PORT` refuses to start, and the refusal renders next to the switch in words)

- [x] **The harness stops depending on tailscaled's accidents.** @claude
      `PORT_BUSY = 8799` works only because `tailscaled` happens to hold that tailnet address, which is
      why the `busyport` and `reason` groups *skip* on a machine where it does not — and a skip is not a
      pass. The harness will bind the tailnet face of an otherwise-free port itself, making the collision
      deterministic, removing two conditional skips, and freeing the fixture from the same serve rule
      Phase 3 now refuses.
      Files: `verify.cjs` (`PORT_BUSY` → self-made collision).
      (need: nothing)
      (proof: `node verify.cjs` finishes **118/118, zero skips, exit 0**. The three groups that mutate
      real state — `remote`, `phone`, `trust` — each own a port now, so none of them can borrow
      @edward's live WinMux and skip instead of testing)

- [x] **Prove it, in the states that matter.** @claude
      New checks, measured not asserted: a device that scanned once is still admitted after the token is
      rotated · a device with no cookie and no key still gets 401 + the "One step left" page · the
      tailnet switch defaults OFF on a fresh trust store · POSTing `trustTailnet` from the phone door
      returns 403 · with it ON a bare request gets 200 · forgetting a device makes its next request 401 ·
      a tunnelled port is refused at startup with a readable reason. Plus screenshots of the new Settings
      panel in both colour schemes, shipped to @edward.
      (need: nothing)
      (proof: the `trust` group, 48 checks over ten stages — fresh install · the scan · the guest list ·
      the phone door's read-only guardrails · a key rotation · a real process kill and restart · a
      stranger turned away · a second phone getting a working shell · the rendered panel · forgetting as
      revocation · the tailnet switch. The panel screenshots were measured, not eyeballed: the settings
      pane is `overflow-y:auto`, the last remembered phone scrolls fully into view, its Forget button is
      a real target, and the "dark"/"light" shots are the resolved themes (`#1e1e1e` / `#ffffff`), not an
      emulated OS hint that the app's attribute override would have beaten. Shipped to @edward)

## Phase 4 — A session that survives the trip

Objective: leaving WinMux and coming back finds the same shell, with the same work in it. Today it
does not, and the app says so in the worst possible way.

Gate: a socket reaped mid-session — exactly what a phone browser does to a backgrounded tab —
reconnects on its own and the shell's state is still there; the terminal only ever says the session
ended when the shell genuinely exited.

- [x] Shells outlive their socket @claude
    Every terminal is one pty pinned to one websocket, and `ws.on('close')` kills it. A phone that
    sleeps, a laptop lid, a wifi hop, or a tab left in the background long enough all close that
    socket, so the shell dies and everything in it goes with it. Give each shell a stable id and a
    scrollback buffer, keep it alive for a grace window after its socket detaches, and let a
    returning client reattach by id.
    (proof: `75e8189` — harness `survive` proves a reaped socket leaves the shell running with
    nobody attached, and that closing a tab on purpose still ends its shell rather than leaking it)
- [ ] Revocation cannot be outlived @claude
    The other half of the same contract, and the one thing the survival work made worse: a forgotten
    device is re-admitted by its still-valid key cookie even after its row is deleted, because the
    client now reconnects. `forgetDevice()` has to rotate the phone key; kept devices still enter by
    their own row, so rotation costs them nothing.
    (need: nothing — this is the single failing check, 131/132)
- [x] The client reconnects instead of giving up @claude
    There is no retry anywhere in `app.js` — one `onclose` and the terminal is a dead rectangle
    printing `[session ended]`. Reconnect with backoff, reattach by id, replay the scrollback, and
    retry the moment the tab becomes visible or the network comes back. `[session ended]` is
    reserved for a shell that actually exited; an interrupted one says it is reconnecting.
    (proof: `75e8189` — harness proves the app opens a second socket by itself and the shell's
    variable is still set afterwards, and that it never printed "session ended")
- [x] The harness holds the line @claude
    A check that sets a variable in a shell, reaps the socket the way a backgrounded phone does, and
    proves the terminal comes back with that variable still set — plus the other half, that closing a
    tab on purpose still kills its shell rather than leaking a process.
    (proof: `75e8189` — `verify.cjs survive`, 8/8)

## Phase 5 — The app is simply there, and behaves like a terminal

Objective: WinMux stops being something that has to be remembered and started, and the small physical
habits of a Windows terminal work in it.

Gate: a link saved today still opens the app tomorrow without anyone starting anything, and dragging
a folder in from Explorer puts its path on the command line.

- [x] One address that never moves, running before anyone asks @claude
    The port floated between runs and nothing kept the server alive, so a saved link pointed at
    nothing and the honest state of the app most of any day was "not running" — which from the
    outside is indistinguishable from broken.
    (proof: `2c5272b` — port pinned to 9912 in the launcher, `winmux-autostart.vbs` in the user
    Startup folder; proved cold: stopped the server, ran only the Startup file, it came back by
    itself in 9s on the same port with the phone door still on)
- [x] Drag a folder in from Explorer to get its path @claude
    The muscle memory is: type `cd `, drag the folder in, enter. A browser refuses to tell a page
    where a dropped folder lives, so the server — standing on the same disk — finds it by name and
    contents instead.
    (proof: `52cd700` — harness `drop`, 5/5; screenshots `drop-hint.png` / `drop-pasted.png` shipped
    to @edward. The one link automation cannot originate is a real OS drag — @edward's acceptance)
- [x] Colours nobody chose, replaced by colours measured against the ground @claude
    `themeColors()` named only four values and never the sixteen ANSI slots, so xterm.js fell back
    to Tango — GNOME Terminal's 2006 default, drawn for a mid-grey background. PSReadLine paints
    every command you type in brightYellow (`#fce94f`, a 14.01:1 shout on our near-black) and every
    parameter in brightBlack (`#555753`, 2.38:1 mud). Light mode had 11 of 16 failing outright.
    The luminance windows for the two backgrounds do not overlap, so each mode gets its own set.
    (proof: `11001e3` — three palettes x two modes, all clearing 4.5:1; harness `colour` 12/12,
    reading the colour off the span xterm actually painted after a real PowerShell command; six
    screenshots `palette-{aurora,ash,ember}-{dark,light}.png` shipped to @edward. Which of the three
    ships as default is @edward's eye — Aurora is the current default)

## Phase 6 — The side is groups, the top is sessions

Objective: the sidebar stops being a second copy of the tab bar and becomes what the design contract
always said it was — a list of **groups**, each holding many terminals. Clicking a group changes which
terminals the top tab strip shows. A group is **just a name** you make and rename (@edward's decision,
2026-07-26) — it is not tied to a folder, a repo, or a project on disk.

Gate: with two groups on screen, clicking one swaps the top tabs to that group's terminals and nothing
from the other group is reachable or visible; the arrow on a group row opens its sessions inline
without leaving the group; a terminal opened while "Client work" is selected still belongs to "Client
work" after a browser reload; and on the phone the three screens go Groups → Sessions → Terminal with
a working back arrow at each step.

Everything this phase renders already exists in `public/cockpit.css` and is currently unused —
`.skids`, `.srow`, `.sinfo`, `.srtop`, `.sname`, `.sstat`, `.smeta`, `.sbar`, `.pbar`, `.pu`,
`.pexpand[data-open2]`, `.nsessions`, `.nbar`, `.ncard`, `.ns-list`. **The CSS file is not touched.**
Anything genuinely new goes in the `<style>` block in `index.html`.

- [x] Every terminal belongs to a group, and the group survives a reload @claude
    Today `panes[]` holds terminals directly and there is no group layer anywhere in `app.js`, which
    is why the sidebar can only list terminals. Add the missing layer: a `groups` array of
    `{ id, name, pinned, color }`, an `activeGroupId`, and a `groupId` on every terminal (set in
    `newTerm()`, in the object literal at `public/app.js:~700` that already carries `id`/`paneId`).
    A `visibleTerms(p)` helper returns only the active group's terminals in a pane — every place that
    asks "what is in this pane" goes through it. Existing terminals migrate into a first group named
    `Workspace` so nothing is orphaned on upgrade. Groups, their order, their names and the selected
    one persist to `localStorage` under `ct-groups`, alongside the existing `ct-settings`/`ct-layouts`.
    (need: nothing — this is invisible plumbing, no owner decision in it)
- [x] The sidebar lists groups, not terminals @claude
    `renderSidebar()` (`public/app.js:296-321`) emits one `.prow` per terminal, puts a working
    directory in the sub-line, and repurposes `.pexpand` as a close button — three divergences from
    the contract in one function. Rewrite it to emit one `.prow` per group carrying
    `data-switch="<group id>"`, a folder glyph whose dot aggregates that group's worst status
    (needs-you beats working beats idle), and a sub-line reading `"3 sessions · 1 working"` — or
    `"2 needs you"` when something is waiting, because that is the line worth stealing attention.
    `#sx-count` becomes the number of groups, not `totalTerms()`. The deck counts (working / needs
    you / idle) stay **global across every group** exactly as the mockup has them — the deck is a
    fleet gauge, and scoping it to one group would hide the alert you opened the app for. The header
    word "Terminals" becomes "Groups". Close moves off the row and into the row's right-click menu,
    where closing a whole group belongs.
- [x] The arrow on a group opens its sessions without leaving the group @claude
    Restore `.pexpand` to the job the CSS already gives it: a right-pointing caret that rotates down
    when open (`cockpit.css:392` keys off `[data-open2]`), revealing a `.skids` block of `.srow`
    session rows beneath the group — status dot, name, a status line reading Idle / Working / Needs
    you / Error, and a `.sbar` progress sliver while a command is running. Matches `sessionRowHTML`
    in the reference (`wmux-amirlehmam/design-spec/cockpit.html:506`). Clicking a session row focuses
    that terminal directly. This is the "peek without switching" move — expanding a group must not
    change which group is active.
- [x] Clicking a group swaps the top tab strip @claude
    This is the mechanic @edward described and the reason the phase exists: side = groups, top = that
    group's terminals. `switchGroup(id)` sets `activeGroupId`, then in every pane shows the tab
    elements whose terminal is in that group and hides the rest (`display:none` on `t.tabEl`, the
    terminal host follows), activates the group's most-recent terminal in each pane, and re-renders.
    A pane that would be left showing nothing gets a fresh shell rather than an empty frame.
    Three existing call sites break the moment tabs can be hidden and are patched in the same commit:
    `closeTerm`'s emptiness test `p.terms.length === 0` (`public/app.js:474`) becomes
    `visibleTerms(p).length === 0`, or closing the last tab of the visible group leaves a live pane
    looking dead; the same function's MRU fallback must pick a *visible* terminal; and `hiddenTabs(p)`
    (`public/app.js:524-532`) must skip hidden tabs — a `display:none` tab measures 0×0 at offset 0,
    so once the strip is scrolled every other group's tabs would pile into the overflow menu as
    phantom entries.
    Deliberate deviation, recorded not omitted: the mockup caps a strip at `MAX_TABS = 10`
    (`cockpit.html:625`). WinMux does **not** implement that cap. It already has a working tab
    overflow menu (`tab-of` / `hiddenTabs` / `showOverflowMenu`), so a hard cap would remove working
    capability to imitate a mockup's placeholder data, and silently losing the 11th terminal of a
    group is worse than a scrollable strip.
- [x] Making, naming, and closing a group @claude
    A "New group" button in the sidebar footer (`.sx-foot`, `index.html:191`) next to the existing
    new/save/load buttons: it creates a group, prompts for the name, switches to it, and opens one
    shell in it. Right-clicking a group row offers Rename, Pin, and Close group — mirroring the
    reference's project menu (`cockpit.html:961-964`), and reusing WinMux's existing context-menu
    plumbing rather than inventing a second one. Closing a group closes its terminals, so it asks
    first and says how many it is about to end. The last group cannot be closed — there is nowhere
    for the terminals to go.
    (need: nothing — naming is free-text, which is exactly what "just a name" means)
- [x] The phone gets its middle screen @claude
    On a phone the app can only show one thing at a time, and today it shows a flat list then a
    terminal. The contract's three-screen drill-in — groups, then that group's sessions, then the
    terminal — has never been built: there is no `<section class="nsessions">` in `index.html` at
    all, even though `cockpit.css:250-264` fully styles it. Add it between the sidebar and `.main`:
    a `.nbar` with a back arrow, `#ns-name` for the group name, and `#ns-list` of `.ncard` rows
    (status dot, name, status badge, last line of output). Tapping a group goes to Sessions, tapping
    a session goes to the terminal, and back steps out one level.
    The `data-view` values stay **`projects` / `sessions` / `focus`** exactly as they are. They read
    like leftovers but `cockpit.css:66`, `:251`, `:253` and `:91` all key off those literal strings,
    and the CSS file is never edited. Only the word a human sees changes to "Groups".
- [x] Prove it, on the real thing @claude
    A `groups` scenario in `verify.cjs` alongside the existing eleven, run against a real server on
    its own port: two groups exist; switching hides one group's tabs and shows the other's (read off
    computed style, not appearance); the sub-line arithmetic matches the terminals that actually
    exist; expanding a group does not change the active group; closing the last visible tab leaves a
    live shell rather than an empty pane; a reload restores the group names and the selected group;
    and at phone width the back arrow walks focus → sessions → groups. Then screenshots at desktop
    and phone width, shipped to @edward unprompted (rule 21) — the sidebar is a thing he looks at,
    so appearance is his call and the mechanics above are mine to measure.
    (proof: `node verify.cjs groups` — 29/29 measured assertions pass on :9919, commit d54b6f9. Screenshots shipped 2026-07-26: groups-desktop.png, groups-expanded.png, groups-phone-groups.png, groups-phone-sessions.png, groups-phone-terminal.png in verify-out/. Two defects the harness caught and fixed: a saved layout spanning two groups collapsed them into one, and hidden tabs piled into the overflow menu as phantoms)

## Phase 7 — The finishing pass: cleaner chrome, a kinder keyboard, an honest reload

Objective: close the gaps a real discovery pass found — redundant controls, a keyboard that
fought the terminal, and a reload that silently threw away your shell — so WinMux is genuinely
pleasant to run tools (including Claude, Codex, vim) through.

Gate: the chrome carries no duplicate control, a focused terminal keeps its own keys, and
reopening the page lands back in the running shell with the work intact.

- [x] Drop the redundant chrome and even the spacing @claude
    Diagnostics was reachable four ways; Save and Load were two buttons for one popover; the
    per-pane sidebar-rail icon duplicated three other controls; pin rendered in single-pane where
    it does nothing. All dropped or merged to one Layouts button. The same 28px icon button was
    spaced 6px in the header and 4px in the footer — unified to 6px — the header padding evened,
    and the group count no longer floats to the buttons. cockpit.css untouched.
    (proof: measured — diag/save/load absent, one Layouts button, rail absent, pin display:none
    single-pane, sx-head gap == sx-foot gap == 6px, count margin-left 0; desktop + phone
    screenshots shipped to @edward; 29/29 groups)

- [x] Terminal is king — stop stealing Ctrl+D/F/B from a focused shell @claude
    WinMux's capture-phase shortcuts consumed keys the terminal needs: Ctrl+D (shell EOF, vim
    half-page), Ctrl+F (vim/less page-forward), Ctrl+B (page-back). vim, less and REPLs were
    broken. When a terminal has focus those three now fall through to xterm; each action stays
    reachable from its pane button and the palette. Alt/Meta chords stay WinMux's so keyboard
    tab/pane nav still works — a lower-severity collision left intact by choice (revisit if heavy
    readline/emacs use appears).
    (proof: measured live — terminal-focused Ctrl+B/F/D do not drive WinMux, chrome-focused Ctrl+B
    still toggles the sidebar; behaviour change only, no rendered change; 29/29 groups)

- [x] Reopening the page reattaches instead of orphaning the shell @claude
    A dropped socket detaches for the 10-min grace, but a full reload lost the in-memory session
    id and started a fresh shell, orphaning the old one. The live layout — with each tab's session
    id — is now saved on the way out and restored on load, reconnecting by id; named layouts stay
    templates and strip the sid. Reuses the tested snapshot/restoreLayout machinery, with a new
    committed harness scenario.
    (proof: committed harness `reload` check 4/4 — one shell after reload, detached 0, `$mywork`
    survives; live reload screenshot shipped to @edward)

- [ ] Close the revocation hole so a forgotten device cannot outlive its welcome @claude
    The same open item as Phase 4's "Revocation cannot be outlived" (#153): forgetting a phone must
    rotate the key. This is the binding constraint on the open-source-ready verdict and is what
    turns the failing `trust` harness check green — the last build item before the readiness call.
    (need: nothing — reversible and owned; next in the batch)

- [ ] Open-source packaging + the honest readiness verdict @claude
    README a stranger can follow, a LICENSE, a clean-clone build check, then the market-ready call.
    (need: @edward's answer on decision "Open-source launch" below — it sets whether this phase runs)

## Decisions

- Open-source launch the target? (pending: @edward — if yes, the revocation hole + packaging above
  are required and WinMux hardens to the promotable bar; if it stays a personal tool, packaging is
  skipped and the trust bar is @edward's call. The cost difference is small — mostly a README + LICENSE.)
- Detached-shell grace window (pending: @edward — currently 10 min, so a phone asleep longer loses a
  running job. Keep 10, extend to 30–60 for a commute, or add a per-session keep-alive. A resource-vs-
  lost-work tradeoff, so it is @edward's.)
- Shells surviving a reboot (pending: @edward — true today that they die on reboot, in-memory only.
  Accept + document for v1, or build disk persistence — a much larger change for a rare case.)
- Design contract (resolved: `public/cockpit.css` is the mockup verbatim and is never edited — all app-specific CSS lives in the `<style>` block in `index.html`)
- What a group is (resolved: **just a name** — a container the user creates and renames, @edward 2026-07-26. Not a folder, repo, or path. An earlier reading tied sidebar rows to working directories; that would have made a group something you cannot create on purpose)
- Sidebar model (resolved: **groups on the side, sessions on top** — settled in `design-spec/GAP-ANALYSIS.md` as "the single highest-leverage decision" and recorded resolved there. An earlier version of this file wrongly called it out of scope; see the Correction at the top)
- Tab cap (declined: the mockup's `MAX_TABS = 10` is not implemented — WinMux's existing tab overflow menu already handles a crowded strip, and a hard cap would drop the 11th terminal of a group)
- Deck counters under groups (resolved: stay **global** across all groups, as in the mockup — the deck is a fleet gauge; scoping it to the open group would hide the "needs you" that made you open the app)
- Network exposure (resolved: 127.0.0.1 always — it runs real shell commands)
- Phone access (resolved: a switch in Settings → Phone, not a startup flag — @edward expected a setting and he was right. Two separate listeners: the desk door always on 127.0.0.1, the phone door bound to the Tailscale address only and key-gated on every request; never `0.0.0.0`. Built and verified 12/12; turning it on is @edward's call, because the link is a shell on his PC)
- Onboarding the phone (resolved: a scanned QR code, not a typed 32-character key — nobody types a key correctly on a phone)
- Who may open the phone door (resolved: the PC only. The phone link renders the switch disabled and the API returns 403, so a leaked link can never widen its own access)
- Agent-cockpit features (declined: out of scope, see above)
- Mockup's auto-drop tab limit (declined: it kills a running shell without asking)
- Name (resolved: **WinMux** — @edward's call. A terminal multiplexer for Windows, in the tmux lineage. Renamed across the app, the package, the plan, and the repo)
- Where the name shows on the desktop (resolved: the browser tab title and the `v1.0` chip only. The mockup reserves no brand slot in the sidebar footer — measured 51px of spare room against a ~50px word — so the in-app brand mark lives in the phone header, exactly as the design does it)
- A failure the person can't see (resolved: any refusal to flip the phone switch renders its reason beside the switch, not only in the bell)
- Default port (resolved: with no `PORT` set the server picks the first candidate free on **both** its faces, because a port whose Tailscale side is taken can host the desk door and never the phone one. An explicit `PORT` is obeyed exactly — the busy-port fixture depends on it. Order: 8799, 9912, 9911, 9913, 8800–8802)
- Staying up (resolved: `winmux.ps1 start` runs node hidden and detached via `Start-Process`, so the link outlives the terminal that created it. Logon autostart is @edward's one-time elevated call — Claude cannot self-elevate, and until it is registered WinMux runs only until the next reboot)
- Screenshots of the Phone tab (resolved: the link and the QR are blanked before every capture, and a check fails if a live key survives. A screenshot of that panel is a photograph of a working shell key)
- Arriving without the key (resolved: a refusal must name the fix, not just the problem. @edward typed the tailnet address by hand instead of scanning the QR and got a bare `WinMux: this link needs its access key.` — correct, and a dead end. The phone door now serves a self-contained branded page telling him where the key lives (Settings → Phone → scan the QR) when the request comes from a person (`Accept: text/html`), and keeps the one-line refusal for scripts, assets, and the websocket. Self-contained on purpose: every asset is behind the same door it is refusing. Measured on a 384px phone viewport — 3 steps, app accent, no sideways scroll)
- Trusting the tailnet instead of the key (resolved: **both, with the tailnet switch OFF by default** — @edward's call. His premise was that Tailscale is already the lock, which is true but not sufficient: `tailscale status` shows seven devices on this tailnet and one of them, `rugking-pad-pro-1`, belongs to `davidshamosh16@`. Keyless-on-tailnet therefore means keyless for David. The pain he actually described — re-scanning after every restart — is solved by remembering devices, which does not widen anything. The switch he asked for exists anyway, defaults off, and is flippable only at the PC)
- A `tailscale serve` rule pointed at our own default port (resolved: WinMux moves, @edward's config is not rewritten. `:8810 → 127.0.0.1:8799` already tunnels the whole tailnet into the desk-door default port; proved with a probe server, not assumed. Other serve rules belong to other projects, so the fix is ours to absorb: skip tunnelled ports when choosing, and refuse to start on an explicitly-requested one)
- The door's colour scheme (resolved: it follows the phone, because the app does. `cockpit.css:7` gives WinMux a `prefers-color-scheme: light` block, so the needs-key page hardcoding dark put a dark refusal in front of a light app — two different products. Found by opening the live link in a real browser, not by reading the CSS. Same four tokens, same values, switched on the media query; two checks measure the computed body background and colour in each scheme rather than trusting the stylesheet)
- Bell while you are watching the tab (resolved: logged to notifications only; the attention ring is reserved for a tab you are NOT watching, so it never nags about output you can already see)

## Phase 8 — The third face: a real desktop app (Electron shell)

Status: **Live.** First phase of turning WinMux into a public open-source desktop product
that replaces wmux (design spec: `docs/superpowers/specs/2026-07-27-winmux-electron-oss-product-design.md`;
plan: `docs/superpowers/plans/2026-07-27-winmux-phase8-electron-shell.md`).

Objective: WinMux had two faces — the desk browser and the phone over Tailscale, both clients
of one `server.cjs`. Phase 8 adds the third: a native Windows app. The move that keeps the
phone alive is that the Electron shell does **not** re-implement anything — it boots the exact
same `server.cjs` **in-process** and points a frameless window at the same served cockpit. One
server, three clients. The phone door is untouched.

- **`server.cjs` boots in-process** — the trailing startup IIFE became an exported
  `start(): Promise<{ port, host }>` plus a `require.main === module` guard. `node server.cjs`
  auto-starts exactly as before (the phone path is byte-for-byte unchanged); Electron `require`s
  it and calls `start()` to learn the chosen port. Proved by the whole existing harness staying
  green on the server path, and by `remote` — a real phone-viewport browser running a live
  PowerShell command over the Tailscale address — still passing after the refactor.
- **A frameless native window** (`electron/main.ts`) loads `http://127.0.0.1:<port>/` — the same
  cockpit the phone loads. New code is TypeScript compiled to `dist-electron/` (gitignored);
  `server.cjs` and `public/*` stay plain JS and, apart from `start()`, untouched.
- **Native window controls, no new UI** — the cockpit's existing `.wc` min/max/close buttons
  already called a `window.winmux` bridge that was inert in a browser. `electron/preload.ts` now
  injects the real bridge (`{ isElectron, minimize, maximize, close }`) over IPC to the main
  process, so the same buttons drive the real window. Measured: maximize toggles, minimize works,
  close quits.
- **The frozen contract already had the drag regions.** `cockpit.css` (frozen) already marks
  `.ptabs` as `-webkit-app-region: drag` and every interactive cluster (`.pctrls`, `.wc`,
  `.tab-of`, `.ptab`) as `no-drag` — inert in a browser, live under Electron. Measured in the
  real frameless window (`data-electron`, `mode:full`): the tab bar drags, every control stays
  clickable. So no index.html supplement was needed — the plan's assumed addition would have
  been dead CSS.
- **The harness grew a third-face check.** `verify.cjs` gains an `electron` check: it launches
  `dist-electron/main.js` in a new `WINMUX_SMOKE` mode (zero effect on production launches) that
  self-checks the rendered cockpit, writes a JSON verdict + `verify-out/electron-shell.png`, and
  quits. Playwright's `_electron` launcher hangs on the CDP handshake in this environment, so the
  shell is driven directly via `require('electron')`. `npm run verify` now builds the shell first.
  Green: 7/7 electron assertions, in isolation and in the full run.

Deferred to later phases (per the spec): `winmux` CLI + RPC (Phase 9), the webview+CDP browser
panel and markdown viewer (Phase 10), agent integration (Phase 11), and OSS distribution —
installer, auto-update, winget, README/LICENSE, public repo (Phase 12).

## Phase 9 — Drive it from the command line (`winmux` CLI + control channel)

Status: **Live.** (spec: the OSS-product design doc; plan:
`docs/superpowers/plans/2026-07-27-winmux-phase9-cli-rpc.md`)

Objective: at parity with wmux's CLI, a `winmux` command scripts the *running*
app — open tabs, split, type into a terminal, read what's on screen — so a human
or an agent (Claude) can drive the cockpit.

The shape of the problem: the server is passive and owns the pty `SESSIONS`; the
*app* owns layout (groups/tabs/panes and which terminal is "active"). So the CLI
can't talk only to the server — it has to reach the running app.

- **Two hops, one command.** The short-lived CLI does `POST /rpc` on the desk
  door. The server forwards the command over a persistent `/control` WebSocket to
  the connected app, which runs it against the real layout and replies; the reply
  travels back out the CLI's HTTP response. `/control` and `/rpc` live only on the
  desk door (127.0.0.1) — the phone can never drive the app.
- **Discovery.** `start()` writes `~/.winmux/instance.json` with the live port, so
  `winmux` finds a running app without being told; removed on exit.
- **The command set** (`bin/winmux.cjs`): `list`, `new-tab [shell]`,
  `split [right|down]`, `send <text> [--id N] [--enter]`,
  `read-screen [--id N] [--lines N]`, `focus <id>`, `--json`. `browser`/`agent`/
  `markdown` are reserved with a "later phase" notice (Phase 10/11).
- **A ws gotcha fixed along the way.** Two `{server,path}` socket servers on one
  HTTP server fight over the upgrade event, so the desk-door `/pty` and `/control`
  became `noServer` behind one upgrade router. Phone door unchanged.
- **Proof.** The harness gains a `cli` check: a headless page is the app, the
  `winmux` binary is spawned as a child process, and it must make that page act —
  `list` sees the terminal, `send` runs a command `read-screen` then finds on
  screen, `new-tab` grows the count, and with no app connected the CLI fails
  clean and fast. `verify-out/cli-drove-it.png`.

Deferred to later phases: agent integration (Phase 11), OSS distribution —
installer, auto-update, winget, LICENSE, public repo (Phase 12).

## Phase 10 — The two surfaces wmux was Electron for (browser panel + markdown)

wmux's one genuinely Electron-hard feature is a *controllable* browser panel — not an
iframe, but a real page you can navigate, snapshot, and click by script. WinMux gets it
from Electron's `<webview>`, driven through the same `/rpc → /control` chain the CLI
already uses, so no new transport is invented.

- **Browser panel** (`public/app.js`, `public/index.html`, `electron/main.ts`). `webviewTag`
  is enabled on the window; the app mounts a `.wmb` overlay holding a `<webview>` docked
  right. Navigation goes through the `dom-ready` event (a `src` change while the panel is
  hidden is dropped by Electron), so opens queue until the view is ready. `runControl('browser')`
  handles `open/url/back/forward/reload/snapshot/click/screenshot`; `snapshot` tags every
  interactive node `@e1..@eN`, `click` acts on a ref. Web/phone mode never sees a webview —
  the panel simply does not mount there.
- **CLI** (`bin/winmux.cjs`): `winmux browser open <url> | snapshot | click <@ref> |
  back|forward|reload|url | screenshot [file]`.
- **Markdown viewer** (`server.cjs` `/api/md`, `public/app.js`, `public/index.html`). `winmux
  markdown <file>` opens a `.wmm` read surface; the server reads the file, the app renders a
  small markdown subset, and it re-pulls every 1.5s so a file the agent is writing updates
  live without a reopen. Works on plain web — no webview needed.
- **Proof.** The `electron` check now drives the browser panel inside the headless smoke run
  over the real `/rpc` path: it opens a `data:` page, snapshots it (asserts ≥2 `@refs`), and
  clicks one — all green. A new `markdown` check proves `/api/md` (read + clean not-found),
  the `winmux markdown` verb, the rendered surface, and the live-update on file edit.
  `verify-out/markdown.png`.

Deferred to later phases: agent integration — Claude Code hooks, fleet/transcript view,
shell-integration cwd/git (Phase 11); OSS distribution — installer, auto-update, winget,
LICENSE, public repo (Phase 12); launch hardening (Phase 13).

## Upcoming phases (roadmap — not yet built)

The three faces, the CLI, the browser panel, and the markdown viewer are done and
proven (Phases 1–10). What remains to reach a public v1.0 launch, and one thing
beyond it:

### Design law & north-star — calm surface, powerful underneath (Edward, 2026-07-28)

**This governs every feature decision from here on.** Edward's call, locked.

**The law:** the UI stays exactly as calm and polished as it looks today. *The polish is
the adoption moat* — the market is full of dev tools that vomit panels, gauges, and graphs;
a terminal that stays quiet and just works is the rare one everyone wants to adopt. A
cluttered cockpit is the amateur floor, not the ceiling. **Adding power must not add
surface.** Any feature that needs new chrome ships as *summoned / progressive*, never as
default weight.

**The north-star:** WinMux is not just a terminal — its parts (Claude-transcript reader,
fleet view, browser control, scriptable CLI, phone cockpit over Tailscale) already sketch a
**calm agent-operations control plane**: one place to watch, drive, and hand off a fleet of
AI agents across every device you own. The ambition above launch-ready is to *become* that —
without the surface ever getting busier.

**How power is added without clutter (the four mechanisms):**
1. **Existing rows carry state.** The sidebar (groups → sessions) already *is* the fleet
   tree. A running agent just gives its existing row a quiet status dot — working /
   waiting-for-you / done / errored. "Watch the fleet" = zero new UI.
2. **Attention comes to you; you don't go looking.** No monitoring dashboard. When an agent
   needs you, one calm notification reaches whatever device you're on; otherwise, silence.
3. **The command layer is the invisible control plane.** The `winmux` CLI drives sessions
   with commands, not buttons — automation and orchestration live in a keystroke, no chrome.
4. **Progressive disclosure.** The default stays one calm terminal; deeper powers reveal only
   when summoned (palette, shortcut, phone long-press). The 90% never meets the 10%.

**The one named tradeoff:** a few ambitions genuinely want more surface (e.g. a "watch six
agents side by side" grid on a big monitor). That is the only place the law and a capability
pull apart — and it ships as an **opt-in view you summon, never the default**, decided
deliberately by Edward. Everything else on the ceiling costs zero clutter.

**The test every future feature must pass:** *does this add power without adding surface?*
If it needs new default chrome, it's wrong — make it summoned, put it on a row that already
exists, route it through attention, or push it into the command layer.

**Authority split (Edward, locked 2026-07-28) — who approves what.**
- **Anything that renders — new UI, a visible control, a screen, an on-row affordance →
  Edward's gate.** Bring it to him before it ships.
- **Anything backend / mechanism — engines, data layers, CLI verbs, transports, persistence,
  orchestration, plumbing → pre-approved.** Standing authorization to build when we get to it,
  no fresh ask.
- **Hybrid features split cleanly:** build the engine to completion under standing approval;
  the thin visible bit it eventually surfaces through waits for Edward's yes. Build the engine
  freely, gate the glass. (This *speeds us up* — mechanisms sit built and ready, so an approved
  surface ships instantly instead of from scratch.) Example: the whole "what's it doing"
  transcript-analysis layer and the remote-permission-approval routing are pre-approved to
  build; the row line and the notification's visible design are gated. Workspaces-as-code is
  pure backend — fully pre-approved, no surface at all.

### Depth ideas — power without surface (backlog under the design law, 2026-07-28)

Every item lives in one of the four no-clutter channels, so each already passes the "does
this add power without adding surface?" test. Not committed scope — a shaped backlog to pull
from. ⭐ = highest-leverage / most on-brand.

**On rows you already have (zero new UI):**
- ⭐ **"What is this agent doing right now"** — a one-line, transcript-derived summary on the
  session row. WinMux already reads Claude transcripts (`claude-fleet.ts`), so this is fleet
  awareness with no fleet panel.
- Live status dot + idle heartbeat (working / waiting-for-you / done / errored / "last active").
- Unread-output badge on sessions you're not looking at.
- Cost / token meter per agent session (quiet, on row or hover) — fleet budget awareness, no dashboard.
- Git branch + dirty state on repo rows (from shell integration).

**Attention that comes to you (the anti-dashboard):**
- ⭐ **Approve agent permission prompts from your phone** — Claude asks "can I run this?" while
  you're away → one tap Approve/Deny on the lock screen. The feature people switch tools for.
- Actionable notifications — reply to an agent from the notification itself.
- "While you were away" digest (N finished, 1 needs you, 1 errored).
- Long-command-done / command-failed pings with the result line; quiet hours.

**The invisible command layer (power, no chrome):**
- ⭐ **Workspaces-as-code / session templates** — `winmux open morning` spins up N repos, right
  cwds, an agent started in each. Reproducible environments in one word.
- **Fleet orchestration** — start N agents on N tasks from one command, watch the dots, get
  pinged as each finishes. The control plane itself.
- Cross-session run / broadcast; fuzzy-jump to any session (Ctrl+P for terminals); start/idle hooks.

**Progressive disclosure (summoned, never default):**
- Command palette as the universal "do anything" (keep buttons off the default surface).
- Global scrollback search across all sessions; **peek** (preview a session's latest output
  without switching); the opt-in fleet grid for a big monitor (the one named tradeoff).

**Continuity — "all connected," all invisible:**
- ⭐ **Clipboard sync** desktop↔phone (copy on the desk, paste on the phone).
- Send-to-device (push a command/path between devices); seamless agent handoff (already roadmapped).

**Terminal depth that stays calm:**
- Command marks (jump between commands, rerun last, click a past command to rerun); clickable
  paths/URLs/errors → editor or browser panel; collapse long output only when summoned.

**The four highest-leverage, most on-brand:** transcript-derived "what's it doing" line ·
remote permission approval from phone · workspaces-as-code · clipboard/send-to-device. Together
they turn "a beautiful terminal" into "the calm cockpit I run all my agents from" — none of
them touching the default surface.

### Production-readiness checklist (Edward + Claude, 2026-07-28)

The spine for a terminal: **it never loses my work · it's always honestly there · it
never makes me wait or wonder** — continuity, honesty, speed. The concrete list, roughly
ranked by how much it moves the "production-ready" needle. Items marked → point to the
phase where they're detailed.

Top tier (biggest felt difference):
1. **Survive a full close** — detached server; shells + agents live through closing. → Phase 11.
2. **Never lose work on a crash** — server/pty/Electron auto-recover + scrollback restore. (trust spine)
3. **Instant-feel** — pre-warmed shell + instant cursor, measured not guessed. → Phase 13.
4. **Honest connection status** — calm connected/reconnecting/offline, invisible reconnect. This is the real fix for the "loading" ambiguity — the problem is *wondering*, not only speed.
5. **First-run onboarding** — a stranger opens it and it explains itself; add-your-phone flow. (critical for OSS)
6. **Human error surfaces, everywhere** — consistent, actionable (already done for the phone-port case).
7. **Attention / notifications** — long command done, or an agent needs input, surfaced (esp. on phone).
8. **Keyboard completeness** — new tab/split/switch/close/palette, reliable + discoverable.
9. **Resource hygiene over long uptime** — no leaked shells, no memory creep, no zombie sockets.
10. **Cross-device continuity** — true multi-viewer mirror + synced layout. → Phase 11.

Security & trust (veto category — OSS is scrutinized publicly):
11. **Harden the phone door** — rate-limit key guesses, rotate key on device-forget (→ #153), tighten cookies/session.
12. **Input safety on the server** — `/rpc` + folder-find touch shell/filesystem; airtight against injection.
13. **Scrollback is secrets-at-rest** — persisting history (the resume feature) can store passwords/tokens; encrypt / opt-out / redact by design, not after.

Data integrity (a crash must not corrupt state):
14. **Atomic writes** for every persisted file (layout, trust list, scrollback) — no half-written brick.
15. **Config migration** — an update that changes saved-layout format migrates old state, doesn't throw.

Robustness on machines that aren't ours (the clean-install reality):
16. **node-pty native-module trap** — the compiled binary is tied to the Electron/Node version; the #1 way an Electron terminal breaks on someone else's machine. Handle in the build deliberately.
17. **Shell/environment variety** — pwsh vs Windows PowerShell vs cmd vs WSL vs Git Bash, non-ASCII paths (Windows+PS+Unicode is a landmine), multi-monitor, DPI scaling.
18. **Reconnect across real life** — laptop sleep/wake, wifi→cellular on phone, Tailscale re-auth; back off politely, just recover.

Performance under load (separate test from first paint):
19. **Many terminals** (20–50) and **fast output** (thousands of lines/sec) — xterm keeps up, memory stays flat.

UX depth power users feel immediately:
20. **Paste safety (bracketed paste)** — pasting multi-line that auto-runs is a footgun, worse with an agent; guard it.
21. **Copy/paste ergonomics, clickable links/paths in output, scrollback search, font/zoom.**

Operability (proof it's alive and supportable):
22. **Auto-update** — security fixes reach users; feels maintained. → Phase 12.
23. **Diagnostics** — one-click log / copy-diagnostics when it breaks for someone.
24. **Code signing** — not a gate for OSS, but unsigned trips Windows SmartScreen and hurts how *installing* feels. → Phase 12.

Sleeper risks worth naming (where "looks done" and "is done" diverge): **#16 node-pty
native-module trap** (how the OSS launch quietly fails on other machines), **#11–13
security** (public code, non-negotiable), and **#13 scrollback-as-secrets** (the resume
feature has a privacy edge — don't build it blind). Not glamorous; highest leverage.

### Phase 11 — Agent integration
Claude Code hooks, a live fleet/transcript view, and shell integration that keeps the
prompt's cwd and git branch current. This is what makes WinMux an *agent* cockpit,
not just a terminal.

**Session survival across a full app close (known gap, verified 2026-07-27).** Today the
Electron app boots `server.cjs` *in-process*, so fully closing the window quits the server
and kills every live shell — including a running `claude`/`codex`. The tab/group layout is
restored on reopen, but the shells come back fresh (no scrollback, nothing still running).
Minimizing keeps everything; only a full close ends it (the phone's grace-window reconnect
already survives a backgrounded tab). Fix: run the terminal server as a **detached
background process** the app attaches to on launch, instead of hosting it in-process — the
detached server already exists (`winmux.ps1 remote`), it just isn't the desktop default.
Then closing the window leaves the shells (and any agent) running, and reopening reattaches
by session id (the reload path already reattaches this way). This belongs with Phase 11
because a persistent agent cockpit is the whole point.

**Session capture & restore — the two levels (design, verified feasible 2026-07-27).**
"Restore a session" means two distinct promises; WinMux should offer both:

- **Level 1 — keep it alive (true restore).** With the detached server above, a close
  doesn't end anything: reopen is the *same* live shell, full scrollback, anything mid-run
  still running. This is the real "pick up exactly where I left off." The only thing no
  terminal can do is resurrect a *dead* process's in-memory state (a half-open vim buffer) —
  the answer is to keep it alive, not revive it.
- **Level 2 — replay the history (visual restore).** Persist each session's scrollback to
  disk and repaint it on reopen, so even a session whose process ended comes back with its
  full command history visible and ready to type into. WinMux already keeps scrollback in the
  session registry for reconnection (Phase 4); this adds a disk write + a replay-on-open.

**Cross-device viewing — today vs. the ask (verified 2026-07-27).** WinMux is one server,
so the desktop app and the phone (over Tailscale) share the *same live shells* — the phone
is not a synced copy, it attaches to the real sessions. But each terminal has a **single
active socket**: `attach()` closes any existing socket with "picked up elsewhere" (code
4004) and hands the session to the newest client. So opening the *same* terminal on the
phone **takes it over** from the desktop (tmux-attach model) rather than mirroring live on
both; *different* terminals on each device coexist fine. The genuine follow-you-around
upside already works: start at the desk, pick the same session up on the phone. What is NOT
built (and is a real design choice, not a bug): **true multi-viewer mirroring** (the same
terminal live on both screens at once) and a **layout that syncs across devices** (the phone
currently manages its own tab/group arrangement; only the underlying shells are shared).
Building it means the session holding a *set* of sockets and fanning pty output to all of
them, plus resize arbitration — worth doing deliberately, not a quick toggle.

**Claude Code / Codex resume (design).** These agents already persist their conversation to
disk and support native resume (`claude --resume <id>`, Codex equivalent). WinMux layers a
one-click "Resume" on top: detect a tab was running the agent, remember its session id + cwd,
and on reopen offer to run the resume command in the right folder. WinMux already ships a
Claude-transcript reader (the fleet viewer, Phases 51–59 / `claude-fleet.ts`), so the ability
to identify the session and offer resume is largely already in the codebase — this is a small
layer over a feature that already exists, not a new persistence system.

### Phase 12 — OSS distribution + a production-grade GitHub presence
Two halves. The **packaging** half: a Windows installer, auto-update, a winget entry,
LICENSE (MIT), and flipping the repo public. The **presentation** half — the repo has
to read like a finished product the moment a stranger lands on it, because for OSS the
README *is* the storefront:

- A README written as a shipped product, not a dev log: what it is in one line, a
  hero shot, install in one command, the phone/Tailscale story, the CLI, and the
  agent angle.
- **A full screenshot gallery, captured at real fidelity, covering every face and state:**
  - **Desktop app** (Electron) — the cockpit with live terminals, split panes, the
    group sidebar.
  - **Mobile / phone** — the drill-in flow (groups → sessions → terminal) over the
    Tailscale link.
  - **Light mode and dark mode** — every headline shot in both themes; the app
    follows the device, and the README should prove it.
  - **The CLI** — a real capture of `winmux` driving the live app (list / send /
    read-screen / new-tab).
  - **The browser panel** — the Electron `<webview>` open and being scripted.
  - **The markdown viewer** — a file open and live-updating.
  - **The phone-connect flow** — the QR code and the keyed Tailscale link in Settings.
- Every shot must be of the real running product (no mockups), scrubbed of any live
  access key, and shown as if this were a mature, finished tool.

### Phase 13 — Launch hardening
Clear every known glitch (including the two tracked harness flakes, #180), prove a
clean-machine install, and confirm every claimed state holds. This is the pass that
takes it from "works for us" to "safe to put our name on in public."

**Instant-feel / connection latency (Edward flagged 2026-07-28: sometimes a visible
"loading" beat).** "Instant" is part of feeling finished — a connect flicker reads as
unpolished. Do this by measurement, not guesswork (measure-before-optimizing): instrument
the real connect path — click → websocket open → the shell's first byte → first xterm paint
— and find which segment actually costs the time. Likely suspects, in order: (1) **PowerShell
cold-start** (loading the user profile/modules on a fresh `node-pty` spawn — usually the
biggest cost), (2) per-terminal socket handshake + xterm mount, (3) Tailscale round-trip on
the phone, (4) the reconnect grace window looking like "loading" when it is actually the
safety net. Fixes to weigh once measured: **pre-warm a spare PowerShell** so a new tab
attaches to an already-ready shell instead of cold-starting; an **instant skeleton/cursor**
so the unavoidable milliseconds never *feel* like waiting; trim any redundant handshake
round-trips. Target: a new tab and a reconnect both feel immediate on desktop, and as close
as the network allows on the phone.

### Phase 14 — Android companion app (post-v1.0, "eventually")
A native Android APK that is the phone face as a real installable app instead of a
browser tab. You connect by **pasting the Tailscale link** — or **scanning the QR
code** the desktop already generates — and it opens the full WinMux phone experience
(groups, sessions, live terminals) natively, with the connection remembered so it
reconnects on its own. This is a separate product surface beyond the v1.0 launch, not
a blocker for it; it reuses the existing phone server and trusted-device model, so no
new backend is required — the app is a native client over the same door.

## Risks

- Scope drift back into the agent-cockpit demo (medium) — containment: this file is the scope; anything not listed above is a new decision.
- Mockup CSS drift (medium) — containment: `cockpit.css` stays byte-identical to the mockup so the design can be re-diffed at any time.

## Resources

- [Design mockup](../wmux-amirlehmam/design-spec/cockpit.html)
- [Repo](https://github.com/Zbrooklyn/winmux)
