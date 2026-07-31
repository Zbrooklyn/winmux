# WinMux Item 7 — Polish: markdown richness + browser automation verbs + terminal command-marks/reset

> **For agentic workers:** Execute task-by-task. Each keeps `npm run verify` green, ships a committed harness check, and a screenshot for any rendered change.

**Goal:** Close the three named "polish" gaps in the WinMux cockpit — a markdown viewer rich enough to read WinMux's own plan/doc files faithfully (tables + task-list checkboxes + images), full wmux-parity browser automation verbs (type/fill/get-text/eval/scroll), and terminal command-mark navigation + a user-facing reset — each an independently testable unit.

**Architecture:** Three isolated enrichments of already-built surfaces. (1) `mdRender` in `public/app.js` gains GFM tables, task-list checkboxes, and images — pure string→HTML, no new surface. (2) `runControl`'s `browser` command gains five verbs backed by small injected-JS helpers, mirrored into the `winmux` CLI and the MCP tool schema. (3) The OSC-133 marks already captured in `t.marks` get consumed by prev/next-prompt jump actions + a Reset-terminal action, wired into ACTIONS (so they're remappable via item 6's keymap) and the term/command menus.

**Tech Stack:** vanilla JS client (`public/app.js`), Node RPC (`bin/winmux.cjs`, `bin/winmux-mcp.cjs`), Electron webview verbs, Playwright harness (`verify.cjs`), xterm.js.

## Global Constraints

- `cockpit.css` is FROZEN — new styles go in the `index.html` override layer only.
- Keep the standalone `node server.cjs` phone/web path working; browser verbs are Electron-only and must fail with a clear message elsewhere (as `browser open` already does).
- Every task keeps `npm run verify` green + ships its own committed check.
- Rendered changes ship a screenshot to Edward (rule 21).
- Commit + push per task on `feature/phase8-electron-shell`.
- Do not touch the owner-gated publish (master merge / public flip) or the v2 Rust/Tauri tree.

## Grounded current state (verified this session)

- **Markdown:** `mdRender` (`app.js:3554`) already does h1–h6, bold/italic, inline code, fenced code blocks, ul/ol, blockquote, hr, links via `mdInline`/`mdEsc`. Live viewer pulls `/api/md` and re-renders on mtime change (`app.js:3600`). GAPS: tables, task-list checkboxes (`- [ ]`/`- [x]`), images — the plan/doc files WinMux is used to read contain all three.
- **Browser verbs:** `runControl` `browser` (`app.js:3665`) supports open/url/back/forward/reload/snapshot/click/screenshot over the Electron `<webview>` via `view.executeJavaScript`. `SNAPSHOT_JS` tags refs `data-wm-ref="eN"`; `CLICK_JS(ref)` resolves one. CLI (`bin/winmux.cjs:155`) and MCP (`bin/winmux-mcp.cjs:68`) both enumerate the same 7 verbs. GAP vs wmux: type/fill/get-text/eval/scroll.
- **Terminal marks/reset:** OSC-133 A/B/C/D pushed to `t.marks` (`app.js:1511`, cap 500) but NOTHING consumes them. `term.reset()` is used on resume (`app.js:1585`) but there's no user-facing reset. Selection already covered: `copySel`, `selectAll` (term menu `app.js:391`), copy-mode j/k (`app.js:2167+`). `ACTIONS` registry + `keymapLookup` (item 6) is the wiring point for new remappable actions.

---

### Task 1: Markdown richness — tables, task-lists, images

**Files:**
- Modify: `public/app.js` (`mdRender`/`mdInline` — add GFM table blocks, `- [ ]`/`- [x]` task-list items, `![alt](src)` images)
- Modify: `public/index.html` (override-layer CSS for `.wmm table`, `.wmm .task`, `.wmm img`)
- Test: `verify.cjs` (`md-rich` check — render a doc with a table + checkboxes + an image, assert the DOM has `<table>` with the right cell text, a checked + unchecked `<input type=checkbox disabled>`, and an `<img>` with the right src)

**Interfaces:**
- Consumes: existing `mdEsc`, `mdInline`, the `mdRender` line loop.
- Produces: `mdRender` emits `<table><thead><tr><th>…</th></tr></thead><tbody><tr><td>…</td></tr></tbody></table>`; task items render `<li class="task"><input type="checkbox" disabled [checked]> …`; `mdInline` turns `![alt](url)` into `<img src=url alt=alt>` (before the link rule so image syntax wins).

**Done-criteria:** A markdown file containing a pipe table, a `- [ ]`/`- [x]` task list, and an `![alt](img)` renders as a real HTML table, disabled checkboxes reflecting checked state, and an inline image — verified in the live viewer DOM.

- [x] `mdInline`: add image rule `!\[([^\]]*)\]\(([^)]+)\)` → `<img>` BEFORE the link rule.
- [x] `mdRender`: recognise a task-list line (`^\s*[-*+]\s+\[( |x|X)\]\s+`) inside the existing ul branch → `<li class="task"><input type="checkbox" disabled` + `checked` when `x`/`X` + label.
- [x] `mdRender`: GFM table — a header line, a `---|---` separator line, then body rows of `| a | b |`; close any open list first; emit thead/tbody. A non-table line ends the table.
- [x] `index.html` override CSS: table borders/padding, `.task` list-style none + gap, `img` max-width 100%.
- [x] `md-rich` harness check (new PORT) — feed a fixture doc, assert table cells, checkbox states, img src on the rendered `.wmm-body`.
- [x] Screenshot: the viewer showing a table + task list + image. Commit + push.

### Task 2: Browser automation verbs — type / fill / get-text / eval / scroll

**Files:**
- Modify: `public/app.js` (`runControl` `browser` — add `type`/`fill`/`get-text`/`eval`/`scroll`; add `TYPE_JS(ref,text)`, `FILL_JS(ref,val)`, `GETTEXT_JS`, `SCROLL_JS(dir/amount)` helpers next to `SNAPSHOT_JS`/`CLICK_JS`)
- Modify: `bin/winmux.cjs` (CLI: `browser type <@ref> <text…>`, `browser fill <@ref> <value>`, `browser get-text`, `browser eval <js>`, `browser scroll [up|down|top|bottom|N]`)
- Modify: `bin/winmux-mcp.cjs` (`winmux_browser` schema + desc: add the new sub verbs + `text`/`value`/`js`/`amount` props)
- Test: `verify.cjs` (`browser-verbs` check — Electron-gated like the existing `browser` check; drive a data: page: type into an input, assert its value; get-text returns body text; eval returns a computed value; scroll changes scrollY)

**Interfaces:**
- Consumes: `browserWebview()`, `view.executeJavaScript`, the `data-wm-ref` tagging from `SNAPSHOT_JS`.
- Produces: `runControl('browser', {sub:'type', ref, text})` sets `el.value`+dispatches `input`/`change` and (for contenteditable) inserts text; `{sub:'fill', ref, value}` = set value + events; `{sub:'get-text'}` → `{text: document.body.innerText.slice(0, N)}`; `{sub:'eval', js}` → `{result: <JSON-safe>}`; `{sub:'scroll', amount}` where amount ∈ `up|down|top|bottom|<px>` → `{ok, scrollY}`.

**Done-criteria:** From the `winmux` CLI (and MCP), an agent can type into a field, read the page's text, run a snippet, and scroll — same verb surface as the wmux browser commands — proven against a live webview.

- [x] `app.js`: `TYPE_JS`/`FILL_JS`/`GETTEXT_JS`/`SCROLL_JS` helpers + the five `sub===` branches in `runControl` browser; keep the Electron guard; `eval` wraps user JS so the return is JSON-serialisable (stringify fallback).
- [x] `bin/winmux.cjs`: the five CLI verbs + updated usage/help + the `(open|snapshot|click|…|type|fill|get-text|eval|scroll)` error list.
- [x] `bin/winmux-mcp.cjs`: extend `winmux_browser` schema (`text`,`value`,`js`,`amount`) + desc listing the verbs.
- [x] `browser-verbs` harness check (Electron-gated; skips cleanly when Electron unavailable, like the `browser` check) — type→assert value, get-text→assert substring, eval→assert result, scroll→assert scrollY moved.
- [x] Screenshot (or, if Electron-headless can't render, the harness pass output) shipped. Commit + push.

### Task 3: Terminal command-marks navigation + reset

**Files:**
- Modify: `public/app.js` (consume `t.marks`: `jumpMark(t, dir)` scrolls to the prev/next prompt (OSC-133 `A`) line via `term.scrollToLine`; `resetTerm(t)` = `term.reset()` + clear + a redraw hint; register both in `ACTIONS` so they're remappable; add to the term/command menu; `window.__winmuxJumpMark`/`__winmuxResetTerm` test hooks)
- Modify: `public/index.html` (override CSS only if a new menu row needs it — reuse existing menu item styles)
- Test: `verify.cjs` (`marks` check — write output with synthetic OSC-133 `A` marks at known lines, call `__winmuxJumpMark(+1/-1)`, assert `term.buffer.active.viewportY` lands on the mark; call `__winmuxResetTerm` and assert the buffer cleared)

**Interfaces:**
- Consumes: `t.marks` (`{k,y}` array), xterm `term.scrollToLine(y)`, `term.buffer.active.baseY/viewportY`, `term.reset()`, the `ACTIONS` registry + `actionById` from item 6.
- Produces: `jumpMark(t, +1|-1)` (jump to next/prev prompt mark relative to the viewport, clamped); `resetTerm(t)`; two `ACTIONS` entries `jump-prev-mark`/`jump-next-mark` (defaults e.g. `Ctrl+Shift+Up`/`Ctrl+Shift+Down`) + a `reset-terminal` command-palette action; `__winmuxJumpMark(dir)`/`__winmuxResetTerm()` hooks mirroring them.

**Done-criteria:** With prompt marks present, prev/next-prompt jumps scroll the viewport to the surrounding command boundaries; a Reset terminal action clears the screen and scrollback — both reachable from the keyboard (remappable) and the menu, proven in the harness.

- [x] `jumpMark(t, dir)`: filter `t.marks` to prompt marks (`k==='A'`), pick the nearest above/below the current `viewportY+baseY`, `term.scrollToLine`; no-op safely when no marks.
- [x] `resetTerm(t)`: `term.reset()` (+ `term.clear()` fallback); leave the shell/socket untouched (visual reset only).
- [x] Register `jump-prev-mark`/`jump-next-mark`/`reset-terminal` in `ACTIONS` (remappable) + add "Reset terminal" to the term menu near "Select all"; `__winmuxJumpMark`/`__winmuxResetTerm` hooks.
- [x] `marks` harness check (new PORT): seed marks, assert jump lands on the mark line; assert reset clears the buffer.
- [x] Screenshot: term menu showing "Reset terminal" (+ a jumped viewport). Commit + push.

---

## Self-Review

- **Coverage:** markdown richness (T1) · browser automation verbs (T2) · terminal command-marks + reset (T3) — the three named pieces of roadmap item 7. Selection was already built (copySel/selectAll/copy-mode), so T3 scopes to the genuinely-missing marks+reset rather than re-doing selection.
- **Sequencing:** T1 first (lowest risk, pure render). T2 second (isolated to the Electron browser surface + its CLI/MCP mirrors). T3 last (touches the ACTIONS registry from item 6). No interdependencies — order is by risk.
- **Risk:** T2's `eval` runs arbitrary JS in the webview — it's the same trust boundary as the existing snapshot/click (this user's own local RPC over loopback/tailnet, cookie-auth). T3's jump/reset are visual-only and can't strand a shell. Each task independently testable with a committed check; phone/web path unaffected (T1 render is universal; T2 stays Electron-gated; T3 is client-only).
- **No owner gates here** — all three are technical enrichments of existing surfaces. GFM/task-list/image are the right markdown extensions for a plan/doc viewer; the five browser verbs are exactly wmux's set (parity, not invention).
