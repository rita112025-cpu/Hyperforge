$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeDirectory = 'D:\tools\node-v22.23.3-win-x64'
$probeUrl = 'http://127.0.0.1:3000'
$browserUrl = 'http://localhost:3000'
$logPath = Join-Path $repoRoot '.logs\hyperforge-dev.log'
$mutex = $null
$locked = $false

function Get-HyperForgeResponse {
    try {
        $response = Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
            if ($response.Content -match '<title>HyperForge(?:\s|\s*<)') { return 'HyperForge' }
            return 'Other'
        }
    } catch { }
    return 'Unavailable'
}

function Get-PortListeners {
    @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
}

function Test-HyperForgeListener {
    param($Listener)
    # Require the exact repo's Next server and its dev parent, not a page title.
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($Listener.OwningProcess)" -ErrorAction Stop
    if (-not $process -or $process.Name -ne 'node.exe') { return $false }
    $serverPath = Join-Path $repoRoot 'node_modules\next\dist\server\lib\start-server.js'
    if ($process.CommandLine -notmatch [regex]::Escape($serverPath)) { return $false }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ParentProcessId)" -ErrorAction Stop
    $nextPath = Join-Path $repoRoot 'node_modules'
    return ($parent -and $parent.Name -eq 'node.exe' -and
        $parent.CreationDate -le $process.CreationDate -and
        $parent.CommandLine -match [regex]::Escape($nextPath) -and
        $parent.CommandLine -match '\bnext["\s]+dev\b')
}

function Test-HyperForgeReady {
    if ((Get-HyperForgeResponse) -ne 'HyperForge') { return $false }
    $listeners = @(Get-PortListeners)
    if ($listeners.Count -eq 0) { return $false }
    foreach ($listener in $listeners) {
        if (-not (Test-HyperForgeListener $listener)) { return $false }
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

    if (Test-HyperForgeReady) {
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
