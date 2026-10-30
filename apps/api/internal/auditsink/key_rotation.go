// SPDX-License-Identifier: AGPL-3.0-only
//
// key_rotation.go — Standard Webhooks signing-key lifecycle.
//
// Each HTTP sink with webhook_format=standard_webhooks needs at least
// one active key in audit_sink_signing_keys for the worker to sign
// outbound batches with. This file owns:
//
//   - activeSigningKey: lookup hot-path used by deliverHTTP. Returns
//     the most recent non-revoked key for a sink, bootstrapping one if
//     none exists (first-time delivery for a freshly-created sink).
//
//   - RotateKey: explicit operator-driven rotation. Inserts a new key
//     and immediately marks the old one revoked (with a 30-minute
//     grace window where it stays in the JWKS — see admin_signing.go).
//
//   - KeyRotator.Run: background worker that walks every HTTP sink
//     with format=standard_webhooks every N minutes and rotates any
//     key older than RotationTTL (default 90 days). Inserts the new
//     key and leaves the old one with revoked_at=now() so existing
//     consumers have the grace window.
//
// All paths set app.outbox_worker='true' so the worker policy on
// audit_sink_signing_keys lets the queries through without per-tenant
// GUC juggling.

package auditsink

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// KeyRotationTTL is the default age after which a signing key gets
// automatically rotated by KeyRotator.Run. 90 days matches the SOC2
// "rotate annually, plus on demand" baseline plus a comfortable margin.
const KeyRotationTTL = 90 * 24 * time.Hour

// activeSigningKey returns the raw HMAC secret + kid for the sink's
// most-recent non-revoked signing key. Bootstraps a new key when none
// exists (first delivery on a fresh sink). Uses the worker GUC so it
// works inside the worker context (no per-tenant tx).
func (d *Deps) activeSigningKey(ctx context.Context, s Sink) ([]byte, string, error) {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		kid            string
		secretEnvelope []byte
	)
	err = tx.QueryRow(ctx, `
SELECT kid, secret_envelope
  FROM audit_sink_signing_keys
 WHERE sink_id = $1::uuid
   AND revoked_at IS NULL
 ORDER BY rotated_at DESC
 LIMIT 1`, s.ID).Scan(&kid, &secretEnvelope)
	if errors.Is(err, pgx.ErrNoRows) {
		// No active key — bootstrap one so the first delivery on a
		// fresh sink still goes out. Subsequent deliveries hit the row
		// we just inserted.
		_ = tx.Rollback(ctx)
		kid, secretEnvelope, err = d.bootstrapSigningKey(ctx, s)
		if err != nil {
			return nil, "", err
		}
	} else if err != nil {
		return nil, "", err
	} else {
		_ = tx.Rollback(ctx)
	}
	secret, err := d.decryptSecret(ctx, secretEnvelope)
	if err != nil {
		return nil, "", fmt.Errorf("decrypt signing key: %w", err)
	}
	return secret, kid, nil
}

// bootstrapSigningKey inserts the first signing key for a sink. The kid
// is short random hex; the secret is 32 bytes of CSPRNG output (HS256
// security floor). Encrypted at rest via the Encrypter when configured.
func (d *Deps) bootstrapSigningKey(ctx context.Context, s Sink) (string, []byte, error) {
	kid, envelope, err := d.generateSigningKey(ctx)
	if err != nil {
		return "", nil, err
	}
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return "", nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_sink_signing_keys
  (tenant_id, sink_id, kid, alg, secret_envelope)
VALUES ($1::uuid, $2::uuid, $3, 'HS256', $4::bytea)
ON CONFLICT (tenant_id, sink_id, kid) DO NOTHING`,
		s.TenantID, s.ID, kid, envelope); err != nil {
		return "", nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", nil, err
	}
	return kid, envelope, nil
}

// generateSigningKey returns a fresh (kid, secret_envelope) pair. The
// secret is 32 random bytes; envelope-encrypted when an Encrypter is
// wired, otherwise stored raw (dev-mode only — mirrors the credentials
// envelope convention in admin.go).
func (d *Deps) generateSigningKey(ctx context.Context) (string, []byte, error) {
	var kidBytes [8]byte
	if _, err := rand.Read(kidBytes[:]); err != nil {
		return "", nil, fmt.Errorf("kid rand: %w", err)
	}
	kid := hex.EncodeToString(kidBytes[:])
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return "", nil, fmt.Errorf("secret rand: %w", err)
	}
	envelope, err := d.encryptSecret(ctx, secret[:])
	if err != nil {
		return "", nil, err
	}
	return kid, envelope, nil
}

// encryptSecret wraps a raw HMAC secret under the platform Encrypter
// when available, otherwise returns it raw (dev-mode contract).
func (d *Deps) encryptSecret(ctx context.Context, plaintext []byte) ([]byte, error) {
	if d.Encrypter == nil {
		return plaintext, nil
	}
	return d.Encrypter.Encrypt(ctx, plaintext)
}

// decryptSecret unwraps an envelope produced by encryptSecret. Empty
// envelope is an error — never sign with a zero secret.
func (d *Deps) decryptSecret(ctx context.Context, envelope []byte) ([]byte, error) {
	if len(envelope) == 0 {
		return nil, errors.New("signing key envelope is empty")
	}
	if d.Cipher == nil {
		// Dev-mode: envelope is the raw secret.
		return envelope, nil
	}
	return d.Cipher.Decrypt(ctx, envelope, nil)
}

// RotateKey inserts a new signing key for the sink and marks the
// previously-active key revoked. Returns the new kid. Operators trigger
// this through the admin POST /api/v1/audit-sinks/{id}/rotate-key
// endpoint; the rotation worker calls the same code path on its TTL.
//
// Old keys remain visible in the JWKS endpoint (admin_signing.go) until
// the grace window has elapsed so in-flight consumers can still verify
// signatures issued just before rotation.
func (d *Deps) RotateKey(ctx context.Context, tenantID, sinkID string) (string, error) {
	kid, envelope, err := d.generateSigningKey(ctx)
	if err != nil {
		return "", err
	}
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE audit_sink_signing_keys
   SET revoked_at = now(), updated_at = now()
 WHERE sink_id = $1::uuid
   AND revoked_at IS NULL`, sinkID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_sink_signing_keys
  (tenant_id, sink_id, kid, alg, secret_envelope)
VALUES ($1::uuid, $2::uuid, $3, 'HS256', $4::bytea)`,
		tenantID, sinkID, kid, envelope); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return kid, nil
}

// KeyRotator is the background worker that auto-rotates aged keys.
type KeyRotator struct {
	Deps     *Deps
	Logger   *slog.Logger
	Interval time.Duration
	TTL      time.Duration
}

// Run drives the rotator on the configured interval. Cancels on ctx.
func (k *KeyRotator) Run(ctx context.Context) error {
	if k.Deps == nil {
		return errors.New("auditsink rotator: Deps required")
	}
	interval := k.Interval
	if interval <= 0 {
		interval = 6 * time.Hour
	}
	ttl := k.TTL
	if ttl <= 0 {
		ttl = KeyRotationTTL
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	if k.Logger != nil {
		k.Logger.Info("auditsink key-rotator: starting",
			"interval", interval.String(), "ttl", ttl.String())
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
		if err := k.tick(ctx, ttl); err != nil && k.Logger != nil {
			k.Logger.Warn("auditsink key-rotator tick failed",
				"err", err.Error())
		}
	}
}

// tick walks every HTTP sink with webhook_format=standard_webhooks and
// rotates any whose newest active key is older than ttl.
func (k *KeyRotator) tick(ctx context.Context, ttl time.Duration) error {
	tx, err := db.WithWorkerScope(ctx, k.Deps.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT s.id::text, s.tenant_id::text
  FROM audit_sinks s
 WHERE s.kind = 'http'
   AND s.enabled = true
   AND COALESCE(s.webhook_format, 'postwave_v1') = 'standard_webhooks'
   AND NOT EXISTS (
       SELECT 1 FROM audit_sink_signing_keys k
        WHERE k.sink_id = s.id
          AND k.revoked_at IS NULL
          AND k.rotated_at > now() - $1::interval
   )`, fmt.Sprintf("%d seconds", int(ttl.Seconds())))
	if err != nil {
		return err
	}
	defer rows.Close()
	type pending struct {
		sinkID, tenantID string
	}
	var todo []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.sinkID, &p.tenantID); err != nil {
			return err
		}
		todo = append(todo, p)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	for _, p := range todo {
		if _, err := k.Deps.RotateKey(ctx, p.tenantID, p.sinkID); err != nil {
			if k.Logger != nil {
				k.Logger.Warn("auditsink key-rotator rotate failed",
					"sink", p.sinkID, "err", err.Error())
			}
			continue
		}
		if k.Logger != nil {
			k.Logger.Info("auditsink key-rotator: rotated",
				"sink", p.sinkID)
		}
	}
	return nil
}
