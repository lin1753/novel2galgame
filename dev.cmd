@echo off
title Novel2Galgame - Dev Servers
cd /d "%~dp0"

echo ================================
echo   All Novel Can Be Galgame
echo   Dev Server Launcher
echo ================================

:: Kill existing processes on the ports
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3002 " ^| findstr "LISTENING" 2^>nul') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173 " ^| findstr "LISTENING" 2^>nul') do taskkill /F /PID %%a >nul 2>&1
timeout /t 2 /nobreak >nul

echo.
echo [1/2] Starting API server on http://localhost:3002 ...
start "API Server" cmd /k "cd /d %~dp0apps\api && set DATA_DIR=D:\Project\novel2glagame\data && npx tsx watch src\index.ts"

timeout /t 3 /nobreak >nul

echo [2/2] Starting Workbench on http://localhost:5173 ...
start "Workbench" cmd /k "cd /d %~dp0apps\workbench && npx vite --port 5173"

timeout /t 2 /nobreak >nul

echo.
echo ================================
echo   Servers starting...
echo   API:      http://localhost:3002
echo   Workbench: http://localhost:5173
echo ================================
echo.

start http://localhost:5173
pause
