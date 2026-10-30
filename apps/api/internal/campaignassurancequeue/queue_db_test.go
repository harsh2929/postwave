// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancequeue

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignassuranceapi"
)

func queueDBPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_QUEUE_TEST_DATABASE_URL"))
	if url == "" {
		t.Skip("POSTWAVE_ASSURANCE_QUEUE_TEST_DATABASE_URL is required for command queue DB proof")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var ready bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.campaign_assurance_commands') IS NOT NULL
   AND to_regclass('public.campaign_assurance_runs') IS NOT NULL`).Scan(&ready); err != nil || !ready {
		t.Fatalf("migration 1925 is not ready: ready=%v err=%v", ready, err)
	}
	return pool
}

func TestDurableCommandQueueLeaseVisibilityAndTenantFences_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool := queueDBPool(t, ctx)
	tenantID, campaignID := uuid.NewString(), uuid.NewString()
	revisionID, planID, artifactID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, _ = pool.Exec(cleanup, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	suffix := strings.ReplaceAll(tenantID, "-", "")[:16]
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Assurance queue proof', 'studio')`, []any{tenantID, "assurance-queue-" + suffix}},
		{`INSERT INTO campaigns (id, tenant_id, name, subject, body_html)
VALUES ($1::uuid, $2::uuid, 'Assurance queue proof', 'Proof', '<p>Proof</p>')`, []any{campaignID, tenantID}},
		{`INSERT INTO campaign_content_revisions (
    id, tenant_id, campaign_id, revision_no, source_mode,
    content_schema_version, subject, semantic_tree, legacy_html,
    fact_contract, variants, locales, source_hash
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, 1, 'legacy_html',
    1, 'Proof', '[]'::jsonb, '<p>Proof</p>',
    '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, repeat('1', 64)
)`, []any{revisionID, tenantID, campaignID}},
		{`INSERT INTO campaign_send_plans (
    id, tenant_id, campaign_id, content_revision_id, plan_no,
    request_id, request_hash, renderer_version, compiler_version,
    transform_manifest, coverage_manifest, fixture_set_version,
    policy_version, state
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1,
    gen_random_uuid(), repeat('2', 64), 'renderer-v1', 'compiler-v1',
    '{}'::jsonb, '{"scenarios":["base"]}'::jsonb,
    'fixtures-v1', 'plan-policy-v1', 'preparing'
)`, []any{planID, tenantID, campaignID, revisionID}},
		{`INSERT INTO campaign_render_artifacts (
    id, tenant_id, campaign_id, send_plan_id, scenario_id,
    locale, branch_key, fixture_id, source_hash, html_hash, text_hash,
    mime_structure_hash, outbound_mime_hash, compiler_receipt,
    representation_manifest
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'base',
    'en-US', 'default', 'fixture-base', repeat('1', 64), repeat('3', 64),
    repeat('4', 64), repeat('5', 64), repeat('6', 64), '{}'::jsonb, '{}'::jsonb
)`, []any{artifactID, tenantID, campaignID, planID}},
		{`UPDATE campaign_send_plans
   SET state = 'ready', plan_hash = repeat('b', 64), ready_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, []any{tenantID, planID}},
	}
	for index, statement := range statements {
		if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("seed statement %d: %v", index+1, err)
		}
	}
	requestID := uuid.NewString()
	run, err := campaignassurance.NewRepo(pool).CreateRun(ctx, tenantID, campaignassurance.CreateRunInput{
		CampaignID: campaignID, ContentRevisionID: revisionID, SendPlanID: planID,
		RequestID: requestID, TriggerKind: campaignassurance.TriggerExplicit,
		Profile: campaignassurance.ProfileFast, AnalyzerSuiteVersion: "analyzer-v1",
		ModelSuiteVersion: "model-unavailable-v1", PromptSuiteVersion: "prompt-unavailable-v1",
		PromptSuiteHash: strings.Repeat("a", 64), NormalizationVersion: "normalization-v1",
		ScoringVersion: "score-not-computed-v1", GatePolicyVersion: "gate-v1",
		MethodologyVersion: "method-v1", MaxAttempts: 3,
		Configurations: []campaignassurance.ConfigurationInput{{
			ID: "deterministic.queue-proof", SourceClass: campaignassurance.SourceDeterministic,
			Configuration: []byte(`{"policy":"gate-v1"}`),
		}},
	})
	if err != nil {
		t.Fatalf("create assurance run: %v", err)
	}
	ownerOne := uuid.NewString()
	queueOne := New(pool, ownerOne)
	queueOne.LeaseTTL = time.Minute
	queueOne.PollInterval = 10 * time.Millisecond
	if err := queueOne.ValidateSchema(ctx); err != nil {
		t.Fatalf("validate schema: %v", err)
	}
	dispatch := campaignassuranceapi.DispatchCommand{
		TenantID: tenantID, CampaignID: campaignID, RunID: run.ID, RequestID: requestID,
	}
	if err := queueOne.EnqueueCampaignAssurance(ctx, dispatch); err != nil {
		t.Fatal(err)
	}
	if err := queueOne.EnqueueCampaignAssurance(ctx, dispatch); err != nil {
		t.Fatalf("exact scheduler replay: %v", err)
	}
	var commandCount int
	if err := pool.QueryRow(ctx, `
SELECT count(*) FROM campaign_assurance_commands
 WHERE tenant_id = $1::uuid AND run_id = $2::uuid`, tenantID, run.ID).Scan(&commandCount); err != nil || commandCount != 1 {
		t.Fatalf("command count=%d err=%v", commandCount, err)
	}
	command, err := queueOne.Receive(ctx)
	if err != nil || command.TenantID != tenantID || command.RunID != run.ID || command.DeliveryID == "" {
		t.Fatalf("command=%+v err=%v", command, err)
	}
	if err := queueOne.Renew(ctx, command); err != nil {
		t.Fatalf("renew: %v", err)
	}
	queueTwo := New(pool, uuid.NewString())
	queueTwo.LeaseTTL = time.Minute
	queueTwo.PollInterval = 10 * time.Millisecond
	blockedCtx, stopBlocked := context.WithTimeout(ctx, 40*time.Millisecond)
	defer stopBlocked()
	if _, err := queueTwo.Receive(blockedCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second owner received live lease: %v", err)
	}
	retryAt := time.Now().UTC().Add(80 * time.Millisecond)
	if err := queueOne.Release(ctx, command, retryAt); err != nil {
		t.Fatalf("release: %v", err)
	}
	notYetCtx, stopNotYet := context.WithTimeout(ctx, 30*time.Millisecond)
	defer stopNotYet()
	if _, err := queueTwo.Receive(notYetCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("command ignored retry visibility: %v", err)
	}
	time.Sleep(70 * time.Millisecond)
	commandTwo, err := queueTwo.Receive(ctx)
	if err != nil || commandTwo.DeliveryID != command.DeliveryID {
		t.Fatalf("redelivery=%+v err=%v", commandTwo, err)
	}
	if err := queueOne.Acknowledge(ctx, command); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale owner acknowledge err=%v", err)
	}
	if err := queueTwo.Acknowledge(ctx, commandTwo); err != nil {
		t.Fatalf("acknowledge: %v", err)
	}

	// Tenant readers cannot enumerate another tenant, and the broad worker GUC
	// alone is insufficient without the dedicated assurance capability.
	foreignTenantID := uuid.NewString()
	for _, proof := range []struct {
		name        string
		configure   string
		wantVisible int
	}{
		{"foreign tenant", `SELECT set_config('app.tenant_id', $1, true)`, 0},
		{"broad worker only", `SELECT set_config('app.outbox_worker', 'true', true)`, 0},
		{"assurance worker", `SELECT set_config('app.outbox_worker', 'true', true), set_config('app.campaign_assurance_worker', 'true', true)`, 1},
	} {
		t.Run(proof.name, func(t *testing.T) {
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			if _, err := tx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
				t.Skipf("configured database cannot SET ROLE postwave_app: %v", err)
			}
			if strings.Contains(proof.configure, "$1") {
				_, err = tx.Exec(ctx, proof.configure, foreignTenantID)
			} else {
				_, err = tx.Exec(ctx, proof.configure)
			}
			if err != nil {
				t.Fatal(err)
			}
			var visible int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM campaign_assurance_commands`).Scan(&visible); err != nil {
				t.Fatal(err)
			}
			if visible != proof.wantVisible {
				t.Fatalf("visible=%d want=%d", visible, proof.wantVisible)
			}
		})
	}

	var commandID string
	if err := pool.QueryRow(ctx, `
SELECT id::text FROM campaign_assurance_commands
 WHERE tenant_id = $1::uuid AND run_id = $2::uuid`, tenantID, run.ID).Scan(&commandID); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
UPDATE campaign_assurance_commands SET run_id = gen_random_uuid()
 WHERE id = $1::uuid`, commandID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55000" {
		t.Fatalf("identity mutation err=%v", err)
	}
	_, err = pool.Exec(ctx, `
UPDATE campaign_assurance_commands SET available_at = clock_timestamp()
 WHERE id = $1::uuid`, commandID)
	pgErr = nil
	if !errors.As(err, &pgErr) || pgErr.Code != "55000" {
		t.Fatalf("completed command mutation err=%v", err)
	}
}
