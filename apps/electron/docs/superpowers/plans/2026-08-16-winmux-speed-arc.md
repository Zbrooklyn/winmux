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
- **SP-7 — Ship + hand-feel gate.** Full harness green (with the new checks), action table + echo probe re-run on the installed build, release (v0.2.4), Edward's hands on the real app.
  **Done:** release live; Edward says it feels instant — the box only he can check.

## Scorecard (strict; baseline from the instant-feel arc where shared)

1. Typing echo felt-instant (≤16ms painted)? — 85ms today. **3/10** → SP-1.
2. Is the app on screen the moment you want it? — no summon; 1.7s cold launch. **2/10** → SP-2, SP-3.
3. Does heavy agent output stay smooth, provably vs competitors? — unmeasured. **2/10 (unmeasured scores low)** → SP-4.
4. Does rendering cost scale with what changed at 5× scale? — O(pane) rebuilds, harmless today. **7/10** → SP-5.
5. Are resize/search/mass-session paths measured fast? — unmeasured. **3/10** → SP-6.
6. Is every speed claim backed by a committed, re-runnable probe? — action/echo probes committed; new paths not yet. **6/10** → all units.
7. Does Edward's hand say instant? — his trigger for the arc. **3/10** → SP-7.

**Exit bar:** every question ≥8, every target number hit or honestly ticketed, release shipped, Edward's hand-feel sign-off.

## Risks / boundaries
- Local echo must NEVER corrupt the buffer (overlay-only design makes this structural) and must never display a password character past the guards — the confidence gate + prompt heuristic + empty-cells rule stack for defence in depth; a leak class found in testing blocks ship of SP-1.
- Global shortcut must not steal a hotkey Edward uses elsewhere — default chosen to be rare, fully configurable, and off in harness runs.
- No framework rewrites hiding in a perf arc; surgical scope per unit.
- Edward's live WinMux Rust (port 9920) untouched throughout, as always.
