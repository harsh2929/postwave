#!/usr/bin/env python3
"""Verify the effective database state promised by the migration lint ledger.

Two passes run against DATABASE_URL, which must be migrated to head:

1. The positive pass reads pg_catalog and checks the ledger's promises and
   the complete tenant schema against the reviewed registers below.
2. The negative self-test (run_negative_self_test) then applies each change in
   negative_cases() inside a transaction, runs the catalog scans in that same
   transaction and rolls it back. Each change is one the verifier must reject,
   so a catalog query edited into leniency fails here rather than letting CI
   pass. It needs a role that may GRANT on and ALTER the reviewed tables (CI
   connects as a superuser). --no-negative-self-test skips it, for a
   read-only check of a shared database; CI never passes it.

scripts/lint-migrations-schema.test.py tests the decision functions without a
database.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any, NamedTuple


def grant(*table: str, columns: dict[str, frozenset[str]] | None = None) -> dict[str, Any]:
    """One grantee's reviewed privileges on one table.

    table holds the table-level privileges and columns maps a column to the
    privileges granted on that column alone. Privilege names are the
    privilege_type values aclexplode() returns; a privilege held WITH GRANT
    OPTION is spelled "<privilege> WITH GRANT OPTION".
    """

    return {"table": frozenset(table), "columns": dict(columns or {})}


def on_columns(privileges: Iterable[str], *columns: str) -> dict[str, frozenset[str]]:
    """The same column privileges on each named column."""

    return {column: frozenset(privileges) for column in columns}


# Nullable tenant identifiers are not ordinary ownership edges. Keep this list
# exact and verify the effective object metadata so a new nullable tenant_id
# cannot silently become an unreviewed cross-tenant/global data path.
#
# "acl" is the table's exact ACL, the owner aside: every role (PUBLIC
# included) that holds a privilege, with its table-level privileges and its
# per-column privileges. The verifier compares it with aclexplode() over
# pg_class.relacl and every pg_attribute.attacl, so a new grantee, a widened
# table grant and a new column grant all fail. It also compares postwave_app's
# effective table privileges (has_table_privilege, which sees role membership)
# with the table-level part of the entry. An entry whose postwave_app grant
# includes DELETE on an audit table names a "delete_gate": the RESTRICTIVE
# DELETE policy, per relation, that confines the grant to one worker
# capability. The gate is verified with the privilege, so the grant cannot
# outlive the policy that makes it safe. "review" records why an ACL differs
# from the obvious one, with the evidence, and any gap the ACL leaves open.
NULLABLE_TENANT_EXCEPTIONS: dict[str, dict[str, Any]] = {
    "affiliate_conversions": {
        "comment": (
            "postwave:tenant-scope-exception=global-accounting; nullable and deliberately not a tenant FK "
            "so accounting rows survive tenant deletion"
        ),
        "fk_action": "none",
        "acl": {"postwave_app": grant("INSERT", "SELECT", "UPDATE")},
        "rls": False,
    },
    "audit_log": {
        "comment": (
            "postwave:tenant-scope-exception=platform-operator-audit; NULL identifies a fleet-level "
            "operator action while tenant rows retain ON DELETE CASCADE"
        ),
        "fk_action": "cascade",
        "acl": {
            "postwave_app": grant(
                "DELETE",
                "INSERT",
                "SELECT",
                columns=on_columns(
                    {"UPDATE"}, "legal_hold", "prev_hash", "retention_override_days", "row_hash"
                ),
            ),
            "postwave_ops": grant("INSERT"),
        },
        "rls": True,
        "delete_gate": {
            "setting": "app.audit_trim_worker",
            "policies": {
                "audit_log": "audit_log_trim_worker_only",
                "audit_log_legacy": "audit_log_legacy_trim_worker_only",
            },
        },
        "review": (
            "Migration 1902 granted DELETE so the retention trimmer (apps/api/internal/audit/trim.go, "
            "on the postwave_app pool) can enforce the audit retention window; without it every trim "
            "failed with permission denied. The grant is paired with the RESTRICTIVE DELETE policy "
            "audit_log_trim_worker_only (and audit_log_legacy_trim_worker_only on the directly granted "
            "legacy partition), which ANDs app.audit_trim_worker with tenant_isolation, so an ordinary "
            "tenant request still cannot delete its own audit rows. "
            "TestOnlyTheRetentionTrimmerCanDeleteAuditRows proves both directions as postwave_app. "
            "postwave_app may UPDATE only four columns: retention_override_days and legal_hold "
            "(migration 0271, the retention controls) and prev_hash and row_hash (migration 1726, the "
            "Merkle chain worker). postwave_ops holds INSERT alone (migration 1703), for the ops "
            "console's action-run audit rows."
        ),
    },
    "billing_events": {
        "comment": (
            "postwave:tenant-scope-exception=durable-audit-set-null; nullable FK uses ON DELETE SET NULL "
            "so webhook evidence survives tenant deletion"
        ),
        "fk_action": "set_null",
        "acl": {"postwave_app": grant("INSERT", "SELECT", "UPDATE")},
        "rls": True,
    },
    "blocklist_observations": {
        "comment": (
            "postwave:tenant-scope-exception=shared-infrastructure; NULL identifies operator-owned "
            "free-pool infrastructure"
        ),
        "fk_action": "none",
        "acl": {
            "postwave_app": grant("DELETE", "INSERT", "SELECT", "UPDATE"),
            "postwave_deliverability_discovery_definer": grant(
                columns=on_columns({"SELECT"}, "checked_at", "tenant_id")
            ),
        },
        "rls": True,
        "review": (
            "Migration 1849 gives the NOLOGIN BYPASSRLS role postwave_deliverability_discovery_definer "
            "SELECT on tenant_id and checked_at only, so deliverability_hub_worker_tenants() can list "
            "the tenants with recent observations without reading any other column."
        ),
    },
    "bot_open_signatures": {
        "comment": (
            "postwave:tenant-scope-exception=platform-default; NULL identifies a platform-wide bot signature"
        ),
        "fk_action": "cascade",
        "acl": {"postwave_app": grant("DELETE", "INSERT", "SELECT", "UPDATE")},
        "rls": True,
    },
    "campaign_template_reference_review_decisions": {
        "comment": (
            "postwave:tenant-scope-exception=platform-default; NULL identifies a catalog operator review "
            "of a platform-shared reference template"
        ),
        "fk_action": "cascade",
        "acl": {"postwave_app": grant("INSERT", "SELECT")},
        "rls": True,
        "review": (
            "Migration 1825 dropped NOT NULL: a platform review receipt has no tenant owner. "
            "validate_campaign_template_reference_review_decision() admits a NULL tenant only for the "
            "catalog operator, which must not be postwave_app, and tenant_isolation keeps tenant rows "
            "tenant-scoped. The exception comment is set by migration 2047. OPEN GAP, not fixed here: "
            "the ON DELETE CASCADE tenant FK cannot complete. campaign_template_reference_review_immutable "
            "rejects every DELETE, and ON DELETE RESTRICT FKs run both ways between this table and "
            "campaign_templates (template_id, and campaign_templates.reference_review_decision_id), so "
            "deleting a tenant that owns a reference review fails. When the cascade reaches the "
            "decisions, the guard raises SQLSTATE 55000 (\"campaign template reference review "
            "decisions are append-only\"); a tenant whose templates also have revisions can stop "
            "earlier, at campaign_template_revision_immutable. The verifier checks only that the FK "
            "is the one validated ON DELETE CASCADE tenant FK, not that the cascade can finish. The "
            "tenant-erasure follow-up for campaign_template_revisions must cover this guard and both "
            "RESTRICT FKs."
        ),
    },
    "campaign_templates": {
        "comment": (
            "postwave:tenant-scope-exception=platform-default; NULL identifies a platform-shared campaign template"
        ),
        "fk_action": "cascade",
        "acl": {"postwave_app": grant("INSERT", "SELECT", "UPDATE")},
        "rls": True,
        "review": (
            "Migration 1824 revoked DELETE: templates are archived and restored, never deleted, and every "
            "transition appends a revision. campaigntemplates' security_db_test asserts that a direct "
            "DELETE as postwave_app fails with permission denied."
        ),
    },
    "cli_device_grants": {
        "comment": (
            "postwave:tenant-scope-exception=preauth-secret; NULL identifies an unapproved device grant "
            "that must be selected only by a transaction-bound secret"
        ),
        "fk_action": "cascade",
        "acl": {"postwave_app": grant("DELETE", "INSERT", "SELECT", "UPDATE")},
        "rls": True,
    },
    "content_report_decisions": {
        "comment": (
            "postwave:tenant-scope-exception=durable-audit-set-null; nullable FK uses ON DELETE SET NULL "
            "so a statement of reasons survives tenant deletion"
        ),
        "fk_action": "set_null",
        "acl": {"postwave_app": grant("INSERT", "SELECT")},
        "rls": True,
        "review": (
            "Migration 2041: a DSA Art. 17 statement of reasons is a communication already sent, so it "
            "outlives its tenant, and it is NULL for a notice that never resolved to a tenant. DELETE is "
            "withheld. Tenant sessions see and insert only rows whose tenant_id label is their own "
            "tenant. The exception comment is set by migration 2047. OPEN GAP, not fixed here: nothing "
            "ties report_id to that label. The report_id FK is checked with the table owner's rights, "
            "so a tenant session that knows another tenant's report id, or an unresolved notice's id, "
            "can insert a decision for it. public_content_report_status() then shows that decision to "
            "the notifier, and UNIQUE (report_id) stops the rightful tenant from recording its own. The "
            "verifier checks the ACL, the comment and the SET NULL tenant FK, none of which covers "
            "report_id. The forward fix must bind each decision to its report's tenant, for example a "
            "composite FK (report_id, tenant_id) -> content_reports (id, tenant_id) over a unique key "
            "on those columns, which MATCH SIMPLE skips for an operator's NULL-tenant decision, with "
            "ON UPDATE CASCADE so the SET NULL that tenant deletion applies to "
            "content_reports.tenant_id carries into the decision."
        ),
    },
    "content_reports": {
        "comment": (
            "postwave:tenant-scope-exception=unresolved-public-ingest; NULL identifies a notice not yet "
            "resolved to a tenant asset, and ON DELETE SET NULL keeps the notice as evidence after tenant "
            "deletion"
        ),
        "fk_action": "set_null",
        "acl": {
            "postwave_app": grant(
                "INSERT", "SELECT", columns=on_columns({"UPDATE"}, "status", "updated_at")
            ),
        },
        "rls": True,
        "review": (
            "Migration 2041: a DSA Art. 16 notice is addressed to Moosewave and may arrive before its URL "
            "resolves to a tenant; record_public_content_report() (SECURITY DEFINER) is the only path that "
            "inserts a NULL tenant, and the tenant policies admit only rows of the session's tenant. The "
            "notice is evidence of when actual knowledge was obtained, so the tenant FK is ON DELETE SET "
            "NULL and DELETE is withheld. The exception comment is set by migration 2047. 2041 also "
            "granted UPDATE on the whole table, and content_reports_tenant_update admits every row of "
            "the session's tenant, so that tenant (for a public notice, the tenant whose content it "
            "reports) could rewrite actual_knowledge_at, the explanation, the notifier fields and the "
            "rest of the evidence. Migration 2047 narrows the grant to UPDATE (status, updated_at), the "
            "only columns contentreports.Repo.Decide writes. Still open: a tenant session can still set "
            "status by itself (to 'withdrawn', say) without recording a decision; a status-transition "
            "guard is the follow-up."
        ),
    },
    "ip_reputation_snapshots": {
        "comment": (
            "postwave:tenant-scope-exception=shared-infrastructure; NULL identifies operator-owned "
            "free-pool infrastructure"
        ),
        "fk_action": "none",
        "acl": {"postwave_app": grant("DELETE", "INSERT", "SELECT")},
        "rls": True,
    },
    "maintenance_windows": {
        "comment": (
            "postwave:tenant-scope-exception=platform-default; NULL identifies a platform-wide "
            "maintenance window"
        ),
        "fk_action": "none",
        "acl": {"postwave_app": grant("DELETE", "INSERT", "SELECT", "UPDATE")},
        "rls": True,
    },
    "privacy_incidents": {
        "comment": (
            "postwave:tenant-scope-exception=durable-audit-set-null; nullable FK uses ON DELETE SET NULL "
            "so compliance evidence survives tenant deletion"
        ),
        "fk_action": "set_null",
        "acl": {"postwave_app": grant("DELETE", "INSERT", "SELECT", "UPDATE")},
        "rls": True,
    },
    "recommendation_network_peers": {
        "comment": (
            "postwave:tenant-scope-exception=durable-audit-set-null; nullable FK uses ON DELETE SET NULL "
            "so archived network evidence survives tenant deletion"
        ),
        "fk_action": "set_null",
        "acl": {"postwave_app": grant("INSERT", "SELECT", "UPDATE")},
        "rls": True,
    },
    "tenant_feature_flags": {
        "comment": (
            "postwave:tenant-scope-exception=platform-default; NULL identifies a platform-wide feature default"
        ),
        "fk_action": "none",
        "acl": {"postwave_app": grant("DELETE", "INSERT", "SELECT", "UPDATE")},
        "rls": True,
    },
    "template_thumbnails": {
        "comment": (
            "postwave:tenant-scope-exception=platform-default; NULL mirrors a platform-shared campaign template"
        ),
        "fk_action": "cascade",
        "acl": {"postwave_app": grant("DELETE", "INSERT", "SELECT", "UPDATE")},
        "rls": True,
    },
    "web_vitals_events": {
        "comment": (
            "postwave:tenant-scope-exception=global-telemetry; nullable and deliberately not a tenant FK "
            "because anonymous telemetry is not tenant-owned"
        ),
        "fk_action": "none",
        "acl": {"postwave_app": grant("DELETE", "INSERT", "SELECT")},
        "rls": False,
        "review": (
            "Migration 1910 granted DELETE for retention.Sweeper.sweepGlobal "
            "(apps/api/internal/retention/raw_payloads.go), which prunes expired web vitals on the "
            "postwave_app pool and returned on its first error, so the missing grant also stopped the "
            "stripe_webhook_attempts prune. The table is global telemetry with no RLS and no tenant scope, "
            "so there is no tenant policy for a bare grant to widen. "
            "TestTheGlobalSweepCompletesBothStatements drives the real sweep."
        ),
    },
    "webmentions_inbox": {
        "comment": (
            "postwave:tenant-scope-exception=unresolved-public-ingest; NULL identifies a Webmention "
            "that could not yet be bound to a tenant"
        ),
        "fk_action": "cascade",
        "acl": {"postwave_app": grant("INSERT", "SELECT", "UPDATE")},
        "rls": True,
    },
}


def reviewed_app_privileges(contract: dict[str, Any]) -> set[str]:
    """The table-level privileges a register entry grants postwave_app."""

    return set(contract["acl"].get("postwave_app", {}).get("table", frozenset()))

GLOBAL_TENANT_EXCEPTIONS = {
    name for name, contract in NULLABLE_TENANT_EXCEPTIONS.items() if not contract["rls"]
}
PARTITIONED_NULLABLE_EXCEPTIONS = {"audit_log", "web_vitals_events"}


class PolicyFacts(NamedTuple):
    """One effective row-level security policy.

    command is pg_policy.polcmd: '*' (ALL), 'r' (SELECT), 'a' (INSERT),
    'w' (UPDATE) or 'd' (DELETE). roles are sorted role names, with PUBLIC for
    the PUBLIC pseudo-role. using and check are pg_get_expr output with runs of
    whitespace collapsed to one space; each is empty when the policy has none.
    """

    permissive: bool
    command: str
    roles: tuple[str, ...]
    using: str
    check: str


def capability_predicate(setting: str) -> str:
    """pg_get_expr's rendering of current_setting('<setting>', true) = 'true'."""

    return f"(current_setting('{setting}'::text, true) = 'true'::text)"


OUTBOX_WORKER_PREDICATE = capability_predicate("app.outbox_worker")


def worker_policy(command: str) -> PolicyFacts:
    """A permissive postwave_app policy gated only on the outbox-worker capability."""

    return PolicyFacts(
        permissive=True,
        command=command,
        roles=("postwave_app",),
        using="" if command == "a" else OUTBOX_WORKER_PREDICATE,
        check="" if command in {"r", "d"} else OUTBOX_WORKER_PREDICATE,
    )


def delete_gate_policy(setting: str) -> PolicyFacts:
    """The RESTRICTIVE DELETE policy that confines a DELETE grant to one capability."""

    return PolicyFacts(
        permissive=False,
        command="d",
        roles=("PUBLIC",),
        using=capability_predicate(setting),
        check="",
    )


# Every RLS tenant table must carry a policy whose predicate reads
# app.tenant_id, except the tables below. Each one is deliberately closed to
# tenant-scoped sessions rather than scoped by them: a worker capability scans
# it across tenants, or only a SECURITY DEFINER function can reach it. The
# register is exact. The verifier compares each table's complete effective
# policy set and its exact ACL (every grantee's table and column privileges,
# the owner aside, as for NULLABLE_TENANT_EXCEPTIONS) with the entry, plus
# postwave_app's effective table privileges. So an added policy, a widened
# predicate, a new table or column grant to any role, and a new grantee all
# fail. A reviewed table that gains an app.tenant_id policy fails too, and
# must leave the register.
TENANT_POLICY_SCOPE_EXCEPTIONS: dict[str, dict[str, Any]] = {
    "campaign_assurance_raw_output_cleanup_receipts": {
        "scope": "worker-capability",
        "acl": {"postwave_app": grant("INSERT", "SELECT")},
        "policies": {
            "campaign_assurance_raw_output_cleanup_receipts_worker_insert": worker_policy("a"),
            "campaign_assurance_raw_output_cleanup_receipts_worker_select": worker_policy("r"),
        },
        "review": (
            "Migration 2016. Orphan-cleanup receipts for Campaign Assurance raw model output are written "
            "only by the cleanup worker. apps/api/internal/campaignassurancerawstore/repository.go runs "
            "every statement under db.WithWorkerScope, and ClaimOrphans leases orphans across tenants with "
            "FOR UPDATE SKIP LOCKED, so a tenant predicate would break cleanup. Tenant sessions match no "
            "policy and see no rows. UPDATE, DELETE and TRUNCATE are revoked and the rows are immutable."
        ),
    },
    "campaign_assurance_raw_output_write_intents": {
        "scope": "worker-capability",
        "acl": {"postwave_app": grant("INSERT", "SELECT", "UPDATE")},
        "policies": {
            "campaign_assurance_raw_output_write_intents_worker": worker_policy("*"),
        },
        "review": (
            "Migration 2016. Pre-S3 write intents and their cleanup leases. Written and leased only under "
            "db.WithWorkerScope (campaignassurancerawstore/repository.go); ClaimOrphans scans every "
            "tenant's due intents. DELETE and TRUNCATE are revoked; the guard trigger allows a DELETE only "
            "once the tenant row is gone. TestWriteVersionCleanupReceiptLifecycleDB exercises the "
            "lifecycle as postwave_app."
        ),
    },
    "campaign_assurance_raw_output_write_receipts": {
        "scope": "worker-capability",
        "acl": {"postwave_app": grant("INSERT", "SELECT")},
        "policies": {
            "campaign_assurance_raw_output_write_receipts_worker_insert": worker_policy("a"),
            "campaign_assurance_raw_output_write_receipts_worker_select": worker_policy("r"),
        },
        "review": (
            "Migration 2016. Immutable exact-version S3 write receipts, recorded and read only under "
            "db.WithWorkerScope (campaignassurancerawstore/repository.go). Tenant sessions match no "
            "policy. UPDATE, DELETE and TRUNCATE are revoked."
        ),
    },
    "campaign_report_projection_mutation_authorizations": {
        "scope": "definer-owner-only",
        "acl": {},
        "policies": {
            "campaign_report_projection_mutation_auth_owner_internal": PolicyFacts(
                permissive=True,
                command="*",
                roles=("PUBLIC",),
                using=(
                    "(CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner FROM pg_class relation "
                    "WHERE (relation.oid = ('campaign_report_projection_mutation_authorizations'::regclass)"
                    "::oid))))"
                ),
                check=(
                    "(CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner FROM pg_class relation "
                    "WHERE (relation.oid = ('campaign_report_projection_mutation_authorizations'::regclass)"
                    "::oid))))"
                ),
            ),
        },
        "review": (
            "Migration 1964. A transaction-scoped bridge between the SECURITY DEFINER projection mutation "
            "functions and the projected-row triggers. No role but the owner holds a privilege, and the "
            "only policy admits the owner, which the definer functions run as. Rows are keyed by backend "
            "pid and transaction id and are removed before the function returns. "
            "apps/api/internal/campaignreportprojection/mutation_protocol_db_test.go asserts forced RLS "
            "and no postwave_app DML."
        ),
    },
    "deliverability_degradation_claims": {
        "scope": "worker-capability",
        "acl": {
            "postwave_app": grant(
                "INSERT",
                "SELECT",
                columns=on_columns(
                    {"UPDATE"},
                    "operator_attempt_count",
                    "operator_last_error",
                    "operator_lease_expires_at",
                    "operator_lease_token",
                    "operator_next_attempt_at",
                    "operator_notified_at",
                ),
            ),
        },
        "policies": {
            "deliverability_degradation_worker_all": worker_policy("*"),
        },
        "review": (
            "Migration 1849. Degradation claims are claimed and delivered only under db.WithWorkerScope "
            "(apps/api/internal/deliverability_hub/degradation.go and degradation_delivery.go); the "
            "operator-delivery lease scans due claims across tenants with FOR UPDATE SKIP LOCKED. "
            "postwave_app holds SELECT and INSERT on the table and UPDATE on the six operator_* "
            "delivery-state columns only, so even the worker cannot move a claim to another tenant: "
            "deliverability_degradation_worker_all checks only the worker capability. "
            "TestDeliverabilityInventoryScopeAndEvidencePrivileges_DB asserts that it cannot DELETE."
        ),
    },
    "referral_code_tokens": {
        "scope": "definer-bypassrls-only",
        "acl": {
            "postwave_referral_code_definer": grant(
                "DELETE",
                columns=on_columns(
                    {"INSERT", "SELECT"},
                    "referral_code_id",
                    "subscriber_id",
                    "tenant_id",
                    "token",
                    "token_kind",
                ),
            ),
        },
        "policies": {},
        "review": (
            "Migration 1772. The private, PII-free registry of the global referral token namespace. Only "
            "referral_code_tokens_sync() writes it and only referral_code_resolve() reads it, both SECURITY "
            "DEFINER functions owned by the NOLOGIN BYPASSRLS role postwave_referral_code_definer. Forced "
            "RLS with no policy denies every other role, the owner included. Resolution is cross-tenant by "
            "design, since a public URL names its tenant, so no tenant predicate can apply. "
            "TestReferralPublicCodeBoundary_DB asserts that a direct postwave_app read fails with 42501. "
            "The definer holds exactly what the sync needs: DELETE on the table, and INSERT and SELECT on "
            "the five registry columns; no UPDATE and no TRUNCATE. "
            "Tenant ownership is proven by referral_code_tokens_referral_code_tenant_fkey (migration 2047)."
        ),
    },
}


def flatten_acl(acl: dict[str, dict[str, Any]]) -> dict[tuple[str, str], frozenset[str]]:
    """A register ACL as (grantee, column) -> privileges; column '' is the table itself.

    Empty privilege sets are dropped, so an entry that spells out an empty
    grant compares equal to one that leaves the grantee out.
    """

    flat: dict[tuple[str, str], frozenset[str]] = {}
    for grantee, entry in acl.items():
        if entry.get("table"):
            flat[(grantee, "")] = frozenset(entry["table"])
        for column, privileges in entry.get("columns", {}).items():
            if not column:
                raise RuntimeError(f"register ACL for {grantee} names an empty column")
            if privileges:
                flat[(grantee, column)] = frozenset(privileges)
    return flat


def acl_errors(
    table: str, contract: dict[str, Any], actual: dict[tuple[str, str], frozenset[str]]
) -> list[str]:
    """Every difference between a register entry's exact ACL and the catalog's."""

    expected = flatten_acl(contract["acl"])
    errors: list[str] = []
    for grantee, column in sorted(set(expected) | set(actual)):
        want = expected.get((grantee, column), frozenset())
        got = actual.get((grantee, column), frozenset())
        if want != got:
            where = f"column {column}" if column else "the table"
            errors.append(
                f"{table} grants {grantee} {sorted(got)} on {where}; the reviewed ACL grants {sorted(want)}"
            )
    return errors


def policy_scope_exception_errors(
    table: str,
    contract: dict[str, Any],
    *,
    privileges: set[str],
    acl: dict[tuple[str, str], frozenset[str]],
    policies: dict[str, PolicyFacts],
) -> list[str]:
    """Compare one reviewed policy-scope exception with the effective catalog."""

    errors: list[str] = []
    expected = contract["policies"]
    for name in sorted(set(policies) - set(expected)):
        errors.append(f"{table} policy {name} is not part of its reviewed policy-scope exception")
    for name in sorted(set(expected) - set(policies)):
        errors.append(f"{table} is missing reviewed policy {name}")
    for name in sorted(set(expected) & set(policies)):
        if policies[name] != expected[name]:
            errors.append(
                f"{table} policy {name} differs from its reviewed definition: "
                f"got {policies[name]}, expected {expected[name]}"
            )
    if any("app.tenant_id" in policy.using or "app.tenant_id" in policy.check for policy in policies.values()):
        errors.append(
            f"{table} now has a policy that reads app.tenant_id; remove its reviewed "
            "policy-scope exception so the ordinary tenant-policy rule applies"
        )
    expected_privileges = reviewed_app_privileges(contract)
    if privileges != expected_privileges:
        errors.append(
            f"{table} postwave_app privileges are {sorted(privileges)}; "
            f"expected {sorted(expected_privileges)}"
        )
    errors.extend(acl_errors(table, contract, acl))
    return errors


def delete_gate_errors(
    table: str, contract: dict[str, Any], policies: dict[str, dict[str, PolicyFacts]]
) -> list[str]:
    """Require the RESTRICTIVE DELETE policy that makes a reviewed DELETE grant safe."""

    gate = contract.get("delete_gate")
    if gate is None:
        return []
    expected = delete_gate_policy(gate["setting"])
    errors: list[str] = []
    for relation, policy_name in sorted(gate["policies"].items()):
        actual = policies.get(relation, {}).get(policy_name)
        if actual is None:
            errors.append(
                f"{table} grants postwave_app DELETE, but the RESTRICTIVE delete gate {policy_name} "
                f"is missing on {relation}"
            )
        elif actual != expected:
            errors.append(
                f"{table} delete gate {policy_name} on {relation} differs from its reviewed definition: "
                f"got {actual}, expected {expected}"
            )
    return errors


def delete_gate_relations() -> dict[str, str]:
    """Every relation that carries a reviewed delete gate, mapped to its gate policy."""

    return {
        relation: policy_name
        for contract in NULLABLE_TENANT_EXCEPTIONS.values()
        for relation, policy_name in contract.get("delete_gate", {}).get("policies", {}).items()
    }


def partition_delete_gate_error(child: str, root: str, child_privileges: set[str]) -> str | None:
    """A partition granted DELETE directly must carry its root's reviewed delete gate."""

    gate = NULLABLE_TENANT_EXCEPTIONS.get(root, {}).get("delete_gate")
    if gate is None or "DELETE" not in child_privileges or child in gate["policies"]:
        return None
    return (
        f"partition {child} grants postwave_app DELETE directly but has no reviewed delete gate; "
        f"{root} confines DELETE to {gate['setting']}"
    )


# Tenant ownership of a NOT NULL tenant_id is proven in one of two ways:
#
#   * directly: exactly one validated ON DELETE CASCADE FK (tenant_id) ->
#     tenants(id); or
#   * through a parent: the table has no FK to tenants(id) at all, on any
#     column, and one of its FKs is validated, ON DELETE CASCADE, has only NOT
#     NULL columns, and maps the table's tenant_id onto the parent's tenant_id,
#     where the parent is itself bound (directly or through a parent of its
#     own).
#
# The second form proves the same two facts as the first. The row's tenant_id
# must equal a parent's tenant_id, which names a real tenant. Deleting the
# tenant deletes the parent, and the parent's cascade deletes the row. NOT NULL
# on every FK column matters because MATCH SIMPLE skips the check for a row
# with any NULL key column. Any FK to tenants(id), whatever its columns, puts
# the table's rows on the first cascade level of tenant deletion, next to the
# root, and PostgreSQL orders that level by RI trigger name
# (RI_ConstraintTrigger_a_<oid>). A table whose DELETE guard waits for its root
# row to be gone then fails or succeeds by OID digits (migration 2046), so a
# parent-bound table may have none. The verifier cannot read a guard's logic
# from the catalog. It therefore requires the second form only of the tables
# the ledger names in tenant_fk_transitive_cascade verifications, the ones
# migrations 2046 and 2047 bound through a parent. Guarded tables that still
# have a direct FK beside their root, such as ai_regression_results and
# campaign_assurance_patch_applications, pass the direct rule and remain an
# open follow-up.


class TenantTable(NamedTuple):
    """Ownership facts for one logical public table that exposes tenant_id.

    tenant_fk_count counts FKs shaped exactly (tenant_id) -> tenants(id);
    other_tenant_fk_count counts every other FK that references tenants.
    """

    name: str
    not_null: bool
    tenant_fk_count: int
    cascade_count: int
    other_tenant_fk_count: int = 0

    @property
    def directly_bound(self) -> bool:
        return self.not_null and self.tenant_fk_count == 1 and self.cascade_count == 1

    @property
    def any_tenant_fk_count(self) -> int:
        return self.tenant_fk_count + self.other_tenant_fk_count


class ForeignKeyEdge(NamedTuple):
    """One top-level public FK that does not reference tenants.

    columns holds (column, column is NOT NULL, referenced parent column) in key
    order.
    """

    table: str
    constraint: str
    parent: str
    validated: bool
    delete_action: str
    columns: tuple[tuple[str, bool, str], ...]


class TenantGraph(NamedTuple):
    tables: dict[str, TenantTable]
    edges: tuple[ForeignKeyEdge, ...]
    transitive: dict[str, tuple[str, ...]]

    @property
    def bound(self) -> set[str]:
        return {name for name, table in self.tables.items() if table.directly_bound} | set(
            self.transitive
        )


def transitive_binding_defect(edge: ForeignKeyEdge, bound: set[str]) -> str | None:
    """Explain why an FK cannot carry its table's tenant ownership, or return None."""

    if edge.parent == edge.table:
        return "is self-referential"
    if not edge.validated:
        return "is not validated"
    if edge.delete_action != "c":
        return "is not ON DELETE CASCADE"
    nullable = [column for column, not_null, _ in edge.columns if not not_null]
    if nullable:
        return (
            f"has nullable column(s) {', '.join(nullable)}, so MATCH SIMPLE does not "
            "check every row"
        )
    if not any(
        column == "tenant_id" and parent_column == "tenant_id"
        for column, _, parent_column in edge.columns
    ):
        return f"does not map tenant_id onto {edge.parent}.tenant_id"
    if edge.parent not in bound:
        return f"references {edge.parent}, which is not bound to tenants"
    return None


def resolve_tenant_bindings(
    tables: dict[str, TenantTable], edges: Iterable[ForeignKeyEdge]
) -> dict[str, tuple[str, ...]]:
    """Return every table bound to tenants only through a parent, with its binding FKs.

    This is the least fixed point that starts from the directly bound tables.
    A table whose only candidate parents reference each other in a cycle is
    never bound. A table that has any FK to tenants(id), on tenant_id or on any
    other column, must satisfy the direct rule, so it is never a candidate
    here.
    """

    bound = {name for name, table in tables.items() if table.directly_bound}
    candidates = [
        edge
        for edge in edges
        if edge.table in tables
        and tables[edge.table].not_null
        and tables[edge.table].any_tenant_fk_count == 0
    ]
    transitive: dict[str, set[str]] = {}
    changed = True
    while changed:
        changed = False
        for edge in candidates:
            if edge.constraint in transitive.get(edge.table, set()):
                continue
            if transitive_binding_defect(edge, bound) is None:
                transitive.setdefault(edge.table, set()).add(edge.constraint)
                bound.add(edge.table)
                changed = True
    return {table: tuple(sorted(names)) for table, names in sorted(transitive.items())}


def tenant_ownership_error(table: TenantTable, graph: TenantGraph) -> str | None:
    """Return the ownership error for a NOT NULL tenant table, or None when it is bound."""

    if table.directly_bound or (table.any_tenant_fk_count == 0 and table.name in graph.transitive):
        return None
    message = (
        f"{table.name}.tenant_id must have exactly one validated ON DELETE CASCADE FK to tenants(id) "
        f"(found {table.tenant_fk_count} tenant FK, {table.cascade_count} validated cascade)"
    )
    if table.tenant_fk_count != 0:
        return message
    if table.other_tenant_fk_count != 0:
        return (
            f"{message}; it cannot be bound through a parent either, because it has "
            f"{table.other_tenant_fk_count} FK(s) to tenants(id) on columns other than tenant_id"
        )
    bound = graph.bound
    defects = [
        f"{edge.constraint} {transitive_binding_defect(edge, bound)}"
        for edge in graph.edges
        if edge.table == table.name
    ]
    return (
        f"{message} or a transitive binding through a tenant-bound parent "
        f"(candidate FKs: {'; '.join(defects) if defects else 'none'})"
    )


def parse_foreign_key_edge(row: list[str]) -> ForeignKeyEdge:
    table, constraint, parent, validated_raw, delete_action, columns_raw = row
    columns = tuple(
        (str(column), bool(not_null), str(parent_column))
        for column, not_null, parent_column in json.loads(columns_raw)
    )
    return ForeignKeyEdge(
        table=table,
        constraint=constraint,
        parent=parent,
        validated=parse_bool(validated_raw),
        delete_action=delete_action,
        columns=columns,
    )


def load_foreign_key_edges(database_url: str | Session) -> tuple[ForeignKeyEdge, ...]:
    """Load every top-level FK from a logical public table, except FKs to tenants."""

    rows = run_query(
        database_url,
        """
        SELECT child.relname,
               constraint_meta.conname,
               parent.relname,
               constraint_meta.convalidated::text,
               constraint_meta.confdeltype::text,
               jsonb_agg(
                   jsonb_build_array(
                       child_column.attname, child_column.attnotnull, parent_column.attname
                   )
                   ORDER BY key_column.ordinal
               )::text
          FROM pg_constraint constraint_meta
          JOIN pg_class child ON child.oid = constraint_meta.conrelid
          JOIN pg_class parent ON parent.oid = constraint_meta.confrelid
          CROSS JOIN LATERAL unnest(constraint_meta.conkey, constraint_meta.confkey)
               WITH ORDINALITY AS key_column(child_attnum, parent_attnum, ordinal)
          JOIN pg_attribute child_column
            ON child_column.attrelid = constraint_meta.conrelid
           AND child_column.attnum = key_column.child_attnum
          JOIN pg_attribute parent_column
            ON parent_column.attrelid = constraint_meta.confrelid
           AND parent_column.attnum = key_column.parent_attnum
         WHERE constraint_meta.contype = 'f'
           AND constraint_meta.conparentid = 0
           AND constraint_meta.confrelid <> 'public.tenants'::regclass
           AND child.relnamespace = 'public'::regnamespace
           AND parent.relnamespace = 'public'::regnamespace
           AND child.relkind IN ('r', 'p')
           AND NOT child.relispartition
         GROUP BY child.relname, constraint_meta.conname, parent.relname,
                  constraint_meta.convalidated, constraint_meta.confdeltype
         ORDER BY child.relname, constraint_meta.conname;
        """,
    )
    return tuple(parse_foreign_key_edge(row) for row in rows)


def transitive_fk_check_errors(check: dict[str, Any], graph: TenantGraph) -> list[str]:
    """Verify one reviewed table that must be bound only through a named parent FK."""

    table_name = check.get("table")
    constraint = check.get("constraint")
    parent = check.get("parent")
    if not all(isinstance(value, str) and value for value in (table_name, constraint, parent)):
        raise RuntimeError(
            f"tenant_fk_transitive_cascade verification requires table, constraint and parent: {check!r}"
        )
    table = graph.tables.get(table_name)
    if table is None:
        return [f"{table_name} is not a logical public table with a tenant_id column"]
    problems: list[str] = []
    if not table.not_null:
        problems.append(f"{table_name}.tenant_id is nullable; a transitive tenant binding requires NOT NULL")
    if table.any_tenant_fk_count != 0:
        other = (
            f" ({table.other_tenant_fk_count} on columns other than tenant_id)"
            if table.other_tenant_fk_count
            else ""
        )
        problems.append(
            f"{table_name} must be bound to its tenant only through {constraint}, but it has "
            f"{table.any_tenant_fk_count} direct FK(s) to tenants(id){other}; that second cascade "
            "path lets tenant deletion reach the table on the same level as its parent"
        )
    edge = next(
        (item for item in graph.edges if item.table == table_name and item.constraint == constraint),
        None,
    )
    if edge is None:
        problems.append(f"required transitive tenant binding {constraint} is missing on {table_name}")
    elif edge.parent != parent:
        problems.append(
            f"transitive tenant binding {constraint} on {table_name} references {edge.parent}; "
            f"expected {parent}"
        )
    else:
        defect = transitive_binding_defect(edge, graph.bound)
        if defect is not None:
            problems.append(f"transitive tenant binding {constraint} on {table_name} {defect}")
    return problems


def verify_transitive_fks(
    checks: list[dict[str, Any]], graph: TenantGraph, errors: list[str]
) -> None:
    for check in checks:
        errors.extend(transitive_fk_check_errors(check, graph))


def load_linter(root: Path):
    spec = importlib.util.spec_from_file_location("postwave_lint_migrations", root / "scripts/lint-migrations.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load scripts/lint-migrations.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class Session(NamedTuple):
    """A database plus statements that run first, in the query's own transaction.

    run_query opens a transaction, runs prelude, runs the catalog query in the
    same transaction and rolls it back. The negative self-test uses this to
    show the verifier a forbidden catalog change that is never committed.
    """

    url: str
    prelude: str


def run_query(database: str | Session, sql: str) -> list[list[str]]:
    env = os.environ.copy()
    env.setdefault("PGCONNECT_TIMEOUT", "10")
    if isinstance(database, Session):
        # Each -c runs in the one session, and -q keeps the command tags of
        # BEGIN, the prelude and ROLLBACK out of the output. If any statement
        # fails, ON_ERROR_STOP ends the session and the server rolls back.
        commands = [
            "-q",
            "-c",
            "BEGIN",
            "-c",
            "SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '60s'",
            "-c",
            database.prelude,
            "-c",
            sql,
            "-c",
            "ROLLBACK",
        ]
        database_url = database.url
    else:
        commands = ["-c", sql]
        database_url = database
    result = subprocess.run(
        [
            "psql",
            "--no-psqlrc",
            "-X",
            "--dbname",
            database_url,
            "-v",
            "ON_ERROR_STOP=1",
            "-A",
            "-t",
            "-F",
            "\t",
            *commands,
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown psql error"
        raise RuntimeError(detail)
    return [line.split("\t") for line in result.stdout.splitlines() if line]


def load_checksum_supersessions(root: Path) -> dict[str, set[str]]:
    path = root / "infra/migrations/checksum-supersessions.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("version") != 1:
        raise RuntimeError("checksum supersessions version must be 1")
    review = raw.get("review", {})
    if not review.get("owner") or not review.get("review_by"):
        raise RuntimeError("checksum supersessions require review owner and review_by")
    review_by = dt.date.fromisoformat(review["review_by"])
    today = dt.date.fromisoformat(
        os.environ.get(
            "POSTWAVE_MIGRATION_SUPERSESSION_TODAY",
            dt.datetime.now(dt.timezone.utc).date().isoformat(),
        )
    )
    if today > review_by:
        raise RuntimeError(f"checksum supersession review expired on {review_by.isoformat()}")
    accepted: dict[str, set[str]] = {}
    for record in raw.get("supersessions", []):
        version = record.get("version", "")
        accepted_sha = record.get("accepted_sha256", "")
        current_sha = record.get("current_sha256", "")
        migration = root / "infra/migrations" / f"{version}.sql"
        if (
            not re.fullmatch(r"[0-9a-f]{64}", accepted_sha)
            or not re.fullmatch(r"[0-9a-f]{64}", current_sha)
            or accepted_sha == current_sha
            or not record.get("rationale")
            or not migration.is_file()
            or hashlib.sha256(migration.read_bytes()).hexdigest() != current_sha
        ):
            raise RuntimeError(f"invalid checksum supersession for {version!r}")
        if accepted_sha in accepted.setdefault(version, set()):
            raise RuntimeError(f"duplicate checksum supersession for {version}")
        accepted[version].add(accepted_sha)
    return accepted


def verify_checksums(database_url: str, root: Path, ledger: dict[str, Any], errors: list[str]) -> None:
    expected: dict[str, str] = {}
    for relative, metadata in ledger["files"].items():
        expected[Path(relative).stem] = metadata["source_sha256"]
    for entry in ledger["findings"]:
        repair = entry.get("repair_migration")
        if repair:
            expected[Path(repair).stem] = hashlib.sha256((root / repair).read_bytes()).hexdigest()
    values = ",".join(f"({sql_literal(version)})" for version in sorted(expected))
    rows = run_query(
        database_url,
        f"""
        WITH wanted(version) AS (VALUES {values})
        SELECT wanted.version, COALESCE(schema_migrations.checksum, '')
          FROM wanted
          LEFT JOIN schema_migrations USING (version)
         ORDER BY wanted.version;
        """,
    )
    actual = {version: checksum for version, checksum in rows}
    accepted = load_checksum_supersessions(root)
    for version, checksum in expected.items():
        recorded = actual.get(version)
        if recorded != checksum and recorded not in accepted.get(version, set()):
            errors.append(
                f"schema_migrations checksum mismatch for {version}: "
                f"got {recorded or 'missing'}, expected {checksum}"
            )


def verify_indexes(database_url: str, checks: list[dict[str, Any]], errors: list[str]) -> None:
    by_index = {check["index"]: check for check in checks}
    values = ",".join(f"({sql_literal(name)})" for name in sorted(by_index))
    rows = run_query(
        database_url,
        f"""
        WITH wanted(index_name) AS (VALUES {values})
        SELECT wanted.index_name,
               COALESCE(table_class.relname, ''),
               COALESCE(index_meta.indisvalid::text, ''),
               COALESCE(index_meta.indisready::text, ''),
               COALESCE(index_meta.indisunique::text, ''),
               COALESCE(table_class.relkind::text, '')
          FROM wanted
          LEFT JOIN pg_class index_class
            ON index_class.relname = wanted.index_name
           AND index_class.relnamespace = 'public'::regnamespace
          LEFT JOIN pg_index index_meta ON index_meta.indexrelid = index_class.oid
          LEFT JOIN pg_class table_class ON table_class.oid = index_meta.indrelid
         ORDER BY wanted.index_name;
        """,
    )
    actual = {row[0]: row[1:] for row in rows}
    for index_name, check in by_index.items():
        table, valid, ready, unique, relkind = actual.get(index_name, ["", "", "", "", ""])
        expected_table = check.get("effective_table", check["table"])
        if table != expected_table or valid != "true" or ready != "true":
            errors.append(
                f"index {index_name} is missing/invalid or belongs to {table or 'no table'}; "
                f"expected valid index on {expected_table}"
            )
        if (unique == "true") != bool(check.get("unique")):
            errors.append(f"index {index_name} uniqueness does not match the reviewed ledger")
        if check["kind"] == "partition_parent_index_valid" and relkind != "p":
            errors.append(f"{check['table']} is not a partitioned parent (relkind={relkind or 'missing'})")


def verify_partition_indexes(database_url: str, checks: list[dict[str, Any]], errors: list[str]) -> None:
    for check in checks:
        rows = run_query(
            database_url,
            f"""
            WITH table_parts AS (
                SELECT count(*)::int AS count
                  FROM pg_inherits
                 WHERE inhparent = {sql_literal(check['table'])}::regclass
            ), index_parts AS (
                SELECT count(*)::int AS count,
                       COALESCE(bool_and(child_meta.indisvalid AND child_meta.indisready), false) AS valid
                  FROM pg_inherits
                  JOIN pg_index child_meta ON child_meta.indexrelid = inhrelid
                 WHERE inhparent = {sql_literal(check['index'])}::regclass
            )
            SELECT table_parts.count, index_parts.count, index_parts.valid::text
              FROM table_parts CROSS JOIN index_parts;
            """,
        )
        table_count, index_count, valid = rows[0] if rows else ("0", "0", "false")
        if int(table_count) == 0 or table_count != index_count or valid != "true":
            errors.append(
                f"partition index {check['index']} has {index_count}/{table_count} valid attached child indexes"
            )


def verify_rls(database_url: str, checks: list[dict[str, Any]], errors: list[str]) -> None:
    expected: dict[str, dict[str, bool]] = {}
    for check in checks:
        state = expected.setdefault(check["table"], {"enabled": False, "forced": False})
        state["enabled"] = state["enabled"] or bool(check.get("enabled"))
        state["forced"] = state["forced"] or bool(check.get("forced"))
    values = ",".join(f"({sql_literal(table)})" for table in sorted(expected))
    rows = run_query(
        database_url,
        f"""
        WITH wanted(table_name) AS (VALUES {values})
        SELECT wanted.table_name,
               COALESCE(pg_class.relrowsecurity::text, ''),
               COALESCE(pg_class.relforcerowsecurity::text, '')
          FROM wanted
          LEFT JOIN pg_class
            ON pg_class.relname = wanted.table_name
           AND pg_class.relnamespace = 'public'::regnamespace
         ORDER BY wanted.table_name;
        """,
    )
    actual = {table: (enabled, forced) for table, enabled, forced in rows}
    for table, state in expected.items():
        enabled, forced = actual.get(table, ("", ""))
        if state["enabled"] and enabled != "true":
            errors.append(f"RLS is not enabled on {table}")
        if state["forced"] and forced != "true":
            errors.append(f"RLS is not forced on {table}")


def verify_policies(database_url: str, checks: list[dict[str, Any]], errors: list[str]) -> None:
    for check in checks:
        rows = run_query(
            database_url,
            f"""
            SELECT policy.polpermissive::text,
                   EXISTS (
                       SELECT 1 FROM pg_roles role
                        WHERE role.rolname = {sql_literal(check['role'])}
                          AND role.oid = ANY(policy.polroles)
                   )::text,
                   COALESCE(pg_get_expr(policy.polqual, policy.polrelid), ''),
                   COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
              FROM pg_policy policy
              JOIN pg_class table_class ON table_class.oid = policy.polrelid
             WHERE table_class.relnamespace = 'public'::regnamespace
               AND table_class.relname = {sql_literal(check['table'])}
               AND policy.polname = {sql_literal(check['policy'])};
            """,
        )
        if len(rows) != 1:
            errors.append(f"required policy {check['policy']} is missing on {check['table']}")
            continue
        permissive, role_applies, using_expr, check_expr = rows[0]
        setting = check.get("predicate_setting", "")
        if permissive != "true" or role_applies != "true":
            errors.append(f"policy {check['policy']} is not permissive for {check['role']}")
        if setting and (setting not in using_expr or setting not in check_expr):
            errors.append(f"policy {check['policy']} does not bind both predicates to {setting}")


def verify_fks(database_url: str, checks: list[dict[str, Any]], errors: list[str]) -> None:
    for check in checks:
        rows = run_query(
            database_url,
            f"""
            SELECT constraint_meta.convalidated::text,
                   pg_get_constraintdef(constraint_meta.oid)
              FROM pg_constraint constraint_meta
              JOIN pg_class table_class ON table_class.oid = constraint_meta.conrelid
             WHERE table_class.relnamespace = 'public'::regnamespace
               AND table_class.relname = {sql_literal(check['table'])}
               AND constraint_meta.conname = {sql_literal(check['constraint'])}
               AND constraint_meta.contype = 'f';
            """,
        )
        if len(rows) != 1:
            errors.append(f"required FK {check['constraint']} is missing on {check['table']}")
            continue
        validated, definition = rows[0]
        normalized = re.sub(r"\s+", " ", definition.lower())
        if validated != "true" or "foreign key (tenant_id)" not in normalized or "references tenants(id)" not in normalized or "on delete cascade" not in normalized:
            errors.append(f"FK {check['constraint']} is not a validated cascading tenant FK")


def verify_tenant_bound_policies(
    database_url: str, checks: list[dict[str, Any]], errors: list[str]
) -> None:
    """Require a permissive app policy whose effective predicate is tenant-bound."""

    tables = sorted({check["table"] for check in checks})
    if not tables:
        return
    values = ",".join(f"({sql_literal(table)})" for table in tables)
    rows = run_query(
        database_url,
        f"""
        WITH wanted(table_name) AS (VALUES {values})
        SELECT wanted.table_name,
               count(policy.oid) FILTER (
                   WHERE policy.polpermissive
                     AND (
                         0 = ANY(policy.polroles)
                         OR EXISTS (
                             SELECT 1
                               FROM pg_roles role
                              WHERE role.rolname = 'postwave_app'
                                AND role.oid = ANY(policy.polroles)
                         )
                     )
                     AND (
                         COALESCE(pg_get_expr(policy.polqual, policy.polrelid), '')
                             LIKE '%app.tenant_id%'
                         OR COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
                             LIKE '%app.tenant_id%'
                     )
               )::int
          FROM wanted
          LEFT JOIN pg_class table_class
            ON table_class.relname = wanted.table_name
           AND table_class.relnamespace = 'public'::regnamespace
          LEFT JOIN pg_policy policy ON policy.polrelid = table_class.oid
         GROUP BY wanted.table_name
         ORDER BY wanted.table_name;
        """,
    )
    actual = {table: int(count) for table, count in rows}
    for table in tables:
        if actual.get(table, 0) < 1:
            errors.append(
                f"{table} has no permissive postwave_app/PUBLIC policy bound to app.tenant_id"
            )


def verify_null_safe_tenant_policies(database_url: str, errors: list[str]) -> int:
    """Reject every effective public policy that directly casts an unset tenant GUC."""

    unsafe_cast = "(current_setting('app.tenant_id'::text, true))::uuid"
    rows = run_query(
        database_url,
        f"""
        SELECT table_class.relname,
               policy.polname,
               (
                   strpos(
                       COALESCE(pg_get_expr(policy.polqual, policy.polrelid), ''),
                       {sql_literal(unsafe_cast)}
                   ) > 0
               )::text,
               (
                   strpos(
                       COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), ''),
                       {sql_literal(unsafe_cast)}
                   ) > 0
               )::text
          FROM pg_policy policy
          JOIN pg_class table_class ON table_class.oid = policy.polrelid
          JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
         WHERE namespace.nspname = 'public'
           AND (
               COALESCE(pg_get_expr(policy.polqual, policy.polrelid), '') LIKE '%app.tenant_id%'
               OR COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), '') LIKE '%app.tenant_id%'
           )
         ORDER BY table_class.relname, policy.polname;
        """,
    )
    for table, policy, unsafe_using_raw, unsafe_check_raw in rows:
        unsafe_predicates = []
        if parse_bool(unsafe_using_raw):
            unsafe_predicates.append("USING")
        if parse_bool(unsafe_check_raw):
            unsafe_predicates.append("WITH CHECK")
        if unsafe_predicates:
            errors.append(
                f"policy {policy} on {table} has an unsafe direct app.tenant_id UUID cast "
                f"in {' and '.join(unsafe_predicates)}"
            )
    return len(rows)


def verify_table_fks(
    database_url: str, checks: list[dict[str, Any]], errors: list[str]
) -> None:
    """Verify an exact validated cascading tenant ownership edge by table."""

    tables = sorted({check["table"] for check in checks})
    if not tables:
        return
    values = ",".join(f"({sql_literal(table)})" for table in tables)
    rows = run_query(
        database_url,
        f"""
        WITH wanted(table_name) AS (VALUES {values})
        SELECT wanted.table_name,
               count(constraint_meta.oid) FILTER (
                   WHERE constraint_meta.convalidated
                     AND constraint_meta.contype = 'f'
                     AND constraint_meta.confrelid = 'public.tenants'::regclass
                     AND constraint_meta.confdeltype = 'c'
                     AND constraint_meta.conkey = ARRAY[tenant_column.attnum]::smallint[]
                     AND constraint_meta.confkey = ARRAY[tenant_id_column.attnum]::smallint[]
               )::int
          FROM wanted
          LEFT JOIN pg_class table_class
            ON table_class.relname = wanted.table_name
           AND table_class.relnamespace = 'public'::regnamespace
          LEFT JOIN pg_attribute tenant_column
            ON tenant_column.attrelid = table_class.oid
           AND tenant_column.attname = 'tenant_id'
           AND NOT tenant_column.attisdropped
          CROSS JOIN LATERAL (
              SELECT attnum
                FROM pg_attribute
               WHERE attrelid = 'public.tenants'::regclass
                 AND attname = 'id'
                 AND NOT attisdropped
          ) tenant_id_column
          LEFT JOIN pg_constraint constraint_meta
            ON constraint_meta.conrelid = table_class.oid
         GROUP BY wanted.table_name
         ORDER BY wanted.table_name;
        """,
    )
    actual = {table: int(count) for table, count in rows}
    for table in tables:
        if actual.get(table, 0) != 1:
            errors.append(
                f"{table}.tenant_id must have exactly one validated ON DELETE CASCADE FK "
                f"to tenants(id) (found {actual.get(table, 0)})"
            )


def parse_bool(value: str) -> bool:
    if value in {"t", "true"}:
        return True
    if value in {"f", "false"}:
        return False
    raise ValueError(f"unexpected PostgreSQL boolean value {value!r}")


def parse_privileges(value: str) -> set[str]:
    return {privilege for privilege in value.split(",") if privilege}


def normalize_expression(value: str) -> str:
    return " ".join(value.split())


class TenantTableFacts(NamedTuple):
    """What the complete tenant-schema scan reads about one logical table.

    public_privileges lists what PUBLIC holds: table privileges by name and
    column privileges as <privilege>(<column>). Both are rejected.
    """

    name: str
    relkind: str
    not_null: bool
    rls: bool
    forced: bool
    tenant_comment: str
    privileges: frozenset[str]
    public_privileges: str
    tenant_fk_count: int
    cascade_count: int
    set_null_count: int
    policy_count: int
    tenant_policy_count: int
    other_tenant_fk_count: int = 0

    @property
    def ownership(self) -> TenantTable:
        return TenantTable(
            name=self.name,
            not_null=self.not_null,
            tenant_fk_count=self.tenant_fk_count,
            cascade_count=self.cascade_count,
            other_tenant_fk_count=self.other_tenant_fk_count,
        )


def parse_tenant_table_row(row: list[str]) -> TenantTableFacts:
    (
        table,
        relkind,
        not_null_raw,
        rls_raw,
        force_raw,
        tenant_comment,
        privilege_raw,
        public_privilege_raw,
        tenant_fk_count_raw,
        cascade_count_raw,
        set_null_count_raw,
        other_tenant_fk_count_raw,
        policy_count_raw,
        tenant_policy_count_raw,
    ) = row
    return TenantTableFacts(
        name=table,
        relkind=relkind,
        not_null=parse_bool(not_null_raw),
        rls=parse_bool(rls_raw),
        forced=parse_bool(force_raw),
        tenant_comment=tenant_comment,
        privileges=frozenset(parse_privileges(privilege_raw)),
        public_privileges=public_privilege_raw,
        tenant_fk_count=int(tenant_fk_count_raw),
        cascade_count=int(cascade_count_raw),
        set_null_count=int(set_null_count_raw),
        policy_count=int(policy_count_raw),
        tenant_policy_count=int(tenant_policy_count_raw),
        other_tenant_fk_count=int(other_tenant_fk_count_raw),
    )


class ReviewedScopeFacts(NamedTuple):
    """Policies and ACLs of the relations the exception registers name.

    policies maps relation -> policy name -> PolicyFacts. acls maps each
    register table to its exact ACL, (grantee, column) -> privileges, with
    column '' for the table itself, PUBLIC spelled PUBLIC and the owner
    excluded (see flatten_acl).
    """

    policies: dict[str, dict[str, PolicyFacts]]
    acls: dict[str, dict[tuple[str, str], frozenset[str]]]


def tenant_table_errors(
    facts: TenantTableFacts, graph: TenantGraph, scope: ReviewedScopeFacts
) -> list[str]:
    """Every complete-scan error for one logical tenant table."""

    table = facts.name
    errors: list[str] = []
    if facts.public_privileges:
        errors.append(f"{table} grants privileges to PUBLIC: {facts.public_privileges}")
    if facts.not_null:
        if table in NULLABLE_TENANT_EXCEPTIONS:
            errors.append(f"{table}.tenant_id is no longer nullable but remains in the nullable exception register")
        ownership_error = tenant_ownership_error(facts.ownership, graph)
        if ownership_error is not None:
            errors.append(ownership_error)
    else:
        contract = NULLABLE_TENANT_EXCEPTIONS.get(table)
        if contract is None:
            errors.append(f"{table}.tenant_id is nullable without an exact reviewed exception")
            return errors
        if facts.tenant_comment != contract["comment"]:
            errors.append(f"{table}.tenant_id is missing its exact reviewed exception comment")
        expected_privileges = reviewed_app_privileges(contract)
        if set(facts.privileges) != expected_privileges:
            errors.append(
                f"{table} postwave_app privileges are {sorted(facts.privileges)}; "
                f"expected {sorted(expected_privileges)}"
            )
        errors.extend(acl_errors(table, contract, scope.acls.get(table, {})))
        errors.extend(delete_gate_errors(table, contract, scope.policies))
        if contract["fk_action"] == "none" and facts.tenant_fk_count != 0:
            errors.append(f"{table}.tenant_id must remain outside the tenant FK ownership graph")
        if contract["fk_action"] == "set_null" and (
            facts.tenant_fk_count != 1 or facts.set_null_count != 1
        ):
            errors.append(
                f"{table}.tenant_id must have exactly one validated ON DELETE SET NULL FK to tenants(id)"
            )
        if contract["fk_action"] == "cascade" and (
            facts.tenant_fk_count != 1 or facts.cascade_count != 1
        ):
            errors.append(
                f"{table}.tenant_id must have exactly one validated ON DELETE CASCADE FK to tenants(id)"
            )
        expected_partitioned = table in PARTITIONED_NULLABLE_EXCEPTIONS
        if (facts.relkind == "p") != expected_partitioned:
            errors.append(
                f"{table} relation kind is {facts.relkind}; reviewed nullable contract expects "
                f"{'a partitioned parent' if expected_partitioned else 'a regular table'}"
            )

    expected_rls = table not in GLOBAL_TENANT_EXCEPTIONS
    if facts.rls != expected_rls or facts.forced != expected_rls:
        errors.append(
            f"{table} RLS state is enabled={facts.rls}, forced={facts.forced}; "
            f"expected enabled={expected_rls}, forced={expected_rls}"
        )
    scope_contract = TENANT_POLICY_SCOPE_EXCEPTIONS.get(table)
    if scope_contract is not None:
        errors.extend(
            policy_scope_exception_errors(
                table,
                scope_contract,
                privileges=set(facts.privileges),
                acl=scope.acls.get(table, {}),
                policies=scope.policies.get(table, {}),
            )
        )
        return errors
    if expected_rls and facts.rls and facts.policy_count == 0:
        errors.append(f"{table} enables RLS but has no policies")
    if (
        expected_rls
        and facts.rls
        and table != "recommendation_network_peers"
        and facts.tenant_policy_count == 0
    ):
        errors.append(f"{table} has no policy predicate bound to app.tenant_id")
    return errors


def parse_policy_row(row: list[str]) -> tuple[str, str, PolicyFacts]:
    relation, name, permissive_raw, command, roles_raw, using, check = row
    return (
        relation,
        name,
        PolicyFacts(
            permissive=parse_bool(permissive_raw),
            command=command,
            roles=tuple(sorted(role for role in roles_raw.split(",") if role)),
            using=normalize_expression(using),
            check=normalize_expression(check),
        ),
    )


def load_policies(
    database_url: str | Session, relations: Iterable[str]
) -> dict[str, dict[str, PolicyFacts]]:
    """Load every policy on the named public relations."""

    names = sorted(set(relations))
    if not names:
        return {}
    values = ",".join(f"({sql_literal(name)})" for name in names)
    # pg_get_expr can span lines; collapse whitespace so each policy is one row.
    rows = run_query(
        database_url,
        f"""
        WITH wanted(relation_name) AS (VALUES {values})
        SELECT table_class.relname,
               policy.polname,
               policy.polpermissive::text,
               policy.polcmd::text,
               COALESCE((
                   SELECT string_agg(role_names.role_name, ',' ORDER BY role_names.role_name)
                     FROM (
                         SELECT CASE WHEN role_oid = 0 THEN 'PUBLIC'
                                     ELSE pg_get_userbyid(role_oid)::text END AS role_name
                           FROM unnest(policy.polroles) AS role_oid
                     ) AS role_names
               ), ''),
               regexp_replace(
                   COALESCE(pg_get_expr(policy.polqual, policy.polrelid), ''), '\\s+', ' ', 'g'
               ),
               regexp_replace(
                   COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), ''), '\\s+', ' ', 'g'
               )
          FROM wanted
          JOIN pg_class table_class
            ON table_class.relname = wanted.relation_name
           AND table_class.relnamespace = 'public'::regnamespace
          JOIN pg_policy policy ON policy.polrelid = table_class.oid
         ORDER BY table_class.relname, policy.polname;
        """,
    )
    policies: dict[str, dict[str, PolicyFacts]] = {}
    for row in rows:
        relation, name, facts = parse_policy_row(row)
        policies.setdefault(relation, {})[name] = facts
    return policies


def parse_acl_rows(rows: Iterable[list[str]]) -> dict[str, dict[tuple[str, str], frozenset[str]]]:
    """Group (relation, column, grantee, privilege) rows into flat ACLs.

    column is '' for a table-level privilege, the same spelling flatten_acl
    uses, so a register ACL and a catalog ACL compare directly.
    """

    grouped: dict[str, dict[tuple[str, str], set[str]]] = {}
    for relation, column, grantee, privilege in rows:
        grouped.setdefault(relation, {}).setdefault((grantee, column), set()).add(privilege)
    return {
        relation: {key: frozenset(privileges) for key, privileges in acl.items()}
        for relation, acl in grouped.items()
    }


def load_acls(
    database: str | Session, relations: Iterable[str]
) -> dict[str, dict[tuple[str, str], frozenset[str]]]:
    """The exact ACL of each named relation: every table and column grant, the owner aside.

    A relation with the default ACL (relacl NULL, no column ACLs) grants
    nothing to anyone but its owner and is absent from the result.
    """

    names = sorted(set(relations))
    if not names:
        return {}
    values = ",".join(f"({sql_literal(name)})" for name in names)
    rows = run_query(
        database,
        f"""
        WITH wanted(relation_name) AS (VALUES {values}),
        relation AS (
            SELECT table_class.oid, table_class.relname, table_class.relowner, table_class.relacl
              FROM wanted
              JOIN pg_class table_class
                ON table_class.relname = wanted.relation_name
               AND table_class.relnamespace = 'public'::regnamespace
        ), grants AS (
            SELECT relation.relname, relation.relowner, ''::text AS column_name, table_acl.*
              FROM relation
             CROSS JOIN LATERAL aclexplode(relation.relacl) AS table_acl
             WHERE relation.relacl IS NOT NULL
            UNION ALL
            SELECT relation.relname, relation.relowner, column_meta.attname::text, column_acl.*
              FROM relation
              JOIN pg_attribute column_meta
                ON column_meta.attrelid = relation.oid
               AND column_meta.attnum > 0
               AND NOT column_meta.attisdropped
               AND column_meta.attacl IS NOT NULL
             CROSS JOIN LATERAL aclexplode(column_meta.attacl) AS column_acl
        )
        SELECT grants.relname,
               grants.column_name,
               CASE WHEN grants.grantee = 0 THEN 'PUBLIC'
                    ELSE pg_get_userbyid(grants.grantee)::text END,
               grants.privilege_type
                   || CASE WHEN grants.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
          FROM grants
         WHERE grants.grantee <> grants.relowner
         ORDER BY 1, 2, 3, 4;
        """,
    )
    return parse_acl_rows(rows)


def policy_scope_check_errors(check: dict[str, Any], graph: TenantGraph) -> list[str]:
    """Verify a ledger entry that names a reviewed policy-scope exception.

    The complete tenant-schema scan compares the table with its register entry;
    this ties the static-lint finding to that entry, so removing the entry
    cannot leave the finding silently accepted.
    """

    table = check.get("table")
    if not isinstance(table, str) or not table:
        raise RuntimeError(f"policy_scope_exception verification requires table: {check!r}")
    if table not in TENANT_POLICY_SCOPE_EXCEPTIONS:
        return [f"{table} has no reviewed policy-scope exception in scripts/lint-migrations-schema.py"]
    if table not in graph.tables:
        return [f"{table} is not a logical public table with a tenant_id column"]
    return []


def verify_complete_tenant_tables(
    database_url: str | Session, errors: list[str]
) -> tuple[int, int, TenantGraph]:
    """Verify every effective logical table that exposes a tenant_id column.

    Partition children are checked separately. Partitioned parents are logical
    access surfaces and are intentionally included here. Returns the tenant
    ownership graph so reviewed per-table bindings are judged by the same rules.
    """

    rows = run_query(
        database_url,
        """
        WITH tenant_tables AS (
            SELECT table_class.oid,
                   table_class.relname,
                   table_class.relkind,
                   table_class.relrowsecurity,
                   table_class.relforcerowsecurity,
                   table_class.relacl,
                   table_class.relowner,
                   tenant_column.attnum,
                   tenant_column.attnotnull,
                   COALESCE(col_description(table_class.oid, tenant_column.attnum), '') AS tenant_comment
              FROM pg_class table_class
              JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
              JOIN pg_attribute tenant_column
                ON tenant_column.attrelid = table_class.oid
               AND tenant_column.attname = 'tenant_id'
               AND NOT tenant_column.attisdropped
             WHERE namespace.nspname = 'public'
               AND table_class.relkind IN ('r', 'p')
               AND NOT table_class.relispartition
        ), tenant_key AS (
            SELECT id_column.attnum
              FROM pg_attribute id_column
             WHERE id_column.attrelid = 'public.tenants'::regclass
               AND id_column.attname = 'id'
               AND NOT id_column.attisdropped
        ), tenant_fks AS (
            -- Every FK that references tenants, on any column. The first
            -- three counts take only the (tenant_id) -> tenants(id) shape;
            -- other_tenant_fk_count takes the rest.
            SELECT tenant_tables.oid,
                   count(constraint_meta.oid) FILTER (
                       WHERE constraint_meta.conkey = ARRAY[tenant_tables.attnum]::smallint[]
                         AND constraint_meta.confkey = ARRAY[tenant_key.attnum]::smallint[]
                   )::int AS tenant_fk_count,
                   count(constraint_meta.oid) FILTER (
                       WHERE constraint_meta.conkey = ARRAY[tenant_tables.attnum]::smallint[]
                         AND constraint_meta.confkey = ARRAY[tenant_key.attnum]::smallint[]
                         AND constraint_meta.convalidated
                         AND constraint_meta.confdeltype = 'c'
                   )::int AS cascade_count,
                   count(constraint_meta.oid) FILTER (
                       WHERE constraint_meta.conkey = ARRAY[tenant_tables.attnum]::smallint[]
                         AND constraint_meta.confkey = ARRAY[tenant_key.attnum]::smallint[]
                         AND constraint_meta.convalidated
                         AND constraint_meta.confdeltype = 'n'
                   )::int AS set_null_count,
                   count(constraint_meta.oid) FILTER (
                       WHERE constraint_meta.conkey IS DISTINCT FROM ARRAY[tenant_tables.attnum]::smallint[]
                          OR constraint_meta.confkey IS DISTINCT FROM ARRAY[tenant_key.attnum]::smallint[]
                   )::int AS other_tenant_fk_count
              FROM tenant_tables
             CROSS JOIN tenant_key
              LEFT JOIN pg_constraint constraint_meta
                ON constraint_meta.conrelid = tenant_tables.oid
               AND constraint_meta.contype = 'f'
               AND constraint_meta.confrelid = 'public.tenants'::regclass
             GROUP BY tenant_tables.oid
        ), policy_state AS (
            SELECT tenant_tables.oid,
                   count(policy.oid)::int AS policy_count,
                   count(policy.oid) FILTER (
                       WHERE COALESCE(pg_get_expr(policy.polqual, policy.polrelid), '') LIKE '%app.tenant_id%'
                          OR COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), '') LIKE '%app.tenant_id%'
                   )::int AS tenant_policy_count
              FROM tenant_tables
              LEFT JOIN pg_policy policy ON policy.polrelid = tenant_tables.oid
             GROUP BY tenant_tables.oid
        )
        SELECT tenant_tables.relname,
               tenant_tables.relkind::text,
               tenant_tables.attnotnull::text,
               tenant_tables.relrowsecurity::text,
               tenant_tables.relforcerowsecurity::text,
               tenant_tables.tenant_comment,
               COALESCE((
                   SELECT string_agg(privilege.name, ',' ORDER BY privilege.name)
                     FROM (VALUES
                         ('DELETE'), ('INSERT'), ('REFERENCES'), ('SELECT'),
                         ('TRIGGER'), ('TRUNCATE'), ('UPDATE')
                     ) AS privilege(name)
                    WHERE has_table_privilege('postwave_app', tenant_tables.oid, privilege.name)
               ), ''),
               COALESCE((
                   SELECT string_agg(public_grant.privilege, ',' ORDER BY public_grant.privilege)
                     FROM (
                         SELECT table_grant.privilege_type AS privilege
                           FROM aclexplode(COALESCE(
                               tenant_tables.relacl, acldefault('r', tenant_tables.relowner)
                           )) table_grant
                          WHERE table_grant.grantee = 0
                         UNION ALL
                         SELECT column_grant.privilege_type || '(' || column_meta.attname || ')'
                           FROM pg_attribute column_meta
                          CROSS JOIN LATERAL aclexplode(column_meta.attacl) column_grant
                          WHERE column_meta.attrelid = tenant_tables.oid
                            AND column_meta.attnum > 0
                            AND NOT column_meta.attisdropped
                            AND column_meta.attacl IS NOT NULL
                            AND column_grant.grantee = 0
                     ) public_grant
               ), ''),
               tenant_fks.tenant_fk_count,
               tenant_fks.cascade_count,
               tenant_fks.set_null_count,
               tenant_fks.other_tenant_fk_count,
               policy_state.policy_count,
               policy_state.tenant_policy_count
          FROM tenant_tables
          JOIN tenant_fks USING (oid)
          JOIN policy_state USING (oid)
         ORDER BY tenant_tables.relname;
        """,
    )
    facts = [parse_tenant_table_row(row) for row in rows]
    actual_names = {item.name for item in facts}
    missing_exceptions = sorted(set(NULLABLE_TENANT_EXCEPTIONS) - actual_names)
    for table in missing_exceptions:
        errors.append(f"reviewed nullable tenant exception {table} is missing")
    for table in sorted(set(TENANT_POLICY_SCOPE_EXCEPTIONS) - actual_names):
        errors.append(f"reviewed policy-scope exception {table} is missing")

    tenant_tables = {item.name: item.ownership for item in facts}
    edges = load_foreign_key_edges(database_url)
    graph = TenantGraph(
        tables=tenant_tables,
        edges=edges,
        transitive=resolve_tenant_bindings(tenant_tables, edges),
    )
    scope = ReviewedScopeFacts(
        policies=load_policies(
            database_url, set(TENANT_POLICY_SCOPE_EXCEPTIONS) | set(delete_gate_relations())
        ),
        acls=load_acls(
            database_url, set(TENANT_POLICY_SCOPE_EXCEPTIONS) | set(NULLABLE_TENANT_EXCEPTIONS)
        ),
    )

    nullable_count = 0
    for item in facts:
        if not item.not_null:
            nullable_count += 1
        errors.extend(tenant_table_errors(item, graph, scope))

    return len(rows), nullable_count, graph


def app_privileges_sql(relation_oid: str) -> str:
    """SQL for the privileges postwave_app holds on a relation, table-level or on any column.

    A column grant counts: it is as direct a path to a partition's rows as a
    table grant, and has_table_privilege() does not see it.
    """

    return f"""COALESCE((
                   SELECT string_agg(privilege.name, ',' ORDER BY privilege.name)
                     FROM (VALUES
                         ('DELETE'), ('INSERT'), ('REFERENCES'), ('SELECT'),
                         ('TRIGGER'), ('TRUNCATE'), ('UPDATE')
                     ) AS privilege(name)
                    WHERE has_table_privilege('postwave_app', {relation_oid}, privilege.name)
                       OR (privilege.name IN ('INSERT', 'REFERENCES', 'SELECT', 'UPDATE')
                           AND has_any_column_privilege('postwave_app', {relation_oid}, privilege.name))
               ), '')"""


def verify_partition_tenant_semantics(database_url: str | Session, errors: list[str]) -> int:
    rows = run_query(
        database_url,
        f"""
        WITH RECURSIVE ancestry(child_oid, ancestor_oid, depth) AS (
            SELECT inherits.inhrelid, inherits.inhparent, 1
              FROM pg_inherits inherits
            UNION ALL
            SELECT ancestry.child_oid, inherits.inhparent, ancestry.depth + 1
              FROM ancestry
              JOIN pg_inherits inherits ON inherits.inhrelid = ancestry.ancestor_oid
        ), roots AS (
            SELECT DISTINCT ON (child_oid) child_oid, ancestor_oid AS root_oid
              FROM ancestry
             ORDER BY child_oid, depth DESC
        ), tenant_children AS (
            SELECT child.oid,
                   child.relname,
                   child.relrowsecurity,
                   child.relforcerowsecurity,
                   child_tenant.attnotnull,
                   root.oid AS root_oid,
                   root.relname AS root_name,
                   root.relrowsecurity AS root_rls,
                   root.relforcerowsecurity AS root_force,
                   root_tenant.attnotnull AS root_not_null
              FROM roots
              JOIN pg_class child ON child.oid = roots.child_oid
              JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
              JOIN pg_attribute child_tenant
                ON child_tenant.attrelid = child.oid
               AND child_tenant.attname = 'tenant_id'
               AND NOT child_tenant.attisdropped
              JOIN pg_class root ON root.oid = roots.root_oid
              JOIN pg_attribute root_tenant
                ON root_tenant.attrelid = root.oid
               AND root_tenant.attname = 'tenant_id'
               AND NOT root_tenant.attisdropped
             WHERE namespace.nspname = 'public'
               AND child.relkind = 'r'
               AND child.relispartition
        )
        SELECT tenant_children.relname,
               tenant_children.root_name,
               tenant_children.relrowsecurity::text,
               tenant_children.relforcerowsecurity::text,
               tenant_children.attnotnull::text,
               tenant_children.root_rls::text,
               tenant_children.root_force::text,
               tenant_children.root_not_null::text,
               {app_privileges_sql("tenant_children.oid")},
               {app_privileges_sql("tenant_children.root_oid")},
               COALESCE((
                   SELECT string_agg(public_grant.privilege, ',' ORDER BY public_grant.privilege)
                     FROM (
                         SELECT table_grant.privilege_type AS privilege
                           FROM aclexplode(COALESCE(
                               (SELECT relacl FROM pg_class WHERE oid = tenant_children.oid),
                               acldefault('r', (SELECT relowner FROM pg_class WHERE oid = tenant_children.oid))
                           )) table_grant
                          WHERE table_grant.grantee = 0
                         UNION ALL
                         SELECT column_grant.privilege_type || '(' || column_meta.attname || ')'
                           FROM pg_attribute column_meta
                          CROSS JOIN LATERAL aclexplode(column_meta.attacl) column_grant
                          WHERE column_meta.attrelid = tenant_children.oid
                            AND column_meta.attnum > 0
                            AND NOT column_meta.attisdropped
                            AND column_meta.attacl IS NOT NULL
                            AND column_grant.grantee = 0
                     ) public_grant
               ), ''),
               (SELECT count(*)::int FROM pg_policy policy WHERE policy.polrelid = tenant_children.oid),
               (SELECT count(*)::int
                  FROM pg_constraint constraint_meta
                 WHERE constraint_meta.conrelid = tenant_children.oid
                   AND constraint_meta.contype = 'f'
                   AND constraint_meta.confrelid = 'public.tenants'::regclass
                   AND constraint_meta.convalidated
                   AND constraint_meta.confdeltype = 'c'
                   AND constraint_meta.conkey = ARRAY[(
                       SELECT tenant_column.attnum
                         FROM pg_attribute tenant_column
                        WHERE tenant_column.attrelid = tenant_children.oid
                          AND tenant_column.attname = 'tenant_id'
                          AND NOT tenant_column.attisdropped
                   )]::smallint[])
          FROM tenant_children
         ORDER BY tenant_children.relname;
        """,
    )
    for row in rows:
        (
            child,
            root,
            child_rls_raw,
            child_force_raw,
            child_not_null_raw,
            root_rls_raw,
            root_force_raw,
            root_not_null_raw,
            child_privilege_raw,
            root_privilege_raw,
            public_privilege_raw,
            child_policy_count_raw,
            child_cascade_count_raw,
        ) = row
        child_rls = parse_bool(child_rls_raw)
        child_force = parse_bool(child_force_raw)
        child_not_null = parse_bool(child_not_null_raw)
        root_rls = parse_bool(root_rls_raw)
        root_force = parse_bool(root_force_raw)
        root_not_null = parse_bool(root_not_null_raw)
        child_privileges = parse_privileges(child_privilege_raw)
        root_privileges = parse_privileges(root_privilege_raw)
        child_policy_count = int(child_policy_count_raw)
        child_cascade_count = int(child_cascade_count_raw)

        expected_root_rls = root not in GLOBAL_TENANT_EXCEPTIONS
        if root_rls != expected_root_rls or root_force != expected_root_rls:
            errors.append(
                f"partition {child} has unsafe root {root}: RLS enabled={root_rls}, forced={root_force}"
            )
        if child_not_null != root_not_null:
            errors.append(f"partition {child}.tenant_id nullability differs from parent {root}")
        if public_privilege_raw:
            errors.append(f"partition {child} grants privileges to PUBLIC: {public_privilege_raw}")
        if not child_privileges.issubset(root_privileges):
            errors.append(
                f"partition {child} grants postwave_app {sorted(child_privileges - root_privileges)} "
                f"beyond parent {root}"
            )
        gate_error = partition_delete_gate_error(child, root, child_privileges)
        if gate_error is not None:
            errors.append(gate_error)
        if child_privileges and expected_root_rls and (
            not child_rls or not child_force or child_policy_count == 0
        ):
            errors.append(
                f"directly granted partition {child} must independently FORCE RLS and retain a policy"
            )
        if child_not_null and child_cascade_count != 1:
            errors.append(
                f"partition {child}.tenant_id must inherit one validated cascading tenant FK "
                f"(found {child_cascade_count})"
            )
    return len(rows)


class NegativeCase(NamedTuple):
    """One forbidden catalog change, and what the verifier must say about it.

    prelude runs inside the catalog query's transaction, which is rolled back.
    Every fragment in expected must appear in some error the verifier reports
    against the changed catalog.
    """

    change: str
    prelude: str
    expected: tuple[str, ...]


NEGATIVE_PARTITION_PARENT = "audit_log"


def redefine_constraint_sql(
    table: str, constraint: str, replacements: tuple[tuple[str, str], ...], suffix: str
) -> str:
    """A DO block that drops a real constraint and re-adds it, edited, under its own name.

    The ledger and the registers find constraints by name, so a weakened
    constraint must keep the name of the one it replaces. Each (old, new)
    pair is applied to pg_get_constraintdef's text, which must contain old;
    suffix is appended to the result (" NOT VALID", say).
    """

    edits = "definition"
    for old, new in replacements:
        edits = f"pg_catalog.replace({edits}, {sql_literal(old)}, {sql_literal(new)})"
    guards = " OR ".join(f"strpos(definition, {sql_literal(old)}) = 0" for old, _ in replacements) or "false"
    return f"""DO $lint_negative$
DECLARE definition text;
BEGIN
    SELECT pg_catalog.pg_get_constraintdef(oid) INTO STRICT definition
      FROM pg_catalog.pg_constraint
     WHERE conrelid = {sql_literal('public.' + table)}::regclass AND conname = {sql_literal(constraint)};
    IF {guards} THEN
        RAISE EXCEPTION 'negative self-test: % no longer has the definition this case edits: %',
            {sql_literal(constraint)}, definition;
    END IF;
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', {sql_literal(table)}, {sql_literal(constraint)});
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I ', {sql_literal(table)}, {sql_literal(constraint)})
        || {edits} || {sql_literal(suffix)};
END
$lint_negative$"""


def drop_policies_sql(table: str, then: str) -> str:
    """A DO block that drops every policy on a table, then runs then (if any).

    It raises if the table has no policy to drop, so a case whose table lost its
    policies some other way fails instead of proving nothing.
    """

    follow_up = f"\n    EXECUTE {sql_literal(then)};" if then else ""
    return f"""DO $lint_negative$
DECLARE
    policy_name name;
    dropped int := 0;
BEGIN
    FOR policy_name IN
        SELECT polname FROM pg_catalog.pg_policy
         WHERE polrelid = {sql_literal('public.' + table)}::regclass
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', policy_name, {sql_literal(table)});
        dropped := dropped + 1;
    END LOOP;
    IF dropped = 0 THEN
        RAISE EXCEPTION 'negative self-test: % has no policy to drop', {sql_literal(table)};
    END IF;{follow_up}
END
$lint_negative$"""


def negative_cases(partition: str) -> list[NegativeCase]:
    """The forbidden changes the verifier's catalog queries must each catch.

    One case per query path that a lenient edit could silently switch off:
    the column part and the grant options of the exact ACL (register tables,
    a new grantee, the referral definer), the effective table privileges,
    PUBLIC column grants on an ordinary table, the policy loader (a reviewed
    scope policy and a delete gate), the nullable contract's comment and FK
    action, both FK counts behind a parent binding, the validation, delete
    action and NOT NULL facts load_foreign_key_edges reads for a binding FK,
    and the partition query's delete gate, column grants and PUBLIC grants.
    The main scan's own facts have cases too: tenant_id's NOT NULL, the
    validation and delete action of a direct tenant FK (cascade and set
    null), RLS enabled and forced, and the policy count and the app.tenant_id
    predicate count. partition names an audit_log partition with no grant and
    no RLS.
    """

    findings_binding = "campaign_assurance_findings_target_fk"
    return [
        NegativeCase(
            "a column UPDATE grant to postwave_app on a worker-capability table",
            "GRANT UPDATE (tenant_id) ON public.deliverability_degradation_claims TO postwave_app",
            (
                "deliverability_degradation_claims grants postwave_app ['UPDATE'] on column tenant_id; "
                "the reviewed ACL grants []",
            ),
        ),
        NegativeCase(
            "a column UPDATE grant to postwave_app on the immutable raw-output write receipts",
            "GRANT UPDATE (tenant_id) ON public.campaign_assurance_raw_output_write_receipts TO postwave_app",
            (
                "campaign_assurance_raw_output_write_receipts grants postwave_app ['UPDATE'] on column "
                "tenant_id; the reviewed ACL grants []",
            ),
        ),
        NegativeCase(
            "SELECT WITH GRANT OPTION, which would let postwave_app re-grant SELECT",
            "GRANT SELECT ON public.campaign_assurance_raw_output_cleanup_receipts TO postwave_app "
            "WITH GRANT OPTION",
            (
                "campaign_assurance_raw_output_cleanup_receipts grants postwave_app "
                "['INSERT', 'SELECT WITH GRANT OPTION'] on the table; the reviewed ACL grants "
                "['INSERT', 'SELECT']",
            ),
        ),
        NegativeCase(
            "TRUNCATE and a column UPDATE for the referral registry definer",
            "GRANT TRUNCATE ON public.referral_code_tokens TO postwave_referral_code_definer; "
            "GRANT UPDATE (tenant_id) ON public.referral_code_tokens TO postwave_referral_code_definer",
            (
                "referral_code_tokens grants postwave_referral_code_definer ['DELETE', 'TRUNCATE'] on the "
                "table; the reviewed ACL grants ['DELETE']",
                "referral_code_tokens grants postwave_referral_code_definer ['INSERT', 'SELECT', 'UPDATE'] "
                "on column tenant_id; the reviewed ACL grants ['INSERT', 'SELECT']",
            ),
        ),
        NegativeCase(
            "an UPDATE grant on a DSA notice's evidence column",
            "GRANT UPDATE (actual_knowledge_at) ON public.content_reports TO postwave_app",
            (
                "content_reports grants postwave_app ['UPDATE'] on column actual_knowledge_at; "
                "the reviewed ACL grants []",
            ),
        ),
        NegativeCase(
            "a table-level UPDATE grant on content_reports",
            "GRANT UPDATE ON public.content_reports TO postwave_app",
            (
                "content_reports postwave_app privileges are ['INSERT', 'SELECT', 'UPDATE']; "
                "expected ['INSERT', 'SELECT']",
                "content_reports grants postwave_app ['INSERT', 'SELECT', 'UPDATE'] on the table; "
                "the reviewed ACL grants ['INSERT', 'SELECT']",
            ),
        ),
        NegativeCase(
            "a column grant to a role outside a nullable exception's reviewed ACL",
            "GRANT SELECT (notifier_email) ON public.content_reports TO postwave_ops",
            (
                "content_reports grants postwave_ops ['SELECT'] on column notifier_email; "
                "the reviewed ACL grants []",
            ),
        ),
        NegativeCase(
            "a PUBLIC column grant on an ordinary tenant table",
            "GRANT SELECT (tenant_id) ON public.campaign_assurance_findings TO PUBLIC",
            ("campaign_assurance_findings grants privileges to PUBLIC: SELECT(tenant_id)",),
        ),
        NegativeCase(
            "a PUBLIC read policy on a worker-capability table",
            "CREATE POLICY lint_negative_public_read ON public.campaign_assurance_raw_output_write_receipts "
            "FOR SELECT TO PUBLIC USING (true)",
            (
                "campaign_assurance_raw_output_write_receipts policy lint_negative_public_read is not part "
                "of its reviewed policy-scope exception",
            ),
        ),
        NegativeCase(
            "a widened predicate on a reviewed worker policy",
            "ALTER POLICY deliverability_degradation_worker_all ON public.deliverability_degradation_claims "
            "USING (true)",
            (
                "deliverability_degradation_claims policy deliverability_degradation_worker_all differs "
                "from its reviewed definition",
            ),
        ),
        NegativeCase(
            "a direct tenant_id FK to tenants on a parent-bound table",
            "ALTER TABLE public.campaign_assurance_findings ADD CONSTRAINT lint_negative_tenant_fkey "
            "FOREIGN KEY (tenant_id) REFERENCES public.tenants (id) ON DELETE CASCADE NOT VALID",
            (
                f"campaign_assurance_findings must be bound to its tenant only through {findings_binding}, "
                "but it has 1 direct FK(s) to tenants(id);",
            ),
        ),
        NegativeCase(
            "an FK to tenants from another column of a parent-bound table",
            "ALTER TABLE public.campaign_assurance_findings ADD COLUMN lint_negative_owner uuid; "
            "ALTER TABLE public.campaign_assurance_findings ADD CONSTRAINT lint_negative_owner_fkey "
            "FOREIGN KEY (lint_negative_owner) REFERENCES public.tenants (id) ON DELETE CASCADE",
            (
                f"campaign_assurance_findings must be bound to its tenant only through {findings_binding}, "
                "but it has 1 direct FK(s) to tenants(id) (1 on columns other than tenant_id)",
                "campaign_assurance_findings.tenant_id must have exactly one validated ON DELETE CASCADE FK "
                "to tenants(id) (found 0 tenant FK, 0 validated cascade); it cannot be bound through a "
                "parent either, because it has 1 FK(s) to tenants(id) on columns other than tenant_id",
            ),
        ),
        NegativeCase(
            "a parent binding FK that is not validated",
            redefine_constraint_sql("campaign_assurance_findings", findings_binding, (), " NOT VALID"),
            (
                f"transitive tenant binding {findings_binding} on campaign_assurance_findings is not validated",
                "campaign_assurance_findings.tenant_id must have exactly one validated ON DELETE CASCADE FK "
                "to tenants(id) (found 0 tenant FK, 0 validated cascade) or a transitive binding through a "
                "tenant-bound parent",
            ),
        ),
        NegativeCase(
            "a parent binding FK that no longer cascades",
            redefine_constraint_sql(
                "campaign_assurance_findings",
                findings_binding,
                (("ON DELETE CASCADE", "ON DELETE RESTRICT"),),
                "",
            ),
            (
                f"transitive tenant binding {findings_binding} on campaign_assurance_findings "
                "is not ON DELETE CASCADE",
            ),
        ),
        NegativeCase(
            "a nullable column in a parent binding FK",
            "ALTER TABLE public.campaign_assurance_findings ALTER COLUMN run_id DROP NOT NULL",
            (
                f"transitive tenant binding {findings_binding} on campaign_assurance_findings has "
                "nullable column(s) run_id, so MATCH SIMPLE does not check every row",
            ),
        ),
        NegativeCase(
            "a widened delete gate on the audit log",
            "ALTER POLICY audit_log_trim_worker_only ON public.audit_log USING (true)",
            (
                "audit_log delete gate audit_log_trim_worker_only on audit_log differs from its reviewed "
                "definition",
            ),
        ),
        NegativeCase(
            "a nullable exception comment that no longer names its reviewed category",
            "COMMENT ON COLUMN public.content_reports.tenant_id IS "
            "'postwave:tenant-scope-exception=unresolved-public-ingest'",
            ("content_reports.tenant_id is missing its exact reviewed exception comment",),
        ),
        NegativeCase(
            "a DSA notice's tenant FK that cascades instead of setting NULL",
            redefine_constraint_sql(
                "content_reports",
                "content_reports_tenant_id_fkey",
                (("ON DELETE SET NULL", "ON DELETE CASCADE"),),
                "",
            ),
            (
                "content_reports.tenant_id must have exactly one validated ON DELETE SET NULL FK to "
                "tenants(id)",
            ),
        ),
        NegativeCase(
            "a NOT VALID tenant FK on a DSA notice",
            redefine_constraint_sql("content_reports", "content_reports_tenant_id_fkey", (), " NOT VALID"),
            (
                "content_reports.tenant_id must have exactly one validated ON DELETE SET NULL FK to "
                "tenants(id)",
            ),
        ),
        NegativeCase(
            "a direct tenant FK that no longer cascades",
            redefine_constraint_sql(
                "campaigns",
                "campaigns_tenant_id_fkey",
                (("ON DELETE CASCADE", "ON DELETE RESTRICT"),),
                "",
            ),
            (
                "campaigns.tenant_id must have exactly one validated ON DELETE CASCADE FK to tenants(id) "
                "(found 1 tenant FK, 0 validated cascade)",
            ),
        ),
        NegativeCase(
            "a direct tenant FK that is not validated",
            redefine_constraint_sql("campaigns", "campaigns_tenant_id_fkey", (), " NOT VALID"),
            (
                "campaigns.tenant_id must have exactly one validated ON DELETE CASCADE FK to tenants(id) "
                "(found 1 tenant FK, 0 validated cascade)",
            ),
        ),
        NegativeCase(
            "a nullable tenant_id outside the nullable exception register",
            "ALTER TABLE public.campaigns ALTER COLUMN tenant_id DROP NOT NULL",
            ("campaigns.tenant_id is nullable without an exact reviewed exception",),
        ),
        NegativeCase(
            "row-level security no longer forced on an ordinary tenant table",
            "ALTER TABLE public.campaigns NO FORCE ROW LEVEL SECURITY",
            (
                "campaigns RLS state is enabled=True, forced=False; expected enabled=True, forced=True",
            ),
        ),
        NegativeCase(
            "row-level security disabled on an ordinary tenant table",
            "ALTER TABLE public.campaigns DISABLE ROW LEVEL SECURITY",
            (
                "campaigns RLS state is enabled=False, forced=True; expected enabled=True, forced=True",
            ),
        ),
        NegativeCase(
            "an ordinary tenant table whose policies no longer read app.tenant_id",
            drop_policies_sql(
                "campaign_recipients",
                "CREATE POLICY lint_negative_unbound ON public.campaign_recipients "
                "USING (true) WITH CHECK (true)",
            ),
            ("campaign_recipients has no policy predicate bound to app.tenant_id",),
        ),
        NegativeCase(
            "an ordinary tenant table with row-level security and no policy",
            drop_policies_sql("campaign_recipients", ""),
            (
                "campaign_recipients enables RLS but has no policies",
                "campaign_recipients has no policy predicate bound to app.tenant_id",
            ),
        ),
        NegativeCase(
            "a direct DELETE grant on an audit partition, without its delete gate",
            f"GRANT DELETE ON public.{partition} TO postwave_app",
            (
                f"partition {partition} grants postwave_app DELETE directly but has no reviewed delete gate",
                f"directly granted partition {partition} must independently FORCE RLS and retain a policy",
            ),
        ),
        NegativeCase(
            "a column SELECT grant on an audit partition without RLS",
            f"GRANT SELECT (tenant_id) ON public.{partition} TO postwave_app",
            (f"directly granted partition {partition} must independently FORCE RLS and retain a policy",),
        ),
        NegativeCase(
            "a PUBLIC column grant on an audit partition",
            f"GRANT SELECT (tenant_id) ON public.{partition} TO PUBLIC",
            (f"partition {partition} grants privileges to PUBLIC: SELECT(tenant_id)",),
        ),
    ]


def negative_case_problems(case: NegativeCase, errors: list[str]) -> list[str]:
    """What the verifier failed to say about one forbidden change."""

    return [
        f"negative self-test: the verifier accepted {case.change}; no error contained {fragment!r}"
        for fragment in case.expected
        if not any(fragment in error for error in errors)
    ]


def negative_test_partition(database_url: str) -> str:
    """An audit_log partition postwave_app cannot reach and that has no RLS of its own."""

    rows = run_query(
        database_url,
        f"""
        SELECT child.relname
          FROM pg_inherits inherits
          JOIN pg_class child ON child.oid = inherits.inhrelid
         WHERE inherits.inhparent = {sql_literal('public.' + NEGATIVE_PARTITION_PARENT)}::regclass
           AND child.relkind = 'r'
           AND NOT child.relrowsecurity
           AND NOT has_table_privilege('postwave_app', child.oid, 'SELECT')
           AND NOT has_any_column_privilege('postwave_app', child.oid, 'SELECT')
         ORDER BY child.relname
         LIMIT 1;
        """,
    )
    if not rows:
        raise RuntimeError(
            f"negative self-test needs a {NEGATIVE_PARTITION_PARENT} partition with no grant and no RLS; "
            "found none"
        )
    return rows[0][0]


def run_negative_self_test(
    database_url: str, transitive_fk_checks: list[dict[str, Any]]
) -> tuple[int, list[str]]:
    """Apply each forbidden change in a rolled-back transaction and require the verifier to reject it.

    The positive run proves the verifier accepts the reviewed schema; this
    proves its catalog queries still see each kind of widening, so a query
    edited into leniency fails CI instead of passing it. Each change needs a
    role that may alter the reviewed tables (CI connects as a superuser), and
    each takes its locks for one short transaction, bounded by lock_timeout.
    """

    cases = negative_cases(negative_test_partition(database_url))
    problems: list[str] = []
    for case in cases:
        session = Session(database_url, case.prelude)
        errors: list[str] = []
        _, _, graph = verify_complete_tenant_tables(session, errors)
        verify_transitive_fks(transitive_fk_checks, graph, errors)
        verify_partition_tenant_semantics(session, errors)
        problems.extend(negative_case_problems(case, errors))
    return len(cases), problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL", ""))
    parser.add_argument(
        "--no-negative-self-test",
        action="store_true",
        help=(
            "skip the negative self-test, which applies forbidden catalog changes in rolled-back "
            "transactions; use it only for a read-only check of a shared database, never in CI"
        ),
    )
    args = parser.parse_args()
    root = args.root.resolve()
    baseline_path = (args.baseline or root / "scripts/lint-migrations-baseline.json").resolve()
    if not args.database_url:
        print("ERROR: DATABASE_URL or --database-url is required", file=sys.stderr)
        return 2
    if not shutil.which("psql"):
        print("ERROR: psql is required for effective-schema verification", file=sys.stderr)
        return 2
    linter = load_linter(root)
    complete_table_count = 0
    nullable_exception_count = 0
    tenant_partition_count = 0
    tenant_policy_expression_count = 0
    try:
        ledger, _ = linter.validate_baseline(root, baseline_path)
        errors: list[str] = []
        verifications = {
            tuple(sorted(entry["verification"].items())): entry["verification"]
            for entry in ledger["findings"]
        }.values()
        supported_kinds = {
            "index_valid",
            "index_valid_on_legacy_table",
            "partition_parent_index_valid",
            "replacement_index_valid",
            "rls_state",
            "permissive_policy",
            "tenant_policy_bound",
            "tenant_fk_cascade",
            "tenant_fk_cascade_for_table",
            "tenant_fk_transitive_cascade",
            "policy_scope_exception",
        }
        unknown_kinds = sorted(
            {verification["kind"] for verification in verifications} - supported_kinds
        )
        if unknown_kinds:
            raise RuntimeError(
                "unsupported migration ledger verification kind(s): "
                + ", ".join(unknown_kinds)
            )
        index_checks = [
            v
            for v in verifications
            if v["kind"]
            in {
                "index_valid",
                "index_valid_on_legacy_table",
                "partition_parent_index_valid",
                "replacement_index_valid",
            }
        ]
        partition_checks = [v for v in index_checks if v["kind"] == "partition_parent_index_valid"]
        rls_checks = [v for v in verifications if v["kind"] == "rls_state"]
        policy_checks = [v for v in verifications if v["kind"] == "permissive_policy"]
        tenant_policy_checks = [v for v in verifications if v["kind"] == "tenant_policy_bound"]
        fk_checks = [v for v in verifications if v["kind"] == "tenant_fk_cascade"]
        table_fk_checks = [
            v for v in verifications if v["kind"] == "tenant_fk_cascade_for_table"
        ]
        transitive_fk_checks = [
            v for v in verifications if v["kind"] == "tenant_fk_transitive_cascade"
        ]
        policy_scope_checks = [
            v for v in verifications if v["kind"] == "policy_scope_exception"
        ]
        verify_checksums(args.database_url, root, ledger, errors)
        verify_indexes(args.database_url, index_checks, errors)
        verify_partition_indexes(args.database_url, partition_checks, errors)
        verify_rls(args.database_url, rls_checks, errors)
        verify_policies(args.database_url, policy_checks, errors)
        verify_tenant_bound_policies(args.database_url, tenant_policy_checks, errors)
        tenant_policy_expression_count = verify_null_safe_tenant_policies(
            args.database_url, errors
        )
        verify_fks(args.database_url, fk_checks, errors)
        verify_table_fks(args.database_url, table_fk_checks, errors)
        (
            complete_table_count,
            nullable_exception_count,
            tenant_graph,
        ) = verify_complete_tenant_tables(args.database_url, errors)
        verify_transitive_fks(transitive_fk_checks, tenant_graph, errors)
        for check in policy_scope_checks:
            errors.extend(policy_scope_check_errors(check, tenant_graph))
        tenant_partition_count = verify_partition_tenant_semantics(args.database_url, errors)
    except Exception as exc:  # fail closed on psql, ledger, or parsing errors
        print(f"ERROR: effective migration schema verification failed: {exc}", file=sys.stderr)
        return 2
    if errors:
        print("FAIL: effective migration schema does not satisfy the reviewed ledger:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    if args.no_negative_self_test:
        negative_summary = "negative self-test SKIPPED (--no-negative-self-test)"
    else:
        try:
            negative_count, negative_problems = run_negative_self_test(
                args.database_url, transitive_fk_checks
            )
        except Exception as exc:  # a change that cannot be applied proves nothing
            print(f"ERROR: effective-schema negative self-test failed: {exc}", file=sys.stderr)
            return 2
        if negative_problems:
            print(
                "FAIL: the effective-schema verifier accepted a forbidden catalog change:",
                file=sys.stderr,
            )
            for problem in negative_problems:
                print(f"  - {problem}", file=sys.stderr)
            return 1
        negative_summary = (
            f"negative self-test: all {negative_count} forbidden catalog changes rejected, "
            "each in a rolled-back transaction"
        )
    print(
        f"OK: effective schema satisfies {ledger['expected_findings']} reviewed migration-lint dispositions "
        f"({len(index_checks)} indexes, {len(rls_checks)} RLS states, "
        f"{len(policy_checks)} exact policies, {len(tenant_policy_checks)} tenant-bound policy tables, "
        f"{len(fk_checks)} named tenant FK, {len(table_fk_checks)} table tenant FK, "
        f"{len(transitive_fk_checks)} parent-bound tenant FK, "
        f"{len(policy_scope_checks)} policy-scope exception) "
        f"with 0 unsafe casts across {tenant_policy_expression_count} tenant-policy expressions "
        "and complete tenant-schema invariants "
        f"({complete_table_count} logical tables, {len(tenant_graph.transitive)} bound through a parent, "
        f"{nullable_exception_count} reviewed nullable exceptions, "
        f"{len(TENANT_POLICY_SCOPE_EXCEPTIONS)} reviewed policy-scope exceptions, "
        f"{tenant_partition_count} partitions); {negative_summary}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
