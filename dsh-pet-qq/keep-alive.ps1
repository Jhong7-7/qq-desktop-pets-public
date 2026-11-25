<#
keep-alive.ps1 —— 给 QQ 桥 + SnowLuma 装上看门狗，不动现有连接。
双击 keep-alive.bat 运行；可重复点。若 watchdog.ps1 比当前看门狗进程新，
会先重启看门狗载入新守护逻辑，否则什么都不做。
#>
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$vbs = Join-Path $root 'start-watchdog.vbs'
$log = Join-Path $root 'logs\watchdog.log'

function Get-Watchdog {
  @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
     Where-Object { $_.CommandLine -like '*watchdog.ps1*' })
}

Write-Host '=== dsh-pet-qq 常驻看门狗 ===' -ForegroundColor Cyan
$wd = Get-Watchdog

# watchdog.ps1 被改过（mtime 晚于当前实例启动时间）→ 重启它，载入新守护逻辑。
# 双击一次即可把「同时守护 7341 + 5099」应用到已经跑着的看门狗。
if ($wd.Count -gt 0) {
  $stamp = (Get-Item (Join-Path $root 'watchdog.ps1')).LastWriteTimeUtc
  $proc = Get-Process -Id $wd[0].ProcessId -ErrorAction SilentlyContinue
  if ($proc -and $stamp -gt $proc.StartTime.ToUniversalTime()) {
    Write-Host '  看门狗脚本有更新，重启以载入新逻辑…'
    $wd | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    $wd = @()
  }
}

if ($wd.Count -gt 0) {
  Write-Host "  已在运行（PID $(($wd | Select-Object -First 1).ProcessId)），无需重复启动"
} else {
  Start-Process -FilePath 'wscript.exe' -ArgumentList '//B', "`"$vbs`"" `
    -WorkingDirectory $root -WindowStyle Hidden
  # wscript 中转两层，进程登记会有几秒延迟；轮询最多 15 秒，别急着误报失败。
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    $wd = Get-Watchdog
    if ($wd.Count -gt 0) { break }
  }
  if ($wd.Count -gt 0) {
    Write-Host "  看门狗已启动（PID $(($wd | Select-Object -First 1).ProcessId)）"
  } else {
    Write-Host '  暂未查到看门狗进程，以 7341 / logs\watchdog.log 为准' -ForegroundColor Yellow
  }
}

# 看门狗每 20 秒巡检一次；桥不在就立刻拉起，最多等 35 秒。
$deadline = (Get-Date).AddSeconds(35)
while (-not (Get-NetTCPConnection -State Listen -LocalPort 7341 -ErrorAction SilentlyContinue)) {
  if ((Get-Date) -gt $deadline) { break }
  Start-Sleep -Seconds 1
}
$bridge = Get-NetTCPConnection -State Listen -LocalPort 7341 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($bridge) {
  Write-Host "  桥已在线（7341，PID $($bridge.OwningProcess)）" -ForegroundColor Green
} else {
  Write-Host '  桥还没监听 7341，看 logs\bridge.log / logs\watchdog.log' -ForegroundColor Yellow
}
if (Test-Path $log) {
  Write-Host ''
  Write-Host '  最近看门狗日志：' -ForegroundColor Cyan
  Get-Content $log -Tail 5 | ForEach-Object { Write-Host "    $_" }
}

# 顺手把「登录时自动守护」也装上（幂等，可重复运行）。
Write-Host ''
Write-Host '=== 开机自启（可跳过） ===' -ForegroundColor Cyan
& (Join-Path $root 'install-startup.ps1')

# 再把当前这次会话里那个 SnowLuma 命令行窗口藏起来（零中断，可重复运行）。
Write-Host ''
Write-Host '=== 隐藏 SnowLuma 命令行窗口 ===' -ForegroundColor Cyan
& (Join-Path $root 'hide-snowluma.ps1')
