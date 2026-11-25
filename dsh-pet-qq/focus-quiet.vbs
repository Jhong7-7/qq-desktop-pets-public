' focus-quiet.vbs -- force QUIET mode: PC in use, pets stay silent but still
' answer QQ messages. Applies immediately (-Apply); no background daemon needed.
' Drop a shortcut to this file on the desktop if you want a one-click switch.
CreateObject("WScript.Shell").Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""D:\dsh workplace\tools\dsh-pet-qq\focus-mode.ps1"" -Apply quiet", 0, False
