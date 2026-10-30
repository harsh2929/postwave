# PowerShell counterpart of scripts/dev-fanout-env.sh.
#
# Fan out the root .env.local to each app's expected env-file location.
#   apps\api      -> apps\api\.env                       (godotenv)
#   apps\web      -> apps\web\.env.local                 (Next.js)
#   apps\desktop  -> apps\desktop\.env                   (Vite)
#
# Usage:
#   .\scripts\dev-fanout-env.ps1                # refuse to overwrite
#   .\scripts\dev-fanout-env.ps1 -Force         # overwrite existing per-app envs
#
# If you see "running scripts is disabled on this system", run:
#   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Src = Join-Path $RootDir '.env.local'

if (-not (Test-Path $Src)) {
    Write-Error @"
$Src does not exist.

Bootstrap it first:
  copy .env.local.example .env.local
  # then fill in GENERATE_ME values (see comments inside)
  # tip: openssl rand -hex 32   (use Git Bash on Windows if openssl isn't on PATH)

Then re-run this script.
"@
    exit 1
}

$Targets = @(
    'apps\api\.env',
    'apps\web\.env.local',
    'apps\desktop\.env'
)

$created = 0
$overwrote = 0
$skipped = 0

foreach ($rel in $Targets) {
    $dest = Join-Path $RootDir $rel
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path $destDir)) {
        Write-Host "skip   $rel  (parent dir does not exist - is the repo complete?)"
        $skipped++
        continue
    }
    if ((Test-Path $dest) -and (-not $Force)) {
        Write-Host "skip   $rel  (exists; pass -Force to overwrite)"
        $skipped++
        continue
    }
    if (Test-Path $dest) {
        Copy-Item -Path $Src -Destination $dest -Force
        Write-Host "wrote  $rel  (overwrote existing)"
        $overwrote++
    } else {
        Copy-Item -Path $Src -Destination $dest
        Write-Host "wrote  $rel"
        $created++
    }
}

Write-Host ""
Write-Host "Done. created=$created  overwrote=$overwrote  skipped=$skipped"

# Helpful nudge if placeholders remain.
$content = Get-Content -Path $Src -Raw
if ($content -match 'GENERATE_ME|PROVIDE_ME') {
    Write-Host ""
    Write-Host "Heads up: $Src still has GENERATE_ME / PROVIDE_ME placeholders."
    Write-Host "          Run:  Select-String -Path .env.local -Pattern 'GENERATE_ME|PROVIDE_ME'"
    Write-Host "          to see what's left."
}
