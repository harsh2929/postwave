// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/campaignreportprojection"
	"github.com/postwave/postwave/apps/api/internal/db"
)

type failingSubscriberReportProjector struct{ err error }

func (projector failingSubscriberReportProjector) ProjectCanonicalEvent(
	context.Context,
	pgx.Tx,
	string,
	campaignreportprojection.CanonicalEvent,
) error {
	return projector.err
}

func seedSubscriberProjectionCampaign(t *testing.T, pool *db.Pool, tenantID string) string {
	t.Helper()
	campaignID := uuid.NewString()
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(context.Background(), `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html, status)
VALUES ($1::uuid, $2::uuid, 'Subscriber projection', 'Projection', '<p>x</p>', 'draft')`,
		campaignID, tenantID); err != nil {
		t.Fatalf("seed subscriber projection campaign: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	return campaignID
}

func subscriberProjectionCounts(
	t *testing.T,
	pool *db.Pool,
	tenantID, sourceEventID string,
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
  ), '')`, tenantID, sourceEventID).Scan(&source, &report, &projection, &method); err != nil {
		t.Fatal(err)
	}
	return source, report, projection, method
}

func TestSubscriberEventWriterProjectsAndRollsBackAtomically_DB(t *testing.T) {
	pool := newObservationTestPool(t)
	ctx := context.Background()
	var ready bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.campaign_report_event_projections') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatal(err)
	}
	if !ready {
		t.Fatal("configured database is missing migration 1959")
	}
	tenantID, subscriberID := seedObservationSubscriber(t, pool)
	campaignID := seedSubscriberProjectionCampaign(t, pool, tenantID)
	runtime, err := campaignreportprojection.BuildRuntime(
		ctx, campaignreportprojection.RuntimeConfiguration{Enabled: true}, pool,
	)
	if err != nil {
		t.Fatalf("build subscriber projection runtime: %v", err)
	}
	sourceEventID := "subscriber-projection-" + uuid.NewString()
	occurredAt := time.Now().UTC().Truncate(time.Microsecond)
	input := SubscriberEventInput{
		EventType: "clicked", CampaignID: campaignID,
		LinkURL: "https://example.test/subscriber-projection",
		Source:  "public-track", SourceEventID: sourceEventID, OccurredAt: &occurredAt,
	}
	repo := &Repo{Pool: pool, CampaignReportProjector: runtime}
	first, err := repo.RecordSubscriberEvent(ctx, tenantID, subscriberID, input)
	if err != nil || first.Deduped {
		t.Fatalf("first subscriber projection event=%+v err=%v", first, err)
	}
	replay, err := repo.RecordSubscriberEvent(ctx, tenantID, subscriberID, input)
	if err != nil || !replay.Deduped || replay.ID != first.ID || !replay.At.Equal(first.At) {
		t.Fatalf("subscriber projection replay=%+v first=%+v err=%v", replay, first, err)
	}
	source, report, projection, method := subscriberProjectionCounts(t, pool, tenantID, sourceEventID)
	if source != 1 || report != 1 || projection != 1 || method != "inserted_projection" {
		t.Fatalf("subscriber projection source/report/link=%d/%d/%d method=%q",
			source, report, projection, method)
	}

	rollbackID := "subscriber-projection-rollback-" + uuid.NewString()
	rollbackInput := input
	rollbackInput.SourceEventID = rollbackID
	sentinel := errors.New("injected subscriber projection failure")
	failing := &Repo{
		Pool: pool, CampaignReportProjector: failingSubscriberReportProjector{err: sentinel},
	}
	if _, err := failing.RecordSubscriberEvent(ctx, tenantID, subscriberID, rollbackInput); !errors.Is(err, sentinel) {
		t.Fatalf("subscriber projection failure error=%v", err)
	}
	source, report, projection, _ = subscriberProjectionCounts(t, pool, tenantID, rollbackID)
	if source != 0 || report != 0 || projection != 0 {
		t.Fatalf("subscriber projection failure leaked source/report/link=%d/%d/%d",
			source, report, projection)
	}
}
