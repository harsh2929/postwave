// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk_delete_consent_db_test.go — deleting a subscriber that owns consent
// evidence (migration 2053).
//
// consent_records.subscriber_id is ON DELETE SET NULL, so every subscriber
// delete issues an UPDATE on the subscriber's consent records. Migration 1766's
// chronology trigger resolved consent_events-only columns while checking that
// UPDATE and raised 42703, which turned POST /subscribers/bulk/delete into a 500
// for every contact that had ever been given consent. These tests drive the
// real delete paths as the RLS-bound application role and prove the evidence
// row survives, detached and otherwise byte-for-byte unchanged, while the
// immutability contract still rejects every other change.

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// seedSubscriberConsentRecord appends one consent ledger row owned by the
// subscriber, exactly as an application writer does: as postwave_app, inside
// the tenant's RLS scope. It returns the record id and a snapshot of every
// evidence column.
func seedSubscriberConsentRecord(t *testing.T, pool *pgxpool.Pool, tenantID, subscriberID, email string) (string, string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("consent record tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var recordID string
	if err := tx.QueryRow(ctx, `
INSERT INTO consent_records (
    tenant_id, subscriber_id, email, channel, consent_status, source, evidence
) VALUES (
    $1::uuid, $2::uuid, $3, 'email', 'withdrawn', 'admin',
    jsonb_build_object('reason', 'operator recorded a withdrawal')
)
RETURNING id::text`, tenantID, subscriberID, email).Scan(&recordID); err != nil {
		t.Fatalf("seed consent record: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit consent record: %v", err)
	}
	return recordID, consentRecordEvidence(t, pool, tenantID, recordID)
}

// consentRecordEvidence snapshots every column the immutability contract
// protects — everything except the owner link the delete is allowed to clear.
func consentRecordEvidence(t *testing.T, pool *pgxpool.Pool, tenantID, recordID string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("consent evidence tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var snapshot string
	if err := tx.QueryRow(ctx, `
SELECT (to_jsonb(r) - 'subscriber_id')::text
  FROM consent_records r
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, recordID).Scan(&snapshot); err != nil {
		t.Fatalf("read consent evidence: %v", err)
	}
	return snapshot
}

func consentRecordOwner(t *testing.T, pool *pgxpool.Pool, tenantID, recordID string) *string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("consent owner tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var owner *string
	if err := tx.QueryRow(ctx, `
SELECT subscriber_id::text FROM consent_records
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, recordID).Scan(&owner); err != nil {
		t.Fatalf("read consent owner: %v", err)
	}
	return owner
}

func subscriberCount(t *testing.T, pool *pgxpool.Pool, tenantID, subscriberID string) int {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("subscriber count tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`,
		tenantID, subscriberID).Scan(&count); err != nil {
		t.Fatalf("count subscriber: %v", err)
	}
	return count
}

func TestBulkDeleteSubscriberWithConsentEvidenceThroughRouter_DB(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID := uuid.NewString()
	seedBulkVerbsTenant(t, pool, tenantID)
	email := "consented-" + uuid.NewString() + "@example.test"
	subscriberID := seedBulkVerbsSubscriber(t, pool, tenantID, email, StatusEnabled)
	recordID, evidenceBefore := seedSubscriberConsentRecord(t, pool, tenantID, subscriberID, email)

	router := chi.NewRouter()
	MountBulkRoutes(router, &Deps{Repo: &Repo{Pool: pool}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/bulk/delete",
		strings.NewReader(fmt.Sprintf(`{"subscriber_ids":[%q]}`, subscriberID)))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID: uuid.NewString(), TenantID: tenantID, Email: "owner@example.test", Role: "owner",
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))

	result := decodeBulkResult(t, rec)
	if result.Affected != 1 {
		t.Fatalf("bulk delete affected=%d, want 1 (body=%s)", result.Affected, rec.Body.String())
	}
	if got := subscriberCount(t, pool, tenantID, subscriberID); got != 0 {
		t.Fatalf("subscriber survived bulk delete: count=%d", got)
	}
	if owner := consentRecordOwner(t, pool, tenantID, recordID); owner != nil {
		t.Fatalf("consent record still names deleted subscriber %q", *owner)
	}
	if after := consentRecordEvidence(t, pool, tenantID, recordID); after != evidenceBefore {
		t.Fatalf("consent evidence changed while detaching:\nbefore=%s\nafter=%s", evidenceBefore, after)
	}
}

func TestSingleDeleteSubscriberWithConsentEvidence_DB(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	tenantID := uuid.NewString()
	seedBulkVerbsTenant(t, pool, tenantID)
	email := "single-consented-" + uuid.NewString() + "@example.test"
	subscriberID := seedBulkVerbsSubscriber(t, pool, tenantID, email, StatusEnabled)
	recordID, evidenceBefore := seedSubscriberConsentRecord(t, pool, tenantID, subscriberID, email)

	deleted, err := (&Repo{Pool: pool}).Delete(context.Background(), tenantID, subscriberID)
	if err != nil {
		t.Fatalf("delete subscriber with consent evidence: %v", err)
	}
	if deleted == nil || deleted.ID != subscriberID {
		t.Fatalf("deleted=%+v, want subscriber %s", deleted, subscriberID)
	}
	if owner := consentRecordOwner(t, pool, tenantID, recordID); owner != nil {
		t.Fatalf("consent record still names deleted subscriber %q", *owner)
	}
	if after := consentRecordEvidence(t, pool, tenantID, recordID); after != evidenceBefore {
		t.Fatalf("consent evidence changed while detaching:\nbefore=%s\nafter=%s", evidenceBefore, after)
	}
}

// TestConsentChronologyTriggerStillRejectsEvidenceRewrites runs as the table
// owner: postwave_app has no UPDATE grant on either ledger, so the owner (the
// identity RI cascades and SECURITY DEFINER code act as) is the one the trigger
// actually polices.
func TestConsentChronologyTriggerStillRejectsEvidenceRewrites_DB(t *testing.T) {
	pool := newBulkVerbsTestPool(t)
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL not set; the owner-level immutability proof needs it")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	t.Cleanup(admin.Close)

	tenantID := uuid.NewString()
	seedBulkVerbsTenant(t, pool, tenantID)
	email := "immutable-" + uuid.NewString() + "@example.test"
	subscriberID := seedBulkVerbsSubscriber(t, pool, tenantID, email, StatusEnabled)
	otherID := seedBulkVerbsSubscriber(t, pool, tenantID, "other-"+uuid.NewString()+"@example.test", StatusEnabled)
	recordID, _ := seedSubscriberConsentRecord(t, pool, tenantID, subscriberID, email)

	var eventID string
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("consent event tx: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO consent_events (tenant_id, subject_type, subject_id, channel, category, action)
VALUES ($1::uuid, 'visitor', $2, 'web', 'analytics', 'granted')
RETURNING id::text`, tenantID, "visitor-"+uuid.NewString()).Scan(&eventID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed consent event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit consent event: %v", err)
	}

	expectImmutable := func(t *testing.T, statement string, args ...any) {
		t.Helper()
		_, err := admin.Exec(ctx, statement, args...)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Fatalf("owner rewrite error=%v, want SQLSTATE 23514", err)
		}
	}
	t.Run("consent record evidence", func(t *testing.T) {
		expectImmutable(t, `UPDATE consent_records SET evidence = '{"forged":true}'::jsonb WHERE id = $1::uuid`, recordID)
	})
	t.Run("consent record address", func(t *testing.T) {
		expectImmutable(t, `UPDATE consent_records SET email = 'forged@example.test' WHERE id = $1::uuid`, recordID)
	})
	t.Run("consent record re-pointed to another subscriber", func(t *testing.T) {
		expectImmutable(t, `UPDATE consent_records SET subscriber_id = $2::uuid WHERE id = $1::uuid`, recordID, otherID)
	})
	t.Run("consent event evidence", func(t *testing.T) {
		expectImmutable(t, `UPDATE consent_events SET source = 'forged' WHERE id = $1::uuid`, eventID)
	})
	t.Run("detached consent record cannot be re-attached", func(t *testing.T) {
		if _, err := admin.Exec(ctx, `UPDATE consent_records SET subscriber_id = NULL WHERE id = $1::uuid`, recordID); err != nil {
			t.Fatalf("clearing the owner link (the SET NULL cascade) was rejected: %v", err)
		}
		expectImmutable(t, `UPDATE consent_records SET subscriber_id = $2::uuid WHERE id = $1::uuid`, recordID, subscriberID)
	})
}
