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

## Risks
- Both engines must implement /api/workspace identically (drift class — add parity check to harness).
- Migration must never lose an existing ct-live layout (Rule: no silent data loss; migrate-then-verify before trusting the file).
- Edward review gate: the three-outcome Close dialog wording and the Recent list placement are taste calls — build, screenshot, he accepts.
