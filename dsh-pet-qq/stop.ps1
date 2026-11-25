<#
stop.ps1 —— 停掉 dsh-pet-qq 桥。

按 7341 单实例闸门的「归属 PID」精确停，兼容两种启动方式：
  · 双击 bat / wscript 启动（命令行含完整路径 dsh-pet-qq\bridge.mjs）
  · 后台任务启动（命令行只有相对的 bridge.mjs，旧版按路径匹配会漏掉）
不会碰 SnowLuma、QQ-B 或 DSH。
#>
$ErrorActionPreference = 'SilentlyContinue'

$targets = @()
$conn = Get-NetTCPConnection -State Listen -LocalPort 7341 | Select-Object -First 1
if ($conn) { $targets += [int]$conn.OwningProcess }

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dsh-pet-qq*bridge.mjs*' } |
  ForEach-Object { $targets += [int]$_.ProcessId }

$targets = @($targets | Sort-Object -Unique)
if ($targets.Count -eq 0) {
  Write-Host '没有发现正在运行的桥（7341 未监听）'
  exit 0
}

foreach ($id in $targets) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') {
    Stop-Process -Id $id -Force
    Write-Host "已停止桥 PID $id"
  }
}
Start-Sleep -Seconds 1
$still = Get-NetTCPConnection -State Listen -LocalPort 7341 | Select-Object -First 1
Write-Host $(if ($still) { '警告：7341 仍被占用' } else { '7341 已释放 OK' })
