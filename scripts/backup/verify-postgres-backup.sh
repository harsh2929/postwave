#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Verify a PostgreSQL physical restore running in an isolated Docker container.

set -euo pipefail

CONTAINER=""
OUTPUT=""
DATABASE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --database) DATABASE="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

[[ "${CONTAINER}" =~ ^postwave-dr-[a-z0-9-]+$ ]] || {
  echo "--container must identify a postwave-dr-* isolated drill container" >&2
  exit 64
}
[[ -n "${OUTPUT}" ]] || { echo "--output is required" >&2; exit 64; }
[[ "${DATABASE}" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || {
  echo "--database is required and must be a safe lowercase PostgreSQL database name" >&2
  exit 64
}
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 69; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 69; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { log "FAIL: $*" >&2; exit 1; }
q() {
  docker exec --user 999:999 "${CONTAINER}" \
    psql --username=postgres --dbname="${DATABASE}" --quiet --no-align --tuples-only -v ON_ERROR_STOP=1 -c "$1"
}

network_mode="$(docker inspect --format '{{.HostConfig.NetworkMode}}' "${CONTAINER}")"
published_ports="$(docker inspect --format '{{json .HostConfig.PortBindings}}' "${CONTAINER}")"
[[ "${network_mode}" == "none" ]] || fail "drill container must have all networking disabled"
[[ "${published_ports}" == "null" || "${published_ports}" == "{}" ]] || fail "drill container publishes a port"

[[ "$(q 'SELECT pg_is_in_recovery()')" == "f" ]] || fail "PostgreSQL has not completed archive recovery"

for table in schema_migrations tenants users subscribers; do
  [[ "$(q "SELECT to_regclass('public.${table}') IS NOT NULL")" == "t" ]] || fail "required table is missing: ${table}"
done

migration_count="$(q 'SELECT count(*) FROM public.schema_migrations')"
[[ "${migration_count}" -gt 0 ]] || fail "schema_migrations is empty"
latest_migration="$(q 'SELECT version::text FROM public.schema_migrations ORDER BY version DESC LIMIT 1')"

tenant_rls_failures="$(q "
  SELECT count(*)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r','p')
     AND NOT c.relispartition
     AND EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
     )
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
")"
[[ "${tenant_rls_failures}" -eq 0 ]] || fail "${tenant_rls_failures} tenant-scoped tables lost enabled+forced RLS"

invalid_foreign_keys="$(q "SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated")"
[[ "${invalid_foreign_keys}" -eq 0 ]] || fail "${invalid_foreign_keys} foreign keys are not validated"
invalid_indexes="$(q "SELECT count(*) FROM pg_index WHERE NOT indisvalid OR NOT indisready")"
[[ "${invalid_indexes}" -eq 0 ]] || fail "${invalid_indexes} indexes are invalid or not ready"

database_size_bytes="$(q 'SELECT pg_database_size(current_database())')"
tenant_count="$(q 'SELECT count(*) FROM public.tenants')"
user_count="$(q 'SELECT count(*) FROM public.users')"
subscriber_count="$(q 'SELECT count(*) FROM public.subscribers')"
last_replay_lsn="$(q "SELECT COALESCE(pg_last_wal_replay_lsn()::text, '')")"
last_replay_timestamp="$(q "SELECT COALESCE(pg_last_xact_replay_timestamp()::text, '')")"

jq -n \
  --arg verified_at "$(date -u +%FT%TZ)" \
  --arg database "${DATABASE}" \
  --arg latest_migration "${latest_migration}" \
  --arg last_replay_lsn "${last_replay_lsn}" \
  --arg last_replay_timestamp "${last_replay_timestamp}" \
  --argjson migration_count "${migration_count}" \
  --argjson database_size_bytes "${database_size_bytes}" \
  --argjson tenants "${tenant_count}" \
  --argjson users "${user_count}" \
  --argjson subscribers "${subscriber_count}" \
  '{
    verification_version: 2,
    verified_at: $verified_at,
    database: $database,
    postgres_recovery_complete: true,
    network_isolated_from_inbound_traffic: true,
    network_egress_disabled: true,
    schema: {latest_migration:$latest_migration,migration_count:$migration_count},
    integrity: {
      tenant_scoped_tables_have_forced_rls: true,
      foreign_keys_validated: true,
      indexes_valid_and_ready: true
    },
    database_size_bytes: $database_size_bytes,
    diagnostic_row_counts: {tenants:$tenants,users:$users,subscribers:$subscribers},
    last_replay_lsn: $last_replay_lsn,
    last_replay_timestamp: $last_replay_timestamp
  }' >"${OUTPUT}"

log "restore verification passed (migration=${latest_migration}, size=${database_size_bytes} bytes)"
