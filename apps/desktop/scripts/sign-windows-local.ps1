# sign-windows-local.ps1 — sign + verify a locally-built Moosewave .msi / .exe.
#
# WHEN TO USE THIS:
#   You're on a Windows operator machine with the EV cert installed (or the
#   .pfx file accessible) and want to verify the signing pipeline end-to-end
#   without going through GitHub Actions. Same use cases as sign-mac-local.sh:
#     - Diagnose signtool failures.
#     - Produce an emergency build when CI is down.
#     - Onboard a new operator.
#
#   For real releases, prefer the CI pipeline.
#
# WHAT IT DOES:
#   1. Locates the latest .msi and .exe under
#      apps\desktop\src-tauri\target\release\bundle\.
#   2. Calls signtool.exe with /tr (timestamp), /td sha256, /fd sha256 against
#      each artifact.
#   3. Calls `signtool verify /pa` to confirm the signature chain validates
#      against the OS trust store.
#
# REQUIRED ENV:
#   $env:WINDOWS_CERTIFICATE_PATH      — absolute path to the .pfx file.
#                                        e.g. "C:\Users\you\Moosewave-EV.pfx"
#   $env:WINDOWS_CERTIFICATE_PASSWORD  — password set when the .pfx was exported.
#
# OPTIONAL ENV:
#   $env:WINDOWS_TIMESTAMP_URL  — RFC 3161 timestamp server. Default:
#                                 http://timestamp.digicert.com  (works for
#                                 Sectigo, DigiCert, GlobalSign issued certs).
#
# USAGE:
#   pnpm --filter postwave-desktop-shell tauri build
#   pwsh apps\desktop\scripts\sign-windows-local.ps1

# Strict mode + stop on any error: same energy as `set -euo pipefail` for bash.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- env validation ----------------------------------------------------------

if (-not $env:WINDOWS_CERTIFICATE_PATH) {
    throw "WINDOWS_CERTIFICATE_PATH must be set to the absolute path of the .pfx file."
}
if (-not (Test-Path $env:WINDOWS_CERTIFICATE_PATH)) {
    throw "Certificate file not found: $env:WINDOWS_CERTIFICATE_PATH"
}
if (-not $env:WINDOWS_CERTIFICATE_PASSWORD) {
    throw "WINDOWS_CERTIFICATE_PASSWORD must be set to the .pfx export password."
}

# Default timestamp server. Apple uses Apple's own server; Windows just needs
# any RFC 3161 server the cert chain trusts. DigiCert's is the most reliable.
$timestampUrl = if ($env:WINDOWS_TIMESTAMP_URL) {
    $env:WINDOWS_TIMESTAMP_URL
} else {
    "http://timestamp.digicert.com"
}

# --- locate signtool.exe -----------------------------------------------------

# signtool ships with the Windows SDK. Find the newest one available.
# tauri-action does this discovery internally; we replicate it for local use.
$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if (-not $signtool) {
    $candidates = Get-ChildItem -Path "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe" `
        -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending
    if ($candidates) {
        $signtool = $candidates[0]
    } else {
        throw "signtool.exe not found. Install the Windows 10/11 SDK from https://developer.microsoft.com/windows/downloads/windows-sdk/"
    }
}
Write-Host "Using signtool: $($signtool.Source ?? $signtool.FullName)"

# --- locate built artifacts --------------------------------------------------

# Tauri output paths on Windows.
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$bundleDir = Join-Path $repoRoot "src-tauri\target\release\bundle"

if (-not (Test-Path $bundleDir)) {
    throw "Bundle directory not found: $bundleDir`nBuild first with: pnpm --filter postwave-desktop-shell tauri build"
}

# Collect every .msi and .exe — Tauri produces an .msi under bundle\msi\
# and an NSIS .exe under bundle\nsis\.
$artifacts = Get-ChildItem -Path $bundleDir -Recurse -Include *.msi, *.exe -File
if ($artifacts.Count -eq 0) {
    throw "No .msi or .exe found under $bundleDir. Did the Tauri build complete?"
}

Write-Host ""
Write-Host "Found $($artifacts.Count) artifact(s) to sign:"
$artifacts | ForEach-Object { Write-Host "  - $($_.FullName)" }
Write-Host ""

# --- sign each artifact ------------------------------------------------------

foreach ($artifact in $artifacts) {
    Write-Host "==> signing $($artifact.Name)"

    # /f   = path to .pfx
    # /p   = .pfx password
    # /fd  = file digest algo (sha256 — sha1 is deprecated and triggers warnings)
    # /tr  = RFC 3161 timestamp URL
    # /td  = timestamp digest algo
    # /v   = verbose
    & $signtool.Source sign `
        /f $env:WINDOWS_CERTIFICATE_PATH `
        /p $env:WINDOWS_CERTIFICATE_PASSWORD `
        /fd sha256 `
        /tr $timestampUrl `
        /td sha256 `
        /v `
        $artifact.FullName

    if ($LASTEXITCODE -ne 0) {
        throw "signtool sign failed for $($artifact.FullName) (exit $LASTEXITCODE)"
    }
}

# --- verify each artifact ----------------------------------------------------

# /pa = "default authentication policy" = validate against the live cert store.
# This is what SmartScreen-adjacent tooling on the user's machine will do at
# install time, so it's the right verification mode for our purposes.
foreach ($artifact in $artifacts) {
    Write-Host "==> verifying $($artifact.Name)"
    & $signtool.Source verify /pa /v $artifact.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "signtool verify failed for $($artifact.FullName) (exit $LASTEXITCODE)"
    }
}

Write-Host ""
Write-Host "All artifacts signed and verified."
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Smoke test the .msi on a clean Windows VM."
Write-Host "  2. Confirm no SmartScreen 'Unknown publisher' warning."
Write-Host "     (A short 'Verified publisher' string should appear instead.)"
Write-Host "  3. If SmartScreen still warns, see docs/runbooks/desktop-build-and-sign.md"
Write-Host "     section 'Windows SmartScreen reputation'."
