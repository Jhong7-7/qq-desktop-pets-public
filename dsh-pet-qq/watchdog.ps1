<#
watchdog.ps1 —— dsh-pet-qq 常驻看门狗（在用户桌面会话里无窗口运行）。

为什么需要它：
  以前桥是用「对话里的后台任务」拉起来的，任务被回收 / 会话结束时会把
  node 一起杀掉，日志连「WS 已断开」都没有，表现为 QQ 突然不回消息了。
  2026-11-08 22:55 又暴露第二个缺口：SnowLuma 挂掉时 3011 全没，
  桥虽然活着却一直 ECONNREFUSED，旧版看门狗只盯 7341 所以没救。
  现在由桌面会话进程托管，守护三处：
    · 7341 桥不在   → start-hidden.vbs 拉起（20 秒内自愈）
    · 5099 SnowLuma → start-snowluma-hidden.vbs 隐藏拉起（同样 20 秒内）
    · 3001/3011 掉了但 5099 还在 → 说明 SnowLuma 活着、QQ 客户端没被注入，
      连续 3 次（约 60s）确认后跑 start-qq-clients.ps1 把两个 QQ 拉起来
  2026-11-09 20:40 的真实故障：开机自启把 SnowLuma/Coo/桥/看门狗全拉起来了，
  唯独两个 QQ 客户端没自启，于是 3001/3011 全空、Coo 显示「协议端未连接」、
  桥一直 ECONNREFUSED。启动目录新增 QQ-Clients.vbs 解决开机场景，上面第 3 条
  解决会话中途用户退出 QQ 的场景。
  桥自身的 WS 断线重连 / 桌宠端口漂移由 bridge.mjs 自己处理，这里不插手。

单实例：用命名 Mutex 保证只有一个看门狗，进程退出后自动释放。
日志：logs\watchdog.log（超过 1 MB 轮转成 .1）
#>
param([int]$IntervalSec = 20)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$logFile = Join-Path $root 'logs\watchdog.log'
$logDir = Split-Path -Parent $logFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-Log([string]$msg) {
  try {
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1048576) {
      Move-Item -Path $logFile -Destination "$logFile.1" -Force
    }
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg`n"
    [System.IO.File]::AppendAllText($logFile, $line, $utf8)
  } catch { }
}

# 命名 Mutex：第二个实例直接退出，进程被杀后句柄自动释放。
try {
  $mutex = [System.Threading.Mutex]::new($false, 'Local\dsh-pet-qq-watchdog')
  if (-not $mutex.WaitOne(0, $false)) {
    Write-Log '已有看门狗在运行，本实例退出'
    exit 0
  }
} catch {
  Write-Log "单实例锁失败，本实例退出：$($_.Exception.Message)"
  exit 1
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

$vbs = Join-Path $root 'start-hidden.vbs'
$snowVbs = Join-Path $root 'start-snowluma-hidden.vbs'
$qqPs1 = Join-Path $root 'start-qq-clients.ps1'
Write-Log "看门狗启动 PID=$PID 间隔=${IntervalSec}s 守护端口=7341(桥) + 5099(SnowLuma) + 3001/3011(QQ 客户端)"
$lastStart = [datetime]::MinValue
$failures = 0
$lastSnowStart = [datetime]::MinValue
$snowFailures = 0
$qqMisses = 0
$lastQqStart = [datetime]::MinValue
# 进程优先级由 focus-mode.ps1 按「在用 / 离开」模式统一管理，这里不插手，
# 避免两个常驻脚本互相把优先级改来改去。

while ($true) {
  # ── 桥 ───────────────────────────────────────────────────────────
  if (-not (Test-Port 7341)) {
    $cooldown = [Math]::Max(25, $IntervalSec)
    if (((Get-Date) - $lastStart).TotalSeconds -ge $cooldown) {
      $failures += 1
      Write-Log "桥未监听 7341 → 第 $failures 次重新拉起（$vbs）"
      try {
        Start-Process -FilePath 'wscript.exe' `
          -ArgumentList '//B', "`"$vbs`"" `
          -WorkingDirectory $root -WindowStyle Hidden
        $lastStart = Get-Date
      } catch {
        Write-Log "桥拉起失败：$($_.Exception.Message)"
      }
    }
  } elseif ($failures -gt 0) {
    Write-Log "桥已恢复在线（7341 OK），累计自动拉起 $failures 次"
    $failures = 0
  }

  # ── SnowLuma ─────────────────────────────────────────────────────
  # 只看 5099：它是 WebUI，也是 3010/3011 OneBot 端口的宿主。
  # 冷却比桥长一些（SnowLuma 启动 + QQ 注入要几秒），避免重复拉起。
  if (-not (Test-Port 5099)) {
    $snowCooldown = [Math]::Max(45, $IntervalSec)
    if (((Get-Date) - $lastSnowStart).TotalSeconds -ge $snowCooldown) {
      $snowFailures += 1
      Write-Log "SnowLuma 未监听 5099 → 第 $snowFailures 次隐藏拉起（$snowVbs）"
      try {
        Start-Process -FilePath 'wscript.exe' `
          -ArgumentList '//B', "`"$snowVbs`"" `
          -WorkingDirectory $root -WindowStyle Hidden
        $lastSnowStart = Get-Date
      } catch {
        Write-Log "SnowLuma 拉起失败：$($_.Exception.Message)"
      }
    }
  } elseif ($snowFailures -gt 0) {
    Write-Log "SnowLuma 已恢复在线（5099 OK），累计自动拉起 $snowFailures 次"
    $snowFailures = 0
  }

  # ── QQ 客户端（3001 / 3011）───────────────────────────────────────
  # 5099 在线但 OneBot WS 掉了 = SnowLuma 活着、只是没有 QQ 进程被注入。
  # 连续 3 次（约 60s）才动手，避开 QQ 刚登录 / SnowLuma 注入中的窗口期；
  # 拉起脚本自身按端口幂等，已在线的通道不会被重复启动。
  if (Test-Port 5099) {
    if ((-not (Test-Port 3001)) -or (-not (Test-Port 3011))) {
      $qqMisses += 1
      if ($qqMisses -ge 3 -and ((Get-Date) - $lastQqStart).TotalSeconds -ge 180) {
        Write-Log "OneBot 3001/3011 连续 $qqMisses 次掉线 → 拉起 QQ 客户端（$qqPs1）"
        try {
          Start-Process -FilePath 'powershell.exe' `
            -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$qqPs1`"" `
            -WorkingDirectory $root -WindowStyle Hidden
          $lastQqStart = Get-Date
          $qqMisses = 0
        } catch {
          Write-Log "QQ 客户端拉起失败：$($_.Exception.Message)"
        }
      }
    } elseif ($qqMisses -gt 0) {
      Write-Log 'OneBot 3001/3011 已恢复，取消 QQ 客户端拉起'
      $qqMisses = 0
    }
  } else {
    $qqMisses = 0
  }

  Start-Sleep -Seconds $IntervalSec
}
