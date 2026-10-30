#!/usr/bin/env bash
# Creates a disposable PostgreSQL cluster with a private Unix socket. Never
# reads DATABASE_URL from the caller and never connects to staging/production.
set -euo pipefail

migration_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
migration_pg_bin="${POSTWAVE_TEST_POSTGRES_BIN:-}"
if [[ -z "$migration_pg_bin" ]]; then
  for candidate in /opt/homebrew/opt/postgresql@16/bin /opt/homebrew/opt/postgresql@17/bin /usr/lib/postgresql/16/bin /usr/lib/postgresql/17/bin; do
    if [[ -x "$candidate/initdb" ]]; then migration_pg_bin="$candidate"; break; fi
  done
fi
if [[ -z "$migration_pg_bin" ]] && command -v initdb >/dev/null; then
  migration_pg_bin="$(dirname "$(command -v initdb)")"
fi
if [[ ! -x "$migration_pg_bin/initdb" ]]; then
  echo 'PostgreSQL 16+ is required. Set POSTWAVE_TEST_POSTGRES_BIN to its bin directory.' >&2
  exit 1
fi

migration_test_dir="$(mktemp -d /tmp/postwave-migration-tests.XXXXXX)"
chmod 700 "$migration_test_dir"
migration_pg_started=0
cleanup() {
  if [[ "$migration_pg_started" == 1 ]]; then
    "$migration_pg_bin/pg_ctl" -D "$migration_test_dir/data" -m fast -w stop >> "$migration_test_dir/postgres.log" 2>&1 || true
  fi
  echo "Local test logs: $migration_test_dir"
}
trap cleanup EXIT
"$migration_pg_bin/initdb" -D "$migration_test_dir/data" -U postgres -A trust --encoding=UTF8 --locale=C > "$migration_test_dir/initdb.log"
"$migration_pg_bin/pg_ctl" -D "$migration_test_dir/data" -l "$migration_test_dir/postgres.log" -o "-k $migration_test_dir -h '' -c max_locks_per_transaction=512" -w start
migration_pg_started=1
"$migration_pg_bin/createdb" -h "$migration_test_dir" -U postgres postwave
"$migration_pg_bin/psql" -h "$migration_test_dir" -U postgres -d postwave -v ON_ERROR_STOP=1 -c 'CREATE ROLE postwave_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT CONNECT ON DATABASE postwave TO postwave_app;'
export POSTWAVE_TEST_ADMIN_DATABASE_URL="postgres://postgres@/postwave?host=$migration_test_dir&sslmode=disable"
export TEST_DATABASE_URL="postgres://postwave_app@/postwave?host=$migration_test_dir&sslmode=disable"
cd "$migration_repo_root"
echo 'Applying the repository schema to the disposable local database.'
if ! DATABASE_URL="$POSTWAVE_TEST_ADMIN_DATABASE_URL" go run ./apps/api/cmd/migrate --dir infra/migrations --allow-unsafe --timeout 20m > "$migration_test_dir/schema.log" 2>&1; then
  tail -n 40 "$migration_test_dir/schema.log" >&2
  exit 1
fi
export DATABASE_URL="$TEST_DATABASE_URL"
echo 'Running migration database, isolation, recovery and rollback tests.'
if [[ "$#" -gt 0 ]]; then
  "$@"
else
  go test -json -count=1 -timeout=15m ./services/migration/... ./packages/runtime/tenantengine > "$migration_test_dir/tests.jsonl"
  python3 - "$migration_test_dir/tests.jsonl" <<'PY'
import collections, json, sys
counts = collections.Counter()
skips = []
for line in open(sys.argv[1]):
    event = json.loads(line)
    if event.get('Test'):
        counts[event['Action']] += 1
        if event['Action'] == 'skip':
            skips.append(event['Package'] + ':' + event['Test'])
print(f"Passed: {counts['pass']}; failed: {counts['fail']}; skipped: {len(skips)}")
if skips:
    print('\n'.join(skips))
    raise SystemExit('Local database qualification is incomplete: tests were skipped.')
PY
fi
