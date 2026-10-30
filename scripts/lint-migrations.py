#!/usr/bin/env python3
"""Fail-closed SQL migration lint with an exact, reviewed legacy baseline."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


PINNED_BASELINE_SHA256 = "be5b1b408373cb6de828e166f947401420ea93ea8bed38c92d39e78f426a581c"
RULE_INDEX = "CONCURRENTLY-MISSING"
RULE_RLS = "FORCE-RLS-MISSING"
RULE_FK = "FK-TO-TENANTS-MISSING"
ALLOWED_RULES = {RULE_INDEX, RULE_RLS, RULE_FK}
VERIFICATION_KINDS_BY_CHECK = {
    "index_concurrently": {
        "index_valid",
        "index_valid_on_legacy_table",
        "partition_parent_index_valid",
        "replacement_index_valid",
    },
    "rls_enabled": {"rls_state"},
    "rls_forced": {"rls_state"},
    "permissive_policy": {"permissive_policy", "tenant_policy_bound", "policy_scope_exception"},
    "tenant_fk": {
        "tenant_fk_cascade",
        "tenant_fk_cascade_for_table",
        "tenant_fk_transitive_cascade",
    },
    "tenant_fk_cascade": {"tenant_fk_cascade", "tenant_fk_cascade_for_table"},
}

SMALL_TABLE_ALLOWLIST = {
    "schema_migrations",
    "tenants",
    "plans",
    "feature_flags",
    "settings",
    "workspace_settings",
    "notification_preferences",
    "system_health_checks",
    "system_config",
}

PLATFORM_TABLE_ALLOWLIST = {
    "platform_operators",
    "ops_check_results",
    "ops_check_history",
    "ops_manual_log",
    "ops_push_state",
    "ops_digest_state",
    "ops_action_runs",
}

IDENT = r'(?:(?:"[^"]+")|(?:[a-zA-Z_][a-zA-Z0-9_]*))(?:\.(?:(?:"[^"]+")|(?:[a-zA-Z_][a-zA-Z0-9_]*)))?'
RE_CREATE_INDEX = re.compile(
    rf"\bCREATE\s+(?P<unique>UNIQUE\s+)?INDEX\s+"
    rf"(?P<concurrently>CONCURRENTLY\s+)?"
    rf"(?:IF\s+NOT\s+EXISTS\s+)?"
    rf"(?P<index>{IDENT})\s+ON\s+(?:ONLY\s+)?(?P<table>{IDENT})",
    re.IGNORECASE,
)
RE_CREATE_TABLE = re.compile(
    rf"\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<table>{IDENT})\s*\(",
    re.IGNORECASE,
)
RE_ENABLE_RLS = re.compile(
    rf"\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?P<table>{IDENT})\s+"
    rf"ENABLE\s+ROW\s+LEVEL\s+SECURITY\b",
    re.IGNORECASE | re.DOTALL,
)
RE_FORCE_RLS = re.compile(
    rf"\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?P<table>{IDENT})\s+"
    rf"FORCE\s+ROW\s+LEVEL\s+SECURITY\b",
    re.IGNORECASE | re.DOTALL,
)
RE_CREATE_POLICY = re.compile(
    rf"\bCREATE\s+POLICY\s+{IDENT}\s+ON\s+(?P<table>{IDENT})"
    rf"(?:\s+AS\s+(?P<kind>PERMISSIVE|RESTRICTIVE))?",
    re.IGNORECASE | re.DOTALL,
)
RE_TENANT_COL = re.compile(r"\btenant_id\s+uuid\s+NOT\s+NULL\b", re.IGNORECASE)
RE_TENANT_FK_INLINE = re.compile(
    r"\btenant_id\s+uuid\s+NOT\s+NULL[^,)]*?"
    r"REFERENCES\s+tenants\s*\(\s*id\s*\)",
    re.IGNORECASE | re.DOTALL,
)
RE_TENANT_FK_CASCADE = re.compile(
    r"\btenant_id\s+uuid\s+NOT\s+NULL[^,)]*?"
    r"REFERENCES\s+tenants\s*\(\s*id\s*\)[^,)]*?ON\s+DELETE\s+CASCADE",
    re.IGNORECASE | re.DOTALL,
)
RE_ALTER_ADD_FK = re.compile(
    rf"\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?P<table>{IDENT})\s+"
    rf"ADD\s+(?:CONSTRAINT\s+{IDENT}\s+)?FOREIGN\s+KEY\s*\(\s*tenant_id\s*\)\s+"
    rf"REFERENCES\s+tenants\s*\(\s*id\s*\)(?P<tail>[^;]*)",
    re.IGNORECASE | re.DOTALL,
)


class BaselineError(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_identifier(name: str) -> str:
    name = name.strip()
    if "." in name:
        name = name.split(".", 1)[1]
    return name.strip('"').lower()


RE_DOLLAR_QUOTE_TAG = re.compile(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$")


def _is_identifier_char(char: str) -> bool:
    return char.isalnum() or char in "_$"


def _quoted_end(src: str, start: int) -> int:
    """Index just past the quoted literal or identifier that opens at start.

    Doubled quotes are escapes. An E'' string also takes backslash escapes.
    An unterminated literal runs to the end of the text.
    """

    quote = src[start]
    backslash_escapes = (
        quote == "'"
        and start > 0
        and src[start - 1] in "eE"
        and (start < 2 or not _is_identifier_char(src[start - 2]))
    )
    index = start + 1
    while index < len(src):
        char = src[index]
        if backslash_escapes and char == "\\":
            index += 2
            continue
        if char == quote:
            if src.startswith(quote * 2, index):
                index += 2
                continue
            return index + 1
        index += 1
    return len(src)


def _block_comment_end(src: str, start: int) -> int:
    """Index just past the block comment that opens at start.

    PostgreSQL nests block comments: /* a /* b */ c */ is one comment. Inside
    one, only "/*" and "*/" mean anything; quotes and "--" are plain text. An
    unterminated comment runs to the end of the text.
    """

    depth = 0
    index = start
    while index < len(src):
        if src.startswith("/*", index):
            depth += 1
            index += 2
        elif src.startswith("*/", index):
            depth -= 1
            index += 2
            if depth == 0:
                return index
        else:
            index += 1
    return len(src)


def strip_sql_comments(src: str) -> str:
    """Blank out SQL comments, keeping every other character and every newline in place.

    Text inside a string literal or a quoted identifier is not a comment. The
    first version of this stripper treated every "--" as a comment, so the
    '--' literal in migration 1772's CHECK (strpos(token, '--') = 0) blanked the
    rest of that line. That dropped the parentheses that close the CREATE TABLE,
    and referral_code_tokens escaped every table rule. A dollar-quoted body is
    scanned the same way, so comments inside a function or DO block are still
    blanked while its string literals are kept. Block comments nest, as in
    PostgreSQL; ending one at its first "*/" would leave the rest of a nested
    comment as text, and a quote in it would then swallow real SQL.
    """

    out: list[str] = []
    index = 0
    length = len(src)
    while index < length:
        char = src[index]
        if src.startswith("--", index):
            end = src.find("\n", index)
            end = length if end < 0 else end
            out.append(" " * (end - index))
            index = end
        elif src.startswith("/*", index):
            end = _block_comment_end(src, index)
            out.append(re.sub(r"[^\n]", " ", src[index:end]))
            index = end
        elif char in "'\"":
            end = _quoted_end(src, index)
            out.append(src[index:end])
            index = end
        elif (
            char == "$"
            and not (index > 0 and _is_identifier_char(src[index - 1]))
            and (tag := RE_DOLLAR_QUOTE_TAG.match(src, index)) is not None
        ):
            body_start = tag.end()
            close = src.find(tag.group(0), body_start)
            if close < 0:
                out.append(tag.group(0) + strip_sql_comments(src[body_start:]))
                index = length
            else:
                out.append(tag.group(0) + strip_sql_comments(src[body_start:close]) + tag.group(0))
                index = close + len(tag.group(0))
        else:
            out.append(char)
            index += 1
    return "".join(out)


def display_path(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def find_create_table_blocks(src: str) -> list[tuple[str, str, int, int]]:
    blocks: list[tuple[str, str, int, int]] = []
    for match in RE_CREATE_TABLE.finditer(src):
        table = normalize_identifier(match.group("table"))
        start = match.end() - 1
        depth = 0
        end = -1
        for index in range(start, len(src)):
            if src[index] == "(":
                depth += 1
            elif src[index] == ")":
                depth -= 1
                if depth == 0:
                    end = index
                    break
        if end >= 0:
            blocks.append((table, src[start + 1 : end], match.start(), end))
    return blocks


def statement_at(src: str, start: int) -> str:
    end = src.find(";", start)
    if end < 0:
        end = len(src) - 1
    return " ".join(src[start : end + 1].split())


def evidence_hash(path: str, rule: str, check: str, table: str, obj: str, evidence: str) -> str:
    canonical = "\x1f".join((path, rule, check, table, obj, evidence))
    return sha256_bytes(canonical.encode("utf-8"))


def make_finding(
    *,
    path: str,
    source_sha256: str,
    rule: str,
    check: str,
    table: str,
    obj: str,
    message: str,
    evidence: str = "missing",
    unique: bool | None = None,
) -> dict[str, Any]:
    finding: dict[str, Any] = {
        "path": path,
        "source_sha256": source_sha256,
        "rule": rule,
        "check": check,
        "table": table,
        "object": obj,
        "evidence_sha256": evidence_hash(path, rule, check, table, obj, evidence),
        "message": message,
    }
    if unique is not None:
        finding["unique"] = unique
    return finding


def lint_file(path: Path, root: Path) -> list[dict[str, Any]]:
    raw_bytes = path.read_bytes()
    raw = raw_bytes.decode("utf-8")
    src = strip_sql_comments(raw)
    rel = display_path(path, root)
    source_sha = sha256_bytes(raw_bytes)
    findings: list[dict[str, Any]] = []
    blocks = find_create_table_blocks(src)
    created_tables = {table for table, _, _, _ in blocks}

    def in_create_table(position: int) -> bool:
        return any(start <= position <= end for _, _, start, end in blocks)

    for match in RE_CREATE_INDEX.finditer(src):
        if in_create_table(match.start()) or match.group("concurrently"):
            continue
        table = normalize_identifier(match.group("table"))
        if table in SMALL_TABLE_ALLOWLIST or table in created_tables:
            continue
        index_name = normalize_identifier(match.group("index"))
        statement = statement_at(src, match.start())
        findings.append(
            make_finding(
                path=rel,
                source_sha256=source_sha,
                rule=RULE_INDEX,
                check="index_concurrently",
                table=table,
                obj=index_name,
                evidence=statement,
                unique=bool(match.group("unique")),
                message=(
                    f"CREATE INDEX `{index_name}` on existing table `{table}` lacks "
                    "CONCURRENTLY. Use CREATE [UNIQUE] INDEX CONCURRENTLY outside "
                    "an explicit transaction, or document an exact reviewed exception."
                ),
            )
        )

    enabled_rls = {normalize_identifier(m.group("table")) for m in RE_ENABLE_RLS.finditer(src)}
    forced_rls = {normalize_identifier(m.group("table")) for m in RE_FORCE_RLS.finditer(src)}
    permissive_policies = {
        normalize_identifier(m.group("table"))
        for m in RE_CREATE_POLICY.finditer(src)
        if (m.group("kind") or "PERMISSIVE").upper() != "RESTRICTIVE"
    }
    alter_fk_tables: dict[str, bool] = {}
    for match in RE_ALTER_ADD_FK.finditer(src):
        table = normalize_identifier(match.group("table"))
        cascade = bool(re.search(r"ON\s+DELETE\s+CASCADE", match.group("tail") or "", re.IGNORECASE))
        alter_fk_tables[table] = alter_fk_tables.get(table, False) or cascade

    for table, body, _, _ in blocks:
        if table in PLATFORM_TABLE_ALLOWLIST or not RE_TENANT_COL.search(body):
            continue
        if table not in enabled_rls:
            findings.append(
                make_finding(
                    path=rel,
                    source_sha256=source_sha,
                    rule=RULE_RLS,
                    check="rls_enabled",
                    table=table,
                    obj="relrowsecurity",
                    message=f"New tenant table `{table}` does not ENABLE ROW LEVEL SECURITY.",
                )
            )
        if table not in forced_rls:
            findings.append(
                make_finding(
                    path=rel,
                    source_sha256=source_sha,
                    rule=RULE_RLS,
                    check="rls_forced",
                    table=table,
                    obj="relforcerowsecurity",
                    message=f"New tenant table `{table}` does not FORCE ROW LEVEL SECURITY.",
                )
            )
        if table not in permissive_policies:
            findings.append(
                make_finding(
                    path=rel,
                    source_sha256=source_sha,
                    rule=RULE_RLS,
                    check="permissive_policy",
                    table=table,
                    obj="permissive_policy",
                    message=f"New tenant table `{table}` has no PERMISSIVE policy.",
                )
            )

        inline_fk = RE_TENANT_FK_INLINE.search(body) is not None
        alter_fk = table in alter_fk_tables
        if not (inline_fk or alter_fk):
            findings.append(
                make_finding(
                    path=rel,
                    source_sha256=source_sha,
                    rule=RULE_FK,
                    check="tenant_fk",
                    table=table,
                    obj="tenant_id_fkey",
                    message=f"New tenant table `{table}` has no tenant_id FK to tenants(id).",
                )
            )
        else:
            inline_cascade = RE_TENANT_FK_CASCADE.search(body) is not None
            alter_cascade = alter_fk_tables.get(table, False)
            if not (inline_cascade or alter_cascade):
                findings.append(
                    make_finding(
                        path=rel,
                        source_sha256=source_sha,
                        rule=RULE_FK,
                        check="tenant_fk_cascade",
                        table=table,
                        obj="tenant_id_fkey",
                        message=f"Tenant FK on `{table}` lacks ON DELETE CASCADE.",
                    )
                )
    return findings


def finding_key(finding: dict[str, Any]) -> tuple[str, ...]:
    return tuple(
        str(finding[key])
        for key in ("path", "rule", "check", "table", "object", "evidence_sha256")
    )


def git_bytes(root: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise BaselineError(f"git {' '.join(args)} failed: {detail or 'unknown error'}")
    return result.stdout


def validate_baseline(root: Path, baseline_path: Path) -> tuple[dict[str, Any], set[tuple[str, ...]]]:
    if not baseline_path.is_file():
        raise BaselineError(f"reviewed baseline is missing: {baseline_path}")
    raw = baseline_path.read_bytes()
    expected_sha = os.environ.get("POSTWAVE_MIGRATION_LINT_BASELINE_SHA256", PINNED_BASELINE_SHA256)
    actual_sha = sha256_bytes(raw)
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha or ""):
        raise BaselineError("pinned baseline SHA-256 is not configured")
    if actual_sha != expected_sha:
        raise BaselineError(
            f"baseline checksum mismatch: got {actual_sha}, expected {expected_sha}; "
            "every ledger change requires explicit review and a pin update"
        )
    try:
        baseline = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BaselineError(f"invalid baseline JSON: {exc}") from exc
    if baseline.get("version") != 1:
        raise BaselineError("baseline version must be 1")
    if baseline.get("scope") != "full-migration-tree":
        raise BaselineError("baseline scope must be full-migration-tree")
    cutoff = baseline.get("baseline_cutoff_commit", "")
    if not re.fullmatch(r"[0-9a-f]{40}", cutoff):
        raise BaselineError("baseline_cutoff_commit must be a full 40-character commit SHA")
    review = baseline.get("review")
    if not isinstance(review, dict) or not review.get("owner") or not review.get("review_by"):
        raise BaselineError("baseline requires review.owner and review.review_by")
    try:
        review_by = dt.date.fromisoformat(review["review_by"])
        today = dt.date.fromisoformat(
            os.environ.get("POSTWAVE_MIGRATION_LINT_TODAY", dt.datetime.now(dt.timezone.utc).date().isoformat())
        )
    except ValueError as exc:
        raise BaselineError(f"invalid baseline review date: {exc}") from exc
    if today > review_by:
        raise BaselineError(
            f"baseline review expired on {review_by.isoformat()} (owner: {review['owner']})"
        )

    entries = baseline.get("findings")
    files = baseline.get("files")
    dispositions = baseline.get("dispositions")
    if not isinstance(entries, list) or not isinstance(files, dict) or not isinstance(dispositions, dict):
        raise BaselineError("baseline requires findings[], files{}, and dispositions{}")
    for name, contract in dispositions.items():
        if (
            not isinstance(name, str)
            or not isinstance(contract, dict)
            or not contract.get("rationale")
            or contract.get("schema_verification_required") is not True
        ):
            raise BaselineError(
                f"disposition {name!r} requires a rationale and schema_verification_required=true"
            )
    if baseline.get("expected_findings") != len(entries):
        raise BaselineError("expected_findings does not match findings length")
    expected_counts = baseline.get("expected_rule_counts")
    actual_counts = Counter(entry.get("rule") for entry in entries)
    if expected_counts != dict(sorted(actual_counts.items())):
        raise BaselineError("expected_rule_counts does not match ledger findings")
    expected_dispositions = baseline.get("expected_disposition_counts")
    actual_dispositions = Counter(entry.get("disposition") for entry in entries)
    if expected_dispositions != dict(sorted(actual_dispositions.items())):
        raise BaselineError("expected_disposition_counts does not match ledger findings")

    required = {
        "id",
        "path",
        "rule",
        "check",
        "table",
        "object",
        "evidence_sha256",
        "disposition",
        "verification",
    }
    ids: set[str] = set()
    keys: set[tuple[str, ...]] = set()
    entry_paths: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or not required.issubset(entry):
            raise BaselineError(f"baseline entry lacks required fields: {entry!r}")
        if entry["id"] in ids:
            raise BaselineError(f"duplicate baseline id: {entry['id']}")
        ids.add(entry["id"])
        if entry["rule"] not in ALLOWED_RULES:
            raise BaselineError(f"unknown baseline rule: {entry['rule']}")
        if entry["disposition"] not in dispositions:
            raise BaselineError(f"unknown disposition on {entry['id']}: {entry['disposition']}")
        if not isinstance(entry["verification"], dict) or not entry["verification"].get("kind"):
            raise BaselineError(f"missing schema verification contract on {entry['id']}")
        allowed_kinds = VERIFICATION_KINDS_BY_CHECK.get(entry["check"])
        if not allowed_kinds or entry["verification"]["kind"] not in allowed_kinds:
            raise BaselineError(
                f"verification kind {entry['verification']['kind']!r} is invalid for "
                f"{entry['check']} on {entry['id']}"
            )
        # A named repair migration is bound into the effective-schema checksum
        # check, so it must exist and be forward of the finding whatever the
        # disposition; forward-repaired entries must name one.
        if entry["disposition"] == "forward-repaired" or "repair_migration" in entry:
            repair = entry.get("repair_migration", "")
            if not repair or not (root / repair).is_file():
                raise BaselineError(f"missing forward repair migration on {entry['id']}: {repair}")
            if Path(repair).name <= Path(entry["path"]).name:
                raise BaselineError(f"repair migration is not forward-only on {entry['id']}")
        key = finding_key(entry)
        if key in keys:
            raise BaselineError(f"duplicate baseline finding identity: {entry['id']}")
        keys.add(key)
        entry_paths.add(entry["path"])

    if set(files) != entry_paths:
        raise BaselineError("files map must exactly match the paths referenced by findings")
    for rel, metadata in files.items():
        if not re.fullmatch(r"infra/migrations/[0-9]{4}_[^/]+\.sql", rel):
            raise BaselineError(f"baseline path is not an exact numbered migration path: {rel}")
        if not isinstance(metadata, dict):
            raise BaselineError(f"invalid file metadata for {rel}")
        path = root / rel
        if not path.is_file():
            raise BaselineError(f"baseline migration is missing: {rel}")
        current_sha = sha256_bytes(path.read_bytes())
        if current_sha != metadata.get("source_sha256"):
            raise BaselineError(
                f"baseline source checksum mismatch for {rel}: got {current_sha}, "
                f"expected {metadata.get('source_sha256')}"
            )
        cutoff_bytes = git_bytes(root, "show", f"{cutoff}:{rel}")
        cutoff_sha = sha256_bytes(cutoff_bytes)
        if cutoff_sha != metadata.get("cutoff_sha256"):
            raise BaselineError(
                f"cutoff checksum mismatch for {rel}: got {cutoff_sha}, "
                f"expected {metadata.get('cutoff_sha256')}"
            )

    migration_paths = sorted((root / "infra/migrations").glob("*.sql"))
    recomputed = [finding for path in migration_paths for finding in lint_file(path, root)]
    recomputed_keys = {finding_key(finding) for finding in recomputed}
    if recomputed_keys != keys:
        stale = sorted(keys - recomputed_keys)
        unknown = sorted(recomputed_keys - keys)
        details = []
        if stale:
            details.append(f"stale/unknown ledger entries={len(stale)}")
        if unknown:
            details.append(f"new unreviewed findings in baseline files={len(unknown)}")
        raise BaselineError("baseline no longer exactly matches source: " + ", ".join(details))
    return baseline, keys


def print_violations(violations: list[dict[str, Any]]) -> None:
    print("FAIL: migration lint violations detected.\n", file=sys.stderr)
    by_file: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for finding in violations:
        by_file[finding["path"]].append(finding)
    for path, findings in sorted(by_file.items()):
        print(f"  {path}", file=sys.stderr)
        for finding in findings:
            print(
                f"    [{finding['rule']}:{finding['check']}] "
                f"table=`{finding['table']}` object=`{finding['object']}`",
                file=sys.stderr,
            )
            print(f"      {finding['message']}\n", file=sys.stderr)
    print(f"Total violations: {len(violations)}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--print-findings-json", action="store_true")
    parser.add_argument("--validate-baseline-only", action="store_true")
    parser.add_argument("files", nargs="*", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    files = list(dict.fromkeys(path.resolve() for path in args.files))
    findings = [finding for path in files for finding in lint_file(path, root)]
    if args.print_findings_json:
        print(json.dumps(findings, indent=2, sort_keys=True))
        return 0
    try:
        baseline, baseline_keys = validate_baseline(root, args.baseline.resolve())
    except (BaselineError, OSError) as exc:
        print(f"ERROR: migration lint baseline invalid: {exc}", file=sys.stderr)
        return 2
    if args.validate_baseline_only:
        print(
            f"OK: migration lint baseline exactly matches {baseline['expected_findings']} "
            "reviewed finding(s)."
        )
        return 0
    violations = [finding for finding in findings if finding_key(finding) not in baseline_keys]
    if violations:
        print_violations(violations)
        return 1
    suppressed = len(findings) - len(violations)
    print(
        f"OK: {len(files)} migration file(s) passed lint-migrations checks "
        f"({suppressed} exact reviewed finding(s) matched baseline; "
        f"ledger total={baseline['expected_findings']})."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
