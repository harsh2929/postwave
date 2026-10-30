#!/usr/bin/env bash
# CI guard: ensure no application code embeds or imports `proprietary/` directly.
# Only runtime env-path loading is allowed (LICENSE-BOUNDARY.md).

set -euo pipefail

cd "$(dirname "$0")/.."

violations=0

# Scan tracked source only: build outputs and dependency trees are not part of
# this repository boundary and make a recursive filesystem grep both noisy and
# unnecessarily slow.

# Forbidden: //go:embed proprietary/...
if matches=$(git grep -nE "//go:embed[[:space:]]+proprietary/" -- \
  'apps/**/*.go' 'services/**/*.go' 'packages/**/*.go' 2>/dev/null || true) &&
  [[ -n "$matches" ]]; then
  echo "$matches"
  echo "ERROR: //go:embed proprietary/* detected. Use runtime env-path loading instead."
  violations=$((violations + 1))
fi

# Forbidden: Go import of "github.com/postwave/postwave/proprietary/..."
# (Runtime string literals containing "proprietary/" are allowed — they're
# file paths read at runtime, not import statements.)
if matches=$(git grep -nF '"github.com/postwave/postwave/proprietary' -- \
  'apps/**/*.go' 'services/**/*.go' 'packages/**/*.go' 2>/dev/null || true) &&
  [[ -n "$matches" ]]; then
  echo "$matches"
  echo "ERROR: Go import of github.com/postwave/postwave/proprietary detected."
  violations=$((violations + 1))
fi

# Forbidden: TS/JS imports of proprietary
if matches=$(git grep -nE "from ['\"][^'\"]*proprietary/" -- \
  'packages/**/*.ts' 'packages/**/*.tsx' 'packages/**/*.js' \
  'apps/web/**/*.ts' 'apps/web/**/*.tsx' 'apps/web/**/*.js' 2>/dev/null || true) &&
  [[ -n "$matches" ]]; then
  echo "$matches"
  echo "ERROR: TS/JS import of proprietary/ path detected."
  violations=$((violations + 1))
fi

# A normal source export must omit the real packs while retaining the
# redistributable stubs. This preserves private cloud image builds from a
# private checkout while making `git archive` fail safe for public source.
if ! git check-attr export-ignore -- proprietary/README.md \
  | grep -Eq ': export-ignore: set$'; then
  echo "ERROR: .gitattributes must mark proprietary/** export-ignore."
  violations=$((violations + 1))
fi

if [[ ! -f proprietary-stubs/LICENSE ]] ||
   ! grep -Fq "MIT License" proprietary-stubs/LICENSE ||
   ! grep -Fq "Permission is hereby granted, free of charge" proprietary-stubs/LICENSE; then
  echo "ERROR: proprietary-stubs/ must ship its full MIT LICENSE."
  violations=$((violations + 1))
fi

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "$violations isolation violation(s). See LICENSE-BOUNDARY.md."
  exit 1
fi

echo "proprietary isolation OK: no forbidden embeds or imports found"
