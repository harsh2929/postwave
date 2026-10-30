#!/usr/bin/env bash
# Turnkey live smoke for the 5 cutting-edge-2026 white-space features (#1-#5).
#
# Two phases:
#   1. (optional) DB preflight — verify migrations 0402-0412 applied.
#   2. HTTP smoke — exercise each feature's flow against a running API gateway.
#
# It does NOT bring the stack up for you (that needs your local creds/secrets);
# it prints the exact commands and then runs the checks. See scripts/smoke/README.md.
#
# Required env:  POSTWAVE_BASE_URL, POSTWAVE_TENANT_ID, and POSTWAVE_API_KEY
#               (or POSTWAVE_AUTH_HEADER="Name: value").
# Optional env: DATABASE_URL (enables the DB preflight),
#               POSTWAVE_SMOKE_LLM=1 (exercise #1 replay; needs voice+Gemini),
#               POSTWAVE_SEGMENT_ID / POSTWAVE_CAMPAIGN_ID / POSTWAVE_AUDIENCE_SYNC_ID.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_URL="${POSTWAVE_BASE_URL:-http://localhost:3000}"

echo "==> Moosewave 2026 white-space smoke"
echo "    base url : ${BASE_URL}"
echo "    repo     : ${ROOT}"
echo

cat <<'BRINGUP'
If the stack is NOT up yet, in another shell:
  docker compose -f infra/docker-compose.yml up -d           # Postgres + Redis + Listmonk
  # migrations 0402-0412 apply automatically at API-gateway boot (migrationrunner),
  # or explicitly:  go run -C apps/api ./cmd/migrate up
  # then start the API gateway with DATABASE_URL/REDIS_ADDR/LISTMONK_* set.
BRINGUP
echo

# ---------- Phase 1: DB preflight (optional, needs psql + DATABASE_URL) ----------
if [[ -n "${DATABASE_URL:-}" ]] && command -v psql >/dev/null 2>&1; then
  echo "==> DB preflight: migrations 0402-0412 (9 tables + 2 columns)"
  read -r TABLES COLS < <(psql "${DATABASE_URL}" -tA -F' ' -c "
    SELECT
      (SELECT count(*) FROM information_schema.tables WHERE table_name = ANY(ARRAY[
        'ai_golden_examples','ai_regression_runs','ai_regression_results','ai_regression_settings',
        'activation_exclusion_receipts','segment_holdouts','segment_pnl_cost_config',
        'segment_membership_log','segment_decay_events'])),
      (SELECT count(*) FROM information_schema.columns WHERE
        (table_name='audience_syncs' AND column_name='required_consent_purpose') OR
        (table_name='audience_sync_runs' AND column_name='excluded_count'));
  ") || { echo "    psql query failed — is DATABASE_URL correct?"; exit 2; }
  echo "    tables present: ${TABLES}/9    new columns present: ${COLS}/2"
  if [[ "${TABLES}" != "9" || "${COLS}" != "2" ]]; then
    echo "    ✗ migrations 0402-0412 are NOT fully applied. Apply them, then re-run."
    exit 2
  fi
  echo "    ✓ all 0402-0412 schema present"
else
  echo "==> DB preflight skipped (set DATABASE_URL + install psql to enable)."
  echo "    The HTTP smoke still proves table existence: a missing table 500s the endpoint."
fi
echo

# ---------- Phase 2: HTTP smoke ----------
echo "==> HTTP smoke (per-feature flows)"
EXTRA=()
[[ "${POSTWAVE_SMOKE_LLM:-}" == "1" ]] && EXTRA+=(--llm)
[[ "${POSTWAVE_SMOKE_STRICT:-}" == "1" ]] && EXTRA+=(--strict)
node "${ROOT}/scripts/smoke/whitespace-2026-smoke.mjs" "${EXTRA[@]}"
