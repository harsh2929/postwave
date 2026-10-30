package jobstore

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/migrate/canonical"
)

func TestMemorySourceEventMonitorTracksContinuousSuccessfulCoverage(t *testing.T) {
	store := NewMemoryJobStore()
	startedAt := time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC)
	store.SetClock(func() time.Time { return startedAt })
	record := SourceEventMonitorRecord{
		JobID:           "job-continuous-overlap",
		TenantID:        "tenant_a",
		Source:          canonical.SourceActiveCampaign,
		Enabled:         true,
		IntervalSeconds: 300,
	}

	created, err := store.UpsertSourceEventMonitor(context.Background(), record)
	if err != nil {
		t.Fatal(err)
	}
	if created.EnabledSince == nil || !created.EnabledSince.Equal(startedAt) {
		t.Fatalf("enabled_since = %v, want %s", created.EnabledSince, startedAt)
	}
	originalCreatedAt := created.CreatedAt
	firstSync := startedAt.Add(time.Minute)
	if err := store.UpdateSourceEventMonitorAfterSync(context.Background(), record.TenantID, record.JobID, "cursor-1", nil, firstSync, firstSync.Add(5*time.Minute), 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	secondSync := firstSync.Add(7 * time.Minute)
	if err := store.UpdateSourceEventMonitorAfterSync(context.Background(), record.TenantID, record.JobID, "cursor-2", nil, secondSync, secondSync.Add(5*time.Minute), 0, 0, ""); err != nil {
		t.Fatal(err)
	}

	stillEnabledAt := startedAt.Add(24 * time.Hour)
	store.SetClock(func() time.Time { return stillEnabledAt })
	unchanged, err := store.UpsertSourceEventMonitor(context.Background(), record)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.EnabledSince == nil || !unchanged.EnabledSince.Equal(startedAt) ||
		unchanged.FirstSyncedAt == nil || !unchanged.FirstSyncedAt.Equal(firstSync) ||
		unchanged.SuccessfulSyncs != 2 || unchanged.MaxSyncGapSecs != 420 {
		t.Fatalf("preserved coverage = %+v", unchanged)
	}

	intervalChangedAt := startedAt.Add(36 * time.Hour)
	store.SetClock(func() time.Time { return intervalChangedAt })
	changed := record
	changed.IntervalSeconds = 600
	reset, err := store.UpsertSourceEventMonitor(context.Background(), changed)
	if err != nil {
		t.Fatal(err)
	}
	if reset.EnabledSince == nil || !reset.EnabledSince.Equal(intervalChangedAt) || reset.FirstSyncedAt != nil || reset.SuccessfulSyncs != 0 || reset.MaxSyncGapSecs != 0 || reset.LastSyncedAt != nil {
		t.Fatalf("interval-change reset = %+v", reset)
	}
	failedSync := intervalChangedAt.Add(time.Minute)
	if err := store.UpdateSourceEventMonitorAfterSync(context.Background(), record.TenantID, record.JobID, "cursor-failed", nil, failedSync, failedSync.Add(10*time.Minute), 0, 0, "provider unavailable"); err != nil {
		t.Fatal(err)
	}
	afterFailure, err := store.GetSourceEventMonitor(context.Background(), record.TenantID, record.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if afterFailure.SuccessfulSyncs != 0 || afterFailure.FirstSyncedAt != nil || afterFailure.LastSyncedAt != nil {
		t.Fatalf("failed sync manufactured coverage = %+v", afterFailure)
	}

	if err := store.DisableSourceEventMonitor(context.Background(), record.TenantID, record.JobID); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateSourceEventMonitorAfterSync(context.Background(), record.TenantID, record.JobID, "late", nil, failedSync, failedSync, 0, 0, ""); err != ErrNotFound {
		t.Fatalf("in-flight disabled update error = %v, want ErrNotFound", err)
	}
	reenabledAt := startedAt.Add(48 * time.Hour)
	store.SetClock(func() time.Time { return reenabledAt })
	reenabled, err := store.UpsertSourceEventMonitor(context.Background(), changed)
	if err != nil {
		t.Fatal(err)
	}
	if reenabled.EnabledSince == nil || !reenabled.EnabledSince.Equal(reenabledAt) || reenabled.FirstSyncedAt != nil || reenabled.SuccessfulSyncs != 0 || reenabled.MaxSyncGapSecs != 0 {
		t.Fatalf("re-enabled coverage = %+v, want reset at %s", reenabled, reenabledAt)
	}
	if !reenabled.CreatedAt.Equal(originalCreatedAt) {
		t.Fatalf("record created_at = %s, want immutable %s", reenabled.CreatedAt, originalCreatedAt)
	}
}
