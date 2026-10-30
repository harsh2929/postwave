// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Secret decryption, signing-key rotation windows, per-webhook delivery
// configuration and event matching for the outbound webhook Store. Webhook
// persistence and the delivery lease lifecycle stay in store.go.

// DecryptSecret returns the plaintext signing secret for a webhook.
// Used by the delivery worker. May be invoked from the worker's
// permissive context (no tenant scope) — we still pass tenantID + id
// to keep the lookup tight.
func (s *Store) DecryptSecret(ctx context.Context, tenantID, webhookID string) (string, error) {
	if s.Cipher == nil {
		return "", ErrCipherUnconfigured
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var envelope []byte
	if err := tx.QueryRow(ctx,
		`SELECT secret_envelope FROM outbound_webhooks
		   WHERE tenant_id = $1::uuid
		     AND id::text = $2
		     AND deleted_at IS NULL`,
		tenantID, webhookID,
	).Scan(&envelope); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	plaintext, err := s.Cipher.Decrypt(ctx, envelope, s.LegacyKEK)
	if err != nil {
		return "", fmt.Errorf("decrypt secret: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return string(plaintext), nil
}

// SigningKeys bundles the keying material the worker needs to sign
// a delivery. Algorithm picks the scheme; Primary is always set;
// Secondary is set only during the rotation grace window. Both byte
// slices are the algorithm-appropriate "store form" (HMAC: raw secret
// bytes; ECDSA/Ed25519: PEM-encoded private key).
type SigningKeys struct {
	Algorithm string
	Primary   []byte
	Secondary []byte // nil unless inside rotation grace window
}

// LoadSigningKeys returns the active signing material for a webhook,
// including the secondary key when the rotation grace window is open.
// Replaces DecryptSecret for callers that need to dual-sign.
func (s *Store) LoadSigningKeys(ctx context.Context, tenantID, webhookID string, now time.Time) (*SigningKeys, error) {
	if s.Cipher == nil {
		return nil, ErrCipherUnconfigured
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var algorithm string
	var primaryEnv, secondaryEnv []byte
	var secondaryExpires *time.Time
	if err := tx.QueryRow(ctx, `
SELECT signing_algorithm, secret_envelope,
       secondary_secret_envelope, secondary_expires_at
  FROM outbound_webhooks
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND deleted_at IS NULL`,
		tenantID, webhookID,
	).Scan(&algorithm, &primaryEnv, &secondaryEnv, &secondaryExpires); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	primary, err := s.Cipher.Decrypt(ctx, primaryEnv, s.LegacyKEK)
	if err != nil {
		return nil, fmt.Errorf("decrypt primary: %w", err)
	}
	out := &SigningKeys{Algorithm: algorithm, Primary: primary}
	if secondaryEnv != nil && secondaryExpires != nil && secondaryExpires.After(now) {
		sec, err := s.Cipher.Decrypt(ctx, secondaryEnv, s.LegacyKEK)
		if err != nil {
			// Don't fail the delivery just because we couldn't decrypt
			// the rotation-window backup — sign with primary only.
			_ = err
		} else {
			out.Secondary = sec
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// DeliveryConfig bundles the per-webhook filter + transformation that
// the worker applies BEFORE signing. Resolved once per delivery; cheap
// — both columns are nullable, so the common case is two NULL reads.
type DeliveryConfig struct {
	// Filter is the compiled filter expression, or nil for "always".
	Filter *Filter
	// Transform is the JSON-Pointer projection template, or nil for
	// "send payload as-is".
	Transform map[string]any
	// AuthConfig is the receiver-auth config applied after signing.
	AuthConfig *AuthConfig
}

// LoadDeliveryConfig returns the webhook's compiled Filter + Transform.
// Worker-permissive context — the worker sweeps across tenants, so the
// query runs without db.WithTenant. The query MUST include the
// tenant_id predicate so a future caller that passes a webhook id
// resolved from a different tenant's context can't silently inherit
// another tenant's filter/transform. The caller (worker.deliver) has
// p.TenantID from the leased PendingDelivery row.
func (s *Store) LoadDeliveryConfig(ctx context.Context, tenantID, webhookID string) (*DeliveryConfig, error) {
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var filterExpr *string
	var transformJSON []byte
	var authJSON, authEnvelope []byte
	var authState string
	row := tx.QueryRow(ctx, `
SELECT filter_expression, transform_template, COALESCE(auth_config, '{}'::jsonb),
       auth_config_envelope, auth_config_state
  FROM outbound_webhooks
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND deleted_at IS NULL`, tenantID, webhookID)
	if err := row.Scan(&filterExpr, &transformJSON, &authJSON, &authEnvelope, &authState); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	cfg := &DeliveryConfig{}
	if filterExpr != nil && strings.TrimSpace(*filterExpr) != "" {
		f, err := ParseFilter(*filterExpr)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidFilter, err)
		}
		cfg.Filter = f
	}
	if len(transformJSON) > 0 {
		var t map[string]any
		if err := json.Unmarshal(transformJSON, &t); err != nil {
			return nil, fmt.Errorf("%w: decode: %v", ErrInvalidTransform, err)
		}
		if err := ValidateTransform(t); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidTransform, err)
		}
		cfg.Transform = t
	}
	switch authState {
	case authConfigStateReady:
	case authConfigStateLegacyPending:
		return nil, ErrAuthConfigPending
	case authConfigStateInvalid:
		return nil, ErrAuthConfigInvalid
	default:
		return nil, fmt.Errorf("%w: unknown state", ErrAuthConfigInvalid)
	}
	if authMetadataContainsCredentialValues(authJSON) {
		return nil, fmt.Errorf("%w: plaintext metadata", ErrAuthConfigInvalid)
	}
	if len(authEnvelope) == 0 {
		if authMetadataClaimsCredentials(authJSON) {
			return nil, fmt.Errorf("%w: ciphertext missing", ErrAuthConfigInvalid)
		}
	} else {
		if !authMetadataIsEncrypted(authJSON) || !authMetadataClaimsCredentials(authJSON) {
			return nil, fmt.Errorf("%w: ciphertext metadata", ErrAuthConfigInvalid)
		}
		if len(authEnvelope) > maxAuthEnvelopeBytes {
			return nil, fmt.Errorf("%w: ciphertext size", ErrAuthConfigInvalid)
		}
		if s.Cipher == nil {
			return nil, ErrCipherUnconfigured
		}
		plaintext, err := s.Cipher.Decrypt(ctx, authEnvelope, s.LegacyKEK)
		if err != nil {
			return nil, fmt.Errorf("%w: decrypt receiver auth", ErrAuthConfigInvalid)
		}
		if len(plaintext) == 0 || len(plaintext) > maxAuthCredentialBytes {
			return nil, fmt.Errorf("%w: credential plaintext size", ErrAuthConfigInvalid)
		}
		authCfg, err := decodeAuthConfig(plaintext, false)
		if err != nil || authCfg == nil {
			return nil, fmt.Errorf("%w: credential payload", ErrAuthConfigInvalid)
		}
		cfg.AuthConfig = authCfg
	}
	return cfg, nil
}

// FindMatching looks up active webhooks across one tenant that
// subscribe to eventType. Tenant-scoped tx so RLS gates the read.
func (s *Store) FindMatching(ctx context.Context, tenantID, eventType string) ([]Webhook, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+webhookSelectColumns+`
 FROM outbound_webhooks
 WHERE tenant_id = $1::uuid
   AND deleted_at IS NULL
   AND active = true
   AND auth_config_state = 'ready'
   AND url_state = 'ready'
   AND $2 = ANY(events)`,
		tenantID, eventType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Webhook{}
	for rows.Next() {
		var w Webhook
		if err := scanWebhook(rows, &w); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
