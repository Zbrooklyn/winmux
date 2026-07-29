# WinMux Phase 12 — Installer + Clean Coexistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package WinMux as a Windows Electron installer (electron-builder → one NSIS `.exe`) that can run on the same machine as the from-source dev copy with **zero cross-interference**.

**Architecture:** A pure `resolveProfile({ isPackaged })` function computes a per-copy identity (appId, app name, userData dir, discovery file, trust file). The packaged `.exe` (`app.isPackaged === true`) and the dev copy (`false`) get disjoint identities, so Electron's `%APPDATA%` folder, the Chromium ProcessSingleton lock, the CLI discovery file, and the trusted-devices file never collide. `server.cjs` and the `winmux` CLI honor a `WINMUX_INSTANCE_FILE` env (mirroring the existing `WINMUX_TRUST_FILE`) so the desktop app hands each server its own discovery file. Web-port auto-fallback, the `__dirname`-scoped trust file, and the `winmux.ps1` `$Root`-scoped state already isolate by construction and must stay that way.

**Tech Stack:** Electron, electron-builder (NSIS target), TypeScript (`electron/`), Node (`server.cjs`, `bin/winmux.cjs`), Playwright (verification), node-pty (N-API prebuilds).

## Global Constraints

- **Clean coexistence is the hard acceptance test.** The installed app and the dev copy must run simultaneously with independent userData, independent discovery entries, independent settings/layouts/onboarding, and both windows alive. Nothing ships until this is proven against a real built `.exe`.
- **`node server.cjs` standalone path is unchanged** — the phone/browser server must still boot exactly as today with no new required env.
- **`public/cockpit.css` is frozen** — no edits; this phase touches no cockpit styling.
- **node-pty uses N-API prebuilds** — no `electron-rebuild`; electron-builder MUST `asarUnpack` `node_modules/node-pty/prebuilds/**` (and `build/Release/*.node` if present) so the native binary loads from the installed app.
- **Deferred, structure-for-not-build-now:** code signing (costs money; unsigned works but shows Windows SmartScreen), auto-update (electron-updater + GitHub Releases), winget submission. None are built here; the design must not preclude them.
- **appId:** `com.zbrooklyn.winmux` (packaged) / `com.zbrooklyn.winmux.dev` (dev). **productName:** `WinMux`.
- **NSIS install mode:** per-user (`perMachine: false`, `oneClick: false`) — no admin prompt, cleaner coexistence, and it keeps the packaged userData under the user's `%APPDATA%`.

---

## File Structure

- `electron/profile.ts` **(new)** — pure `resolveProfile({ isPackaged, appData, home, resourcesPath })` → `{ appId, name, userData, instanceFile, trustFile }`. No Electron import; fully unit-testable.
- `electron/main.ts` **(modify)** — before `app.whenReady()`, call `resolveProfile`, then `app.setAppUserModelId`, `app.setName`, `app.setPath('userData', …)`, and export `WINMUX_INSTANCE_FILE` + `WINMUX_TRUST_FILE` into `process.env` so the in-process server picks them up.
- `server.cjs` **(modify)** — read `process.env.WINMUX_INSTANCE_FILE` (default `~/.winmux/instance.json`) instead of the hardcoded path.
- `bin/winmux.cjs` **(modify)** — read `process.env.WINMUX_INSTANCE_FILE`; add `--dev` / `WINMUX_PROFILE=dev` to target the dev discovery file.
- `package.json` **(modify)** — `build` block (electron-builder config), `dist`/`pack` scripts, `electron-builder` devDep.
- `build/icon.ico` **(new)** — 256×256 app icon.
- `verify.cjs` **(modify)** — add a zero-arg `profile` check asserting both `resolveProfile` branches are disjoint.
- `verify-coexist.cjs` **(new)** — the heavy integration proof: build `--dir`, launch packed + dev together in smoke mode, assert disjoint userData + discovery + both cockpits render.
- `PLAN.md` **(modify)** — extend Phase 12 with the packaging spine + coexistence acceptance test; point at this plan.

---

### Task 1: Pure profile resolver

**Files:**
- Create: `electron/profile.ts`
- Test: `electron/profile.test.cjs`

**Interfaces:**
- Produces: `resolveProfile(opts: { isPackaged: boolean; appData: string; home: string }): { appId: string; name: string; userData: string; instanceFile: string; trustFile: string }`

- [ ] **Step 1: Write the failing test**

```javascript
// electron/profile.test.cjs
const assert = require('assert');
const path = require('path');
// Compiled output lands in dist-electron/profile.js; test the compiled JS.
const { resolveProfile } = require('../dist-electron/profile.js');

const appData = 'C:\\Users\\E\\AppData\\Roaming';
const home = 'C:\\Users\\E';

const prod = resolveProfile({ isPackaged: true, appData, home });
const dev = resolveProfile({ isPackaged: false, appData, home });

// Identity is distinct across the two copies.
assert.notStrictEqual(prod.appId, dev.appId, 'appId must differ');
assert.notStrictEqual(prod.userData, dev.userData, 'userData must differ');
assert.notStrictEqual(prod.instanceFile, dev.instanceFile, 'instanceFile must differ');
assert.notStrictEqual(prod.trustFile, dev.trustFile, 'trustFile must differ');

// No path is a prefix of the other's userData (a nested dir would still share a lock).
assert.ok(!prod.userData.startsWith(dev.userData) && !dev.userData.startsWith(prod.userData),
  'userData dirs must not nest');

// Concrete production values are stable (users find their data here).
assert.strictEqual(prod.appId, 'com.zbrooklyn.winmux');
assert.strictEqual(prod.name, 'WinMux');
assert.strictEqual(prod.userData, path.join(appData, 'WinMux'));
assert.strictEqual(prod.instanceFile, path.join(home, '.winmux', 'instance.json'));
assert.strictEqual(dev.instanceFile, path.join(home, '.winmux', 'instance.dev.json'));

console.log('profile.test OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node electron/profile.test.cjs`
Expected: FAIL — `Cannot find module '../dist-electron/profile.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// electron/profile.ts
import * as path from 'path';

export interface ProfileOpts {
  isPackaged: boolean;
  appData: string; // app.getPath('appData'), e.g. %APPDATA%
  home: string;    // os.homedir()
}

export interface Profile {
  appId: string;
  name: string;
  userData: string;
  instanceFile: string;
  trustFile: string;
}

// One computation of a copy's identity. The packaged .exe and the from-source
// dev copy get disjoint values so they never share Electron's userData (and its
// ProcessSingleton lock), the CLI discovery file, or the trusted-devices file.
export function resolveProfile(opts: ProfileOpts): Profile {
  const dev = !opts.isPackaged;
  const winmuxDir = path.join(opts.home, '.winmux');
  return {
    appId: dev ? 'com.zbrooklyn.winmux.dev' : 'com.zbrooklyn.winmux',
    name: dev ? 'WinMux Dev' : 'WinMux',
    userData: path.join(opts.appData, dev ? 'WinMuxDev' : 'WinMux'),
    instanceFile: path.join(winmuxDir, dev ? 'instance.dev.json' : 'instance.json'),
    trustFile: path.join(winmuxDir, dev ? 'devices.dev.json' : 'devices.json'),
  };
}
```

- [ ] **Step 4: Compile and run the test to verify it passes**

Run: `npm run build:electron && node electron/profile.test.cjs`
Expected: PASS — `profile.test OK`

- [ ] **Step 5: Commit**

```bash
git add electron/profile.ts electron/profile.test.cjs
git commit -m "feat(installer): pure per-copy identity resolver (packaged vs dev disjoint)"
```

---

### Task 2: Wire the resolver into the Electron main

**Files:**
- Modify: `electron/main.ts` (top of file + start of `createWindow`)

**Interfaces:**
- Consumes: `resolveProfile` from Task 1.
- Produces: sets `process.env.WINMUX_INSTANCE_FILE` and `process.env.WINMUX_TRUST_FILE` **before** `require('../server.cjs').start()` is called, and sets Electron's identity/userData before `app.whenReady()`.

- [ ] **Step 1: Add the identity block at module top**

Insert immediately after the existing imports and the `server.cjs` require in `electron/main.ts`:

```typescript
import * as os from 'os';
import { resolveProfile } from './profile';

// Establish this copy's identity BEFORE anything reads userData or starts the
// server. app.isPackaged is true only inside the built .exe, so the installed
// app and the from-source dev copy resolve to disjoint identities automatically.
const profile = resolveProfile({
  isPackaged: app.isPackaged,
  appData: app.getPath('appData'),
  home: os.homedir(),
});
app.setAppUserModelId(profile.appId);
app.setName(profile.name);
app.setPath('userData', profile.userData);
// Hand the in-process server its own discovery + trust files so two running
// copies never clobber each other's ~/.winmux/instance.json or devices file.
process.env.WINMUX_INSTANCE_FILE = profile.instanceFile;
process.env.WINMUX_TRUST_FILE = process.env.WINMUX_TRUST_FILE || profile.trustFile;
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build:electron`
Expected: no TypeScript errors; `dist-electron/main.js` written.

- [ ] **Step 3: Verify the dev app boots with the dev identity (smoke)**

Run: `npm run verify` (the existing electron smoke check boots the real shell).
Expected: 225/225 (electron `ptyOk` still true — the identity change doesn't touch the server path).

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts
git commit -m "feat(installer): main sets per-copy identity + userData + hands server its discovery/trust files"
```

---

### Task 3: server.cjs honors WINMUX_INSTANCE_FILE

**Files:**
- Modify: `server.cjs:1093-1097` (the instance-advertise block)

**Interfaces:**
- Consumes: `process.env.WINMUX_INSTANCE_FILE` (default `~/.winmux/instance.json`).

- [ ] **Step 1: Replace the hardcoded discovery path**

Change the block at `server.cjs:1093-1097` from:

```javascript
  if (!process.env.WINMUX_NO_INSTANCE) try {
    const dir = path.join(os.homedir(), '.winmux');
    fs.mkdirSync(dir, { recursive: true });
    const inst = path.join(dir, 'instance.json');
```

to:

```javascript
  if (!process.env.WINMUX_NO_INSTANCE) try {
    const inst = process.env.WINMUX_INSTANCE_FILE || path.join(os.homedir(), '.winmux', 'instance.json');
    fs.mkdirSync(path.dirname(inst), { recursive: true });
```

(The later `path.join(dir, 'instance.json')` usages are removed — `inst` is now the full path; the `cleanup`/`unlinkSync(inst)` lines already use `inst` and are unchanged.)

- [ ] **Step 2: Verify standalone still advertises the default**

Run: `node -e "process.env.WINMUX_NO_INSTANCE='';const{start}=require('./server.cjs');start().then(async()=>{const fs=require('fs'),os=require('os'),p=require('path');await new Promise(r=>setTimeout(r,300));console.log('default exists:', fs.existsSync(p.join(os.homedir(),'.winmux','instance.json')));process.exit(0)})"`
Expected: `default exists: true`

- [ ] **Step 3: Verify the env override writes elsewhere**

Run: `WINMUX_INSTANCE_FILE="$HOME/.winmux/instance.test.json" node -e "const{start}=require('./server.cjs');start().then(async()=>{const fs=require('fs'),os=require('os'),p=require('path');await new Promise(r=>setTimeout(r,300));console.log('override exists:', fs.existsSync(p.join(os.homedir(),'.winmux','instance.test.json')));process.exit(0)})"`
Expected: `override exists: true`

- [ ] **Step 4: Commit**

```bash
git add server.cjs
git commit -m "feat(installer): server advertises to WINMUX_INSTANCE_FILE (default unchanged)"
```

---

### Task 4: winmux CLI honors WINMUX_INSTANCE_FILE + --dev

**Files:**
- Modify: `bin/winmux.cjs:15-18` (the discovery reader)

**Interfaces:**
- Consumes: `process.env.WINMUX_INSTANCE_FILE`, `process.env.WINMUX_PROFILE`, and a `--dev` argv flag. A bare `winmux` with none set targets the production `instance.json` (the installed app is the daily driver).

- [ ] **Step 1: Replace the discovery reader**

Change `bin/winmux.cjs:15-18` from:

```javascript
  if (process.env.WINMUX_PORT) return { port: Number(process.env.WINMUX_PORT), host: process.env.WINMUX_HOST || '127.0.0.1' };
  const f = path.join(os.homedir(), '.winmux', 'instance.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { die('WinMux is not running (no ~/.winmux/instance.json). Start it with `npm start` or the desktop app.'); }
```

to:

```javascript
  if (process.env.WINMUX_PORT) return { port: Number(process.env.WINMUX_PORT), host: process.env.WINMUX_HOST || '127.0.0.1' };
  // Which copy to drive: explicit file wins; then --dev / WINMUX_PROFILE=dev;
  // otherwise the production instance (the installed app is the default target).
  const dev = process.argv.includes('--dev') || process.env.WINMUX_PROFILE === 'dev';
  const f = process.env.WINMUX_INSTANCE_FILE
    || path.join(os.homedir(), '.winmux', dev ? 'instance.dev.json' : 'instance.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { die('WinMux is not running (no ' + f + '). Start it with `npm start` or the desktop app.'); }
```

- [ ] **Step 2: Strip the --dev flag so it is not forwarded as a verb argument**

Find where `bin/winmux.cjs` reads `argv` for the verb (near the top, after shebang). Add, right after `const argv = process.argv.slice(2);` (adjust to the file's actual variable):

```javascript
// --dev selects the dev copy in findInstance(); it is not a verb argument.
const devFlagIdx = argv.indexOf('--dev');
if (devFlagIdx !== -1) argv.splice(devFlagIdx, 1);
```

- [ ] **Step 3: Verify default vs --dev target different files**

Run: `node -e "const cp=require('child_process');['','--dev'].forEach(f=>{try{cp.execSync('node bin/winmux.cjs status '+f,{stdio:'pipe'})}catch(e){process.stdout.write(f+' -> '+String(e.stderr).match(/instance[.\w]*\.json/)+'\n')}})"`
Expected: two lines — `-> instance.json` and `--dev -> instance.dev.json` (both "not running" errors, but naming the correct file each time).

- [ ] **Step 4: Commit**

```bash
git add bin/winmux.cjs
git commit -m "feat(installer): winmux CLI targets prod by default, dev via --dev/WINMUX_PROFILE"
```

---

### Task 5: electron-builder config + NSIS installer

**Files:**
- Modify: `package.json` (add `build` block, `dist`/`pack` scripts, `electron-builder` devDep)
- Create: `build/icon.ico`

**Interfaces:**
- Produces: `npm run pack` → unpacked app in `dist-installer/win-unpacked/`; `npm run dist` → `dist-installer/WinMux Setup <version>.exe`.

- [ ] **Step 1: Add the icon**

Create `build/icon.ico` — a 256×256 ICO of the WinMux mark (accent `#8a5cf5` "W"). Generate from a source PNG:

```bash
# If a source PNG exists at build/icon-256.png:
node -e "console.log('place a 256x256 build/icon.ico; electron-builder requires >=256px')"
```

Acceptance: `build/icon.ico` exists and is ≥256×256. (A placeholder solid-accent icon is acceptable for this phase; a final mark is a later polish item.)

- [ ] **Step 2: Install electron-builder**

Run: `npm install --save-dev electron-builder`
Expected: `electron-builder` appears in `devDependencies`.

- [ ] **Step 3: Add the build block + scripts to package.json**

Add a top-level `"build"` key:

```json
"build": {
  "appId": "com.zbrooklyn.winmux",
  "productName": "WinMux",
  "directories": { "output": "dist-installer", "buildResources": "build" },
  "files": [
    "server.cjs",
    "public/**/*",
    "dist-electron/**/*",
    "bin/**/*",
    "package.json"
  ],
  "asarUnpack": [
    "node_modules/node-pty/prebuilds/**",
    "node_modules/node-pty/build/Release/*.node"
  ],
  "win": { "target": ["nsis"], "icon": "build/icon.ico" },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true,
    "artifactName": "WinMux Setup ${version}.${ext}"
  }
}
```

Add to `"scripts"`:

```json
"pack": "npm run build:electron && electron-builder --dir",
"dist": "npm run build:electron && electron-builder --win nsis"
```

- [ ] **Step 4: Add build artifacts to .gitignore**

Append to `.gitignore`:

```
dist-installer/
```

- [ ] **Step 5: Build the unpacked app and confirm the prebuild is unpacked**

Run: `npm run pack`
Expected: `dist-installer/win-unpacked/WinMux.exe` exists, AND `dist-installer/win-unpacked/resources/app.asar.unpacked/node_modules/node-pty/prebuilds/` contains the win32 prebuild (proves `asarUnpack` worked).

- [ ] **Step 6: Commit**

```bash
git add package.json build/icon.ico .gitignore
git commit -m "feat(installer): electron-builder NSIS config + per-user installer + asarUnpack node-pty prebuilds"
```

---

### Task 6: Zero-arg harness check — profile isolation

**Files:**
- Modify: `verify.cjs` (add a `profile` check that needs no server/browser)

**Interfaces:**
- Consumes: compiled `dist-electron/profile.js` `resolveProfile`.

- [ ] **Step 1: Add the check**

Add near the other `check(...)` registrations in `verify.cjs` (it uses no port/browser — pass a dummy port and ignore the fixtures):

```javascript
// Coexistence (Phase 12): the packaged .exe and the dev copy must resolve to
// disjoint identities, or they share Electron's userData (and its singleton
// lock), the CLI discovery file, and the trust file. This is the cheap unit
// guard; verify-coexist.cjs proves it end-to-end against a real build.
check('profile', PORT_ONBOARD, async ({ t }) => {
  const { resolveProfile } = require('./dist-electron/profile.js');
  const o = { appData: 'C:\\A', home: 'C:\\H' };
  const prod = resolveProfile({ ...o, isPackaged: true });
  const dev = resolveProfile({ ...o, isPackaged: false });
  t('packaged and dev appIds differ', prod.appId !== dev.appId, { prod: prod.appId, dev: dev.appId });
  t('packaged and dev userData dirs differ', prod.userData !== dev.userData, { prod: prod.userData, dev: dev.userData });
  t('userData dirs do not nest (no shared singleton lock)',
    !prod.userData.startsWith(dev.userData) && !dev.userData.startsWith(prod.userData));
  t('discovery files differ', prod.instanceFile !== dev.instanceFile, { prod: prod.instanceFile, dev: dev.instanceFile });
  t('trust files differ', prod.trustFile !== dev.trustFile);
  t('production identity is the stable public one', prod.appId === 'com.zbrooklyn.winmux' && prod.name === 'WinMux');
});
```

- [ ] **Step 2: Run the harness**

Run: `npm run verify`
Expected: PASS `profile` group; overall count rises to 231/231.

- [ ] **Step 3: Commit**

```bash
git add verify.cjs
git commit -m "test(installer): zero-arg profile-isolation guard in the harness"
```

---

### Task 7: Coexistence integration proof (the acceptance gate)

**Files:**
- Create: `verify-coexist.cjs`
- Modify: `package.json` (`verify:coexist` script)

**Interfaces:**
- Consumes: `npm run pack` output (`dist-installer/win-unpacked/WinMux.exe`) and the dev main (`dist-electron/main.js`).
- Produces: a pass/fail verdict + a written JSON proof at `verify-out/coexist.json`.

- [ ] **Step 1: Write the coexistence proof script**

```javascript
// verify-coexist.cjs — the Phase 12 acceptance gate. Runs the PACKAGED app and
// the DEV app in smoke mode together and proves they do not share state.
// Heavy (it builds), so it is a named script, not part of the zero-arg harness.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, 'verify-out');
fs.mkdirSync(OUT, { recursive: true });

function smoke(exe, args, label) {
  const outFile = path.join(OUT, 'coexist-' + label + '.json');
  try { fs.unlinkSync(outFile); } catch (e) {}
  const r = spawnSync(exe, args, {
    env: { ...process.env, WINMUX_SMOKE: '1', WINMUX_SMOKE_OUT: outFile },
    timeout: 90000, windowsHide: true,
  });
  const verdict = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
  return { verdict, code: r.status };
}

(async () => {
  // 1) Build the unpacked packaged app.
  console.log('building unpacked app (npm run pack)…');
  execFileSync('npm', ['run', 'pack'], { stdio: 'inherit', shell: true });
  const packedExe = path.join(__dirname, 'dist-installer', 'win-unpacked', 'WinMux.exe');
  if (!fs.existsSync(packedExe)) { console.error('FAIL: no packed exe at ' + packedExe); process.exit(1); }

  // 2) Smoke the packaged app, then the dev app. Each writes its identity.
  const packed = smoke(packedExe, [], 'packed');
  const devExe = path.join(__dirname, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const dev = smoke(devExe, [path.join(__dirname, 'dist-electron', 'main.js')], 'dev');

  const P = packed.verdict, D = dev.verdict;
  const fails = [];
  const req = (name, cond) => { if (!cond) fails.push(name); console.log((cond ? 'PASS  ' : 'FAIL  ') + name); };

  req('packaged app rendered its cockpit', !!(P && P.hasCockpit));
  req('dev app rendered its cockpit', !!(D && D.hasCockpit));
  req('packaged userData differs from dev userData', !!(P && D && P.userData && P.userData !== D.userData));
  req('userData dirs do not nest', !!(P && D && !P.userData.startsWith(D.userData) && !D.userData.startsWith(P.userData)));
  req('discovery files differ', !!(P && D && P.instanceFile !== D.instanceFile));
  req('both node-pty shells ran (ptyOk)', !!(P && P.ptyOk) && !!(D && D.ptyOk));

  fs.writeFileSync(path.join(OUT, 'coexist.json'), JSON.stringify({ packed: P, dev: D, fails }, null, 2));
  console.log(fails.length ? '\nCOEXIST FAILED: ' + fails.join(', ') : '\nCOEXIST OK — installed and dev are independent');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Extend the Electron smoke verdict to report identity**

In `electron/main.ts` `runSmoke`, add `userData` and `instanceFile` to the `result` object (from `profile`, already in scope at module level — pass them in). Add to the default `result` literal and set them before writing the JSON:

```typescript
  result.userData = profile.userData;
  result.instanceFile = profile.instanceFile;
```

Recompile: `npm run build:electron`.

- [ ] **Step 3: Add the script**

Add to `package.json` `"scripts"`: `"verify:coexist": "node verify-coexist.cjs"`.

- [ ] **Step 4: Run the acceptance gate**

Run: `npm run verify:coexist`
Expected: `COEXIST OK — installed and dev are independent`, and `verify-out/coexist.json` shows `packed.userData` = `…\WinMux`, `dev.userData` = `…\WinMuxDev`, distinct `instanceFile`s, both `hasCockpit` and `ptyOk` true.

- [ ] **Step 5: Build the real installer and confirm it produces an .exe**

Run: `npm run dist`
Expected: `dist-installer/WinMux Setup 0.1.0.exe` exists.

- [ ] **Step 6: Commit**

```bash
git add verify-coexist.cjs package.json electron/main.ts
git commit -m "test(installer): coexistence acceptance gate — packed + dev run independent (verify:coexist)"
```

---

### Task 8: PLAN.md Phase 12 extension + push

**Files:**
- Modify: `PLAN.md` (Phase 12 packaging spine)

- [ ] **Step 1: Extend Phase 12**

Under the Phase 12 heading in `PLAN.md`, add a "packaging half" subsection recording: the electron-builder NSIS installer, the per-copy identity model (`resolveProfile`, packaged vs dev disjoint userData/discovery/trust), coexistence as the acceptance test (`verify:coexist`), and that signing/auto-update/winget are structured-for but deferred. Note the presentation half (README/gallery/LICENSE) is done (M9).

- [ ] **Step 2: Final harness + push**

Run: `npm run verify` (expect 231/231) then push the branch:

```bash
git add PLAN.md
git commit -m "docs(plan): Phase 12 packaging spine + coexistence acceptance test"
git push origin feature/phase8-electron-shell
```

- [ ] **Step 3: Report coexistence proof to Edward**

Ship `verify-out/coexist.json` (or a screenshot of both windows/verdicts) so the independence is visible, not just asserted.

---

## Self-Review

**1. Spec coverage:**
- Distinct Electron identity + private userData (packaged vs dev) → Tasks 1, 2, 6, 7. ✅
- ProcessSingleton lock avoided (non-nesting userData) → asserted in Tasks 1 & 6. ✅
- Namespaced CLI discovery file → Tasks 3, 4, 7. ✅
- Tailscale phone-port note → recorded in PLAN.md Task 8 (minor, both default off). ✅
- Keep isolated: web-port fallback, `__dirname` trust file, `winmux.ps1` state → unchanged by design; trust file additionally namespaced via env. ✅
- `node server.cjs` standalone unchanged → Task 3 keeps the default path; verified in Task 3 Step 2. ✅
- cockpit.css frozen → no task touches it. ✅
- asarUnpack node-pty prebuilds → Task 5 config + Step 5 assertion. ✅
- Committed coexistence verification asset → Task 7 (`verify-coexist.cjs`) + Task 6 (zero-arg guard). ✅
- Defer signing/auto-update/winget → Global Constraints + PLAN.md; no task builds them. ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"; every code step shows real code. The only soft item is `build/icon.ico` (a placeholder icon is explicitly allowed this phase; a final mark is later polish). ✅

**3. Type consistency:** `resolveProfile` returns `{ appId, name, userData, instanceFile, trustFile }` — the exact keys read in Tasks 2, 6, 7. `WINMUX_INSTANCE_FILE` is the single env name across server (Task 3), CLI (Task 4), and main (Task 2). ✅
