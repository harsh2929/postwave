package seedlist

import (
	"encoding/json"
	"strings"
	"testing"
)

// A registry holding one active seed, one flagged, and one banned — each with
// resolvable credentials, so a projection that leaks them has something to leak.
func catalogFixture(t *testing.T) *Registry {
	t.Helper()
	t.Setenv("CAT_ADDRESS", "active-seed@example.test")
	t.Setenv("CAT_USER", "imap-user-value")
	t.Setenv("CAT_PASSWORD", "super-secret-password")
	registry := NewRegistry()
	if err := registry.LoadJSON(`{"inboxes":[
        {"id":"gmail-001","provider":"gmail",
         "address_secret_ref":"env:CAT_ADDRESS",
         "imap_host":"imap.example.test","imap_port":993,
         "imap_user_secret_ref":"env:CAT_USER",
         "imap_password_secret_ref":"env:CAT_PASSWORD",
         "status":"active"},
        {"id":"gmail-002","provider":"gmail",
         "address":"flagged-seed@example.test",
         "imap_host":"imap.example.test","imap_port":993,
         "status":"flagged"},
        {"id":"yahoo-001","provider":"yahoo",
         "address":"banned-seed@example.test",
         "imap_host":"imap.example.test","imap_port":993,
         "status":"banned"}
    ]}`); err != nil {
		t.Fatal(err)
	}
	return registry
}

// The gateway advertises these mailboxes so a customer can send a manual test
// to them. A flagged or banned seed cannot produce a placement observation, so
// advertising one mints a test that silently never completes.
func TestCatalogPublishesOnlyActiveSeeds(t *testing.T) {
	response := Catalog(catalogFixture(t))
	if len(response.Seeds) != 1 {
		t.Fatalf("expected only the active seed, got %d: %+v", len(response.Seeds), response.Seeds)
	}
	if response.Seeds[0].MailboxID != "gmail-001" {
		t.Fatalf("wrong seed published: %+v", response.Seeds[0])
	}
	if response.Seeds[0].Address != "active-seed@example.test" {
		t.Fatalf("address not resolved for dispatch: %+v", response.Seeds[0])
	}
}

// The whole reason SeedEntry is not seedlist.Inbox. This asserts on the
// SERIALIZED form, because that is what actually crosses the trust boundary —
// a struct field that is unexported or omitted still fails this if it marshals.
func TestCatalogNeverSerializesSeedCredentials(t *testing.T) {
	response := Catalog(catalogFixture(t))
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{
		"super-secret-password", // the IMAP password itself
		"imap-user-value",       // the IMAP account name
		"CAT_PASSWORD",          // the reference that would let a reader fetch it
		"CAT_USER",
		"imap.example.test", // host/port are read-path topology, not send-path
	} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("seed catalog leaked %q across the trust boundary: %s", secret, encoded)
		}
	}
}

// A provider whose seeds are all flagged has no capacity. Reporting its raw
// configured count would advertise mailboxes that cannot execute.
func TestCatalogProviderCountsExcludeInactiveSeeds(t *testing.T) {
	response := Catalog(catalogFixture(t))
	counts := map[string]int{}
	for _, provider := range response.Providers {
		counts[provider.Provider] = provider.SeedCount
	}
	if counts["gmail"] != 1 {
		t.Fatalf("gmail should count only its active seed, got %d", counts["gmail"])
	}
	if counts["yahoo"] != 0 {
		t.Fatalf("yahoo's only seed is banned, so it has no capacity, got %d", counts["yahoo"])
	}
}

// HasCategorizer must come from the real categorizer set. The gateway's static
// fallback hardcodes true for every provider; if the two ever diverge, the
// service's answer is the one that reflects what can actually be classified.
func TestCatalogReportsCategorizerSupportFromTheRealSet(t *testing.T) {
	response := Catalog(catalogFixture(t))
	if len(response.Providers) == 0 {
		t.Fatal("no providers reported")
	}
	supported := defaultCategorizerProviders()
	for _, provider := range response.Providers {
		_, ok := supported[providerKey(provider.Provider)]
		if provider.HasCategorizer != ok {
			t.Fatalf("provider %s reported HasCategorizer=%v but the categorizer set says %v",
				provider.Provider, provider.HasCategorizer, ok)
		}
	}
}
