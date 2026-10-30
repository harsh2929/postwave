// Package subscriberevents contains the shared persistence primitives for the
// partitioned subscriber event stream.
package subscriberevents

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// DedupClaim reports whether this transaction owns a new provider event key.
// ExistingID and ExistingAt are populated when a committed or earlier
// same-transaction writer already bound the key to an event.
type DedupClaim struct {
	Claimed    bool
	ExistingID int64
	ExistingAt time.Time
}

// ClaimDedupKey atomically claims the global provider key outside the
// time-partitioned event table. INSERT .. ON CONFLICT blocks behind a
// concurrent claimant; under PostgreSQL READ COMMITTED the following SELECT
// then sees the row that won. Both calls must run in the same tenant-scoped
// transaction as the subscriber_events insert.
func ClaimDedupKey(ctx context.Context, tx pgx.Tx, tenantID, source, sourceEventID string) (DedupClaim, error) {
	source = strings.TrimSpace(source)
	sourceEventID = strings.TrimSpace(sourceEventID)
	if tenantID == "" || source == "" || sourceEventID == "" {
		return DedupClaim{}, errors.New("subscriber event dedup key requires tenant, source, and source_event_id")
	}

	tag, err := tx.Exec(ctx, `
INSERT INTO subscriber_event_dedup_keys (tenant_id, source, source_event_id)
VALUES ($1::uuid, $2, $3)
ON CONFLICT (tenant_id, source, source_event_id) DO NOTHING`,
		tenantID, source, sourceEventID)
	if err != nil {
		return DedupClaim{}, fmt.Errorf("claim subscriber event dedup key: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return DedupClaim{Claimed: true}, nil
	}

	var existingID int64
	var existingAt time.Time
	err = tx.QueryRow(ctx, `
SELECT event_id, event_at
  FROM subscriber_event_dedup_keys
 WHERE tenant_id = $1::uuid
   AND source = $2
   AND source_event_id = $3`, tenantID, source, sourceEventID).
		Scan(&existingID, &existingAt)
	if err != nil {
		return DedupClaim{}, fmt.Errorf("load subscriber event dedup key: %w", err)
	}
	return DedupClaim{ExistingID: existingID, ExistingAt: existingAt}, nil
}

// BindDedupKey finishes a successful claim. A failed event insert rolls the
// claim back with its surrounding transaction/savepoint, so an incomplete key
// cannot be committed by these writers.
func BindDedupKey(ctx context.Context, tx pgx.Tx, tenantID, source, sourceEventID string, eventID int64, eventAt time.Time) error {
	tag, err := tx.Exec(ctx, `
UPDATE subscriber_event_dedup_keys
   SET event_id = $4,
       event_at = $5
 WHERE tenant_id = $1::uuid
   AND source = $2
   AND source_event_id = $3
   AND event_id IS NULL
   AND event_at IS NULL`, tenantID, strings.TrimSpace(source), strings.TrimSpace(sourceEventID), eventID, eventAt)
	if err != nil {
		return fmt.Errorf("bind subscriber event dedup key: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return errors.New("bind subscriber event dedup key: claim is missing or already bound")
	}
	return nil
}
