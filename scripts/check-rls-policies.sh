#!/usr/bin/env bash
# check-rls-policies.sh
#
# Lints infra/migrations/*.sql for the RESTRICTIVE-only-policy antipattern
# that has bitten us twice in production (migrations 0077 + 0078 are the
# emergency follow-up fixes).
#
# Postgres semantics refresher:
#   - PERMISSIVE policies are ORed; a row is visible to a role iff at least
#     one PERMISSIVE policy returns true.
#   - RESTRICTIVE policies are ANDed on top of the PERMISSIVE OR; they
#     filter further but DO NOT GRANT access on their own.
#   - A table with FORCE ROW LEVEL SECURITY enabled and zero PERMISSIVE
#     policies is a silent always-deny for every non-owner role.
#
# What this lint catches:
#   For every table that the migration tree:
#     1) ENABLEs row level security on, AND
#     2) Has at least one CREATE POLICY ... AS RESTRICTIVE on,
#   we require at least one CREATE POLICY without the AS RESTRICTIVE
#   keyword (= an implicit/explicit PERMISSIVE) somewhere in
#   infra/migrations/*.sql.
#
# Cross-file fixups are tolerated: 0077 / 0078 patch earlier RESTRICTIVE-
# only tables by adding companion permissive policies in a later
# migration. We accept that as long as the permissive policy exists
# somewhere in the directory.
#
# Implementation notes:
#   - All hard work happens in a single Python process — bash 3.2 (the
#     macOS default) lacks mapfile + assoc arrays, so dropping into
#     python3 keeps this script portable across the dev laptops AND the
#     Linux CI runners.
#
# Exit codes:
#   0 — every restricted table has a companion permissive policy
#   1 — at least one table is RESTRICTIVE-only (silent always-deny)
#   2 — usage error / IO problem
#
# Usage:
#   scripts/check-rls-policies.sh                  # default migration dir
#   scripts/check-rls-policies.sh path/to/dir      # alternate dir
#

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="${1:-$ROOT/infra/migrations}"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
    echo "ERROR: migrations directory not found: $MIGRATIONS_DIR" >&2
    exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 not found on PATH (required by this lint)" >&2
    exit 2
fi

python3 - "$MIGRATIONS_DIR" <<'PY'
import os
import re
import sys
from pathlib import Path

migrations_dir = Path(sys.argv[1])
files = sorted(migrations_dir.glob("*.sql"))
if not files:
    print(f"ERROR: no .sql files found in {migrations_dir}", file=sys.stderr)
    sys.exit(2)

# Helpers that match an identifier — bare or "quoted" — without
# importing anything heavy. Moosewave migrations use lowercase bare
# identifiers, but be tolerant of the schema-qualified form.
ident = r'(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)(?:\.(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*))?'

re_enable = re.compile(
    rf"\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?({ident})\s+"
    rf"ENABLE\s+ROW\s+LEVEL\s+SECURITY\b",
    re.IGNORECASE | re.DOTALL,
)
# CREATE POLICY <pname> ON <table> [AS PERMISSIVE|RESTRICTIVE] ...
re_policy = re.compile(
    rf"\bCREATE\s+POLICY\s+{ident}\s+ON\s+({ident})"
    rf"(?:\s+AS\s+(PERMISSIVE|RESTRICTIVE))?",
    re.IGNORECASE | re.DOTALL,
)


def normalize(name: str) -> str:
    """Lowercase + unquote a (possibly schema-qualified) identifier."""
    name = name.strip()
    if name.startswith('"') and name.endswith('"'):
        return name[1:-1]
    if "." in name:
        # Drop the schema prefix; cross-file refs in our tree are
        # unqualified so matching the table name alone is sufficient.
        name = name.split(".", 1)[1]
        if name.startswith('"') and name.endswith('"'):
            return name[1:-1]
        return name.lower()
    return name.lower()


# Per-table accumulators across the whole tree.
rls_enabled: dict[str, str] = {}        # table -> first file that enabled
has_restrictive: dict[str, str] = {}    # table -> first file declaring restrictive
has_permissive: set[str] = set()        # table set with at least one permissive

for path in files:
    src = path.read_text(encoding="utf-8")
    # Drop -- line comments to avoid commented-out CREATE POLICY blocks
    # being counted. We don't strip /* ... */ because the migration tree
    # doesn't use that style and stripping risks false positives in
    # string literals.
    src = re.sub(r"--[^\n]*", "", src)

    # Each statement ends with ';' so we split that way. This is good
    # enough for our tightly-controlled migration style — we don't have
    # CREATE POLICY blocks inside DO/PL/pgSQL bodies.
    for stmt in src.split(";"):
        m = re_enable.search(stmt)
        if m:
            tbl = normalize(m.group(1))
            rls_enabled.setdefault(tbl, path.name)
        m = re_policy.search(stmt)
        if m:
            tbl = normalize(m.group(1))
            kind = (m.group(2) or "").upper()
            if kind == "RESTRICTIVE":
                has_restrictive.setdefault(tbl, path.name)
            else:
                # Either explicit PERMISSIVE or no AS clause (implicit
                # permissive — the Postgres default).
                has_permissive.add(tbl)

# A table is in violation iff it:
#   1) has RLS enabled somewhere, AND
#   2) has at least one RESTRICTIVE policy, AND
#   3) has zero PERMISSIVE policies anywhere in the migration tree.
violations = []
for tbl, first_file in sorted(has_restrictive.items()):
    if tbl not in rls_enabled:
        continue  # no-op restrictive policy — skip
    if tbl in has_permissive:
        continue  # cross-file fixup OK
    violations.append((tbl, first_file))

if not violations:
    print("OK: every RLS-enabled table with a RESTRICTIVE policy has a companion PERMISSIVE policy.")
    sys.exit(0)

print(
    "FAIL: RESTRICTIVE-only RLS policy detected (silent always-deny).",
    file=sys.stderr,
)
print("", file=sys.stderr)
print(
    "Postgres requires at least one PERMISSIVE policy for any access to be granted.",
    file=sys.stderr,
)
print(
    "A RESTRICTIVE policy is an AND-filter on top of the PERMISSIVE OR; alone it",
    file=sys.stderr,
)
print(
    "evaluates to access-denied for every non-owner role. This bit us in",
    file=sys.stderr,
)
print(
    "0077_send_domain_rls_fixup.sql + 0078_audience_rls_fixup.sql.",
    file=sys.stderr,
)
print("", file=sys.stderr)
print("Tables missing a companion PERMISSIVE policy:", file=sys.stderr)
for tbl, first_file in violations:
    print(f"  - {tbl:<40s} (first seen in {first_file})", file=sys.stderr)
print("", file=sys.stderr)
print(
    "Fix: add a CREATE POLICY ... AS PERMISSIVE FOR ALL TO postwave_app",
    file=sys.stderr,
)
print(
    "     USING/WITH CHECK clause in the same migration. See 0077/0078 for the",
    file=sys.stderr,
)
print(
    "     canonical fixup pattern.",
    file=sys.stderr,
)
sys.exit(1)
PY
