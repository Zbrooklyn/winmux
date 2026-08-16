# WinMux Market-Door Arc — kill the five confusion blockers (all but signing)

Date: 2026-08-16 · Edward directive: "fix all of it except app signing"
Source: market-readiness audit — the product is production-ready inside; strangers get lost at the door.
Out of scope (Edward's explicit gates): code signing (money), auto-install updates, TS-7 Tauri browser panel.

## The five blockers being fixed

2. Release page shows four installers with zero guidance (README names the right one, the release page doesn't).
3. Phone flow assumes the user knows Tailscale; the no-Tailscale state names the problem but never explains what Tailscale is or links to it.
4. Welcome card promises "peek at what Claude or Codex is doing" but the first session has no path to experience it.
5. Closing the window silently leaves the engine + shells running — correct behavior (session survival), never explained; unsigned app + persisting processes reads as malware to a stranger.
6. Vocabulary stack (tab/group/session/detached/project) has no in-app definition anywhere.

## Units

- **MD-1 — this plan file.** ✅ before first commit.
- **MD-2 — download guidance.** PATCH the v0.2.1 release body with a "Which download?" section: **WinMux Setup** = the app (start here); WinMux-Rust = second side-by-side identity (advanced); WinMux-Tauri = experimental lightweight shell (**beta** — no embedded browser panel yet); WinMux-Node = legacy Node engine (compatibility). README gets the same short block under Download. NO asset renames (winget manifest + existing links depend on names). Done = release body live + README committed.
- **MD-3 — Tailscale explainer.** In the Phone settings pane, the no-Tailscale state and the switch-off explainer gain one plain sentence ("Tailscale is a free private network between your own devices — install it on this PC and your phone, signed in to the same account") plus a real link to https://tailscale.com/download (opens externally in Electron via the existing openExternal bridge; target=_blank in browser/phone). Engine APIs already expose `tailscale:false` — UI-only change, shared app.js so all four apps get it. Done = both states render the explainer + link works in Electron and browser.
- **MD-4 — agent-promise path.** The welcome card's "Built for agents" point becomes clickable → opens a small Agents guide overlay (house overlay style): (1) the fleet sidebar + eyeball peek, (2) the orchestration panel, (3) connect-your-agent one-liner (`winmux-mcp` / CLI `winmux agent spawn`), with a button that opens the fleet panel live. Same guide reachable from the command palette ("Agents guide"). Keep #wc-start/#wc-phone ids untouched (harness). Done = clickable path exists from first-run promise to a live agent surface + guide screenshot.
- **MD-5 — first-close honesty.** Electron main, packaged builds only (`isPackaged` gate keeps the dev harness unaffected): on first window close, one dialog — "Your terminals keep running in the background so you can pick them up later." Buttons: Keep running in background (default) / Quit completely (kills engine via existing shutdown path). "Remember my choice" checkbox persisted in userData; Settings > Behaviour gains a row to change it later. Done = dialog proven on a packaged build, choice persists, quit-completely actually ends the engine.
- **MD-6 — vocabulary card.** Existing cheat-sheet/tutorial overlay gains a compact "Words WinMux uses" card: tab, group, session, detached session, project — one line each. Sweep visible UI copy for consistent use of exactly those terms. No new surfaces. Done = card renders desktop + narrow.
- **MD-7 — verify + ship proof.** build:electron; full harness green (pause the Tauri app to free :9921 — winmux#1); screenshots of every new/changed state (welcome, phone no-Tailscale, agents guide, close dialog, vocab card) at desktop + narrow, shipped to Edward; commit+push feature + master.
- **MD-8 — release v0.2.2.** Bump package.json + winmux-core Cargo.toml + tauri conf to 0.2.2; rebuild engine + all four installers (CARGO_TARGET_DIR off-Dropbox; retry on 0xC0000142); publish v0.2.2 release whose body leads with the Which-download section; update installed apps that are safe to touch (Node + Tauri = mine; WinMux Rust only if no live sessions, else stage + hand to Edward). Winget PR #418279 stays at 0.2.1 (retargeting mid-moderation restarts review; 0.2.2 goes to winget after merge) — owned decision, reported.

## Risks
- Welcome overlay changes must not break harness first-run checks (ids stable, new elements additive).
- Close dialog must never appear in dev/harness runs (isPackaged gate) and must never block shutdown paths.
- Release-body PATCH must preserve existing 0.2.1 notes (append section, not replace).
