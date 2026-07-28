import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// server.cjs is CommonJS at the repo root (one level up from dist-electron/).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { start } = require('../server.cjs') as {
  start: () => Promise<{ port: number; host: string }>;
};

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
  if (SMOKE) { await runSmoke(win); return; }
  win.show();
  win.on('closed', () => { win = null; });
}

// Drive the real shell to a verdict without a human: wait for the cockpit to
// render, then read back the three things that prove the shell works — the
// cockpit is present, the preload bridge is injected, and the frameless tab bar
// resolves to a real drag region. Screenshot for Edward's eye; JSON for the tally.
async function runSmoke(w: BrowserWindow): Promise<void> {
  const outDir = path.join(__dirname, '..', 'verify-out');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* ignore */ }
  let result: Record<string, unknown> = {
    hasCockpit: false, isElectron: false, dataElectron: false, ptabsRegion: null, error: null,
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
        error: null,
      };
    })()`);
    const png = await w.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'electron-shell.png'), png.toPNG());
  } catch (e) {
    result.error = String((e as Error).message || e);
  }
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
