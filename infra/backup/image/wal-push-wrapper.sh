#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail
: "${POSTGRES_SYSTEM_IDENTIFIER:?POSTGRES_SYSTEM_IDENTIFIER must be set}"
[[ "${POSTGRES_SYSTEM_IDENTIFIER}" =~ ^[0-9]{10,20}$ ]] || {
  echo "invalid POSTGRES_SYSTEM_IDENTIFIER" >&2
  exit 126
}

actual_system_identifier="$(psql --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 \
  -c 'SELECT system_identifier FROM pg_control_system()')" || exit 126
[[ "${actual_system_identifier}" == "${POSTGRES_SYSTEM_IDENTIFIER}" ]] || {
  echo "refusing to mix WAL from PostgreSQL system ${actual_system_identifier} into generation ${POSTGRES_SYSTEM_IDENTIFIER}" >&2
  exit 126
}
exec /usr/local/bin/wal-g wal-push "$@"
