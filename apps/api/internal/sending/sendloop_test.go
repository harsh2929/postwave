package sending

// Sendloop integration tests.
//
// These tests need a real Postgres so the SELECT … FOR UPDATE SKIP LOCKED
// + RLS path is exercised end-to-end. They follow the existing skip-when-
// DATABASE_URL-unset pattern from internal/db/db_test.go so CI without a
// database doesn't block.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// mockListmonk records send calls and can be configured to fail.
type mockListmonk struct {
	mu                 sync.Mutex
	sent               []sendArgs
	failNext           error
	lastIdempotencyKey string
	lastMessenger      string
	lastHeaders        map[string]string
}

type sendArgs struct {
	tenant, email, subject, body string
}

type failAfterRateLimiter struct {
	allowed int
	calls   int
	err     error
}

type failAfterSuppressionChecker struct {
	mu      sync.Mutex
	allowed int
	calls   int
	err     error
}

func (s *failAfterSuppressionChecker) Check(_ context.Context, _, _ string) (bool, *SuppressionEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.calls > s.allowed {
		return false, nil, s.err
	}
	return false, nil, nil
}

// blockingBatchSuppression lets a test place a suppression after the send
// loop has claimed the queue row but before the required batch decision is
// read. It exercises the real queue-to-dispatch race window deterministically.
type blockingBatchSuppression struct {
	delegate SuppressionBatchChecker
	started  chan struct{}
	release  chan struct{}
	once     sync.Once
}

// clearBatchBlockingScalar models a suppression created after a successful
// clear batch snapshot. The scalar check blocks so the test can write the row
// in the exact snapshot-to-dispatch window, then delegates to the real
// converger. This proves the tail-of-batch freshness revalidation is live.
type clearBatchBlockingScalar struct {
	delegate      SuppressionChecker
	scalarStarted chan struct{}
	release       chan struct{}
	once          sync.Once
}

func (b *clearBatchBlockingScalar) Check(ctx context.Context, tenantID, email string) (bool, *SuppressionEntry, error) {
	b.once.Do(func() { close(b.scalarStarted) })
	select {
	case <-ctx.Done():
		return false, nil, ctx.Err()
	case <-b.release:
	}
	return b.delegate.Check(ctx, tenantID, email)
}

func (b *clearBatchBlockingScalar) CheckBatch(_ context.Context, _ string, emails []string) (map[string]SuppressionDecision, error) {
	out := make(map[string]SuppressionDecision, len(emails))
	for _, email := range emails {
		out[normalizeSuppressionEmail(email)] = SuppressionDecision{}
	}
	return out, nil
}

func (b *blockingBatchSuppression) Check(ctx context.Context, tenantID, email string) (bool, *SuppressionEntry, error) {
	decisions, err := b.CheckBatch(ctx, tenantID, []string{email})
	if err != nil {
		return false, nil, err
	}
	decision, ok := decisions[normalizeSuppressionEmail(email)]
	if !ok {
		return false, nil, ErrSuppressionBatchIncomplete
	}
	return decision.Suppressed, decision.Entry, nil
}

func (b *blockingBatchSuppression) CheckBatch(ctx context.Context, tenantID string, emails []string) (map[string]SuppressionDecision, error) {
	b.once.Do(func() { close(b.started) })
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-b.release:
	}
	return b.delegate.CheckBatch(ctx, tenantID, emails)
}

func (r *failAfterRateLimiter) Try(_ context.Context, _ string, _ int) (bool, time.Time, error) {
	r.calls++
	if r.calls <= r.allowed {
		return true, time.Time{}, nil
	}
	return false, time.Time{}, r.err
}

func TestSenderHeadersUseTheCampaignAddressNotTheDisplayName(t *testing.T) {
	headers := senderHeaders("Acme News", "news@example.com")
	if got, want := headers["From"], `"Acme News" <news@example.com>`; got != want {
		t.Fatalf("From header = %q, want %q", got, want)
	}
	if got := senderHeaders("Acme News", ""); got != nil {
		t.Fatalf("empty from_email should not create a sender header: %v", got)
	}
}

func TestCampaignHeadersApplyReplyToAndExplicitTrackingChoices(t *testing.T) {
	headers := campaignHeaders(campaignBody{
		fromName:            "Acme News",
		fromEmail:           "news@example.com",
		replyTo:             "Support <help@example.com>",
		trackingSettingsRaw: []byte(`{"open_tracking":false,"click_tracking":true}`),
	})
	if got := headers["Reply-To"]; got != `"Support" <help@example.com>` {
		t.Fatalf("Reply-To = %q", got)
	}
	if got := headers["X-Postwave-No-Open-Track"]; got != "1" {
		t.Fatalf("open tracking opt-out header = %q", got)
	}
	if _, disabled := headers["X-Postwave-No-Click-Track"]; disabled {
		t.Fatal("explicit click tracking=true must not disable click tracking")
	}
	defaults := campaignHeaders(campaignBody{trackingSettingsRaw: []byte(`{}`)})
	if _, disabled := defaults["X-Postwave-No-Open-Track"]; disabled {
		t.Fatal("missing settings must preserve the backwards-compatible tracking default")
	}
}

func TestWithProviderAttributionServerOwnsBindingHeaders(t *testing.T) {
	headers := map[string]string{
		tenantAttributionHeader:   "spoofed-tenant",
		campaignAttributionHeader: "spoofed-campaign",
		"Reply-To":                "help@example.com",
	}
	got := withProviderAttribution(
		headers,
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
	)
	if got[tenantAttributionHeader] != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("tenant attribution = %q", got[tenantAttributionHeader])
	}
	if got[campaignAttributionHeader] != "22222222-2222-4222-8222-222222222222" {
		t.Fatalf("campaign attribution = %q", got[campaignAttributionHeader])
	}
	if got["Reply-To"] != "help@example.com" {
		t.Fatal("unrelated campaign headers must be retained")
	}
	if got := withProviderAttribution(nil, "", ""); got != nil {
		t.Fatalf("empty tenant should not manufacture headers: %#v", got)
	}
}

func TestPrepareCampaignHTMLAddsEscapedPreheaderAndUTMParameters(t *testing.T) {
	body := `<html><body><a href="https://example.com/path?existing=1#details">Read</a><a href="{{ unsubscribe_url }}">Leave</a></body></html>`
	got := prepareCampaignHTML(body, `A preview <without markup>`, []byte(`{
		"google_analytics":true,
		"utm_source":"newsletter",
		"utm_medium":"email",
		"utm_campaign":"launch"
	}`))
	for _, want := range []string{
		`data-postwave-preheader`,
		`A preview &lt;without markup&gt;`,
		`existing=1`,
		`utm_campaign=launch`,
		`utm_medium=email`,
		`utm_source=newsletter`,
		`href="{{ unsubscribe_url }}"`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("prepared HTML missing %q: %s", want, got)
		}
	}
}

func (m *mockListmonk) Send(_ context.Context, tenantID, email, subject, body string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failNext != nil {
		err := m.failNext
		m.failNext = nil
		return err
	}
	m.sent = append(m.sent, sendArgs{tenantID, email, subject, body})
	return nil
}

// SendIdempotent satisfies the D2-extended ListmonkSender interface.
// The mock doesn't assert on the idempotency key in existing tests;
// new tests can read m.lastIdempotencyKey to verify the wire-up.
func (m *mockListmonk) SendIdempotent(ctx context.Context, tenantID, email, subject, body, idempotencyKey string) error {
	m.mu.Lock()
	m.lastIdempotencyKey = idempotencyKey
	m.mu.Unlock()
	return m.Send(ctx, tenantID, email, subject, body)
}

// SendWithRouting satisfies the dedicated-IP routing extension of
// ListmonkSender. Records the messenger so tests can assert routing.
func (m *mockListmonk) SendWithRouting(ctx context.Context, tenantID, email, subject, body, idempotencyKey, messenger string) error {
	m.mu.Lock()
	m.lastIdempotencyKey = idempotencyKey
	m.lastMessenger = messenger
	m.mu.Unlock()
	return m.Send(ctx, tenantID, email, subject, body)
}

// SendWithHeaders satisfies the headers extension of ListmonkSender.
// Records the headers so tests can assert the List-Unsubscribe wire
// path. Threads through Send so the existing failNext / fail-injection
// machinery still applies.
func (m *mockListmonk) SendWithHeaders(ctx context.Context, tenantID, email, subject, body, idempotencyKey, messenger string, headers map[string]string) error {
	m.mu.Lock()
	m.lastIdempotencyKey = idempotencyKey
	m.lastMessenger = messenger
	if headers != nil {
		m.lastHeaders = make(map[string]string, len(headers))
		for k, v := range headers {
			m.lastHeaders[k] = v
		}
	} else {
		m.lastHeaders = nil
	}
	m.mu.Unlock()
	return m.Send(ctx, tenantID, email, subject, body)
}

func (m *mockListmonk) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sent)
}

// requireDB returns a pool + cleanup, skipping the test when DATABASE_URL
// is unset (matches internal/db/db_test.go's pattern). Also detects the
// known migration 0068 RLS-bug (see noteOnMigration0068Bug) and emits a
// loud Skipf with a remediation pointer when present, so CI surfaces the
// bug without classifying it as a test failure.
func requireDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	if err := probeMigration0068(ctx, pool); err != nil {
		t.Fatalf("migration 0068 RLS bug detected: %v\n\n%s",
			err, migration0068Remediation)
	}
	return pool
}

// noteOnMigration0068Bug documents a bug in migration 0068.
//
// Migration 0068 created tenant_sending_settings, tenant_send_rate_buckets,
// and campaign_recipients each with a single `AS RESTRICTIVE` policy.
// Postgres RLS requires at least one PERMISSIVE policy for any row to
// pass; RESTRICTIVE-only is always-deny. Every gateway INSERT/UPDATE
// against these three tables therefore fails with SQLSTATE 42501.
//
// The existing unit tests in sendingsettings/ never touch the database,
// so this bug was hidden. The fix is a follow-up migration adding
// PERMISSIVE policies (or re-creating the existing ones without the
// AS RESTRICTIVE qualifier). Per this task's "no new migrations" rule
// we do NOT add it here; the integration tests skip with a clear
// remediation message instead.
//
//nolint:unused // documentation symbol referenced only from the comment block.
var noteOnMigration0068Bug struct{}

const migration0068Remediation = `Fix: drop the RESTRICTIVE-only tenant_isolation policies
on tenant_sending_settings, tenant_send_rate_buckets, and campaign_recipients,
or add a PERMISSIVE companion policy. Example follow-up migration:

  ALTER POLICY tenant_isolation ON tenant_sending_settings RENAME TO tenant_isolation_old;
  CREATE POLICY tenant_isolation ON tenant_sending_settings
    AS PERMISSIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  DROP POLICY tenant_isolation_old ON tenant_sending_settings;
(repeat for tenant_send_rate_buckets and campaign_recipients).`

// probeMigration0068 returns nil when the X1+X2+X3 tables are writeable,
// or an error when the RLS-only-RESTRICTIVE bug is in effect. Probes
// against a throwaway tenant id and rolls back so nothing persists.
func probeMigration0068(ctx context.Context, pool *db.Pool) error {
	tx, txErr := pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	const probeID = "00000000-0000-0000-0000-0000feedbeef"
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, probeID); err != nil {
		return err
	}
	// We don't have a real tenants row; skip the FK by using a savepoint
	// + targeted error inspection. We just want to know whether the RLS
	// WITH CHECK passes — the FK error means RLS already let us through.
	_, txErr = tx.Exec(ctx,
		`INSERT INTO tenant_sending_settings (tenant_id) VALUES ($1::uuid)`, probeID)
	if txErr == nil {
		return nil
	}
	s := txErr.Error()
	if indexOf(s, "row-level security") >= 0 || indexOf(s, "42501") >= 0 {
		return txErr
	}
	// Other errors (FK, etc) mean RLS was satisfied — not the bug.
	return nil
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// fixtureTenant creates a fresh tenant with a fresh campaign and N
// pending recipients, returning their ids. The cleanup callback drops
// everything via cascading FK so a failing test doesn't poison the next
// run. Uses the outbox-worker GUC pattern to write across RLS during
// setup.
func fixtureTenant(t *testing.T, pool *db.Pool, recipients int, capPerHour *int, quietStart, quietEnd, quietTZ string) (tenantID, campaignID string) {
	t.Helper()
	ctx := context.Background()
	// Pre-generate the tenant UUID so we can SET LOCAL app.tenant_id
	// to it BEFORE the INSERT — tenants's RLS WITH CHECK requires the
	// row's id to match app.tenant_id. After the insert we keep the
	// same scope for downstream child-table inserts.
	var tenantUUID string
	{
		row := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`)
		if err := row.Scan(&tenantUUID); err != nil {
			t.Fatalf("gen tenant uuid: %v", err)
		}
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, tenantUUID); err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	tname := fmt.Sprintf("sendloop-%d", time.Now().UnixNano())
	if err := tx.QueryRow(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, $2, $2, 'studio')
RETURNING id::text`, tenantUUID, tname).Scan(&tenantID); err != nil {
		t.Fatalf("create tenant: %v", err)
	}
	// settings row (only when caller asked for one)
	if capPerHour != nil || quietStart != "" {
		if _, err := tx.Exec(ctx, `
INSERT INTO tenant_sending_settings
  (tenant_id, max_sends_per_hour, quiet_hours_start, quiet_hours_end, quiet_hours_tz)
VALUES ($1::uuid, $2, NULLIF($3,''), NULLIF($4,''), NULLIF($5,''))`,
			tenantID, capPerHour, quietStart, quietEnd, quietTZ); err != nil {
			t.Fatalf("create settings: %v", err)
		}
	}
	// campaign in 'sending' state so the loop picks it up.
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, body_html, status)
VALUES ($1::uuid, $2, 'subject', '<p>hi</p>', 'sending')
RETURNING id::text`, tenantID, tname+"-campaign").Scan(&campaignID); err != nil {
		t.Fatalf("create campaign: %v", err)
	}
	// recipients
	for i := 0; i < recipients; i++ {
		email := fmt.Sprintf("u%d@%s.test", i, tname)
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_recipients (campaign_id, tenant_id, subscriber_email, status)
VALUES ($1::uuid, $2::uuid, $3, 'pending')`, campaignID, tenantID, email); err != nil {
			t.Fatalf("create recipient: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
	t.Cleanup(func() {
		// Tenant cascades through campaigns + recipients + settings + bucket.
		// Cleanup needs tenant scope (the DELETE policy on tenants requires
		// app.tenant_id = id). Best-effort — ignore errors on shutdown.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		dtx, err := pool.BeginTx(ctx, pgx.TxOptions{})
		if err != nil {
			return
		}
		defer func() { _ = dtx.Rollback(ctx) }()
		_, _ = dtx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID)
		_, _ = dtx.Exec(ctx, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
		_ = dtx.Commit(ctx)
	})
	return tenantID, campaignID
}

// countByStatus returns the count of campaign_recipients rows in each
// status for a campaign.
func countByStatus(t *testing.T, pool *db.Pool, tenantID, campaignID string) map[string]int {
	t.Helper()
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	rows, err := tx.Query(context.Background(),
		`SELECT status, count(*) FROM campaign_recipients
         WHERE campaign_id=$1::uuid GROUP BY status`, campaignID)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var s string
		var n int
		if err := rows.Scan(&s, &n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[s] = n
	}
	return out
}

func campaignStatus(t *testing.T, pool *db.Pool, tenantID, campaignID string) string {
	t.Helper()
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var status string
	if err := tx.QueryRow(context.Background(),
		`SELECT status FROM campaigns WHERE id=$1::uuid`, campaignID).Scan(&status); err != nil {
		t.Fatalf("campaign status: %v", err)
	}
	return status
}

func campaignRecipientEmail(t *testing.T, pool *db.Pool, tenantID, campaignID string) string {
	t.Helper()
	tx, err := db.WithTenant(t.Context(), pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	var email string
	if err := tx.QueryRow(t.Context(), `
SELECT subscriber_email::text
FROM campaign_recipients
WHERE campaign_id = $1::uuid
ORDER BY id
LIMIT 1`, campaignID).Scan(&email); err != nil {
		t.Fatalf("campaign recipient email: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatalf("commit recipient lookup: %v", err)
	}
	return email
}

func suppressionTestGuard(pool *db.Pool, sender *mockListmonk, checker SuppressionChecker) *Guard {
	return &Guard{
		Pool:         pool,
		Listmonk:     sender,
		RateLimit:    &PostgresRateLimiter{Pool: pool, Window: time.Hour},
		QuietHours:   &QuietHoursChecker{Pool: pool},
		Suppressions: checker,
		BatchSize:    10,
	}
}

func TestRunOnce_HappyPath(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 10, nil, "", "", "")

	mock := &mockListmonk{}
	g := &Guard{
		Pool:         pool,
		Listmonk:     mock,
		RateLimit:    &PostgresRateLimiter{Pool: pool, Window: time.Hour},
		QuietHours:   &QuietHoursChecker{Pool: pool},
		Suppressions: &stubChecker{},
		BatchSize:    100,
	}
	n, err := g.RunOnce(context.Background(), tenantID)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if n != 10 {
		t.Errorf("RunOnce sent %d, want 10", n)
	}
	if mock.count() != 10 {
		t.Errorf("listmonk got %d sends, want 10", mock.count())
	}
	got := countByStatus(t, pool, tenantID, campaignID)
	if got["sent"] != 10 {
		t.Errorf("status counts = %v, want sent=10", got)
	}
}

func TestRunOnce_CanonicalSuppressionBoundaryClearSends(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 1, nil, "", "", "")
	store := &suppressions.Store{Pool: pool}
	checker := NewSuppressionConvergerAdapter(suppressions.NewConverger(store, nil))
	sender := &mockListmonk{}

	n, err := suppressionTestGuard(pool, sender, checker).RunOnce(t.Context(), tenantID)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if n != 1 || sender.count() != 1 {
		t.Fatalf("attempted=%d sends=%d, want 1/1", n, sender.count())
	}
	if got := countByStatus(t, pool, tenantID, campaignID); got["sent"] != 1 || len(got) != 1 {
		t.Fatalf("status counts = %v, want sent=1", got)
	}
}

func TestRunOnce_SuppressionAddedAfterClaimBeforeSendIsSkipped(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 1, nil, "", "", "")
	email := campaignRecipientEmail(t, pool, tenantID, campaignID)
	store := &suppressions.Store{Pool: pool}
	production := NewSuppressionConvergerAdapter(suppressions.NewConverger(store, nil))
	blocking := &blockingBatchSuppression{
		delegate: production,
		started:  make(chan struct{}),
		release:  make(chan struct{}),
	}
	sender := &mockListmonk{}
	type runResult struct {
		n   int
		err error
	}
	resultCh := make(chan runResult, 1)
	go func() {
		n, err := suppressionTestGuard(pool, sender, blocking).RunOnce(t.Context(), tenantID)
		resultCh <- runResult{n: n, err: err}
	}()

	select {
	case <-blocking.started:
	case <-time.After(5 * time.Second):
		t.Fatal("send loop did not reach the post-claim suppression boundary")
	}
	released := false
	defer func() {
		if !released {
			close(blocking.release)
		}
	}()
	if _, err := store.Add(
		t.Context(), tenantID, email,
		suppressions.ReasonHardBounce, suppressions.SourceManual,
		"race-"+campaignID, nil, map[string]any{"test": "queue_to_send_race"},
	); err != nil {
		t.Fatalf("add suppression in queue-to-send race: %v", err)
	}
	close(blocking.release)
	released = true

	select {
	case result := <-resultCh:
		if result.err != nil {
			t.Fatalf("RunOnce: %v", result.err)
		}
		if result.n != 0 {
			t.Fatalf("attempted=%d, want 0", result.n)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("send loop did not finish after suppression decision was released")
	}
	if sender.count() != 0 {
		t.Fatalf("upstream sends=%d, want 0", sender.count())
	}
	if got := countByStatus(t, pool, tenantID, campaignID); got["skipped"] != 1 || len(got) != 1 {
		t.Fatalf("status counts = %v, want skipped=1", got)
	}
}

func TestRunOnce_SuppressionAddedAfterClearBatchSnapshotBeforeDispatchIsSkipped(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 1, nil, "", "", "")
	email := campaignRecipientEmail(t, pool, tenantID, campaignID)
	store := &suppressions.Store{Pool: pool}
	production := NewSuppressionConvergerAdapter(suppressions.NewConverger(store, nil))
	checker := &clearBatchBlockingScalar{
		delegate:      production,
		scalarStarted: make(chan struct{}),
		release:       make(chan struct{}),
	}
	sender := &mockListmonk{}
	type runResult struct {
		n   int
		err error
	}
	resultCh := make(chan runResult, 1)
	go func() {
		n, err := suppressionTestGuard(pool, sender, checker).RunOnce(t.Context(), tenantID)
		resultCh <- runResult{n: n, err: err}
	}()

	select {
	case <-checker.scalarStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("send loop did not reach the last-moment scalar suppression check")
	}
	released := false
	defer func() {
		if !released {
			close(checker.release)
		}
	}()
	if _, err := store.Add(
		t.Context(), tenantID, email,
		suppressions.ReasonSpamComplaint, suppressions.SourceManual,
		"post-batch-race-"+campaignID, nil,
		map[string]any{"test": "batch_snapshot_to_dispatch_race"},
	); err != nil {
		t.Fatalf("add suppression after batch snapshot: %v", err)
	}
	close(checker.release)
	released = true

	select {
	case result := <-resultCh:
		if result.err != nil {
			t.Fatalf("RunOnce: %v", result.err)
		}
		if result.n != 0 {
			t.Fatalf("attempted=%d, want 0", result.n)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("send loop did not finish after scalar suppression decision was released")
	}
	if sender.count() != 0 {
		t.Fatalf("upstream sends=%d, want 0", sender.count())
	}
	if got := countByStatus(t, pool, tenantID, campaignID); got["skipped"] != 1 || len(got) != 1 {
		t.Fatalf("status counts = %v, want skipped=1", got)
	}
}

func TestRunOnce_DSARHashedSuppressionIsSkippedByBatchBoundary(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 1, nil, "", "", "")
	email := campaignRecipientEmail(t, pool, tenantID, campaignID)
	store := &suppressions.Store{Pool: pool}
	if _, err := store.Add(
		t.Context(), tenantID, email,
		suppressions.ReasonDSARDeletion, suppressions.SourceManual,
		"hashed-"+campaignID, nil, map[string]any{"test": "hashed_send_boundary"},
	); err != nil {
		t.Fatalf("seed suppression: %v", err)
	}

	// Model privacy erasure: the canonical row keeps only the normalized
	// SHA-256 match and the plaintext mirror is removed. The send-time batch
	// boundary must still map the hit back to the requested queue address.
	sum := sha256.Sum256([]byte(normalizeSuppressionEmail(email)))
	hashHex := hex.EncodeToString(sum[:])
	tx, err := db.WithTenant(t.Context(), pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	if _, err := tx.Exec(t.Context(), `
UPDATE subscriber_suppressions
SET email = $3, email_sha256 = $2
WHERE tenant_id = $1::uuid AND email = $4`,
		tenantID, hashHex, "erased+"+campaignID+"@invalid.postwave.local", email,
	); err != nil {
		t.Fatalf("hash canonical suppression: %v", err)
	}
	if _, err := tx.Exec(t.Context(), `
DELETE FROM email_suppressions
WHERE tenant_id = $1::uuid AND email = $2`, tenantID, email); err != nil {
		t.Fatalf("remove plaintext mirror: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatalf("commit hashed suppression: %v", err)
	}
	storeHits, err := store.LookupBulk(t.Context(), tenantID, []string{email})
	if err != nil {
		t.Fatalf("canonical store hashed batch lookup: %v", err)
	}
	if !storeHits[normalizeSuppressionEmail(email)] {
		t.Fatal("canonical store batch lookup missed DSAR-retained email hash")
	}

	checker := NewSuppressionConvergerAdapter(suppressions.NewConverger(store, nil))
	sender := &mockListmonk{}
	n, err := suppressionTestGuard(pool, sender, checker).RunOnce(t.Context(), tenantID)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if n != 0 || sender.count() != 0 {
		t.Fatalf("attempted=%d sends=%d, want 0/0", n, sender.count())
	}
	if got := countByStatus(t, pool, tenantID, campaignID); got["skipped"] != 1 || len(got) != 1 {
		t.Fatalf("status counts = %v, want skipped=1", got)
	}
}

func TestRunOnce_SuppressionLookupErrorReleasesClaims(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 2, nil, "", "", "")
	sender := &mockListmonk{}
	wantErr := errors.New("suppression database unavailable")

	n, err := suppressionTestGuard(pool, sender, &stubChecker{err: wantErr}).RunOnce(t.Context(), tenantID)
	if !errors.Is(err, wantErr) {
		t.Fatalf("RunOnce error=%v, want suppression outage", err)
	}
	if n != 0 || sender.count() != 0 {
		t.Fatalf("attempted=%d sends=%d, want 0/0", n, sender.count())
	}
	if got := countByStatus(t, pool, tenantID, campaignID); got["pending"] != 2 || len(got) != 1 {
		t.Fatalf("status counts = %v, want pending=2", got)
	}
}

func TestRunOnce_MidBatchSuppressionErrorPersistsPriorSendAndReleasesSuffix(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 3, nil, "", "", "")
	sender := &mockListmonk{}
	wantErr := errors.New("suppression database unavailable")
	checker := &failAfterSuppressionChecker{allowed: 1, err: wantErr}

	n, err := suppressionTestGuard(pool, sender, checker).RunOnce(t.Context(), tenantID)
	if !errors.Is(err, wantErr) {
		t.Fatalf("RunOnce error=%v, want suppression outage", err)
	}
	if n != 1 || sender.count() != 1 {
		t.Fatalf("attempted=%d sends=%d, want 1/1", n, sender.count())
	}
	if got := countByStatus(t, pool, tenantID, campaignID); got["sent"] != 1 || got["pending"] != 2 || len(got) != 2 {
		t.Fatalf("status counts = %v, want sent=1 pending=2", got)
	}
	if got := campaignStatus(t, pool, tenantID, campaignID); got != "sending" {
		t.Fatalf("campaign status=%q, want sending while retryable suffix remains", got)
	}
}

func TestRunOnce_MissingSuppressionGateDoesNotClaim(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 2, nil, "", "", "")
	sender := &mockListmonk{}
	guard := suppressionTestGuard(pool, sender, nil)

	n, err := guard.RunOnce(t.Context(), tenantID)
	if !errors.Is(err, ErrSuppressionGateUnavailable) {
		t.Fatalf("RunOnce error=%v, want ErrSuppressionGateUnavailable", err)
	}
	if n != 0 || sender.count() != 0 {
		t.Fatalf("attempted=%d sends=%d, want 0/0", n, sender.count())
	}
	if got := countByStatus(t, pool, tenantID, campaignID); got["pending"] != 2 || len(got) != 1 {
		t.Fatalf("status counts = %v, want pending=2", got)
	}
}

func TestRunOnce_IncompleteSuppressionBatchReleasesClaims(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 2, nil, "", "", "")
	sender := &mockListmonk{}
	checker := &stubBatchChecker{decisions: map[string]SuppressionDecision{}}
	warmup := NewMemoryWarmupTracker()
	now := time.Now()
	if err := warmup.Start(t.Context(), tenantID, now, 1_000); err != nil {
		t.Fatalf("start warmup: %v", err)
	}
	guard := suppressionTestGuard(pool, sender, checker)
	guard.Warmup = warmup

	n, err := guard.RunOnce(t.Context(), tenantID)
	if !errors.Is(err, ErrSuppressionBatchIncomplete) {
		t.Fatalf("RunOnce error=%v, want ErrSuppressionBatchIncomplete", err)
	}
	if n != 0 || sender.count() != 0 {
		t.Fatalf("attempted=%d sends=%d, want 0/0", n, sender.count())
	}
	if got := countByStatus(t, pool, tenantID, campaignID); got["pending"] != 2 || len(got) != 1 {
		t.Fatalf("status counts = %v, want pending=2", got)
	}
	state, err := warmup.Get(t.Context(), tenantID)
	if err != nil {
		t.Fatalf("warmup state: %v", err)
	}
	if sent := state.DailySent[dayKey(now)]; sent != 0 {
		t.Fatalf("unavailable suppression decision consumed %d warmup sends, want 0", sent)
	}
}

func TestRunOnce_QuietHoursDefers(t *testing.T) {
	pool := requireDB(t)
	// Force a quiet window covering "right now". Use the current UTC hour
	// as the start, +2h as the end. Window is in UTC.
	now := time.Now().UTC()
	startHM := fmt.Sprintf("%02d:00", now.Hour())
	endH := (now.Hour() + 2) % 24
	endHM := fmt.Sprintf("%02d:00", endH)
	tenantID, campaignID := fixtureTenant(t, pool, 5, nil, startHM, endHM, "UTC")

	mock := &mockListmonk{}
	g := &Guard{
		Pool:         pool,
		Listmonk:     mock,
		RateLimit:    &PostgresRateLimiter{Pool: pool, Window: time.Hour},
		QuietHours:   &QuietHoursChecker{Pool: pool},
		Suppressions: &stubChecker{},
		BatchSize:    10,
	}
	n, err := g.RunOnce(context.Background(), tenantID)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if n != 0 {
		t.Errorf("RunOnce sent %d during quiet hours, want 0", n)
	}
	if mock.count() != 0 {
		t.Errorf("listmonk got %d sends during quiet hours, want 0", mock.count())
	}
	got := countByStatus(t, pool, tenantID, campaignID)
	if got["pending"] != 5 || len(got) != 1 {
		t.Errorf("status counts = %v, want pending=5", got)
	}
	if got := campaignStatus(t, pool, tenantID, campaignID); got != "sending" {
		t.Errorf("campaign status = %q, want sending while recipients are deferred", got)
	}
}

func TestRunOnce_RateLimited(t *testing.T) {
	pool := requireDB(t)
	cap := 3
	tenantID, campaignID := fixtureTenant(t, pool, 5, &cap, "", "", "")

	mock := &mockListmonk{}
	g := &Guard{
		Pool:         pool,
		Listmonk:     mock,
		RateLimit:    &PostgresRateLimiter{Pool: pool, Window: time.Hour},
		QuietHours:   &QuietHoursChecker{Pool: pool},
		Suppressions: &stubChecker{},
		BatchSize:    10,
	}
	n, err := g.RunOnce(context.Background(), tenantID)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	// First pass should send 3 (= cap), then bail. The remaining 2 stay
	// pending for the next pass.
	if n != cap {
		t.Errorf("RunOnce sent %d, want %d (cap)", n, cap)
	}
	got := countByStatus(t, pool, tenantID, campaignID)
	if got["sent"] != cap || got["pending"] != 2 {
		t.Errorf("status counts = %v, want sent=%d pending=2", got, cap)
	}
	if got := campaignStatus(t, pool, tenantID, campaignID); got != "sending" {
		t.Errorf("campaign status = %q, want sending while recipients are rate-limited", got)
	}

	// Use a short-window limiter on a separate Guard instance to verify
	// that rotating the bucket window allows the remaining sends.
	g2 := &Guard{
		Pool:         pool,
		Listmonk:     mock,
		RateLimit:    &PostgresRateLimiter{Pool: pool, Window: 50 * time.Millisecond},
		QuietHours:   &QuietHoursChecker{Pool: pool},
		Suppressions: &stubChecker{},
		BatchSize:    10,
	}
	// Wait for the bucket window to elapse.
	time.Sleep(100 * time.Millisecond)
	n2, err := g2.RunOnce(context.Background(), tenantID)
	if err != nil {
		t.Fatalf("RunOnce 2: %v", err)
	}
	if n2 != 2 {
		t.Errorf("post-window RunOnce sent %d, want 2", n2)
	}
	if got := campaignStatus(t, pool, tenantID, campaignID); got != "sent" {
		t.Errorf("campaign status = %q after final recipients, want sent", got)
	}
}

func TestRunOnce_RateLimiterErrorPersistsPriorResultAndReleasesUnsentClaims(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 3, nil, "", "", "")

	mock := &mockListmonk{}
	g := &Guard{
		Pool:         pool,
		Listmonk:     mock,
		RateLimit:    &failAfterRateLimiter{allowed: 1, err: errors.New("limiter unavailable")},
		QuietHours:   &QuietHoursChecker{Pool: pool},
		Suppressions: &stubChecker{},
		BatchSize:    10,
	}
	n, err := g.RunOnce(context.Background(), tenantID)
	if err == nil || !strings.Contains(err.Error(), "limiter unavailable") {
		t.Fatalf("RunOnce error = %v, want limiter unavailable", err)
	}
	if n != 1 || mock.count() != 1 {
		t.Errorf("attempted=%d upstream sends=%d, want 1 and 1", n, mock.count())
	}
	if got := countByStatus(t, pool, tenantID, campaignID); got["sent"] != 1 || got["pending"] != 2 || len(got) != 2 {
		t.Errorf("status counts = %v, want sent=1 pending=2", got)
	}
	if got := campaignStatus(t, pool, tenantID, campaignID); got != "sending" {
		t.Errorf("campaign status = %q, want sending after limiter failure", got)
	}
}

func TestMaybeTransitionCampaignsSentBulk_DoesNotCompleteWithInFlightRecipient(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 2, nil, "", "", "")

	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(context.Background(), `
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY id) AS n
  FROM campaign_recipients
  WHERE campaign_id = $1::uuid
)
UPDATE campaign_recipients cr
SET status = CASE WHEN ordered.n = 1 THEN 'sent' ELSE 'sending' END,
    sent_at = CASE WHEN ordered.n = 1 THEN now() ELSE NULL END,
    claimed_at = CASE WHEN ordered.n = 2 THEN now() ELSE NULL END
FROM ordered
WHERE cr.id = ordered.id`, campaignID); err != nil {
		t.Fatalf("prepare mixed recipient states: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit mixed recipient states: %v", err)
	}

	g := &Guard{Pool: pool}
	g.maybeTransitionCampaignsSentBulk(context.Background(), tenantID, []string{campaignID})
	if got := campaignStatus(t, pool, tenantID, campaignID); got != "sending" {
		t.Errorf("campaign status = %q, want sending while one recipient is in flight", got)
	}
}

func TestRunOnce_Cancellation(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 4, nil, "", "", "")

	// Flip campaign out of 'sending' so the SELECT join filter excludes
	// it, and flip pending recipients to 'cancelled' (the status the
	// campaigns.Repo.SetStatus path uses on cancel). NB: the campaigns
	// table's status CHECK constraint pre-dates the X1 send-domain work
	// and does NOT allow 'cancelled' as a status — campaigns.SetStatus
	// is therefore broken at the SQL level, but that's outside this
	// task's scope. We use 'paused' here to model the same drain
	// behaviour: the join in RunOnce filters on c.status='sending', and
	// 'paused' fails that filter just as 'cancelled' would.
	tx, txErr := db.WithTenant(context.Background(), pool, tenantID)
	if txErr != nil {
		t.Fatalf("WithTenant: %v", txErr)
	}
	if _, err := tx.Exec(context.Background(),
		`UPDATE campaigns SET status='paused' WHERE id=$1::uuid`, campaignID); err != nil {
		t.Fatalf("flip campaign: %v", err)
	}
	if _, err := tx.Exec(context.Background(),
		`UPDATE campaign_recipients SET status='cancelled'
         WHERE campaign_id=$1::uuid AND status='pending'`, campaignID); err != nil {
		t.Fatalf("flip recipients: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit: %v", err)
	}

	mock := &mockListmonk{}
	g := &Guard{
		Pool:         pool,
		Listmonk:     mock,
		RateLimit:    &PostgresRateLimiter{Pool: pool, Window: time.Hour},
		QuietHours:   &QuietHoursChecker{Pool: pool},
		Suppressions: &stubChecker{},
		BatchSize:    10,
	}
	n, txErr := g.RunOnce(context.Background(), tenantID)
	if txErr != nil {
		t.Fatalf("RunOnce: %v", txErr)
	}
	if n != 0 {
		t.Errorf("RunOnce on cancelled campaign sent %d, want 0", n)
	}
	if mock.count() != 0 {
		t.Errorf("listmonk got %d sends after cancel, want 0", mock.count())
	}
	got := countByStatus(t, pool, tenantID, campaignID)
	if got["cancelled"] != 4 {
		t.Errorf("cancelled rows = %v, want cancelled=4", got)
	}
}

func TestPostgresRateLimiter_DenyAfterCap(t *testing.T) {
	pool := requireDB(t)
	cap := 2
	tenantID, _ := fixtureTenant(t, pool, 0, &cap, "", "", "")

	rl := &PostgresRateLimiter{Pool: pool, Window: time.Hour}
	for i := 0; i < cap; i++ {
		ok, _, err := rl.Try(context.Background(), tenantID, 1)
		if err != nil {
			t.Fatalf("Try %d: %v", i, err)
		}
		if !ok {
			t.Fatalf("Try %d: not allowed; want allowed", i)
		}
	}
	// (cap+1)th must be denied.
	ok, retryAt, err := rl.Try(context.Background(), tenantID, 1)
	if err != nil {
		t.Fatalf("over-cap Try: %v", err)
	}
	if ok {
		t.Errorf("over-cap Try allowed; want denied")
	}
	if retryAt.IsZero() {
		t.Errorf("denied Try should return a non-zero retryAt")
	}
}

func TestPostgresRateLimiter_UncappedAllowsAll(t *testing.T) {
	pool := requireDB(t)
	// No settings row → uncapped.
	tenantID, _ := fixtureTenant(t, pool, 0, nil, "", "", "")

	rl := &PostgresRateLimiter{Pool: pool, Window: time.Hour}
	for i := 0; i < 100; i++ {
		ok, _, err := rl.Try(context.Background(), tenantID, 1)
		if err != nil {
			t.Fatalf("uncapped Try %d: %v", i, err)
		}
		if !ok {
			t.Errorf("uncapped Try %d denied", i)
		}
	}
}

func TestPostgresRateLimiter_WindowReset(t *testing.T) {
	pool := requireDB(t)
	cap := 2
	tenantID, _ := fixtureTenant(t, pool, 0, &cap, "", "", "")

	// Use a window comfortably larger than the time it takes to fill +
	// re-check the bucket so the "denied" assertion is not racy.
	const window = 500 * time.Millisecond
	rl := &PostgresRateLimiter{Pool: pool, Window: window}
	for i := 0; i < cap; i++ {
		ok, _, err := rl.Try(context.Background(), tenantID, 1)
		if err != nil || !ok {
			t.Fatalf("fill Try %d: ok=%v err=%v", i, ok, err)
		}
	}
	// Denied immediately while window is still open.
	ok, _, err := rl.Try(context.Background(), tenantID, 1)
	if err != nil {
		t.Fatalf("over-cap Try: %v", err)
	}
	if ok {
		t.Fatalf("expected denied after cap")
	}
	// Wait long enough for the window to elapse, then verify reset.
	time.Sleep(window + 100*time.Millisecond)
	ok2, _, err := rl.Try(context.Background(), tenantID, 1)
	if err != nil {
		t.Fatalf("post-window: %v", err)
	}
	if !ok2 {
		t.Errorf("post-window Try denied; want allowed (bucket reset)")
	}
}

func TestRunOnce_HardFailureMarksFailed(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 1, nil, "", "", "")

	mock := &mockListmonk{failNext: errors.New("boom from listmonk")}
	g := &Guard{
		Pool:         pool,
		Listmonk:     mock,
		RateLimit:    &PostgresRateLimiter{Pool: pool, Window: time.Hour},
		QuietHours:   &QuietHoursChecker{Pool: pool},
		Suppressions: &stubChecker{},
		BatchSize:    5,
	}
	n, err := g.RunOnce(context.Background(), tenantID)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if n != 1 {
		t.Errorf("RunOnce attempted %d, want 1", n)
	}
	got := countByStatus(t, pool, tenantID, campaignID)
	if got["failed"] != 1 {
		t.Errorf("status counts = %v, want failed=1", got)
	}
}

// --- Loop sanity: contracting context must cause Loop to exit promptly.
func TestLoop_StopsOnContextCancel(t *testing.T) {
	pool := requireDB(t)
	g := &Guard{
		Pool:         pool,
		Listmonk:     &mockListmonk{},
		RateLimit:    &PostgresRateLimiter{Pool: pool, Window: time.Hour},
		QuietHours:   &QuietHoursChecker{Pool: pool},
		Suppressions: &stubChecker{},
		LoopInterval: 10 * time.Millisecond,
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- g.Loop(ctx) }()
	time.Sleep(30 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Loop returned err: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Loop did not return within 2s of cancel")
	}
}
