// SPDX-License-Identifier: AGPL-3.0-only
//
// Zero-copy credential references are tenant-bound labels. A label never
// resolves directly against a process-wide environment variable or global
// Secrets Manager name; the resolver derives a canonical per-tenant,
// read-only namespace before asking the trusted secret backend.
package zerocopy_triggers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

const (
	tenantWarehouseSecretPrefix   = "postwave/tenants/"
	hardMaxCredentialPayloadBytes = 256 << 10 // 256 KiB
)

var credentialLabelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// RuntimeSecretResolver is the narrow shared-vault seam used in production.
type RuntimeSecretResolver interface {
	Get(ctx context.Context, name string) (string, error)
}

// TenantSecretsCredentialResolver resolves a tenant-local label through the
// process' configured AWS Secrets Manager/env chain after namespacing it.
type TenantSecretsCredentialResolver struct {
	Secrets RuntimeSecretResolver
}

func NewTenantSecretsCredentialResolver(secrets RuntimeSecretResolver) *TenantSecretsCredentialResolver {
	return &TenantSecretsCredentialResolver{Secrets: secrets}
}

func (r *TenantSecretsCredentialResolver) Resolve(ctx context.Context, tenantID, ref string) (map[string]any, error) {
	if r == nil || r.Secrets == nil {
		return nil, fmt.Errorf("zerocopy credentials: secrets backend is not configured")
	}
	name, err := tenantCredentialSecretName(tenantID, ref)
	if err != nil {
		return nil, err
	}
	raw, err := r.Secrets.Get(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("zerocopy credentials: resolve tenant secret: %w", err)
	}
	return parseTenantCredentialPayload(raw)
}

// EnvCredentialResolver is retained for isolated/local composition. It uses
// the exact same tenant namespace as the production resolver, mapped to an env
// identifier (e.g. postwave/tenants/<uuid>/warehouse/read-only/acme becomes
// POSTWAVE_TENANTS_<UUID>_WAREHOUSE_READ_ONLY_ACME).
type EnvCredentialResolver struct{}

func NewEnvCredentialResolver() *EnvCredentialResolver { return &EnvCredentialResolver{} }

func (r *EnvCredentialResolver) Resolve(_ context.Context, tenantID, ref string) (map[string]any, error) {
	name, err := tenantCredentialSecretName(tenantID, ref)
	if err != nil {
		return nil, err
	}
	envName := tenantCredentialEnvName(name)
	raw := strings.TrimSpace(os.Getenv(envName))
	if raw == "" {
		return nil, fmt.Errorf("zerocopy credentials: tenant-scoped env var %q is empty/unset", envName)
	}
	return parseTenantCredentialPayload(raw)
}

func tenantCredentialSecretName(tenantID, ref string) (string, error) {
	tenantID = strings.ToLower(strings.TrimSpace(tenantID))
	if _, err := uuid.Parse(tenantID); err != nil {
		return "", fmt.Errorf("zerocopy credentials: invalid tenant id")
	}
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", fmt.Errorf("zerocopy credentials: empty credentials_ref")
	}
	prefix := tenantWarehouseSecretPrefix + tenantID + "/warehouse/read-only/"
	label := ref
	switch {
	case strings.HasPrefix(ref, tenantWarehouseSecretPrefix):
		if !strings.HasPrefix(ref, prefix) {
			return "", fmt.Errorf("zerocopy credentials: reference is outside the requesting tenant's read-only warehouse namespace")
		}
		label = strings.TrimPrefix(ref, prefix)
	case strings.HasPrefix(strings.ToLower(ref), "vault://"):
		label = ref[len("vault://"):]
	case strings.HasPrefix(ref, "POSTWAVE_WH_"):
		label = strings.TrimPrefix(ref, "POSTWAVE_WH_")
	}
	if !credentialLabelPattern.MatchString(label) {
		return "", fmt.Errorf("zerocopy credentials: reference must be a tenant-local label of at most 128 letters, digits, dots, dashes, or underscores")
	}
	return prefix + label, nil
}

func tenantCredentialEnvName(name string) string {
	r := strings.NewReplacer("/", "_", "-", "_", ".", "_")
	return strings.ToUpper(r.Replace(name))
}

func parseTenantCredentialPayload(raw string) (map[string]any, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("zerocopy credentials: resolved credential is empty")
	}
	if len(raw) > hardMaxCredentialPayloadBytes {
		return nil, fmt.Errorf("zerocopy credentials: credential exceeds %d bytes", hardMaxCredentialPayloadBytes)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil || len(payload) == 0 {
		return nil, fmt.Errorf("zerocopy credentials: credential must be a non-empty JSON object with read_only=true")
	}
	return payload, nil
}
