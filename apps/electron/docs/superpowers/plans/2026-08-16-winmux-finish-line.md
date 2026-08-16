# WinMux finish line — everything free, no signing, no auto-update

**Date:** 2026-08-16 · **Owner:** Claude (Edward authorized: "do everything here that will not cost us money; do not do the auto update — defer it")
**Branch:** work lands on `feature/phase8-electron-shell` → promoted to `master` (promotion itself authorized in the same message).

## Objective

Close every remaining roadmap item that needs no money and no auto-update decision, so
WinMux v0.2.0 is released, distributed (winget), running the Rust engine as its shipped
default, hardened, and the only things left are the two deferred owner decisions
(code signing, auto-install updates) and the post-v1.0 Android arc.

## Explicitly OUT of scope (Edward, 2026-08-16)

- **Code signing** — costs money. Installer stays unsigned; SmartScreen warning stays.
- **Auto-install updates** — deferred entirely ("I don't even know if I wanna add that").
  Users keep the existing notify + link-to-releases badge. Nothing is built toward it.
- Depth-ideas backlog — stays a backlog; items get pulled only when Edward asks.

## Work items (FL ledger, tasks #274–#285)

| # | Item | Done when |
|---|------|-----------|
| FL-1 | This plan file | Committed before the first FL commit. |
| FL-2 | Promote to master | `master` == `fe04fe3` (ff push), public repo shows orchestration + supervision. |
| FL-3 | v0.2.0 installer | Version bumped; NSIS installer built off-Dropbox (0xC0000142 retry); Rust engine bundled the way the installed app already ships it (`resources/winmux-core.exe`). |
| FL-4 | v0.2.0 release | GitHub release live with the installer asset + honest notes; old installs' update badge points at it. |
| FL-5 | Edward's installed app updated | Installed copy runs the supervision engine. Applied without killing a live session: swap staged, applied when the app is closed — never a forced restart. |
| FL-6 | winget submitted | Manifest generated from the real v0.2.0 URL+SHA; PR open on microsoft/winget-pkgs. (Moderation timeline is theirs.) |
| FL-7 | Stage 4 closed | Verified: packaged app boots the Rust core as its engine; dev-vs-installed paths documented; Node engine is explicit fallback only. Task #202 closed. |
| FL-8 | Stage 0 spike | Bounded Tauri/WebView2 spike answers: can a Tauri shell host the browser panel? Written verdict decides Stage 5 vs staying Electron. No product code touched. |
| FL-9 | Scrollback privacy | Settings toggle "Persist scrollback to disk" (default on = today's behavior); turning it off stops writes AND wipes existing backlog files; documented. Harness check. |
| FL-10 | Per-turn transcript view | Backend `.jsonl` per-turn reader + CLI/MCP surface proven on real worker sessions. Any new pixels ship as screenshots for Edward's acceptance before being called done (FE gate). |
| FL-11 | Clean-machine proof | v0.2.0 installer proven on a clean profile: install → onboarding → real shell → phone door off. Screenshots. |
| FL-12 | Android companion | Final arc, post the above; gets its own plan file before its first commit (Phase 14: paste-link/scan-QR native client over the existing phone door). |
| FL-13 | v0.2.1 identity fix (task #286) | The v0.2.0 primary installer conflated core-rust.flag's ENGINE choice with the "WinMux Rust" IDENTITY: the shipped primary app ran under the side identity's userData/instance/trust files — 0.1.x upgraders' settings invisible, `winmux` CLI blind to the app (looks in instance.json, app registered in instance.rust.json). Done when: flag content carries the identity bit ('rust' = engine only, 'rust identity' = side app), `parseCoreFlag` unit-tested, CLI + MCP discovery try instance.json then instance.rust.json (dead-pid files skipped), v0.2.1 released with both installers rebuilt, winget PR moved to 0.2.1 pre-merge, Edward's staged installer replaced. |

## Order

FL-2 → FL-3 → FL-4 → (FL-5, FL-6 in parallel) → FL-7 → FL-9 → FL-10 → FL-11 → FL-8 → FL-12.
Rationale: promotion unblocks the release; the release unblocks distribution and Edward's
install; hardening and the transcript view ride the now-current master; the spike is
independent and cheap; Android is the long pole and goes last.

## Standing gates that survive this authorization

- Anything destructive/irreversible outside this scope; credentials; spending.
- Edward's installed app is never killed while it has live sessions.
- New rendered UI (FL-9 settings row, FL-10 view) = screenshots to Edward; his eye accepts.

## Proof discipline

Every FL item closes with fresh verification (harness or targeted test) + evidence in the
task/commit, per the house rules. Release claims match the human-usable bar: a stranger
can install v0.2.0 from the README and reach a working terminal.
