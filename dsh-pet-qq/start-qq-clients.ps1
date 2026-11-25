<#
start-qq-clients.ps1 -- Bring BOTH QQ clients up (idempotent, ASCII-only).

Why this exists:
  SnowLuma only injects QQ processes that appear AFTER SnowLuma itself
  started. On a fresh logon the startup folder revives SnowLuma, Coopanion,
  the bridge and the watchdog -- but NOT the two QQ clients. Result: 5099,
  7341 and 17788 are all up while 3000/3001/3010/3011 stay down, Coo shows
  "protocol: disconnected" and the bridge loops on ECONNREFUSED 3011.

  This script waits for SnowLuma (5099), then starts only the clients whose
  OneBot WS port is still down:
    D:\QQ.exe      channel A (Coo / 泡泡, uin 30027) -> 3001
    D:\QQ-B\QQ.exe channel B (dsh-pet 溪颜, uin 10001) -> 3011

Safe to run repeatedly: an online port means that client is already injected
and is skipped. If a login QR pops up, the window is left visible on purpose.
Log: logs\qq-clients.log
#>
param([int]$WaitSnowSec = 90, [switch]$Force)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'qq-clients.log'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Log([string]$m) {
  try {
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1048576) {
      Move-Item -Path $logFile -Destination "$logFile.1" -Force
    }
    [System.IO.File]::AppendAllText($logFile, "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m`n", $utf8)
  } catch { }
  Write-Host $m
}

function Test-Port([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(700, $false)) { return $false }
    $c.EndConnect($ar)
    return $true
  } catch { return $false } finally { $c.Close() }
}

Write-Log '--- start-qq-clients invoked ---'

# 1) SnowLuma MUST already be up, otherwise injection will silently fail.
if (-not (Test-Port 5099)) {
  Write-Log "waiting for SnowLuma 5099 (max ${WaitSnowSec}s) ..."
  $deadline = (Get-Date).AddSeconds($WaitSnowSec)
  while (-not (Test-Port 5099) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  if (-not (Test-Port 5099)) {
    Write-Log 'ERROR SnowLuma 5099 still down; abort (the watchdog revives it)'
    exit 1
  }
}
Write-Log 'SnowLuma 5099 online'

$clients = @(
  @{ Name = 'A/Coo';  Port = 3001; Exe = 'D:\QQ.exe';      Work = 'D:\' },
  @{ Name = 'B/fish'; Port = 3011; Exe = 'D:\QQ-B\QQ.exe'; Work = 'D:\QQ-B' }
)

# 2) Start only what is missing.
foreach ($c in $clients) {
  if (-not $Force -and (Test-Port $c.Port)) {
    Write-Log "$($c.Name) already online (:$($c.Port)), skip"
    continue
  }
  if (-not (Test-Path $c.Exe)) {
    Write-Log "ERROR missing $($c.Exe)"
    continue
  }
  try {
    Start-Process -FilePath $c.Exe -WorkingDirectory $c.Work
    Write-Log "started $($c.Name): $($c.Exe)"
  } catch {
    Write-Log "ERROR failed to start $($c.Name): $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 4
}

# 3) Report (SnowLuma injection takes ~10-30s after login).
$deadline2 = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline2) {
  if ((Test-Port 3001) -and (Test-Port 3011)) { break }
  Start-Sleep -Seconds 3
}
$a = if (Test-Port 3001) { 'OK' } else { 'DOWN' }
$b = if (Test-Port 3011) { 'OK' } else { 'DOWN' }
Write-Log "result: 3001(A/Coo)=$a 3011(B/fish)=$b"
if ($a -eq 'OK' -and $b -eq 'OK') { exit 0 } else { exit 2 }
