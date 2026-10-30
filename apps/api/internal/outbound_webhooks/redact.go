// SPDX-License-Identifier: AGPL-3.0-only
//
// redact.go — background worker that scrubs receiver-response bodies
// from outbound_webhook_deliveries after a retention window.
//
// Why: every delivery row persists the receiver's last response body
// in `last_response_body_truncated` for operator debugging. Receivers
// commonly echo PII (email addresses, user names, sometimes tokens)
// in their 4xx/5xx error responses. Holding that PII indefinitely
// builds up a third-party PII footprint per tenant — fine for
// 7-day debug; problematic for compliance review.
//
// What this worker does: every 5 minutes, walks rows where
//   created_at < now() - 7 days
//   AND last_response_body_redacted_at IS NULL
//   AND last_response_body_truncated IS NOT NULL
// and replaces the body with a SHA-256 hash + byte-length tag
// (e.g. "redacted:sha256=<64hex>:bytes=<n>"). Stamps the redaction
// timestamp so the worker never re-touches the same row.
//
// Operators querying recent failures still see the raw body for the
// first 7 days; after that the hash is enough to recognize identical
// receiver responses without leaking the content.

package outbound_webhooks

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// RedactionWorker walks aged delivery rows and replaces their stored
// receiver-response bodies with a hash+length tag. Stateless; safe to
// run one per process.
type RedactionWorker struct {
	Pool *db.Pool
	// RetentionWindow is how long a raw body sticks around before
	// redaction. Defaults to 7 * 24 * time.Hour when zero.
	RetentionWindow time.Duration
	// TickInterval defaults to 5 * time.Minute.
	TickInterval time.Duration
	// BatchSize bounds rows processed per tick. Defaults to 200.
	BatchSize int
	Logger    *slog.Logger
}

// Run loops until ctx is cancelled. Each tick redacts at most
// BatchSize rows in one short tx. Errors are logged and skipped;
// the worker continues on the next tick.
func (w *RedactionWorker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return nil
	}
	if w.RetentionWindow <= 0 {
		w.RetentionWindow = 7 * 24 * time.Hour
	}
	if w.TickInterval <= 0 {
		w.TickInterval = 5 * time.Minute
	}
	if w.BatchSize <= 0 {
		w.BatchSize = 200
	}
	t := time.NewTicker(w.TickInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			if n, err := w.tickOnce(ctx); err != nil {
				if w.Logger != nil {
					w.Logger.Warn("outbound_webhooks redaction tick failed", "err", err.Error())
				}
			} else if n > 0 && w.Logger != nil {
				w.Logger.Info("outbound_webhooks redaction tick", "redacted", n)
			}
		}
	}
}

// tickOnce processes one globally-oldest batch under the explicit worker RLS
// scope. The redaction uses SHA-256 of the stored body so two failed
// deliveries to the same receiver still hash to the same tag (helpful for
// grouping).
func (w *RedactionWorker) tickOnce(ctx context.Context) (int, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// FOR UPDATE SKIP LOCKED lets every replica contribute without selecting
	// the same rows. Global created_at ordering prevents a large tenant from
	// hiding older PII belonging to tenants outside an arbitrary discovery
	// limit.
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, last_response_body_truncated
  FROM outbound_webhook_deliveries
 WHERE last_response_body_redacted_at IS NULL
   AND last_response_body_truncated IS NOT NULL
   AND created_at < now() - ($1::int * INTERVAL '1 second')
 ORDER BY created_at, id
 FOR UPDATE SKIP LOCKED
 LIMIT $2`,
		int(w.RetentionWindow.Seconds()), w.BatchSize)
	if err != nil {
		return 0, err
	}
	type pick struct {
		id       string
		tenantID string
		body     string
	}
	picks := make([]pick, 0, w.BatchSize)
	for rows.Next() {
		var p pick
		if err := rows.Scan(&p.id, &p.tenantID, &p.body); err != nil {
			rows.Close()
			return 0, err
		}
		picks = append(picks, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	n := 0
	for _, p := range picks {
		sum := sha256.Sum256([]byte(p.body))
		tag := fmt.Sprintf("redacted:sha256=%s:bytes=%d",
			hex.EncodeToString(sum[:]), len(p.body))
		if _, err := tx.Exec(ctx, `
UPDATE outbound_webhook_deliveries
   SET last_response_body_truncated     = $2,
       last_response_body_redacted_at   = now()
 WHERE tenant_id = $3::uuid
   AND id::text = $1`,
			p.id, tag, p.tenantID); err != nil {
			return n, err
		}
		n++
	}
	if err := tx.Commit(ctx); err != nil {
		return n, err
	}
	return n, nil
}
