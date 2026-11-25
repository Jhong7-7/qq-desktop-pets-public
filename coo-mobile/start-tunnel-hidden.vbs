Option Explicit
' Launch the Coopanion tunnel SUPERVISOR detached from the agent session.
' All paths are derived at runtime: no non-ASCII literals in this file, so
' Windows Script Host never has to guess the encoding of a Chinese folder name.
Dim fso, sh, here, py, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
py = "C:\Users\86189\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe"
If Not fso.FileExists(py) Then
    py = "C:\Users\86189\AppData\Local\Programs\Python\Python310\pythonw.exe"
End If
cmd = """" & py & """ """ & here & "\tunnel-guard.py"""
sh.Run cmd, 0, False
