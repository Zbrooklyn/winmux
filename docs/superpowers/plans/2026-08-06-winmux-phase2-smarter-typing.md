# WinMux Phase 2 — Smarter Typing (Inline Command Prediction)

**Goal:** As you type in a WinMux terminal, faint grey text completes your command from history; RightArrow accepts it. No popup.

## Outcome (2026-08-06): it's a shell feature, not something we build or inject

The original plan assumed WinMux would *enable* prediction by injecting
`Set-PSReadLineOption -PredictionSource History -PredictionViewStyle InlineView`
into every PowerShell shell it spawns. Grounding on the real machine killed that
approach:

- **WinMux's default shell is Windows PowerShell 5.1** (`powershell.exe`), which ships
  **PSReadLine 2.0.0** — this predates `-PredictionSource` entirely. The injected option
  throws (swallowed by the `try/catch`), and no injection can turn prediction on there.
  Verified: `PSV=5.1.26100.8875 PSRL=2.0.0 PRED=(blank)`.
- **PowerShell 7 (`pwsh`) ships PSReadLine 2.4.5**, which renders inline grey
  history prediction **by default, with no injection at all.** Verified at the pty layer:
  typing `echo winmuxGHOS` emits `\e[2m\e[3mTtest` (dim + italic = the faint grey ghost
  completion) with the cursor moved back — exactly the "faint text, RightArrow accepts,
  no popup" the feature describes. `pwsh 7.6.4` is installed on this machine.

So "smarter typing" is delivered by **using PowerShell 7**, which WinMux already spawns
and already exposes in Settings → Default shell. There is nothing to build and nothing to
inject. The dead injection was removed from `server.cjs` `spawnSession`.

## What shipped (reversible, backend — done)

- **`server.cjs`** — removed the PSReadLine injection block; replaced with a comment
  explaining prediction is the shell's job (pwsh 7 native; impossible on 5.1).
- **`verify.cjs`** — the `prediction` check now opens a **pwsh tab** (via
  `desktop(browser, { defaultShell: 'pwsh' })`) and proves inline prediction renders +
  RightArrow accepts. It **skips cleanly** (single pass) on a machine without pwsh
  installed, since that's an OS property, not a WinMux regression. 3/3 green.

## The one owner decision (gated — Edward)

Out of the box, WinMux opens **5.1** (`DEFAULT_SHELL_KEY = 'powershell'` in `server.cjs`;
`DEFAULT_SHELL = 'powershell'` in `public/app.js`), so prediction is dark until the user
switches to PowerShell 7 in Settings. Making pwsh the default **when it's installed**
would light up prediction (and a generally better shell) on first launch.

That changes what the user sees on screen at launch → **visible change, Edward-gated**
(BUILD-PLAN line 7 + the standing "no new front-end without approval" rule). Recommendation:
default to pwsh 7 when detected, fall back to 5.1 when not. Not flipped yet — awaiting OK.

If approved: change `DEFAULT_SHELL_KEY` (server.cjs) + `DEFAULT_SHELL` (app.js) to prefer
`'pwsh'` when `detectPwsh()` succeeds, keep `'powershell'` fallback, re-run the harness,
screenshot the first-launch prompt, then mark Phase 2 done in BUILD-PLAN.md + PLAN.md.
