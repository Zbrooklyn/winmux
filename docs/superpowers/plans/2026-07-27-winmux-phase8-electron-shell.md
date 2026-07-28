# WinMux Phase 8 — Electron Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the existing WinMux web app in an Electron desktop shell that boots `server.cjs` in-process and loads it in a frameless native window, without editing `public/cockpit.css` and without changing how `node server.cjs` serves the phone.

**Architecture:** Electron main (`electron/main.ts`) requires the repo-root `server.cjs`, calls a new exported `start()` to boot the HTTP/WS server and learn its chosen port, then opens a frameless `BrowserWindow` pointed at `http://127.0.0.1:<port>/` — the exact same UI the phone loads. A preload bridge (`electron/preload.ts`) exposes `window.winmux` (minimize/maximize/close), which the app's existing `.wc` window-control buttons already call. New code is TypeScript compiled to `dist-electron/`; `server.cjs` and `public/` are otherwise untouched.

**Tech Stack:** Electron, TypeScript, existing Node + node-pty + ws backend, Playwright `_electron` for the smoke test.

## Global Constraints

- Platform: **Windows-first**; **Electron** (not Tauri); **one repo** (`projects/winmux`).
- `public/cockpit.css` is a **frozen contract — never edit it.** All Electron-only styling goes in the `<style>` block of `public/index.html`, gated by a `:root[data-electron]` selector.
- **Pure-web/phone mode must keep working unchanged:** `node server.cjs` must still serve `public/` and the Tailscale phone door exactly as today. The only permitted change to `server.cjs` is wrapping its startup in an exported `start()` plus a `require.main === module` auto-run guard.
- New code is **TypeScript** in `electron/`, compiled to `dist-electron/` via `tsconfig.electron.json`. `server.cjs`/`public/*` stay plain JS.
- Keep the committed harness green: `npm run verify` (`verify.cjs`) must pass, extended with an Electron smoke test.
- License/product: WinMux, MIT, public OSS (affects later phases; no change here).

---

### Task 1: Electron + TypeScript toolchain

**Files:**
- Modify: `package.json` (devDependencies + scripts)
- Create: `tsconfig.electron.json`
- Create: `electron/main.ts` (temporary trivial version, replaced in Task 3)
- Create: `.gitignore` entry for `dist-electron/`

**Interfaces:**
- Produces: `npm run build:electron` compiles `electron/*.ts` → `dist-electron/*.js`; `npm run dev:electron` builds then launches Electron.

- [ ] **Step 1: Add devDependencies and scripts to `package.json`**

Add to `devDependencies` (alongside the existing `"playwright": "^1.62.0"`):

```json
    "electron": "^33.2.0",
    "typescript": "^5.7.2",
    "@types/node": "^22.10.0"
```

Add to `scripts` (alongside existing):

```json
    "build:electron": "tsc -p tsconfig.electron.json",
    "dev:electron": "npm run build:electron && electron dist-electron/main.js"
```

- [ ] **Step 2: Create `tsconfig.electron.json`**

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "CommonJS",
    "moduleResolution": "node",
    "outDir": "dist-electron",
    "rootDir": "electron",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["electron/**/*.ts"]
}
```

- [ ] **Step 3: Create a trivial `electron/main.ts` to prove the toolchain**

```ts
import { app, BrowserWindow } from 'electron';

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 600 });
  win.loadURL('data:text/html,<h1>WinMux Electron toolchain OK</h1>');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 4: Add `dist-electron/` to `.gitignore`**

Append the line `dist-electron/` to `.gitignore` (create the file if absent).

- [ ] **Step 5: Install and build**

Run: `cd projects/winmux && npm install && npm run build:electron`
Expected: `npm install` pulls `electron` + `typescript`; `tsc` emits `dist-electron/main.js` with no errors.

- [ ] **Step 6: Launch once to confirm Electron works**

Run: `npm run dev:electron`
Expected: a native window opens showing "WinMux Electron toolchain OK". Close it.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.electron.json electron/main.ts .gitignore
git commit -m "build(electron): add Electron + TypeScript toolchain (Phase 8)"
```

---

### Task 2: Make `server.cjs` bootable in-process (exported `start()`)

**Files:**
- Modify: `server.cjs` (the trailing startup IIFE, ~lines 868–890)

**Interfaces:**
- Produces: `module.exports = { start }` where `start(): Promise<{ port: number, host: string }>` — resolves after the server is listening, returning the chosen port. Running `node server.cjs` directly still auto-starts (unchanged behavior).

- [ ] **Step 1: Read the current startup block**

Open `server.cjs` and locate the trailing `(async () => { … server.listen(PORT, HOST, announce); })();` block (currently the last statements in the file, around lines 868–890). Confirm `PORT`, `HOST`, `PORT_FORCED`, `PORT_REQUESTED`, `server`, `pickPort`, `tunnelledPorts`, and `announce` are all module-level (they are).

- [ ] **Step 2: Replace the IIFE with an exported `start()` + auto-run guard**

Replace the entire trailing `(async () => { … })();` block with:

```js
async function start() {
  if (!PORT_FORCED) {
    PORT = await pickPort();
    if (PORT !== PORT_REQUESTED) {
      console.log('port ' + PORT_REQUESTED + ' was busy on your Tailscale address — using ' + PORT + ' instead');
    }
  } else if ((await tunnelledPorts()).has(PORT)) {
    // An explicit PORT is otherwise obeyed exactly. Not this one: serving the
    // keyless desk door on a port the whole tailnet is already forwarded into
    // would hand out a shell with no key at all. Refuse loudly instead.
    console.error('WinMux will not start on port ' + PORT + '.');
    console.error('A "tailscale serve" rule already forwards that port to this PC, so anything on your Tailscale');
    console.error('network would reach WinMux without a key. Start it on a different port, or run');
    console.error('  tailscale serve status');
    console.error('to find the rule that points at 127.0.0.1:' + PORT + ' and turn that one off.');
    throw new Error('refused: port ' + PORT + ' is already tunnelled by tailscale serve');
  }
  await new Promise((resolve) => server.listen(PORT, HOST, () => { announce(); resolve(); }));
  return { port: PORT, host: HOST };
}

module.exports = { start };

// Running `node server.cjs` directly auto-starts, exactly as before. When
// required by the Electron main process, nothing runs until start() is called.
if (require.main === module) {
  start().catch((e) => { console.error(e.message); process.exit(2); });
}
```

- [ ] **Step 3: Verify phone/web mode is unchanged**

Run: `PORT_GROUPS= node server.cjs` (or just `node server.cjs`)
Expected: prints `WinMux running at http://127.0.0.1:8799` (or an alternate port), `shells: …`, `phone access: off …` — identical to before. Open `http://127.0.0.1:8799` in a browser and confirm the cockpit loads and a real command runs. Ctrl+C to stop.

- [ ] **Step 4: Verify `start()` is requirable and returns the port**

Run:
```bash
node -e "require('./server.cjs').start().then(r => { console.log('READY', JSON.stringify(r)); process.exit(0); });"
```
Expected: prints the normal boot logs then `READY {"port":8799,"host":"127.0.0.1"}` and exits 0.

- [ ] **Step 5: Run the existing harness to confirm no regression**

Run: `npm run verify`
Expected: the existing checks still pass (same count as before this task).

- [ ] **Step 6: Commit**

```bash
git add server.cjs
git commit -m "refactor(server): export start() + require.main guard so Electron can boot it in-process (Phase 8)"
```

---

### Task 3: Electron main boots the server + opens the frameless window

**Files:**
- Modify: `electron/main.ts` (replace the trivial Task 1 version)

**Interfaces:**
- Consumes: `require('../server.cjs').start(): Promise<{ port: number, host: string }>` (Task 2).
- Produces: on `app.whenReady`, a frameless `BrowserWindow` loading `http://127.0.0.1:<port>/`; a module-level `win: BrowserWindow | null`. IPC handlers for `win:minimize` / `win:maximize` / `win:close` are added in Task 4.

- [ ] **Step 1: Replace `electron/main.ts`**

```ts
import { app, BrowserWindow } from 'electron';
import * as path from 'path';

// server.cjs is CommonJS at the repo root (one level up from dist-electron/).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../server.cjs') as {
  start: () => Promise<{ port: number; host: string }>;
};

let win: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  const { port } = await start();
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    frame: false,
    backgroundColor: '#111214',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  await win.loadURL('http://127.0.0.1:' + port + '/');
  win.show();
  win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
```

- [ ] **Step 2: Create a placeholder preload so the path resolves (real version in Task 4)**

Create `electron/preload.ts`:

```ts
// Populated in Task 4.
export {};
```

- [ ] **Step 3: Build and launch**

Run: `npm run dev:electron`
Expected: a **frameless** window opens showing the real WinMux cockpit (tab bar, terminal). The server boot logs appear in the terminal that launched it.

- [ ] **Step 4: Prove a real command runs in the Electron window**

In the opened window, click into the terminal, type `Get-Date` and press Enter.
Expected: PowerShell prints the current date/time inside the Electron window. Close the window (the app quits).

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts electron/preload.ts
git commit -m "feat(electron): boot server.cjs in-process + open frameless cockpit window (Phase 8)"
```

---

### Task 4: Preload bridge + native window controls

**Files:**
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts` (add IPC handlers)
- Reference (read, do not edit): `public/app.js:1771-1781` (the `winBridge()` wiring)

**Interfaces:**
- Consumes: the app's existing `.wc` buttons call `window.winmux.minimize()`, `window.winmux.maximize()`, `window.winmux.close()` (confirm exact method names in `app.js:1774-1780`).
- Produces: `window.winmux = { minimize, maximize, close, isElectron: true }`; and `document.documentElement` gets a `data-electron` attribute for CSS gating (used by Task 5).

- [ ] **Step 1: Confirm the method names the app calls**

Read `public/app.js` lines 1771–1781. Confirm `wc-min` calls `b.minimize()`, `wc-close` calls `b.close()`, and `wc-max` calls `b.maximize()` (fullscreen only as fallback when no bridge). If any name differs, use the app's actual names in Step 2 — the bridge must match the consumer.

- [ ] **Step 2: Write `electron/preload.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('winmux', {
  isElectron: true,
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
});

// Tag the document so index.html CSS can enable Electron-only drag regions.
// Preload shares the page DOM even with contextIsolation on.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.setAttribute('data-electron', '');
});
```

- [ ] **Step 3: Add IPC handlers to `electron/main.ts`**

Add, after the `createWindow` function definition (before `app.whenReady`):

```ts
import { ipcMain } from 'electron';

ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', () => win?.close());
```

(Merge the `ipcMain` import into the existing `import { app, BrowserWindow } from 'electron';` line: `import { app, BrowserWindow, ipcMain } from 'electron';`.)

- [ ] **Step 4: Build, launch, and test the three controls**

Run: `npm run dev:electron`
Expected: the window opens. Click the top-right **minimize** button → window minimizes to taskbar. Restore it. Click **maximize** → window fills the screen; click again → restores. Click **close** → window closes and the app quits.

- [ ] **Step 5: Confirm the bridge is present in the page**

With the window open, open its devtools (temporarily add `win.webContents.openDevTools()` in `createWindow`, or run from the terminal) and in the console run `window.winmux.isElectron`.
Expected: `true`. Remove the temporary `openDevTools()` line if added.

- [ ] **Step 6: Commit**

```bash
git add electron/preload.ts electron/main.ts
git commit -m "feat(electron): preload bridge + native min/max/close wired to .wc controls (Phase 8)"
```

---

### Task 5: Make the window draggable (Electron-only)

**Files:**
- Modify: `public/index.html` (the `<style>` block only — NOT `cockpit.css`)

**Interfaces:**
- Consumes: `:root[data-electron]` set by the preload (Task 4).
- Produces: the desktop tab bar (`.ptabs`) is a drag handle under Electron; interactive children stay clickable.

- [ ] **Step 1: Confirm the desktop top-bar element**

Read `public/index.html` markup to confirm the top pane tab bar is `.ptabs` and its interactive children include `.ptab`, `.pc`, `.sxbtn`, `.tab-of`, and `.wc`. (These are the controls that must remain clickable, i.e. `no-drag`.)

- [ ] **Step 2: Add drag-region CSS to the `index.html` `<style>` block**

Add near the other Electron/`data-electron`-related rules (or at the end of the block):

```css
  /* Under Electron the window is frameless, so the tab bar doubles as the
     drag handle. cockpit.css stays frozen; this lives in index.html and only
     activates when the preload has tagged the document. */
  :root[data-electron] .ptabs { -webkit-app-region: drag; }
  :root[data-electron] .ptabs .ptab,
  :root[data-electron] .ptabs .pc,
  :root[data-electron] .ptabs .sxbtn,
  :root[data-electron] .ptabs .tab-of,
  :root[data-electron] .ptabs .wc { -webkit-app-region: no-drag; }
```

- [ ] **Step 3: Build, launch, and test dragging**

Run: `npm run dev:electron`
Expected: click-drag an **empty** part of the tab bar → the window moves. Clicking a tab, the `+`, a footer icon, or a window control still works (does not drag).

- [ ] **Step 4: Confirm phone/web mode is visually unaffected**

Run `node server.cjs`, open `http://127.0.0.1:8799` in a normal browser.
Expected: no `data-electron` attribute is set (no preload), so the drag rules never apply — the web/phone UI is byte-for-byte as before.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(electron): make the tab bar a window drag handle under Electron only (Phase 8)"
```

---

### Task 6: Electron offscreen smoke test in the harness

**Files:**
- Modify: `verify.cjs` (add an Electron smoke check)
- Reference: existing `verify.cjs` structure (Playwright-based, zero-arg `npm run verify`)

**Interfaces:**
- Consumes: Playwright's `_electron` launcher (Playwright is already a devDependency); the built `dist-electron/main.js`.
- Produces: a new harness check `electron-shell` that launches the Electron app, asserts the cockpit rendered and `window.winmux.isElectron === true`, screenshots it, and reports pass/fail in the existing tally.

- [ ] **Step 1: Read how `verify.cjs` registers and reports checks**

Open `verify.cjs`. Identify the pattern it uses to (a) define a check, (b) accumulate pass/fail, (c) print the `N/N checks passed` line, and (d) where screenshots are written (`verify-out/`). Mirror that pattern exactly for the new check rather than inventing a new one.

- [ ] **Step 2: Write the failing test — add the `electron-shell` check**

Add a check that runs when invoked (either always, or under a `PORT_GROUPS`-style selector consistent with the file's existing convention). Core body:

```js
// --- electron-shell smoke check ---
const { _electron } = require('playwright');
async function checkElectronShell(record) {
  const path = require('path');
  const electronApp = await _electron.launch({
    args: [path.join(__dirname, 'dist-electron', 'main.js')],
    cwd: __dirname,
  });
  try {
    const page = await electronApp.firstWindow();
    await page.waitForTimeout(6000); // server boot + cockpit render
    const hasCockpit = await page.evaluate(() => !!document.querySelector('.ptabs'));
    const isElectron = await page.evaluate(() => !!(window.winmux && window.winmux.isElectron));
    await page.screenshot({ path: path.join(__dirname, 'verify-out', 'electron-shell.png') });
    record('electron-shell: cockpit renders', hasCockpit, 'cockpit .ptabs present: ' + hasCockpit);
    record('electron-shell: winmux bridge', isElectron, 'window.winmux.isElectron: ' + isElectron);
  } finally {
    await electronApp.close();
  }
}
```

Wire `checkElectronShell` into the harness's run list using its existing `record`/tally mechanism (matching what Step 1 found).

- [ ] **Step 3: Run it against a NOT-yet-built dist to see it fail**

Run: `rm -rf dist-electron && npm run verify` (or the harness command that includes the electron check)
Expected: the `electron-shell` check FAILS (Electron can't launch a missing `dist-electron/main.js`), proving the check actually exercises the shell.

- [ ] **Step 4: Build, then run the check to see it pass**

Run: `npm run build:electron && npm run verify`
Expected: `electron-shell: cockpit renders` and `electron-shell: winmux bridge` both PASS; `verify-out/electron-shell.png` shows the cockpit. Overall tally increases by 2 and stays green.

- [ ] **Step 5: Make `verify` build the shell first (so it's self-contained)**

Change the `verify` script in `package.json` to build the Electron bundle first:

```json
    "verify": "npm run build:electron && node verify.cjs"
```

Run: `npm run verify`
Expected: builds then runs; all checks pass including the two Electron ones.

- [ ] **Step 6: Commit**

```bash
git add verify.cjs package.json
git commit -m "test(verify): Electron offscreen smoke check (cockpit renders + bridge present) (Phase 8)"
```

---

### Task 7: Phone-mode regression proof + docs

**Files:**
- Modify: `PLAN.md` (add Phase 8 section)
- Modify: `DESIGN.md` (note the Electron shell exists; window controls now real under Electron)
- Modify: `README.md` (add a "Run as a desktop app" note; create the file if absent)

**Interfaces:**
- Consumes: nothing new.
- Produces: documentation only; no code behavior change.

- [ ] **Step 1: Prove phone mode still works end-to-end (regression gate)**

Run: `node server.cjs`, then from a second machine or phone on the tailnet (or emulate) open the served URL after enabling phone access in Settings → Phone.
Expected: the phone connects to the **same** server and runs a real command — identical to pre-Phase-8 behavior. (If a live device isn't available, at minimum confirm `http://127.0.0.1:<port>` serves the cockpit and the phone door toggle still returns a QR from `/api/phone/qr`.)

- [ ] **Step 2: Add a Phase 8 section to `PLAN.md`**

Append a `## Phase 8 — Electron shell` section summarizing: the Electron wrapper boots `server.cjs` in-process via the new `start()`; a frameless `BrowserWindow` loads the same served cockpit; native min/max/close via the `window.winmux` preload bridge; tab bar is the drag handle under Electron only; `cockpit.css` untouched; phone/web mode unchanged; harness gains an `electron-shell` smoke check. Mark it Live once Tasks 1–6 are done.

- [ ] **Step 3: Note the Electron shell in `DESIGN.md`**

Add one Decisions-log entry: window-frame controls, previously stubbed/forward-wired, are now **real** under Electron (the `window.winmux` bridge is injected by `electron/preload.ts`); in the plain browser they still fall back (maximize→fullscreen, minimize inert), unchanged.

- [ ] **Step 4: Add a desktop-app note to `README.md`**

Add a short section:

```markdown
## Run as a desktop app (Electron)

WinMux also runs as a native Windows app that wraps the same server:

    npm install
    npm run dev:electron

This opens WinMux in a frameless native window. The same server still serves
your phone over Tailscale — the desktop app and the phone are two clients of
one server.
```

- [ ] **Step 5: Commit**

```bash
git add PLAN.md DESIGN.md README.md
git commit -m "docs: record Phase 8 Electron shell in PLAN/DESIGN/README (Phase 8)"
```

- [ ] **Step 6: Push the phase**

```bash
git push origin master
```

---

## Self-Review

**Spec coverage (Phase 8 slice of the spec):**
- Electron shell wrapping the web app + booting `server.cjs` in-process → Tasks 2, 3. ✓
- Frameless window loading the served cockpit → Task 3. ✓
- Native window controls via `window.winmux` bridge → Task 4. ✓
- `cockpit.css` frozen; Electron styling in index.html only → Task 5 (gated by `:root[data-electron]`). ✓
- Pure-web/phone mode unchanged → Tasks 2 (require.main guard), 5 (no `data-electron` in browser), 7 (regression gate). ✓
- New code in TypeScript compiled alongside untouched server/public → Task 1. ✓
- Harness gains an Electron smoke test → Task 6. ✓
- Extend PLAN.md as Phase 8, not a competing file → Task 7. ✓

Out of Phase 8 scope (later phases, per spec): CLI/RPC (Phase 9), browser panel + markdown (Phase 10), agent integration (Phase 11), installer/auto-update/winget/LICENSE (Phase 12).

**Placeholder scan:** No TBD/TODO; every code step shows complete code; test steps give exact commands and expected output. One deliberate verification step (Task 4 Step 1, Task 5 Step 1, Task 6 Step 1) instructs reading the real file to confirm names/structure before writing — that is confirmation, not a placeholder.

**Type consistency:** `start()` returns `{ port, host }` (Task 2) and is consumed with that shape (Task 3). Bridge methods `minimize`/`maximize`/`close` + `isElectron` are defined in preload (Task 4) and asserted by the harness (Task 6) and consumed by `app.js` (Task 4 Step 1 confirms the names match). IPC channel names `win:minimize`/`win:maximize`/`win:close` match between preload (send) and main (on).
