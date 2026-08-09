# Sample a process TREE rooted at -RootPid: total CPU seconds + working-set bytes,
# for the root process alone and for the whole descendant tree. Emits one compact
# JSON line. Used by endurance.cjs to compare the Rust core vs the Node server.
param([int]$RootPid)

$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
$kids = @{}
foreach ($p in $all) {
  $ppid = [int]$p.ParentProcessId
  if (-not $kids.ContainsKey($ppid)) { $kids[$ppid] = New-Object System.Collections.ArrayList }
  [void]$kids[$ppid].Add([int]$p.ProcessId)
}

$seen  = New-Object System.Collections.Generic.HashSet[int]
$queue = New-Object System.Collections.Generic.Queue[int]
[void]$queue.Enqueue($RootPid); [void]$seen.Add($RootPid)
while ($queue.Count) {
  $c = $queue.Dequeue()
  if ($kids.ContainsKey($c)) { foreach ($k in $kids[$c]) { if ($seen.Add($k)) { [void]$queue.Enqueue($k) } } }
}

$procs = Get-Process -Id ([int[]]$seen) -ErrorAction SilentlyContinue
$core  = Get-Process -Id $RootPid -ErrorAction SilentlyContinue

[pscustomobject]@{
  cpuCore = if ($core) { [math]::Round([double]$core.CPU, 3) } else { $null }
  rssCore = if ($core) { [int64]$core.WorkingSet64 } else { $null }
  cpuTree = [math]::Round([double](($procs | Measure-Object CPU -Sum).Sum), 3)
  rssTree = [int64](($procs | Measure-Object WorkingSet64 -Sum).Sum)
  n       = ($procs | Measure-Object).Count
} | ConvertTo-Json -Compress
