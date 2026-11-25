@echo off
rem One-click reconnect for BOTH QQ channels (Coo + dsh-pet fish).
rem Safe to run repeatedly; it only revives missing services and reloads the watchdog.
rem -ForceReloadWatchdog re-parents the watchdog into this desktop session so it
rem survives after the chat/tool session that started it is closed.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0reconnect-all.ps1" -ForceReloadWatchdog
echo.
pause
