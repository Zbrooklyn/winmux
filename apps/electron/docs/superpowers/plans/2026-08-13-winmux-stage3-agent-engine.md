# WinMux Stage 3 — Agent-First Orchestration Engine (Master Plan v2, post-critic)

Size: MEDIUM-LARGE (bounded feature, but safety-sensitive supervision + a real orchestration protocol). Existing project, reversible feature branch. Revised after a Codex independent critic pass that flagged real design issues; resolutions folded in below.

> **Build status (2026-08-13):** P0–P4 landed and verified on both engines; P5 docs + CI-widen in this commit. Tier-1 mechanism proof is green in the harness (agentjob 9/9 Node + Rust, agentspawn 3/3 Node + Rust). Tier-2 real-Claude E2E and P6 supervision remain open — the E2E is the designated owner surface (needs an authenticated `claude` CLI on the live machine + Edward's eyes on a recording); P6 auto-restart stays OFF/opt-in/gated.

## 1. Goal
A Claude session (A) inside WinMux can **spawn** a second Claude session (B), **wait** until B finishes, receive **B's result as data**, and (later, gated) **maintain** B. Core loop (v1) must work on BOTH engines (Node + Rust) with a server-side store, and must NOT depend on screen-scraping.

## 2. Current-state recovery (confidence: MEDIUM-HIGH; P0 closes the gaps)
- CLI `bin/winmux.cjs` → POST `/rpc {cmd,args}` → `server.cjs:1103` → `callApp` relays EVERY verb to the app over `/control`. Agent state lives in the renderer (app.js `t.status`), ephemeral, keyed by `WINMUX_SID`. No server store, no result, no blocking wait. Rust `/rpc`+`/control` are byte-blind relays of the same app.js.
- **NOT yet proven (P0 must establish, with exit criteria):** (a) does `new-tab` return the new session's SID? (b) exact `/rpc` response schemas; (c) the reliable completion signal (cooperative report) and the reliable crash signal (needs a wrapper — see below); (d) captured baseline `npm run verify` output.

## 3. Design decisions (baked in, resolving the critic)
- **Identity = server-minted `jobId`** (generation-aware), not SID. SID addresses a session; jobId is the unit of work. A report/wait/result all carry jobId. Terminal states are immutable; a stale report can't satisfy a new wait.
- **Completion is a COOPERATIVE protocol.** B signals done/failed + result by calling `winmux agent done --result …` from its Claude Code **Stop hook** (or task instruction). WinMux cannot infer "Claude finished" from the shell, because `claude` runs inside a persistent PTY that stays alive at a prompt. **Honest limit:** a clean B exit that never reports → resolves as `timeout`, not `done`. Crash-without-report detection needs the wrapper (P5).
- **Spawn = register(jobId) THEN launch**, never launch-then-register (closes the report-before-registered race). Prompt is passed **safely** (temp file / stdin / strict escaping), never naive string-interpolated into `claude "<prompt>"`. Spawn returns `{jobId, sid}`.
- **Result contract:** UTF-8 string, hard size cap (64 KB, truncate + flag), single terminal report wins, stored verbatim, returned as one JSON envelope `{jobId, sid, state, result, exitCode, startedAt, endedAt}` — byte-identical shape on Node and Rust.
- **Wait semantics:** event-driven resolve (<1s after a report), **default timeout 90s** (well under Claude's 600s Bash ceiling), **resumable** — on timeout it returns the current state (`working`) with a non-terminal exit so A can immediately re-wait or do other work. Exit codes: `0`=done, `2`=failed, `3`=timeout/still-working, `4`=unknown-job.
- **State machine:** `created → working → (done | failed)`; terminals immutable; unknown jobId → error `4`; multiple concurrent waiters allowed; retention = cap N + TTL eviction; local-desk-door only (phone → 403), so authorization is "local process."
- **Single engine per instance** (a running WinMux is Node XOR Rust on one port) — the store is per-instance in-memory; parity means identical behavior, NOT shared state. In-memory (no disk) is fine for v1; sessions don't survive a full server restart today either.

## 4. Two-tier validation (critic #12 — synthetic can't prove real orchestration)
- **Tier 1 — mechanism (CI-safe, both engines):** verify.cjs checks with a synthetic reporter — store round-trip, wait-unblocks-on-report (<1s), timeout→resumable, jobId isolation, result envelope parity Node vs Rust. Added to the serial CI slice.
- **Tier 2 — real-Claude E2E (local, NOT CI, needs auth):** one real Claude session spawns another, B reports done+result via its Stop hook, A waits and receives the result. Screen-recorded proof to Edward. Prereqs stated: claude CLI installed + authenticated in B's shell, WinMux app open (spawn needs the renderer), Stop-hook merged.

## 5. Roadmap
- **P0 — Discovery + protocol spike (no shipping code).** Establish the four unknowns in §2 with hard exit criteria; write the jobId/result/wait contract as a short DESIGN note. Exit: new-tab-SID answer known, completion+crash signals chosen, RPC schemas + baseline captured. Validation: the written contract + evidence.
- **P1 — Server-side job store + report/status (Node).** In-memory jobId store; server-handled `/rpc` verbs (`job-report`, `job-status`, `job-list`) intercepted BEFORE the relay; extend `agent` to record state+result. Existing verbs stay pure-relay (regression = current 16 CI checks). Validation: Tier-1 round-trip check.
- **P2 — Blocking `agent wait` (Node).** Event-driven `/rpc job-wait {jobId,timeoutMs}` + CLI `winmux agent wait --job … [--timeout 90]`, resumable, defined exit codes. Validation: Tier-1 unblock (<1s) + timeout-resumable + jobId-isolation checks.
- **P3 — Spawn + safe prompt + result plumbing (Node).** `winmux agent spawn "<prompt>" [--shell][--name][--cwd]` = mint jobId → register → new-tab → launch claude with the prompt passed safely → return {jobId,sid}. `winmux agent result --job …`. Validation: Tier-1 spawn-registers-before-report; injection/escaping check (newlines/quotes/metachars).
- **P4 — Rust parity.** Mirror store + verbs + event-driven wait (Mutex + Notify, lost-wakeup-safe) in main.rs. Validation: `WINMUX_CORE=rust` Tier-1 checks + brand/footer regression green.
- **P5 — Docs + real-Claude E2E + CI widen.** README agent section, docs/agent-integration.md (the Stop-hook completion protocol), CHANGELOG; widen CI slice; run the **Tier-2 real-Claude E2E** and ship the recording. Validation: Tier-2 pass on the live machine + Tier-1 green in CI both engines.
- **P6 — Maintain / supervision (SEPARATE approval; default-safe).** A wrapper owns B's `claude` child so crash = child exit (not PTY exit); on crash-without-report → mark `failed` + raise attention. **Auto-restart is OPT-IN, OFF by default, and gated** (replaying an agent can duplicate commits/edits/deploys — critic #9). Validation: kill B's child, assert failed+attention; auto-restart only behind an explicit flag with an idempotency warning.

## 6. The one real owner decision (everything else I own)
"Maintain" splits into two very different things:
- **Detect + surface** (mark failed, raise attention when B dies without finishing) — safe, I build it in P6 by default.
- **Auto-restart** (re-run B's prompt) — genuinely risky: it can repeat side effects (duplicate commits, edits, deploys). Recommendation: ship it OFF by default, opt-in per-job, with a warning; never a silent default.
Also honest scoping: even with all this, WinMux only knows B "finished" if B **reports** it (cooperative). True zero-cooperation supervision is not achievable through a terminal; the wrapper (P6) is the closest.

## 7. Risks + rollback
- Wait hangs → mandatory default timeout + resumable. Injection → safe prompt passing (P3 check). Rust wait deadlock/lost-wakeup → Notify pattern + Rust Tier-1 check. Auto-restart side effects → OFF by default, gated (P6).
- Rollback: each phase = its own commit on the feature branch; revert the phase. **Runtime rollback too:** on abort, kill spawned sessions + clear the store (source revert alone doesn't stop live agents). Never force-push; master untouched until Edward promotes. Last known good = master c5a62a5 (baseline suite captured in P0).

## 8. Approval + handoff
One bundled approval: (a) this shape, (b) v1 = P0–P5 (spawn+wait+result, both engines, with the real-Claude E2E gate), (c) the jobId/cooperative-completion/safe-spawn architecture, (d) P6 supervision built as detect+surface with **auto-restart OFF/opt-in/gated**. `/super-run` persists this to `apps/electron/docs/superpowers/plans/`, drives P0 first via `/loop 3m`, reports at the P5 milestone, and re-confirms before P6 turns on any auto-restart. Nothing crosses a master/prod/destructive gate.
