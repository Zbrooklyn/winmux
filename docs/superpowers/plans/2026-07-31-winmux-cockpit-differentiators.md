# WinMux Cockpit Differentiators Implementation Plan

> **For agentic workers:** Execute task-by-task. Each keeps `npm run verify` green, ships a committed check, and a screenshot for any rendered change.

**Goal:** The four cockpit differentiators that make WinMux more than a terminal — a native MCP surface for agents, cross-device clipboard, a live "what's it doing" line, and remote permission approval.

**Architecture:** All build on the existing `server.cjs` `/rpc` + `/control` transport and the `winmux` CLI. The MCP server is a thin stdio adapter over `/rpc`. cockpit.css stays FROZEN. The `node server.cjs` phone/web path stays intact.

## Global Constraints

- cockpit.css FROZEN — new styles in the index.html override layer only.
- Keep the standalone `node server.cjs` phone/web path working.
- Every task keeps `npm run verify` green + ships its own committed check.
- Rendered changes ship a screenshot (rule 21).
- Commit + push per unit on `feature/phase8-electron-shell`.

## Recovery (state before this plan)

- **Remote permission approval — DONE (item 3).** Approve/Deny on `needsyou` rows + preview panel, phone-capable; `winmux notify` + OS notification complete the loop. No new work; this differentiator is met.
- **Clipboard (local) — exists.** `copySel` / `navigator.clipboard` copy+paste within a device. Cross-*device* sync is new (Task C).
- **"What's it doing" — partial.** `statusLine(t)` shows status label (idle/working/needs-you), not the live last-activity content. Enrichment in Task B.
- **MCP — absent.** No mcp module, no SDK. Task A builds it.

---

### Task A: `winmux-mcp` — MCP server over the /rpc surface (primary differentiator)

**Files:**
- Create: `bin/winmux-mcp.cjs` (stdio MCP server; discovers the running WinMux via the same instance file the CLI uses; exposes the /rpc verbs as MCP tools)
- Modify: `package.json` (add `@modelcontextprotocol/sdk`; add `winmux-mcp` bin)
- Create: `docs/winmux-mcp.md` (how to add it to a Claude Code `.mcp.json`)
- Test: `verify.cjs` (`mcp` check — spawn the MCP server, speak the protocol over stdio, call a tool, assert it drove the live app)

**Interfaces:**
- Tools mirror the CLI verbs: `list`, `read_screen`, `send`, `new_tab`, `split`, `focus`, `notify`, `browser`, `markdown`. Each forwards to `/rpc` and returns the JSON result.
- Discovery: reuse the CLI's instance-file resolution (`~/.winmux/instance.*.json`), so no config when WinMux is running; clear error when it isn't.

**Done-criteria:** From an MCP client (the harness acts as one), `list` returns the live sessions and `send`/`read_screen` round-trips a command through the real app — proving an agent can drive WinMux over MCP. Clean error when no app is running.

- [ ] Install the SDK; scaffold the stdio server with the tool list.
- [ ] Wire each tool to `/rpc` via the existing forwarder; reuse instance discovery.
- [ ] Add the `mcp` harness check (spawn server, initialize, `tools/list`, `tools/call list`, assert sessions; `send`+`read_screen` round-trip).
- [ ] Docs: `.mcp.json` snippet. `npm run verify` green.
- [ ] Commit + push. (Screenshot N/A — headless protocol; the check output is the proof.)

### Task B: "What's it doing" — live activity line on session rows

**Files:**
- Modify: `public/app.js` (`statusLine`/row render — add the last non-empty output line, throttled, as the activity subtitle; already have per-term output in the ws handler)
- Modify: `public/index.html` (override-layer styling for the activity line, ellipsis/one-line)
- Test: `verify.cjs` (`doing` check — send output to a background session, assert its row shows the latest line)

**Done-criteria:** A session row shows a live, one-line "what it's doing" (its most recent meaningful output), truncated, updating as output flows, without stealing focus. Harness asserts the row reflects the last line after output.

- [x] Capture the last non-empty rendered line per term (throttle to ~1/sec) into `t.lastLine`. — `lastLiveLine`/`captureDoing`/`scheduleDoing` in app.js; hooked in `ws.onmessage` after `markWorking`.
- [x] Render it in the row (override layer), one line, ellipsis. — `.sdoing` in `srowHTML` + `updateDoing` live-patch; CSS in index.html override layer.
- [x] Add the `doing` check; `npm run verify` green; screenshot a row showing live activity. — `doing` check (PORT 9938) passes 2/2; row echoes the marker line; screenshot `doing-doing-activity-line.png` shipped.
- [x] Commit + push.

**STATUS: DONE.** The active session row shows a live, faded, one-line "what it's doing" (its latest meaningful output), ellipsised, updating as output flows, patched in place so it never steals focus. Proven mechanically (rowText assertion) + visually.

### Task C: Clipboard sync (cross-device, opt-in)

**Files:**
- Modify: `server.cjs` (a small `/api/clip` GET/POST holding the latest clip in memory, loopback/tailnet-guarded like the rest)
- Modify: `public/app.js` (opt-in: on copy, POST the clip; a "Paste from other device" affordance pulls the latest)
- Modify: `public/index.html` + Settings (a "Sync clipboard across devices" toggle, default OFF — privacy)
- Test: `verify.cjs` (`clip` check — POST a clip on one server, GET it back)

**Done-criteria:** With the toggle on, copying on the PC makes the text available to pull on the phone (and vice-versa) over the tailnet, never persisted to disk. Default off. Harness asserts the round-trip through `/api/clip`.

- [ ] `/api/clip` in-memory latest-clip endpoint (guarded).
- [ ] Client opt-in copy→POST + pull-latest affordance + Settings toggle (default off).
- [ ] Add the `clip` check; `npm run verify` green; screenshot the toggle + the paste affordance.
- [ ] Commit + push.

---

## Self-Review

- Coverage: MCP (A, new) · what's-it-doing (B) · clipboard sync (C) · remote approval (already done, item 3). All four differentiators addressed.
- Sequencing: MCP first (highest-value, fully backend/testable) → activity line → clipboard sync (privacy-gated).
- Each task independently testable with a committed check; phone path intact.
