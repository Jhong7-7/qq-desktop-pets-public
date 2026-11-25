# 一键回退绘图功能（停桥 → 还原 → 重启 → 自测）
# 用法：右键"使用 PowerShell 运行"，或在 PowerShell 里 & .\rollback-draw.ps1
$ErrorActionPreference = 'Stop'
$here = 'D:\dsh workplace\tools\dsh-pet-qq'
$ts = '20261120-1955-draw'
$persona = 'C:\Users\86189\.dsh\dsh-pet\main-config.jsonc'

"== 1. 停桥 =="
$old = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'bridge\.mjs' }
foreach ($p in $old) { Stop-Process -Id $p.ProcessId -Force; "  已停 PID $($p.ProcessId)" }
Start-Sleep -Milliseconds 800

"== 2. 还原备份 =="
Copy-Item "$here\bridge.mjs.bak-$ts" "$here\bridge.mjs" -Force
Copy-Item "$here\config.json.bak-$ts" "$here\config.json" -Force
Copy-Item "$persona.bak-$ts" $persona -Force
"  三个文件已还原到绘图前"

"== 3. 重启桥（计划任务脱离会话）=="
$nodeExe = 'C:\Users\86189\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
$bridge = "$here\bridge.mjs"
$name = 'XiyanBridgeRelaunch'
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
$a = New-ScheduledTaskAction -Execute $nodeExe -Argument ('"{0}"' -f $bridge) -WorkingDirectory $here
$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(-10)
$p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $a -Trigger $t -Principal $p -Force | Out-Null
Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 3
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
Start-Sleep -Seconds 6
$proc = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'bridge\.mjs' }
if ($proc) { $proc | ForEach-Object { "  桥已起 PID $($_.ProcessId)" } } else { "  警告：桥未起来，请手动检查" }

"== 4. 确认绘图已关 =="
Start-Sleep -Seconds 2
$log = "$here\logs\bridge.log"
Get-Content $log -Tail 30 | Select-String '绘图' | Select-Object -Last 1

"回退完成。（image-gen.mjs 与 generated/ 保留但不被加载，可手动删除）"
