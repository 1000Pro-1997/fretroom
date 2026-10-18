@echo off
setlocal
cd /d "%~dp0"

if exist "release\fretroom.exe" goto launch

where npm >nul 2>&1
if errorlevel 1 (
  echo The app is not built yet. Install Node.js from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\electron-builder\cli.js" (
  call npm install
  if errorlevel 1 goto failed
)
call npm run package:win
if errorlevel 1 goto failed

:launch
start "" "%~dp0release\fretroom.exe"
exit /b 0

:failed
echo Could not build the app. Check the error above.
pause
exit /b 1
