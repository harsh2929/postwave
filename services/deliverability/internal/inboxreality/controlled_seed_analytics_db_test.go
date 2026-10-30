package inboxreality

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
)

func TestControlledSeedEventsAreTypedRetainedAndDefaultExcludedDB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, app := executionDBPools(t, ctx)
	fixture := seedExecutionFixture(t, ctx, admin)
	snapshot := inboxrealitycontract.CapabilitySnapshot{
		Version: "postwave.seed-capability-snapshot.v1", Connector: "imap",
		Placement: "available", Headers: "available", RawMIME: "available",
		BodyParts: "available", ObservedSurface: "unavailable", CapturedAt: time.Now().UTC(),
	}
	dispatcher := &Dispatcher{
		Seeds: dbTestSeedSource{seeds: []Seed{{
			MailboxID: "analytics-controlled-01", Provider: "gmail", Address: "seed@example.test",
		}}, snapshot: snapshot},
		Store: NewPostgresExecutionStore(app), Sender: &countingRawSender{},
	}
	if _, err := dispatcher.Execute(ctx, fixture.request()); err != nil {
		t.Fatal(err)
	}

	tx, err := app.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, fixture.tenantID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.controlled_seed_event_ingester','true',true)`); err != nil {
		t.Fatal(err)
	}
	var seedSubscriber, seedReport bool
	var seedTestID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, campaign_id, at, source,
    provider_event_id, source_event_id, message_id, metadata
) VALUES ($1::uuid, 'seed@example.test', 'opened', $2::uuid, now(), 'listmonk',
          $3, $3, ' <CONTROLLED.SEED@EXAMPLE.TEST> ', '{}'::jsonb)
RETURNING is_seed, COALESCE(controlled_seed_test_id::text, '')`,
		fixture.tenantID, fixture.campaignID, "seed-subscriber-"+fixture.testID).Scan(&seedSubscriber, &seedTestID); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO campaign_report_events (
    tenant_id, campaign_id, subscriber_email, event_type, at, source,
    provider_event_id, message_id, metadata
) VALUES ($1::uuid, $2::uuid, 'seed@example.test', 'opened', now(), 'listmonk',
          $3, '<controlled.seed@example.test>', '{}'::jsonb)
RETURNING is_seed`, fixture.tenantID, fixture.campaignID,
		"seed-report-"+fixture.testID).Scan(&seedReport); err != nil {
		t.Fatal(err)
	}
	if !seedSubscriber || !seedReport || seedTestID != fixture.testID {
		t.Fatalf("seed origin subscriber=%t report=%t test=%q", seedSubscriber, seedReport, seedTestID)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.controlled_seed_event_ingester','false',true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, campaign_id, at, source,
    provider_event_id, source_event_id, message_id, metadata
) VALUES ($1::uuid, 'reader@example.test', 'opened', $2::uuid, now(), 'listmonk',
          $3, $3, '<recipient@example.test>', '{}'::jsonb)`, fixture.tenantID,
		fixture.campaignID, "recipient-subscriber-"+fixture.testID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_report_events (
    tenant_id, campaign_id, subscriber_email, event_type, at, source,
    provider_event_id, message_id, metadata
) VALUES ($1::uuid, $2::uuid, 'reader@example.test', 'opened', now(), 'listmonk',
          $3, '<recipient@example.test>', '{}'::jsonb)`, fixture.tenantID,
		fixture.campaignID, "recipient-report-"+fixture.testID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	assertVisible := func(name string, outbox, evidence bool, wantSubscribers, wantReports int) {
		t.Helper()
		readTx, err := app.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = readTx.Rollback(ctx) }()
		if _, err := readTx.Exec(ctx, `SELECT
            set_config('app.tenant_id',$1,true),
            set_config('app.outbox_worker',$2,true),
            set_config('app.controlled_seed_evidence_reader',$3,true)`,
			fixture.tenantID, boolSetting(outbox), boolSetting(evidence)); err != nil {
			t.Fatal(err)
		}
		var subscribers, reports int
		if err := readTx.QueryRow(ctx, `SELECT count(*) FROM subscriber_events
WHERE tenant_id=$1::uuid AND message_id IN (' <CONTROLLED.SEED@EXAMPLE.TEST> ', '<recipient@example.test>')`,
			fixture.tenantID).Scan(&subscribers); err != nil {
			t.Fatal(err)
		}
		if err := readTx.QueryRow(ctx, `SELECT count(*) FROM campaign_report_events
WHERE tenant_id=$1::uuid AND message_id IN ('<controlled.seed@example.test>', '<recipient@example.test>')`,
			fixture.tenantID).Scan(&reports); err != nil {
			t.Fatal(err)
		}
		if subscribers != wantSubscribers || reports != wantReports {
			t.Fatalf("%s visible subscriber=%d report=%d", name, subscribers, reports)
		}
	}
	assertVisible("ordinary tenant analytics", false, false, 1, 1)
	assertVisible("evidence flag alone", false, true, 1, 1)
	assertVisible("generic worker alone", true, false, 1, 1)
	assertVisible("two-factor evidence reader", true, true, 2, 2)

	var rawSubscribers, rawReports int
	if err := admin.QueryRow(ctx, `SELECT
    (SELECT count(*) FROM subscriber_events WHERE tenant_id=$1::uuid AND is_seed),
    (SELECT count(*) FROM campaign_report_events WHERE tenant_id=$1::uuid AND is_seed)`,
		fixture.tenantID).Scan(&rawSubscribers, &rawReports); err != nil {
		t.Fatal(err)
	}
	if rawSubscribers != 1 || rawReports != 1 {
		t.Fatalf("raw seed evidence subscriber=%d report=%d", rawSubscribers, rawReports)
	}
	if _, err := admin.Exec(ctx, `UPDATE subscriber_events SET event_origin='recipient'
WHERE tenant_id=$1::uuid AND is_seed`, fixture.tenantID); err == nil || !strings.Contains(err.Error(), "origin is immutable") {
		t.Fatalf("origin immutability error=%v", err)
	}
	if _, err := admin.Exec(ctx, `UPDATE subscriber_events SET subscriber_email='redacted@example.test'
WHERE tenant_id=$1::uuid AND is_seed`, fixture.tenantID); err != nil {
		t.Fatalf("privacy-compatible email update: %v", err)
	}
}

func boolSetting(value bool) string {
	if value {
		return "true"
	}
	return "false"
}
