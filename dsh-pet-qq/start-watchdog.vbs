' dsh-pet-qq 看门狗无窗口启动入口（给 keep-alive.ps1 / rebuild-qq.ps1 / 登录启动项用）。
' 用 wscript 中转一层，让 watchdog.ps1 与调用方进程树脱钩。
Option Explicit
Dim fso, sh, here, ps1, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\watchdog.ps1"
sh.CurrentDirectory = here
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
sh.Run cmd, 0, False
