// SPDX-License-Identifier: AGPL-3.0-only

// imap_secrets.go — resolving mailbox credential references.
//
// ValidSecretReference mirrors migration 1975's storage-integrity CHECK. The
// narrower ValidTenantSecretReference is the authorization boundary: a shape
// being safe to store does not make it safe for a tenant to choose.

package replies

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

var secretReferencePattern = regexp.MustCompile(
	`^(env|env-json|aws-sm|vault|gcp-sm|azure-kv):(?://)?[^\s]+$`)

// ValidSecretReference mirrors the SQL CHECK in migration 1975.
func ValidSecretReference(reference string) bool {
	reference = strings.TrimSpace(reference)
	return len(reference) >= 5 && len(reference) <= 1000 &&
		!strings.ContainsAny(reference, "\x00\r\n\t ") &&
		secretReferencePattern.MatchString(reference)
}

const tenantIMAPEnvironmentPrefix = "POSTWAVE_REPLY_IMAP_TENANT_"

var tenantSecretNamePattern = regexp.MustCompile(`^[A-Z0-9_]{1,128}$`)

// TenantEnvironmentSecretReference returns the namespace an operator must use
// when provisioning an IMAP credential for a tenant. Tenant-facing callers may
// select a value inside this namespace, but can never name an arbitrary process
// environment variable such as DATABASE_URL or GEMINI_API_KEY.
//
// UUIDs are rendered without punctuation so a secret name is portable across
// environment injectors and managed-secret adapters.
func TenantEnvironmentSecretReference(tenantID, name string) (string, error) {
	id, err := uuid.Parse(strings.TrimSpace(tenantID))
	if err != nil {
		return "", errors.New("replies: invalid tenant for secret reference")
	}
	name = strings.TrimSpace(name)
	if !tenantSecretNamePattern.MatchString(name) {
		return "", errors.New("replies: invalid tenant secret name")
	}
	compactTenantID := strings.ToUpper(strings.ReplaceAll(id.String(), "-", ""))
	return "env:" + tenantIMAPEnvironmentPrefix + compactTenantID + "_" + name, nil
}

// ValidTenantSecretReference is the trust boundary for references supplied by
// a tenant. The database's broader scheme vocabulary is intentionally not
// enough: those rows are also used by trusted deployment automation, whereas a
// tenant must be confined to its own environment namespace.
func ValidTenantSecretReference(tenantID, reference string) bool {
	reference = strings.TrimSpace(reference)
	if !ValidSecretReference(reference) || !strings.HasPrefix(reference, "env:") {
		return false
	}
	id, err := uuid.Parse(strings.TrimSpace(tenantID))
	if err != nil {
		return false
	}
	compactTenantID := strings.ToUpper(strings.ReplaceAll(id.String(), "-", ""))
	prefix := "env:" + tenantIMAPEnvironmentPrefix + compactTenantID + "_"
	if !strings.HasPrefix(reference, prefix) {
		return false
	}
	return tenantSecretNamePattern.MatchString(strings.TrimPrefix(reference, prefix))
}

// EnvironmentSecretResolver supports only the tenant-bound env namespace
// produced by TenantEnvironmentSecretReference.
//
// Deployments using a secret manager inject the corresponding resolver instead;
// this one refuses the other schemes rather than silently returning empty,
// because an empty password would present as "login rejected" and send an
// operator hunting the wrong problem.
type EnvironmentSecretResolver struct{}

func (EnvironmentSecretResolver) Resolve(_ context.Context, tenantID, reference string) (string, error) {
	reference = strings.TrimSpace(reference)
	if !ValidTenantSecretReference(tenantID, reference) {
		return "", errors.New("replies: secret reference is not valid for this tenant")
	}
	name := strings.TrimPrefix(reference, "env:")
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		// Names the reference, never the value — this reaches last_error.
		return "", errors.New("replies: referenced environment secret is unavailable")
	}
	return value, nil
}
