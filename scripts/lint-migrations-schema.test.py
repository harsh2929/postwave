#!/usr/bin/env python3
"""Database-free self-tests for the tenant rules in lint-migrations-schema.py.

The effective-schema verifier reads pg_catalog through psql. Its decisions are
pure functions over the facts it loads: tenant ownership (direct or through a
parent), the reviewed nullable tenant_id contracts with their exact ACLs and
delete gates, and the reviewed policy-scope exceptions. These tests feed them
synthetic catalog facts shaped like the real schema and check both directions:
exact shapes are accepted, and each weakened shape is rejected. They also tie
the registers and the ledger to the migrations that create the reviewed state
(2046, 2047) with literal expectations.

The catalog queries themselves are tested against a database, not here: CI's
Go job runs scripts/lint-migrations-schema.py on a database migrated to head,
and after its positive pass the script's negative self-test applies each
forbidden change in negative_cases() inside a rolled-back transaction and
requires the matching error. NegativeSelfTest below checks that harness and
keeps its expected messages in step with the rules. scripts/lint-migrations.test.sh
runs this file in the database-free migration-lint job.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_SPEC = importlib.util.spec_from_file_location(
    "postwave_lint_migrations_schema", ROOT / "scripts/lint-migrations-schema.py"
)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError("cannot load scripts/lint-migrations-schema.py")
schema = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(schema)

# Fewer tests than this means a test was renamed away or skipped. Fail rather
# than report a smaller suite as a pass.
MINIMUM_TESTS = 66


def table(
    name: str, *, not_null: bool = True, direct: int = 0, cascade: int | None = None, other: int = 0
):
    """Ownership facts; direct counts (tenant_id) -> tenants(id) FKs, other every other tenants FK."""

    return schema.TenantTable(
        name=name,
        not_null=not_null,
        tenant_fk_count=direct,
        cascade_count=direct if cascade is None else cascade,
        other_tenant_fk_count=other,
    )


def edge(
    child: str,
    constraint: str,
    parent: str,
    columns: list[tuple[str, bool, str]],
    *,
    validated: bool = True,
    action: str = "c",
):
    return schema.ForeignKeyEdge(
        table=child,
        constraint=constraint,
        parent=parent,
        validated=validated,
        delete_action=action,
        columns=tuple(columns),
    )


def run_key(run_column: str = "run_id") -> list[tuple[str, bool, str]]:
    """The (tenant_id, run_id) -> parent (tenant_id, id) shape of the assurance tables."""

    return [("tenant_id", True, "tenant_id"), (run_column, True, "id")]


def build_graph(tables, edges):
    by_name = {item.name: item for item in tables}
    edges = tuple(edges)
    return schema.TenantGraph(
        tables=by_name,
        edges=edges,
        transitive=schema.resolve_tenant_bindings(by_name, edges),
    )


ROOT_RUNS = table("runs", direct=1)


class AcceptedBindings(unittest.TestCase):
    def test_direct_cascading_tenant_fk_binds(self):
        graph = build_graph([ROOT_RUNS], [])
        self.assertIsNone(schema.tenant_ownership_error(ROOT_RUNS, graph))
        self.assertEqual(graph.transitive, {})

    def test_composite_fk_into_a_directly_bound_parent_binds(self):
        child = table("run_artifacts")
        graph = build_graph(
            [ROOT_RUNS, child],
            [edge("run_artifacts", "run_artifacts_run_fk", "runs", run_key())],
        )
        self.assertEqual(graph.transitive, {"run_artifacts": ("run_artifacts_run_fk",)})
        self.assertIsNone(schema.tenant_ownership_error(child, graph))

    def test_binding_is_recursive_regardless_of_edge_order(self):
        # The grandchild's edge is listed before its parent's, so a single pass
        # would miss it; the fixed point must not.
        artifacts = table("run_artifacts")
        targets = table("run_targets")
        extractions = table("extractions")
        graph = build_graph(
            [extractions, targets, artifacts, ROOT_RUNS],
            [
                edge(
                    "extractions",
                    "extractions_target_fk",
                    "run_targets",
                    [("tenant_id", True, "tenant_id"), ("target_id", True, "id")],
                ),
                edge(
                    "run_targets",
                    "run_targets_artifact_fk",
                    "run_artifacts",
                    [("tenant_id", True, "tenant_id"), ("artifact_id", True, "id")],
                ),
                edge("run_artifacts", "run_artifacts_run_fk", "runs", run_key()),
            ],
        )
        self.assertEqual(
            set(graph.transitive), {"extractions", "run_targets", "run_artifacts"}
        )
        for item in (artifacts, targets, extractions):
            self.assertIsNone(schema.tenant_ownership_error(item, graph))

    def test_every_qualifying_parent_fk_is_recorded(self):
        configurations = table("run_configurations")
        artifacts = table("run_artifacts")
        targets = table("run_targets")
        graph = build_graph(
            [ROOT_RUNS, configurations, artifacts, targets],
            [
                edge("run_artifacts", "run_artifacts_run_fk", "runs", run_key()),
                edge(
                    "run_configurations",
                    "run_configurations_run_fk",
                    "runs",
                    run_key(),
                ),
                edge(
                    "run_targets",
                    "run_targets_artifact_fk",
                    "run_artifacts",
                    [("tenant_id", True, "tenant_id"), ("artifact_id", True, "id")],
                ),
                edge(
                    "run_targets",
                    "run_targets_configuration_fk",
                    "run_configurations",
                    [("tenant_id", True, "tenant_id"), ("configuration_id", True, "id")],
                ),
            ],
        )
        self.assertEqual(
            graph.transitive["run_targets"],
            ("run_targets_artifact_fk", "run_targets_configuration_fk"),
        )

    def test_tenant_column_may_sit_anywhere_in_the_key(self):
        child = table("run_events")
        graph = build_graph(
            [ROOT_RUNS, child],
            [
                edge(
                    "run_events",
                    "run_events_run_fk",
                    "runs",
                    [("run_id", True, "id"), ("campaign_id", True, "campaign_id"), ("tenant_id", True, "tenant_id")],
                )
            ],
        )
        self.assertIn("run_events", graph.transitive)

    def test_direct_table_with_a_parent_path_is_judged_by_the_direct_rule(self):
        # Pre-existing tables such as campaign_assurance_runs carry both a
        # direct FK and a composite FK into campaigns. They are accepted as
        # directly bound and never listed as transitive.
        campaigns = table("campaigns", direct=1)
        runs = table("runs", direct=1)
        graph = build_graph(
            [campaigns, runs],
            [
                edge(
                    "runs",
                    "runs_campaign_fk",
                    "campaigns",
                    [("tenant_id", True, "tenant_id"), ("campaign_id", True, "id")],
                )
            ],
        )
        self.assertIsNone(schema.tenant_ownership_error(runs, graph))
        self.assertNotIn("runs", graph.transitive)

    def test_catalog_row_parses_into_an_edge(self):
        row = [
            "campaign_send_delivery_events",
            "campaign_send_delivery_events_delivery_fk",
            "campaign_send_deliveries",
            "true",
            "c",
            json.dumps(
                [
                    ["tenant_id", True, "tenant_id"],
                    ["campaign_id", True, "campaign_id"],
                    ["delivery_id", True, "id"],
                ]
            ),
        ]
        parsed = schema.parse_foreign_key_edge(row)
        self.assertEqual(
            parsed,
            edge(
                "campaign_send_delivery_events",
                "campaign_send_delivery_events_delivery_fk",
                "campaign_send_deliveries",
                [
                    ("tenant_id", True, "tenant_id"),
                    ("campaign_id", True, "campaign_id"),
                    ("delivery_id", True, "id"),
                ],
            ),
        )
        row[3] = "false"
        self.assertFalse(schema.parse_foreign_key_edge(row).validated)

    def test_referral_token_binding_from_migration_2047_binds(self):
        # (tenant_id, referral_code_id) -> referral_codes (tenant_id, id): the
        # key order differs from the parent's column order, and both columns
        # are NOT NULL.
        codes = table("referral_codes", direct=1)
        tokens = table("referral_code_tokens")
        graph = build_graph(
            [codes, tokens],
            [
                edge(
                    "referral_code_tokens",
                    "referral_code_tokens_referral_code_tenant_fkey",
                    "referral_codes",
                    [("tenant_id", True, "tenant_id"), ("referral_code_id", True, "id")],
                )
            ],
        )
        self.assertEqual(
            graph.transitive,
            {"referral_code_tokens": ("referral_code_tokens_referral_code_tenant_fkey",)},
        )
        self.assertIsNone(schema.tenant_ownership_error(tokens, graph))

    def test_reviewed_parent_binding_passes(self):
        child = table("progress_events")
        graph = build_graph(
            [ROOT_RUNS, child],
            [edge("progress_events", "progress_events_run_fk", "runs", run_key())],
        )
        check = {
            "kind": "tenant_fk_transitive_cascade",
            "table": "progress_events",
            "constraint": "progress_events_run_fk",
            "parent": "runs",
        }
        self.assertEqual(schema.transitive_fk_check_errors(check, graph), [])


class RejectedBindings(unittest.TestCase):
    def assert_unbound(self, child, tables, edges, expected_fragment: str):
        graph = build_graph(tables, edges)
        self.assertNotIn(child.name, graph.transitive)
        error = schema.tenant_ownership_error(child, graph)
        self.assertIsNotNone(error)
        self.assertIn("must have exactly one validated ON DELETE CASCADE FK to tenants(id)", error)
        self.assertIn(expected_fragment, error)
        return error

    def test_table_with_no_ownership_edge_is_rejected(self):
        orphan = table("chat_log")
        error = self.assert_unbound(orphan, [orphan], [], "candidate FKs: none")
        self.assertIn("found 0 tenant FK, 0 validated cascade", error)

    def test_fk_that_leaves_tenant_id_out_of_the_key_is_rejected(self):
        # referral_code_tokens before migration 2047: bound to a parent by id
        # alone, so its own tenant_id is never compared with anything.
        codes = table("referral_codes", direct=1)
        tokens = table("referral_code_tokens")
        self.assert_unbound(
            tokens,
            [codes, tokens],
            [
                edge(
                    "referral_code_tokens",
                    "referral_code_tokens_referral_code_id_fkey",
                    "referral_codes",
                    [("referral_code_id", True, "id")],
                )
            ],
            "does not map tenant_id onto referral_codes.tenant_id",
        )

    def test_tenant_id_mapped_onto_another_parent_column_is_rejected(self):
        child = table("run_artifacts")
        self.assert_unbound(
            child,
            [ROOT_RUNS, child],
            [
                edge(
                    "run_artifacts",
                    "run_artifacts_run_fk",
                    "runs",
                    [("tenant_id", True, "id"), ("run_id", True, "tenant_id")],
                )
            ],
            "does not map tenant_id onto runs.tenant_id",
        )

    def test_nullable_fk_column_is_rejected(self):
        child = table("findings")
        self.assert_unbound(
            child,
            [ROOT_RUNS, child],
            [
                edge(
                    "findings",
                    "findings_extraction_fk",
                    "runs",
                    [("tenant_id", True, "tenant_id"), ("extraction_id", False, "id")],
                )
            ],
            "has nullable column(s) extraction_id",
        )

    def test_nullable_tenant_id_is_never_bound_through_a_parent(self):
        child = table("shared_templates", not_null=False)
        graph = build_graph(
            [ROOT_RUNS, child],
            [edge("shared_templates", "shared_templates_run_fk", "runs", run_key())],
        )
        self.assertNotIn("shared_templates", graph.transitive)

    def test_unvalidated_fk_is_rejected(self):
        child = table("run_artifacts")
        self.assert_unbound(
            child,
            [ROOT_RUNS, child],
            [
                edge(
                    "run_artifacts",
                    "run_artifacts_run_fk",
                    "runs",
                    run_key(),
                    validated=False,
                )
            ],
            "run_artifacts_run_fk is not validated",
        )

    def test_non_cascading_fk_is_rejected(self):
        child = table("run_artifacts")
        for action in ("a", "r", "n", "d"):
            with self.subTest(confdeltype=action):
                self.assert_unbound(
                    child,
                    [ROOT_RUNS, child],
                    [
                        edge(
                            "run_artifacts",
                            "run_artifacts_run_fk",
                            "runs",
                            run_key(),
                            action=action,
                        )
                    ],
                    "is not ON DELETE CASCADE",
                )

    def test_parent_without_its_own_binding_is_rejected(self):
        parent = table("runs")  # no tenant FK and no parent of its own
        child = table("run_artifacts")
        self.assert_unbound(
            child,
            [parent, child],
            [edge("run_artifacts", "run_artifacts_run_fk", "runs", run_key())],
            "references runs, which is not bound to tenants",
        )

    def test_parent_with_a_broken_direct_fk_does_not_bind_children(self):
        parent = table("runs", direct=1, cascade=0)
        child = table("run_artifacts")
        self.assert_unbound(
            child,
            [parent, child],
            [edge("run_artifacts", "run_artifacts_run_fk", "runs", run_key())],
            "which is not bound to tenants",
        )

    def test_nullable_parent_does_not_bind_children(self):
        # A nullable-tenant parent lives under the reviewed nullable exception
        # contract, not the ownership invariant, so it cannot anchor a chain.
        parent = table("templates", not_null=False, direct=1)
        child = table("template_versions")
        self.assert_unbound(
            child,
            [parent, child],
            [
                edge(
                    "template_versions",
                    "template_versions_template_fk",
                    "templates",
                    [("tenant_id", True, "tenant_id"), ("template_id", True, "id")],
                )
            ],
            "references templates, which is not bound to tenants",
        )

    def test_cycle_without_a_directly_bound_member_binds_nothing(self):
        left = table("left_evidence")
        right = table("right_evidence")
        graph = build_graph(
            [left, right],
            [
                edge("left_evidence", "left_right_fk", "right_evidence", run_key("right_id")),
                edge("right_evidence", "right_left_fk", "left_evidence", run_key("left_id")),
            ],
        )
        self.assertEqual(graph.transitive, {})
        self.assertIsNotNone(schema.tenant_ownership_error(left, graph))
        self.assertIsNotNone(schema.tenant_ownership_error(right, graph))

    def test_self_reference_does_not_bind(self):
        # campaign_assurance_extractions_reused_source_fk points at its own table.
        child = table("extractions")
        self.assert_unbound(
            child,
            [child],
            [edge("extractions", "extractions_reused_source_fk", "extractions", run_key())],
            "is self-referential",
        )

    def test_broken_direct_fk_is_not_rescued_by_a_parent_binding(self):
        child = table("run_artifacts", direct=1, cascade=0)
        graph = build_graph(
            [ROOT_RUNS, child],
            [edge("run_artifacts", "run_artifacts_run_fk", "runs", run_key())],
        )
        self.assertNotIn("run_artifacts", graph.transitive)
        self.assertEqual(
            schema.tenant_ownership_error(child, graph),
            "run_artifacts.tenant_id must have exactly one validated ON DELETE CASCADE FK to "
            "tenants(id) (found 1 tenant FK, 0 validated cascade)",
        )

    def test_two_direct_fks_are_rejected(self):
        child = table("run_artifacts", direct=2)
        graph = build_graph([ROOT_RUNS, child], [])
        self.assertIn("found 2 tenant FK", schema.tenant_ownership_error(child, graph))

    def test_reviewed_table_that_regains_a_direct_fk_is_rejected(self):
        # The migration 2045 hazard: the parent binding is intact, but a direct
        # FK puts the rows on the same cascade level as their root.
        child = table("progress_events", direct=1)
        graph = build_graph(
            [ROOT_RUNS, child],
            [edge("progress_events", "progress_events_run_fk", "runs", run_key())],
        )
        # The complete-schema scan alone would accept this table...
        self.assertIsNone(schema.tenant_ownership_error(child, graph))
        # ...so the reviewed per-table verification is what rejects it.
        errors = schema.transitive_fk_check_errors(
            {
                "kind": "tenant_fk_transitive_cascade",
                "table": "progress_events",
                "constraint": "progress_events_run_fk",
                "parent": "runs",
            },
            graph,
        )
        self.assertEqual(len(errors), 1)
        self.assertIn("must be bound to its tenant only through progress_events_run_fk", errors[0])
        self.assertIn("1 direct FK(s) to tenants(id)", errors[0])

    def test_reviewed_binding_that_is_missing_repointed_or_weakened_is_rejected(self):
        child = table("progress_events")
        check = {
            "kind": "tenant_fk_transitive_cascade",
            "table": "progress_events",
            "constraint": "progress_events_run_fk",
            "parent": "runs",
        }
        missing = build_graph([ROOT_RUNS, child], [])
        self.assertEqual(
            schema.transitive_fk_check_errors(check, missing),
            ["required transitive tenant binding progress_events_run_fk is missing on progress_events"],
        )
        other = table("other_runs", direct=1)
        repointed = build_graph(
            [ROOT_RUNS, other, child],
            [edge("progress_events", "progress_events_run_fk", "other_runs", run_key())],
        )
        self.assertEqual(
            schema.transitive_fk_check_errors(check, repointed),
            [
                "transitive tenant binding progress_events_run_fk on progress_events references "
                "other_runs; expected runs"
            ],
        )
        weakened = build_graph(
            [ROOT_RUNS, child],
            [
                edge(
                    "progress_events",
                    "progress_events_run_fk",
                    "runs",
                    run_key(),
                    action="a",
                )
            ],
        )
        self.assertEqual(
            schema.transitive_fk_check_errors(check, weakened),
            [
                "transitive tenant binding progress_events_run_fk on progress_events is not "
                "ON DELETE CASCADE"
            ],
        )

    def test_reviewed_table_with_nullable_tenant_id_is_rejected(self):
        child = table("progress_events", not_null=False)
        graph = build_graph(
            [ROOT_RUNS, child],
            [edge("progress_events", "progress_events_run_fk", "runs", run_key())],
        )
        errors = schema.transitive_fk_check_errors(
            {
                "kind": "tenant_fk_transitive_cascade",
                "table": "progress_events",
                "constraint": "progress_events_run_fk",
                "parent": "runs",
            },
            graph,
        )
        self.assertIn(
            "progress_events.tenant_id is nullable; a transitive tenant binding requires NOT NULL",
            errors,
        )

    def test_tenants_fk_on_another_column_blocks_a_parent_binding(self):
        # FOREIGN KEY (owner_tenant) REFERENCES tenants(id) puts the rows on
        # the first cascade level just as a tenant_id FK does, so a
        # parent-bound table may have neither.
        child = table("progress_events", other=1)
        graph = build_graph(
            [ROOT_RUNS, child],
            [edge("progress_events", "progress_events_run_fk", "runs", run_key())],
        )
        self.assertNotIn("progress_events", graph.transitive)
        self.assertEqual(
            schema.tenant_ownership_error(child, graph),
            "progress_events.tenant_id must have exactly one validated ON DELETE CASCADE FK to tenants(id) "
            "(found 0 tenant FK, 0 validated cascade); it cannot be bound through a parent either, because "
            "it has 1 FK(s) to tenants(id) on columns other than tenant_id",
        )
        errors = schema.transitive_fk_check_errors(
            {
                "kind": "tenant_fk_transitive_cascade",
                "table": "progress_events",
                "constraint": "progress_events_run_fk",
                "parent": "runs",
            },
            graph,
        )
        self.assertEqual(
            errors,
            [
                "progress_events must be bound to its tenant only through progress_events_run_fk, but it "
                "has 1 direct FK(s) to tenants(id) (1 on columns other than tenant_id); that second cascade "
                "path lets tenant deletion reach the table on the same level as its parent"
            ],
        )
        # Its children lose their binding with it.
        grandchild = table("progress_notes")
        chained = build_graph(
            [ROOT_RUNS, child, grandchild],
            [
                edge("progress_events", "progress_events_run_fk", "runs", run_key()),
                edge("progress_notes", "progress_notes_event_fk", "progress_events", run_key("event_id")),
            ],
        )
        self.assertEqual(chained.transitive, {})

    def test_directly_bound_table_may_reference_tenants_twice(self):
        # developer_test_accounts.sandbox_tenant_id and the agency links keep a
        # second tenants FK; the direct rule counts only the tenant_id edge.
        both = table("developer_test_accounts", direct=1, other=1)
        self.assertIsNone(schema.tenant_ownership_error(both, build_graph([both], [])))

    def test_reviewed_check_without_a_parent_fails_closed(self):
        graph = build_graph([ROOT_RUNS], [])
        with self.assertRaises(RuntimeError):
            schema.transitive_fk_check_errors(
                {"kind": "tenant_fk_transitive_cascade", "table": "runs", "constraint": "x"},
                graph,
            )


MIGRATION_2046 = "infra/migrations/2046_drop_duplicate_tenant_cascade_paths.sql"
MIGRATION_2047 = "infra/migrations/2047_referral_token_tenant_binding_and_tenant_scope_comments.sql"


def load_ledger() -> dict:
    return json.loads((ROOT / "scripts/lint-migrations-baseline.json").read_text(encoding="utf-8"))


def read_migration(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


class LedgerAgreesWithRepairMigrations(unittest.TestCase):
    """The ledger's reviewed bindings and each repair migration's self-audit name the same edges."""

    def transitive_entries_by_repair(self) -> dict[str, set[tuple[str, str, str]]]:
        grouped: dict[str, set[tuple[str, str, str]]] = {}
        for entry in load_ledger()["findings"]:
            verification = entry["verification"]
            if verification["kind"] != "tenant_fk_transitive_cascade":
                continue
            self.assertEqual(entry["table"], verification["table"], entry["id"])
            grouped.setdefault(entry["repair_migration"], set()).add(
                (verification["table"], verification["constraint"], verification["parent"])
            )
            expected_disposition = {
                MIGRATION_2046: "transitive-tenant-binding",
                MIGRATION_2047: "forward-repaired",
            }.get(entry["repair_migration"])
            self.assertIsNotNone(
                expected_disposition,
                f"{entry['id']} names repair migration {entry['repair_migration']}, "
                "which has no self-audit this test knows",
            )
            self.assertEqual(entry["disposition"], expected_disposition, entry["id"])
        return grouped

    def test_transitive_entries_match_the_2046_self_audit(self):
        reviewed = self.transitive_entries_by_repair()[MIGRATION_2046]
        migration = read_migration(MIGRATION_2046)

        def array(name: str) -> list[str]:
            match = re.search(rf"\b{name} text\[\] := ARRAY\[(.*?)\];", migration, re.DOTALL)
            self.assertIsNotNone(match, name)
            return re.findall(r"'([a-z0-9_]+)'", match.group(1))

        audited = set(zip(array("children"), array("bindings"), array("parents")))
        self.assertEqual(len(audited), 12)
        self.assertEqual(reviewed, audited)
        dropped = set(
            re.findall(
                r"ALTER TABLE public\.([a-z0-9_]+)\s+DROP CONSTRAINT IF EXISTS \1_tenant_id_fkey;",
                migration,
            )
        )
        self.assertEqual(dropped, {child for child, _, _ in audited})

    def test_transitive_entry_matches_the_2047_binding_and_self_audit(self):
        reviewed = self.transitive_entries_by_repair()[MIGRATION_2047]
        migration = read_migration(MIGRATION_2047)
        added = set(
            re.findall(
                r"ALTER TABLE public\.([a-z0-9_]+)\s+ADD CONSTRAINT ([a-z0-9_]+)\s+"
                r"FOREIGN KEY \(tenant_id, [a-z0-9_]+\)\s+REFERENCES public\.([a-z0-9_]+) \(tenant_id, id\)\s+"
                r"ON UPDATE CASCADE\s+ON DELETE CASCADE\s+NOT VALID;",
                migration,
            )
        )
        self.assertEqual(reviewed, added)
        self.assertEqual(reviewed, {("referral_code_tokens", "referral_code_tokens_referral_code_tenant_fkey", "referral_codes")})
        for table_name, constraint, _ in reviewed:
            self.assertRegex(
                migration,
                rf"ALTER TABLE public\.{table_name}\s+VALIDATE CONSTRAINT {constraint};",
            )
            # The self-audit checks this exact constraint.
            self.assertIn(f"conname = '{constraint}'", migration)
        self.assertRegex(
            migration,
            r"ALTER TABLE public\.referral_code_tokens\s+"
            r"DROP CONSTRAINT IF EXISTS referral_code_tokens_referral_code_id_fkey;",
        )

    def test_policy_scope_entries_name_register_tables(self):
        entries = [
            entry
            for entry in load_ledger()["findings"]
            if entry["verification"]["kind"] == "policy_scope_exception"
        ]
        self.assertEqual({entry["table"] for entry in entries}, {"referral_code_tokens"})
        for entry in entries:
            self.assertEqual(entry["disposition"], "reviewed-policy-scope-exception", entry["id"])
            self.assertEqual(entry["check"], "permissive_policy", entry["id"])
            self.assertEqual(entry["verification"]["table"], entry["table"], entry["id"])
            self.assertIn(entry["table"], schema.TENANT_POLICY_SCOPE_EXCEPTIONS, entry["id"])


def statement_lines(segment: str) -> list[str]:
    """The non-blank, non-comment lines of a SQL segment."""

    return [
        line.strip()
        for line in segment.splitlines()
        if line.strip() and not line.strip().startswith("--")
    ]


class RepairMigrationLocksAndRowSecurity(unittest.TestCase):
    """2046 and 2047 take locks in the order their headers promise; 2047 reads rows only with
    row_security off and keeps referral_codes.id immutable under its cascading FK."""

    def test_2046_locks_every_altered_table_before_tenants(self):
        # Each DROP CONSTRAINT also locks tenants ACCESS EXCLUSIVE. Taken by
        # the first DROP, tenants stayed locked while every later DROP waited
        # for its own table, and every tenants read waited with it.
        migration = read_migration(MIGRATION_2046)
        locks = [
            (match.start(), match.group(1), match.group(2))
            for match in re.finditer(
                r"^LOCK TABLE\s+(.*?)\s+IN ([A-Z ]+) MODE;", migration, re.MULTILINE | re.DOTALL
            )
        ]
        self.assertEqual(len(locks), 2, locks)
        (children_at, children_list, children_mode), (tenants_at, tenants_list, tenants_mode) = locks
        self.assertEqual((children_mode, tenants_mode), ("ACCESS EXCLUSIVE", "ACCESS EXCLUSIVE"))
        self.assertEqual(tenants_list.strip(), "public.tenants")
        locked = [name.strip().removeprefix("public.") for name in children_list.split(",")]
        dropped = re.findall(
            r"^ALTER TABLE public\.([a-z0-9_]+)\s+DROP CONSTRAINT IF EXISTS \1_tenant_id_fkey;",
            migration,
            re.MULTILINE,
        )
        self.assertEqual(len(dropped), 12)
        self.assertEqual(locked, dropped, "lock the tables in the order the DROPs alter them")
        first_alter = re.search(r"^ALTER TABLE ", migration, re.MULTILINE)
        self.assertIsNotNone(first_alter)
        self.assertLess(children_at, tenants_at)
        self.assertLess(tenants_at, first_alter.start())
        # Nothing between BEGIN and the first LOCK may take a table lock.
        begin = re.search(r"^BEGIN;$", migration, re.MULTILINE)
        self.assertIsNotNone(begin)
        self.assertEqual(
            statement_lines(migration[begin.end() : children_at]),
            ["SET LOCAL lock_timeout = '5s';"],
        )

    def test_2047_reads_rows_with_row_security_off_and_locks_in_writer_order(self):
        # A migrator that owns these FORCE RLS tables without bypassing RLS
        # sees no rows, and VALIDATE CONSTRAINT then marks the FK valid
        # without having read one. row_security = off turns that into an
        # error. Writers lock referral_codes before referral_code_tokens.
        migration = read_migration(MIGRATION_2047)
        blocks = re.findall(r"^BEGIN;\n(.*?)^COMMIT;", migration, re.MULTILINE | re.DOTALL)
        self.assertEqual(len(blocks), 3, "comments, NOT VALID FK, then VALIDATE")
        comments, add, validate = blocks
        writer_order = r"LOCK TABLE public\.referral_codes, public\.referral_code_tokens\s+IN {} MODE;"

        comment_lines = statement_lines(comments)
        self.assertEqual(comment_lines[0], "SET LOCAL lock_timeout = '5s';")
        self.assertNotIn("referral_code", comments)
        self.assertEqual(
            len(re.findall(r"^COMMENT ON COLUMN public\.[a-z_]+\.tenant_id IS$", comments, re.MULTILINE)),
            3,
        )

        def position(block: str, pattern: str) -> int:
            match = re.search(pattern, block)
            self.assertIsNotNone(match, pattern)
            return match.start()

        row_security = r"^SET LOCAL row_security = off;$"
        for name, block in (("NOT VALID FK", add), ("VALIDATE", validate)):
            with self.subTest(phase=name):
                self.assertIsNotNone(re.search(row_security, block, re.MULTILINE))
                self.assertIn("SET LOCAL lock_timeout = '5s';", block)

        self.assertLess(
            re.search(row_security, add, re.MULTILINE).start(), position(add, r"DO \$preflight\$")
        )
        self.assertLess(
            position(add, r"DO \$preflight\$"), position(add, writer_order.format("SHARE ROW EXCLUSIVE"))
        )
        self.assertLess(
            position(add, writer_order.format("SHARE ROW EXCLUSIVE")), position(add, r"ADD CONSTRAINT")
        )

        self.assertLess(
            re.search(row_security, validate, re.MULTILINE).start(),
            position(validate, r"VALIDATE CONSTRAINT"),
        )
        self.assertLess(
            position(validate, r"VALIDATE CONSTRAINT"),
            position(validate, writer_order.format("ACCESS EXCLUSIVE")),
        )
        self.assertLess(
            position(validate, writer_order.format("ACCESS EXCLUSIVE")),
            position(validate, r"DROP CONSTRAINT"),
        )

    def test_2047_keeps_referral_code_ids_immutable_before_its_fk_cascades_updates(self):
        # ON UPDATE CASCADE covers the whole key (tenant_id, id). Without the
        # guard, an UPDATE of referral_codes.id, which the id-only NO ACTION
        # FK refused, would succeed and rewrite the registry.
        migration = read_migration(MIGRATION_2047)
        _, add, validate = re.findall(r"^BEGIN;\n(.*?)^COMMIT;", migration, re.MULTILINE | re.DOTALL)
        function = re.search(
            r"^CREATE FUNCTION public\.referral_codes_id_immutable\(\)\n(.*?)^\$guard\$;$",
            add,
            re.MULTILINE | re.DOTALL,
        )
        self.assertIsNotNone(function)
        body = function.group(1)
        self.assertIn("RETURNS trigger\nLANGUAGE plpgsql\nSET search_path = pg_catalog, pg_temp\nAS $guard$\n", body)
        self.assertNotIn("SECURITY DEFINER", body)
        self.assertIn("    IF NEW.id IS DISTINCT FROM OLD.id THEN\n        RAISE EXCEPTION USING\n", body)
        self.assertIn("ERRCODE = '55000'", body)
        self.assertIn("REVOKE ALL ON FUNCTION public.referral_codes_id_immutable() FROM PUBLIC;", add)
        trigger = re.search(
            r"^CREATE TRIGGER referral_codes_id_immutable\n"
            r"    BEFORE UPDATE OF id ON public\.referral_codes\n"
            r"    FOR EACH ROW\n"
            r"    EXECUTE FUNCTION public\.referral_codes_id_immutable\(\);$",
            add,
            re.MULTILINE,
        )
        self.assertIsNotNone(trigger)
        # Under the writer-order lock, in the transaction that adds the FK and
        # before it, so no committed state lets an id change cascade.
        self.assertLess(add.index("IN SHARE ROW EXCLUSIVE MODE;"), function.start())
        self.assertLess(
            trigger.end(), add.index("ADD CONSTRAINT referral_code_tokens_referral_code_tenant_fkey")
        )
        # The self-audit pins the trigger's exact shape.
        for fragment in (
            "trigger_meta.tgname = 'referral_codes_id_immutable'",
            "AND trigger_meta.tgenabled = 'O'",
            "AND trigger_meta.tgtype = 19",
            "AND trigger_meta.tgqual IS NULL",
            "AND ARRAY(SELECT pg_catalog.unnest(trigger_meta.tgattr::smallint[])) = ARRAY[(",
            "AND id_column.attname = 'id'",
            "AND function_meta.oid = 'public.referral_codes_id_immutable()'::regprocedure",
            "AND NOT function_meta.prosecdef",
        ):
            self.assertIn(fragment, validate)


def facts(
    name: str,
    *,
    not_null: bool = True,
    relkind: str = "r",
    rls: bool = True,
    forced: bool = True,
    comment: str = "",
    privileges: set[str] | None = None,
    public_privileges: str = "",
    tenant_fk_count: int = 1,
    cascade_count: int = 1,
    set_null_count: int = 0,
    policy_count: int = 1,
    tenant_policy_count: int = 1,
    other_tenant_fk_count: int = 0,
):
    return schema.TenantTableFacts(
        name=name,
        relkind=relkind,
        not_null=not_null,
        rls=rls,
        forced=forced,
        tenant_comment=comment,
        privileges=frozenset(privileges or set()),
        public_privileges=public_privileges,
        tenant_fk_count=tenant_fk_count,
        cascade_count=cascade_count,
        set_null_count=set_null_count,
        policy_count=policy_count,
        tenant_policy_count=tenant_policy_count,
        other_tenant_fk_count=other_tenant_fk_count,
    )


def nullable_facts(name: str, **overrides):
    """Facts that satisfy the reviewed nullable contract for name exactly."""

    contract = schema.NULLABLE_TENANT_EXCEPTIONS[name]
    fk_action = contract["fk_action"]
    values = dict(
        not_null=False,
        relkind="p" if name in schema.PARTITIONED_NULLABLE_EXCEPTIONS else "r",
        rls=contract["rls"],
        forced=contract["rls"],
        comment=contract["comment"],
        privileges=schema.reviewed_app_privileges(contract),
        tenant_fk_count=0 if fk_action == "none" else 1,
        cascade_count=1 if fk_action == "cascade" else 0,
        set_null_count=1 if fk_action == "set_null" else 0,
    )
    values.update(overrides)
    return facts(name, **values)


def register_acls(name: str) -> dict[str, dict[tuple[str, str], frozenset[str]]]:
    """The catalog ACL a register entry accepts, shaped as load_acls() returns it."""

    contract = schema.NULLABLE_TENANT_EXCEPTIONS.get(name) or schema.TENANT_POLICY_SCOPE_EXCEPTIONS.get(name)
    return {name: schema.flatten_acl(contract["acl"])} if contract else {}


def acl_with(
    name: str, changes: dict[tuple[str, str], set[str]]
) -> dict[str, dict[tuple[str, str], frozenset[str]]]:
    """name's register ACL with each (grantee, column) entry replaced; an empty set removes it."""

    table_acl = dict(register_acls(name).get(name, {}))
    for key, privileges in changes.items():
        if privileges:
            table_acl[key] = frozenset(privileges)
        else:
            table_acl.pop(key, None)
    return {name: table_acl}


def audit_gates() -> dict[str, dict[str, object]]:
    gate = schema.delete_gate_policy("app.audit_trim_worker")
    return {
        "audit_log": {"audit_log_trim_worker_only": gate},
        "audit_log_legacy": {"audit_log_legacy_trim_worker_only": gate},
    }


def errors_for(item, *, policies=None, acls=None, graph=None):
    """tenant_table_errors for item; acls defaults to exactly what item's register entry grants."""

    graph = graph or build_graph([item.ownership], [])
    scope = schema.ReviewedScopeFacts(
        policies=policies or {}, acls=register_acls(item.name) if acls is None else acls
    )
    return schema.tenant_table_errors(item, graph, scope)


class NullableExceptionContracts(unittest.TestCase):
    def test_every_reviewed_contract_is_satisfiable_as_written(self):
        for name in schema.NULLABLE_TENANT_EXCEPTIONS:
            with self.subTest(table=name):
                self.assertEqual(errors_for(nullable_facts(name), policies=audit_gates()), [])

    def test_audit_log_delete_requires_both_restrictive_trim_gates(self):
        audit = nullable_facts("audit_log")
        self.assertEqual(errors_for(audit, policies=audit_gates()), [])

        missing = audit_gates()
        del missing["audit_log"]["audit_log_trim_worker_only"]
        self.assertEqual(
            errors_for(audit, policies=missing),
            [
                "audit_log grants postwave_app DELETE, but the RESTRICTIVE delete gate "
                "audit_log_trim_worker_only is missing on audit_log"
            ],
        )
        missing_partition = audit_gates()
        del missing_partition["audit_log_legacy"]
        self.assertEqual(len(errors_for(audit, policies=missing_partition)), 1)

        gate = schema.delete_gate_policy("app.audit_trim_worker")
        for label, weakened in {
            "permissive": gate._replace(permissive=True),
            "all commands": gate._replace(command="*"),
            "other capability": schema.delete_gate_policy("app.outbox_worker"),
            "always true": gate._replace(using="true"),
        }.items():
            with self.subTest(weakening=label):
                policies = audit_gates()
                policies["audit_log"]["audit_log_trim_worker_only"] = weakened
                errors = errors_for(audit, policies=policies)
                self.assertEqual(len(errors), 1, errors)
                self.assertIn("audit_log delete gate audit_log_trim_worker_only on audit_log differs", errors[0])

    def test_privilege_drift_is_rejected_in_both_directions(self):
        cases = {
            # Lost the retention grant: the trimmer is broken again.
            "audit_log": ({"INSERT", "SELECT"}, "expected ['DELETE', 'INSERT', 'SELECT']"),
            # Regained the DELETE that 1824 revoked.
            "campaign_templates": (
                {"DELETE", "INSERT", "SELECT", "UPDATE"},
                "expected ['INSERT', 'SELECT', 'UPDATE']",
            ),
            # Rows of global telemetry are never rewritten.
            "web_vitals_events": (
                {"DELETE", "INSERT", "SELECT", "UPDATE"},
                "expected ['DELETE', 'INSERT', 'SELECT']",
            ),
            # A notice is evidence: DELETE is withheld, and 2047 took back the
            # table-level UPDATE that let its tenant rewrite it.
            "content_reports": (
                {"INSERT", "SELECT", "UPDATE"},
                "expected ['INSERT', 'SELECT']",
            ),
            "content_report_decisions": ({"INSERT", "SELECT", "UPDATE"}, "expected ['INSERT', 'SELECT']"),
            "campaign_template_reference_review_decisions": (
                {"DELETE", "INSERT", "SELECT"},
                "expected ['INSERT', 'SELECT']",
            ),
        }
        for name, (privileges, expected) in cases.items():
            with self.subTest(table=name):
                errors = errors_for(nullable_facts(name, privileges=privileges), policies=audit_gates())
                self.assertEqual(len(errors), 1, errors)
                self.assertIn(f"{name} postwave_app privileges are", errors[0])
                self.assertIn(expected, errors[0])

    def test_reviewed_contracts_match_the_migrations_that_set_them(self):
        # Literal expectations, each anchored to the statement that establishes
        # it, so a register edit cannot move the expectation with it.
        expected = {
            "audit_log": ("cascade", {"DELETE", "INSERT", "SELECT"}, True),
            "web_vitals_events": ("none", {"DELETE", "INSERT", "SELECT"}, False),
            "campaign_templates": ("cascade", {"INSERT", "SELECT", "UPDATE"}, True),
            "content_reports": ("set_null", {"INSERT", "SELECT"}, True),
            "content_report_decisions": ("set_null", {"INSERT", "SELECT"}, True),
            "campaign_template_reference_review_decisions": ("cascade", {"INSERT", "SELECT"}, True),
        }
        for name, (fk_action, privileges, rls) in expected.items():
            with self.subTest(table=name):
                contract = schema.NULLABLE_TENANT_EXCEPTIONS[name]
                self.assertEqual(
                    (contract["fk_action"], schema.reviewed_app_privileges(contract), contract["rls"]),
                    (fk_action, privileges, rls),
                )
        anchors = {
            "infra/migrations/1902_audit_log_trim_capability.sql": [
                r"GRANT DELETE ON audit_log TO postwave_app;",
                r"CREATE POLICY audit_log_trim_worker_only ON audit_log\s+AS RESTRICTIVE\s+FOR DELETE\s+"
                r"USING \(current_setting\('app\.audit_trim_worker', true\) = 'true'\);",
                r"GRANT DELETE ON audit_log_legacy TO postwave_app;",
                r"CREATE POLICY audit_log_legacy_trim_worker_only ON audit_log_legacy\s+AS RESTRICTIVE\s+"
                r"FOR DELETE\s+USING \(current_setting\('app\.audit_trim_worker', true\) = 'true'\);",
            ],
            "infra/migrations/1910_web_vitals_events_retention_delete.sql": [
                r"GRANT DELETE ON web_vitals_events TO postwave_app;",
            ],
            "infra/migrations/1824_campaign_template_lifecycle.sql": [
                r"REVOKE DELETE ON campaign_templates FROM postwave_app;",
            ],
            "infra/migrations/2041_content_reports_notice_and_action.sql": [
                r"CREATE TABLE IF NOT EXISTS content_reports \([^;]*?"
                r"tenant_id\s+uuid REFERENCES tenants\(id\) ON DELETE SET NULL,",
                r"CREATE TABLE IF NOT EXISTS content_report_decisions \([^;]*?"
                r"tenant_id\s+uuid REFERENCES tenants\(id\) ON DELETE SET NULL,",
                r"GRANT SELECT, INSERT, UPDATE ON content_reports TO postwave_app;",
                r"GRANT SELECT, INSERT ON content_report_decisions TO postwave_app;",
            ],
            MIGRATION_2047: [
                r"REVOKE UPDATE ON public\.content_reports FROM postwave_app;\n"
                r"GRANT UPDATE \(status, updated_at\) ON public\.content_reports TO postwave_app;",
            ],
            "infra/migrations/1819_campaign_template_reference_reviews.sql": [
                r"CREATE TABLE campaign_template_reference_review_decisions \(\s+"
                r"id\s+uuid PRIMARY KEY DEFAULT gen_random_uuid\(\),\s+"
                r"tenant_id\s+uuid NOT NULL REFERENCES tenants\(id\) ON DELETE CASCADE,",
            ],
            "infra/migrations/1825_campaign_template_catalog_publication.sql": [
                r"ALTER TABLE campaign_template_reference_review_decisions\s+"
                r"ALTER COLUMN tenant_id DROP NOT NULL;",
            ],
        }
        for relative, patterns in anchors.items():
            text = read_migration(relative)
            for pattern in patterns:
                with self.subTest(migration=relative, statement=pattern):
                    self.assertRegex(text, pattern)
        gate = schema.NULLABLE_TENANT_EXCEPTIONS["audit_log"]["delete_gate"]
        self.assertEqual(gate["setting"], "app.audit_trim_worker")
        self.assertEqual(
            gate["policies"],
            {
                "audit_log": "audit_log_trim_worker_only",
                "audit_log_legacy": "audit_log_legacy_trim_worker_only",
            },
        )
        self.assertEqual(
            {name for name, contract in schema.NULLABLE_TENANT_EXCEPTIONS.items() if "delete_gate" in contract},
            {"audit_log"},
        )

    def test_exact_acls_match_the_grants_that_set_them(self):
        # Literal ACLs, each privilege anchored to the GRANT that creates it,
        # so the register cannot drift from the migrations unnoticed.
        app_update = frozenset({"UPDATE"})
        expected = {
            "audit_log": {
                ("postwave_app", ""): frozenset({"DELETE", "INSERT", "SELECT"}),
                ("postwave_app", "legal_hold"): app_update,
                ("postwave_app", "prev_hash"): app_update,
                ("postwave_app", "retention_override_days"): app_update,
                ("postwave_app", "row_hash"): app_update,
                ("postwave_ops", ""): frozenset({"INSERT"}),
            },
            "blocklist_observations": {
                ("postwave_app", ""): frozenset({"DELETE", "INSERT", "SELECT", "UPDATE"}),
                ("postwave_deliverability_discovery_definer", "checked_at"): frozenset({"SELECT"}),
                ("postwave_deliverability_discovery_definer", "tenant_id"): frozenset({"SELECT"}),
            },
            "content_reports": {
                ("postwave_app", ""): frozenset({"INSERT", "SELECT"}),
                ("postwave_app", "status"): app_update,
                ("postwave_app", "updated_at"): app_update,
            },
        }
        for name, acl in expected.items():
            with self.subTest(table=name):
                self.assertEqual(schema.flatten_acl(schema.NULLABLE_TENANT_EXCEPTIONS[name]["acl"]), acl)
        anchors = {
            "infra/migrations/0002_audit_log.sql": [r"GRANT SELECT, INSERT ON audit_log TO postwave_app;"],
            "infra/migrations/0271_audit_retention.sql": [
                r"GRANT UPDATE \(retention_override_days, legal_hold\) ON audit_log TO postwave_app;"
            ],
            "infra/migrations/1703_ops_action_runs.sql": [r"GRANT INSERT ON audit_log TO postwave_ops;"],
            "infra/migrations/1726_audit_merkle_worker_permissions.sql": [
                r"GRANT UPDATE \(prev_hash, row_hash\) ON audit_log TO postwave_app;"
            ],
            "infra/migrations/0154_misc_table_app_grants.sql": [
                r"GRANT SELECT, INSERT, UPDATE, DELETE ON blocklist_observations\s+TO postwave_app;"
            ],
            "infra/migrations/1849_deliverability_degradation_claims.sql": [
                r"GRANT SELECT \(tenant_id, checked_at\)\s+ON public\.blocklist_observations\s+"
                r"TO postwave_deliverability_discovery_definer;"
            ],
        }
        for relative, patterns in anchors.items():
            text = read_migration(relative)
            for pattern in patterns:
                with self.subTest(migration=relative, statement=pattern):
                    self.assertRegex(text, pattern)

    def test_column_grants_and_new_grantees_are_rejected(self):
        # The widenings the table-level check could not see: a column grant,
        # and any grant to a role outside the reviewed ACL.
        name = "content_reports"
        facts_ok = nullable_facts(name)
        cases = {
            "evidence column": (
                acl_with(name, {("postwave_app", "actual_knowledge_at"): {"UPDATE"}}),
                "content_reports grants postwave_app ['UPDATE'] on column actual_knowledge_at; "
                "the reviewed ACL grants []",
            ),
            "tenant column": (
                acl_with(name, {("postwave_app", "tenant_id"): {"UPDATE"}}),
                "content_reports grants postwave_app ['UPDATE'] on column tenant_id; "
                "the reviewed ACL grants []",
            ),
            "new grantee, column": (
                acl_with(name, {("postwave_ops", "notifier_email"): {"SELECT"}}),
                "content_reports grants postwave_ops ['SELECT'] on column notifier_email; "
                "the reviewed ACL grants []",
            ),
            "PUBLIC, table": (
                acl_with(name, {("PUBLIC", ""): {"SELECT"}}),
                "content_reports grants PUBLIC ['SELECT'] on the table; the reviewed ACL grants []",
            ),
            "grant option": (
                acl_with(name, {("postwave_app", ""): {"INSERT", "SELECT WITH GRANT OPTION"}}),
                "content_reports grants postwave_app ['INSERT', 'SELECT WITH GRANT OPTION'] on the table; "
                "the reviewed ACL grants ['INSERT', 'SELECT']",
            ),
            "lost column grant": (
                acl_with(name, {("postwave_app", "status"): set()}),
                "content_reports grants postwave_app [] on column status; the reviewed ACL grants ['UPDATE']",
            ),
        }
        for label, (acls, expected) in cases.items():
            with self.subTest(change=label):
                self.assertEqual(errors_for(facts_ok, acls=acls), [expected])
        # A missing catalog ACL is no grant at all, not a pass.
        self.assertEqual(
            errors_for(nullable_facts("billing_events"), acls={}),
            [
                "billing_events grants postwave_app [] on the table; "
                "the reviewed ACL grants ['INSERT', 'SELECT', 'UPDATE']"
            ],
        )

    def test_new_nullable_contracts_require_comment_and_delete_action(self):
        self.assertEqual(
            errors_for(nullable_facts("content_reports", comment="")),
            ["content_reports.tenant_id is missing its exact reviewed exception comment"],
        )
        self.assertEqual(
            errors_for(nullable_facts("content_report_decisions", set_null_count=0, cascade_count=1)),
            [
                "content_report_decisions.tenant_id must have exactly one validated ON DELETE SET NULL FK "
                "to tenants(id)"
            ],
        )
        self.assertEqual(
            errors_for(
                nullable_facts(
                    "campaign_template_reference_review_decisions", cascade_count=0, set_null_count=1
                )
            ),
            [
                "campaign_template_reference_review_decisions.tenant_id must have exactly one validated "
                "ON DELETE CASCADE FK to tenants(id)"
            ],
        )

    def test_unreviewed_nullable_tenant_is_rejected(self):
        self.assertEqual(
            errors_for(facts("anonymous_uploads", not_null=False, tenant_fk_count=0, cascade_count=0)),
            ["anonymous_uploads.tenant_id is nullable without an exact reviewed exception"],
        )

    def test_directly_granted_partition_needs_the_roots_delete_gate(self):
        self.assertIsNone(
            schema.partition_delete_gate_error("audit_log_legacy", "audit_log", {"DELETE", "INSERT", "SELECT"})
        )
        self.assertIsNone(schema.partition_delete_gate_error("audit_log_p2026_10", "audit_log", set()))
        self.assertIsNone(schema.partition_delete_gate_error("audit_log_p2026_11", "audit_log", {"SELECT"}))
        self.assertIn(
            "partition audit_log_p2026_12 grants postwave_app DELETE directly but has no reviewed delete gate",
            schema.partition_delete_gate_error("audit_log_p2026_12", "audit_log", {"DELETE"}),
        )
        # web_vitals_events has no RLS and no gate to inherit.
        self.assertIsNone(
            schema.partition_delete_gate_error("web_vitals_events_legacy", "web_vitals_events", {"DELETE"})
        )

    def test_register_comments_match_migration_2047_and_reviewed_categories(self):
        migration = read_migration(MIGRATION_2047)
        commented = dict(
            re.findall(
                r"COMMENT ON COLUMN public\.([a-z0-9_]+)\.tenant_id IS\s+'([^']+)';", migration
            )
        )
        self.assertEqual(
            set(commented),
            {"content_reports", "content_report_decisions", "campaign_template_reference_review_decisions"},
        )
        for name, comment in commented.items():
            self.assertEqual(schema.NULLABLE_TENANT_EXCEPTIONS[name]["comment"], comment, name)
            # The self-audit compares the same text.
            self.assertIn(f"('{name}',\n                 '{comment}')", migration)

        # apps/api/internal/schemaguard fails on an exception category it has
        # not reviewed; every register comment must use one of those.
        guard = read_migration("apps/api/internal/schemaguard/tenant_isolation_test.go")
        known_block = re.search(r"known := map\[string\]bool\{(.*?)\n\t\}", guard, re.DOTALL)
        self.assertIsNotNone(known_block)
        known = set(re.findall(r'"([a-z-]+)":\s+true', known_block.group(1)))
        self.assertGreaterEqual(len(known), 8)
        for name, contract in schema.NULLABLE_TENANT_EXCEPTIONS.items():
            match = re.match(r"postwave:tenant-scope-exception=([a-z-]+); ", contract["comment"])
            self.assertIsNotNone(match, name)
            self.assertIn(match.group(1), known, name)


WORKER_TABLE = "campaign_assurance_raw_output_cleanup_receipts"


def scope_facts(name: str, **overrides):
    contract = schema.TENANT_POLICY_SCOPE_EXCEPTIONS[name]
    values = dict(
        privileges=schema.reviewed_app_privileges(contract),
        policy_count=len(contract["policies"]),
        tenant_policy_count=0,
    )
    values.update(overrides)
    return facts(name, **values)


def scope_policies(name: str) -> dict[str, dict[str, object]]:
    return {name: dict(schema.TENANT_POLICY_SCOPE_EXCEPTIONS[name]["policies"])}


class PolicyScopeExceptions(unittest.TestCase):
    def test_every_register_entry_is_satisfiable_as_written(self):
        for name in schema.TENANT_POLICY_SCOPE_EXCEPTIONS:
            with self.subTest(table=name):
                self.assertEqual(errors_for(scope_facts(name), policies=scope_policies(name)), [])

    def test_registers_do_not_overlap(self):
        # A table in both registers would have its ACL judged twice, by two
        # entries that could disagree.
        self.assertEqual(
            set(schema.NULLABLE_TENANT_EXCEPTIONS) & set(schema.TENANT_POLICY_SCOPE_EXCEPTIONS), set()
        )

    def test_register_entries_are_complete(self):
        for name, contract in schema.TENANT_POLICY_SCOPE_EXCEPTIONS.items():
            with self.subTest(table=name):
                self.assertIn(
                    contract["scope"],
                    {"worker-capability", "definer-owner-only", "definer-bypassrls-only"},
                )
                self.assertGreater(len(contract["review"]), 100)
                self.assertNotIn("PUBLIC", contract["acl"])
                app_privileges = schema.reviewed_app_privileges(contract)
                for policy in contract["policies"].values():
                    self.assertIsInstance(policy, schema.PolicyFacts)
                    self.assertNotIn("app.tenant_id", policy.using + policy.check)
                if contract["scope"] == "worker-capability":
                    # Worker tables are reachable by postwave_app only through the
                    # outbox-worker capability, and never deletable by it.
                    self.assertTrue(contract["policies"])
                    for policy in contract["policies"].values():
                        self.assertEqual(policy.roles, ("postwave_app",))
                        self.assertIn(schema.OUTBOX_WORKER_PREDICATE, (policy.using, policy.check))
                    self.assertNotIn("DELETE", app_privileges)
                    self.assertNotIn("TRUNCATE", app_privileges)
                    self.assertEqual(set(contract["acl"]), {"postwave_app"})
                    self.assertNotIn("tenant_id", contract["acl"]["postwave_app"]["columns"])
                else:
                    self.assertEqual(app_privileges, set())
                    self.assertNotIn("postwave_app", contract["acl"])

    def test_exact_acls_match_the_grants_that_set_them(self):
        app_update = frozenset({"UPDATE"})
        definer_column = frozenset({"INSERT", "SELECT"})
        expected = {
            "campaign_assurance_raw_output_cleanup_receipts": {
                ("postwave_app", ""): frozenset({"INSERT", "SELECT"}),
            },
            "campaign_assurance_raw_output_write_intents": {
                ("postwave_app", ""): frozenset({"INSERT", "SELECT", "UPDATE"}),
            },
            "campaign_assurance_raw_output_write_receipts": {
                ("postwave_app", ""): frozenset({"INSERT", "SELECT"}),
            },
            "campaign_report_projection_mutation_authorizations": {},
            "deliverability_degradation_claims": {
                ("postwave_app", ""): frozenset({"INSERT", "SELECT"}),
                ("postwave_app", "operator_attempt_count"): app_update,
                ("postwave_app", "operator_last_error"): app_update,
                ("postwave_app", "operator_lease_expires_at"): app_update,
                ("postwave_app", "operator_lease_token"): app_update,
                ("postwave_app", "operator_next_attempt_at"): app_update,
                ("postwave_app", "operator_notified_at"): app_update,
            },
            "referral_code_tokens": {
                ("postwave_referral_code_definer", ""): frozenset({"DELETE"}),
                ("postwave_referral_code_definer", "referral_code_id"): definer_column,
                ("postwave_referral_code_definer", "subscriber_id"): definer_column,
                ("postwave_referral_code_definer", "tenant_id"): definer_column,
                ("postwave_referral_code_definer", "token"): definer_column,
                ("postwave_referral_code_definer", "token_kind"): definer_column,
            },
        }
        self.assertEqual(set(expected), set(schema.TENANT_POLICY_SCOPE_EXCEPTIONS))
        for name, acl in expected.items():
            with self.subTest(table=name):
                self.assertEqual(schema.flatten_acl(schema.TENANT_POLICY_SCOPE_EXCEPTIONS[name]["acl"]), acl)
        anchors = {
            "infra/migrations/1849_deliverability_degradation_claims.sql": [
                r"REVOKE ALL ON public\.deliverability_degradation_claims FROM postwave_app;\n"
                r"GRANT SELECT, INSERT ON public\.deliverability_degradation_claims TO postwave_app;\n"
                r"GRANT UPDATE \(\s+operator_notified_at,\s+operator_attempt_count,\s+"
                r"operator_next_attempt_at,\s+operator_lease_token,\s+operator_lease_expires_at,\s+"
                r"operator_last_error\s+\) ON public\.deliverability_degradation_claims TO postwave_app;",
            ],
            "infra/migrations/1772_referral_public_code_boundary.sql": [
                r"GRANT SELECT \(token, referral_code_id, tenant_id, subscriber_id, token_kind\),\s+"
                r"INSERT \(token, referral_code_id, tenant_id, subscriber_id, token_kind\)\s+"
                r"ON public\.referral_code_tokens TO postwave_referral_code_definer;",
                r"GRANT DELETE ON public\.referral_code_tokens\s+TO postwave_referral_code_definer;",
            ],
        }
        for relative, patterns in anchors.items():
            text = read_migration(relative)
            for pattern in patterns:
                with self.subTest(migration=relative, statement=pattern):
                    self.assertRegex(text, pattern)

    def test_an_added_tenant_policy_retires_the_exception(self):
        policies = scope_policies(WORKER_TABLE)
        policies[WORKER_TABLE]["tenant_visible"] = schema.PolicyFacts(
            permissive=True,
            command="r",
            roles=("postwave_app",),
            using="(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
            check="",
        )
        errors = errors_for(
            scope_facts(WORKER_TABLE, policy_count=3, tenant_policy_count=1),
            policies=policies,
        )
        self.assertEqual(
            errors,
            [
                f"{WORKER_TABLE} policy tenant_visible is not part of its reviewed policy-scope exception",
                f"{WORKER_TABLE} now has a policy that reads app.tenant_id; remove its reviewed "
                "policy-scope exception so the ordinary tenant-policy rule applies",
            ],
        )

    def test_widened_missing_or_repointed_policies_are_rejected(self):
        name = f"{WORKER_TABLE}_worker_select"
        reviewed = schema.TENANT_POLICY_SCOPE_EXCEPTIONS[WORKER_TABLE]["policies"][name]
        for label, changed in {
            "always true": reviewed._replace(using="true"),
            "public role": reviewed._replace(roles=("PUBLIC",)),
            "restrictive": reviewed._replace(permissive=False),
            "all commands": reviewed._replace(command="*"),
            "other capability": reviewed._replace(
                using="(current_setting('app.retention_worker'::text, true) = 'true'::text)"
            ),
        }.items():
            with self.subTest(change=label):
                policies = scope_policies(WORKER_TABLE)
                policies[WORKER_TABLE][name] = changed
                errors = errors_for(scope_facts(WORKER_TABLE), policies=policies)
                self.assertEqual(len(errors), 1, errors)
                self.assertIn(f"{WORKER_TABLE} policy {name} differs from its reviewed definition", errors[0])
        policies = scope_policies(WORKER_TABLE)
        del policies[WORKER_TABLE][name]
        self.assertEqual(
            errors_for(scope_facts(WORKER_TABLE, policy_count=1), policies=policies),
            [f"{WORKER_TABLE} is missing reviewed policy {name}"],
        )

    def test_new_privilege_or_grantee_is_rejected(self):
        policies = scope_policies(WORKER_TABLE)
        # An effective privilege the ACL does not show (role membership).
        self.assertEqual(
            errors_for(
                scope_facts(WORKER_TABLE, privileges={"DELETE", "INSERT", "SELECT"}), policies=policies
            ),
            [
                f"{WORKER_TABLE} postwave_app privileges are ['DELETE', 'INSERT', 'SELECT']; "
                "expected ['INSERT', 'SELECT']"
            ],
        )
        # A direct table grant shows in both.
        self.assertEqual(
            errors_for(
                scope_facts(WORKER_TABLE, privileges={"DELETE", "INSERT", "SELECT"}),
                policies=policies,
                acls=acl_with(WORKER_TABLE, {("postwave_app", ""): {"DELETE", "INSERT", "SELECT"}}),
            ),
            [
                f"{WORKER_TABLE} postwave_app privileges are ['DELETE', 'INSERT', 'SELECT']; "
                "expected ['INSERT', 'SELECT']",
                f"{WORKER_TABLE} grants postwave_app ['DELETE', 'INSERT', 'SELECT'] on the table; "
                "the reviewed ACL grants ['INSERT', 'SELECT']",
            ],
        )
        for grantee, column in (("postwave_ops", ""), ("PUBLIC", ""), ("postwave_ops", "tenant_id")):
            with self.subTest(grantee=grantee, column=column):
                errors = errors_for(
                    scope_facts(WORKER_TABLE),
                    policies=policies,
                    acls=acl_with(WORKER_TABLE, {(grantee, column): {"SELECT"}}),
                )
                where = f"column {column}" if column else "the table"
                self.assertEqual(
                    errors,
                    [f"{WORKER_TABLE} grants {grantee} ['SELECT'] on {where}; the reviewed ACL grants []"],
                )

    def test_a_column_grant_on_a_worker_table_is_rejected(self):
        # The widening has_table_privilege cannot see: UPDATE (tenant_id) under
        # a FOR ALL worker policy would let the worker move claims between
        # tenants, and the receipts are immutable.
        for name in ("deliverability_degradation_claims", "campaign_assurance_raw_output_write_receipts"):
            with self.subTest(table=name):
                self.assertEqual(
                    errors_for(
                        scope_facts(name),
                        policies=scope_policies(name),
                        acls=acl_with(name, {("postwave_app", "tenant_id"): {"UPDATE"}}),
                    ),
                    [f"{name} grants postwave_app ['UPDATE'] on column tenant_id; the reviewed ACL grants []"],
                )
        # Losing one of the six delivery-state columns breaks the worker.
        name = "deliverability_degradation_claims"
        self.assertEqual(
            errors_for(
                scope_facts(name),
                policies=scope_policies(name),
                acls=acl_with(name, {("postwave_app", "operator_lease_token"): set()}),
            ),
            [f"{name} grants postwave_app [] on column operator_lease_token; the reviewed ACL grants ['UPDATE']"],
        )

    def test_definer_only_registry_must_stay_closed(self):
        name = "referral_code_tokens"
        definer = "postwave_referral_code_definer"
        self.assertEqual(errors_for(scope_facts(name, policy_count=0), policies={}), [])
        self.assertEqual(
            errors_for(
                scope_facts(name, privileges={"SELECT"}, policy_count=0),
                policies={},
                acls=acl_with(name, {("postwave_app", ""): {"SELECT"}}),
            ),
            [
                "referral_code_tokens postwave_app privileges are ['SELECT']; expected []",
                "referral_code_tokens grants postwave_app ['SELECT'] on the table; the reviewed ACL grants []",
            ],
        )
        # The definer is reviewed down to the privilege: no TRUNCATE, no UPDATE.
        self.assertEqual(
            errors_for(
                scope_facts(name, policy_count=0),
                policies={},
                acls=acl_with(
                    name,
                    {
                        (definer, ""): {"DELETE", "TRUNCATE"},
                        (definer, "tenant_id"): {"INSERT", "SELECT", "UPDATE"},
                    },
                ),
            ),
            [
                f"referral_code_tokens grants {definer} ['DELETE', 'TRUNCATE'] on the table; "
                "the reviewed ACL grants ['DELETE']",
                f"referral_code_tokens grants {definer} ['INSERT', 'SELECT', 'UPDATE'] on column tenant_id; "
                "the reviewed ACL grants ['INSERT', 'SELECT']",
            ],
        )
        opened = {
            name: {
                "app_lookup": schema.PolicyFacts(
                    permissive=True, command="r", roles=("postwave_app",), using="true", check=""
                )
            }
        }
        self.assertEqual(
            errors_for(scope_facts(name, policy_count=1), policies=opened),
            [f"{name} policy app_lookup is not part of its reviewed policy-scope exception"],
        )

    def test_rls_state_is_still_required(self):
        errors = errors_for(
            scope_facts(WORKER_TABLE, forced=False),
            policies=scope_policies(WORKER_TABLE),
        )
        self.assertEqual(
            errors,
            [
                f"{WORKER_TABLE} RLS state is enabled=True, forced=False; expected enabled=True, forced=True"
            ],
        )

    def test_tables_outside_the_register_keep_the_tenant_policy_rule(self):
        # The same catalog shapes the register accepts are still rejected for
        # any other table: the rule is narrowed per table, not weakened.
        self.assertEqual(
            errors_for(facts("worker_leases", policy_count=1, tenant_policy_count=0)),
            ["worker_leases has no policy predicate bound to app.tenant_id"],
        )
        self.assertEqual(
            errors_for(facts("private_registry", policy_count=0, tenant_policy_count=0)),
            [
                "private_registry enables RLS but has no policies",
                "private_registry has no policy predicate bound to app.tenant_id",
            ],
        )

    def test_ledger_check_requires_a_register_entry_and_a_tenant_table(self):
        graph = build_graph([table("referral_code_tokens"), table("referral_codes", direct=1)], [])
        self.assertEqual(
            schema.policy_scope_check_errors(
                {"kind": "policy_scope_exception", "table": "referral_code_tokens"}, graph
            ),
            [],
        )
        self.assertEqual(
            schema.policy_scope_check_errors({"kind": "policy_scope_exception", "table": "widgets"}, graph),
            ["widgets has no reviewed policy-scope exception in scripts/lint-migrations-schema.py"],
        )
        self.assertEqual(
            schema.policy_scope_check_errors(
                {"kind": "policy_scope_exception", "table": WORKER_TABLE}, graph
            ),
            [f"{WORKER_TABLE} is not a logical public table with a tenant_id column"],
        )
        with self.assertRaises(RuntimeError):
            schema.policy_scope_check_errors({"kind": "policy_scope_exception"}, graph)


class CatalogRowParsing(unittest.TestCase):
    def test_policy_row_parses_and_normalizes(self):
        relation, name, parsed = schema.parse_policy_row(
            [
                "audit_log",
                "audit_log_trim_worker_only",
                "false",
                "d",
                "PUBLIC",
                "(current_setting('app.audit_trim_worker'::text,  true) = 'true'::text) ",
                "",
            ]
        )
        self.assertEqual((relation, name), ("audit_log", "audit_log_trim_worker_only"))
        self.assertEqual(parsed, schema.delete_gate_policy("app.audit_trim_worker"))
        _, _, multi_role = schema.parse_policy_row(
            ["t", "p", "true", "*", "postwave_ops,postwave_app", "true", "true"]
        )
        self.assertEqual(multi_role.roles, ("postwave_app", "postwave_ops"))

    def test_tenant_table_row_parses(self):
        parsed = schema.parse_tenant_table_row(
            [
                "content_reports", "r", "false", "true", "true", "comment",
                "INSERT,SELECT", "", "1", "0", "1", "0", "3", "3",
            ]
        )
        self.assertEqual(
            parsed,
            facts(
                "content_reports",
                not_null=False,
                comment="comment",
                privileges={"INSERT", "SELECT"},
                cascade_count=0,
                set_null_count=1,
                policy_count=3,
                tenant_policy_count=3,
            ),
        )
        # The other-tenant-FK count sits after set_null_count and reaches the
        # ownership facts.
        other = schema.parse_tenant_table_row(
            [
                "campaign_assurance_findings", "r", "true", "true", "true", "",
                "SELECT", "SELECT(tenant_id)", "0", "0", "0", "2", "4", "4",
            ]
        )
        self.assertEqual(other.other_tenant_fk_count, 2)
        self.assertEqual(other.ownership.any_tenant_fk_count, 2)
        self.assertEqual(other.public_privileges, "SELECT(tenant_id)")
        with self.assertRaises(ValueError):
            schema.parse_tenant_table_row(["too", "short"])

    def test_acl_rows_group_by_relation_grantee_and_column(self):
        rows = [
            ["content_reports", "", "postwave_app", "INSERT"],
            ["content_reports", "", "postwave_app", "SELECT"],
            ["content_reports", "status", "postwave_app", "UPDATE"],
            ["content_reports", "updated_at", "postwave_app", "UPDATE"],
            ["referral_code_tokens", "tenant_id", "postwave_referral_code_definer", "SELECT WITH GRANT OPTION"],
        ]
        self.assertEqual(
            schema.parse_acl_rows(rows),
            {
                "content_reports": {
                    ("postwave_app", ""): frozenset({"INSERT", "SELECT"}),
                    ("postwave_app", "status"): frozenset({"UPDATE"}),
                    ("postwave_app", "updated_at"): frozenset({"UPDATE"}),
                },
                "referral_code_tokens": {
                    ("postwave_referral_code_definer", "tenant_id"): frozenset({"SELECT WITH GRANT OPTION"}),
                },
            },
        )
        # The register spelling flattens to the same shape, and an empty
        # grant is no grant.
        self.assertEqual(
            schema.flatten_acl(
                {
                    "postwave_app": schema.grant(
                        "INSERT", "SELECT", columns=schema.on_columns({"UPDATE"}, "status", "updated_at")
                    ),
                    "postwave_ops": schema.grant(columns={"notifier_email": frozenset()}),
                }
            ),
            schema.parse_acl_rows(rows[:4])["content_reports"],
        )
        with self.assertRaises(RuntimeError):
            schema.flatten_acl({"postwave_app": schema.grant(columns={"": frozenset({"UPDATE"})})})


class PublicGrants(unittest.TestCase):
    def test_public_grants_are_rejected_on_every_tenant_table(self):
        # Not only on the nullable exceptions: a PUBLIC column grant on an
        # ordinary tenant table is as much a grant as a table-level one.
        for item, listed in (
            (facts("campaign_assurance_findings", public_privileges="SELECT(tenant_id)"), "SELECT(tenant_id)"),
            (facts("subscribers", public_privileges="SELECT"), "SELECT"),
        ):
            with self.subTest(table=item.name):
                self.assertEqual(
                    errors_for(item), [f"{item.name} grants privileges to PUBLIC: {listed}"]
                )
        self.assertEqual(errors_for(facts("subscribers")), [])


class NegativeSelfTest(unittest.TestCase):
    """The database-backed negative self-test's harness; the changes themselves run in CI's Go job."""

    def test_a_session_query_runs_inside_a_transaction_that_is_rolled_back(self):
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, stdout="t\tx\n", stderr="")

        original = schema.subprocess.run
        schema.subprocess.run = fake_run
        try:
            rows = schema.run_query(schema.Session("postgres://db", "GRANT X"), "SELECT 1")
            plain = schema.run_query("postgres://db", "SELECT 2")
        finally:
            schema.subprocess.run = original
        self.assertEqual(rows, [["t", "x"]])
        self.assertEqual(plain, [["t", "x"]])
        session_args, plain_args = calls
        commands = [session_args[i + 1] for i, arg in enumerate(session_args) if arg == "-c"]
        self.assertEqual(
            commands,
            [
                "BEGIN",
                "SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '60s'",
                "GRANT X",
                "SELECT 1",
                "ROLLBACK",
            ],
        )
        self.assertIn("-q", session_args)
        self.assertIn("ON_ERROR_STOP=1", session_args)
        self.assertFalse(any("COMMIT" in arg for arg in session_args))
        self.assertEqual([plain_args[i + 1] for i, arg in enumerate(plain_args) if arg == "-c"], ["SELECT 2"])

    def test_cases_are_distinct_and_each_names_what_must_be_said(self):
        cases = schema.negative_cases("audit_log_p2026_10")
        # Exact, so dropping a case (and the query path it guards) fails here.
        self.assertEqual(
            [case.change for case in cases],
            [
                "a column UPDATE grant to postwave_app on a worker-capability table",
                "a column UPDATE grant to postwave_app on the immutable raw-output write receipts",
                "SELECT WITH GRANT OPTION, which would let postwave_app re-grant SELECT",
                "TRUNCATE and a column UPDATE for the referral registry definer",
                "an UPDATE grant on a DSA notice's evidence column",
                "a table-level UPDATE grant on content_reports",
                "a column grant to a role outside a nullable exception's reviewed ACL",
                "a PUBLIC column grant on an ordinary tenant table",
                "a PUBLIC read policy on a worker-capability table",
                "a widened predicate on a reviewed worker policy",
                "a direct tenant_id FK to tenants on a parent-bound table",
                "an FK to tenants from another column of a parent-bound table",
                "a parent binding FK that is not validated",
                "a parent binding FK that no longer cascades",
                "a nullable column in a parent binding FK",
                "a widened delete gate on the audit log",
                "a nullable exception comment that no longer names its reviewed category",
                "a DSA notice's tenant FK that cascades instead of setting NULL",
                "a NOT VALID tenant FK on a DSA notice",
                "a direct tenant FK that no longer cascades",
                "a direct tenant FK that is not validated",
                "a nullable tenant_id outside the nullable exception register",
                "row-level security no longer forced on an ordinary tenant table",
                "row-level security disabled on an ordinary tenant table",
                "an ordinary tenant table whose policies no longer read app.tenant_id",
                "an ordinary tenant table with row-level security and no policy",
                "a direct DELETE grant on an audit partition, without its delete gate",
                "a column SELECT grant on an audit partition without RLS",
                "a PUBLIC column grant on an audit partition",
            ],
        )
        self.assertEqual(len({case.prelude for case in cases}), len(cases))
        for case in cases:
            with self.subTest(change=case.change):
                self.assertTrue(case.expected)
                self.assertNotIn("COMMIT", case.prelude.upper())
                # Objects a case creates are named so that no real object can
                # collide with them. The one exception is a real constraint
                # the same case drops first and re-adds, weakened, under its
                # own name, which the ledger and the registers look up.
                redefined = set(
                    re.findall(
                        r"DROP CONSTRAINT %I', '[a-z_]+', '([a-z_]+)'\);\s+"
                        r"EXECUTE format\('ALTER TABLE public\.%I ADD CONSTRAINT %I ', '[a-z_]+', '\1'\)",
                        case.prelude,
                    )
                )
                for created in re.findall(
                    r"\b(?:CREATE POLICY|ADD CONSTRAINT|ADD COLUMN)\s+([a-z_]+)", case.prelude
                ):
                    self.assertTrue(created.startswith("lint_negative_"), created)
                for created in re.findall(r"ADD CONSTRAINT %I ', '[a-z_]+', '([a-z_]+)'", case.prelude):
                    self.assertIn(created, redefined, "a re-added constraint must replace the one dropped")
        # Every verifier path the finding named has a case.
        preludes = " ".join(case.prelude for case in cases)
        for needle in (
            "GRANT UPDATE (tenant_id) ON public.deliverability_degradation_claims",
            "TO postwave_referral_code_definer",
            "TO PUBLIC USING (true)",
            "FOREIGN KEY (tenant_id) REFERENCES public.tenants",
            "FOREIGN KEY (lint_negative_owner) REFERENCES public.tenants",
            "'campaign_assurance_findings_target_fk'",
            "ALTER COLUMN run_id DROP NOT NULL",
            "ALTER POLICY audit_log_trim_worker_only ON public.audit_log",
            "COMMENT ON COLUMN public.content_reports.tenant_id",
            "'content_reports_tenant_id_fkey'",
            "'campaigns_tenant_id_fkey'",
            "ALTER TABLE public.campaigns ALTER COLUMN tenant_id DROP NOT NULL",
            "ALTER TABLE public.campaigns NO FORCE ROW LEVEL SECURITY",
            "ALTER TABLE public.campaigns DISABLE ROW LEVEL SECURITY",
            "CREATE POLICY lint_negative_unbound ON public.campaign_recipients USING (true) WITH CHECK (true)",
            "GRANT DELETE ON public.audit_log_p2026_10",
            "GRANT SELECT (tenant_id) ON public.audit_log_p2026_10 TO postwave_app",
        ):
            self.assertIn(needle, preludes)

    def test_a_weakened_constraint_keeps_its_name_and_fails_if_its_definition_moved(self):
        sql = schema.redefine_constraint_sql(
            "content_reports",
            "content_reports_tenant_id_fkey",
            (("ON DELETE SET NULL", "ON DELETE CASCADE"),),
            " NOT VALID",
        )
        self.assertTrue(sql.startswith("DO $lint_negative$"))
        self.assertIn(
            "WHERE conrelid = 'public.content_reports'::regclass AND conname = 'content_reports_tenant_id_fkey'",
            sql,
        )
        # A definition that no longer contains the text to edit would re-add
        # the constraint unchanged and "prove" nothing, so the block raises.
        self.assertIn("IF strpos(definition, 'ON DELETE SET NULL') = 0 THEN", sql)
        self.assertIn(
            "EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', 'content_reports', "
            "'content_reports_tenant_id_fkey');",
            sql,
        )
        self.assertIn(
            "EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I ', 'content_reports', "
            "'content_reports_tenant_id_fkey')\n        || pg_catalog.replace(definition, "
            "'ON DELETE SET NULL', 'ON DELETE CASCADE') || ' NOT VALID';",
            sql,
        )
        unchanged = schema.redefine_constraint_sql("t", "c", (), " NOT VALID")
        self.assertIn("IF false THEN", unchanged)
        self.assertIn("|| definition || ' NOT VALID';", unchanged)
        self.assertNotIn("COMMIT", sql.upper())

    def test_an_unrejected_change_is_reported_per_missing_message(self):
        case = schema.NegativeCase("a change", "GRANT X", ("first message", "second message"))
        self.assertEqual(schema.negative_case_problems(case, ["... first message ..."]), [
            "negative self-test: the verifier accepted a change; no error contained 'second message'"
        ])
        self.assertEqual(schema.negative_case_problems(case, ["first message", "second message"]), [])
        self.assertEqual(len(schema.negative_case_problems(case, [])), 2)

    def test_case_messages_match_what_the_rules_say(self):
        # The same catalog shapes the database cases create, fed to the pure
        # rules, must produce each case's expected text. A reworded error then
        # fails here, before CI's database run.
        cases = {case.change: case for case in schema.negative_cases("audit_log_p2026_10")}

        def must_say(change: str, errors: list[str]) -> None:
            self.assertEqual(schema.negative_case_problems(cases[change], errors), [], errors)

        claims = "deliverability_degradation_claims"
        must_say(
            "a column UPDATE grant to postwave_app on a worker-capability table",
            errors_for(
                scope_facts(claims),
                policies=scope_policies(claims),
                acls=acl_with(claims, {("postwave_app", "tenant_id"): {"UPDATE"}}),
            ),
        )
        must_say(
            "a table-level UPDATE grant on content_reports",
            errors_for(
                nullable_facts("content_reports", privileges={"INSERT", "SELECT", "UPDATE"}),
                acls=acl_with("content_reports", {("postwave_app", ""): {"INSERT", "SELECT", "UPDATE"}}),
            ),
        )
        must_say(
            "a PUBLIC column grant on an ordinary tenant table",
            errors_for(facts("campaign_assurance_findings", public_privileges="SELECT(tenant_id)")),
        )
        targets = table("campaign_assurance_run_targets", direct=1)
        for change, findings in (
            ("a direct tenant_id FK to tenants on a parent-bound table", table(
                "campaign_assurance_findings", direct=1, cascade=0
            )),
            ("an FK to tenants from another column of a parent-bound table", table(
                "campaign_assurance_findings", other=1
            )),
        ):
            with self.subTest(change=change):
                graph = build_graph(
                    [targets, findings],
                    [
                        edge(
                            "campaign_assurance_findings",
                            "campaign_assurance_findings_target_fk",
                            "campaign_assurance_run_targets",
                            [("tenant_id", True, "tenant_id"), ("target_id", True, "id")],
                        )
                    ],
                )
                errors = schema.transitive_fk_check_errors(
                    {
                        "kind": "tenant_fk_transitive_cascade",
                        "table": "campaign_assurance_findings",
                        "constraint": "campaign_assurance_findings_target_fk",
                        "parent": "campaign_assurance_run_targets",
                    },
                    graph,
                )
                ownership = schema.tenant_ownership_error(findings, graph)
                must_say(change, errors + ([ownership] if ownership else []))
        # The weakened parent binding: the findings table keeps no tenants FK,
        # and its binding FK loses validation, its cascade or a NOT NULL key
        # column.
        findings = table("campaign_assurance_findings")
        binding_key = [
            ("tenant_id", True, "tenant_id"),
            ("campaign_id", True, "campaign_id"),
            ("run_id", True, "run_id"),
        ]
        for change, weakened in (
            (
                "a parent binding FK that is not validated",
                dict(validated=False, columns=binding_key),
            ),
            (
                "a parent binding FK that no longer cascades",
                dict(action="r", columns=binding_key),
            ),
            (
                "a nullable column in a parent binding FK",
                dict(columns=[binding_key[0], binding_key[1], ("run_id", False, "run_id")]),
            ),
        ):
            with self.subTest(change=change):
                columns = weakened.pop("columns")
                graph = build_graph(
                    [targets, findings],
                    [
                        edge(
                            "campaign_assurance_findings",
                            "campaign_assurance_findings_target_fk",
                            "campaign_assurance_run_targets",
                            columns,
                            **weakened,
                        )
                    ],
                )
                errors = schema.transitive_fk_check_errors(
                    {
                        "kind": "tenant_fk_transitive_cascade",
                        "table": "campaign_assurance_findings",
                        "constraint": "campaign_assurance_findings_target_fk",
                        "parent": "campaign_assurance_run_targets",
                    },
                    graph,
                )
                ownership = schema.tenant_ownership_error(findings, graph)
                self.assertIsNotNone(ownership)
                must_say(change, errors + [ownership])
        widened_gate = audit_gates()
        widened_gate["audit_log"]["audit_log_trim_worker_only"] = schema.delete_gate_policy(
            "app.audit_trim_worker"
        )._replace(using="true")
        must_say(
            "a widened delete gate on the audit log",
            errors_for(nullable_facts("audit_log"), policies=widened_gate),
        )
        must_say(
            "a nullable exception comment that no longer names its reviewed category",
            errors_for(
                nullable_facts(
                    "content_reports", comment="postwave:tenant-scope-exception=unresolved-public-ingest"
                )
            ),
        )
        must_say(
            "a DSA notice's tenant FK that cascades instead of setting NULL",
            errors_for(nullable_facts("content_reports", set_null_count=0, cascade_count=1)),
        )
        # The main scan's own facts. A NOT VALID or non-cascading direct FK is
        # still a tenant FK, but not a validated cascade (or set null) one.
        must_say(
            "a NOT VALID tenant FK on a DSA notice",
            errors_for(nullable_facts("content_reports", set_null_count=0)),
        )
        for change in ("a direct tenant FK that no longer cascades", "a direct tenant FK that is not validated"):
            with self.subTest(change=change):
                must_say(change, errors_for(facts("campaigns", tenant_fk_count=1, cascade_count=0)))
        must_say(
            "a nullable tenant_id outside the nullable exception register",
            errors_for(facts("campaigns", not_null=False)),
        )
        must_say(
            "row-level security no longer forced on an ordinary tenant table",
            errors_for(facts("campaigns", forced=False)),
        )
        must_say(
            "row-level security disabled on an ordinary tenant table",
            errors_for(facts("campaigns", rls=False)),
        )
        must_say(
            "an ordinary tenant table whose policies no longer read app.tenant_id",
            errors_for(facts("campaign_recipients", policy_count=1, tenant_policy_count=0)),
        )
        must_say(
            "an ordinary tenant table with row-level security and no policy",
            errors_for(facts("campaign_recipients", policy_count=0, tenant_policy_count=0)),
        )
        delete_case = cases["a direct DELETE grant on an audit partition, without its delete gate"]
        gate = schema.partition_delete_gate_error("audit_log_p2026_10", "audit_log", {"DELETE"})
        self.assertIn(delete_case.expected[0], gate)


def main() -> int:
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        return 1
    if result.testsRun < MINIMUM_TESTS or result.skipped:
        print(
            f"FAIL: expected at least {MINIMUM_TESTS} tenant-binding tests and no skips; "
            f"ran {result.testsRun}, skipped {len(result.skipped)}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
