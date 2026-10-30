#!/usr/bin/env bash
#
# sign-mac-local.sh — sign + notarize + staple a locally-built Moosewave.app.
#
# WHEN TO USE THIS:
#   You have certs on your Mac (operator laptop). You want to verify the
#   signing pipeline works without going through GitHub Actions. Useful for:
#     - Diagnosing notarization rejections on a real artifact.
#     - Producing an emergency signed build when CI is down.
#     - Onboarding a new operator (run end-to-end on their machine).
#
#   For real releases, prefer the CI pipeline (.github/workflows/desktop-release.yml).
#   That keeps signing keys on a single trusted runner instead of every
#   operator laptop.
#
# WHAT IT DOES:
#   1. codesign the .app with --options runtime (hardened runtime),
#      --timestamp (Apple's secure timestamp server), and our entitlements.plist.
#   2. Submit to Apple's notarization service via `xcrun notarytool submit --wait`.
#      `--wait` blocks until Apple finishes (typically 1-5 min, occasionally
#      30+ min during peak load).
#   3. `xcrun stapler staple` attaches the notarization ticket to the .app
#      so Gatekeeper can verify offline. Without staple, first-launch on a
#      machine with no internet shows the "from unidentified developer" warning.
#
# REQUIRED ENV:
#   APPLE_SIGNING_IDENTITY  — exact CN of the cert, e.g.
#                             "Developer ID Application: Moosewave Inc. (ABCDE12345)"
#                             Find via: security find-identity -v -p codesigning
#   APPLE_ID                — Apple ID email (developer account).
#   APPLE_PASSWORD          — app-specific password from appleid.apple.com.
#   APPLE_TEAM_ID           — 10-char team ID from developer.apple.com -> Membership.
#
# USAGE:
#   pnpm --filter postwave-desktop-shell tauri build
#   ./apps/desktop/scripts/sign-mac-local.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TAURI_DIR="${DESKTOP_DIR}/src-tauri"
ENTITLEMENTS="${TAURI_DIR}/entitlements.plist"

# --- env validation ----------------------------------------------------------

# Fail loud and early if any required var is missing. `set -u` would catch
# the first one but the message is unhelpful — explicit checks are kinder.
: "${APPLE_SIGNING_IDENTITY:?must be set, e.g. \"Developer ID Application: Moosewave Inc. (ABCDE12345)\"}"
: "${APPLE_ID:?must be set to your Apple ID email}"
: "${APPLE_PASSWORD:?must be set to an app-specific password (NOT your normal Apple ID password)}"
: "${APPLE_TEAM_ID:?must be set to your 10-char team ID}"

if [[ ! -f "${ENTITLEMENTS}" ]]; then
  echo "error: entitlements.plist not found at ${ENTITLEMENTS}" >&2
  echo "the parallel agent building the Rust shell should have placed it there." >&2
  exit 66
fi

# --- locate the built .app ---------------------------------------------------

# Tauri places the .app under target/<triple>/release/bundle/macos/. We look
# for a single .app to avoid ambiguity. If multiple are present (e.g. a stale
# previous run), bail and ask the operator to clean up.
APP_PATHS=(
  "${TAURI_DIR}/target/release/bundle/macos"
  "${TAURI_DIR}/target/universal-apple-darwin/release/bundle/macos"
  "${TAURI_DIR}/target/aarch64-apple-darwin/release/bundle/macos"
)

APP_BUNDLE=""
for dir in "${APP_PATHS[@]}"; do
  if [[ -d "${dir}" ]]; then
    found=$(find "${dir}" -maxdepth 1 -name "*.app" -type d | head -n 1)
    if [[ -n "${found}" ]]; then
      APP_BUNDLE="${found}"
      break
    fi
  fi
done

if [[ -z "${APP_BUNDLE}" ]]; then
  echo "error: no .app bundle found." >&2
  echo "build first with: pnpm --filter postwave-desktop-shell tauri build" >&2
  exit 66
fi

echo "Signing target: ${APP_BUNDLE}"

# --- codesign ----------------------------------------------------------------

# --options runtime  = hardened runtime (required for notarization).
# --timestamp        = secure timestamp from timestamp.apple.com — without
#                      this, the signature stops validating once the cert
#                      expires, even though codesigning rules say it should
#                      still verify if it was timestamped.
# --entitlements     = the plist of capabilities our app declares. Hardened
#                      runtime denies a bunch of things by default
#                      (allow-jit, allow-unsigned-executable-memory, etc.);
#                      WKWebView needs JIT, hence entitlements.plist.
# --deep             = recurse into nested bundles. Tauri 2 typically doesn't
#                      need this (single binary), but harmless and forward-
#                      compatible if a future plugin adds a helper.
# --force            = overwrite any existing signature (e.g. an unsigned
#                      Tauri-bundled signature from a debug build).
echo "==> codesign"
codesign \
  --sign "${APPLE_SIGNING_IDENTITY}" \
  --options runtime \
  --timestamp \
  --entitlements "${ENTITLEMENTS}" \
  --deep \
  --force \
  "${APP_BUNDLE}"

# Sanity check: codesign --verify exits non-zero if the signature is broken.
echo "==> codesign --verify"
codesign --verify --strict --verbose=2 "${APP_BUNDLE}"

# --- zip for notarization ----------------------------------------------------

# notarytool wants a .zip, .pkg, or .dmg. Easiest is to zip the .app.
# ditto preserves resource forks / extended attributes that plain `zip` drops.
ZIP_PATH="${APP_BUNDLE%.app}-notarize.zip"
echo "==> zipping for notarization: ${ZIP_PATH}"
ditto -c -k --keepParent "${APP_BUNDLE}" "${ZIP_PATH}"

# --- notarize ----------------------------------------------------------------

# `--wait` blocks until Apple either accepts or rejects. On reject, parse the
# JSON log it returns to figure out which entitlement / signature is wrong.
echo "==> xcrun notarytool submit --wait"
xcrun notarytool submit "${ZIP_PATH}" \
  --apple-id "${APPLE_ID}" \
  --password "${APPLE_PASSWORD}" \
  --team-id "${APPLE_TEAM_ID}" \
  --wait

# --- staple ------------------------------------------------------------------

# Staples the notarization ticket directly into the .app so Gatekeeper can
# verify on first launch even with no internet. Re-signing the .app AFTER
# stapling invalidates the staple — see runbook gotchas.
echo "==> xcrun stapler staple"
xcrun stapler staple "${APP_BUNDLE}"

echo ""
echo "Signed, notarized, and stapled: ${APP_BUNDLE}"
echo ""
echo "Next steps:"
echo "  1. Smoke test:   open '${APP_BUNDLE}'"
echo "  2. Verify:       spctl -a -v '${APP_BUNDLE}'"
echo "                   (should print 'accepted' and 'source=Notarized Developer ID')"
echo "  3. Wrap in DMG:  pnpm --filter postwave-desktop-shell tauri build (re-run)"
echo "                   (note: re-bundling regenerates the .dmg; the staple"
echo "                    on the inner .app survives the dmg packaging)"
