Option Explicit
' DeskPets.vbs -- Startup folder entry, idempotent.
'
' Reboots used to leave both pet hosts down: the startup folder revived
' SnowLuma, the QQ clients, the bridge and the watchdog, but NOT the two
' pet apps. Without them the DSH /chat host and Coo WebUI 17788 stay dark.
'
' Startup folder items already run in the desktop session, so no
' run-via-explorer.ps1 proxy is needed here.
' Each app is started only when its process is missing, to avoid a second
' Electron instance when the user already launched it manually.
' All literals are ASCII on purpose (Windows Script Host encoding).

Dim sh, fso, logDir, logPath, f, exeDsh, exeCoo
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
logDir = "D:\dsh workplace\tools\dsh-pet-qq\logs"
logPath = logDir & "\deskpets.log"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)

Sub LogLine(msg)
    On Error Resume Next
    Set f = fso.OpenTextFile(logPath, 8, True)
    f.WriteLine Now & "  " & msg
    f.Close
    On Error Goto 0
End Sub

Function IsRunning(img)
    Dim wmi, col
    On Error Resume Next
    Set wmi = GetObject("winmgmts:\\.\root\cimv2")
    Set col = wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name = '" & img & "'")
    If Err.Number <> 0 Then
        IsRunning = False
    Else
        IsRunning = (col.Count > 0)
    End If
    On Error Goto 0
End Function

exeDsh = "D:\deepseek harness\DeepSeek Harness.exe"
exeCoo = "D:\coopanion\Coopanion.exe"

LogLine "--- DeskPets startup invoked by desktop shell ---"

If IsRunning("DeepSeek Harness.exe") Then
    LogLine "DSH already running, skip"
ElseIf fso.FileExists(exeDsh) Then
    sh.CurrentDirectory = "D:\deepseek harness"
    sh.Run """" & exeDsh & """", 1, False
    LogLine "DSH host started: " & exeDsh
Else
    LogLine "ERROR missing " & exeDsh
End If

WScript.Sleep 3000

If IsRunning("Coopanion.exe") Then
    LogLine "Coopanion already running, skip"
ElseIf fso.FileExists(exeCoo) Then
    sh.CurrentDirectory = "D:\coopanion"
    sh.Run """" & exeCoo & """", 1, False
    LogLine "Coopanion started: " & exeCoo
Else
    LogLine "ERROR missing " & exeCoo
End If

LogLine "done; bridge auto-discovers the drifting dsh-pet port"
