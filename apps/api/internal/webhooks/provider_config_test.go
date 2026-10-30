// SPDX-License-Identifier: AGPL-3.0-only
package webhooks

import "testing"

func TestRedactProviderConfigRecurses(t *testing.T) {
	in := map[string]any{
		"webhook_token": "tok_live",
		"public":        "value",
		"nested": map[string]any{
			"signing_key": "secret",
			"region":      "us-east-1",
		},
		"items": []any{
			map[string]any{"client_secret": "hidden", "name": "primary"},
		},
	}

	out := redactProviderConfig(in)
	if got := out["webhook_token"]; got != providerSecretRedacted {
		t.Fatalf("top-level token was not redacted: %#v", got)
	}
	nested, ok := out["nested"].(map[string]any)
	if !ok {
		t.Fatalf("nested map missing: %#v", out["nested"])
	}
	if got := nested["signing_key"]; got != providerSecretRedacted {
		t.Fatalf("nested signing key was not redacted: %#v", got)
	}
	if got := nested["region"]; got != "us-east-1" {
		t.Fatalf("non-secret nested value changed: %#v", got)
	}
	items, ok := out["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("items slice missing: %#v", out["items"])
	}
	item, ok := items[0].(map[string]any)
	if !ok {
		t.Fatalf("item map missing: %#v", items[0])
	}
	if got := item["client_secret"]; got != providerSecretRedacted {
		t.Fatalf("nested slice secret was not redacted: %#v", got)
	}
}

func TestValidateProviderConfigRejectsRawSendCredentials(t *testing.T) {
	for _, tc := range []struct {
		name   string
		config map[string]any
	}{
		{name: "api key", config: map[string]any{"api_key": "SG.secret"}},
		{name: "postmark server token", config: map[string]any{"postmark": map[string]any{"server_token": "pm-secret"}}},
		{name: "aws key", config: map[string]any{"credentials": map[string]any{"secret_access_key": "aws-secret"}}},
		{name: "smtp password", config: map[string]any{"smtp_password": "smtp-secret"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateProviderConfig("sendgrid", tc.config); err == nil {
				t.Fatalf("expected raw credential rejection for %#v", tc.config)
			}
		})
	}
}

func TestValidateProviderConfigAllowsWebhookTokensAndRefs(t *testing.T) {
	config := map[string]any{
		"webhook_token":  "edge-token-with-at-least-32-characters",
		"token":          "legacy-edge-token-with-32-characters",
		"credential_ref": "cred_live_123",
		"region":         "us-east-1",
		"nested": map[string]any{
			"webhook_signing_key_ref": "cred_webhook_123",
		},
	}
	if err := validateProviderConfig("mailgun", config); err != nil {
		t.Fatalf("expected webhook-token/ref config to pass, got %v", err)
	}
}

func TestValidateProviderConfigRejectsWeakWebhookTokens(t *testing.T) {
	for _, token := range []any{"short", "has whitespace despite being much longer than thirty two", 42} {
		if err := validateProviderConfig("sendgrid", map[string]any{"webhook_token": token}); err == nil {
			t.Fatalf("expected weak webhook token rejection for %#v", token)
		}
	}
}

func TestValidateProviderConfigAcceptsBoundedCredentialRefAndRejectsCredentialMaterial(t *testing.T) {
	if err := validateProviderConfig("sendgrid", map[string]any{
		"credential_ref": "deliverability/sendgrid",
	}); err != nil {
		t.Fatalf("expected vault reference to pass: %v", err)
	}
	for _, raw := range []any{
		"",
		"contains whitespace",
		"Bearer SG.secret",
		"SG.raw-key",
		"abc123-us21",
		"../another-tenant/key",
		"deliverability//sendgrid",
		"tenants/another-tenant/deliverability/sendgrid",
		`{"api_key":"secret"}`,
		123,
	} {
		if err := validateProviderConfig("sendgrid", map[string]any{"credential_ref": raw}); err == nil {
			t.Fatalf("expected credential_ref rejection for %#v", raw)
		}
	}
}

func TestMergeProviderConfigPreservesOmittedAndRedactedSecrets(t *testing.T) {
	existing := map[string]any{
		"webhook_token": "existing-webhook-token",
		"api_key":       "existing-api-key",
		"region":        "us-east-1",
	}

	got := mergeProviderConfig(existing, map[string]any{
		"webhook_token":  providerSecretRedacted,
		"credential_ref": "deliverability/sendgrid",
		"region":         "us-west-2",
	})

	if got["webhook_token"] != "existing-webhook-token" {
		t.Fatalf("redacted sentinel replaced stored webhook token: %#v", got)
	}
	if _, exists := got["api_key"]; exists {
		t.Fatalf("legacy API key remained after vault-reference migration: %#v", got)
	}
	if got["region"] != "us-west-2" {
		t.Fatalf("non-secret update was not overlaid: %#v", got)
	}
	if existing["region"] != "us-east-1" {
		t.Fatalf("merge mutated its existing input: %#v", existing)
	}
}

func TestMergeProviderConfigCanonicalizesLegacyCredentialReferenceKey(t *testing.T) {
	got := mergeProviderConfig(nil, map[string]any{
		"credentials_ref": "deliverability/sendgrid",
	})
	if got["credential_ref"] != "deliverability/sendgrid" {
		t.Fatalf("credential reference was not canonicalized: %#v", got)
	}
	if _, exists := got["credentials_ref"]; exists {
		t.Fatalf("legacy credential-reference alias remained: %#v", got)
	}
}

func TestPrepareProviderConfigHashesAndMigratesWebhookToken(t *testing.T) {
	token := "high-entropy-edge-token-1234567890abcdef"
	got := prepareProviderConfigForStorage(map[string]any{
		"webhook_token": token,
	}, nil)
	if _, exists := got["webhook_token"]; exists {
		t.Fatalf("plaintext webhook token remained: %#v", got)
	}
	digest, ok := got["webhook_token_hash"].(string)
	if !ok || len(digest) != 64 {
		t.Fatalf("webhook token digest = %#v", got["webhook_token_hash"])
	}
	if !providerTokenMatches(token, "hmac-sha256:"+digest, "sendgrid") {
		t.Fatal("stored digest did not verify the original token")
	}
	if providerTokenMatches(token+"x", "hmac-sha256:"+digest, "sendgrid") {
		t.Fatal("stored digest accepted a different token")
	}
}
