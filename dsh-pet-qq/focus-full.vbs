' focus-full.vbs -- force FULL mode: restore all background worlds and the
' pets' proactive chatter. Use this when you leave the PC without locking it,
' or when watching a long video (no keyboard/mouse input would look "away").
' Applies immediately (-Apply); no background daemon needed.
CreateObject("WScript.Shell").Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""D:\dsh workplace\tools\dsh-pet-qq\focus-mode.ps1"" -Apply full", 0, False
