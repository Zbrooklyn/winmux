@echo off
setlocal
rem The `winmux` command, as it exists inside a terminal WinMux started.
rem
rem An installed WinMux has no Node on it and never had one — the CLI was a .cjs
rem file sealed inside app.asar, so `winmux ...` was not merely absent from PATH,
rem it could not be run by full path either. The agents guide taught it anyway.
rem
rem It needs nothing installed. The app's own binary IS a Node runtime when asked
rem (ELECTRON_RUN_AS_NODE), and the CLI itself imports only Node builtins, so the
rem shipped executable can run it as-is.
rem
rem WINMUX_EXE is set by the engine on every shell it spawns, which also makes
rem this correct from a source checkout, where that binary is plain node.exe. The
rem fallback is for someone who found this file and ran it by hand: bin sits at
rem resources\app.asar.unpacked\bin, so the app is three levels up.
if defined WINMUX_EXE goto :run
set "WINMUX_EXE=%~dp0..\..\..\WinMux.exe"
if not exist "%WINMUX_EXE%" (
  echo winmux: cannot find the WinMux executable. Run this from a WinMux terminal, 1>&2
  echo         or set WINMUX_EXE to the full path of WinMux.exe. 1>&2
  exit /b 1
)
:run
set ELECTRON_RUN_AS_NODE=1
"%WINMUX_EXE%" "%~dp0winmux.cjs" %*
