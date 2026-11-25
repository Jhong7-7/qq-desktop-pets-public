@echo off
title DSH Pet QQ - Rebuild Channel B
cd /d "%~dp0"
echo.
echo   Rebuild QQ channel B: SnowLuma -^> OneBot 3011 -^> bridge -^> dsh-pet
echo   (keep the minimized SnowLuma window open)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rebuild-qq.ps1"
echo.
echo ============================================================
echo  Finished. You may close THIS window.
echo  SnowLuma (minimized), QQ-B and the bridge keep running.
echo ============================================================
pause >nul
