#!/usr/bin/env bash
# Local release-candidate gate for the full Docker stack.
#
# This script is intentionally local-only. It never deploys, pushes images, or
# touches AWS. It wraps the static prelaunch gate and then exercises the real
# docker-compose stack through tests/e2e.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

log() {
    printf '\n==> %s\n' "$*"
}

if [[ "${POSTWAVE_RELEASE_E2E_SKIP_GATE:-}" != "1" ]]; then
    log "Running local prelaunch gate"
    pnpm gate:prelaunch:local
else
    log "POSTWAVE_RELEASE_E2E_SKIP_GATE=1: skipping prelaunch gate"
fi

log "Running real Docker E2E journeys"
export POSTWAVE_E2E_STRICT_ASSERTIONS="${POSTWAVE_E2E_STRICT_ASSERTIONS:-1}"
./tests/e2e/run.sh

if [[ "${POSTWAVE_RELEASE_E2E_SMOKE:-}" == "1" ]]; then
    log "Running optional browser smoke suite against the Docker stack"
    POSTWAVE_E2E_SKIP_UP=1 POSTWAVE_E2E_KEEP_STACK=1 pnpm test:smoke:local
fi

log "Local Docker release gate passed"
