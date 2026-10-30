// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// The v2 signed-ingest secret is an HMAC key: whoever holds it can post
// conversions as this tenant. Until now it existed only as a row a test
// inserted — there was no way for a tenant to obtain one except direct SQL.
//
// These tests are about the two properties that make a secret manageable
// rather than merely stored: it is disclosed EXACTLY once, and rotating it
// never requires a window with no working key.

// secretsSeedPool connects the way every other database proof in this package
// does, through DATABASE_URL, which CI points at the restricted postwave_app
// role. These tests used to read a variable of their own that no CI job set, so
// all eight skipped in CI. That variable also had to name postwave_app, because
// db.New refuses a role that can bypass RLS, and its name did not say so.
func secretsSeedPool(t *testing.T, ctx context.Context) *db.Pool {
	t.Helper()
	pool := attributionDB(t)
	var ready bool
	if err := pool.QueryRow(ctx,
		`SELECT to_regclass('public.conversion_ingest_secrets') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatalf("inspect schema: %v", err)
	}
	if !ready {
		t.Fatal("database is missing conversion_ingest_secrets")
	}
	return pool
}

// resolvedTenantForKey asks the public resolver which tenant a key id names,
// through the fixed SECURITY DEFINER function that ResolveSignedCaller queries.
// It returns "" when the resolver admits no row.
//
// The public endpoint reads this table through the resolver before any tenant
// is bound, so the resolver is the only honest probe of resolution. Under
// postwave_app a plain SELECT with no app.tenant_id matches no row, revoked or
// not, and a SELECT that filters on revoked_at itself never asks the resolver.
func resolvedTenantForKey(t *testing.T, ctx context.Context, pool *db.Pool, keyID string) string {
	t.Helper()
	var tenantID string
	err := pool.QueryRow(ctx, `
SELECT tenant_id::text FROM public.resolve_conversion_ingest_secret($1)`, keyID).Scan(&tenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ""
	}
	if err != nil {
		t.Fatalf("resolve key %s: %v", keyID, err)
	}
	return tenantID
}

func seedSecretsTenant(t *testing.T, ctx context.Context, pool *db.Pool) string {
	t.Helper()
	tenantID := uuid.NewString()
	suffix := strings.ReplaceAll(tenantID, "-", "")[:16]
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tenant seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind tenant seed: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, $3, 'sending')`,
		tenantID, "secrets-"+suffix, "Secrets "+suffix); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	t.Cleanup(func() {
		cleanup, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(context.Background()) }()
		_, _ = cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(context.Background())
	})
	return tenantID
}

func encryptedSecretsTestStore(pool *db.Pool) *IngestSecretStore {
	return &IngestSecretStore{
		Pool: pool,
		Cipher: &ingestSecretCipherStub{
			envelope: []byte{0x02, 's', 'e', 'a', 'l', 'e', 'd'},
		},
	}
}

// mustJSON serializes a summary so the leak assertion inspects the whole wire
// value rather than the fields the test happens to know about.
func mustJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(raw)
}

func TestIssuedSecretIsReturnedOnceAndNeverListed(t *testing.T) {
	ctx := context.Background()
	pool := secretsSeedPool(t, ctx)
	store := encryptedSecretsTestStore(pool)
	tenantID := seedSecretsTenant(t, ctx, pool)

	issued, err := store.Issue(ctx, tenantID, "shop backend")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if strings.TrimSpace(issued.Secret) == "" {
		t.Fatal("issuance must return the secret; it can never be recovered later")
	}
	if strings.TrimSpace(issued.KeyID) == "" {
		t.Fatal("issuance must return the key id the caller signs with")
	}
	if issued.Status != ProjectionStatusPending || issued.ErrorCode != "" ||
		issued.UpdatedAt.IsZero() {
		t.Fatalf("new key must disclose non-null pending projection metadata: %+v", issued)
	}
	var storedLegacy string
	var storedEnvelope []byte
	var storedKMSKeyARN string
	storageTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open storage inspection: %v", err)
	}
	defer func() { _ = storageTX.Rollback(ctx) }()
	if err := storageTX.QueryRow(ctx, `
SELECT secret, secret_envelope, secret_kms_key_arn
  FROM conversion_ingest_secrets
 WHERE tenant_id = $1::uuid AND key_id = $2`, tenantID, issued.KeyID).Scan(
		&storedLegacy, &storedEnvelope, &storedKMSKeyARN,
	); err != nil {
		t.Fatalf("inspect encrypted storage: %v", err)
	}
	if storedLegacy != ingestSecretEnvelopeSentinel || len(storedEnvelope) == 0 ||
		bytes.Contains(storedEnvelope, []byte(issued.Secret)) ||
		storedKMSKeyARN != testConversionKMSKeyARN {
		t.Fatalf("issuance did not use non-plaintext envelope storage: sentinel=%q envelope_bytes=%d",
			storedLegacy, len(storedEnvelope))
	}

	listed, err := store.List(ctx, tenantID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(listed) != 1 {
		t.Fatalf("listed %d secrets, want 1", len(listed))
	}
	// The property that matters. A management endpoint that echoes the key
	// turns every read-scoped credential into a write-scoped one.
	if strings.Contains(strings.ToLower(mustJSON(t, listed[0])), strings.ToLower(issued.Secret)) {
		t.Fatal("listing leaked the secret; it must be disclosed only at issuance")
	}
}

// Rotation has to be overlap-first: issue the new key, move traffic, then
// revoke. If a tenant could only ever hold one live key, every rotation would
// require a window where their integration is broken.
func TestRotationAllowsTwoLiveKeysSoThereIsNoOutageWindow(t *testing.T) {
	ctx := context.Background()
	pool := secretsSeedPool(t, ctx)
	store := encryptedSecretsTestStore(pool)
	tenantID := seedSecretsTenant(t, ctx, pool)

	first, err := store.Issue(ctx, tenantID, "current")
	if err != nil {
		t.Fatalf("issue first: %v", err)
	}
	second, err := store.Issue(ctx, tenantID, "rolling")
	if err != nil {
		t.Fatalf("issue second: %v", err)
	}
	if first.KeyID == second.KeyID {
		t.Fatal("each issuance must mint a distinct key id")
	}

	listed, err := store.List(ctx, tenantID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	live := 0
	for _, row := range listed {
		if row.RevokedAt == nil {
			live++
		}
	}
	if live != 2 {
		t.Fatalf("live keys = %d, want 2 during a rotation", live)
	}
}

// Revocation is not deletion. The row is the record that the key existed and
// when it stopped being accepted, which is what an incident review reads.
func TestRevocationRetainsTheRowAndStopsResolution(t *testing.T) {
	ctx := context.Background()
	pool := secretsSeedPool(t, ctx)
	store := encryptedSecretsTestStore(pool)
	tenantID := seedSecretsTenant(t, ctx, pool)

	issued, err := store.Issue(ctx, tenantID, "leaked")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	// A live key resolves to its tenant. Without this control, the miss after
	// revocation could come from a probe that never sees the row at all.
	if got := resolvedTenantForKey(t, ctx, pool, issued.KeyID); got != tenantID {
		t.Fatalf("live key resolved to tenant %q, want %q", got, tenantID)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open HMAC fact seed: %v", err)
	}
	var conversionID int64
	digest := EmailIdentityHMAC(issued.Secret, "retained@example.test")
	if err := tx.QueryRow(ctx, `
INSERT INTO conversions (
    tenant_id, event_name, email_hmac_sha256, email_hmac_key_id
) VALUES ($1::uuid, 'retention-proof', $2, $3)
RETURNING id`, tenantID, digest, issued.KeyID).Scan(&conversionID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed HMAC fact: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO conversion_attribution_touches (
    tenant_id, conversion_id, touch_kind, identity_kind,
    identity_value, identity_key_id, resolution_rank, is_winner
) VALUES ($1::uuid, $2, 'identity', 'email_hmac_sha256', $3, $4, 1, true)`,
		tenantID, conversionID, digest, issued.KeyID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed HMAC touch: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit HMAC evidence: %v", err)
	}

	if err := store.Revoke(ctx, tenantID, issued.KeyID); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	listed, err := store.List(ctx, tenantID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(listed) != 1 || listed[0].RevokedAt == nil {
		t.Fatalf("the revoked key must remain listed with its revocation time: %+v", listed)
	}

	// The public resolver only admits live rows, so a revoked key must no
	// longer resolve — that is what actually stops the leaked credential.
	if got := resolvedTenantForKey(t, ctx, pool, issued.KeyID); got != "" {
		t.Errorf("a revoked key must not remain resolvable; it still resolves to tenant %q", got)
	}

	inspection, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open cryptoshred inspection: %v", err)
	}
	defer func() { _ = inspection.Rollback(ctx) }()
	var tombstone string
	var envelope []byte
	var keyARN *string
	var destroyedAt *time.Time
	if err := inspection.QueryRow(ctx, `
SELECT secret, secret_envelope, secret_kms_key_arn, secret_destroyed_at
  FROM conversion_ingest_secrets
 WHERE tenant_id = $1::uuid AND key_id = $2`, tenantID, issued.KeyID).Scan(
		&tombstone, &envelope, &keyARN, &destroyedAt,
	); err != nil {
		t.Fatalf("inspect cryptoshred receipt: %v", err)
	}
	if tombstone != ingestSecretRevokedTombstone || envelope != nil || keyARN != nil ||
		destroyedAt == nil || destroyedAt.IsZero() {
		t.Fatalf("revoked material retained: tombstone=%q envelope=%d arn=%v destroyed=%v",
			tombstone, len(envelope), keyARN, destroyedAt)
	}
	var factShredded bool
	var liveHMACTouches int
	var shreddedTouchReceipts int
	if err := inspection.QueryRow(ctx, `
SELECT email_hmac_sha256 IS NULL AND email_hmac_key_id IS NULL
  FROM conversions WHERE tenant_id = $1::uuid AND id = $2`,
		tenantID, conversionID).Scan(&factShredded); err != nil {
		t.Fatalf("inspect HMAC fact retention: %v", err)
	}
	if err := inspection.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE identity_kind = 'email_hmac_sha256'),
       count(*) FILTER (
           WHERE identity_kind = 'email_hmac_cryptoshredded'
             AND identity_value = 'revoked:cryptoshredded'
             AND identity_key_id IS NULL
             AND subscriber_id IS NULL
             AND NOT is_winner
       )
  FROM conversion_attribution_touches
 WHERE tenant_id = $1::uuid AND conversion_id = $2`, tenantID, conversionID).Scan(
		&liveHMACTouches, &shreddedTouchReceipts,
	); err != nil {
		t.Fatalf("inspect HMAC touch retention: %v", err)
	}
	if !factShredded || liveHMACTouches != 0 || shreddedTouchReceipts != 1 {
		t.Fatalf("revoked HMAC evidence retained or receipt malformed: fact_shredded=%t live_touches=%d shredded_receipts=%d",
			factShredded, liveHMACTouches, shreddedTouchReceipts)
	}
}

func TestLiveKeyLimitIsConcurrentSafeAndRotationCanContinueAfterRevoke(t *testing.T) {
	ctx := context.Background()
	pool := secretsSeedPool(t, ctx)
	store := encryptedSecretsTestStore(pool)
	tenantID := seedSecretsTenant(t, ctx, pool)

	issued := make([]IssuedSecret, 0, MaxLiveIngestKeys)
	for index := 0; index < MaxLiveIngestKeys-1; index++ {
		key, err := store.Issue(ctx, tenantID, "bounded")
		if err != nil {
			t.Fatalf("issue live key %d: %v", index, err)
		}
		issued = append(issued, key)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			_, err := store.Issue(ctx, tenantID, "concurrent")
			results <- err
		}()
	}
	close(start)
	succeeded, limited := 0, 0
	for range 2 {
		err := <-results
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrSecretLiveLimit):
			limited++
		default:
			t.Fatalf("concurrent cap result: %v", err)
		}
	}
	if succeeded != 1 || limited != 1 {
		t.Fatalf("concurrent live cap outcomes = success %d limited %d", succeeded, limited)
	}
	if err := store.Revoke(ctx, tenantID, issued[0].KeyID); err != nil {
		t.Fatalf("revoke before rotation: %v", err)
	}
	if _, err := store.Issue(ctx, tenantID, "replacement"); err != nil {
		t.Fatalf("issue replacement within cap: %v", err)
	}
}

func TestSigningKeyListUsesStableBoundedPages(t *testing.T) {
	ctx := context.Background()
	pool := secretsSeedPool(t, ctx)
	store := encryptedSecretsTestStore(pool)
	tenantID := seedSecretsTenant(t, ctx, pool)
	for index := 0; index < 5; index++ {
		if _, err := store.Issue(ctx, tenantID, "page"); err != nil {
			t.Fatalf("issue page fixture %d: %v", index, err)
		}
	}

	cursor := pagination.Cursor{}
	seen := map[string]bool{}
	pages := 0
	for {
		page, err := store.ListPage(ctx, tenantID, cursor, 2)
		if err != nil {
			t.Fatalf("list page %d: %v", pages, err)
		}
		if len(page.Items) > 2 {
			t.Fatalf("page %d returned %d items above bound", pages, len(page.Items))
		}
		for _, item := range page.Items {
			if seen[item.KeyID] {
				t.Fatalf("key %s repeated across stable pages", item.KeyID)
			}
			seen[item.KeyID] = true
		}
		pages++
		if page.NextCursor == "" {
			break
		}
		if len(page.NextCursor) > MaxSecretCursorBytes {
			t.Fatalf("cursor is %d bytes", len(page.NextCursor))
		}
		cursor, err = pagination.Decode(page.NextCursor)
		if err != nil {
			t.Fatalf("decode page cursor: %v", err)
		}
	}
	if len(seen) != 5 || pages != 3 {
		t.Fatalf("paged catalog = %d keys over %d pages, want 5/3", len(seen), pages)
	}
}

func TestRevokingTwiceIsReportedRatherThanSilentlyAccepted(t *testing.T) {
	ctx := context.Background()
	pool := secretsSeedPool(t, ctx)
	store := encryptedSecretsTestStore(pool)
	tenantID := seedSecretsTenant(t, ctx, pool)

	issued, err := store.Issue(ctx, tenantID, "once")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if err := store.Revoke(ctx, tenantID, issued.KeyID); err != nil {
		t.Fatalf("first revoke: %v", err)
	}
	if err := store.Revoke(ctx, tenantID, issued.KeyID); !errors.Is(err, ErrSecretNotLive) {
		t.Fatalf("second revoke error = %v, want ErrSecretNotLive", err)
	}
}

// One tenant must never revoke another's key: that is a denial-of-service on
// their conversion feed.
func TestRevocationIsTenantScoped(t *testing.T) {
	ctx := context.Background()
	pool := secretsSeedPool(t, ctx)
	store := encryptedSecretsTestStore(pool)
	mine := seedSecretsTenant(t, ctx, pool)
	theirs := seedSecretsTenant(t, ctx, pool)

	issued, err := store.Issue(ctx, theirs, "theirs")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if err := store.Revoke(ctx, mine, issued.KeyID); !errors.Is(err, ErrSecretNotLive) {
		t.Fatalf("cross-tenant revoke error = %v, want ErrSecretNotLive", err)
	}
	// The error alone does not show the key survived. Their feed keeps working
	// only if the key still resolves to them.
	if got := resolvedTenantForKey(t, ctx, pool, issued.KeyID); got != theirs {
		t.Fatalf("after a cross-tenant revoke attempt the key resolves to %q, want %q", got, theirs)
	}
}

// The key id is resolved BEFORE the tenant is known, so it is globally unique
// and must not be guessable from anything tenant-shaped.
func TestKeyIDsAreHighEntropyAndDistinct(t *testing.T) {
	ctx := context.Background()
	pool := secretsSeedPool(t, ctx)
	store := encryptedSecretsTestStore(pool)
	tenantID := seedSecretsTenant(t, ctx, pool)

	seen := map[string]bool{}
	for i := 0; i < 5; i++ {
		issued, err := store.Issue(ctx, tenantID, "k")
		if err != nil {
			t.Fatalf("issue %d: %v", i, err)
		}
		if len(issued.KeyID) < 16 {
			t.Fatalf("key id %q is too short to resist guessing", issued.KeyID)
		}
		if strings.Contains(issued.KeyID, tenantID) {
			t.Fatal("the key id must not embed the tenant id")
		}
		if seen[issued.KeyID] {
			t.Fatalf("duplicate key id %q", issued.KeyID)
		}
		seen[issued.KeyID] = true
	}
}
