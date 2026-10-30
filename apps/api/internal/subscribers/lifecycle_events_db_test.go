// SPDX-License-Identifier: AGPL-3.0-only
//
// lifecycle_events_db_test.go — pg-backed proofs for SUB-118 (the PUBLIC
// merge endpoint fires subscriber.merged on the outbound-webhook catalog) and
// SUB-119 (the double-opt-in confirmation, unconfirmed → enabled, fires
// subscriber.confirmed on BOTH the outbound webhook and the SSE Bus). Skips
// cleanly without DATABASE_URL, matching the project-wide pg-backed test
// convention.

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// recordingDispatcher implements WebhookDispatcher and captures every event
// the repo fires. It ignores the tx (the assertion is "did the producer fire
// this event", not "did the delivery commit") and never errors so the merge /
// update business write proceeds normally.
type recordingDispatcher struct {
	fired []string
}

func (r *recordingDispatcher) Fire(_ context.Context, _ pgx.Tx, in WebhookFireInput) (int, error) {
	r.fired = append(r.fired, in.EventType)
	return 0, nil
}

func (r *recordingDispatcher) has(event string) bool {
	for _, e := range r.fired {
		if e == event {
			return true
		}
	}
	return false
}

func newLifecycleTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed lifecycle-events test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedLifecycleTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`,
		tenantID).Scan(&exists); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read tenants: %v", err)
	}
	if !exists {
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'lifecycle-test', 'lifecycle-test-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

func seedLifecycleSubscriber(t *testing.T, pool *pgxpool.Pool, tenantID, email, status string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, $3, 'api')
RETURNING id::text`, tenantID, email, status).Scan(&id); err != nil {
		t.Fatalf("seed subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber seed: %v", err)
	}
	return id
}

// TestPublicMerge_FiresMergedWebhook pins SUB-118: a successful PUBLIC
// Repo.Merge fires subscriber.merged on the outbound-webhook catalog (the same
// event the identify-driven merge already fired). Previously the public merge
// fired no webhook at all.
func TestPublicMerge_FiresMergedWebhook(t *testing.T) {
	pool := newLifecycleTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41210"
	seedLifecycleTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	primaryEmail := fmt.Sprintf("merge-primary-%d@example.test", suffix)
	dupeEmail := fmt.Sprintf("merge-dupe-%d@example.test", suffix)
	primaryID := seedLifecycleSubscriber(t, pool, tenantID, primaryEmail, "enabled")
	dupeID := seedLifecycleSubscriber(t, pool, tenantID, dupeEmail, "enabled")

	rec := &recordingDispatcher{}
	repo := &Repo{Pool: pool, Webhooks: rec}
	primary, err := repo.Get(context.Background(), tenantID, primaryID)
	if err != nil {
		t.Fatalf("load primary revision: %v", err)
	}
	duplicate, err := repo.Get(context.Background(), tenantID, dupeID)
	if err != nil {
		t.Fatalf("load duplicate revision: %v", err)
	}
	if _, err := repo.Merge(context.Background(), tenantID, MergeInput{
		PrimaryID: primaryID, DuplicateID: dupeID,
		PrimaryVersion: primary.Version, DuplicateVersion: duplicate.Version,
	}); err != nil {
		t.Fatalf("merge: %v", err)
	}
	if !rec.has(EventSubscriberMerged) {
		t.Fatalf("public merge did not fire %q; fired = %v", EventSubscriberMerged, rec.fired)
	}
}

// TestConfirm_FiresConfirmedOnUpdate pins SUB-119: a PATCH that flips a
// subscriber from unconfirmed → enabled fires subscriber.confirmed on the
// outbound webhook AND publishes it on the SSE Bus.
func TestConfirm_FiresConfirmedOnUpdate(t *testing.T) {
	pool := newLifecycleTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41211"
	seedLifecycleTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("confirm-update-%d@example.test", suffix)
	id := seedLifecycleSubscriber(t, pool, tenantID, email, StatusUnconfirmed)

	rec := &recordingDispatcher{}
	pub := &recordingPublisher{}
	repo := &Repo{Pool: pool, Webhooks: rec, Bus: pub}
	when := time.Now().UTC().Add(-time.Minute)
	source := ConsentDoubleOptIn
	if _, err := repo.Update(context.Background(), tenantID, id, UpdateInput{
		Status:               ptr(StatusEnabled),
		ConsentTimestamp:     &when,
		ConsentSource:        &source,
		ConsentChannel:       "email",
		ConsentLegalBasis:    "consent",
		ConsentJurisdiction:  "DE",
		ConsentEvidence:      "double-opt-in-confirmation:lifecycle-test",
		ConsentReason:        "confirmed exact address",
		ConsentPolicyVersion: "privacy-2026-07",
	}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if !rec.has(EventSubscriberConfirmed) {
		t.Fatalf("update did not fire confirmed webhook; fired = %v", rec.fired)
	}
	if !publisherHas(pub, EventSubscriberConfirmed) {
		t.Fatalf("update did not emit confirmed on Bus; events = %v", pub.events)
	}
}

// TestConfirm_SetStatusRejectsEvidenceFreeEnable pins the safety boundary:
// a status-only helper cannot fabricate the consent evidence needed to send.
func TestConfirm_SetStatusRejectsEvidenceFreeEnable(t *testing.T) {
	pool := newLifecycleTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41212"
	seedLifecycleTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("confirm-setstatus-%d@example.test", suffix)
	id := seedLifecycleSubscriber(t, pool, tenantID, email, StatusUnconfirmed)

	rec := &recordingDispatcher{}
	pub := &recordingPublisher{}
	repo := &Repo{Pool: pool, Webhooks: rec, Bus: pub}

	if _, err := repo.SetStatus(context.Background(), tenantID, id, StatusEnabled); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("setstatus error = %v, want ErrInvalidInput", err)
	}
	if rec.has(EventSubscriberConfirmed) {
		t.Fatalf("rejected setstatus fired confirmed webhook; fired = %v", rec.fired)
	}
	if publisherHas(pub, EventSubscriberConfirmed) {
		t.Fatalf("rejected setstatus emitted confirmed on Bus; events = %v", pub.events)
	}
}

// TestConfirm_NoConfirmedWithoutTransition pins the negative: a non-confirmation
// status change (enabled → blocklisted) must NOT fire subscriber.confirmed.
func TestConfirm_NoConfirmedWithoutTransition(t *testing.T) {
	pool := newLifecycleTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099a2c41213"
	seedLifecycleTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("confirm-none-%d@example.test", suffix)
	id := seedLifecycleSubscriber(t, pool, tenantID, email, StatusEnabled)

	rec := &recordingDispatcher{}
	repo := &Repo{Pool: pool, Webhooks: rec}
	if _, err := repo.SetStatus(context.Background(), tenantID, id, StatusBlocklisted); err != nil {
		t.Fatalf("setstatus: %v", err)
	}
	if rec.has(EventSubscriberConfirmed) {
		t.Fatalf("blocklist transition wrongly fired confirmed; fired = %v", rec.fired)
	}
}

func publisherHas(p *recordingPublisher, topic string) bool {
	for _, e := range p.events {
		if e.topic == topic {
			return true
		}
	}
	return false
}
