#!/usr/bin/env bash
# Fail a local Docker release gate when app containers emit unexpected WARN/ERROR
# lines. The allowlist is intentionally narrow and dev-only; background-worker
# errors should fail the gate.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if docker compose version >/dev/null 2>&1; then
    DC=(docker compose)
elif [[ -x /Applications/Docker.app/Contents/Resources/bin/docker ]]; then
    DC=(/Applications/Docker.app/Contents/Resources/bin/docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    DC=(docker-compose)
else
    echo "ERROR: no docker compose binary found on PATH" >&2
    exit 2
fi

SINCE="${POSTWAVE_DOCKER_LOG_CHECK_SINCE:-30m}"
SERVICES=(${POSTWAVE_DOCKER_LOG_CHECK_SERVICES:-api automation deliverability migration voice web listmonk})

logs="$("${DC[@]}" \
    -f infra/docker-compose.yml \
    -f infra/docker-compose.full.yml \
    logs --no-color --since "$SINCE" "${SERVICES[@]}" 2>/dev/null || true)"

matches="$(printf '%s\n' "$logs" \
    | grep -E '"level":"(WARN|ERROR)"|level=(warn|error)|(^|[^[:alnum:]_])(WARN|ERROR)([^[:alnum:]_]|$)' \
    | grep -Ev 'POSTWAVE_API_KEY_PEPPER is unset|POSTWAVE_AUTH_HMAC_PEPPER unset|KMS not configured|using static-key AES-GCM fallback|GEMINI_API_KEY not set|OPENAI_API_KEY not set|DMARC_IMAP_HOST not set|HCTI_USER_ID/HCTI_API_KEY not set|seedlist config not loaded|Sentry Logger \\[warn\\]|No global error handler configured' \
    || true)"

if [[ -n "$matches" ]]; then
    echo "ERROR: unexpected WARN/ERROR lines found in Docker release logs:" >&2
    printf '%s\n' "$matches" | head -120 >&2
    echo >&2
    echo "Set POSTWAVE_DOCKER_LOG_CHECK_SKIP=1 only for a local diagnostic run." >&2
    exit 1
fi

echo "Docker log hygiene check passed."
