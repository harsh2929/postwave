// SPDX-License-Identifier: AGPL-3.0-only
//
// snapshot_worker_test.go — guard tests for the SUB-124 audience growth
// snapshot worker. The tenant enumeration + per-tenant upsert require a
// live DB (covered by integration suites); db.Pool is a concrete type and
// cannot be stubbed, so here we assert the nil-deps guard so a
// misconfigured worker fails loudly rather than panicking, and that a
// cancelled context returns the guard error without hanging.

package subscribers

import (
	"context"
	"testing"
)

func TestGrowthSnapshotWorkerNilDeps(t *testing.T) {
	cases := []struct {
		name string
		w    *GrowthSnapshotWorker
	}{
		{"nil worker", nil},
		{"nil pool", &GrowthSnapshotWorker{Repo: &Repo{}}},
		{"nil repo", &GrowthSnapshotWorker{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.w.Run(context.Background())
			if err == nil {
				t.Fatal("Run with nil deps must return an error, not panic")
			}
		})
	}
}

func TestGrowthSnapshotWorkerCancelledContext(t *testing.T) {
	// With nil deps the guard returns promptly; this asserts Run does not
	// hang on an already-cancelled context (db.Pool is concrete and cannot
	// be stubbed, so we exercise the guard path).
	w := &GrowthSnapshotWorker{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := w.Run(ctx); err == nil {
		t.Fatal("expected the nil-deps guard error")
	}
}
