// SPDX-License-Identifier: AGPL-3.0-only

package inboxreality

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
	"github.com/postwave/postwave/packages/runtime/internalsign"
)

func seedlistServer(t *testing.T, status int, body any) (*httptest.Server, *[]*http.Request) {
	t.Helper()
	seen := &[]*http.Request{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*seen = append(*seen, r.Clone(context.Background()))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if body != nil {
			_ = json.NewEncoder(w).Encode(body)
		}
	}))
	t.Cleanup(server.Close)
	return server, seen
}

func testRegistry(t *testing.T, server *httptest.Server) *HTTPSeedRegistry {
	t.Helper()
	return &HTTPSeedRegistry{
		BaseURL:       server.URL,
		BearerToken:   "bearer",
		SigningSecret: "internal-secret",
		Clock:         func() time.Time { return time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC) },
	}
}

func liveCatalog() inboxrealitycontract.SeedlistResponse {
	return inboxrealitycontract.SeedlistResponse{
		ContractVersion: inboxrealitycontract.SeedlistVersion,
		Seeds: []inboxrealitycontract.SeedEntry{
			{MailboxID: "gmail-001", Provider: "gmail", Address: "seed@example.test"},
		},
		Providers: []inboxrealitycontract.SeedProvider{
			{Provider: "gmail", SeedCount: 1, HasCategorizer: true},
		},
	}
}

func TestHTTPSeedRegistryReturnsLiveSeeds(t *testing.T) {
	server, _ := seedlistServer(t, http.StatusOK, liveCatalog())
	seeds, err := testRegistry(t, server).Seeds(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(seeds) != 1 || seeds[0].Address != "seed@example.test" || seeds[0].MailboxID != "gmail-001" {
		t.Fatalf("unexpected seeds: %+v", seeds)
	}
	// The label is the gateway's own, never the service's: display copy has a
	// single owner so the two cannot drift.
	if seeds[0].ProviderLabel != ProviderGmail.DisplayName() {
		t.Fatalf("label %q did not come from the gateway catalog", seeds[0].ProviderLabel)
	}
}

// The service rejects anything unsigned, so an unsigned client would fail in
// production while every unit test passed against a permissive stub.
func TestHTTPSeedRegistrySignsItsRequest(t *testing.T) {
	server, seen := seedlistServer(t, http.StatusOK, liveCatalog())
	if _, err := testRegistry(t, server).Seeds(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 1 {
		t.Fatalf("expected one upstream call, got %d", len(*seen))
	}
	headers := internalsign.FromHTTP((*seen)[0].Header)
	if err := internalsign.Verify("internal-secret", http.MethodGet,
		inboxrealitycontract.SeedlistPath, nil, headers,
		time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC), internalsign.DefaultTolerance); err != nil {
		t.Fatalf("outbound request would be rejected by the service: %v", err)
	}
	if (*seen)[0].Header.Get("Authorization") != "Bearer bearer" {
		t.Fatal("bearer token missing: the service router's own auth would reject this")
	}
}

// The service verifies against r.URL.EscapedPath() — the FULL path it
// received. If the client signs only the bare contract path while the
// configured base URL carries a prefix, every request is signed over a
// different string than the one verified, and the whole integration fails 401
// in exactly the deployments that route through a path-prefixed ingress.
func TestHTTPSeedRegistrySignsThePathTheServiceWillVerify(t *testing.T) {
	server, seen := seedlistServer(t, http.StatusOK, liveCatalog())
	registry := testRegistry(t, server)
	registry.BaseURL = server.URL + "/deliverability"
	if _, err := registry.Seeds(context.Background()); err != nil {
		t.Fatal(err)
	}
	received := (*seen)[0]
	if err := internalsign.Verify("internal-secret", http.MethodGet,
		received.URL.EscapedPath(), nil, internalsign.FromHTTP(received.Header),
		time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC), internalsign.DefaultTolerance); err != nil {
		t.Fatalf("signature does not cover the delivered path %q: %v", received.URL.EscapedPath(), err)
	}
}

// The distinction that matters operationally. CreateTest maps an error to
// "load active seeds failed" and an empty list to ErrNoActiveSeeds. If an
// unreachable service returned an empty list, an operator would go hunting for
// missing seed configuration instead of a broken dependency.
func TestHTTPSeedRegistryErrorsRatherThanReportingNoSeeds(t *testing.T) {
	for _, status := range []int{http.StatusInternalServerError, http.StatusUnauthorized,
		http.StatusServiceUnavailable, http.StatusNotFound} {
		server, _ := seedlistServer(t, status, nil)
		seeds, err := testRegistry(t, server).Seeds(context.Background())
		if err == nil {
			t.Fatalf("status %d returned %d seeds and no error", status, len(seeds))
		}
	}
}

func TestHTTPSeedRegistryRejectsForeignContractVersion(t *testing.T) {
	catalog := liveCatalog()
	catalog.ContractVersion = "postwave.inbox-reality-seedlist.v99"
	server, _ := seedlistServer(t, http.StatusOK, catalog)
	if _, err := testRegistry(t, server).Seeds(context.Background()); err == nil {
		t.Fatal("accepted a catalog from an unrecognised contract version")
	}
}

// A seed with no address cannot receive a test. Passing it through would make
// CreateTest mint a test that can never produce an observation.
func TestHTTPSeedRegistryDropsAddresslessSeeds(t *testing.T) {
	catalog := liveCatalog()
	catalog.Seeds = append(catalog.Seeds,
		inboxrealitycontract.SeedEntry{MailboxID: "gmail-002", Provider: "gmail", Address: "   "})
	server, _ := seedlistServer(t, http.StatusOK, catalog)
	seeds, err := testRegistry(t, server).Seeds(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(seeds) != 1 {
		t.Fatalf("addressless seed was published: %+v", seeds)
	}
}

// The provider matrix is a stable dashboard surface. A provider the service
// does not currently list must still appear, at zero, rather than vanishing —
// a missing column reads as "we never supported this".
func TestHTTPSeedRegistryProviderCatalogCoversEveryKnownProvider(t *testing.T) {
	server, _ := seedlistServer(t, http.StatusOK, liveCatalog())
	providers, err := testRegistry(t, server).ProviderInfo(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != len(AllProviders) {
		t.Fatalf("expected all %d providers, got %d", len(AllProviders), len(providers))
	}
	byProvider := map[Provider]ProviderInfo{}
	for _, info := range providers {
		byProvider[info.Provider] = info
	}
	if byProvider[ProviderGmail].SeedCount != 1 {
		t.Fatalf("live gmail count lost: %+v", byProvider[ProviderGmail])
	}
	if byProvider[ProviderYahoo].SeedCount != 0 {
		t.Fatalf("unlisted provider should report zero capacity: %+v", byProvider[ProviderYahoo])
	}
	if byProvider[ProviderYahoo].Label != ProviderYahoo.DisplayName() {
		t.Fatal("provider label missing for a provider the service did not return")
	}
}

func TestHTTPSeedRegistryValidateRejectsIncompleteWiring(t *testing.T) {
	for name, registry := range map[string]*HTTPSeedRegistry{
		"no base URL": {BearerToken: "b", SigningSecret: "s"},
		"no secret":   {BaseURL: "https://svc.internal", BearerToken: "b"},
		"no bearer":   {BaseURL: "https://svc.internal", SigningSecret: "s"},
		"bad scheme":  {BaseURL: "file:///etc/passwd", BearerToken: "b", SigningSecret: "s"},
	} {
		if err := registry.Validate(); err == nil {
			t.Fatalf("%s: incomplete registry validated", name)
		}
	}
}

func TestVerifyProductionCapacityRefusesAShortSeedlist(t *testing.T) {
	server, _ := seedlistServer(t, http.StatusOK, liveCatalog())
	err := testRegistry(t, server).VerifyProductionCapacity(context.Background())
	if err == nil {
		t.Fatal("a one-seed catalog satisfied the production capacity gate")
	}
	if !strings.Contains(err.Error(), "production requires") {
		t.Errorf("error does not explain the mismatch: %v", err)
	}
}

func TestVerifyProductionCapacityAcceptsAFullSeedlist(t *testing.T) {
	catalog := liveCatalog()
	for len(catalog.Seeds) < inboxrealitycontract.ProductionSeedlistMinimum {
		catalog.Seeds = append(catalog.Seeds, inboxrealitycontract.SeedEntry{
			MailboxID: "gmail-fill", Provider: "gmail", Address: "fill@example.test",
		})
	}
	server, _ := seedlistServer(t, http.StatusOK, catalog)
	if err := testRegistry(t, server).VerifyProductionCapacity(context.Background()); err != nil {
		t.Errorf("a full seedlist was refused: %v", err)
	}
}

func TestVerifyProductionCapacitySurfacesAFetchFailure(t *testing.T) {
	// An unreachable service must not read as "capacity satisfied". Zero seeds is
	// exactly the shape a failure produces.
	server, _ := seedlistServer(t, http.StatusInternalServerError, nil)
	if err := testRegistry(t, server).VerifyProductionCapacity(context.Background()); err == nil {
		t.Error("an unreachable seed catalog satisfied the production capacity gate")
	}
}
