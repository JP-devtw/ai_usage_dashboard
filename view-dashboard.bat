@echo off
rem Quick-view launcher: start server only if not already running, then open browser.
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:3789/)|Out-Null;exit 0}catch{exit 1}"
if errorlevel 1 (
  start "AI Usage Dashboard Server" /min cmd /c "cd /d "%~dp0" & node server.js"
  timeout /t 2 >nul
)
start "" http://127.0.0.1:3789
