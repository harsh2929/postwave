#!/usr/bin/env bash
# preflight.sh
#
# Zero-data-loss update gate for Moosewave. Run this before applying a release
# that may include DB migrations:
#
#   DATABASE_URL=postgres://... scripts/update/preflight.sh
#
# It creates a fresh logical backup, runs the migration dry-run, and blocks
# if the migration safety scanner reports a destructive operation.

set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-${ROOT}/infra/migrations}"
BACKUP_DIR="${BACKUP_DIR:-${ROOT}/backups/pre-update}"
ENVIRONMENT="${ENVIRONMENT:-local}"
SKIP_BACKUP="${POSTWAVE_SKIP_PREUPDATE_BACKUP:-0}"

: "${DATABASE_URL:?DATABASE_URL is required}"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { printf '[%s] FAIL: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }

if [[ "${SKIP_BACKUP}" == "1" && "${POSTWAVE_ALLOW_BACKUP_SKIP:-0}" != "1" ]]; then
  fail "refusing to skip pre-update backup without POSTWAVE_ALLOW_BACKUP_SKIP=1"
fi

PLAN_FILE="$(mktemp -t postwave-migration-plan-XXXXXX.txt)"
trap 'rm -f "${PLAN_FILE}"' EXIT

log "=== Moosewave update preflight ==="
log "migrations dir: ${MIGRATIONS_DIR}"

if [[ "${SKIP_BACKUP}" != "1" ]]; then
  log "creating fresh pre-update logical backup"
  DATABASE_URL="${DATABASE_URL}" "${ROOT}/scripts/backup/create-postgres-backup.sh" \
    --output-dir "${BACKUP_DIR}" \
    --env "${ENVIRONMENT}" \
    --label "pre-update"
else
  log "backup skipped by explicit break-glass env; this is not allowed for production"
fi

log "running migration dry-run + safety scanner"
(
  cd "${ROOT}"
  go run ./apps/api/cmd/migrate \
    --dir "${MIGRATIONS_DIR}" \
    --dry-run
) | tee "${PLAN_FILE}"

if grep -Eq '^[[:space:]]*blocker[[:space:]]' "${PLAN_FILE}"; then
  fail "destructive migration finding present. Take a reviewed PITR snapshot, rewrite as expand/contract, or use postwave-migrate --allow-unsafe only after incident-level approval."
fi

if grep -q '^DRIFT:' "${PLAN_FILE}"; then
  fail "migration checksum drift present"
fi

log "preflight OK"
