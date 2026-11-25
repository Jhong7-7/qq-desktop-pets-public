<#
new-channel.ps1 —— 给 dsh 桌宠开第二条 QQ 通道（不共用 Coo 的 3001/token）。

它做两件事：
  1) 生成/修正 SnowLuma 的按号配置 app\config\onebot_<Uin>.json —— 端口换成 3011/3010，token 独立
  2) 把 tools\dsh-pet-qq\config.json 指向这条新通道（wsUrl / token / expectSelfId）

用法：
  # 只生成本地桥配置 + 打印 SnowLuma 侧要写的内容（SnowLuma 在跑时最安全）
  powershell -ExecutionPolicy Bypass -File new-channel.ps1 -Uin 123456789

  # 连 SnowLuma 的配置一起写（先完全退出 SnowLuma，否则它会把文件写回去）
  powershell -ExecutionPolicy Bypass -File new-channel.ps1 -Uin 123456789 -WriteSnowLuma

注意：同一个 QQ 号的两份配置不能占同一个端口。泡泡🫧(30027) 已经占 3000/3001，
      新号默认走 3010/3011。
#>
param(
  [Parameter(Mandatory = $true)][string]$Uin,
  [int]$WsPort = 3011,
  [int]$HttpPort = 3010,
  [string]$SnowLumaRoot = 'C:\Users\86189\SnowLuma',
  [switch]$WriteSnowLuma
)

$ErrorActionPreference = 'Stop'

if ($Uin -notmatch '^\d{5,12}$') { throw "Uin 必须是 5–12 位数字，收到：$Uin" }
if ($WsPort -eq 3001 -or $HttpPort -eq 3000) { throw '3010/3011 是本通道默认口；3000/3001 属于 Coo，别抢。' }

# 43 位 base64url token，与 SnowLuma 现有 token 的形状一致
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

$snowCfgDir = Join-Path $SnowLumaRoot 'app\config'
$snowCfgPath = Join-Path $snowCfgDir "onebot_$Uin.json"
$bridgeCfgPath = Join-Path $PSScriptRoot 'config.json'

function Write-Utf8NoBom([string]$path, [string]$text) {
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# PS 5.1 的 Get-Content 按 ANSI 读，UTF-8 中文与 JSON 会解析失败；统一走这个
function Read-Utf8([string]$path) {
  [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}
$onebot = [ordered]@{
  mode     = 'snapshot'
  networks = [ordered]@{
    httpServers = @([ordered]@{
        name = 'http-default'; accessToken = $token; messageFormat = 'array'; reportSelfMessage = $false
        host = '127.0.0.1'; port = $HttpPort; path = '/'; enableWebSocket = $false
      })
    httpClients = @()
    wsServers   = @([ordered]@{
        name = 'ws-default'; accessToken = $token; messageFormat = 'array'; reportSelfMessage = $false
        host = '127.0.0.1'; port = $WsPort; path = '/'; role = 'Universal'
      })
    wsClients   = @()
  }
  statusCommand = [ordered]@{ enabled = $true; swallow = $false; cooldownSeconds = 5; trigger = '#sl' }
  historySync   = [ordered]@{ enabled = $false }
  notifications = [ordered]@{ channelIds = @() }
}
$onebotJson = $onebot | ConvertTo-Json -Depth 10

Write-Host "=== 1) SnowLuma 侧：$snowCfgPath ===" -ForegroundColor Cyan
$snowLumaRunning = (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$SnowLumaRoot*" } | Measure-Object).Count -gt 0
if (Test-Path $snowCfgPath) {
  $cur = Read-Utf8 $snowCfgPath | ConvertFrom-Json
  $curWs = $cur.networks.wsServers[0].port
  $curHttp = $cur.networks.httpServers[0].port
  $curTok = $cur.networks.wsServers[0].accessToken
  Write-Host ("已存在该号的配置：WS {0} / HTTP {1}，token {2}…" -f $curWs, $curHttp, $curTok.Substring(0, [Math]::Min(8, $curTok.Length)))
  if ($curWs -ne $WsPort) {
    Write-Host ("⚠ 端口还是 {0}，和泡泡🫧 的 3001 会打架，必须改成 {1}" -f $curWs, $WsPort) -ForegroundColor Yellow
  }
  $token = if ($curTok) { $curTok } else { $token }
} else {
  Write-Host '该号还没有配置（说明这个 QQ 还没被 SnowLuma 注入过）。'
}

if ($WriteSnowLuma) {
  if ($snowLumaRunning) {
    Write-Host '⚠ SnowLuma 正在运行，它会在退出时把旧配置写回去。建议先完全退出 SnowLuma 再跑这条。' -ForegroundColor Yellow
  }
  if (Test-Path $snowCfgPath) {
    Copy-Item $snowCfgPath "$snowCfgPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
  }
  # 已存在时保留原 token，只改端口
  $onebot2 = $onebotJson | ConvertFrom-Json
  $onebot2.networks.httpServers[0].accessToken = $token
  $onebot2.networks.wsServers[0].accessToken = $token
  Write-Utf8NoBom $snowCfgPath ($onebot2 | ConvertTo-Json -Depth 10)
  Write-Host "已写入 $snowCfgPath（WS $WsPort / HTTP $HttpPort）" -ForegroundColor Green
} else {
  Write-Host '（未加 -WriteSnowLuma：只打印，不改 SnowLuma 的文件）'
  Write-Host '要写进去的 JSON 如下：'
  Write-Host $onebotJson
}

Write-Host ''
Write-Host "=== 2) 桥侧：$bridgeCfgPath ===" -ForegroundColor Cyan
Copy-Item $bridgeCfgPath "$bridgeCfgPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
$bridge = Read-Utf8 $bridgeCfgPath | ConvertFrom-Json
$bridge.channel = "channel-b（桌宠专用 QQ $Uin，$WsPort）"
$bridge.onebot.wsUrl = "ws://127.0.0.1:$WsPort/"
$bridge.onebot.token = $token
$bridge.onebot.expectSelfId = [int]$Uin
Write-Utf8NoBom $bridgeCfgPath ($bridge | ConvertTo-Json -Depth 10)
Write-Host "已指向通道 B：$($bridge.onebot.wsUrl)  目标号 $Uin" -ForegroundColor Green

Write-Host ''
Write-Host '=== 3) 接下来（首次接入按这个顺序）===' -ForegroundColor Cyan
@"
首次接入一个从没被 SnowLuma 见过的号：
  1) 先跑 SnowLuma：$SnowLumaRoot\start.bat
  2) 用新号启动第二个 QQ 并登录（同一台机多开：复制一份 QQ 安装目录，例如 D:\QQ-B，跑 D:\QQ-B\QQ.exe）
  3) SnowLuma 会给这个号生成 app\config\onebot_$Uin.json，但端口默认还是 3000/3001，会和泡泡🫧 打架
  4) 完全退出 SnowLuma → 再跑一次本脚本并加 -WriteSnowLuma：
       powershell -ExecutionPolicy Bypass -File "$PSCommandPath" -Uin $Uin -WriteSnowLuma
     它会把该号改成 WS $WsPort / HTTP $HttpPort，token 用本通道自己的
  5) 重开 SnowLuma → 重开 QQ B（顺序不能反：SnowLuma 只能注入它启动之后出现的 QQ 进程）
  6) 等 $WsPort 监听：Test-NetConnection 127.0.0.1 -Port $WsPort
  7) 自检：node "$PSScriptRoot\bridge.mjs" --check     （应显示「✓ 目标号」）
  8) 常驻：wscript //B "$PSScriptRoot\start-hidden.vbs"
     或者直接跑：powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\connect-qq-b.ps1"

注意：
  - 泡泡🫧 的 3000/3001 归 Coo，别抢；本通道固定 3010/$WsPort。
  - 同一时刻只跑一条桥（单实例闸门 7341）：切回共用通道先跑 stop.bat，再
      node bridge.mjs --config config.channel-a.json
"@