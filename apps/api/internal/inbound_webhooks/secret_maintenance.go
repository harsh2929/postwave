// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	inboundSecretSentinel                = "envelope:do-not-use"
	defaultSecretMaintenanceBatchSize    = 50
	maxSecretMaintenanceBatchSize        = 200
	defaultSecretMaintenanceTickInterval = 30 * time.Second
)

var (
	errSecretMaintenanceCipher = errors.New("inbound_webhooks: secret maintenance requires an envelope cipher")

	inboundSecretMaintenanceTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "inbound_webhook_secret_maintenance_total",
		Help: "Inbound webhook signing-secret maintenance outcomes.",
	}, []string{"result"})
	inboundSecretMaintenancePending = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "inbound_webhook_secret_maintenance_pending",
		Help: "Legacy primary or secondary inbound webhook signing secrets still awaiting envelope maintenance.",
	})
)

// SecretMaintenanceResult is an operator-safe summary. It never contains
// plaintext, ciphertext, endpoint slugs, or tenant identifiers.
type SecretMaintenanceResult struct {
	Claimed            int
	PrimaryRewrapped   int
	SecondaryRewrapped int
	ExpiredCleared     int
	InvalidDisabled    int
	Remaining          int
}

// SecretMaintenanceWorker envelope-wraps historical plaintext signing
// secrets and clears expired rotation-grace material. Claims are bounded and
// use SKIP LOCKED, so one worker may safely run in every API replica.
type SecretMaintenanceWorker struct {
	Repo         *Repo
	Logger       *slog.Logger
	BatchSize    int
	TickInterval time.Duration
}

func (w *SecretMaintenanceWorker) Run(ctx context.Context) error {
	if w == nil || w.Repo == nil || w.Repo.Pool == nil {
		return nil
	}
	if w.Repo.Cipher == nil {
		return errSecretMaintenanceCipher
	}
	interval := w.TickInterval
	if interval <= 0 {
		interval = defaultSecretMaintenanceTickInterval
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
				inboundSecretMaintenanceTotal.WithLabelValues("error").Inc()
				if w.Logger != nil {
					w.Logger.Warn("inbound webhook secret maintenance failed",
						"error_code", "secret_maintenance_failed")
				}
			} else {
				inboundSecretMaintenancePending.Set(float64(result.Remaining))
				if result.Claimed > 0 {
					inboundSecretMaintenanceTotal.WithLabelValues("batch").Inc()
					if w.Logger != nil {
						w.Logger.Info("inbound webhook secret maintenance completed",
							"claimed", result.Claimed,
							"primary_rewrapped", result.PrimaryRewrapped,
							"secondary_rewrapped", result.SecondaryRewrapped,
							"expired_cleared", result.ExpiredCleared,
							"invalid_disabled", result.InvalidDisabled,
							"remaining", result.Remaining)
					}
				}
			}
			timer.Reset(interval)
		}
	}
}

func (w *SecretMaintenanceWorker) tickOnce(ctx context.Context) (SecretMaintenanceResult, error) {
	if w == nil || w.Repo == nil {
		return SecretMaintenanceResult{}, nil
	}
	return w.Repo.MaintainSecrets(ctx, w.BatchSize)
}

// MaintainSecrets processes one globally-oldest maintenance batch under the
// explicit worker RLS scope. Encryption and redaction commit atomically.
func (r *Repo) MaintainSecrets(ctx context.Context, batchSize int) (SecretMaintenanceResult, error) {
	var result SecretMaintenanceResult
	if r == nil || r.Pool == nil {
		return result, nil
	}
	if r.Cipher == nil {
		return result, errSecretMaintenanceCipher
	}
	if batchSize <= 0 {
		batchSize = defaultSecretMaintenanceBatchSize
	}
	if batchSize > maxSecretMaintenanceBatchSize {
		batchSize = maxSecretMaintenanceBatchSize
	}

	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	type maintenanceRow struct {
		id                string
		secret            string
		envelope          []byte
		state             string
		secondary         *string
		secondaryEnvelope []byte
		secondaryExpires  *time.Time
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, secret, secret_envelope, COALESCE(secret_storage_state, 'legacy_pending'),
       secondary_secret, secondary_secret_envelope, secondary_expires_at
  FROM inbound_webhook_endpoints
 WHERE (secret_storage_state IS NULL OR secret_storage_state = 'legacy_pending')
    OR (
        (secondary_secret IS NOT NULL
         OR secondary_secret_envelope IS NOT NULL
         OR secondary_expires_at IS NOT NULL)
        AND (
            secondary_expires_at IS NULL
            OR secondary_expires_at <= now()
            OR secondary_secret IS DISTINCT FROM 'envelope:do-not-use'
            OR secondary_secret_envelope IS NULL
        )
    )
 ORDER BY created_at, id
 FOR UPDATE SKIP LOCKED
 LIMIT $1`, batchSize)
	if err != nil {
		return result, err
	}
	claimed := make([]maintenanceRow, 0, batchSize)
	for rows.Next() {
		var row maintenanceRow
		if err := rows.Scan(
			&row.id,
			&row.secret,
			&row.envelope,
			&row.state,
			&row.secondary,
			&row.secondaryEnvelope,
			&row.secondaryExpires,
		); err != nil {
			rows.Close()
			return result, err
		}
		claimed = append(claimed, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return result, err
	}
	result.Claimed = len(claimed)

	now := time.Now().UTC()
	for _, row := range claimed {
		enabled := true
		if row.state == "" || row.state == "legacy_pending" {
			switch {
			case row.secret == inboundSecretSentinel && len(row.envelope) > 0:
				row.state = "ready"
			case strings.TrimSpace(row.secret) == "" || row.secret == inboundSecretSentinel:
				// There is no usable secret to recover. Fail the endpoint closed
				// and remove the misleading legacy storage state.
				row.secret = "invalid:redacted"
				row.envelope = nil
				row.state = "invalid"
				enabled = false
				result.InvalidDisabled++
			default:
				// Plaintext is the most recent write in the legacy rolling-
				// deployment shape. Always replace any existing envelope:
				// retaining it could silently reactivate the pre-rotation key.
				row.envelope, err = r.Cipher.Encrypt(ctx, []byte(row.secret))
				if err != nil {
					return result, errors.New("inbound_webhooks: primary secret maintenance encryption failed")
				}
				if len(row.envelope) == 0 {
					return result, errors.New("inbound_webhooks: primary secret maintenance produced empty ciphertext")
				}
				row.secret = inboundSecretSentinel
				row.state = "ready"
				result.PrimaryRewrapped++
			}
		}

		hasSecondary := row.secondary != nil ||
			len(row.secondaryEnvelope) > 0 ||
			row.secondaryExpires != nil
		expiredSecondary := row.secondaryExpires == nil ||
			!row.secondaryExpires.After(now)
		if hasSecondary && expiredSecondary {
			row.secondary = nil
			row.secondaryEnvelope = nil
			row.secondaryExpires = nil
			result.ExpiredCleared++
		} else if hasSecondary {
			switch {
			case row.secondary != nil &&
				*row.secondary == inboundSecretSentinel &&
				len(row.secondaryEnvelope) > 0:
				// Already envelope-backed; wait for its grace deadline.
			case row.secondary != nil &&
				strings.TrimSpace(*row.secondary) != "" &&
				*row.secondary != inboundSecretSentinel:
				// As for the primary, a real plaintext value wins over a stale
				// envelope left by a legacy rotation.
				row.secondaryEnvelope, err = r.Cipher.Encrypt(ctx, []byte(*row.secondary))
				if err != nil {
					return result, errors.New("inbound_webhooks: secondary secret maintenance encryption failed")
				}
				if len(row.secondaryEnvelope) == 0 {
					return result, errors.New("inbound_webhooks: secondary secret maintenance produced empty ciphertext")
				}
				sentinel := inboundSecretSentinel
				row.secondary = &sentinel
				result.SecondaryRewrapped++
			case len(row.secondaryEnvelope) > 0:
				sentinel := inboundSecretSentinel
				row.secondary = &sentinel
			default:
				// An active deadline without recoverable signing material offers
				// no grace. Clear it rather than repeatedly claiming the row.
				row.secondary = nil
				row.secondaryEnvelope = nil
				row.secondaryExpires = nil
				result.ExpiredCleared++
			}
		}

		tag, err := tx.Exec(ctx, `
UPDATE inbound_webhook_endpoints
   SET secret = $2,
       secret_envelope = $3,
       secret_storage_state = $4,
       enabled = CASE WHEN $5 THEN enabled ELSE false END,
       secondary_secret = $6,
       secondary_secret_envelope = $7,
       secondary_expires_at = $8
 WHERE id = $1::uuid`,
			row.id,
			row.secret,
			row.envelope,
			row.state,
			enabled,
			row.secondary,
			row.secondaryEnvelope,
			row.secondaryExpires,
		)
		if err != nil {
			return result, err
		}
		if tag.RowsAffected() != 1 {
			return result, errors.New("inbound_webhooks: secret maintenance claim changed")
		}
	}

	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM inbound_webhook_endpoints
 WHERE (secret_storage_state IS NULL OR secret_storage_state = 'legacy_pending')
    OR (
        (secondary_secret IS NOT NULL
         OR secondary_secret_envelope IS NOT NULL
         OR secondary_expires_at IS NOT NULL)
        AND (
            secondary_expires_at IS NULL
            OR secondary_expires_at <= now()
            OR secondary_secret IS DISTINCT FROM 'envelope:do-not-use'
            OR secondary_secret_envelope IS NULL
        )
    )`).Scan(&result.Remaining); err != nil {
		return result, err
	}
	if err := tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}
