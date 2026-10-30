// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	defaultAuthRewrapBatchSize = 25
	maxAuthRewrapBatchSize     = 100
	defaultAuthRewrapInterval  = 30 * time.Second
)

// AuthConfigRewrapResult describes one bounded legacy-credential pass.
type AuthConfigRewrapResult struct {
	Claimed   int
	Rewrapped int
	Invalid   int
	Cleared   int
}

// AuthConfigRewrapWorker migrates legacy plaintext auth_config rows. It is
// intentionally separate from delivery: a delivery must never opportunistically
// decrypt/use plaintext and then attempt a best-effort migration.
type AuthConfigRewrapWorker struct {
	Store        *Store
	Logger       *slog.Logger
	BatchSize    int
	TickInterval time.Duration
}

func (w *AuthConfigRewrapWorker) Run(ctx context.Context) error {
	if w == nil || w.Store == nil || w.Store.Pool == nil {
		return nil
	}
	if w.Store.Cipher == nil {
		return ErrCipherUnconfigured
	}
	interval := w.TickInterval
	if interval <= 0 {
		interval = defaultAuthRewrapInterval
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			result, err := w.tickOnce(ctx)
			if err != nil {
				if w.Logger != nil {
					w.Logger.Warn("outbound webhook receiver-auth rewrap failed", "err", err.Error())
				}
			} else if result.Claimed > 0 && w.Logger != nil {
				w.Logger.Info("outbound webhook receiver-auth rewrap completed",
					"claimed", result.Claimed,
					"rewrapped", result.Rewrapped,
					"cleared", result.Cleared,
					"invalid", result.Invalid)
			}
			timer.Reset(interval)
		}
	}
}

func (w *AuthConfigRewrapWorker) tickOnce(ctx context.Context) (AuthConfigRewrapResult, error) {
	if w == nil || w.Store == nil {
		return AuthConfigRewrapResult{}, nil
	}
	return w.Store.RewrapLegacyAuthConfigs(ctx, w.BatchSize)
}

// RewrapLegacyAuthConfigs claims and processes at most batchSize rows under the
// existing app.outbox_worker RLS policies. Valid configs become encrypted plus
// value-free metadata. Malformed configs are redacted, marked invalid and
// disabled in the same transaction, so they can neither leak nor deliver.
func (s *Store) RewrapLegacyAuthConfigs(ctx context.Context, batchSize int) (AuthConfigRewrapResult, error) {
	var result AuthConfigRewrapResult
	if s == nil || s.Pool == nil {
		return result, nil
	}
	if s.Cipher == nil {
		return result, ErrCipherUnconfigured
	}
	if batchSize <= 0 {
		batchSize = defaultAuthRewrapBatchSize
	}
	if batchSize > maxAuthRewrapBatchSize {
		batchSize = maxAuthRewrapBatchSize
	}

	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	type legacyRow struct {
		id       string
		tenantID string
		raw      []byte
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, auth_config
  FROM outbound_webhooks
 WHERE auth_config_state = 'legacy_pending'
 ORDER BY updated_at, id
 FOR UPDATE SKIP LOCKED
 LIMIT $1`, batchSize)
	if err != nil {
		return result, err
	}
	legacy := make([]legacyRow, 0, batchSize)
	for rows.Next() {
		var row legacyRow
		if err := rows.Scan(&row.id, &row.tenantID, &row.raw); err != nil {
			rows.Close()
			return result, err
		}
		legacy = append(legacy, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return result, err
	}

	result.Claimed = len(legacy)
	for _, row := range legacy {
		normalized, decodeErr := decodeLegacyAuthConfig(row.raw)
		if decodeErr != nil {
			if err := markLegacyAuthInvalid(ctx, tx, row.tenantID, row.id); err != nil {
				return result, err
			}
			result.Invalid++
			continue
		}
		metadata, err := encodeAuthMetadata(normalized)
		if err != nil {
			return result, err
		}
		var envelope []byte
		if normalized != nil {
			plaintext, err := json.Marshal(normalized)
			if err != nil {
				return result, err
			}
			envelope, err = s.Cipher.Encrypt(ctx, plaintext)
			if err != nil {
				return result, errors.New("outbound_webhooks: receiver-auth rewrap encryption failed")
			}
			if len(envelope) == 0 || len(envelope) > maxAuthEnvelopeBytes {
				return result, errors.New("outbound_webhooks: receiver-auth rewrap produced invalid ciphertext size")
			}
		}
		var restoredActive bool
		err = tx.QueryRow(ctx, `
UPDATE outbound_webhooks
   SET auth_config = $3::jsonb,
       auth_config_envelope = $4,
       auth_config_state = 'ready',
       active = CASE
           WHEN deleted_at IS NULL
           THEN COALESCE(auth_config_restore_active, false)
           ELSE false
       END,
       auth_config_restore_active = NULL,
       updated_at = now(),
       config_version = config_version + CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND auth_config_state = 'legacy_pending'
 RETURNING active`,
			row.tenantID, row.id, string(metadata), envelope).Scan(&restoredActive)
		if err != nil {
			return result, err
		}
		if restoredActive {
			if err := resumePausedDeliveries(ctx, tx, row.tenantID, row.id); err != nil {
				return result, err
			}
		}
		if normalized == nil {
			result.Cleared++
		} else {
			result.Rewrapped++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

func decodeLegacyAuthConfig(raw []byte) (*AuthConfig, error) {
	if len(raw) == 0 || len(raw) > maxAuthCredentialBytes {
		return nil, ErrInvalidAuthConfig
	}
	return decodeAuthConfig(raw, false)
}

func markLegacyAuthInvalid(ctx context.Context, tx pgx.Tx, tenantID, id string) error {
	tag, err := tx.Exec(ctx, `
UPDATE outbound_webhooks
   SET auth_config = '{"secret_redacted":true}'::jsonb,
       auth_config_envelope = NULL,
       auth_config_state = 'invalid',
       active = false,
       auth_config_restore_active = NULL,
       updated_at = now(),
       config_version = config_version + CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND auth_config_state = 'legacy_pending'`,
		tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("outbound_webhooks: invalid receiver-auth claim changed")
	}
	return nil
}
