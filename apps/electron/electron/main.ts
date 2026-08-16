import { app, BrowserWindow, ipcMain, shell, dialog, globalShortcut, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { resolveProfile, parseCoreFlag } from './profile';
import { resolveServer } from './server-host';

// server.cjs is CommonJS at the repo root (one level up from dist-electron/).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../server.cjs') as {
  start: () => Promise<{ port: number; host: string }>;
};

// Establish this copy's identity BEFORE anything reads userData or starts the
// server. app.isPackaged is true only inside the built .exe, so the installed
// app and the from-source dev copy resolve to disjoint identities automatically
// — separate %APPDATA% dirs (and separate ProcessSingleton locks), separate CLI
// discovery files, separate trusted-device files. This is what lets both run at
// once without stepping on each other (Phase 12 coexistence contract).
// core-rust.flag next to main.js selects the Rust ENGINE (since v0.2.0 the
// primary installer ships it too). The distinct "WinMux Rust" IDENTITY is a
// separate bit in the flag's content ('rust identity', written only by
// dist-rust.cjs) — the primary Rust-core build keeps the primary identity so
// existing installs upgrade in place and the CLI finds it at instance.json.
let flagContent: string | null = null;
try { flagContent = fs.readFileSync(path.join(__dirname, 'core-rust.flag'), 'utf8'); } catch { /* no flag = Node engine */ }
const coreFlag = parseCoreFlag(flagContent);
const isRustBuild = coreFlag.rustCore;
// identity-node.flag (written only by scripts/dist-node-app.cjs, never together
// with core-rust.flag) selects the side-by-side "WinMux Node" identity: the
// legacy Node engine as a FOURTH coexisting app instead of a primary fallback.
const isNodeApp = !isRustBuild && fs.existsSync(path.join(__dirname, 'identity-node.flag'));
const profile = resolveProfile({
  isPackaged: app.isPackaged,
  appData: app.getPath('appData'),
  home: os.homedir(),
  rust: coreFlag.rustIdentity,
  nodeApp: isNodeApp,
});
app.setAppUserModelId(profile.appId);
app.setName(profile.name);
app.setPath('userData', profile.userData);
// Hand the in-process server its own discovery + trust files (mirrors the
// server's existing WINMUX_TRUST_FILE / WINMUX_INSTANCE_FILE env contract).
process.env.WINMUX_INSTANCE_FILE = profile.instanceFile;
process.env.WINMUX_TRUST_FILE = process.env.WINMUX_TRUST_FILE || profile.trustFile;

// The harness (verify.cjs) runs this same main in WINMUX_SMOKE mode: no visible
// window, self-check the rendered cockpit, write a JSON verdict + a screenshot,
// then quit. Production launches (unset) are completely unaffected.
const SMOKE = !!process.env.WINMUX_SMOKE;

let win: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  // The SMOKE harness keeps the in-process server so the electron check is
  // unaffected. A real launch RESOLVES a detached server (reattach to a live one
  // for this profile, else spawn one) so closing the window never kills the shells.
  let port: number;
  if (SMOKE) {
    ({ port } = await start());
  } else {
    // WINMUX_CORE=rust boots the native Rust core as the sidecar instead of the
    // Node server. Discovery is identical (it writes the same instance.json and
    // answers /api/info), so the renderer connects the same way. Node stays default.
    // isRustBuild (module scope) is set from core-rust.flag; the env var still
    // forces Rust in dev. Node stays the shipped default when neither is set.
    const useRust = process.env.WINMUX_CORE === 'rust' || isRustBuild;
    let rustCorePath: string | undefined;
    let extraEnv: Record<string, string> | undefined;
    if (useRust) {
      const root = path.join(__dirname, '..', '..', '..');   // apps/electron/dist-electron → repo root
      const candidates = [
        process.env.WINMUX_CORE_BIN,
        // Packaged: bundled beside the app via extraResources.
        app.isPackaged ? path.join(process.resourcesPath, 'winmux-core.exe') : undefined,
        path.join(root, 'core', 'rust', 'target', 'release', 'winmux-core.exe'),
        path.join(root, 'core', 'rust', 'target', 'debug', 'winmux-core.exe'),
      ].filter(Boolean) as string[];
      rustCorePath = candidates.find((p) => fs.existsSync(p));
      if (!rustCorePath) throw new Error('WINMUX_CORE=rust but no winmux-core.exe found (build core/rust first)');
      // The Rust core is a separate process serving static files off disk, so in
      // a packaged app public/ must be unpacked (asarUnpack), not inside the asar.
      extraEnv = {
        WINMUX_PUBLIC: app.isPackaged
          ? path.join(process.resourcesPath, 'app.asar.unpacked', 'public')
          : path.join(__dirname, '..', 'public'),
      };
    }
    const resolved = await resolveServer({
      instanceFile: profile.instanceFile,
      trustFile: process.env.WINMUX_TRUST_FILE || profile.trustFile,
      execPath: process.execPath,
      serverPath: path.join(__dirname, '..', 'server.cjs'),
      rustCorePath,
      extraEnv,
    });
    port = resolved.port;
  }
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
      webviewTag: true,          // the browser panel (Phase 10) is a <webview>
    },
  });
  await win.loadURL('http://127.0.0.1:' + port + '/');
  if (SMOKE) { await runSmoke(win, port); return; }
  win.show();
  win.on('closed', () => { win = null; });
}

// POST a control command through the real desk door (/rpc → /control → the
// running app). This is the exact path the `winmux` CLI takes, so proving the
// browser panel this way proves the CLI-driven feature, not a shortcut.
function rpc(port: number, cmd: string, args: Record<string, unknown>): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('http');
  const body = JSON.stringify({ cmd, args });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/rpc', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res: any) => {
      let b = ''; res.on('data', (d: any) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad rpc reply: ' + b.slice(0, 120))); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Drive the real shell to a verdict without a human: wait for the cockpit to
// render, then read back the three things that prove the shell works — the
// cockpit is present, the preload bridge is injected, and the frameless tab bar
// resolves to a real drag region. Screenshot for Edward's eye; JSON for the tally.
async function runSmoke(w: BrowserWindow, port: number): Promise<void> {
  const outDir = path.join(__dirname, '..', 'verify-out');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* ignore */ }
  let result: Record<string, unknown> = {
    hasCockpit: false, isElectron: false, dataElectron: false, ptabsRegion: null,
    browserOpened: false, browserRefs: 0, browserClicked: false, ptyOk: false, error: null,
    browserTyped: false, browserGotText: false, browserEval: false, browserScrolled: false,
    menuTypes: [], diffIsTab: false, diffRendered: false,
    quakeRegistered: false, quakeDrops: false,
  };
  try {
    for (let i = 0; i < 40; i++) {
      const ready = await w.webContents.executeJavaScript("!!document.querySelector('.ptabs')");
      if (ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    result = await w.webContents.executeJavaScript(`(() => {
      const ptabs = document.querySelector('.ptabs');
      const cs = ptabs ? getComputedStyle(ptabs) : null;
      return {
        hasCockpit: !!ptabs,
        isElectron: !!(window.winmux && window.winmux.isElectron),
        dataElectron: document.documentElement.hasAttribute('data-electron'),
        ptabsRegion: cs ? (cs.getPropertyValue('-webkit-app-region') || cs.webkitAppRegion || '') : null,
        browserOpened: false, browserRefs: 0, browserClicked: false,
        error: null,
      };
    })()`);

    // node-pty under Electron's ABI (readiness #16 — the native-module trap, the
    // #1 way an Electron terminal fails to even start on someone else's machine).
    // node-pty 1.x ships N-API prebuilds (prebuilds/win32-x64/…) that are ABI-
    // stable across Node AND Electron, so no electron-rebuild is needed — but that
    // only holds if the binary actually loads and spawns here. Prove it end-to-end:
    // run a command through the real terminal (a live node-pty shell) over the same
    // /control chain the CLI uses, and read the marker back off the screen.
    try {
      const token = 'WINMUX_PTY_' + 'OK';
      await rpc(port, 'send', { data: 'echo ' + token, enter: true });
      let screen = '';
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const rs = await rpc(port, 'read-screen', { lines: 60 });
        screen = String((rs && rs.result && rs.result.screen) || '');
        // The echoed command line itself contains the token; a match on a line
        // that is not the command proves the shell ran it and printed the result.
        const hits = (screen.match(new RegExp(token, 'g')) || []).length;
        if (hits >= 2) break;
      }
      result.ptyOk = (screen.match(new RegExp(token, 'g')) || []).length >= 2;
    } catch (pe) {
      result.ptyError = String((pe as Error).message || pe);
    }

    const png = await w.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'electron-shell.png'), png.toPNG());

    // Surfaces-as-tabs (Phase 1): the "+" button opens a type menu. Open it, record
    // its item labels (Browser only shows under Electron, which this run is), and
    // photograph it for Edward's eye — the one new pixel this unit adds.
    try {
      // Dismiss the first-run onboarding overlay so it can't cover the menu. The
      // browser test runs AFTER this section, so no <webview> leaf exists yet to
      // composite over the capture — the layout here is the clean startup.
      await w.webContents.executeJavaScript(`(() => {
        const s = document.getElementById('wc-start'); if (s) s.click();
      })()`);
      await new Promise((r) => setTimeout(r, 350));
      // A hidden window (show:false) coalesces paints, so the menu — a pure DOM
      // insertion with no other paint trigger — never reaches the capture buffer.
      // Show it inactive for the shots so the overlay actually renders, then hide.
      w.showInactive();
      // Capture the three elevation treatments Edward is choosing between: flat
      // (default, no shadow), soft (a whisper of shadow), edge (no shadow, crisp
      // border on a lifted surface). Same clean layout; only the elevation differs.
      const openMenu = `(() => {
        document.body.click();
        const btn = document.querySelector('.pc-new'); if (!btn) return [];
        btn.click();
        return [].slice.call(document.querySelectorAll('.tmenu .tmi .lab'))
          .map((n) => (n.textContent || '').trim());
      })()`;
      // Elevation set (flat = shipped default) + three structural directions
      // (minimal / grid / compact) via data-tmenu-style. One capture each.
      const variants = [
        ['elev', '', 'newtab-flat.png'], ['elev', 'soft', 'newtab-soft.png'], ['elev', 'edge', 'newtab-edge.png'],
        ['style', 'minimal', 'newtab-minimal.png'], ['style', 'grid', 'newtab-grid.png'], ['style', 'compact', 'newtab-compact.png'],
      ];
      for (const [axis, val, file] of variants) {
        await w.webContents.executeJavaScript(
          "document.documentElement.removeAttribute('data-tmenu-elev');" +
          "document.documentElement.removeAttribute('data-tmenu-style');" +
          (val ? `document.documentElement.setAttribute('data-tmenu-${axis}','${val}');` : ''));
        const labels = await w.webContents.executeJavaScript(openMenu);
        if (!val) result.menuTypes = labels;
        await new Promise((r) => setTimeout(r, 250));
        fs.writeFileSync(path.join(outDir, file), (await w.webContents.capturePage()).toPNG());
      }
      // Reset to the shipped default (flat) and re-hide so the run stays headless.
      await w.webContents.executeJavaScript("document.documentElement.removeAttribute('data-tmenu-elev'); document.documentElement.removeAttribute('data-tmenu-style'); document.body.click();");
      w.hide();
    } catch (me) {
      result.menuError = String((me as Error).message || me);
    }

    // The Electron-only browser surface, driven through the real /rpc → /control
    // chain (the CLI's path). Runs LAST: opening a browser leaf focuses it, so
    // doing this after the terminal + menu tests keeps those on the clean startup
    // layout. Proves the webview navigates AND that it lives in a pane tab (leaf),
    // not the retired side dock.
    try {
      await new Promise((r) => setTimeout(r, 500));
      const page = 'data:text/html,' + encodeURIComponent(
        '<input id=x><button>Go</button><a href="#x">Docs</a><p>SMOKE_MARKER</p><div style="height:3000px"></div>');
      const opened = await rpc(port, 'browser', { sub: 'open', url: page });
      result.browserOpened = !!(opened && opened.ok);
      let snap: any = null;
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500));
        snap = await rpc(port, 'browser', { sub: 'snapshot' });
        if (snap && snap.ok && snap.result && /@e1/.test(String(snap.result.tree || ''))) break;
      }
      const tree = String((snap && snap.result && snap.result.tree) || '');
      result.browserRefs = (tree.match(/@e\d+/g) || []).length;
      const clicked = await rpc(port, 'browser', { sub: 'click', ref: '@e1' });
      result.browserClicked = !!(clicked && clicked.ok);
      await rpc(port, 'browser', { sub: 'fill', ref: '@e1', value: 'ab' });
      await rpc(port, 'browser', { sub: 'type', ref: '@e1', text: 'cd' });
      const val = await rpc(port, 'browser', { sub: 'eval', js: "document.querySelector('input').value" });
      result.browserTyped = !!(val && val.ok && val.result && val.result.result === 'abcd');
      const gt = await rpc(port, 'browser', { sub: 'get-text' });
      result.browserGotText = !!(gt && gt.ok && gt.result && /SMOKE_MARKER/.test(String(gt.result.text || '')));
      const ev = await rpc(port, 'browser', { sub: 'eval', js: '6*7' });
      result.browserEval = !!(ev && ev.ok && ev.result && ev.result.result === 42);
      const sc = await rpc(port, 'browser', { sub: 'scroll', amount: 'bottom' });
      result.browserScrolled = !!(sc && sc.ok && sc.result && sc.result.scrollY > 0);
      // ST3: the browser is a pane TAB, not a side dock — a .ptab carrying the
      // browser favicon (data-leaf="browser") inside a pane, and .wmb is gone.
      result.browserIsTab = await w.webContents.executeJavaScript(
        "!!document.querySelector('.pane .ptab[data-leaf=\"browser\"]') && !document.querySelector('.wmb')");
      // A photograph of the browser as a live tab, for Edward's eye (the new pixel).
      // Remove any lingering menu (it closes on mousedown, which a synthetic click
      // doesn't emit) + reset the style attrs so the shot is clean browser chrome.
      await w.webContents.executeJavaScript("[].forEach.call(document.querySelectorAll('.tmenu, .ofmenu, .ctxmenu'), function(m){ m.remove(); }); document.documentElement.removeAttribute('data-tmenu-elev'); document.documentElement.removeAttribute('data-tmenu-style');");
      w.showInactive();
      await new Promise((r) => setTimeout(r, 500));
      fs.writeFileSync(path.join(outDir, 'browser-tab.png'), (await w.webContents.capturePage()).toPNG());
      w.hide();
    } catch (be) {
      result.browserError = String((be as Error).message || be);
    }

    // ST5/ST6 in the packaged app: the git-diff surface opens as a pane tab too,
    // via the same New-tab menu, and renders real git status inside Electron (not
    // just in the plain-browser harness). Proves diff-in-the-real-app, not code-only.
    try {
      // The pane-header changes button (.pc-dock) calls openDiffLeaf() directly —
      // deterministic, no menu to drive.
      await w.webContents.executeJavaScript("var b=document.querySelector('.pc-dock'); if(b) b.click();");
      await new Promise((r) => setTimeout(r, 2000));   // /api/git round trip + render
      result.diffIsTab = await w.webContents.executeJavaScript(
        "!!document.querySelector('.pane .ptab[data-leaf=\"diff\"]')");
      result.diffRendered = await w.webContents.executeJavaScript(
        "(function(){var b=document.querySelector('.term-host.diffleaf'); return !!(b && (b.querySelector('.diff') || b.querySelector('.diff-empty')));})()");
      await w.webContents.executeJavaScript("[].forEach.call(document.querySelectorAll('.tmenu, .ofmenu, .ctxmenu'), function(m){ m.remove(); }); document.documentElement.removeAttribute('data-tmenu-elev'); document.documentElement.removeAttribute('data-tmenu-style');");
      w.showInactive();
      await new Promise((r) => setTimeout(r, 500));
      fs.writeFileSync(path.join(outDir, 'diff-tab-electron.png'), (await w.webContents.capturePage()).toPNG());
      w.hide();
    } catch (de) {
      result.diffError = String((de as Error).message || de);
    }
    // Phase 7 quake drop: prove the OS accepts the binding and the toggle reveals a
    // hidden window. A real keypress needs a human at a real display, but registering
    // the accelerator and driving dropQuake() proves everything main.js owns.
    try {
      w.hide();
      const reg = applyQuake(true, 'Control+`');
      result.quakeRegistered = reg && globalShortcut.isRegistered('Control+`');
      const before = w.isVisible();     // false — just hid it
      dropQuake();
      result.quakeDrops = !before && w.isVisible();   // hidden -> revealed
      result.quakeMs = lastQuakeMs;     // SP-2: summon must be <=100ms, measured
      applyQuake(false, '');            // release the key; the run stays headless
      w.hide();
    } catch (qe) {
      result.quakeError = String((qe as Error).message || qe);
    }

    // (ST6 persists the browser + diff leaf this smoke opens; the harness wipes the
    // dev profile's Local Storage before each run so the startup layout stays clean.)
  } catch (e) {
    result.error = String((e as Error).message || e);
  }
  // Stamp this copy's identity so the coexistence gate can prove the packaged
  // app and the dev copy resolved to disjoint userData + discovery files.
  result.userData = profile.userData;
  result.instanceFile = profile.instanceFile;
  const outFile = process.env.WINMUX_SMOKE_OUT || path.join(outDir, 'electron-smoke.json');
  try { fs.writeFileSync(outFile, JSON.stringify(result, null, 2)); } catch (e) { /* ignore */ }
  app.quit();
}

// Phase 7 — quake drop. A global hotkey slides WinMux over whatever app you're in;
// press it again to hide, sessions untouched. OFF until the renderer asks for it
// (Settings → Behaviour), so nothing grabs a system-wide key by default. The
// renderer owns on/off + which key; main owns the OS binding and the show/hide.
let quakeKey: string | null = null;
// The speed arc's SP-2 contract: hotkey -> visible+focused in <=100ms. The part
// main owns (this function) is timed on every summon and logged, so the number
// is always one `[quake]` log line away instead of an argument.
let lastQuakeMs = -1;
function dropQuake(): void {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) { win.hide(); return; }
  const t0 = Date.now();
  // Land at the top-centre of whichever monitor the cursor is on — the classic
  // drop-down-terminal spot — then reveal and focus so you can type immediately.
  try {
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = disp.workArea;
    const b = win.getBounds();
    win.setBounds({ x: wa.x + Math.round((wa.width - b.width) / 2), y: wa.y, width: b.width, height: Math.min(b.height, wa.height) });
  } catch (e) { /* keep the window where it is if the display query fails */ }
  win.show();
  win.focus();
  lastQuakeMs = Date.now() - t0;
  console.log('[quake] summon ' + lastQuakeMs + 'ms');
}
function applyQuake(enabled: boolean, hotkey: string): boolean {
  if (quakeKey) { try { globalShortcut.unregister(quakeKey); } catch (e) { /* already gone */ } quakeKey = null; }
  if (!enabled || !hotkey) return true;
  try { const ok = globalShortcut.register(hotkey, dropQuake); if (ok) quakeKey = hotkey; return ok; }
  catch (e) { return false; }
}
ipcMain.on('win:quake', (_e, opts: { enabled?: boolean; hotkey?: string }) => {
  applyQuake(!!(opts && opts.enabled), (opts && String(opts.hotkey || '')) || '');
});

ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', () => win?.close());
// Open a URL (the update / release page) in the user's real browser, never a new
// Electron window. Guarded to http(s) so the bridge can't be turned into a way to
// launch arbitrary local programs.
ipcMain.on('win:open-external', (_e, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});
// Native open-file dialog for the "Markdown" new-tab item — the OS picker, so no
// custom in-app UI. Returns the chosen absolute path, or null if cancelled.
ipcMain.handle('win:pick-file', async (_e, opts?: { filters?: { name: string; extensions: string[] }[] }) => {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: opts?.filters || [{ name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Never leave a system-wide key grabbed after WinMux is gone.
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) { /* nothing to release */ } });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
