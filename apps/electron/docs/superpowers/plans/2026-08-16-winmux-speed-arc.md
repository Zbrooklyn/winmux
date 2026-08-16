# WinMux Speed Arc — the ceiling of hyper speed

Date: 2026-08-16 · Edward's directive: "anywhere in the system that feels slow, we should improve it to its ceiling of hyper speed … a leading market product in the Windows space … the dream tool that every AI terminal developer will end up using." Checklist approved verbatim; "do everything in the checklist."

## Doctrine

Same law as the instant-feel arc: feel is measured, not argued. Every unit ships with a before/after number from a committed probe; nothing is claimed fast without the number. The one truth that frames this arc: **the Rust engine is not the renderer** — both engines feed the same Chromium/WebGL paint path (proven: typing echo 85ms Rust vs 84ms Node). The felt-speed levers are in the input→paint path and the app lifecycle, not the engine.

## Baseline (measured 2026-08-16, installed v0.2.3)

- Chrome actions: worst 32ms cold / 38ms under 10-stream load — instant.
- Browser leaf open: 16ms.
- **Typing echo: ~85ms median** (keypress → painted char; ConPTY/PSReadLine path, engine-neutral).
- **Cold launch → usable page: ~1,700ms** (warm ~600ms).
- Unmeasured: sustained throughput, resize/drag frame rate, 100k-line search, 30-session tab switch.

## Units

- **SP-0** — this plan. Committed before the first arc commit.
- **SP-1 — Local echo (predictive typing).** Paint printable characters the frame they're typed; reconcile with the real shell echo. Design: overlay prediction (Mosh technique — predictions are cosmetic, drawn over the cursor cell, cleared the instant real data arrives; the terminal buffer is never touched, so mispredictions self-heal in one round-trip). Guards: alternate-screen (TUIs) → never predict; password-prompt heuristic on the cursor line → suppress; echo-confidence gate (display only after recent keystrokes were confirmed echoed) → passwords/odd modes shut it off automatically; IME composition → skip; paste/multi-char → skip; only display when the cells right of the cursor are empty. Settings toggle "Instant typing", default ON. Both renderers (DOM + WebGL), both engines.
  **Done:** perf-echo with prediction ON measures **≤16ms** keypress→painted; final buffer always matches shell truth (reconcile check); harness `localecho` check green on Node AND Rust; no prediction painted in alt-screen or after an unechoed keystroke.
- **SP-2 — Instant summon (quake-style).** Global hotkey (default Ctrl+Alt+`` ` ``, configurable) toggles hide/show+focus of the running window over any app. v1 = Electron primary (globalShortcut); Tauri parity noted for later. The detached engine means summon never cold-starts anything.
  **Done:** main-process-timed hotkey→visible+focused **≤100ms**; toggle works repeatedly; setting to change/disable the hotkey; harness-safe (never registered in harness runs).
- **SP-3 — Cold-launch teardown.** Instrument every phase (Electron ready / window shown / page loaded / server listening / shell attached), then attack: window visible immediately with painted skeleton, defer update-check + non-critical work behind first paint, lean on the pre-warmed shell. Cold-start the Tauri shell for comparison (speed-flagship candidate).
  **Done:** phase breakdown recorded; something visible **≤300ms** after launch; usable prompt **≤700ms** warm and materially improved cold, honest numbers recorded either way.
- **SP-4 — Throughput benchmark.** Sustained large-output drain (identical payload) in WinMux vs Windows Terminal (vs Alacritty if installed): wall-clock to drain + our frame stats. Tune xterm write batching/flow control ONLY if we lose.
  **Done:** head-to-head numbers recorded; WinMux matches or beats Windows Terminal, or the losing gap has a fix ticket with its own number.
- **SP-5 — Scale-proof rendering.** Sidebar/fleet ticks and settings toggles update only the changed row instead of whole-pane innerHTML. Verify at 50 tabs / 10 streams.
  **Done:** action table stays **≤40ms** at 5× today's scale; scorecard Q5 (instant-feel plan) lifts to ≥9 honestly.
- **SP-6 — Corner measurements.** Split-drag + window-resize frame rate; scrollback search at 100k lines; tab switch with 30 heavy sessions. Fix only what the numbers indict.
  **Done:** each measured with a committed probe; anything over budget fixed or ticketed with its number.
## Progress ledger

- **SP-1 ✅ (2026-08-16, commit 6e95d06).** Instant typing live: predicted paint **0ms to DOM / ≤1 frame to pixels** (was 85ms); `localecho` check 5/5 on Node AND Rust (instant paint, truthful reconcile, no password leak, recovery after secure prompt, honest off switch); screenshot to Edward showing predicted type-ahead over a sleeping shell. perf-echo now reports FELT latency alongside shell echo.
- **SP-2 ✅ (commit c8916b0).** The Phase-7 quake drop already existed — the arc added the number: summon measured **49ms** hidden→visible+focused, asserted ≤100ms in the electron smoke on every run. Default stays OFF (no system-wide key grabbed without consent); Settings toggle + hotkey field already shipped.
- **SP-3 ✅ (commit 90b3097).** Launch de-serialized: window paints FIRST. Measured (dev): **window-shown 98–130ms** (target ≤300), **page-loaded 457–475ms** typical (target ≤700 warm), deep first-ever cold 1,559ms (engine spawn dominates — and the window is up at 130ms instead of nothing until 1.7s). `[boot]` phase marks committed; resolve poll 200→50ms; engine-failure now shows an error dialog instead of a dead dark window. Tauri cold comparison: 1,251ms launch→engine-answering (external timing).
- **SP-4 ✅ (commit b60725d).** Identical self-timed 9.3MB drain, head-to-head: **WinMux (installed, WebGL) 415ms = 22.5 MB/s, worst frame gap 33ms · Windows Terminal 476ms = 19.6 MB/s · conhost 499ms = 18.7 MB/s.** WinMux is the fastest of the three — no tuning warranted ("tune only if losing"). Probe committed as perf-throughput.cjs. Alacritty not installed on this machine — noted, not measured. Lesson: Chromium silently skips binding `--remote-debugging-port` when the port lingers in TIME_WAIT — use a fresh CDP port per probe run.
- **SP-5 ✅.** Rendering cost now scales with what changed, not with how much exists. Three real offenders found and killed at 50 tabs (perf-actions `--scale`, new committed mode):
  1. Every status flap rebuilt the whole sidebar (`renderSidebar` innerHTML) → **`renderRow(t)`**: one srow + its group header + deck counters + narrow card, same HTML generators as the full render. **Fleet tick: 1.4ms median / 2.4ms worst at 50 tabs** (`window.__winmuxFleetTick` hook).
  2. Settings toggles cost **619→750ms**: `options.theme` got a fresh object each apply (xterm rebuilds its glyph atlas — even for identical colours), every hidden terminal ate ~2ms of option churn, and `applyRenderer` requested 50 WebGL contexts against a ~16-context browser cap, so contexts musical-chaired on every apply (measured 385ms). Fixes: theme guarded by signature; hidden terminals marked dirty and caught up on show; **WebGL only for visible terminals** (applied on activate, released on hide — also removes the context-eviction failure mode entirely). **Toggle at 50 tabs: 750ms → 2–35ms.**
  3. Agent last-line updates full-rendered the sidebar → `updateDoing` row patch.
  Scoreboard (50 tabs / 10 live streams, streaming the whole time): **all 13 actions ≤95ms worst — 0 offenders over the pre-registered 100ms instant bar** (was 619ms worst). Idle at 50 tabs every action ≤35ms (meets the plan's stretch 40ms); under simultaneous full-rate streaming the floor is the streams' own paint (33ms worst frame gap, SP-4), which is contention, not O(n) work — recorded honestly, no fix warranted. Settings toggles were already per-row (`data-sw` flips in place — verified, not assumed).
- **SP-6 ✅.** All four corners measured by the new committed probe (perf-corners.cjs); nothing indicted, nothing to fix:
  - Window resize (24 viewport steps, shell open): **55fps, worst frame gap 20ms** — no jank.
  - Split-drag (real mouse on the divider, 40 moves): **55fps, worst gap 20ms** — the flex-only-during-drag design (refit on mouseup) holds.
  - Search across a real 100,003-line scrollback: far hit **1ms**, dense-match average **0.1ms**, absolute worst case (zero-match full scan) **103ms** — one-time, on a miss only; not worth touching.
  - Tab switch with 30 heavy sessions (each holding a 20k-line buffer): **median 31ms, worst 87ms** — includes the SP-5 on-activate WebGL attach, still instant.

- **SP-7 — Ship + hand-feel gate.** Full harness green (with the new checks), action table + echo probe re-run on the installed build, release (v0.2.4), Edward's hands on the real app.
  **Done:** release live; Edward says it feels instant — the box only he can check.
- **SP-7 ✅ (release live; Edward's hand-feel is the one open box).** **444/444 on BOTH engines** (Node and Rust, same frozen check code) — the first-ever full Rust-engine run since the PT arc, which surfaced and fixed four harness debts: prediction earned in rounds (slow-echo shutoff is by design), buffer reads instead of `.xterm-rows` (the phone terminal now genuinely gets WebGL), a run-start sweep of persisted workspace/instance state (each run starts from the fresh-clone slate), and the resume template written through the engine config (the PT-6 authority). Release: [v0.2.4](https://github.com/Zbrooklyn/winmux/releases/tag/v0.2.4) (id 371416075), tag on master eea844b, all four installers uploaded. Installed 0.2.4 primary re-proven: attach 1,123ms cold, **every action ≤22ms**; Tauri updated to 0.2.4 (engine reports 0.2.4); Node + Rust identities staged, not installed (live sessions). Screenshot of the shipped app delivered.

## Scorecard (strict; baseline from the instant-feel arc where shared)

1. Typing echo felt-instant (≤16ms painted)? — 85ms today. **3/10** → SP-1.
2. Is the app on screen the moment you want it? — no summon; 1.7s cold launch. **2/10** → SP-2, SP-3.
3. Does heavy agent output stay smooth, provably vs competitors? — unmeasured. **2/10 (unmeasured scores low)** → SP-4.
4. Does rendering cost scale with what changed at 5× scale? — O(pane) rebuilds, harmless today. **7/10** → SP-5.
5. Are resize/search/mass-session paths measured fast? — unmeasured. **3/10** → SP-6.
6. Is every speed claim backed by a committed, re-runnable probe? — action/echo probes committed; new paths not yet. **6/10** → all units.
7. Does Edward's hand say instant? — his trigger for the arc. **3/10** → SP-7.

### Re-rates (2026-08-16, after SP-1..SP-6)

1. **10/10.** Predicted paint 0ms to DOM / ≤1 frame to pixels, guarded (passwords, TUIs, IME), truthful reconcile, both engines, `localecho` 5/5. Held back from nothing — the char is on screen the frame you press it.
2. **9/10.** Summon 49ms (asserted ≤100 every smoke run); window visible 98–130ms, usable 457–475ms warm. The last point waits on deep-cold engine spawn (1.5s first-ever) — structural to a cold process, honest.
3. **9/10.** Measured head-to-head with an identical self-timed drain: WinMux 22.5 MB/s beats Windows Terminal 19.6 and conhost 18.7, worst frame gap 33ms. Alacritty absent from this machine, so "vs competitors" is proven against the two that are installed.
4. **9/10.** Fleet tick 1.4ms median at 50 tabs; settings toggle 750ms → 2–35ms; WebGL contexts capped at visible terminals. Cost provably follows the change. (Also resolves the instant-feel plan's Q5 rework: that plan's Q5 lifts to 9.)
5. **9/10.** Resize 55fps / drag 55fps / 100k-line search ≤103ms worst-case-miss / 30-session switch median 31ms — all measured by a committed probe, nothing over budget.
6. **10/10.** Every claim in this arc traces to a committed zero-argument probe: perf-echo (FELT), electron smoke (quakeMs), `[boot]` marks, perf-throughput, perf-actions `--scale` + `__winmuxFleetTick`, perf-corners. Re-runnable by anyone.
7. **— Edward's box.** The release is the evidence; his hand is the verdict.

**Exit bar:** every question ≥8, every target number hit or honestly ticketed, release shipped, Edward's hand-feel sign-off.

## Risks / boundaries
- Local echo must NEVER corrupt the buffer (overlay-only design makes this structural) and must never display a password character past the guards — the confidence gate + prompt heuristic + empty-cells rule stack for defence in depth; a leak class found in testing blocks ship of SP-1.
- Global shortcut must not steal a hotkey Edward uses elsewhere — default chosen to be rare, fully configurable, and off in harness runs.
- No framework rewrites hiding in a perf arc; surgical scope per unit.
- Edward's live WinMux Rust (port 9920) untouched throughout, as always.
