# WinMux Terminal-Parity Ride-Along Implementation Plan

> **For agentic workers:** Execute task-by-task. Each task is an independently testable unit that keeps `npm run verify` green and ships its own committed harness check + screenshot for any rendered change.

**Goal:** Bring WinMux's terminal up to modern-emulator parity — clickable links, correct wide-glyph width, shell integration (cwd / command marks / auto-title), and font ligatures — matching what Windows Terminal / iTerm / WezTerm users expect.

**Architecture:** All four are xterm.js addon / parser integrations layered onto the existing `makeTerm` path in `public/app.js`. Addons are hand-vendored as local UMD files in `public/vendor/` (offline product — no CDN), loaded via `<script>` in `public/index.html`, wired in `app.js`. Shell integration uses `term.parser.registerOscHandler`. cockpit.css stays FROZEN — any new CSS goes in the `index.html` override layer. The pure-web/phone path (plain `node server.cjs`) must keep working.

**Tech Stack:** xterm.js 5.5.0, @xterm/addon-web-links 0.11, @xterm/addon-unicode11 0.8, @xterm/addon-ligatures 0.9 (gated — see T4).

## Global Constraints

- cockpit.css is FROZEN — new styles go in the `index.html` override layer only.
- Keep the standalone `node server.cjs` phone/browser path unchanged and working.
- Every task keeps `npm run verify` green and ships its own committed harness check.
- Any rendered change ships a screenshot to Edward (rule 21).
- Addons vendored locally (UMD in `public/vendor/`), never loaded from a CDN.
- Commit + push per unit on `feature/phase8-electron-shell`.
- Do NOT touch the v2 Rust/Tauri rewrite.

---

### Task T1: Clickable hyperlinks (web-links addon + OSC-8)

**Files:**
- Copy: `node_modules/@xterm/addon-web-links/lib/addon-web-links.js` → `public/vendor/addon-web-links.js`
- Modify: `public/index.html` (add `<script src="/vendor/addon-web-links.js">`)
- Modify: `public/app.js` (`makeTerm` — load WebLinksAddon with a handler that opens in the WinMux browser panel under Electron, else `window.open`)
- Test: `verify.cjs` (`links` check)

**Done-criteria:** A bare URL printed to the terminal becomes a hoverable, clickable link; clicking it under Electron routes to the browser panel (`runControl browser`) and in web mode opens a new tab. OSC-8 explicit hyperlinks (`ESC ] 8 ; ; url ESC \ text ESC ] 8 ; ; ESC \`) are also clickable. Harness asserts the addon is loaded and a link decoration is registered for a printed URL.

- [ ] Copy the vendor file, add the script tag, wire `new WebLinksAddon.WebLinksAddon(handler)` in makeTerm after fit/search.
- [ ] Handler: if `window.winmux?.isElectron` (or the control channel is present) open in the browser surface; else `window.open(url, '_blank', 'noopener')`.
- [ ] Add `links` check to verify.cjs: write a URL, assert `.xterm-rows a` / link hover decoration exists (renderer-independent: use the link provider registration or the underline decoration).
- [ ] `npm run verify` green; screenshot a terminal with a clickable URL underlined on hover.
- [ ] Commit + push.

### Task T2: Unicode 11 width (unicode11 addon)

**Files:**
- Copy: `node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js` → `public/vendor/addon-unicode11.js`
- Modify: `public/index.html` (script tag)
- Modify: `public/app.js` (`makeTerm` — load addon, set `term.unicode.activeVersion = '11'`)
- Test: `verify.cjs` (`unicode` check)

**Done-criteria:** Wide glyphs (CJK, emoji) occupy 2 cells and don't smear/overlap adjacent cells. Harness asserts `term.unicode.activeVersion === '11'` and a wide codepoint measures width 2 via `term.buffer`.

- [ ] Copy vendor, add script tag, `term.loadAddon(new Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11';`
- [ ] Add `unicode` check: assert activeVersion 11 + a wide char is 2 cells.
- [ ] `npm run verify` green; screenshot emoji/CJK rendering cleanly aligned.
- [ ] Commit + push.

### Task T3: Shell integration (OSC-7 cwd · OSC-133 marks · OSC-0/2 title)

**Files:**
- Modify: `public/app.js` (`makeTerm` — register OSC handlers; store per-term cwd; feed auto-title to the tab label)
- Possibly modify: `public/index.html` (tab-title binding already exists via onTitleChange for OSC-0/2)
- Test: `verify.cjs` (`shellint` check)

**Done-criteria:** (a) OSC-7 `file://host/path` updates the term's tracked cwd, used as the default start folder for a split/new-tab from that pane; (b) OSC-133 `A`/`B`/`C`/`D` prompt/command marks are captured (enabling command-boundary features later); (c) OSC-0/2 sets the tab's auto-title. Harness emits each sequence and asserts the captured state.

- [ ] Register `term.parser.registerOscHandler(7, ...)` → parse `file://` → `t.cwd`.
- [ ] Register `registerOscHandler(133, ...)` → record mark type on the buffer line (store minimal `t.marks`).
- [ ] Bind `term.onTitleChange` (covers OSC 0/2) → set tab auto-title when the user hasn't manually renamed.
- [ ] Add `shellint` check: write OSC-7/133/title sequences, assert `t.cwd`, a recorded mark, and the tab title.
- [ ] `npm run verify` green; screenshot a tab auto-titled from OSC + a new split inheriting the cwd.
- [ ] Commit + push.

### Task T4: Ligatures (GATED — investigate WebGL + font-scan compatibility first)

**Files:**
- Investigate: `@xterm/addon-ligatures` — it depends on `font-ligatures`/`font-finder` (Node fs font scanning). Determine whether it runs in the renderer with our bundled Cascadia Code, and whether it coexists with the WebGL renderer's character joiner.
- Modify (if compatible): `public/app.js`, `public/index.html`, Settings toggle.
- Test: `verify.cjs` (`ligatures` check, if enabled).

**Done-criteria (fork):**
- If addon-ligatures runs cleanly in-renderer AND coexists with WebGL → enable behind a Settings → Terminal toggle (default on), harness asserts a ligature joiner is registered.
- If it requires Node font-scanning that breaks the web/phone path OR conflicts with WebGL → do NOT ship the addon. Instead either (a) rely on the bundled Cascadia Code's own `calt` ligatures via CSS `font-feature-settings` where the renderer honors it, or (b) defer ligatures as a documented known-gap. This is a reversible build-behind-a-setting decision, NOT an owner gate — pick the option that keeps parity honest and the harness green, document the choice in PLAN.md.

- [ ] Spike: load addon-ligatures in a scratch page; check for Node `require` errors in the browser + WebGL joiner conflict.
- [ ] Decide per the fork above; implement the winning option behind a toggle where applicable.
- [ ] Harness check appropriate to the chosen option; `npm run verify` green; screenshot ligatures on/off if shipped.
- [ ] Commit + push; record the decision + rationale in PLAN.md.

---

## Self-Review

- Coverage: web-links (T1) = OSC-8 + clickable URLs; unicode11 (T2); shell integration OSC-7/133/0-2 (T3); ligatures (T4). All roadmap parity items covered.
- Sequencing: cleanest/highest-visible-win first (links), then width, then shell integration, then the risky ligatures last behind a real investigation.
- Each task ships a committed harness check + screenshot and keeps the phone path intact.
