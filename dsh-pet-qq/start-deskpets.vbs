Option Explicit
' start-deskpets.vbs -- bring BOTH desktop pet hosts back after a reboot.
'
' Startup folder revives SnowLuma, the QQ clients, the bridge and the watchdog,
' but NOT the two pet apps themselves. Without them:
'   DSH host down  -> port 8726 dark, bridge logs "fetch failed" on every /chat
'   Coopanion down -> 17788 dark and nobody connects to OneBot 3001
'
' Called through run-via-explorer.ps1 so WScript and both apps belong to the
' desktop session and survive a WorkBuddy exit.
' All literals are ASCII on purpose (Windows Script Host encoding).

Dim sh, fso, here, logPath, f, exeDsh, exeCoo
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
logPath = here & "\logs\deskpets.log"
If Not fso.FolderExists(here & "\logs") Then fso.CreateFolder(here & "\logs")

Sub LogLine(msg)
    On Error Resume Next
    Set f = fso.OpenTextFile(logPath, 8, True)
    f.WriteLine Now & "  " & msg
    f.Close
    On Error Goto 0
End Sub

exeDsh = "D:\deepseek harness\DeepSeek Harness.exe"
exeCoo = "D:\coopanion\Coopanion.exe"

LogLine "--- start-deskpets invoked by desktop shell ---"

If fso.FileExists(exeDsh) Then
    sh.CurrentDirectory = "D:\deepseek harness"
    sh.Run """" & exeDsh & """", 1, False
    LogLine "DSH host started: " & exeDsh
Else
    LogLine "ERROR missing " & exeDsh
End If

WScript.Sleep 3000

If fso.FileExists(exeCoo) Then
    sh.CurrentDirectory = "D:\coopanion"
    sh.Run """" & exeCoo & """", 1, False
    LogLine "Coopanion started: " & exeCoo
Else
    LogLine "ERROR missing " & exeCoo
End If

LogLine "done; expect 8726 (dsh-pet) and 17788 + 3001 client (Coo) within ~30s"
