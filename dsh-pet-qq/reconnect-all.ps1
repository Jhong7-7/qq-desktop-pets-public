<#
reconnect-all.ps1 -- Bring BOTH QQ channels back online (Coo + dsh-pet fish).

Both QQ worlds share one SnowLuma process:
  5099            SnowLuma WebUI (the process health signal)
  3000 / 3001     channel A  -> Coopanion's cortico-world-qq (Coo)
  3010 / 3011     channel B  -> dsh-pet-qq bridge (the fish)
  7341            the bridge's single-instance gate

So when SnowLuma dies, BOTH QQ links go dark. This script:
  1. revives SnowLuma hidden (start-snowluma-hidden.vbs)
  2. revives the bridge hidden if needed (start-hidden.vbs)
  3. reloads the watchdog if its running copy is older than watchdog.ps1
     (an old watchdog only watches 7341 and cannot rescue SnowLuma)
     -ForceReloadWatchdog always reloads it, so running this from the
     user's own desktop session re-parents the watchdog out of a tool session
  4. waits for the ports and prints a short status

Safe to run repeatedly. Does not touch QQ, Coopanion or DSH processes.
#>
param([switch]$SkipWatchdogReload, [switch]$ForceReloadWatchdog)

$ErrorActionPreference = 'Continue'
# PowerShell 5.1 的 Invoke-WebRequest 默认刷进度条，会把状态表冲乱。
$ProgressPreference = 'SilentlyContinue'
$root = $PSScriptRoot

function Test-Port([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(700, $false)) { return $false }
    $c.EndConnect($ar)
    return $true
  } catch { return $false } finally { $c.Close() }
}

function Start-Hidden([string]$vbsName) {
  $vbs = Join-Path $root $vbsName
  if (-not (Test-Path $vbs)) { throw "missing launcher: $vbs" }
  Start-Process -FilePath 'wscript.exe' `
    -ArgumentList '//B', "`"$vbs`"" `
    -WorkingDirectory $root -WindowStyle Hidden
}

function Wait-Port([int]$port, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $port) { return $true }
    Start-Sleep -Seconds 2
  }
  return (Test-Port $port)
}

Write-Host '=== reconnect-all: Coo + dsh-pet QQ ===' -ForegroundColor Cyan

# -- 1. SnowLuma (shared by both channels) -------------------------------
if (Test-Port 5099) {
  Write-Host '  [1/4] SnowLuma 5099 已在线' -ForegroundColor Green
} else {
  Write-Host '  [1/4] SnowLuma 掉了 → 隐藏拉起' -ForegroundColor Yellow
  try { Start-Hidden 'start-snowluma-hidden.vbs' }
  catch { Write-Host "    拉起失败：$($_.Exception.Message)" -ForegroundColor Red }
  if (Wait-Port 5099 40) { Write-Host '    5099 已上线' -ForegroundColor Green }
  else { Write-Host '    5099 仍未上线，看 logs\watchdog.log' -ForegroundColor Red }
}

# -- 2. Bridge -------------------------------------------------------------
if (Test-Port 7341) {
  Write-Host '  [2/4] 桥 7341 已在线' -ForegroundColor Green
} else {
  Write-Host '  [2/4] 桥掉了 → 隐藏拉起' -ForegroundColor Yellow
  try { Start-Hidden 'start-hidden.vbs' }
  catch { Write-Host "    拉起失败：$($_.Exception.Message)" -ForegroundColor Red }
  if (Wait-Port 7341 30) { Write-Host '    7341 已上线' -ForegroundColor Green }
  else { Write-Host '    7341 仍未上线' -ForegroundColor Red }
}

# -- 3. Watchdog reload ----------------------------------------------------
$wdScript = Join-Path $root 'watchdog.ps1'
$stamp = (Get-Item $wdScript).LastWriteTime
$running = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match '(?i)-File\s+.*watchdog\.ps1' -and $_.ProcessId -ne $PID })

if (-not $SkipWatchdogReload) {
  $stale = @($running | Where-Object { [datetime]$_.CreationDate -lt $stamp })
  if ($ForceReloadWatchdog -and $running.Count -gt 0) {
    Write-Host "  [3/4] 强制重载看门狗到当前桌面会话（旧 PID $(($running | Select-Object -First 1).ProcessId)）" -ForegroundColor Yellow
    foreach ($p in $running) {
      try { Stop-Process -Id $p.ProcessId -Force -Confirm:$false -ErrorAction Stop } catch { }
    }
    Start-Sleep -Seconds 2
    Start-Hidden 'start-watchdog.vbs'
    Write-Host '    已拉起新看门狗' -ForegroundColor Green
  } elseif ($running.Count -eq 0) {
    Write-Host '  [3/4] 看门狗没在跑 → 拉起（新代码：7341 + 5099）' -ForegroundColor Yellow
    Start-Hidden 'start-watchdog.vbs'
  } elseif ($stale.Count -gt 0) {
    Write-Host "  [3/4] 看门狗是旧代码（PID $(($stale | Select-Object -First 1).ProcessId)）→ 重载" -ForegroundColor Yellow
    foreach ($p in $stale) {
      try { Stop-Process -Id $p.ProcessId -Force -Confirm:$false -ErrorAction Stop } catch { }
    }
    Start-Sleep -Seconds 2
    Start-Hidden 'start-watchdog.vbs'
    Write-Host '    已拉起新看门狗' -ForegroundColor Green
  } else {
    Write-Host "  [3/4] 看门狗已是新代码（PID $(($running | Select-Object -First 1).ProcessId)）" -ForegroundColor Green
  }
}

# -- 4. Status -------------------------------------------------------------
Write-Host '  [4/4] 链路状态' -ForegroundColor Cyan
$rows = @(
  @{ Name = 'SnowLuma WebUI (共用)'; Port = 5099 },
  @{ Name = '通道 A Coo  HTTP';       Port = 3000 },
  @{ Name = '通道 A Coo  OneBot WS';  Port = 3001 },
  @{ Name = '通道 B 鱼   HTTP';       Port = 3010 },
  @{ Name = '通道 B 鱼   OneBot WS';  Port = 3011 },
  @{ Name = 'dsh-pet-qq 桥';          Port = 7341 }
)
foreach ($r in $rows) {
  $ok = Test-Port $r.Port
  $tag = if ($ok) { 'OK  ' } else { 'DOWN' }
  $color = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("    {0}  {1,-24} :{2}" -f $tag, $r.Name, $r.Port) -ForegroundColor $color
}

# 桌宠端点会随 DSH 重启漂移（8726 → 1958 → 1697 → 5229 …），写死端口会误报 DOWN。
# 只认 /dsh-pet-7340/state 里带 counter/sections 的那个，和 bridge.mjs 的判据一致。
$petPort = 0
foreach ($cand in 8726, 5229, 1958, 1697, 3215, 1882, 2727) {
  if (-not (Test-Port $cand)) { continue }
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$cand/dsh-pet-7340/state" -UseBasicParsing -TimeoutSec 2
    if ($resp.Content -match '"counter"' -and $resp.Content -match '"sections"') { $petPort = $cand; break }
  } catch { }
}
if ($petPort) {
  Write-Host ("    OK    {0,-24} :{1} (端点自动发现)" -f 'DSH 桌宠 /chat', $petPort) -ForegroundColor Green
} else {
  Write-Host ("    DOWN  {0,-24} :{1}" -f 'DSH 桌宠 /chat', '未找到有效端点') -ForegroundColor Red
}
Write-Host ''
Write-Host '完成。想验证收发：node bridge.mjs --check / --selftest "在吗"' -ForegroundColor Cyan
