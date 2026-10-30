// SPDX-License-Identifier: AGPL-3.0-only

package eqscore

import (
	"context"
	"errors"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// DBReputation is the production seven-day sending-history reader. It uses
// campaign_report_events because that ledger contains the sent denominator and
// provider-deduplicated delivery, bounce, and complaint outcomes.
type DBReputation struct {
	Pool *db.Pool
}

// NewDBReputation returns the production Reputation implementation.
func NewDBReputation(pool *db.Pool) *DBReputation {
	return &DBReputation{Pool: pool}
}

// Last7d implements Reputation under tenant RLS. No sent rows means there is
// no denominator, so the reputation pillar is explicitly skipped.
func (r *DBReputation) Last7d(
	ctx context.Context,
	tenantID string,
) (Last7dStats, bool, error) {
	if r == nil || r.Pool == nil {
		return Last7dStats{}, false, errors.New("eqscore: reputation store is unavailable")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return Last7dStats{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var stats Last7dStats
	err = tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE event_type = 'sent')::bigint,
       count(*) FILTER (WHERE event_type = 'delivered')::bigint,
       count(*) FILTER (WHERE event_type = 'bounced')::bigint,
       count(*) FILTER (WHERE event_type = 'complained')::bigint
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND at >= now() - INTERVAL '7 days'`, tenantID).Scan(
		&stats.Sent,
		&stats.Delivered,
		&stats.Bounced,
		&stats.Complained,
	)
	if err != nil {
		return Last7dStats{}, false, err
	}
	return stats, stats.Sent >= minimumReputationSends, nil
}
