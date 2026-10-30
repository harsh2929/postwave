#!/usr/bin/env bash
# check-no-bare-set-config.sh
#
# Enforces the rule from p0-pgxpool-after-release: NEW code MUST NOT issue
# a session-level `set_config('app.<scope>', ..., false)` directly on a
# pool-acquired connection. Use `db.WithWorkerScope(ctx, pool)` (which
# binds the scope to a tx via SET LOCAL / set_config(..., true)) instead.
#
# Background: a session-level write on a pool-acquired connection used to
# leak the scope onto the next checkout, silently flipping a per-tenant
# request handler into worker mode (RLS bypass on tables that respect the
# `app.outbox_worker` predicate). The pgxpool AfterRelease hook in
# apps/api/internal/db/db.go now RESETs these GUCs on release — but the
# safer pattern is to never set them at session level to begin with.
#
# Existing pre-existing sites are grandfathered via an allowlist below
# (see ALLOWLIST). New uses anywhere else are blocked.
#
# Exits 0 = clean; 1 = forbidden pattern found.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Files that pre-date this lint and are tracked in the TODO inside
# apps/api/internal/db/db.go. Adding a file here = explicit "we know,
# migration pending". Remove from this list as each is migrated to
# `db.WithWorkerScope`.
#
# Paths are matched as exact `git ls-files`-style relative paths.
ALLOWLIST=(
  # The seven production worker call sites have been migrated to
  # db.WithWorkerScope (short worker-scope txs; reads/writes split out of any
  # span that holds a tx across network I/O). They are intentionally NO LONGER
  # listed here — the lint now enforces the migrated form.
  #
  # The two test files below stay grandfathered ON PURPOSE: their setup writes
  # a session-level (committed) GUC + rows that the pool-based code under test
  # must then see on a *separate* connection. A WithWorkerScope tx would not be
  # visible until commit, so the raw-conn form is correct for test scaffolding,
  # and the pool-leak the lint guards against is harmless against a throwaway
  # test database.
  "apps/api/internal/outbound_webhooks/store_test.go"
  "apps/api/internal/outbound_webhooks/worker_test.go"

  # This isolated-database migration contract deliberately impersonates the
  # shared postwave_app role on one dedicated connection and proves that the
  # retired support_worker GUC does not widen tenant visibility. It never
  # returns that connection to an application pool while the capability is
  # set, so rewriting the assertion through WithWorkerScope would stop testing
  # the legacy caller-controlled input the migration is required to contain.
  "apps/api/internal/migrationrunner/migration_1993_db_test.go"
)

# First pattern we want to forbid. We match the literal `set_config('app.` prefix
# followed by anything that ends with `, false)`. A `, true)` form is safe only
# when issued on an explicit transaction; the AST-backed Go guard invoked below
# separately rejects it on a raw connection returned by pgxpool.Acquire.
#
# Using extended regex with grep -E so the comma + spaces are tolerant
# of formatting drift.
PATTERN="set_config\\('app\\.[a-z_]+'[[:space:]]*,[[:space:]]*'[^']*'[[:space:]]*,[[:space:]]*false[[:space:]]*\\)"

violations=0

# Scope the scan to apps/api — that's where the pool + workers live.
# Excluding vendor/, node_modules/, and the db.go file itself (which only
# *documents* the pattern in comments — see the TODO block).
while IFS= read -r line; do
  # line format: "path:lineno:matched text"
  file="${line%%:*}"

  # Skip the policy doc / migration files that reference the pattern in
  # comments or SQL fixtures.
  case "$file" in
    apps/api/internal/db/db.go) continue ;;
    scripts/check-no-bare-set-config.sh) continue ;;
  esac

  allowed=false
  for allow in "${ALLOWLIST[@]}"; do
    if [[ "$file" == "$allow" ]]; then
      allowed=true
      break
    fi
  done

  if [[ "$allowed" == "true" ]]; then
    continue
  fi

  echo "FORBIDDEN: $line"
  echo "  use db.WithWorkerScope(ctx, pool) instead of bare set_config(..., false)"
  violations=$((violations + 1))
done < <(grep -E -rn --include='*.go' "$PATTERN" apps/api 2>/dev/null || true)

if [[ "$violations" -gt 0 ]]; then
  echo ""
  echo "Found $violations forbidden bare set_config(..., false) call(s)."
  echo "See apps/api/internal/db/db.go for the WithWorkerScope helper + migration path."
  exit 1
fi

echo "check-no-bare-set-config: OK (no new bare set_config(..., false) outside allowlist)"

# The Go parser ties an Acquire assignment to later method calls on that exact
# identifier. This catches the more subtle auto-commit bug where
# set_config(..., true) succeeds but its transaction-local value disappears
# before the dependent query.
(
  cd apps/api
  go test ./internal/db -run 'Test(BareTransactionLocalSetConfigAnalyzer|NoBareTransactionLocalSetConfig)$' -count=1
)

echo "check-no-bare-set-config: OK (no set_config(..., true) on raw pooled connections)"
exit 0
