// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDBPurgeExpiredStartsBoundedStaleJobItemRetention(t *testing.T) {
	pool, admin, tenantID := purgeDB(t)
	store := newStore(t, pool, nil)
	ctx := context.Background()
	ancient := time.Now().UTC().Add(-VerificationJobMaxNonTerminalAge - time.Hour)

	stale, err := store.CreateJob(ctx, tenantID, JobSpec{
		Source: JobSourceInline, Emails: []string{"stale-pending@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob stale: %v", err)
	}
	healthDBExec(t, pool, tenantID, `
UPDATE verification_jobs
   SET created_at=$3, next_attempt_at=$3
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, stale.ID, ancient)

	fresh, err := store.CreateJob(ctx, tenantID, JobSpec{
		Source: JobSourceInline, Emails: []string{"fresh-pending@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob fresh: %v", err)
	}

	active, err := store.CreateJob(ctx, tenantID, JobSpec{
		Source: JobSourceInline, Emails: []string{"active-lease@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob active: %v", err)
	}
	owner := "active-retention-test-owner"
	leaseUntil := time.Now().UTC().Add(time.Hour)
	healthDBExec(t, pool, tenantID, `
UPDATE verification_jobs
   SET status='running', created_at=$3, started_at=$4, next_attempt_at=$3,
       attempts=1, lease_owner=$5, lease_expires_at=$6
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, active.ID, ancient,
		ancient.Add(time.Hour), owner, leaseUntil)
	healthDBExec(t, pool, tenantID, `
UPDATE verification_job_items
   SET attempt_state='leased', attempt_token=$3::uuid,
       lease_owner=$4, lease_expires_at=$5
 WHERE tenant_id=$1::uuid AND job_id=$2::uuid`, tenantID, active.ID,
		uuid.NewString(), owner, leaseUntil)

	run := purgeOwnRows(t, store, admin, tenantID, 100)
	if run.removed != 0 {
		t.Fatalf("removed address rows = %d, want watchdog transition only", run.removed)
	}
	// The watchdog terminalizes the stale job but deletes nothing: all three
	// jobs and every one of their address items are still there.
	requirePurgeRemoved(t, run.gone, purgeFootprint{})

	got, err := store.GetJob(ctx, tenantID, stale.ID)
	if err != nil {
		t.Fatalf("GetJob stale: %v", err)
	}
	if got.Status != JobStatusFailed || got.FailureCode != failureCodeRetentionTimeout ||
		got.CompletedAt == nil || got.LeaseOwner != "" {
		t.Fatalf("stale job terminal state = %+v", got)
	}
	items, err := store.JobResults(ctx, tenantID, stale.ID, JobResultFilter{Limit: 10})
	if err != nil || len(items) != 1 || items[0].AttemptState != "pending" || items[0].Processed {
		t.Fatalf("stale undispatched item = %+v, err=%v", items, err)
	}

	freshGot, err := store.GetJob(ctx, tenantID, fresh.ID)
	if err != nil || freshGot.Status != JobStatusPending {
		t.Fatalf("fresh job changed = %+v, err=%v", freshGot, err)
	}
	activeGot, err := store.GetJob(ctx, tenantID, active.ID)
	if err != nil || activeGot.Status != JobStatusRunning || activeGot.LeaseOwner != owner {
		t.Fatalf("actively leased job changed = %+v, err=%v", activeGot, err)
	}
}

func TestDBExpireStaleJobPreservesDispatchedAmbiguity(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	store := newStore(t, pool, nil)
	ctx := context.Background()
	ancient := time.Now().UTC().Add(-VerificationJobMaxNonTerminalAge - 2*time.Hour)
	expiredLease := time.Now().UTC().Add(-time.Hour)
	owner := "dead-retention-test-owner"

	job, err := store.CreateJob(ctx, tenantID, JobSpec{
		Source: JobSourceInline, Emails: []string{"ambiguous-stale@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	healthDBExec(t, pool, tenantID, `
UPDATE verification_jobs
   SET status='running', created_at=$3, started_at=$4, next_attempt_at=$3,
       attempts=1, lease_owner=$5, lease_expires_at=$6
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, job.ID, ancient,
		ancient.Add(time.Hour), owner, expiredLease)
	healthDBExec(t, pool, tenantID, `
UPDATE verification_job_items
   SET attempt_state='leased', attempt_token=$3::uuid,
       request_started_at=$4, lease_owner=$5, lease_expires_at=$6
 WHERE tenant_id=$1::uuid AND job_id=$2::uuid`, tenantID, job.ID,
		uuid.NewString(), expiredLease.Add(-time.Minute), owner, expiredLease)

	changed, err := store.expireStaleJob(ctx, staleVerificationJob{tenantID: tenantID, jobID: job.ID})
	if err != nil || !changed {
		t.Fatalf("expireStaleJob changed=%v err=%v", changed, err)
	}
	got, err := store.GetJob(ctx, tenantID, job.ID)
	if err != nil {
		t.Fatalf("GetJob: %v", err)
	}
	if got.Status != JobStatusFailed || got.FailureCode != failureCodeOutcomeAmbiguous ||
		got.Ambiguous != 1 || got.CompletedAt == nil || got.LeaseOwner != "" {
		t.Fatalf("ambiguous terminal job = %+v", got)
	}
	items, err := store.JobResults(ctx, tenantID, job.ID, JobResultFilter{Limit: 10})
	if err != nil || len(items) != 1 || items[0].AttemptState != "ambiguous" ||
		items[0].Status != string(StatusUnknown) || items[0].SubStatus != "provider_response_ambiguous" {
		t.Fatalf("ambiguous item = %+v, err=%v", items, err)
	}
}

func TestDBExpireStaleJobAndWorkerClaimAreSerialized(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	store := newStore(t, pool, nil)
	ctx := context.Background()
	ancient := time.Now().UTC().Add(-VerificationJobMaxNonTerminalAge - time.Hour)

	for i := 0; i < 10; i++ {
		job, err := store.CreateJob(ctx, tenantID, JobSpec{
			Source: JobSourceInline,
			Emails: []string{uuid.NewString() + "@example.com"},
		})
		if err != nil {
			t.Fatalf("CreateJob %d: %v", i, err)
		}
		healthDBExec(t, pool, tenantID, `
UPDATE verification_jobs
   SET created_at=$3, next_attempt_at=$3
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, job.ID, ancient)

		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		var expired, claimed bool
		var expireErr, claimErr error
		go func() {
			defer wg.Done()
			<-start
			expired, expireErr = store.expireStaleJob(ctx,
				staleVerificationJob{tenantID: tenantID, jobID: job.ID})
		}()
		go func() {
			defer wg.Done()
			<-start
			claimed, claimErr = store.claimJob(ctx, tenantID, job.ID,
				"retention-race-owner", time.Hour)
		}()
		close(start)
		wg.Wait()
		// claimJob deliberately reports a concurrently locked candidate as a
		// held lease. In this race that is a valid loser result, not a failure.
		if errors.Is(claimErr, ErrJobLeaseHeld) {
			claimErr = nil
		}
		if expireErr != nil || claimErr != nil {
			t.Fatalf("iteration %d expireErr=%v claimErr=%v", i, expireErr, claimErr)
		}
		if expired == claimed {
			t.Fatalf("iteration %d expired=%v claimed=%v, want exactly one winner", i, expired, claimed)
		}

		got, err := store.GetJob(ctx, tenantID, job.ID)
		if err != nil {
			t.Fatalf("GetJob %d: %v", i, err)
		}
		switch got.Status {
		case JobStatusFailed:
			if !expired || got.FailureCode != failureCodeRetentionTimeout || got.LeaseOwner != "" {
				t.Fatalf("iteration %d invalid expiry winner: %+v", i, got)
			}
		case JobStatusRunning:
			if !claimed || got.LeaseOwner == "" || got.LeaseExpiresAt == nil {
				t.Fatalf("iteration %d invalid claim winner: %+v", i, got)
			}
		default:
			t.Fatalf("iteration %d invalid terminal/lease state: %+v", i, got)
		}
	}
}
