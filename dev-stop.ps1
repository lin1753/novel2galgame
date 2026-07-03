# Novel2Galgame - Stop Dev Servers

@("3002", "5173") | ForEach-Object {
    $pids = netstat -ano | Select-String ":$_\s" | Select-String "LISTENING" | ForEach-Object {
        ($_ -split '\s+')[-1]
    } | Where-Object { $_ -and $_ -ne '0' }
    foreach ($p in $pids) {
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped port $_ (PID $p)"
    }
}
Write-Host "All dev servers stopped."
