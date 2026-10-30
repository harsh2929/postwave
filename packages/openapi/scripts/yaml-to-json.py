#!/usr/bin/env python3
#
# yaml-to-json.py — wholesale YAML → JSON conversion for openapi.yaml.
#
# The companion regenerate.go script appends route stubs to openapi.yaml
# and *also* mirrors them into openapi.json via a dependency-free
# string-splice. That works for the incremental case but lets the two
# files drift over time when YAML is hand-edited (added schemas,
# components, hand-curated path entries that bypass regenerate.go).
#
# This script is the canonical reconciler: it parses openapi.yaml
# end-to-end and writes the published package JSON plus the API-embedded
# docs mirror such that both are byte-for-byte semantically equivalent.
# Idempotent: running it twice produces the same JSON.
#
# Usage:
#   python3 packages/openapi/scripts/yaml-to-json.py        # write
#   python3 packages/openapi/scripts/yaml-to-json.py --check # exit 1 if drift
#
# Why Python and not Go: keeping regenerate.go zero-dep was an explicit
# choice in that script's header. Adding yaml.v3 to apps/api/go.mod just
# to support a sync flag would compile the dep into the API binary even
# though it's tooling-only. Python ships with the dev environment
# (PyYAML 6.x is available) and this script is a one-shot used only by
# `pnpm --filter @postwave/openapi sync-json` and CI.

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - tooling environment guarantee
    sys.stderr.write(
        "yaml-to-json: PyYAML not installed. Run `pip install pyyaml` "
        "or use the project's dev environment.\n"
    )
    sys.exit(2)


def find_repo_root(start: Path) -> Path:
    """Walk up from start until we find go.work — the repo marker."""
    cur = start.resolve()
    while True:
        if (cur / "go.work").exists():
            return cur
        if cur.parent == cur:
            sys.stderr.write(f"yaml-to-json: no go.work in any parent of {start}\n")
            sys.exit(1)
        cur = cur.parent


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync OpenAPI JSON mirrors from openapi.yaml.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit 1 if any OpenAPI JSON mirror is out of sync with openapi.yaml (CI mode).",
    )
    args = parser.parse_args()

    repo = find_repo_root(Path(__file__).parent)
    yaml_path = repo / "packages" / "openapi" / "openapi.yaml"
    json_paths = [
        repo / "packages" / "openapi" / "openapi.json",
        repo / "apps" / "api" / "internal" / "apidocs" / "openapi.json",
    ]

    if not yaml_path.exists():
        sys.stderr.write(f"yaml-to-json: missing {yaml_path}\n")
        return 1

    with yaml_path.open("r", encoding="utf-8") as fh:
        spec = yaml.safe_load(fh)

    # Match the formatting of the existing openapi.json:
    #   - 2-space indent
    #   - sort_keys=True (regenerate.go uses MarshalIndent which sorts
    #     map keys alphabetically; staying consistent prevents huge
    #     gratuitous diffs when the two scripts run in alternation)
    #   - trailing newline
    rendered = json.dumps(spec, indent=2, sort_keys=True, ensure_ascii=False) + "\n"

    if args.check:
        drifted: list[str] = []
        missing: list[str] = []
        for json_path in json_paths:
            rel = json_path.relative_to(repo)
            if not json_path.exists():
                missing.append(str(rel))
                continue
            existing = json_path.read_text(encoding="utf-8")
            if existing != rendered:
                drifted.append(str(rel))
        if missing:
            sys.stderr.write(
                "yaml-to-json: missing OpenAPI JSON mirror(s): "
                + ", ".join(missing)
                + "\n"
            )
            return 1
        if drifted:
            sys.stderr.write(
                "yaml-to-json: OpenAPI JSON mirror(s) out of sync with openapi.yaml: "
                + ", ".join(drifted)
                + ". "
                "Run `pnpm --filter @postwave/openapi sync-json`.\n"
            )
            return 1
        print("yaml-to-json: OpenAPI JSON mirrors are in sync.")
        return 0

    n_paths = len(spec.get("paths", {}))
    for json_path in json_paths:
        json_path.write_text(rendered, encoding="utf-8")
        print(f"yaml-to-json: wrote {json_path.relative_to(repo)} ({n_paths} paths).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
