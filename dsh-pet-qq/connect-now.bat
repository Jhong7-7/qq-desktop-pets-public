@echo off
title DSH Pet QQ - Channel B
cd /d "%~dp0"
echo.
echo   DSH Pet QQ - Channel B : one-click connect
echo   (keep the minimized SnowLuma window open)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0connect-now.ps1"
echo.
echo ============================================================
echo  Finished. You may close THIS window.
echo  SnowLuma (minimized), QQ-B and the bridge keep running.
echo ============================================================
pause >nul
