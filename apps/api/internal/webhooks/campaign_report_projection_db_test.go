// SPDX-License-Identifier: AGPL-3.0-only

package webhooks

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/campaignreportprojection"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

type failingProviderReportProjector struct{ err error }

func (projector failingProviderReportProjector) ProjectCanonicalEvent(
	context.Context,
	pgx.Tx,
	string,
	campaignreportprojection.CanonicalEvent,
) error {
	return projector.err
}

func seedWebhookProjectionCampaign(t *testing.T, pool *db.Pool, tenantID string) string {
	t.Helper()
	campaignID := uuid.NewString()
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(context.Background(), `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html, status)
VALUES ($1::uuid, $2::uuid, 'ESP projection', 'ESP projection', '<p>x</p>', 'draft')`,
		campaignID, tenantID); err != nil {
		t.Fatalf("seed ESP projection campaign: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	return campaignID
}

func projectionCountsForProviderEvent(
	t *testing.T,
	pool *db.Pool,
	tenantID, providerID string,
) (source, report, projection int, method string) {
	t.Helper()
	tx, err := db.WithTenantWorker(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(context.Background(), `
SELECT set_config('app.campaign_report_projection_worker','true',true)`); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(context.Background(), `
SELECT
  (SELECT count(*) FROM subscriber_events
    WHERE tenant_id=$1::uuid AND source_event_id=$2),
  (SELECT count(*) FROM campaign_report_events report
     JOIN campaign_report_event_projections projection_row
       ON projection_row.tenant_id=report.tenant_id
      AND projection_row.campaign_report_event_id=report.id
      AND projection_row.campaign_report_event_at=report.at
     JOIN subscriber_events event
       ON event.tenant_id=projection_row.tenant_id
      AND event.id=projection_row.subscriber_event_id
      AND event.at=projection_row.subscriber_event_at
    WHERE projection_row.tenant_id=$1::uuid AND event.source_event_id=$2),
  (SELECT count(*) FROM campaign_report_event_projections projection_row
     JOIN subscriber_events event
       ON event.tenant_id=projection_row.tenant_id
      AND event.id=projection_row.subscriber_event_id
      AND event.at=projection_row.subscriber_event_at
    WHERE projection_row.tenant_id=$1::uuid AND event.source_event_id=$2),
  COALESCE((
    SELECT projection_row.materialization_method
      FROM campaign_report_event_projections projection_row
      JOIN subscriber_events event
        ON event.tenant_id=projection_row.tenant_id
       AND event.id=projection_row.subscriber_event_id
       AND event.at=projection_row.subscriber_event_at
     WHERE projection_row.tenant_id=$1::uuid AND event.source_event_id=$2
     LIMIT 1
  ), '')`, tenantID, providerID).Scan(&source, &report, &projection, &method); err != nil {
		t.Fatal(err)
	}
	return source, report, projection, method
}

func TestESPWriterProjectsAndRollsBackAtomically_DB(t *testing.T) {
	pool := webhookDB(t)
	ctx := context.Background()
	var ready bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.campaign_report_event_projections') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatal(err)
	}
	if !ready {
		t.Fatal("configured database is missing migration 1959")
	}
	tenantID := seedWebhookTenant(t, pool)
	campaignID := seedWebhookProjectionCampaign(t, pool, tenantID)
	runtime, err := campaignreportprojection.BuildRuntime(
		ctx, campaignreportprojection.RuntimeConfiguration{Enabled: true}, pool,
	)
	if err != nil {
		t.Fatalf("build ESP projection runtime: %v", err)
	}
	providerID := "esp-projection-" + uuid.NewString()
	event := classifyOutcome{
		Email: "esp-projection@example.test", CampaignID: campaignID,
		EventType: "clicked", ProviderName: suppressions.SourcePostmark,
		ProviderID: providerID, MessageID: "<" + uuid.NewString() + "@example.test>",
		OccurredAt: time.Now().UTC().Truncate(time.Microsecond),
	}
	deps := &DeliverabilityDeps{Pool: pool, CampaignReportProjector: runtime}
	if err := deps.appendEvent(ctx, tenantID, event, event.OccurredAt); err != nil {
		t.Fatalf("append projected ESP event: %v", err)
	}
	if err := deps.appendEvent(ctx, tenantID, event, event.OccurredAt); err != nil {
		t.Fatalf("replay projected ESP event: %v", err)
	}
	source, report, projection, method := projectionCountsForProviderEvent(t, pool, tenantID, providerID)
	if source != 1 || report != 1 || projection != 1 || method != "inserted_projection" {
		t.Fatalf("ESP projection source/report/link=%d/%d/%d method=%q",
			source, report, projection, method)
	}
	// The full provider fan-out must retain the unsubscribe as a canonical
	// campaign fact as well as enforcing suppression. This path historically
	// stopped after subscriber_suppressions and left both event ledgers empty.
	unsubscribeID := "esp-unsubscribe-projection-" + uuid.NewString()
	unsubscribe := event
	unsubscribe.EventType = "unsubscribed"
	unsubscribe.ProviderID = unsubscribeID
	unsubscribe.MessageID = ""
	deps.Suppressions = &suppressions.Store{Pool: pool}
	if err := deps.process(ctx, tenantID, unsubscribe); err != nil {
		t.Fatalf("process projected ESP unsubscribe: %v", err)
	}
	source, report, projection, method = projectionCountsForProviderEvent(t, pool, tenantID, unsubscribeID)
	if source != 1 || report != 1 || projection != 1 || method != "inserted_projection" {
		t.Fatalf("ESP unsubscribe projection source/report/link=%d/%d/%d method=%q",
			source, report, projection, method)
	}

	rollbackID := "esp-projection-rollback-" + uuid.NewString()
	rollback := event
	rollback.ProviderID = rollbackID
	rollback.MessageID = "<" + uuid.NewString() + "@example.test>"
	sentinel := errors.New("injected ESP projection failure")
	failing := &DeliverabilityDeps{
		Pool: pool, CampaignReportProjector: failingProviderReportProjector{err: sentinel},
	}
	if err := failing.appendEvent(ctx, tenantID, rollback, rollback.OccurredAt); !errors.Is(err, sentinel) {
		t.Fatalf("ESP projection failure error=%v", err)
	}
	source, report, projection, _ = projectionCountsForProviderEvent(t, pool, tenantID, rollbackID)
	if source != 0 || report != 0 || projection != 0 {
		t.Fatalf("ESP projection failure leaked source/report/link=%d/%d/%d",
			source, report, projection)
	}
}
