// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func legacySignedRequest(
	t *testing.T,
	path, secret, keyID, idempotencyKey string,
	body []byte,
	now time.Time,
) *http.Request {
	t.Helper()
	timestamp := strconv.FormatInt(now.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(legacySigningPreimage(timestamp, body))
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	req.Header.Set(SignatureHeader,
		"keyid="+keyID+",v1="+hex.EncodeToString(mac.Sum(nil)))
	req.Header.Set(TimestampHeader, timestamp)
	req.Header.Set(IdempotencyHeader, idempotencyKey)
	return req
}

// A 202 is evidence of a committed conversion fact, not merely a stored
// idempotency marker. Every wire field that has a durable column is asserted,
// including occurred_at so delayed delivery cannot move revenue into today.
func TestSignedIngestAtomicallyPersistsTheConversionAndReceipt(t *testing.T) {
	pool := attributionDB(t)
	tenantID, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC().Truncate(time.Microsecond)
	occurredAt := now.Add(-26 * time.Hour).Truncate(time.Microsecond)
	externalID := "customer-" + uuid.NewString()
	clickID := "click-" + uuid.NewString()
	hash := emailHMAC("buyer@example.test")
	idempotencyKey := "idem-" + uuid.NewString()
	body := []byte(`{"event_name":"purchase","occurred_at":"` +
		occurredAt.Format(time.RFC3339Nano) + `","identity":{"click_id":"` +
		clickID + `","email_hmac_sha256":"` + hash + `","external_id":"` +
		externalID + `"},"value":129.00,"currency":"usd",` +
		`"metadata":{"order_id":"order-1001"}}`)

	recorder := httptest.NewRecorder()
	signedRouter(pool, now).ServeHTTP(recorder, signedRequest(t,
		"/api/public/conversions/ingest", secret, keyID, idempotencyKey, body, now))
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("ingest = %d, body %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Accepted      int     `json:"accepted"`
		ConversionIDs []int64 `json:"conversion_ids"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Accepted != 1 || len(response.ConversionIDs) != 1 {
		t.Fatalf("response = %+v, want one durable conversion id", response)
	}

	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var event, currency, storedHash, storedHMACKeyID, storedClick, storedExternal, orderID string
	var cents int64
	var storedAt time.Time
	if err := tx.QueryRow(context.Background(), `
	SELECT event_name, amount_cents, currency, occurred_at,
	       email_hmac_sha256, email_hmac_key_id, click_id, external_id,
	       properties->>'order_id'
  FROM conversions
 WHERE tenant_id = $1::uuid AND id = $2`, tenantID, response.ConversionIDs[0]).
		Scan(&event, &cents, &currency, &storedAt, &storedHash, &storedHMACKeyID, &storedClick,
			&storedExternal, &orderID); err != nil {
		t.Fatalf("read conversion fact: %v", err)
	}
	if event != "purchase" || cents != 12900 || currency != "USD" ||
		!storedAt.Equal(occurredAt) || storedHash != hash || storedHMACKeyID != keyID || storedClick != clickID ||
		storedExternal != externalID || orderID != "order-1001" {
		t.Fatalf("persisted fact mismatch: event=%q cents=%d currency=%q at=%s hmac=%q hmac_key=%q click=%q external=%q order=%q",
			event, cents, currency, storedAt, storedHash, storedHMACKeyID, storedClick, storedExternal, orderID)
	}
	var receipts int
	if err := tx.QueryRow(context.Background(), `
SELECT count(*) FROM conversion_ingest_idempotency
 WHERE tenant_id = $1::uuid AND idempotency_key = $2`, tenantID, idempotencyKey).
		Scan(&receipts); err != nil {
		t.Fatalf("count receipt: %v", err)
	}
	if receipts != 1 {
		t.Fatalf("receipt count = %d, want 1 committed with the fact", receipts)
	}
}

// All concurrent retries share one unique receipt claim. The winner commits one
// conversion; every loser reads the winner's final response after the unique
// index wait and must return it byte-for-byte.
func TestConcurrentSignedIngestRetriesCreateOneFactAndOneReceipt(t *testing.T) {
	pool := attributionDB(t)
	tenantID, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	externalID := "concurrent-" + uuid.NewString()
	idempotencyKey := "idem-" + uuid.NewString()
	body := []byte(`{"event_name":"purchase","identity":{"external_id":"` +
		externalID + `"},"value":19.99,"currency":"USD"}`)
	router := signedRouter(pool, now)

	const callers = 16
	responses := make([]string, callers)
	codes := make([]int, callers)
	var wg sync.WaitGroup
	wg.Add(callers)
	for i := 0; i < callers; i++ {
		go func(index int) {
			defer wg.Done()
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, signedRequest(t,
				"/api/public/conversions/ingest", secret, keyID,
				idempotencyKey, body, now))
			codes[index] = recorder.Code
			responses[index] = recorder.Body.String()
		}(i)
	}
	wg.Wait()
	for i := 0; i < callers; i++ {
		if codes[i] != http.StatusAccepted {
			t.Fatalf("caller %d = %d, body %s", i, codes[i], responses[i])
		}
		if responses[i] != responses[0] {
			t.Fatalf("caller %d response %q differs from winner %q", i,
				responses[i], responses[0])
		}
	}

	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var facts, receipts int
	if err := tx.QueryRow(context.Background(), `
SELECT
  (SELECT count(*) FROM conversions
    WHERE tenant_id=$1::uuid AND external_id=$2),
  (SELECT count(*) FROM conversion_ingest_idempotency
    WHERE tenant_id=$1::uuid AND idempotency_key=$3)`,
		tenantID, externalID, idempotencyKey).Scan(&facts, &receipts); err != nil {
		t.Fatalf("count outcomes: %v", err)
	}
	if facts != 1 || receipts != 1 {
		t.Fatalf("facts/receipts = %d/%d, want 1/1", facts, receipts)
	}
}

// Setting the retired custom GUC must not restore cross-tenant table reads.
// The only pre-tenant lookup is the fixed definer function, and the live key id
// is globally exclusive so it cannot name two workspaces.
func TestConversionSecretResolutionIsNarrowAndGloballyUnambiguous(t *testing.T) {
	pool := attributionDB(t)
	tenantID, keyID, _ := signedIngestFixture(t, pool)
	otherTenant := createAttributionTenant(t, pool, context.Background())

	unbound, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatalf("begin unbound: %v", err)
	}
	defer func() { _ = unbound.Rollback(context.Background()) }()
	if _, err := unbound.Exec(context.Background(),
		`SELECT set_config('app.conversion_signature_resolver','true',true)`); err != nil {
		t.Fatalf("set retired GUC: %v", err)
	}
	var leaked int
	if err := unbound.QueryRow(context.Background(), `
SELECT count(*) FROM conversion_ingest_secrets WHERE key_id=$1`, keyID).
		Scan(&leaked); err != nil {
		t.Fatalf("direct secret probe: %v", err)
	}
	if leaked != 0 {
		t.Fatalf("caller-set resolver GUC exposed %d secret rows", leaked)
	}
	var resolvedTenant string
	if err := unbound.QueryRow(context.Background(), `
SELECT tenant_id::text FROM public.resolve_conversion_ingest_secret($1)`, keyID).
		Scan(&resolvedTenant); err != nil {
		t.Fatalf("fixed resolver: %v", err)
	}
	if resolvedTenant != tenantID {
		t.Fatalf("resolver tenant = %s, want %s", resolvedTenant, tenantID)
	}
	_ = unbound.Rollback(context.Background())

	collision, err := db.WithTenant(context.Background(), pool, otherTenant)
	if err != nil {
		t.Fatalf("WithTenant(other): %v", err)
	}
	defer func() { _ = collision.Rollback(context.Background()) }()
	collisionEnvelope, err := signedIngestTestEnvelope().Encrypt(
		context.Background(), []byte("different-secret"),
	)
	if err != nil {
		t.Fatalf("encrypt collision secret: %v", err)
	}
	if _, err := collision.Exec(context.Background(), `
INSERT INTO conversion_ingest_secrets (
    tenant_id, key_id, label, secret, secret_envelope, secret_kms_key_arn
)
VALUES ($1::uuid, $2, 'collision', $3, $4, $5)`, otherTenant, keyID,
		ingestSecretEnvelopeSentinel, collisionEnvelope, testConversionKMSKeyARN); err == nil {
		t.Fatal("a second live workspace claimed the same resolver key id")
	}

	var publicCanExecute bool
	if err := pool.QueryRow(context.Background(), `
SELECT has_function_privilege(
  'postwave_public', 'public.resolve_conversion_ingest_secret(text)', 'EXECUTE'
)`).Scan(&publicCanExecute); err != nil {
		t.Fatalf("inspect anonymous grant: %v", err)
	}
	if publicCanExecute {
		t.Fatal("anonymous postwave_public can execute the secret resolver")
	}

	var canLogin, superuser, createDB, createRole, inherit, replication, bypassRLS bool
	if err := pool.QueryRow(context.Background(), `
SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
       rolreplication, rolbypassrls
  FROM pg_roles
 WHERE rolname='postwave_conversion_secret_resolver'`).Scan(
		&canLogin, &superuser, &createDB, &createRole, &inherit, &replication,
		&bypassRLS); err != nil {
		t.Fatalf("inspect resolver role: %v", err)
	}
	if canLogin || superuser || createDB || createRole || inherit || replication || bypassRLS {
		t.Fatalf("unsafe resolver role attributes: login=%v super=%v createdb=%v createrole=%v inherit=%v replication=%v bypassrls=%v",
			canLogin, superuser, createDB, createRole, inherit, replication, bypassRLS)
	}
	var memberships int
	if err := pool.QueryRow(context.Background(), `
SELECT count(*)
  FROM pg_auth_members AS membership
  JOIN pg_roles AS role
    ON role.oid=membership.member OR role.oid=membership.roleid
 WHERE role.rolname='postwave_conversion_secret_resolver'`).Scan(&memberships); err != nil {
		t.Fatalf("inspect resolver memberships: %v", err)
	}
	if memberships != 0 {
		t.Fatalf("resolver role has %d memberships/members, want zero", memberships)
	}
	rows, err := pool.Query(context.Background(), `
SELECT attribute.attname
  FROM pg_attribute AS attribute
 WHERE attribute.attrelid='public.conversion_ingest_secrets'::regclass
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
   AND has_column_privilege(
       'postwave_conversion_secret_resolver',
       'public.conversion_ingest_secrets', attribute.attname, 'SELECT'
   )
 ORDER BY attribute.attname`)
	if err != nil {
		t.Fatalf("inspect resolver column grants: %v", err)
	}
	defer rows.Close()
	var granted []string
	for rows.Next() {
		var column string
		if err := rows.Scan(&column); err != nil {
			t.Fatalf("scan resolver column: %v", err)
		}
		granted = append(granted, column)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("resolver column rows: %v", err)
	}
	wantColumns := "key_id,legacy_v1_until,revoked_at,secret,secret_envelope,tenant_id"
	if strings.Join(granted, ",") != wantColumns {
		t.Fatalf("resolver columns = %v, want exact %s", granted, wantColumns)
	}
	var canInsert, canUpdate, canDelete bool
	if err := pool.QueryRow(context.Background(), `
SELECT
  has_table_privilege('postwave_conversion_secret_resolver',
                      'public.conversion_ingest_secrets','INSERT'),
  has_table_privilege('postwave_conversion_secret_resolver',
                      'public.conversion_ingest_secrets','UPDATE'),
  has_table_privilege('postwave_conversion_secret_resolver',
                      'public.conversion_ingest_secrets','DELETE')`).Scan(
		&canInsert, &canUpdate, &canDelete); err != nil {
		t.Fatalf("inspect resolver writes: %v", err)
	}
	if canInsert || canUpdate || canDelete {
		t.Fatalf("resolver received write privilege: insert=%v update=%v delete=%v",
			canInsert, canUpdate, canDelete)
	}
	var functionOwner string
	var securityDefiner bool
	if err := pool.QueryRow(context.Background(), `
SELECT owner.rolname, procedure.prosecdef
  FROM pg_proc AS procedure
  JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
  JOIN pg_roles AS owner ON owner.oid=procedure.proowner
 WHERE namespace.nspname='public'
   AND procedure.proname='resolve_conversion_ingest_secret'`).Scan(
		&functionOwner, &securityDefiner); err != nil {
		t.Fatalf("inspect resolver function: %v", err)
	}
	if functionOwner != "postwave_conversion_secret_resolver" || !securityDefiner {
		t.Fatalf("resolver owner/security = %s/%v", functionOwner, securityDefiner)
	}
}

// Compatibility is deliberate and finite: a secret created after 1951 is v2
// only; an operator can keep an already-issued v1 credential alive until its
// migration deadline, after which the identical MAC fails closed.
func TestLegacyV1SignaturesRequireAnUnexpiredCompatibilityFence(t *testing.T) {
	pool := attributionDB(t)
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL is required for historical compatibility fixture setup")
	}
	admin, err := pgx.Connect(context.Background(), adminURL)
	if err != nil {
		t.Fatalf("connect admin database: %v", err)
	}
	t.Cleanup(func() { _ = admin.Close(context.Background()) })

	tenantID, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	body := []byte(`{"event_name":"purchase","identity":{"external_id":"legacy"}}`)
	router := signedRouter(pool, now)

	newSecret := httptest.NewRecorder()
	router.ServeHTTP(newSecret, legacySignedRequest(t,
		"/api/public/conversions/ingest", secret, keyID,
		"idem-"+uuid.NewString(), body, now))
	if newSecret.Code != http.StatusUnauthorized {
		t.Fatalf("new v2-only secret accepted v1: %d", newSecret.Code)
	}

	setDeadline := func(deadline time.Time) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		tx, err := admin.Begin(ctx)
		if err != nil {
			t.Fatalf("begin historical compatibility fixture: %v", err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if _, err := tx.Exec(ctx, `SET LOCAL row_security = off`); err != nil {
			t.Fatalf("require historical compatibility fixture authority: %v", err)
		}
		result, err := tx.Exec(ctx, `
UPDATE conversion_ingest_secrets
   SET legacy_v1_until=$3
	 WHERE tenant_id=$1::uuid AND key_id=$2`, tenantID, keyID, deadline)
		if err != nil {
			t.Fatalf("set compatibility deadline: %v", err)
		}
		if result.RowsAffected() != 1 {
			t.Fatalf("set compatibility deadline affected %d rows, want 1", result.RowsAffected())
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit compatibility deadline: %v", err)
		}
	}
	setDeadline(now.Add(time.Hour))
	compatible := httptest.NewRecorder()
	router.ServeHTTP(compatible, legacySignedRequest(t,
		"/api/public/conversions/ingest", secret, keyID,
		"idem-"+uuid.NewString(), body, now))
	if compatible.Code != http.StatusAccepted {
		t.Fatalf("unexpired migrated v1 secret = %d, body %s",
			compatible.Code, compatible.Body.String())
	}

	setDeadline(now.Add(-time.Second))
	expired := httptest.NewRecorder()
	router.ServeHTTP(expired, legacySignedRequest(t,
		"/api/public/conversions/ingest", secret, keyID,
		"idem-"+uuid.NewString(), body, now))
	if expired.Code != http.StatusUnauthorized {
		t.Fatalf("expired v1 signature = %d, want 401", expired.Code)
	}
}
