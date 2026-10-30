// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
)

type executionFixture struct {
	tenantID, campaignID, revisionID, planID, artifactID string
	testID, commandID, leaseToken, token                 string
	expiresAt                                            time.Time
	raw                                                  []byte
}

func executionDBPools(t *testing.T, ctx context.Context) (*pgxpool.Pool, *pgxpool.Pool) {
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
	app, err := pgxpool.New(ctx, appURL)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { app.Close(); admin.Close() })
	return admin, app
}

func seedExecutionFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) executionFixture {
	t.Helper()
	f := executionFixture{
		tenantID: uuid.NewString(), campaignID: uuid.NewString(), revisionID: uuid.NewString(),
		planID: uuid.NewString(), artifactID: uuid.NewString(), testID: uuid.NewString(),
		commandID: uuid.NewString(), leaseToken: uuid.NewString(),
		token:     strings.ReplaceAll(uuid.NewString(), "-", ""),
		expiresAt: time.Now().UTC().Add(15 * time.Minute).Truncate(time.Microsecond),
		raw:       []byte("From: sender@example.test\r\nTo: placeholder@example.test\r\nMessage-ID: <controlled.seed@example.test>\r\nSubject: Launch\r\nContent-Type: text/plain\r\n\r\nLaunch\r\n"),
	}
	suffix := strings.ReplaceAll(f.tenantID, "-", "")[:16]
	mimeHash := digest(f.raw)
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
			[]any{f.tenantID, "inbox-execution-" + suffix, "Inbox execution " + suffix}},
		{`INSERT INTO campaigns (id, tenant_id, name, subject, body_html)
VALUES ($1::uuid, $2::uuid, 'Inbox execution', 'Launch', '<p>Launch</p>')`, []any{f.campaignID, f.tenantID}},
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
    repeat('1',64), repeat('3',64), repeat('4',64), repeat('5',64), $5,
    'postwave.tenant-object-ref.v1:inbox-execution/raw.eml', '{}'::jsonb, '{}'::jsonb,
    now()+interval '2 hours')`, []any{f.artifactID, f.tenantID, f.campaignID, f.planID, mimeHash}},
		{`UPDATE campaign_send_plans SET state='ready', plan_hash=repeat('b',64), ready_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid`, []any{f.tenantID, f.planID}},
		{`INSERT INTO inbox_reality_tests (
    id, tenant_id, header_token, kind, subject, status, expires_at, campaign_id,
    content_revision_id, send_plan_id, artifact_id, scenario_id,
    outbound_mime_hash, outbound_mime_structure_hash, requested_capabilities
) VALUES ($1::uuid, $2::uuid, $3, 'campaign_assurance', 'Launch', 'awaiting_delivery', $4,
    $5::uuid, $6::uuid, $7::uuid, $8::uuid, 'base', $9, repeat('5',64), $10::jsonb)`,
			[]any{f.testID, f.tenantID, f.token, f.expiresAt, f.campaignID, f.revisionID,
				f.planID, f.artifactID, mimeHash, capabilityRequirementsJSON()}},
		{`INSERT INTO inbox_reality_dispatch_commands (
    id, tenant_id, test_id, idempotency_key, request_hash, campaign_id,
    content_revision_id, send_plan_id, artifact_id, scenario_id,
    artifact_mime_object_ref, artifact_mime_hash, artifact_structure_hash,
    requested_capabilities, state, attempt_count, lease_owner, lease_token, lease_expires_at
) VALUES ($1::uuid, $2::uuid, $3::uuid, 'execution-db-test', repeat('a',64), $4::uuid,
    $5::uuid, $6::uuid, $7::uuid, 'base',
    'postwave.tenant-object-ref.v1:inbox-execution/raw.eml', $8, repeat('5',64),
    $9::jsonb, 'leased', 1, gen_random_uuid(), $10::uuid, now()+interval '5 minutes')`,
			[]any{f.commandID, f.tenantID, f.testID, f.campaignID, f.revisionID, f.planID,
				f.artifactID, mimeHash, capabilityRequirementsJSON(), f.leaseToken}},
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

func capabilityRequirementsJSON() string {
	return `{"placement":"required","headers":"required","raw_mime":"required","body_parts":"required","observed_surface":"disabled"}`
}

func (f executionFixture) request() inboxrealitycontract.DispatchRequest {
	return inboxrealitycontract.DispatchRequest{
		ContractVersion: inboxrealitycontract.Version, CommandID: f.commandID,
		TenantID: f.tenantID, TestID: f.testID, LeaseToken: f.leaseToken,
		RequestHash: strings.Repeat("a", 64), HeaderValue: "irt_" + f.token,
		CampaignID: f.campaignID, ContentRevisionID: f.revisionID, SendPlanID: f.planID,
		ArtifactID: f.artifactID, ScenarioID: "base", ArtifactMIMEHash: digest(f.raw),
		ArtifactStructureHash: strings.Repeat("5", 64),
		RequestedCapabilities: inboxrealitycontract.CapabilityRequirements{
			Placement: "required", Headers: "required", RawMIME: "required",
			BodyParts: "required", ObservedSurface: "disabled",
		}, RawMIME: append([]byte(nil), f.raw...), ExpiresAt: f.expiresAt,
	}
}

type dbTestSeedSource struct {
	seeds    []Seed
	snapshot inboxrealitycontract.CapabilitySnapshot
}

func (s dbTestSeedSource) ActiveSeeds(context.Context) ([]Seed, error) {
	return append([]Seed(nil), s.seeds...), nil
}
func (s dbTestSeedSource) CapabilitySnapshot(context.Context) (inboxrealitycontract.CapabilitySnapshot, error) {
	return s.snapshot, nil
}

type countingRawSender struct {
	mu    sync.Mutex
	calls int
}

func (s *countingRawSender) SendRaw(_ context.Context, request SendRequest) (SendReceipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if strings.Count(string(request.RawMIME), "X-Postwave-Test-ID:") != 1 {
		return SendReceipt{}, &SendError{Disposition: FailurePermanentDefinitelyNotSent, Code: "BAD_HEADER"}
	}
	return SendReceipt{ProviderMessageID: "provider-" + request.MailboxID}, nil
}

func (s *countingRawSender) count() int { s.mu.Lock(); defer s.mu.Unlock(); return s.calls }

func insertExecutionRegistryVersion(t *testing.T, ctx context.Context, admin *pgxpool.Pool, mailboxID, provider string) string {
	t.Helper()
	var id string
	err := admin.QueryRow(ctx, `
INSERT INTO controlled_seed_registry_versions (
    mailbox_id, version, registry_schema_version, lifecycle_state,
    operational_status, warmup_state, health_state, provider, client, device,
    account_tier, region, locale, timezone, language, smart_features,
    capability_snapshot, address_secret_ref, config_fingerprint_sha256
) VALUES ($1, 1, 'postwave.controlled-seed-registry.v1', 'active', 'active',
          'ready', 'healthy', $2, 'test_client', 'test_device', 'test_tier',
          'test_region', 'en-US', 'UTC', 'en', '{}'::jsonb, '{}'::jsonb,
          'env:TEST_ADDRESS', repeat('a',64))
RETURNING id::text`, mailboxID, provider).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestPostgresExecutionConvergesReplayWithoutDuplicateProviderSendDB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, app := executionDBPools(t, ctx)
	f := seedExecutionFixture(t, ctx, admin)
	snapshot := inboxrealitycontract.CapabilitySnapshot{
		Version: "postwave.seed-capability-snapshot.v1", Connector: "imap",
		Placement: "available", Headers: "available", RawMIME: "available",
		BodyParts: "available", ObservedSurface: "unavailable", CapturedAt: time.Now().UTC(),
	}
	suffix := strings.ReplaceAll(f.tenantID, "-", "")[:12]
	gmailMailbox := "gmail-controlled-" + suffix
	o365Mailbox := "o365-controlled-" + suffix
	seeds := []Seed{
		{MailboxID: gmailMailbox, Provider: "gmail", Address: "gmail@example.test",
			RegistryVersionID: insertExecutionRegistryVersion(t, ctx, admin, gmailMailbox, "gmail")},
		{MailboxID: o365Mailbox, Provider: "o365", Address: "o365@example.test",
			RegistryVersionID: insertExecutionRegistryVersion(t, ctx, admin, o365Mailbox, "o365")},
	}
	sender := &countingRawSender{}
	dispatcher := &Dispatcher{
		Seeds: dbTestSeedSource{seeds: seeds, snapshot: snapshot},
		Store: NewPostgresExecutionStore(app), Sender: sender,
	}
	first, err := dispatcher.Execute(ctx, f.request())
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "accepted" || first.AcceptedCount != len(seeds) || sender.count() != len(seeds) {
		t.Fatalf("first receipt=%+v provider calls=%d", first, sender.count())
	}
	second, err := dispatcher.Execute(ctx, f.request())
	if err != nil {
		t.Fatal(err)
	}
	if second.Status != "accepted" || sender.count() != len(seeds) {
		t.Fatalf("replay receipt=%+v provider calls=%d", second, sender.count())
	}
	var persisted, accepted, leakedAddresses, frozenRegistry, sourceMessageIDs int
	if err := admin.QueryRow(ctx, `SELECT
        count(*), count(*) FILTER (WHERE state='accepted'),
        count(*) FILTER (WHERE to_jsonb(d)::text LIKE '%@example.test%'),
        count(*) FILTER (WHERE seed_registry_version_id IS NOT NULL),
        count(*) FILTER (WHERE source_message_id_sha256 IS NOT NULL)
      FROM inbox_reality_seed_dispatches d WHERE tenant_id=$1::uuid`, f.tenantID).Scan(
		&persisted, &accepted, &leakedAddresses, &frozenRegistry, &sourceMessageIDs); err != nil {
		t.Fatal(err)
	}
	if persisted != len(seeds) || accepted != len(seeds) || leakedAddresses != 0 ||
		frozenRegistry != len(seeds) || sourceMessageIDs != len(seeds) {
		t.Fatalf("persisted=%d accepted=%d leaked=%d registry=%d message_ids=%d",
			persisted, accepted, leakedAddresses, frozenRegistry, sourceMessageIDs)
	}
	var unscopedVisible int
	if err := app.QueryRow(ctx, `SELECT count(*) FROM inbox_reality_seed_dispatches
WHERE tenant_id=$1::uuid`, f.tenantID).Scan(&unscopedVisible); err != nil {
		t.Fatal(err)
	}
	if unscopedVisible != 0 {
		t.Fatalf("unscoped postwave_app saw %d seed dispatch rows", unscopedVisible)
	}
}

func TestPostgresExecutionConcurrentReplayClaimsEachSeedOnceDB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, app := executionDBPools(t, ctx)
	f := seedExecutionFixture(t, ctx, admin)
	snapshot := inboxrealitycontract.CapabilitySnapshot{
		Version: "postwave.seed-capability-snapshot.v1", Connector: "imap",
		Placement: "available", Headers: "available", RawMIME: "available",
		BodyParts: "available", ObservedSurface: "unavailable", CapturedAt: time.Now().UTC(),
	}
	seeds := []Seed{
		{MailboxID: "gmail-controlled-01", Provider: "gmail", Address: "gmail@example.test"},
		{MailboxID: "o365-controlled-01", Provider: "o365", Address: "o365@example.test"},
	}
	sender := &countingRawSender{}
	dispatcher := &Dispatcher{
		Seeds: dbTestSeedSource{seeds: seeds, snapshot: snapshot},
		Store: NewPostgresExecutionStore(app), Sender: sender,
	}
	const callers = 8
	errorsCh := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := dispatcher.Execute(ctx, f.request())
			if err != nil {
				errorsCh <- err
			}
		}()
	}
	wg.Wait()
	close(errorsCh)
	for err := range errorsCh {
		t.Fatalf("concurrent execution: %v", err)
	}
	if sender.count() != len(seeds) {
		t.Fatalf("provider calls=%d, want exactly %d", sender.count(), len(seeds))
	}
	var accepted int
	if err := admin.QueryRow(ctx, `SELECT count(*) FROM inbox_reality_seed_dispatches
WHERE tenant_id=$1::uuid AND state='accepted'`, f.tenantID).Scan(&accepted); err != nil {
		t.Fatal(err)
	}
	if accepted != len(seeds) {
		t.Fatalf("accepted rows=%d, want %d", accepted, len(seeds))
	}
}
