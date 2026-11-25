# rollback-task1.ps1 —— 一键回退方案①（任务队列通道）
# 停桥 → 还原 bridge.mjs / config.json → 删除新增文件 → 重启桥 → 自测确认
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Stop-Bridge {
  $old = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'dsh-pet-qq\\bridge\.mjs' }
  foreach ($p in $old) { Stop-Process -Id $p.ProcessId -Force; "已停旧桥 PID $($p.ProcessId)" }
  if (-not $old) { "没有正在运行的桥" }
}

"=== 1. 停桥 ==="
Stop-Bridge
Start-Sleep -Milliseconds 800

"=== 2. 还原文件 ==="
Copy-Item -Force "bridge.mjs.bak-20261120-1010-task1" "bridge.mjs" -ErrorAction Stop; "bridge.mjs 已还原"
Copy-Item -Force "config.json.bak-20261120-1010-task1" "config.json" -ErrorAction Stop; "config.json 已还原"

"=== 3. 删除新增文件 ==="
foreach ($f in @("task-bridge.mjs", "task-notify.mjs")) {
  if (Test-Path $f) { Remove-Item -Force $f; "$f 已删除" }
}
if (Test-Path "tasks") { Remove-Item -Recurse -Force "tasks"; "tasks/ 已删除" }

"=== 4. 自测确认 ==="
$test = & node bridge.mjs --quiet-test 2>&1 | Select-Object -Last 5
$test | ForEach-Object { $_ }

"=== 5. 重启桥 ==="
explorer.exe "$here\start-hidden.vbs"
Start-Sleep -Seconds 4
$new = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'dsh-pet-qq\\bridge\.mjs' }
if ($new) { "新桥已启动 PID $($new.ProcessId -join ',')" } else { "警告：新桥未列出，稍后用 start-hidden.vbs 手动起" }

"=== 回退完成 ==="
