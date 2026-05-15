# Start Mailbin frontend dev server and open browser
Write-Host "Starting Mailbin frontend at http://127.0.0.1:5174 ..." -ForegroundColor Cyan
Set-Location -LiteralPath "$PSScriptRoot/frontend"
npx vite --open --host 127.0.0.1 --port 5174 --strictPort
