Option Explicit
' Auto-start the Coopanion tunnel SUPERVISOR at logon.
' The guard launches and revives start-tunnel.py by itself; both are
' windowless, and neither needs admin rights nor the task scheduler.
' Every literal here is ASCII: the Chinese folder name is assembled with
' ChrW so Windows Script Host never has to guess this file's encoding.
' Delete this file to disable the automatic tunnel.
Dim sh, fso, base, folder, py, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = "D:\wb\"
folder = "coo" & ChrW(&H624B) & ChrW(&H673A) & ChrW(&H5316)
base = base & folder
py = "C:\Users\86189\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe"
If Not fso.FileExists(py) Then
    py = "C:\Users\86189\AppData\Local\Programs\Python\Python310\pythonw.exe"
End If
sh.CurrentDirectory = base
cmd = """" & py & """ """ & base & "\tunnel-guard.py"""
sh.Run cmd, 0, False
