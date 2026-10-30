#!/usr/bin/env bash
#
# generate-icons.sh — regenerate the Moosewave desktop icon set.
#
# Usage:
#   ./apps/desktop/scripts/generate-icons.sh path/to/source.svg
#
# What it does:
#   Hands the source artwork to `pnpm tauri icon`, which generates the full
#   per-platform icon matrix (.png at multiple sizes, .icns for macOS, .ico
#   for Windows) into apps/desktop/src-tauri/icons/.
#
# When to run:
#   - First-time setup of the desktop app.
#   - Brand refresh (new logo / new colors).
#   - Before a marketing-visible release if the icons look stale.
#
# The output is committed to git so CI builds don't depend on this script
# being available on the runner. Re-run only when the source artwork changes.
#
# Make executable once after cloning:
#   chmod +x apps/desktop/scripts/generate-icons.sh

set -euo pipefail

# Resolve the directory containing this script so the script works regardless
# of the caller's CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# --- argument parsing --------------------------------------------------------

if [[ $# -lt 1 ]]; then
  echo "error: missing source SVG argument" >&2
  echo "usage: $(basename "$0") <path-to-source.svg>" >&2
  echo "" >&2
  echo "The source SVG should be a square 1024x1024 export of the Moosewave" >&2
  echo "logo. Tauri downsamples from there into every required size." >&2
  exit 64  # EX_USAGE
fi

SOURCE_SVG="$1"

if [[ ! -f "${SOURCE_SVG}" ]]; then
  echo "error: source file not found: ${SOURCE_SVG}" >&2
  exit 66  # EX_NOINPUT
fi

# --- run tauri icon ----------------------------------------------------------

echo "Generating icons from: ${SOURCE_SVG}"
echo "Output directory:      ${DESKTOP_DIR}/src-tauri/icons/"

# `pnpm tauri icon` expects to be invoked from the Tauri project root so it
# can find tauri.conf.json. cd into apps/desktop and call the workspace
# binary explicitly.
cd "${DESKTOP_DIR}"
pnpm tauri icon "${SOURCE_SVG}"

echo ""
echo "Done. Review the generated files in src-tauri/icons/ and commit them:"
echo "  git add apps/desktop/src-tauri/icons/"
echo "  git commit -m 'desktop: regenerate icons'"
