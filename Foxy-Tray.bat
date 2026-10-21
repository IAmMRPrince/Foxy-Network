@echo off
start powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0packages\foxy-daemon\bin\foxy-tray.ps1"
exit
