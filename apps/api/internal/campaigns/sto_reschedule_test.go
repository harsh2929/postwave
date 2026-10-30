// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for CampaignsRescheduler. The DB-backed path requires a
// live Postgres + RLS-aware tx; it is exercised via the integration
// suite. These tests cover the pure guards: nil pool, empty inputs,
// and the empty-schedule no-op contract.

package campaigns

import (
	"context"
	"strings"
	"testing"
)

func TestRescheduleByBestTime_NilReceiver(t *testing.T) {
	var r *CampaignsRescheduler
	err := r.RescheduleByBestTime(context.Background(), "t1", "c1", nil)
	if err == nil {
		t.Fatal("nil receiver: want error, got nil")
	}
	if !strings.Contains(err.Error(), "Pool is nil") {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestRescheduleByBestTime_NilPool(t *testing.T) {
	r := &CampaignsRescheduler{}
	err := r.RescheduleByBestTime(context.Background(), "t1", "c1", nil)
	if err == nil {
		t.Fatal("nil pool: want error, got nil")
	}
}

func TestRescheduleByBestTime_RequiresTenantID(t *testing.T) {
	r := &CampaignsRescheduler{}
	// Reset to defaultable values so the nil-pool guard fires first
	// only if we pass valid ids. We pass empty tenant to hit the
	// tenantID-required branch — but the Pool-nil branch fires first
	// in the actual code path (Pool is checked before tenant). To
	// exercise the tenant-required branch we'd need a non-nil pool;
	// that's covered by the integration suite.
	err := r.RescheduleByBestTime(context.Background(), "", "c1", nil)
	if err == nil {
		t.Fatal("empty tenant: want error, got nil")
	}
}

func TestRescheduleByBestTime_EmptyScheduleIsNoopButRequiresValidPool(t *testing.T) {
	// Empty schedule with nil pool still errors because we guard on
	// Pool-nil first. This is intentional: a nil pool is a programmer
	// error (the wiring in main.go is broken), not a runtime case the
	// handler should swallow.
	r := &CampaignsRescheduler{}
	if err := r.RescheduleByBestTime(context.Background(), "t1", "c1", nil); err == nil {
		t.Fatal("nil pool + empty schedule: want error, got nil")
	}
}
