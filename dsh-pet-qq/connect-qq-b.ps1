<#
connect-qq-b.ps1 —— 一键拉起「桌宠专用 QQ」通道（通道 B）。

和 connect-qq.ps1 的关系：
  connect-qq.ps1    = Coo 的通道（SnowLuma → QQ 泡泡🫧 → 3001 → Coo）
  connect-qq-b.ps1  = 桌宠自己的通道（SnowLuma → QQ B → 3011 → dsh-pet-qq 桥 → dsh 桌宠）
两条通道互不干扰，可以同时在线；它们只是同一个 SnowLuma 下的不同账号配置。

用法：
  powershell -ExecutionPolicy Bypass -File connect-qq-b.ps1
  powershell -ExecutionPolicy Bypass -File connect-qq-b.ps1 -QqExe 'D:\QQ-B\QQ.exe'
#>
param(
  [string]$QqExe = 'D:\QQ-B\QQ.exe',
  [string]$SnowLumaRoot = 'C:\Users\86189\SnowLuma',
  [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Continue'
$logFile = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'logs\connect-qq-b.log'
$bridgeDir = $PSScriptRoot
$cfgPath = Join-Path $bridgeDir 'config.json'

function Write-Step([string]$m) {
  $line = '{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  try { $dir = Split-Path -Parent $logFile; if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }; Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch { }
  Write-Host $line
}

function Test-Port([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(800, $false)) { return $false }
    $client.EndConnect($ar)
    return $true
  } catch { return $false } finally { $client.Close() }
}

Write-Step '--- 连接桌宠专用 QQ（通道 B）---'

# PS 5.1 的 Get-Content 按 ANSI 读，UTF-8 的 config.json 会解析失败
function Read-Utf8([string]$path) {
  [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}
$cfg = Read-Utf8 $cfgPath | ConvertFrom-Json
$wsUrl = [string]$cfg.onebot.wsUrl
$port = 3011
if ($wsUrl -match ':(\d+)') { $port = [int]$Matches[1] }
$expect = [int]$cfg.onebot.expectSelfId
Write-Step ("配置：{0} → 端口 {1}，目标号 {2}" -f $cfg.channel, $port, $(if ($expect) { $expect } else { '未设定（先跑 new-channel.ps1 -Uin）' }))

if (-not $expect) {
  Write-Step '失败：config.json 还没有目标号。先跑：new-channel.ps1 -Uin <桌宠的QQ号> -WriteSnowLuma'
  exit 1
}

# 1) SnowLuma 必须在跑：它负责注入 QQ 并开 OneBot 端口
if (-not (Test-Port 5099)) {
  $startBat = Join-Path $SnowLumaRoot 'start.bat'
  if (Test-Path $startBat) {
    Start-Process -FilePath 'C:\Windows\System32\cmd.exe' -ArgumentList '/c', "`"$startBat`"" -WindowStyle Hidden
    Write-Step '已启动 SnowLuma，等 WebUI 5099 …'
  } else {
    Write-Step "失败：找不到 $startBat"
    exit 1
  }
} else {
  Write-Step 'SnowLuma 已在运行 (5099)'
}

# 2) 通道 B 的 QQ 进程
$qqB = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $QqExe } | Select-Object -First 1
if (-not $qqB) {
  if (Test-Path $QqExe) {
    Start-Process -FilePath $QqExe -WorkingDirectory (Split-Path -Parent $QqExe)
    Write-Step "已启动 $QqExe —— 若弹登录窗口，用桌宠那个号扫码登录"
  } else {
    Write-Step "失败：找不到 $QqExe"
    Write-Step '多开 QQ 的做法：把 D:\QQ.exe 那套文件复制到 D:\QQ-B，改用自己的数据目录；详见 tools\dsh-pet-qq\README.md'
    exit 1
  }
}

# 3) 等 OneBot WS 端口
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while (-not (Test-Port $port)) {
  if ((Get-Date) -gt $deadline) {
    Write-Step "失败：${port} 一直没监听。"
    Write-Step '常见原因：① 通道 B 的 QQ 没登录；② SnowLuma 启动时该端口被占（EADDRINUSE 不重试）；③ app\config\onebot_<号>.json 里端口没改成这个。'
    Write-Step "诊断：Get-ChildItem '$SnowLumaRoot\app\config\onebot_*.json' | ForEach-Object { \$_.Name; (Get-Content \$_.Raw | ConvertFrom-Json).networks.wsServers[0].port }"
    exit 1
  }
  Start-Sleep -Seconds 3
}
Write-Step "OneBot ${port} 已监听"

# 4) 起桥（无窗口），单实例闸门在 7341
if (Test-Port 7341) {
  Write-Step '桥已在运行 (7341)'
} else {
  Start-Process -FilePath 'wscript.exe' -ArgumentList '//B', "`"$bridgeDir\start-hidden.vbs`"" -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Port 7341)) {
    if ((Get-Date) -gt $deadline) { break }
    Start-Sleep -Seconds 1
  }
  if (Test-Port 7341) { Write-Step '桥已启动 (7341)' } else { Write-Step '警告：桥没监听 7341，看 tools\dsh-pet-qq\logs\bridge.log' }
}

# 5) 用自检确认「登录的确实是目标号」
Write-Step '自检（账号校验）…'
$check = & node (Join-Path $bridgeDir 'bridge.mjs') --check 2>&1
$check | ForEach-Object { Write-Host '   ' $_ }
$hit = ($check | Select-String '✓ 目标号' | Measure-Object).Count
# PS 5.1 会把 node 的 UTF-8 stdout 按系统 ANSI(936) 解码，中文和 ✓ 会变乱码，
# 上面那句因此永远匹配不上，误报「账号不是目标号」。用纯 ASCII 的目标号再判一次。
if ($hit -eq 0) {
  $hit = ($check | Select-String -SimpleMatch "($expect)" | Measure-Object).Count
}
if ($hit -gt 0) {
  Write-Step '完成：dsh 桌宠已接上桌宠专用 QQ ✓'
  exit 0
}
Write-Step '警告：通道端口通了，但账号不是目标号（或自检失败）。看上面自检输出与 logs\bridge.log。'
exit 2
