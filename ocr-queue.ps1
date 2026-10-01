# Runs every OCR job until nothing is left, appending to ocr.log.
# Started by the "openbook-ocr" scheduled task (at logon and hourly), so it
# comes back after a crash or restart. Only one copy runs at a time; each job
# skips finished documents, so restarting is always safe.
# When everything is done it writes ocr-finished.txt and removes the task.
# Stop for good:  Unregister-ScheduledTask openbook-ocr -Confirm:$false
#                 then end the python processes running ocr-stored.py
Set-Location $PSScriptRoot
if (Test-Path ocr-finished.txt) { exit }

$lock = 'ocr-queue.pid'
if (Test-Path $lock) {
    $old = Get-Content $lock -ErrorAction SilentlyContinue
    if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'powershell' })) { exit }
}
$PID | Set-Content $lock

$env:SUPABASE_URL = [Environment]::GetEnvironmentVariable('SUPABASE_URL', 'User')
$env:SUPABASE_SERVICE_KEY = [Environment]::GetEnvironmentVariable('SUPABASE_SERVICE_KEY', 'User')

# Pass 1 does the work; later passes retry documents that errored.
foreach ($pass in 1..3) {
    foreach ($job in @('--scanned-only', '--from-ag', '')) {
        Add-Content ocr.log "--- $(Get-Date -Format s) pass ${pass}: ocr-stored.py $job ---"
        cmd /c "python -u ocr-stored.py $job --workers 10 >> ocr.log 2>&1"
    }
}
Add-Content ocr.log "--- $(Get-Date -Format s) ALL JOBS FINISHED ---"
Get-Date -Format s | Set-Content ocr-finished.txt
Remove-Item $lock -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName openbook-ocr -Confirm:$false -ErrorAction SilentlyContinue
