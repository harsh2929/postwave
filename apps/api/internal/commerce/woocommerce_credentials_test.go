package commerce

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

type fakeRuntimeSecretResolver struct {
	values map[string]string
}

func (f fakeRuntimeSecretResolver) Get(_ context.Context, name string) (string, error) {
	if v, ok := f.values[name]; ok {
		return v, nil
	}
	return "", pwsecrets.ErrNotFound
}

func (f fakeRuntimeSecretResolver) GetJSON(ctx context.Context, name string, dst any) error {
	raw, err := f.Get(ctx, name)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(raw), dst)
}

func TestWooCommerceSecretsCredentialResolverJSON(t *testing.T) {
	resolver := NewWooCommerceSecretsCredentialResolver(fakeRuntimeSecretResolver{values: map[string]string{
		"vault://commerce/woo": `{"consumer_key":"ck_live","consumer_secret":"cs_live"}`,
	}})

	creds, err := resolver.ResolveWooCommerce(context.Background(), "tenant-1", Integration{
		Provider: ProviderWooCommerce,
		Settings: map[string]any{"credential_ref": "vault://commerce/woo"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if creds.ConsumerKey != "ck_live" || creds.ConsumerSecret != "cs_live" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestWooCommerceSecretsCredentialResolverRawFallbacks(t *testing.T) {
	tests := map[string]string{
		"pair":  "ck_live:cs_live",
		"lines": "consumer_key=ck_live\nconsumer_secret=cs_live",
	}
	for name, raw := range tests {
		t.Run(name, func(t *testing.T) {
			resolver := NewWooCommerceSecretsCredentialResolver(fakeRuntimeSecretResolver{values: map[string]string{"ref": raw}})

			creds, err := resolver.ResolveWooCommerce(context.Background(), "tenant-1", Integration{
				Provider: ProviderWooCommerce,
				Settings: map[string]any{"credential_ref": "ref"},
			})
			if err != nil {
				t.Fatal(err)
			}
			if creds.ConsumerKey != "ck_live" || creds.ConsumerSecret != "cs_live" {
				t.Fatalf("creds=%+v", creds)
			}
		})
	}
}

func TestWooCommerceSecretsCredentialResolverRequiresRef(t *testing.T) {
	resolver := NewWooCommerceSecretsCredentialResolver(fakeRuntimeSecretResolver{values: map[string]string{}})
	_, err := resolver.ResolveWooCommerce(context.Background(), "tenant-1", Integration{Provider: ProviderWooCommerce})
	if err == nil || !strings.Contains(err.Error(), "credential_ref is required") {
		t.Fatalf("expected missing credential ref error, got %v", err)
	}
}
