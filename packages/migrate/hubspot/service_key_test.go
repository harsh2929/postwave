package hubspot

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/migrate/adapter"
)

// Service Keys and legacy private app tokens intentionally share a Bearer
// protocol. Their prefix cannot establish which kind of credential was issued.
func TestServiceKeyRotationBindsPortalAndRequiredReads(t *testing.T) {
	var original string
	for _, token := range []string{"pat-na1-service-key", "pat-na1-rotated-key", "pat-na1-existing-private-token"} {
		fixture := newHubSpotAPIFixture(t)
		fixture.Contacts = []hsObject{{ID: "1", Properties: map[string]string{"email": "contact@example.com"}}}
		fixture.ExpectedToken = token
		server := httptest.NewServer(fixture)
		ad := newTestHubSpotAdapter(server.URL)
		sess, err := ad.Authenticate(context.Background(), adapter.Credentials{APIKey: token, AccountID: "12345"})
		if err != nil {
			server.Close()
			t.Fatal(err)
		}
		fingerprint := AccountFingerprint(sess)
		if fingerprint == "" || (original != "" && fingerprint != original) {
			t.Fatal("rotation changed verified portal")
		}
		original = fingerprint
		if _, err := ad.Discover(context.Background(), sess); err != nil {
			server.Close()
			t.Fatal(err)
		}
		server.Close()
	}
}

func TestServiceKeyRevocationAndMissingReadsFailClosed(t *testing.T) {
	for _, path := range []string{
		"/crm/objects/2026-03/contacts",
		"/account-info/2026-03/details",
		"/crm/properties/2026-03/contacts",
		"/crm/lists/2026-03/search",
		"/communication-preferences/2026-03/definitions",
		"/account-info/2026-03/api-usage/daily/private-apps",
	} {
		t.Run(path, func(t *testing.T) {
			fixture := newHubSpotAPIFixture(t)
			fixture.Contacts = []hsObject{{ID: "1", Properties: map[string]string{"email": "contact@example.com"}}}
			fixture.ExpectedToken = "pat-na1-service-key"
			fixture.FailStatus[path] = http.StatusForbidden
			server := httptest.NewServer(fixture)
			defer server.Close()
			ad := newTestHubSpotAdapter(server.URL)
			sess, err := ad.Authenticate(context.Background(), adapter.Credentials{APIKey: fixture.ExpectedToken})
			if err == nil {
				_, err = ad.Discover(context.Background(), sess)
			}
			if err == nil {
				t.Fatal("missing required read accepted")
			}
		})
	}
	fixture := newHubSpotAPIFixture(t)
	fixture.Contacts = []hsObject{{ID: "1", Properties: map[string]string{"email": "contact@example.com"}}}
	fixture.FailStatus["/crm/objects/2026-03/contacts"] = http.StatusUnauthorized
	server := httptest.NewServer(fixture)
	defer server.Close()
	_, err := newTestHubSpotAdapter(server.URL).Authenticate(context.Background(), adapter.Credentials{APIKey: "revoked"})
	if !errors.Is(err, adapter.ErrAuth) {
		t.Fatalf("revoked key: %v", err)
	}
}
