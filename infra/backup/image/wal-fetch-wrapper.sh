#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

# PostgreSQL treats an ordinary missing archive file as the end of available
# WAL, but exit statuses 126-255 as a fatal restore_command failure. Pinned
# WAL-G uses 74 for an ordinary missing segment. Preserve only success/missing;
# map every other error (configuration, auth, KMS, transport, corruption) to a
# fatal status so PostgreSQL cannot silently promote after an infrastructure
# failure.
set +e
/usr/local/bin/wal-g wal-fetch "$@"
status=$?
set -e

case "${status}" in
  0|74) exit "${status}" ;;
  *) exit 126 ;;
esac
