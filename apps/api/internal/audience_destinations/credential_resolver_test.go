// SPDX-License-Identifier: AGPL-3.0-only
package audience_destinations

import (
	"context"
	"errors"
	"testing"
)

type fakeAudienceSecretResolver struct {
	json map[string]map[string]string
	raw  map[string]string
}

func (f fakeAudienceSecretResolver) Get(_ context.Context, ref string) (string, error) {
	if v, ok := f.raw[ref]; ok {
		return v, nil
	}
	return "", errors.New("not found")
}

func (f fakeAudienceSecretResolver) GetJSON(_ context.Context, ref string, out any) error {
	m, ok := f.json[ref]
	if !ok {
		return errors.New("not found")
	}
	dst, ok := out.(*map[string]string)
	if !ok {
		return errors.New("unexpected target")
	}
	*dst = m
	return nil
}

func TestHydrateAdapterConfigResolvesJSONCredentialRef(t *testing.T) {
	resolver := SecretsAudienceCredentialResolver{Secrets: fakeAudienceSecretResolver{
		json: map[string]map[string]string{"ref-1": {"access_token": "tok_live", "developer_token": "dev_live"}},
	}}
	cfg := map[string]any{"audience_id": "aud_1", "credential_ref": "ref-1"}
	out, err := hydrateAdapterConfig(context.Background(), resolver, cfg)
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if configString(out, "access_token") != "tok_live" || configString(out, "developer_token") != "dev_live" {
		t.Fatalf("secrets not injected: %+v", out)
	}
	if configString(out, "audience_id") != "aud_1" {
		t.Fatalf("existing config lost: %+v", out)
	}
	// The original config must not be mutated (no secret leak into the stored row).
	if _, present := cfg["access_token"]; present {
		t.Fatal("original config was mutated with a resolved secret")
	}
}

func TestHydrateAdapterConfigResolvesRawTokenRef(t *testing.T) {
	resolver := SecretsAudienceCredentialResolver{Secrets: fakeAudienceSecretResolver{
		raw: map[string]string{"ref-raw": "tok_raw"},
	}}
	cfg := map[string]any{"audience_id": "aud", "access_token_ref": "ref-raw"}
	out, err := hydrateAdapterConfig(context.Background(), resolver, cfg)
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if configString(out, "access_token") != "tok_raw" {
		t.Fatalf("raw token not injected as access_token: %+v", out)
	}
}

func TestHydrateAdapterConfigPrefersExplicitRawValue(t *testing.T) {
	resolver := SecretsAudienceCredentialResolver{Secrets: fakeAudienceSecretResolver{
		json: map[string]map[string]string{"ref-1": {"access_token": "tok_resolved"}},
	}}
	cfg := map[string]any{"credential_ref": "ref-1", "access_token": "tok_explicit"}
	out, err := hydrateAdapterConfig(context.Background(), resolver, cfg)
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if configString(out, "access_token") != "tok_explicit" {
		t.Fatalf("explicit raw value must win over resolved: %+v", out)
	}
}

func TestHydrateAdapterConfigNoRefIsNoop(t *testing.T) {
	cfg := map[string]any{"audience_id": "aud", "access_token": "tok"}
	out, err := hydrateAdapterConfig(context.Background(), nil, cfg)
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if configString(out, "access_token") != "tok" || configString(out, "audience_id") != "aud" {
		t.Fatalf("noop hydrate changed config: %+v", out)
	}
}
