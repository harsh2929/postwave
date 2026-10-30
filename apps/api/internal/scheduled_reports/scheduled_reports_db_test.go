// SPDX-License-Identifier: AGPL-3.0-only
package scheduled_reports

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func scheduledReportDB(t *testing.T) *db.Pool {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping scheduled-report PostgreSQL tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	var migrated bool
	if err := pool.QueryRow(ctx, `
SELECT
    to_regclass('public.scheduled_report_runs') IS NOT NULL
    AND to_regclass('public.scheduled_report_delivery_receipts') IS NOT NULL
    AND EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'scheduled_reports'
           AND column_name = 'timezone'
    )
    AND EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'scheduled_reports'
           AND column_name = 'delivery_next_due_at'
    )`).Scan(&migrated); err != nil || !migrated {
		t.Fatalf("migration 1804 is not applied")
	}
	return pool
}

func scheduledReportTenant(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
) string {
	t.Helper()
	tenantID := uuid.NewString()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(
		ctx,
		`SELECT set_config('app.tenant_id', $1, true)`,
		tenantID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $2, 'studio')`,
		tenantID,
		"scheduled-report-"+stringsWithoutHyphens(tenantID),
	); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cleanup, err := db.WithTenant(cleanupCtx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(
			cleanupCtx,
			`DELETE FROM tenants WHERE id = $1::uuid`,
			tenantID,
		)
		_ = cleanup.Commit(cleanupCtx)
	})
	return tenantID
}

func stringsWithoutHyphens(value string) string {
	out := make([]byte, 0, len(value))
	for i := 0; i < len(value); i++ {
		if value[i] != '-' {
			out = append(out, value[i])
		}
	}
	return string(out)
}

func seedScheduledReport(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID string,
	dueAt time.Time,
	recipients []string,
) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var reportID string
	err = tx.QueryRow(ctx, `
INSERT INTO scheduled_reports (
    tenant_id,
    name,
    template,
    schedule,
    timezone,
    recipients,
    next_due_at
)
VALUES (
    $1::uuid,
    'Executive engagement',
    'engagement_summary',
    'weekly:sun@09:00',
    'America/New_York',
    $2::text[],
    $3
)
RETURNING id::text`,
		tenantID,
		recipients,
		dueAt,
	).Scan(&reportID)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return reportID
}

type recordingReportMailer struct {
	mu    sync.Mutex
	calls map[string]int
	err   error
}

func (m *recordingReportMailer) Send(
	_ context.Context,
	to, _, _ string,
) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.calls == nil {
		m.calls = map[string]int{}
	}
	m.calls[to]++
	return m.err
}

func TestLegacyCursorWritesAreRedirectedAndOldWorkersFailClosedDB(t *testing.T) {
	pool := scheduledReportDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tenantID := scheduledReportTenant(t, ctx, pool)
	dueAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	reportID := seedScheduledReport(
		t,
		ctx,
		pool,
		tenantID,
		dueAt,
		[]string{"rollout@example.test"},
	)

	assertCursor := func(want time.Time) {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var durable time.Time
		var legacyVisible int
		if err := tx.QueryRow(ctx, `
SELECT
    delivery_next_due_at,
    (COUNT(*) FILTER (
        WHERE next_due_at IS NOT NULL AND next_due_at <= now()
    ) OVER ())::integer
  FROM scheduled_reports
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
			tenantID,
			reportID,
		).Scan(&durable, &legacyVisible); err != nil {
			t.Fatal(err)
		}
		if !durable.Equal(want) || legacyVisible != 0 {
			t.Fatalf(
				"durable/legacy-visible cursor = %s/%d, want %s/0",
				durable,
				legacyVisible,
				want,
			)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	assertCursor(dueAt)

	// Model an old API/worker binary explicitly writing the legacy column
	// during an ECS rolling replacement. The trigger must preserve the write
	// for the new worker while keeping the old worker's read predicate empty.
	replacementDue := dueAt.Add(7 * 24 * time.Hour)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE scheduled_reports
   SET next_due_at = $1
 WHERE tenant_id = $2::uuid
   AND id = $3::uuid`,
		replacementDue,
		tenantID,
		reportID,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	assertCursor(replacementDue)
}

func TestScheduledReportCRUDUsesDurableTimezoneCursorDB(t *testing.T) {
	pool := scheduledReportDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := scheduledReportTenant(t, ctx, pool)
	requestContext := middleware.WithTenant(
		ctx,
		&middleware.Tenant{ID: tenantID},
	)
	deps := &Deps{Pool: pool}

	createRequest := httptest.NewRequestWithContext(
		requestContext,
		http.MethodPost,
		"/api/v1/scheduled-reports",
		strings.NewReader(`{
			"name":"  Executive pulse  ",
			"template":"growth",
			"schedule":"weekly:mon@09:00",
			"timezone":"America/New_York",
			"recipients":[
				"Owner <owner@example.test>",
				"owner@EXAMPLE.test"
			]
		}`),
	)
	createRequest.Header.Set("Content-Type", "application/json")
	createRecorder := httptest.NewRecorder()
	deps.Create(createRecorder, createRequest)
	if createRecorder.Code != http.StatusCreated {
		t.Fatalf(
			"create status/body = %d %s",
			createRecorder.Code,
			createRecorder.Body.String(),
		)
	}
	var created struct {
		ID        string    `json:"id"`
		NextDueAt time.Time `json:"next_due_at"`
		Timezone  string    `json:"timezone"`
	}
	if err := json.Unmarshal(createRecorder.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if _, err := uuid.Parse(created.ID); err != nil ||
		created.Timezone != "America/New_York" ||
		!created.NextDueAt.After(time.Now().UTC()) {
		t.Fatalf("created report contract = %#v, id error=%v", created, err)
	}

	patchRoute := chi.NewRouteContext()
	patchRoute.URLParams.Add("id", created.ID)
	patchContext := context.WithValue(requestContext, chi.RouteCtxKey, patchRoute)
	patchRequest := httptest.NewRequestWithContext(
		patchContext,
		http.MethodPatch,
		"/api/v1/scheduled-reports/"+created.ID,
		strings.NewReader(`{
			"name":"  Board pulse  ",
			"schedule":"weekly:fri@17:30",
			"timezone":"Asia/Kolkata",
			"recipients":[
				"Ops <ops@example.test>",
				"ops@EXAMPLE.test"
			]
		}`),
	)
	patchRequest.Header.Set("Content-Type", "application/json")
	patchRecorder := httptest.NewRecorder()
	deps.Patch(patchRecorder, patchRequest)
	if patchRecorder.Code != http.StatusOK {
		t.Fatalf(
			"patch status/body = %d %s",
			patchRecorder.Code,
			patchRecorder.Body.String(),
		)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var (
		name, schedule, timezone string
		recipients               []string
		durableDue               time.Time
		legacyDue                *time.Time
	)
	if err := tx.QueryRow(ctx, `
SELECT
    name,
    schedule,
    timezone,
    recipients,
    delivery_next_due_at,
    next_due_at
  FROM scheduled_reports
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID,
		created.ID,
	).Scan(
		&name,
		&schedule,
		&timezone,
		&recipients,
		&durableDue,
		&legacyDue,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	location, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Fatal(err)
	}
	localDue := durableDue.In(location)
	if name != "Board pulse" ||
		schedule != "weekly:fri@17:30" ||
		timezone != "Asia/Kolkata" ||
		len(recipients) != 1 ||
		recipients[0] != "ops@example.test" ||
		legacyDue != nil ||
		localDue.Weekday() != time.Friday ||
		localDue.Hour() != 17 ||
		localDue.Minute() != 30 {
		t.Fatalf(
			"stored CRUD state = %q/%q/%q/%#v/%s/%#v",
			name,
			schedule,
			timezone,
			recipients,
			durableDue,
			legacyDue,
		)
	}

	deleteRoute := chi.NewRouteContext()
	deleteRoute.URLParams.Add("id", created.ID)
	deleteContext := context.WithValue(requestContext, chi.RouteCtxKey, deleteRoute)
	deleteRequest := httptest.NewRequestWithContext(
		deleteContext,
		http.MethodDelete,
		"/api/v1/scheduled-reports/"+created.ID,
		nil,
	)
	deleteRecorder := httptest.NewRecorder()
	deps.Delete(deleteRecorder, deleteRequest)
	if deleteRecorder.Code != http.StatusOK {
		t.Fatalf(
			"delete status/body = %d %s",
			deleteRecorder.Code,
			deleteRecorder.Body.String(),
		)
	}
	deleteRecorder = httptest.NewRecorder()
	deps.Delete(deleteRecorder, deleteRequest)
	if deleteRecorder.Code != http.StatusNotFound {
		t.Fatalf(
			"second delete status/body = %d %s",
			deleteRecorder.Code,
			deleteRecorder.Body.String(),
		)
	}
}

func TestScheduledReportReplicaRaceCreatesOneOccurrenceAndOneSendDB(t *testing.T) {
	pool := scheduledReportDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := scheduledReportTenant(t, ctx, pool)
	recipients := []string{"one@example.test", "two@example.test"}
	dueAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Second)
	reportID := seedScheduledReport(
		t,
		ctx,
		pool,
		tenantID,
		dueAt,
		recipients,
	)
	mailer := &recordingReportMailer{}
	workers := []*Worker{
		{
			Pool:         pool,
			Mailer:       mailer,
			OwnerID:      uuid.NewString(),
			LeaseTTL:     time.Minute,
			SendWindow:   10 * time.Second,
			tenantFilter: tenantID,
		},
		{
			Pool:         pool,
			Mailer:       mailer,
			OwnerID:      uuid.NewString(),
			LeaseTTL:     time.Minute,
			SendWindow:   10 * time.Second,
			tenantFilter: tenantID,
		},
	}
	var wg sync.WaitGroup
	errs := make(chan error, len(workers))
	for _, worker := range workers {
		worker := worker
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- worker.tick(ctx)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}

	mailer.mu.Lock()
	for _, recipient := range recipients {
		if got := mailer.calls[recipient]; got != 1 {
			mailer.mu.Unlock()
			t.Fatalf("provider calls for %s = %d, want exactly 1",
				recipient, got)
		}
	}
	if len(mailer.calls) != len(recipients) {
		mailer.mu.Unlock()
		t.Fatalf("provider recipients = %#v", mailer.calls)
	}
	mailer.mu.Unlock()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var runs, accepted int
	var status string
	var nextDue time.Time
	if err := tx.QueryRow(ctx, `
SELECT
    COUNT(DISTINCT runs.id)::integer,
    COUNT(receipts.id) FILTER (WHERE receipts.state = 'accepted')::integer,
    MIN(runs.status),
    MIN(reports.delivery_next_due_at)
  FROM scheduled_reports AS reports
  JOIN scheduled_report_runs AS runs
    ON runs.tenant_id = reports.tenant_id
   AND runs.scheduled_report_id = reports.id
  LEFT JOIN scheduled_report_delivery_receipts AS receipts
    ON receipts.tenant_id = runs.tenant_id
   AND receipts.run_id = runs.id
 WHERE reports.tenant_id = $1::uuid
   AND reports.id = $2::uuid`,
		tenantID,
		reportID,
	).Scan(&runs, &accepted, &status, &nextDue); err != nil {
		t.Fatal(err)
	}
	if runs != 1 || accepted != len(recipients) || status != "succeeded" {
		t.Fatalf("runs/accepted/status = %d/%d/%s",
			runs, accepted, status)
	}
	wantNext, err := computeNextDue(
		"weekly:sun@09:00",
		"America/New_York",
		dueAt,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !nextDue.Equal(wantNext) {
		t.Fatalf("next_due_at = %s, want deterministic %s", nextDue, wantNext)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestManualRunConcurrentIdempotencyDoesNotMoveRecurringCursorDB(t *testing.T) {
	pool := scheduledReportDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := scheduledReportTenant(t, ctx, pool)
	nextDue := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Second)
	reportID := seedScheduledReport(
		t,
		ctx,
		pool,
		tenantID,
		nextDue,
		[]string{"idempotent@example.test"},
	)
	store := &Store{Pool: pool}

	const callers = 12
	results := make(chan SendNowResult, callers)
	errs := make(chan error, callers)
	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := store.QueueManualRun(
				ctx,
				tenantID,
				reportID,
				"same-operator-action",
			)
			results <- result
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var first SendNowResult
	for result := range results {
		if first.RunID == "" {
			first = result
			continue
		}
		if result.RunID != first.RunID ||
			!result.OccurrenceAt.Equal(first.OccurrenceAt) ||
			!result.CreatedAt.Equal(first.CreatedAt) {
			t.Fatalf("idempotent result changed: %#v vs %#v", first, result)
		}
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var runCount, receiptCount int
	var gotNextDue time.Time
	if err := tx.QueryRow(ctx, `
SELECT
    COUNT(DISTINCT runs.id)::integer,
    COUNT(receipts.id)::integer,
    MIN(reports.delivery_next_due_at)
  FROM scheduled_reports AS reports
  LEFT JOIN scheduled_report_runs AS runs
    ON runs.tenant_id = reports.tenant_id
   AND runs.scheduled_report_id = reports.id
   AND runs.run_kind = 'manual'
  LEFT JOIN scheduled_report_delivery_receipts AS receipts
    ON receipts.tenant_id = runs.tenant_id
   AND receipts.run_id = runs.id
 WHERE reports.tenant_id = $1::uuid
   AND reports.id = $2::uuid`,
		tenantID,
		reportID,
	).Scan(&runCount, &receiptCount, &gotNextDue); err != nil {
		t.Fatal(err)
	}
	if runCount != 1 || receiptCount != 1 {
		t.Fatalf("manual runs/receipts = %d/%d, want 1/1",
			runCount, receiptCount)
	}
	if !gotNextDue.Equal(nextDue) {
		t.Fatalf("manual send moved recurring cursor: got %s want %s",
			gotNextDue, nextDue)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestExpiredSendingReceiptBecomesUnknownAndCannotBeClaimedDB(t *testing.T) {
	pool := scheduledReportDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := scheduledReportTenant(t, ctx, pool)
	reportID := seedScheduledReport(
		t,
		ctx,
		pool,
		tenantID,
		time.Now().UTC().Add(24*time.Hour),
		[]string{"ambiguous@example.test"},
	)
	store := &Store{Pool: pool}
	queued, err := store.QueueManualRun(
		ctx,
		tenantID,
		reportID,
		"crash-boundary",
	)
	if err != nil {
		t.Fatal(err)
	}

	worker := &Worker{
		Pool:         pool,
		OwnerID:      uuid.NewString(),
		LeaseTTL:     time.Minute,
		SendWindow:   10 * time.Second,
		tenantFilter: tenantID,
	}
	runs, err := worker.claimRuns(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var run runSnapshot
	for _, candidate := range runs {
		if candidate.ID == queued.RunID {
			run = candidate
			break
		}
	}
	if run.ID == "" {
		t.Fatalf("manual run %s was not claimed", queued.RunID)
	}
	owned, err := worker.storeRendered(ctx, run, RenderedReport{
		PeriodStart: run.OccurrenceAt.Add(-7 * 24 * time.Hour),
		PeriodEnd:   run.OccurrenceAt,
		Metrics:     ReportMetrics{},
		Subject:     "Crash boundary",
		Body:        "Frozen body",
	})
	if err != nil || !owned {
		t.Fatalf("store rendered owned=%v err=%v", owned, err)
	}
	delivery, ok, err := worker.claimNextDelivery(ctx, run)
	if err != nil || !ok {
		t.Fatalf("claim delivery ok=%v err=%v", ok, err)
	}
	if delivery.Recipient != "ambiguous@example.test" {
		t.Fatalf("claimed recipient = %q", delivery.Recipient)
	}

	// Model a process that contacted the provider and died before receipt
	// bookkeeping: the durable state is sending, then its lease expires.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE scheduled_report_delivery_receipts
   SET lease_expires_at = now() - interval '1 second'
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID,
		delivery.ID,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE scheduled_report_runs
   SET lease_expires_at = now() - interval '1 second'
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID,
		run.ID,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	recovered, err := worker.recoverAmbiguousDeliveries(ctx)
	if err != nil || recovered != 1 {
		t.Fatalf("recover count=%d err=%v", recovered, err)
	}
	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = read.Rollback(ctx) }()
	var receiptState, runStatus, code string
	if err := read.QueryRow(ctx, `
SELECT receipts.state, runs.status, receipts.error_code
  FROM scheduled_report_delivery_receipts AS receipts
  JOIN scheduled_report_runs AS runs
    ON runs.tenant_id = receipts.tenant_id
   AND runs.id = receipts.run_id
 WHERE receipts.tenant_id = $1::uuid
   AND receipts.id = $2::uuid`,
		tenantID,
		delivery.ID,
	).Scan(&receiptState, &runStatus, &code); err != nil {
		t.Fatal(err)
	}
	if receiptState != "unknown" ||
		runStatus != "needs_review" ||
		code != "worker_crash_outcome_unknown" {
		t.Fatalf("recovered receipt/run/code = %s/%s/%s",
			receiptState, runStatus, code)
	}
	if err := read.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	claimed, err := worker.claimRuns(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range claimed {
		if candidate.ID == run.ID {
			t.Fatalf("terminal ambiguous run %s became claimable", run.ID)
		}
	}
}

func TestExpiredRunLeaseCannotCrossDeliveryOrSkipBoundaryDB(t *testing.T) {
	pool := scheduledReportDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := scheduledReportTenant(t, ctx, pool)
	reportID := seedScheduledReport(
		t,
		ctx,
		pool,
		tenantID,
		time.Now().UTC().Add(24*time.Hour),
		[]string{"first@example.test", "second@example.test"},
	)
	queued, err := (&Store{Pool: pool}).QueueManualRun(
		ctx,
		tenantID,
		reportID,
		"lease-transfer-boundary",
	)
	if err != nil {
		t.Fatal(err)
	}
	original := &Worker{
		Pool:         pool,
		OwnerID:      uuid.NewString(),
		LeaseTTL:     time.Minute,
		SendWindow:   10 * time.Second,
		tenantFilter: tenantID,
	}
	runs, err := original.claimRuns(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var staleRun runSnapshot
	for _, candidate := range runs {
		if candidate.ID == queued.RunID {
			staleRun = candidate
			break
		}
	}
	if staleRun.ID == "" {
		t.Fatal("manual run was not claimed by the original worker")
	}
	owned, err := original.storeRendered(ctx, staleRun, RenderedReport{
		PeriodStart: staleRun.OccurrenceAt.Add(-7 * 24 * time.Hour),
		PeriodEnd:   staleRun.OccurrenceAt,
		Metrics:     ReportMetrics{},
		Subject:     "Lease transfer",
		Body:        "Frozen",
	})
	if err != nil || !owned {
		t.Fatalf("store rendered owned=%v err=%v", owned, err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE scheduled_report_runs
   SET lease_expires_at = now() - interval '1 second'
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID,
		staleRun.ID,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	replacement := &Worker{
		Pool:         pool,
		OwnerID:      uuid.NewString(),
		LeaseTTL:     time.Minute,
		SendWindow:   10 * time.Second,
		tenantFilter: tenantID,
	}
	runs, err = replacement.claimRuns(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var currentRun runSnapshot
	for _, candidate := range runs {
		if candidate.ID == staleRun.ID {
			currentRun = candidate
			break
		}
	}
	if currentRun.ID == "" {
		t.Fatal("expired run was not acquired by the replacement worker")
	}

	if delivery, ok, err := original.claimNextDelivery(ctx, staleRun); err != nil ||
		ok {
		t.Fatalf(
			"stale delivery claim = %#v, ok=%v, err=%v; want no claim",
			delivery,
			ok,
			err,
		)
	}
	if err := original.failRun(
		ctx,
		staleRun,
		"stale_worker",
		"A stale worker must not mutate delivery evidence.",
	); err == nil {
		t.Fatal("stale worker unexpectedly failed the replacement worker's run")
	}

	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var pending, attempted int
	var leaseOwner, status string
	if err := read.QueryRow(ctx, `
SELECT
    COUNT(*) FILTER (WHERE receipts.state = 'pending')::integer,
    COUNT(*) FILTER (WHERE receipts.attempt_count <> 0)::integer,
    runs.lease_owner,
    runs.status
  FROM scheduled_report_runs AS runs
  JOIN scheduled_report_delivery_receipts AS receipts
    ON receipts.tenant_id = runs.tenant_id
   AND receipts.run_id = runs.id
 WHERE runs.tenant_id = $1::uuid
   AND runs.id = $2::uuid
 GROUP BY runs.lease_owner, runs.status`,
		tenantID,
		staleRun.ID,
	).Scan(&pending, &attempted, &leaseOwner, &status); err != nil {
		_ = read.Rollback(ctx)
		t.Fatal(err)
	}
	if err := read.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if pending != 2 || attempted != 0 ||
		leaseOwner != replacement.OwnerID || status != "delivering" {
		t.Fatalf(
			"pending/attempted/owner/status = %d/%d/%s/%s",
			pending,
			attempted,
			leaseOwner,
			status,
		)
	}

	delivery, ok, err := replacement.claimNextDelivery(ctx, currentRun)
	if err != nil || !ok || delivery.ID == "" {
		t.Fatalf(
			"replacement delivery claim = %#v, ok=%v, err=%v",
			delivery,
			ok,
			err,
		)
	}
}

func TestScheduledReportRunAndReceiptRLSDB(t *testing.T) {
	pool := scheduledReportDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tenantA := scheduledReportTenant(t, ctx, pool)
	tenantB := scheduledReportTenant(t, ctx, pool)
	reportB := seedScheduledReport(
		t,
		ctx,
		pool,
		tenantB,
		time.Now().UTC().Add(24*time.Hour),
		[]string{"private@example.test"},
	)
	result, err := (&Store{Pool: pool}).QueueManualRun(
		ctx,
		tenantB,
		reportB,
		"tenant-boundary",
	)
	if err != nil {
		t.Fatal(err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var runs, receipts int
	if err := tx.QueryRow(ctx, `
SELECT
    (SELECT COUNT(*) FROM scheduled_report_runs WHERE id = $1::uuid),
    (SELECT COUNT(*) FROM scheduled_report_delivery_receipts WHERE run_id = $1::uuid)`,
		result.RunID,
	).Scan(&runs, &receipts); err != nil {
		t.Fatal(err)
	}
	if runs != 0 || receipts != 0 {
		t.Fatalf("tenant A saw tenant B run/receipts = %d/%d", runs, receipts)
	}
	if _, err := tx.Exec(ctx, "SAVEPOINT cross_tenant_report"); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO scheduled_report_runs (
    tenant_id,
    scheduled_report_id,
    scheduled_report_id_snapshot,
    run_kind,
    occurrence_at,
    report_name_snapshot,
    template_snapshot,
    schedule_snapshot,
    timezone_snapshot
)
VALUES (
    $1::uuid,
    $2::uuid,
    $2::uuid,
    'recurring',
    now(),
    'Cross-tenant probe',
    'engagement_summary',
    'weekly:mon@09:00',
    'UTC'
)`,
		tenantA,
		reportB,
	); err == nil {
		t.Fatal("cross-tenant scheduled_report_id unexpectedly satisfied the run FK")
	}
	if _, err := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT cross_tenant_report"); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "SAVEPOINT orphan_report_snapshot"); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO scheduled_report_runs (
    tenant_id,
    scheduled_report_id,
    scheduled_report_id_snapshot,
    run_kind,
    occurrence_at,
    report_name_snapshot,
    template_snapshot,
    schedule_snapshot,
    timezone_snapshot
)
VALUES (
    $1::uuid,
    NULL,
    $2::uuid,
    'recurring',
    now(),
    'Orphan probe',
    'engagement_summary',
    'weekly:mon@09:00',
    'UTC'
)`,
		tenantA,
		reportB,
	); err == nil {
		t.Fatal("orphan report snapshot unexpectedly bypassed the insert guard")
	}
	if _, err := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT orphan_report_snapshot"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestListIsNoStoreAndLatestRunFieldsAreCoherentDB(t *testing.T) {
	pool := scheduledReportDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tenantID := scheduledReportTenant(t, ctx, pool)
	reportID := seedScheduledReport(
		t,
		ctx,
		pool,
		tenantID,
		time.Now().UTC().Add(24*time.Hour),
		[]string{"private@example.test"},
	)
	if _, err := (&Store{Pool: pool}).QueueManualRun(
		ctx,
		tenantID,
		reportID,
		"list-coherence",
	); err != nil {
		t.Fatal(err)
	}
	requestCtx := middleware.WithTenant(
		ctx,
		&middleware.Tenant{ID: tenantID},
	)
	request := httptest.NewRequestWithContext(
		requestCtx,
		"GET",
		"/api/v1/scheduled-reports",
		nil,
	)
	recorder := httptest.NewRecorder()
	(&Deps{Pool: pool}).List(recorder, request)
	if recorder.Code != 200 {
		t.Fatalf("list status/body = %d %s",
			recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	body := recorder.Body.String()
	for _, fragment := range []string{
		`"timezone":"America/New_York"`,
		`"latest_run_status":"queued"`,
		`"latest_run_created_at":`,
		`"latest_run_recipient_count":1`,
	} {
		if !strings.Contains(body, fragment) {
			t.Errorf("list body missing %s: %s", fragment, body)
		}
	}
	// A newest queued run has no completion timestamp; do not combine its
	// queued status with an older last_run_at.
	if strings.Contains(body, `"last_run_at"`) {
		t.Fatalf("queued latest run exposed a mixed completion timestamp: %s", body)
	}
}

func TestMailerUnavailableAfterPartialAcceptanceStaysPartialDB(t *testing.T) {
	pool := scheduledReportDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tenantID := scheduledReportTenant(t, ctx, pool)
	reportID := seedScheduledReport(
		t,
		ctx,
		pool,
		tenantID,
		time.Now().UTC().Add(24*time.Hour),
		[]string{"accepted@example.test", "pending@example.test"},
	)
	queued, err := (&Store{Pool: pool}).QueueManualRun(
		ctx,
		tenantID,
		reportID,
		"partial-then-config-failure",
	)
	if err != nil {
		t.Fatal(err)
	}
	worker := &Worker{
		Pool:         pool,
		OwnerID:      uuid.NewString(),
		LeaseTTL:     time.Minute,
		SendWindow:   10 * time.Second,
		tenantFilter: tenantID,
	}
	runs, err := worker.claimRuns(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var run runSnapshot
	for _, candidate := range runs {
		if candidate.ID == queued.RunID {
			run = candidate
		}
	}
	if run.ID == "" {
		t.Fatal("manual run was not claimed")
	}
	owned, err := worker.storeRendered(ctx, run, RenderedReport{
		PeriodStart: run.OccurrenceAt.Add(-7 * 24 * time.Hour),
		PeriodEnd:   run.OccurrenceAt,
		Metrics:     ReportMetrics{},
		Subject:     "Partial",
		Body:        "Frozen",
	})
	if err != nil || !owned {
		t.Fatalf("store rendered owned=%v err=%v", owned, err)
	}
	delivery, ok, err := worker.claimNextDelivery(ctx, run)
	if err != nil || !ok {
		t.Fatalf("claim first delivery ok=%v err=%v", ok, err)
	}
	if err := worker.completeDelivery(
		ctx,
		run,
		delivery.ID,
		"accepted",
		"",
		"",
	); err != nil {
		t.Fatal(err)
	}
	if err := worker.failRun(
		ctx,
		run,
		"mailer_unavailable",
		"Scheduled report delivery is not configured. No further recipient was contacted.",
	); err != nil {
		t.Fatal(err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status string
	var accepted, skipped int
	if err := tx.QueryRow(ctx, `
SELECT
    runs.status,
    COUNT(receipts.id) FILTER (WHERE receipts.state = 'accepted')::integer,
    COUNT(receipts.id) FILTER (WHERE receipts.state = 'skipped')::integer
  FROM scheduled_report_runs AS runs
  JOIN scheduled_report_delivery_receipts AS receipts
    ON receipts.tenant_id = runs.tenant_id
   AND receipts.run_id = runs.id
 WHERE runs.tenant_id = $1::uuid
   AND runs.id = $2::uuid
 GROUP BY runs.status`,
		tenantID,
		run.ID,
	).Scan(&status, &accepted, &skipped); err != nil {
		t.Fatal(err)
	}
	if status != "partial" || accepted != 1 || skipped != 1 {
		t.Fatalf("status/accepted/skipped = %s/%d/%d, want partial/1/1",
			status, accepted, skipped)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestDeletingDefinitionPreservesRunAndReceiptsDB(t *testing.T) {
	pool := scheduledReportDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tenantID := scheduledReportTenant(t, ctx, pool)
	reportID := seedScheduledReport(
		t,
		ctx,
		pool,
		tenantID,
		time.Now().UTC().Add(24*time.Hour),
		[]string{"history@example.test"},
	)
	queued, err := (&Store{Pool: pool}).QueueManualRun(
		ctx,
		tenantID,
		reportID,
		"preserve-history",
	)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
DELETE FROM scheduled_reports
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID,
		reportID,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	replayed, err := (&Store{Pool: pool}).QueueManualRun(
		ctx,
		tenantID,
		reportID,
		"preserve-history",
	)
	if err != nil {
		t.Fatalf("idempotent replay after definition deletion: %v", err)
	}
	if replayed.RunID != queued.RunID ||
		replayed.ScheduledReportID != reportID ||
		!replayed.OccurrenceAt.Equal(queued.OccurrenceAt) ||
		!replayed.CreatedAt.Equal(queued.CreatedAt) {
		t.Fatalf("deleted-definition replay changed: %#v vs %#v", queued, replayed)
	}

	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = read.Rollback(ctx) }()
	var reportRef *string
	var reportSnapshot string
	var receipts int
	if err := read.QueryRow(ctx, `
SELECT
    runs.scheduled_report_id::text,
    runs.scheduled_report_id_snapshot::text,
    COUNT(receipts.id)::integer
  FROM scheduled_report_runs AS runs
  LEFT JOIN scheduled_report_delivery_receipts AS receipts
    ON receipts.tenant_id = runs.tenant_id
   AND receipts.run_id = runs.id
 WHERE runs.tenant_id = $1::uuid
   AND runs.id = $2::uuid
 GROUP BY runs.scheduled_report_id, runs.scheduled_report_id_snapshot`,
		tenantID,
		queued.RunID,
	).Scan(&reportRef, &reportSnapshot, &receipts); err != nil {
		t.Fatal(err)
	}
	if reportRef != nil || reportSnapshot != reportID || receipts != 1 {
		t.Fatalf("deleted definition history ref/snapshot/receipts = %#v/%s/%d",
			reportRef, reportSnapshot, receipts)
	}
	if err := read.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestRunRetentionPurgesRecipientAndSnapshotTogetherDB(t *testing.T) {
	pool := scheduledReportDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tenantID := scheduledReportTenant(t, ctx, pool)
	reportID := seedScheduledReport(
		t,
		ctx,
		pool,
		tenantID,
		time.Now().UTC().Add(24*time.Hour),
		[]string{"retained@example.test"},
	)
	runID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO scheduled_report_runs (
    id,
    tenant_id,
    scheduled_report_id,
    scheduled_report_id_snapshot,
    run_kind,
    occurrence_at,
    report_name_snapshot,
    template_snapshot,
    schedule_snapshot,
    timezone_snapshot,
    status,
    last_error_code,
    last_error_summary,
    created_at,
    retention_until,
    completed_at
)
VALUES (
    $1::uuid,
    $2::uuid,
    $3::uuid,
    $3::uuid,
    'recurring',
    now() - interval '100 days',
    'Retention evidence',
    'engagement_summary',
    'weekly:sun@09:00',
    'UTC',
    'failed',
    'delivery_failed',
    'No recipient delivery was confirmed.',
    now() - interval '100 days',
    now() - interval '10 days',
    now() - interval '99 days'
)`,
		runID,
		tenantID,
		reportID,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO scheduled_report_delivery_receipts (
    tenant_id,
    run_id,
    recipient,
    recipient_hash,
    recipient_ordinal,
    state,
    error_code,
    error_summary,
    completed_at
)
VALUES (
    $1::uuid,
    $2::uuid,
    'retained@example.test',
    $3,
    0,
    'skipped',
    'run_failed_before_delivery',
    'The run failed before this recipient was contacted.',
    now() - interval '99 days'
)`,
		tenantID,
		runID,
		recipientHash(tenantID, "retained@example.test"),
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	worker := &Worker{
		Pool:         pool,
		OwnerID:      uuid.NewString(),
		BatchSize:    10,
		tenantFilter: tenantID,
	}
	purged, err := worker.purgeExpiredRuns(ctx)
	if err != nil || purged != 1 {
		t.Fatalf("purged=%d err=%v", purged, err)
	}
	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = read.Rollback(ctx) }()
	var runs, receipts int
	if err := read.QueryRow(ctx, `
SELECT
    (SELECT COUNT(*) FROM scheduled_report_runs WHERE id = $1::uuid),
    (SELECT COUNT(*) FROM scheduled_report_delivery_receipts WHERE run_id = $1::uuid)`,
		runID,
	).Scan(&runs, &receipts); err != nil {
		t.Fatal(err)
	}
	if runs != 0 || receipts != 0 {
		t.Fatalf("expired run/receipts remain = %d/%d", runs, receipts)
	}
	if err := read.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestManualStoreRejectsUnsafeKeyBeforeDatabase(t *testing.T) {
	t.Parallel()

	store := &Store{}
	_, err := store.QueueManualRun(
		context.Background(),
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
		"bad\nkey",
	)
	if !errors.Is(err, ErrIdempotencyKeyInvalid) {
		t.Fatalf("unsafe key reached store dependencies: %v", err)
	}
	if _, err := normalizeIdempotencyKey("bad\nkey"); !errors.Is(
		err,
		ErrIdempotencyKeyInvalid,
	) {
		t.Fatalf("unsafe key error = %v", err)
	}
}
