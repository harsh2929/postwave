// SPDX-License-Identifier: AGPL-3.0-only
package integration_writeback

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// RuntimeSecretResolver is the trusted secrets backend (the same vault the
// connectors use). Get returns a raw string; GetJSON unmarshals a JSON bundle.
type RuntimeSecretResolver interface {
	Get(ctx context.Context, ref string) (string, error)
	GetJSON(ctx context.Context, ref string, v any) error
}

// CredentialResolver resolves a credentials_ref to a flat string map (token,
// shop_domain, etc.). A JSON bundle is preferred; a raw string falls back to a
// single "token" key.
type CredentialResolver interface {
	Resolve(ctx context.Context, ref string) (map[string]string, error)
}

type TenantCredentialResolver interface {
	ResolveForTenant(ctx context.Context, tenantID, ref string) (map[string]string, error)
}

// SecretsCredentialResolver resolves references through the Moosewave secrets
// vault. Mirrors audience_destinations.SecretsAudienceCredentialResolver.
type SecretsCredentialResolver struct {
	Secrets RuntimeSecretResolver
}

func (r SecretsCredentialResolver) Resolve(ctx context.Context, ref string) (map[string]string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil, errors.New("credentials_ref is required")
	}
	if r.Secrets == nil {
		return nil, errors.New("secrets backend not configured")
	}
	var fields map[string]string
	if err := r.Secrets.GetJSON(ctx, ref, &fields); err == nil && len(fields) > 0 {
		return fields, nil
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return nil, err
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("resolved credential is empty")
	}
	// Tolerate a JSON object stored as a raw string.
	if strings.HasPrefix(raw, "{") {
		var m map[string]string
		if json.Unmarshal([]byte(raw), &m) == nil && len(m) > 0 {
			return m, nil
		}
	}
	return map[string]string{"token": raw}, nil
}

type KlaviyoCredentialStore interface {
	GetKlaviyoCredentialSecret(ctx context.Context, tenantID, ref string) (string, error)
}

type MarketingAwareCredentialResolver struct {
	Secrets      RuntimeSecretResolver
	KlaviyoStore KlaviyoCredentialStore
}

func (r MarketingAwareCredentialResolver) Resolve(ctx context.Context, ref string) (map[string]string, error) {
	return SecretsCredentialResolver{Secrets: r.Secrets}.Resolve(ctx, ref)
}

func (r MarketingAwareCredentialResolver) ResolveForTenant(ctx context.Context, tenantID, ref string) (map[string]string, error) {
	ref = strings.TrimSpace(ref)
	if strings.HasPrefix(ref, "marketing:klaviyo:") && r.KlaviyoStore != nil {
		raw, err := r.KlaviyoStore.GetKlaviyoCredentialSecret(ctx, tenantID, ref)
		if err != nil {
			return nil, err
		}
		return parseFlatCredentialMap(raw)
	}
	return r.Resolve(ctx, ref)
}

func parseFlatCredentialMap(raw string) (map[string]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("resolved credential is empty")
	}
	var fields map[string]string
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &fields); err == nil && len(fields) > 0 {
			return fields, nil
		}
	}
	if strings.Contains(raw, "=") {
		fields = map[string]string{}
		for _, line := range strings.Split(raw, "\n") {
			parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
			if len(parts) == 2 && strings.TrimSpace(parts[0]) != "" {
				fields[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
			}
		}
		if len(fields) > 0 {
			return fields, nil
		}
	}
	return map[string]string{"token": raw}, nil
}
