import { contextBridge, ipcRenderer } from 'electron';

// The cockpit's .wc window-control buttons (public/app.js:1774-1780) call
// window.winmux.minimize/maximize/close when this bridge is present, and fall
// back to fullscreen/window.close() in a plain browser. Under Electron we give
// them the real thing.
contextBridge.exposeInMainWorld('winmux', {
  isElectron: true,
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  // Open the release/download page in the user's real browser (the update badge).
  openExternal: (url: string) => ipcRenderer.send('win:open-external', url),
  // Native open-file dialog (the "Markdown" new-tab item). Resolves to a path or null.
  pickFile: (opts?: { filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('win:pick-file', opts),
  // Quake drop (Phase 7): tell main to register/release the global hotkey. Off until
  // the Settings toggle calls this, so nothing grabs a system key by default.
  setQuake: (opts: { enabled: boolean; hotkey: string }) => ipcRenderer.send('win:quake', opts),
});

// Tag the document so index.html CSS can enable Electron-only drag regions
// (Task 5). Preload shares the page DOM even with contextIsolation on.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.setAttribute('data-electron', '');
});
