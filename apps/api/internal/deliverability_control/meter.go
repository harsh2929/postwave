// SPDX-License-Identifier: AGPL-3.0-only
//
// meter.go enforces deliverability entitlements. The deliverability_entitlements
// table and its CRUD existed, but nothing consumed the quota — inbox-reality
// tests and email render-previews ran unmetered. This adds an atomic
// check-and-consume keyed to the tenant's current billing month.
package deliverability_control

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrQuotaExceeded is returned by CheckAndConsume when a configured limit with
// overage_policy='block' has been reached for the current period.
var ErrQuotaExceeded = errors.New("deliverability_control: quota exceeded")

// meterColumns maps a metered resource to its (used, monthly) columns. The keys
// are a fixed allow-list, so interpolating the column names into SQL is safe.
var meterColumns = map[string][2]string{
	"inbox_tests":     {"inbox_tests_used", "inbox_tests_monthly"},
	"render_previews": {"render_previews_used", "render_previews_monthly"},
}

// CheckAndConsume atomically consumes one unit of resource for the tenant's
// current billing month.
//
// Returns:
//   - remaining >= 0, nil → consumed; remaining quota this period.
//   - 0, ErrQuotaExceeded → the plan's hard monthly limit is reached.
//
// The current-period row is derived from billing_state (falling back to the
// tenant tier), never from caller input or a prior entitlement row. This means
// new paid workspaces are metered on their first request, a new month resets
// usage, and stale/admin-authored limits cannot become an unlimited grant.
func (r *Repo) CheckAndConsume(ctx context.Context, tenantID, resource string) (int, *Ceiling, error) {
	cols, ok := meterColumns[resource]
	if !ok {
		return 0, nil, fmt.Errorf("deliverability_control: unknown metered resource %q", resource)
	}
	usedCol, monthlyCol := cols[0], cols[1]

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := ensureCanonicalEntitlement(ctx, tx, tenantID); err != nil {
		return 0, nil, err
	}

	// Atomic conditional increment: only consume when under the limit (or the
	// policy permits overage). RETURNING gives the post-increment remaining.
	var remaining int
	err = tx.QueryRow(ctx, `
UPDATE deliverability_entitlements
   SET `+usedCol+` = `+usedCol+` + 1
 WHERE tenant_id = $1::uuid AND period_start = date_trunc('month', now())::date
   AND (overage_policy <> 'block' OR `+usedCol+` < `+monthlyCol+`)
RETURNING `+monthlyCol+` - `+usedCol+``, tenantID).Scan(&remaining)
	if err == nil {
		if remaining < 0 {
			remaining = 0 // overage consumed past the limit
		}
		return remaining, nil, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, err
	}

	// No row updated: the current-period row is at its block limit.
	//
	// The ceiling is read HERE, in the transaction that made the decision.
	// A previous version read it afterwards from its own transaction, which
	// produced denials that contradicted themselves: an admin raising the limit
	// between the two reads yielded "monthly quota exhausted" reporting 1 of 10
	// used — and the admin PUT that triggers it is the very remedy the denial
	// names. Across a month boundary the second read could also find no row at
	// all. Same transaction, same snapshot, numbers true by construction.
	var c Ceiling
	err = tx.QueryRow(ctx, `
SELECT `+monthlyCol+`, `+usedCol+`, plan_tier
  FROM deliverability_entitlements
 WHERE tenant_id = $1::uuid AND period_start = date_trunc('month', now())::date`,
		tenantID).Scan(&c.Limit, &c.Used, &c.Tier)
	if err != nil {
		return 0, nil, err
	}
	return 0, &c, ErrQuotaExceeded
}

// Ceiling describes the allowance a caller just hit.
//
// Returned because the denial needs it and this transaction already knows it: a
// review found the handlers replying "monthly render-preview quota exhausted"
// with no limit, no current usage and no tier — so a client could not say how
// much was used, and the site could not apply the top-tier remedy rule because
// it had no tier to apply it to.
type Ceiling struct {
	// Limit and Used are the configured monthly allowance and consumption.
	Limit int
	Used  int
	Tier  string
}

type deliverabilityAllowance struct {
	Tier           string
	InboxTests     int
	RenderPreviews int
}

// canonicalDeliverabilityAllowance is the one commercial catalog used by the
// metering boundary. Historical paid slugs remain read-compatible; all free,
// BYO, and unknown tiers fail closed with zero managed allowance.
func canonicalDeliverabilityAllowance(rawTier string) deliverabilityAllowance {
	tier := strings.ToLower(strings.TrimSpace(rawTier))
	switch tier {
	case "sending":
		tier = "launch"
	case "pro":
		tier = "scale"
	}
	switch tier {
	case "launch":
		return deliverabilityAllowance{Tier: tier, InboxTests: 5, RenderPreviews: 50}
	case "growth":
		return deliverabilityAllowance{Tier: tier, InboxTests: 25, RenderPreviews: 250}
	case "scale":
		return deliverabilityAllowance{Tier: tier, InboxTests: 100, RenderPreviews: 1000}
	case "sandbox", "studio":
		return deliverabilityAllowance{Tier: tier}
	default:
		return deliverabilityAllowance{Tier: "sandbox"}
	}
}

func ensureCanonicalEntitlement(ctx context.Context, tx pgx.Tx, tenantID string) error {
	var rawTier string
	if err := tx.QueryRow(ctx, `
SELECT lower(COALESCE(NULLIF(bs.tier, ''), NULLIF(t.tier, ''), 'sandbox'))
  FROM tenants t
  LEFT JOIN billing_state bs ON bs.tenant_id = t.id
 WHERE t.id = $1::uuid`, tenantID).Scan(&rawTier); err != nil {
		return err
	}
	allowance := canonicalDeliverabilityAllowance(rawTier)
	_, err := tx.Exec(ctx, `
INSERT INTO deliverability_entitlements
    (tenant_id, period_start, plan_tier, inbox_tests_monthly,
     render_previews_monthly, overage_policy)
VALUES
    ($1::uuid, date_trunc('month', now())::date, $2, $3, $4, 'block')
ON CONFLICT (tenant_id, period_start) DO UPDATE SET
    plan_tier = EXCLUDED.plan_tier,
    inbox_tests_monthly = EXCLUDED.inbox_tests_monthly,
    render_previews_monthly = EXCLUDED.render_previews_monthly,
    overage_policy = 'block',
    updated_at = now()`, tenantID, allowance.Tier, allowance.InboxTests, allowance.RenderPreviews)
	return err
}
