@echo off
setlocal
rem Start Coopanion with the phone-facing pet service enabled.
rem Core's WebUI on 17788 stays on 127.0.0.1 on purpose.

set "COOPANION_PET_BIND=0.0.0.0"
set "COOPANION_PET_MOBILE_TOKEN=YOUR_ACCESS_TOKEN_HERE"

powershell -NoProfile -Command "if (Get-Process Coopanion -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
  echo Coopanion is already running. Quit it from the tray first, then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Coopanion phone mode
powershell -NoProfile -Command "$ip=(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress; if (-not $ip) { $ip='127.0.0.1' }; Write-Output ('  Phone URL: http://' + $ip + ':7797/pet?m=' + $env:COOPANION_PET_MOBILE_TOKEN)"
echo   Text chat works now. Microphone needs HTTPS; ASR/TTS are still off.
echo.
echo   To see the full check result: double-click check-mobile.cmd in this folder.
echo.

start "" "D:\coopanion\Coopanion.exe"
echo   Coopanion is starting. This window closes in 12 seconds.
timeout /t 12 >nul
endlocal
