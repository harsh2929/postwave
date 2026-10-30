// SPDX-License-Identifier: AGPL-3.0-only
//
// replay_test.go — pure-function tests for the replay job lifecycle.
// DB-touching paths live in replay_db_test.go (skipped when POSTWAVE_TEST_DB
// is unset). These are the always-on guards.

package auditsink

import (
	"context"
	"strings"
	"testing"
)

func TestCreateReplayJob_ValidatesRange(t *testing.T) {
	// Nil pool — Create exits before touching the DB so all validation
	// paths return without hitting Postgres.
	m := &ReplayJobManager{Pool: nil}
	cases := []struct {
		name    string
		fromID  int64
		toID    int64
		wantErr string
	}{
		{
			name:    "from > to",
			fromID:  100,
			toID:    50,
			wantErr: "from_id must be <= to_id",
		},
		{
			name:    "negative from",
			fromID:  -1,
			toID:    10,
			wantErr: "must be non-negative",
		},
		{
			name:    "negative to",
			fromID:  0,
			toID:    -5,
			wantErr: "must be non-negative",
		},
		{
			name:    "range too large",
			fromID:  0,
			toID:    MaxReplayRowsPerJob + 1,
			wantErr: "range exceeds",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := m.CreateReplayJob(context.Background(), "tenant", "sink", tc.fromID, tc.toID, "test")
			if err == nil {
				t.Fatalf("expected error matching %q, got nil", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("expected error containing %q, got %q", tc.wantErr, err.Error())
			}
		})
	}
}

func TestCreateReplayJob_RequiresPool(t *testing.T) {
	m := &ReplayJobManager{Pool: nil}
	_, err := m.CreateReplayJob(context.Background(), "tenant", "sink", 0, 100, "")
	if err == nil {
		t.Fatal("expected error when pool is nil")
	}
	if !strings.Contains(err.Error(), "pool required") {
		t.Errorf("expected 'pool required' error, got %q", err.Error())
	}
}

func TestReplayStatusConstants(t *testing.T) {
	// Lock the constants to their string values so any rename also
	// updates the SQL migration / Postgres CHECK constraint.
	want := map[string]string{
		"pending":     ReplayStatusPending,
		"in_progress": ReplayStatusInProgress,
		"completed":   ReplayStatusCompleted,
		"failed":      ReplayStatusFailed,
		"cancelled":   ReplayStatusCancelled,
	}
	for k, v := range want {
		if k != v {
			t.Errorf("status constant drift: want %q, got %q", k, v)
		}
	}
}

func TestMaxReplayRowsPerJob_MatchesExportLimit(t *testing.T) {
	// Sanity: replay range cap should match export limit so an operator
	// who downloaded an export bundle can always re-queue it in a single
	// replay job. If you bump one, bump the other.
	if MaxReplayRowsPerJob != 100_000 {
		t.Errorf("MaxReplayRowsPerJob = %d, expected 100000 (matches handlers.MaxExportRows)",
			MaxReplayRowsPerJob)
	}
}
