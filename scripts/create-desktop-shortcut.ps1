$ErrorActionPreference = 'Stop'
try {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $target = Join-Path $repoRoot 'Start-HyperForge.bat'
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Launcher is missing: $target" }
    $desktop = [Environment]::GetFolderPath('DesktopDirectory')
    if (-not $desktop -or -not (Test-Path -LiteralPath $desktop -PathType Container)) {
        throw 'The current Windows user desktop folder is unavailable.'
    }
    $shortcutPath = Join-Path $desktop 'HyperForge.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.Description = 'Start HyperForge and open the browser'
    $shortcut.Save()
    Write-Host "Desktop shortcut created: $shortcutPath"
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
