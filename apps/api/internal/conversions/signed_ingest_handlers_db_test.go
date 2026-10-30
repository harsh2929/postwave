// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	pwcrypto "github.com/postwave/postwave/apps/api/internal/crypto"
	"github.com/postwave/postwave/apps/api/internal/db"
)

const testSignedIngestSecret = "sk_test_conversion_identity_hmac_32_bytes_minimum"
const testConversionKMSKeyARN = "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000002017"

var signedIngestTestKEK = []byte("conversion-test-kek-32-bytes!!!!")

type signedIngestProjectionTestCipher struct {
	EnvelopeCipher
}

func (*signedIngestProjectionTestCipher) KMSKeyARN() string {
	return testConversionKMSKeyARN
}

func signedIngestTestEnvelope() EnvelopeCipher {
	cipher, err := pwcrypto.NewStaticEnvelope(signedIngestTestKEK)
	if err != nil {
		panic(err)
	}
	return &signedIngestProjectionTestCipher{EnvelopeCipher: cipher}
}

// signedIngestFixture provisions a tenant with a live signing secret.
func signedIngestFixture(t *testing.T, pool *db.Pool) (tenantID, keyID, secret string) {
	t.Helper()
	ctx := context.Background()
	tenantID = createAttributionTenant(t, pool, ctx)
	keyID = "k-" + uuid.NewString()[:8]
	secret = testSignedIngestSecret

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	envelope, err := signedIngestTestEnvelope().Encrypt(ctx, []byte(secret))
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("encrypt test secret: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO conversion_ingest_secrets (
    tenant_id, key_id, label, secret, secret_envelope, secret_kms_key_arn
)
VALUES ($1::uuid, $2, 'test', $3, $4, $5)`, tenantID, keyID,
		ingestSecretEnvelopeSentinel, envelope, testConversionKMSKeyARN); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed secret: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	drainEmailHMACProjection(t, pool)
	return tenantID, keyID, secret
}

// drainEmailHMACProjection runs the same repository pages as the production
// worker with a test-only v2 envelope implementation. It is intentionally
// bounded and fails if work does not converge, so DB tests cannot silently
// reinstate the old subscriber-scan resolver.
func drainEmailHMACProjection(t *testing.T, pool *db.Pool) {
	t.Helper()
	repository, err := NewEmailHMACProjectionRepository(pool)
	if err != nil {
		t.Fatalf("projection repository: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	workerID := "projection-test-" + uuid.NewString()
	for sweep := 0; sweep < 100; sweep++ {
		claims, err := repository.Claim(ctx, workerID, 100, time.Minute)
		if err != nil {
			t.Fatalf("claim projection: %v", err)
		}
		if len(claims) == 0 {
			return
		}
		for _, claim := range claims {
			secret, err := repository.ResolveSecret(ctx, claim, signedIngestTestEnvelope())
			if err != nil {
				t.Fatalf("resolve projection secret: %v", err)
			}
			_, applyErr := repository.Apply(ctx, claim, secret, DefaultProjectionPageSize)
			zeroSecret(secret)
			if applyErr != nil {
				t.Fatalf("apply projection page: %v", applyErr)
			}
		}
	}
	t.Fatal("email-HMAC projection did not converge within 100 bounded sweeps")
}

func emailHMAC(address string) string {
	return EmailIdentityHMAC(testSignedIngestSecret, address)
}

func signedRequest(t *testing.T, path, secret, keyID, idempotencyKey string, body []byte, now time.Time) *http.Request {
	t.Helper()
	timestamp := strconv.FormatInt(now.Unix(), 10)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	req.Header.Set(SignatureHeader, SignRequest(secret, keyID, timestamp, body))
	req.Header.Set(TimestampHeader, timestamp)
	if idempotencyKey != "" {
		req.Header.Set(IdempotencyHeader, idempotencyKey)
	}
	return req
}

func signedRouter(pool *db.Pool, now time.Time) chi.Router {
	router := chi.NewRouter()
	MountSignedIngestRoutes(router, &SignedIngestDeps{
		Repo: &Repo{Pool: pool, Cipher: signedIngestTestEnvelope()},
		Now:  func() time.Time { return now },
	})
	return router
}

// A correctly signed conversion is accepted; every way of getting it wrong is not.
func TestTheSignedIngestAcceptsOnlyProperlySignedRequests(t *testing.T) {
	pool := attributionDB(t)
	_, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	router := signedRouter(pool, now)

	body := []byte(`{"event_name":"purchase","value":129.00,"currency":"USD",` +
		`"identity":{"email_hmac_sha256":"` + emailHMAC("buyer@example.test") + `"}}`)

	t.Run("a valid signature is accepted", func(t *testing.T) {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, signedRequest(t, "/api/public/conversions/ingest",
			secret, keyID, "idem-"+uuid.NewString(), body, now))
		if rec.Code != http.StatusAccepted {
			t.Fatalf("= %d, body %s", rec.Code, rec.Body.String())
		}
		var receipt map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &receipt); err != nil {
			t.Fatalf("decode receipt: %v", err)
		}
		if _, exposed := receipt["tenant"]; exposed {
			t.Fatal("public signed-conversion receipt exposed tenant identity")
		}
		if _, exposed := receipt["tenant_id"]; exposed {
			t.Fatal("public signed-conversion receipt exposed tenant_id")
		}
	})

	t.Run("an unsigned request is refused", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/public/conversions/ingest",
			bytes.NewReader(body))
		req.Header.Set(IdempotencyHeader, "idem-"+uuid.NewString())
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("= %d, want 401", rec.Code)
		}
	})

	t.Run("a tampered body is refused", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := signedRequest(t, "/api/public/conversions/ingest", secret, keyID,
			"idem-"+uuid.NewString(), body, now)
		// Same signature, different bytes — the exact attack the raw-body
		// verification exists to stop.
		req.Body = http.NoBody
		tampered := []byte(`{"event_name":"purchase","value":12900.00,"currency":"USD",` +
			`"identity":{"email_hmac_sha256":"` + emailHMAC("buyer@example.test") + `"}}`)
		req = httptest.NewRequest(http.MethodPost, "/api/public/conversions/ingest",
			bytes.NewReader(tampered))
		timestamp := strconv.FormatInt(now.Unix(), 10)
		req.Header.Set(SignatureHeader, SignRequest(secret, keyID, timestamp, body))
		req.Header.Set(TimestampHeader, timestamp)
		req.Header.Set(IdempotencyHeader, "idem-"+uuid.NewString())
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("a body that differs from the signed bytes was accepted: %d", rec.Code)
		}
	})

	t.Run("a stale timestamp is named distinctly", func(t *testing.T) {
		stale := now.Add(-time.Hour)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, signedRequest(t, "/api/public/conversions/ingest",
			secret, keyID, "idem-"+uuid.NewString(), body, stale))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("= %d, want 401", rec.Code)
		}
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		if out["error"] != "stale_signature" {
			t.Errorf("error = %v, want stale_signature — a customer with a skewed "+
				"clock needs to be told that, and the timestamp is already in the "+
				"request so saying so reveals nothing", out["error"])
		}
	})
}

// The Idempotency-Key is REQUIRED, and a retry replays the original response.
func TestTheSignedIngestRequiresAndHonoursIdempotency(t *testing.T) {
	pool := attributionDB(t)
	_, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	router := signedRouter(pool, now)
	body := []byte(`{"event_name":"purchase","identity":{"external_id":"cust-1"}}`)

	t.Run("a missing key is refused", func(t *testing.T) {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, signedRequest(t, "/api/public/conversions/ingest",
			secret, keyID, "", body, now))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("= %d, want 400 — optional idempotency double-counts on the "+
				"first network retry", rec.Code)
		}
	})

	t.Run("a retry replays the original response", func(t *testing.T) {
		key := "idem-" + uuid.NewString()
		first := httptest.NewRecorder()
		router.ServeHTTP(first, signedRequest(t, "/api/public/conversions/ingest",
			secret, keyID, key, body, now))
		if first.Code != http.StatusAccepted {
			t.Fatalf("first = %d, body %s", first.Code, first.Body.String())
		}
		second := httptest.NewRecorder()
		router.ServeHTTP(second, signedRequest(t, "/api/public/conversions/ingest",
			secret, keyID, key, body, now))
		if second.Code != first.Code || second.Body.String() != first.Body.String() {
			t.Fatalf("retry returned %d/%s, want the original %d/%s — a caller "+
				"reconciling ids would treat this as a failed first attempt",
				second.Code, second.Body.String(), first.Code, first.Body.String())
		}
	})

	t.Run("the same key with a different body is a conflict", func(t *testing.T) {
		key := "idem-" + uuid.NewString()
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, signedRequest(t, "/api/public/conversions/ingest",
			secret, keyID, key, body, now))
		if rec.Code != http.StatusAccepted {
			t.Fatalf("first = %d", rec.Code)
		}
		other := []byte(`{"event_name":"refund","identity":{"external_id":"cust-1"}}`)
		conflict := httptest.NewRecorder()
		router.ServeHTTP(conflict, signedRequest(t, "/api/public/conversions/ingest",
			secret, keyID, key, other, now))
		if conflict.Code != http.StatusConflict {
			t.Fatalf("= %d, want 409 — replaying the stored response would silently "+
				"discard the new data while reporting success", conflict.Code)
		}
	})
}

// Plaintext email is refused by name, and a malformed hash too.
func TestPlaintextEmailIsRefusedAndTheHashIsValidated(t *testing.T) {
	pool := attributionDB(t)
	_, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	router := signedRouter(pool, now)

	for _, tc := range []struct{ name, body, wantCode string }{
		{
			name:     "plaintext email",
			body:     `{"event_name":"purchase","identity":{"email":"buyer@example.test"}}`,
			wantCode: "plaintext_email_rejected",
		},
		{
			name: "legacy unsalted digest",
			body: `{"event_name":"purchase","identity":{"email_sha256":"` +
				strings.Repeat("a", 64) + `"}}`,
			wantCode: "unsafe_email_sha256_rejected",
		},
		{
			// A truncated or salted digest would simply never resolve, and the caller
			// would watch conversions land unattributed with no error explaining it.
			name:     "truncated hash",
			body:     `{"event_name":"purchase","identity":{"email_hmac_sha256":"abc123"}}`,
			wantCode: "invalid_email_hmac_sha256",
		},
		{
			name:     "uppercase hash",
			body:     `{"event_name":"purchase","identity":{"email_hmac_sha256":"` + "A" + emailHMAC("x@y.test")[1:] + `"}}`,
			wantCode: "invalid_email_hmac_sha256",
		},
		{
			name:     "no identity at all",
			body:     `{"event_name":"purchase","identity":{}}`,
			wantCode: "identity_required",
		},
		{
			name:     "no event name",
			body:     `{"identity":{"external_id":"cust-1"}}`,
			wantCode: "event_name_required",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, signedRequest(t, "/api/public/conversions/ingest",
				secret, keyID, "idem-"+uuid.NewString(), []byte(tc.body), now))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("= %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
			var out map[string]any
			_ = json.Unmarshal(rec.Body.Bytes(), &out)
			if out["error"] != tc.wantCode {
				t.Errorf("error = %v, want %q — naming the field is the difference "+
					"between a caller fixing it in a minute and filing a ticket",
					out["error"], tc.wantCode)
			}
		})
	}
}

// A batch over 500 is REFUSED, not truncated.
//
// A silently truncated batch reports success for conversions never recorded, and
// the caller has no way to discover which ones.
func TestAnOversizedBatchIsRefusedRatherThanTruncated(t *testing.T) {
	pool := attributionDB(t)
	_, keyID, secret := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	router := signedRouter(pool, now)

	items := make([]string, 0, MaxBatchConversions+1)
	for i := 0; i <= MaxBatchConversions; i++ {
		items = append(items, `{"event_name":"purchase","identity":{"external_id":"c`+
			strconv.Itoa(i)+`"}}`)
	}
	body := []byte(`{"conversions":[` + joinStrings(items, ",") + `]}`)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, signedRequest(t, "/api/public/conversions/ingest/batch",
		secret, keyID, "idem-"+uuid.NewString(), body, now))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("= %d, want 413 for %d items", rec.Code, MaxBatchConversions+1)
	}

	// And exactly 500 is accepted.
	ok := make([]string, 0, MaxBatchConversions)
	for i := 0; i < MaxBatchConversions; i++ {
		ok = append(ok, `{"event_name":"purchase","identity":{"external_id":"c`+
			strconv.Itoa(i)+`"}}`)
	}
	okBody := []byte(`{"conversions":[` + joinStrings(ok, ",") + `]}`)
	accepted := httptest.NewRecorder()
	router.ServeHTTP(accepted, signedRequest(t, "/api/public/conversions/ingest/batch",
		secret, keyID, "idem-"+uuid.NewString(), okBody, now))
	if accepted.Code != http.StatusAccepted {
		t.Fatalf("a 500-item batch = %d, want 202 (body %s)",
			accepted.Code, accepted.Body.String())
	}
}

func joinStrings(items []string, sep string) string {
	out := ""
	for i, item := range items {
		if i > 0 {
			out += sep
		}
		out += item
	}
	return out
}

// The repo enforces the batch cap ITSELF, not only through the handler.
//
// The handler refuses an oversized batch first, so the repo's own cap is
// unreachable from any route test: deleting it leaves every HTTP test green. That
// is a guard surviving by luck rather than by test. The invariant belongs to the
// repo because RecordSignedConversions is reachable without the handler, and a
// future non-HTTP caller would inherit an unbounded batch — the exact failure the
// cap exists to prevent, arriving through the door nobody tested.
func TestTheRepoRefusesAnOversizedBatchIndependentlyOfTheHandler(t *testing.T) {
	pool := attributionDB(t)
	tenantID, keyID, _ := signedIngestFixture(t, pool)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	now := time.Now().UTC()

	oversized := make([]signedConversion, 0, MaxBatchConversions+1)
	for i := 0; i <= MaxBatchConversions; i++ {
		oversized = append(oversized, signedConversion{
			EventName: "purchase",
			Identity:  signedIdentity{ExternalID: "over-" + strconv.Itoa(i)},
		})
	}
	if _, err := repo.RecordSignedConversions(ctx, tenantID, keyID,
		"idem-"+uuid.NewString(), RequestDigest([]byte("{}")), oversized, now); err == nil {
		t.Fatalf("recorded %d items, want refusal above %d", len(oversized), MaxBatchConversions)
	}

	// Guard the guard. Without this, a repo that refused EVERY batch would pass
	// the assertion above while being completely broken.
	atCap := oversized[:MaxBatchConversions]
	if _, err := repo.RecordSignedConversions(ctx, tenantID, keyID,
		"idem-"+uuid.NewString(), RequestDigest([]byte("{}")), atCap, now); err != nil {
		t.Fatalf("exactly %d items must be accepted: %v", MaxBatchConversions, err)
	}
}

// A missing Idempotency-Key is named even when the signature is ALSO wrong.
//
// The handler documents that presence is checked before the signature. With a
// VALID signature the repo layer returns the same error, so the ordering is
// invisible: removing the handler check changed no test. Only a request that is
// wrong in both ways distinguishes them.
//
// The ordering is worth keeping. A caller debugging an integration otherwise
// fixes the signature, retries, and only then discovers the second problem —
// two round trips through a support conversation for one malformed request.
func TestAMissingIdempotencyKeyIsNamedBeforeTheSignatureIsChecked(t *testing.T) {
	pool := attributionDB(t)
	_, keyID, _ := signedIngestFixture(t, pool)
	now := time.Now().UTC()
	router := signedRouter(pool, now)
	body := []byte(`{"event_name":"purchase","identity":{"external_id":"c1"}}`)

	// Signed with the WRONG secret: structurally valid, cryptographically false.
	req := httptest.NewRequest(http.MethodPost, "/api/public/conversions/ingest",
		bytes.NewReader(body))
	timestamp := strconv.FormatInt(now.Unix(), 10)
	req.Header.Set(SignatureHeader, SignRequest("sk_not_the_real_secret", keyID, timestamp, body))
	req.Header.Set(TimestampHeader, timestamp)
	// and deliberately NO Idempotency-Key.

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("= %d, want 400 (the client bug named first); body %s",
			rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "idempotency_key_required") {
		t.Fatalf("body = %s, want idempotency_key_required", rec.Body.String())
	}
}
