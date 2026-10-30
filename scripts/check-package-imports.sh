#!/usr/bin/env bash
# CI guard: packages/* are the MIT layer and must not import application code.

set -euo pipefail

cd "$(dirname "$0")/.."

violations=0

if matches=$(
  git grep -nE "(from|import\(|require\())[[:space:]]*['\"][^'\"]*((^|/)(apps|services)/|(apps|services)/)" \
    -- "packages/**/*.ts" "packages/**/*.tsx" "packages/**/*.js" "packages/**/*.jsx" \
       "packages/**/*.mjs" "packages/**/*.cjs" 2>/dev/null || true
); then
  if [[ -n "$matches" ]]; then
    echo "ERROR: JS/TS package imports app/service layer code." >&2
    echo "$matches" >&2
    violations=$((violations + 1))
  fi
fi

if matches=$(
  git grep -nE "^[[:space:]]*(from|import)[[:space:]]+(apps|services)([.]|[[:space:]]|$)" \
    -- "packages/**/*.py" 2>/dev/null || true
); then
  if [[ -n "$matches" ]]; then
    echo "ERROR: Python package imports app/service layer code." >&2
    echo "$matches" >&2
    violations=$((violations + 1))
  fi
fi

set +e
matches=$(go run ./scripts/check-go-package-imports.go packages)
go_scan_status=$?
set -e
if (( go_scan_status != 0 )); then
  echo "ERROR: Go package import scan could not complete." >&2
  exit "$go_scan_status"
fi
if [[ -n "$matches" ]]; then
  echo "ERROR: Go package imports app/service layer code." >&2
  echo "$matches" >&2
  violations=$((violations + 1))
fi

if (( violations > 0 )); then
  cat >&2 <<'EOF'

Package import boundary violation detected.

packages/* is the MIT client/tooling layer and must not import from apps/ or
services/. Move shared types into packages/schema or communicate over a public
API boundary instead.
EOF
  exit 1
fi

echo "package import boundary OK: no package imports from apps/ or services/"
