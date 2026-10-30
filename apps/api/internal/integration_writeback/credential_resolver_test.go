// SPDX-License-Identifier: AGPL-3.0-only
package integration_writeback

import (
	"context"
	"testing"
)

type fakeKlaviyoWritebackCredentialStore struct {
	raw string
}

func (f fakeKlaviyoWritebackCredentialStore) GetKlaviyoCredentialSecret(context.Context, string, string) (string, error) {
	return f.raw, nil
}

func TestMarketingAwareCredentialResolverResolvesManagedKlaviyoRef(t *testing.T) {
	resolver := MarketingAwareCredentialResolver{
		KlaviyoStore: fakeKlaviyoWritebackCredentialStore{raw: `{"access_token":"oauth_access","refresh_token":"oauth_refresh"}`},
	}
	creds, err := resolver.ResolveForTenant(context.Background(), "tenant-1", "marketing:klaviyo:stored")
	if err != nil {
		t.Fatal(err)
	}
	if creds["access_token"] != "oauth_access" || creds["refresh_token"] != "oauth_refresh" {
		t.Fatalf("creds=%+v", creds)
	}
}
