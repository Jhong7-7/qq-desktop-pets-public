<#
adopt-desktop-session.ps1 -- Move the WHOLE QQ stack out of the WorkBuddy session.

Run by detach-watchdog.vbs, which is launched through explorer.exe ShellExecute.
explorer is the desktop shell, so THIS process and every child it starts belong
to the user logon session, not to WorkBuddy's job. WorkBuddy exiting therefore
cannot kill them.

Full migration (default):
  1. stop the old watchdog so it does not interfere
  2. stop + relaunch SnowLuma (5099) from this desktop session
  3. stop + relaunch the bridge (7341) from this desktop session
  4. start a fresh watchdog from this desktop session
  => Coo (3001) and the fish (3011) reconnect by themselves; ~10-20s blip
  => after this, closing WorkBuddy has NO effect on either QQ channel

-SkipServices only re-parents the watchdog (zero downtime), useful when a
chat is in progress and you just want the guardian to be independent.

Bridge dependencies are all local: Coopanion's bundled `ws` module plus
./stickers.mjs ./pet-endpoint.mjs ./sleep-state.mjs. No WorkBuddy runtime.
#>
param([switch]$SkipServices)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$log = Join-Path $root 'logs\desktop-session.log'
$dir = Split-Path -Parent $log
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-Log([string]$m) {
  try { [System.IO.File]::AppendAllText($log, "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m`n", $utf8) } catch { }
}

function Test-Port([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(700, $false)) { return $false }
    $c.EndConnect($ar); return $true
  } catch { return $false } finally { $c.Close() }
}
function Wait-Port([int]$port, [int]$seconds, [switch]$WantDown) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $up = Test-Port $port
    if ($WantDown -and -not $up) { return $true }
    if (-not $WantDown -and $up) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}
function Start-HiddenVbs([string]$name) {
  $vbs = Join-Path $root $name
  Start-Process -FilePath 'wscript.exe' -ArgumentList '//B', "`"$vbs`"" `
    -WorkingDirectory $root -WindowStyle Hidden
  Write-Log "桌面会话拉起 $name"
}
function Get-Watchdogs {
  @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match '(?i)-File\s+.*watchdog\.ps1' -and $_.ProcessId -ne $PID })
}
function Get-Owner([int]$port) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess }
  return 0
}
function Stop-Tree([int]$childPid, [string]$label) {
  if ($childPid -le 0) { return }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$childPid" -ErrorAction SilentlyContinue
  if (-not $p) { return }
  $parent = $p.ParentProcessId
  $pp = Get-CimInstance Win32_Process -Filter "ProcessId=$parent" -ErrorAction SilentlyContinue
  # supervisor first, so it cannot respawn the child
  if ($pp -and $pp.Name -match 'node') {
    try { Stop-Process -Id $parent -Force -Confirm:$false -ErrorAction Stop; Write-Log "停 $label 监督进程 PID $parent" } catch { }
  }
  try { Stop-Process -Id $childPid -Force -Confirm:$false -ErrorAction Stop; Write-Log "停 $label PID $childPid" } catch { Write-Log "停 $label PID $childPid 失败: $($_.Exception.Message)" }
}

$self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
$selfParent = Get-CimInstance Win32_Process -Filter "ProcessId=$($self.ParentProcessId)" -ErrorAction SilentlyContinue
Write-Log "===== adopt 启动 PID=$PID 父=$(if ($selfParent) { "$($selfParent.Name)($($self.ParentProcessId))" } else { "$($self.ParentProcessId) 已退出" }) Full=$(-not $SkipServices) ====="

# -- 1. stop the old watchdog (it may belong to a tool session) ------------
$old = Get-Watchdogs
Write-Log "现有看门狗: $(if (@($old).Count -gt 0) { (@($old) | ForEach-Object { $_.ProcessId }) -join ',' } else { '无' })"
foreach ($p in $old) {
  try { Stop-Process -Id $p.ProcessId -Force -Confirm:$false -ErrorAction Stop; Write-Log "已停旧看门狗 $($p.ProcessId)" } catch { Write-Log "停止 $($p.ProcessId) 失败: $($_.Exception.Message)" }
}
Start-Sleep -Seconds 2   # let the named Mutex release

# -- 2. re-parent SnowLuma + bridge -----------------------------------------
if (-not $SkipServices) {
  $snowPid = Get-Owner 5099
  Write-Log "迁移 SnowLuma：当前 5099 PID=$snowPid"
  Stop-Tree $snowPid 'SnowLuma'
  Wait-Port 5099 15 -WantDown | Out-Null
  Start-HiddenVbs 'start-snowluma-hidden.vbs'
  $okSnow = Wait-Port 5099 60
  $ok3011 = Wait-Port 3011 60
  Write-Log "SnowLuma 重启结果 5099=$okSnow 3011=$ok3011"

  $bridgePid = Get-Owner 7341
  Write-Log "迁移桥：当前 7341 PID=$bridgePid"
  Stop-Tree $bridgePid '桥'
  Wait-Port 7341 15 -WantDown | Out-Null
  Start-HiddenVbs 'start-hidden.vbs'
  $okBridge = Wait-Port 7341 40
  Write-Log "桥重启结果 7341=$okBridge"
}

# -- 3. fresh watchdog, now entirely desktop-session owned -----------------
Start-HiddenVbs 'start-watchdog.vbs'
Start-Sleep -Seconds 3
$new = Get-Watchdogs
Write-Log "新看门狗: $(if (@($new).Count -gt 0) { (@($new) | ForEach-Object { "PID $($_.ProcessId) 父 $($_.ParentProcessId)" }) -join '; ' } else { '尚未就绪' })"

# -- 4. audit ---------------------------------------------------------------
$ports = @(5099, 3000, 3001, 3010, 3011, 7341, 8726)
$state = ($ports | ForEach-Object { "$_=$(if (Test-Port $_) { 'OK' } else { 'DOWN' })" }) -join ' '
Write-Log "端口状态 $state"
Write-Log 'adopt 完成：全部常驻组件已由 explorer 桌面会话托管'
