# WinMux Phase 10 — Browser panel + Markdown viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Add the two wmux surfaces WinMux is missing — a real, controllable **browser panel** and a **markdown viewer** — both drivable from the `winmux` CLI (`browser open/snapshot/click`, `markdown <file>`), reusing the Phase 9 `/rpc → /control` channel.

**Architecture:** The browser panel is an Electron `<webview>` mounted in the cockpit's existing `.browser` leaf. An Electron `<webview>` is controllable *directly from the app renderer* (`el.loadURL`, `el.executeJavaScript`, `el.getURL`, `el.capturePage`), so the CLI's `browser` verbs route through the same path Phase 9 built — `/rpc → /control → runControl` — with no new main-process IPC. On the phone/web (no Electron, no webview) the panel shows an "open on desktop" affordance. The markdown viewer is a pure-DOM surface that renders a `.md` file the server reads, live-updating on change.

**Tech Stack:** Electron `<webview>` (enable `webviewTag`), the existing server + `/control` channel, vanilla JS, a tiny inline markdown renderer (no CDN), Playwright harness.

## Global Constraints

- `public/cockpit.css` frozen. The `.browser`/`.bframe` classes already exist; new styling goes in `index.html`.
- Pure-web/phone mode keeps working: the browser panel is Electron-only; on web it degrades to an affordance, never a broken frame.
- The git-diff dock stays. The browser panel is additive.
- CLI verbs `browser`/`markdown` were stubbed in Phase 9 — now implemented. Keep the harness green (new `browser` + `markdown` checks).
- Desktop-only surfaces are honest about degradation on the phone (spec §8).

---

### Task 1: Enable webview + a browser surface in the cockpit

**Files:** Modify `electron/main.ts` (`webviewTag: true`), `public/index.html` (browser surface markup + wiring in the JS is in Task 2; here just the Electron flag + a feature probe).

- [ ] **Step 1:** In `electron/main.ts` set `webviewTag: true` in `webPreferences`. Rebuild (`npm run build:electron`), confirm the cockpit still loads (smoke check still green).
- [ ] **Step 2:** Add a helper the renderer can call to know it may use a webview: the preload already sets `window.winmux.isElectron`. Confirm that is enough (it is — webview works whenever isElectron).
- [ ] **Step 3:** Commit: `feat(electron): enable <webview> for the browser panel (Phase 10 T1)`.

### Task 2: Mount + control the webview from the app

**Files:** Modify `public/app.js` (a `browser` surface: a `<webview>` under Electron, an "open on desktop" card on web; a `browserEl()` accessor; extend `runControl` with `browser` commands).

**Interfaces:** Produces `runControl('browser', {sub, ...})` handling `open {url}`, `snapshot`, `click {ref}`, `back`, `forward`, `reload`, `url`, `screenshot`.

- [ ] **Step 1:** Add a browser leaf renderer: under Electron insert `<webview src=... class="bframe" allowpopups>`; on web insert a card "The browser panel runs in the WinMux desktop app." Keep the existing `.browser` container.
- [ ] **Step 2:** `browserEl()` returns the live `<webview>` element (or null on web).
- [ ] **Step 3:** Extend `runControl`:
  - `open {url}` → `el.loadURL(url)` (default `https://`-prefix if missing); return `{url}`.
  - `url` → `{url: el.getURL()}`.
  - `back`/`forward`/`reload` → `el.goBack()/goForward()/reload()`.
  - `snapshot` → `el.executeJavaScript(SNAPSHOT_JS)` where SNAPSHOT_JS walks the DOM into a compact list of interactive nodes each tagged `@e1`, `@e2`… with role+text (mirrors the wmux/browser skill snapshot). Return `{tree}`.
  - `click {ref}` → `el.executeJavaScript(CLICK_JS(ref))` clicking the node tagged with that ref.
  - `screenshot` → `el.capturePage()` → save PNG to a temp path the server can serve, or return a data URL; return `{path|dataUrl}`.
  On web (no webview) each returns an error "the browser panel needs the desktop app".
- [ ] **Step 4:** Manual smoke (Electron): open the app, drive `browser open`, `snapshot`, `click` via a direct /rpc call; confirm the webview navigates and snapshot returns refs.
- [ ] **Step 5:** Commit: `feat(browser): controllable webview panel via /control (Phase 10 T2)`.

### Task 3: `winmux browser` CLI verbs

**Files:** Modify `bin/winmux.cjs` (replace the `browser` stub with real subcommands).

- [ ] **Step 1:** `winmux browser open <url>` / `snapshot` / `click <ref>` / `back` / `forward` / `reload` / `url` / `screenshot [path]` → `rpc('browser', {sub, ...})`. `snapshot` prints the ref tree; `screenshot` writes the PNG.
- [ ] **Step 2:** Smoke against a live Electron app: `winmux browser open example.com`, `winmux browser snapshot`, `winmux browser click @e1`.
- [ ] **Step 3:** Commit: `feat(cli): winmux browser open/snapshot/click/... (Phase 10 T3)`.

### Task 4: Markdown viewer surface + `winmux markdown`

**Files:** `server.cjs` (a `/api/md?path=` route reading a file + an mtime for live-update), `public/app.js` (a markdown surface rendering server-read markdown with a tiny inline renderer, polling mtime for live update), `bin/winmux.cjs` (`markdown <file>` verb → `runControl('markdown', {path})`).

- [ ] **Step 1:** `server.cjs`: `GET /api/md?path=<abs>` returns `{ok, text, mtime}` (desk-door only; reject outside-home traversal sensibly). 
- [ ] **Step 2:** `public/app.js`: a markdown leaf that fetches `/api/md`, renders with a small inline markdown→HTML function (headings, bold/italic, code, lists, links, hr — no external lib), and re-fetches on an mtime poll to live-update.
- [ ] **Step 3:** `runControl('markdown', {path})` opens the markdown surface on that file (new tab/leaf).
- [ ] **Step 4:** `winmux markdown <file>` → resolves to abs path → `rpc('markdown', {path})`.
- [ ] **Step 5:** Smoke: `winmux markdown README.md` renders it; editing the file updates the view.
- [ ] **Step 6:** Commit: `feat(markdown): viewer surface + /api/md + winmux markdown (Phase 10 T4)`.

### Task 5: Harness checks + docs + push

**Files:** `verify.cjs` (a `browser` check under Electron: open→snapshot→click round-trips; a `markdown` check: /api/md renders + live-updates), `PLAN.md`, `README.md`, `DESIGN.md`.

- [ ] **Step 1:** `browser` check — launch the Electron app (WINMUX_SMOKE-style or a dedicated control mode), drive `browser open` a local test page, assert snapshot returns refs and click changes state. If driving the real webview offscreen is flaky, assert the renderer-side `runControl('browser', …)` against a local data: page.
- [ ] **Step 2:** `markdown` check — `/api/md` on a temp file returns rendered structure; touch the file → mtime changes → surface updates.
- [ ] **Step 3:** PLAN.md Phase 10 section; README browser+markdown notes; DESIGN decision (webview chosen over WebContentsView, why; desktop-only degradation).
- [ ] **Step 4:** `npm run verify` green (minus the tracked pre-existing flakes). Commit + push.

## Self-Review

Spec coverage: browser panel (webview+control) → T1–T3; markdown viewer → T4; CLI parity verbs → T3/T4; proof → T5. Phone degradation explicit (T2 Step 3). git-diff dock untouched. cockpit.css frozen.
Risk: driving a real webview offscreen in the harness may be flaky → fall back to asserting the control layer against a `data:`/local page (T5 Step 1 note). WebContentsView is a documented future-hardening swap if `<webview>` deprecation bites (DESIGN note).
