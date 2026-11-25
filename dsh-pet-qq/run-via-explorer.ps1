<#
run-via-explorer.ps1 -- Execute a VBS through the desktop shell.

Why: processes created directly from a WorkBuddy tool session are killed when
WorkBuddy exits. explorer.exe is the desktop shell (owned by the user logon
session), so handing a .vbs to explorer makes WScript and everything it starts
belong to the desktop session instead.

Usage:
  powershell -ExecutionPolicy Bypass -File .\run-via-explorer.ps1
  powershell -ExecutionPolicy Bypass -File .\run-via-explorer.ps1 -Vbs .\some.vbs

Default target is detach-watchdog.vbs, which re-parents the QQ watchdog.
#>
param([string]$Vbs = '')

$root = $PSScriptRoot
if (-not $Vbs) { $Vbs = Join-Path $root 'detach-watchdog.vbs' }
if (-not (Test-Path $Vbs)) { throw "VBS not found: $Vbs" }

# ShellExecute via explorer: the WScript host becomes a child of explorer,
# not of this tool session. explorer returns immediately.
Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$Vbs`"" -WindowStyle Hidden
Write-Host "已交给 explorer 执行：$Vbs"
Write-Host "结果看 logs\desktop-session.log（约 5 秒内出现）"
