// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/campaignreportprojection"
	"github.com/postwave/postwave/apps/api/internal/db"
)

type failingReplyReportProjector struct{ err error }

func (projector failingReplyReportProjector) ProjectCanonicalEvent(
	context.Context,
	pgx.Tx,
	string,
	campaignreportprojection.CanonicalEvent,
) error {
	return projector.err
}

func replyProjectionCounts(
	t *testing.T,
	pool *db.Pool,
	fixture replyDBFixture,
) (report, projection int, method string) {
	t.Helper()
	tx, err := db.WithTenantWorker(context.Background(), pool, fixture.TenantID)
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
  (SELECT count(*) FROM campaign_report_events
    WHERE campaign_id=$1::uuid AND event_type='replied'),
  (SELECT count(*) FROM campaign_report_event_projections projection_row
     JOIN subscriber_events event
       ON event.tenant_id=projection_row.tenant_id
      AND event.id=projection_row.subscriber_event_id
      AND event.at=projection_row.subscriber_event_at
    WHERE event.campaign_id=$1::uuid AND event.event_type='replied'),
  COALESCE((
    SELECT projection_row.materialization_method
      FROM campaign_report_event_projections projection_row
      JOIN subscriber_events event
        ON event.tenant_id=projection_row.tenant_id
       AND event.id=projection_row.subscriber_event_id
       AND event.at=projection_row.subscriber_event_at
     WHERE event.campaign_id=$1::uuid AND event.event_type='replied'
     LIMIT 1
  ), '')`, fixture.CampaignID).Scan(&report, &projection, &method); err != nil {
		t.Fatal(err)
	}
	return report, projection, method
}

func TestStrongHumanReplyProjectsAndRollsBackAtomically_DB(t *testing.T) {
	pool := repliesDB(t)
	ctx := context.Background()
	var ready bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.campaign_report_event_projections') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatal(err)
	}
	if !ready {
		t.Fatal("configured database is missing migration 1959")
	}
	projectionRuntime, err := campaignreportprojection.BuildRuntime(
		ctx, campaignreportprojection.RuntimeConfiguration{Enabled: true}, pool,
	)
	if err != nil {
		t.Fatalf("build reply projection runtime: %v", err)
	}
	receivedAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
	fixture := seedReplyFixture(t, pool, false)
	store := &Store{
		Pool: pool, EngagementClassifier: replyClassifierRuntime(t, pool),
		CampaignReportProjector: projectionRuntime,
	}
	reply := stronglyMatchedHumanReply(fixture, receivedAt)
	id, duplicate, err := store.Persist(ctx, fixture.TenantID, reply)
	if err != nil || duplicate || id == "" {
		t.Fatalf("first projected reply id=%q duplicate=%v err=%v", id, duplicate, err)
	}
	replayID, duplicate, err := store.Persist(ctx, fixture.TenantID, reply)
	if err != nil || !duplicate || replayID != id {
		t.Fatalf("projected reply replay id=%q duplicate=%v err=%v", replayID, duplicate, err)
	}
	evidence := loadReplyEvidence(t, pool, fixture)
	if evidence.Replies != 1 || evidence.Events != 1 || evidence.Observations != 1 || evidence.Classifications != 1 {
		t.Fatalf("reply evidence after projection=%+v", evidence)
	}
	report, projection, method := replyProjectionCounts(t, pool, fixture)
	if report != 1 || projection != 1 || method != "inserted_projection" {
		t.Fatalf("reply projection report/link=%d/%d method=%q", report, projection, method)
	}

	rollbackFixture := seedReplyFixture(t, pool, false)
	sentinel := errors.New("injected reply projection failure")
	failingStore := &Store{
		Pool: pool, EngagementClassifier: replyClassifierRuntime(t, pool),
		CampaignReportProjector: failingReplyReportProjector{err: sentinel},
	}
	rollbackReply := stronglyMatchedHumanReply(rollbackFixture, receivedAt.Add(time.Second))
	if _, _, err := failingStore.Persist(ctx, rollbackFixture.TenantID, rollbackReply); !errors.Is(err, sentinel) {
		t.Fatalf("reply projection failure error=%v", err)
	}
	rolledBack := loadReplyEvidence(t, pool, rollbackFixture)
	if rolledBack.Replies != 0 || rolledBack.Events != 0 ||
		rolledBack.Observations != 0 || rolledBack.Classifications != 0 {
		t.Fatalf("reply projection failure leaked evidence=%+v", rolledBack)
	}
	report, projection, _ = replyProjectionCounts(t, pool, rollbackFixture)
	if report != 0 || projection != 0 {
		t.Fatalf("reply projection failure leaked report/link=%d/%d", report, projection)
	}
}
