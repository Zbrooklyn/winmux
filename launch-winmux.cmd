@echo off
rem WinMux desktop launcher. Double-click this (or the desktop shortcut that
rem points at it) to open the real Electron app. No install required.
rem If you have changed the TypeScript source, run `npm run build:electron` first.
cd /d "%~dp0"
if not exist "dist-electron\main.js" (
  echo Building the Electron bundle for the first time...
  call npm run build:electron
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "dist-electron\main.js"
