Option Explicit
' start-watchdog-desktop.vbs -- relaunch watchdog.ps1 via explorer ShellExecute.
'
' explorer.exe is the desktop shell, so WScript and the PowerShell watchdog
' it starts belong to the user logon session and survive a WorkBuddy exit.
' ASCII-only on purpose: Windows Script Host reads .vbs as ANSI.
'
' Use this instead of adopt-desktop-session.ps1 (full migration) when QQ is
' already healthy: restarting SnowLuma would break injection of the QQ
' processes that are already running.

Dim sh, fso, here, ps1, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = "D:\dsh workplace\tools\dsh-pet-qq"
ps1 = here & "\watchdog.ps1"
If Not fso.FileExists(ps1) Then WScript.Quit 1
sh.CurrentDirectory = here
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
sh.Run cmd, 0, False
