$ErrorActionPreference = 'Stop'
try {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $startTarget = Join-Path $repoRoot 'Start-HyperForge.bat'
    $stopTarget = Join-Path $repoRoot 'Stop-HyperForge.bat'
    $icon = Join-Path $repoRoot 'hyperforge_hammer.ico'
    foreach ($required in @($startTarget, $stopTarget, $icon)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required file is missing: $required" }
    }
    $desktop = [Environment]::GetFolderPath('DesktopDirectory')
    if (-not $desktop -or -not (Test-Path -LiteralPath $desktop -PathType Container)) {
        throw 'The current Windows user desktop folder is unavailable.'
    }
    $shell = New-Object -ComObject WScript.Shell

    $start = $shell.CreateShortcut((Join-Path $desktop 'HyperForge.lnk'))
    $start.TargetPath = $startTarget
    $start.WorkingDirectory = $repoRoot
    $start.IconLocation = "$icon,0"
    $start.Description = 'Start HyperForge and open the browser'
    $start.Save()

    $stop = $shell.CreateShortcut((Join-Path $desktop 'Stop HyperForge.lnk'))
    $stop.TargetPath = $stopTarget
    $stop.WorkingDirectory = $repoRoot
    $stop.Description = 'Stop the HyperForge local server'
    $stop.Save()

    Write-Host "Desktop shortcuts created in: $desktop"
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
