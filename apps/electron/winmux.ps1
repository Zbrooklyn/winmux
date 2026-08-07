# WinMux launcher — starts the server detached, so it outlives this terminal.
#
#   .\winmux.ps1 start | stop | status | link
#
# Every WinMux before this one died with the shell that started it, which is why
# a phone link never survived long enough to be useful. Start-Process with a
# hidden window reparents node away from this console, so closing the window
# (or ending an agent turn) leaves the server running.
param([Parameter(Position = 0)][ValidateSet('start', 'stop', 'status', 'link')][string]$Command = 'status')

$ErrorActionPreference = 'Stop'
$Root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateFile = Join-Path $Root '.winmux-state.json'
$LogFile   = Join-Path $Root 'winmux.log'
$ErrFile   = Join-Path $Root 'winmux.err.log'

# The state file is a claim, not proof. Confirm the process is really alive
# before believing it, and clean up the file when it is not.
function Get-State {
  if (-not (Test-Path $StateFile)) { return $null }
  try { $s = Get-Content $StateFile -Raw | ConvertFrom-Json } catch { return $null }
  $proc = Get-Process -Id $s.pid -ErrorAction SilentlyContinue
  if (-not $proc) { Remove-Item $StateFile -Force -ErrorAction SilentlyContinue; return $null }
  return $s
}

function Start-WinMux {
  $existing = Get-State
  if ($existing) {
    Write-Host "WinMux is already running (pid $($existing.pid)) at http://127.0.0.1:$($existing.port)"
    return
  }
  Remove-Item $LogFile, $ErrFile -Force -ErrorAction SilentlyContinue
  # CT_REMOTE=1 pre-opens the same door the Settings toggle opens; the child
  # inherits this process's environment.
  $env:CT_REMOTE = '1'
  # A moving address is the same as no address: a link saved yesterday points at
  # nothing today, which reads as "the app is broken" rather than "the port
  # changed". So the launcher pins one number and keeps it. 8799 can never be it
  # on this machine — tailscaled owns that port on the Tailscale side — so the
  # pin is 9912, the first candidate the server itself would have picked anyway.
  $env:PORT = '9912'
  $proc = Start-Process -FilePath 'node' -ArgumentList 'server.cjs' `
    -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile

  # The server chooses its own port, so read it back rather than assuming.
  $port = $null
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline -and -not $port) {
    Start-Sleep -Milliseconds 300
    if (Test-Path $LogFile) {
      $m = Select-String -Path $LogFile -Pattern 'running at http://127\.0\.0\.1:(\d+)' -ErrorAction SilentlyContinue
      if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
    }
  }
  if (-not $port) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    Write-Error "WinMux did not start. See $LogFile and $ErrFile."
    return
  }
  @{ pid = $proc.Id; port = $port; started = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content $StateFile -Encoding UTF8

  Write-Host "WinMux running   pid $($proc.Id)   http://127.0.0.1:$port"
  Write-Host "It stays up after you close this window. Stop it with: .\winmux.ps1 stop"
  Write-Host ''
  Write-Host "For your phone: open http://127.0.0.1:$port  ->  Settings -> Phone  ->  scan the QR."
}

function Stop-WinMux {
  $s = Get-State
  if (-not $s) { Write-Host 'WinMux is not running.'; return }
  Stop-Process -Id $s.pid -Force
  Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
  Write-Host "WinMux stopped (pid $($s.pid)). The phone link is dead."
}

function Get-Status {
  $s = Get-State
  if (-not $s) { Write-Host 'WinMux is not running.'; return }
  Write-Host "WinMux running   pid $($s.pid)   http://127.0.0.1:$($s.port)   since $($s.started)"
  try {
    $p = Invoke-RestMethod -Uri "http://127.0.0.1:$($s.port)/api/phone" -TimeoutSec 5
    if ($p.on) { Write-Host "phone access: ON  (bound to $($p.ip):$($p.port))" }
    else { Write-Host 'phone access: off — turn it on in Settings -> Phone' }
  } catch { Write-Host 'phone access: unknown (the desk door did not answer)' }
}

function Show-Link {
  $s = Get-State
  if (-not $s) { Write-Host 'WinMux is not running. Start it with: .\winmux.ps1 start'; return }
  $p = Invoke-RestMethod -Uri "http://127.0.0.1:$($s.port)/api/phone" -TimeoutSec 5
  if (-not $p.on) { Write-Host 'Phone access is off. Turn it on in Settings -> Phone.'; return }
  Write-Host ''
  Write-Host 'THIS LINK IS A SHELL ON THIS PC. Do not paste it into chat, email, or a screenshot.'
  Write-Host ''
  Write-Host $p.url
  Write-Host ''
  Write-Host "Easier: open http://127.0.0.1:$($s.port) -> Settings -> Phone and scan the QR code."
}

switch ($Command) {
  'start'  { Start-WinMux }
  'stop'   { Stop-WinMux }
  'status' { Get-Status }
  'link'   { Show-Link }
}
