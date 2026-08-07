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
- [x] Server: throttled write of `s.buf` (+ meta) to `<configdir>/backlog/<sid>.json` on output and on shutdown; cap by `SCROLLBACK`; prune files older than a week on start. (commit 9623b12)
- [x] Server: `GET /api/backlog?sid` returns the saved buf only to the owning device; 404 otherwise. (commit 9623b12)
- [x] Client: on `m.lost` for a plain tab, fetch `/api/backlog?sid` and, once the cold shell settles (its startup clear would wipe an immediate paint), reset + replay the saved screen. NOTE: divider lands **below** the restored content ("restored from before the restart · fresh shell below"), not above — the saved buf carries its own leading clear, which erases anything written over it. Armed auto-resume tabs are skipped (resume command is their recovery). (commit 6809428)
- [x] Done-criteria: kill + restart the server (reboot sim) → restored tab repaints prior output, live prompt below. Proven by scratchpad `replayshot.cjs` (screenshot shipped) and the committed `restart` harness check (backend seam).

### Task 2 — Real auto-start toggle (replaces the manual .vbs)
**Files:** `server.cjs` or a small helper (install/remove the Startup entry + optionally the app window), `public/app.js` + `public/index.html` (Settings row), `verify.cjs`.
**Interfaces consumed:** none. **Produced:** `/api/autostart` GET (state) + POST (enable/disable) that writes/removes the Startup-folder launcher.
- [x] Logon launcher decided: a `WinMux.vbs` in the Startup folder relaunches the packaged app exe (server + window + restore) under Electron, or `winmux.ps1 start` (detached server) when run from source. (commit 65c4eca)
- [x] Settings toggle (OFF by default) in Behaviour calling `/api/autostart`; reflects real installed state on open. (commit 2d9f60a)
- [x] Done-criteria: toggling on creates the Startup entry, off removes it. Proven by scratchpad `autostarttest.cjs` (backend, 5/5) + `autostartshot.cjs` (UI, 5/5); Settings row screenshot shipped to Edward. Off by default; not enabled anywhere.

### Task 3 — Prove the reboot path end-to-end
**Files:** `verify.cjs`, `PLAN.md`, `docs/BUILD-PLAN.md`.
- [x] Committed `restart` harness check (PORT 9960): run a command → kill the server dead → restart on the same config → `/api/backlog` still hands back that session's exact scrollback. Deterministic backend seam (no xterm timing), 4/4. Layout survival across reboot was already covered by the existing `reload` check (ct-live restore). The full client repaint is proven by `replayshot.cjs` rather than the shared suite, to keep it flake-free.
- [x] Real-window screenshot of the restored screen (prior output + divider + live prompt) shipped to Edward.
- [x] BUILD-PLAN Phase 5 marked done with the honest scope note.

**Scope note (honest):** "Survive a reboot" = layout + on-screen scrollback rebuild + one-tap agent resume. Live *processes* cannot survive a reboot and never claim to. Auto-start ships OFF by default; the history-restore works with or without it.
