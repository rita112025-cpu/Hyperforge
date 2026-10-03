$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$probeUrl = 'http://127.0.0.1:3000'
$logPath = Join-Path $repoRoot '.logs\hyperforge-dev.log'
$pidPath = Join-Path $repoRoot '.logs\hyperforge.pid'
$mutex = $null
$locked = $false

. (Join-Path $PSScriptRoot 'hyperforge-common.ps1')

function Stop-ProcessTree {
    param([int]$ProcessId)
    # Never kill by image name: only this PID and its descendants.
    & cmd.exe /d /c "taskkill.exe /PID $ProcessId /T /F >nul 2>&1"
}

try {
    # Share the lock with Start so a stop cannot interleave with a start.
    $mutex = New-Object System.Threading.Mutex($false, 'Local\HyperForgeLauncherPort3000')
    try { $locked = $mutex.WaitOne(60000) }
    catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'A HyperForge launcher is still busy. Try again shortly.' }

    $targets = @(Get-ValidPidTargets)
    if ($targets.Count -eq 0) {
        if (Clear-StalePidFile) { Write-Host 'Removed stale PID file (its process is gone or was reused by another program).' }
        # No usable PID file: fall back to a listener that is verifiably this repo's Next dev server.
        $pair = Get-VerifiedListenerPair
        if ($pair) { $targets = @($pair.Root, $pair.Listener) }
    }

    if ($targets.Count -eq 0) {
        Write-Host 'HyperForge is not running.'
        if (@(Get-PortListeners).Count -gt 0) {
            Write-Host 'Port 3000 is in use by another program; it was left untouched.'
        }
        exit 0
    }

    $killed = @()
    foreach ($target in $targets) {
        $id = [int]$target.ProcessId
        if (Get-ProcessInfo $id) { Stop-ProcessTree $id }
        $killed += $id
    }

    # Wait until nothing recorded, and no HyperForge listener, remains on port 3000.
    $released = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $alive = @($killed | Where-Object { Get-ProcessInfo $_ })
        $mine = @(Get-PortListeners | Where-Object { $killed -contains [int]$_.OwningProcess -or (Test-HyperForgeListenerSafe $_) })
        if ($alive.Count -eq 0 -and $mine.Count -eq 0) { $released = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $released) {
        throw 'HyperForge did not stop within 15 seconds. The PID file was kept.'
    }
    Remove-PidFile
    Write-Host 'HyperForge stopped.'
    exit 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
