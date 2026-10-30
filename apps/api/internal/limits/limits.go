package limits

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	sharedusage "github.com/postwave/postwave/packages/runtime/commercialusage"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

type Resource string

const (
	ResourceContacts              Resource = "contacts"
	ResourceCampaigns             Resource = "campaigns"
	ResourceAutomations           Resource = "automations"
	ResourceLandingPages          Resource = "landing_pages"
	ResourcePopupForms            Resource = "popup_forms"
	ResourceEcommerceIntegrations Resource = "ecommerce_integrations"
	ResourceMonthlySends          Resource = "monthly_sends"
	ResourceSeats                 Resource = "seats"
	ResourceAssetStorage          Resource = "asset_storage"
	ResourceAICredits             Resource = "ai_credits"
	ResourceAutomationExecutions  Resource = "automation_executions"
	ResourceTrackedEvents         Resource = "tracked_events"
	ResourceAPIOperations         Resource = "api_operations"
	// ResourceAssuranceRuns is metered per calendar month, not held as a
	// standing count, because a run is an EVENT rather than an object a tenant
	// owns. It is also the first resource here whose marginal cost is real
	// money — a `full` profile fans out to eight model members per scenario and
	// reserves its worst-case spend before the first provider call — so an
	// unmetered run endpoint is a way for one tenant to spend the budget.
	ResourceAssuranceRuns Resource = "assurance_runs"
)

var ErrExceeded = errors.New("plan limit exceeded")

type Error struct {
	Resource Resource `json:"resource"`
	Tier     string   `json:"tier"`
	Limit    int      `json:"limit"`
	Current  int      `json:"current"`
}

const gib int64 = 1024 * 1024 * 1024

// AssetStorageAllowanceBytes is the standing live-asset cap. Unknown tiers
// fail closed as Sandbox; legacy paid aliases resolve to the canonical plans.
func AssetStorageAllowanceBytes(tier string) (canonical string, allowance int64) {
	canonical = canonicalTier(tier)
	switch canonical {
	case "launch":
		return canonical, 2 * gib
	case "growth":
		return canonical, 10 * gib
	case "scale":
		return canonical, 50 * gib
	case "studio":
		return canonical, 2 * gib
	default:
		return "sandbox", 250 * 1024 * 1024
	}
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s limit exceeded for %s tier: %d/%d", e.Resource, e.Tier, e.Current, e.Limit)
}

type Enforcer struct {
	Pool *db.Pool
}

type limits struct {
	Contacts              int
	Campaigns             int
	Automations           int
	LandingPages          int
	PopupForms            int
	EcommerceIntegrations int
	MonthlySends          int
	Seats                 int
	AssuranceRuns         int
}

var tierLimits = map[string]limits{
	"":        {Contacts: 500, Campaigns: 25, Automations: 3, LandingPages: 2, PopupForms: 1, EcommerceIntegrations: 1, MonthlySends: 0, Seats: 1, AssuranceRuns: 20},
	"sandbox": {Contacts: 500, Campaigns: 25, Automations: 3, LandingPages: 2, PopupForms: 1, EcommerceIntegrations: 1, MonthlySends: 0, Seats: 1, AssuranceRuns: 20},
	"studio":  {Contacts: 1000, Campaigns: 25, Automations: 3, LandingPages: 2, PopupForms: 1, EcommerceIntegrations: 1, MonthlySends: 2000, Seats: 1, AssuranceRuns: 20},
	"launch":  {Contacts: 2500, Campaigns: 250, Automations: 5, LandingPages: 25, PopupForms: 10, EcommerceIntegrations: 3, MonthlySends: 25000, Seats: 3, AssuranceRuns: 400},
	"growth":  {Contacts: 10000, Campaigns: 1000, Automations: 25, LandingPages: 100, PopupForms: 40, EcommerceIntegrations: 6, MonthlySends: 100000, Seats: 5, AssuranceRuns: 1600},
	"scale":   {Contacts: 50000, Campaigns: 2000, Automations: 100, LandingPages: 250, PopupForms: 100, EcommerceIntegrations: 10, MonthlySends: 500000, Seats: 10, AssuranceRuns: 4000},
}

// Historical paid tier names remain read-compatible during catalog migration,
// but are never separate entitlement definitions. Keeping one canonical row
// per plan prevents a legacy slug from drifting away from the public cap.
var tierAliases = map[string]string{
	"sending": "launch",
	"pro":     "scale",
}

func canonicalTier(tier string) string {
	tier = strings.ToLower(strings.TrimSpace(tier))
	if canonical, ok := tierAliases[tier]; ok {
		return canonical
	}
	return tier
}

func configuredLimits(tier string) (limits, bool) {
	lim, ok := tierLimits[canonicalTier(tier)]
	return lim, ok
}

// MonthlySendCap is the single source of truth for a tier's included monthly
// send allowance. The billing dashboard and provider-boundary reservation gate
// both read it so the enforced ceiling and displayed cap cannot drift. General
// limit callers retain the historical Studio fallback for unknown tiers; the
// managed-send gate uses ManagedMonthlySendAllowance and fails unknown plans
// closed instead.
func MonthlySendCap(tier string) int {
	lim, ok := configuredLimits(tier)
	if !ok {
		lim = tierLimits["studio"]
	}
	return lim.MonthlySends
}

// ManagedMonthlySendAllowance classifies the plans for which Moosewave pays
// the delivery provider. Only the explicit historical Studio/BYO tier bypasses
// it. Unknown tiers return managed=true with no cap so the provider boundary
// fails closed rather than silently granting an unmetered managed plan. The cap
// remains sourced from tierLimits so UI and dispatch authority cannot drift.
func ManagedMonthlySendAllowance(tier string) (managed bool, allowance int) {
	tier = canonicalTier(tier)
	if tier == "studio" {
		return false, 0
	}
	if tier == "sandbox" {
		return true, 0
	}
	if tier != "launch" && tier != "growth" && tier != "scale" {
		return true, 0
	}
	return true, MonthlySendCap(tier)
}

// AssuranceRunCap is the single source of truth for a tier's included monthly
// Campaign Assurance runs — the same number Check enforces. The billing
// dashboard and any "runs remaining" copy MUST read this, for the same reason
// MonthlySendCap exists: an enforced ceiling and a displayed one that are
// written twice will disagree. Unknown tiers fall back to studio.
func AssuranceRunCap(tier string) int {
	lim, ok := configuredLimits(tier)
	if !ok {
		lim = tierLimits["studio"]
	}
	return lim.AssuranceRuns
}

// WorkspaceSeatAllowance is shared by invitation creation and redemption.
// Pending live invitations reserve a seat at creation; redemption checks the
// current member count again so a plan downgrade cannot turn an old invite
// into an over-cap member. Unknown tiers fail closed as Sandbox.
func WorkspaceSeatAllowance(tier string) (canonical string, allowance int) {
	canonical = canonicalTier(tier)
	lim, ok := tierLimits[canonical]
	if !ok {
		canonical = "sandbox"
		lim = tierLimits[canonical]
	}
	return canonical, lim.Seats
}

func (e *Enforcer) Check(ctx context.Context, tenantID string, resource Resource, increment int) error {
	if e == nil || e.Pool == nil || tenantID == "" {
		return nil
	}
	if increment <= 0 {
		increment = 1
	}
	tx, err := db.WithTenant(ctx, e.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tier := "studio"
	slug := ""
	_ = tx.QueryRow(ctx, `
SELECT t.slug, COALESCE(bs.tier, t.tier, 'studio')
  FROM tenants t
  LEFT JOIN billing_state bs ON bs.tenant_id = t.id
 WHERE t.id = $1::uuid`, tenantID).Scan(&slug, &tier)
	if slug == "demo" {
		return tx.Commit(ctx)
	}
	tier = canonicalTier(tier)
	lim, configured := configuredLimits(tier)
	if !configured {
		lim = tierLimits["studio"]
		tier = "studio"
	}
	current, limit, err := currentAndLimit(ctx, tx, tenantID, resource, lim)
	if err != nil {
		return err
	}
	if limit > 0 && current+increment > limit {
		return &Error{Resource: resource, Tier: tier, Limit: limit, Current: current}
	}
	return tx.Commit(ctx)
}

func (e *Enforcer) Increment(ctx context.Context, tenantID string, resource Resource, amount int) error {
	if e == nil || e.Pool == nil || tenantID == "" || amount <= 0 {
		return nil
	}
	if resource != ResourceMonthlySends {
		return nil
	}
	tx, err := db.WithTenant(ctx, e.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	month := monthStart(time.Now().UTC())
	_, err = tx.Exec(ctx, `
INSERT INTO tenant_usage_snapshots (tenant_id, monthly_sends, month_start, recomputed_at)
VALUES ($1::uuid, $2, $3::date, now())
ON CONFLICT (tenant_id) DO UPDATE SET
  monthly_sends = CASE
    WHEN tenant_usage_snapshots.month_start = EXCLUDED.month_start
      THEN tenant_usage_snapshots.monthly_sends + EXCLUDED.monthly_sends
    ELSE EXCLUDED.monthly_sends
  END,
  month_start = EXCLUDED.month_start,
  recomputed_at = now()`, tenantID, amount, month)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func currentAndLimit(ctx context.Context, q pgx.Tx, tenantID string, resource Resource, lim limits) (int, int, error) {
	var current int
	var sql string
	var limit int
	switch resource {
	case ResourceContacts:
		sql, limit = `SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid`, lim.Contacts
	case ResourceCampaigns:
		sql, limit = `SELECT count(*) FROM campaigns WHERE tenant_id = $1::uuid`, lim.Campaigns
	case ResourceAutomations:
		sql, limit = `
SELECT
  (SELECT count(*) FROM automations WHERE tenant_id = $1::uuid AND status <> 'archived') +
  (SELECT count(*) FROM automation_journeys WHERE tenant_id = $1::uuid AND status <> 'archived')`, lim.Automations
	case ResourceLandingPages:
		sql, limit = `SELECT count(*) FROM landing_pages WHERE tenant_id = $1::uuid AND status <> 'archived'`, lim.LandingPages
	case ResourcePopupForms:
		sql, limit = `SELECT count(*) FROM popup_forms WHERE tenant_id = $1::uuid AND status <> 'archived'`, lim.PopupForms
	case ResourceEcommerceIntegrations:
		sql, limit = `SELECT count(*) FROM commerce_integrations WHERE tenant_id = $1::uuid AND status <> 'paused'`, lim.EcommerceIntegrations
	case ResourceMonthlySends:
		sql, limit = `
SELECT GREATEST(
	COALESCE((SELECT reserved_units + committed_units FROM managed_send_allowance_buckets WHERE tenant_id = $1::uuid AND period_start = date_trunc('month', now())::date), 0),
	COALESCE((SELECT sum(sends)::int FROM api_key_usage WHERE tenant_id = $1::uuid AND period >= date_trunc('month', now())::date), 0),
	COALESCE((SELECT count(*)::int FROM campaign_report_events WHERE tenant_id = $1::uuid AND event_type = 'sent' AND at >= date_trunc('month', now())), 0)
)`, lim.MonthlySends
	case ResourceSeats:
		sql, limit = `
SELECT
  (SELECT count(*) FROM users
    WHERE tenant_id = $1::uuid AND status <> 'deleted') +
  (SELECT count(*) FROM team_invitations
    WHERE tenant_id = $1::uuid AND accepted_at IS NULL AND expires_at > now())`, lim.Seats
	case ResourceAssuranceRuns:
		// Counted from the run ledger for the CURRENT month only. Counting all
		// time would deny a tenant permanently once they had ever reached the
		// cap, which presents as the feature simply being broken.
		sql, limit = `
SELECT count(*)::int FROM campaign_assurance_runs
 WHERE tenant_id = $1::uuid
   AND created_at >= date_trunc('month', now())`, lim.AssuranceRuns
	case ResourceAICredits:
		sql = `
SELECT CEIL(COALESCE((SELECT used_units FROM commercial_usage_buckets
 WHERE tenant_id = $1::uuid AND period_start = date_trunc('month', now())::date
   AND resource = 'ai_credit_millis'), 0) / 1000.0)::int`
		limit = int(sharedusage.LimitForTier(canonicalTierForAllowance(lim), sharedusage.ResourceAICreditMillis) / 1000)
	case ResourceAutomationExecutions:
		sql = `
SELECT COALESCE((SELECT used_units::int FROM commercial_usage_buckets
 WHERE tenant_id = $1::uuid AND period_start = date_trunc('month', now())::date
   AND resource = 'automation_runs'), 0)`
		limit = int(sharedusage.LimitForTier(canonicalTierForAllowance(lim), sharedusage.ResourceAutomationRuns))
	case ResourceTrackedEvents:
		sql = `
SELECT COALESCE((SELECT used_units::int FROM commercial_usage_buckets
 WHERE tenant_id = $1::uuid AND period_start = date_trunc('month', now())::date
   AND resource = 'tracked_events'), 0)`
		limit = int(sharedusage.LimitForTier(canonicalTierForAllowance(lim), sharedusage.ResourceTrackedEvents))
	case ResourceAPIOperations:
		sql = `
SELECT COALESCE((SELECT used_units::int FROM commercial_usage_buckets
 WHERE tenant_id = $1::uuid AND period_start = date_trunc('month', now())::date
   AND resource = 'api_operations'), 0)`
		limit = int(sharedusage.LimitForTier(canonicalTierForAllowance(lim), sharedusage.ResourceAPIOperations))
	case ResourceAssetStorage:
		sql = `SELECT CEIL(COALESCE(sum(bytes), 0) / 1048576.0)::int
  FROM assets WHERE tenant_id = $1::uuid AND deleted_at IS NULL`
		_, bytes := AssetStorageAllowanceBytes(canonicalTierForAllowance(lim))
		limit = int(bytes / (1024 * 1024))
	default:
		return 0, 0, nil
	}
	if err := q.QueryRow(ctx, sql, tenantID).Scan(&current); err != nil {
		return 0, 0, err
	}
	return current, limit, nil
}

// currentAndLimit historically receives the resolved limit struct rather than
// the tier slug. Map the canonical catalog rows back to their unique tier for
// the shared commercial limits. This avoids a second tenant-tier query per row.
func canonicalTierForAllowance(lim limits) string {
	switch lim.MonthlySends {
	case 500000:
		return "scale"
	case 100000:
		return "growth"
	case 25000, 2000:
		return "launch"
	default:
		return "sandbox"
	}
}

func monthStart(now time.Time) time.Time {
	now = now.UTC()
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
}

func WriteExceeded(w http.ResponseWriter, err error) bool {
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	// One constructor, not a hand-built map. `campaigns` built this identical
	// envelope independently, so a change to either diverged from the other
	// silently — and the two are the same rule.
	entitlement.Write(w, entitlement.PlanLimit(
		"plan."+string(e.Resource), string(e.Resource), e.Tier, e.Error(),
		int64(e.Limit), int64(e.Current),
	))
	return true
}
