<#
connect-now.ps1 —— 通道 B 一键接入（必须在你自己的桌面会话里跑，进程才能常驻）。

做两件事：
  1) 确保 SnowLuma 已就绪（5099）；没跑就用最小化窗口启动 start.bat，并等它就绪
     这一步同时会把通道 A（泡泡/Coo 的 3000/3001）一起恢复
  2) 再交给 connect-qq-b.ps1：起 QQ-B → 等 3011 → 无窗口起桥 → 账号自检

顺序不能反：SnowLuma 只能注入它启动之后出现的 QQ 进程。
#>
param([int]$WaitSec = 90)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot

function Test-Port([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(800, $false)) { return $false }
    $c.EndConnect($ar)
    return $true
  } catch { return $false } finally { $c.Close() }
}

Write-Host '=== 1) SnowLuma ===' -ForegroundColor Cyan
if (Test-Port 5099) {
  Write-Host '  已在运行 (5099)'
} else {
  $bat = 'C:\Users\86189\SnowLuma\start.bat'
  if (-not (Test-Path $bat)) { Write-Host "  失败：找不到 $bat"; exit 1 }
  Start-Process -FilePath $bat -WorkingDirectory (Split-Path -Parent $bat) -WindowStyle Minimized
  Write-Host '  已启动（最小化窗口，别关它），等待 5099 …'
  $deadline = (Get-Date).AddSeconds($WaitSec)
  while (-not (Test-Port 5099)) {
    if ((Get-Date) -gt $deadline) {
      Write-Host '  失败：5099 一直没起来，看 SnowLuma 那个窗口的报错'
      exit 1
    }
    Start-Sleep -Seconds 1
  }
  Write-Host '  SnowLuma 就绪 OK'
}

Write-Host ''
Write-Host '=== 2) 通道 A 端口 ===' -ForegroundColor Cyan
Write-Host ("  3001 (泡泡 / Coo): {0}" -f $(if (Test-Port 3001) { '在线 OK' } else { '暂未在线（等 QQ 被重新注入）' }))

Write-Host ''
Write-Host '=== 3) 拉起 QQ-B / 桥 / 账号自检 ===' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'connect-qq-b.ps1')
$code = $LASTEXITCODE
Write-Host ''
if ($code -eq 0) {
  Write-Host '完成：可以用主人号 10000 给 10001 私聊发「在吗」测试' -ForegroundColor Green
} elseif ($code -eq 2) {
  Write-Host '端口通了但账号校验没过，看上面的自检输出与 logs\bridge.log' -ForegroundColor Yellow
} else {
  Write-Host '未接通，按 connect-qq-b.ps1 上面的提示排查（QQ-B 是否登录 / 3011 是否监听）' -ForegroundColor Yellow
}
exit $code
