#!/usr/bin/env bash
set -euo pipefail

image="${1:-}"
if [[ -z "$image" ]]; then
  echo "usage: $0 <image-reference>" >&2
  exit 2
fi

platform="${POSTWAVE_WEB_IMAGE_PLATFORM:-linux/amd64}"
case "$platform" in
  linux/amd64 | linux/arm64) ;;
  *)
    echo "POSTWAVE_WEB_IMAGE_PLATFORM must be linux/amd64 or linux/arm64; got '$platform'" >&2
    exit 2
    ;;
esac

# Digest references used by the publish gate may already have another
# architecture in the local content store. Pull the requested child explicitly
# so inspection and startup cannot silently exercise the host-default image.
if [[ "$image" == */* || "$image" == *@* ]]; then
  docker pull --platform "$platform" "$image" >/dev/null
elif ! docker image inspect --platform "$platform" "$image" >/dev/null 2>&1; then
  docker pull --platform "$platform" "$image" >/dev/null
fi

user="$(docker image inspect --platform "$platform" "$image" --format '{{.Config.User}}')"
workdir="$(docker image inspect --platform "$platform" "$image" --format '{{.Config.WorkingDir}}')"
health="$(docker image inspect --platform "$platform" "$image" --format '{{json .Config.Healthcheck.Test}}')"
image_size="$(docker image inspect --platform "$platform" "$image" --format '{{.Size}}')"
image_os="$(docker image inspect --platform "$platform" "$image" --format '{{.Os}}')"
image_arch="$(docker image inspect --platform "$platform" "$image" --format '{{.Architecture}}')"
expected_arch="${platform#linux/}"
[[ "$image_os" == linux && "$image_arch" == "$expected_arch" ]] || {
  echo "web image platform must be $platform; got ${image_os:-unknown}/${image_arch:-unknown}" >&2
  exit 1
}
[[ "$user" == "10001:10001" ]] || {
  echo "web image must run as 10001:10001; got '$user'" >&2
  exit 1
}
[[ "$workdir" == "/app/apps/web" ]] || {
  echo "web image working directory must be /app/apps/web; got '$workdir'" >&2
  exit 1
}
[[ "$health" == *'/healthz'* ]] || {
  echo "web image health check must use the local /healthz route" >&2
  exit 1
}
[[ "$image_size" =~ ^[0-9]+$ ]] && (( image_size <= 419430400 )) || {
  echo "web image exceeds the 400 MiB uncompressed runtime budget: ${image_size:-unknown} bytes" >&2
  exit 1
}
node_version="$(docker run --rm --platform "$platform" --entrypoint node "$image" --version)"
[[ "$node_version" == v24.16.0 ]] || {
  echo "web image must use reviewed Node.js v24.16.0; got '$node_version'" >&2
  exit 1
}

created=""
running=""
inventory="$(mktemp)"
cleanup() {
  if [[ -n "$running" ]]; then docker rm -f "$running" >/dev/null 2>&1 || true; fi
  if [[ -n "$created" ]]; then docker rm -f "$created" >/dev/null 2>&1 || true; fi
  rm -f "$inventory"
}
trap cleanup EXIT

created="$(docker create --platform "$platform" "$image")"
docker export "$created" | tar -tf - > "$inventory"

for required in \
  app/apps/web/server.js \
  app/apps/web/.next/static/ \
  app/apps/web/public/; do
  grep -Fqx "$required" "$inventory" || {
    echo "web standalone artifact is missing $required" >&2
    exit 1
  }
done

# Report every forbidden artifact, not only the first, then fail. grep -m caps
# each listing; piping into head would SIGPIPE grep under pipefail and abort.
forbidden_found=0
for forbidden in \
  '(^|/)\.git/' \
  '^app/apps/web/src/' \
  '^app/apps/web/scripts/' \
  '^app/(apps|packages)/.*\.(ts|tsx)$' \
  '^app/packages/mcp-server/' \
  '^app/(pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json)$' \
  '^app/node_modules/(eslint|prettier|turbo|typescript|vitest)/' \
  '^app/.*\.map$' \
  '^usr/local/lib/node_modules/(npm|corepack)/' \
  '^usr/local/bin/(npm|npx|corepack|yarn|yarnpkg)$' \
  '^opt/yarn-v'; do
  if grep -Eq "$forbidden" "$inventory"; then
    echo "web image contains forbidden build/source artifact matching $forbidden" >&2
    grep -E -m 20 "$forbidden" "$inventory" >&2
    forbidden_found=1
  fi
done

while IFS= read -r dev_dependency; do
  if grep -Fq "node_modules/${dev_dependency}/" "$inventory"; then
    echo "web image contains declared development dependency ${dev_dependency}" >&2
    grep -F -m 20 "node_modules/${dev_dependency}/" "$inventory" >&2
    forbidden_found=1
  fi
done < <(
  node -e '
    const manifest = require("./apps/web/package.json");
    // MJML performs production CSS processing through postcss. It is also a
    // direct build dependency, but its traced copy is runtime-reachable and is
    // exercised below; every build-only dev dependency remains forbidden.
    const runtimeOverlap = new Set(["postcss"]);
    for (const name of Object.keys(manifest.devDependencies || {}).sort()) {
      if (runtimeOverlap.has(name)) continue;
      process.stdout.write(`${name}\n`);
    }
  '
)
(( forbidden_found == 0 )) || exit 1

artifact_permissions="$(docker run --rm --platform "$platform" --entrypoint sh "$image" -c '
  set -eu
  test "$(stat -c %u:%g /app/apps/web/server.js)" = 0:0
  test ! -w /app/apps/web/server.js
  test "$(stat -c %u:%g:%a /app/apps/web/.next/cache)" = 10001:10001:700
  test -w /app/apps/web/.next/cache
  printf ok
')"
[[ "$artifact_permissions" == ok ]] || {
  echo "web artifact ownership/write-boundary contract failed" >&2
  exit 1
}

running="$(docker run -d --platform "$platform" --read-only \
  --tmpfs /tmp:rw,nosuid,noexec,size=64m,uid=10001,gid=10001,mode=0700 \
  --tmpfs /app/apps/web/.next/cache:rw,nosuid,noexec,size=128m,uid=10001,gid=10001,mode=0700 \
  -e POSTWAVE_RELEASE=0123456789abcdef0123456789abcdef01234567 \
  -e POSTWAVE_APPLE_TEAM_ID=ABCDE12345 \
  -e POSTWAVE_IOS_BUNDLE_ID=com.moosewave.app \
  -e POSTWAVE_ANDROID_PACKAGE_NAME=com.moosewave.app \
  -e POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS=AA:BB:CC \
  -p 127.0.0.1::3000 \
  "$image")"

host_port="$(docker port "$running" 3000/tcp | head -1)"
for _ in $(seq 1 40); do
  if body="$(curl --fail --silent --show-error "http://${host_port}/healthz" 2>/dev/null)"; then
    break
  fi
  if [[ "$(docker inspect "$running" --format '{{.State.Running}}')" != true ]]; then
    docker logs "$running" >&2 || true
    echo "web image exited during hardened startup" >&2
    exit 1
  fi
  sleep 1
done

[[ "${body:-}" == '{"status":"ok","service":"postwave-web"}' ]] || {
  docker logs "$running" >&2 || true
  echo "web /healthz returned an unexpected body: ${body:-<none>}" >&2
  exit 1
}
curl --fail --silent --show-error --output /dev/null "http://${host_port}/login"
curl --fail --silent --show-error --output /dev/null \
  "http://${host_port}/docs/getting-started"
curl --fail --silent --show-error --output /dev/null \
  "http://${host_port}/docs/api/get-core-health"
curl --fail --silent --show-error --output /dev/null \
  "http://${host_port}/docs/skills/migrate-start"
docs_search="$(curl --fail --silent --show-error \
  "http://${host_port}/api/docs/search?q=migrate")"
[[ "$docs_search" == *'"results":['* ]] || {
  echo "web docs search did not return its production catalog" >&2
  exit 1
}
aasa="$(curl --fail --silent --show-error \
  "http://${host_port}/.well-known/apple-app-site-association")"
assetlinks="$(curl --fail --silent --show-error \
  "http://${host_port}/.well-known/assetlinks.json")"
node -e '
  const [aasa, assetlinks] = process.argv.slice(1).map((value) => JSON.parse(value));
  if (aasa.applinks?.details?.[0]?.appID !== "ABCDE12345.com.moosewave.app") {
    throw new Error("Apple association metadata does not match runtime identity");
  }
  if (
    assetlinks?.[0]?.target?.package_name !== "com.moosewave.app" ||
    assetlinks[0].target.sha256_cert_fingerprints?.[0] !== "AA:BB:CC"
  ) {
    throw new Error("Android association metadata does not match runtime identity");
  }
' "$aasa" "$assetlinks"
docker exec "$running" node -e '
  const render = require("mjml");
  void (async () => {
    const result = await render("<mjml><mj-body><mj-section><mj-column><mj-text>ok</mj-text></mj-column></mj-section></mj-body></mjml>");
    if ((result.errors?.length ?? 0) > 0 || !result.html?.includes("ok")) {
      process.exit(1);
    }
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
'
[[ "$(docker exec "$running" id -u)" == 10001 ]] || {
  echo "web process is not running as UID 10001" >&2
  exit 1
}

echo "PASS web image ($platform) is minimal and starts read-only/non-root with local process health"
