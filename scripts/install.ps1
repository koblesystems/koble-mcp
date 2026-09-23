# Installs koble on Windows, then runs `koble setup`.
#
#   irm https://raw.githubusercontent.com/koblesystems/koble-mcp/master/scripts/install.ps1 | iex
#
# $env:KOBLE_VERSION = 'v0.1.0'   install that release instead of the newest
# $env:KOBLE_INSTALL_DIR = '...'  install somewhere other than %LOCALAPPDATA%\Programs\koble
# $env:KOBLE_SKIP_SETUP = '1'     install only; run `koble setup` yourself later
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'koblesystems/koble-mcp'
$dir = if ($env:KOBLE_INSTALL_DIR) { $env:KOBLE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\koble' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'koble needs 64-bit Windows.' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
if ($arch -eq 'arm64') { Write-Host 'Windows on ARM: using the x64 build, which Windows runs through emulation.'; $arch = 'x64' }
$asset = "koble-windows-$arch.exe"

$version = $env:KOBLE_VERSION
if (-not $version) {
    # The newest full release; before there is one, the newest release candidate.
    try { $version = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name }
    catch { $version = @(Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=1")[0].tag_name }
    if (-not $version) { throw "Could not find a release of $repo." }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("koble-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $base = "https://github.com/$repo/releases/download/$version"
    Write-Host "Downloading koble $version for Windows..."
    Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp $asset) -UseBasicParsing
    Invoke-WebRequest "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt') -UseBasicParsing

    $expected = Get-Content (Join-Path $tmp 'checksums.txt') |
        ForEach-Object { $parts = $_ -split '\s+'; if ($parts.Count -ge 2 -and (($parts[1] -replace '^\*', '') -eq $asset)) { $parts[0] } } |
        Select-Object -First 1
    $actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) { throw 'The download does not match checksums.txt; nothing was installed.' }

    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $target = Join-Path $dir 'koble.exe'
    if (Test-Path $target) { Move-Item $target "$target.old" -Force }   # a running koble.exe can be renamed, not overwritten
    Move-Item (Join-Path $tmp $asset) $target -Force
    Unblock-File $target
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "Installed $target"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ((($userPath -split ';') | Where-Object { $_ -eq $dir }).Count -eq 0) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ";$dir").TrimStart(';')), 'User')
    $env:Path = "$env:Path;$dir"
    Write-Host "Added $dir to your PATH. Terminals opened from now on will find koble."
}

if (-not $env:KOBLE_SKIP_SETUP -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    Write-Host ''
    & $target setup
} else {
    Write-Host ''
    Write-Host 'Next: run  koble setup'
}
