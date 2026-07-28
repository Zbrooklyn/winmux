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
});

// Tag the document so index.html CSS can enable Electron-only drag regions
// (Task 5). Preload shares the page DOM even with contextIsolation on.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.setAttribute('data-electron', '');
});
