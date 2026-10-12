@echo off
powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\desktop-tray.ps1" -ConsoleMode
if errorlevel 1 pause
