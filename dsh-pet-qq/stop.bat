@echo off
rem Stop the dsh-pet-qq bridge (matches the 7341 instance-lock owner; see stop.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
