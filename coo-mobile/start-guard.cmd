@echo off
rem Legacy shortcut. Double-click start-guard.vbs instead: it launches the
rem supervisor with NO console window at all. This .cmd only forwards to it
rem and exits, so the black box disappears immediately.
start "" wscript.exe //B //Nologo "%~dp0start-guard.vbs"
exit /b
