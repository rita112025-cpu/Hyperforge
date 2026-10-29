# Optional: -NodeDir <folder containing node.exe and npm.cmd>. Same as env var HYPERFORGE_NODE_DIR.
param([string]$NodeDir)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
# Legacy portable Node location; used only if it exists (kept for backward compatibility).
$legacyNodeDirectory = 'D:\tools\node-v22.23.3-win-x64'
# Used when package.json has no engines.node (the launcher previously pinned Node 22).
$defaultNodeMajor = 22
$nodeDirectory = $null
$npmCmd = $null
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

# Resolve Node in order: (a) -NodeDir / HYPERFORGE_NODE_DIR, (b) legacy D:\tools folder if present, (c) PATH.
function Resolve-NodeTools {
    param([string]$RequestedDir)
    $source = '-NodeDir parameter'
    if (-not $RequestedDir -and $env:HYPERFORGE_NODE_DIR) {
        $RequestedDir = $env:HYPERFORGE_NODE_DIR
        $source = 'HYPERFORGE_NODE_DIR'
    }
    if ($RequestedDir) {
        # An explicit choice must work; do not silently fall back to another Node.
        $missing = @()
        foreach ($file in @('node.exe', 'npm.cmd')) {
            if (-not (Test-Path -LiteralPath (Join-Path $RequestedDir $file) -PathType Leaf)) { $missing += $file }
        }
        if ($missing.Count -gt 0) {
            throw ("Node folder from $source is missing $($missing -join ' and '): $RequestedDir`n" +
                "Point it to the folder that contains node.exe and npm.cmd, or remove the setting to use Node from PATH.")
        }
        return [pscustomobject]@{
            Dir = $RequestedDir; Node = (Join-Path $RequestedDir 'node.exe'); Npm = (Join-Path $RequestedDir 'npm.cmd'); Source = $source
        }
    }
    $legacyNode = Join-Path $legacyNodeDirectory 'node.exe'
    $legacyNpm = Join-Path $legacyNodeDirectory 'npm.cmd'
    if ((Test-Path -LiteralPath $legacyNode -PathType Leaf) -and (Test-Path -LiteralPath $legacyNpm -PathType Leaf)) {
        return [pscustomobject]@{ Dir = $legacyNodeDirectory; Node = $legacyNode; Npm = $legacyNpm; Source = 'legacy portable folder' }
    }
    $nodeFound = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $npmFound = Get-Command 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeFound -and $npmFound) {
        return [pscustomobject]@{
            Dir = (Split-Path -Parent $nodeFound.Source); Node = $nodeFound.Source; Npm = $npmFound.Source; Source = 'PATH'
        }
    }
    throw ("Node.js was not found. HyperForge looked in:`n" +
        "  1. -NodeDir parameter / HYPERFORGE_NODE_DIR environment variable (not set)`n" +
        "  2. $legacyNodeDirectory (not found)`n" +
        "  3. node.exe and npm.cmd on PATH (not found)`n" +
        "Fix one of these:`n" +
        "  - Install Node.js $defaultNodeMajor LTS from https://nodejs.org/ (adds node and npm to PATH), then run the launcher again.`n" +
        "  - Or set HYPERFORGE_NODE_DIR to a folder that contains node.exe and npm.cmd, for example:`n" +
        "      setx HYPERFORGE_NODE_DIR ""C:\path\to\node-v22-win-x64""   (then open a new window)`n" +
        "  - Or run: Start-HyperForge.bat -NodeDir ""C:\path\to\node-v22-win-x64""")
}

# Checks one major version against a simple engines.node range ("22", "^22", "22.x", ">=20 <23", "20 || 22").
# Returns $true / $false, or $null if the range syntax is not understood.
function Test-NodeMajorInRange {
    param([int]$Major, [string]$Range)
    foreach ($alternative in ($Range -split '\|\|')) {
        $tokens = @($alternative.Trim() -split '\s+' | Where-Object { $_ })
        if ($tokens.Count -eq 0) { return $null }
        $ok = $true
        foreach ($token in $tokens) {
            if ($token -notmatch '^(>=|<=|>|<|\^|~|=)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$') { return $null }
            # Copy the groups first: the -match calls below overwrite $Matches.
            $op = $Matches[1]
            $n = [int]$Matches[2]
            $minor = [string]$Matches[3]
            $patch = [string]$Matches[4]
            $hasNumericMinor = ($minor -match '^\d+$')
            $hasNonZeroPart = (($minor -match '^\d+$') -and [int]$minor -gt 0) -or (($patch -match '^\d+$') -and [int]$patch -gt 0)
            switch ($op) {
                '>=' { if ($Major -lt $n) { $ok = $false } }
                '>'  { if ($hasNumericMinor) { if ($Major -lt $n) { $ok = $false } } elseif ($Major -le $n) { $ok = $false } }
                '<=' { if ($Major -gt $n) { $ok = $false } }
                '<'  { if ($hasNonZeroPart) { if ($Major -gt $n) { $ok = $false } } elseif ($Major -ge $n) { $ok = $false } }
                default { if ($Major -ne $n) { $ok = $false } }
            }
        }
        if ($ok) { return $true }
    }
    return $false
}

function Assert-NodeVersion {
    param($Tools)
    $nodePath = $Tools.Node
    $versionText = "$(& $nodePath --version | Select-Object -First 1)"
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(\d+)\.') {
        throw "Could not read the Node.js version from $nodePath (found via $($Tools.Source))."
    }
    $major = [int]$Matches[1]
    $range = $null
    try {
        $pkg = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
        if ($pkg.engines -and $pkg.engines.node) { $range = [string]$pkg.engines.node }
    } catch { }
    if ($range) {
        $inRange = Test-NodeMajorInRange -Major $major -Range $range
        if ($null -eq $inRange) {
            Write-Host "Warning: could not interpret package.json engines.node '$range'; skipping the Node version check." -ForegroundColor Yellow
            return
        }
        $wanted = "engines.node '$range' in package.json"
    } else {
        $inRange = ($major -eq $defaultNodeMajor)
        $wanted = "Node.js $defaultNodeMajor (package.json has no engines.node, so the launcher's default is used)"
    }
    if (-not $inRange) {
        throw ("Node.js $versionText at $nodePath (found via $($Tools.Source)) does not match $wanted.`n" +
            "Install a matching Node.js LTS, or set HYPERFORGE_NODE_DIR / -NodeDir to a folder with a matching node.exe and npm.cmd.")
    }
}

function Show-Log {
    Write-Host "Log: $logPath"
    if (Test-Path -LiteralPath $logPath) {
        Get-Content -LiteralPath $logPath -Tail 40 | ForEach-Object { Write-Host $_ }
    }
}

try {
    $nodeTools = Resolve-NodeTools -RequestedDir $NodeDir
    Assert-NodeVersion $nodeTools
    $nodeDirectory = $nodeTools.Dir
    $npmCmd = $nodeTools.Npm
    Write-Host "Using Node: $($nodeTools.Node) ($($nodeTools.Source))"
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
        & $npmCmd $installCommand
        if ($LASTEXITCODE -ne 0) { throw "npm $installCommand failed with exit code $LASTEXITCODE." }
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
    # A separate hidden Windows process survives the BAT/PowerShell exit.
    # Explicit port prevents Next from silently moving to a different port.
    $command = '""{0}" run dev -- --port 3000 > "{1}" 2>&1"' -f $npmCmd, $logPath
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
