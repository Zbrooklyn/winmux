# Surfaces-as-Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS — SHIPPED (2026-08-06).** All tasks done on `feature/phase8-electron-shell`;
> full harness **363/363**. Commits: ST1–ST4 (`9f18acb` typed leaves, `516e104` type
> menu, `39c3cb7` browser leaf, `30c9d5c` markdown leaf), `05165fe` (ST5 diff leaf), and
> `e597b3c` (ST6 persistence). Implementation notes vs this plan:
> - Leaves were built as **dedicated constructors** — `newBrowserLeaf` / `newMarkdownLeaf`
>   / `newDiffLeaf` — rather than one `newLeaf`+`mountLeafBody` dispatcher. Same outcome,
>   less shared branching; each leaf owns its body/lifecycle (e.g. the markdown poll timer
>   is cleared in that leaf's `onClose`).
> - Harness check names landed as `browser-tab`, `markdown`/`md-rich` (repointed to the
>   leaf host), `diff-tab`, and `leaf-persist` — not the tentative `surface-menu`/
>   `markdown-tab` names in the task steps.
> - Non-terminal tabs are tagged `data-leaf` so terminal-only DOM selectors use
>   `.ptab:not([data-leaf])` (the shell favicon classes are reused, so the favicon alone
>   can't discriminate a leaf from a PowerShell tab).
> - Diff leaf default cwd: the shell parks at `$HOME` (never a repo), so a fresh diff
>   leaf reads the server's launch dir; `/api/git`'s empty-cwd default was flipped from
>   `os.homedir()` to `process.cwd()` to match.

**Goal:** Teach WinMux that a pane's tab can be a non-terminal surface — Browser, Markdown, or Diff — opened from a Terminal/Browser/Markdown new-tab menu, matching the cockpit design contract, and retire the browser/markdown side panels.

**Architecture:** Today a pane holds `p.terms` — an array of terminal objects only; the browser (`ensureBrowserPanel`) and markdown (`ensureMarkdownPanel`) are separate Electron/side docks. We generalize the tab entry into a **typed leaf** (`leaf.type` ∈ `terminal | browser | markdown | diff`) carried in the SAME `p.terms` array, so every existing terminal path keeps working with `type` defaulting to `'terminal'`. Non-terminal leaves render their body into the pane's content area instead of an xterm. We reuse the existing `browserOpen`/`runControl`/`/api/md` plumbing verbatim — only its *host* moves from a dock to a pane leaf. The design-spec mockup (`../wmux-amirlehmam/design-spec/cockpit.html`) is the reference implementation: `state.leaves[id]={id,type,...}`, `leafTitle`, `leafDot`, tab favicons (`fav-b ◆` / `fav-m ¶` / `fav-d ±` / `fav-t >_`), `browserHTML`, the new-tab type menu, and `enforceLimit`.

**Tech Stack:** Vanilla JS (`public/app.js`, ~4046 lines, no framework), `public/cockpit.css` (design contract, lines 8–399 never edited — new surface CSS goes in `public/index.html`'s `<style>` or an additive block), Electron `<webview>` for real browser sites, `/api/md` for markdown, the `verify.cjs` Playwright harness as the test vehicle (`node verify.cjs <check>`), and `winmux` CLI verbs in `bin/winmux.cjs`.

## Global Constraints

- **Keep all existing harness checks green.** Baseline is 267/267; run `npm run verify` before declaring any phase done. No phase may regress a check.
- **`public/cockpit.css` lines 8–399 are the design contract — never edit them.** New surface styling is additive, in `index.html`'s style block, using the mockup's class names (`.browser`, `.bchrome`, `.bframe`, `.fav`, `.fav-b/-m/-d/-t`).
- **Every terminal behavior must survive the generalization:** splits (right/down), zoom, close pane/tab + confirm, Ctrl+Tab MRU + reopen-closed, drag-tab-to-split, tab overflow menu, broadcast input, per-tab status dot/color, rename, save/load layout, focus, auto-resume. A leaf of `type:'terminal'` must be byte-for-byte the behavior shipping today.
- **Browser leaf is Electron-only for real external sites** (`<webview>`, gated by `isElectronApp()`). In plain-browser mode (`127.0.0.1` in Chrome) the browser leaf must degrade gracefully — show a "needs the desktop app" message, never a broken frame or a crash. Same gate the current dock uses (`app.js:3993`).
- **Retire the docks, don't leave two code paths.** After the browser/markdown leaves land and are proven, delete `ensureBrowserPanel`/`.wmb` and `ensureMarkdownPanel`/`.wmm` and re-point the CLI verbs (`winmux browser *`, `winmux markdown`) and `runControl` at the leaf host. The "Open browser" affordances (`data-addbrowser` in mockup) open a leaf, not a dock.
- **Commit per task on the feature branch** `feature/phase8-electron-shell`. Do not merge to master (owner-gated).
- **Frontend proof (Rule 21):** each surface task ships a screenshot of the surface rendered as a live tab (desktop; browser leaf under Electron) plus a computed-value check where geometry matters.

---

## File Structure

- `public/app.js` — the whole change lives here. New/modified regions:
  - **Leaf model** (new helpers near the tab helpers ~line 480–800): `leafType(t)`, `leafTitle(t)`, `leafDot(t)`, `leafFavSvg(t)`, `newLeaf(p, type, opts)`.
  - **`newTerm`** (`1566`) — add a `type` param defaulting `'terminal'`; terminals unchanged.
  - **Tab render** (the tab DOM build inside `newTerm`/`activateTerm` region) — prepend the type favicon; title from `leafTitle`.
  - **Pane body render** (`activateTerm` `1354`, `focusTerm` `1238`) — when the active leaf is non-terminal, mount its surface node instead of the xterm.
  - **New-tab menu** (`1183`, `#open-new`) — becomes a caret menu: Terminal (→ shell submenu, current behavior) / Browser / Markdown.
  - **Browser leaf host** — reuse `browserOpen`/`browserWebview`/`runControl` (`3722`–`3993`), mount the `<webview>` into the pane leaf body instead of `.wmb`.
  - **Markdown leaf host** — reuse `openMarkdown`/`/api/md` (`3818`–`3905`), mount into the pane leaf body instead of `.wmm`.
  - **Diff leaf** — the git-diff dock content (`changes dock`) hostable as a leaf.
  - **Save/load layout** — persist `type` + `url`/`path` per leaf; restore rebuilds non-terminal leaves.
- `public/index.html` — additive CSS for the in-pane surfaces (browser chrome, markdown body, favicons) using mockup class names; the new-tab caret menu markup if needed.
- `bin/winmux.cjs` — repoint `browser`/`markdown` verbs to open/target a leaf (help text already correct).
- `verify.cjs` — new checks: `browser-tab`, `markdown-tab`, `diff-tab`, `mixed-split`, `surface-persist`; keep existing green.
- `PLAN.md` / `README.md` — remove the stale "Browser tab … out of scope" note; document the surface model.

---

## Task 1: Leaf-type foundation (non-breaking)

Introduce `type` on the tab object with `'terminal'` default and the display helpers, so nothing changes visibly but the model is ready. This is the safety net: prove 267/267 still green with the field threaded through.

**Files:**
- Modify: `public/app.js` — `newTerm` (`1566`), add helper block near `1480`.
- Test: `verify.cjs` (run full suite as regression).

**Interfaces:**
- Produces: `leafType(t) -> 'terminal'|'browser'|'markdown'|'diff'` (reads `t.type || 'terminal'`); `leafTitle(t) -> string`; `leafDot(t) -> statusKey`; `leafFavSvg(t) -> htmlString`. Every existing terminal has `t.type` undefined → treated as `'terminal'`.

- [ ] **Step 1: Read the anchors first.** Read `public/app.js` `newTerm` (1566–~1650), the tab-DOM build inside it, `activateTerm` (1354), `focusTerm` (1238), and the mockup `leafTitle`/`leafDot` (`cockpit.html:584-585`). Hold the term-object shape in context before editing.

- [ ] **Step 2: Add the helper block** near line 1480 (before `layoutTabs`):

```js
function leafType(t) { return t.type || 'terminal'; }
function leafTitle(t) {
  if (leafType(t) === 'browser') return t.url || 'Browser';
  if (leafType(t) === 'markdown') return t.mdTitle || t.mdPath || 'Markdown';
  if (leafType(t) === 'diff') return 'Diff';
  return termName(t); // existing terminal title fn
}
function leafDot(t) {
  if (leafType(t) === 'browser') return 'browser';
  if (leafType(t) === 'markdown' || leafType(t) === 'diff') return 'idle';
  return t.status || 'idle';
}
function leafFavSvg(t) {
  var k = leafType(t);
  if (k === 'browser')  return '<span class="fav fav-b">' + BROWSER_FAV_SVG + '</span>';
  if (k === 'markdown') return '<span class="fav fav-m">¶</span>';
  if (k === 'diff')     return '<span class="fav fav-d">±</span>';
  return '<span class="fav fav-t">&gt;_</span>';
}
```
(Define `BROWSER_FAV_SVG` = a small globe glyph next to the other `*_SVG` consts.)

- [ ] **Step 3: Thread `type` through `newTerm`.** Change signature to `newTerm(p, shellKey, cwd, seedSid, resumeCmd, resumeId, pinnedByHand, opts)` where `opts = {type, url, mdPath}` (all optional). At the top: `var kind = (opts && opts.type) || 'terminal'; t.type = kind;`. Guard the PTY-spawn / xterm-attach block with `if (kind === 'terminal') { …existing… }`. Non-terminal leaves skip shell spawn.

- [ ] **Step 4: Use the favicon + title in the tab DOM.** Where the tab element's inner HTML is built, prepend `leafFavSvg(t)` and source the label from `leafTitle(t)`. For terminals the output is identical to today (`>_` favicon already present? if so, replace the hardcoded one with `leafFavSvg`).

- [ ] **Step 5: Regression — full harness.** Run: `npm run verify`
Expected: still 267/267 (or the machine's isolated-run number). Terminals unchanged. If any check regressed, the `type` threading broke a terminal path — fix before committing.

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat(surfaces): typed-leaf foundation — type field + display helpers, terminals unchanged"
```

---

## Task 2: New-tab type menu (Terminal / Browser / Markdown)

Turn the `#open-new` button (and the new-tab caret) into a type picker. Terminal keeps the existing shell submenu; Browser and Markdown create their leaves.

**Files:**
- Modify: `public/app.js` — `#open-new` handler (`1183` region) and the caret menu builder.
- Test: `verify.cjs` new check `surface-menu`.

**Interfaces:**
- Consumes: `newLeaf(p, type, opts)` (Task 3 provides browser/markdown bodies; here it just creates the tab + activates it). Define `newLeaf` now as a thin wrapper: `function newLeaf(p, type, opts){ return newTerm(p, null, null, null, null, null, false, Object.assign({type:type}, opts)); }`.
- Produces: menu with `data-newtype="terminal|browser|markdown"`.

- [ ] **Step 1: Write the failing harness check** `verify.cjs` `surface-menu`: open the app, click the new-tab caret, assert the menu lists "Terminal", "Browser", "Markdown"; click "Browser"; assert a new tab appears whose favicon has class `fav-b`.

```js
check('surface-menu', PORT_SURFACES, async ({ browser, base, t, shot }) => {
  const p = await browser.newPage(); await p.goto(base); await p.waitForSelector('#open-new');
  await p.click('#newtab-caret');                 // the type caret
  const items = await p.$$eval('.ctxmenu [data-newtype]', els => els.map(e => e.textContent.trim()));
  t.eq('menu offers the three surface types', items, ['Terminal', 'Browser', 'Markdown']);
  await p.click('.ctxmenu [data-newtype="browser"]');
  await p.waitForSelector('.ptab .fav-b');
  t.ok('a browser tab was created', await p.$('.ptab .fav-b'));
  await shot(p, 'surface-menu');
});
```

- [ ] **Step 2: Run it, verify it fails.** Run: `node verify.cjs surface-menu` → FAIL (no caret / no `data-newtype`).

- [ ] **Step 3: Build the type menu.** Add a caret next to `#open-new` (`#newtab-caret`). On click, build a `.ctxmenu` with three `addMenuItem`s carrying `data-newtype`. "Terminal" opens the existing shell submenu (reuse the current shell-picker). "Browser" → `newLeaf(activePane(), 'browser', {url:'about:blank'})`. "Markdown" → `newLeaf(activePane(), 'markdown', {})`. Keep the plain `#open-new` click = "new terminal here" (unchanged default).

- [ ] **Step 4: Run it, verify it passes.** Run: `node verify.cjs surface-menu` → PASS.

- [ ] **Step 5: Regression.** Run: `npm run verify` → no regressions.

- [ ] **Step 6: Commit**

```bash
git add public/app.js verify.cjs
git commit -m "feat(surfaces): new-tab type menu — Terminal/Browser/Markdown"
```

---

## Task 3: Browser leaf — render the webview in the pane, retire the dock

Host the existing `<webview>` inside the active browser leaf's pane body. Reuse `browserOpen`/`runControl` unchanged; move the mount point.

**Files:**
- Modify: `public/app.js` — pane body render in `activateTerm`/`focusTerm`; `ensureBrowserPanel`→`mountBrowserLeaf`; `browserOpen`, `browserWebview`, `runControl` (`3722`–`3993`); delete `.wmb` dock. `bin/winmux.cjs` browser verbs target the active/first browser leaf.
- Modify: `public/index.html` — additive `.browser/.bchrome/.bframe` CSS from the mockup (`cockpit.html:185-205, 695-714`).
- Test: `verify.cjs` `browser-tab`.

**Interfaces:**
- Consumes: `newLeaf(p,'browser',{url})` (Task 2). `leafType` (Task 1).
- Produces: `browserWebviewFor(t) -> <webview>|null` (per-leaf); `mountLeafBody(p, t)` — the dispatcher that renders a non-terminal leaf's body into the pane content area.

- [ ] **Step 1: Read** `ensureBrowserPanel`/`browserOpen`/`runControl`/`isElectronApp` (`3722`–`3993`) and the mockup `browserHTML` (`cockpit.html:695`). Note the Electron gate at `3993`.

- [ ] **Step 2: Write the failing check** `browser-tab` (Electron path — mirror how the `electron` check runs; if the harness runs browser leaves only under Electron, gate with the same helper the `electron`/`detach` checks use):

```js
check('browser-tab', PORT_SURFACES, async ({ t }) => {
  // Under Electron: open a browser leaf, navigate to the local app itself, assert the webview loaded.
  const app = await launchElectron();               // reuse the electron-check harness helper
  await app.click('#newtab-caret'); await app.click('.ctxmenu [data-newtype="browser"]');
  await app.fill('.bchrome .baddr', 'http://127.0.0.1:' + app.port);
  await app.press('.bchrome .baddr', 'Enter');
  await app.waitForWebviewLoad('.pane .browser webview');
  t.ok('the browser leaf webview navigated', await app.webviewUrl() !== 'about:blank');
  await app.shot('browser-tab');
});
```

- [ ] **Step 3: Run it, verify it fails.** Run: `node verify.cjs browser-tab` → FAIL.

- [ ] **Step 4: Add the leaf-body dispatcher.** In the pane render path, when `leafType(active) !== 'terminal'`, hide the xterm holder and show a `.leafbody` container; call `mountLeafBody(p, t)`. Implement `mountLeafBody` to switch on `leafType`: `'browser'` → build the mockup `.browser` chrome (address bar `.baddr`, back/fwd/reload `data-bnav`, `<webview class="wmb-view">` under Electron, else the degrade message) and store the node on `t.bodyEl`; wire `.baddr` Enter → `browserOpen(t, val)`.

- [ ] **Step 5: Re-point `browserOpen`/`runControl` at the leaf.** `browserOpen(t, url)` loads into `t`'s webview; `runControl` and CLI verbs resolve "the browser" = the active browser leaf, else the first browser leaf, else create one. Keep the `@ref` snapshot/click/type/eval/screenshot logic verbatim — only the webview handle source changes.

- [ ] **Step 6: Delete the dock.** Remove `ensureBrowserPanel`, its `.wmb` DOM, the dock toggle, and any reopen-strip entry for it. Grep for `.wmb`/`ensureBrowserPanel` → zero remaining refs.

- [ ] **Step 7: Run it, verify it passes.** Run: `node verify.cjs browser-tab` → PASS. Screenshot shows the browser as a live tab.

- [ ] **Step 8: Plain-browser degrade check.** In non-Electron mode, open a browser leaf; assert the `.leafbody` shows the "needs the desktop app" message and the app does not throw (console clean).

- [ ] **Step 9: Regression + CLI.** Run: `npm run verify`; then `node bin/winmux.cjs browser open https://example.com` against the running app and confirm it targets the leaf.

- [ ] **Step 10: Commit**

```bash
git add public/app.js public/index.html bin/winmux.cjs verify.cjs
git commit -m "feat(surfaces): browser as a pane tab (webview leaf), retire the side dock"
```

---

## Task 4: Markdown leaf — render markdown in the pane, retire the dock

Same move for markdown: host `/api/md` render in the leaf body; delete `.wmm`.

**Files:**
- Modify: `public/app.js` — `mountLeafBody` markdown branch; `openMarkdown`/`ensureMarkdownPanel` (`3818`–`3905`) → leaf; delete `.wmm`. `bin/winmux.cjs` `markdown` verb targets a leaf.
- Modify: `public/index.html` — additive markdown-body CSS.
- Test: `verify.cjs` `markdown-tab` (adapt the existing `markdown`/`md-rich` checks to the leaf host).

**Interfaces:**
- Consumes: `mountLeafBody` (Task 3), `newLeaf(p,'markdown',{mdPath})`.
- Produces: markdown leaf renders `/api/md?path=` content and live-updates.

- [ ] **Step 1: Write the failing check** `markdown-tab`: open a markdown leaf via the type menu, point it at `PLAN.md` (`newLeaf` opts or the leaf's file picker), assert the rendered body contains a known heading string from `PLAN.md`.

- [ ] **Step 2: Run it, verify it fails.** `node verify.cjs markdown-tab` → FAIL.

- [ ] **Step 3: Implement the markdown branch** of `mountLeafBody`: reuse the existing markdown render fn (`openMarkdown`'s renderer) but write into `t.bodyEl` instead of `.wmm`. Keep the `/api/md` fetch + live-update poll.

- [ ] **Step 4: Delete the dock.** Remove `ensureMarkdownPanel`/`.wmm`. Grep clean.

- [ ] **Step 5: Run it, verify it passes.** `node verify.cjs markdown-tab` → PASS. Also re-run the pre-existing `markdown` and `md-rich` checks; update them to the leaf host if they targeted `.wmm`.

- [ ] **Step 6: Regression.** `npm run verify`.

- [ ] **Step 7: Commit**

```bash
git add public/app.js public/index.html bin/winmux.cjs verify.cjs
git commit -m "feat(surfaces): markdown as a pane tab, retire the side dock"
```

---

## Task 5: Diff leaf — the changes surface as a tab

The git-diff "changes dock" content becomes a `diff` leaf, per the mockup (`type:'diff'`, `±` favicon).

**Files:**
- Modify: `public/app.js` — `mountLeafBody` diff branch; the changes-dock open path opens a diff leaf; the diff render fn writes to `t.bodyEl`.
- Test: `verify.cjs` `diff-tab`.

**Interfaces:**
- Consumes: `mountLeafBody`, `newLeaf(p,'diff',{})`.
- Produces: a diff leaf showing `git diff` for the repo, favicon `fav-d`.

- [ ] **Step 1: Write the failing check** `diff-tab`: open a diff leaf; in a repo with a staged/unstaged change, assert the leaf body renders at least one `@@` hunk header and a `+`/`-` line.

- [ ] **Step 2: Run it, verify it fails.** `node verify.cjs diff-tab` → FAIL.

- [ ] **Step 3: Implement the diff branch** of `mountLeafBody` reusing the existing changes-dock diff renderer, writing to `t.bodyEl`. Add "Diff" to the type menu (or open from the changes affordance) — match how the app surfaces diff today.

- [ ] **Step 4: Run it, verify it passes.** `node verify.cjs diff-tab` → PASS.

- [ ] **Step 5: Regression.** `npm run verify`.

- [ ] **Step 6: Commit**

```bash
git add public/app.js verify.cjs
git commit -m "feat(surfaces): git diff as a pane tab"
```

---

## Task 6: Persistence, splits & lifecycle for non-terminal leaves

Make save/load, splits, MRU/reopen, close, and focus correct for mixed leaf types. This is where the generalization is proven not to have half-broken the terminal-only assumptions.

**Files:**
- Modify: `public/app.js` — the layout snapshot/restore fns (grep `snapshot`/`restore`/`ct-groups`/`saveLayout`), `activateTerm`/close/MRU paths.
- Test: `verify.cjs` `surface-persist`, `mixed-split`.

**Interfaces:**
- Consumes: all prior leaf types.
- Produces: layout JSON entries gain `type` and `url`/`mdPath`; restore rebuilds non-terminal leaves via `newLeaf`.

- [ ] **Step 1: Write failing check** `surface-persist`: create a pane with a terminal + a browser leaf (URL set) + a markdown leaf; save layout; reload the app; load layout; assert all three tabs return with correct types (favicons `fav-t`, `fav-b`, `fav-m`) and the browser leaf's URL is restored.

- [ ] **Step 2: Write failing check** `mixed-split`: split a pane so a terminal is on the left and a browser leaf on the right; assert both render simultaneously and each is independently focusable; drag a markdown tab into the terminal pane and assert it lands as a tab there.

- [ ] **Step 3: Run both, verify they fail.** `node verify.cjs surface-persist mixed-split` → FAIL.

- [ ] **Step 4: Extend snapshot/restore.** In the layout serializer, for each tab write `{type, shell?, cwd?, url?, mdPath?, resume?}`. In restore, branch on `type`: `'terminal'` → existing `newTerm` path; else `newLeaf(p, type, {url, mdPath})`. Ensure a non-terminal leaf never triggers the "empty pane needs a shell" guard (`1158`, `1397`): those guards must count only terminal leaves when deciding to auto-spawn a shell — audit `visibleTerms`/`p.terms.length` uses and switch the "must have a live shell" ones to a terminal-only count.

- [ ] **Step 5: Fix close/MRU/focus.** Closing the last *terminal* in a pane that still has a browser leaf must NOT force-spawn a shell; closing any leaf updates MRU; reopen-closed-tab restores a non-terminal leaf by type. Focus of a non-terminal leaf focuses its body (webview/markdown), not a PTY.

- [ ] **Step 6: Run both, verify they pass.** `node verify.cjs surface-persist mixed-split` → PASS.

- [ ] **Step 7: Full regression — the real gate.** Run: `npm run verify`
Expected: every prior check green PLUS the five new ones (`surface-menu`, `browser-tab`, `markdown-tab`, `diff-tab`, `surface-persist`, `mixed-split`). This is the acceptance bar for the feature.

- [ ] **Step 8: Commit**

```bash
git add public/app.js verify.cjs
git commit -m "feat(surfaces): persistence, splits, MRU and lifecycle for mixed leaf types"
```

---

## Task 7: Docs + proof

**Files:**
- Modify: `PLAN.md` (remove the stale "Browser tab … out of scope" note at ~line 44–48; document the surface model + new checks), `README.md` (mention Browser/Markdown/Diff tabs), `DESIGN.md` if it lists surfaces.

- [ ] **Step 1: Update PLAN.md.** Delete "Browser tab, markdown tab, diff-as-a-tab" from the out-of-scope list; add a "Surfaces as tabs" line to *Already done* with the check names.

- [ ] **Step 2: Update README/DESIGN** to describe the type menu and the Electron-only browser caveat.

- [ ] **Step 3: Ship proof to Edward.** Desktop screenshot of a pane with a terminal tab + a live browser tab + a markdown tab in one strip; note the passing check count from `npm run verify`.

- [ ] **Step 4: Commit + push**

```bash
git add PLAN.md README.md DESIGN.md
git commit -m "docs(surfaces): document surfaces-as-tabs; remove stale out-of-scope note"
git push origin feature/phase8-electron-shell
```

---

## Self-Review

**Spec coverage:** Full-mockup scope (Edward's decision) = browser + markdown + diff as tabs via a Terminal/Browser/Markdown menu, docks retired. Task 2 = menu; Task 3 = browser + dock retire; Task 4 = markdown + dock retire; Task 5 = diff; Task 6 = persistence/splits/lifecycle; Task 7 = docs/proof. Task 1 is the non-breaking foundation. Covered.

**Placeholder scan:** Harness-check bodies are illustrative skeletons (the executor must adapt them to `verify.cjs`'s real helpers — `check(name, port, fn)`, the Electron launch helper used by the `electron`/`detach` checks, and `t.eq/t.ok/shot`). Every implementation step names the exact function to reuse (`browserOpen`, `runControl`, `openMarkdown`, the diff renderer) rather than "add appropriate logic." The one genuine unknown the executor must resolve by reading is the exact Electron-launch harness helper name — flagged in Task 3 Step 2.

**Type consistency:** `leafType/leafTitle/leafDot/leafFavSvg` (Task 1) are used unchanged in Tasks 2–6. `newLeaf(p, type, opts)` (Task 2) wraps `newTerm(..., opts)` (Task 1). `mountLeafBody(p, t)` (Task 3) is extended, not renamed, in Tasks 4–5. `t.bodyEl`, `t.url`, `t.mdPath`, `t.type` are the consistent per-leaf fields throughout.

**Risk note for the executor:** the highest-risk step is Task 6 Step 4 — the "empty pane must have a live shell" guards (`app.js:1158`, `1397`) assume `p.terms` = terminals. Audit every `p.terms.length` / `visibleTerms` use and split "count of tabs" from "count of live shells" before wiring restore, or a pane holding only a browser leaf will spawn a phantom terminal.
