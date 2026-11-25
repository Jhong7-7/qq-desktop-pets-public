' focus-auto.vbs -- clear the manual override and return to automatic
' detection (idle >= 5 min or locked session -> FULL, otherwise QUIET).
CreateObject("WScript.Shell").Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""D:\dsh workplace\tools\dsh-pet-qq\focus-mode.ps1"" -Set auto", 0, False
