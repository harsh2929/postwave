// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed tests for the async bulk-verification job runner.

package verification

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func jobStore(t *testing.T, pool interface{ Close() }) {}

// runnerFor builds a Store plus a Runner wired to a scripted vendor.
func runnerFor(t *testing.T, tenant string, s *Store, vendor Verifier) *Runner {
	t.Helper()
	return &Runner{
		Store: s,
		ChainFor: func(context.Context, string) (*Chain, error) {
			return &Chain{
				Local:  localStub(nil),
				Vendor: vendor,
				Cache:  &TenantCache{Store: s, TenantID: tenant, TTL: DefaultCacheTTL},
			}, nil
		},
		BatchSize: 2,
	}
}

func seedHeldJobImport(t *testing.T, pool *db.Pool, tenant, mode string, rows int) string {
	t.Helper()
	importID := uuid.NewString()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `INSERT INTO subscriber_imports
		(id,tenant_id,object_key,original_filename,mapping,rows_total,status,
		 verification_mode,verification_state,source_delete_after)
		VALUES ($1::uuid,$2::uuid,$3,'held-job.csv','{}'::jsonb,$4,
		        'verification_running',$5,'pending',NULL)`,
		importID, tenant, "imports/"+importID+".csv", rows, mode); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return importID
}

func TestDBCreateInlineJobSeedsUnprocessedItems(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	job, err := s.CreateJob(ctx, tenant, JobSpec{
		Source: JobSourceInline,
		Emails: []string{"a@example.com", "b@example.com", "c@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	if job.Status != JobStatusPending {
		t.Fatalf("Status = %q, want %q", job.Status, JobStatusPending)
	}
	if job.Total != 3 {
		t.Fatalf("Total = %d, want 3", job.Total)
	}
	if job.Processed != 0 {
		t.Fatalf("Processed = %d, want 0", job.Processed)
	}
	if job.ExecutionMode != JobExecutionModeFull {
		t.Fatalf("ExecutionMode = %q, want default %q", job.ExecutionMode, JobExecutionModeFull)
	}
}

func TestDBLocalExecutionModeNeverCallsInjectedVendor(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	job, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"local@example.com"},
		ExecutionMode: JobExecutionModeLocal,
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	vendor := vendorStub(nil)
	runner := &Runner{Store: s, ChainFor: func(context.Context, string) (*Chain, error) {
		return &Chain{Local: localStub(nil), Vendor: vendor}, nil
	}}
	if err := runner.RunJob(context.Background(), tenant, job.ID); err != nil {
		t.Fatalf("RunJob: %v", err)
	}
	if got := vendor.asked(); len(got) != 0 {
		t.Fatalf("local-mode job crossed the paid boundary: %v", got)
	}
	done, err := s.GetJob(context.Background(), tenant, job.ID)
	if err != nil || done.Status != JobStatusCompleted || done.CreditsSpent != 0 {
		t.Fatalf("local-mode completion = %+v, err=%v", done, err)
	}
}

func TestDBFullExecutionWithoutProviderFailsBeforeClaimingItems(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	job, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"full@example.com"},
		ExecutionMode: JobExecutionModeFull,
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	err = (&Runner{Store: s}).RunJob(context.Background(), tenant, job.ID)
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("RunJob err=%v, want ErrNotConfigured", err)
	}
	failed, getErr := s.GetJob(context.Background(), tenant, job.ID)
	if getErr != nil || failed.Status != JobStatusFailed || failed.FailureCode != "provider_not_configured" {
		t.Fatalf("full-mode failure = %+v, err=%v", failed, getErr)
	}
	items, itemsErr := s.JobResults(context.Background(), tenant, job.ID, JobResultFilter{Limit: 10})
	if itemsErr != nil || len(items) != 1 || items[0].AttemptState != "pending" || items[0].Processed {
		t.Fatalf("full-mode no-provider items=%+v err=%v", items, itemsErr)
	}
}

func TestDBHeldImportJobBindsBeforeActivationAndCannotSpendWhileHeld(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	importID := seedHeldJobImport(t, pool, tenant, JobExecutionModeFull, 1)
	key := SubscriberImportJobIdempotencyKey(importID)
	bulk, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"decoy@example.com"}, IdempotencyKey: key,
	})
	if err != nil {
		t.Fatalf("public namespace CreateJob: %v", err)
	}
	job, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceUpload, SourceRef: importID, Emails: []string{"held@example.com"},
		ExecutionMode: JobExecutionModeFull, SubscriberImportHeld: true,
		IdempotencyKey: key,
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	if job.ExecutionClass != JobExecutionClassSubscriberImport || job.Status != JobStatusPending || job.ActivatedAt != nil {
		t.Fatalf("held job lifecycle=%+v", job)
	}
	if job.ID == bulk.ID || bulk.ExecutionClass != jobExecutionClassBulk {
		t.Fatalf("execution-class idempotency namespaces collided bulk=%+v import=%+v", bulk, job)
	}
	tx, err := db.WithTenant(context.Background(), pool, tenant)
	if err != nil {
		t.Fatal(err)
	}
	var linked string
	if err := tx.QueryRow(context.Background(), `SELECT verification_job_id::text
		FROM subscriber_imports WHERE id=$1::uuid`, importID).Scan(&linked); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatal(err)
	}
	_ = tx.Commit(context.Background())
	if linked != job.ID {
		t.Fatalf("import linked job=%q want=%q", linked, job.ID)
	}

	vendor := vendorStub(nil)
	runner := runnerFor(t, tenant, s, vendor)
	if err := runner.RunJob(context.Background(), tenant, job.ID); err != nil {
		t.Fatalf("held RunJob: %v", err)
	}
	if got := vendor.asked(); len(got) != 0 {
		t.Fatalf("held job crossed provider boundary: %v", got)
	}
	if err := s.ActivateSubscriberImportJob(context.Background(), tenant, job.ID, importID, JobExecutionModeFull); err != nil {
		t.Fatalf("ActivateSubscriberImportJob: %v", err)
	}
	// Simulate the pre-1956 claim predicate after activation. Import jobs stay
	// in their private status vocabulary for their whole non-terminal life, so
	// a rolling old worker cannot see even an activated job and bypass its
	// frozen execution mode.
	oldWorkerTx, err := db.WithTenant(context.Background(), pool, tenant)
	if err != nil {
		t.Fatal(err)
	}
	oldClaim, err := oldWorkerTx.Exec(context.Background(), `
UPDATE verification_jobs
   SET status='running'
 WHERE tenant_id=$1::uuid AND id=$2::uuid
   AND status IN ('pending','running')`, tenant, job.ID)
	if err != nil {
		_ = oldWorkerTx.Rollback(context.Background())
		t.Fatalf("old-worker claim simulation: %v", err)
	}
	if oldClaim.RowsAffected() != 0 {
		_ = oldWorkerTx.Rollback(context.Background())
		t.Fatal("pre-1956 worker claimed an activated subscriber-import verification job")
	}
	if err := oldWorkerTx.Commit(context.Background()); err != nil {
		t.Fatalf("commit old-worker claim simulation: %v", err)
	}
	if err := runner.RunJob(context.Background(), tenant, job.ID); err != nil {
		t.Fatalf("activated RunJob: %v", err)
	}
	if got := vendor.asked(); len(got) != 1 || got[0] != "held@example.com" {
		t.Fatalf("activated provider calls=%v", got)
	}
}

func TestDBEmptyHeldFullImportCompletesWithoutProvider(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	importID := seedHeldJobImport(t, pool, tenant, JobExecutionModeFull, 3)
	job, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceUpload, SourceRef: importID, ExecutionMode: JobExecutionModeFull,
		SubscriberImportHeld: true, IdempotencyKey: SubscriberImportJobIdempotencyKey(importID),
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	if job.Status != JobStatusCompleted || job.Total != 0 || job.CreditsSpent != 0 ||
		job.CompletedAt == nil || job.ActivatedAt == nil {
		t.Fatalf("empty held job=%+v", job)
	}
	if err := (&Runner{Store: s}).RunJob(context.Background(), tenant, job.ID); err != nil {
		t.Fatalf("completed empty RunJob: %v", err)
	}
}

func TestDBFullExecutionRecordsConfiguredProviderBuildFailureSafely(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	// No secret resolver is deliberate: the enabled provider is known, but its
	// credential cannot be built. The job must fail before claiming an item and
	// the provider row must receive only the stable health code.
	s := newStore(t, pool, nil)
	if _, err := s.UpsertProvider(context.Background(), tenant, ProviderConfig{
		Provider: ProviderKickbox, CredentialRef: "missing-runtime-secret", Enabled: true,
	}); err != nil {
		t.Fatalf("UpsertProvider: %v", err)
	}
	job, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"full@example.com"},
		ExecutionMode: JobExecutionModeFull,
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	err = (&Runner{Store: s}).RunJob(context.Background(), tenant, job.ID)
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("RunJob err=%v, want ErrNotConfigured", err)
	}
	provider, err := s.EnabledProvider(context.Background(), tenant)
	if err != nil {
		t.Fatalf("EnabledProvider: %v", err)
	}
	if provider == nil || provider.LastError != "provider_not_configured" || provider.LastErrorAt == nil {
		t.Fatalf("provider build failure was not recorded safely: %+v", provider)
	}
	items, err := s.JobResults(context.Background(), tenant, job.ID, JobResultFilter{Limit: 10})
	if err != nil || len(items) != 1 || items[0].AttemptState != "pending" || items[0].Processed {
		t.Fatalf("provider build failure claimed work items=%+v err=%v", items, err)
	}
}

func TestDBCreateInlineJobDeduplicatesAddresses(t *testing.T) {
	// A duplicate in the uploaded file must not become a second
	// billable row.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)

	job, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceUpload,
		Emails: []string{"dup@example.com", "DUP@Example.com", "other@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	if job.Total != 2 {
		t.Fatalf("Total = %d, want 2 after case-insensitive dedup", job.Total)
	}
}

func TestDBCreateJobIdempotencyIsTenantScopedAndInputBound(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()
	spec := JobSpec{Source: JobSourceInline, Emails: []string{"a@example.com"}, IdempotencyKey: "retry-42"}

	first, err := s.CreateJob(ctx, tenant, spec)
	if err != nil {
		t.Fatalf("first CreateJob: %v", err)
	}
	replayed, err := s.CreateJob(ctx, tenant, spec)
	if err != nil {
		t.Fatalf("replayed CreateJob: %v", err)
	}
	if replayed.ID != first.ID {
		t.Fatalf("idempotent retry created %q after %q", replayed.ID, first.ID)
	}
	if _, err := s.CreateJob(ctx, tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"different@example.com"}, IdempotencyKey: "retry-42",
	}); !errors.Is(err, ErrJobIdempotencyConflict) {
		t.Fatalf("mismatched retry error = %v, want ErrJobIdempotencyConflict", err)
	}
}

func TestDBDynamicJobIdempotencyReplaysFrozenMembership(t *testing.T) {
	for _, tt := range []struct {
		name      string
		source    string
		sourceRef string
		remove    string
	}{
		{
			name: "tag", source: JobSourceTag, sourceRef: "reviewed",
			remove: `UPDATE subscribers SET tags='{}'::text[] WHERE tenant_id=$1::uuid`,
		},
		{
			name: "all subscribers", source: JobSourceAllSubscribers,
			remove: `DELETE FROM subscribers WHERE tenant_id=$1::uuid`,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			pool := verificationDB(t)
			tenant := newTenant(t, pool)
			s := newStore(t, pool, nil)
			ctx := context.Background()
			tx, err := db.WithTenant(ctx, pool, tenant)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id,email,status,consent_source,tags)
VALUES ($1::uuid,'frozen@example.com','enabled','api',ARRAY['reviewed']::text[])`, tenant); err != nil {
				_ = tx.Rollback(ctx)
				t.Fatalf("seed subscriber: %v", err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatalf("commit subscriber: %v", err)
			}

			spec := JobSpec{
				Source: tt.source, SourceRef: tt.sourceRef,
				IdempotencyKey: "dynamic-frozen-" + strings.ReplaceAll(tt.name, " ", "-"),
			}
			first, err := s.CreateJob(ctx, tenant, spec)
			if err != nil {
				t.Fatalf("first CreateJob: %v", err)
			}
			wantFingerprint := jobRequestFingerprint(tt.source, tt.sourceRef, nil, JobExecutionModeFull)
			if first.Total != 1 || first.RequestFingerprint != wantFingerprint {
				t.Fatalf("first dynamic job=%+v, fingerprint want %q", first, wantFingerprint)
			}

			removeTx, err := db.WithTenant(ctx, pool, tenant)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := removeTx.Exec(ctx, tt.remove, tenant); err != nil {
				_ = removeTx.Rollback(ctx)
				t.Fatalf("change dynamic membership: %v", err)
			}
			if err := removeTx.Commit(ctx); err != nil {
				t.Fatalf("commit membership change: %v", err)
			}

			replay, err := s.CreateJob(ctx, tenant, spec)
			if err != nil {
				t.Fatalf("retry after membership change: %v", err)
			}
			if replay.ID != first.ID || replay.Total != 1 || replay.RequestFingerprint != wantFingerprint {
				t.Fatalf("dynamic retry drifted: first=%+v replay=%+v", first, replay)
			}
		})
	}
}

func TestDBDynamicJobResolutionIsOrderedAndBounded(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id,email,status,consent_source,tags) VALUES
 ($1::uuid,'c@example.com','enabled','api',ARRAY['bounded']::text[]),
 ($1::uuid,'a@example.com','enabled','api',ARRAY['bounded']::text[]),
 ($1::uuid,'b@example.com','enabled','api',ARRAY['bounded']::text[])`, tenant); err != nil {
		t.Fatalf("seed bounded subscribers: %v", err)
	}

	got, err := resolveJobAddressesWithLimit(ctx, tx, tenant, JobSpec{
		Source: JobSourceTag, SourceRef: "bounded",
	}, 3)
	if err != nil {
		t.Fatalf("resolve within limit: %v", err)
	}
	want := []string{"a@example.com", "b@example.com", "c@example.com"}
	if !slices.Equal(got, want) {
		t.Fatalf("deterministic resolution=%v, want %v", got, want)
	}
	if _, err := resolveJobAddressesWithLimit(ctx, tx, tenant, JobSpec{
		Source: JobSourceAllSubscribers,
	}, 2); err == nil || !strings.Contains(err.Error(), "3 addresses exceeds the 2 per-job limit") {
		t.Fatalf("oversized bounded resolution error=%v", err)
	}
}

func TestDBConcurrentJobClaimHasOneOwner(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	job, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"a@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	winners := 0
	var mu sync.Mutex
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			claimed, claimErr := s.claimJob(context.Background(), tenant, job.ID,
				"concurrent-owner-"+string(rune('a'+i)), time.Minute)
			if claimErr != nil && !errors.Is(claimErr, ErrJobLeaseHeld) {
				t.Errorf("claim %d: %v", i, claimErr)
				return
			}
			if claimed {
				mu.Lock()
				winners++
				mu.Unlock()
			}
		}(i)
	}
	close(start)
	wg.Wait()
	if winners != 1 {
		t.Fatalf("concurrent winners = %d, want exactly 1", winners)
	}
}

func seedExpiredJobAttempt(
	t *testing.T,
	pool *db.Pool,
	tenantID, jobID, email, previousOwner string,
	requestStarted bool,
) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE verification_jobs
   SET status = 'running', lease_owner = $3,
       lease_expires_at = now() - interval '1 minute'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, jobID, previousOwner); err != nil {
		t.Fatalf("expire job lease: %v", err)
	}
	requestSQL := "NULL"
	if requestStarted {
		requestSQL = "now() - interval '2 minutes'"
	}
	if _, err := tx.Exec(ctx, `
UPDATE verification_job_items
   SET attempt_state = 'leased', attempt_token = gen_random_uuid(),
       request_started_at = `+requestSQL+`, lease_owner = $4,
       lease_expires_at = now() - interval '1 minute'
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND email = $3`,
		tenantID, jobID, email, previousOwner); err != nil {
		t.Fatalf("seed expired item lease: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit expired attempt: %v", err)
	}
}

func TestDBExpiredPreDispatchAttemptIsRecoveredWithoutAmbiguity(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	job, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"recover@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	seedExpiredJobAttempt(t, pool, tenant, job.ID, "recover@example.com", "dead-worker", false)

	claimed, err := s.claimJob(context.Background(), tenant, job.ID, "new-worker", time.Minute)
	if err != nil || !claimed {
		t.Fatalf("claim recovered job = %v, %v", claimed, err)
	}
	items, err := s.JobResults(context.Background(), tenant, job.ID, JobResultFilter{Limit: 10})
	if err != nil {
		t.Fatalf("JobResults: %v", err)
	}
	if len(items) != 1 || items[0].AttemptState != "pending" {
		t.Fatalf("recovered items = %+v, want one pending", items)
	}
}

func TestDBExpiredPostDispatchAttemptBecomesTerminalAmbiguous(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	job, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"uncertain@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	seedExpiredJobAttempt(t, pool, tenant, job.ID, "uncertain@example.com", "dead-worker", true)

	claimed, err := s.claimJob(context.Background(), tenant, job.ID, "new-worker", time.Minute)
	if claimed || !errors.Is(err, ErrJobOutcomeAmbiguous) {
		t.Fatalf("claim ambiguous job = %v, %v", claimed, err)
	}
	got, err := s.GetJob(context.Background(), tenant, job.ID)
	if err != nil {
		t.Fatalf("GetJob: %v", err)
	}
	if got.Status != JobStatusFailed || got.Ambiguous != 1 || got.FailureCode != failureCodeOutcomeAmbiguous {
		t.Fatalf("ambiguous job = %+v", got)
	}
	items, err := s.JobResults(context.Background(), tenant, job.ID, JobResultFilter{Limit: 10})
	if err != nil || len(items) != 1 || items[0].AttemptState != "ambiguous" || items[0].Processed {
		t.Fatalf("ambiguous items = %+v, err=%v", items, err)
	}
}

func TestDBDispatchedProviderFailureIsNeverRetried(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	job, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"uncertain@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	vendor := &fakeVerifier{name: ProviderZeroBounce, err: ErrProviderUnavailable}
	runner := runnerFor(t, tenant, s, vendor)
	err = runner.RunJob(context.Background(), tenant, job.ID)
	if !errors.Is(err, ErrJobOutcomeAmbiguous) || len(vendor.asked()) != 1 {
		t.Fatalf("first run err=%v calls=%v", err, vendor.asked())
	}
	if err := runner.RunJob(context.Background(), tenant, job.ID); err != nil {
		t.Fatalf("terminal rerun: %v", err)
	}
	if len(vendor.asked()) != 1 {
		t.Fatalf("terminal ambiguous job was retried: %v", vendor.asked())
	}
}

func TestDBJobClaimRequiresWorkerPolicy(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	job, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"a@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	err = tx.QueryRow(ctx, `SELECT count(*) FROM verification_jobs WHERE id=$1::uuid`, job.ID).Scan(&count)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("unscoped job read: %v", err)
	}
	if count != 0 {
		t.Fatalf("unscoped app role saw %d worker jobs", count)
	}
}

func TestDBCreateJobRejectsEmptyInlineList(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)

	if _, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceInline, Emails: nil,
	}); err == nil {
		t.Fatal("expected an error for an inline job with no addresses")
	}
}

func TestDBCreateJobRejectsUnknownSource(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)

	if _, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: "segment", SourceRef: "abc",
	}); err == nil {
		t.Fatal("expected an error for a source the worker cannot resolve")
	}
}

func TestDBRunJobVerifiesEveryItemAndCompletes(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	job, err := s.CreateJob(ctx, tenant, JobSpec{
		Source: JobSourceInline,
		Emails: []string{"a@example.com", "b@example.com", "c@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}

	vendor := vendorStub(map[string]Result{
		"a@example.com": {Status: StatusValid, Billable: true},
		"b@example.com": {Status: StatusInvalid, SubStatus: SubStatusMailboxNotFound, Billable: true},
		"c@example.com": {Status: StatusCatchAll, Billable: true},
	})
	r := runnerFor(t, tenant, s, vendor)

	if err := r.RunJob(ctx, tenant, job.ID); err != nil {
		t.Fatalf("RunJob: %v", err)
	}

	done, err := s.GetJob(ctx, tenant, job.ID)
	if err != nil {
		t.Fatalf("GetJob: %v", err)
	}
	if done.Status != JobStatusCompleted {
		t.Fatalf("Status = %q (error=%q), want %q", done.Status, done.Error, JobStatusCompleted)
	}
	if done.Processed != 3 {
		t.Fatalf("Processed = %d, want 3", done.Processed)
	}
	if done.CreditsSpent != 3 {
		t.Fatalf("CreditsSpent = %d, want 3", done.CreditsSpent)
	}
	if done.CompletedAt == nil {
		t.Fatal("CompletedAt not set")
	}

	items, err := s.JobResults(ctx, tenant, job.ID, JobResultFilter{Limit: 50})
	if err != nil {
		t.Fatalf("JobResults: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("got %d items, want 3", len(items))
	}
	for _, it := range items {
		if !it.Processed {
			t.Fatalf("item %q left unprocessed", it.Email)
		}
	}
}

func TestDBRunJobRecordsMeasuredLocalSavings(t *testing.T) {
	// The savings figure shown to an operator has to be the one that
	// actually happened, not an estimate.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	job, err := s.CreateJob(ctx, tenant, JobSpec{
		Source: JobSourceInline,
		Emails: []string{"junk@mailinator.com", "real@example.com", "nope@bad"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}

	// Real local verifier: the legacy mailinator corpus hit is advisory,
	// "nope@bad" fails syntax, and the two routable addresses reach the vendor.
	vendor := vendorStub(nil)
	r := &Runner{
		Store: s,
		ChainFor: func(context.Context, string) (*Chain, error) {
			return &Chain{
				Local: &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
					return true, "mx.example.com", nil
				}},
				Vendor: vendor,
			}, nil
		},
		BatchSize: 10,
	}
	if err := r.RunJob(ctx, tenant, job.ID); err != nil {
		t.Fatalf("RunJob: %v", err)
	}

	done, err := s.GetJob(ctx, tenant, job.ID)
	if err != nil {
		t.Fatalf("GetJob: %v", err)
	}
	if done.LocalFiltered != 1 {
		t.Fatalf("LocalFiltered = %d, want 1", done.LocalFiltered)
	}
	if done.CreditsSpent != 2 {
		t.Fatalf("CreditsSpent = %d, want 2 — a static heuristic must not suppress mailbox probes", done.CreditsSpent)
	}
	if n := len(vendor.asked()); n != 2 {
		t.Fatalf("vendor asked %d times (%v), want 2", n, vendor.asked())
	}
}

func TestDBRunJobResumesWithoutRepayingForCompletedItems(t *testing.T) {
	// A worker crash mid-job must not re-verify what was already
	// verified; those credits are already spent.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	job, err := s.CreateJob(ctx, tenant, JobSpec{
		Source: JobSourceInline,
		Emails: []string{"a@example.com", "b@example.com", "c@example.com", "d@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}

	// First pass: a vendor that fails after the first batch of 2.
	calls := 0
	flaky := &fakeVerifier{name: ProviderZeroBounce, fallback: Result{Status: StatusValid, Billable: true}}
	r := &Runner{
		Store: s,
		ChainFor: func(context.Context, string) (*Chain, error) {
			calls++
			if calls > 1 {
				return nil, errors.New("simulated crash")
			}
			return &Chain{Local: localStub(nil), Vendor: flaky}, nil
		},
		BatchSize: 2,
		// One batch per RunJob invocation so the failure lands
		// between batches.
		MaxBatchesPerRun: 1,
	}
	if err := r.RunJob(ctx, tenant, job.ID); err != nil {
		t.Fatalf("first RunJob: %v", err)
	}

	mid, err := s.GetJob(ctx, tenant, job.ID)
	if err != nil {
		t.Fatalf("GetJob: %v", err)
	}
	if mid.Processed != 2 {
		t.Fatalf("Processed = %d after one batch, want 2", mid.Processed)
	}
	if mid.Status != JobStatusRunning {
		t.Fatalf("Status = %q, want %q while work remains", mid.Status, JobStatusRunning)
	}

	// Second pass with a fresh runner: only the remaining 2 addresses
	// should be sent to the vendor.
	fresh := vendorStub(nil)
	r2 := runnerFor(t, tenant, s, fresh)
	r2.BatchSize = 10
	if err := r2.RunJob(ctx, tenant, job.ID); err != nil {
		t.Fatalf("second RunJob: %v", err)
	}
	if n := len(fresh.asked()); n != 2 {
		t.Fatalf("resume asked the vendor %d times (%v), want 2", n, fresh.asked())
	}

	done, err := s.GetJob(ctx, tenant, job.ID)
	if err != nil {
		t.Fatalf("GetJob: %v", err)
	}
	if done.Status != JobStatusCompleted || done.Processed != 4 {
		t.Fatalf("job = %+v, want completed with 4 processed", done)
	}
}

func TestDBRunJobFailsLoudlyOnCreditExhaustion(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()
	if _, err := s.UpsertProvider(ctx, tenant, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "runner-credit-test", Enabled: true,
	}); err != nil {
		t.Fatalf("UpsertProvider: %v", err)
	}

	job, err := s.CreateJob(ctx, tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"a@example.com", "b@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}

	broke := &fakeVerifier{name: ProviderZeroBounce, err: ErrNoCredits}
	r := runnerFor(t, tenant, s, broke)

	err = r.RunJob(ctx, tenant, job.ID)
	if !errors.Is(err, ErrNoCredits) {
		t.Fatalf("RunJob err = %v, want ErrNoCredits", err)
	}

	failed, err := s.GetJob(ctx, tenant, job.ID)
	if err != nil {
		t.Fatalf("GetJob: %v", err)
	}
	if failed.Status != JobStatusFailed {
		t.Fatalf("Status = %q, want %q", failed.Status, JobStatusFailed)
	}
	if failed.Error == "" {
		t.Fatal("a failed job must record why")
	}
	provider, err := s.EnabledProvider(ctx, tenant)
	if err != nil {
		t.Fatalf("EnabledProvider: %v", err)
	}
	if provider == nil || provider.LastError != "provider_no_credits" || provider.LastErrorAt == nil {
		t.Fatalf("provider health did not record safe credit exhaustion: %+v", provider)
	}
}

func TestDBCancelJobStopsFurtherWork(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	job, err := s.CreateJob(ctx, tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"a@example.com", "b@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	if err := s.CancelJob(ctx, tenant, job.ID); err != nil {
		t.Fatalf("CancelJob: %v", err)
	}

	vendor := vendorStub(nil)
	r := runnerFor(t, tenant, s, vendor)
	if err := r.RunJob(ctx, tenant, job.ID); err != nil {
		t.Fatalf("RunJob on a canceled job: %v", err)
	}
	if n := len(vendor.asked()); n != 0 {
		t.Fatalf("a canceled job still spent %d credits", n)
	}

	got, err := s.GetJob(ctx, tenant, job.ID)
	if err != nil {
		t.Fatalf("GetJob: %v", err)
	}
	if got.Status != JobStatusCanceled {
		t.Fatalf("Status = %q, want %q", got.Status, JobStatusCanceled)
	}
}

func TestDBJobResultsFilterByStatus(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	job, err := s.CreateJob(ctx, tenant, JobSpec{
		Source: JobSourceInline,
		Emails: []string{"good@example.com", "bad@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	vendor := vendorStub(map[string]Result{
		"good@example.com": {Status: StatusValid, Billable: true},
		"bad@example.com":  {Status: StatusInvalid, Billable: true},
	})
	if err := runnerFor(t, tenant, s, vendor).RunJob(ctx, tenant, job.ID); err != nil {
		t.Fatalf("RunJob: %v", err)
	}

	invalid, err := s.JobResults(ctx, tenant, job.ID, JobResultFilter{
		Status: []string{string(StatusInvalid)}, Limit: 50,
	})
	if err != nil {
		t.Fatalf("JobResults: %v", err)
	}
	if len(invalid) != 1 || invalid[0].Email != "bad@example.com" {
		t.Fatalf("filtered results = %+v", invalid)
	}
}

func TestDBJobSummaryCountsByStatus(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	job, err := s.CreateJob(ctx, tenant, JobSpec{
		Source: JobSourceInline,
		Emails: []string{"a@example.com", "b@example.com", "c@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	vendor := vendorStub(map[string]Result{
		"a@example.com": {Status: StatusValid, Billable: true},
		"b@example.com": {Status: StatusValid, Billable: true},
		"c@example.com": {Status: StatusInvalid, Billable: true},
	})
	if err := runnerFor(t, tenant, s, vendor).RunJob(ctx, tenant, job.ID); err != nil {
		t.Fatalf("RunJob: %v", err)
	}

	sum, err := s.JobSummary(ctx, tenant, job.ID)
	if err != nil {
		t.Fatalf("JobSummary: %v", err)
	}
	if sum["valid"] != 2 || sum["invalid"] != 1 {
		t.Fatalf("summary = %v", sum)
	}
}

func TestDBJobsAreTenantIsolated(t *testing.T) {
	pool := verificationDB(t)
	tenantA := newTenant(t, pool)
	tenantB := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	job, err := s.CreateJob(ctx, tenantA, JobSpec{
		Source: JobSourceInline, Emails: []string{"a@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}

	if _, err := s.GetJob(ctx, tenantB, job.ID); err == nil {
		t.Fatal("tenant B read tenant A's job")
	}
	listed, err := s.ListJobs(ctx, tenantB, 50)
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(listed) != 0 {
		t.Fatalf("tenant B listed %d of tenant A's jobs", len(listed))
	}
}

func TestDBRunJobWritesResultsIntoTheSharedCache(t *testing.T) {
	// A bulk run should make subsequent single lookups free.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	job, err := s.CreateJob(ctx, tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"cached@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	vendor := vendorStub(map[string]Result{
		"cached@example.com": {Status: StatusValid, Billable: true},
	})
	if err := runnerFor(t, tenant, s, vendor).RunJob(ctx, tenant, job.ID); err != nil {
		t.Fatalf("RunJob: %v", err)
	}

	hits, err := (&TenantCache{Store: s, TenantID: tenant, TTL: DefaultCacheTTL}).
		Get(ctx, []string{"cached@example.com"})
	if err != nil {
		t.Fatalf("cache Get: %v", err)
	}
	if len(hits) != 1 {
		t.Fatal("the bulk run did not populate the cache")
	}
}

var _ = jobStore
