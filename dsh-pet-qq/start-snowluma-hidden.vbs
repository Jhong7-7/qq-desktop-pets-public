Option Explicit
' Launch SnowLuma WINDOWLESS; used by watchdog.ps1 / reconnect-all.ps1
' SnowLuma owns 5099 (WebUI), 3000/3001 (Coo channel A) and 3010/3011
' (channel B = desk-pet QQ OneBot WS). Keep it running.
'
' Do NOT go through start.bat / launcher.bat here: those run a node version
' check and end with "pause", which can stall under SW_HIDE. Launch the exact
' entry point directly, the same way start-hidden.vbs launches the bridge.
' Bundled Node 24.22.1 is prepended to PATH so child spawns resolve too.
' 0 = SW_HIDE, so no console window appears on the taskbar.
Dim sh, appDir, nodeExe, cmd
Set sh = CreateObject("WScript.Shell")
nodeExe = "C:\Users\86189\SnowLuma\runtime\node-v24.22.1-win-x64\node.exe"
appDir  = "C:\Users\86189\SnowLuma\app"
sh.Environment("Process")("PATH") = "C:\Users\86189\SnowLuma\runtime\node-v24.22.1-win-x64;" & sh.Environment("Process")("PATH")
sh.CurrentDirectory = appDir
cmd = """" & nodeExe & """ ""./index.mjs"""
sh.Run cmd, 0, False
