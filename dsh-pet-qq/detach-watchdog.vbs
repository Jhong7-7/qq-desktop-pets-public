Option Explicit
' Called through explorer.exe ShellExecute (see run-via-explorer.ps1).
' explorer is the desktop shell and does NOT belong to the WorkBuddy job,
' so anything started from here survives after WorkBuddy exits.
'
' Chain: explorer.exe -> WScript.exe -> powershell.exe (adopt-desktop-session.ps1)
'        -> WScript.exe -> powershell.exe (watchdog.ps1)
' All of it is desktop-session owned. No window (0 = SW_HIDE).
Dim fso, sh, here, ps1, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\adopt-desktop-session.ps1"
sh.CurrentDirectory = here
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
sh.Run cmd, 0, False
