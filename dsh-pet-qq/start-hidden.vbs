' dsh-pet-qq 无窗口启动：给 connect-qq.ps1 / connect-qq-b.ps1 / 登录启动项用。
' 可选第一个参数是配置文件名（相对本目录），例如：wscript //B start-hidden.vbs config.channel-a.json
Option Explicit
Dim fso, sh, here, bridge, nodeExe, args
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
bridge = here & "\bridge.mjs"

args = ""
If WScript.Arguments.Count > 0 Then
  args = " --config """ & WScript.Arguments(0) & """"
End If

nodeExe = "node"
' PATH 里没有 node 时退到 SnowLuma 自带的 v24
If sh.Run("cmd /c where node >nul 2>nul", 0, True) <> 0 Then
  nodeExe = "C:\Users\86189\SnowLuma\runtime\node-v24.22.1-win-x64\node.exe"
End If

sh.CurrentDirectory = here
sh.Run """" & nodeExe & """ """ & bridge & """" & args, 0, False

' Windows 11 默认终端 = Windows Terminal 时，WT 会以 -Embedding 接管控制台
' 进程并忽略上面的 0(SW_HIDE)，桌面仍会弹出黑窗。启动后跑 hide-console.ps1
' 用 ShowWindow(SW_HIDE) 收掉窗口，只隐藏、不结束 bridge 进程。
WScript.Sleep 1200
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\hide-console.ps1""", 0, False
