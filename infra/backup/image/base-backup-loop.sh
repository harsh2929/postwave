#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail
source /usr/local/lib/postwave-backup/common.sh

for name in BACKUP_BUCKET AWS_REGION BACKUP_ENVIRONMENT; do
  require_env "${name}"
done

interval="${BASE_BACKUP_INTERVAL_SECONDS:-86400}"
poll="${BASE_BACKUP_CHECK_SECONDS:-900}"
[[ "${interval}" =~ ^[1-9][0-9]*$ ]] || fail "BASE_BACKUP_INTERVAL_SECONDS must be a positive integer"
[[ "${poll}" =~ ^[1-9][0-9]*$ ]] || fail "BASE_BACKUP_CHECK_SECONDS must be a positive integer"
heartbeat_key="postgres/${BACKUP_ENVIRONMENT}/health/base-backup/latest.json"

while true; do
  last_modified="$(aws s3api head-object \
    --region "${AWS_REGION}" \
    --bucket "${BACKUP_BUCKET}" \
    --key "${heartbeat_key}" \
    --query LastModified --output text 2>/dev/null || true)"

  due=1
  if [[ -n "${last_modified}" && "${last_modified}" != "None" ]]; then
    age="$(age_seconds "${last_modified}")"
    [[ "${age}" -ge 0 ]] || age=0
    if [[ "${age}" -lt "${interval}" ]]; then
      due=0
      log "base backup age ${age}s; next check in ${poll}s"
    fi
  fi

  if [[ "${due}" -eq 1 ]]; then
    if ! /usr/local/bin/postwave-base-backup; then
      log "base backup attempt failed; retrying after ${poll}s" >&2
    fi
  fi
  sleep "${poll}"
done
