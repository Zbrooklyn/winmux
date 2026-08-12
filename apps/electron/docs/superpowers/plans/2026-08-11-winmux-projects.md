# WinMux Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace WinMux's browser-storage "layouts" with file-backed **Projects** — a project is a `.json` file on disk holding a full workspace; users save, reopen from recents, and are prompted to save on close.

**Architecture:** The server owns the filesystem and exposes `/api/project(s)` endpoints (Node engine now, Rust core later); the client is a panel that reuses the existing `snapshot()` / `restoreLayout()` machinery. Old `ct-layouts` are migrated into project files once, then the old popover is retired.

**Tech Stack:** Node `http` server (`server.cjs`), vanilla-JS frontend (`public/app.js`, `index.html`, `public/cockpit.css`), `verify.cjs` Playwright harness. No new dependencies.

## Global Constraints

- Canonical copy: `C:\Users\EDWAR\Dropbox\AI_Projects_Claude\projects\winmux`, branch `feature/phase8-electron-shell`. All work here.
- Project file shape: `{ winmuxProject:1, name, created, modified, layout }` where `layout` === `snapshot()` output with live `sid`s stripped.
- Default projects dir: `Documents\WinMux Projects\`. Machine state (recents index, current-project pointer) lives in `~/.winmux/`, never in the projects dir.
- All file writes atomic (temp + `fs.renameSync`), matching #194.
- Path safety: server only reads/writes `*.json` files; reject directory traversal and non-`.json` extensions.
- Engine-agnostic: client calls `/api/...` only — never touches disk directly. Rust-core endpoints are out of scope for this plan (tracked as Stage 2).
- Nothing lost: migration leaves the `ct-layouts` localStorage blob intact as a silent safety copy.
- Keep `verify.cjs` green across every task. Promotion to `main` stays Edward-gated.

---

### Task 1: Server project store + endpoints

**Files:**
- Modify: `server.cjs` — add a project-store section + 4 route handlers alongside the existing `/api/config` block (~server.cjs:783).
- Test: `scripts/projects-smoke.cjs` (Create) — boots nothing; hits a running server's endpoints and asserts the round-trip.

**Interfaces:**
- Produces (HTTP):
  - `GET /api/projects` → `{ dir:string, recents:[{path,name,tabs,opened,missing:boolean}] }`
  - `GET /api/project?path=<abs>` → `{ name, layout, modified }` or `404`
  - `POST /api/project` body `{ name, path?, layout }` → `{ path }` (writes file, upserts recents)
  - `DELETE /api/project` body `{ path, trash?:boolean }` → `{ ok:true }` (removes from recents; unlinks file only if `trash`)
- Consumes: existing helpers — the `~/.winmux` dir resolver used by the instance/trust files, and the JSON body-reader used by other POST routes.

- [ ] **Step 1: Add the project-store helpers** in `server.cjs` (near the config helpers):

```js
// ---- projects: files on disk, recents index in ~/.winmux ----
const os = require('os');
function projectsDir() {
  const d = path.join(os.homedir(), 'Documents', 'WinMux Projects');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}
function recentsFile() { return path.join(winmuxHome(), 'recents.json'); } // winmuxHome() = existing ~/.winmux resolver
function readRecents() {
  try { return JSON.parse(fs.readFileSync(recentsFile(), 'utf8')).recents || []; } catch (e) { return []; }
}
function writeRecents(list) {
  const f = recentsFile(), tmp = f + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify({ recents: list.slice(0, 30) }, null, 2)); fs.renameSync(tmp, f); } catch (e) {}
}
function safeProjectPath(p) {
  if (!p || typeof p !== 'string') return null;
  const r = path.resolve(p);
  if (!/\.json$/i.test(r)) return null;
  return r;
}
function tabCount(layout) {
  try { return (layout.cols || []).reduce((a, c) => a + c.reduce((b, pd) => b + (pd.tabs || []).length, 0), 0); }
  catch (e) { return 0; }
}
```

- [ ] **Step 2: Add `GET /api/projects`** (recents + missing flags + default dir):

```js
if (urlPath === '/api/projects') {
  const list = readRecents().map(r => ({ ...r, missing: !fs.existsSync(r.path) }));
  return sendJson(res, { dir: projectsDir(), recents: list });
}
```

- [ ] **Step 3: Add `GET /api/project`** (read one):

```js
if (urlPath === '/api/project' && req.method === 'GET') {
  let q = {}; try { q = Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch (e) {}
  const p = safeProjectPath(q.path);
  if (!p || !fs.existsSync(p)) return sendJson(res, { error: 'not found' }, 404);
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return sendJson(res, { name: j.name || path.basename(p, '.json'), layout: j.layout || j, modified: j.modified || 0 });
  } catch (e) { return sendJson(res, { error: 'unreadable' }, 400); }
}
```

- [ ] **Step 4: Add `POST /api/project`** (save/write + upsert recents):

```js
if (urlPath === '/api/project' && req.method === 'POST') {
  return readBody(req, (body) => {
    const name = (body.name || 'Untitled').trim();
    let p = safeProjectPath(body.path);
    if (!p) p = path.join(projectsDir(), name.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').toLowerCase() + '.winmux.json');
    const now = Date.now();
    let created = now; try { created = JSON.parse(fs.readFileSync(p, 'utf8')).created || now; } catch (e) {}
    const doc = { winmuxProject: 1, name, created, modified: now, layout: body.layout || {} };
    const tmp = p + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(doc, null, 2)); fs.renameSync(tmp, p); }
    catch (e) { return sendJson(res, { error: 'write failed: ' + e.message }, 500); }
    const rec = { path: p, name, tabs: tabCount(body.layout || {}), opened: now };
    writeRecents([rec].concat(readRecents().filter(r => r.path !== p)));
    return sendJson(res, { path: p });
  });
}
```

- [ ] **Step 5: Add `DELETE /api/project`** (remove from recents; unlink only if `trash`):

```js
if (urlPath === '/api/project' && req.method === 'DELETE') {
  return readBody(req, (body) => {
    const p = safeProjectPath(body.path);
    if (!p) return sendJson(res, { error: 'bad path' }, 400);
    writeRecents(readRecents().filter(r => r.path !== p));
    if (body.trash) { try { fs.unlinkSync(p); } catch (e) {} }
    return sendJson(res, { ok: true });
  });
}
```

(If `sendJson` / `readBody` / `winmuxHome` are named differently in `server.cjs`, reuse the actual local helpers — do not add new ones. Confirm the exact names by reading the `/api/config` and `/api/clip` handlers before writing.)

- [ ] **Step 6: Write `scripts/projects-smoke.cjs`** — assumes a WinMux server is already running on `WINMUX_PORT` (default 8791); POSTs a fake layout, GETs it back, asserts the file exists with `winmuxProject:1`, then DELETEs it from recents:

```js
const http = require('http');
const port = process.env.WINMUX_PORT || 8791;
const req = (method, pathname, body) => new Promise((ok, no) => {
  const r = http.request({ port, method, path: pathname, headers: { 'content-type': 'application/json' } }, (s) => {
    let b = ''; s.on('data', d => b += d); s.on('end', () => ok({ code: s.statusCode, json: (() => { try { return JSON.parse(b); } catch (e) { return null; } })() }));
  }); r.on('error', no); if (body) r.write(JSON.stringify(body)); r.end();
});
(async () => {
  const layout = { v: 4, cols: [[{ active: 0, tabs: [{ type: 'terminal', shell: 'pwsh', cwd: 'C:/tmp' }] }]], group: 'Smoke' };
  const saved = await req('POST', '/api/project', { name: 'Smoke Test', layout });
  if (!saved.json || !saved.json.path) throw new Error('save failed: ' + JSON.stringify(saved));
  const got = await req('GET', '/api/project?path=' + encodeURIComponent(saved.json.path));
  if (got.json.layout.group !== 'Smoke') throw new Error('roundtrip mismatch: ' + JSON.stringify(got.json));
  const listed = await req('GET', '/api/projects');
  if (!listed.json.recents.some(r => r.path === saved.json.path)) throw new Error('not in recents');
  await req('DELETE', '/api/project', { path: saved.json.path, trash: true });
  console.log('projects-smoke OK →', saved.json.path);
})().catch(e => { console.error('projects-smoke FAIL', e.message); process.exit(1); });
```

- [ ] **Step 7: Run it** against a live server: `node server.cjs` in one shell, `WINMUX_PORT=8791 node scripts/projects-smoke.cjs` in another. Expected: `projects-smoke OK → …\WinMux Projects\smoke-test.winmux.json`.

- [ ] **Step 8: Commit** `feat(projects): server-side project store + /api/project(s) endpoints`.

---

### Task 2: Client project API + the Projects panel

**Files:**
- Modify: `public/index.html` — replace the `#sessmenu` inner markup with the Projects panel skeleton (keep the element id + anchor wiring).
- Modify: `public/app.js` — add a `Projects` module (fetch wrappers + render), repoint `openLayoutMenu`/`saveLayoutDialog`/`loadLayoutDialog` to it.
- Modify: `public/cockpit.css` — panel styles (reuse the mock's classes: `.proj`, `.fold`, `.chip`, etc.).

**Interfaces:**
- Consumes (Task 1 HTTP): the 4 endpoints above.
- Consumes (existing): `snapshot()`, `restoreLayout(desc)`, `openSavedLayout(l)` confirm-guard, `notify()`.
- Produces (JS): `Projects.open(anchor)`, `Projects.saveCurrent()`, `Projects.openPath(path)`, `Projects.newProject()`.

- [ ] **Step 1: Add fetch wrappers** in `app.js`:

```js
var Projects = (function () {
  function api(method, url, body) {
    return fetch(url, { method: method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(function (r) { return r.json(); });
  }
  function list() { return api('GET', '/api/projects'); }
  function read(path) { return api('GET', '/api/project?path=' + encodeURIComponent(path)); }
  function save(name, path, layout) { return api('POST', '/api/project', { name: name, path: path, layout: layout }); }
  function forget(path) { return api('DELETE', '/api/project', { path: path }); }
  return { api: api, list: list, read: read, save: save, forget: forget };
})();
```

- [ ] **Step 2: Layout template as a project** — a helper that returns `snapshot()` with `sid`s stripped (a project is a template, same rule as app.js:3395):

```js
function projectLayout() {
  var d = snapshot();
  d.cols.forEach(function (c) { c.forEach(function (pd) { (pd.tabs || []).forEach(function (td) { td.sid = ''; }); }); });
  return d;
}
```

- [ ] **Step 3: Replace `#sessmenu` markup** in `index.html` with the panel skeleton (recents list container + New / Open-file / name-input + Save), classes from the approved mock. Keep `id="sessmenu"` so existing open/close/anchor code still targets it.

- [ ] **Step 4: `renderRecents()`** — fetch `/api/projects`, build the rows (folder-color dot, name, tab count, chips from the layout's shells, last-opened via existing `ago()`, filename), greying `missing` entries; empty → the mock's empty state.

- [ ] **Step 5: Wire actions** — row click → `Projects.read(path)` → `openSavedLayout({name, desc:layout})` (reuses the confirm-if-live guard); **Save** → `Projects.save(name, currentPath, projectLayout())` then set current-project (Task 3); **New** → `Projects.newProject()` (Task 3); **Open file…** → path input → `read` → restore.

- [ ] **Step 6: Repoint entry functions** — `saveLayoutDialog`/`loadLayoutDialog`/`openLayoutMenu` now open the Projects panel; delete the dead `ct-layouts` render/save/delete handlers (`renderLayouts`, `doSaveLayout`, `writeLayouts` and their listeners) — but keep `layouts()` reachable for the one-time migration (Task 4).

- [ ] **Step 7: Build + eyeball** — `npm run verify` must still pass its existing checks; open the app, confirm the panel renders and a save writes a file (check `Documents\WinMux Projects\`). Screenshot for Task 6.

- [ ] **Step 8: Commit** `feat(projects): Projects panel replaces the layout popover`.

---

### Task 3: Current project + save-on-close + dirty tracking

**Files:**
- Modify: `public/app.js` — `ct-current` pointer, dirty flag, save-on-close prompt.

**Interfaces:**
- Consumes: `Projects.save`, `confirmDialog`, `persistLive`, the `beforeunload` hook (app.js ~4289).
- Produces (JS): `currentProject` state `{ path, name, dirty }`; `markDirty()`; `setCurrentProject(path, name)`.

- [ ] **Step 1: State + helpers** — `currentProject` persisted in `ct-current`; `setCurrentProject()` writes it and re-renders the sidebar Projects row label; `markDirty()` sets `dirty=true`.

- [ ] **Step 2: Fire `markDirty()`** on structural changes only — tab add/close/move, rename, group change, folder/resume change. Hook the existing places that already call `persistLive()` (they mark exactly the structural mutations); do **not** mark on shell output.

- [ ] **Step 3: Save-on-close** — in `beforeunload` and before `newProject()`/opening another project, if `currentProject.dirty`, show the mock's **Save "X" before closing?** prompt (`confirmDialog` with Save / Don't save). Save → `Projects.save(...)` then proceed; Don't save → proceed. (In `beforeunload` a synchronous best-effort `navigator.sendBeacon('/api/project', …)` on Save, since async can't block unload.)

- [ ] **Step 4: `newProject()`** — guard-save if dirty, then `restoreLayout` a single fresh terminal, clear `ct-current`.

- [ ] **Step 5: Verify** — save a project, add a tab (row shows dirty), reload → prompt fires; screenshot the prompt for Task 6.

- [ ] **Step 6: Commit** `feat(projects): current-project pointer + save-on-close`.

---

### Task 4: One-time migration (ct-layouts → project files)

**Files:**
- Modify: `public/app.js` — migration run on boot, behind a `ct-projects-migrated` marker.

**Interfaces:**
- Consumes: `layouts()` (kept from Task 2), `Projects.save`.

- [ ] **Step 1: `migrateLayoutsOnce()`** — if `localStorage['ct-projects-migrated']` unset and `layouts()` non-empty, for each `{name, desc}` call `Projects.save(name, null, strippedDesc)`; on success set the marker. Leave `ct-layouts` in place (silent safety copy). Idempotent.

- [ ] **Step 2: Call it** early in boot, before the on-launch panel decision (Task 5), so migrated projects appear in recents immediately.

- [ ] **Step 3: Verify** — seed a fake `ct-layouts` blob in a fresh profile, load, assert a file appears in `Documents\WinMux Projects\` and shows in recents.

- [ ] **Step 4: Commit** `feat(projects): migrate saved layouts into project files once`.

---

### Task 5: Entry points (sidebar row, on-launch, palette, shortcut)

**Files:**
- Modify: `public/index.html` + `public/cockpit.css` — a **Projects** row near the brand header.
- Modify: `public/app.js` — on-launch panel logic, palette command, shortcut binding.

- [ ] **Step 1: Sidebar Projects row** — a clickable row by the brand/nav header showing the current project name (or "No project"); click opens the panel.
- [ ] **Step 2: On-launch** — in boot, after migration: if `ct-live` did not restore a workspace (the `!restored` branch at app.js ~4300), open the Projects panel instead of only spawning a bare terminal. If a project is current, restore silently.
- [ ] **Step 3: Palette** — add "Open project" / "Save project" commands to the command palette registry.
- [ ] **Step 4: Shortcut** — ensure `Ctrl+Alt+O` opens the panel (repoint the existing binding).
- [ ] **Step 5: Verify** — screenshot the sidebar row + on-launch panel (desktop + phone widths).
- [ ] **Step 6: Commit** `feat(projects): sidebar entry, on-launch panel, palette + shortcut`.

---

### Task 6: Harness check + proof + docs

**Files:**
- Modify: `verify.cjs` — a `projects` check (round-trip through disk).
- Modify: `PLAN.md` / `README` — document Projects.

- [ ] **Step 1: `projects` harness check** — in the running app: call `Projects.save('Harness', null, projectLayout())` via `page.evaluate`; assert `/api/project?path=` returns a layout whose group matches; mutate the workspace (open a tab); restore the saved project; assert tab count matches the file, not the mutation. Clean up (`DELETE trash:true`).
- [ ] **Step 2: Migration check** — seed `ct-layouts`, reload, assert a project file exists and `#sessmenu` no longer shows the old layout list.
- [ ] **Step 3: Run full `npm run verify`** — capture the pass/fail count; fix any regression before proceeding.
- [ ] **Step 4: Screenshots** — panel with recents, save-on-close prompt, sidebar row, at desktop + phone; ship to Edward (SendUserFile).
- [ ] **Step 5: Docs** — Projects section in PLAN.md + README (what a project file is, where they live, how to open/save).
- [ ] **Step 6: Commit + push** `feat(projects): harness check, docs, proof` and push the branch.

---

## Self-Review

- **Spec coverage:** file-on-disk model (Task 1), recents (Task 1/2), panel + save/open/new (Task 2), save-on-close (Task 3), migration (Task 4), entry points incl. on-launch (Task 5), harness + screenshots (Task 6). All spec sections mapped.
- **Type consistency:** `layout` is `snapshot()`'s shape everywhere; `projectLayout()` (sid-stripped) is the single writer; recents entry shape `{path,name,tabs,opened,missing}` used identically in server and client.
- **Placeholder scan:** endpoint bodies, smoke script, and JS wrappers are concrete; the one deferred detail (exact `sendJson`/`readBody`/`winmuxHome` helper names) is called out in Task 1 Step 5 to confirm-by-reading, not guessed.
- **Owner gate:** merge to `main` untouched; all tasks are branch-local and reversible.
