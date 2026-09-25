@echo off
setlocal
title BTC Monitor
cd /d "%~dp0"
echo ============================================================
echo   BTC MONITOR - Bitcoin Live Educational Pro Chart
echo   Le tableau de bord s'ouvre dans le navigateur.
echo   Gardez cette fenetre ouverte pendant le direct (fermer = arreter).
echo ============================================================
echo.
if exist "BTC-Monitor.exe" (
  "BTC-Monitor.exe" %*
  goto :end
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe et BTC-Monitor.exe est absent.
  echo Installez Node.js ^(https://nodejs.org^) ou recuperez BTC-Monitor.exe, puis relancez.
  start "" https://nodejs.org/
  goto :end
)
if not exist "node_modules\ws" (
  echo Installation des dependances ^(une seule fois^)...
  call npm install --omit=dev --no-audit --no-fund
)
node server\index.js --open %*
:end
echo.
pause
