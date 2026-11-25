@echo off
title DSH Pet QQ - Keep Alive
cd /d "%~dp0"
echo.
echo   Keep the QQ bridge alive in your desktop session.
echo   The watchdog checks port 7341 every 20s and restarts the bridge if it dies.
echo   Safe to run repeatedly; it does NOT disconnect anything.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0keep-alive.ps1"
echo.
echo ============================================================
echo  Done. You may close THIS window; the watchdog keeps running.
echo ============================================================
pause >nul
