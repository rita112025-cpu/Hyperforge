@echo off
setlocal
title HyperForge
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-hyperforge.ps1"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
    echo.
    echo HyperForge failed to start.
    pause
)
endlocal & exit /b %RESULT%
