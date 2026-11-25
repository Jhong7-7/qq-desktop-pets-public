Option Explicit
' Auto-start SnowLuma WINDOWLESS at logon.
' SnowLuma owns 5099 (WebUI), 3000/3001 (Coo channel A) and 3010/3011
' (channel B = the desk-pet QQ OneBot WS). Keep it running.
' 0 = SW_HIDE, so no console window appears on the taskbar.
'
' Launch the bundled Node entry point DIRECTLY instead of start.bat.
' start.bat -> launcher.bat runs a node version check and ends with "pause";
' under SW_HIDE (and when launched from a non-interactive session) that can
' stall, leaving all five ports down. This is the exact same command as
' start-snowluma-hidden.vbs, verified working on 2026-11-09 00:53.
' No admin rights, no task scheduler. Delete this file to disable.
' Previous (start.bat) version backed up to
' D:\wb\_startup-backup-20261108\SnowLuma.vbs.bak-20261109-0055
Dim sh, appDir, nodeExe, cmd
Set sh = CreateObject("WScript.Shell")
nodeExe = "C:\Users\86189\SnowLuma\runtime\node-v24.22.1-win-x64\node.exe"
appDir  = "C:\Users\86189\SnowLuma\app"
sh.Environment("Process")("PATH") = "C:\Users\86189\SnowLuma\runtime\node-v24.22.1-win-x64;" & sh.Environment("Process")("PATH")
sh.CurrentDirectory = appDir
cmd = """" & nodeExe & """ ""./index.mjs"""
sh.Run cmd, 0, False
