# Shared helpers for start-hyperforge.ps1 and stop-hyperforge.ps1 (dot-sourced).
# The caller must define: $repoRoot, $probeUrl, $logPath, $pidPath.
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.

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

function Get-ProcessInfo {
    param([int]$ProcessId)
    Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Get-ProcessStamp {
    param($Process)
    $Process.CreationDate.ToUniversalTime().ToString('o')
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

function Test-HyperForgeListenerSafe {
    param($Listener)
    try { return (Test-HyperForgeListener $Listener) } catch { return $false }
}

# A process counts as "ours" only if it still exists, was created at the recorded time (defeats PID reuse),
# is cmd.exe or node.exe, and its command line contains this repo's path.
function Get-OwnedProcess {
    param([int]$ProcessId, [string]$ExpectedStamp)
    if ($ProcessId -le 0 -or -not $ExpectedStamp) { return $null }
    $p = Get-ProcessInfo $ProcessId
    if (-not $p) { return $null }
    if ((Get-ProcessStamp $p) -ne $ExpectedStamp) { return $null }
    if ($p.Name -ne 'cmd.exe' -and $p.Name -ne 'node.exe') { return $null }
    if (-not $p.CommandLine -or $p.CommandLine.IndexOf($repoRoot, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $null }
    return $p
}

function Read-PidFile {
    if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) { return $null }
    try {
        $data = Get-Content -LiteralPath $pidPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ($data.version -ne 1) { return $null }
        return $data
    } catch { return $null }
}

function Remove-PidFile {
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

function Write-PidFile {
    param($Root, $Listener)
    New-Item -ItemType Directory -Path (Split-Path -Parent $pidPath) -Force | Out-Null
    $data = [ordered]@{
        version       = 1
        repoRoot      = $repoRoot
        rootPid       = [int]$Root.ProcessId
        rootStamp     = (Get-ProcessStamp $Root)
        listenerPid   = [int]$Listener.ProcessId
        listenerStamp = (Get-ProcessStamp $Listener)
    }
    $json = $data | ConvertTo-Json
    $tmp = "$pidPath.tmp"
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $pidPath -Force
}

# Processes recorded in the PID file that still verifiably belong to HyperForge.
function Get-ValidPidTargets {
    $data = Read-PidFile
    if (-not $data) { return @() }
    $targets = @()
    $root = Get-OwnedProcess -ProcessId ([int]$data.rootPid) -ExpectedStamp ([string]$data.rootStamp)
    if ($root) { $targets += $root }
    $listener = Get-OwnedProcess -ProcessId ([int]$data.listenerPid) -ExpectedStamp ([string]$data.listenerStamp)
    if ($listener) { $targets += $listener }
    return @($targets)
}

# Removes the PID file when nothing it names is alive (or the file is unreadable). Returns $true if removed.
function Clear-StalePidFile {
    if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) { return $false }
    if (@(Get-ValidPidTargets).Count -gt 0) { return $false }
    Remove-PidFile
    return $true
}

# For a server started before PID files existed: derive (root = next dev parent, listener) from the verified port owner.
function Get-VerifiedListenerPair {
    foreach ($l in @(Get-PortListeners)) {
        if (-not (Test-HyperForgeListenerSafe $l)) { continue }
        $listener = Get-ProcessInfo ([int]$l.OwningProcess)
        if (-not $listener) { continue }
        $root = Get-ProcessInfo ([int]$listener.ParentProcessId)
        if ($root) { return [pscustomobject]@{ Root = $root; Listener = $listener } }
    }
    return $null
}
