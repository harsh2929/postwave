// SPDX-License-Identifier: AGPL-3.0-only
//
// sweep_inbound.go — scrubs inbound_emails and campaign_replies body content
// past the tenant's InboundEmailRetentionDays window. Both rows remain so
// envelope, correlation, classification, and immutable digest evidence survive;
// subscriber-authored content does not survive in a parallel reply table after
// the original inbound email has been redacted.
//
// This is a content scrub, not a row delete. The "rows affected"
// returned counts how many rows had their bodies blanked on this
// pass; subsequent passes find the same rows in their post-scrub
// state and a length-zero check keeps us from doing repeat writes.

package retention

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func (s *Sweeper) sweepInboundEmailBodies(ctx context.Context, tenantID string, days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := s.sweepInboundEmailBatch(ctx, tenantID, days)
		if err != nil {
			return total, err
		}
		total += n
		if n == 0 {
			break
		}
	}
	return total, nil
}

func (s *Sweeper) sweepInboundEmailBatch(ctx context.Context, tenantID string, days int) (int64, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Skip rows that are already scrubbed (both body columns empty)
	// so repeated ticks don't keep writing zeroes to the same rows.
	inboundTag, err := tx.Exec(ctx, `
UPDATE inbound_emails
   SET body_text = '', body_html = ''
 WHERE id IN (
     SELECT id FROM inbound_emails
      WHERE tenant_id = $1::uuid
        AND received_at < now() - ($2::int * interval '1 day')
        AND (length(body_text) > 0 OR length(body_html) > 0)
      LIMIT $3
 )`, tenantID, days, s.batchSize())
	if err != nil {
		return 0, fmt.Errorf("scrub inbound_emails: %w", err)
	}
	replyTag, err := tx.Exec(ctx, `
UPDATE campaign_replies
   SET body_snippet = '',
       body_stripped = '',
       body_redacted_at = clock_timestamp()
 WHERE id IN (
     SELECT id FROM campaign_replies
      WHERE tenant_id = $1::uuid
        AND received_at < now() - ($2::int * interval '1 day')
        AND body_redacted_at IS NULL
        AND (
            COALESCE(body_snippet, '') <> ''
            OR COALESCE(body_stripped, '') <> ''
        )
      ORDER BY received_at, id
      LIMIT $3
 )`, tenantID, days, s.batchSize())
	if err != nil {
		return 0, fmt.Errorf("scrub campaign_replies: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit inbound reply body sweep: %w", err)
	}
	return inboundTag.RowsAffected() + replyTag.RowsAffected(), nil
}
