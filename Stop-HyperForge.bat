@echo off
setlocal
title Stop HyperForge
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-hyperforge.ps1"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
    echo.
    echo HyperForge failed to stop.
    pause
) else (
    rem Keep the message visible for a moment when launched by double-click.
    ping -n 3 127.0.0.1 >nul
)
endlocal & exit /b %RESULT%
