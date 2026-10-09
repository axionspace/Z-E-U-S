# One-command installer for the hardened Zeus panel (Windows PowerShell).
# Creates a zeus-wizard folder in the current directory, downloads wizard.mjs
# into it from this repository's mirrors, and runs it with Node.js.
# Usage:
#   irm https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/install.ps1 | iex
# Requires Node.js 18+ (https://nodejs.org).
$ErrorActionPreference = "Stop"

$InstallDir = "zeus-wizard"
$Wizard = "wizard.mjs"

# TLS 1.2 for older Windows PowerShell installations
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "Node.js is required but was not found. Install Node.js 18+ from https://nodejs.org, then run this command again."
    return
}

$NodeVersion = (node --version).TrimStart("v")
$NodeMajor = [int]$NodeVersion.Split(".")[0]
if ($NodeMajor -lt 18) {
    Write-Host ""
    Write-Host "Node.js 18 or newer is required (found $(node --version)). Install it from https://nodejs.org."
    return
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$WizardPath = Join-Path $InstallDir $Wizard

$Mirrors = @(
    "https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/wizard.mjs",
    "https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs",
    "https://fastly.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs",
    "https://gcore.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs"
)

Write-Host ""
Write-Host "Downloading $Wizard..."
$Downloaded = $false
foreach ($Url in $Mirrors) {
    try {
        Invoke-WebRequest -Uri $Url -OutFile $WizardPath -UseBasicParsing
        $Downloaded = $true
        break
    } catch {}
}

if (-not $Downloaded) {
    Write-Host ""
    Write-Host "Could not download $Wizard from any mirror. Check your connection (a VPN may help) and try again."
    return
}

Write-Host ""
Write-Host "Starting the wizard (saved to $WizardPath for future runs)."
Write-Host ""

Push-Location $InstallDir
try {
    & node $Wizard @args
} finally {
    Pop-Location
}
