' start-bridge-hidden.vbs —— 用隐藏窗口启动桥（Task Scheduler 拉起本脚本）。
' 目的：桥常驻桌面会话、但不在桌面留黑色命令行窗口。
' 直接指定 WorkBuddy 自带 node，避免 where node 在不同 PATH 下取到不同版本。
Option Explicit
Dim fso, sh, here, bridge, nodeExe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
bridge = here & "\bridge.mjs"
nodeExe = "C:\Users\86189\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"
sh.CurrentDirectory = here
' 第二个参数 0 = 隐藏窗口；False = 不等待
sh.Run """" & nodeExe & """ """ & bridge & """", 0, False

' Windows 11 把 Windows Terminal 设为默认终端时，控制台进程会被 WT 以
' -Embedding 接管，上面的 0(SW_HIDE) 会被忽略，桌面仍会弹出黑色命令行窗口。
' 等窗口出现后跑 hide-console.ps1 做 ShowWindow(SW_HIDE)：只收窗口，
' 绝不结束 bridge 进程（与 hide-console.ps1 / README 的约定一致）。
WScript.Sleep 1200
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\hide-console.ps1""", 0, False
