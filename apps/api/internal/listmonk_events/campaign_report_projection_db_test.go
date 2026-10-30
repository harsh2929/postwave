// SPDX-License-Identifier: AGPL-3.0-only

package listmonk_events

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/campaignreportprojection"
)

type failingCampaignReportProjector struct{ err error }

func (projector failingCampaignReportProjector) ProjectCanonicalEvent(
	context.Context,
	pgx.Tx,
	string,
	campaignreportprojection.CanonicalEvent,
) error {
	return projector.err
}

func TestListmonkReportPeerIsAtomicallyAdoptedByProjection_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := engagementClassificationDBPools(t, ctx)
	var projectionReady bool
	if err := admin.QueryRow(ctx, `
SELECT to_regclass('public.campaign_report_event_projections') IS NOT NULL`).Scan(&projectionReady); err != nil {
		t.Fatal(err)
	}
	if !projectionReady {
		t.Fatal("configured database is missing migration 1959")
	}
	tenantID := uuid.NewString()
	campaignID := uuid.NewString()
	if _, err := admin.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'Listmonk projection integration', 'lm-projection-' || left($1::text, 12), 'studio')`,
		tenantID); err != nil {
		t.Fatalf("seed Listmonk projection tenant: %v", err)
	}
	if _, err := admin.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html, status)
VALUES ($2::uuid, $1::uuid, 'Listmonk projection campaign', 'Projection', '<p>Projection</p>', 'draft')`,
		tenantID, campaignID); err != nil {
		t.Fatalf("seed Listmonk projection campaign: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
	})
	runtime, err := campaignreportprojection.BuildRuntime(
		ctx, campaignreportprojection.RuntimeConfiguration{Enabled: true}, app,
	)
	if err != nil {
		t.Fatalf("build campaign report projection runtime: %v", err)
	}
	providerEventID := "listmonk-projection-" + uuid.NewString()
	eventAt := time.Now().UTC().Truncate(time.Microsecond).Add(-time.Minute)
	event := CanonicalEvent{
		TenantID: tenantID, SubscriberEmail: "projection-" + uuid.NewString() + "@example.test",
		EventType: EventClicked, CampaignID: campaignID,
		LinkURL: "https://example.test/projection", UserAgent: "projection-test/1",
		IP: "192.0.2.211", Source: "listmonk", ProviderEventID: providerEventID,
		MessageID: "<" + uuid.NewString() + "@example.test>", At: eventAt,
		Metadata: map[string]any{"wire_type": WireClicked},
	}
	deps := &Deps{Pool: app, CampaignReportProjector: runtime}
	inserted, err := deps.persist(ctx, event)
	if err != nil || !inserted {
		t.Fatalf("persist projected Listmonk event=(%v,%v)", inserted, err)
	}
	inserted, err = deps.persist(ctx, event)
	if err != nil || inserted {
		t.Fatalf("replay projected Listmonk event=(%v,%v)", inserted, err)
	}
	var sourceCount, reportCount, projectionCount int
	var method string
	if err := admin.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_events
    WHERE tenant_id=$1::uuid AND provider_event_id=$2),
  (SELECT count(*) FROM campaign_report_events
    WHERE tenant_id=$1::uuid AND provider_event_id=$2),
  (SELECT count(*) FROM campaign_report_event_projections projection
     JOIN subscriber_events source
       ON source.tenant_id=projection.tenant_id
      AND source.id=projection.subscriber_event_id
      AND source.at=projection.subscriber_event_at
    WHERE projection.tenant_id=$1::uuid AND source.provider_event_id=$2),
  projection.materialization_method
FROM campaign_report_event_projections projection
JOIN subscriber_events source
  ON source.tenant_id=projection.tenant_id
 AND source.id=projection.subscriber_event_id
 AND source.at=projection.subscriber_event_at
WHERE projection.tenant_id=$1::uuid AND source.provider_event_id=$2`,
		tenantID, providerEventID).Scan(&sourceCount, &reportCount, &projectionCount, &method); err != nil {
		t.Fatalf("read Listmonk projection lineage: %v", err)
	}
	if sourceCount != 1 || reportCount != 1 || projectionCount != 1 || method != "adopted_legacy" {
		t.Fatalf("lineage source/report/projection=%d/%d/%d method=%q",
			sourceCount, reportCount, projectionCount, method)
	}

	// Projection is part of the writer commit boundary, not best effort.
	rollbackID := "listmonk-projection-rollback-" + uuid.NewString()
	sentinel := errors.New("injected campaign report projection failure")
	rollbackEvent := event
	rollbackEvent.ProviderEventID = rollbackID
	rollbackEvent.MessageID = "<" + uuid.NewString() + "@example.test>"
	rollbackEvent.At = eventAt.Add(time.Second)
	failing := &Deps{Pool: app, CampaignReportProjector: failingCampaignReportProjector{err: sentinel}}
	if inserted, err := failing.persist(ctx, rollbackEvent); inserted || !errors.Is(err, sentinel) {
		t.Fatalf("projection failure persist=(%v,%v), want rollback", inserted, err)
	}
	if err := admin.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_events WHERE tenant_id=$1::uuid AND provider_event_id=$2),
  (SELECT count(*) FROM campaign_report_events WHERE tenant_id=$1::uuid AND provider_event_id=$2)`,
		tenantID, rollbackID).Scan(&sourceCount, &reportCount); err != nil {
		t.Fatal(err)
	}
	if sourceCount != 0 || reportCount != 0 {
		t.Fatalf("projection failure leaked source/report=%d/%d", sourceCount, reportCount)
	}
}
