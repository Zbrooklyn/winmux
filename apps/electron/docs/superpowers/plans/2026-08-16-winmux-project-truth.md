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
- **PT-3** — Workspace-as-file: move ct-live autosave to the engine (`/api/workspace` GET/PUT, throttled), localStorage becomes a cache; migration on first load; both engines (parity!).
- **PT-4** — Recovery surface: "Recent & recoverable" in the sidebar/project menu — detached sessions (backlog) listed with age + one-click restore/dismiss; honest counts in /api/info and diagnostics.
- **PT-5** — Close-project verb + project manager: Close with the three-outcome dialog; a simple list UI of saved projects (open/rename/delete) so files aren't invisible in Documents.
- **PT-6** — Single-source settings: engine config.json is the source of truth, localStorage a cache; all four apps converge.
- **PT-7** — Harness checks for every new state transition + vocab/docs update + release.

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
