@echo off
echo ========================================
echo   All Novel Can Be Galgame - Start
echo ========================================
echo.

echo [1/2] Starting API server (port 3002)...
cd /d "%~dp0apps\api"
start "API Server" cmd /c "npx tsx src/index.ts"
timeout /t 4 /nobreak >nul

echo [2/2] Starting Workbench (port 5173)...
cd /d "%~dp0apps\workbench"
start "Workbench" cmd /c "npx vite --port 5173"
timeout /t 3 /nobreak >nul

echo.
echo ========================================
echo   All services started!
echo   API:  http://localhost:3002
echo   App:  http://localhost:5173
echo ========================================
echo.
pause
