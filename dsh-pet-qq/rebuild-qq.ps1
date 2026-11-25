<#
rebuild-qq.ps1 —— 通道 B 一键重建（必须在你自己的桌面会话里双击 bat 运行）。

用途：DSH 重启、桥被关掉、换电脑重启后，把 QQ 通道重新拉起来。
做四件事：
  1) 确认 SnowLuma(5099) 在跑，不在就启动并等就绪（同时恢复通道 A 3000/3001）
  2) 确认协议端 3011 在监听（不在就提示 QQ-B 没登录）
  3) 停掉旧桥，确保常驻看门狗在跑，由它把桥拉起来（桌宠端口由 pet-endpoint.mjs 自动发现）
  4) 跑 --check 做账号校验，确认登录的确实是桌宠专用号
#>
param([int]$WaitSec = 90)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$cfg = Get-Content (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$expect = [string]$cfg.onebot.expectSelfId

function Test-Port([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(800, $false)) { return $false }
    $c.EndConnect($ar)
    return $true
  } catch { return $false } finally { $c.Close() }
}

Write-Host '=== 1/4 SnowLuma (5099) ===' -ForegroundColor Cyan
if (Test-Port 5099) {
  Write-Host '  已在运行 OK'
} else {
  $bat = 'C:\Users\86189\SnowLuma\start.bat'
  if (-not (Test-Path $bat)) { Write-Host "  失败：找不到 $bat"; exit 1 }
  Start-Process -FilePath $bat -WorkingDirectory (Split-Path -Parent $bat) -WindowStyle Minimized
  Write-Host '  已启动（最小化窗口别关），等待就绪 …'
  $deadline = (Get-Date).AddSeconds($WaitSec)
  while (-not (Test-Port 5099)) {
    if ((Get-Date) -gt $deadline) { Write-Host '  失败：5099 一直没起来'; exit 1 }
    Start-Sleep -Seconds 1
  }
  Write-Host '  SnowLuma 就绪 OK'
}

Write-Host ''
Write-Host '=== 2/4 协议端 (3011) ===' -ForegroundColor Cyan
if (Test-Port 3011) {
  Write-Host '  通道 B WS 在线 OK'
} else {
  Write-Host '  警告：3011 没监听。检查 D:\QQ-B\QQ.exe 是否已登录桌宠专用号、SnowLuma 是否先于 QQ 启动。' -ForegroundColor Yellow
  Write-Host '  桥仍会启动，但收不到消息；修好后重新双击本脚本即可。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '=== 3/4 重启桥（并装常驻看门狗） ===' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'stop.ps1')
Start-Sleep -Seconds 1

# 先确保看门狗在跑；它发现 7341 空了会自动用 start-hidden.vbs 把桥拉起来。
# 看门狗由 wscript 从桌面会话托管，不随对话后台任务一起被回收。
$wd = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { $_.CommandLine -like '*watchdog.ps1*' })
if ($wd.Count -eq 0) {
  Start-Process -FilePath 'wscript.exe' -ArgumentList '//B', "`"$root\start-watchdog.vbs`"" `
    -WorkingDirectory $root -WindowStyle Hidden
  Write-Host '  看门狗已启动（桌面会话常驻，掉线自动拉起）'
} else {
  Write-Host "  看门狗已在运行（PID $(($wd | Select-Object -First 1).ProcessId)）"
}

$deadline = (Get-Date).AddSeconds(35)
while (-not (Test-Port 7341)) {
  if ((Get-Date) -gt $deadline) { break }
  Start-Sleep -Seconds 1
}
if (-not (Test-Port 7341)) {
  Write-Host '  失败：桥没监听 7341，看 logs\bridge.log / logs\watchdog.log' -ForegroundColor Red
  exit 1
}
Write-Host '  桥已启动 (7341) OK'

Write-Host ''
Write-Host '=== 4/4 自检 ===' -ForegroundColor Cyan
$check = & node (Join-Path $root 'bridge.mjs') --check 2>&1
$check | ForEach-Object { Write-Host '   ' $_ }
# PS 5.1 会把 node 的 UTF-8 输出按 ANSI(936) 解码，中文和 ✓ 变乱码；
# 因此用纯 ASCII 的目标号做兜底判据。
$hit = ($check | Select-String '✓ 目标号' | Measure-Object).Count
if ($hit -eq 0) { $hit = ($check | Select-String -SimpleMatch "($expect)" | Measure-Object).Count }
$petOk = ($check | Select-String -SimpleMatch 'HTTP 200' | Measure-Object).Count

Write-Host ''
if ($hit -gt 0 -and $petOk -gt 0) {
  Write-Host "完成：桌宠已接上桌宠专用 QQ $expect" -ForegroundColor Green
  Write-Host '用主人号私聊发一句「在吗」验证；表情包让她自己挑就行。' -ForegroundColor Green
  exit 0
}
Write-Host '警告：自检没全过，看上面的输出和 logs\bridge.log' -ForegroundColor Yellow
exit 2
