#!/usr/bin/env python3
#
# enrich-scopes.py — inject `x-required-scopes` into openapi.yaml from the
# ACTUAL apikeys.RequireScope(...) enforcement in the apps/api route tree.
#
# Why this exists: the gateway enforces per-route API-key scopes
# (apikeys.RequireScope), but the OpenAPI spec carried none — SDK/doc
# consumers had no machine-readable authz hint. This script is the canonical,
# re-runnable enricher. It is purely additive and FORMATTING-PRESERVING: it
# walks openapi.yaml line-by-line and splices an `x-required-scopes` block into
# each operation that has an inline RequireScope, anchored on the operation's
# (path, method) POSITION (not operationId — those are not unique). Operations
# already carrying x-required-scopes are skipped (idempotent).
#
# It only enriches operations whose (METHOD, path) matches a route guarded by
# an INLINE `.With(apikeys.RequireScope(apikeys.ScopeX)).Method("/path", ...)`.
# Group-level (r.Use) scopes and routes absent from the spec are left untouched
# rather than guessed — we never fabricate an authz claim.
#
# Usage:
#   python3 packages/openapi/scripts/enrich-scopes.py          # write
#   python3 packages/openapi/scripts/enrich-scopes.py --check  # exit 1 on drift
#
# After running, regenerate the JSON mirror:
#   python3 packages/openapi/scripts/yaml-to-json.py

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
API_DIR = ROOT / "apps" / "api"
SPEC_YAML = ROOT / "packages" / "openapi" / "openapi.yaml"

METHODS = {"get", "post", "put", "patch", "delete"}


def scope_const_map() -> dict[str, str]:
    """Scope const identifier -> wire string, parsed from the apikeys package."""
    out: dict[str, str] = {}
    pat = re.compile(r'(Scope[A-Za-z0-9_]+)\s+Scope\s*=\s*"([^"]+)"')
    for name in ("apikeys.go", "scopes.go"):
        f = API_DIR / "internal" / "apikeys" / name
        if f.exists():
            for m in pat.finditer(f.read_text()):
                out[m.group(1)] = m.group(2)
    return out


def route_scopes() -> dict[tuple[str, str], list[str]]:
    """(METHOD, path) -> sorted scopes, from inline RequireScope route guards."""
    const = scope_const_map()
    method_re = re.compile(r'\.(Get|Post|Put|Patch|Delete)\(\s*"(/api/[^"]+)"')
    scope_re = re.compile(r'RequireScopes?\(\s*apikeys\.(Scope[A-Za-z0-9_]+)')
    files = subprocess.run(
        ["bash", "-lc", "grep -rl 'RequireScope' apps/api --include=*.go | grep -v _test"],
        cwd=ROOT, capture_output=True, text=True,
    ).stdout.split()
    acc: dict[tuple[str, str], set[str]] = {}
    for fp in files:
        for line in (ROOT / fp).read_text().splitlines():
            scopes = scope_re.findall(line)
            meth = method_re.search(line)
            if scopes and meth:
                key = (meth.group(1).upper(), meth.group(2))
                acc.setdefault(key, set()).update(const.get(s, s) for s in scopes)
    return {k: sorted(v) for k, v in acc.items()}


# Line classifiers for the openapi.yaml structure: paths are 2-space indented,
# methods 4-space, operation fields 6-space.
PATH_RE = re.compile(r'^  (/\S+):\s*$')
METHOD_RE = re.compile(r'^    (get|post|put|patch|delete|head|options):\s*$')
OPFIELD_RE = re.compile(r'^      \S')
OPID_RE = re.compile(r'^      operationId:')
XSCOPE_RE = re.compile(r'^      x-required-scopes:')


def enrich(yaml_text: str, rs: dict[tuple[str, str], list[str]]) -> tuple[str, int]:
    lines = yaml_text.splitlines(keepends=True)
    out: list[str] = []
    cur_path = None
    cur_method = None          # METHOD string while inside an operation
    want: list[str] | None = None   # scopes pending insert for the current op
    inserted_here = False      # already spliced this op?
    has_xscope = False         # op already declares x-required-scopes
    count = 0

    def flush_after_method(idx_out_len):
        pass

    i = 0
    while i < len(lines):
        line = lines[i]
        mp = PATH_RE.match(line)
        mm = METHOD_RE.match(line)

        if mp:
            cur_path = mp.group(1)
            cur_method = None
            want = None
            out.append(line)
            i += 1
            continue

        if mm and cur_path is not None:
            cur_method = mm.group(1).upper()
            want = rs.get((cur_method, cur_path))
            inserted_here = False
            # Look ahead within this operation block for (a) an existing
            # x-required-scopes (idempotency) and (b) an operationId we can
            # anchor on. Scan until the next path/method or a line dedented
            # out of the op body.
            has_xscope = False
            has_opid = False
            j = i + 1
            while j < len(lines):
                nl = lines[j]
                if PATH_RE.match(nl) or METHOD_RE.match(nl):
                    break
                # a line indented <6 spaces with content ends the op body
                if nl.strip() and not nl.startswith("      "):
                    break
                if XSCOPE_RE.match(nl):
                    has_xscope = True
                if OPID_RE.match(nl):
                    has_opid = True
                j += 1
            out.append(line)
            i += 1
            # No operationId to anchor on (stub entries): splice right after the
            # method header so the op still gets its scopes.
            if want and not has_xscope and not has_opid:
                out.append("      x-required-scopes:\n")
                for s in want:
                    out.append(f"        - {s}\n")
                inserted_here = True
                count += 1
            continue

        # Inside an op body: splice after operationId (preferred) when pending.
        if want and not inserted_here and not has_xscope and OPID_RE.match(line):
            out.append(line)
            out.append("      x-required-scopes:\n")
            for s in want:
                out.append(f"        - {s}\n")
            inserted_here = True
            count += 1
            i += 1
            continue

        out.append(line)
        i += 1

    return "".join(out), count


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="exit 1 if the spec would change")
    args = ap.parse_args()

    rs = route_scopes()
    original = SPEC_YAML.read_text()
    enriched, count = enrich(original, rs)

    if args.check:
        if enriched != original:
            sys.stderr.write(
                "enrich-scopes: openapi.yaml is missing x-required-scopes entries; "
                "run `python3 packages/openapi/scripts/enrich-scopes.py`\n")
            return 1
        print("enrich-scopes: OK (x-required-scopes in sync)")
        return 0

    SPEC_YAML.write_text(enriched)
    print(f"enrich-scopes: spliced x-required-scopes into {count} operations "
          f"({len(rs)} inline-guarded routes discovered)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
