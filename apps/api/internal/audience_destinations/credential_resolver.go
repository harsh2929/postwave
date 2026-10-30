// SPDX-License-Identifier: AGPL-3.0-only
//
// credential_resolver.go — SUB-113 credential hydration.
//
// Public destination config stores only a credential *reference* (never a raw
// ads access token) to avoid credential/PII exfiltration. Before an adapter can
// deliver to Meta / Google Ads / TikTok / LinkedIn / Snap, the reference must be
// hydrated into the actual secret fields (access_token, developer_token, ...).
// This is the step that flips those destinations from the
// "credential_resolution_required" readiness gate to live delivery.
package audience_destinations

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// AudienceCredentialResolver resolves a stored credential reference into the
// secret fields an adapter needs (e.g. {"access_token": "...",
// "developer_token": "..."}).
type AudienceCredentialResolver interface {
	ResolveAudienceCredential(ctx context.Context, ref string) (map[string]string, error)
}

// AudienceRuntimeSecretResolver is the trusted secrets backend (the same
// resolver the CRM and commerce connectors use).
type AudienceRuntimeSecretResolver interface {
	Get(ctx context.Context, ref string) (string, error)
	GetJSON(ctx context.Context, ref string, out any) error
}

// SecretsAudienceCredentialResolver resolves references through the Moosewave
// secrets vault. A JSON secret maps directly to adapter fields; a bare string
// secret is treated as the access token.
type SecretsAudienceCredentialResolver struct {
	Secrets AudienceRuntimeSecretResolver
}

func (r SecretsAudienceCredentialResolver) ResolveAudienceCredential(ctx context.Context, ref string) (map[string]string, error) {
	if r.Secrets == nil {
		return nil, fmt.Errorf("audience credential resolver is not configured")
	}
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil, fmt.Errorf("audience credential ref is required")
	}
	var fields map[string]string
	if err := r.Secrets.GetJSON(ctx, ref, &fields); err == nil && len(fields) > 0 {
		return fields, nil
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return nil, fmt.Errorf("resolve audience credential %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("audience credential %q is empty", ref)
	}
	if strings.HasPrefix(raw, "{") {
		var parsed map[string]string
		if err := json.Unmarshal([]byte(raw), &parsed); err == nil && len(parsed) > 0 {
			return parsed, nil
		}
	}
	return map[string]string{"access_token": raw}, nil
}

// hydrateAdapterConfig returns a copy of cfg with resolved secret fields merged
// in. It never mutates the input (so the stored destination row keeps only the
// reference), and never overwrites an explicitly-provided raw value.
func hydrateAdapterConfig(ctx context.Context, resolver AudienceCredentialResolver, cfg map[string]any) (map[string]any, error) {
	out := make(map[string]any, len(cfg)+4)
	for key, value := range cfg {
		out[key] = value
	}
	ref := credentialReference(cfg)
	if ref == "" || resolver == nil {
		return out, nil
	}
	fields, err := resolver.ResolveAudienceCredential(ctx, ref)
	if err != nil {
		return nil, fmt.Errorf("hydrate audience credential %q: %w", ref, err)
	}
	for key, value := range fields {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "" || value == "" {
			continue
		}
		if configString(out, key) != "" {
			continue // an explicit raw value wins over the resolved one
		}
		out[key] = value
	}
	return out, nil
}
