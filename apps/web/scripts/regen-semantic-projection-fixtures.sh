#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Regenerate apps/web/src/__tests__/fixtures/semantic-email-projection.json from
# the REAL Go semantic-email compiler.
#
# Why this exists
# ---------------
# apps/web needs a live preview of a semantic email while it is being authored.
# The projections (accessible HTML + genuinely authored plain text) are defined
# once, in apps/api/internal/semanticemail. There is no HTTP endpoint that
# compiles an unsaved draft tree — the only semantic compile paths are
# revision-freeze and assurance, both of which operate on an already immutable
# revision — so the browser cannot ask the server "what would this look like".
#
# The alternative to a second renderer would be no preview at all. So apps/web
# carries a TypeScript mirror of the projection, and this script pins that
# mirror to the Go original: it feeds a corpus through the actual compiler and
# records what came out. src/__tests__/semantic-email-go-parity.test.ts then
# asserts the TypeScript mirror reproduces those bytes exactly. Change the Go
# renderer, re-run this, and the parity test fails until the mirror is fixed.
#
# The generator source lives in apps/web (semantic-projection-fixtures.go.txt).
# It is copied into the Go package for the duration of one `go test` run,
# because Go's internal/ visibility rule means only a package inside apps/api
# may import apps/api/internal/semanticemail. Nothing is left behind: the trap
# removes it even if the test fails.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web_root="$(dirname "$here")"
repo_root="$(cd "$web_root/../.." && pwd)"
api_root="$repo_root/apps/api"
pkg_dir="$api_root/internal/semanticemail"
generator="$here/semantic-projection-fixtures.go.txt"
temp_file="$pkg_dir/zz_web_fixture_export_test.go"
out_file="$web_root/src/__tests__/fixtures/semantic-email-projection.json"

if [ ! -d "$pkg_dir" ]; then
  echo "semantic-email package not found at $pkg_dir" >&2
  exit 1
fi
if [ -e "$temp_file" ]; then
  echo "$temp_file already exists; refusing to overwrite" >&2
  exit 1
fi

cleanup() { rm -f "$temp_file"; }
trap cleanup EXIT

cp "$generator" "$temp_file"
mkdir -p "$(dirname "$out_file")"

cd "$api_root"
POSTWAVE_WEB_FIXTURE_OUT="$out_file" \
  go test ./internal/semanticemail/ -run TestExportWebProjectionFixtures -count=1 -v

echo "wrote $out_file"
