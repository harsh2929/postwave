// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
)

// spyEngagementClassifier records that it was called.
//
// Behavioural, because a source grep for the call cannot tell a live call from one
// behind a short-circuit — established four times over in this project.
type spyEngagementClassifier struct {
	calls       int
	lastRef     engagementclassification.EventRef
	workerScope string
	scopeErr    error
}

func (s *spyEngagementClassifier) RecordProviderEvent(
	ctx context.Context, tx pgx.Tx, _ string,
	in engagementclassification.ProviderEventInput,
) error {
	s.calls++
	s.lastRef = in.EventRef
	s.scopeErr = tx.QueryRow(
		ctx, `SELECT current_setting('app.outbox_worker', true)`,
	).Scan(&s.workerScope)
	return nil
}

// An event recorded through RecordSubscriberEvent writes an observation.
//
// This is the path internal/publictrack delegates to, so before this every event a
// customer sent through the PUBLIC track endpoint was invisible to
// reclassification — the corpus covered the Listmonk path and the seven provider
// webhooks and silently omitted the one a customer controls directly.
func TestRecordSubscriberEventWritesAnObservation(t *testing.T) {
	pool := newObservationTestPool(t)
	ctx := context.Background()
	tenantID, subscriberID := seedObservationSubscriber(t, pool)

	spy := &spyEngagementClassifier{}
	repo := &Repo{Pool: pool, EngagementClassifier: spy}

	occurred := time.Now().UTC()
	if _, err := repo.RecordSubscriberEvent(ctx, tenantID, subscriberID, SubscriberEventInput{
		EventType: "opened", Source: "public-track",
		SourceEventID: "pt-" + occurred.Format("150405.000000000"),
		OccurredAt:    &occurred,
	}); err != nil {
		t.Fatalf("RecordSubscriberEvent: %v", err)
	}

	if spy.calls != 1 {
		t.Fatalf("classifier invoked %d times, want 1 — events on the public track "+
			"path stay invisible to reclassification and a rebuild produces a "+
			"partial corpus", spy.calls)
	}
	if spy.lastRef.ID == 0 {
		t.Error("the observation carries no canonical event id, so it cannot be " +
			"joined back to the event it describes")
	}
	if spy.scopeErr != nil || spy.workerScope != "true" {
		t.Fatalf("classifier transaction worker scope=%q err=%v; a real runtime would reject this call",
			spy.workerScope, spy.scopeErr)
	}
}

// A deduplicated event does NOT write a second observation.
//
// The observation for the original already exists; recording another would
// double-count the evidence a classification is derived from.
func TestADeduplicatedEventDoesNotWriteASecondObservation(t *testing.T) {
	pool := newObservationTestPool(t)
	ctx := context.Background()
	tenantID, subscriberID := seedObservationSubscriber(t, pool)

	spy := &spyEngagementClassifier{}
	repo := &Repo{Pool: pool, EngagementClassifier: spy}

	occurred := time.Now().UTC()
	input := SubscriberEventInput{
		EventType: "clicked", Source: "public-track",
		SourceEventID: "pt-dedup-" + occurred.Format("150405.000000000"),
		OccurredAt:    &occurred,
	}
	for i := 0; i < 3; i++ {
		if _, err := repo.RecordSubscriberEvent(ctx, tenantID, subscriberID, input); err != nil {
			t.Fatalf("record %d: %v", i, err)
		}
	}
	if spy.calls != 1 {
		t.Fatalf("classifier invoked %d times for one deduplicated event; the "+
			"evidence behind a classification is being double-counted", spy.calls)
	}
}

// A nil classifier is the disabled rollout, not an error.
func TestANilClassifierLeavesSubscriberEventIngestWorking(t *testing.T) {
	pool := newObservationTestPool(t)
	ctx := context.Background()
	tenantID, subscriberID := seedObservationSubscriber(t, pool)

	repo := &Repo{Pool: pool} // EngagementClassifier deliberately nil
	occurred := time.Now().UTC()
	if _, err := repo.RecordSubscriberEvent(ctx, tenantID, subscriberID, SubscriberEventInput{
		EventType: "opened", Source: "public-track",
		SourceEventID: "pt-nil-" + occurred.Format("150405.000000000"),
		OccurredAt:    &occurred,
	}); err != nil {
		t.Fatalf("a disabled classifier broke event ingest: %v — the typed-nil "+
			"failure in its behavioural form", err)
	}
}

func newObservationTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping observation tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedObservationSubscriber creates a throwaway tenant and subscriber.
func seedObservationSubscriber(t *testing.T, pool *db.Pool) (tenantID, subscriberID string) {
	t.Helper()
	ctx := context.Background()
	tenantID = uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'observation-test', $2, 'studio')`,
		tenantID, "obs-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api') RETURNING id::text`,
		tenantID, "obs-"+tenantID[:8]+"@example.test").Scan(&subscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
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
	return tenantID, subscriberID
}
