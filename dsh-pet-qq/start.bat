@echo off
rem dsh-pet-qq 前台启动（能看见日志，调试用）。日常用 start-hidden.vbs 或「连接QQ」。
setlocal
set "HERE=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  set "NODEEXE=C:\Users\86189\SnowLuma\runtime\node-v24.22.1-win-x64\node.exe"
) else (
  set "NODEEXE=node"
)
"%NODEEXE%" "%HERE%bridge.mjs" %*
if errorlevel 1 pause
