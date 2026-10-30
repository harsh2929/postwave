// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestSignedIngestJSONContractIsClosed(t *testing.T) {
	t.Parallel()

	for _, body := range []string{
		`{"event_name":"purchase","identity":{"external_id":"customer-1"},"tenant_id":"attacker"}`,
		`{"event_name":"purchase","identity":{"external_id":"customer-1","email_address":"buyer@example.test"}}`,
		`{"event_name":"purchase","identity":{"external_id":"customer-1"}} {}`,
	} {
		var input signedConversion
		if err := decodeClosedJSON([]byte(body), &input); err == nil {
			t.Fatalf("undocumented signed-ingest field/value was silently accepted: %s", body)
		}
	}

	var input signedConversion
	if err := decodeClosedJSON([]byte(
		`{"event_name":"purchase","identity":{"external_id":"customer-1"},"metadata":{"merchant_extension":true}}`,
	), &input); err != nil {
		t.Fatalf("documented metadata extension map was rejected: %v", err)
	}
}

func TestSignedIngestRejectsAmbiguousIdempotencyKeysBeforeSecretLookup(t *testing.T) {
	t.Parallel()

	for _, key := range []string{" spaced", "spaced ", "line\tbreak", strings.Repeat("x", maxIdempotencyKeyBytes+1)} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/public/conversions/ingest", bytes.NewReader([]byte(`{}`)))
		request.Header.Set(IdempotencyHeader, key)
		(&SignedIngestDeps{}).Ingest(recorder, request)
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"error":"invalid_idempotency_key"`) {
			t.Fatalf("key %q returned %d/%s", key, recorder.Code, recorder.Body.String())
		}
		if recorder.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatalf("key %q refusal was cacheable: %q", key, recorder.Header().Get("Cache-Control"))
		}
	}
}

func TestSignedIngestStoredResponseNeverContainsTenantIdentity(t *testing.T) {
	t.Parallel()

	source := readSignedIngestSourceForContract(t)
	if strings.Contains(source, `"tenant":`) || strings.Contains(source, `"tenant_id":`) {
		t.Fatal("signed-ingest public receipt exposes tenant identity")
	}
}

func TestSignedIngestIsRootMountedWithCipherAndPublicLimiter(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("../../main.go")
	if err != nil {
		t.Fatalf("read API composition: %v", err)
	}
	source := string(raw)
	mount := strings.Index(source, "conversions.MountSignedIngestRoutes(")
	if mount < 0 {
		t.Fatal("signed conversion ingest is not mounted in API composition")
	}
	legacyPublicGroup := strings.Index(source[mount:], "// Remaining public routes")
	if legacyPublicGroup < 0 {
		t.Fatal("signed conversion ingest is not root-mounted before the legacy public group")
	}
	for _, required := range []string{
		"httpcache.WithPolicy(httpcache.Mutation())",
		"publicRateLimit.Middleware",
		"Cipher:    envCipher",
		"LegacyKEK: cfg.SendingKEK",
		"Logger: logger",
	} {
		if !strings.Contains(source[mount:mount+legacyPublicGroup], required) {
			t.Fatalf("signed conversion ingest composition is missing %q", required)
		}
	}
}

func readSignedIngestSourceForContract(t *testing.T) string {
	t.Helper()
	// Keep this source-level assertion independent of a live PostgreSQL fixture:
	// it protects the public response projection even in focused unit CI.
	raw, err := os.ReadFile("signed_ingest.go")
	if err != nil {
		t.Fatalf("read signed_ingest.go: %v", err)
	}
	return string(raw)
}
