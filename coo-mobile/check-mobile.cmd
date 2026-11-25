@echo off
rem Double-click this to see the phone-entry check result. The window stays open,
rem and the same output is saved to verify-result.txt next to this file.
cd /d "%~dp0"
python "%~dp0verify-mobile.py" > "%~dp0verify-result.txt" 2>&1
type "%~dp0verify-result.txt"
echo.
echo  ----------------------------------------------------------
echo   Result saved to: %~dp0verify-result.txt
echo   Phone page: scan mobile-qr.png, or copy the Phone URL above.
echo  ----------------------------------------------------------
echo.
pause
