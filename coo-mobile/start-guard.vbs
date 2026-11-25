Option Explicit
' Double-click this ONCE to start the always-on Coopanion tunnel supervisor.
' No console window will appear: the guard, the tunnel manager, cloudflared
' and the SSH fallback all run hidden. Logs go to guard.log / tunnel.log.
' Every literal here is ASCII; the folder path (which contains Chinese
' characters) is derived at runtime, so WSH never has to guess an encoding.
' Delete or ignore this file if you do not want the tunnel to auto-recover.
Dim sh, fso, here, py, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
py = "C:\Users\86189\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe"
If Not fso.FileExists(py) Then
    py = "C:\Users\86189\AppData\Local\Programs\Python\Python310\pythonw.exe"
End If
cmd = """" & py & """ """ & here & "\tunnel-guard.py"""
sh.Run cmd, 0, False
