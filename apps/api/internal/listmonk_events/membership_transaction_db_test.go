// SPDX-License-Identifier: AGPL-3.0-only
package listmonk_events

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type fixedMembershipResolver struct {
	listID string
}

func (r fixedMembershipResolver) GetListUUIDByBigintID(
	context.Context,
	string,
	int64,
) (string, error) {
	return r.listID, nil
}

type membershipFanoutRecorder struct {
	events []TransactionalWebhookEvent
	err    error
}

func (r *membershipFanoutRecorder) fire(
	_ context.Context,
	_ pgx.Tx,
	event TransactionalWebhookEvent,
) (int, error) {
	r.events = append(r.events, event)
	return 1, r.err
}

func newMembershipTransactionTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set")
	}
	pool, err := db.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedMembershipTransactionSubject(
	t *testing.T,
	pool *db.Pool,
) (tenantID, subscriberID, email string) {
	t.Helper()
	tenantID = uuid.NewString()
	email = "listmonk-membership-" + uuid.NewString() + "@example.test"
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open seed tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'listmonk membership test', 'lm-membership-' || $1::text, 'studio')`,
		tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (
    tenant_id, email, primary_email, status, mailchimp_status,
    consent_source, custom_fields, tags, merge_fields, groups,
    gdpr_permissions
)
VALUES (
    $1::uuid, $2, $2, 'unconfirmed', 'non_subscribed',
    'unknown', '{}'::jsonb, ARRAY[]::text[], '{}'::jsonb,
    '[]'::jsonb, '[]'::jsonb
)
RETURNING id::text`, tenantID, email).Scan(&subscriberID); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		subscriberCleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("open subscriber cleanup: %v", cleanupErr)
			return
		}
		defer func() { _ = subscriberCleanup.Rollback(cleanupCtx) }()
		// Subscriber deletion advances the exact-address generation ledger.
		// Commit that trigger work while the tenant FK still exists; remove
		// the tenant and all remaining tenant-owned rows in a second tx.
		if _, cleanupErr := subscriberCleanup.Exec(cleanupCtx,
			`DELETE FROM subscribers WHERE tenant_id = $1::uuid`, tenantID); cleanupErr != nil {
			t.Errorf("cleanup subscribers: %v", cleanupErr)
			return
		}
		if cleanupErr := subscriberCleanup.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("commit subscriber cleanup: %v", cleanupErr)
			return
		}

		tenantCleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("open tenant cleanup: %v", cleanupErr)
			return
		}
		defer func() { _ = tenantCleanup.Rollback(cleanupCtx) }()
		if _, cleanupErr := tenantCleanup.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id = $1::uuid`, tenantID); cleanupErr != nil {
			t.Errorf("cleanup tenant: %v", cleanupErr)
			return
		}
		if cleanupErr := tenantCleanup.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("commit tenant cleanup: %v", cleanupErr)
		}
	})
	return tenantID, subscriberID, email
}

func TestPopulateListMembershipOwnsTransactionalAddedLifecycle(t *testing.T) {
	pool := newMembershipTransactionTestPool(t)
	tenantID, subscriberID, email := seedMembershipTransactionSubject(t, pool)
	listID := uuid.NewString()
	at := time.Date(2026, 7, 23, 9, 10, 11, 123000000, time.UTC)
	event := &MembershipEvent{
		Type:          WireSubscriberAdded,
		TenantID:      tenantID,
		At:            at,
		SourceEventID: "provider-event-1",
	}
	event.Subscriber.Email = email
	event.List.ID = 42
	recorder := &membershipFanoutRecorder{}

	changed, err := PopulateListMembership(
		context.Background(), pool, fixedMembershipResolver{listID: listID},
		event, recorder.fire,
	)
	if err != nil || !changed {
		t.Fatalf("populate = (%v, %v), want true, nil", changed, err)
	}
	if len(recorder.events) != 1 {
		t.Fatalf("webhook intents = %d, want 1", len(recorder.events))
	}
	got := recorder.events[0]
	if got.EventType != "list.subscriber.added" ||
		got.Body["subscriber_id"] != subscriberID ||
		got.Body["list_id"] != listID ||
		!got.OccurredAt.Equal(at) ||
		!strings.Contains(got.SourceEventID, at.Format(time.RFC3339Nano)) {
		t.Fatalf("unexpected transactional event: %+v", got)
	}

	changed, err = PopulateListMembership(
		context.Background(), pool, fixedMembershipResolver{listID: listID},
		event, recorder.fire,
	)
	if err != nil || changed || len(recorder.events) != 1 {
		t.Fatalf("provider replay = (%v, %v), intents=%d; want false, nil, 1",
			changed, err, len(recorder.events))
	}

	removed := *event
	removed.Type = WireSubscriberRemoved
	removed.At = at.Add(time.Minute)
	if changed, err := PopulateListMembership(
		context.Background(), pool, fixedMembershipResolver{listID: listID},
		&removed, recorder.fire,
	); err != nil || !changed {
		t.Fatalf("remove = (%v, %v), want true, nil", changed, err)
	}
	revived := *event
	revived.At = at.Add(2 * time.Minute)
	revived.SourceEventID = "provider-event-2"
	if changed, err := PopulateListMembership(
		context.Background(), pool, fixedMembershipResolver{listID: listID},
		&revived, recorder.fire,
	); err != nil || !changed {
		t.Fatalf("revive = (%v, %v), want true, nil", changed, err)
	}
	if len(recorder.events) != 2 ||
		recorder.events[0].SourceEventID == recorder.events[1].SourceEventID {
		t.Fatalf("revival intents = %+v", recorder.events)
	}
}

func TestPopulateListMembershipRollsBackOnFanoutFailure(t *testing.T) {
	pool := newMembershipTransactionTestPool(t)
	tenantID, subscriberID, email := seedMembershipTransactionSubject(t, pool)
	listID := uuid.NewString()
	event := &MembershipEvent{
		Type:     WireSubscriberAdded,
		TenantID: tenantID,
		At:       time.Now().UTC(),
	}
	event.Subscriber.Email = email
	event.List.ID = 42
	sentinel := errors.New("injected list fanout failure")
	recorder := &membershipFanoutRecorder{err: sentinel}

	if _, err := PopulateListMembership(
		context.Background(), pool, fixedMembershipResolver{listID: listID},
		event, recorder.fire,
	); !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want wrapped %v", err, sentinel)
	}
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("open verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var count int
	if err := tx.QueryRow(context.Background(), `
SELECT count(*)
  FROM list_subscribers
 WHERE tenant_id = $1::uuid
   AND list_id = $2::uuid
   AND subscriber_id = $3::uuid`,
		tenantID, listID, subscriberID).Scan(&count); err != nil {
		t.Fatalf("count membership: %v", err)
	}
	if count != 0 {
		t.Fatalf("membership committed after fanout failure: %d", count)
	}
}
