// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	destinationStateReady         = "ready"
	destinationStateLegacyPending = "legacy_pending"
	destinationStateInvalid       = "invalid"

	maxDestinationPlaintextBytes = 2048
	maxDestinationEnvelopeBytes  = 16 << 10

	defaultDestinationRewrapBatchSize = 25
	maxDestinationRewrapBatchSize     = 100
	defaultDestinationRewrapInterval  = 30 * time.Second
)

// destinationDisplay returns the non-secret projection exposed in API/UI
// responses. Path and query presence remain visible for troubleshooting, but
// their values never survive in plaintext storage.
func destinationDisplay(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "invalid://redacted"
	}
	display := strings.ToLower(parsed.Scheme) + "://" + parsed.Host
	if parsed.EscapedPath() != "" && parsed.EscapedPath() != "/" {
		display += "/…"
	} else if parsed.EscapedPath() == "/" {
		display += "/"
	}
	if parsed.RawQuery != "" {
		display += "?…"
	}
	return display
}

func (s *Store) encodeDestination(
	ctx context.Context,
	raw string,
	requireHTTPS bool,
) (display string, envelope []byte, err error) {
	raw = strings.TrimSpace(raw)
	if err := validateURL(raw, requireHTTPS); err != nil {
		return "", nil, err
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", nil, ErrInvalidURL
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	raw = parsed.String()
	if s == nil || s.Cipher == nil {
		return "", nil, ErrCipherUnconfigured
	}
	envelope, err = s.Cipher.Encrypt(ctx, []byte(raw))
	if err != nil {
		return "", nil, fmt.Errorf("encrypt webhook destination: %w", err)
	}
	if len(envelope) == 0 || len(envelope) > maxDestinationEnvelopeBytes {
		return "", nil, errors.New("encrypt webhook destination: invalid ciphertext size")
	}
	return destinationDisplay(raw), envelope, nil
}

// ResolveDestination opens the complete receiver URL only in memory at the
// moment it is needed for a test/playground/delivery.
func (s *Store) ResolveDestination(ctx context.Context, tenantID, webhookID string) (string, error) {
	if s == nil || s.Pool == nil {
		return "", ErrNotFound
	}
	if s.Cipher == nil {
		return "", ErrCipherUnconfigured
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var envelope []byte
	var state string
	err = tx.QueryRow(ctx, `
SELECT url_envelope, COALESCE(url_state, 'legacy_pending')
 FROM outbound_webhooks
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND deleted_at IS NULL`, tenantID, webhookID).Scan(&envelope, &state)
	if err != nil {
		return "", err
	}
	if state != destinationStateReady || len(envelope) == 0 ||
		len(envelope) > maxDestinationEnvelopeBytes {
		if state == destinationStateLegacyPending {
			return "", ErrDestinationPending
		}
		return "", ErrDestinationInvalid
	}
	plaintext, err := s.Cipher.Decrypt(ctx, envelope, s.LegacyKEK)
	if err != nil {
		return "", fmt.Errorf("%w: decrypt", ErrDestinationInvalid)
	}
	if len(plaintext) == 0 || len(plaintext) > maxDestinationPlaintextBytes {
		return "", fmt.Errorf("%w: plaintext size", ErrDestinationInvalid)
	}
	destination := string(plaintext)
	if err := validateURL(destination, s.RequireHTTPS); err != nil {
		return "", ErrDestinationInvalid
	}
	parsed, err := url.Parse(destination)
	if err != nil {
		return "", ErrDestinationInvalid
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	return parsed.String(), nil
}

type DestinationRewrapResult struct {
	Claimed   int
	Rewrapped int
	Invalid   int
	Remaining int
}

// DestinationRewrapWorker migrates historical capability-bearing URLs into
// envelope storage. It runs immediately and then in bounded, SKIP LOCKED
// batches so every API replica may participate safely.
type DestinationRewrapWorker struct {
	Store        *Store
	Logger       *slog.Logger
	BatchSize    int
	TickInterval time.Duration
}

func (w *DestinationRewrapWorker) Run(ctx context.Context) error {
	if w == nil || w.Store == nil || w.Store.Pool == nil {
		return nil
	}
	if w.Store.Cipher == nil {
		return ErrCipherUnconfigured
	}
	interval := w.TickInterval
	if interval <= 0 {
		interval = defaultDestinationRewrapInterval
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			result, err := w.Store.RewrapLegacyDestinations(ctx, w.BatchSize)
			if err != nil {
				if w.Logger != nil {
					w.Logger.Warn("outbound webhook destination rewrap failed",
						"error_code", "destination_rewrap_failed")
				}
			} else if result.Claimed > 0 && w.Logger != nil {
				w.Logger.Info("outbound webhook destination rewrap completed",
					"claimed", result.Claimed,
					"rewrapped", result.Rewrapped,
					"invalid", result.Invalid,
					"remaining", result.Remaining)
			}
			timer.Reset(interval)
		}
	}
}

func (s *Store) RewrapLegacyDestinations(
	ctx context.Context,
	batchSize int,
) (DestinationRewrapResult, error) {
	var result DestinationRewrapResult
	if s == nil || s.Pool == nil {
		return result, nil
	}
	if s.Cipher == nil {
		return result, ErrCipherUnconfigured
	}
	if batchSize <= 0 {
		batchSize = defaultDestinationRewrapBatchSize
	}
	if batchSize > maxDestinationRewrapBatchSize {
		batchSize = maxDestinationRewrapBatchSize
	}
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	type row struct {
		id       string
		tenantID string
		raw      string
		active   bool
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, url, active
  FROM outbound_webhooks
 WHERE url_state IS NULL OR url_state = 'legacy_pending'
 ORDER BY updated_at, id
 FOR UPDATE SKIP LOCKED
 LIMIT $1`, batchSize)
	if err != nil {
		return result, err
	}
	claimed := make([]row, 0, batchSize)
	for rows.Next() {
		var item row
		if err := rows.Scan(&item.id, &item.tenantID, &item.raw, &item.active); err != nil {
			rows.Close()
			return result, err
		}
		claimed = append(claimed, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return result, err
	}
	result.Claimed = len(claimed)
	for _, item := range claimed {
		display, envelope, encodeErr := s.encodeDestination(ctx, item.raw, s.RequireHTTPS)
		if encodeErr != nil {
			// Remove any capability value even for an invalid legacy URL and
			// fail the subscription closed for explicit operator repair.
			if _, err := tx.Exec(ctx, `
UPDATE outbound_webhooks
   SET url = 'invalid://redacted',
       url_envelope = NULL,
       url_state = 'invalid',
       active = false,
       disabled_reason = COALESCE(disabled_reason, 'manual'),
       disabled_at = COALESCE(disabled_at, now()),
       updated_at = now(),
       config_version = config_version + CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
				item.tenantID,
				item.id,
			); err != nil {
				return result, err
			}
			if err := pauseURLDeliveries(ctx, tx, item.tenantID, item.id); err != nil {
				return result, err
			}
			result.Invalid++
			continue
		}
		if _, err := tx.Exec(ctx, `
UPDATE outbound_webhooks
   SET url = $3,
       url_envelope = $4,
       url_state = 'ready',
       updated_at = now(),
       config_version = config_version + CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
			item.tenantID,
			item.id,
			display,
			envelope,
		); err != nil {
			return result, err
		}
		if item.active {
			if err := resumePausedDeliveries(ctx, tx, item.tenantID, item.id); err != nil {
				return result, err
			}
		}
		result.Rewrapped++
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM outbound_webhooks
 WHERE url_state IS NULL OR url_state = 'legacy_pending'`).Scan(&result.Remaining); err != nil {
		return result, err
	}
	if err := tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

func pauseURLDeliveries(ctx context.Context, tx pgx.Tx, tenantID, webhookID string) error {
	_, err := tx.Exec(ctx, `
UPDATE outbound_webhook_deliveries
   SET next_attempt_at = NULL,
       url_paused_at = COALESCE(url_paused_at, now()),
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE tenant_id = $1::uuid
   AND webhook_id = $2::uuid
   AND status = 'pending'`, tenantID, webhookID)
	return err
}
