#!/usr/bin/env bash
# check-license-boundary.sh
#
# Enforces the architectural rule from LICENSE-BOUNDARY.md: the Moosewave
# application (apps/api, services/*) must NEVER import a Go package from the
# separately deployed Listmonk work. The two communicate only over HTTP so
# their release, source-offer, and upgrade obligations remain independently
# auditable.
#
# Run from the repo root. Exits non-zero if any forbidden import is found.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Components that must remain separated from Listmonk at source level.
TARGETS=(
  "apps/api"
  "services/migration"
  "services/deliverability"
  "services/voice"
  "services/automation"
)

# Patterns that constitute an AGPL boundary violation.
PATTERNS=(
  'github.com/knadh/listmonk'
  'github.com/postwave/listmonk'
)

violations=0

for target in "${TARGETS[@]}"; do
  if [[ ! -d "$target" ]]; then
    continue
  fi
  for pattern in "${PATTERNS[@]}"; do
    # -E for ERE, -r recursive, -n line numbers, -I skip binary, --include only Go.
    if matches=$(grep -E -rnI --include='*.go' "import.*${pattern}|\"${pattern}" "$target" 2>/dev/null); then
      if [[ -n "$matches" ]]; then
        echo "ERROR: forbidden Listmonk import in $target (pattern: ${pattern})" >&2
        echo "$matches" >&2
        violations=$((violations + 1))
      fi
    fi
  done
done

if (( violations > 0 )); then
  cat >&2 <<'EOF'

License boundary violation detected.

Moosewave services (apps/api, services/*) must communicate with the Listmonk
process ONLY over HTTP. Importing github.com/knadh/listmonk or
github.com/postwave/listmonk packages collapses the documented component and
release boundary and makes independent source-offer verification unreliable.

Read LICENSE-BOUNDARY.md and replace the import with an HTTP call to the
running Listmonk instance.
EOF
  exit 1
fi

echo "license boundary OK: no forbidden Listmonk imports found"

# Current release-facing material must not hard-code the absent public mirror
# or Listmonk-fork URLs. GitHub Actions derives OCI source metadata from the
# repository that actually runs the workflow; local paths remain relative.
if matches=$(git grep -nE 'https://github[.]com/postwave/(postwave|listmonk)(/|$)' -- \
  README.md LICENSE LICENSE-BOUNDARY.md \
  'engine/**' 'apps/*/README.md' 'services/*/README.md' \
  docs/SELF-HOSTING.md docs/aws-deployment-runbook.md \
  docs/runbooks/desktop-build-and-sign.md \
  'infra/**/*.md' 'infra/**/*.yml' 'infra/**/Dockerfile' \
  'proprietary*/README.md' 2>/dev/null || true); then
  if [[ -n "$matches" ]]; then
    echo >&2 "ABSENT PUBLIC MIRROR: release-facing material hard-codes a repository that is not an approved distribution source:"
    echo "$matches" | sed 's/^/  /' >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# packages/ must be internally consistent with the MIT declaration.
#
# LICENSE-BOUNDARY.md declares every immediate package root MIT. The import
# check above satisfies only one part of that policy; the files and package
# metadata must also agree with the grant.
# ---------------------------------------------------------------------------

pkg_violations=0

# Every immediate packages/* root is declared to be an independently licensed
# MIT work, including native Go/Rust/etc. packages without package.json.
for dir in packages/*; do
  [[ -d "$dir" ]] || continue
  if [[ ! -f "$dir/LICENSE" ]]; then
    echo >&2 "MISSING LICENSE: $dir must ship a root MIT LICENSE file."
    pkg_violations=$((pkg_violations + 1))
    continue
  fi
  if ! grep -Fq "MIT License" "$dir/LICENSE" ||
     ! grep -Fq "Permission is hereby granted, free of charge" "$dir/LICENSE"; then
    echo >&2 "LICENSE MISMATCH: $dir/LICENSE must contain the full MIT grant."
    pkg_violations=$((pkg_violations + 1))
  fi
done

for pkgjson in packages/*/package.json; do
  [[ -f "$pkgjson" ]] || continue
  dir="$(dirname "$pkgjson")"

  license="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('license','')) " "$pkgjson" 2>/dev/null || echo "")"

  if [[ "$license" != "MIT" ]]; then
    echo >&2 "LICENSE MISMATCH: $dir must declare \"license\": \"MIT\" (found '${license:-missing}')."
    pkg_violations=$((pkg_violations + 1))
    continue
  fi

  # 1. An MIT package must not claim to be proprietary.
  if hdrs=$(grep -rlI "Proprietary and confidential" "$dir" 2>/dev/null | grep -v node_modules); then
    if [[ -n "$hdrs" ]]; then
      echo >&2 "LICENSE MISMATCH: $dir declares \"license\": \"MIT\" but these files are headed 'Proprietary and confidential':"
      echo "$hdrs" | sed 's/^/  /' >&2
      pkg_violations=$((pkg_violations + 1))
    fi
  fi

  # 2. An MIT package must ship the licence it grants.
  if ! ls "$dir" 2>/dev/null | grep -qi '^LICENSE'; then
    echo >&2 "MISSING LICENSE: $dir declares \"license\": \"MIT\" but ships no LICENSE file."
    pkg_violations=$((pkg_violations + 1))
  fi
done

if (( pkg_violations > 0 )); then
  cat >&2 <<'EOF'

packages/ license consistency violation.

Every package under packages/ that declares "license": "MIT" must (a) ship a
LICENSE file and (b) contain no "Proprietary and confidential" headers. An MIT
grant on source that calls itself proprietary is a contradiction a downstream
consumer has to resolve, whether or not the package is published.

See LICENSE-BOUNDARY.md — "MIT package layer".
EOF
  exit 1
fi

echo "packages/ license consistency OK: MIT packages ship a LICENSE and carry no proprietary headers"

# Non-JavaScript SDKs do not have package.json, so validate their native
# manifest metadata and require a full MIT text at each publish root.
sdk_violations=0
SDK_DIRS=(
  packages/sdk-dotnet
  packages/sdk-elixir
  packages/sdk-go
  packages/sdk-java
  packages/sdk-php
  packages/sdk-py
  packages/sdk-ruby
  packages/sdk-rust
)

for dir in "${SDK_DIRS[@]}"; do
  if [[ ! -f "$dir/LICENSE" ]]; then
    echo >&2 "MISSING LICENSE: $dir must ship its MIT license text."
    sdk_violations=$((sdk_violations + 1))
  fi
done

SDK_LICENSE_CHECKS=(
  'packages/sdk-dotnet/Postwave.csproj|<PackageLicenseExpression>MIT</PackageLicenseExpression>'
  'packages/sdk-elixir/mix.exs|licenses: ["MIT"]'
  'packages/sdk-java/pom.xml|<name>MIT License</name>'
  'packages/sdk-php/composer.json|"license": "MIT"'
  'packages/sdk-ruby/postwave.gemspec|spec.license = "MIT"'
  'packages/sdk-rust/Cargo.toml|license = "MIT"'
)

for check in "${SDK_LICENSE_CHECKS[@]}"; do
  manifest="${check%%|*}"
  expected="${check#*|}"
  if ! grep -Fq "$expected" "$manifest"; then
    echo >&2 "LICENSE METADATA: $manifest must contain: $expected"
    sdk_violations=$((sdk_violations + 1))
  fi
done

if [[ ! -f packages/sdk-java/src/main/resources/META-INF/LICENSE ]]; then
  echo >&2 "MISSING PACKAGED LICENSE: Java SDK JAR must include META-INF/LICENSE."
  sdk_violations=$((sdk_violations + 1))
fi

if (( sdk_violations > 0 )); then
  exit 1
fi

echo "multi-ecosystem SDK license metadata and texts OK"

# Application manifests and source headers must agree with the AGPL boundary.
app_violations=0

for app_dir in apps/* services/* infra; do
  [[ -d "$app_dir" ]] || continue
  if [[ ! -f "$app_dir/LICENSE" ]]; then
    echo >&2 "MISSING LICENSE: $app_dir must ship its AGPL component notice."
    app_violations=$((app_violations + 1))
    continue
  fi
  if ! grep -Fq "AGPL-3.0-only" "$app_dir/LICENSE"; then
    echo >&2 "LICENSE MISMATCH: $app_dir/LICENSE must declare AGPL-3.0-only."
    app_violations=$((app_violations + 1))
  fi
done

for pkgjson in apps/*/package.json; do
  [[ -f "$pkgjson" ]] || continue
  license="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('license',''))" "$pkgjson" 2>/dev/null || echo "")"
  if [[ "$license" != "AGPL-3.0-only" ]]; then
    echo >&2 "LICENSE MISMATCH: $pkgjson must declare AGPL-3.0-only (found '${license:-missing}')."
    app_violations=$((app_violations + 1))
  fi
  app_dir="$(dirname "$pkgjson")"
  if [[ ! -f "$app_dir/LICENSE" ]]; then
    echo >&2 "MISSING LICENSE: $app_dir must ship its AGPL component notice."
    app_violations=$((app_violations + 1))
  fi
done

if old_headers=$(grep -ErIl \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next \
  'Proprietary (and|&) confidential|Proprietary, closed source|closed-source proprietary code' \
  apps services infra 2>/dev/null); then
  if [[ -n "$old_headers" ]]; then
    echo >&2 "APPLICATION LICENSE MISMATCH: AGPL application files still claim proprietary/confidential status:"
    echo "$old_headers" | sed 's/^/  /' >&2
    app_violations=$((app_violations + 1))
  fi
fi

if [[ ! -f LICENSE || ! -f LICENSE-AGPL.md || ! -f LICENSE-BOUNDARY.md ]]; then
  echo >&2 "MISSING ROOT LICENSE: LICENSE, LICENSE-AGPL.md, and LICENSE-BOUNDARY.md are required."
  app_violations=$((app_violations + 1))
fi

if (( app_violations > 0 )); then
  exit 1
fi

echo "application AGPL manifest and source-header consistency OK"
