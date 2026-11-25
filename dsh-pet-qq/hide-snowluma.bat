@echo off
title Hide SnowLuma console
cd /d "%~dp0"
echo.
echo   Hide the SnowLuma console window WITHOUT stopping it.
echo   Ports 5099 / 3000 / 3001 / 3010 / 3011 stay online.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hide-snowluma.ps1"
echo.
pause >nul
