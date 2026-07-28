import { app, BrowserWindow } from 'electron';

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 600 });
  win.loadURL('data:text/html,<h1>WinMux Electron toolchain OK</h1>');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
