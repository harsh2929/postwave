// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
	"github.com/postwave/postwave/packages/runtime/internalsign"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
)

func seedlistTestRegistry(t *testing.T) *seedlist.Registry {
	t.Helper()
	registry := seedlist.NewRegistry()
	if err := registry.LoadJSON(`{"inboxes":[
        {"id":"gmail-001","provider":"gmail","address":"seed@example.test",
         "imap_host":"imap.example.test","imap_port":993,
         "imap_password_env":"SEED_PW","status":"active"}
    ]}`); err != nil {
		t.Fatal(err)
	}
	return registry
}

func seedlistHandler(t *testing.T, now time.Time) *Handler {
	t.Helper()
	return &Handler{
		Seeds:          seedlistTestRegistry(t),
		SigningSecrets: "internal-secret",
		Clock:          func() time.Time { return now },
	}
}

func signedSeedlistRequest(t *testing.T, secret string, now time.Time) *http.Request {
	t.Helper()
	signed, err := internalsign.Sign(secret, http.MethodGet,
		inboxrealitycontract.SeedlistPath, inboxrealitycontract.SeedlistRequestID, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, inboxrealitycontract.SeedlistPath, nil)
	internalsign.Apply(request.Header, signed)
	return request
}

func serveSeedlist(t *testing.T, handler *Handler, request *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	handler.MountInternal(router)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

// The seed catalog names every controlled mailbox we own. An unauthenticated
// reader would learn the full list of addresses to allowlist, which defeats the
// entire point of seeds being indistinguishable from real recipients.
func TestSeedlistRejectsUnsignedRequest(t *testing.T) {
	now := time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
	request := httptest.NewRequest(http.MethodGet, inboxrealitycontract.SeedlistPath, nil)
	recorder := serveSeedlist(t, seedlistHandler(t, now), request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unsigned seed catalog request returned %d, want 401", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), "seed@example.test") {
		t.Fatalf("rejected response still disclosed a seed address: %s", recorder.Body.String())
	}
}

func TestSeedlistRejectsSignatureFromAnotherSecret(t *testing.T) {
	now := time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
	request := signedSeedlistRequest(t, "not-the-internal-secret", now)
	recorder := serveSeedlist(t, seedlistHandler(t, now), request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("foreign-signed request returned %d, want 401", recorder.Code)
	}
}

func TestSeedlistReturnsSignedCatalogWithoutCredentials(t *testing.T) {
	now := time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
	recorder := serveSeedlist(t, seedlistHandler(t, now), signedSeedlistRequest(t, "internal-secret", now))
	if recorder.Code != http.StatusOK {
		t.Fatalf("signed request returned %d: %s", recorder.Code, recorder.Body.String())
	}
	var response inboxrealitycontract.SeedlistResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.ContractVersion != inboxrealitycontract.SeedlistVersion {
		t.Fatalf("unversioned catalog: %q", response.ContractVersion)
	}
	if len(response.Seeds) != 1 || response.Seeds[0].Address != "seed@example.test" {
		t.Fatalf("unexpected seeds: %+v", response.Seeds)
	}
	if strings.Contains(recorder.Body.String(), "SEED_PW") ||
		strings.Contains(recorder.Body.String(), "imap.example.test") {
		t.Fatalf("endpoint leaked read-path credentials: %s", recorder.Body.String())
	}
}

// Without a registry the honest answer is "I cannot tell you", not an empty
// catalog — an empty list reads as "we own no seeds" and would make the
// gateway mint a test that fails closed for the wrong stated reason.
func TestSeedlistFailsClosedWithoutRegistry(t *testing.T) {
	now := time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
	handler := &Handler{SigningSecrets: "internal-secret", Clock: func() time.Time { return now }}
	recorder := serveSeedlist(t, handler, signedSeedlistRequest(t, "internal-secret", now))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing registry returned %d, want 503", recorder.Code)
	}
}
