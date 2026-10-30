#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail
source /usr/local/lib/postwave-backup/common.sh

for name in AWS_REGION BACKUP_ENVIRONMENT WALG_S3_PREFIX; do
  require_env "${name}"
done
for command_name in jq timeout wal-g; do
  require_command "${command_name}"
done

wal_verify_timeout="${WAL_VERIFY_TIMEOUT_SECONDS:-3600}"
[[ "${wal_verify_timeout}" =~ ^[1-9][0-9]*$ ]] || fail "WAL_VERIFY_TIMEOUT_SECONDS must be a positive integer"
workdir="$(mktemp -d)"

cleanup() {
  local status=$?
  rm -rf "${workdir}"
  if [[ "${status}" -ne 0 ]]; then
    put_metric_best_effort WalIntegrityHealthy 0 None
    put_metric_best_effort WalIntegrityMonitorSuccess 0 None
  fi
  exit "${status}"
}
trap cleanup EXIT

timeout --signal=TERM --kill-after=60 "${wal_verify_timeout}" \
  wal-g wal-verify integrity timeline --json >"${workdir}/wal-verify.json"
jq -e '.integrity.status == "OK" and .timeline.status == "OK"' "${workdir}/wal-verify.json" >/dev/null || \
  fail "WAL-G integrity/timeline verification did not report OK"

put_metric WalIntegrityHealthy 1 None
put_metric WalIntegrityMonitorSuccess 1 None
log "bounded WAL integrity and timeline verification passed"
