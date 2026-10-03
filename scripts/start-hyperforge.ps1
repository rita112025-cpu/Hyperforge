$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeDirectory = 'D:\tools\node-v22.23.3-win-x64'
$probeUrl = 'http://127.0.0.1:3000'
$browserUrl = 'http://localhost:3000'
$logPath = Join-Path $repoRoot '.logs\hyperforge-dev.log'
$pidPath = Join-Path $repoRoot '.logs\hyperforge.pid'
$mutex = $null
$locked = $false

. (Join-Path $PSScriptRoot 'hyperforge-common.ps1')

function Test-HyperForgeReady {
    if ((Get-HyperForgeResponse) -ne 'HyperForge') { return $false }
    $listeners = @(Get-PortListeners)
    if ($listeners.Count -eq 0) { return $false }
    foreach ($listener in $listeners) {
        if (-not (Test-HyperForgeListenerSafe $listener)) { return $false }
    }
    return $true
}

function Show-Log {
    Write-Host "Log: $logPath"
    if (Test-Path -LiteralPath $logPath) {
        Get-Content -LiteralPath $logPath -Tail 40 | ForEach-Object { Write-Host $_ }
    }
}

try {
    foreach ($file in @('node.exe', 'npm.cmd')) {
        $path = Join-Path $nodeDirectory $file
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Required portable Node file is missing: $path"
        }
    }
    $env:Path = "$nodeDirectory;$env:Path"
    Set-Location -LiteralPath $repoRoot
    # Serialize clicks, including clicks while the first server is compiling.
    $mutex = New-Object System.Threading.Mutex($false, 'Local\HyperForgeLauncherPort3000')
    try { $locked = $mutex.WaitOne(180000) }
    catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another HyperForge launcher is still starting. Try again shortly.' }

    # A PID file only counts while the process it names is verifiably still ours; otherwise drop it.
    if (Clear-StalePidFile) { Write-Host 'Removed stale PID file.' }

    if (Test-HyperForgeReady) {
        if (@(Get-ValidPidTargets).Count -eq 0) {
            # Server started before PID files existed: record the verified listener so Stop can find it.
            $pair = Get-VerifiedListenerPair
            if ($pair) { Write-PidFile -Root $pair.Root -Listener $pair.Listener }
        }
        Write-Host 'HyperForge is already running.'
        Write-Host 'Opening browser...'
        Start-Process $browserUrl
        exit 0
    }
    $listeners = @(Get-PortListeners)
    if ($listeners.Count -gt 0 -or (Get-HyperForgeResponse) -ne 'Unavailable') {
        $owners = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
        if (-not $owners) { $owners = 'unavailable' }
        throw "Port 3000 is occupied and the HTTP response could not be identified as HyperForge (PID: $owners). Close the conflicting application yourself, then retry."
    }

    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules') -PathType Container)) {
        Write-Host 'First run: installing dependencies...'
        $installCommand = 'install'
        if (Test-Path -LiteralPath (Join-Path $repoRoot 'package-lock.json')) { $installCommand = 'ci' }
        & (Join-Path $nodeDirectory 'npm.cmd') $installCommand
        if ($LASTEXITCODE -ne 0) { throw "npm $installCommand failed with exit code $LASTEXITCODE." }
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
    # A separate hidden Windows process survives the BAT/PowerShell exit.
    # Explicit port prevents Next from silently moving to a different port.
    $command = '""{0}" run dev -- --port 3000 > "{1}" 2>&1"' -f (Join-Path $nodeDirectory 'npm.cmd'), $logPath
    $server = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $command) -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    Write-Host "Starting HyperForge (server command PID: $($server.Id))..."
    Write-Host "Log: $logPath"
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $server.Refresh()
        if ($server.HasExited) {
            Show-Log
            throw "HyperForge failed to start. Server command exited with code $($server.ExitCode)."
        }
        if (Test-HyperForgeReady) {
            # Record this launch so Stop can end exactly this process tree (never by image name).
            $root = Get-ProcessInfo $server.Id
            $listenerConn = Get-PortListeners | Select-Object -First 1
            $listener = $null
            if ($listenerConn) { $listener = Get-ProcessInfo ([int]$listenerConn.OwningProcess) }
            if ($root -and $listener) { Write-PidFile -Root $root -Listener $listener }
            Write-Host 'HyperForge is ready.'
            Write-Host $browserUrl
            Start-Process $browserUrl
            exit 0
        }
        if ((Get-HyperForgeResponse) -eq 'Other') {
            Show-Log
            throw 'Port 3000 returned a response from another application during startup.'
        }
        Start-Sleep -Seconds 1
    }
    Show-Log
    throw 'HyperForge did not become ready within the startup timeout.'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
