@echo off
REM Build & start the Burpsuite-AI sidecar on Windows.
REM Usage:  sidecar-setup.bat   (npm ci + build)
REM         sidecar-setup.bat start  (start sidecar on 127.0.0.1:8570)
setlocal
cd /d "%~dp0..\sidecar"

if "%1"=="start" goto start
if "%1"=="test" goto test

echo [1/2] installing dependencies...
call npm ci
if errorlevel 1 exit /b 1
echo [2/2] building (creates dist/index.js)...
call npm run build
if errorlevel 1 exit /b 1
echo.
echo Done. dist/index.js created.
echo.
echo Next:
echo   - Run:        sidecar-setup.bat start
echo   - Or load the extension jar in Burp and click "Start sidecar"
goto :eof

:test
call npm test
goto :eof

:start
if not exist "dist\index.js" (
  echo dist/index.js missing - run sidecar-setup.bat first
  exit /b 1
)
echo Starting sidecar on 127.0.0.1:8570...
call node dist\index.js
endlocal
