#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs one CI group on AWS CodeBuild. Invoked by buildspec-ci.yml with
# CI_GROUP set; each group mirrors the Linux jobs of the GitHub Actions
# workflows (.github/workflows/ci.yml, test.yml, openapi-check.yml) step for
# step, with the same commands, so a green group here means what a green job
# there means. This exists for when GitHub-hosted runners are unavailable
# (an Actions spending limit); it is not a second CI definition — when a
# workflow step changes, change the matching line here in the same commit.
#
# Groups: contracts | web | packages | go | ops | mobile | e2e | toolchain (installs only; smoke-tests the image)
# Not covered (need macOS or a JDK/Gradle toolchain): desktop-ci, mobile
# native Android/iOS smoke, mobile-release, visual-regression.
#
# Run locally for a dry look at the command list: CI_GROUP=web DRY_RUN=1 ./ci-group.sh
set -euo pipefail

CI_GROUP="${CI_GROUP:?CI_GROUP is required}"
CI_SHA="${CI_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
export GO_VERSION="${GO_VERSION:-1.26.8}"
export NODE_VERSION="${NODE_VERSION:-20.19.5}"
export PNPM_VERSION="${PNPM_VERSION:-9.12.0}"
export GOLANGCI_LINT_VERSION="${GOLANGCI_LINT_VERSION:-v2.12.2}"
export GITLEAKS_VERSION="${GITLEAKS_VERSION:-8.30.1}"
export CFN_LINT_VERSION="${CFN_LINT_VERSION:-1.53.0}"
export DRY_RUN="${DRY_RUN:-}"
export RUNNER_TEMP="${RUNNER_TEMP:-/tmp/runner}"
mkdir -p "$RUNNER_TEMP"

# ---------------------------------------------------------------------------
# Step runner. Every CI step runs through `step`, which prints a header, times
# the command, and records PASS/FAIL. A failing step stops the group (the
# workflows stop at the first failing step too) unless CI_CONTINUE=1, in which
# case every step runs and the group exits non-zero at the end.
# ---------------------------------------------------------------------------
FAILED=()
STEP_NO=0
step() {
  local name="$1"; shift
  STEP_NO=$((STEP_NO + 1))
  printf '\n=== [%s] step %02d: %s\n' "$CI_GROUP" "$STEP_NO" "$name"
  if [[ -n "$DRY_RUN" ]]; then printf '    %s\n' "$*"; return 0; fi
  local started=$SECONDS
  if "$@"; then
    printf -- '--- PASS %s (%ss)\n' "$name" "$((SECONDS - started))"
  else
    local rc=$?
    printf -- '--- FAIL %s (%ss, exit %s)\n' "$name" "$((SECONDS - started))" "$rc"
    FAILED+=("$name")
    [[ -n "${CI_CONTINUE:-}" ]] || return "$rc"
  fi
}
sh_step() { local name="$1"; shift; step "$name" bash -euo pipefail -c "$*"; }

# The EXIT trap's status is the group's exit status: 1 if any step failed or
# anything else stopped the script, else 0. The summary prints that status,
# not $? on entry, which is 0 after a failed step under CI_CONTINUE and the
# step's own code without it.
finish() {
  local rc=$? status=0
  [[ ${#FAILED[@]} -eq 0 && $rc -eq 0 ]] || status=1
  printf '\n=== [%s] summary: %d steps, %d failed (exit %s)\n' "$CI_GROUP" "$STEP_NO" "${#FAILED[@]}" "$status"
  for f in "${FAILED[@]:-}"; do [[ -n "$f" ]] && printf '    FAIL %s\n' "$f"; done
  return "$status"
}
trap finish EXIT

# ---------------------------------------------------------------------------
# Toolchains. The CodeBuild standard image ships older Go/Node than the
# workflows pin, so each group installs exactly the versions setup-go /
# setup-node / pnpm/action-setup would have. Installs are idempotent.
# ---------------------------------------------------------------------------
# Toolchain installs are skipped under DRY_RUN so the step list can be printed
# on a developer machine.
ensure_go() {
  [[ -n "$DRY_RUN" ]] && return 0
  if command -v go >/dev/null && [[ "$(go version 2>/dev/null)" == *"go${GO_VERSION} "* ]]; then return; fi
  echo "installing go ${GO_VERSION}"
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tgz
  rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz
  export PATH="/usr/local/go/bin:/root/go/bin:$PATH"
  go version
}
ensure_node() {
  local want="${1:-$NODE_VERSION}"
  [[ -n "$DRY_RUN" ]] && return 0
  if command -v node >/dev/null && [[ "$(node --version)" == "v${want}" ]]; then return; fi
  echo "installing node ${want}"
  # The CodeBuild standard image carries nvm (n is not installed).
  export NVM_DIR="${NVM_DIR:-/root/.nvm}"
  # shellcheck disable=SC1091
  [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"
  if command -v nvm >/dev/null; then
    nvm install "$want" >/dev/null && nvm use "$want" >/dev/null
  else
    curl -fsSL "https://nodejs.org/dist/v${want}/node-v${want}-linux-x64.tar.xz" -o /tmp/node.txz
    rm -rf /usr/local/node && mkdir -p /usr/local/node && tar -C /usr/local/node --strip-components=1 -xJf /tmp/node.txz
    export PATH="/usr/local/node/bin:$PATH"
  fi
  node --version
}
ensure_pnpm() {
  [[ -n "$DRY_RUN" ]] && return 0
  # Current corepack, not the one bundled with Node 20: audit-js.mjs runs a
  # pinned pnpm 11 through corepack, and Node 20's bundled corepack cannot
  # load it (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING).
  npm install -g corepack@latest >/dev/null 2>&1 || true
  if command -v pnpm >/dev/null && [[ "$(pnpm --version)" == "$PNPM_VERSION" ]]; then return; fi
  corepack enable >/dev/null 2>&1 || npm install -g corepack >/dev/null
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
  pnpm --version
}
# The image's pyenv puts a python3.12 shim on PATH whether or not 3.12 is
# installed, so probe the interpreter, never `command -v`.
have_python312() { python3.12 --version >/dev/null 2>&1; }
ensure_python() {
  [[ -n "$DRY_RUN" ]] && return 0
  # The workflows pin 3.12. Ubuntu 22.04's apt has 3.10; deadsnakes carries 3.12.
  if have_python312; then return; fi
  echo "installing python 3.12"
  (apt-get update -qq && apt-get install -y -qq --no-install-recommends software-properties-common >/dev/null \
    && add-apt-repository -y ppa:deadsnakes/ppa >/dev/null && apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends python3.12 python3.12-venv python3.12-dev >/dev/null \
    && python3.12 -m ensurepip --upgrade >/dev/null 2>&1) \
    || echo "WARN: python 3.12 unavailable, falling back to $(python3 --version)"
}
# PYTHON is a resolved binary (not a shell function) so `env … $PYTHON` and
# sub-shells can use it.
python_bin() { if python3.12 --version >/dev/null 2>&1; then echo python3.12; else echo python3; fi; }
py() { "$(python_bin)" "$@"; }
ensure_psql() { [[ -n "$DRY_RUN" ]] && return 0; command -v psql >/dev/null || (apt-get update -qq && apt-get install -y -qq --no-install-recommends postgresql-client >/dev/null); }
ensure_golangci() {
  [[ -n "$DRY_RUN" ]] && return 0
  if command -v golangci-lint >/dev/null && [[ "$(golangci-lint --version)" == *"${GOLANGCI_LINT_VERSION#v}"* ]]; then return; fi
  curl -fsSL https://raw.githubusercontent.com/golangci/golangci-lint/HEAD/install.sh | sh -s -- -b /usr/local/bin "$GOLANGCI_LINT_VERSION"
}
ensure_gitleaks() {
  [[ -n "$DRY_RUN" ]] && return 0
  command -v gitleaks >/dev/null && return
  curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" | tar -xz -C /usr/local/bin gitleaks
}
ensure_cfn_lint() {
  [[ -n "$DRY_RUN" ]] && return 0
  command -v cfn-lint >/dev/null && return
  py -m pip install -q "cfn-lint==${CFN_LINT_VERSION}" || pip3 install -q "cfn-lint==${CFN_LINT_VERSION}"
}
pnpm_install() { step "Install dependencies" pnpm install --frozen-lockfile; }
go_sync() { step "Sync Go workspace" go work sync; }

# Every workflow job starts from a checkout of the commit; the source zip
# carries the tree plus a single-commit .git so git-aware gates work.
# ---------------------------------------------------------------------------

export POSTWAVE_RELEASE="$CI_SHA" SENTRY_RELEASE="$CI_SHA"

group_contracts() {
  ensure_go; ensure_node; ensure_pnpm; ensure_python; ensure_cfn_lint
  # ci.yml: workflow-contracts
  step "Validate every GitHub Actions workflow" go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -color=false
  sh_step "Validate release-gate wiring" "node scripts/check-ci-release-contracts.mjs && node scripts/check-security-scan-coverage.mjs"
  sh_step "Prove release gates fail closed" "node scripts/check-ci-release-contracts.mjs --self-test && node scripts/check-security-scan-coverage.mjs --self-test && node scripts/check-load-target.mjs --self-test"
  # test.yml: aws-deployment-contracts
  sh_step "Verify platform, digest, migration, secret, and service-roll contracts" "node scripts/check-sensitive-handoff.mjs && node scripts/check-production-platform.mjs && node scripts/release/verify-aws-deployment-contracts.mjs"
  step "Validate every canonical CloudFormation template" cfn-lint \
    infra/aws/cloudformation/postwave-stack.yaml infra/aws/cloudformation/postwave-sidecars.yaml infra/aws/cloudformation/postwave-web.yaml \
    infra/aws/observability-stack.yaml infra/aws/cloudwatch-alarms.yaml infra/backup/aws-backup-dr.yaml infra/backup/aws-rds-dr.yaml infra/backup/aws-dns-failover.yaml
  # ci.yml: license-boundary-check
  step "Run license-boundary check" bash scripts/check-license-boundary.sh
  step "Run proprietary-isolation check" bash scripts/check-proprietary-isolation.sh
  step "Run package-import boundary check" bash scripts/check-package-imports.sh
  # ci.yml: secret-scan. gitleaks-action scans the commits of the push or PR,
  # not the whole tree; a whole-tree scan of the snapshot flags every fixture
  # ever committed, so scripts/ci/aws-ci.sh runs gitleaks over the commit range
  # against origin/main on the caller's clone instead.
  # ci.yml: openapi-lint
  step "Spectral lint" npx --yes @stoplight/spectral-cli@6 lint --ruleset packages/openapi/.spectral.yaml --fail-severity error packages/openapi/openapi.yaml
  step "Subscriber schema parity" node scripts/check-subscriber-parity.mjs
  sh_step "Route parity (gateway ↔ OpenAPI spec)" "node --test scripts/lib/route-reachability.test.mjs && node scripts/check-webhook-event-catalog.mjs --self-test && node scripts/check-webhook-event-catalog.mjs && node scripts/check-route-reachability-coverage.mjs --self-test && node scripts/check-route-reachability-coverage.mjs && node scripts/check-route-parity.mjs && node scripts/generate-route-capabilities.mjs --check"
  step "OpenAPI codegen drift check" node packages/openapi/scripts/codegen.mjs --check
  # openapi-check.yml: spec-up-to-date
  pnpm_install
  sh_step "Gateway route extraction drift check" "go test ./packages/openapi/scripts/regenerate.go ./packages/openapi/scripts/regenerate_test.go && go run ./packages/openapi/scripts/regenerate.go -check"
  sh_step "Go→OpenAPI schema generator drift check" "go test ./packages/openapi/scripts/gen-go-schemas.go ./packages/openapi/scripts/gen-go-schemas_test.go && go run ./packages/openapi/scripts/gen-go-schemas.go -check -merge TransactionalEmailRecord"
  step "Operation metadata drift check" node packages/openapi/scripts/complete-operation-metadata.mjs --check
  step "OpenAPI JSON mirror drift check" "$(python_bin)" packages/openapi/scripts/yaml-to-json.py --check
  sh_step "OpenAPI client-contract quality ratchet" "node scripts/check-openapi-contract-quality.mjs --self-test && node scripts/check-openapi-contract-quality.mjs"
  sh_step "First-party SDK parity" "node scripts/check-sdk-parity.mjs && node scripts/check-cutover-evidence-contract.mjs"
  # ci.yml: rls-policy-check + test.yml: migrations-lint. The migration lint
  # reads pinned baselines out of git history (`git show <commit>:<path>`),
  # which the single-commit snapshot does not have, so scripts/ci/aws-ci.sh
  # runs it on the caller's clone and reports it alongside these groups.
  step "Run RLS policy check" bash scripts/check-rls-policies.sh
  step "Reject leaked transaction-local database scope" bash scripts/check-no-bare-set-config.sh
  sh_step "Audit worker database scope" "pnpm test:worker-db-safety && pnpm audit:worker-db && node scripts/check-worker-db-safety.mjs --self-test && node scripts/check-worker-db-safety.mjs"
  step "Audit request-body bounds" pnpm audit:request-bodies
}

group_web() {
  ensure_node; ensure_pnpm
  # eslint over apps/web needs more than Node's default heap (it ran out at 2 GB).
  export NODE_OPTIONS="--max-old-space-size=8192"
  pnpm_install
  step "Build web workspace dependencies" pnpm --filter '@postwave/web^...' --if-present run build
  # The web suite's published-dist freshness test reads every package's dist.
  step "Build packages" pnpm -r --filter './packages/**' --if-present run build
  step "Lint" pnpm --filter @postwave/web lint
  step "Environment contract" pnpm --filter @postwave/web env:check
  step "Public claims register" pnpm audit:claims
  step "Third-party license policy" pnpm licenses:check
  step "Typecheck" pnpm --filter @postwave/web typecheck
  step "Unit tests" pnpm --filter @postwave/web test
  step "Build" pnpm --filter @postwave/web build
  step "Bundle budgets" pnpm --filter @postwave/web bundle:check
  step "Build docs site" pnpm --filter @postwave/docs build:archive-preview
}

group_packages() {
  ensure_go; ensure_node; ensure_pnpm; ensure_python
  pnpm_install
  # ci.yml: js-packages
  step "Validate every workspace quality gate" pnpm audit:workspace-quality
  step "Prove workspace policy fails closed" pnpm test:workspace-quality
  step "Check test skips are about the environment, not the fixture" pnpm audit:test-skip-honesty
  step "Check migration numbering is unique" pnpm audit:migration-numbering
  step "Check release locks are registered and unchanged" pnpm audit:release-locks
  step "Check context-epoch wiring" pnpm audit:context-epoch
  step "Check audit actor vocabulary matches the server" pnpm audit:audit-actor-vocabulary
  step "Check Klaviyo parity register" pnpm audit:klaviyo
  step "Check Mailchimp parity register" pnpm audit:mailchimp
  step "Check SDK tier manifest matches disk" pnpm audit:sdk-tiers
  step "Check tenant-abuse hardening" pnpm audit:tenant-abuse
  step "Check observability contract" pnpm audit:observability
  step "Test npm release planning" pnpm test:npm-release-plan
  step "Validate documentation governance" pnpm test:docs-contracts
  step "Execute documentation command contracts" env POSTWAVE_EXECUTE_DOCUMENT_CONTRACTS=1 pnpm docs:contracts
  step "Validate distribution hygiene" pnpm audit:distribution
  step "Build packages" pnpm -r --filter './packages/**' --if-present run build
  step "Lint packages" pnpm -r --filter './packages/**' run lint
  step "Typecheck packages" pnpm -r --filter './packages/**' run typecheck
  step "Test packages" pnpm -r --filter './packages/**' --if-present run test
  step "Verify packed npm artifacts and clean consumers" node scripts/release/verify-npm-package-set.mjs
  sh_step "Verify VS Code Marketplace artifact" '
    version="$(node -p "require(\"./packages/vscode-extension/package.json\").version")"
    artifact_dir="$RUNNER_TEMP/postwave-vscode-ci"; filename="postwave-vscode-${version}.vsix"; mkdir -p "$artifact_dir"
    pnpm --dir packages/vscode-extension exec vsce ls --no-dependencies
    pnpm --dir packages/vscode-extension exec vsce package --no-dependencies --githubBranch main --out "$artifact_dir/$filename"
    scripts/release/verify-vscode-vsix.sh "$artifact_dir/$filename" "$version" harsh2929/postwave'
  # ci.yml: js-audit — audit-js.mjs deliberately runs a pinned pnpm 11, which
  # needs Node 22; the job runs on Node 22.20.0.
  # nvm switches the whole prefix, so pnpm is re-activated after each switch.
  ensure_node 22.20.0; ensure_pnpm
  step "Test dependency-audit policy parser" pnpm test:audit-js
  step "Audit production dependencies" pnpm audit:js
  ensure_node; ensure_pnpm
  # ci.yml: agent-surface-audit
  go_sync
  step "Agent tool registry drift gate" pnpm audit:tools
  step "Ops registry guard" pnpm audit:ops
  step "SDK parity gate" pnpm audit:sdk-parity
  sh_step "Event-map parity gate" "pnpm test:event-map-parity && pnpm audit:event-map-parity"
  sh_step "Route-map destination gate" "pnpm test:route-map-destinations && pnpm audit:route-map-destinations"
  sh_step "Nav manifest destination gate" "pnpm test:nav-destinations && pnpm audit:nav-destinations"
  sh_step "Identity surface parity gate" "pnpm test:identity-parity && pnpm audit:identity-parity"
  sh_step "Optimistic concurrency gate" "pnpm test:optimistic-concurrency && pnpm audit:optimistic-concurrency"
  sh_step "Entitlement denial contract gate" "pnpm test:entitlement-denials && pnpm audit:entitlement-denials"
  sh_step "Ecosystem release-evidence gate" "pnpm test:ecosystem-evidence && pnpm audit:ecosystem-evidence"
  # ci.yml: python-sdk
  sh_step "Python SDK tests" "$(python_bin) -m venv $RUNNER_TEMP/venv && . $RUNNER_TEMP/venv/bin/activate && python -m pip install -q --upgrade pip && python -m pip install -q -e packages/sdk-py pytest pytest-asyncio && python -m pytest packages/sdk-py"
  # test.yml: ts-packages
  step "Build SDK first (typecheck dependency)" pnpm --filter @postwave/sdk build
  sh_step "TS packages typecheck" "for p in sdk mcp-server cli email-react claude-code-plugin schema; do pnpm --filter @postwave/\$p --if-present typecheck; done"
  sh_step "TS packages test" "for p in sdk mcp-server cli email-react claude-code-plugin; do pnpm --filter @postwave/\$p --if-present test; done"
  sh_step "Build remaining packages" "for p in mcp-server cli email-react claude-code-plugin; do pnpm --filter @postwave/\$p --if-present build; done"
  # test.yml: desktop (TypeScript shell only; Tauri/Rust checks live in desktop-ci.yml)
  step "Desktop build (tsc -b + vite build)" pnpm --filter postwave-desktop-shell build
}

group_go() {
  ensure_go; ensure_node; ensure_pnpm; ensure_python; ensure_psql; ensure_golangci
  go_sync
  # ci.yml: go-build-test
  sh_step "Check formatting" 'test -z "$(gofmt -l apps services packages infra tests)"'
  step "Check bounded request-body contract" go run ./apps/api/cmd/checkrequestbodies --root apps/api
  step "Check API source-quality ratchets" go run ./apps/api/cmd/checksourcequality --root apps/api
  step "Build" go build ./apps/api/... ./services/automation/... ./services/voice/... ./services/deliverability/... ./services/migration/... ./packages/migrate/... ./packages/kms/... ./packages/runtime/... ./packages/secrets/...
  # test.yml: go (release verifiers, Postgres, migrations, race tests)
  sh_step "Test release migration-state verifier" "cd apps/api && go test ../../scripts/release/verify-migration-state.go ../../scripts/release/verify-migration-state_test.go"
  sh_step "Test consent-evidence release preflight" "cd apps/api && go test ../../scripts/release/verify-consent-evidence.go ../../scripts/release/verify-consent-evidence_test.go"
  # max_locks_per_transaction=512, as on test.yml's service container (the
  # comment on its "Verify Postgres lock-table headroom" step has the
  # reasoning and measurements). One DELETE FROM tenants cascades through
  # ~720 foreign keys and holds ~3,300 locks until it commits. A test that
  # deletes a tenant as postwave_app must set app.tenant_id, which takes the
  # push-suppression domain advisory lock shared, so such deletes of
  # different tenants overlap in this database (a superuser's delete without
  # app.tenant_id takes it exclusively and runs alone), and the tests that
  # build scratch databases beside this one delete tenants there at the same
  # time. The overlap is bounded by go test -p, 8 on BUILD_GENERAL1_LARGE.
  # With the stock 64 the fourth concurrent cascade across databases fails
  # with SQLSTATE 53200 ("out of shared memory"), and the second can once
  # earlier overlap has used up the spare shared memory; with 512, 24 in one
  # database and 16 across 16 databases ran cleanly. The SHOW fails the step
  # if the setting did not take.
  sh_step "Start Postgres 16 (mirrors the workflow service container)" '
    docker rm -f postwave-ci-pg >/dev/null 2>&1 || true
    docker run -d --name postwave-ci-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=public-local-demo-only -e POSTGRES_DB=postwave -p 5432:5432 postgres:16-alpine -c max_locks_per_transaction=512 >/dev/null
    for _ in $(seq 1 60); do pg_isready -h localhost -U postgres -d postwave >/dev/null 2>&1 && break; sleep 1; done
    pg_isready -h localhost -U postgres -d postwave
    locks="$(docker exec postwave-ci-pg psql -U postgres -d postwave -tAc "SHOW max_locks_per_transaction")"
    echo "max_locks_per_transaction=$locks"
    [ "$locks" = 512 ] || { echo "max_locks_per_transaction is $locks, want 512" >&2; exit 1; }'
  sh_step "Apply migrations" '
    export PGPASSWORD=public-local-demo-only
    psql -v ON_ERROR_STOP=1 -h localhost -U postgres -d postwave -c "CREATE ROLE postwave_app WITH LOGIN PASSWORD '"'"'postwave_app_dev'"'"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; GRANT CONNECT ON DATABASE postwave TO postwave_app;"
    docker build --file infra/migrations/Dockerfile --tag postwave-db-migrator:test .
    docker run --rm --network host --env DATABASE_URL="postgres://postgres:public-local-demo-only@127.0.0.1:5432/postwave?sslmode=disable" --env POSTWAVE_MIGRATOR_ALLOW_UNSAFE=1 --env POSTWAVE_MIGRATOR_TIMEOUT=20m postwave-db-migrator:test'
  # scripts/lint-migrations-schema.py resolves its reviewed baseline with
  # `git show <commit>:<path>`, which the single-commit snapshot cannot serve.
  # Reported as SKIPPED (never PASS): run it from a clone with history against
  # a migrated database — scripts/ci/aws-ci.sh does when
  # POSTWAVE_CI_SCHEMA_DATABASE_URL points at one.
  STEP_NO=$((STEP_NO + 1))
  printf -- '\n=== [%s] step %02d: Verify reviewed migration-lint effective schema\n--- SKIPPED needs git history; run locally via scripts/ci/aws-ci.sh with POSTWAVE_CI_SCHEMA_DATABASE_URL\n' "$CI_GROUP" "$STEP_NO"
  step "Test (race + coverage)" env \
    DATABASE_URL='postgres://postwave_app:postwave_app_dev@localhost:5432/postwave?sslmode=disable' \
    TEST_DATABASE_URL='postgres://postwave_app:postwave_app_dev@localhost:5432/postwave?sslmode=disable' \
    POSTWAVE_TEST_ADMIN_DATABASE_URL='postgres://postgres:public-local-demo-only@localhost:5432/postwave?sslmode=disable' \
    go test -race -covermode=atomic -coverprofile=coverage.out -timeout=10m \
      ./apps/api/... ./services/automation/... ./services/deliverability/... ./services/migration/... ./services/voice/... ./packages/migrate/...
  # ci.yml: go-build-test's remaining packages (no DB involvement)
  step "Test kms, runtime, secrets" go test ./packages/kms/... ./packages/runtime/... ./packages/secrets/...
  # ci.yml: go-lint
  step "Test Go lint ratchet" node --test scripts/check-go-lint-baseline.test.mjs
  sh_step "Run uncapped Go lint ratchet" '
    scopes=(./apps/api/... ./services/automation/... ./services/voice/... ./services/deliverability/... ./services/migration/... ./packages/migrate/... ./packages/kms/... ./packages/runtime/... ./packages/secrets/...)
    golangci-lint run --timeout=5m --issues-exit-code=0 --max-issues-per-linter=0 --max-same-issues=0 --output.text.path=/dev/null --output.json.path="$RUNNER_TEMP/go-lint-report.json" "${scopes[@]}"
    args=(); for s in "${scopes[@]}"; do args+=(--scope "$s"); done
    node scripts/check-go-lint-baseline.mjs --report "$RUNNER_TEMP/go-lint-report.json" --tool-version '"$GOLANGCI_LINT_VERSION"' "${args[@]}"'
}

group_ops() {
  ensure_node 24.16.0; ensure_pnpm
  export OPS_API_ORIGIN=https://api.invalid OPS_API_ALLOWED_HOSTS=api.invalid OPS_PUBLIC_ORIGIN=https://ops.invalid OPS_RUNBOOK_BASE_URL=https://runbooks.invalid/production/
  pnpm_install
  step "Build ops workspace dependencies" pnpm --filter '@postwave/ops^...' --if-present run build
  step "Lint" pnpm --filter @postwave/ops lint
  step "Unit tests" pnpm --filter @postwave/ops test
  step "Typecheck" pnpm --filter @postwave/ops typecheck
  step "Production build" pnpm --filter @postwave/ops build
  step "Build pinned non-root container" docker build -f apps/ops/Dockerfile -t "postwave-ops:${CI_SHA}" .
}

group_mobile() {
  ensure_node 20.19.5; ensure_pnpm
  pnpm_install
  step "Build mobile workspace dependencies" pnpm --filter '@postwave/mobile^...' --if-present run build
  step "Typecheck" pnpm --filter @postwave/mobile typecheck
  step "Unit tests" pnpm --filter @postwave/mobile test:coverage
  step "Lint" pnpm --filter @postwave/mobile lint
  step "Source size and complexity ratchets" pnpm --filter @postwave/mobile quality:source-budgets
  step "Generated runtime documentation" pnpm --filter @postwave/mobile docs:runtime-check
  step "Expo dependency alignment" pnpm --filter @postwave/mobile exec expo install --check
  step "Expo config validation" pnpm --filter @postwave/mobile exec expo config --type public
  step "Expo Doctor" pnpm --filter @postwave/mobile quality:doctor
  step "Deterministic iOS and Android export with budgets" pnpm --filter @postwave/mobile build
}

group_e2e() {
  ensure_node; ensure_pnpm
  pnpm_install
  step "Boot full compose stack" docker compose -f infra/docker-compose.yml -f infra/docker-compose.full.yml up -d --wait
  if ! step "Run Playwright smoke" pnpm test:smoke:local; then
    docker compose -f infra/docker-compose.yml -f infra/docker-compose.full.yml logs --tail=200 || true
    return 1
  fi
}

group_toolchain() {
  # Installs every pinned toolchain and prints versions: a two-minute probe of
  # the image before a full run, and the first thing to re-run when the image
  # or a pin changes.
  sh_step "Go" "$(declare -f ensure_go); ensure_go; go version"
  sh_step "Node 20.19.5" "$(declare -f ensure_node); ensure_node; node --version"
  sh_step "pnpm" "$(declare -f ensure_pnpm); ensure_pnpm; pnpm --version"
  sh_step "Node 24.16.0" "$(declare -f ensure_node); ensure_node 24.16.0; node --version"
  sh_step "Python 3.12" "$(declare -f have_python312); $(declare -f ensure_python); $(declare -f py); ensure_python; py --version"
  sh_step "psql" "$(declare -f ensure_psql); ensure_psql; psql --version"
  sh_step "golangci-lint" "$(declare -f ensure_golangci); ensure_golangci; golangci-lint --version"
  sh_step "gitleaks" "$(declare -f ensure_gitleaks); ensure_gitleaks; gitleaks version"
  sh_step "cfn-lint" "$(declare -f ensure_cfn_lint); $(declare -f py); ensure_cfn_lint; cfn-lint --version || py -m cfnlint --version"
  sh_step "docker" "docker version --format '{{.Server.Version}}' && docker compose version"
}

case "$CI_GROUP" in
  contracts|web|packages|go|ops|mobile|e2e|toolchain) "group_${CI_GROUP}" ;;
  *) echo "unknown CI_GROUP '$CI_GROUP' (contracts|web|packages|go|ops|mobile|e2e|toolchain)" >&2; exit 64 ;;
esac
