// SPDX-License-Identifier: AGPL-3.0-only

package deliverability_hub

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type concurrentHealthNotifier struct {
	mu        sync.Mutex
	incidents []string
}

func (n *concurrentHealthNotifier) NotifyDeliverabilityDegraded(_ context.Context, alert HealthAlert) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.incidents = append(n.incidents, alert.IncidentID)
	return nil
}

func (*concurrentHealthNotifier) NotifyDeliverabilityAutoThrottled(context.Context, ThrottleAlert) {}

func (n *concurrentHealthNotifier) count() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.incidents)
}

func newDegradationDBTestPool(t *testing.T) *db.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping degradation DB test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect to degradation test database: %v", err)
	}
	t.Cleanup(pool.Close)
	var migrated bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.deliverability_degradation_claims') IS NOT NULL
   AND to_regclass('public.deliverability_hub_snapshots_cadence_uidx') IS NOT NULL
   AND to_regprocedure(
       'public.deliverability_hub_worker_tenants(timestamp with time zone,bigint)'
   ) IS NOT NULL`).Scan(&migrated); err != nil {
		t.Fatalf("inspect degradation migration: %v", err)
	}
	if !migrated {
		t.Fatalf("migration 1849 is not applied to the test database")
	}
	return pool
}

func seedDegradationDBFixture(
	t *testing.T,
	pool *db.Pool,
	now time.Time,
) string {
	t.Helper()
	tenantID := uuid.NewString()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("begin degradation fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("bind degradation fixture tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'degradation concurrency test',
        'degradation-concurrency-' || left($1::text, 8), 'studio')`, tenantID); err != nil {
		t.Fatalf("seed degradation tenant: %v", err)
	}
	// The DNS instruction columns are mandatory and pinned to exactly these two
	// literals by `sending_identities_dns_instruction_safety_check` (migration
	// 1854_dmarc_evidence_hardening.sql). They are wizard instructions, not
	// tenant-supplied DNS, so the only production writer
	// (`upsertSendingIdentitySQL` in internal/sending_identity) always emits
	// these same values from spfRecordValue()/dmarcRecordValue(). This fixture
	// omitted them and so described an identity that production cannot create;
	// it must carry them to remain a faithful DNS-only inventory row.
	if _, err := tx.Exec(ctx, `
INSERT INTO sending_identities
    (tenant_id, domain, dkim_public_key_b64, verify_state,
     spf_record_value, dmarc_record_value)
VALUES ($1::uuid, 'degradation.example.test', 'test-public-key', 'pending',
        'v=spf1 include:_spf.postwave.io -all',
        'v=DMARC1; p=none; aspf=r; adkim=r')`, tenantID); err != nil {
		t.Fatalf("seed DNS-only inventory evidence: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO outbound_webhooks (
    tenant_id, url, url_envelope, url_state, events, secret_envelope,
    active, auth_config_state, created_at
)
VALUES (
    $1::uuid, 'https://example.invalid/…', '\x01'::bytea, 'ready',
    ARRAY['list_health.degraded']::text[], '\x00'::bytea, true, 'ready', $2
)`, tenantID, now.Add(-2*time.Hour)); err != nil {
		t.Fatalf("seed degradation webhook: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO deliverability_hub_snapshots
    (tenant_id, score, model_version, sample_qualified, sample_size,
     sampled_at, observation_bucket_at)
VALUES ($1::uuid, 75, $2, true, 1200, $3, $4)`,
		tenantID,
		DeliverabilityScoreModelVersion,
		now.Add(-time.Hour),
		now.Add(-time.Hour).Truncate(time.Hour),
	); err != nil {
		t.Fatalf("seed healthy snapshot: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit degradation fixture: %v", err)
	}

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanup, cleanupErr := db.WithWorkerScope(cleanupCtx, pool)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx,
			"SELECT set_config('app.tenant_id', $1, true)", tenantID)
		_, _ = cleanup.Exec(cleanupCtx,
			"DELETE FROM tenants WHERE id = $1::uuid", tenantID)
		_ = cleanup.Commit(cleanupCtx)
	})
	return tenantID
}

func TestDegradationConcurrentWorkersOwnOneCadenceAndOneDelivery_DB(t *testing.T) {
	pool := newDegradationDBTestPool(t)
	// The PREVIOUS hour's bucket, so this instant is always in the past.
	//
	// This was `Truncate(time.Hour).Add(10 * time.Minute)`, which lands in the
	// FUTURE for the first ten minutes of every hour. The claim writes that
	// value into `operator_next_attempt_at`, and delivery only leases rows where
	// `operator_next_attempt_at <= now()` — so for ten minutes in sixty this
	// test would find nothing to deliver and fail, correctly, on a row that was
	// genuinely not yet due. The hour bucket is what the cadence check needs;
	// being in the future is not.
	now := time.Now().UTC().Truncate(time.Hour).Add(-time.Hour).Add(10 * time.Minute)
	tenantID := seedDegradationDBFixture(t, pool, now)
	notifier := &concurrentHealthNotifier{}
	workers := []*Worker{
		{Deps: &Deps{Pool: pool, HubInterval: time.Hour, HealthNotifier: notifier}},
		{Deps: &Deps{Pool: pool, HubInterval: time.Hour, HealthNotifier: notifier}},
	}
	hub := HubScore{
		TenantID:        tenantID,
		Score:           45,
		Grade:           "D",
		ModelVersion:    DeliverabilityScoreModelVersion,
		SampleQualified: true,
		ComputedAt:      now,
		WindowDays:      30,
		Totals:          HubTotals{Sends30d: 1200},
		Breaches: []ThresholdBreach{{
			Code: "complaint_rate_high", Title: "Complaint rate above 0.1%",
			Severity: "critical",
		}},
	}

	type result struct {
		claim degradationTransitionClaim
		err   error
	}
	start := make(chan struct{})
	results := make(chan result, len(workers))
	var wg sync.WaitGroup
	for _, worker := range workers {
		wg.Add(1)
		go func(w *Worker) {
			defer wg.Done()
			<-start
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			claim, err := w.recordSnapshotAndClaimDegradation(ctx, tenantID, hub)
			results <- result{claim: claim, err: err}
		}(worker)
	}
	close(start)
	wg.Wait()
	close(results)
	owners := 0
	claims := 0
	for got := range results {
		if got.err != nil {
			t.Fatalf("concurrent degradation worker: %v", got.err)
		}
		if got.claim.ToSnapshotScore != hub.Score ||
			got.claim.ToSnapshotModelVersion != hub.ModelVersion ||
			got.claim.ToSnapshotSampleQualified != hub.SampleQualified ||
			got.claim.ToSnapshotSampleSize != hub.Totals.Sends30d ||
			!got.claim.ToSnapshotSampledAt.Equal(hub.ComputedAt) {
			t.Fatalf("worker returned non-canonical snapshot evidence: %+v", got.claim)
		}
		if got.claim.SnapshotOwned {
			owners++
		}
		if got.claim.Claimed {
			claims++
		}
	}
	if owners != 1 || claims != 1 {
		t.Fatalf("snapshot owners=%d claims=%d, want exactly one each", owners, claims)
	}

	// Two replicas race the durable operator outbox; SKIP LOCKED + lease allows
	// exactly one invocation and the winning ACK closes the incident.
	start = make(chan struct{})
	errs := make(chan error, len(workers))
	for _, worker := range workers {
		wg.Add(1)
		go func(w *Worker) {
			defer wg.Done()
			<-start
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			errs <- w.deliverPendingDegradationNotifications(ctx)
		}(worker)
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("drain degradation notifications: %v", err)
		}
	}
	if got := notifier.count(); got != 1 {
		t.Fatalf("operator notifier calls=%d, want 1", got)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	verify, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("begin degradation verification: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	if _, err := verify.Exec(ctx,
		"SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("bind verification tenant: %v", err)
	}
	var snapshotCount, claimCount, receiptCount, deliveryCount int
	var operatorDone bool
	if err := verify.QueryRow(ctx, `
SELECT (SELECT count(*) FROM deliverability_hub_snapshots WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM deliverability_degradation_claims WHERE tenant_id=$1::uuid),
       (SELECT count(*) FROM outbound_webhook_event_receipts
         WHERE tenant_id=$1::uuid AND event_type='list_health.degraded'),
       (SELECT count(*) FROM outbound_webhook_deliveries
         WHERE tenant_id=$1::uuid AND event_type='list_health.degraded'),
       (SELECT bool_and(operator_notified_at IS NOT NULL)
          FROM deliverability_degradation_claims WHERE tenant_id=$1::uuid)`, tenantID).Scan(
		&snapshotCount, &claimCount, &receiptCount, &deliveryCount, &operatorDone,
	); err != nil {
		t.Fatalf("verify degradation evidence: %v", err)
	}
	if snapshotCount != 2 || claimCount != 1 || receiptCount != 1 || deliveryCount != 1 || !operatorDone {
		t.Fatalf("snapshots=%d claims=%d receipts=%d deliveries=%d operator_done=%v",
			snapshotCount, claimCount, receiptCount, deliveryCount, operatorDone)
	}
	if err := verify.Commit(ctx); err != nil {
		t.Fatalf("commit degradation verification: %v", err)
	}

	// The next real cadence remains appendable; cadence ownership only removes
	// replica duplicates, not later observations.
	later := hub
	later.ComputedAt = now.Add(time.Hour)
	later.Score = 44
	got, err := workers[0].recordSnapshotAndClaimDegradation(ctx, tenantID, later)
	if err != nil {
		t.Fatalf("record later cadence: %v", err)
	}
	if !got.SnapshotOwned || got.Claimed {
		t.Fatalf("later cadence result=%+v, want owned non-crossing snapshot", got)
	}
}

func TestDegradationCadenceReuseReturnsCanonicalSnapshotEvidence_DB(t *testing.T) {
	pool := newDegradationDBTestPool(t)
	firstAt := time.Now().UTC().Truncate(time.Hour).Add(-time.Hour).Add(10 * time.Minute)
	tenantID := seedDegradationDBFixture(t, pool, firstAt)
	worker := &Worker{Deps: &Deps{Pool: pool, HubInterval: time.Hour}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	first := HubScore{
		TenantID:        tenantID,
		Score:           95,
		ModelVersion:    DeliverabilityScoreModelVersion,
		SampleQualified: false,
		ComputedAt:      firstAt,
		Totals:          HubTotals{Sends30d: MinimumRateSampleSends - 1},
	}
	owner, err := worker.recordSnapshotAndClaimDegradation(ctx, tenantID, first)
	if err != nil {
		t.Fatalf("record cadence owner: %v", err)
	}
	if !owner.SnapshotOwned {
		t.Fatalf("first cadence writer did not own its snapshot: %+v", owner)
	}

	// Model a second replica computing materially different live evidence after
	// the cadence owner committed. Reuse must return the first durable snapshot's
	// complete evidence, not pair its ID with these unpersisted caller values.
	second := first
	second.Score = 40
	second.SampleQualified = true
	second.Totals.Sends30d = MinimumRateSampleSends
	second.ComputedAt = firstAt.Add(20 * time.Minute)
	reused, err := worker.recordSnapshotAndClaimDegradation(ctx, tenantID, second)
	if err != nil {
		t.Fatalf("reuse cadence snapshot: %v", err)
	}
	if reused.SnapshotOwned || reused.ToSnapshotID != owner.ToSnapshotID {
		t.Fatalf("cadence reuse ownership/id = %+v, owner=%+v", reused, owner)
	}
	if reused.ToSnapshotScore != first.Score ||
		reused.ToSnapshotModelVersion != first.ModelVersion ||
		reused.ToSnapshotSampleQualified != first.SampleQualified ||
		reused.ToSnapshotSampleSize != first.Totals.Sends30d ||
		!reused.ToSnapshotSampledAt.Equal(first.ComputedAt) {
		t.Fatalf("reused evidence=%+v, want first durable observation=%+v", reused, first)
	}
	if err := reused.validateThrottleSnapshot(first.ModelVersion); err != nil {
		t.Fatalf("reused canonical evidence is not throttle-safe: %v", err)
	}
}

func TestDeliverabilityInventoryScopeAndEvidencePrivileges_DB(t *testing.T) {
	pool := newDegradationDBTestPool(t)
	now := time.Now().UTC()
	tenantID := seedDegradationDBFixture(t, pool, now)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant inventory check: %v", err)
	}
	var leakedTenant string
	err = tenantTx.QueryRow(ctx, workerTenantInventorySQL,
		now.Add(-deliverabilityModelWindow), MinimumRateSampleSends).Scan(&leakedTenant)
	_ = tenantTx.Rollback(ctx)
	if err == nil {
		t.Fatalf("tenant-scoped app session enumerated worker inventory tenant %q", leakedTenant)
	}

	worker := &Worker{Deps: &Deps{Pool: pool, Clock: func() time.Time { return now }}}
	tenants, err := worker.listWorkerTenants(ctx)
	if err != nil {
		t.Fatalf("worker inventory: %v", err)
	}
	found := false
	for _, candidate := range tenants {
		if candidate == tenantID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("DNS-only tenant %s missing from worker inventory", tenantID)
	}

	var snapshotDelete, claimDelete, reasonUpdate, clearedAtUpdate bool
	if err := pool.QueryRow(ctx, `
SELECT has_table_privilege('postwave_app', 'public.deliverability_hub_snapshots', 'DELETE'),
       has_table_privilege('postwave_app', 'public.deliverability_degradation_claims', 'DELETE'),
       has_column_privilege('postwave_app', 'public.deliverability_repair_overrides', 'reason', 'UPDATE'),
       has_column_privilege('postwave_app', 'public.deliverability_repair_overrides', 'cleared_at', 'UPDATE')`).Scan(
		&snapshotDelete, &claimDelete, &reasonUpdate, &clearedAtUpdate,
	); err != nil {
		t.Fatalf("inspect deliverability evidence privileges: %v", err)
	}
	if snapshotDelete || claimDelete || reasonUpdate || !clearedAtUpdate {
		t.Fatalf("snapshot_delete=%v claim_delete=%v reason_update=%v cleared_at_update=%v",
			snapshotDelete, claimDelete, reasonUpdate, clearedAtUpdate)
	}
}
