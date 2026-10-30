#!/usr/bin/env bash
# tests/e2e/run.sh
#
# One-shot runner for the end-to-end suite. Brings the local Docker
# stack up, waits for dependency-aware /api/ready, runs `go test -v` against every
# *_test.go in this directory, and (optionally) tears the stack back
# down.
#
# Env knobs:
#
#   POSTWAVE_E2E_KEEP_STACK=1   skip the down step at the end (useful
#                               when iterating on a single journey).
#   POSTWAVE_E2E_SKIP_UP=1      assume the stack is already up; just
#                               run the tests.
#   POSTWAVE_POSTGRES_PORT      forwarded to docker-compose; default 5432.
#   POSTWAVE_REDIS_PORT         forwarded to docker-compose; default 6379.
#
# Run from anywhere; the script resolves paths relative to its own dir.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/tests/e2e"

# Pick a docker compose binary. The Mac install ships docker compose v2
# under /Applications/Docker.app/...; the Linux runners use the bundled
# `docker compose` plugin. Prefer the plugin form so this script works
# in both places without env-var twiddling.
if docker compose version >/dev/null 2>&1; then
    DOCKER_BIN="$(command -v docker)"
    DC=(docker compose)
elif [[ -x /Applications/Docker.app/Contents/Resources/bin/docker ]]; then
    DOCKER_BIN="/Applications/Docker.app/Contents/Resources/bin/docker"
    DC=(/Applications/Docker.app/Contents/Resources/bin/docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_BIN="$(command -v docker || true)"
    DC=(docker-compose)
else
    echo "ERROR: no docker compose binary found on PATH" >&2
    exit 2
fi

cd "$ROOT"

STACK_STARTED=0

ensure_docker_daemon() {
    if [[ -z "${DOCKER_BIN:-}" ]]; then
        echo "ERROR: docker CLI not found; install Docker Desktop or expose docker on PATH" >&2
        exit 2
    fi
    if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
        echo "ERROR: Docker daemon is not reachable. Start Docker Desktop, then rerun $0." >&2
        exit 2
    fi
}

bring_up() {
    if [[ "${POSTWAVE_E2E_SKIP_UP:-}" == "1" ]]; then
        echo "POSTWAVE_E2E_SKIP_UP=1: assuming stack is already running"
        STACK_STARTED=1
        return
    fi
    ensure_docker_daemon
    echo ">> bringing up local docker stack"
    "${DC[@]}" \
        -f infra/docker-compose.yml \
        -f infra/docker-compose.full.yml \
        up -d --build
    STACK_STARTED=1
}

bring_down() {
    if [[ "$STACK_STARTED" != "1" ]]; then
        return
    fi
    if [[ "${POSTWAVE_E2E_KEEP_STACK:-}" == "1" ]]; then
        echo "POSTWAVE_E2E_KEEP_STACK=1: leaving stack up for next iteration"
        return
    fi
    echo ">> tearing down local docker stack"
    cd "$ROOT"
    "${DC[@]}" \
        -f infra/docker-compose.yml \
        -f infra/docker-compose.full.yml \
        down --volumes --remove-orphans || true
}

wait_for_ready() {
    local url="${POSTWAVE_E2E_API_BASE:-http://localhost:8080}/api/ready"
    local attempts="${POSTWAVE_E2E_READY_ATTEMPTS:-90}"
    local i

    if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || (( attempts > 180 )); then
        echo "ERROR: POSTWAVE_E2E_READY_ATTEMPTS must be an integer from 1 to 180" >&2
        exit 2
    fi

    echo ">> waiting for dependency-aware readiness at $url"
    for ((i = 1; i <= attempts; i++)); do
        if curl -fsS --max-time 5 "$url" >/dev/null; then
            echo ">> stack ready after $i attempt(s)"
            return
        fi
        sleep 2
    done

    echo "ERROR: stack never became ready at $url" >&2
    "${DC[@]}" \
        -f infra/docker-compose.yml \
        -f infra/docker-compose.full.yml \
        ps >&2 || true
    "${DC[@]}" \
        -f infra/docker-compose.yml \
        -f infra/docker-compose.full.yml \
        logs --tail=200 >&2 || true
    exit 1
}

trap bring_down EXIT

bring_up
wait_for_ready

# The one-shot runner is a release gate, not an ad-hoc package-test command.
# Convert every environment skip and soft dependency assertion into a hard
# failure so a green run proves every journey actually executed.
export POSTWAVE_E2E_RUN=1
export POSTWAVE_E2E_STRICT_ASSERTIONS=1

echo ">> running e2e suite"
cd "$HERE"
# GOWORK=off — tests/e2e is a standalone module by design (see
# go.mod's package doc). Without this the root go.work refuses to load
# this dir.
# `-count=1` defeats the test cache so a previous skip doesn't mask
# new failures. -timeout big enough to absorb image pulls + warmup on
# the first run.
GOWORK=off go test -v -count=1 -timeout=10m ./...

if [[ "${POSTWAVE_DOCKER_LOG_CHECK_SKIP:-}" != "1" ]]; then
    echo ">> checking docker logs for unexpected warnings/errors"
    cd "$ROOT"
    ./scripts/release/check-docker-logs.sh
fi
