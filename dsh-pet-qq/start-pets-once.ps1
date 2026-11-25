<#
start-pets-once.ps1 -- ONE-SHOT start of the desk-pet / QQ chain. NO daemon.

Order (each step is idempotent: already-up ports/processes are skipped):
  1. SnowLuma   (5099 WebUI, hosts 3001 Coo / 3011 fish) -- must precede QQ injection
  2. both pet hosts (DeepSeek Harness = /chat host, Coopanion = 17788 + QQ world)
  3. both QQ clients via start-qq-clients.ps1 (waits for 5099, skips live ports)
  4. dsh-pet-qq bridge (7341, needs 3011 + a live pet /chat endpoint)

This script starts things and EXITS. It deliberately does NOT start
watchdog.ps1 or tunnel-guard.py / start-tunnel.py -- those are the
auto-reconnect daemons. If a link dies later it stays down until you click
the desktop button again. That is the whole point.

Log: logs\start-once.log
#>
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'start-once.log'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Log([string]$m) {
  try { [IO.File]::AppendAllText($logFile, "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m`n", $utf8) } catch { }
}

function Test-Port([int]$p) {
  $c = New-Object Net.Sockets.TcpClient
  try {
    $a = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    if (-not $a.AsyncWaitHandle.WaitOne(700, $false)) { return $false }
    $c.EndConnect($a); return $true
  } catch { return $false } finally { $c.Close() }
}

function Wait-Port([int]$p, [int]$sec) {
  $d = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $d) { if (Test-Port $p) { return $true }; Start-Sleep -Seconds 2 }
  return (Test-Port $p)
}

Log '--- one-shot start requested ---'

# 1) SnowLuma (hidden). Hosts 5099 / 3001 / 3011.
if (Test-Port 5099) { Log '[1/4] SnowLuma 5099 already up' }
else {
  $node = 'C:\Users\86189\SnowLuma\runtime\node-v24.22.1-win-x64\node.exe'
  $app  = 'C:\Users\86189\SnowLuma\app'
  if (-not (Test-Path $node)) { Log "[1/4] ERROR missing $node" }
  else {
    Start-Process -FilePath $node -ArgumentList './index.mjs' -WorkingDirectory $app -WindowStyle Hidden
    Log '[1/4] SnowLuma launched hidden'
    if (Wait-Port 5099 45) { Log '[1/4] 5099 online' } else { Log '[1/4] WARN 5099 still down' }
  }
}

# 2) Both pet hosts (visible -- the pets are the point).
$pets = @(
  @{ Name='DeepSeek Harness'; Proc='DeepSeek Harness'; Exe='D:\deepseek harness\DeepSeek Harness.exe'; Work='D:\deepseek harness' },
  @{ Name='Coopanion';        Proc='Coopanion';        Exe='D:\coopanion\Coopanion.exe';             Work='D:\coopanion' }
)
foreach ($p in $pets) {
  if (@(Get-Process -Name $p.Proc -ErrorAction SilentlyContinue).Count -gt 0) { Log "[2/4] $($p.Name) already running" }
  elseif (-not (Test-Path $p.Exe)) { Log "[2/4] ERROR missing $($p.Exe)" }
  else {
    Start-Process -FilePath $p.Exe -WorkingDirectory $p.Work
    Log "[2/4] $($p.Name) started"
    Start-Sleep -Seconds 3
  }
}

# 3) Both QQ clients. Helper waits for 5099 and skips ports already up.
$qq = Join-Path $root 'start-qq-clients.ps1'
if (Test-Path $qq) {
  Log '[3/4] QQ clients: running start-qq-clients.ps1 (idempotent)'
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"`"$qq`"" `
    -WorkingDirectory $root -WindowStyle Hidden -Wait
  Log '[3/4] QQ client step finished'
} else { Log "[3/4] ERROR missing $qq" }

# 4) Bridge (hidden). Needs 3011 + a live pet /chat endpoint.
if (Test-Port 7341) { Log '[4/4] bridge 7341 already up' }
else {
  $node = 'C:\Users\86189\SnowLuma\runtime\node-v24.22.1-win-x64\node.exe'
  if (-not (Test-Path $node)) { $node = 'node' }
  Start-Process -FilePath $node -ArgumentList "`"$root\bridge.mjs`"" -WorkingDirectory $root -WindowStyle Hidden
  Log '[4/4] bridge launched hidden'
  if (Wait-Port 7341 25) { Log '[4/4] 7341 online' } else { Log '[4/4] WARN 7341 still down' }
}

# Status dump. No daemon is left running by this script.
Log '--- status ---'
$rows = @(
  @('SnowLuma', 5099), @('Coo OneBot', 3001), @('fish OneBot', 3011),
  @('bridge', 7341), @('Coo WebUI', 17788)
)
foreach ($r in $rows) {
  Log ("  {0,-12} :{1}  {2}" -f $r[0], $r[1], $(if (Test-Port $r[1]) { 'OK' } else { 'DOWN' }))
}
Log 'done. no watchdog / no auto-reconnect daemon was started.'
