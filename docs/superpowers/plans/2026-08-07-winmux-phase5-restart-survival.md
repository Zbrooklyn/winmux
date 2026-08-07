# WinMux Phase 5 — Never Lose Your Work (survive a full Windows restart)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** After a full Windows reboot (every process killed), WinMux comes back and rebuilds the workspace to look and feel like you left it — same tabs/panes/splits/folders and the on-screen history — and relaunches agents on one tap.

**Architecture:** Build on what already survives a reboot, don't rebuild it. The client already snapshots the layout (tabs, panes, splits, cwd, shell, and each agent's resume command) to disk-backed `localStorage['ct-live']` (`public/app.js` `snapshot()`/`persistLive()` ~3079/3119) and restores it at boot (~4127). The server keeps per-session scrollback in memory (`s.buf`, `server.cjs` ~1261, replayed on reattach ~1316) — which dies on reboot. A manual `winmux-autostart.vbs` starts the *server* at logon but is a hand-copied Startup file and never opens the app window.

**Tech stack:** vanilla JS, node-pty, Electron, `verify.cjs` Playwright harness. No build step for the web path.

## Global Constraints
- Reboot cannot resurrect a live process; "survive" = rebuild layout + replay history + offer resume. Never claim live processes continue.
- Anything visible (a Settings toggle, a restored-history banner) is shown to Edward before it goes live; backend is built freely. Gate the visible bits behind their default-off/existing flags until approved.
- Auto-start ships a Settings toggle **OFF by default** — nothing touches Windows startup until Edward flips it.
- Agent resume on restore is **one-tap, never auto-executed unattended** (uses the existing armed-resume path, not a silent run).
- Keep `verify.cjs` green through every task; add a check per task.

---

### Task 1 — Scrollback survives the server dying (backend)
**Files:** `server.cjs` (persist `s.buf` to disk, reload index on start), `public/app.js` (replay saved history into a restored pane whose live session is gone), `verify.cjs` (new `restart` check).
**Interfaces produced:** a disk file per session id under the config dir holding `{id, dev, shell, cwd, buf, savedAt}`; an HTTP `GET /api/backlog?sid=<id>` returning the saved buf for a dead session (device-guarded, same rule as reattach).
- [ ] Server: throttled write of `s.buf` (+ meta) to `<configdir>/backlog/<sid>.txt` on output and on shutdown; cap by `SCROLLBACK`; prune files older than N days on start.
- [ ] Server: `GET /api/backlog?sid` returns the saved buf only to the owning device; 404 otherwise.
- [ ] Client: when `restoreLayout` reopens a tab whose `sid` the server no longer holds, fetch `/api/backlog?sid`; if present, write it into the fresh terminal dimmed, under a `── previous session ──` separator, before the live prompt.
- [ ] Done-criteria: kill + restart the server (reboot sim); a restored tab shows its prior output above the live prompt. Verified by the `restart` check.

### Task 2 — Real auto-start toggle (replaces the manual .vbs)
**Files:** `server.cjs` or a small helper (install/remove the Startup entry + optionally the app window), `public/app.js` + `public/index.html` (Settings row), `verify.cjs`.
**Interfaces consumed:** none. **Produced:** `/api/autostart` GET (state) + POST (enable/disable) that writes/removes the Startup-folder launcher.
- [ ] Decide + implement what logon launches so the workspace *visually* returns (server + app window), reusing `winmux.ps1 start` for the server.
- [ ] Settings toggle (OFF by default) calling `/api/autostart`; reflects real installed state on open.
- [ ] Done-criteria: toggling on creates the Startup entry, off removes it; state persists across app reopen. Harness asserts the file is created/removed. **Screenshot the Settings row to Edward before it's enabled by default anywhere.**

### Task 3 — Prove the reboot path end-to-end
**Files:** `verify.cjs`, `PLAN.md`, `docs/BUILD-PLAN.md`.
- [ ] Harness scenario: build a 2-pane workspace with an armed resume + output → persist → kill the server → restart → reopen → assert layout + scrollback + resume affordance all return.
- [ ] Real-window screenshot of a restored workspace (layout + dimmed history) to Edward.
- [ ] Mark BUILD-PLAN Phase 5 done with the honest scope note; record in PLAN.md.
