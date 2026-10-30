// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type classifierDBFixture struct {
	TenantID        string
	ForeignTenantID string
	CampaignID      string
	Events          []EventRef
	At              time.Time
}

func classifierDBPools(t *testing.T, ctx context.Context) (*pgxpool.Pool, *pgxpool.Pool) {
	t.Helper()
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_ENGAGEMENT_CLASSIFIER_TEST_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("POSTWAVE_ENGAGEMENT_CLASSIFIER_APP_TEST_DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_ENGAGEMENT_CLASSIFIER_TEST_DATABASE_URL and POSTWAVE_ENGAGEMENT_CLASSIFIER_APP_TEST_DATABASE_URL are required for F01 PostgreSQL proof")
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect classifier admin database: %v", err)
	}
	t.Cleanup(admin.Close)
	app, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect classifier app database: %v", err)
	}
	t.Cleanup(app.Close)
	var schemaReady bool
	if err := admin.QueryRow(ctx, `
SELECT to_regclass('public.subscriber_event_observations') IS NOT NULL
   AND to_regclass('public.event_classifications') IS NOT NULL
   AND to_regclass('public.engagement_machine_registry_versions') IS NOT NULL
   AND to_regclass('public.subscriber_event_classification_shadow_v1') IS NOT NULL
   AND to_regclass('public.engagement_classifier_reach_cutover_approvals') IS NOT NULL
   AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'engagement_classifier_calibration_reports'
          AND column_name = 'report_payload'
   )`).Scan(&schemaReady); err != nil {
		t.Fatalf("inspect F01 schema: %v", err)
	}
	if !schemaReady {
		t.Fatal("configured database does not have the sealed F01/F12 release schema through migration 2035")
	}
	var unsafeRLS int
	if err := admin.QueryRow(ctx, `
SELECT count(*)
  FROM pg_class
 WHERE relname = ANY($1::text[])
   AND (NOT relrowsecurity OR NOT relforcerowsecurity)`, []string{
		"subscriber_event_engagement_identities",
		"subscriber_event_observations", "event_classifications",
		"event_reclassification_runs", "engagement_machine_registry_entries",
		"engagement_machine_registry_versions",
		"engagement_classifier_methodology_versions",
		"engagement_classifier_calibration_reports",
		"engagement_classifier_reach_cutover_approvals",
		"subscriber_event_observation_deletions",
	}).Scan(&unsafeRLS); err != nil {
		t.Fatalf("inspect F01 forced RLS: %v", err)
	}
	if unsafeRLS != 0 {
		t.Fatalf("F01 schema has %d tables without enabled+forced RLS", unsafeRLS)
	}
	var compositeEdges int
	if err := admin.QueryRow(ctx, `
SELECT count(*)
  FROM pg_constraint
 WHERE contype = 'f'
   AND conname IN (
       'subscriber_event_observations_event_fk',
       'event_classifications_event_fk'
   )
   AND cardinality(conkey) = 3`).Scan(&compositeEdges); err != nil {
		t.Fatalf("inspect F01 composite tenant FKs: %v", err)
	}
	if compositeEdges != 2 {
		t.Fatalf("F01 composite event ownership edges=%d, want 2", compositeEdges)
	}
	var appUser string
	var bypassRLS bool
	if err := app.QueryRow(ctx, `
SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user`).Scan(&appUser, &bypassRLS); err != nil {
		t.Fatalf("inspect F01 application role: %v", err)
	}
	if appUser != "postwave_app" || bypassRLS {
		t.Skipf("application URL must use non-bypass postwave_app; got user=%q bypassrls=%v", appUser, bypassRLS)
	}
	return admin, app
}

func seedClassifierDBFixture(t *testing.T, ctx context.Context, admin *pgxpool.Pool) classifierDBFixture {
	t.Helper()
	fixture := classifierDBFixture{
		TenantID: uuid.NewString(), ForeignTenantID: uuid.NewString(),
		CampaignID: uuid.NewString(), At: time.Now().UTC().Truncate(time.Microsecond),
	}
	suffix := strings.ReplaceAll(fixture.TenantID, "-", "")[:12]
	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES
    ($1::uuid, $2, 'F01 DB tenant', 'studio'),
    ($3::uuid, $4, 'F01 foreign tenant', 'studio')`, fixture.TenantID,
		"f01-db-"+suffix, fixture.ForeignTenantID, "f01-foreign-"+suffix); err != nil {
		t.Fatalf("seed F01 tenants: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html)
VALUES ($1::uuid, $2::uuid, 'F01 campaign', 'F01', '<p>F01</p>')`,
		fixture.CampaignID, fixture.TenantID); err != nil {
		t.Fatalf("seed F01 campaign: %v", err)
	}
	for index := 0; index < 2; index++ {
		at := fixture.At.Add(time.Duration(index) * time.Second)
		var event EventRef
		if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, campaign_id, source,
    provider_event_id, source_event_id, message_id, metadata, at
) VALUES (
    $1::uuid, $2, 'opened', $3::uuid, 'f01-fixture', $4, $4, $5, '{}'::jsonb, $6
)
RETURNING id, at`, fixture.TenantID, fmt.Sprintf("f01-%d-%s@example.test", index, suffix),
			fixture.CampaignID, fmt.Sprintf("provider-%s-%d", suffix, index),
			fmt.Sprintf("<message-%s@example.test>", suffix), at).Scan(&event.ID, &event.At); err != nil {
			t.Fatalf("seed canonical subscriber event %d: %v", index, err)
		}
		fixture.Events = append(fixture.Events, event)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit F01 fixture: %v", err)
	}
	return fixture
}

func classifierDBObservation(fixture classifierDBFixture, index int) ObservationInput {
	ingested := fixture.At.Add(-2 * time.Hour)
	expires := fixture.At.Add(-time.Hour)
	return ObservationInput{
		EventRef: fixture.Events[index], Source: "f01-fixture",
		SourceEventID:      fmt.Sprintf("source-%d", index),
		IdempotencyKey:     fmt.Sprintf("f01-observation-%s-%d", fixture.TenantID, index),
		EventSchemaVersion: ObservationSchemaV1,
		// Deliberately spoofed: the composition hook and database trigger must
		// replace this with canonical subscriber_events.event_type='opened'.
		EventType: "clicked", OccurredAt: fixture.Events[index].At,
		IngestedAt: ingested, CampaignID: fixture.ForeignTenantID,
		MessageIdentityHash: repeat("a", 64),
		OrderedHeaders:      []Header{{Name: "Accept-Language", Value: "en-US"}},
		ProviderSignals:     map[string]any{}, PrivacyExpiryAt: expires,
	}
}

func classifierSQLState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}

func TestF01ObservationClassificationReclassificationAndRLS_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx, `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, fixture.TenantID, fixture.ForeignTenantID)
	})
	repo := &Repo{Pool: (*db.Pool)(app), Now: func() time.Time { return fixture.At }}
	registry, err := repo.LoadRegistry(ctx, CurrentRegistryV2)
	// Pinned deliberately: the registry is the classifier's entire knowledge of
	// what a machine looks like, so growth must be a conscious edit rather than
	// a migration nobody noticed. V2 preserves the 18-row shape while replacing
	// the over-labelled historical assistant rule.
	if err != nil || len(registry) != 18 {
		t.Fatalf("load bootstrap machine registry count=%d err=%v", len(registry), err)
	}
	classifierV2, err := NewClassifier(DefaultConfig(), registry)
	if err != nil {
		t.Fatalf("bootstrap registry fingerprint or matcher is invalid: %v", err)
	}
	if err := repo.PublishRegistryEntries(ctx, registry); err != nil {
		t.Fatalf("exact bootstrap registry replay is not idempotent: %v", err)
	}
	machineObservation := validObservation()
	machineObservation.UserAgent = "Mozilla/5.0 via GoogleImageProxy"
	humanObservation := validObservation()
	dwell := int64(30_000)
	humanObservation.DwellMilliseconds = &dwell
	policy := calibrationTestPolicy()
	policy.MinimumMachineSamples = 1
	policy.MinimumHumanSamples = 1
	report, err := EvaluateCalibration(ctx, classifierV2, policy,
		calibrationCorpus(ControlledMachineCorpus, "5", LabeledExample{
			ID: "db-machine", GroundTruth: Machine, Observation: machineObservation,
		}),
		calibrationCorpus(LabeledHumanCorpus, "6", LabeledExample{
			ID: "db-human", GroundTruth: Human, Observation: humanObservation,
		}),
	)
	if err != nil {
		t.Fatalf("evaluate DB calibration receipt: %v", err)
	}
	persistedReport, err := repo.RecordCalibrationReport(ctx, classifierV2, report)
	if err != nil {
		t.Fatalf("persist calibration receipt: %v", err)
	}
	replayedReport, err := repo.RecordCalibrationReport(ctx, classifierV2, report)
	if err != nil || replayedReport.ID != persistedReport.ID {
		t.Fatalf("calibration replay id=%q want=%q err=%v", replayedReport.ID, persistedReport.ID, err)
	}

	first, err := repo.Record(ctx, fixture.TenantID, classifierDBObservation(fixture, 0), MessageAggregate{}, classifierV2)
	if err != nil {
		t.Fatalf("record first observation: %v", err)
	}
	if !first.ObservationInserted || !first.ClassificationAdded || first.Result.Classification != Unknown {
		t.Fatalf("first record receipt = %+v", first)
	}
	replay, err := repo.Record(ctx, fixture.TenantID, classifierDBObservation(fixture, 0), MessageAggregate{}, classifierV2)
	if err != nil || replay.ObservationInserted || replay.ClassificationAdded || replay.ObservationID != first.ObservationID {
		t.Fatalf("exact replay = %+v err=%v", replay, err)
	}
	conflict := classifierDBObservation(fixture, 0)
	conflict.UserAgent = "changed evidence"
	if _, err := repo.Record(ctx, fixture.TenantID, conflict, MessageAggregate{}, classifierV2); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("conflicting replay error = %v, want ErrIdempotencyConflict", err)
	}

	// A concurrent provider retry creates exactly one second observation and
	// one exact-version classification.
	start := make(chan struct{})
	errorsSeen := make(chan error, 8)
	var wait sync.WaitGroup
	for index := 0; index < 8; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, err := repo.Record(ctx, fixture.TenantID, classifierDBObservation(fixture, 1), MessageAggregate{}, classifierV2)
			errorsSeen <- err
		}()
	}
	close(start)
	wait.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		if err != nil {
			t.Fatalf("concurrent exact replay: %v", err)
		}
	}
	var observations, classifications int
	if err := admin.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_event_observations WHERE tenant_id = $1::uuid),
  (SELECT count(*) FROM event_classifications WHERE tenant_id = $1::uuid)`,
		fixture.TenantID).Scan(&observations, &classifications); err != nil {
		t.Fatal(err)
	}
	if observations != 2 || classifications != 2 {
		t.Fatalf("concurrent ledger counts observations=%d classifications=%d, want 2/2", observations, classifications)
	}

	// The public shadow projection fails closed for both explicit unknown and
	// missing evidence. Plain tenant scope cannot read raw envelopes.
	tenantTx, err := db.WithTenant(ctx, (*db.Pool)(app), fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	var projected string
	var humanSignal, machineSignal, unknownSignal bool
	if err := tenantTx.QueryRow(ctx, `
SELECT classification, human_signal, machine_signal, unknown_signal
  FROM subscriber_event_classification_shadow_v1
 WHERE subscriber_event_id = $1 AND subscriber_event_at = $2`,
		fixture.Events[0].ID, fixture.Events[0].At).Scan(
		&projected, &humanSignal, &machineSignal, &unknownSignal,
	); err != nil {
		t.Fatalf("read shadow projection: %v", err)
	}
	if projected != "unknown" || humanSignal || machineSignal || !unknownSignal {
		t.Fatalf("unsafe unknown projection class=%q human=%v machine=%v unknown=%v", projected, humanSignal, machineSignal, unknownSignal)
	}
	var rawVisible int
	if err := tenantTx.QueryRow(ctx, `SELECT count(*) FROM subscriber_event_observations`).Scan(&rawVisible); err != nil {
		t.Fatal(err)
	}
	if rawVisible != 0 {
		t.Fatalf("plain tenant scope can read %d raw observations", rawVisible)
	}
	_, err = tenantTx.Exec(ctx, `
INSERT INTO subscriber_event_observations (
    tenant_id, subscriber_event_id, subscriber_event_at,
    source, idempotency_key, event_schema_version, event_type,
    occurred_at, privacy_expiry_at, observation_fingerprint
) VALUES (
    $1::uuid, $2, $3::timestamptz, 'unauthorized', 'unauthorized',
    $4, 'opened', $3::timestamptz,
    $3::timestamptz + interval '1 day', repeat('f', 64)
)`, fixture.TenantID, fixture.Events[0].ID, fixture.Events[0].At, ObservationSchemaV1)
	if classifierSQLState(err) != "42501" {
		t.Fatalf("plain tenant raw insert error=%v state=%q, want 42501", err, classifierSQLState(err))
	}
	_ = tenantTx.Rollback(ctx)

	foreignTx, err := db.WithTenant(ctx, (*db.Pool)(app), fixture.ForeignTenantID)
	if err != nil {
		t.Fatal(err)
	}
	var foreignVisible int
	if err := foreignTx.QueryRow(ctx, `SELECT count(*) FROM event_classifications`).Scan(&foreignVisible); err != nil {
		t.Fatal(err)
	}
	if foreignVisible != 0 {
		t.Fatalf("foreign tenant can read %d classifications", foreignVisible)
	}
	_ = foreignTx.Rollback(ctx)

	var storedEventType, storedCampaign string
	var storedSeed bool
	if err := admin.QueryRow(ctx, `
SELECT event_type, COALESCE(campaign_id::text, ''), is_seed
  FROM subscriber_event_observations WHERE id = $1::uuid`, first.ObservationID).Scan(
		&storedEventType, &storedCampaign, &storedSeed,
	); err != nil {
		t.Fatal(err)
	}
	if storedEventType != "opened" || storedCampaign != fixture.CampaignID || storedSeed {
		t.Fatalf("observation trusted adapter dimensions type=%q campaign=%q seed=%v", storedEventType, storedCampaign, storedSeed)
	}

	if _, err := admin.Exec(ctx, `UPDATE subscriber_event_observations SET user_agent='mutated' WHERE id=$1::uuid`, first.ObservationID); classifierSQLState(err) != "55000" {
		t.Fatalf("raw observation update error=%v state=%q, want 55000", err, classifierSQLState(err))
	}
	if _, err := admin.Exec(ctx, `UPDATE event_classifications SET classification='human' WHERE id=$1::uuid`, first.ClassificationID); classifierSQLState(err) != "55000" {
		t.Fatalf("classification update error=%v state=%q, want 55000", err, classifierSQLState(err))
	}
	if _, err := admin.Exec(ctx, `UPDATE engagement_classifier_calibration_reports SET result='fail' WHERE id=$1::uuid`, persistedReport.ID); classifierSQLState(err) != "55000" {
		t.Fatalf("calibration update error=%v state=%q, want 55000", err, classifierSQLState(err))
	}

	configV3 := DefaultConfig()
	configV3.MethodologyVersion = "postwave.engagement-methodology.v3"
	configV3.HumanLatencyWeight = 0.14
	classifierV3 := mustClassifier(t, configV3)
	reclassified, err := repo.ReclassifyEvent(ctx, fixture.TenantID, fixture.Events[0], classifierV3, "")
	if err != nil || !reclassified.ClassificationAdded {
		t.Fatalf("append reclassification = %+v err=%v", reclassified, err)
	}
	var rawCount, historyCount, lineageCount int
	if err := admin.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_event_observations
    WHERE tenant_id=$1::uuid AND subscriber_event_id=$2 AND subscriber_event_at=$3),
  (SELECT count(*) FROM event_classifications
    WHERE tenant_id=$1::uuid AND subscriber_event_id=$2 AND subscriber_event_at=$3),
  (SELECT count(*) FROM event_classifications
    WHERE tenant_id=$1::uuid AND subscriber_event_id=$2 AND subscriber_event_at=$3
      AND supersedes_id IS NOT NULL)`, fixture.TenantID, fixture.Events[0].ID,
		fixture.Events[0].At).Scan(&rawCount, &historyCount, &lineageCount); err != nil {
		t.Fatal(err)
	}
	if rawCount != 1 || historyCount != 2 || lineageCount != 1 {
		t.Fatalf("reclassification rewrote evidence raw=%d history=%d lineage=%d", rawCount, historyCount, lineageCount)
	}

	run, err := repo.ReclassifyWindow(ctx, fixture.TenantID, ReclassificationWindow{
		RequestID: uuid.NewString(), Start: fixture.At.Add(-time.Minute),
		End: fixture.At.Add(time.Minute), BatchSize: 1,
	}, classifierV3)
	if err != nil {
		t.Fatalf("reclassify bounded window: %v", err)
	}
	if run.State != "completed" || run.CandidateCount != 2 ||
		run.ClassifiedCount != 1 || run.UnchangedCount != 1 {
		t.Fatalf("reclassification run = %+v", run)
	}

	deleted, err := repo.PurgeExpiredObservation(ctx, fixture.TenantID, first.ObservationID, "privacy_expired")
	if err != nil || !deleted {
		t.Fatalf("governed raw purge deleted=%v err=%v", deleted, err)
	}
	var remainingRaw, durableHistory, deletionReceipts int
	if err := admin.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_event_observations WHERE id=$1::uuid),
  (SELECT count(*) FROM event_classifications
    WHERE tenant_id=$2::uuid AND subscriber_event_id=$3 AND subscriber_event_at=$4),
  (SELECT count(*) FROM subscriber_event_observation_deletions
    WHERE tenant_id=$2::uuid AND observation_id=$1::uuid)`, first.ObservationID,
		fixture.TenantID, fixture.Events[0].ID, fixture.Events[0].At).Scan(
		&remainingRaw, &durableHistory, &deletionReceipts,
	); err != nil {
		t.Fatal(err)
	}
	if remainingRaw != 0 || durableHistory != 2 || deletionReceipts != 1 {
		t.Fatalf("retention boundary raw=%d history=%d receipts=%d", remainingRaw, durableHistory, deletionReceipts)
	}
}

func TestF01ReclassificationCrashRecoveryAndLeaseFencing_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx, `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, fixture.TenantID, fixture.ForeignTenantID)
	})

	baseRepo := &Repo{Pool: (*db.Pool)(app), Now: func() time.Time { return fixture.At }}
	baseClassifier := mustClassifier(t, DefaultConfig())
	for index := range fixture.Events {
		if _, err := baseRepo.Record(
			ctx, fixture.TenantID, classifierDBObservation(fixture, index),
			MessageAggregate{}, baseClassifier,
		); err != nil {
			t.Fatalf("seed event %d observation: %v", index, err)
		}
	}

	reclassificationConfig := DefaultConfig()
	reclassificationConfig.MethodologyVersion = "postwave.engagement-methodology.lease-recovery-v1"
	reclassificationConfig.HumanLatencyWeight = 0.19
	classifier := mustClassifier(t, reclassificationConfig)
	window := ReclassificationWindow{
		RequestID: uuid.NewString(), Start: fixture.At.Add(-time.Minute).UTC(),
		End: fixture.At.Add(time.Minute).UTC(), BatchSize: 1,
	}
	requestHash, err := reclassificationRequestHash(window, classifier)
	if err != nil {
		t.Fatal(err)
	}
	crashedRepo := &Repo{
		Pool: (*db.Pool)(app), ReclassificationWorkerID: "f01-crashed-worker",
		ReclassificationLeaseTTL: 100 * time.Millisecond,
	}
	crashedRun, err := crashedRepo.createAndClaimRun(
		ctx, fixture.TenantID, window, classifier, requestHash,
	)
	if err != nil || crashedRun.AttemptCount != 1 || crashedRun.LeaseToken == "" {
		t.Fatalf("initial crash lease=%+v err=%v", crashedRun, err)
	}
	crashedLease := leaseFromRun(crashedRun, crashedRepo.reclassificationLeaseTTL())
	firstReceipt, err := crashedRepo.reclassifyEvent(
		ctx, fixture.TenantID, fixture.Events[0], classifier, crashedLease,
	)
	if err != nil || firstReceipt.ReclassificationRunID != crashedRun.ID {
		t.Fatalf("pre-crash classification=%+v err=%v", firstReceipt, err)
	}

	contender := &Repo{
		Pool: (*db.Pool)(app), ReclassificationWorkerID: "f01-live-contender",
		ReclassificationLeaseTTL: 2 * time.Second,
	}
	if _, err := contender.createAndClaimRun(
		ctx, fixture.TenantID, window, classifier, requestHash,
	); !errors.Is(err, ErrRunInProgress) {
		t.Fatalf("live lease contender error=%v, want ErrRunInProgress", err)
	}

	// Simulate process death after the append and before page progress. No
	// heartbeat follows, so another worker must reclaim the exact request.
	time.Sleep(180 * time.Millisecond)
	recoveredRun, err := contender.ReclassifyWindow(
		ctx, fixture.TenantID, window, classifier,
	)
	if err != nil {
		t.Fatalf("recover stale reclassification run: %v", err)
	}
	if recoveredRun.State != "completed" || recoveredRun.AttemptCount != 2 ||
		recoveredRun.LeaseToken == crashedRun.LeaseToken ||
		recoveredRun.CandidateCount != 2 || recoveredRun.ClassifiedCount != 2 ||
		recoveredRun.UnchangedCount != 0 {
		t.Fatalf("recovered run=%+v", recoveredRun)
	}

	staleProgress := crashedRun
	staleProgress.Cursor = &fixture.Events[0]
	staleProgress.CandidateCount = 1
	staleProgress.ClassifiedCount = 1
	if err := crashedRepo.persistRunProgress(
		ctx, fixture.TenantID, staleProgress, crashedLease,
	); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale progress error=%v, want ErrLeaseLost", err)
	}
	if _, err := crashedRepo.completeReclassificationRun(
		ctx, fixture.TenantID, staleProgress, crashedLease,
	); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale completion error=%v, want ErrLeaseLost", err)
	}

	var state, workerID, token string
	var attempts int
	var candidateCount, classifiedCount, unchangedCount int64
	if err := admin.QueryRow(ctx, `
SELECT state, worker_id, lease_token::text, attempt_count,
       candidate_count, classified_count, unchanged_count
  FROM event_reclassification_runs
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, fixture.TenantID, crashedRun.ID).Scan(
		&state, &workerID, &token, &attempts, &candidateCount,
		&classifiedCount, &unchangedCount,
	); err != nil {
		t.Fatal(err)
	}
	if state != "completed" || workerID != "f01-live-contender" ||
		token != recoveredRun.LeaseToken || attempts != 2 || candidateCount != 2 ||
		classifiedCount != 2 || unchangedCount != 0 {
		t.Fatalf("durable recovered run state=%q worker=%q token=%q attempts=%d counts=%d/%d/%d",
			state, workerID, token, attempts, candidateCount, classifiedCount, unchangedCount)
	}
}

func TestF01RetentionBatchPurgesInlineAndBlocksObjectBackedEvidence_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx, `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, fixture.TenantID, fixture.ForeignTenantID)
	})
	repo := &Repo{Pool: (*db.Pool)(app), Now: func() time.Time { return fixture.At }}
	classifier := mustClassifier(t, DefaultConfig())
	inline, err := repo.Record(
		ctx, fixture.TenantID, classifierDBObservation(fixture, 0),
		MessageAggregate{}, classifier,
	)
	if err != nil {
		t.Fatalf("record inline retention observation: %v", err)
	}
	objectInput := classifierDBObservation(fixture, 1)
	objectInput.RawObjectRef = "s3://f01-private-evidence/" + uuid.NewString()
	objectInput.RawObjectVersionID = "exact-version-1"
	objectBacked, err := repo.Record(
		ctx, fixture.TenantID, objectInput, MessageAggregate{}, classifier,
	)
	if err != nil {
		t.Fatalf("record legacy object-backed observation: %v", err)
	}

	result, err := repo.PurgeExpiredObservationBatch(ctx, fixture.TenantID, 10)
	if err != nil {
		t.Fatalf("purge bounded inline retention batch: %v", err)
	}
	if result.Deleted != 1 || !result.ObjectBackedBlocked {
		t.Fatalf("retention result=%+v, want one inline deletion and object block", result)
	}
	if deleted, err := repo.PurgeExpiredObservation(
		ctx, fixture.TenantID, objectBacked.ObservationID, "privacy_expired",
	); deleted || !errors.Is(err, ErrObjectDeletionRequired) {
		t.Fatalf("object-backed repository purge=(%v,%v), want fail closed", deleted, err)
	}

	workerTx, err := db.WithTenantWorker(ctx, (*db.Pool)(app), fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = workerTx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, workerTx); err != nil {
		t.Fatal(err)
	}
	var deleted bool
	err = workerTx.QueryRow(ctx, `
SELECT purge_expired_subscriber_event_observation($1::uuid, $2::uuid, 'privacy_expired')`,
		fixture.TenantID, objectBacked.ObservationID).Scan(&deleted)
	if classifierSQLState(err) != "55000" {
		t.Fatalf("object-backed SQL purge error=%v state=%q, want 55000",
			err, classifierSQLState(err))
	}
	_ = workerTx.Rollback(ctx)

	var inlineRows, objectRows, inlineReceipts, objectReceipts int
	if err := admin.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_event_observations WHERE id=$1::uuid),
  (SELECT count(*) FROM subscriber_event_observations WHERE id=$2::uuid),
  (SELECT count(*) FROM subscriber_event_observation_deletions
    WHERE tenant_id=$3::uuid AND observation_id=$1::uuid),
  (SELECT count(*) FROM subscriber_event_observation_deletions
    WHERE tenant_id=$3::uuid AND observation_id=$2::uuid)`,
		inline.ObservationID, objectBacked.ObservationID, fixture.TenantID).Scan(
		&inlineRows, &objectRows, &inlineReceipts, &objectReceipts,
	); err != nil {
		t.Fatal(err)
	}
	if inlineRows != 0 || objectRows != 1 || inlineReceipts != 1 || objectReceipts != 0 {
		t.Fatalf("retention rows inline/object=%d/%d receipts=%d/%d",
			inlineRows, objectRows, inlineReceipts, objectReceipts)
	}
}
