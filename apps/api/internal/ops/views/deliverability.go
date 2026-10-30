package views

import "context"

// DeliverabilityRow is one tenant's 7-day deliverability health — the numbers
// that decide whether a sending domain is about to get throttled. complaint_rate
// crossing 0.30% is the ceiling Gmail/Yahoo/Outlook enforce (0.10% is where harm
// begins) — the ops console flags who is approaching it, cross-tenant.
type DeliverabilityRow struct {
	TenantID      string  `json:"tenant_id"`
	Slug          string  `json:"slug"`
	Name          string  `json:"name"`
	Sent7d        int64   `json:"sent_7d"`
	Complained7d  int64   `json:"complained_7d"`
	Bounced7d     int64   `json:"bounced_7d"`
	Unsub7d       int64   `json:"unsubscribed_7d"`
	ComplaintRate float64 `json:"complaint_rate"` // fraction, 0..1
	BounceRate    float64 `json:"bounce_rate"`
}

// DeliverabilityByTenant returns per-tenant 7-day complaint/bounce health, worst
// complaint rate first. The denominator is campaign_recipients.sent_at (the real
// send ledger) — NOT subscriber_events, which has no 'sent' event_type.
func (r *Reader) DeliverabilityByTenant(ctx context.Context, limit int) ([]DeliverabilityRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	// Via the ops_deliverability_by_tenant SECURITY DEFINER function: postwave_ops
	// has no SELECT on campaign_recipients/subscriber_events (migration 1738).
	rows, err := r.Pool.Query(ctx,
		`SELECT tenant_id, slug, name, sent_7d, complained_7d, bounced_7d, unsub_7d
		   FROM ops_deliverability_by_tenant($1)`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DeliverabilityRow{}
	for rows.Next() {
		var row DeliverabilityRow
		if err := rows.Scan(&row.TenantID, &row.Slug, &row.Name,
			&row.Sent7d, &row.Complained7d, &row.Bounced7d, &row.Unsub7d); err != nil {
			return nil, err
		}
		if row.Sent7d > 0 {
			row.ComplaintRate = float64(row.Complained7d) / float64(row.Sent7d)
			row.BounceRate = float64(row.Bounced7d) / float64(row.Sent7d)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
