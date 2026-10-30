#!/usr/bin/env bash
# Local load + abuse smoke. This never deploys and assumes a local/staging-like
# API is already running at POSTWAVE_LOAD_BASE_URL.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BASE="${POSTWAVE_LOAD_BASE_URL:-http://localhost:8080}"

log() {
    printf '\n==> %s\n' "$*"
}

if [[ "${POSTWAVE_LOAD_SKIP_K6:-}" == "1" ]]; then
    log "POSTWAVE_LOAD_SKIP_K6=1: skipping k6 load/abuse smoke"
    exit 0
fi

if ! command -v k6 >/dev/null 2>&1; then
    printf 'ERROR: k6 is not installed. Install it with `brew install k6` or set POSTWAVE_LOAD_SKIP_K6=1 for non-load-test local runs.\n' >&2
    exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
    printf 'ERROR: curl is required for the preflight health probe.\n' >&2
    exit 2
fi

log "Checking API health at ${BASE}/api/health"
curl -fsS --max-time 5 "${BASE}/api/health" >/dev/null

log "Running subscriber CRUD load smoke"
k6 run infra/load/subscriber-crud.k6.js

log "Running abuse/rate-limit smoke"
k6 run infra/load/abuse-rate-limit.k6.js

log "Local load + abuse smoke passed"
