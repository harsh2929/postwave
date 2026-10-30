// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type lifecycleDBFixture struct {
	tenantID, campaignID, revisionID, planID, artifactID string
}

func inboxRealityDBPools(t *testing.T, ctx context.Context) (*pgxpool.Pool, *db.Pool) {
	t.Helper()
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_INBOX_REALITY_TEST_ADMIN_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("POSTWAVE_INBOX_REALITY_TEST_DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_INBOX_REALITY_TEST_ADMIN_DATABASE_URL and POSTWAVE_INBOX_REALITY_TEST_DATABASE_URL are required")
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	app, err := db.New(ctx, appURL)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { app.Close(); admin.Close() })
	var ready bool
	if err := admin.QueryRow(ctx, `SELECT
        to_regclass('public.inbox_reality_dispatch_commands') IS NOT NULL
        AND to_regclass('public.inbox_reality_seed_dispatches') IS NOT NULL`).Scan(&ready); err != nil || !ready {
		t.Fatalf("migration 1928 is not ready: ready=%v err=%v", ready, err)
	}
	return admin, app
}

func seedLifecycleDBFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) lifecycleDBFixture {
	t.Helper()
	f := lifecycleDBFixture{
		tenantID: uuid.NewString(), campaignID: uuid.NewString(), revisionID: uuid.NewString(),
		planID: uuid.NewString(), artifactID: uuid.NewString(),
	}
	suffix := strings.ReplaceAll(f.tenantID, "-", "")[:16]
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, $3, 'studio')`,
			[]any{f.tenantID, "inbox-lifecycle-" + suffix, "Inbox lifecycle " + suffix}},
		{`INSERT INTO campaigns (id, tenant_id, name, subject, body_html)
VALUES ($1::uuid, $2::uuid, 'Inbox lifecycle', 'Launch', '<p>Launch</p>')`, []any{f.campaignID, f.tenantID}},
		{`INSERT INTO campaign_content_revisions (
    id, tenant_id, campaign_id, revision_no, source_mode, content_schema_version,
    subject, semantic_tree, legacy_html, fact_contract, variants, locales, source_hash
) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'legacy_html', 1, 'Launch', '[]'::jsonb,
    '<p>Launch</p>', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, repeat('1',64))`,
			[]any{f.revisionID, f.tenantID, f.campaignID}},
		{`INSERT INTO campaign_send_plans (
    id, tenant_id, campaign_id, content_revision_id, plan_no, request_id,
    request_hash, renderer_version, compiler_version, transform_manifest,
    coverage_manifest, fixture_set_version, policy_version, state
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, gen_random_uuid(), repeat('2',64),
    'renderer-v1', 'compiler-v1', '{}'::jsonb, '{"scenarios":["base"]}'::jsonb,
    'fixtures-v1', 'policy-v1', 'preparing')`, []any{f.planID, f.tenantID, f.campaignID, f.revisionID}},
		{`INSERT INTO campaign_render_artifacts (
    id, tenant_id, campaign_id, send_plan_id, scenario_id, locale, branch_key,
    fixture_id, source_hash, html_hash, text_hash, mime_structure_hash,
    outbound_mime_hash, mime_object_ref, compiler_receipt, representation_manifest, expires_at
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'base', 'en-US', 'default', 'fixture-base',
    repeat('1',64), repeat('3',64), repeat('4',64), repeat('5',64), repeat('6',64),
    'postwave.tenant-object-ref.v1:inbox-lifecycle/raw.eml', '{}'::jsonb, '{}'::jsonb,
    now()+interval '2 hours')`, []any{f.artifactID, f.tenantID, f.campaignID, f.planID}},
		{`UPDATE campaign_send_plans SET state='ready', plan_hash=repeat('b',64), ready_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid`, []any{f.tenantID, f.planID}},
	}
	for index, statement := range statements {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("fixture statement %d: %v", index+1, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, f.tenantID) })
	return f
}

func exactLifecycleParams(f lifecycleDBFixture) ExactCreateParams {
	return ExactCreateParams{
		TenantID: f.tenantID, HeaderToken: strings.ReplaceAll(uuid.NewString(), "-", ""),
		ArtifactID: f.artifactID, ScenarioID: "base", IdempotencyKey: "inbox-lifecycle-race",
		RequestHash: strings.Repeat("a", 64), RequestedCapabilities: DefaultCapabilityRequirements(),
		ExpiresAt: time.Now().UTC().Add(10 * time.Minute),
	}
}

func TestExactLifecycleIdempotencyLeaseAndFencingDB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, app := inboxRealityDBPools(t, ctx)
	f := seedLifecycleDBFixture(t, ctx, admin)
	store := &pgStore{pool: app}
	params := exactLifecycleParams(f)

	const callers = 12
	results := make(chan ExactCreateResult, callers)
	errorsCh := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			created, err := store.CreateExactTest(ctx, params)
			if err != nil {
				errorsCh <- err
				return
			}
			results <- created
		}()
	}
	wg.Wait()
	close(results)
	close(errorsCh)
	for err := range errorsCh {
		t.Fatalf("concurrent exact create: %v", err)
	}
	var testID, commandID string
	for result := range results {
		if testID == "" {
			testID, commandID = result.Test.ID, result.Command.ID
		}
		if result.Test.ID != testID || result.Command.ID != commandID {
			t.Fatalf("idempotent create diverged: test=%q command=%q", result.Test.ID, result.Command.ID)
		}
	}
	var testCount, commandCount int
	if err := admin.QueryRow(ctx, `SELECT
        (SELECT count(*) FROM inbox_reality_tests WHERE tenant_id=$1::uuid),
        (SELECT count(*) FROM inbox_reality_dispatch_commands WHERE tenant_id=$1::uuid)`,
		f.tenantID).Scan(&testCount, &commandCount); err != nil {
		t.Fatal(err)
	}
	if testCount != 1 || commandCount != 1 {
		t.Fatalf("race minted tests=%d commands=%d, want 1/1", testCount, commandCount)
	}
	if _, err := store.GetDispatch(ctx, uuid.NewString(), testID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant dispatch read error=%v, want ErrNotFound", err)
	}

	claimed, err := store.ClaimDispatch(ctx, uuid.NewString(), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	losingFence := claimed
	losingFence.LeaseToken = uuid.NewString()
	if err := store.CompleteDispatch(ctx, losingFence, []byte(`{"status":"accepted"}`)); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale fence error=%v, want ErrLeaseLost", err)
	}
	if err := store.CompleteDispatch(ctx, claimed, []byte(`{"status":"accepted"}`)); err != nil {
		t.Fatal(err)
	}
	command, err := store.GetDispatch(ctx, f.tenantID, testID)
	if err != nil || command.State != DispatchDispatched {
		t.Fatalf("completed command=%+v err=%v", command, err)
	}
}

func TestExactLifecycleCancelClosesQueuedCommandDB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, app := inboxRealityDBPools(t, ctx)
	f := seedLifecycleDBFixture(t, ctx, admin)
	store := &pgStore{pool: app}
	params := exactLifecycleParams(f)
	created, err := store.CreateExactTest(ctx, params)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CancelTest(ctx, f.tenantID, created.Test.ID, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	command, err := store.GetDispatch(ctx, f.tenantID, created.Test.ID)
	if err != nil || command.State != DispatchCancelled {
		t.Fatalf("cancelled command=%+v err=%v", command, err)
	}
	test, err := store.GetTest(ctx, f.tenantID, created.Test.ID)
	if err != nil || test.Status != StatusCancelled {
		t.Fatalf("cancelled test=%+v err=%v", test, err)
	}
}

func TestExactLifecycleObservationCallbackConvergesSanitizedProjectionDB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, app := inboxRealityDBPools(t, ctx)
	f := seedLifecycleDBFixture(t, ctx, admin)
	store := &pgStore{pool: app}
	created, err := store.CreateExactTest(ctx, exactLifecycleParams(f))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
INSERT INTO inbox_reality_seed_dispatches (
    tenant_id, test_id, command_id, mailbox_id, provider, capability_snapshot,
    artifact_mime_hash, dispatched_mime_hash, state, attempt_count,
    provider_message_id_sha256, completed_at
) VALUES ($1::uuid, $2::uuid, $3::uuid, 'gmail-controlled-01', 'gmail',
    '{"raw_mime":"available"}'::jsonb, repeat('6',64), repeat('d',64),
    'accepted', 1, repeat('e',64), now())`, f.tenantID, created.Test.ID, created.Command.ID); err != nil {
		t.Fatal(err)
	}
	receipt := ObservationReceipt{
		TenantID: f.tenantID, TestID: created.Test.ID, ArtifactID: f.artifactID,
		ScenarioID: "base", ObservationKey: strings.Repeat("f", 64),
		MailboxID: "gmail-controlled-01", Provider: ProviderGmail,
		Placement: PlacementPrimary, Folder: "INBOX",
		CapabilitySnapshot: []byte(`{"raw_mime":"available","observed_surface":"unavailable"}`),
		RawMIMEStatus:      "complete", ReceivedMIMESHA256: strings.Repeat("6", 64),
		ReceivedStructureSHA256: strings.Repeat("5", 64), StructureComparison: "match",
		CapturedAt: time.Now().UTC().Truncate(time.Microsecond),
	}
	first, err := store.RecordObservation(ctx, receipt)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.RecordObservation(ctx, receipt)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID || first.ObservationKey != receipt.ObservationKey || len(first.RawHeaders) != 0 {
		t.Fatalf("callback did not converge safely: first=%+v second=%+v", first, second)
	}
	test, err := store.GetTest(ctx, f.tenantID, created.Test.ID)
	if err != nil || test.Status != StatusComplete {
		t.Fatalf("completed test=%+v err=%v", test, err)
	}
	results, err := store.ListResults(ctx, f.tenantID, created.Test.ID)
	if err != nil || len(results) != 1 || results[0].ReceivedStructureSHA256 != strings.Repeat("5", 64) {
		t.Fatalf("sanitized results=%+v err=%v", results, err)
	}
}
