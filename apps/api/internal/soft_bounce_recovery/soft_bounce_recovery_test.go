package soft_bounce_recovery

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestRecoverTenantRejectsUnsafeInputs(t *testing.T) {
	ctx := context.Background()
	if _, err := RecoverTenant(ctx, nil, "tenant", DefaultRecoveryWindow); err == nil {
		t.Fatal("nil pool: expected error")
	}
	pool := new(db.Pool)
	if _, err := RecoverTenant(ctx, pool, "", DefaultRecoveryWindow); err == nil {
		t.Fatal("empty tenant: expected error")
	}
	if _, err := RecoverTenant(ctx, pool, "tenant", 0); err == nil {
		t.Fatal("zero recovery window: expected error")
	}
	if _, err := RecoverTenant(ctx, pool, "tenant", -time.Hour); err == nil {
		t.Fatal("negative recovery window: expected error")
	}
}

func TestRecoverTenantPreservesDisabledStatusAndAuditsTransientExpiry(t *testing.T) {
	pool := recoveryDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	tenantID := setupRecoveryTenant(t, pool, ctx, "preserve-disabled")
	const email = "disabled-soft-bounce@example.test"
	seedRecoverySubscriber(t, pool, ctx, tenantID, email, "disabled")
	seedRecoveryBounce(t, pool, ctx, tenantID, "DISABLED-SOFT-BOUNCE@EXAMPLE.TEST", "soft", time.Now().UTC().Add(-30*24*time.Hour))
	suppressionID := seedRecoverySuppression(t, pool, ctx, tenantID, email,
		"soft_bounce_threshold", timePtr(time.Now().UTC().Add(-time.Hour)))
	seedLinkedLegacyRecoverySuppression(t, pool, ctx, tenantID, email, suppressionID,
		time.Now().UTC().Add(-time.Hour))

	expired, err := RecoverTenant(ctx, pool, tenantID, DefaultRecoveryWindow)
	if err != nil {
		t.Fatalf("RecoverTenant: %v", err)
	}
	if expired != 1 {
		t.Fatalf("expired = %d, want 1", expired)
	}

	status, consentPresent := recoverySubscriberState(t, pool, ctx, tenantID, email)
	if status != "disabled" {
		t.Fatalf("subscriber status = %q, want disabled; bounce recovery must never reactivate", status)
	}
	if consentPresent {
		t.Fatal("fixture unexpectedly has purpose consent; bounce counters must not manufacture it")
	}
	if got := recoveryCount(t, pool, ctx, tenantID,
		`SELECT count(*) FROM subscriber_suppressions WHERE tenant_id=$1::uuid AND email=$2::citext`, email); got != 0 {
		t.Fatalf("canonical suppression count = %d, want 0", got)
	}
	if got := recoveryCount(t, pool, ctx, tenantID,
		`SELECT count(*) FROM email_suppressions WHERE tenant_id=$1::uuid AND email=$2::citext`, email); got != 0 {
		t.Fatalf("linked legacy suppression count = %d, want 0", got)
	}
	if got := recoveryCount(t, pool, ctx, tenantID, `
SELECT count(*) FROM suppression_audit
 WHERE tenant_id=$1::uuid AND email=$2::citext AND action='expire'
   AND source_table IN ('subscriber_suppressions','email_suppressions')`, email); got != 2 {
		t.Fatalf("transactional expire audit count = %d, want 2", got)
	}
}

func TestRecoverTenantHostileEligibilityMatrixPreservesEveryLifecycle(t *testing.T) {
	pool := recoveryDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	now := time.Now().UTC()
	old := now.Add(-30 * 24 * time.Hour)
	recent := now.Add(-24 * time.Hour)
	pastExpiry := now.Add(-time.Hour)
	futureExpiry := now.Add(24 * time.Hour)

	tenantID := setupRecoveryTenant(t, pool, ctx, "hostile-matrix")
	type fixture struct {
		email      string
		status     string
		reason     string
		expiresAt  *time.Time
		bounces    []recoveryBounce
		exactGrant bool
		wantDelete bool
	}
	fixtures := []fixture{
		{
			email: "eligible-enabled@example.test", status: "enabled",
			reason: "soft_bounce_threshold", expiresAt: &pastExpiry,
			bounces: []recoveryBounce{{kind: "soft", at: old}}, wantDelete: true,
		},
		{
			email: "eligible-blocklisted@example.test", status: "blocklisted",
			reason: "soft_bounce_threshold", expiresAt: &pastExpiry,
			bounces: []recoveryBounce{{kind: "soft", at: old}}, wantDelete: true,
		},
		{
			email: "fully-consented-disabled@example.test", status: "disabled",
			reason: "soft_bounce_threshold", expiresAt: &pastExpiry,
			bounces:    []recoveryBounce{{kind: "soft", at: old}},
			exactGrant: true, wantDelete: true,
		},
		{
			email: "active-disabled@example.test", status: "disabled",
			reason: "soft_bounce_threshold", expiresAt: &futureExpiry,
			bounces: []recoveryBounce{{kind: "soft", at: old}},
		},
		{
			email: "recent-soft-disabled@example.test", status: "disabled",
			reason: "soft_bounce_threshold", expiresAt: &pastExpiry,
			bounces: []recoveryBounce{{kind: "soft", at: recent}},
		},
		{
			email: "new-hard-disabled@example.test", status: "disabled",
			reason: "soft_bounce_threshold", expiresAt: &pastExpiry,
			bounces: []recoveryBounce{{kind: "soft", at: old}, {kind: "hard", at: recent}},
		},
		{
			email: "permanent-hard-disabled@example.test", status: "disabled",
			reason: "hard_bounce", expiresAt: &pastExpiry,
			bounces: []recoveryBounce{{kind: "soft", at: old}},
		},
		{
			email: "nonexpiring-soft-disabled@example.test", status: "disabled",
			reason: "soft_bounce_threshold", expiresAt: nil,
			bounces: []recoveryBounce{{kind: "soft", at: old}},
		},
	}
	for _, f := range fixtures {
		seedRecoverySubscriber(t, pool, ctx, tenantID, f.email, f.status)
		if f.exactGrant {
			seedRecoveryExactGrant(t, pool, ctx, tenantID, f.email)
		}
		for _, bounce := range f.bounces {
			seedRecoveryBounce(t, pool, ctx, tenantID, f.email, bounce.kind, bounce.at)
		}
		seedRecoverySuppression(t, pool, ctx, tenantID, f.email, f.reason, f.expiresAt)
	}

	otherTenant := setupRecoveryTenant(t, pool, ctx, "hostile-other-tenant")
	const otherEmail = "other-tenant@example.test"
	seedRecoverySubscriber(t, pool, ctx, otherTenant, otherEmail, "disabled")
	seedRecoveryBounce(t, pool, ctx, otherTenant, otherEmail, "soft", old)
	seedRecoverySuppression(t, pool, ctx, otherTenant, otherEmail,
		"soft_bounce_threshold", &pastExpiry)

	expired, err := RecoverTenant(ctx, pool, tenantID, DefaultRecoveryWindow)
	if err != nil {
		t.Fatalf("RecoverTenant: %v", err)
	}
	if expired != 3 {
		t.Fatalf("expired = %d, want the three eligible tenant-scoped rows", expired)
	}
	for _, f := range fixtures {
		status, consentPresent := recoverySubscriberState(t, pool, ctx, tenantID, f.email)
		if status != f.status {
			t.Errorf("%s lifecycle = %q, want preserved %q", f.email, status, f.status)
		}
		if f.exactGrant && !consentPresent {
			t.Errorf("%s lost its purpose-consent projection", f.email)
		}
		gotCount := recoveryCount(t, pool, ctx, tenantID,
			`SELECT count(*) FROM subscriber_suppressions WHERE tenant_id=$1::uuid AND email=$2::citext`, f.email)
		wantCount := int64(1)
		if f.wantDelete {
			wantCount = 0
		}
		if gotCount != wantCount {
			t.Errorf("%s suppression count = %d, want %d", f.email, gotCount, wantCount)
		}
	}
	if got := recoveryCount(t, pool, ctx, otherTenant,
		`SELECT count(*) FROM subscriber_suppressions WHERE tenant_id=$1::uuid AND email=$2::citext`, otherEmail); got != 1 {
		t.Fatalf("cross-tenant suppression count = %d, want untouched 1", got)
	}
	if status, _ := recoverySubscriberState(t, pool, ctx, otherTenant, otherEmail); status != "disabled" {
		t.Fatalf("cross-tenant subscriber status = %q, want disabled", status)
	}
}

func TestRecoverTenantSkipsConcurrentlyReclassifiedSuppression(t *testing.T) {
	pool := recoveryDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	now := time.Now().UTC()
	tenantID := setupRecoveryTenant(t, pool, ctx, "concurrent-reclassify")
	const email = "concurrent@example.test"
	seedRecoverySubscriber(t, pool, ctx, tenantID, email, "disabled")
	seedRecoveryBounce(t, pool, ctx, tenantID, email, "soft", now.Add(-30*24*time.Hour))
	suppressionID := seedRecoverySuppression(t, pool, ctx, tenantID, email,
		"soft_bounce_threshold", timePtr(now.Add(-time.Hour)))

	lockTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin reclassification tx: %v", err)
	}
	defer func() { _ = lockTx.Rollback(ctx) }()
	var lockedID string
	if err := lockTx.QueryRow(ctx, `
SELECT id::text FROM subscriber_suppressions
 WHERE tenant_id=$1::uuid AND id=$2::uuid
 FOR UPDATE`, tenantID, suppressionID).Scan(&lockedID); err != nil {
		t.Fatalf("lock suppression: %v", err)
	}

	type recoveryResult struct {
		n   int
		err error
	}
	resultCh := make(chan recoveryResult, 1)
	go func() {
		n, recoverErr := RecoverTenant(ctx, pool, tenantID, DefaultRecoveryWindow)
		resultCh <- recoveryResult{n: n, err: recoverErr}
	}()
	select {
	case result := <-resultCh:
		if result.err != nil || result.n != 0 {
			t.Fatalf("locked recovery = (%d, %v), want (0, nil)", result.n, result.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("recovery blocked on concurrently reviewed row; expected SKIP LOCKED")
	}

	if _, err := lockTx.Exec(ctx, `
UPDATE subscriber_suppressions
   SET reason='hard_bounce', expires_at=NULL
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, suppressionID); err != nil {
		t.Fatalf("reclassify suppression: %v", err)
	}
	if err := lockTx.Commit(ctx); err != nil {
		t.Fatalf("commit reclassification: %v", err)
	}

	if n, err := RecoverTenant(ctx, pool, tenantID, DefaultRecoveryWindow); err != nil || n != 0 {
		t.Fatalf("post-reclassification recovery = (%d, %v), want (0, nil)", n, err)
	}
	status, _ := recoverySubscriberState(t, pool, ctx, tenantID, email)
	if status != "disabled" {
		t.Fatalf("subscriber status = %q, want disabled", status)
	}
	if got := recoveryCount(t, pool, ctx, tenantID, `
SELECT count(*) FROM subscriber_suppressions
 WHERE tenant_id=$1::uuid AND email=$2::citext AND reason='hard_bounce' AND expires_at IS NULL`, email); got != 1 {
		t.Fatalf("reclassified hard-bounce rows = %d, want 1", got)
	}
	if got := recoveryCount(t, pool, ctx, tenantID, `
SELECT count(*) FROM suppression_audit
 WHERE tenant_id=$1::uuid AND email=$2::citext AND action='expire'`, email); got != 0 {
		t.Fatalf("expire audit rows = %d, want 0 for skipped/reclassified row", got)
	}
}

func TestHTTPCompatibilityNeverReportsSubscriberReactivation(t *testing.T) {
	pool := recoveryDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	now := time.Now().UTC()
	tenantID := setupRecoveryTenant(t, pool, ctx, "http-honest-counts")
	const email = "http-disabled@example.test"
	seedRecoverySubscriber(t, pool, ctx, tenantID, email, "disabled")
	seedRecoveryBounce(t, pool, ctx, tenantID, email, "soft", now.Add(-30*24*time.Hour))
	seedRecoverySuppression(t, pool, ctx, tenantID, email,
		"soft_bounce_threshold", timePtr(now.Add(-time.Hour)))

	deps := &Deps{Pool: pool}
	statsRec := httptest.NewRecorder()
	statsReq := httptest.NewRequest(http.MethodGet, "/api/v1/soft-bounce-recovery/stats", nil)
	statsReq = statsReq.WithContext(middleware.WithTenant(statsReq.Context(), &middleware.Tenant{ID: tenantID}))
	deps.Stats(statsRec, statsReq)
	if statsRec.Code != http.StatusOK {
		t.Fatalf("stats status = %d; body=%s", statsRec.Code, statsRec.Body.String())
	}
	var stats map[string]any
	if err := json.Unmarshal(statsRec.Body.Bytes(), &stats); err != nil {
		t.Fatalf("decode stats: %v", err)
	}
	if stats["eligible_now"] != float64(0) || stats["eligible_suppressions_now"] != float64(1) {
		t.Fatalf("stats = %#v, want eligible_now=0 and eligible_suppressions_now=1", stats)
	}
	if stats["automatic_reactivation_active"] != false {
		t.Fatalf("stats automatic_reactivation_active = %#v, want false", stats["automatic_reactivation_active"])
	}

	runRec := httptest.NewRecorder()
	runReq := httptest.NewRequest(http.MethodPost, "/api/v1/soft-bounce-recovery/run-now", nil)
	runReq = runReq.WithContext(middleware.WithTenant(runReq.Context(), &middleware.Tenant{ID: tenantID}))
	deps.RunNow(runRec, runReq)
	if runRec.Code != http.StatusOK {
		t.Fatalf("run-now status = %d; body=%s", runRec.Code, runRec.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(runRec.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode run-now: %v", err)
	}
	if result["recovered"] != float64(0) || result["expired_suppressions"] != float64(1) {
		t.Fatalf("run-now = %#v, want recovered=0 and expired_suppressions=1", result)
	}
	if status, _ := recoverySubscriberState(t, pool, ctx, tenantID, email); status != "disabled" {
		t.Fatalf("subscriber status after HTTP run = %q, want disabled", status)
	}
}

type recoveryBounce struct {
	kind string
	at   time.Time
}

func recoveryDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping soft-bounce recovery PostgreSQL test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func setupRecoveryTenant(t *testing.T, pool *db.Pool, ctx context.Context, hint string) string {
	t.Helper()
	var tenantID string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("generate tenant id: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	name := fmt.Sprintf("soft-bounce-%s-%d", hint, time.Now().UnixNano())
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, name); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
		_ = cleanupTx.Commit(cleanupCtx)
	})
	return tenantID
}

func seedRecoverySubscriber(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, email, status string,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin subscriber fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, $3, 'unknown')`, tenantID, email, status); err != nil {
		t.Fatalf("insert subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber fixture: %v", err)
	}
}

// seedRecoveryExactGrant gives a disabled fixture the strongest current
// delivery evidence available: purpose projection plus an exact-address grant
// with reviewed structured proof. Recovery still must preserve the disabled
// lifecycle state because this package chose strict lifecycle preservation,
// not evidence-based autonomous reactivation.
func seedRecoveryExactGrant(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, email string,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin exact-grant fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var subscriberID, addressID string
	if err := tx.QueryRow(ctx, `
SELECT id::text FROM subscribers
 WHERE tenant_id=$1::uuid AND email=$2::citext`, tenantID, email).Scan(&subscriberID); err != nil {
		t.Fatalf("resolve subscriber for exact grant: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT id::text FROM subscriber_emails
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid
   AND lower(email::text)=lower($3::text)`, tenantID, subscriberID, email).Scan(&addressID); err != nil {
		t.Fatalf("resolve canonical address for exact grant: %v", err)
	}
	var eventID string
	occurredAt := time.Now().UTC().Add(-time.Minute)
	if err := tx.QueryRow(ctx, `
INSERT INTO consent_events
       (tenant_id, subject_type, subject_id, subject_email, channel,
	        category, action, source, policy_version, preferences, proof_text,
	        created_at)
VALUES ($1::uuid, 'subscriber', $3, $4::citext, 'api',
	        'email_marketing', 'granted', 'direct_request', 'recovery-test-v1',
	        jsonb_build_object(
	            'subscriber_id', $2::text,
	            'address_id', $3::text,
	            'consent_status', 'subscribed',
	            'legal_basis', 'consent',
	            'jurisdiction', 'US',
	            'reason', 'reviewed recovery fixture'
	        ),
	        'hostile recovery fixture: reviewed exact-address consent', $5)
RETURNING id::text`, tenantID, subscriberID, addressID, email, occurredAt).Scan(&eventID); err != nil {
		t.Fatalf("insert exact grant evidence: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO consent_records
       (tenant_id, subscriber_id, email, channel, consent_status, source,
	        captured_at, expires_at, evidence)
VALUES ($1::uuid, $2::uuid, $3::citext, 'email', 'granted', 'admin',
	        $5::timestamptz, $5::timestamptz + interval '365 days',
	        jsonb_build_object(
	            'event_id', $4::text,
	            'address_id', $6::text,
	            'legal_basis', 'consent',
	            'jurisdiction', 'US',
	            'reason', 'reviewed recovery fixture',
	            'policy_version', 'recovery-test-v1',
	            'evidence', 'hostile recovery fixture: reviewed exact-address consent'
	        ))`, tenantID, subscriberID, email, eventID, occurredAt, addressID); err != nil {
		t.Fatalf("insert exact grant record: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit exact-grant fixture: %v", err)
	}
}

func seedRecoveryBounce(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, email, kind string,
	at time.Time,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin bounce fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_events
       (tenant_id, subscriber_email, event_type, bounce_type, at)
VALUES ($1::uuid, $2, 'bounced', $3, $4)`, tenantID, email, kind, at); err != nil {
		t.Fatalf("insert %s bounce for %s: %v", kind, email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit bounce fixture: %v", err)
	}
}

func seedRecoverySuppression(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, email, reason string,
	expiresAt *time.Time,
) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin suppression fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_suppressions
       (tenant_id, email, reason, source, expires_at, metadata)
VALUES ($1::uuid, $2, $3, 'manual', $4, '{"fixture":"soft_bounce_recovery"}'::jsonb)
RETURNING id::text`, tenantID, email, reason, expiresAt).Scan(&id); err != nil {
		t.Fatalf("insert suppression %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit suppression fixture: %v", err)
	}
	return id
}

func seedLinkedLegacyRecoverySuppression(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, email, suppressionID string,
	expiresAt time.Time,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin legacy suppression fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO email_suppressions
       (tenant_id, email, reason, source, expires_at, metadata)
VALUES ($1::uuid, $2, 'soft_bounce', 'manual', $3,
        jsonb_build_object($4::text, $5::text))`,
		tenantID, email, expiresAt, legacyMirrorSuppressionIDKey, suppressionID); err != nil {
		t.Fatalf("insert linked legacy suppression: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit legacy suppression fixture: %v", err)
	}
}

func recoverySubscriberState(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, email string,
) (status string, consentPresent bool) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin subscriber assertion: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
SELECT status, consent_email_marketing_at IS NOT NULL
  FROM subscribers
 WHERE tenant_id=$1::uuid AND email=$2::citext`, tenantID, email).Scan(&status, &consentPresent); err != nil {
		t.Fatalf("read subscriber state %s: %v", email, err)
	}
	return status, consentPresent
}

func recoveryCount(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, query, email string,
) int64 {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin count assertion: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int64
	if err := tx.QueryRow(ctx, query, tenantID, email).Scan(&count); err != nil {
		t.Fatalf("count query for %s: %v", email, err)
	}
	return count
}

func timePtr(v time.Time) *time.Time { return &v }
