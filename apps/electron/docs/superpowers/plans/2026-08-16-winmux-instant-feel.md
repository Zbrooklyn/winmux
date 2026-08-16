# WinMux Instant-Feel Arc — everything the hand touches responds now

Date: 2026-08-16 · Edward objective 2: "certain areas don't feel snappy enough — GPU rendering, actions — things I feel could be more instant."

## Doctrine

Feel is measured, not argued (Rule 21 sibling): every claim in this arc is a before/after number from the perf harness, plus Edward's hand on the real app for acceptance. Perceived speed counts as much as raw speed — response within ~100ms reads as instant; anything the UI can acknowledge optimistically, it should.

## What exists

- `perf.cjs` measures startup/first-paint/typing-tick/new-tab with baselines (Phase 0–4 arc, GPU renderer + font bundling + pre-warm + throttle all landed with measured gates).
- What it does NOT yet measure: interactive action latency — palette open, settings open (and per-toggle re-render), tab switch, sidebar toggle, group expand, peek open, diff open, welcome delay, menu opens. These are exactly where "doesn't feel snappy" lives.
- Known code smells to test (suspects, not verdicts): settings pane re-renders wholesale per toggle; sidebar re-renders on fleet ticks; artificial setTimeouts (400ms welcome, 60ms tab-click chains); synchronous /api calls before paint on some opens; xterm refit storms on layout changes.

## Units

- **IF-1** — this plan. ✅
- **IF-2 — Measure first.** Extend perf.cjs with an `actions` mode: click→next-paint latency for ~12 interactions (palette, settings open, each settings tab, one toggle flip, new tab, tab switch, sidebar toggle, group drill-in, peek, diff leaf, markdown leaf, close-tab). Run against the dev build AND the installed app for a real-machine baseline. Output a ranked table. No fixes in this unit. ✅ **Done 2026-08-16:** perf-actions.cjs (dev, idle + --load), perf-installed.cjs (installed primary app via CDP), echo probes on both engines. Ranked result: NO action anywhere measured exceeds 38ms; typing echo is the slowest input at ~85ms median, engine-neutral. Full numbers in the scorecard re-rates below.
- **IF-3 — Fix batch 1 (worst offenders).** Take the top of the ranked table; typical moves: render only the changed row/pane instead of whole-pane innerHTML; cache built DOM for overlays; remove/shrink artificial delays; move API reads off the open-path (open instantly, fill in); requestAnimationFrame-align paints. Surgical, per-offender commits.
  **Disposition after IF-2 (2026-08-16): no batch to fix.** The measured table has zero offenders over the 100ms instant budget — every suspected smell (whole-pane rebuilds, click-path fetches, missing overlay caches) was measured harmless at real scale. Building "fixes" for sub-40ms actions would be unfelt complexity (Simple First). The one number near the budget — 85ms typing echo — is the shared ConPTY/shell path, not chrome; the only lever is local echo/prediction (predict the typed char into xterm before the shell round-trip, reconcile on echo — the Mosh technique). That is a substantial feature with real failure modes (password prompts, TUIs, IME), so it goes to Edward as a roadmap decision, not a silent build.
- **IF-4 — Re-measure + prove.** Same probes, same machine; every fixed action shows its delta; nothing regressed (typing tick + startup re-run). Numbers to Edward.
- **IF-5 — Perceived-instant polish.** Optimistic acknowledgment where real work takes time (pressed states, immediate overlay shells); only where IF-2 shows the wait is irreducible.
- **IF-6 — Ship.** Harness green, release (0.2.3 or fold into next), Edward's hand-feel acceptance on his real machine is the exit gate — his "feels snappy" is the done-criterion, numbers are the evidence.

## Scorecard — the questions we hold ourselves to (baseline 2026-08-16, re-rate after every unit)

Strict ratings; "unmeasured" scores low on principle — we don't get credit for speed we can't prove.

1. Do we know, in numbers, our slowest user-facing actions? — Startup/typing measured; the ~12 daily actions never measured. **2/10** → IF-2.
   **IF-2 partial result (2026-08-16): perf-actions.cjs landed (13 probes, idle + --load). Dev-stack baseline: idle worst 31ms, under 10-stream load worst 38ms — chrome actions are instant in a clean browser. Re-rated 2→6.** Remaining to 10: measure inside the installed Electron shells, the webview browser leaf, startup/window-restore, typing echo on the Rust engine, and Edward's named slow moments.
   **IF-2 complete (2026-08-16):**
   - **Installed app measured** (perf-installed.cjs against the primary `WinMux.exe` via CDP): all 12 actions cold+warm, worst **29ms** — the installed shell is as instant as the dev stack. Launch→app-page attach 1691ms (startup, not action latency).
   - **Typing echo measured on BOTH engines** (identical isolated probe, DOM renderer, keypress→painted char): **Rust median 85ms / max 91ms; Node median 84ms / max 91ms** (n=14 each). Engine-neutral to within 1ms — the plan's Rust-engine suspicion (Boundaries note) is cleared by evidence. The latency lives in the shared path: browser key dispatch → ws → ConPTY → PSReadLine echo → ws → xterm DOM paint, plus ~a frame of poll granularity in the probe itself. This range matches native Windows terminal stacks (conhost/Windows Terminal echo is typically 40–90ms); it is the strongest candidate for what Edward feels while typing, and it is NOT fixable by chrome/render work — only local echo/prediction (a large feature, see IF-3 note) would move it.
   - **Re-rate: Q1 6→8.** Held below 10 honestly: webview browser-leaf probes not run, and Edward's specific felt-slow moments not yet named/replayed.
2. Does every input acknowledge within ~100ms? — Unmeasured; code suspects say no. **3/10 (unproven)** → IF-2 then IF-3.
   **IF-2 re-rate 3→7:** every measured input acknowledges well under 100ms (chrome ≤38ms worst under load; typing echo ≤91ms max on both engines). Held at 7: unmeasured surfaces remain (webview leaf) and 85ms typing is inside but near the budget.
3. Is anything artificially delayed? — Yes: 400ms welcome, 60ms click chains, assorted throttles; some justified, none revisited since written. **4/10** → IF-3.
   **IF-2 audit (2026-08-16), re-rate 4→8:** every setTimeout ≥250ms in app.js was read and justified: 400ms welcome (one-time onboarding, intentional beat), backlog/workspace save throttles (I/O batching, not on any paint path), reconnect/backoff timers (network), toast/animation timings (design). The 60ms tab-click chains are animation-frame-scale, below perception. No delay sits on an acknowledgment path. Held at 8 not 10: justification is an audit, not a harness guard.
4. Is work done on the click path that could happen before or after? — Settings rebuilds its whole DOM on open; some opens fetch before paint. **4/10 (suspected)** → IF-3.
   **IF-2 re-rate 4→8:** the click-path work exists but is measured cheap — settings-open 29ms worst installed. Suspicion resolved by numbers, not refactor; held at 8 because the structure would surface again if pane content grows 10×.
5. Does rendering cost scale with what changed, or with page size? — Whole-pane innerHTML re-renders (settings per toggle, sidebar on fleet ticks). **3/10** → IF-3.
   **IF-2 re-rate 3→7:** structurally still O(pane), but the --load pass (10 live streams) shows worst 38ms — at real workspace scale the cost is imperceptible. Honest 7: the scaling shape is unchanged, only proven harmless today.
6. Is the GPU used everywhere it helps? — Terminal yes (WebGL default, proven); ligatures toggle honestly documents its software-renderer cost. **7/10** → hold.
7. Does it stay snappy under load (streaming agents, many tabs)? — Throttle + refit fixes landed with measured gates; chrome actions under load unmeasured. **6/10** → IF-2 includes an under-load pass.
   **IF-2 re-rate 6→8:** under-load pass run — 10 streaming sessions, worst action 38ms (vs 31ms idle). Load costs ~7ms, well inside budget.
8. Is the second time instant even when the first isn't (warm caches)? — No overlay DOM caching; everything rebuilds every open. **3/10** → IF-3.
   **IF-2 re-rate 3→9:** the no-caching hypothesis is refuted by measurement — warm opens are ≤29ms in the installed app and ≤38ms under load in dev (settings/palette/cheat all rebuild fast enough that caching would buy nothing perceivable). The suspected smell was real code, but not a real cost. No IF-3 work warranted here.
9. Do we re-measure on every release (regression guard)? — perf.cjs exists but is not a release gate. **5/10** → IF-4 makes the action table part of release proof.
10. Does Edward's hand say it feels instant? — He says no; that's this arc's trigger and its exit gate. **3/10** → IF-6.

**Baseline: 40/100.** Exit bar: every measured action <100ms to first acknowledgment (or optimistically acknowledged), no question below 8, and Edward's hand-feel sign-off.

**After IF-2 (2026-08-16): 70/100** (Q1 8, Q2 7, Q3 8, Q4 8, Q5 7, Q6 7, Q7 8, Q8 9, Q9 5, Q10 3). Remaining map: Q9 5 → IF-4 makes the action table + echo probe part of release proof; Q2/Q5/Q6 at 7 → webview-leaf probe + honest structural notes; Q10 3 → Edward's hand-feel (IF-6 gate) plus his named slow moments replayed; the 85ms typing echo goes to him as the local-echo roadmap decision.

## Boundaries
- GPU renderer stays default-on; any renderer change re-proves the Phase-1 tick gate.
- No framework rewrite hiding inside a perf arc (omni-repo restructure is its own future arc).
- Rust engine untouched unless IF-2 proves engine latency (unlikely — prior measurements put it ahead of the Node engine).
