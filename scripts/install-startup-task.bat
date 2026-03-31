@echo off
chcp 65001 >nul 2>&1
REM Install Windows Task Scheduler tasks for CK_OpenClaw
REM Run as Administrator

echo Installing CK_OpenClaw scheduled tasks...

REM 1. Startup on logon (60s delay for Docker Desktop)
schtasks /Create /TN "CK_OpenClaw\Startup" ^
  /TR "cmd /c \"%~dp0startup.bat\"" ^
  /SC ONLOGON ^
  /DELAY 0001:00 ^
  /RL HIGHEST ^
  /F
echo [OK] Startup task created (triggers on logon with 60s delay)

REM 2. Watchdog every 5 minutes (backup)
schtasks /Create /TN "CK_OpenClaw\Watchdog" ^
  /TR "bash \"%~dp0watchdog.sh\"" ^
  /SC MINUTE /MO 5 ^
  /F
echo [OK] Watchdog task created (every 5 minutes)

echo.
echo Done! Verify with: schtasks /Query /TN "CK_OpenClaw\Startup"
pause
