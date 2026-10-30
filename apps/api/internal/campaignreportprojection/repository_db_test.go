// SPDX-License-Identifier: AGPL-3.0-only

package campaignreportprojection

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type projectionFixture struct {
	TenantID        string
	ForeignTenantID string
	CampaignID      string
	ForeignCampaign string
	At              time.Time
}

func projectionDBPools(t *testing.T, ctx context.Context) (*pgxpool.Pool, *pgxpool.Pool) {
	t.Helper()
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_REPORT_PROJECTION_TEST_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("POSTWAVE_REPORT_PROJECTION_APP_TEST_DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_REPORT_PROJECTION_TEST_DATABASE_URL and POSTWAVE_REPORT_PROJECTION_APP_TEST_DATABASE_URL are required")
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect projection admin database: %v", err)
	}
	t.Cleanup(admin.Close)
	app, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect projection app database: %v", err)
	}
	t.Cleanup(app.Close)
	var ready bool
	if err := admin.QueryRow(ctx, `
SELECT to_regclass('public.campaign_report_event_projections') IS NOT NULL
   AND to_regclass('public.campaign_report_projection_runs') IS NOT NULL
   AND to_regprocedure('public.append_campaign_report_event_projection(uuid,bigint,timestamp with time zone,text,uuid,uuid,integer)') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatal(err)
	}
	if !ready {
		t.Fatal("configured database is missing migration 1959")
	}
	var user string
	var bypass bool
	if err := app.QueryRow(ctx, `
SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user`).Scan(&user, &bypass); err != nil {
		t.Fatal(err)
	}
	if user != "postwave_app" || bypass {
		t.Skipf("app DSN must use non-bypass postwave_app; got %q bypass=%v", user, bypass)
	}
	var invalidReplyConstraints int
	if err := admin.QueryRow(ctx, `
SELECT count(*)
  FROM pg_partition_tree('campaign_report_events') AS tree
  LEFT JOIN pg_constraint AS constraint_row
    ON constraint_row.conrelid = tree.relid
   AND constraint_row.conname = 'campaign_report_events_event_type_check'
 WHERE constraint_row.oid IS NULL
    OR NOT constraint_row.convalidated
    OR pg_get_constraintdef(constraint_row.oid) NOT LIKE '%replied%'`).Scan(&invalidReplyConstraints); err != nil {
		t.Fatal(err)
	}
	if invalidReplyConstraints != 0 {
		t.Fatalf("%d campaign report partitions lack the validated replied constraint", invalidReplyConstraints)
	}
	var unsafeRLS int
	if err := admin.QueryRow(ctx, `
SELECT count(*)
  FROM pg_class
 WHERE relname = ANY($1::text[])
   AND (NOT relrowsecurity OR NOT relforcerowsecurity)`, []string{
		"campaign_report_event_projection_identities",
		"campaign_report_event_projections",
		"campaign_report_projection_runs",
	}).Scan(&unsafeRLS); err != nil {
		t.Fatal(err)
	}
	if unsafeRLS != 0 {
		t.Fatalf("%d projection tables lack enabled+forced RLS", unsafeRLS)
	}
	var tenantSafeProjectionEdges int
	if err := admin.QueryRow(ctx, `
SELECT count(*)
  FROM pg_constraint
 WHERE conname IN (
       'campaign_report_event_projections_source_fk',
       'campaign_report_event_projections_report_fk'
   )
   AND cardinality(conkey) = 3
   AND cardinality(confkey) = 3`).Scan(&tenantSafeProjectionEdges); err != nil {
		t.Fatal(err)
	}
	if tenantSafeProjectionEdges != 2 {
		t.Fatalf("tenant-safe composite projection edges=%d, want 2", tenantSafeProjectionEdges)
	}
	var canInsertEvidence, canUpdateEvidence bool
	if err := app.QueryRow(ctx, `
SELECT has_table_privilege(current_user, 'campaign_report_event_projections', 'INSERT'),
       has_table_privilege(current_user, 'campaign_report_event_projections', 'UPDATE')`).Scan(
		&canInsertEvidence, &canUpdateEvidence); err != nil {
		t.Fatal(err)
	}
	if canInsertEvidence || canUpdateEvidence {
		t.Fatalf("postwave_app immutable evidence privileges insert=%v update=%v",
			canInsertEvidence, canUpdateEvidence)
	}
	return admin, app
}

func seedProjectionFixture(t *testing.T, ctx context.Context, admin *pgxpool.Pool) projectionFixture {
	t.Helper()
	fixture := projectionFixture{
		TenantID: uuid.NewString(), ForeignTenantID: uuid.NewString(),
		CampaignID: uuid.NewString(), ForeignCampaign: uuid.NewString(),
		At: time.Now().UTC().Truncate(time.Microsecond).Add(-2 * time.Hour),
	}
	suffix := strings.ReplaceAll(fixture.TenantID, "-", "")[:10]
	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES
    ($1::uuid, $2, 'Projection DB tenant', 'studio'),
	($3::uuid, $4, 'Projection foreign tenant', 'studio')`,
		fixture.TenantID, "projection-"+suffix, fixture.ForeignTenantID,
		"projection-foreign-"+suffix)
	if err != nil {
		t.Fatalf("seed projection fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html) VALUES
    ($1::uuid, $2::uuid, 'Projection campaign', 'Projection', '<p>x</p>'),
    ($3::uuid, $4::uuid, 'Projection foreign campaign', 'Projection', '<p>x</p>')`,
		fixture.CampaignID, fixture.TenantID, fixture.ForeignCampaign,
		fixture.ForeignTenantID); err != nil {
		t.Fatalf("seed projection campaigns: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit projection fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = admin.Exec(cleanupCtx, `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
			fixture.TenantID, fixture.ForeignTenantID)
	})
	return fixture
}

func insertCanonicalEvent(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	fixture projectionFixture,
	index int,
	eventType string,
	at time.Time,
) EventRef {
	t.Helper()
	var event EventRef
	suffix := strings.ReplaceAll(fixture.TenantID, "-", "")[:10]
	err := admin.QueryRow(ctx, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, campaign_id, link_url,
    user_agent, ip, at, source, provider_event_id, source_event_id,
    message_id, metadata, country
) VALUES (
    $1::uuid, $2, $3, $4::uuid, $5, $6, $7::inet, $8,
    'projection-db', $9, $9, $10, $11::jsonb, $12
)
RETURNING id, at`, fixture.TenantID,
		fmt.Sprintf("recipient-%d-%s@example.test", index, suffix), eventType,
		fixture.CampaignID, fmt.Sprintf("https://example.test/%d", index),
		fmt.Sprintf("projection-agent/%d", index), fmt.Sprintf("192.0.2.%d", index+1),
		at, fmt.Sprintf("projection-provider-%s-%d", suffix, index),
		fmt.Sprintf("<projection-%s-%d@example.test>", suffix, index),
		fmt.Sprintf(`{"fixture":%d}`, index), "US").Scan(&event.ID, &event.At)
	if err != nil {
		t.Fatalf("insert canonical event %d: %v", index, err)
	}
	return event
}

func insertExactLegacyReport(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	fixture projectionFixture,
	event EventRef,
) int64 {
	t.Helper()
	var reportID int64
	err := admin.QueryRow(ctx, `
INSERT INTO campaign_report_events (
    tenant_id, campaign_id, subscriber_email, event_type, link_url,
    user_agent, ip, country, metadata, at, source, provider_event_id,
    message_id, event_origin, event_origin_version, is_seed
)
SELECT event.tenant_id, event.campaign_id, event.subscriber_email,
       event.event_type, event.link_url, event.user_agent, event.ip,
       event.country, event.metadata, event.at, event.source,
       event.provider_event_id, event.message_id, event.event_origin,
       event.event_origin_version, event.is_seed
  FROM subscriber_events AS event
 WHERE event.tenant_id = $1::uuid AND event.id = $2 AND event.at = $3
RETURNING id`, fixture.TenantID, event.ID, event.At).Scan(&reportID)
	if err != nil {
		t.Fatalf("insert exact legacy report: %v", err)
	}
	return reportID
}

func projectionSQLState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}

func TestProjectionExactReplayAdoptionRLSAndAppendOnly_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := projectionDBPools(t, ctx)
	fixture := seedProjectionFixture(t, ctx, admin)
	repo := &Repo{Pool: (*db.Pool)(app)}

	insertedEvent := insertCanonicalEvent(t, ctx, admin, fixture, 1, "clicked", fixture.At)
	assertProjectionFunctionDenied(t, ctx, app, fixture.TenantID, insertedEvent, false, false)
	assertProjectionFunctionDenied(t, ctx, app, fixture.TenantID, insertedEvent, true, false)
	assertProjectionFunctionDenied(t, ctx, app, fixture.TenantID, insertedEvent, false, true)
	first, err := repo.Append(ctx, fixture.TenantID, insertedEvent, ProjectionVersionV1)
	if err != nil {
		t.Fatalf("append canonical projection: %v", err)
	}
	if !first.ProjectionInserted || first.MaterializationMethod != "inserted_projection" {
		t.Fatalf("first receipt=%+v", first)
	}
	replay, err := repo.Append(ctx, fixture.TenantID, insertedEvent, ProjectionVersionV1)
	if err != nil {
		t.Fatalf("exact projection replay: %v", err)
	}
	if replay.ProjectionInserted || replay.CampaignReportEventID != first.CampaignReportEventID ||
		!replay.CampaignReportEventAt.Equal(first.CampaignReportEventAt) {
		t.Fatalf("replay=%+v first=%+v", replay, first)
	}
	if _, err := repo.Append(ctx, fixture.TenantID, insertedEvent,
		"postwave.campaign-report-projection.v2"); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflicting replay error=%v", err)
	}

	adoptedEvent := insertCanonicalEvent(t, ctx, admin, fixture, 2, "opened", fixture.At.Add(time.Second))
	legacyID := insertExactLegacyReport(t, ctx, admin, fixture, adoptedEvent)
	adopted, err := repo.Append(ctx, fixture.TenantID, adoptedEvent, ProjectionVersionV1)
	if err != nil {
		t.Fatalf("adopt exact legacy row: %v", err)
	}
	if !adopted.ProjectionInserted || adopted.MaterializationMethod != "adopted_legacy" ||
		adopted.CampaignReportEventID != legacyID {
		t.Fatalf("adoption receipt=%+v legacy=%d", adopted, legacyID)
	}

	replied := insertCanonicalEvent(t, ctx, admin, fixture, 3, "replied", fixture.At.Add(2*time.Second))
	repliedReceipt, err := repo.Append(ctx, fixture.TenantID, replied, ProjectionVersionV1)
	if err != nil || repliedReceipt.MaterializationMethod != "inserted_projection" {
		t.Fatalf("project canonical reply receipt=%+v err=%v", repliedReceipt, err)
	}
	unsupported := insertCanonicalEvent(t, ctx, admin, fixture, 4, "custom", fixture.At.Add(3*time.Second))
	if _, err := repo.Append(ctx, fixture.TenantID, unsupported,
		ProjectionVersionV1); !errors.Is(err, ErrUnsupportedCanonicalRow) {
		t.Fatalf("unsupported event error=%v", err)
	}
	if _, err := repo.Append(ctx, fixture.ForeignTenantID, insertedEvent,
		ProjectionVersionV1); err == nil {
		t.Fatal("foreign tenant projected another tenant's canonical event")
	}

	var reportCount, projectionCount int
	if err := admin.QueryRow(ctx, `
SELECT (SELECT count(*) FROM campaign_report_events WHERE tenant_id = $1::uuid),
       (SELECT count(*) FROM campaign_report_event_projections WHERE tenant_id = $1::uuid)`,
		fixture.TenantID).Scan(&reportCount, &projectionCount); err != nil {
		t.Fatal(err)
	}
	if reportCount != 3 || projectionCount != 3 {
		t.Fatalf("dual-run counts report=%d projections=%d, want 3/3", reportCount, projectionCount)
	}

	if _, err := admin.Exec(ctx, `
UPDATE campaign_report_event_projections
   SET projection_version = 'postwave.campaign-report-projection.v2'
 WHERE tenant_id = $1::uuid AND subscriber_event_id = $2 AND subscriber_event_at = $3`,
		fixture.TenantID, insertedEvent.ID, insertedEvent.At); projectionSQLState(err) != "55000" {
		t.Fatalf("projection evidence mutation SQLSTATE=%q err=%v", projectionSQLState(err), err)
	}
	if _, err := admin.Exec(ctx, `
UPDATE campaign_report_events SET metadata = '{"tampered":true}'::jsonb
 WHERE tenant_id = $1::uuid AND id = $2 AND at = $3`, fixture.TenantID,
		first.CampaignReportEventID, first.CampaignReportEventAt); projectionSQLState(err) != "55000" {
		t.Fatalf("projected report mutation SQLSTATE=%q err=%v", projectionSQLState(err), err)
	}

	// Deliberately capture the current compatibility blocker: canonical rows
	// are mutated by privacy erasure/merge today, while linked report rows are
	// immutable. Replay must fail closed instead of claiming stale PII is an
	// exact projection, and rollback must not silently discard lineage.
	if _, err := admin.Exec(ctx, `
UPDATE subscriber_events
   SET subscriber_email = 'erased+projection@example.invalid',
       user_agent = NULL, ip = NULL
 WHERE tenant_id = $1::uuid AND id = $2 AND at = $3`, fixture.TenantID,
		insertedEvent.ID, insertedEvent.At); err != nil {
		t.Fatalf("simulate canonical privacy mutation: %v", err)
	}
	if _, err := repo.Append(ctx, fixture.TenantID, insertedEvent,
		ProjectionVersionV1); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("privacy-diverged replay error=%v", err)
	}
	var retainedEmail, retainedAgent, retainedIP string
	if err := admin.QueryRow(ctx, `
SELECT subscriber_email::text, COALESCE(user_agent, ''), COALESCE(ip::text, '')
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND id = $2 AND at = $3`, fixture.TenantID,
		first.CampaignReportEventID, first.CampaignReportEventAt).Scan(
		&retainedEmail, &retainedAgent, &retainedIP); err != nil {
		t.Fatal(err)
	}
	if retainedEmail == "erased+projection@example.invalid" || retainedAgent == "" || retainedIP == "" {
		t.Fatalf("privacy mutation unexpectedly rewrote linked report email=%q ua=%q ip=%q",
			retainedEmail, retainedAgent, retainedIP)
	}
	if _, err := admin.Exec(ctx, `
DELETE FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND id = $2 AND at = $3`, fixture.TenantID,
		first.CampaignReportEventID, first.CampaignReportEventAt); projectionSQLState(err) != "55000" {
		t.Fatalf("linked rollback delete SQLSTATE=%q err=%v", projectionSQLState(err), err)
	}
	var unlinkedReportID int64
	var unlinkedReportAt time.Time
	if err := admin.QueryRow(ctx, `
INSERT INTO campaign_report_events (tenant_id, campaign_id, event_type, at)
VALUES ($1::uuid, $2::uuid, 'sent', $3)
RETURNING id, at`, fixture.TenantID, fixture.CampaignID,
		fixture.At.Add(10*time.Second)).Scan(&unlinkedReportID, &unlinkedReportAt); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
DELETE FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND id = $2 AND at = $3`, fixture.TenantID,
		unlinkedReportID, unlinkedReportAt); err != nil {
		t.Fatalf("unlinked legacy rollback delete was not preserved: %v", err)
	}

	assertProjectionRLSCount(t, ctx, app, fixture.TenantID, false, false, 0)
	assertProjectionRLSCount(t, ctx, app, fixture.TenantID, true, false, 0)
	assertProjectionRLSCount(t, ctx, app, fixture.TenantID, false, true, 0)
	assertProjectionRLSCount(t, ctx, app, fixture.TenantID, true, true, 3)
	assertProjectionRLSCount(t, ctx, app, fixture.ForeignTenantID, true, true, 0)
}

func assertProjectionFunctionDenied(
	t *testing.T,
	ctx context.Context,
	app *pgxpool.Pool,
	tenantID string,
	event EventRef,
	generic, purpose bool,
) {
	t.Helper()
	tx, err := app.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
SELECT set_config('app.tenant_id', $1, true),
       set_config('app.outbox_worker', $2, true),
       set_config('app.campaign_report_projection_worker', $3, true)`,
		tenantID, fmt.Sprint(generic), fmt.Sprint(purpose)); err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `
SELECT * FROM append_campaign_report_event_projection(
    $1::uuid, $2, $3, $4
)`, tenantID, event.ID, event.At, ProjectionVersionV1)
	if projectionSQLState(err) != "42501" {
		t.Fatalf("function generic=%v purpose=%v SQLSTATE=%q err=%v",
			generic, purpose, projectionSQLState(err), err)
	}
}

func assertProjectionRLSCount(
	t *testing.T,
	ctx context.Context,
	app *pgxpool.Pool,
	tenantID string,
	generic, purpose bool,
	want int,
) {
	t.Helper()
	tx, err := app.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
SELECT set_config('app.tenant_id', $1, true),
       set_config('app.outbox_worker', $2, true),
       set_config('app.campaign_report_projection_worker', $3, true)`,
		tenantID, fmt.Sprint(generic), fmt.Sprint(purpose)); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM campaign_report_event_projections`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("RLS generic=%v purpose=%v tenant=%s count=%d want=%d",
			generic, purpose, tenantID, count, want)
	}
}

func TestReconciliationFenceCursorLeaseAndNoDoubleCount_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := projectionDBPools(t, ctx)
	fixture := seedProjectionFixture(t, ctx, admin)
	events := []EventRef{
		insertCanonicalEvent(t, ctx, admin, fixture, 11, "opened", fixture.At),
		insertCanonicalEvent(t, ctx, admin, fixture, 12, "clicked", fixture.At.Add(time.Second)),
		insertCanonicalEvent(t, ctx, admin, fixture, 13, "delivered", fixture.At.Add(2*time.Second)),
	}
	legacyID := insertExactLegacyReport(t, ctx, admin, fixture, events[1])
	repo := &Repo{
		Pool: (*db.Pool)(app), WorkerID: "projection-db-worker-a",
		LeaseTTL: time.Minute,
	}
	request := ReconciliationRequest{
		RequestID: uuid.NewString(), ProjectionVersion: ProjectionVersionV1,
		WindowStart: fixture.At.Add(-time.Minute), WindowEnd: fixture.At.Add(time.Hour),
	}
	run, err := repo.StartReconciliation(ctx, fixture.TenantID, request)
	if err != nil {
		t.Fatalf("start reconciliation: %v", err)
	}
	if run.State != "running" || run.CandidateCount != 3 || run.FenceEventID != events[2].ID ||
		run.AttemptCount != 1 || run.LeaseToken == "" {
		t.Fatalf("initial run=%+v", run)
	}
	if _, err := repo.StartReconciliation(ctx, fixture.TenantID,
		ReconciliationRequest{RequestID: request.RequestID,
			ProjectionVersion: request.ProjectionVersion,
			WindowStart:       request.WindowStart, WindowEnd: request.WindowEnd.Add(time.Second),
		}); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflicting request replay error=%v", err)
	}

	late := insertCanonicalEvent(t, ctx, admin, fixture, 14, "clicked", fixture.At.Add(500*time.Millisecond))
	if late.ID <= run.FenceEventID {
		t.Fatalf("late event id=%d did not exceed fence=%d", late.ID, run.FenceEventID)
	}
	outsideTx, err := db.WithTenantWorker(ctx, (*db.Pool)(app), fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AppendInTx(ctx, outsideTx, fixture.TenantID, late,
		run.ProjectionVersion, run.ID, run.LeaseToken,
		run.AttemptCount); !errors.Is(err, ErrLeaseLost) {
		_ = outsideTx.Rollback(ctx)
		t.Fatalf("outside-fence run lineage error=%v", err)
	}
	_ = outsideTx.Rollback(ctx)
	run, err = repo.ProcessBatch(ctx, fixture.TenantID, run.ID,
		run.LeaseToken, run.AttemptCount, 1)
	if err != nil {
		t.Fatalf("process first bounded page: %v", err)
	}
	if run.State != "running" || run.ProcessedCount != 1 || run.Cursor == nil {
		t.Fatalf("first page run=%+v", run)
	}
	if _, err := admin.Exec(ctx, `
UPDATE campaign_report_projection_runs
   SET cursor_event_at = $3, cursor_event_id = $4, updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.TenantID, run.ID,
		request.WindowStart, int64(1)); projectionSQLState(err) != "55000" {
		t.Fatalf("backward cursor SQLSTATE=%q err=%v", projectionSQLState(err), err)
	}

	for run.State == "running" {
		run, err = repo.ProcessBatch(ctx, fixture.TenantID, run.ID,
			run.LeaseToken, run.AttemptCount, 1)
		if err != nil {
			t.Fatalf("process reconciliation page: %v", err)
		}
	}
	if run.State != "completed" || run.ProcessedCount != 3 ||
		run.InsertedCount != 2 || run.AdoptedCount != 1 || run.ReplayedCount != 0 {
		t.Fatalf("completed run=%+v", run)
	}
	var reports, links, lateLinks int
	if err := admin.QueryRow(ctx, `
SELECT (SELECT count(*) FROM campaign_report_events WHERE tenant_id = $1::uuid),
       (SELECT count(*) FROM campaign_report_event_projections WHERE tenant_id = $1::uuid),
       (SELECT count(*) FROM campaign_report_event_projections
         WHERE tenant_id = $1::uuid AND subscriber_event_id = $2 AND subscriber_event_at = $3)`,
		fixture.TenantID, late.ID, late.At).Scan(&reports, &links, &lateLinks); err != nil {
		t.Fatal(err)
	}
	if reports != 3 || links != 3 || lateLinks != 0 {
		t.Fatalf("fenced counts reports=%d links=%d late_links=%d", reports, links, lateLinks)
	}
	var adoptedReportID int64
	if err := admin.QueryRow(ctx, `
SELECT campaign_report_event_id FROM campaign_report_event_projections
 WHERE tenant_id = $1::uuid AND subscriber_event_id = $2 AND subscriber_event_at = $3`,
		fixture.TenantID, events[1].ID, events[1].At).Scan(&adoptedReportID); err != nil {
		t.Fatal(err)
	}
	if adoptedReportID != legacyID {
		t.Fatalf("reconciliation did not adopt legacy report: got=%d want=%d", adoptedReportID, legacyID)
	}
}

func TestAmbiguousLegacyRowsAreRejectedWithoutLinking_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := projectionDBPools(t, ctx)
	fixture := seedProjectionFixture(t, ctx, admin)
	event := insertCanonicalEvent(t, ctx, admin, fixture, 8, "opened", fixture.At)
	if _, err := admin.Exec(ctx, `
UPDATE subscriber_events SET provider_event_id = NULL
 WHERE tenant_id=$1::uuid AND id=$2 AND at=$3`, fixture.TenantID,
		event.ID, event.At); err != nil {
		t.Fatal(err)
	}
	_ = insertExactLegacyReport(t, ctx, admin, fixture, event)
	_ = insertExactLegacyReport(t, ctx, admin, fixture, event)
	repo := &Repo{Pool: (*db.Pool)(app)}
	if _, err := repo.Append(ctx, fixture.TenantID, event,
		ProjectionVersionV1); !errors.Is(err, ErrAmbiguousLegacyRow) {
		t.Fatalf("ambiguous legacy projection error=%v", err)
	}
	var reports, links int
	if err := admin.QueryRow(ctx, `
SELECT (SELECT count(*) FROM campaign_report_events WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM campaign_report_event_projections WHERE tenant_id=$1::uuid)`,
		fixture.TenantID).Scan(&reports, &links); err != nil {
		t.Fatal(err)
	}
	if reports != 2 || links != 0 {
		t.Fatalf("ambiguous rows were changed reports=%d links=%d", reports, links)
	}
}

func TestExpiredLeaseIsFencedFromProjectionProgress_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := projectionDBPools(t, ctx)
	fixture := seedProjectionFixture(t, ctx, admin)
	_ = insertCanonicalEvent(t, ctx, admin, fixture, 21, "opened", fixture.At)
	request := ReconciliationRequest{
		RequestID: uuid.NewString(), WindowStart: fixture.At.Add(-time.Minute),
		WindowEnd: fixture.At.Add(time.Minute),
	}
	firstRepo := &Repo{Pool: (*db.Pool)(app), WorkerID: "projection-stale-a", LeaseTTL: 10 * time.Millisecond}
	first, err := firstRepo.StartReconciliation(ctx, fixture.TenantID, request)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	secondRepo := &Repo{Pool: (*db.Pool)(app), WorkerID: "projection-stale-b", LeaseTTL: time.Minute}
	second, err := secondRepo.StartReconciliation(ctx, fixture.TenantID, request)
	if err != nil {
		t.Fatalf("reclaim expired projection lease: %v", err)
	}
	if second.AttemptCount != first.AttemptCount+1 || second.LeaseToken == first.LeaseToken {
		t.Fatalf("lease was not fenced: first=%+v second=%+v", first, second)
	}
	if _, err := firstRepo.ProcessBatch(ctx, fixture.TenantID, first.ID,
		first.LeaseToken, first.AttemptCount, 1); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale worker error=%v", err)
	}
	completed, err := secondRepo.ProcessBatch(ctx, fixture.TenantID, second.ID,
		second.LeaseToken, second.AttemptCount, 1)
	if err != nil {
		t.Fatalf("fenced worker process: %v", err)
	}
	if completed.State != "completed" || completed.ProcessedCount != 1 {
		t.Fatalf("completed reclaimed run=%+v", completed)
	}
}

func TestGovernedFailureIsFencedAndTerminal_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := projectionDBPools(t, ctx)
	fixture := seedProjectionFixture(t, ctx, admin)
	_ = insertCanonicalEvent(t, ctx, admin, fixture, 31, "opened", fixture.At)
	repo := &Repo{Pool: (*db.Pool)(app), WorkerID: "projection-fail-worker", LeaseTTL: time.Minute}
	request := ReconciliationRequest{
		RequestID: uuid.NewString(), WindowStart: fixture.At.Add(-time.Minute),
		WindowEnd: fixture.At.Add(time.Minute),
	}
	run, err := repo.StartReconciliation(ctx, fixture.TenantID, request)
	if err != nil {
		t.Fatal(err)
	}
	failed, err := repo.FailReconciliation(ctx, fixture.TenantID, run.ID,
		run.LeaseToken, run.AttemptCount, "operator_abandoned")
	if err != nil {
		t.Fatalf("fail reconciliation: %v", err)
	}
	if failed.State != "failed" || failed.ErrorCode != "operator_abandoned" ||
		failed.CompletedAt == nil {
		t.Fatalf("failed run=%+v", failed)
	}
	if _, err := repo.ProcessBatch(ctx, fixture.TenantID, run.ID,
		run.LeaseToken, run.AttemptCount, 1); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("terminal run accepted progress: %v", err)
	}
	replayed, err := repo.StartReconciliation(ctx, fixture.TenantID, request)
	if err != nil || replayed.State != "failed" || replayed.ID != run.ID {
		t.Fatalf("failed request replay=%+v err=%v", replayed, err)
	}
	if _, err := admin.Exec(ctx, `
UPDATE campaign_report_projection_runs SET error_code = 'rewritten'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.TenantID,
		run.ID); projectionSQLState(err) != "55000" {
		t.Fatalf("terminal mutation SQLSTATE=%q err=%v", projectionSQLState(err), err)
	}
}

func TestPreFenceLateCommitFailsRunDurably_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := projectionDBPools(t, ctx)
	fixture := seedProjectionFixture(t, ctx, admin)

	lateCommitTx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lateCommitTx.Rollback(ctx) }()
	var lateAllocated EventRef
	if err := lateCommitTx.QueryRow(ctx, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, campaign_id, at,
    source, source_event_id, metadata
) VALUES ($1::uuid, 'late-allocated@example.test', 'opened', $2::uuid,
          $3, 'projection-race', $4, '{}'::jsonb)
RETURNING id, at`, fixture.TenantID, fixture.CampaignID, fixture.At,
		uuid.NewString()).Scan(&lateAllocated.ID, &lateAllocated.At); err != nil {
		t.Fatal(err)
	}
	visible := insertCanonicalEvent(t, ctx, admin, fixture, 41, "clicked",
		fixture.At.Add(time.Second))
	if visible.ID <= lateAllocated.ID {
		t.Fatalf("visible id=%d must exceed in-flight id=%d", visible.ID, lateAllocated.ID)
	}

	repo := &Repo{Pool: (*db.Pool)(app), WorkerID: "projection-race-worker", LeaseTTL: time.Minute}
	request := ReconciliationRequest{
		RequestID: uuid.NewString(), WindowStart: fixture.At.Add(-time.Minute),
		WindowEnd: fixture.At.Add(time.Minute),
	}
	run, err := repo.StartReconciliation(ctx, fixture.TenantID, request)
	if err != nil {
		t.Fatal(err)
	}
	if run.CandidateCount != 1 || run.FenceEventID != visible.ID {
		t.Fatalf("initial race fence=%+v", run)
	}
	if err := lateCommitTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	failed, err := repo.ProcessBatch(ctx, fixture.TenantID, run.ID,
		run.LeaseToken, run.AttemptCount, 10)
	if !errors.Is(err, ErrSourceFenceChanged) {
		t.Fatalf("late pre-fence commit error=%v run=%+v", err, failed)
	}
	if failed.State != "failed" || failed.ErrorCode != "source_fence_changed" ||
		failed.ProcessedCount != 0 || failed.CompletedAt == nil {
		t.Fatalf("late pre-fence commit did not terminate durably: %+v", failed)
	}
	var reportCount, linkCount int
	if err := admin.QueryRow(ctx, `
SELECT (SELECT count(*) FROM campaign_report_events WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM campaign_report_event_projections WHERE tenant_id=$1::uuid)`,
		fixture.TenantID).Scan(&reportCount, &linkCount); err != nil {
		t.Fatal(err)
	}
	if reportCount != 0 || linkCount != 0 {
		t.Fatalf("failed race batch partially committed reports=%d links=%d", reportCount, linkCount)
	}
}

var _ pgx.Tx // keep pgx imported for compile-time DB contract documentation.
