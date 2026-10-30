#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="${ROOT}/infra/aws/observability-stack.yaml"
LOCK="${ROOT}/infra/aws/observability-image-lock.json"
IMAGE_DIR="${ROOT}/infra/observability/image"
IMAGE="${POSTWAVE_COLLECTOR_IMAGE:-postwave-observability-collector:contract-$$}"
REMOVE_IMAGE=true
if [[ -n "${POSTWAVE_COLLECTOR_IMAGE:-}" ]]; then
  REMOVE_IMAGE=false
fi
CONTAINER="postwave-observability-config-check-$$"

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  if [[ "${REMOVE_IMAGE}" == "true" ]]; then
    docker image rm -f "${IMAGE}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

for command in docker node; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "${command} is required for the collector startup contract" >&2
    exit 1
  }
done

SCANNER_IMAGE="$(node -e 'const lock=require(process.argv[1]); process.stdout.write(lock.scannerImage)' "${LOCK}")"

node "${ROOT}/scripts/check-observability-collector-source.mjs"

CONFIG="$({
  awk '
    /- Name: AOT_CONFIG_CONTENT/ { seen = 1 }
    seen && /Fn::Sub: \|/ { capture = 1; next }
    capture && /^          HealthCheck:/ { exit }
    capture { sub(/^                  /, ""); print }
  ' "${STACK}"
} | sed \
  -e 's/${AWS::Region}/us-west-2/g' \
  -e 's/${!env:METRICS_TOKEN}/${env:METRICS_TOKEN}/g' \
  -e 's#${PrometheusWorkspace.PrometheusEndpoint}#https://127.0.0.1:65535/workspaces/ws-test/api/v1/#g')"

if [[ -z "${CONFIG}" ]]; then
  echo "failed to extract AOT_CONFIG_CONTENT from ${STACK}" >&2
  exit 1
fi

if [[ "${REMOVE_IMAGE}" == "true" ]]; then
  docker build --pull --tag "${IMAGE}" "${IMAGE_DIR}" >/dev/null
fi

IMAGE_USER="$(docker image inspect "${IMAGE}" --format '{{.Config.User}}')"
if [[ "${IMAGE_USER}" != "10001:10001" ]]; then
  echo "collector wrapper must run as 10001:10001; found ${IMAGE_USER}" >&2
  exit 1
fi

docker run -d \
  --name "${CONTAINER}" \
  --network none \
  --init \
  --user 10001:10001 \
  --cap-drop ALL \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -e AWS_REGION=us-west-2 \
  -e AWS_ACCESS_KEY_ID=TESTONLY \
  -e AWS_SECRET_ACCESS_KEY=TESTONLYSECRET \
  -e METRICS_TOKEN=test-only-nonsecret-token \
  -e "AOT_CONFIG_CONTENT=${CONFIG}" \
  "${IMAGE}" >/dev/null

ready=false
for _ in $(seq 1 20); do
  state="$(docker inspect "${CONTAINER}" --format '{{.State.Status}} {{.State.ExitCode}}')"
  if [[ "${state}" == exited* ]]; then
    docker logs "${CONTAINER}" >&2
    echo "collector exited before becoming ready: ${state}" >&2
    exit 1
  fi
  if docker logs "${CONTAINER}" 2>&1 | grep -Fq "Everything is ready. Begin running and processing data."; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "${ready}" != true ]]; then
  docker logs "${CONTAINER}" >&2
  echo "collector did not reach ready state within 20 seconds" >&2
  exit 1
fi

docker exec --user 10001:10001 "${CONTAINER}" /healthcheck >/dev/null

if docker logs "${CONTAINER}" 2>&1 | grep -Eq 'failed to get config|invalid configuration|application run finished with error'; then
  docker logs "${CONTAINER}" >&2
  echo "collector reported a configuration failure" >&2
  exit 1
fi

job_count="$(docker logs "${CONTAINER}" 2>&1 | grep -c 'Scrape job added')"
if [[ "${job_count}" -ne 5 ]]; then
  docker logs "${CONTAINER}" >&2
  echo "collector must load exactly five scrape jobs; loaded ${job_count}" >&2
  exit 1
fi

if [[ "${POSTWAVE_COLLECTOR_SCAN:-false}" == "true" ]]; then
  docker volume create postwave-trivy-cache >/dev/null
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v postwave-trivy-cache:/root/.cache/trivy \
    "${SCANNER_IMAGE}" image \
    --scanners vuln \
    --severity HIGH,CRITICAL \
    --ignore-unfixed \
    --exit-code 1 \
    --no-progress \
    "${IMAGE}"
fi

echo "PASS locked OpenTelemetry wrapper, hardened startup, five scrape jobs, and healthcheck"
