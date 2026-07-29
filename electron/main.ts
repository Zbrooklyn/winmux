import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { resolveProfile } from './profile';

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
const profile = resolveProfile({
  isPackaged: app.isPackaged,
  appData: app.getPath('appData'),
  home: os.homedir(),
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

    // The Electron-only feature: a controllable <webview> browser panel, driven
    // through the real /rpc → /control chain (the CLI's path). The app has been
    // connected to /control since load; give it a beat, then open a data: page
    // whose interactive nodes we can count and click.
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const page = 'data:text/html,' + encodeURIComponent('<button>Go</button><a href="#x">Docs</a>');
      const opened = await rpc(port, 'browser', { sub: 'open', url: page });
      result.browserOpened = !!(opened && opened.ok);
      // The webview navigates on dom-ready; poll the snapshot until it has refs.
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
    } catch (be) {
      result.browserError = String((be as Error).message || be);
    }

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
