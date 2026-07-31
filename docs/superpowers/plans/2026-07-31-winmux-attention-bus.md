# WinMux Attention Bus Implementation Plan

> **For agentic workers:** Execute task-by-task. Each task keeps `npm run verify` green, ships a committed harness check, and a screenshot for any rendered change.

**Goal:** Complete the attention bus so any session that needs Edward reliably reaches him — including when WinMux isn't the focused window — and so agents can explicitly signal "I need you," not only ring the bell.

**Architecture:** Layered onto the existing attention infrastructure in `public/app.js` (bell → `needsyou`, the NEEDS YOU counter, Approve/Deny on rows + preview panel, and the `notify()` notification centre) plus the Phase-9 `/rpc` + `winmux` CLI transport. Two additive units; nothing existing is rebuilt.

**Tech Stack:** existing server.cjs `/rpc` forwarder + `/control` WS, `bin/winmux.cjs` CLI, Electron `Notification` (renderer) with a Web Notification fallback for the phone/web path.

## Global Constraints

- cockpit.css FROZEN — new styles go in the `index.html` override layer only.
- Keep the standalone `node server.cjs` phone/browser path working.
- Every task keeps `npm run verify` green + ships its own committed check.
- Rendered changes ship a screenshot (rule 21).
- Commit + push per unit on `feature/phase8-electron-shell`.

## Already shipped (recovery — do NOT rebuild)

- **Detection:** `term.onBell` → an unfocused terminal escalates to `status='needsyou'` (app.js:1494).
- **Surfacing:** red status dot, "Needs you" label, the NEEDS YOU deck counter (`d-need`), the pane attention ring.
- **Respond:** `approveTerm` (sends `\r`) / `denyTerm` (sends `\x1b`) on session rows and the preview panel — phone-capable (app.js:721-722, 592-593, 626-647).
- **Notification centre:** `notify()` + badge + popover/bottom-sheet, fed by bell / session-ended (app.js:394-455).

---

### Task A: `winmux notify` — explicit agent attention signal (CLI + /rpc verb)

**Files:**
- Modify: `server.cjs` (add a `notify` action to the `/control` command set the app already consumes; forwarded via the existing `/rpc` POST path)
- Modify: `public/app.js` (handle an inbound `notify` control message → find the target term by id/title → `setStatus(t,'needsyou')` + `notify(title, msg, t.id)`)
- Modify: `bin/winmux.cjs` (add `winmux notify [--session <id|title>] <message>`)
- Test: `verify.cjs` (`notify` check — drive `winmux notify` and assert the target session goes `needsyou` + a notification lands)

**Done-criteria:** `winmux notify --session <id> "needs your call"` marks that session `needsyou` (counter increments, row shows Approve) and adds a notification. With no `--session`, targets the active one. Harness asserts the status flip + notification via the CLI path (mirrors the existing `cli` check).

- [ ] Add the `notify` control handler app-side (reuse the `/control` message dispatch that `cli`/`browser` already use).
- [ ] Add the CLI verb + wire it through `/rpc`.
- [ ] Add the `notify` harness check; `npm run verify` green.
- [ ] Screenshot: a session flipped to NEEDS YOU by a `winmux notify` call.
- [ ] Commit + push.

### Task B: OS notification when a session needs you and WinMux is unfocused

**Files:**
- Modify: `public/app.js` (`notify()` → also raise an OS notification when `!document.hasFocus()`; click → focus window + jump to the term. Guard behind a Settings toggle, default on. Electron `Notification` if present, else `window.Notification` with a one-time permission request; silent no-op if denied.)
- Modify: `public/index.html` (Settings → Behaviour row: "Desktop notifications" toggle) — override layer only.
- Test: `verify.cjs` (`osnotify` check — stub `window.Notification`, blur focus, trigger a needsyou, assert a Notification was constructed with the session title)

**Done-criteria:** when a session escalates to `needsyou` and the WinMux window is not focused, an OS notification fires with the session name; clicking it focuses WinMux and jumps to that session. A Settings toggle (default on) governs it; denial/opt-out is a clean no-op. Harness asserts the Notification is constructed on an unfocused needsyou and NOT on a focused one.

- [ ] Route `notify()` through an OS-notification helper gated on focus + the setting + permission.
- [ ] Add the Settings toggle (default on) in the override layer.
- [ ] Add the `osnotify` harness check (stubbed Notification, focus/blur cases).
- [ ] `npm run verify` green; screenshot the Settings toggle + (best-effort) the fired notification.
- [ ] Commit + push.

---

## Self-Review

- Coverage: "which session needs you" is shipped and extended by an explicit agent signal (A); "reaches you / phone approve-deny" is shipped, and A+B make it reach you when away (OS notification) — the whole roadmap item.
- Additive only; the bell path, counter, approve/deny, and notification centre are untouched except to gain an OS-notification branch and a new inbound signal.
- Each task is independently testable with a committed check + screenshot; phone path unaffected (Web Notification fallback, silent if unsupported).
