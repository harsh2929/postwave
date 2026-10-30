#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Moosewave mobile: Sentry source-map uploader.
#
# When this runs (CI):
#   .github/workflows/mobile-release.yml invokes this script AFTER an
#   `expo export` step produces a bundle in ./dist. This is the
#   "non-EAS" build path — preview / staging builds that don't go
#   through `eas build` and therefore don't run Sentry's native/EAS
#   upload hooks inside the Expo cloud worker.
#
# When this is NOT needed:
#   If the build step was `eas build`, the EAS build container runs
#   @sentry/react-native's Expo config plugin/native build hooks and
#   uploads source-maps from inside the Expo cloud.
#   This script is the fallback for every other code path.
#
# Local invocation:
#   cd apps/mobile
#   SENTRY_AUTH_TOKEN=... SENTRY_ORG=... SENTRY_PROJECT=postwave-mobile \
#     ./scripts/upload-sourcemaps.sh
#
# Or via pnpm:
#   SENTRY_AUTH_TOKEN=... SENTRY_ORG=... SENTRY_PROJECT=postwave-mobile \
#     pnpm --filter @postwave/mobile upload-sourcemaps
# -----------------------------------------------------------------------------
set -euo pipefail

# Required env: SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT
# Optional:    POSTWAVE_RELEASE (defaults to the full git commit hash)
# Optional:    DIST_DIR (defaults to ./dist)

: "${SENTRY_AUTH_TOKEN:?SENTRY_AUTH_TOKEN required}"
: "${SENTRY_ORG:?SENTRY_ORG required}"
: "${SENTRY_PROJECT:?SENTRY_PROJECT required}"

RELEASE="${POSTWAVE_RELEASE:-$(git rev-parse HEAD)}"
DIST="${DIST_DIR:-./dist}"

# -----------------------------------------------------------------------------
# Resolve sentry-cli from the lockfile, never from the network.
#
# This used to shell out through npm's install-and-execute runner with no
# version and no integrity constraint: it fetches whatever the registry
# is serving for `latest` at that moment and runs it — with SENTRY_AUTH_TOKEN
# already exported into its environment, three lines above. One compromised
# publish, one typosquat, one registry mirror that answers a slightly different
# tarball, and an org-scoped Sentry token leaves the runner. The `--yes` flag
# it carried also suppressed the prompt that was the only thing making the
# unattended install visible at all.
#
# The binary is already on disk and already pinned: @sentry/react-native
# depends on an EXACT @sentry/cli version, so the lockfile fixes it and the
# install has already integrity-checked the tarball. Resolving through
# @sentry/react-native's own require (rather than this package's) is what
# guarantees we run the CLI that matches the SDK that produced the bundle.
#
# Resolution is anchored at the app root rather than $PWD so that DIST_DIR
# keeps meaning "relative to where you invoked this", which is what the CI
# workflow relies on.
# -----------------------------------------------------------------------------
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! SENTRY_CLI="$(node -e '
const { createRequire } = require("node:module");
const path = require("node:path");
const fromApp = createRequire(path.join(process.argv[1], "package.json"));
const fromSdk = createRequire(fromApp.resolve("@sentry/react-native/package.json"));
process.stdout.write(fromSdk.resolve("@sentry/cli/bin/sentry-cli"));
' "$APP_ROOT" 2>/dev/null)" || [ ! -x "$SENTRY_CLI" ]; then
  echo "fatal: sentry-cli is not installed under $APP_ROOT" >&2
  echo "       run 'pnpm install' first. This script deliberately does NOT fall" >&2
  echo "       back to a registry fetch-and-run of @sentry/cli: that would" >&2
  echo "       download and execute an unpinned package with SENTRY_AUTH_TOKEN" >&2
  echo "       already in its environment." >&2
  exit 1
fi

# Printed, not just resolved: when a build's symbolication is wrong months from
# now, the log has to say which CLI produced the upload.
echo "Using $("$SENTRY_CLI" --version) at $SENTRY_CLI"

if [ ! -d "$DIST" ]; then
  echo "fatal: dist directory $DIST not found; run 'expo export' first" >&2
  exit 1
fi

echo "Uploading source maps from $DIST for release $RELEASE..."

# Export so @sentry/cli picks them up automatically (it reads them
# from the env). We re-export the trio explicitly even though they're
# already in the parent env to make this script safe to source-and-run
# directly.
export SENTRY_AUTH_TOKEN SENTRY_ORG SENTRY_PROJECT

uploaded_any="false"

# Build the bundle pair (ios + android) if both exist.
# Expo Router export puts bundles under `_expo/static/js/<platform>/`.
for platform in ios android; do
  BUNDLE_DIR="$DIST/_expo/static/js/$platform"
  if [ -d "$BUNDLE_DIR" ]; then
    echo "  + $platform"
    if ! find "$BUNDLE_DIR" -type f -name '*.map' -print -quit | grep -q .; then
      echo "fatal: no source maps found under $BUNDLE_DIR" >&2
      echo "       run expo export with '--source-maps external' before upload" >&2
      exit 1
    fi
    # `sourcemaps inject` writes the debug-id into the bundle + map so
    # Sentry can associate stack frames to the correct map even when
    # the release tag differs across builds.
    "$SENTRY_CLI" sourcemaps inject "$BUNDLE_DIR"
    "$SENTRY_CLI" sourcemaps upload \
      --release "$RELEASE" \
      --dist "$platform" \
      "$BUNDLE_DIR"
    uploaded_any="true"
  else
    echo "  - $platform (not built)"
  fi
done

if [ "$uploaded_any" != "true" ]; then
  echo "fatal: no platform bundle directories found under $DIST/_expo/static/js/{ios,android}" >&2
  echo "       nothing was uploaded. Did 'expo export' run for at least one platform?" >&2
  exit 1
fi

# Mark the release as deployed so Sentry recognizes events with this release.
# `|| true` because finalize is idempotent-but-noisy: re-finalizing an
# already-finalized release returns non-zero on some CLI versions.
"$SENTRY_CLI" releases finalize "$RELEASE" || true

echo "Source-map upload complete for release $RELEASE."
