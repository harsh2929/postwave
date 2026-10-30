#!/usr/bin/env bash
# Fan out the root .env.local to each app's expected env-file location.
#
# Each app loads its env from a different path:
#   apps/api      → apps/api/.env                       (godotenv)
#   apps/web      → apps/web/.env.local                 (Next.js)
#   apps/desktop  → apps/desktop/.env                   (Vite)
#
# Using a single root .env.local + this script lets a collaborator edit
# ONE file and keep everything in sync.
#
# Usage:
#   ./scripts/dev-fanout-env.sh              # fan out, refusing to overwrite
#   ./scripts/dev-fanout-env.sh --force      # overwrite existing per-app envs
#
# Safe to run repeatedly. Reports which files were created vs skipped.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ROOT_DIR}/.env.local"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force|-f)
      FORCE=1
      ;;
    --help|-h)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$SRC" ]]; then
  cat >&2 <<EOF
ERROR: $SRC does not exist.

Bootstrap it first:
  cp .env.local.example .env.local
  # then fill in GENERATE_ME values (see comments inside)

Then re-run this script.
EOF
  exit 1
fi

declare -a TARGETS=(
  "apps/api/.env"
  "apps/web/.env.local"
  "apps/desktop/.env"
)

created=0
skipped=0
overwrote=0

for rel in "${TARGETS[@]}"; do
  dest="${ROOT_DIR}/${rel}"
  destdir="$(dirname "$dest")"
  if [[ ! -d "$destdir" ]]; then
    echo "skip   $rel  (parent dir does not exist — is the repo complete?)"
    skipped=$((skipped + 1))
    continue
  fi
  if [[ -e "$dest" && $FORCE -eq 0 ]]; then
    echo "skip   $rel  (exists; pass --force to overwrite)"
    skipped=$((skipped + 1))
    continue
  fi
  if [[ -e "$dest" ]]; then
    cp "$SRC" "$dest"
    echo "wrote  $rel  (overwrote existing)"
    overwrote=$((overwrote + 1))
  else
    cp "$SRC" "$dest"
    echo "wrote  $rel"
    created=$((created + 1))
  fi
done

echo ""
echo "Done. created=$created  overwrote=$overwrote  skipped=$skipped"

# Helpful next-step nudge.
if grep -qE "GENERATE_ME|PROVIDE_ME" "$SRC"; then
  echo ""
  echo "Heads up: $SRC still has GENERATE_ME / PROVIDE_ME placeholders."
  echo "         Run:  grep -nE 'GENERATE_ME|PROVIDE_ME' .env.local"
  echo "         to see what's left."
fi
