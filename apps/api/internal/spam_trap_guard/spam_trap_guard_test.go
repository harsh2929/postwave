package spam_trap_guard

// SUB-048 — spam_trap_guard now mirrors each blocklisted address into a
// canonical reason='spamtrap' suppression row. These tests pin the
// no-DB short-circuits (so they run everywhere) and gate the
// status-flip + suppression-write integration on DATABASE_URL, matching
// the repo's existing integration-test pattern.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// TestSweepTenant_NilPoolNoop — a nil pool (or empty tenant) is a
// no-op: returns (0, nil) without panicking. The store argument is
// irrelevant on this path.
func TestSweepTenant_NilPoolNoop(t *testing.T) {
	n, err := SweepTenant(context.Background(), nil, "tid", nil)
	if err != nil || n != 0 {
		t.Errorf("SweepTenant(nil pool) = (%d,%v), want (0,nil)", n, err)
	}
	n, err = SweepTenant(context.Background(), nil, "", &suppressions.Store{})
	if err != nil || n != 0 {
		t.Errorf("SweepTenant(empty tenant) = (%d,%v), want (0,nil)", n, err)
	}
}

// TestRunNow_RequiresTenant — the manual-sweep HTTP handler rejects a
// request with no tenant in context.
func TestRunNow_RequiresTenant(t *testing.T) {
	d := &Deps{Pool: nil}
	r := httptest.NewRequest("POST", "/api/v1/spam-trap-guard/run-now", nil)
	w := httptest.NewRecorder()
	d.RunNow(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestSweepTenant_WritesSpamtrapSuppression is the integration happy
// path: seed a spam_trap bounce event for a subscriber, run the sweep
// with a Store wired, then assert (1) the subscriber is blocklisted and
// (2) a reason='spamtrap' suppression row was written. Skips when
// DATABASE_URL is unset.
//
// It runs in a tenant of its own (createSpamTrapTestTenant), whose teardown
// deletes the tenant and with it every row the test wrote. It used to write
// into the shared tenant 00000000-0000-0000-0000-000000000001, which other
// packages also seed, and clean up with row deletes that could never succeed:
// the pool was closed by `defer pool.Close()` before t.Cleanup ran, and even
// on an open pool the first statement fails, because the application role has
// no DELETE on subscriber_events, and that aborted the rest of the
// transaction. So every run left a subscriber, a spam-trap bounce event and a
// suppression row in the shared tenant, and the next sweep of that tenant
// re-processed them all, which is why the count below could only be checked
// as ">= 1". In an isolated tenant the sweep must blocklist exactly the one
// subscriber seeded here.
func TestSweepTenant_WritesSpamtrapSuppression(t *testing.T) {
	ctx, pool := spamTrapIntegrationPool(t)
	tenantID := createSpamTrapTestTenant(t, ctx, pool)
	tag := randHex4(t)
	email := "trap" + tag + "@example.com"
	store := &suppressions.Store{Pool: pool}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	// Seed a subscriber + a spam_trap bounce event.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'single_optin')
ON CONFLICT (tenant_id, email) DO UPDATE SET status='enabled'`, tenantID, email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, bounce_type, at)
VALUES ($1::uuid, $2, 'bounced', 'spam_trap', now())`, tenantID, email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}

	n, err := SweepTenant(ctx, pool, tenantID, store)
	if err != nil {
		t.Fatalf("SweepTenant: %v", err)
	}
	if n != 1 {
		t.Fatalf("SweepTenant blocklisted %d, want exactly the 1 seeded subscriber", n)
	}

	// The canonical suppression row exists with reason='spamtrap'.
	suppressed, hit, err := store.Check(ctx, tenantID, email)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if !suppressed || hit == nil {
		t.Fatalf("expected a suppression row for %q", email)
	}
	if hit.Reason != suppressions.ReasonSpamtrap {
		t.Errorf("reason = %q, want spamtrap", hit.Reason)
	}
}

// TestSweepTenant_RetriesSuppressionAfterBlocklistCommit proves the P0
// durability invariant: a suppression outage may happen after the subscriber
// status is safely committed, but that status must not hide the still-pending
// canonical suppression from the next sweep.
func TestSweepTenant_RetriesSuppressionAfterBlocklistCommit(t *testing.T) {
	ctx, pool := spamTrapIntegrationPool(t)
	tenantID := createSpamTrapTestTenant(t, ctx, pool)
	email := "retry-" + randHex4(t) + "@example.com"
	seedSpamTrap(t, ctx, pool, tenantID, email, "enabled", time.Now().UTC())

	realStore := &suppressions.Store{Pool: pool}
	writer := &failOnceSuppressionWriter{delegate: realStore}

	blocklisted, err := sweepTenant(ctx, pool, tenantID, writer)
	if err == nil || !errors.Is(err, errForcedSuppressionFailure) {
		t.Fatalf("first SweepTenant error = %v, want forced suppression failure", err)
	}
	if blocklisted != 1 {
		t.Fatalf("first SweepTenant blocklisted = %d, want 1", blocklisted)
	}
	assertSubscriberStatus(t, ctx, pool, tenantID, email, "blocklisted")
	assertCanonicalSpamTrapSuppression(t, ctx, pool, tenantID, email, false)

	blocklisted, err = sweepTenant(ctx, pool, tenantID, writer)
	if err != nil {
		t.Fatalf("retry SweepTenant: %v", err)
	}
	if blocklisted != 0 {
		t.Fatalf("retry SweepTenant blocklisted = %d, want 0 for already-blocklisted subscriber", blocklisted)
	}
	if writer.calls != 2 {
		t.Fatalf("suppression writer calls = %d, want 2", writer.calls)
	}
	assertCanonicalSpamTrapSuppression(t, ctx, pool, tenantID, email, true)
}

// TestWorkerTick_DiscoversOldAlreadyBlocklistedBacklog pins both former loss
// dimensions: tenant discovery has no seven-day horizon and candidate
// selection does not depend on subscribers.status.
func TestWorkerTick_DiscoversOldAlreadyBlocklistedBacklog(t *testing.T) {
	ctx, pool := spamTrapIntegrationPool(t)
	tenantID := createSpamTrapTestTenant(t, ctx, pool)
	email := "old-backlog-" + randHex4(t) + "@example.com"
	seedSpamTrap(t, ctx, pool, tenantID, email, "blocklisted", time.Now().UTC().Add(-400*24*time.Hour))

	worker := &Worker{
		Pool:         pool,
		Suppressions: &suppressions.Store{Pool: pool},
		tenantCursor: uuidImmediatelyBefore(t, tenantID),
	}
	if _, err := worker.tick(ctx); err != nil {
		t.Fatalf("worker tick: %v", err)
	}
	assertCanonicalSpamTrapSuppression(t, ctx, pool, tenantID, email, true)
}

// TestSweepTenant_BatchIsBoundedAndDeterministic ensures a large historical
// backlog cannot create unbounded per-tenant work and that retries select the
// exact same oldest-first page when no completion markers were persisted.
func TestSweepTenant_BatchIsBoundedAndDeterministic(t *testing.T) {
	ctx, pool := spamTrapIntegrationPool(t)
	tenantID := createSpamTrapTestTenant(t, ctx, pool)
	prefix := "bounded-" + randHex4(t) + "-"
	base := time.Now().UTC().Add(-800 * 24 * time.Hour)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_events
       (tenant_id, subscriber_email, event_type, bounce_type, at)
SELECT $1::uuid,
       $2 || lpad(series::text, 4, '0') || '@example.com',
       'bounced', 'spam_trap',
       $3::timestamptz + ((series % 7) * INTERVAL '1 second')
  FROM generate_series(0, $4::integer) AS series`,
		tenantID, prefix, base, spamTrapRecipientBatchLimit); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed bounded backlog: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit bounded backlog: %v", err)
	}

	first := &recordingSuppressionWriter{}
	if _, err := sweepTenant(ctx, pool, tenantID, first); err != nil {
		t.Fatalf("first bounded sweep: %v", err)
	}
	if len(first.emails) != spamTrapRecipientBatchLimit {
		t.Fatalf("first bounded sweep selected %d candidates, want hard limit %d",
			len(first.emails), spamTrapRecipientBatchLimit)
	}

	second := &recordingSuppressionWriter{}
	if _, err := sweepTenant(ctx, pool, tenantID, second); err != nil {
		t.Fatalf("second bounded sweep: %v", err)
	}
	if !reflect.DeepEqual(second.emails, first.emails) {
		t.Fatal("bounded candidate order changed across identical retries")
	}

	type orderedCandidate struct {
		email string
		rank  int
	}
	wantCandidates := make([]orderedCandidate, 0, spamTrapRecipientBatchLimit+1)
	for index := 0; index <= spamTrapRecipientBatchLimit; index++ {
		wantCandidates = append(wantCandidates, orderedCandidate{
			email: fmt.Sprintf("%s%04d@example.com", prefix, index),
			rank:  index % 7,
		})
	}
	sort.Slice(wantCandidates, func(i, j int) bool {
		if wantCandidates[i].rank != wantCandidates[j].rank {
			return wantCandidates[i].rank < wantCandidates[j].rank
		}
		return wantCandidates[i].email < wantCandidates[j].email
	})
	wantEmails := make([]string, spamTrapRecipientBatchLimit)
	for index := range wantEmails {
		wantEmails[index] = wantCandidates[index].email
	}
	if !reflect.DeepEqual(first.emails, wantEmails) {
		t.Fatalf("candidate order is not oldest-first/email-tiebreak; first=%q want=%q",
			first.emails[0], wantEmails[0])
	}
}

var errForcedSuppressionFailure = errors.New("forced suppression failure")

type failOnceSuppressionWriter struct {
	delegate suppressionWriter
	calls    int
}

func (writer *failOnceSuppressionWriter) AddWithCategory(
	ctx context.Context,
	tenantID, email string,
	reason suppressions.Reason,
	source suppressions.Source,
	sourceEventID string,
	expiresAt *time.Time,
	metadata map[string]any,
	category suppressions.BounceCategory,
) (*suppressions.Entry, error) {
	writer.calls++
	if writer.calls == 1 {
		return nil, errForcedSuppressionFailure
	}
	return writer.delegate.AddWithCategory(
		ctx, tenantID, email, reason, source, sourceEventID, expiresAt, metadata, category,
	)
}

type recordingSuppressionWriter struct {
	emails []string
}

func (writer *recordingSuppressionWriter) AddWithCategory(
	_ context.Context,
	_, email string,
	_ suppressions.Reason,
	_ suppressions.Source,
	_ string,
	_ *time.Time,
	_ map[string]any,
	_ suppressions.BounceCategory,
) (*suppressions.Entry, error) {
	writer.emails = append(writer.emails, email)
	return &suppressions.Entry{}, nil
}

func spamTrapIntegrationPool(t *testing.T) (context.Context, *db.Pool) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool
}

func createSpamTrapTestTenant(t *testing.T, ctx context.Context, pool *db.Pool) string {
	t.Helper()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("seed tenant transaction: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier, data_region)
VALUES ($1::uuid, $2, 'Spam trap durability test', 'studio', 'us-east-1')`,
		tenantID, "spam-trap-"+uuid.NewString()); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	// The cascade from tenants removes the subscribers, bounce events and
	// suppressions the test wrote; the application role cannot delete
	// subscriber_events rows directly. A teardown that fails is reported, so a
	// leaked tenant cannot go unnoticed.
	t.Cleanup(func() { deleteSpamTrapTestTenant(t, pool, tenantID) })
	return tenantID
}

func seedSpamTrap(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID, email, status string,
	at time.Time,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, $3, 'single_optin')`, tenantID, email, status); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_events
       (tenant_id, subscriber_email, event_type, bounce_type, at)
VALUES ($1::uuid, $2, 'bounced', 'spam_trap', $3)`, tenantID, email, at); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
}

func assertSubscriberStatus(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID, email, want string,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var got string
	if err := tx.QueryRow(ctx, `
SELECT status FROM subscribers
 WHERE tenant_id = $1::uuid AND email = $2`, tenantID, email).Scan(&got); err != nil {
		t.Fatalf("read subscriber status: %v", err)
	}
	if got != want {
		t.Fatalf("subscriber status = %q, want %q", got, want)
	}
}

func assertCanonicalSpamTrapSuppression(
	t *testing.T,
	ctx context.Context,
	pool *db.Pool,
	tenantID, email string,
	want bool,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var got bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM subscriber_suppressions
     WHERE tenant_id = $1::uuid
       AND email = $2
       AND bounce_category = 'spamtrap'
       AND expires_at IS NULL
)`, tenantID, email).Scan(&got); err != nil {
		t.Fatalf("read canonical suppression: %v", err)
	}
	if got != want {
		t.Fatalf("canonical spamtrap suppression = %t, want %t", got, want)
	}
}

func uuidImmediatelyBefore(t *testing.T, value string) string {
	t.Helper()
	parsed, err := uuid.Parse(value)
	if err != nil {
		t.Fatalf("parse UUID: %v", err)
	}
	for index := len(parsed) - 1; index >= 0; index-- {
		if parsed[index] > 0 {
			parsed[index]--
			break
		}
		parsed[index] = 0xff
	}
	return parsed.String()
}

func randHex4(t *testing.T) string {
	t.Helper()
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

// deleteSpamTrapTestTenant removes a tenant the test created, and everything
// that cascades from it, in a transaction bound to that tenant. The tenants
// DELETE policy sees only the row whose id equals app.tenant_id, so a DELETE
// issued without that binding matches nothing and reports no error.
//
// It retries the whole transaction when Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). One tenant
// delete cascades through every foreign key that references tenants(id), about
// 735 at migration head, and holds a lock on each of those tables and their
// indexes until commit. So a few concurrent deletes from other packages sharing
// the database can briefly exhaust the lock table, and one can deadlock with
// another package's DDL on a shared table (the consent tracking test's
// CREATE/DROP TRIGGER on audit_log, for one). Both clear on their own. Any other
// failure, or a delete that removes no row, fails the test, so a leaked tenant
// cannot go unnoticed.
func deleteSpamTrapTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteSpamTrapTestTenantOnce(ctx, pool, tenantID)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "53200" || pgErr.Code == "40P01") && ctx.Err() == nil {
			t.Logf("cleanup of tenant %s: %s (SQLSTATE %s), retrying in %v", tenantID, pgErr.Message, pgErr.Code, wait)
			time.Sleep(wait)
			continue
		}
		if err != nil {
			t.Errorf("cleanup of tenant %s: %v", tenantID, err)
		} else if removed != 1 {
			t.Errorf("cleanup of tenant %s removed %d tenant rows, want 1", tenantID, removed)
		}
		return
	}
}

func deleteSpamTrapTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
