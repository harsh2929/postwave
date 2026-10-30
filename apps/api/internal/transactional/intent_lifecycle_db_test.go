// SPDX-License-Identifier: AGPL-3.0-only
package transactional

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Intent identity for the transactional send ledger.
//
// This path is LIVE — `POST /api/v1/emails` and its scheduled worker are
// mounted and send real mail — which makes the duplicate here different in kind
// from the contained ones elsewhere in this repo. Two behaviours combine:
//
//   - send.go dispatched to the provider and THEN inserted the ledger row, so a
//     failed insert left mail delivered with no record;
//   - repo.go ClaimDue re-claimed any row stuck in `sending` for ten minutes and
//     re-dispatched it. Its own comment conceded the point: "Re-dispatch is
//     at-least-once; the 10-min guard makes a genuine double-send unlikely."
//
// A worker that stops after the provider accepted a message but before the
// status write therefore re-sends it ten minutes later, to a real person.
//
// These run against a real database, as the non-privileged `postwave_app` role,
// because the property is enforced by a unique index and a claim predicate.
// Counting provider calls through a fake mailer is the only way to assert "the
// outside world was touched once" rather than "we believe it was".

type countingMailer struct {
	mu    sync.Mutex
	calls int
	err   error
}

func (m *countingMailer) Send(_ context.Context, _ mailer.Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	return m.err
}

func (m *countingMailer) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls
}

func TestSendIsExactlyOncePerIntentKey(t *testing.T) {
	pool, tenantID := seedIntentTenant(t)
	m := &countingMailer{}
	d := &Deps{Mailer: m, Repo: &Repo{Pool: pool}, DefaultFrom: "noreply@postwave.test"}
	ctx := context.Background()
	key := "intent-" + uuid.NewString()

	first, err := d.SendWithIntent(ctx, tenantID, "api", newIntentRequest("a@example.com", "Hello"), key, time.Now().UTC())
	if err != nil {
		t.Fatalf("first send: %v", err)
	}
	second, err := d.SendWithIntent(ctx, tenantID, "api", newIntentRequest("a@example.com", "Hello"), key, time.Now().UTC())
	if err != nil {
		t.Fatalf("replayed send: %v", err)
	}

	if m.count() != 1 {
		t.Fatalf("provider called %d times for one intent; a replay must not re-send", m.count())
	}
	if first.ID == "" || first.ID != second.ID {
		t.Fatalf("replay returned id %q, want the original %q", second.ID, first.ID)
	}
}

func TestConcurrentSendsOnOneIntentTouchTheProviderOnce(t *testing.T) {
	// Two API replicas handling a client retry at the same instant. A
	// read-then-write check passes on both before either writes; the uniqueness
	// has to be in the database.
	pool, tenantID := seedIntentTenant(t)
	m := &countingMailer{}
	ctx := context.Background()
	key := "intent-" + uuid.NewString()

	const racers = 6
	var wg sync.WaitGroup
	ids := make([]string, racers)
	errs := make([]error, racers)
	start := make(chan struct{})
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			d := &Deps{Mailer: m, Repo: &Repo{Pool: pool}, DefaultFrom: "noreply@postwave.test"}
			<-start
			res, err := d.SendWithIntent(ctx, tenantID, "api", newIntentRequest("a@example.com", "Hello"), key, time.Now().UTC())
			ids[i], errs[i] = res.ID, err
		}(i)
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("racer %d: %v", i, err)
		}
	}
	if m.count() != 1 {
		t.Fatalf("provider called %d times across %d concurrent sends of one intent; want 1", m.count(), racers)
	}
	for i, id := range ids {
		if id != ids[0] {
			t.Fatalf("racer %d returned id %q, want the single claimed id %q", i, id, ids[0])
		}
	}
	// Blueprint metric M-03, as a literal assertion.
	if n := countRowsForIntent(t, pool, tenantID, key); n != 1 {
		t.Fatalf("%d ledger rows for one intent key; M-03 requires exactly 1", n)
	}
}

func TestReusedIntentKeyWithDifferentContentIsRejected(t *testing.T) {
	// Answering with the first message's id would silently drop the second.
	pool, tenantID := seedIntentTenant(t)
	m := &countingMailer{}
	d := &Deps{Mailer: m, Repo: &Repo{Pool: pool}, DefaultFrom: "noreply@postwave.test"}
	ctx := context.Background()
	key := "intent-" + uuid.NewString()

	if _, err := d.SendWithIntent(ctx, tenantID, "api", newIntentRequest("a@example.com", "Hello"), key, time.Now().UTC()); err != nil {
		t.Fatalf("first send: %v", err)
	}
	_, err := d.SendWithIntent(ctx, tenantID, "api", newIntentRequest("a@example.com", "DIFFERENT"), key, time.Now().UTC())
	if !errors.Is(err, ErrIntentConflict) {
		t.Fatalf("err = %v, want ErrIntentConflict", err)
	}
	if m.count() != 1 {
		t.Fatalf("provider called %d times; a conflicting replay must not send", m.count())
	}
}

func TestAnUnknownProviderOutcomeIsNeverReclaimed(t *testing.T) {
	// The heart of it. A timeout means the provider MAY have accepted the
	// message and no receipt exists to say. Re-dispatching that row is a
	// duplicate to a real person; the old ClaimDue did exactly that after ten
	// minutes. `unknown` is terminal for the worker and surfaced instead.
	pool, tenantID := seedIntentTenant(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	key := "intent-" + uuid.NewString()

	// Model the WORKER path, which is where the duplicate actually lived: a
	// scheduled row is claimed (status -> 'sending'), dispatched, and the
	// provider call times out. The row stays `sending` — the status column has
	// no way to say "we do not know" — and the old predicate re-claimed any
	// `sending` row after ten minutes.
	//
	// Setting this up through Send() instead would leave status='failed', which
	// the claim predicate excludes for an unrelated reason, and the test would
	// pass without exercising attempt_state at all.
	when := time.Now().UTC().Add(-time.Hour)
	id, owned, err := repo.ClaimIntent(ctx, tenantID, InsertInput{
		From: "noreply@postwave.test", To: []string{"a@example.com"},
		Subject: "Scheduled", Status: "sending", ScheduledAt: &when, Source: "api",
		Payload: []byte(`{"to":["a@example.com"],"subject":"Scheduled"}`),
	}, key, "hash")
	if err != nil || !owned {
		t.Fatalf("claim = (%q, %v, %v)", id, owned, err)
	}
	// Age it well past the ten-minute window, still `sending`.
	ageTransactional(t, pool, tenantID, id, "2 hours")

	// Still `prepared`: the provider has not been called, so it IS claimable.
	if !claimIncludes(t, repo, tenantID, id) {
		t.Fatal("a `prepared` row past the stale window must still be claimable")
	}

	// Now the provider call times out.
	if err := repo.SettleIntent(ctx, tenantID, id, "unknown", "unknown", "sending", "", "context deadline exceeded", 0); err != nil {
		t.Fatalf("settle: %v", err)
	}
	ageTransactional(t, pool, tenantID, id, "2 hours")
	if got := attemptStateFor(t, pool, tenantID, key); got != "unknown" {
		t.Fatalf("attempt_state = %q, want unknown", got)
	}

	if claimIncludes(t, repo, tenantID, id) {
		t.Fatal("an `unknown` row was re-claimed for dispatch — the provider may already have accepted it, " +
			"and no receipt exists to say. That is the duplicate send to a real person this exists to prevent.")
	}
}

func claimIncludes(t *testing.T, repo *Repo, tenantID, id string) bool {
	t.Helper()
	due, err := repo.ClaimDue(context.Background(), time.Now().UTC(), 200)
	if err != nil {
		t.Fatalf("claim due: %v", err)
	}
	for _, row := range due {
		if row.ID == id {
			return true
		}
	}
	return false
}

func ageTransactional(t *testing.T, pool *db.Pool, tenantID, id, interval string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("age tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE transactional_emails
		    SET updated_at = now() - $3::interval, scheduled_at = now() - $3::interval
		  WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, id, interval); err != nil {
		t.Fatalf("age row: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("age commit: %v", err)
	}
}

func TestAPreparedRowIsStillReclaimable(t *testing.T) {
	// The conservative rule must not strand work that provably never reached
	// the provider: `prepared` is the one state it is safe to retry.
	pool, tenantID := seedIntentTenant(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	when := time.Now().UTC().Add(-time.Hour)

	id, err := repo.Insert(ctx, tenantID, InsertInput{
		From: "noreply@postwave.test", To: []string{"a@example.com"},
		Subject: "Scheduled", Status: "scheduled", ScheduledAt: &when,
		Source: "api", Payload: []byte(`{"to":["a@example.com"],"subject":"Scheduled"}`),
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	due, err := repo.ClaimDue(ctx, time.Now().UTC(), 50)
	if err != nil {
		t.Fatalf("claim due: %v", err)
	}
	found := false
	for _, row := range due {
		if row.ID == id {
			found = true
		}
	}
	if !found {
		t.Fatal("a due `prepared` row was not claimed; scheduled sends would never go out")
	}
}

// --- harness ----------------------------------------------------------------

func newIntentRequest(to, subject string) *SendRequest {
	return &SendRequest{
		From:    "noreply@postwave.test",
		To:      []string{to},
		Subject: subject,
		Text:    "body",
	}
}

func countRowsForIntent(t *testing.T, pool *db.Pool, tenantID, key string) int {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("count tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM transactional_emails WHERE tenant_id=$1::uuid AND intent_key=$2`,
		tenantID, key).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func attemptStateFor(t *testing.T, pool *db.Pool, tenantID, key string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("state tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var s string
	if err := tx.QueryRow(ctx,
		`SELECT attempt_state FROM transactional_emails WHERE tenant_id=$1::uuid AND intent_key=$2`,
		tenantID, key).Scan(&s); err != nil {
		t.Fatalf("read attempt_state: %v", err)
	}
	return s
}

func seedIntentTenant(t *testing.T) (*db.Pool, string) {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping intent lifecycle test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	// Fatal past the "is there a database" check: a seed failure is a schema or
	// permissions regression, and a SKIP there reads as green.
	if _, err := tx.Exec(context.Background(), `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Transactional intent test', 'studio')`,
		tenantID, "txn-intent-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("tenant commit: %v", err)
	}
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		clean, err := db.WithTenant(c, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = clean.Rollback(c) }()
		_, _ = clean.Exec(c, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
		_ = clean.Commit(c)
	})
	return pool, tenantID
}

// The conflict must reach the caller as 409, never 5xx and never 2xx.
//
// A 5xx makes the idempotency middleware treat the attempt as transient and
// DROP its claim — the handler's own comment says so — which frees the retry to
// send. A 2xx returning the first message's id would silently discard the
// second message. Both are worse than refusing.
func TestReusedKeyWithDifferentContentIs409(t *testing.T) {
	pool, tenantID := seedIntentTenant(t)
	m := &countingMailer{}
	d := &Deps{Mailer: m, Repo: &Repo{Pool: pool}, DefaultFrom: "noreply@postwave.test",
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	key := "intent-" + uuid.NewString()

	post := func(subject string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{
			"from": "noreply@postwave.test", "to": []string{"a@example.com"},
			"subject": subject, "text": "body",
		})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/emails", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
		rec := httptest.NewRecorder()
		d.handleSend(rec, req)
		return rec
	}

	if got := post("Hello").Code; got != http.StatusAccepted {
		t.Fatalf("first send status = %d, want 202", got)
	}
	rec := post("DIFFERENT")
	if rec.Code != http.StatusConflict {
		t.Fatalf("reused key with different content = %d, want 409 (5xx frees the middleware to retry; 2xx drops the message)", rec.Code)
	}
	if m.count() != 1 {
		t.Fatalf("provider called %d times, want 1", m.count())
	}
}

// --- findings from the adversarial review, 2026-08-04 ------------------------
//
// The review mutated each production change and found TWO that no test caught:
// inverting `classifyAttempt`, and making `SettleIntent` always write
// "prepared"/"none". The whole outcome-recording half of the fix was untested —
// the timeout test hand-wrote the SettleIntent call it was meant to be proving.

func TestTheProviderOutcomeIsRecordedByTheSendPath(t *testing.T) {
	// Drives the REAL path. The earlier version called SettleIntent with a
	// literal "unknown", which proves the DB predicate and nothing about
	// whether the code ever produces that value.
	pool, tenantID := seedIntentTenant(t)
	repo := &Repo{Pool: pool}

	for _, tc := range []struct {
		name        string
		mailerErr   error
		wantAttempt string
		wantEffect  string
	}{
		{"a clean send is submitted with full effect", nil, "submitted", "full"},
		{"a timeout is UNKNOWN, not failed", context.DeadlineExceeded, "unknown", "unknown"},
		{"a cancellation is UNKNOWN too", context.Canceled, "unknown", "unknown"},
		{"an ordinary refusal is rejected with no effect", errors.New("mailbox full"), "rejected", "none"},
		// The case an adversarial review showed was missed. A reset AFTER the
		// request was written cannot tell us whether SES processed it, and the
		// SDK has already retried three times by the time we see this.
		{"a connection reset is UNKNOWN, not rejected",
			errors.New("exceeded maximum number of attempts, 3, https response error: read tcp: connection reset by peer"),
			"unknown", "unknown"},
		{"a raw ECONNRESET is UNKNOWN", syscall.ECONNRESET, "unknown", "unknown"},
		{"an EOF mid-flight is UNKNOWN", io.EOF, "unknown", "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &Deps{
				Mailer:      &countingMailer{err: tc.mailerErr},
				Repo:        repo,
				DefaultFrom: "noreply@postwave.test",
				Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
			}
			key := "intent-" + uuid.NewString()
			if _, err := d.SendWithIntent(context.Background(), tenantID, "api",
				newIntentRequest("a@example.com", "Hello"), key, time.Now().UTC()); err != nil {
				t.Fatalf("send: %v", err)
			}
			attempt, effect := lifecycleFor(t, pool, tenantID, key)
			if attempt != tc.wantAttempt || effect != tc.wantEffect {
				t.Fatalf("recorded (%q, %q), want (%q, %q)", attempt, effect, tc.wantAttempt, tc.wantEffect)
			}
		})
	}
}

func TestWithoutAnIdempotencyKeyTwoIdenticalSendsBothGoOut(t *testing.T) {
	// The regression an earlier version of this change introduced. Deriving an
	// intent key from the request body collapsed two DELIBERATE identical sends
	// — a reminder, a "resend confirmation" button, a nightly digest — into one
	// delivery, forever, with no time window. Only the caller knows two requests
	// are the same attempt, so absent a key we must not invent one.
	pool, tenantID := seedIntentTenant(t)
	m := &countingMailer{}
	d := &Deps{Mailer: m, Repo: &Repo{Pool: pool}, DefaultFrom: "noreply@postwave.test",
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx := context.Background()

	for i := 0; i < 2; i++ {
		if _, err := d.Send(ctx, tenantID, "api", newIntentRequest("a@example.com", "Same"), time.Now().UTC()); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	if m.count() != 2 {
		t.Fatalf("provider called %d times for two deliberate identical sends; want 2 — "+
			"a client that sent no Idempotency-Key asked for two messages", m.count())
	}
}

func TestARetryAfterAProviderRefusalIsAllowedAndReported(t *testing.T) {
	// A transient refusal must not become permanent. Answering a flat
	// "accepted" on replay meant a throttled password reset was never sent and
	// the API reported success — the whole product failing silently.
	pool, tenantID := seedIntentTenant(t)
	m := &countingMailer{err: errors.New("throttled by provider")}
	d := &Deps{Mailer: m, Repo: &Repo{Pool: pool}, DefaultFrom: "noreply@postwave.test",
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx := context.Background()
	key := "intent-" + uuid.NewString()

	first, err := d.SendWithIntent(ctx, tenantID, "api", newIntentRequest("a@example.com", "Reset"), key, time.Now().UTC())
	if err != nil {
		t.Fatalf("first send: %v", err)
	}
	if first.Status == "accepted" {
		t.Fatalf("a refused send reported %q; the caller must learn it failed", first.Status)
	}

	// The provider recovers; the same key must be allowed through.
	m.mu.Lock()
	m.err = nil
	m.mu.Unlock()
	second, err := d.SendWithIntent(ctx, tenantID, "api", newIntentRequest("a@example.com", "Reset"), key, time.Now().UTC())
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if second.Status != "sent" {
		t.Fatalf("retry after a decided failure reported %q, want sent", second.Status)
	}
	if m.count() != 2 {
		t.Fatalf("provider called %d times; the retry of a REJECTED attempt must dispatch", m.count())
	}
}

func TestASubmittedIntentIsNeverRedispatchedOnReplay(t *testing.T) {
	// The other side of the same rule: once the provider accepted it, a replay
	// reports the original outcome and calls nothing.
	pool, tenantID := seedIntentTenant(t)
	m := &countingMailer{}
	d := &Deps{Mailer: m, Repo: &Repo{Pool: pool}, DefaultFrom: "noreply@postwave.test",
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx := context.Background()
	key := "intent-" + uuid.NewString()

	first, _ := d.SendWithIntent(ctx, tenantID, "api", newIntentRequest("a@example.com", "Hi"), key, time.Now().UTC())
	second, err := d.SendWithIntent(ctx, tenantID, "api", newIntentRequest("a@example.com", "Hi"), key, time.Now().UTC())
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if m.count() != 1 {
		t.Fatalf("provider called %d times; a submitted intent must not re-dispatch", m.count())
	}
	if second.ID != first.ID || second.Status != "sent" {
		t.Fatalf("replay = %+v, want the original id with its real status", second)
	}
}

func lifecycleFor(t *testing.T, pool *db.Pool, tenantID, key string) (string, string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("lifecycle tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var attempt, effect string
	if err := tx.QueryRow(ctx,
		`SELECT attempt_state, external_effect FROM transactional_emails
		  WHERE tenant_id=$1::uuid AND intent_key=$2`, tenantID, key).Scan(&attempt, &effect); err != nil {
		t.Fatalf("read lifecycle: %v", err)
	}
	return attempt, effect
}

func TestAnInterruptedClaimIsRecoveredNotStranded(t *testing.T) {
	// An immediate send that claims and then dies leaves `status='sending'`,
	// `attempt_state='prepared'` and an empty payload. A review called this an
	// "immortal zombie": ClaimDue re-claims it every ten minutes, SendStored
	// fails validation, and — because MarkFailed's SQL was broken and its error
	// discarded — the status never changed.
	//
	// Repairing MarkFailed should make the worker settle it on the FIRST pass.
	// This pins that, because "it is probably fixed by the other fix" is a
	// belief until something checks.
	pool, tenantID := seedIntentTenant(t)
	repo := &Repo{Pool: pool}
	d := &Deps{Mailer: &countingMailer{}, Repo: repo, DefaultFrom: "noreply@postwave.test",
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx := context.Background()

	id, owned, err := repo.ClaimIntent(ctx, tenantID, InsertInput{
		From: "noreply@postwave.test", To: []string{"a@example.com"},
		Subject: "Interrupted", Status: "sending", Source: "api",
	}, "intent-"+uuid.NewString(), "hash")
	if err != nil || !owned {
		t.Fatalf("claim = (%q, %v, %v)", id, owned, err)
	}
	// The process dies here: no dispatch, no settle. Age it past the window.
	ageTransactional(t, pool, tenantID, id, "2 hours")

	due, err := repo.ClaimDue(ctx, time.Now().UTC(), 50)
	if err != nil {
		t.Fatalf("claim due: %v", err)
	}
	var payload []byte
	for _, row := range due {
		if row.ID == id {
			payload = row.Payload
		}
	}
	if payload == nil {
		t.Fatal("an interrupted `prepared` claim must be re-claimable; otherwise it is stranded")
	}

	d.SendStored(ctx, tenantID, id, payload)

	outcome, err := repo.IntentOutcome(ctx, tenantID, id)
	if err != nil {
		t.Fatalf("outcome: %v", err)
	}
	if outcome.AttemptState == "prepared" {
		t.Fatal("the row is STILL prepared after the worker processed it — it will be re-claimed " +
			"every ten minutes forever, which is the loop the broken MarkFailed SQL created")
	}
	if claimIncludes(t, repo, tenantID, id) {
		t.Fatalf("a settled row (%q) is still claimable", outcome.AttemptState)
	}
}

// The per-message lookup must report the same lifecycle as the list.
//
// `Get` selected twelve columns; `ListRecent`, thirty lines below it, selected
// those twelve PLUS `attempt_state` and `external_effect`. So the one call every
// SDK uses to answer "what happened to this message" was the one that hid the
// honest state: a send whose outcome is genuinely unknown reported an empty
// attempt state through Get, while the same record in a list said `unknown`.
//
// The list and the item are two readings of one row. A caller polling Get after
// an ambiguous dispatch would see nothing to distinguish it from a clean send,
// which is exactly what the attempt-state column exists to prevent.
func TestGetReportsTheSameLifecycleAsTheList(t *testing.T) {
	pool, tenantID := seedIntentTenant(t)
	ctx := context.Background()
	repo := &Repo{Pool: pool}

	id, err := repo.Insert(ctx, tenantID, InsertInput{
		From: "sender@example.test", To: []string{"rcpt@example.test"},
		Subject: "lifecycle", Status: "queued", Source: "api",
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	// Drive it into the ambiguous state the column exists to express.
	if err := repo.MarkUnknown(ctx, tenantID, id, "provider timed out"); err != nil {
		t.Fatalf("mark unknown: %v", err)
	}

	got, err := repo.Get(ctx, tenantID, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	list, err := repo.ListRecent(ctx, tenantID, 50, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var fromList *Record
	for i := range list {
		if list[i].ID == id {
			fromList = &list[i]
			break
		}
	}
	if fromList == nil {
		t.Fatal("the record is missing from the list")
	}

	if fromList.AttemptState == "" {
		t.Fatal("precondition: the list should report an attempt state")
	}
	if got.AttemptState != fromList.AttemptState {
		t.Errorf("Get reports attempt_state %q, the list reports %q. The item and "+
			"the list are two readings of one row; a caller polling Get after an "+
			"ambiguous dispatch cannot tell it from a clean send.",
			got.AttemptState, fromList.AttemptState)
	}
	if got.ExternalEffect != fromList.ExternalEffect {
		t.Errorf("Get reports external_effect %v, the list reports %v",
			got.ExternalEffect, fromList.ExternalEffect)
	}
}
