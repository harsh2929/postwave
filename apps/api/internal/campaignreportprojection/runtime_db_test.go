// SPDX-License-Identifier: AGPL-3.0-only

package campaignreportprojection

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestRuntimeRejectsPreMutationProtocol_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	appURL := strings.TrimSpace(os.Getenv(
		"POSTWAVE_REPORT_PROJECTION_PRE_MUTATION_APP_TEST_DATABASE_URL",
	))
	if appURL == "" {
		t.Skip("POSTWAVE_REPORT_PROJECTION_PRE_MUTATION_APP_TEST_DATABASE_URL is required")
	}
	app, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect pre-mutation app database: %v", err)
	}
	defer app.Close()
	var user string
	var bypass bool
	if err := app.QueryRow(ctx, `
SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user`).
		Scan(&user, &bypass); err != nil {
		t.Fatal(err)
	}
	if user != "postwave_app" || bypass {
		t.Skipf("pre-mutation DSN must use non-bypass postwave_app; got %q bypass=%v", user, bypass)
	}
	runtime, err := BuildRuntime(ctx, RuntimeConfiguration{Enabled: true}, (*db.Pool)(app))
	if runtime != nil || !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatalf("pre-1964 runtime=%v error=%v, want nil ErrRuntimeNotReady", runtime, err)
	}
}

func insertRuntimeCanonicalEvent(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	fixture projectionFixture,
	suffix string,
	at time.Time,
) EventRef {
	t.Helper()
	var event EventRef
	err := tx.QueryRow(ctx, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, campaign_id, link_url,
    user_agent, ip, at, source, metadata
) VALUES (
    $1::uuid, $2, 'clicked', $3::uuid, $4,
    'runtime-writer-test/1', '192.0.2.201'::inet, $5,
    'runtime-writer-test', jsonb_build_object('suffix', $6::text)
)
RETURNING id, at`, fixture.TenantID,
		fmt.Sprintf("runtime-%s@example.test", suffix), fixture.CampaignID,
		"https://example.test/runtime/"+suffix, at, suffix).Scan(&event.ID, &event.At)
	if err != nil {
		t.Fatalf("insert runtime canonical event: %v", err)
	}
	return event
}

func insertRuntimeExactLegacyReport(
	t *testing.T,
	ctx context.Context,
	tx pgx.Tx,
	fixture projectionFixture,
	event EventRef,
) {
	t.Helper()
	_, err := tx.Exec(ctx, `
INSERT INTO campaign_report_events (
    tenant_id, campaign_id, subscriber_email, event_type, link_url,
    user_agent, ip, country, metadata, at, source, provider_event_id,
    message_id, event_origin, controlled_seed_test_id,
    seed_origin_method, event_origin_version, is_seed
)
SELECT source.tenant_id, source.campaign_id, source.subscriber_email,
       source.event_type, source.link_url, source.user_agent, source.ip,
       source.country, source.metadata, source.at, source.source,
       source.provider_event_id, source.message_id, source.event_origin,
       source.controlled_seed_test_id, source.seed_origin_method,
       source.event_origin_version, source.is_seed
  FROM subscriber_events AS source
 WHERE source.tenant_id = $1::uuid AND source.id = $2 AND source.at = $3`,
		fixture.TenantID, event.ID, event.At)
	if err != nil {
		t.Fatalf("insert exact runtime legacy report: %v", err)
	}
}

func TestRuntimeWriterCompositionIsAtomicAndRestricted_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := projectionDBPools(t, ctx)
	fixture := seedProjectionFixture(t, ctx, admin)
	runtime, err := BuildRuntime(ctx, RuntimeConfiguration{Enabled: true}, (*db.Pool)(app))
	if err != nil {
		t.Fatalf("build restricted-role projection runtime: %v", err)
	}
	if !runtime.Enabled() {
		t.Fatal("enabled projection runtime reports disabled")
	}

	// A plain tenant transaction cannot self-elevate into the projection worker.
	plainTx, err := db.WithTenant(ctx, (*db.Pool)(app), fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	err = runtime.ProjectCanonicalEvent(ctx, plainTx, fixture.TenantID, CanonicalEvent{
		EventRef: EventRef{ID: 1, At: fixture.At}, EventType: "clicked",
		CampaignID: fixture.CampaignID,
	})
	_ = plainTx.Rollback(ctx)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("plain tenant projection error=%v, want ErrInvalidInput", err)
	}

	// Simulate the Listmonk dual-write path: canonical row, exact legacy peer,
	// and immutable adoption all commit together under the restricted app role.
	workerTx, err := db.WithTenantWorker(ctx, (*db.Pool)(app), fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	event := insertRuntimeCanonicalEvent(t, ctx, workerTx, fixture, "commit", fixture.At.Add(30*time.Minute))
	insertRuntimeExactLegacyReport(t, ctx, workerTx, fixture, event)
	if err := runtime.ProjectCanonicalEvent(ctx, workerTx, fixture.TenantID, CanonicalEvent{
		EventRef: event, EventType: "clicked", CampaignID: fixture.CampaignID,
	}); err != nil {
		_ = workerTx.Rollback(ctx)
		t.Fatalf("project exact writer peer: %v", err)
	}
	var method string
	if err := workerTx.QueryRow(ctx, `
SELECT materialization_method
  FROM campaign_report_event_projections
 WHERE tenant_id = $1::uuid
   AND subscriber_event_id = $2 AND subscriber_event_at = $3`,
		fixture.TenantID, event.ID, event.At).Scan(&method); err != nil {
		_ = workerTx.Rollback(ctx)
		t.Fatalf("read same-transaction projection: %v", err)
	}
	if method != "adopted_legacy" {
		_ = workerTx.Rollback(ctx)
		t.Fatalf("materialization method=%q, want adopted_legacy", method)
	}
	if err := workerTx.Commit(ctx); err != nil {
		t.Fatalf("commit composed writer transaction: %v", err)
	}

	var sources, reports, projections int
	if err := admin.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_events WHERE tenant_id = $1::uuid),
  (SELECT count(*) FROM campaign_report_events WHERE tenant_id = $1::uuid),
  (SELECT count(*) FROM campaign_report_event_projections WHERE tenant_id = $1::uuid)`,
		fixture.TenantID).Scan(&sources, &reports, &projections); err != nil {
		t.Fatal(err)
	}
	if sources != 1 || reports != 1 || projections != 1 {
		t.Fatalf("committed counts source=%d report=%d projection=%d, want 1/1/1",
			sources, reports, projections)
	}

	// Two indistinguishable legacy peers are an evidence conflict. The runtime
	// fails closed, and rolling back the caller transaction removes the source
	// and both peers—there is no half-composed canonical event.
	conflictTx, err := db.WithTenantWorker(ctx, (*db.Pool)(app), fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	conflict := insertRuntimeCanonicalEvent(t, ctx, conflictTx, fixture, "conflict", fixture.At.Add(31*time.Minute))
	insertRuntimeExactLegacyReport(t, ctx, conflictTx, fixture, conflict)
	insertRuntimeExactLegacyReport(t, ctx, conflictTx, fixture, conflict)
	err = runtime.ProjectCanonicalEvent(ctx, conflictTx, fixture.TenantID, CanonicalEvent{
		EventRef: conflict, EventType: "clicked", CampaignID: fixture.CampaignID,
	})
	if !errors.Is(err, ErrAmbiguousLegacyRow) {
		_ = conflictTx.Rollback(ctx)
		t.Fatalf("ambiguous writer peers error=%v", err)
	}
	if err := conflictTx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("rollback ambiguous writer transaction: %v", err)
	}
	if err := admin.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_events WHERE tenant_id = $1::uuid),
  (SELECT count(*) FROM campaign_report_events WHERE tenant_id = $1::uuid),
  (SELECT count(*) FROM campaign_report_event_projections WHERE tenant_id = $1::uuid)`,
		fixture.TenantID).Scan(&sources, &reports, &projections); err != nil {
		t.Fatal(err)
	}
	if sources != 1 || reports != 1 || projections != 1 {
		t.Fatalf("failed composition leaked writes source=%d report=%d projection=%d",
			sources, reports, projections)
	}
}

func TestRuntimeConcurrentWriterReplayConvergesToOneProjection_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := projectionDBPools(t, ctx)
	fixture := seedProjectionFixture(t, ctx, admin)
	runtime, err := BuildRuntime(ctx, RuntimeConfiguration{Enabled: true}, (*db.Pool)(app))
	if err != nil {
		t.Fatalf("build restricted-role projection runtime: %v", err)
	}
	seedTx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	event := insertRuntimeCanonicalEvent(
		t, ctx, seedTx, fixture, "concurrent", fixture.At.Add(40*time.Minute),
	)
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit concurrent canonical fixture: %v", err)
	}

	const workers = 12
	start := make(chan struct{})
	errorsOut := make(chan error, workers)
	var wait sync.WaitGroup
	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			tx, err := db.WithTenantWorker(ctx, (*db.Pool)(app), fixture.TenantID)
			if err != nil {
				errorsOut <- err
				return
			}
			defer func() { _ = tx.Rollback(ctx) }()
			err = runtime.ProjectCanonicalEvent(ctx, tx, fixture.TenantID, CanonicalEvent{
				EventRef: event, EventType: "clicked", CampaignID: fixture.CampaignID,
			})
			if err == nil {
				err = tx.Commit(ctx)
			}
			errorsOut <- err
		}()
	}
	close(start)
	wait.Wait()
	close(errorsOut)
	for err := range errorsOut {
		if err != nil {
			t.Fatalf("concurrent exact projection replay: %v", err)
		}
	}
	var reportCount, projectionCount int
	if err := admin.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM campaign_report_events report
     JOIN campaign_report_event_projections projection_row
       ON projection_row.tenant_id=report.tenant_id
      AND projection_row.campaign_report_event_id=report.id
      AND projection_row.campaign_report_event_at=report.at
    WHERE projection_row.tenant_id=$1::uuid
      AND projection_row.subscriber_event_id=$2
      AND projection_row.subscriber_event_at=$3),
  (SELECT count(*) FROM campaign_report_event_projections
    WHERE tenant_id=$1::uuid AND subscriber_event_id=$2 AND subscriber_event_at=$3)`,
		fixture.TenantID, event.ID, event.At).Scan(&reportCount, &projectionCount); err != nil {
		t.Fatal(err)
	}
	if reportCount != 1 || projectionCount != 1 {
		t.Fatalf("concurrent replay report/projection=%d/%d, want 1/1", reportCount, projectionCount)
	}
}
