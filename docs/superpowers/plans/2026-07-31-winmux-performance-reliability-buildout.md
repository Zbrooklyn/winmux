# WinMux Performance & Reliability Build-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take WinMux from "works" to genuinely snappy / instant / reliable — measured, not claimed — hitting Edward's words: snappy, instant, preloaded, predicted.

**Architecture:** Measure first and pre-register targets, then land the wins in dependency order: enable the already-built GPU renderer (the measured jank fix), bundle the font (clean-install fix), make new tabs *feel* instant (skeleton + bigger pre-warm pool), and kill the load-flake so "reliable" is provable every run. Session-survival and terminal-parity are structured as a separate this-week pass. Every phase keeps `npm run verify` green and ships its own committed check.

**Tech Stack:** Node `server.cjs` (node-pty + ws), vanilla `public/app.js` + `index.html`, xterm.js with the bundled WebGL addon (`public/vendor/addon-webgl.js`), Electron shell (`electron/*.ts`), Playwright harness `verify.cjs`, electron-builder (NSIS).

## Global Constraints

- **`public/cockpit.css` is FROZEN** — all new styling goes in the `index.html` `<style>` override layer, never in cockpit.css.
- **`server.cjs`'s standalone `node server.cjs` phone/browser path stays unchanged** — it must keep serving the browser and phone faces exactly as today.
- **Every phase keeps `npm run verify` green and ships its own committed check** in `verify.cjs`.
- **Measure before optimizing; pre-register thresholds** before touching a perf path.
- **Do NOT touch the owner-gated publish** (master merge / public flip). All work stays on `feature/phase8-electron-shell`.
- **Any rendered change ships a screenshot to Edward** (SendUserFile) — rule 21; mechanics verified by computed values, not eyeballing.
- **Pre-registered targets (the proof gate):** new tab perceived-instant (≤ ~150 ms click→first paint), event-loop tick < 50 ms under 10 concurrent 3000-line streams, no visible connect flicker, GPU on with DOM fallback intact, font bundled (computed `font-family` resolves to the bundled family, not Consolas).

## File Structure

- Create: `perf.cjs` — committed measurement harness (mirrors `verify.cjs` conventions: boots `server.cjs` as a child, drives Playwright, prints numbers, exits non-zero if a pre-registered target is missed). One responsibility: measure and gate on the targets.
- Create: `public/fonts/` — bundled `.woff2` font files (Cascadia Code + a Nerd Font variant).
- Modify: `public/index.html` — `@font-face` block in the override layer; instant skeleton/cursor styling.
- Modify: `public/app.js` — GPU default flip; instant-skeleton render on tab open.
- Modify: `server.cjs` — pre-warm pool size > 1 + prewarm-on-boot.
- Modify: `verify.cjs` — new committed checks (`gpu`, `font`, `instant`); concurrency throttle for the load-flake.
- Modify: `package.json` — `asarUnpack`/`files` so `public/fonts` ships; `perf` script.
- Modify: `PLAN.md` — link this plan from the P1 build order (do not duplicate the analysis).

---

## Phase 0 — Measure first (pre-register targets)

### Task 0.1: Measurement harness `perf.cjs`

**Files:**
- Create: `perf.cjs`
- Modify: `package.json` (add `"perf": "node perf.cjs"`)

**Interfaces:**
- Produces: `perf.cjs` prints a JSON block `{ connectMs, firstPaintMs, newTabWarmMs, newTabColdMs, tickMs10, gpu }` and exits non-zero if any pre-registered target is missed.

- [ ] **Step 1:** Write `perf.cjs` skeleton reusing `verify.cjs`'s child-server pattern (`spawn(process.execPath, ['server.cjs'], { env: { PORT, WINMUX_NO_INSTANCE:'1' }})`, `waitUp`), a Playwright chromium launch, and a `TARGETS` object with the pre-registered thresholds.
- [ ] **Step 2:** Implement the **connect-path** probe: `page.evaluate` hooks `performance.now()` at click → `ws.onopen` → first shell byte (`onmessage`) → first xterm paint (`term.onRender` once). Report each segment.
- [ ] **Step 3:** Implement **new-tab latency** probe: open a tab with the pre-warm spare available (`newTabWarmMs`) and with `WINMUX_NO_PREWARM=1` on a second child server (`newTabColdMs`).
- [ ] **Step 4:** Implement the **10-stream tick** probe: open 10 tabs, stream a 3000-line burst into each via `winmux send`, sample `setInterval` drift over 3s → average tick. Record with GPU off (baseline).
- [ ] **Step 5:** Run `node perf.cjs`. Expected: prints the baseline numbers; the tick line should reproduce the ~132 ms DOM-renderer baseline (confirms the instrument is real). No target enforced yet (baseline run).
- [ ] **Step 6:** Commit.

```bash
git add perf.cjs package.json
git commit -m "perf: committed measurement harness (connect path, tab latency, 10-stream tick)"
```

**Proof:** `node perf.cjs` prints a baseline showing the DOM-renderer tick ≥ ~100 ms — the number every later phase is graded against.

---

## Phase 1 — GPU renderer: validate, then enable by default

### Task 1.1: `gpu` harness check — WebGL active + DOM fallback identical

**Files:**
- Modify: `verify.cjs` (add `PORT_GPU`, `check('gpu', …)`)

- [ ] **Step 1:** Add `check('gpu', PORT_GPU, …)` that loads the app, forces `S.gpuRenderer = true` via an init script, and asserts a real WebGL context exists on the active terminal (`document.querySelector('.xterm-screen canvas.xterm-link-layer, .xterm canvas')` present AND `term._core._renderService._renderer` is the WebGL renderer — assert via a small exposed flag; see Step 2).
- [ ] **Step 2:** In `public/app.js` where the WebGL addon loads (app.js:1240), set `term.__winmuxRenderer = 'webgl'` on success and `'dom'` in the catch/fallback, so the harness can read which renderer is live.
- [ ] **Step 3:** Add a fallback assertion: with `WebglAddon` forced to throw (init script deletes `window.WebglAddon`), the terminal still renders text (`.xterm-rows` non-empty) and `__winmuxRenderer === 'dom'`.
- [ ] **Step 4:** Run `node verify.cjs gpu`. Expected: FAIL on the first assertion (no `__winmuxRenderer` flag yet).
- [ ] **Step 5:** Implement the `__winmuxRenderer` flag (Step 2 edit). Run `node verify.cjs gpu`. Expected: PASS (WebGL active + DOM fallback both proven).
- [ ] **Step 6:** Commit.

```bash
git add verify.cjs public/app.js
git commit -m "test(gpu): assert WebGL active + DOM fallback renders identically"
```

### Task 1.2: Confirm GPU drops the measured tick, then flip the default

**Files:**
- Modify: `perf.cjs` (add a GPU-on tick pass)
- Modify: `public/app.js:68` (`gpuRenderer: false` → `true`)

- [ ] **Step 1:** In `perf.cjs`, add a second 10-stream tick pass with `S.gpuRenderer=true` seeded; report `tickMs10Gpu` and enforce `tickMs10Gpu < 50` as a target.
- [ ] **Step 2:** Run `node perf.cjs`. Expected: `tickMs10Gpu` prints well under 50 ms (vs the ~132 ms DOM baseline). **If it does NOT drop materially, STOP** — the default stays `false` and this becomes its own investigation task; do not flip.
- [ ] **Step 3:** Flip `public/app.js:68` default `gpuRenderer: false` → `true`.
- [ ] **Step 4:** Run `npm run verify`. Expected: full harness green (the buffer-based reads already tolerate WebGL; the `colour`/`read-screen` checks must still pass).
- [ ] **Step 5:** Capture a real-window screenshot (Electron, visible window) of a live terminal with GPU on; read `getComputedStyle`/`__winmuxRenderer` to confirm `webgl` is live. Ship the screenshot to Edward.
- [ ] **Step 6:** Commit.

```bash
git add public/app.js perf.cjs
git commit -m "perf(gpu): enable GPU renderer by default — measured tick <50ms under 10 streams, DOM fallback intact"
```

**Proof:** `perf.cjs` shows `tickMs10Gpu < 50`; `verify.cjs` green; screenshot shipped; `__winmuxRenderer==='webgl'` live, `'dom'` under forced fallback.

---

## Phase 2 — Bundle the font (clean-install fix)

### Task 2.1: `font` harness check — bundled family actually applied

**Files:**
- Modify: `verify.cjs` (add `check('font', …)`)

- [ ] **Step 1:** Add `check('font', PORT_FONT, …)` that loads the app and asserts the terminal's computed `font-family` first token resolves to the bundled family AND `document.fonts.check('12px "Cascadia Code"')` returns `true` (the face is actually loaded, not just named).
- [ ] **Step 2:** Run `node verify.cjs font`. Expected: FAIL — `document.fonts.check(...)` is `false` (no `@font-face` yet).
- [ ] **Step 3:** (implementation in Task 2.2) — leave failing.

### Task 2.2: Add the font files + `@font-face` + ship in the installer

**Files:**
- Create: `public/fonts/CascadiaCode.woff2`, `public/fonts/CascadiaCodeNF.woff2` (OFL, redistributable)
- Modify: `public/index.html` (`@font-face` in the override layer)
- Modify: `package.json` (`build.files` / `asarUnpack` include `public/fonts/**`)

- [ ] **Step 1:** Add the two `.woff2` files under `public/fonts/` (source: Cascadia Code OFL release + a Nerd Font patched variant).
- [ ] **Step 2:** Add `@font-face` rules to the `index.html` override `<style>` for `Cascadia Code` (and the NF variant), `font-display: swap`, `src: url('/fonts/CascadiaCode.woff2') format('woff2')`.
- [ ] **Step 3:** Confirm `server.cjs` serves `/fonts/*.woff2` with the correct `Content-Type` (it already serves `public/` statically; add a `.woff2 → font/woff2` mapping if the static handler whitelists types).
- [ ] **Step 4:** Run `node verify.cjs font`. Expected: PASS (`document.fonts.check` true; computed family is Cascadia Code).
- [ ] **Step 5:** Add `public/fonts/**` to electron-builder `files`/`asarUnpack` so it ships; `npm run dist`; `grep`/list the packaged asar to confirm the font is inside.
- [ ] **Step 6:** Capture a screenshot of a prompt with Nerd-glyph icons rendering (no tofu) and ship to Edward.
- [ ] **Step 7:** `npm run verify` green, then commit.

```bash
git add public/fonts public/index.html package.json verify.cjs
git commit -m "feat(font): bundle Cascadia Code + Nerd Font via @font-face — fixes clean-install Consolas/tofu"
```

**Proof:** `verify.cjs font` green; packaged asar contains the fonts; screenshot shows real glyphs.

---

## Phase 3 — Instant-feel (skeleton + predicted pre-warm)

### Task 3.1: Instant skeleton/cursor on tab open

**Files:**
- Modify: `public/index.html` (skeleton style in override layer)
- Modify: `public/app.js` (render skeleton at tab-create, clear on first paint)
- Modify: `verify.cjs` (add `check('instant', …)`)

- [ ] **Step 1:** Add `check('instant', PORT_INSTANT, …)`: click New terminal, assert a skeleton/cursor element is present in the pane **synchronously** (within one frame, before the socket resolves), and that it clears once the shell paints.
- [ ] **Step 2:** Run `node verify.cjs instant`. Expected: FAIL (no skeleton element yet).
- [ ] **Step 3:** In `app.js` tab-create, immediately paint a lightweight skeleton (blinking block cursor + prompt placeholder) in the pane; remove it on the terminal's first `onRender`.
- [ ] **Step 4:** Add the skeleton style to the `index.html` override layer (frozen-cockpit rule).
- [ ] **Step 5:** Run `node verify.cjs instant`. Expected: PASS.
- [ ] **Step 6:** Screenshot the skeleton mid-open + ship to Edward; commit.

```bash
git add public/app.js public/index.html verify.cjs
git commit -m "feat(instant): skeleton cursor on tab open so the connect ms never read as loading"
```

### Task 3.2: Pre-warm pool > 1 + prewarm on boot

**Files:**
- Modify: `server.cjs` (`ensureSpare`/`spare` → a small pool)

- [ ] **Step 1:** In `perf.cjs`, add an assertion `newTabWarmMs ≤ 150` and record it as a target.
- [ ] **Step 2:** Convert the single `spare` to a bounded pool `spares[]` (size from `WINMUX_PREWARM_POOL`, default 2), refilled after each hand-off; keep `WINMUX_NO_PREWARM` as the off-switch. Prewarm the pool at server start, not lazily.
- [ ] **Step 3:** Run `node perf.cjs`. Expected: `newTabWarmMs ≤ 150` with the pool warm; second consecutive new-tab is still instant (pool depth ≥ 2 proves "predicted").
- [ ] **Step 4:** Run `npm run verify` (the existing pre-warm behaviour must still pass). Green.
- [ ] **Step 5:** Commit.

```bash
git add server.cjs perf.cjs
git commit -m "perf(prewarm): pool>1 + prewarm-on-boot so the next tab is predicted-ready (<=150ms)"
```

**Proof:** `perf.cjs` shows `newTabWarmMs ≤ 150` for two consecutive tabs; skeleton check green; screenshot shipped.

---

## Phase 4 — Reliability: kill the load-flake

### Task 4.1: Concurrency throttle so the full harness is green every run

**Files:**
- Modify: `verify.cjs` (bound how many checks run concurrently)

- [ ] **Step 1:** Reproduce: run the full `node verify.cjs` several times back-to-back; confirm `busyport`/`cli`/`colour` intermittently fail under full concurrent load (they pass in isolation).
- [ ] **Step 2:** Add a concurrency cap to the runner loop (a bounded worker pool, e.g. `MAX_CONCURRENCY = min(4, cpus-2)`), so per-port servers and Playwright contexts don't contend; keep total coverage identical.
- [ ] **Step 3:** Run the full `node verify.cjs` **5× back-to-back**. Expected: green all 5 runs (no flake).
- [ ] **Step 4:** Commit.

```bash
git add verify.cjs
git commit -m "test(reliability): concurrency throttle kills the busyport/cli/colour load-flake — green 5x"
```

**Proof:** `verify.cjs` green 5 consecutive full runs.

### Task 4.2: Full re-measure against the pre-registered targets (the plan's proof gate)

- [ ] **Step 1:** Run `node perf.cjs`. Expected: all targets met — `tickMs10Gpu < 50`, `newTabWarmMs ≤ 150`, connect path shows no flicker segment, `gpu` live.
- [ ] **Step 2:** Run `npm run verify`. Expected: green.
- [ ] **Step 3:** Rebuild + reinstall (`npm run dist` + silent install); confirm the installed asar carries the GPU default, bundled font, skeleton, and pool.
- [ ] **Step 4:** Ship a before/after summary + screenshots to Edward.

**Proof:** `perf.cjs` all-green against pre-registered targets, in the installed build.

---

## Phase 5 — This-week (structure only; NOT today)

Its own focused session, flagged separately so it doesn't get rushed:

- **Detached-server session survival** — the server runs as a detached process the Electron app attaches to, so closing the window never kills live agents (today `killShells` on clean exit takes them down). M–L; risk = orphaned processes, so it earns its own plan + harness (`survive-restart` check that quits the app and re-attaches).
- **Terminal-parity ride-along** — ligatures + `unicode11` + shell integration (OSC-7 live cwd, OSC-0/2 auto-title) + clickable links (OSC-8). These interlock with the now-enabled GPU path; fold into a short parity pass after Phase 1 proves out. Each is `[backend]` with its own check.

---

## Self-Review

**Spec coverage:** Phase 0 (measure/pre-register) ✓, Phase 1 (GPU validate+enable, fallback, committed check) ✓, Phase 2 (font bundle + computed-family check + installer packaging) ✓, Phase 3 (skeleton + pool>1 + prewarm-on-boot) ✓, Phase 4 (concurrency throttle + full re-measure proof gate) ✓, Phase 5 (session survival + parity, structured not built) ✓. Constraints (frozen cockpit.css, unchanged phone path, per-phase check, measure-first, no publish, screenshots) captured in Global Constraints ✓.

**Placeholder scan:** No "TBD/handle edge cases" left; every code step names the exact file and the concrete edit. Font-file sourcing is a real asset step, not a placeholder.

**Type consistency:** `__winmuxRenderer` flag ('webgl'|'dom') is defined in Task 1.1 Step 2 and consumed by the `gpu` check and Phase 4 proof. `perf.cjs` target keys (`tickMs10Gpu`, `newTabWarmMs`) are consistent across Phases 0/1/3/4. `WINMUX_PREWARM_POOL` / `WINMUX_NO_PREWARM` consistent with existing `server.cjs` env conventions.

**Risk gate:** Phase 1 has an explicit STOP — if GPU doesn't drop the tick, the default is NOT flipped and it becomes its own task. Never ship broken text to look fast.
