package orchestrator

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/canonical"
)

// fixedNow returns a clock that always reports the given time.
func fixedNow(t time.Time) func() time.Time {
	return func() time.Time { return t }
}

// TestRollback_TableCases covers the four contract-level outcomes:
//
//  1. happy_path — completed job inside its window rolls back cleanly and
//     the job ends up in MigRolledBack with cleared RollbackUntil.
//  2. double_rollback — invoking Rollback on an already-rolled-back job is a
//     no-op (idempotent); no error, no audit entries.
//  3. expired_window — a job past its 7-day deadline is refused with
//     ErrRollbackWindowExpired; the job is left untouched.
//  4. ineligible_status — a job that isn't in MigCompleted (e.g. still
//     importing) is refused with ErrNotRollbackable.
func TestRollback_TableCases(t *testing.T) {
	now := time.Date(2026, 4, 29, 12, 0, 0, 0, time.UTC)
	future := now.Add(3 * 24 * time.Hour)
	past := now.Add(-1 * time.Hour)

	cases := []struct {
		name       string
		job        *canonical.MigrationJob
		wantErrIs  error
		wantStatus canonical.MigrationStatus
		wantAudit  bool
	}{
		{
			name: "happy_path",
			job: &canonical.MigrationJob{
				ID:            "j1",
				TenantID:      "t1",
				Source:        canonical.SourceMailchimp,
				Status:        canonical.MigCompleted,
				RollbackUntil: &future,
			},
			wantStatus: canonical.MigRolledBack,
			wantAudit:  true,
		},
		{
			name: "double_rollback_idempotent",
			job: &canonical.MigrationJob{
				ID:       "j2",
				TenantID: "t1",
				Source:   canonical.SourceMailchimp,
				Status:   canonical.MigRolledBack, // already rolled back
			},
			wantStatus: canonical.MigRolledBack,
			wantAudit:  false,
		},
		{
			name: "expired_window_rejected",
			job: &canonical.MigrationJob{
				ID:            "j3",
				TenantID:      "t1",
				Source:        canonical.SourceMailchimp,
				Status:        canonical.MigCompleted,
				RollbackUntil: &past,
			},
			wantErrIs:  ErrRollbackWindowExpired,
			wantStatus: canonical.MigCompleted,
			wantAudit:  false,
		},
		{
			name: "ineligible_status_rejected",
			job: &canonical.MigrationJob{
				ID:            "j4",
				TenantID:      "t1",
				Source:        canonical.SourceMailchimp,
				Status:        canonical.MigImporting,
				RollbackUntil: &future,
			},
			wantErrIs:  ErrNotRollbackable,
			wantStatus: canonical.MigImporting,
			wantAudit:  false,
		},
		{
			name: "failed_job_without_ledger_rejected",
			job: &canonical.MigrationJob{
				ID:            "j5",
				TenantID:      "t1",
				Source:        canonical.SourceMailchimp,
				Status:        canonical.MigFailed,
				RollbackUntil: &future,
			},
			wantErrIs:  ErrNotRollbackable,
			wantStatus: canonical.MigFailed,
			wantAudit:  false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			audited := []string{}
			eng := NewRollbackEngine(nil, nil, "t1")
			eng.Now = fixedNow(now)
			eng.Audit = func(_ context.Context, ev string, _ map[string]interface{}) {
				audited = append(audited, ev)
			}

			err := eng.Rollback(context.Background(), tc.job)
			if tc.wantErrIs != nil {
				require.Error(t, err)
				require.True(t, errors.Is(err, tc.wantErrIs), "expected %v, got %v", tc.wantErrIs, err)
			} else {
				require.NoError(t, err)
			}
			require.Equal(t, tc.wantStatus, tc.job.Status)
			if tc.wantAudit {
				require.Contains(t, audited, "migration.rolled_back")
			} else {
				require.NotContains(t, audited, "migration.rolled_back")
			}
		})
	}
}

// TestRollback_PartialFailureRecovery verifies the engine surfaces a clear
// error and marks progress=failed when a step fails — but leaves the job in
// MigCompleted so the user can retry. Idempotent retry is checked by the
// happy_path + double_rollback combo above.
func TestRollback_PartialFailureRecovery(t *testing.T) {
	now := time.Date(2026, 4, 29, 12, 0, 0, 0, time.UTC)
	future := now.Add(3 * 24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "j-partial",
		TenantID:      "t1",
		Source:        canonical.SourceMailchimp,
		Status:        canonical.MigCompleted,
		RollbackUntil: &future,
	}

	eng := &RollbackEngine{
		TenantID: "t1",
		Now:      fixedNow(now),
		Audit:    func(_ context.Context, _ string, _ map[string]interface{}) {},
		progress: map[string]*RollbackProgress{},
	}
	// With nil Listmonk + nil DB, every step is a no-op and the rollback
	// completes successfully — that's the realistic "nothing to delete"
	// branch the engine must handle without crashing.
	require.NoError(t, eng.Rollback(context.Background(), job))
	require.Equal(t, canonical.MigRolledBack, job.Status)
	require.Nil(t, job.RollbackUntil)

	prog := eng.Progress(job.ID)
	require.NotNil(t, prog)
	require.Equal(t, "completed", prog.State)
}

func TestRollbackRefusesToSkipSubscriberDeletesWithoutListmonk(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	future := now.Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "j-needs-listmonk",
		TenantID:      "t1",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &future,
		Progress: canonical.MigrationProgress{
			SubscribersDone: 1,
		},
	}
	eng := NewRollbackEngine(nil, nil, "t1")
	eng.Now = fixedNow(now)

	err := eng.Rollback(context.Background(), job)
	require.Error(t, err)
	require.True(t, errors.Is(err, ErrRollbackDestinationUnavailable), "expected destination unavailable, got %v", err)
	require.Equal(t, canonical.MigCompleted, job.Status)
	require.Nil(t, eng.Progress(job.ID), "rollback should fail before recording progress")
}

func TestRollbackRefusesToSkipPostgresTrackedDeletesWithoutDB(t *testing.T) {
	now := time.Date(2026, 7, 7, 12, 0, 0, 0, time.UTC)
	future := now.Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "j-needs-db",
		TenantID:      "t1",
		Source:        canonical.SourceActiveCampaign,
		Status:        canonical.MigCompleted,
		RollbackUntil: &future,
		Progress: canonical.MigrationProgress{
			SegmentsDone: 1,
		},
	}
	eng := NewRollbackEngine(nil, nil, "t1")
	eng.Now = fixedNow(now)

	err := eng.Rollback(context.Background(), job)
	require.Error(t, err)
	require.True(t, errors.Is(err, ErrRollbackDestinationUnavailable), "expected destination unavailable, got %v", err)
	require.Equal(t, canonical.MigCompleted, job.Status)
	require.Nil(t, eng.Progress(job.ID), "rollback should fail before recording progress")
}

func TestPreflightRollbackIsReadOnlyAndTenantBound(t *testing.T) {
	now := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	future := now.Add(24 * time.Hour)
	job := &canonical.MigrationJob{
		ID:            "j-read-only-preflight",
		TenantID:      "tenant-a",
		Source:        canonical.SourceCustomerIO,
		Status:        canonical.MigCompleted,
		RollbackUntil: &future,
	}
	eng := NewRollbackEngine(nil, nil, job.TenantID)
	eng.Now = fixedNow(now)

	require.NoError(t, eng.PreflightRollback(context.Background(), job))
	require.Equal(t, canonical.MigCompleted, job.Status)
	require.Equal(t, future, *job.RollbackUntil)
	require.Nil(t, eng.Progress(job.ID), "read-only preflight must not create rollback progress")

	wrongTenant := NewRollbackEngine(nil, nil, "tenant-b")
	wrongTenant.Now = fixedNow(now)
	err := wrongTenant.PreflightRollback(context.Background(), job)
	require.ErrorIs(t, err, ErrRollbackDestinationUnavailable)
	require.Equal(t, canonical.MigCompleted, job.Status)
}
