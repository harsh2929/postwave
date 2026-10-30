#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Local integration test for the exact PostgreSQL/WAL-G image: create a base
# backup, continuously archive WAL, perform PITR into an isolated volume, and
# prove a pre-target row exists while a post-target row does not.

set -euo pipefail

IMAGE="${LOCAL_BACKUP_IMAGE:-postwave-backup:local-test}"
run_id="$(date -u +%Y%m%dt%H%M%S)-$RANDOM"
source_container="postwave-walg-source-${run_id}"
restore_container="postwave-dr-${run_id}"
source_volume="postwave-walg-source-${run_id}"
restore_volume="postwave-walg-restore-${run_id}"
backup_volume="postwave-walg-backup-${run_id}"
workdir="$(mktemp -d -t postwave-walg-test.XXXXXX)"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

cleanup() {
  local status=$?
  if [[ "${status}" -ne 0 ]]; then
    docker logs "${source_container}" >&2 2>/dev/null || true
    docker logs "${restore_container}" >&2 2>/dev/null || true
  fi
  docker rm --force "${source_container}" "${restore_container}" >/dev/null 2>&1 || true
  docker volume rm --force "${source_volume}" "${restore_volume}" "${backup_volume}" >/dev/null 2>&1 || true
  rm -rf "${workdir}"
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

docker image inspect "${IMAGE}" >/dev/null
docker volume create "${source_volume}" >/dev/null
docker volume create "${restore_volume}" >/dev/null
docker volume create "${backup_volume}" >/dev/null
docker run --rm --user 0:0 --mount "type=volume,src=${source_volume},dst=/var/lib/postgresql/data" "${IMAGE}" \
  install -d -o 999 -g 999 -m 0700 /var/lib/postgresql/data/pgdata
docker run --rm --user 0:0 --mount "type=volume,src=${backup_volume},dst=/backup" "${IMAGE}" \
  install -d -o 999 -g 999 -m 0700 /backup/walg

docker run --detach \
  --name "${source_container}" \
  --network none \
  --user 999:999 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=999,gid=999 \
  --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m,uid=999,gid=999 \
  --env POSTGRES_PASSWORD=local-integration-only \
  --env POSTGRES_INITDB_ARGS=--data-checksums \
  --env PGDATA=/var/lib/postgresql/data/pgdata \
  --env WALG_FILE_PREFIX=/backup/walg \
  --mount "type=volume,src=${source_volume},dst=/var/lib/postgresql/data" \
  --mount "type=volume,src=${backup_volume},dst=/backup" \
  "${IMAGE}" \
  postgres \
    -c listen_addresses='' \
    -c archive_mode=on \
    -c wal_level=replica \
    -c archive_timeout=1s \
    -c "archive_command=/usr/local/bin/wal-g wal-push %p" >/dev/null

for _ in $(seq 1 120); do
  if docker exec --user 999:999 "${source_container}" pg_isready --username=postgres --dbname=postgres --timeout=2 >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec --user 999:999 "${source_container}" pg_isready --username=postgres --dbname=postgres --timeout=2 >/dev/null || fail "source PostgreSQL did not become ready"
docker exec --user 999:999 "${source_container}" createdb --username=postgres postwave

docker exec --user 999:999 -i "${source_container}" psql --username=postgres --dbname=postwave -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE TABLE schema_migrations (version integer PRIMARY KEY);
INSERT INTO schema_migrations VALUES (1713);
CREATE TABLE tenants (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, marker text NOT NULL);
CREATE TABLE users (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
CREATE TABLE subscribers (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_isolation ON tenants USING (true);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_isolation ON users USING (true);
ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscribers FORCE ROW LEVEL SECURITY;
CREATE POLICY subscribers_isolation ON subscribers USING (true);
INSERT INTO tenants VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'base');
INSERT INTO users VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001');
INSERT INTO subscribers VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001');
SQL

log "creating verified physical base backup"
source_system_identifier="$(docker exec --user 999:999 "${source_container}" psql --username=postgres --dbname=postwave -Atqc 'SELECT system_identifier FROM pg_control_system()')"
local_backup_id="local-${run_id}"
docker exec \
  --user 999:999 \
  --env WALG_FILE_PREFIX=/backup/walg \
  --env WALG_VERIFY_PAGE_CHECKSUMS=true \
  --env "WALG_SENTINEL_USER_DATA={\"postwave_backup_id\":\"${local_backup_id}\",\"environment\":\"test\",\"cluster_id\":\"local-test\",\"system_identifier\":\"${source_system_identifier}\"}" \
  "${source_container}" \
  wal-g backup-push --verify /var/lib/postgresql/data/pgdata >/dev/null
docker exec --user 999:999 --env WALG_FILE_PREFIX=/backup/walg "${source_container}" \
  wal-g backup-list --detail --json >"${workdir}/backup-list.json"
jq -e --arg backup_id "${local_backup_id}" '
  def user_data:
    (.user_data // .UserData // .userData // .userdata // {}) |
    if type == "string" then (try fromjson catch {}) else . end;
  [.[] | select((user_data.postwave_backup_id // "") == $backup_id)] | length == 1
' "${workdir}/backup-list.json" >/dev/null || fail "WAL-G did not retain the base-backup job sentinel"
if docker exec --user 999:999 \
  --env WALG_FILE_PREFIX=/backup/walg \
  --env POSTGRES_SYSTEM_IDENTIFIER=0000000000000000000 \
  "${source_container}" /usr/local/bin/postwave-wal-push /var/lib/postgresql/data/pgdata/PG_VERSION >/dev/null 2>&1; then
  fail "WAL push wrapper accepted the wrong PostgreSQL system identifier"
fi

docker exec --user 999:999 "${source_container}" psql --username=postgres --dbname=postwave -v ON_ERROR_STOP=1 \
  -c "UPDATE tenants SET marker='before-target' WHERE id='00000000-0000-0000-0000-000000000001'" >/dev/null
sleep 1
target_time="$(docker exec --user 999:999 "${source_container}" psql --username=postgres --dbname=postwave -Atqc "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS+00')")"
sleep 2
docker exec --user 999:999 "${source_container}" psql --username=postgres --dbname=postwave -v ON_ERROR_STOP=1 \
  -c "UPDATE tenants SET marker='after-target' WHERE id='00000000-0000-0000-0000-000000000001'" >/dev/null
docker exec --user 999:999 "${source_container}" psql --username=postgres --dbname=postwave -Atqc 'SELECT pg_switch_wal()' >/dev/null

for _ in $(seq 1 60); do
  archived="$(docker exec --user 999:999 "${source_container}" psql --username=postgres --dbname=postwave -Atqc 'SELECT archived_count FROM pg_stat_archiver')"
  [[ "${archived}" -ge 2 ]] && break
  sleep 1
done
[[ "${archived:-0}" -ge 2 ]] || fail "continuous archiver did not publish the expected WAL segments"
docker stop --time 30 "${source_container}" >/dev/null

docker run --rm --user 0:0 --mount "type=volume,src=${restore_volume},dst=/restore" "${IMAGE}" \
  install -d -o 999 -g 999 -m 0700 /restore/pgdata
docker run --rm --user 999:999 \
  --env WALG_FILE_PREFIX=/backup/walg \
  --mount "type=volume,src=${restore_volume},dst=/restore" \
  --mount "type=volume,src=${backup_volume},dst=/backup,readonly" \
  "${IMAGE}" wal-g backup-fetch /restore/pgdata LATEST >/dev/null
docker run --rm --user 999:999 --mount "type=volume,src=${restore_volume},dst=/restore" "${IMAGE}" \
  /bin/bash -euo pipefail -c "cat >>/restore/pgdata/postgresql.auto.conf <<'EOF'
restore_command = '/usr/local/bin/postwave-wal-fetch %f %p'
recovery_target_time = '${target_time}'
recovery_target_timeline = 'latest'
recovery_target_action = 'promote'
EOF
touch /restore/pgdata/recovery.signal"

docker run --detach \
  --name "${restore_container}" \
  --network none \
  --user 999:999 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=999,gid=999 \
  --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=16m,uid=999,gid=999 \
  --env PGDATA=/var/lib/postgresql/data/pgdata \
  --env WALG_FILE_PREFIX=/backup/walg \
  --mount "type=volume,src=${restore_volume},dst=/var/lib/postgresql/data" \
  --mount "type=volume,src=${backup_volume},dst=/backup,readonly" \
  "${IMAGE}" postgres -c listen_addresses='' -c unix_socket_directories=/var/run/postgresql >/dev/null

for _ in $(seq 1 180); do
  if docker exec --user 999:999 "${restore_container}" pg_isready --username=postgres --dbname=postwave --timeout=2 >/dev/null 2>&1 &&
     [[ "$(docker exec --user 999:999 "${restore_container}" psql --username=postgres --dbname=postwave -Atqc 'SELECT pg_is_in_recovery()')" == "f" ]]; then
    break
  fi
  [[ "$(docker inspect --format '{{.State.Running}}' "${restore_container}")" == "true" ]] || fail "recovery PostgreSQL container exited"
  sleep 1
done

"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-postgres-backup.sh" \
  --container "${restore_container}" --database postwave \
  --output "${workdir}/verification.json" >/dev/null

marker="$(docker exec --user 999:999 "${restore_container}" psql --username=postgres --dbname=postwave -Atqc "SELECT marker FROM tenants WHERE id='00000000-0000-0000-0000-000000000001'")"
[[ "${marker}" == "before-target" ]] || fail "PITR marker mismatch: got ${marker}, expected before-target"
log "WAL-G base backup, continuous WAL chain, isolated PITR, checksums, RLS, FK, and index verification passed"
