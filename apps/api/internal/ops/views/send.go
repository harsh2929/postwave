package views

import (
	"context"
	"time"
)

// QueueDepthRow is one tenant's outbound send backlog, from campaign_recipients.
type QueueDepthRow struct {
	TenantID string `json:"tenant_id"`
	Slug     string `json:"slug"`
	Name     string `json:"name"`
	Pending  int64  `json:"pending"` // queued, not yet sent
	Failed   int64  `json:"failed"`  // failed delivery
}

// QueueDepthByTenant returns the send backlog per tenant, worst (most pending)
// first — the cross-tenant "who is backed up" view. campaign_recipients.status
// is one of pending|sent|failed|cancelled|skipped (migration 0068).
func (r *Reader) QueueDepthByTenant(ctx context.Context, limit int) ([]QueueDepthRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	// Via the ops_send_queue_depth SECURITY DEFINER function — postwave_ops has
	// no SELECT on campaign_recipients/tenants (migration 1738).
	rows, err := r.Pool.Query(ctx,
		`SELECT tenant_id, slug, name, pending, failed
		   FROM ops_send_queue_depth($1)`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []QueueDepthRow{}
	for rows.Next() {
		var row QueueDepthRow
		if err := rows.Scan(&row.TenantID, &row.Slug, &row.Name, &row.Pending, &row.Failed); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// DeadLetterRow is one (tenant, kind) group of dead-lettered outbox events —
// the platform-wide "what is stuck in the outbox" view.
type DeadLetterRow struct {
	TenantID   string    `json:"tenant_id"`
	Slug       string    `json:"slug"`
	Kind       string    `json:"kind"`
	DeadCount  int64     `json:"dead_count"`
	OldestDead time.Time `json:"oldest_dead_at"`
}

// ListDeadLetters returns dead-lettered outbox events (failed_at set) grouped by
// (tenant, kind), oldest first. Cross-tenant.
func (r *Reader) ListDeadLetters(ctx context.Context, limit int) ([]DeadLetterRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	// Via the ops_send_dead_letters SECURITY DEFINER function (migration 1738).
	rows, err := r.Pool.Query(ctx,
		`SELECT tenant_id, slug, kind, dead_count, oldest_dead_at
		   FROM ops_send_dead_letters($1)`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DeadLetterRow{}
	for rows.Next() {
		var row DeadLetterRow
		if err := rows.Scan(&row.TenantID, &row.Slug, &row.Kind, &row.DeadCount, &row.OldestDead); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
