// SPDX-License-Identifier: AGPL-3.0-only
//
// store_pg_subscriber.go — Postgres impl of SubscriberStore, the follow-up the
// package doc flagged. Production previously wired NewMemorySubscriberStore, so
// the sunset/win-back detector swept an empty in-memory map and returned zero
// candidates. This joins subscribers against their last engagement event to
// find genuinely inactive addresses, and performs the suppression / tag /
// win-back-enqueue side effects against the canonical tables.
package sunset

import (
	"context"
	"errors"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type pgSubscriberStore struct {
	pool *db.Pool
}

// NewPostgresSubscriberStore wraps the pgx pool. Errors on a nil pool so the
// boot path fails fast.
func NewPostgresSubscriberStore(pool *db.Pool) (SubscriberStore, error) {
	if pool == nil {
		return nil, errors.New("sunset: nil pool")
	}
	return &pgSubscriberStore{pool: pool}, nil
}

// Candidates returns enabled subscribers whose last POSITIVE engagement event
// (opened/clicked, from subscriber_events, keyed by email) is older than
// policy.InactiveDays — or who have never engaged and whose account predates
// the window — excluding any carrying a policy.ExcludedTags tag or already
// suppressed (checked against the unified suppression view across all three
// suppression tables). Idempotency across re-runs comes from the engine's
// RecordExecution ON CONFLICT, so this query need not pre-filter executions.
func (s *pgSubscriberStore) Candidates(ctx context.Context, tenantID string, policy Policy, limit int) ([]Candidate, error) {
	if limit <= 0 || limit > 50000 {
		limit = 10000
	}
	excluded := policy.ExcludedTags
	if excluded == nil {
		excluded = []string{}
	}
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT s.id::text, s.email::text, last_seen,
       EXTRACT(DAY FROM (now() - last_seen))::int AS inactive_days, s.tags
FROM (
  SELECT sub.id, sub.email, sub.tags,
         COALESCE(ev.last_at, sub.created_at) AS last_seen
  FROM subscribers sub
  LEFT JOIN (
    -- POSITIVE engagement only: bounced/complained/unsubscribed are negative
    -- signals and must NOT count as "still active", or a recently-bounced
    -- address would be excluded from sunset — the opposite of intent.
    --
    -- Opens are filtered through bot_open_signatures. Apple Mail Privacy
    -- Protection prefetches every image the moment mail arrives, so an
    -- untouched address still emits an 'opened' event. Counting those as
    -- engagement means the deadest subscribers on the list look the most
    -- alive and are NEVER pruned — the list rots, complaint rate drifts up,
    -- and (before the ceiling gate) nothing caught the drift. This is the
    -- exact failure bot_open_filter's own package doc warns about; the
    -- filter existed but was only ever joined by the analytics dashboard.
    --
    -- Clicks are always trusted: no mailbox provider auto-clicks. Post-MPP
    -- they are the only unambiguous human signal.
    SELECT e.subscriber_email, MAX(e.at) AS last_at
    FROM subscriber_events e
    WHERE e.tenant_id = $1::uuid
      AND (
        e.event_type = 'clicked'
        OR (
          e.event_type = 'opened'
          AND NOT EXISTS (
            SELECT 1 FROM bot_open_signatures s
            WHERE s.enabled
              AND (s.tenant_id IS NULL OR s.tenant_id = $1::uuid)
              AND COALESCE(e.user_agent, '') ~ s.pattern
          )
        )
      )
    GROUP BY e.subscriber_email
  ) ev ON ev.subscriber_email = sub.email
  WHERE sub.tenant_id = $1::uuid AND sub.status = 'enabled'
) s
WHERE s.last_seen < now() - make_interval(days => $2)
  AND NOT (s.tags && $3::text[])
  AND NOT EXISTS (
    -- unified view converges all three suppression tables (0244/0564)
    SELECT 1 FROM v_suppressions_unified sup
    WHERE sup.tenant_id = $1::uuid AND sup.email = s.email
  )
ORDER BY s.last_seen ASC
LIMIT $4`, tenantID, policy.InactiveDays, excluded, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Candidate{}
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.SubscriberID, &c.Email, &c.LastSeen, &c.InactiveDays, &c.Tags); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// AddSuppression inserts into the canonical suppressions table (idempotent per
// tenant+email). source is folded into the reason so the audit trail records
// why the address was suppressed.
func (s *pgSubscriberStore) AddSuppression(ctx context.Context, tenantID, email, source, reason string) error {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	full := reason
	if source != "" {
		full = source + ": " + reason
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO suppressions (tenant_id, email, reason)
VALUES ($1::uuid, $2::citext, $3)
ON CONFLICT (tenant_id, email) DO NOTHING`, tenantID, email, full); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AddTag idempotently appends tag to the subscriber's text[] tags.
func (s *pgSubscriberStore) AddTag(ctx context.Context, tenantID, subscriberID, tag string) error {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET tags = array_append(array_remove(COALESCE(tags, '{}'::text[]), $3), $3)
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID, tag); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// EnqueueWinback appends to winback_candidate_queue, idempotent per
// (policy_id, subscriber_id).
func (s *pgSubscriberStore) EnqueueWinback(ctx context.Context, tenantID, policyID, subscriberID string) error {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO winback_candidate_queue (tenant_id, policy_id, subscriber_id)
VALUES ($1::uuid, $2::uuid, $3::uuid)
ON CONFLICT (policy_id, subscriber_id) DO NOTHING`, tenantID, policyID, subscriberID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
