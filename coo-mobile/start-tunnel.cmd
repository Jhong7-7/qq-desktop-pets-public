@echo off
rem Legacy entry. The tunnel no longer needs a visible window: the supervisor
rem (tunnel-guard.py) runs hidden as pythonw.exe and keeps the manager alive.
rem Double-click start-guard.vbs for a completely windowless start, or use
rem this file - it forwards to the same hidden launcher and exits.
rem Whenever the domain changes, the new link is pushed to the phone and
rem tunnel-url.txt / wan-qr.png are refreshed automatically.
start "" wscript.exe //B //Nologo "%~dp0start-guard.vbs"
exit /b
