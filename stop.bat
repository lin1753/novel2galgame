@echo off
echo ========================================
echo   All Novel Can Be Galgame - Stop
echo ========================================
echo.

echo Stopping API server (port 3002)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3002.*LISTEN"') do taskkill /F /PID %%a >nul 2>&1

echo Stopping Workbench (port 5173)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173.*LISTEN"') do taskkill /F /PID %%a >nul 2>&1

echo Stopping Ren'Py...
taskkill /F /IM "renpy*" >nul 2>&1

echo.
echo All services stopped.
pause
