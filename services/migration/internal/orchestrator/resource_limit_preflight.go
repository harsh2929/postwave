package orchestrator

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

type migrationResourceIncrements struct {
	Automations  int
	LandingPages int
	PopupForms   int
	Ecommerce    int
}

type migrationTierLimits struct {
	Automations  int
	LandingPages int
	PopupForms   int
	Ecommerce    int
}

var migrationLimitsByTier = map[string]migrationTierLimits{
	"studio":  {Automations: 3, LandingPages: 2, PopupForms: 1, Ecommerce: 1},
	"sending": {Automations: 25, LandingPages: 25, PopupForms: 10, Ecommerce: 3},
	"pro":     {Automations: 250, LandingPages: 250, PopupForms: 100, Ecommerce: 10},
}

func plannedMigrationResourceIncrements(source canonical.SourcePlatform, disc adapter.DiscoveryReport) migrationResourceIncrements {
	increments := migrationResourceIncrements{Automations: disc.AutomationsTotal}
	if source != canonical.SourceMailchimp {
		return increments
	}
	increments.PopupForms = len(disc.Audiences)
	if increments.PopupForms == 0 {
		increments.PopupForms = disc.FormsTotal
	}
	// Landing/ecommerce APIs are account-wide. When the operator selected
	// audiences, adapter records are manual-review/archive-only and therefore
	// consume no live resource quota. Unscoped imports materialize safe drafts.
	if len(disc.Audiences) == 0 {
		increments.LandingPages = disc.LandingPagesTotal
	}
	// Mailchimp stores materialize paused and the canonical enforcer excludes
	// paused commerce integrations, so their quota increment is intentionally 0.
	return increments
}

func validateMigrationResourceLimits(ctx context.Context, db *sql.DB, tenantID, jobID string, source canonical.SourcePlatform, disc adapter.DiscoveryReport) (err error) {
	if db == nil || strings.TrimSpace(tenantID) == "" {
		return fmt.Errorf("migration resource-limit preflight requires DB and tenant")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
			return
		}
		err = tx.Commit()
	}()
	if _, err := tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	var slug, tier string
	if err := tx.QueryRowContext(ctx, `
		SELECT t.slug, lower(COALESCE(bs.tier, t.tier, 'studio'))
		  FROM tenants t LEFT JOIN billing_state bs ON bs.tenant_id = t.id
		 WHERE t.id = $1::uuid
	`, tenantID).Scan(&slug, &tier); err != nil {
		return err
	}
	if slug == "demo" {
		return nil
	}
	limits, ok := migrationLimitsByTier[tier]
	if !ok {
		tier = "studio"
		limits = migrationLimitsByTier[tier]
	}
	increments := plannedMigrationResourceIncrements(source, disc)
	type check struct {
		name       string
		planned    int
		limit      int
		currentSQL string
		ledgerType []string
	}
	checks := []check{
		{"automations", increments.Automations, limits.Automations, `(SELECT count(*) FROM automations WHERE tenant_id = $1::uuid AND status <> 'archived') + (SELECT count(*) FROM automation_journeys WHERE tenant_id = $1::uuid AND status <> 'archived')`, []string{"automation", "automation_journey"}},
		{"landing_pages", increments.LandingPages, limits.LandingPages, `SELECT count(*) FROM landing_pages WHERE tenant_id = $1::uuid AND status <> 'archived'`, []string{"landing_page"}},
		{"popup_forms", increments.PopupForms, limits.PopupForms, `SELECT count(*) FROM popup_forms WHERE tenant_id = $1::uuid AND status <> 'archived'`, []string{"popup_form"}},
		{"ecommerce_integrations", increments.Ecommerce, limits.Ecommerce, `SELECT count(*) FROM commerce_integrations WHERE tenant_id = $1::uuid AND status <> 'paused'`, []string{"commerce_integration"}},
	}
	for _, check := range checks {
		if check.planned <= 0 || check.limit <= 0 {
			continue
		}
		var current int
		if err := tx.QueryRowContext(ctx, check.currentSQL, tenantID).Scan(&current); err != nil {
			return err
		}
		var alreadyOwned int
		if strings.TrimSpace(jobID) != "" {
			resourceTypes, _ := json.Marshal(check.ledgerType)
			if err := tx.QueryRowContext(ctx, `
				SELECT count(*) FROM migration_imported_resources
				 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
				   AND resource_type IN (SELECT jsonb_array_elements_text($3::jsonb))
				   AND rolled_back_at IS NULL
			`, tenantID, jobID, string(resourceTypes)).Scan(&alreadyOwned); err != nil {
				return err
			}
		}
		remaining := check.planned - alreadyOwned
		if remaining < 0 {
			remaining = 0
		}
		if current+remaining > check.limit {
			return fmt.Errorf("%s plan limit exceeded for %s tier before migration writes: current=%d new=%d limit=%d", check.name, tier, current, remaining, check.limit)
		}
	}
	return nil
}
