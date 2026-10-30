package control_group

// send.go — the send-time enforcement control_group never had.
//
// A control group is a GLOBAL program holdout: a deterministic slice of a
// tenant's subscribers who receive NO campaigns, so the engagement gap between
// them and everyone else is the marketing program's incremental lift. IsInControl
// was exported and called from nowhere, so control members received every
// campaign and the "lift" compared two cohorts that both got the email — noise.
//
// The queue path now calls PartitionControl to drop control members before the
// send. Membership is hashed on EMAIL here AND in Report (this file's sibling
// change), so send-time and reporting agree — the trap the old TODO called out.

import (
	"context"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// PartitionControl splits emails into those to send (kept) and those held out
// (excluded because they belong to an active control group). A subscriber in
// ANY active group is excluded — concurrent programs union.
func PartitionControl(groups []ControlGroup, emails []string) (kept, excluded []string) {
	active := make([]ControlGroup, 0, len(groups))
	for _, g := range groups {
		if g.Status == StatusActive && g.Percent > 0 {
			active = append(active, g)
		}
	}
	if len(active) == 0 {
		return emails, nil
	}
	kept = make([]string, 0, len(emails))
	for _, e := range emails {
		if inAnyControl(active, e) {
			excluded = append(excluded, e)
		} else {
			kept = append(kept, e)
		}
	}
	return kept, excluded
}

func inAnyControl(groups []ControlGroup, email string) bool {
	for _, g := range groups {
		// Hash the EMAIL (not the subscriber id): the queue path carries emails,
		// and Report partitions subscriber_events by subscriber_email, so both
		// sides must hash the same identifier or they silently disagree.
		if IsInControl(g.Seed, email, g.Percent) {
			return true
		}
	}
	return false
}

// ActiveForTenant returns the tenant's control groups that are active right now
// (status='active' and inside their [starts_at, ends_at] window). The send path
// calls this once per campaign to know who to hold back.
func (r *Repo) ActiveForTenant(ctx context.Context, tenantID string) ([]ControlGroup, error) {
	if r == nil || r.Pool == nil || tenantID == "" {
		return nil, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, description, percent, seed, status,
       starts_at, ends_at, created_at, updated_at
  FROM control_groups
 WHERE tenant_id = $1::uuid
   AND status = 'active'
   AND starts_at <= now()
   AND (ends_at IS NULL OR ends_at > now())`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ControlGroup
	for rows.Next() {
		var g ControlGroup
		var ends *time.Time
		if err := rows.Scan(&g.ID, &g.TenantID, &g.Name, &g.Description, &g.Percent,
			&g.Seed, &g.Status, &g.StartsAt, &ends, &g.CreatedAt, &g.UpdatedAt); err != nil {
			return nil, err
		}
		g.EndsAt = ends
		out = append(out, g)
	}
	return out, rows.Err()
}
