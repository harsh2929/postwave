// SPDX-License-Identifier: AGPL-3.0-only

package limits

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Campaign Assurance is the first metered resource whose marginal cost is real
// money: a `full` profile run fans out to eight model members per scenario, and
// the cost ceiling is reserved before the first provider call. An unmetered run
// endpoint is therefore a way for one tenant to spend the company's budget.
//
// These are DB tests rather than table-driven unit tests because the counting
// query is the thing that can be wrong — a per-tenant cap that accidentally
// counts every tenant's runs, or counts all time instead of the current month,
// is invisible to any test that stubs the store.

func limitsDBPool(t *testing.T, ctx context.Context) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("POSTWAVE_LIMITS_TEST_DATABASE_URL"))
	if url == "" {
		t.Skip("POSTWAVE_LIMITS_TEST_DATABASE_URL is required for plan-limit DB proof")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect limits test database: %v", err)
	}
	t.Cleanup(pool.Close)
	var ready bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.campaign_assurance_runs') IS NOT NULL
   AND to_regclass('public.tenants') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatalf("inspect schema: %v", err)
	}
	if !ready {
		t.Fatal("configured database is missing campaign_assurance_runs (migration 1921)")
	}
	return pool
}

// assuranceTenant is a tenant plus the identity chain campaign_assurance_runs
// requires. The runs table carries composite foreign keys all the way back
// through campaign_send_plans and campaign_content_revisions, so a run can only
// exist against a real frozen revision and plan — the fixture has to honour
// that rather than invent ids.
type assuranceTenant struct {
	tenantID   string
	campaignID string
	revisionID string
	planID     string
	sourceHash string
	planHash   string
}

func seedAssuranceRunTenant(t *testing.T, ctx context.Context, pool *db.Pool, tier string) assuranceTenant {
	t.Helper()
	fixture := assuranceTenant{
		tenantID:   uuid.NewString(),
		campaignID: uuid.NewString(),
		revisionID: uuid.NewString(),
		planID:     uuid.NewString(),
		sourceHash: strings.Repeat("a", 64),
		planHash:   strings.Repeat("b", 64),
	}
	suffix := strings.ReplaceAll(fixture.tenantID, "-", "")[:16]

	for _, stmt := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, $3, $4)`,
			[]any{fixture.tenantID, "limits-" + suffix, "Limits " + suffix, tier}},
		{`INSERT INTO campaigns (id, tenant_id, name, subject, body_html)
VALUES ($1::uuid, $2::uuid, 'Plan limit proof', 'Subject', '<p>Body</p>')`,
			[]any{fixture.campaignID, fixture.tenantID}},
		// legacy_html is required by campaign_content_revisions_source_shape_check:
		// a revision must always be projectable, so a legacy_html revision cannot
		// exist without its HTML (nor a semantic one without a non-empty tree).
		{`INSERT INTO campaign_content_revisions (
    id, tenant_id, campaign_id, revision_no, source_mode,
    content_schema_version, subject, legacy_html, source_hash
) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'legacy_html', 1, 'Subject', '<p>Body</p>', $4)`,
			[]any{fixture.revisionID, fixture.tenantID, fixture.campaignID, fixture.sourceHash}},
		{`INSERT INTO campaign_send_plans (
    id, tenant_id, campaign_id, content_revision_id, plan_no, plan_hash,
    request_hash, renderer_version, compiler_version, fixture_set_version,
    policy_version
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, $6, 'v1', 'v1', 'v1', 'v1')`,
			[]any{fixture.planID, fixture.tenantID, fixture.campaignID, fixture.revisionID,
				fixture.planHash, strings.Repeat("c", 64)}},
	} {
		if _, err := pool.Exec(ctx, stmt.sql, stmt.args...); err != nil {
			t.Fatalf("seed assurance tenant: %v", err)
		}
	}

	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID)
	})
	return fixture
}

// insertAssuranceRuns writes n runs for the tenant, offset months into the past
// (0 = this month). Only the columns the cap query reads have to be meaningful;
// the rest satisfy NOT NULL.
func insertAssuranceRuns(t *testing.T, ctx context.Context, pool *db.Pool, tenant assuranceTenant, n int, monthsAgo int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, err := pool.Exec(ctx, `
INSERT INTO campaign_assurance_runs (
    tenant_id, campaign_id, content_revision_id, send_plan_id, run_no,
    request_id, request_hash, trigger_kind, profile,
    source_hash, plan_hash, coverage_manifest_hash,
    renderer_version, compiler_version, fixture_set_version, plan_policy_version,
    analyzer_suite_version, model_suite_version, prompt_suite_version,
    prompt_suite_hash, normalization_version, scoring_version,
    gate_policy_version, methodology_version,
    required_scenario_count, required_configuration_count, required_extraction_count,
    created_at
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid,
    -- run_no is unique per (tenant, campaign); derive it so a test can insert
    -- in several batches without restarting the sequence.
    (SELECT COALESCE(MAX(run_no), 0) + 1 FROM campaign_assurance_runs
      WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid),
    gen_random_uuid(), $5, 'explicit', 'fast',
    $6, $7, $5,
    'v1', 'v1', 'v1', 'v1',
    'v1', 'v1', 'v1',
    $5, 'v1', 'v1',
    'v1', 'v1',
    1, 1, 1,
    now() - make_interval(months => $8::int)
)`,
			tenant.tenantID, tenant.campaignID, tenant.revisionID, tenant.planID,
			fmt.Sprintf("%064x", i+1), tenant.sourceHash, tenant.planHash, monthsAgo,
		); err != nil {
			t.Fatalf("insert assurance run %d: %v", i, err)
		}
	}
}

func TestAssuranceRunsAreCappedPerTierPerMonth(t *testing.T) {
	ctx := context.Background()
	pool := limitsDBPool(t, ctx)
	enforcer := &Enforcer{Pool: pool}

	cap := AssuranceRunCap("sending")
	if cap <= 0 {
		t.Fatalf("the sending tier must have a positive assurance-run allowance, got %d", cap)
	}
	tenant := seedAssuranceRunTenant(t, ctx, pool, "sending")

	// One below the cap: the next run still fits.
	insertAssuranceRuns(t, ctx, pool, tenant, cap-1, 0)
	if err := enforcer.Check(ctx, tenant.tenantID, ResourceAssuranceRuns, 1); err != nil {
		t.Fatalf("run %d of %d must be allowed, got %v", cap, cap, err)
	}

	// At the cap: the next run is denied, and the denial carries the numbers a
	// caller needs to explain it.
	insertAssuranceRuns(t, ctx, pool, tenant, 1, 0)
	err := enforcer.Check(ctx, tenant.tenantID, ResourceAssuranceRuns, 1)
	var limitErr *Error
	if !errors.As(err, &limitErr) {
		t.Fatalf("run %d of %d must be denied with *limits.Error, got %v", cap+1, cap, err)
	}
	if limitErr.Resource != ResourceAssuranceRuns {
		t.Errorf("Resource = %q, want %q", limitErr.Resource, ResourceAssuranceRuns)
	}
	if limitErr.Tier != "sending" {
		t.Errorf("Tier = %q, want sending", limitErr.Tier)
	}
	if limitErr.Limit != cap {
		t.Errorf("Limit = %d, want %d", limitErr.Limit, cap)
	}
	if limitErr.Current != cap {
		t.Errorf("Current = %d, want %d", limitErr.Current, cap)
	}
}

// The allowance is monthly. Counting all time would deny a tenant forever once
// they had ever reached the cap — a silent, permanent outage that no unit test
// over a stubbed store can see.
func TestAssuranceRunCapIgnoresEarlierMonths(t *testing.T) {
	ctx := context.Background()
	pool := limitsDBPool(t, ctx)
	enforcer := &Enforcer{Pool: pool}

	cap := AssuranceRunCap("sending")
	tenant := seedAssuranceRunTenant(t, ctx, pool, "sending")
	insertAssuranceRuns(t, ctx, pool, tenant, cap+5, 2)

	if err := enforcer.Check(ctx, tenant.tenantID, ResourceAssuranceRuns, 1); err != nil {
		t.Fatalf("runs from two months ago must not consume this month's allowance, got %v", err)
	}
}

// The cap is per tenant. A shared count would let one busy workspace lock out
// every other tenant on the platform.
func TestAssuranceRunCapIsPerTenant(t *testing.T) {
	ctx := context.Background()
	pool := limitsDBPool(t, ctx)
	enforcer := &Enforcer{Pool: pool}

	cap := AssuranceRunCap("sending")
	noisy := seedAssuranceRunTenant(t, ctx, pool, "sending")
	quiet := seedAssuranceRunTenant(t, ctx, pool, "sending")
	insertAssuranceRuns(t, ctx, pool, noisy, cap+3, 0)

	if err := enforcer.Check(ctx, quiet.tenantID, ResourceAssuranceRuns, 1); err != nil {
		t.Fatalf("another tenant's runs must not consume this tenant's allowance, got %v", err)
	}
}

// A bigger plan must actually buy more runs, otherwise the entitlement is
// decorative and the upgrade remedy in the denial envelope is a lie.
func TestAssuranceRunCapRisesWithTier(t *testing.T) {
	studio := AssuranceRunCap("studio")
	sending := AssuranceRunCap("sending")
	pro := AssuranceRunCap("pro")
	if !(studio < sending && sending < pro) {
		t.Fatalf("caps must increase with tier: studio=%d sending=%d pro=%d", studio, sending, pro)
	}
	if AssuranceRunCap("no-such-tier") != studio {
		t.Errorf("an unknown tier must fall back to the studio allowance, got %d", AssuranceRunCap("no-such-tier"))
	}
}

// The allowance has to be visible before it is hit. A cap that only shows up as
// a 402 mid-workflow reads as a bug; the usage panel is where a tenant is
// supposed to learn they are close.
func TestPlanSummaryPublishesTheAssuranceRunAllowance(t *testing.T) {
	ctx := context.Background()
	pool := limitsDBPool(t, ctx)

	tenant := seedAssuranceRunTenant(t, ctx, pool, "sending")
	insertAssuranceRuns(t, ctx, pool, tenant, 3, 0)

	rows, tier, err := PlanSummaryResources(ctx, pool, tenant.tenantID)
	if err != nil {
		t.Fatalf("plan summary: %v", err)
	}
	if tier != "sending" {
		t.Fatalf("tier = %q, want sending", tier)
	}
	row := findResourceRow(rows, string(ResourceAssuranceRuns))
	if row == nil {
		t.Fatalf("assurance_runs missing from the usage panel: %+v", rows)
	}
	if row.Current != 3 {
		t.Errorf("Current = %d, want 3", row.Current)
	}
	if row.Limit != AssuranceRunCap("sending") {
		t.Errorf("Limit = %d, want %d — the panel must read the same constant Check enforces",
			row.Limit, AssuranceRunCap("sending"))
	}
}

func findResourceRow(rows []UsageRow, name string) *UsageRow {
	for i := range rows {
		if rows[i].Resource == name {
			return &rows[i]
		}
	}
	return nil
}
