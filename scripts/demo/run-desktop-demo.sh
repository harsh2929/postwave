#!/usr/bin/env bash

# Launch the complete local Moosewave desktop demo on macOS.
#
# This is intentionally a source/demo workflow, not a production installer. It
# starts a loopback-only, read-only API shim and compiles the Tauri shell with
# an ephemeral process-scoped bearer plus the explicit demo fixture profile.
# No Keychain entry, hosted service, or customer data is used.

set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
demo_api_url="http://127.0.0.1:8080"
runtime_dir=""
api_pid=""

cleanup() {
  if [ -n "$api_pid" ] && kill -0 "$api_pid" 2>/dev/null; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
  if [ -n "$runtime_dir" ] && [ -d "$runtime_dir" ]; then
    rm -rf "$runtime_dir"
  fi
}
trap cleanup EXIT INT TERM

fail() {
  printf 'Moosewave demo: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required. Ask Codex to install the missing prerequisite, then run this command again."
}

if [ "$(uname -s)" != "Darwin" ]; then
  fail "this desktop demo launcher currently supports macOS."
fi

for command_name in cargo curl git lsof node openssl; do
  require_command "$command_name"
done

if command -v pnpm >/dev/null 2>&1; then
  pnpm_command=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  pnpm_command=(corepack pnpm)
else
  fail "pnpm or Corepack is required. Ask Codex to install Node.js 20+ and enable Corepack, then retry."
fi

cd "$repo_root"

if pgrep -f 'postwave-desktop$' >/dev/null 2>&1; then
  fail "Moosewave is already running. Quit it completely, then run the demo command again."
fi

if lsof -nP -iTCP:8080 -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port 8080 is already in use. Stop the process using it, then retry."
fi

printf 'Installing repository dependencies…\n'
"${pnpm_command[@]}" install --frozen-lockfile

demo_key="pw_live_demo_$(openssl rand -hex 24)"

runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/postwave-desktop-demo.XXXXXX")
printf 'Starting the local read-only demo API…\n'
POSTWAVE_DEMO_API_KEY="$demo_key" \
POSTWAVE_DEMO_API_PORT=8080 \
node "$repo_root/scripts/demo/desktop-demo-api.mjs" \
  >"$runtime_dir/api.log" 2>&1 &
api_pid=$!

api_ready=0
for _attempt in $(seq 1 30); do
  if curl --fail --silent "$demo_api_url/api/health" >/dev/null 2>&1; then
    api_ready=1
    break
  fi
  if ! kill -0 "$api_pid" 2>/dev/null; then
    sed -n '1,160p' "$runtime_dir/api.log" >&2 || true
    fail "the local demo API stopped during startup."
  fi
  sleep 1
done
[ "$api_ready" -eq 1 ] || fail "the local demo API did not become ready within 30 seconds."

printf 'Building the local Moosewave app…\n'
VITE_BUILD_PROFILE=demo \
VITE_API_URL="$demo_api_url" \
"${pnpm_command[@]}" --filter postwave-desktop-shell tauri build \
  --debug --bundles app --no-sign

demo_app="$repo_root/apps/desktop/src-tauri/target/debug/bundle/macos/Moosewave.app"
[ -d "$demo_app" ] || fail "the macOS demo app bundle was not created."

printf '\nPostwave demo is ready. The desktop app will open now.\n'
printf 'Keep this Terminal window open during the walkthrough.\n\n'

open -F -n -W \
  --env POSTWAVE_DESKTOP_DEMO=1 \
  --env POSTWAVE_DESKTOP_DEMO_API_URL="$demo_api_url" \
  --env POSTWAVE_DESKTOP_DEMO_API_KEY="$demo_key" \
  "$demo_app"
