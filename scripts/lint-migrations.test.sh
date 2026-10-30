#!/usr/bin/env bash
# lint-migrations.test.sh
#
# Self-contained smoke test for scripts/lint-migrations.sh.
#
# Synthesizes bad/good migrations and mutated baseline ledgers in a tmpdir,
# runs the linter against them, and asserts:
#
#   * each bad migration is flagged with the correct rule code
#   * the good migration is not flagged
#   * the linter exits non-zero when any violation is present
#   * the linter exits zero when only the good migration is scanned
#   * any unpinned baseline mutation fails
#   * a stale/unknown finding fails even if a test explicitly re-pins the file
#   * an expired review date fails closed
#   * a repair migration named by any ledger entry exists and is forward-only
#   * the effective-schema verifier's tenant rules accept a direct or
#     parent-bound tenant_id and the exact reviewed exceptions, and reject every
#     weakened shape (scripts/lint-migrations-schema.test.py; no database needed)
#   * a '--' or '/*' inside a string literal is not a comment, while comments
#     inside a dollar-quoted body still are
#
# Run locally:
#   scripts/lint-migrations.test.sh
#
# Run in CI as part of the rls-policy-check / migration-lint job (see
# .github/workflows/ci.yml). Test fixtures live in a tmpdir so they
# never pollute infra/migrations/.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
LINT="$ROOT/scripts/lint-migrations.sh"
LINT_IMPL="$ROOT/scripts/lint-migrations.py"
BASELINE="$ROOT/scripts/lint-migrations-baseline.json"

if [[ ! -x "$LINT" ]]; then
    chmod +x "$LINT" || true
fi
if [[ ! -f "$LINT" ]]; then
    echo "FAIL: $LINT not found" >&2
    exit 2
fi

# Parser/violation fixtures must remain runnable even when the authoritative
# repository baseline is doing its job and blocking on newly discovered real
# migration findings. Import the production implementation directly for these
# synthetic files; runs 5-9 below continue to exercise the checksum, expiry,
# scope, identity, and verification fail-closed baseline paths through the
# production shell entrypoint. CI invokes lint-migrations.sh separately for the
# real tree, so this test-only harness cannot waive a repository finding.
lint_fixture_files() {
    python3 - "$LINT_IMPL" "$ROOT" "$@" <<'PY'
import importlib.util
from pathlib import Path
import sys

implementation, root, *arguments = sys.argv[1:]
spec = importlib.util.spec_from_file_location("postwave_lint_migrations", implementation)
if spec is None or spec.loader is None:
    raise RuntimeError("could not load lint-migrations implementation")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

files = [
    Path(argument).resolve()
    for argument in arguments
    if argument.endswith(".sql") and Path(argument).is_file()
]
findings = [
    finding
    for path in files
    for finding in module.lint_file(path, Path(root).resolve())
]
if findings:
    module.print_violations(findings)
    raise SystemExit(1)
print(f"OK: {len(files)} synthetic migration file(s) passed parser checks.")
PY
}

TMP="$(mktemp -d -t lint-migrations-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/migrations"

# -----------------------------------------------------------------------------
# Bad fixture #1: CREATE INDEX without CONCURRENTLY on existing table.
# Expected: CONCURRENTLY-MISSING for `subscribers`.
# -----------------------------------------------------------------------------
cat > "$TMP/migrations/9001_bad_index.sql" <<'SQL'
-- Bad: subscribers is a write-hot table; non-concurrent CREATE INDEX
-- will take ACCESS EXCLUSIVE and block writers.
BEGIN;
CREATE INDEX IF NOT EXISTS subscribers_engagement_score_idx
    ON subscribers (tenant_id, engagement_score DESC);
COMMIT;
SQL

# -----------------------------------------------------------------------------
# Bad fixture #2: New tenant-scoped table missing FORCE RLS and policy.
# Expected: FORCE-RLS-MISSING for `widget_audit` (3 issues: no ENABLE,
# no FORCE, no PERMISSIVE policy). FK is present so no FK violation.
# -----------------------------------------------------------------------------
cat > "$TMP/migrations/9002_bad_force_rls.sql" <<'SQL'
BEGIN;
CREATE TABLE IF NOT EXISTS widget_audit (
    id         bigserial PRIMARY KEY,
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    payload    jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
-- Forgot ENABLE / FORCE / CREATE POLICY -- linter must catch all three.
COMMIT;
SQL

# -----------------------------------------------------------------------------
# Bad fixture #3: New tenant-scoped table with NO FK to tenants(id).
# Expected: FK-TO-TENANTS-MISSING for `widget_events`.
# -----------------------------------------------------------------------------
cat > "$TMP/migrations/9003_bad_fk.sql" <<'SQL'
BEGIN;
CREATE TABLE IF NOT EXISTS widget_events (
    id         bigserial PRIMARY KEY,
    tenant_id  uuid NOT NULL,
    kind       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE widget_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE widget_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY widget_events_tenant_visible ON widget_events
    FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
COMMIT;
SQL

# -----------------------------------------------------------------------------
# Good fixture: everything correct.
# Expected: no violations.
# -----------------------------------------------------------------------------
cat > "$TMP/migrations/9004_good_full.sql" <<'SQL'
BEGIN;
CREATE TABLE IF NOT EXISTS widget_good (
    id         bigserial PRIMARY KEY,
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE widget_good ENABLE ROW LEVEL SECURITY;
ALTER TABLE widget_good FORCE  ROW LEVEL SECURITY;
CREATE POLICY widget_good_tenant_visible ON widget_good
    FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
COMMIT;

-- Inline index inside the CREATE TABLE block above is fine; a follow-up
-- index on this brand-new table is also fine (table is created in this
-- same file, so it cannot yet have any writers to block).
CREATE INDEX IF NOT EXISTS widget_good_name_idx ON widget_good (tenant_id, name);
SQL

# -----------------------------------------------------------------------------
# Run #1: all four files together — expect FAIL with all three rules.
# -----------------------------------------------------------------------------
echo "TEST 1: bad+good fixtures should FAIL with all 3 rule codes"
set +e
OUT="$(lint_fixture_files \
    "$TMP/migrations/9001_bad_index.sql" \
    "$TMP/migrations/9002_bad_force_rls.sql" \
    "$TMP/migrations/9003_bad_fk.sql" \
    "$TMP/migrations/9004_good_full.sql" 2>&1)"
RC=$?
set -e

if [[ $RC -eq 0 ]]; then
    echo "FAIL: linter exited 0 but expected non-zero" >&2
    echo "--- linter output ---" >&2
    echo "$OUT" >&2
    exit 1
fi

for rule in CONCURRENTLY-MISSING FORCE-RLS-MISSING FK-TO-TENANTS-MISSING; do
    if ! grep -q "$rule" <<<"$OUT"; then
        echo "FAIL: expected rule '$rule' in output" >&2
        echo "--- linter output ---" >&2
        echo "$OUT" >&2
        exit 1
    fi
done

# widget_good must NOT appear as a violation source.
if grep -E '\[(CONCURRENTLY|FORCE-RLS|FK-TO-TENANTS)-MISSING\] table=`widget_good`' <<<"$OUT" >/dev/null; then
    echo "FAIL: widget_good (the good fixture) was flagged" >&2
    echo "--- linter output ---" >&2
    echo "$OUT" >&2
    exit 1
fi

echo "  OK: all three rule codes fired; good fixture untouched."

# -----------------------------------------------------------------------------
# Run #2: only the good fixture — expect PASS (exit 0).
# -----------------------------------------------------------------------------
echo "TEST 2: good fixture alone should PASS"
set +e
OUT="$(lint_fixture_files "$TMP/migrations/9004_good_full.sql" 2>&1)"
RC=$?
set -e

if [[ $RC -ne 0 ]]; then
    echo "FAIL: good fixture should pass; linter exited $RC" >&2
    echo "--- linter output ---" >&2
    echo "$OUT" >&2
    exit 1
fi
echo "  OK: good fixture passed cleanly."

# -----------------------------------------------------------------------------
# Run #3: empty target set (no files) — expect skip (exit 0).
# Simulate via passing a non-.sql path; the linter filters it out.
# -----------------------------------------------------------------------------
echo "TEST 3: empty .sql target set should SKIP (exit 0)"
touch "$TMP/migrations/not-a-migration.txt"
set +e
OUT="$(lint_fixture_files "$TMP/migrations/not-a-migration.txt" 2>&1)"
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
    echo "FAIL: empty target set should skip with exit 0; got $RC" >&2
    echo "--- linter output ---" >&2
    echo "$OUT" >&2
    exit 1
fi
echo "  OK: empty target set skipped cleanly."

# -----------------------------------------------------------------------------
# Run #4: CONCURRENTLY rule allowlist — `settings` is in the allowlist.
# Expected: PASS for an otherwise-illegal CREATE INDEX on settings.
# -----------------------------------------------------------------------------
cat > "$TMP/migrations/9005_allowlisted_table.sql" <<'SQL'
BEGIN;
CREATE INDEX IF NOT EXISTS settings_updated_at_idx ON settings (updated_at);
COMMIT;
SQL
echo "TEST 4: CONCURRENTLY allowlist (settings) should PASS"
set +e
OUT="$(lint_fixture_files "$TMP/migrations/9005_allowlisted_table.sql" 2>&1)"
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
    echo "FAIL: allowlisted table should pass; linter exited $RC" >&2
    echo "--- linter output ---" >&2
    echo "$OUT" >&2
    exit 1
fi
echo "  OK: allowlisted table accepted."

# -----------------------------------------------------------------------------
# Run #5: any baseline mutation without a matching reviewed checksum pin fails.
# -----------------------------------------------------------------------------
echo "TEST 5: unpinned baseline mutation should FAIL"
MUTATED_BASELINE="$TMP/mutated-baseline.json"
python3 - "$BASELINE" "$MUTATED_BASELINE" <<'PY'
import json
import sys

source, destination = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    ledger = json.load(handle)
ledger["findings"][0]["table"] = "mutated_without_review"
with open(destination, "w", encoding="utf-8") as handle:
    json.dump(ledger, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
set +e
OUT="$(POSTWAVE_MIGRATION_LINT_BASELINE="$MUTATED_BASELINE" \
    "$LINT" "$TMP/migrations/9004_good_full.sql" 2>&1)"
RC=$?
set -e
if [[ $RC -eq 0 ]] || ! grep -q "baseline checksum mismatch" <<<"$OUT"; then
    echo "FAIL: mutated baseline did not fail its checksum pin" >&2
    echo "$OUT" >&2
    exit 1
fi
echo "  OK: checksum pin rejected the mutation."

# -----------------------------------------------------------------------------
# Run #6: even if a test re-pins a changed ledger, a stale/unknown identity
# cannot suppress a real finding from an exact baseline source file.
# -----------------------------------------------------------------------------
echo "TEST 6: re-pinned stale baseline identity should FAIL"
STALE_SHA="$(python3 - "$MUTATED_BASELINE" <<'PY'
import hashlib
import sys

with open(sys.argv[1], "rb") as handle:
    print(hashlib.sha256(handle.read()).hexdigest())
PY
)"
set +e
OUT="$(POSTWAVE_MIGRATION_LINT_BASELINE="$MUTATED_BASELINE" \
    POSTWAVE_MIGRATION_LINT_BASELINE_SHA256="$STALE_SHA" \
    "$LINT" "$TMP/migrations/9004_good_full.sql" 2>&1)"
RC=$?
set -e
if [[ $RC -eq 0 ]] ||
    ! grep -q "baseline no longer exactly matches source" <<<"$OUT" ||
    ! grep -q "stale/unknown ledger entries=1" <<<"$OUT"; then
    echo "FAIL: stale/unknown re-pinned baseline identity was accepted" >&2
    echo "$OUT" >&2
    exit 1
fi
echo "  OK: source reconciliation rejected the stale identity."

# -----------------------------------------------------------------------------
# Run #7: review ownership is time-bounded; the ledger expires automatically.
# -----------------------------------------------------------------------------
echo "TEST 7: expired baseline review should FAIL"
set +e
OUT="$(POSTWAVE_MIGRATION_LINT_TODAY=2026-10-01 \
    "$LINT" "$TMP/migrations/9004_good_full.sql" 2>&1)"
RC=$?
set -e
if [[ $RC -eq 0 ]] || ! grep -q "baseline review expired" <<<"$OUT"; then
    echo "FAIL: expired baseline review was accepted" >&2
    echo "$OUT" >&2
    exit 1
fi
echo "  OK: expired review failed closed."

# -----------------------------------------------------------------------------
# Run #8: the ledger must cover the full migration tree, not a cherry-picked
# subset of historical files.
# -----------------------------------------------------------------------------
echo "TEST 8: partial-scope baseline should FAIL even when re-pinned"
PARTIAL_BASELINE="$TMP/partial-baseline.json"
read -r PARTIAL_SHA < <(python3 - "$BASELINE" "$PARTIAL_BASELINE" <<'PY'
import hashlib
import json
import sys

source, destination = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    ledger = json.load(handle)
ledger["scope"] = "partial-history"
with open(destination, "w", encoding="utf-8") as handle:
    json.dump(ledger, handle, indent=2, sort_keys=True)
    handle.write("\n")
with open(destination, "rb") as handle:
    print(hashlib.sha256(handle.read()).hexdigest())
PY
)
set +e
OUT="$(POSTWAVE_MIGRATION_LINT_BASELINE="$PARTIAL_BASELINE" \
    POSTWAVE_MIGRATION_LINT_BASELINE_SHA256="$PARTIAL_SHA" \
    "$LINT" "$TMP/migrations/9004_good_full.sql" 2>&1)"
RC=$?
set -e
if [[ $RC -eq 0 ]] || ! grep -q "baseline scope must be full-migration-tree" <<<"$OUT"; then
    echo "FAIL: re-pinned partial-scope baseline was accepted" >&2
    echo "$OUT" >&2
    exit 1
fi
echo "  OK: partial-scope ledger failed closed."

# -----------------------------------------------------------------------------
# Run #9: a finding cannot name a verifier the effective-schema gate does not
# understand.
# -----------------------------------------------------------------------------
echo "TEST 9: unsupported verification kind should FAIL even when re-pinned"
UNKNOWN_KIND_BASELINE="$TMP/unknown-kind-baseline.json"
read -r UNKNOWN_KIND_SHA < <(python3 - "$BASELINE" "$UNKNOWN_KIND_BASELINE" <<'PY'
import hashlib
import json
import sys

source, destination = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    ledger = json.load(handle)
ledger["findings"][0]["verification"]["kind"] = "silently_ignored"
with open(destination, "w", encoding="utf-8") as handle:
    json.dump(ledger, handle, indent=2, sort_keys=True)
    handle.write("\n")
with open(destination, "rb") as handle:
    print(hashlib.sha256(handle.read()).hexdigest())
PY
)
set +e
OUT="$(POSTWAVE_MIGRATION_LINT_BASELINE="$UNKNOWN_KIND_BASELINE" \
    POSTWAVE_MIGRATION_LINT_BASELINE_SHA256="$UNKNOWN_KIND_SHA" \
    "$LINT" "$TMP/migrations/9004_good_full.sql" 2>&1)"
RC=$?
set -e
if [[ $RC -eq 0 ]] || ! grep -q "verification kind.*is invalid" <<<"$OUT"; then
    echo "FAIL: unsupported verification kind was accepted" >&2
    echo "$OUT" >&2
    exit 1
fi
echo "  OK: unsupported verification kind failed closed."

# -----------------------------------------------------------------------------
# Run #10: the effective-schema verifier's tenant-ownership rules. A table may
# be bound through a parent only by a validated, cascading, all-NOT-NULL FK that
# maps tenant_id onto a tenant-bound parent's tenant_id, and a reviewed
# parent-bound table must not regain a direct tenants FK (migration 2046).
# -----------------------------------------------------------------------------
echo "TEST 10: effective-schema tenant-binding rules accept and reject exact shapes"
set +e
OUT="$(python3 "$ROOT/scripts/lint-migrations-schema.test.py" 2>&1)"
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
    echo "FAIL: effective-schema tenant-binding self-tests failed" >&2
    echo "$OUT" >&2
    exit 1
fi
echo "  OK: tenant-binding rules passed ($(grep -oE 'Ran [0-9]+ tests' <<<"$OUT"))."

# -----------------------------------------------------------------------------
# Run #11: a repair migration named by any ledger entry feeds the effective-
# schema checksum check, so it must exist and be forward of the finding even
# when the disposition is not forward-repaired.
# -----------------------------------------------------------------------------
echo "TEST 11: a missing or backward repair migration should FAIL even when re-pinned"
for REPAIR_CASE in missing backward; do
    REPAIR_BASELINE="$TMP/repair-$REPAIR_CASE-baseline.json"
    read -r REPAIR_SHA < <(python3 - "$BASELINE" "$REPAIR_BASELINE" "$REPAIR_CASE" <<'PY'
import hashlib
import json
import sys

source, destination, case = sys.argv[1:]
with open(source, encoding="utf-8") as handle:
    ledger = json.load(handle)
entry = next(
    item for item in ledger["findings"]
    if item["disposition"] == "transitive-tenant-binding"
)
if case == "missing":
    entry["repair_migration"] = "infra/migrations/9999_does_not_exist.sql"
else:
    entry["repair_migration"] = "infra/migrations/0001_init_tenants.sql"
with open(destination, "w", encoding="utf-8") as handle:
    json.dump(ledger, handle, indent=2, sort_keys=True)
    handle.write("\n")
with open(destination, "rb") as handle:
    print(hashlib.sha256(handle.read()).hexdigest())
PY
    )
    if [[ "$REPAIR_CASE" == "missing" ]]; then
        EXPECTED="missing forward repair migration"
    else
        EXPECTED="repair migration is not forward-only"
    fi
    set +e
    OUT="$(POSTWAVE_MIGRATION_LINT_BASELINE="$REPAIR_BASELINE" \
        POSTWAVE_MIGRATION_LINT_BASELINE_SHA256="$REPAIR_SHA" \
        "$LINT" "$TMP/migrations/9004_good_full.sql" 2>&1)"
    RC=$?
    set -e
    if [[ $RC -eq 0 ]] || ! grep -q "$EXPECTED" <<<"$OUT"; then
        echo "FAIL: $REPAIR_CASE repair migration on a transitive-tenant-binding entry was accepted" >&2
        echo "$OUT" >&2
        exit 1
    fi
done
echo "  OK: missing and backward repair migrations failed closed."

# -----------------------------------------------------------------------------
# Run #12: quoted text is not a comment. The first stripper read the '--' in
# migration 1772's CHECK (strpos(token, '--') = 0) as a comment, lost the
# parentheses that close the CREATE TABLE, and so never linted
# referral_code_tokens. A table like that must be flagged; a commented-out
# statement inside a function body must still be ignored.
# -----------------------------------------------------------------------------
cat > "$TMP/migrations/9006_literal_comment_markers.sql" <<'SQL'
BEGIN;
CREATE TABLE IF NOT EXISTS widget_tokens (
    token      text PRIMARY KEY CHECK (strpos(token, '--') = 0),
    tenant_id  uuid NOT NULL,
    note       text NOT NULL DEFAULT '/* not a comment */',
    label      text NOT NULL CHECK (label <> E'it\'s -- still text')
);
COMMIT;
SQL
# PostgreSQL nests block comments. A stripper that ends a comment at its first
# "*/" leaves "don't ... */" as text, and that quote swallows the table below
# up to the '--' literal, which then blanks the closing parenthesis.
cat > "$TMP/migrations/9008_nested_block_comment.sql" <<'SQL'
/* outer /* inner */ don't -- still the outer comment */
BEGIN;
CREATE TABLE IF NOT EXISTS widget_nested (
    note       text NOT NULL CHECK (note <> '--'),
    tenant_id  uuid NOT NULL
);
COMMIT;
SQL
cat > "$TMP/migrations/9007_commented_function_body.sql" <<'SQL'
CREATE OR REPLACE FUNCTION widget_noop() RETURNS text LANGUAGE plpgsql AS $body$
BEGIN
    -- CREATE INDEX widget_noop_idx ON subscribers (tenant_id);
    /* CREATE TABLE widget_ghost (tenant_id uuid NOT NULL); */
    RETURN '-- kept as text';
END;
$body$;
SQL
echo "TEST 12: comment markers inside literals and nested comments must not hide a table; comments in a function body stay comments"
set +e
OUT="$(lint_fixture_files "$TMP/migrations/9006_literal_comment_markers.sql" 2>&1)"
RC=$?
set -e
if [[ $RC -eq 0 ]]; then
    echo "FAIL: a table with a '--' literal escaped the lint" >&2
    echo "$OUT" >&2
    exit 1
fi
# The backticks are literal text in the linter's output, not substitutions.
# shellcheck disable=SC2016
for expected in \
    '[FORCE-RLS-MISSING:rls_enabled] table=`widget_tokens`' \
    '[FORCE-RLS-MISSING:rls_forced] table=`widget_tokens`' \
    '[FORCE-RLS-MISSING:permissive_policy] table=`widget_tokens`' \
    '[FK-TO-TENANTS-MISSING:tenant_fk] table=`widget_tokens`'; do
    if ! grep -qF "$expected" <<<"$OUT"; then
        echo "FAIL: expected finding $expected" >&2
        echo "$OUT" >&2
        exit 1
    fi
done
set +e
OUT="$(lint_fixture_files "$TMP/migrations/9008_nested_block_comment.sql" 2>&1)"
RC=$?
set -e
if [[ $RC -eq 0 ]]; then
    echo "FAIL: a table after a nested block comment escaped the lint" >&2
    echo "$OUT" >&2
    exit 1
fi
# shellcheck disable=SC2016
for expected in \
    '[FORCE-RLS-MISSING:rls_enabled] table=`widget_nested`' \
    '[FK-TO-TENANTS-MISSING:tenant_fk] table=`widget_nested`'; do
    if ! grep -qF "$expected" <<<"$OUT"; then
        echo "FAIL: expected finding $expected after a nested block comment" >&2
        echo "$OUT" >&2
        exit 1
    fi
done
set +e
OUT="$(lint_fixture_files "$TMP/migrations/9007_commented_function_body.sql" 2>&1)"
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
    echo "FAIL: a commented-out statement inside a dollar-quoted body was linted" >&2
    echo "$OUT" >&2
    exit 1
fi
echo "  OK: literals kept their comment markers; nested and body comments stayed comments."

echo ""
echo "ALL SELF-TEST FIXTURES PASSED"
echo "The canonical migration tree is enforced separately by scripts/lint-migrations.sh."
