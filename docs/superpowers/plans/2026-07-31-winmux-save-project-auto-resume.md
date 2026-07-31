# Save-Project + Auto-Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each WinMux tab remembers its folder and (optionally) a resume command; closing WinMux ends the shells, and reopening auto-runs `cd <folder>` → `claude --continue` in each armed tab so you land back in every conversation without touching anything.

**Architecture:** This is roadmap item #240 (workspace config-as-code). The save/restore machinery already exists — named layouts (`ct-layouts`) save `{cwd, shell, group, title}` per tab and `restoreLayout()` spawns fresh shells in each folder; the live snapshot (`ct-live`) reattaches by session id on reload. The feature adds ONE field — a per-tab **resume command** — carried through both, and runs it exactly once on the first *fresh* shell a restored tab gets. It slots into the existing reattach seam: on reconnect the server answers `m.resumed` (warm shell still there → you're back live, no resume) or `m.lost` (shell gone → cold reopen → run the resume command). So a full-app close-and-reopen resumes via `claude --continue`; a page reload where the detached server kept the shell warm reattaches live. Never orphans a running agent, never double-runs.

**Tech Stack:** vanilla `public/app.js` (client), `public/index.html` `<style>` override layer for any new styling (cockpit.css is FROZEN), `verify.cjs` Playwright harness.

## Global Constraints

- `public/cockpit.css` is FROZEN — any new styling goes in the `index.html` `<style>` override layer only.
- Keep `server.cjs`'s standalone `node server.cjs` phone/browser path unchanged — this is a pure client-side feature (no new server RPCs; the resume command is typed into the pty via the existing `t: 'i'` input channel).
- Every task keeps `npm run verify` green and ships its own committed harness check.
- Default resume command: `claude --continue --dangerously-skip-permissions` (Edward's "claude resume yolo"). It is a **setting** (`S.resumeCommand`), editable — not a silent hardcode.
- Die-on-close + auto-resume-on-reopen is the intended UX (Edward's explicit spec). Do NOT rely on session survival for armed tabs; the resume path must work when the shells are gone.
- Screenshots for any rendered change go to Edward (rule 21).
- Build stays on `feature/phase8-electron-shell`. Do NOT touch the owner-gated publish (#230).

## File Structure

- `public/app.js` — all logic: terminal `t.resume` field, `newTerm()` param, `snapshot()`/`restoreLayoutUnsafe()` carry, schema migration, the reattach/lost auto-run state machine, tab-menu arm toggle, settings field.
- `public/index.html` — `<style>` override for the tab/sidebar "armed" indicator; the Settings row markup for the resume command.
- `verify.cjs` — one new port + `resume` check.
- `PLAN.md` — link this plan under the build order; mark #240.
- `docs/agent-integration.md` / `README.md` — one-line mention of auto-resume where workspaces are described.

---

### Task 1: Schema v2 — carry a per-tab resume command through save/restore

**Files:**
- Modify: `public/app.js` — `newTerm()` (~1420), `snapshot()` (~2457), `restoreLayoutUnsafe()` (~2522), `SCHEMA_VERSION`/`migrateLayout()` (~2497), `recordClosed()`/`reopenClosed()` (~1377) so an undo-reopened tab keeps its arm.

**Interfaces:**
- Produces: `newTerm(p, shellKey, cwd, seedSid, resumeCmd)` — 5th param sets `t.resume` (string|null). `snapshot()` tab descriptors gain `resume`. `restoreLayoutUnsafe()` reads `td.resume`.

- [ ] **Step 1: Bump the schema version and add the migration note.** In `migrateLayout()`, set `SCHEMA_VERSION = 2`. v1 blobs have no `resume` on their tabs — that is already the correct "not armed" state, so migration is a no-op passthrough (a v1 tab simply reads `td.resume === undefined` → not armed). Add the chain comment: `// if (v < 2) { /* resume field added; absent = not armed, no transform needed */ }`.

- [ ] **Step 2: Add the `resumeCmd` param to `newTerm`.** Signature becomes `function newTerm(p, shellKey, cwd, seedSid, resumeCmd)`. After the terminal object `t` is built, set `t.resume = resumeCmd || null;`.

- [ ] **Step 3: Carry `resume` in `snapshot()`.** In the tab-map, add `resume: t.resume || ''` to the returned descriptor (alongside shell/cwd/group/title/sid).

- [ ] **Step 4: Read `resume` in `restoreLayoutUnsafe()`.** Change the `newTerm(p, td.shell, td.cwd, td.sid)` call to `newTerm(p, td.shell, td.cwd, td.sid, td.resume || null)`.

- [ ] **Step 5: Keep the arm on undo-reopen.** In `recordClosed()` add `resume: t.resume || null` to the pushed record; in `reopenClosed()` pass it: `newTerm(p, d.shell, d.cwd, null, d.resume)`.

- [ ] **Step 6: Verify manually in the running app.** Boot `node server.cjs`, open the app, set `t.resume` on a tab via console (`__winmuxArm` will exist after Task 3; for now set it on the term object directly), reload, and confirm `JSON.parse(localStorage['ct-live']).cols[..].tabs[..].resume` round-trips. No commit yet (folded into Task 2's deliverable).

---

### Task 2: Auto-run the resume command on the first fresh shell

**Files:**
- Modify: `public/app.js` — `newTerm()` connect/onmessage meta handler (~1589-1615, the `m.resumed` / `m.lost` branches), and the fresh-open path.

**Interfaces:**
- Consumes: `t.resume` (Task 1), `sendToShell(t, txt)` (existing, app.js:383).
- Produces: resume runs exactly once per restored-and-armed tab, on its first *fresh* shell.

- [ ] **Step 1: Arm the pending flag on restore.** In `restoreLayoutUnsafe()` after creating each term, if `td.resume` set `t.autoResumePending = true`. (A tab armed *live* by the user — Task 3 — does NOT set pending; it only writes `t.resume` so the NEXT boot arms it.)

- [ ] **Step 2: Add a one-shot sender.** Near `newTerm`, define a local `function fireResume() { if (t.autoResumePending && t.resume) { t.autoResumePending = false; try { sendToShell(t, t.resume + '\r'); } catch (e) {} } }`.

- [ ] **Step 3: Fire on a fresh shell, not a reattach.** In the meta handler: in the `m.lost` branch (shell we asked for is gone → server spawned fresh) call `fireResume()`. In the `m.resumed` branch (warm reattach) set `t.autoResumePending = false` WITHOUT firing (you are already back live). For a tab created with a resume command but **no** seed sid (a named-layout restore), fire once on first `ws.onopen` — guard with a `t._openedOnce` flag so reconnects don't re-fire.

- [ ] **Step 4: Write the failing harness check first (see Task 4 for the full check).** The behavior test lives in verify.cjs; this task's proof is that check going green.

- [ ] **Step 5: Commit.**
```bash
git add public/app.js
git commit -m "feat(resume): carry per-tab resume command through save/restore + auto-run on cold reopen"
```

---

### Task 3: Arm auto-resume from the UI (tab menu + indicator + setting)

**Files:**
- Modify: `public/app.js` — tab context menu (~508-556), settings wiring, `S` defaults (~60-70), `renderSidebar()` tab/row indicator (~730).
- Modify: `public/index.html` — `<style>` override for the `.armed` indicator dot; Settings row for the resume command input.

**Interfaces:**
- Consumes: `t.resume`, `S.resumeCommand`, `persistLive()`.
- Produces: `__winmuxArm(t, on)` test hook; a visible armed indicator.

- [ ] **Step 1: Default setting.** In the `S` defaults add `resumeCommand: 'claude --continue --dangerously-skip-permissions'`. Mirror it through the same localStorage/disk config path as the other settings.

- [ ] **Step 2: Arm/disarm function.** Add `function armResume(t, on) { t.resume = on ? (S.resumeCommand || 'claude --continue') : null; persistLive(); renderSidebar(); layoutTabs(paneById(t.paneId)); }` and expose `window.__winmuxArm = armResume;` for the harness.

- [ ] **Step 3: Tab context-menu toggle.** In the tab menu, add a checkbox-style item: label `Auto-resume on reopen`, checked when `t.resume`, click → `armResume(t, !t.resume)`. Place it near Rename/Duplicate.

- [ ] **Step 4: Visible indicator.** In `renderSidebar()` (and the tab chrome) add a small `↻` / dot with class `armed` when `t.resume`. Style it in the index.html override layer only (cockpit.css frozen) — a low-key accent glyph, not a loud badge.

- [ ] **Step 5: Settings field.** Add a Settings row "Resume command" bound to `S.resumeCommand`, with helper text "Run in each armed tab when WinMux reopens (e.g. claude --continue)."

- [ ] **Step 6: Screenshot proof to Edward** — armed tab (indicator visible) + the Settings row. Ship via SendUserFile.

- [ ] **Step 7: Commit.**
```bash
git add public/app.js public/index.html
git commit -m "feat(resume): arm auto-resume per tab (menu toggle + indicator + configurable command)"
```

---

### Task 4: Harness check + full verify green

**Files:**
- Modify: `verify.cjs` — new `PORT_RESUME` + `resume` check.

**Interfaces:**
- Consumes: `__winmuxArm`, the layout snapshot, the reattach/lost seam.

- [ ] **Step 1: Write the check.** Boot a server on `PORT_RESUME`. In the page: create/select a tab, call `__winmuxArm(term, true)`, assert the tab's `resume` lands in `localStorage['ct-live']`. Then simulate a cold reopen: drop the tab's sid (so the next connect gets `m.lost`) or reload with the armed live state, and assert the fresh shell received the resume command (grep the shell's echoed input / a sentinel resume command like `echo __RESUMED__` swapped in via `S.resumeCommand` for the test). Assert the reattach path (warm sid) does NOT resend.
- [ ] **Step 2: Run it, watch it fail, implement until green.** `node verify.cjs` scoped to the resume port.
- [ ] **Step 3: Full harness.** Run `npm run verify` (serial, `WINMUX_VERIFY_CONCURRENCY=1`) and confirm green including the new check.
- [ ] **Step 4: Commit + push.**
```bash
git add verify.cjs PLAN.md docs/ README.md
git commit -m "test(resume): harness proves armed tab auto-resumes on cold reopen, not on warm reattach"
git push origin feature/phase8-electron-shell
```

## Self-Review

- **Spec coverage:** folder remembered (existing cwd) ✓; conversation remembered as a resume command ✓; die-on-close (existing kill-on-close) ✓; auto-run on reopen (Task 2) ✓; per-tab (Task 3) ✓; configurable command, no silent hardcode ✓.
- **Placeholder scan:** none — every step names the exact function and line region.
- **Type consistency:** `t.resume` is string|null everywhere; snapshot serializes `''` for none; `newTerm`'s 5th param is `resumeCmd`.
- **Risk:** double-run guarded by `autoResumePending` (one-shot) + `_openedOnce`; reattach explicitly clears without firing so a warm server never re-types into a live agent.
