' Relaunch the two pet hosts in the desktop session, no daemon.
' WScript here is launched by explorer.exe, so the Electron apps it starts
' belong to the user logon session and survive a WorkBuddy exit.
Option Explicit
Dim sh, exeDsh, exeCoo
Set sh = CreateObject("WScript.Shell")

exeDsh = "D:\deepseek harness\DeepSeek Harness.exe"
exeCoo = "D:\coopanion\Coopanion.exe"

sh.CurrentDirectory = "D:\deepseek harness"
sh.Run """" & exeDsh & """", 1, False
WScript.Sleep 3000
sh.CurrentDirectory = "D:\coopanion"
sh.Run """" & exeCoo & """", 1, False
