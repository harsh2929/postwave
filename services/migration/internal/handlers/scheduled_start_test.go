// SPDX-License-Identifier: AGPL-3.0-only

package handlers

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
)

func cursorPtr(s string) *string { return &s }

// TestScheduledStartPausedUntil covers the READ side (MIGR-038): unset/blank/
// garbage are fail-open (not deferred); the boundary is strict-After(now) so the
// exact scheduled instant runs.
func TestScheduledStartPausedUntil(t *testing.T) {
	now := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
	cases := []struct {
		name    string
		cursor  map[string]*string
		wantDef bool
	}{
		{"nil cursor", nil, false},
		{"absent", map[string]*string{}, false},
		{"blank", map[string]*string{scheduledStartAtCursorKey: cursorPtr("  ")}, false},
		{"garbage", map[string]*string{scheduledStartAtCursorKey: cursorPtr("not-a-time")}, false},
		{"past", map[string]*string{scheduledStartAtCursorKey: cursorPtr(now.Add(-time.Minute).Format(time.RFC3339Nano))}, false},
		{"exact now", map[string]*string{scheduledStartAtCursorKey: cursorPtr(now.Format(time.RFC3339Nano))}, false},
		{"future", map[string]*string{scheduledStartAtCursorKey: cursorPtr(now.Add(time.Hour).Format(time.RFC3339Nano))}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, deferred := scheduledStartPausedUntil(&canonical.MigrationJob{Cursor: tc.cursor}, now)
			if deferred != tc.wantDef {
				t.Fatalf("deferred = %v, want %v", deferred, tc.wantDef)
			}
		})
	}
	if _, deferred := scheduledStartPausedUntil(nil, now); deferred {
		t.Fatal("nil job must not be deferred")
	}
}

// TestApplyScheduledStart covers the WRITE side (MIGR-038): empty/past = run now
// (no cursor); garbage = error; future = cursor stamped as RFC3339Nano UTC.
func TestApplyScheduledStart(t *testing.T) {
	t.Run("empty runs immediately", func(t *testing.T) {
		job := &canonical.MigrationJob{}
		scheduled, err := applyScheduledStart(job, "")
		if err != nil || scheduled {
			t.Fatalf("(%v,%v), want (false,nil)", scheduled, err)
		}
		if _, ok := job.Cursor[scheduledStartAtCursorKey]; ok {
			t.Fatal("empty must not stamp a cursor")
		}
	})
	t.Run("past runs immediately", func(t *testing.T) {
		job := &canonical.MigrationJob{}
		scheduled, err := applyScheduledStart(job, time.Now().Add(-time.Hour).Format(time.RFC3339))
		if err != nil || scheduled {
			t.Fatalf("(%v,%v), want (false,nil)", scheduled, err)
		}
		if _, ok := job.Cursor[scheduledStartAtCursorKey]; ok {
			t.Fatal("past must not stamp a cursor")
		}
	})
	t.Run("garbage errors", func(t *testing.T) {
		if _, err := applyScheduledStart(&canonical.MigrationJob{}, "tomorrow"); err == nil {
			t.Fatal("unparseable scheduled_for must error")
		}
	})
	t.Run("future stamps UTC cursor", func(t *testing.T) {
		job := &canonical.MigrationJob{}
		startAt := time.Now().Add(2 * time.Hour)
		scheduled, err := applyScheduledStart(job, startAt.Format(time.RFC3339))
		if err != nil || !scheduled {
			t.Fatalf("(%v,%v), want (true,nil)", scheduled, err)
		}
		raw, ok := cursorString(job.Cursor, scheduledStartAtCursorKey)
		if !ok {
			t.Fatalf("cursor not stamped: %#v", job.Cursor)
		}
		parsed, perr := time.Parse(time.RFC3339Nano, raw)
		if perr != nil {
			t.Fatalf("stamped value not RFC3339Nano: %v", perr)
		}
		if !strings.HasSuffix(raw, "Z") {
			t.Fatalf("stamped value not UTC (missing Z): %s", raw)
		}
		// The setter parses RFC3339 (no sub-second), so compare to the second.
		if parsed.Unix() != startAt.Unix() {
			t.Fatalf("stamped %s, want ~%s (to the second)", parsed, startAt)
		}
	})
}

// TestRecoverRunnableJobsDefersScheduledStart proves the recovery worker HOLDS a
// future-scheduled job (leased path, memory store) without running it, leaving
// the schedule intact.
func TestRecoverRunnableJobsDefersScheduledStart(t *testing.T) {
	registerRateLimitProbeAdapter()
	store := jobstore.NewMemoryJobStore()
	startAt := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	job := &canonical.MigrationJob{
		ID:        "5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c",
		TenantID:  "tenant_a",
		Source:    rateLimitProbeSource,
		Status:    canonical.MigDryRun,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{scheduledStartAtCursorKey: &startAt},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "sched-token", AccountID: "sched-account", Source: rateLimitProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	recovered, err := h.RecoverRunnableJobs(context.Background())
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if recovered != 0 {
		t.Fatalf("recovered = %d, want 0 while scheduled_start is future", recovered)
	}
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Error != nil {
		t.Fatalf("error = %#v, want adapter not invoked while deferred", stored.Error)
	}
	if _, ok := cursorString(stored.Cursor, scheduledStartAtCursorKey); !ok {
		t.Fatalf("schedule cursor must survive the hold: %#v", stored.Cursor)
	}
}

// TestRunJobEntryGateDefersScheduledStart proves the runJob entry gate holds a
// future-scheduled job, keeps it runnable, keeps the schedule, and emits an
// operator-visible progress step (never job.Error).
func TestRunJobEntryGateDefersScheduledStart(t *testing.T) {
	registerRateLimitProbeAdapter()
	store := jobstore.NewMemoryJobStore()
	startAt := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	job := &canonical.MigrationJob{
		ID:        "6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d",
		TenantID:  "tenant_a",
		Source:    rateLimitProbeSource,
		Status:    canonical.MigDryRun,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{scheduledStartAtCursorKey: &startAt},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "sched-token", AccountID: "sched-account", Source: rateLimitProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	events, unsubscribe := h.broadcaster.Subscribe(job.ID)
	defer unsubscribe()
	h.runJob(context.Background(), job.TenantID, job.ID)

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if stored.Status != canonical.MigDryRun {
		t.Fatalf("status = %q, want job to remain runnable", stored.Status)
	}
	if stored.Error != nil {
		t.Fatalf("error = %#v, want scheduling not to touch the failure channel", stored.Error)
	}
	if _, ok := cursorString(stored.Cursor, scheduledStartAtCursorKey); !ok {
		t.Fatalf("schedule cursor must survive the hold: %#v", stored.Cursor)
	}
	sawScheduled := false
	for draining := true; draining; {
		select {
		case ev := <-events:
			if ev.Resource == "all" && ev.CurrentStep != "" &&
				len(ev.CurrentStep) >= len("Migration scheduled") &&
				ev.CurrentStep[:len("Migration scheduled")] == "Migration scheduled" {
				sawScheduled = true
			}
		default:
			draining = false
		}
	}
	if !sawScheduled {
		t.Fatal("entry gate did not publish a 'Migration scheduled to start' progress step")
	}
}

// TestResumeJobClearsInheritedSchedule proves the review-found bug is fixed: a
// job cancelled before its future scheduled start, then resumed, must run NOW
// (schedule scrubbed) rather than silently re-deferring to the original instant.
func TestResumeJobClearsInheritedSchedule(t *testing.T) {
	registerRateLimitProbeAdapter()
	store := jobstore.NewMemoryJobStore()
	msg := cancelledByOperatorMsg
	mode := runModeImporting
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	job := &canonical.MigrationJob{
		ID:        "9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f",
		TenantID:  "tenant_a",
		Source:    rateLimitProbeSource,
		Status:    canonical.MigFailed,
		Error:     &msg,
		StartedAt: time.Now(),
		Cursor: map[string]*string{
			runModeCursorKey:          &mode,
			scheduledStartAtCursorKey: &future,
		},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "resume-token", AccountID: "resume-account", Source: rateLimitProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	r := chi.NewRouter()
	h.Mount(r)
	rec := postResume(t, r, job.ID)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("resume = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}

	// The resume must have scrubbed the inherited schedule (persisted before the
	// 202), so the deferral gate never re-holds the job.
	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if _, ok := cursorString(stored.Cursor, scheduledStartAtCursorKey); ok {
		t.Fatalf("resume left a stale schedule cursor: %#v", stored.Cursor)
	}
}

// TestRunJobClearsScheduledStartWhenRunBegins proves the schedule is dropped
// exactly when the run begins: a PAST schedule passes the gate, the run proceeds
// (hits the rate-limit probe), and the scheduled_start cursor is gone while the
// rate-limit pause cursor is now set.
func TestRunJobClearsScheduledStartWhenRunBegins(t *testing.T) {
	registerRateLimitProbeAdapter()
	store := jobstore.NewMemoryJobStore()
	past := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	job := &canonical.MigrationJob{
		ID:        "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e",
		TenantID:  "tenant_a",
		Source:    rateLimitProbeSource,
		Status:    canonical.MigDryRun,
		StartedAt: time.Now(),
		Cursor:    map[string]*string{scheduledStartAtCursorKey: &past},
	}
	if err := store.Create(context.Background(), job); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := store.SaveSession(context.Background(), job.ID, job.TenantID, adapter.Session{
		AccessToken: "sched-token", AccountID: "sched-account", Source: rateLimitProbeSource,
	}, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("save session: %v", err)
	}

	h := NewMigration("", store)
	h.runJob(context.Background(), job.TenantID, job.ID)

	stored, err := store.Get(jobstore.WithTenantID(context.Background(), job.TenantID), job.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if _, ok := cursorString(stored.Cursor, scheduledStartAtCursorKey); ok {
		t.Fatalf("schedule cursor must be cleared once the run begins: %#v", stored.Cursor)
	}
	if _, ok := cursorString(stored.Cursor, rateLimitRetryAtCursorKey); !ok {
		t.Fatalf("run should have proceeded past the gate to the rate-limit pause: %#v", stored.Cursor)
	}
}
