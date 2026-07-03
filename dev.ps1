# Novel2Galgame - Dev Server Launcher
# 双击运行，自动打开浏览器

Write-Host "================================" -ForegroundColor Cyan
Write-Host "  All Novel Can Be Galgame" -ForegroundColor Cyan
Write-Host "  Dev Server Launcher" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Kill existing processes on ports
@("3002", "5173") | ForEach-Object {
    $pids = netstat -ano | Select-String ":$_\s" | Select-String "LISTENING" | ForEach-Object {
        ($_ -split '\s+')[-1]
    } | Where-Object { $_ -and $_ -ne '0' }
    foreach ($p in $pids) {
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        Write-Host "Killed process $p on port $_"
    }
}
Start-Sleep -Seconds 2

Write-Host "`n[1/2] Starting API server on http://localhost:3002 ..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\apps\api'; `$env:DATA_DIR='D:\Project\novel2glagame\data'; npx tsx watch src\index.ts"
) -WindowStyle Normal

Start-Sleep -Seconds 3

Write-Host "[2/2] Starting Workbench on http://localhost:5173 ..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\apps\workbench'; npx vite --port 5173"
) -WindowStyle Normal

Start-Sleep -Seconds 3

Write-Host "`n================================" -ForegroundColor Green
Write-Host "  Both servers started!" -ForegroundColor Green
Write-Host "  API:       http://localhost:3002" -ForegroundColor Green
Write-Host "  Workbench: http://localhost:5173" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green

Start-Process "http://localhost:5173"
