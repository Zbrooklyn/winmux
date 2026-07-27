' WinMux autostart — runs at logon, with no console window.
'
' WinMux used to exist only while somebody remembered to start it, so the
' honest state of the app for most of any given day was "not running", which
' from the outside is indistinguishable from "broken". A copy of this file in
' the Startup folder makes the app simply present, the way an app should be.
'
' The pause is not padding: Tailscale is still coming up during logon, and
' WinMux binds its phone door to the Tailscale address. Starting too early
' means the desk door works and the phone door silently doesn't.
'
' Remove it by deleting this file from the Startup folder — nothing else to undo.

Dim shell, here
Set shell = CreateObject("WScript.Shell")
here = "C:\Users\EDWAR\Dropbox\AI_Projects_Claude\projects\winmux"

WScript.Sleep 25000

shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & here & "\winmux.ps1"" start", 0, False
