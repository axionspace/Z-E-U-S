# One-command installer for the hardened Zeus panel (Windows PowerShell).
# Creates a zeus-wizard folder in the current directory, downloads wizard.mjs into it
# from this repository's mirrors, and runs it. Nothing needs to be installed first: if
# Node.js 18+ is missing, a private copy of the Node runtime is downloaded into the
# same folder (nothing is installed system-wide - delete the folder to undo it).
# Usage:
#   irm https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/install.ps1 | iex
# Environment switches:
#   $env:ZEUS_SKIP_AUTO_RUNTIME = "1"        never download a runtime; require Node.js 18+
#   $env:ZEUS_NODE_VERSION      = "v24.11.0" pin a different Node.js runtime build
#   $env:ZEUS_NODE_BIN          = "C:\node.exe" use this node binary instead of looking one up
$ErrorActionPreference = "Stop"

$InstallDir = "zeus-wizard"
$Wizard = "wizard.mjs"
if ($env:ZEUS_NODE_VERSION) { $NodeVersion = $env:ZEUS_NODE_VERSION } else { $NodeVersion = "v24.11.0" }
# absolute paths: the wizard is started from inside the install folder
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$InstallDir = (Resolve-Path $InstallDir).Path
$RuntimeDir = Join-Path $InstallDir "runtime"

# TLS 1.2 (and 1.3 where the system supports it) for older Windows PowerShell installs
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls13
    } catch {}
} catch {}

# The wizard script is fetched from several independent providers, in order, so one
# filtered or failing route never blocks the install.
$Mirrors = @(
    "https://raw.githubusercontent.com/axionspace/Z-E-U-S/main/wizard/wizard.mjs",
    "https://cdn.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs",
    "https://fastly.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs",
    "https://gcore.jsdelivr.net/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs",
    "https://raw.githack.com/axionspace/Z-E-U-S/refs/heads/main/wizard/wizard.mjs",
    "https://cdn.jsdmirror.com/gh/axionspace/Z-E-U-S@main/wizard/wizard.mjs"
)

# Node.js runtime mirrors, tried in the same spirit
$RuntimeMirrors = @(
    "https://nodejs.org/dist",
    "https://cdn.npmmirror.com/binaries/node",
    "https://registry.npmmirror.com/-/binary/node",
    "https://mirror.nju.edu.cn/nodejs-release",
    "https://mirrors.huaweicloud.com/nodejs"
)

function Test-ZeusNode($cmd) {
    # A node binary is usable when it answers --version with major version 18 or newer.
    if (-not $cmd) { return $false }
    try {
        $v = ((& $cmd --version 2>$null) | Out-String).Trim()
        if ($v -notmatch '^v?\d+') { return $false }
        $major = [int](($v -replace '^v', '') -split '\.')[0]
        return ($major -ge 18)
    } catch {
        return $false
    }
}

function Get-ZeusFile($url, $out) {
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -TimeoutSec 180
}

function Get-ZeusArch {
    $a = $env:PROCESSOR_ARCHITECTURE
    if ($env:PROCESSOR_ARCHITEW6432) { $a = $env:PROCESSOR_ARCHITEW6432 }
    switch ($a) {
        "ARM64" { return "win-arm64" }
        default { return "win-x64" }
    }
}

function Install-ZeusRuntime {
    $arch = Get-ZeusArch
    $pkg = "node-$NodeVersion-$arch.zip"
    $nodeExe = Join-Path (Join-Path $RuntimeDir "node-$NodeVersion-$arch") "node.exe"
    if ((Test-Path $nodeExe) -and (Test-ZeusNode $nodeExe)) {
        Remove-Item -Force (Join-Path $RuntimeDir "*.zip"), (Join-Path $RuntimeDir "SHASUMS256.txt") -ErrorAction SilentlyContinue
        Write-Host "Reusing the runtime already stored in $RuntimeDir."
        return $nodeExe
    }
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    Write-Host ""
    Write-Host "Node.js is fetched into the wizard folder as $pkg"
    Write-Host "(about 30 MB, one time only, verified by checksum; nothing is installed system-wide)"
    $archive = Join-Path $RuntimeDir $pkg
    $sums = Join-Path $RuntimeDir "SHASUMS256.txt"
    foreach ($base in $RuntimeMirrors) {
        $url = "$base/$NodeVersion"
        Write-Host "  trying $url"
        try { Get-ZeusFile "$url/SHASUMS256.txt" $sums } catch { continue }
        $want = $null
        foreach ($line in @(Get-Content $sums)) {
            $parts = $line.Trim() -split '\s+'
            if ($parts.Length -ge 2 -and $parts[1] -eq $pkg) { $want = $parts[0].ToLower(); break }
        }
        if (-not $want) { Write-Host "  this mirror does not carry that build"; continue }
        try { Get-ZeusFile "$url/$pkg" $archive } catch { continue }
        if (-not (Test-Path $archive)) { continue }
        $got = (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLower()
        if ($got -ne $want) {
            Write-Host "  checksum mismatch ($got), trying the next mirror"
            Remove-Item -Force $archive
            continue
        }
        try {
            Expand-Archive -Path $archive -DestinationPath $RuntimeDir -Force
        } catch {
            Write-Host "  could not unpack this download, trying the next mirror"
            continue
        }
        Remove-Item -Force $archive, $sums -ErrorAction SilentlyContinue
        if (Test-ZeusNode $nodeExe) {
            Write-Host "Runtime ready: $nodeExe"
            return $nodeExe
        }
        Write-Host "  extracted, but that runtime did not start, trying the next mirror"
    }
    return $null
}

Write-Host ""
$Node = $null
if ($env:ZEUS_NODE_BIN -and (Test-ZeusNode $env:ZEUS_NODE_BIN)) {
    $Node = $env:ZEUS_NODE_BIN
    Write-Host "Using Node.js from ZEUS_NODE_BIN."
} elseif (((Get-Command node -ErrorAction SilentlyContinue) -ne $null) -and (Test-ZeusNode "node")) {
    $Node = "node"
    Write-Host "Using Node.js $((node --version)) from your system."
} elseif ($env:ZEUS_SKIP_AUTO_RUNTIME -eq "1") {
    Write-Host ""
    Write-Host "Node.js 18+ is required and ZEUS_SKIP_AUTO_RUNTIME=1 was set. Install Node.js 18+ from https://nodejs.org, then run this command again."
    return
} else {
    Write-Host "Node.js 18+ was not found on this system - fetching a private copy for it."
    $Node = Install-ZeusRuntime
    if (-not $Node) {
        Write-Host ""
        Write-Host "Could not download a Node.js runtime from any mirror. Options:"
        Write-Host "  1. Install Node.js 18+ from https://nodejs.org and re-run this command."
        Write-Host "  2. Put node.exe inside $RuntimeDir (or set `$env:ZEUS_NODE_BIN) and re-run."
        Write-Host "  3. Clone this repository and run: node wizard\wizard.mjs"
        return
    }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$WizardPath = Join-Path $InstallDir $Wizard

Write-Host ""
Write-Host "Downloading $Wizard..."
$Downloaded = $false
foreach ($Url in $Mirrors) {
    try {
        Invoke-WebRequest -Uri $Url -OutFile $WizardPath -UseBasicParsing -TimeoutSec 120
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
Write-Host "Starting the wizard (script kept in $WizardPath for later runs)."
Write-Host "Update later with: node $WizardPath --update"
Write-Host ""

Push-Location $InstallDir
try {
    & $Node $Wizard @args
} finally {
    Pop-Location
}
