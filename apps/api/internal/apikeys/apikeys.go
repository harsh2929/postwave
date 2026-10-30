// SPDX-License-Identifier: AGPL-3.0-only
//
// Package apikeys owns the personal-access-token API key surface: per-tenant
// admin CRUD over hashed keys, plus helpers for the bearer-token middleware
// (apps/api/internal/middleware/apikey.go).
package apikeys

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Scope is one of the fixed permission scopes attachable to a key. The
// catalog mirrors the multi-select in the admin UI.
//
// Read scopes are view-only — they never authorize mutations. Audit
// scopes (audit:*) are orthogonal to the original CRUD scopes: a key
// can hold ScopeReadSubscribers without ScopeAuditRead, and vice
// versa. ScopeAdmin still grants everything as a wildcard.
type Scope string

const (
	ScopeReadSubscribers   Scope = "read:subscribers"
	ScopeWriteSubscribers  Scope = "write:subscribers"
	ScopeReadCampaigns     Scope = "read:campaigns"
	ScopeWriteCampaigns    Scope = "write:campaigns"
	ScopeSendTransactional Scope = "send:transactional"
	ScopeReadReports       Scope = "read:reports"
	ScopeAdmin             Scope = "admin"

	// Audit-log RBAC scopes (added with the rbac-meta-audit feature).
	// Compliance category, priority P0 in the Moosewave audit gap-doc.
	//
	//   ScopeAuditRead             — view /api/v1/audit list, stats,
	//                                 saved views, retention setting,
	//                                 stream (live tail), event details
	//   ScopeAuditReadPII          — additionally see PII columns (ip,
	//                                 user_agent, user_id) in audit
	//                                 rows; without this the read path
	//                                 masks them on the wire
	//   ScopeAuditReadAllTenants   — cross-tenant read (operator role,
	//                                 e.g. for support); without this
	//                                 the existing RLS GUC still scopes
	//                                 to the actor's own tenant
	//   ScopeAuditConfigureSinks   — manage /api/v1/audit-sinks +
	//                                 /api/v1/audit-alerts (route to
	//                                 S3/Datadog/Splunk, alert rules)
	//   ScopeAuditConfigureRetention — set per-tenant
	//                                  audit_retention_days (data
	//                                  governance lever)
	//   ScopeAuditExecuteActions   — trigger destructive audit ops:
	//                                  DLQ replay, circuit reset,
	//                                  manual alert fire
	ScopeAuditRead               Scope = "audit:read"
	ScopeAuditReadPII            Scope = "audit:read_pii"
	ScopeAuditReadAllTenants     Scope = "audit:read_all_tenants"
	ScopeAuditConfigureSinks     Scope = "audit:configure_sinks"
	ScopeAuditConfigureRetention Scope = "audit:configure_retention"
	ScopeAuditExecuteActions     Scope = "audit:execute_actions"
)

// AllScopes is the canonical scope catalog.
var AllScopes = []Scope{
	ScopeReadSubscribers, ScopeWriteSubscribers,
	ScopeReadCampaigns, ScopeWriteCampaigns,
	ScopeSendTransactional, ScopeReadReports, ScopeAdmin,
	ScopeAuditRead, ScopeAuditReadPII, ScopeAuditReadAllTenants,
	ScopeAuditConfigureSinks, ScopeAuditConfigureRetention, ScopeAuditExecuteActions,
}

// AllAuditScopes is the audit-specific subset of AllScopes, used by
// the Settings > Team > Roles UI to render the role-to-scope matrix.
var AllAuditScopes = []Scope{
	ScopeAuditRead, ScopeAuditReadPII, ScopeAuditReadAllTenants,
	ScopeAuditConfigureSinks, ScopeAuditConfigureRetention, ScopeAuditExecuteActions,
}

// IsValidScope reports whether s is one of AllScopes.
func IsValidScope(s string) bool {
	for _, sc := range AllScopes {
		if string(sc) == s {
			return true
		}
	}
	return false
}

// APIKey mirrors the api_keys table. Plaintext is never stored — Repo.Create
// returns it once via CreateResponse and forgets it.
type APIKey struct {
	ID                   string     `json:"id"`
	TenantID             string     `json:"tenantId"`
	UserID               string     `json:"userId,omitempty"`
	Label                string     `json:"label"`
	Prefix               string     `json:"prefix"`
	Scopes               []Scope    `json:"scopes"`
	CreatedAt            time.Time  `json:"createdAt"`
	LastUsedAt           *time.Time `json:"lastUsedAt,omitempty"`
	RevokedAt            *time.Time `json:"revokedAt,omitempty"`
	ActorType            string     `json:"actorType"`            // "human" | "agent"
	ActorLabel           string     `json:"actorLabel,omitempty"` // free-form, e.g. "claude-code"
	SendsPerDay          *int       `json:"sendsPerDay,omitempty"`
	DollarsPerMonthCents *int       `json:"dollarsPerMonthCents,omitempty"`
	// AllowedIPs is a CIDR allowlist. Empty = unrestricted. Stored as
	// inet[] in Postgres; surfaced as []string here for JSON
	// transparency (the inet textual form Postgres returns is exactly
	// what the caller passed at create time, modulo normalisation).
	AllowedIPs []string `json:"allowedIps,omitempty"`

	// Per-key rate limits (added in 0051). Nil/zero = unlimited.
	// Enforced by middleware.KeyRateLimit on every authenticated
	// request after the API key is resolved.
	RateLimitPerMin *int `json:"rateLimitPerMin,omitempty"`
	RateLimitPerDay *int `json:"rateLimitPerDay,omitempty"`
	RateLimitBurst  *int `json:"rateLimitBurst,omitempty"`

	// SandboxOnly forces every request authenticated by this key into
	// sandbox mode. Downstream send paths must simulate lifecycle events
	// and never dispatch real mail when this flag is true.
	SandboxOnly bool `json:"sandboxOnly"`

	// ExpiresAt is an optional expiry (SETC-036). Nil = never expires. A key
	// past its expiry stops authenticating (enforced in LookupByHash).
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
}

// CreateInput is the body of POST /api/v1/api-keys.
type CreateInput struct {
	Label     string     `json:"label"`
	Scopes    []Scope    `json:"scopes"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	// AllowedIPs is an optional CIDR allowlist. Empty / nil = no
	// restriction (default). Non-empty: bearer auth fails 401 for
	// requests originating outside the listed addresses/ranges.
	//
	// Examples accepted:
	//
	//   ["203.0.113.5/32"]              — single host
	//   ["203.0.113.0/24"]              — RFC 5737 documentation /24
	//   ["10.0.0.0/8", "192.168.0.0/16"] — multiple ranges
	AllowedIPs []string `json:"allowed_ips,omitempty"`
	// SandboxOnly creates a key that can exercise production-like send
	// flows without reaching Listmonk or an ESP.
	SandboxOnly bool `json:"sandbox_only,omitempty"`
}

// CreateResponse exposes the plaintext key once.
type CreateResponse struct {
	Key       APIKey `json:"key"`
	Plaintext string `json:"plaintext"`
}

// RotateResponse is the body returned by POST /api/v1/api-keys/{id}/rotate.
//
// `RevokedID` echoes the just-revoked key's id so the caller can render
// "rotated <prev_label> → <new_id>" in the audit log without a follow-
// up read. The old plaintext is permanently invalidated; there is no
// way to recover it.
type RotateResponse struct {
	Key       APIKey `json:"key"`
	Plaintext string `json:"plaintext"`
	RevokedID string `json:"revoked_id"`
}

// ErrInvalidKey is returned when a bearer token is malformed or unknown.
var ErrInvalidKey = errors.New("apikeys: invalid key")

// NewKey returns a fresh plaintext key in the form
// `pw_live_<4 hex>_<48 hex>`. The 4-hex prefix middle is what the UI
// surfaces alongside the masked tail; the full string is what callers send
// in `Authorization: Bearer <key>`.
func NewKey() (plaintext, prefix string, err error) {
	var head [2]byte
	if _, err := rand.Read(head[:]); err != nil {
		return "", "", fmt.Errorf("apikeys: rand head: %w", err)
	}
	var tail [24]byte
	if _, err := rand.Read(tail[:]); err != nil {
		return "", "", fmt.Errorf("apikeys: rand tail: %w", err)
	}
	prefix = "pw_live_" + hex.EncodeToString(head[:]) // 8 chars after pw_live_
	plaintext = prefix + "_" + hex.EncodeToString(tail[:])
	return plaintext, prefix, nil
}

// PrefixOf extracts the visible prefix (`pw_live_xxxx`) from a plaintext
// key. Returns "" if the key is malformed.
func PrefixOf(plaintext string) string {
	parts := strings.SplitN(plaintext, "_", 4)
	if len(parts) < 4 {
		return ""
	}
	return parts[0] + "_" + parts[1] + "_" + parts[2]
}

// HashWithPepper returns the canonical hex digest of plaintext for indexed
// lookup in api_keys.key_hash.
//
// When pepper is non-empty: HMAC-SHA256(pepper, plaintext). A DB leak alone
// is useless to an attacker because the pepper lives in the gateway env /
// KMS, not the database.
//
// When pepper is empty: plain SHA-256(plaintext). This is the legacy mode
// retained for local-dev compatibility with existing rows. main.go logs a
// warning at startup when the pepper is unset, and the production startup
// gate refuses to boot without it.
//
// Hash is deterministic for a given (plaintext, pepper) pair, so existing
// rows resolve as long as the running pepper is the one that wrote them.
// Pepper rotation requires re-issuing every key.
func HashWithPepper(plaintext string, pepper []byte) string {
	if len(pepper) == 0 {
		sum := sha256.Sum256([]byte(plaintext))
		return hex.EncodeToString(sum[:])
	}
	m := hmac.New(sha256.New, pepper)
	m.Write([]byte(plaintext))
	return hex.EncodeToString(m.Sum(nil))
}

// Hash is the legacy single-arg form retained for tests and any caller that
// has not yet been threaded with a pepper. New code should call
// HashWithPepper directly.
//
// Deprecated: use HashWithPepper.
func Hash(plaintext string) string {
	return HashWithPepper(plaintext, nil)
}

// MaskedTail returns the last 4 hex chars of the plaintext key, used for
// the `pw_live_••••3a2b` UI shorthand. Stored alongside the prefix.
func MaskedTail(plaintext string) string {
	if len(plaintext) < 4 {
		return ""
	}
	return plaintext[len(plaintext)-4:]
}
