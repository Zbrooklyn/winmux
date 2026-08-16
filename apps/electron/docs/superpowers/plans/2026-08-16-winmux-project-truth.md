# WinMux Project-Truth Arc — one honest save model, easy recovery, no mystery state

Date: 2026-08-16 · Edward objective 1: "make sure things are saved the right way, easy to recover, no confusion on what happens with projects — e.g. what happens if I close a project but it's still saved to memory?"

## Ground truth recovered (2026-08-16 audit)

Five stores exist today, with five different lifetimes, and nothing explains them:

1. **`ct-live` (localStorage)** — the auto-saved working layout. Lives inside each app identity's browser profile: invisible, not a file, wiped if the profile is wiped, FOUR separate copies across the four apps (plus any browser). This is where "my workspace" actually lives.
2. **`ct-current` (localStorage)** — the binding to a named project file, if any.
3. **Project files (`Documents\WinMux Projects\*.winmux.json`)** — the explicit save feature. **The folder does not exist on Edward's machine: zero projects have ever been saved.** The feature works (harness-proven) but the owner himself never adopted it — evidence the model isn't natural.
4. **`~/.winmux/backlog/`** — detached-session scrollback. **235 files / 8.7 MB accumulated in one week**, auto-expiring at 7 days. `/api/info` reports "detached: 0" while these sit on disk; no UI lists them; recovery only happens implicitly on reattach. Saved-but-unfindable = not really saved.
5. **`~/.winmux/config.json` + localStorage `ct-settings`/`ct-keymap`** — settings live in BOTH a server file and localStorage (dual-store, drift possible across the four apps).

**Answer to Edward's question, as of today:** there is no "close a project" verb at all. Closing the window keeps every shell running in the engine and the layout in ct-live; reopening restores both. Quit completely kills the shells but ct-live still restores the (now shell-less) layout. Saving a project writes a file that nothing ever closes, archives, or cleans up. The confusion is structural: three lifetimes (engine shells / auto-layout / named file) and no verbs that speak to them.

## Target model (proposed — Edward owns the feel, defaults built reversibly)

One sentence a stranger can hold: **"Your workspace is always saved automatically. A Project is a named snapshot you can reopen anytime. Sessions keep running until you end them."**

- **Workspace** = the live, always-auto-saved state. Moves from localStorage to an engine-side file (`~/.winmux/workspace.<identity>.json`) so it is visible, recoverable, survives profile wipes, and one per identity by design.
- **Project** = a named file. Verbs: Save, Open, **Close** (unbinds and returns to the unnamed workspace, offering: keep sessions running / end sessions / save first), Delete (file, confirmed).
- **Recoverable sessions** = a visible "Recent" list: detached sessions with their scrollback, restore or dismiss, with count surfaced honestly (no more "detached: 0" beside 235 files).

## Units

- **PT-1** — this plan. ✅
- **PT-2** — State-model contract doc (`docs/STATE.md`): every store, its lifetime, its owner, its recovery path. The doc is the spec the code then gets held to.
- **PT-3** — Workspace-as-file: move ct-live autosave to the engine (`/api/workspace` GET/PUT, throttled), localStorage becomes a cache; migration on first load; both engines (parity!). ✅ **Done 2026-08-16 (commit 47e75e0):** `/api/workspace` GET/POST in both engines, per-identity file from the instance-file name, atomic writes, desk-door only, memory-only under harness isolation; client restores from cache instantly and from the engine on a wiped profile; 2s-throttled saves + keepalive flush on close. Proof: new `workspace` harness check 5/5 on Node AND Rust; full harness green (the one `groups` failure was a stale premise — a fresh desk-door window now inherits the shared workspace by design — assertion updated, 30/30).
  **Re-rate:** Q1 4→7 (layout survives profile wipe; running shells are processes by nature). Q6 3→5 (workspace loss closed; backlog expiry still silent → PT-4). Q7 5→7 (each identity's faces converge on one engine-owned workspace). Q8 4→6 (workspace is now a copyable file). **Running total: 45/100.**
- **PT-4** — Recovery surface: "Recent & recoverable" in the sidebar/project menu — detached sessions (backlog) listed with age + one-click restore/dismiss; honest counts in /api/info and diagnostics. ✅ **Done 2026-08-16 (commit 9b30dbd):** both engines list backlog entries with savedAt/expiresAt/live and take DELETE (dismiss); /api/info gains `recoverable` (files with no live session); Projects overlay shows the list with age + "expires in Nd"; restore replays into a real tab; delivered backlogs are consumed. Proof: `recover` check 10/10 on Node AND Rust; screenshot sent to Edward.
  **Re-rate:** Q4 1→6, Q5 3→8, Q6 5→8, Q9 4→7. **Running total: 61/100.**
- **PT-5** — Close-project verb + project manager: Close with the three-outcome dialog; a simple list UI of saved projects (open/rename/delete) so files aren't invisible in Documents. ✅ **Done 2026-08-16:** Close button in the Projects overlay (visible only while bound) + palette entry; one dialog, three honest outcomes — keep sessions running / end the sessions / save first (shown when the layout drifted); closing never deletes the file; the row × now distinguishes "remove from list" from a real, confirmed "delete the file" (unbinds if it was the open project). Proof: `closeverb` check 10/10 on Node AND Rust; dialog screenshot sent to Edward (wording = his taste gate).
  **Re-rate:** Q3 4→8, Q4 6→7. **Running total: 66/100.**
- **PT-6** — Single-source settings: engine config.json is the source of truth, localStorage a cache; all four apps converge. ✅ **Done 2026-08-16 (commit 18b80ec):** boot now lets the engine's config.json win over the localStorage cache for settings AND keymap (the cache converges after load; resumeCommand keeps its {id} validity rule). Proof: `sot` check — the rendered terminal measurably takes the engine's 19px over a stale 13px cache. The full-harness gate also caught two real PT-3/PT-4 defects, fixed at the root: the backlog list stalling the single-threaded engine at thousands of files (now stat-capped to newest 30 + honest total), and workspaceFile resolving at module load so every packaged identity would have shared the primary's workspace.json (now lazy; electron smoke isolated and proven deterministic).
  **Re-rate:** Q10 3→9 (settings/keymap/workspace/projects each have one authority now). **Running total: 72/100.**
  **PT-7 remaining to ≥8 everywhere:** Q2 4 (the app itself must say where things live — cheat-sheet "Where your stuff lives" section), Q4 7 (surface the workspace file + recoverable count in Diagnostics), Q8 6 (document the move-to-another-machine path), Q1/Q7/Q9 at 7 (honest framing + parity notes).
- **PT-7** — Harness checks for every new state transition + vocab/docs update + release. ✅ **Done 2026-08-16 (commit 4f0b4c1):** the app itself answers "where is my stuff?" — cheat sheet (F1) gains a "Where your stuff lives" card (the one-sentence model + the four REAL paths from /api/info), Diagnostics lists workspace file / projects folder / recovery folder + honest count / settings file, both engines report the store paths in /api/info (parity-asserted). Dismissing a recoverable scrollback — the list's one irreversible verb — now asks first. STATE.md + README document the move-to-another-machine path. Bonus hardening the probe caught: a non-`instance*` WINMUX_INSTANCE_FILE made the workspace derivation a no-op, so a workspace write would have clobbered the discovery file — both engines now prefix `workspace.` instead. Proof: recover check 12/12 on Node AND Rust; **full harness 438/438**; screenshots of both new surfaces sent to Edward.
  **Final re-rate:** Q1 7→8 (everything but running processes is an engine-side file), Q2 4→9 (the app states the model + paths itself), Q4 7→8, Q7 7→8, Q8 6→8, Q9 7→8 (every destructive verb confirms). **Final: 82/100 — every question ≥8; exit bar met.** Edward can answer Q2 (F1 card) and Q3 (close dialogs) from the app alone. Held below higher: Q1/Q4/Q5/Q6 are honest 8s — running shells die with the machine by nature, and the recovery surfaces are new enough that only harness use, not Edward's habit, has exercised them.

## Scorecard — the questions we hold ourselves to (baseline 2026-08-16, re-rate after every unit)

Ratings are strict: 10 = a stranger could not be confused or lose anything; scores reflect evidence, not intent.

1. If the machine died right now, what does the user lose? — Layout lives in hidden per-app browser storage; running shells are processes (acceptable loss); zero project files exist to be safe. **4/10** → PT-3.
2. Can the user say where their stuff is saved, in one sentence? — Five stores, five lifetimes, no model anywhere. **2/10** → PT-2.
3. Before every action (close window / quit / close project / delete), can the user predict what survives? — Close window now explained (v0.2.2); quit clear; close-project verb does not exist; delete has no UI. **4/10** → PT-5.
4. Can the user SEE everything that is saved? — No list of workspaces, projects, or the 235 hidden recovery files. **1/10** → PT-4, PT-5.
5. Can the user get back everything the system claims to keep? — Reattach is implicit-only; backlog restore has no UI. **3/10** → PT-4.
6. Is anything ever lost silently? — Backlog expires at 7 days without the user ever knowing it existed; profile wipe kills the workspace. **3/10** → PT-3, PT-4 (expiry becomes visible: "expires in N days").
7. Does saving mean the same thing in all four apps + browser + phone? — Shared UI yes, but four separate invisible workspaces surprise. **5/10** → PT-2, PT-3.
8. Can the user move their setup to another machine? — Project files are portable by design but unused; workspace is not. **4/10** → PT-3, PT-5.
9. Is there a way back from a mistaken close/delete? — Reopen-closed-tab exists (good); end-session's undo (backlog) is invisible. **4/10** → PT-4.
10. Is there exactly one source of truth per fact? — Settings/keymap live in a server file AND four localStorage copies. **3/10** → PT-6.

**Baseline: 33/100.** Exit bar for the arc: every question ≥ 8, and Edward can answer Q2 and Q3 from the app alone.

## Risks
- Both engines must implement /api/workspace identically (drift class — add parity check to harness).
- Migration must never lose an existing ct-live layout (Rule: no silent data loss; migrate-then-verify before trusting the file).
- Edward review gate: the three-outcome Close dialog wording and the Recent list placement are taste calls — build, screenshot, he accepts.
