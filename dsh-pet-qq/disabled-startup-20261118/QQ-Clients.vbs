Option Explicit
' QQ-Clients.vbs -- Startup folder entry.
'
' Reboots used to leave both QQ channels dark: the startup folder revived
' SnowLuma, Coopanion, the bridge and the watchdog, but NOT the two QQ
' clients. SnowLuma can only inject QQ processes that appear after itself,
' so 3001 (Coo) and 3011 (fish) never came up.
'
' This hands start-qq-clients.ps1 to PowerShell hidden. That script waits
' for SnowLuma 5099 first, then starts only the client whose port is down.
' Startup items run in the desktop session, so no WorkBuddy dependency.
'
' Delete this file to disable the automatic QQ client start.

Dim sh, fso, base, ps1, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = "D:\dsh workplace\tools\dsh-pet-qq"
ps1 = base & "\start-qq-clients.ps1"
If Not fso.FileExists(ps1) Then WScript.Quit 1
sh.CurrentDirectory = base
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
sh.Run cmd, 0, False
