// SPDX-License-Identifier: AGPL-3.0-only

// Package tenantbindingproof proves, against the migrated database, that rows
// bound to their tenant through a parent row leave with the tenant, and that
// the referral registry stays bound to its referral code (migrations 2046 and
// 2047). It holds no production code.
//
// Each proof builds its rows in one transaction on the administrative
// connection and rolls it back. CI runs every package in parallel against one
// database, and several workers claim rows across tenants, so the proof's rows
// must never be visible to another session. A failed proof leaves nothing
// behind either.
package tenantbindingproof

import (
	"context"
	"crypto/rand"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type proofDatabase struct {
	admin   *pgxpool.Pool
	appRole string
}

// openProofDatabase connects as the administrative role, which builds rows in
// row-level-security-forced tables, and records the application role, which
// runs the statements under proof.
func openProofDatabase(t *testing.T, ctx context.Context) proofDatabase {
	t.Helper()
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if appURL == "" || adminURL == "" {
		t.Skip("DATABASE_URL (the application role) and POSTWAVE_TEST_ADMIN_DATABASE_URL are not set")
	}

	appPool, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect as the application role: %v", err)
	}
	var appRole string
	var appBypassesRLS bool
	err = appPool.QueryRow(ctx, `
SELECT current_user, rolsuper OR rolbypassrls
  FROM pg_catalog.pg_roles
 WHERE rolname = current_user`).Scan(&appRole, &appBypassesRLS)
	appPool.Close()
	if err != nil {
		t.Fatalf("inspect the application role: %v", err)
	}
	if appBypassesRLS {
		t.Skipf("DATABASE_URL must name the non-bypass application role; it connects as %q, which bypasses row-level security", appRole)
	}

	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect as the administrative role: %v", err)
	}
	t.Cleanup(admin.Close)
	var adminBypassesRLS bool
	if err = admin.QueryRow(ctx, `
SELECT rolsuper OR rolbypassrls
  FROM pg_catalog.pg_roles
 WHERE rolname = current_user`).Scan(&adminBypassesRLS); err != nil {
		t.Fatalf("inspect the administrative role: %v", err)
	}
	if !adminBypassesRLS {
		t.Fatal("POSTWAVE_TEST_ADMIN_DATABASE_URL must connect as a role that bypasses row-level security; " +
			"the proofs build rows in tables that force it")
	}
	return proofDatabase{admin: admin, appRole: appRole}
}

// begin opens the proof's transaction. The caller rolls it back.
func (db proofDatabase) begin(t *testing.T, ctx context.Context) pgx.Tx {
	t.Helper()
	tx, err := db.admin.Begin(ctx)
	if err != nil {
		t.Fatalf("begin the proof transaction: %v", err)
	}
	// A proof that queues behind another test's lock fails with a lock
	// timeout, well inside the test's deadline, instead of hanging.
	if _, err = tx.Exec(ctx, `SET LOCAL lock_timeout = '30s'`); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("bound lock waits: %v", err)
	}
	return tx
}

// actAsApplication runs the next statements as the application role, bound to
// tenantID and to no other scope, the way a tenant request runs.
func (db proofDatabase) actAsApplication(t *testing.T, ctx context.Context, tx pgx.Tx, tenantID string) {
	t.Helper()
	run(t, ctx, tx,
		statement{"drop the fixture's worker scope", `SELECT set_config('app.outbox_worker', '', true)`, nil},
		statement{"drop the fixture's acting user", `SELECT set_config('app.user_id', '', true)`, nil},
		statement{"become the application role", `SET LOCAL ROLE ` + pgx.Identifier{db.appRole}.Sanitize(), nil},
		statement{"bind the tenant", `SELECT set_config('app.tenant_id', $1, true)`, []any{tenantID}},
	)
}

type statement struct {
	step string
	sql  string
	args []any
}

func run(t *testing.T, ctx context.Context, tx pgx.Tx, statements ...statement) {
	t.Helper()
	for _, item := range statements {
		if _, err := tx.Exec(ctx, item.sql, item.args...); err != nil {
			t.Fatalf("%s: %v", item.step, err)
		}
	}
}

func count(t *testing.T, ctx context.Context, tx pgx.Tx, table, tenantID string) int {
	t.Helper()
	var rows int
	if err := tx.QueryRow(ctx,
		`SELECT count(*)::integer FROM `+pgx.Identifier{"public", table}.Sanitize()+` WHERE tenant_id = $1::uuid`,
		tenantID,
	).Scan(&rows); err != nil {
		t.Fatalf("count %s rows: %v", table, err)
	}
	return rows
}

// referralCode returns a random code in the shape referral_codes accepts.
func referralCode(t *testing.T) string {
	t.Helper()
	const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		t.Fatalf("random referral code: %v", err)
	}
	code := make([]byte, len(random))
	for index, value := range random {
		code[index] = alphabet[int(value)%len(alphabet)]
	}
	return string(code)
}

// parentBoundTables lists every logical table whose NOT NULL tenant_id has no
// FK to tenants. scripts/lint-migrations-schema.py accepts such a table only
// when it is bound through a parent, so these are the tables tenant deletion
// reaches only through a parent's cascade.
func parentBoundTables(t *testing.T, ctx context.Context, tx pgx.Tx) []string {
	t.Helper()
	rows, err := tx.Query(ctx, `
SELECT table_class.relname::text
  FROM pg_catalog.pg_class AS table_class
  JOIN pg_catalog.pg_attribute AS tenant_column
    ON tenant_column.attrelid = table_class.oid
   AND tenant_column.attname = 'tenant_id'
   AND tenant_column.attnotnull
   AND NOT tenant_column.attisdropped
 WHERE table_class.relnamespace = 'public'::regnamespace
   AND table_class.relkind IN ('r', 'p')
   AND NOT table_class.relispartition
   AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS tenant_fk
        WHERE tenant_fk.conrelid = table_class.oid
          AND tenant_fk.contype = 'f'
          AND tenant_fk.confrelid = 'public.tenants'::regclass
   )
 ORDER BY 1`)
	if err != nil {
		t.Fatalf("list parent-bound tables: %v", err)
	}
	tables, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatalf("read parent-bound tables: %v", err)
	}
	return tables
}

// TestDeletingATenantRemovesItsParentBoundEvidence_DB builds a tenant that owns
// a row in every table bound to its tenant through a parent, deletes the
// tenant as the application role, and requires the delete to succeed and to
// take every one of those rows.
//
// Eleven of those tables carry a DELETE guard that admits a delete only once
// its root row (the assurance run, the campaign or the ai-regression run) is
// gone. Migration 2045 gave them a second, direct FK to tenants, which put
// them on the first cascade level beside their root. PostgreSQL runs that
// level's RI triggers in name order, which follows OID digits, so on a
// database where a 2045 trigger sorted before its root's the delete failed
// with SQLSTATE 55000. Migration 2046 dropped those FKs. This test reproduces
// the failure when the direct FKs come back and their triggers fire first.
func TestDeletingATenantRemovesItsParentBoundEvidence_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openProofDatabase(t, ctx)
	tx := db.begin(t, ctx)
	defer func() { _ = tx.Rollback(context.Background()) }()

	var (
		tenant, owner, campaign, revision  = uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
		plan, artifact, assuranceRun       = uuid.NewString(), uuid.NewString(), uuid.NewString()
		claim, mimeExtraction, modeled     = uuid.NewString(), uuid.NewString(), uuid.NewString()
		finding, override, delivery        = uuid.NewString(), uuid.NewString(), uuid.NewString()
		deliveryClaim, regressionRun       = uuid.NewString(), uuid.NewString()
		goldenExample, automation, contact = uuid.NewString(), uuid.NewString(), uuid.NewString()
		referral                           = uuid.NewString()
		suffix                             = strings.ReplaceAll(tenant, "-", "")[:16]
	)

	// The campaign, its frozen send plan and one rendered artifact.
	run(t, ctx, tx,
		statement{"insert the tenant", `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, []any{tenant, "tenant-binding-proof-" + suffix, "Tenant binding proof " + suffix}},
		statement{"insert the tenant owner", `
INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2::uuid, $3, $4, 'owner')`, []any{owner, tenant, "tenant-binding-owner-" + suffix, "tenant-binding-owner-" + suffix + "@example.test"}},
		statement{"insert the campaign", `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html)
VALUES ($1::uuid, $2::uuid, 'Tenant binding proof', 'Launch Friday', '<p>Launch Friday</p>')`, []any{campaign, tenant}},
		statement{"insert the content revision", `
INSERT INTO campaign_content_revisions (
    id, tenant_id, campaign_id, revision_no, source_mode, content_schema_version, subject,
    semantic_tree, legacy_html, fact_contract, variants, locales, source_hash
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, 1, 'legacy_html', 1, 'Launch Friday',
    '[]'::jsonb, '<p>Launch Friday</p>', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, repeat('1', 64)
)`, []any{revision, tenant, campaign}},
		statement{"insert the send plan", `
INSERT INTO campaign_send_plans (
    id, tenant_id, campaign_id, content_revision_id, plan_no, request_id, request_hash,
    renderer_version, compiler_version, transform_manifest, coverage_manifest,
    fixture_set_version, policy_version, state
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, gen_random_uuid(), repeat('2', 64),
    'renderer-v1', 'compiler-v1', '{}'::jsonb, '{"scenarios":["base"]}'::jsonb,
    'fixtures-v1', 'plan-policy-v1', 'preparing'
)`, []any{plan, tenant, campaign, revision}},
		statement{"insert the rendered artifact", `
INSERT INTO campaign_render_artifacts (
    id, tenant_id, campaign_id, send_plan_id, scenario_id, locale, branch_key, fixture_id,
    source_hash, html_hash, text_hash, mime_structure_hash, outbound_mime_hash,
    compiler_receipt, representation_manifest
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'base', 'en-US', 'default', 'fixture-base',
    repeat('1', 64), repeat('3', 64), repeat('4', 64), repeat('5', 64), repeat('6', 64),
    '{}'::jsonb, '{}'::jsonb
)`, []any{artifact, tenant, campaign, plan}},
		statement{"freeze the send plan", `
UPDATE campaign_send_plans
   SET state = 'ready', plan_hash = repeat('b', 64), ready_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, []any{tenant, plan}},
	)

	// An assurance run through its lifecycle, as campaignassurance.Repo drives
	// it: queued and unfrozen, frozen over one deterministic and one modeled
	// target, claimed by a worker that reserves and settles a model
	// invocation and records both extractions and a blocking finding, then
	// completed with a blocked gate that the tenant owner overrides. Every
	// insert and transition passes the tables' own guards.
	run(t, ctx, tx,
		statement{"create the queued assurance run", `
INSERT INTO campaign_assurance_runs (
    id, tenant_id, campaign_id, content_revision_id, send_plan_id, run_no,
    request_id, request_hash, trigger_kind, profile,
    source_hash, plan_hash, coverage_manifest_hash,
    renderer_version, compiler_version, fixture_set_version, plan_policy_version,
    analyzer_suite_version, model_suite_version, prompt_suite_version,
    prompt_suite_hash, normalization_version, scoring_version,
    gate_policy_version, methodology_version,
    required_scenario_count, required_configuration_count,
    required_extraction_count, max_attempts, max_modeled_cost_microunits, created_by
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1,
    gen_random_uuid(), repeat('7', 64), 'queue', 'fast',
    repeat('1', 64), repeat('b', 64), repeat('8', 64),
    'renderer-v1', 'compiler-v1', 'fixtures-v1', 'plan-policy-v1',
    'tenant-binding-proof-v1', 'model-suite-v1', 'prompt-suite-v1',
    repeat('9', 64), 'normalization-v1', 'score-v1',
    'gate-v1', 'methodology-v1',
    1, 2, 2, 1, 1000, $6::uuid
)`, []any{assuranceRun, tenant, campaign, revision, plan, owner}},
		statement{"snapshot the run's artifact", `
INSERT INTO campaign_assurance_run_artifacts (
    tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
    ordinal, scenario_id, outbound_mime_hash, mime_structure_hash
)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, 'base', repeat('6', 64), repeat('5', 64))`,
			[]any{tenant, campaign, assuranceRun, plan, artifact}},
		statement{"snapshot the run's configurations", `
INSERT INTO campaign_assurance_run_configurations (
    tenant_id, campaign_id, run_id, ordinal, configuration_id,
    source_class, configuration_hash, configuration
)
VALUES
    ($1::uuid, $2::uuid, $3::uuid, 1, 'deterministic.mime', 'deterministic', repeat('c', 64),
     '{"checks":["mime"]}'::jsonb),
    ($1::uuid, $2::uuid, $3::uuid, 2, 'model.primary', 'modeled', repeat('d', 64),
     '{"maximum_cost_microunits":1000}'::jsonb)`, []any{tenant, campaign, assuranceRun}},
		statement{"snapshot the run's targets", `
INSERT INTO campaign_assurance_run_targets (
    tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
    configuration_id, ordinal, source_class, configuration_hash, outbound_mime_hash
)
VALUES
    ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
     'deterministic.mime', 1, 'deterministic', repeat('c', 64), repeat('6', 64)),
    ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
     'model.primary', 2, 'modeled', repeat('d', 64), repeat('6', 64))`,
			[]any{tenant, campaign, assuranceRun, plan, artifact}},
		statement{"freeze the run's snapshot", `
UPDATE campaign_assurance_runs
   SET snapshot_frozen_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'queued' AND snapshot_frozen_at IS NULL`,
			[]any{tenant, assuranceRun}},
		statement{"enter worker scope", `SELECT set_config('app.outbox_worker', 'true', true)`, nil},
		statement{"claim the run", `
UPDATE campaign_assurance_runs
   SET state = 'running', claim_token = $3::uuid, lease_owner = 'tenant-binding-proof-worker',
       lease_expires_at = now() + interval '10 minutes', heartbeat_at = now(),
       attempt_count = attempt_count + 1, started_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'queued'`, []any{tenant, assuranceRun, claim}},
		statement{"reserve the model invocation", `
INSERT INTO campaign_assurance_model_invocation_reservations (
    tenant_id, campaign_id, run_id, attempt_count, claim_token, invocation_id,
    model_cache_key, model_input_manifest_hash, artifact_id, configuration_id,
    configuration_hash, outbound_mime_hash, reserved_microunits
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, 1, $4::uuid, repeat('e', 64),
    repeat('f', 64), repeat('a', 64), $5::uuid, 'model.primary',
    repeat('d', 64), repeat('6', 64), 1000
)`, []any{tenant, campaign, assuranceRun, claim, artifact}},
		statement{"settle the model invocation", `
INSERT INTO campaign_assurance_model_invocation_results (
    tenant_id, campaign_id, run_id, attempt_count, claim_token, invocation_id,
    status, input_tokens, output_tokens, cost_microunits, latency_ms, receipt_hash
)
VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4::uuid, repeat('e', 64), 'complete', 10, 5, 400, 3, repeat('0', 64))`,
			[]any{tenant, campaign, assuranceRun, claim}},
		statement{"record the deterministic extraction", `
INSERT INTO campaign_assurance_extractions (
    id, tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
    configuration_id, source_class, configuration_hash, outbound_mime_hash,
    attempt_count, claim_token, status, normalized_extraction,
    evidence_manifest, unsupported_claims, ambiguities, latency_ms, receipt_hash
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
    'deterministic.mime', 'deterministic', repeat('c', 64), repeat('6', 64),
    1, $7::uuid, 'complete', '{"summary":"Launch Friday"}'::jsonb,
    '{"representations":["mime"]}'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, repeat('1', 64)
)`, []any{mimeExtraction, tenant, campaign, assuranceRun, plan, artifact, claim}},
		statement{"record the modeled extraction", `
INSERT INTO campaign_assurance_extractions (
    id, tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
    configuration_id, source_class, configuration_hash, outbound_mime_hash,
    attempt_count, claim_token, status, normalized_extraction,
    evidence_manifest, unsupported_claims, ambiguities,
    model_provider, model_id, model_version, prompt_version, prompt_hash,
    input_tokens, output_tokens, cost_microunits, latency_ms, receipt_hash,
    model_cache_key, model_input_manifest_hash, model_invocation_id, execution_kind
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
    'model.primary', 'modeled', repeat('d', 64), repeat('6', 64),
    1, $7::uuid, 'complete', '{"summary":"Launch Friday"}'::jsonb,
    '{"representations":["html"]}'::jsonb, '[]'::jsonb, '[]'::jsonb,
    'google', 'gemini-3-flash', 'gemini-3-flash@release-a', 'prompt-v1', repeat('2', 64),
    10, 5, 400, 3, repeat('2', 64),
    repeat('f', 64), repeat('a', 64), repeat('e', 64), 'invoked'
)`, []any{modeled, tenant, campaign, assuranceRun, plan, artifact, claim}},
		statement{"record the blocking finding", `
INSERT INTO campaign_assurance_findings (
    id, tenant_id, campaign_id, run_id, send_plan_id, artifact_id,
    configuration_id, source_class, configuration_hash, outbound_mime_hash,
    attempt_count, claim_token, extraction_id, finding_key, receipt_hash, code, severity,
    blocking, overridable, dimension, block_references, evidence_references,
    explanation, remediation, detector_version, policy_version
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
    'deterministic.mime', 'deterministic', repeat('c', 64), repeat('6', 64),
    1, $7::uuid, $8::uuid, repeat('3', 64), repeat('4', 64), 'PRIMARY_ACTION_MISSING', 'critical',
    true, true, 'primary_action', '[]'::jsonb, '["mime"]'::jsonb,
    'The primary action is not recoverable from the compiled message.', '{"kind":"add_action"}'::jsonb,
    'detector-v1', 'gate-v1'
)`, []any{finding, tenant, campaign, assuranceRun, plan, artifact, claim, mimeExtraction}},
		statement{"complete the run with a blocked gate", `
UPDATE campaign_assurance_runs
   SET state = 'complete', claim_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
       heartbeat_at = NULL, component_scores = '{"deterministic":70}'::jsonb, overall_score = 70,
       score_min = 70, score_max = 70, score_spread = 0, agreement = 1,
       gate_decision = 'block', completed_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'running'`, []any{tenant, assuranceRun}},
		statement{"act as the tenant owner", `SELECT set_config('app.user_id', $1, true)`, []any{owner}},
		statement{"override the blocking finding", `
INSERT INTO campaign_assurance_overrides (
    id, tenant_id, campaign_id, run_id, attempt_count, finding_id, finding_receipt_hash,
    request_id, request_hash, artifact_set_hash, actor_id, actor_role, decision, reason
)
SELECT $1::uuid, runs.tenant_id, runs.campaign_id, runs.id, 1, $3::uuid, repeat('4', 64),
       gen_random_uuid(), repeat('5', 64), runs.artifact_set_hash, $4::uuid, 'owner',
       'allow_send', 'Waive the recoverable blocker for the tenant binding proof.'
  FROM campaign_assurance_runs AS runs
 WHERE runs.tenant_id = $2::uuid AND runs.id = $5::uuid`, []any{override, tenant, finding, owner, assuranceRun}},
		statement{"leave the owner's scope", `SELECT set_config('app.user_id', '', true)`, nil},
	)

	// A raw delivery under the overridden gate. Its insert trigger appends the
	// delivery's first event.
	var recipient int64
	if err := tx.QueryRow(ctx, `
INSERT INTO campaign_recipients (tenant_id, campaign_id, subscriber_email)
VALUES ($1::uuid, $2::uuid, $3)
RETURNING id`, tenant, campaign, "tenant-binding-recipient-"+suffix+"@example.test").Scan(&recipient); err != nil {
		t.Fatalf("insert the campaign recipient: %v", err)
	}
	run(t, ctx, tx,
		statement{"acquire the raw delivery", `
INSERT INTO campaign_send_deliveries (
    id, tenant_id, campaign_id, campaign_recipient_id, send_plan_id, artifact_id,
    assurance_run_id, assurance_attempt_count, artifact_set_hash, gate_decision,
    gate_override_id, gate_override_ids, scenario_id, source_hash, plan_hash,
    compiler_version, outbound_mime_hash, message_id, attempt_no, idempotency_key,
    request_hash, transport_name, transport_contract_version, capability_snapshot,
    claim_token, lease_owner, lease_expires_at, reply_to, reply_correlation_version,
    reply_correlation_key_id, reply_correlation_expires_at, reply_correlation_token_hash
)
SELECT $1::uuid, runs.tenant_id, runs.campaign_id, $2, runs.send_plan_id, $3::uuid,
       runs.id, runs.attempt_count, runs.artifact_set_hash, 'overridden',
       $4::uuid, ARRAY[$4::uuid], 'base', runs.source_hash, runs.plan_hash,
       runs.compiler_version, repeat('6', 64), $5, 1, $6,
       repeat('6', 64), 'ses_raw_v2', 'postwave.campaign-transport.v2',
       '{"contract_version":"postwave.campaign-transport.v2","provider_receipt":true,"raw_mime":true}'::jsonb,
       $7::uuid, 'tenant-binding-proof-sender', now() + interval '10 minutes',
       $8, 1, 'proof-k1', now() + interval '1 day', repeat('7', 64)
  FROM campaign_assurance_runs AS runs
 WHERE runs.tenant_id = $9::uuid AND runs.id = $10::uuid`, []any{
			delivery, recipient, artifact, override,
			"<tenant-binding-" + suffix + "@example.test>", "tenant-binding-proof:" + suffix,
			deliveryClaim, "r-tenant-binding-" + suffix + "@reply.example.test", tenant, assuranceRun,
		}},
		statement{"leave worker scope", `SELECT set_config('app.outbox_worker', '', true)`, nil},
	)

	// An ai-regression run with one frozen example, a lifecycle event with an
	// automation dispatch, and a referral code whose token the registry trigger
	// writes.
	run(t, ctx, tx,
		statement{"create the ai-regression run", `
INSERT INTO ai_regression_runs (id, tenant_id, model_id, model_version_tag, runtime_provider)
VALUES ($1::uuid, $2::uuid, 'gemini-3-flash', 'gemini-3-flash@release-a', 'google')`,
			[]any{regressionRun, tenant}},
		statement{"freeze an ai-regression example", `
INSERT INTO ai_regression_run_examples (
    tenant_id, run_id, example_id, ordinal, surface_kind, brief, approved_output,
    source_model_id, source_created_at
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, 1, 'subject_line', 'Write the frozen subject line',
    'Approved subject line', 'source-model-a', now()
)`, []any{tenant, regressionRun, goldenExample}},
		statement{"receive a lifecycle event", `
INSERT INTO automation_lifecycle_event_inbox (
    tenant_id, source_event_id, subscriber_key, transition_sequence, event_type,
    next_stage, score, transitioned_at, semantic_fingerprint
)
VALUES (
    $1::uuid, $2, $3::uuid, 1, 'subscriber_lifecycle_stage_changed',
    'lead', 3, now(), repeat('8', 64)
)`, []any{tenant, "tenant-binding-proof-" + suffix, contact}},
		statement{"dispatch the lifecycle event to an automation", `
INSERT INTO automation_lifecycle_event_dispatches (tenant_id, source_event_id, automation_id, trigger_type)
VALUES ($1::uuid, $2, $3::uuid, 'subscriber_lifecycle_stage_changed')`,
			[]any{tenant, "tenant-binding-proof-" + suffix, automation}},
		statement{"issue a referral code", `
INSERT INTO referral_codes (id, tenant_id, subscriber_id, code)
VALUES ($1::uuid, $2::uuid, $3, $4)`, []any{referral, tenant, "tenant-binding-proof-" + suffix, referralCode(t)}},
	)

	// The proof covers every table bound to its tenant through a parent; a
	// table added to that set without a row here fails the proof.
	bound := parentBoundTables(t, ctx, tx)
	if len(bound) == 0 {
		t.Fatal("found no table bound to its tenant through a parent; migration 2046 binds twelve and 2047 one")
	}
	for _, table := range bound {
		if count(t, ctx, tx, table, tenant) == 0 {
			t.Errorf("the tenant owns no row in %s, which is bound to its tenant through a parent; "+
				"extend this proof with one", table)
		}
	}
	if t.Failed() {
		t.FailNow()
	}

	// The production erasure statement: tenants.cascadeDelete ends with it,
	// as the application role bound to the tenant.
	db.actAsApplication(t, ctx, tx, tenant)
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenant)
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) {
			t.Fatalf("delete the tenant: SQLSTATE %s: %s (%s)", postgresError.Code, postgresError.Message, postgresError.Where)
		}
		t.Fatalf("delete the tenant: %v", err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("deleted %d tenant rows, want 1", tag.RowsAffected())
	}
	run(t, ctx, tx, statement{"return to the administrative role", `RESET ROLE`, nil})

	for _, table := range append(bound,
		"campaigns", "campaign_assurance_runs", "campaign_send_deliveries",
		"ai_regression_runs", "automation_lifecycle_event_inbox", "referral_codes",
	) {
		if remaining := count(t, ctx, tx, table, tenant); remaining != 0 {
			t.Errorf("%d %s rows outlived their tenant", remaining, table)
		}
	}
}

// TestReferralRegistryStaysBoundToItsCode_DB proves migration 2047's binding:
// a registry row cannot name another tenant than its referral code's, the
// code's id cannot change, and a change of the code's tenant carries the
// registry along.
func TestReferralRegistryStaysBoundToItsCode_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db := openProofDatabase(t, ctx)
	tx := db.begin(t, ctx)
	defer func() { _ = tx.Rollback(context.Background()) }()

	tenantA, tenantB, referral := uuid.NewString(), uuid.NewString(), uuid.NewString()
	suffix := strings.ReplaceAll(tenantA, "-", "")[:16]
	code := referralCode(t)
	run(t, ctx, tx,
		statement{"insert tenant A", `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, $3, 'studio')`,
			[]any{tenantA, "referral-binding-a-" + suffix, "Referral binding A " + suffix}},
		statement{"insert tenant B", `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, $3, 'studio')`,
			[]any{tenantB, "referral-binding-b-" + suffix, "Referral binding B " + suffix}},
		statement{"issue tenant A's referral code", `
INSERT INTO referral_codes (id, tenant_id, subscriber_id, code)
VALUES ($1::uuid, $2::uuid, $3, $4)`, []any{referral, tenantA, "referral-binding-" + suffix, code}},
	)

	registry := func() (tenants []string) {
		t.Helper()
		rows, err := tx.Query(ctx, `
SELECT tenant_id::text
  FROM referral_code_tokens
 WHERE referral_code_id = $1::uuid
 ORDER BY token_kind`, referral)
		if err != nil {
			t.Fatalf("read the registry: %v", err)
		}
		tenants, err = pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			t.Fatalf("read the registry: %v", err)
		}
		return tenants
	}
	if got := registry(); len(got) != 1 || got[0] != tenantA {
		t.Fatalf("registry rows for the new code name tenants %v, want [%s]", got, tenantA)
	}

	// Each refused statement runs in a savepoint so the proof can go on.
	refused := func(step, wantState, wantConstraint, sql string, args ...any) {
		t.Helper()
		run(t, ctx, tx, statement{"savepoint before " + step, `SAVEPOINT refused`, nil})
		_, err := tx.Exec(ctx, sql, args...)
		var postgresError *pgconn.PgError
		if !errors.As(err, &postgresError) || postgresError.Code != wantState ||
			(wantConstraint != "" && postgresError.ConstraintName != wantConstraint) {
			t.Fatalf("%s: error %v, want SQLSTATE %s (constraint %q)", step, err, wantState, wantConstraint)
		}
		run(t, ctx, tx, statement{"roll back " + step, `ROLLBACK TO SAVEPOINT refused`, nil})
	}

	// The definer-owned trigger is the registry's only writer, but the FK
	// holds whoever writes: a row naming tenant B for tenant A's code fails.
	refused("register tenant A's code under tenant B", "23503", "referral_code_tokens_referral_code_tenant_fkey", `
INSERT INTO referral_code_tokens (token, referral_code_id, tenant_id, subscriber_id, token_kind)
VALUES ($1, $2::uuid, $3::uuid, $4, 'desired')`, "binding-"+code, referral, tenantB, "referral-binding-"+suffix)

	// A tenant session cannot move the code to a new id and drag the
	// registry with it through the FK's ON UPDATE CASCADE.
	db.actAsApplication(t, ctx, tx, tenantA)
	refused("change the referral code's id", "55000", "", `
UPDATE referral_codes SET id = gen_random_uuid() WHERE id = $1::uuid`, referral)
	run(t, ctx, tx, statement{"return to the administrative role", `RESET ROLE`, nil})
	if got := registry(); len(got) != 1 || got[0] != tenantA {
		t.Fatalf("after the refused id change the registry names tenants %v, want [%s]", got, tenantA)
	}

	// Moving the code to tenant B moves its registry rows with it.
	run(t, ctx, tx, statement{"move the referral code to tenant B", `
UPDATE referral_codes SET tenant_id = $2::uuid WHERE id = $1::uuid`, []any{referral, tenantB}})
	if got := registry(); len(got) != 1 || got[0] != tenantB {
		t.Fatalf("after the tenant change the registry names tenants %v, want [%s]", got, tenantB)
	}

	// And the registry leaves with the tenant that now owns the code.
	run(t, ctx, tx, statement{"delete tenant B", `DELETE FROM tenants WHERE id = $1::uuid`, []any{tenantB}})
	if got := registry(); len(got) != 0 {
		t.Fatalf("registry rows outlived their tenant: %v", got)
	}
}
