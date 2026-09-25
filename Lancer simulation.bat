@echo off
setlocal
title BTC Monitor (simulation)
cd /d "%~dp0"
echo ============================================================
echo   BTC MONITOR - mode SIMULATION (marche synthetique, sans internet)
echo ============================================================
echo.
if exist "BTC-Monitor.exe" (
  "BTC-Monitor.exe" --sim %*
  goto :end
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe et BTC-Monitor.exe est absent.
  start "" https://nodejs.org/
  goto :end
)
if not exist "node_modules\ws" call npm install --no-audit --no-fund
node server\index.js --sim --open %*
:end
echo.
pause
