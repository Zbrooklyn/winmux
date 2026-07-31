# WinMux Item 8 — Agent integration (Phase 11): Claude Code hooks → cockpit state

> **For agentic workers:** Execute task-by-task. Each keeps `npm run verify` green, ships a committed harness check, and a screenshot for any rendered change.

**Goal:** Make WinMux reflect the *real* state of an agent running inside a terminal — working / needs-you / done — driven by official Claude Code hooks instead of output heuristics, so the WORKING / NEEDS YOU counters and the Approve affordance are truthful for a whole fleet of background agents.

**Architecture:** Three units. (1) Give every spawned shell a stable identity in its environment (`WINMUX_SID` + `WINMUX_PORT`, the tmux `$TMUX_PANE` precedent) so a hook running *inside* a terminal can address its own session. (2) A `winmux agent` state verb (RPC + CLI + MCP) that sets a session's status by sid/id/active. (3) A ready-to-install Claude Code hooks preset + doc that wires Notification→needs-you, Stop→done, and turn-start→working using `$WINMUX_SID`.

**Tech Stack:** Node server (`server.cjs` pty spawn + `/rpc`), vanilla JS client (`public/app.js` `runControl` + `setStatus`), `bin/winmux.cjs` CLI, `bin/winmux-mcp.cjs`, Playwright harness (`verify.cjs`).

## Global Constraints

- `cockpit.css` is FROZEN — new styles go in the `index.html` override layer only (this item likely needs none).
- Keep the standalone `node server.cjs` phone/web path working; agent-state is additive.
- Every task keeps `npm run verify` green + ships its own committed check. **Session survival (`survive`) + reconnect (`reload`) must stay green — unit 1 touches the spawn path.**
- Commit + push per task on `feature/phase8-electron-shell`.
- Do not touch the owner-gated publish or the v2 Rust/Tauri tree.

## Grounded current state (verified this session)

- **Spawn:** `spawnSession(shell, cwd)` (`server.cjs:1151`) creates the pty then the session object with `id = crypto.randomBytes(16).hex` (`:1153`). Env is the bare `process.env` — NO per-session marker. The id exists at spawn and is kept stable through spare-pool adoption (`onShellConnection` reuses `s.id`, `:1224-1236`).
- **Status model:** `idle | working | needsyou | closed` (`app.js:1267 setStatus`; `markWorking` heuristically sets `working` from output `:1283`). Sidebar dots, the WORKING / NEEDS YOU counters (`:752`), the row Approve button (`:734`), and the OS notification (attention bus) all derive from status.
- **Attention bus (item 3, done):** `runControl('notify', {target,message})` (`app.js:3653`) flips a session to `needsyou` + fires `notify()`. CLI `winmux notify` (`bin/winmux.cjs:147`), MCP `winmux_notify`.
- **CLI target resolution:** `winmux` resolves the app via the instance file / `WINMUX_PORT`; commands take `--id N` or default to the active session. `termByTarget` (app side) resolves by id/title. There is a reserved placeholder: `if (cmd === 'agent') die('agent arrives in Phase 11…')` (`bin/winmux.cjs:214`).

## Scope note

This plan builds the **hooks → cockpit-state bridge** — the higher-value, cleanly-bounded half of Phase 11 that makes the cockpit an honest agent fleet monitor. The heavier **transcript/fleet reader** (parsing Claude Code session `.jsonl` for a rich fleet view) is a documented follow-on (it overlaps the older wmux React fleet work) and is NOT in this plan.

---

### Task 1: Session identity in the shell environment

**Files:**
- Modify: `server.cjs` (`spawnSession` — generate the id first, spawn the pty with `env` extended by `WINMUX_SID` + `WINMUX_PORT`)
- Test: `verify.cjs` (`agent-env` check — open a terminal, run `echo $env:WINMUX_SID`, assert it equals the session's sid; assert `WINMUX_PORT` matches)

**Interfaces:**
- Produces: every shell WinMux spawns has `WINMUX_SID=<session id>` and `WINMUX_PORT=<server port>` in its environment; the sid is the same value the client sees as `meta.sid` and the CLI uses as `--sid`. Stable across spare adoption (the spare's id becomes the session id).

**Done-criteria:** Inside any WinMux terminal, `$WINMUX_SID` equals that session's id and `$WINMUX_PORT` equals the server's port; unchanged for a spare-adopted (instant-open) tab; `survive`/`reload` stay green.

- [ ] `spawnSession`: `const id = crypto.randomBytes(16).toString('hex')` first; `const env = Object.assign({}, process.env, { WINMUX_SID: id, WINMUX_PORT: String(PORT) })`; pass `env` to `pty.spawn`; use `id` in the session object.
- [ ] `agent-env` harness check (new PORT): send `echo "SID=$env:WINMUX_SID PORT=$env:WINMUX_PORT"` to the active terminal, read the screen, assert SID matches the live session id (from `winmux list --json`) and PORT matches.
- [ ] Confirm `survive` + `reload` still pass (spawn-path regression). Commit + push.

### Task 2: `winmux agent` state verb (RPC + CLI + MCP)

**Files:**
- Modify: `public/app.js` (`runControl` — add an `agent` command: set a target session's status to `working|needs-you|done|idle` (+ optional message); `needs-you` also fires `notify`; `done`/`idle` clear `working`/`needsyou`)
- Modify: `bin/winmux.cjs` (replace the `agent` placeholder with `winmux agent <working|needs-you|done|idle> [--sid S] [--id N] [message]`; resolve `--sid` from `$WINMUX_SID` by default)
- Modify: `bin/winmux-mcp.cjs` (`winmux_agent` tool: `{ state, message?, id? }`)
- Test: `verify.cjs` (`agent-state` check — `winmux agent needs-you --sid <sid> "waiting"` flips that session to needsyou (Approve appears, NEEDS YOU counter ticks); `winmux agent done --sid <sid>` clears it back to idle)

**Interfaces:**
- Consumes: `termByTarget` (extended to resolve a `sid`), `setStatus`, `notify`.
- Produces: `runControl('agent', { state, target|sid, message })` → sets status, returns `{ id, state }`. State map: `working`→`working`; `needs-you`→`needsyou` + `notify`; `done`/`idle`→`idle`. CLI defaults `--sid` to `process.env.WINMUX_SID` so a hook needs no arguments. `winmux_agent` MCP tool mirrors it.

**Done-criteria:** From the CLI (and MCP), an agent sets its own session's state and the cockpit reflects it — `needs-you` raises the Approve + NEEDS YOU counter exactly like a bell, `done` returns it to idle — targeted precisely by sid, proven live.

- [ ] `app.js`: `runControl` `agent` branch; resolve target by `args.sid` (new) / `args.target` / active; map state→status; `needs-you` calls the same escalation path as `notify`.
- [ ] `termByTarget` (or a small `termBySid`) resolves a session by its `sid`/`id`.
- [ ] `bin/winmux.cjs`: `agent` verb (replace the placeholder), `--sid` default `process.env.WINMUX_SID`, clean JSON out, help text.
- [ ] `bin/winmux-mcp.cjs`: `winmux_agent` tool + schema.
- [ ] `agent-state` harness check (new PORT): drive `winmux agent needs-you/done --sid <sid>` against the live app; assert the row status + counter change.
- [ ] Screenshot: a session flipped to NEEDS YOU by `winmux agent`. Commit + push.

### Task 3: Claude Code hooks preset + doc

**Files:**
- Create: `agent/claude-code-hooks.json` (a ready-to-merge Claude Code `hooks` block: `Notification`→`winmux agent needs-you`, `Stop`→`winmux agent done`, `UserPromptSubmit`→`winmux agent working`, each command using `$WINMUX_SID`)
- Create: `docs/agent-integration.md` (what it does, how to install the hooks, the state model, that it only activates inside a WinMux terminal)
- Modify: `README.md` (a short "Agent integration" pointer)
- Test: `verify.cjs` (`agent-hooks` check — the preset is valid JSON, references `winmux agent` + the three lifecycle events; run the exact command a hook fires (`winmux agent working --sid <sid>`) against the live app and assert the state lands)

**Interfaces:**
- Consumes: `winmux agent` (Task 2), `$WINMUX_SID` (Task 1).
- Produces: an installable hooks preset + doc; the harness proves the hook command path is real end-to-end.

**Done-criteria:** A user can merge the preset into their Claude Code settings and a real agent's lifecycle drives the WinMux cockpit with no per-terminal setup; the harness proves the exact hook command flips live state.

- [ ] `agent/claude-code-hooks.json`: the three hooks, commands shaped `winmux agent <state> --sid $WINMUX_SID [message]`, guarded to no-op when `$WINMUX_SID` is unset (outside WinMux).
- [ ] `docs/agent-integration.md` + README pointer.
- [ ] `agent-hooks` harness check: parse the preset (valid JSON, correct events/commands) + fire the working-hook command live and assert state.
- [ ] Screenshot or preset+doc excerpt shipped. Commit + push.

---

## Self-Review

- **Coverage:** shell identity (T1) · `winmux agent` state (T2) · hooks preset + doc (T3) — the hooks→cockpit-state bridge that is the buildable core of Phase 11 agent integration. The transcript/fleet reader is explicitly out of scope (documented follow-on).
- **Sequencing:** T1 first (identity is the prerequisite for precise targeting); T2 needs T1's sid; T3 packages T1+T2 for a real agent.
- **Risk:** T1 changes the spawn env for every shell — low risk (adds two vars, tmux does the same), but `survive`/`reload` are the regression guard. T2/T3 are additive. No owner gate — env vars + state verbs + a hooks preset are technical mechanics; the state vocabulary already exists.
- **Owner note:** injecting `WINMUX_SID`/`WINMUX_PORT` into shells is the standard multiplexer pattern (`$TMUX`, `$TMUX_PANE`); reversible; not a product/taste decision.
