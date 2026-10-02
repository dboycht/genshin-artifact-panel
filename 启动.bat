@echo off
rem ============================================================
rem  genshin-artifact-panel - one-click launcher
rem  NOTE: keep this file pure ASCII. Chinese text in .bat files
rem        breaks under some Windows code pages.
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] Node.js not found in PATH.
  echo  Please install Node.js 18 or newer: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo Starting local server, the browser will open automatically...
echo Close this window (or press Ctrl+C) to stop.
echo.
node server\server.mjs

if errorlevel 1 (
  echo.
  echo  [ERROR] Server exited abnormally. See messages above.
  pause
)
endlocal
