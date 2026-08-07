# WinMux Phase 3 — Images in the Terminal Implementation Plan

> **For agentic workers:** implement task-by-task; each task ends with a runnable check.

**Goal:** Pictures show right inside the terminal, and a `winmux image <path>` command lets anything — including Claude Code running in a WinMux shell — drop one in. No popup, no separate viewer.

**Architecture:** Rendering is xterm.js's job via the official `@xterm/addon-image` addon, which decodes **sixel** and **iTerm2 inline-image (IIP)** escape sequences straight into the terminal grid. WinMux loads that addon on every terminal. Emitting is an imgcat-style CLI verb: `winmux image <path>` reads the file, base64-encodes it, and writes the IIP escape (`ESC ]1337;File=...:<base64>BEL`) to its **own stdout** — so when it runs inside a WinMux terminal, that terminal renders it. No server round-trip, no cross-tab routing.

**Tech Stack:** `@xterm/addon-image` (UMD global `ImageAddon`, same load path as the other addons), `public/app.js` (addon wiring), `bin/winmux.cjs` (the `image` verb), `public/index.html` (addon `<script>`), `verify.cjs` (a render check).

## Global Constraints

- **Known-protocol truth (surface to Edward):** the official xterm addon supports **sixel + iTerm2 IIP**, NOT the kitty graphics protocol. The task said "sixel/kitty"; kitty would need a hand-written parser and is out of scope. Outcome ("images show inline; `winmux image` drops one in") is fully met with sixel+IIP. Recommend sixel+IIP; note kitty is unavailable.
- **The visible image output is Edward-gated.** Build + test on `feature/phase8-electron-shell`; capture a screenshot of a real image rendered in a real terminal and get Edward's OK before it counts as live (BUILD-PLAN line 7). Do NOT merge to `master`.
- **Renderer reality:** `@xterm/addon-image` renders onto the terminal canvas. WinMux defaults to the WebGL renderer and falls back to the DOM renderer (harness, ligatures). Confirm the addon renders on the **active** renderer; if it only works on one, load it accordingly and record the limitation (do not silently ship a path that shows nothing).
- **Bounded memory:** `ImageAddon` takes a `storageLimit` (MB of decoded image kept in scrollback) and `sixelSupport`/`iipSupport` flags. Set a sane storageLimit (e.g. 128 MB) so a flood of images can't grow unbounded.
- **Keep the harness green.** Baseline 373/373. Add one `images` check; run `node verify.cjs` before done.
- **Surgical:** touch only terminal-construction (addon load), the CLI (new verb), index.html (script), and the harness. No reflow of the tab/leaf machinery.

## File Structure

- `public/index.html` — add the `@xterm/addon-image` UMD `<script>` (vendored the same way the other addon scripts are served).
- `public/app.js` — in `newTerm` where other addons load (~line 1694), construct + `loadAddon(new ImageAddon.ImageAddon({...}))`.
- `bin/winmux.cjs` — add the `image` verb: read file → base64 → write IIP escape to stdout. Pure local, no `/rpc`.
- `verify.cjs` — an `images` check: emit a known IIP sequence into a terminal, assert an image cell / canvas layer appears.
- `docs/BUILD-PLAN.md` / `PLAN.md` — mark Phase 3 done once shipped + gated.

## How the addon scripts reach the browser (resolve FIRST)

Before Task 1, confirm how `WebglAddon`/`FitAddon` UMD files get to `public/` — vendored copies committed under `public/`, or copied from `node_modules` at start, or served from `node_modules`. Match that exact mechanism for `addon-image.js`. (Check `index.html` `<script src>` paths + any copy step in `package.json`/`server.cjs`.) This determines whether Task 1 vendors a file or adds a serve path.

---

## Task 1: Render inline images (addon-image on every terminal)

**Files:** install `@xterm/addon-image`; `public/index.html` (script); `public/app.js` (`newTerm`, ~1694).

**Interfaces:**
- Consumes: the `term` (xterm `Terminal`) in `newTerm`; global `ImageAddon` from the UMD script.
- Produces: every terminal decodes IIP + sixel image escapes to inline pictures.

- [ ] **Step 1 — install:** `npm install @xterm/addon-image@^0.9.0` (the version matching xterm 5.5). Confirm it lands in `node_modules/@xterm/addon-image/`.
- [ ] **Step 2 — serve the UMD:** vendor/serve `addon-image` exactly as the sibling addons (per the resolve-first check) and add its `<script>` to `index.html` before `app.js`.
- [ ] **Step 3 — failing check:** write the `images` harness check (Task 3) and run it; it FAILS because no addon decodes the IIP escape yet.
- [ ] **Step 4 — load it:** in `newTerm`, after `term.loadAddon(fit)`, add:
  ```js
  try {
    term.loadAddon(new ImageAddon.ImageAddon({ sixelSupport: true, iipSupport: true, storageLimit: 128 }));
  } catch (e) { /* addon missing → terminals still work, just no inline images */ }
  ```
- [ ] **Step 5 — check passes:** run `node verify.cjs images` → PASS (image renders).
- [ ] **Step 6 — renderer confirm:** run the check on BOTH the WebGL default and the DOM fallback (the harness pins DOM); if the addon only renders on one, record it in the check + docs. Commit.

## Task 2: `winmux image <path>` emits an inline image

**Files:** `bin/winmux.cjs` (new `image` verb).

**Interfaces:**
- Consumes: `process.argv` path; the file bytes.
- Produces: the iTerm2 IIP escape on stdout, so the surrounding WinMux terminal renders the picture.

- [ ] **Step 1 — failing check:** extend the `images` check to shell out to `winmux image <fixture.png>` inside a terminal and assert an image appears. Run → FAIL (no verb).
- [ ] **Step 2 — implement the verb:** read the file, base64 it, and write the IIP escape:
  ```js
  // ESC ]1337;File=name=<b64name>;size=<bytes>;inline=1:<b64data> BEL
  const data = fs.readFileSync(file);
  const b64 = data.toString('base64');
  const name = Buffer.from(path.basename(file)).toString('base64');
  process.stdout.write(`\x1b]1337;File=name=${name};size=${data.length};inline=1:${b64}\x07`);
  ```
  Guard: missing/oversize file → `die()` with a clear message. Add `image` to the usage/help text.
- [ ] **Step 3 — check passes:** `node verify.cjs images` → PASS. Confirm by hand that `winmux image <path>` inside a WinMux terminal shows the picture. Commit.

## Task 3: Harness check + gated screenshot + docs

**Files:** `verify.cjs` (`images` check + `PORT_IMAGES`), a tiny committed fixture image, `docs/BUILD-PLAN.md`, `PLAN.md`.

- [ ] **Step 1 — the check:** new `check('images', PORT_IMAGES, ...)`: open a terminal, write a small known IIP escape (or run `winmux image` on a committed fixture), wait, then assert the addon created an image layer — e.g. a canvas/`<img>` in the terminal DOM, or `term` image-addon state — NOT merely that the bytes were sent. Assert the real rendered artifact.
- [ ] **Step 2 — full regression:** `node verify.cjs` → expect 374/374.
- [ ] **Step 3 — GATED screenshot:** capture a real terminal showing a rendered image; `SendUserFile` to Edward with a one-line note; hold for OK on the visible output before treating it live.
- [ ] **Step 4 — on OK:** mark Phase 3 done in `docs/BUILD-PLAN.md`; add a `### Phase 17` section to `PLAN.md`; commit + push `feature/phase8-electron-shell`.

## Self-Review

- **Spec coverage:** "pictures show inside the terminal" → addon-image (Task 1). "`winmux image` drops one in" → Task 2. "no popup" → inline canvas, no overlay. ✓
- **Divergence flagged:** kitty unsupported by the addon → sixel+IIP, surfaced to Edward. ✓
- **Proof is the rendered artifact, not the byte path** (Task 3 Step 1) — avoids a green check that proves only transmission. ✓
- **Reversible:** addon load is `try`-guarded; the verb is additive; both revert cleanly. The visible result is gated. ✓
