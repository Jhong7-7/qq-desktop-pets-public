Option Explicit
' start-qq-clients.vbs -- bring BOTH QQ clients back after a reboot.
'
' SnowLuma only injects QQ processes that appear AFTER it started, so this
' must run once SnowLuma (5099) is already online. Launch order:
'   D:\QQ.exe      = channel A (Coo / 泡泡, uin 30027) -> 3000/3001
'   D:\QQ-B\QQ.exe = channel B (dsh-pet 溪颜, uin 10001) -> 3010/3011
'
' Called through run-via-explorer.ps1 so WScript and both QQ processes belong
' to the desktop session and survive a WorkBuddy exit.
' All literals are ASCII on purpose (Windows Script Host encoding).

Dim sh, fso, here, logPath, f, exeA, exeB
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
logPath = here & "\logs\qq-clients.log"
If Not fso.FolderExists(here & "\logs") Then fso.CreateFolder(here & "\logs")

Sub LogLine(msg)
    On Error Resume Next
    Set f = fso.OpenTextFile(logPath, 8, True)
    f.WriteLine Now & "  " & msg
    f.Close
    On Error Goto 0
End Sub

exeA = "D:\QQ.exe"
exeB = "D:\QQ-B\QQ.exe"

LogLine "--- start-qq-clients invoked by desktop shell ---"

If fso.FileExists(exeA) Then
    sh.CurrentDirectory = "D:\"
    sh.Run """" & exeA & """", 1, False
    LogLine "channel A QQ started: " & exeA
Else
    LogLine "ERROR missing " & exeA
End If

WScript.Sleep 4000

If fso.FileExists(exeB) Then
    sh.CurrentDirectory = "D:\QQ-B"
    sh.Run """" & exeB & """", 1, False
    LogLine "channel B QQ started: " & exeB
Else
    LogLine "ERROR missing " & exeB
End If

LogLine "done; SnowLuma should inject both within ~10-30s"
