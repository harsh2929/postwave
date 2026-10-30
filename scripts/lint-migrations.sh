#!/usr/bin/env bash
# Fail-closed migration lint for lock-safe indexes, tenant RLS, and tenant FKs.
#
# Modes:
#   scripts/lint-migrations.sh                    # added migrations vs event/main base
#   scripts/lint-migrations.sh --all              # full migration tree
#   scripts/lint-migrations.sh path/to/file.sql   # explicit files

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$ROOT/infra/migrations"
BASELINE="${POSTWAVE_MIGRATION_LINT_BASELINE:-$ROOT/scripts/lint-migrations-baseline.json}"

if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 not found on PATH (required by migration lint)" >&2
    exit 2
fi

TARGETS=()
MODE="diff"
if [[ "${1:-}" == "--all" ]]; then
    MODE="all"
    shift
fi

if [[ $# -gt 0 ]]; then
    MODE="explicit"
    TARGETS=("$@")
elif [[ "$MODE" == "all" ]]; then
    while IFS= read -r file; do
        TARGETS+=("$file")
    done < <(find "$MIG_DIR" -maxdepth 1 -type f -name '*.sql' | sort)
else
    BASE_REF=""
    REQUESTED_BASE="${POSTWAVE_MIGRATION_LINT_BASE:-}"
    if [[ -n "$REQUESTED_BASE" ]] \
        && [[ ! "$REQUESTED_BASE" =~ ^0+$ ]] \
        && git -C "$ROOT" rev-parse --verify "${REQUESTED_BASE}^{commit}" >/dev/null 2>&1; then
        BASE_REF="$REQUESTED_BASE"
    elif git -C "$ROOT" rev-parse --verify origin/main >/dev/null 2>&1; then
        BASE_REF="origin/main"
    elif git -C "$ROOT" rev-parse --verify main >/dev/null 2>&1; then
        BASE_REF="main"
    elif git -C "$ROOT" rev-parse --verify HEAD~1 >/dev/null 2>&1; then
        BASE_REF="HEAD~1"
    fi

    if [[ -n "$BASE_REF" ]] \
        && [[ "$(git -C "$ROOT" rev-parse "$BASE_REF")" == "$(git -C "$ROOT" rev-parse HEAD)" ]] \
        && git -C "$ROOT" rev-parse --verify HEAD~1 >/dev/null 2>&1; then
        BASE_REF="HEAD~1"
    fi

    if [[ -n "$BASE_REF" ]]; then
        if ! DIFF_FILES="$(git -C "$ROOT" diff --name-only --diff-filter=A "$BASE_REF"...HEAD -- infra/migrations/)"; then
            echo "ERROR: could not compute migration diff from $BASE_REF to HEAD" >&2
            exit 2
        fi
        while IFS= read -r relative; do
            [[ -n "$relative" ]] && TARGETS+=("$ROOT/$relative")
        done <<<"$DIFF_FILES"
    elif git -C "$ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
        if ! DIFF_FILES="$(git -C "$ROOT" diff-tree --root --no-commit-id --name-only --diff-filter=A -r HEAD -- infra/migrations/)"; then
            echo "ERROR: could not compute root-commit migration diff" >&2
            exit 2
        fi
        while IFS= read -r relative; do
            [[ -n "$relative" ]] && TARGETS+=("$ROOT/$relative")
        done <<<"$DIFF_FILES"
    fi

    # New local migrations must never escape the gate before their first commit.
    while IFS= read -r relative; do
        [[ -n "$relative" ]] && TARGETS+=("$ROOT/$relative")
    done < <(git -C "$ROOT" ls-files --others --exclude-standard -- 'infra/migrations/*.sql')
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
    if [[ "$MODE" == "diff" ]]; then
        exec python3 "$ROOT/scripts/lint-migrations.py" \
            --root "$ROOT" \
            --baseline "$BASELINE" \
            --validate-baseline-only
    fi
    echo "ERROR: no migration files to lint" >&2
    exit 2
fi

EXISTING=()
for file in "${TARGETS[@]}"; do
    if [[ -f "$file" && "$file" == *.sql ]]; then
        EXISTING+=("$file")
    fi
done
if [[ ${#EXISTING[@]} -eq 0 ]]; then
    exec python3 "$ROOT/scripts/lint-migrations.py" \
        --root "$ROOT" \
        --baseline "$BASELINE" \
        --validate-baseline-only
fi

exec python3 "$ROOT/scripts/lint-migrations.py" \
    --root "$ROOT" \
    --baseline "$BASELINE" \
    "${EXISTING[@]}"
