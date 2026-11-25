' One-shot launcher, opened by explorer.exe from the desktop button.
' explorer makes WScript belong to the desktop session, so the pet apps
' and bridge it starts are NOT children of an agent/terminal session and
' will not be reaped when that session exits.
' Nothing here loops or watches -- it calls the one-shot script once.
Option Explicit
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\dsh workplace\tools\dsh-pet-qq"
sh.Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""D:\dsh workplace\tools\dsh-pet-qq\start-pets-once.ps1""", 0, False
