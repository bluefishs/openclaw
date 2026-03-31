@echo off
chcp 65001 >nul 2>&1
REM CK_OpenClaw Auto Startup Script
REM Install: Win+R > shell:startup > shortcut to this file
REM Or: Run scripts\install-startup-task.bat as admin

set SCRIPT_DIR=%~dp0
set LOG_DIR=%SCRIPT_DIR%..\logs
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo [%date% %time%] CK_OpenClaw startup initiated >> "%LOG_DIR%\startup.log"

REM 1. Wait for Docker Desktop
echo Waiting for Docker Desktop...
:wait_docker
docker info >nul 2>&1
if errorlevel 1 (
  timeout /t 10 /nobreak >nul
  goto wait_docker
)
echo Docker Desktop ready.
echo [%date% %time%] Docker Desktop ready >> "%LOG_DIR%\startup.log"

REM 2. Wait for gateway container healthy
echo Waiting for openclaw_engine...
:wait_container
for /f "tokens=*" %%i in ('docker inspect openclaw_engine --format "{{.State.Health.Status}}" 2^>nul') do set HEALTH=%%i
if not "%HEALTH%"=="healthy" (
  timeout /t 10 /nobreak >nul
  goto wait_container
)
echo openclaw_engine is healthy.
echo [%date% %time%] openclaw_engine healthy >> "%LOG_DIR%\startup.log"

REM 3. Verify Tailscale Funnel (LINE webhook)
echo Checking Tailscale Funnel...
tailscale status >nul 2>&1
if errorlevel 1 (
  echo WARNING: Tailscale not running! LINE webhook will be unreachable.
  echo [%date% %time%] WARNING: Tailscale not running >> "%LOG_DIR%\startup.log"
) else (
  echo Tailscale active.
  echo [%date% %time%] Tailscale active >> "%LOG_DIR%\startup.log"
)

REM 4. Verify LINE webhook URL (Tailscale Funnel)
echo Verifying LINE webhook...
bash "%SCRIPT_DIR%update-line-webhook.sh" >> "%LOG_DIR%\startup.log" 2>&1

REM 5. Start watchdog background
echo Starting watchdog...
start /B "" bash "%SCRIPT_DIR%watchdog.sh" --loop >> "%LOG_DIR%\watchdog-bg.log" 2>&1

echo [%date% %time%] Startup complete >> "%LOG_DIR%\startup.log"
echo.
echo ====================================
echo   CK_OpenClaw startup complete!
echo   Watchdog running in background.
echo ====================================
timeout /t 5
