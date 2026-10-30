// SPDX-License-Identifier: AGPL-3.0-only

package webhooks

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// spyClassifier records that it was invoked, in the caller's transaction.
//
// A spy rather than the real runtime because what is being tested is the CALL,
// not the classification: the defect was that this path never invoked a
// classifier at all, so events arriving on seven ESP webhooks were invisible to
// reclassification. A source-level grep cannot tell a live call from one behind
// a short-circuit — it only catches a DELETED call site — which is why this
// exists alongside it.
type spyClassifier struct {
	calls       int
	lastRef     engagementclassification.EventRef
	lastKey     string
	workerScope string
	scopeErr    error
}

func (s *spyClassifier) RecordProviderEvent(
	ctx context.Context, tx pgx.Tx, _ string,
	in engagementclassification.ProviderEventInput,
) error {
	s.calls++
	s.lastRef = in.EventRef
	s.lastKey = in.IdempotencyKey
	s.scopeErr = tx.QueryRow(
		ctx, `SELECT current_setting('app.outbox_worker', true)`,
	).Scan(&s.workerScope)
	return nil
}

func webhookDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping ESP observation test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedWebhookTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'esp-observation-test', $2, 'studio')`,
		tenantID, "espobs-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		admin, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		_, _ = admin.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
		_ = admin.Commit(context.Background())
	})
	return tenantID
}

// An ESP-webhook event records an observation, on both insert branches.
//
// Two sub-cases because the code has two: one with a provider dedup key (which
// claims and binds) and one without. The second branch used Exec and discarded
// the RETURNING, so it was structurally unable to record an observation keyed to
// the event id — the branch, not the feature, was the gap.
func TestAnESPWebhookEventRecordsAnObservation(t *testing.T) {
	pool := webhookDB(t)
	ctx := context.Background()

	for _, tc := range []struct {
		name       string
		providerID string
	}{
		{"with a provider dedup id", "prov-" + uuid.NewString()[:8]},
		{"without a provider dedup id", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tenantID := seedWebhookTenant(t, pool)
			spy := &spyClassifier{}
			deps := &DeliverabilityDeps{Pool: pool, EngagementClassifier: spy}

			err := deps.appendEvent(ctx, tenantID, classifyOutcome{
				Email:        "reader@example.test",
				EventType:    "opened",
				ProviderName: suppressions.SourcePostmark,
				ProviderID:   tc.providerID,
				MessageID:    "<msg-" + uuid.NewString()[:8] + "@example.test>",
			}, time.Now().UTC())
			if err != nil {
				t.Fatalf("appendEvent: %v", err)
			}

			if spy.calls != 1 {
				t.Fatalf("classifier invoked %d times, want 1 — events on this path "+
					"are invisible to reclassification and a rebuild would silently "+
					"produce a partial corpus", spy.calls)
			}
			if spy.lastRef.ID == 0 {
				t.Error("the observation carries no canonical event id, so it cannot " +
					"be joined back to the event it describes")
			}
			if spy.lastKey == "" {
				t.Error("no idempotency key: a redelivered webhook would record the " +
					"observation twice")
			}
			if spy.scopeErr != nil || spy.workerScope != "true" {
				t.Fatalf("classifier transaction worker scope=%q err=%v; a real runtime would reject this call",
					spy.workerScope, spy.scopeErr)
			}
		})
	}
}

// A nil classifier is the disabled rollout, not an error.
func TestANilClassifierLeavesTheESPPathWorking(t *testing.T) {
	pool := webhookDB(t)
	ctx := context.Background()
	tenantID := seedWebhookTenant(t, pool)

	deps := &DeliverabilityDeps{Pool: pool} // EngagementClassifier deliberately nil
	if err := deps.appendEvent(ctx, tenantID, classifyOutcome{
		Email: "reader@example.test", EventType: "clicked",
		ProviderName: suppressions.SourcePostmark,
	}, time.Now().UTC()); err != nil {
		t.Fatalf("a disabled classifier broke event ingest: %v — this is the "+
			"typed-nil failure in its behavioural form", err)
	}
}
