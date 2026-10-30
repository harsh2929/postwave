// SPDX-License-Identifier: AGPL-3.0-only

package form_variants

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/testsupport/privatedb"
)

// newMigratedVariantRLSPools gives the test a database of its own, migrated
// through the whole history, and returns the postwave_app pool the RLS proof is
// about and an administrative pool for seeding and reading policies, both
// connected to it. The database is dropped when the test ends.
func newMigratedVariantRLSPools(
	t *testing.T,
	ctx context.Context,
) (*pgxpool.Pool, *pgxpool.Pool) {
	t.Helper()
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if appURL == "" {
		appURL = strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	}
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL and DATABASE_URL (postwave_app) are required for migrated form-variant RLS proof")
	}

	probeConfig, err := pgxpool.ParseConfig(appURL)
	if err != nil {
		t.Fatalf("parse application database URL: %v", err)
	}
	probe, err := pgxpool.NewWithConfig(ctx, probeConfig)
	if err != nil {
		t.Fatalf("connect application-role probe: %v", err)
	}
	var appUser string
	var appBypassesRLS bool
	if err := probe.QueryRow(ctx, `
SELECT current_user,
       COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false)
`).Scan(&appUser, &appBypassesRLS); err != nil {
		probe.Close()
		t.Fatalf("inspect application database role: %v", err)
	}
	probe.Close()
	if appUser != "postwave_app" || appBypassesRLS {
		t.Skipf("DATABASE_URL must use non-bypass postwave_app; got user=%q bypassrls=%v", appUser, appBypassesRLS)
	}

	private := privatedb.ForTest(t, adminURL, privatedb.Spec{
		Prefix: "postwave_1781_rls_",
		Label:  "form-variant RLS database",
		Check:  privatedb.Applied("1781_form_variants_rls_semantics"),
	})
	// Both pools close before the database is dropped: cleanups run last in,
	// first out, and ForTest registered the drop first.
	adminPool := private.Connect(t, adminURL, "administrative")
	appPool := private.Connect(t, appURL, "application")
	return appPool, adminPool
}

func seedVariantRLSTenantAndForm(
	t *testing.T,
	ctx context.Context,
	adminPool *pgxpool.Pool,
	tenantID, formID, suffix, status string,
) {
	t.Helper()
	if _, err := adminPool.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, $2, $3, 'studio')
ON CONFLICT (id) DO NOTHING`,
		tenantID, "Variant RLS "+suffix, "variant-rls-"+suffix); err != nil {
		t.Fatalf("seed tenant %s: %v", suffix, err)
	}
	if _, err := adminPool.Exec(ctx, `
INSERT INTO forms (
    id, tenant_id, slug, name, opt_in_mode, structure, settings, status
)
VALUES (
    $1::uuid, $2::uuid, $3, $4, 'single', '{}'::jsonb, '{}'::jsonb, $5
)`, formID, tenantID, "variant-form-"+suffix, "Variant form "+suffix, status); err != nil {
		t.Fatalf("seed form %s: %v", suffix, err)
	}
}

func setVariantSamples(
	t *testing.T,
	ctx context.Context,
	appPool *pgxpool.Pool,
	tenantID, formID, variantID string,
	impressions, submissions int64,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, appPool, tenantID)
	if err != nil {
		t.Fatalf("open tenant sample transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE form_variant_impressions
   SET impressions = $1, submissions = $2, updated_at = now()
 WHERE form_id = $3::uuid AND variant_id = $4::uuid`,
		impressions, submissions, formID, variantID)
	if err != nil {
		t.Fatalf("seed variant samples: %v", err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("seed variant samples affected %d rows; want one", tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit variant samples: %v", err)
	}
}

func TestFormVariantRLSSemanticsOnMigratedPostgres(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	appPool, adminPool := newMigratedVariantRLSPools(t, ctx)

	policyContract := map[string]string{
		"form_variants/form_variants_scope_guard":                         "RESTRICTIVE/ALL",
		"form_variants/form_variants_tenant_access":                       "PERMISSIVE/ALL",
		"form_variants/form_variants_public_select":                       "PERMISSIVE/SELECT",
		"form_variant_impressions/form_variant_impressions_scope_guard":   "RESTRICTIVE/ALL",
		"form_variant_impressions/form_variant_impressions_tenant_access": "PERMISSIVE/ALL",
		"form_variant_impressions/form_variant_impressions_public_select": "PERMISSIVE/SELECT",
		"form_variant_impressions/form_variant_impressions_public_insert": "PERMISSIVE/INSERT",
		"form_variant_impressions/form_variant_impressions_public_update": "PERMISSIVE/UPDATE",
	}
	rows, err := adminPool.Query(ctx, `
SELECT tablename, policyname, permissive, cmd
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('form_variants', 'form_variant_impressions')`)
	if err != nil {
		t.Fatalf("read installed variant policies: %v", err)
	}
	installed := map[string]string{}
	for rows.Next() {
		var table, name, permissive, command string
		if err := rows.Scan(&table, &name, &permissive, &command); err != nil {
			rows.Close()
			t.Fatalf("scan installed variant policy: %v", err)
		}
		installed[table+"/"+name] = permissive + "/" + command
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("iterate installed variant policies: %v", err)
	}
	rows.Close()
	for key, want := range policyContract {
		if got := installed[key]; got != want {
			t.Errorf("installed policy %s = %q, want %q", key, got, want)
		}
	}
	for _, retired := range []string{
		"form_variants/form_variants_tenant_isolation",
		"form_variants/form_variants_public_read",
		"form_variant_impressions/form_variant_impressions_tenant_isolation",
		"form_variant_impressions/form_variant_impressions_public_writer",
		"form_variant_impressions/form_variant_impressions_public_updater",
	} {
		if _, exists := installed[retired]; exists {
			t.Errorf("retired policy %s remains installed", retired)
		}
	}

	tenantA := uuid.NewString()
	tenantB := uuid.NewString()
	formA := uuid.NewString()
	formB := uuid.NewString()
	draftFormA := uuid.NewString()
	seedVariantRLSTenantAndForm(t, ctx, adminPool, tenantA, formA, "a-"+tenantA[:8], "published")
	seedVariantRLSTenantAndForm(t, ctx, adminPool, tenantB, formB, "b-"+tenantB[:8], "published")
	if _, err := adminPool.Exec(ctx, `
INSERT INTO forms (
    id, tenant_id, slug, name, opt_in_mode, structure, settings, status
)
VALUES (
    $1::uuid, $2::uuid, $3, 'Draft variant form', 'single', '{}'::jsonb, '{}'::jsonb, 'draft'
)`, draftFormA, tenantA, "variant-draft-"+tenantA[:8]); err != nil {
		t.Fatalf("seed draft form: %v", err)
	}

	var bareVariants, bareCounters int
	if err := appPool.QueryRow(ctx, `
SELECT (SELECT count(*)::int FROM form_variants),
       (SELECT count(*)::int FROM form_variant_impressions)
`).Scan(&bareVariants, &bareCounters); err != nil {
		t.Fatalf("read unscoped variant tables: %v", err)
	}
	if bareVariants != 0 || bareCounters != 0 {
		t.Fatalf("unscoped app role saw variants=%d counters=%d; want zero/zero", bareVariants, bareCounters)
	}

	repo := &Repo{Pool: appPool}
	control, err := repo.Create(ctx, tenantA, formA, CreateInput{
		Label:         "control",
		DisplayConfig: map[string]any{"headline": "Control"},
		TrafficPct:    50,
	})
	if err != nil {
		t.Fatalf("tenant A create control: %v", err)
	}
	challenger, err := repo.Create(ctx, tenantA, formA, CreateInput{
		Label:         "challenger",
		DisplayConfig: map[string]any{"headline": "Challenger"},
		TrafficPct:    50,
	})
	if err != nil {
		t.Fatalf("tenant A create challenger: %v", err)
	}
	draftVariant, err := repo.Create(ctx, tenantA, draftFormA, CreateInput{
		Label:      "draft-control",
		TrafficPct: 100,
	})
	if err != nil {
		t.Fatalf("tenant A create draft-form variant: %v", err)
	}
	tenantBVariant, err := repo.Create(ctx, tenantB, formB, CreateInput{
		Label:      "tenant-b-control",
		TrafficPct: 100,
	})
	if err != nil {
		t.Fatalf("tenant B create control: %v", err)
	}
	if _, err := repo.Create(ctx, tenantA, formB, CreateInput{
		Label:      "cross-tenant-attachment",
		TrafficPct: 100,
	}); err == nil {
		t.Fatal("tenant A attached a variant to tenant B's form")
	}
	var malformed int
	if err := adminPool.QueryRow(ctx, `
SELECT count(*)::int
  FROM form_variants
 WHERE tenant_id = $1::uuid AND form_id = $2::uuid`, tenantA, formB).Scan(&malformed); err != nil {
		t.Fatalf("inspect cross-tenant attachment: %v", err)
	}
	if malformed != 0 {
		t.Fatalf("cross-tenant variant attachment rows=%d; want zero", malformed)
	}

	listed, err := repo.List(ctx, tenantA, formA)
	if err != nil || len(listed) != 2 {
		t.Fatalf("tenant A list = %d rows, err=%v; want two", len(listed), err)
	}
	foreignList, err := repo.List(ctx, tenantB, formA)
	if err != nil || len(foreignList) != 0 {
		t.Fatalf("tenant B list of tenant A form = %d rows, err=%v; want zero", len(foreignList), err)
	}

	newLabel := "control-updated"
	newTraffic := 60
	updated, err := repo.Update(ctx, tenantA, formA, control.ID, UpdateInput{
		Label:      &newLabel,
		TrafficPct: &newTraffic,
	})
	if err != nil {
		t.Fatalf("tenant A update control: %v", err)
	}
	if updated.Label != newLabel || updated.TrafficPct != newTraffic {
		t.Fatalf("updated variant = label %q traffic %d; want %q/%d",
			updated.Label, updated.TrafficPct, newLabel, newTraffic)
	}
	if _, err := repo.Update(ctx, tenantB, formA, control.ID, UpdateInput{Label: &newLabel}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tenant B update of tenant A variant err=%v; want ErrNotFound", err)
	}
	if err := repo.Delete(ctx, tenantB, formA, control.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tenant B delete of tenant A variant err=%v; want ErrNotFound", err)
	}

	picked, err := repo.PickForRenderPublic(ctx, tenantA, formA, 0)
	if err != nil || (picked.VariantID != control.ID && picked.VariantID != challenger.ID) {
		t.Fatalf("public pick = %+v err=%v; want tenant A form variant", picked, err)
	}
	if _, err := repo.PickForRenderPublic(ctx, tenantB, formA, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong-tenant public pick err=%v; want ErrNotFound", err)
	}
	if _, err := repo.PickForRenderPublic(ctx, tenantA, formB, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong-form-owner public pick err=%v; want ErrNotFound", err)
	}
	if _, err := repo.PickForRenderPublic(ctx, tenantA, draftFormA, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("draft-form public pick err=%v; want ErrNotFound", err)
	}

	if err := repo.IncrementImpressionPublic(ctx, tenantA, formA, control.ID); err != nil {
		t.Fatalf("public impression increment: %v", err)
	}
	if err := repo.IncrementSubmissionPublic(ctx, tenantA, formA, control.ID); err != nil {
		t.Fatalf("public submission increment: %v", err)
	}
	counted, err := repo.Get(ctx, tenantA, formA, control.ID)
	if err != nil {
		t.Fatalf("read public counters through tenant scope: %v", err)
	}
	if counted.Impressions != 1 || counted.Submissions != 1 {
		t.Fatalf("public counters=%d/%d; want 1/1", counted.Impressions, counted.Submissions)
	}
	for name, increment := range map[string]func() error{
		"wrong tenant": func() error {
			return repo.IncrementImpressionPublic(ctx, tenantB, formA, control.ID)
		},
		"wrong form": func() error {
			return repo.IncrementSubmissionPublic(ctx, tenantA, formB, tenantBVariant.ID)
		},
		"foreign variant": func() error {
			return repo.IncrementImpressionPublic(ctx, tenantA, formA, tenantBVariant.ID)
		},
		"draft form": func() error {
			return repo.IncrementImpressionPublic(ctx, tenantA, draftFormA, draftVariant.ID)
		},
	} {
		if err := increment(); err == nil {
			t.Errorf("public %s counter increment unexpectedly succeeded", name)
		}
	}

	setVariantSamples(t, ctx, appPool, tenantA, formA, control.ID, 1000, 150)
	setVariantSamples(t, ctx, appPool, tenantA, formA, challenger.ID, 1000, 50)
	decision, samples, err := EvaluateForm(ctx, repo, tenantA, formA)
	if err != nil {
		t.Fatalf("tenant A evaluate variants: %v", err)
	}
	if len(samples) != 2 || decision.PromoteVariantID != control.ID {
		t.Fatalf("evaluate samples=%+v decision=%+v; want control promoted", samples, decision)
	}
	promotions, err := repo.ListPromotions(ctx, tenantA, formA)
	if err != nil || len(promotions) != 1 || promotions[0].WinnerVariantID != control.ID {
		t.Fatalf("promotion audit=%+v err=%v; want one control winner", promotions, err)
	}
	foreignDecision, foreignSamples, err := EvaluateForm(ctx, repo, tenantB, formA)
	if err != nil || len(foreignSamples) != 0 || len(foreignDecision.Weights) != 0 {
		t.Fatalf("cross-tenant evaluate decision=%+v samples=%+v err=%v; want empty", foreignDecision, foreignSamples, err)
	}

	picked, err = repo.PickForRenderPublic(ctx, tenantA, formA, 99)
	if err != nil || picked.VariantID != control.ID {
		t.Fatalf("post-promotion public pick=%+v err=%v; want control", picked, err)
	}
	if err := repo.IncrementSubmissionPublic(ctx, tenantA, formA, challenger.ID); err != nil {
		t.Fatalf("late submission for paused challenger: %v", err)
	}
	paused, err := repo.Get(ctx, tenantA, formA, challenger.ID)
	if err != nil || paused.Status != StatusPaused || paused.Submissions != 51 {
		t.Fatalf("paused challenger=%+v err=%v; want paused with 51 submissions", paused, err)
	}

	publicTx, err := appPool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("open direct public-scope transaction: %v", err)
	}
	defer func() { _ = publicTx.Rollback(ctx) }()
	if _, err := publicTx.Exec(ctx, `SELECT set_config('app.public_form_tenant_id', $1, true)`, tenantA); err != nil {
		t.Fatalf("bind direct public tenant: %v", err)
	}
	if _, err := publicTx.Exec(ctx, `SELECT set_config('app.public_form_id', $1, true)`, formA); err != nil {
		t.Fatalf("bind direct public form: %v", err)
	}
	var visibleExact, visibleForeign int
	if err := publicTx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE form_id = $1::uuid)::int,
       count(*) FILTER (WHERE form_id = $2::uuid)::int
  FROM form_variants`, formA, formB).Scan(&visibleExact, &visibleForeign); err != nil {
		t.Fatalf("read direct public variant visibility: %v", err)
	}
	if visibleExact != 2 || visibleForeign != 0 {
		t.Fatalf("direct public visibility exact=%d foreign=%d; want 2/0", visibleExact, visibleForeign)
	}
	tag, err := publicTx.Exec(ctx, `DELETE FROM form_variants WHERE id = $1::uuid`, challenger.ID)
	if err != nil {
		t.Fatalf("attempt direct public delete: %v", err)
	}
	if tag.RowsAffected() != 0 {
		t.Fatalf("direct public delete affected %d rows; want zero", tag.RowsAffected())
	}
	if err := publicTx.Rollback(ctx); err != nil {
		t.Fatalf("close direct public-scope transaction: %v", err)
	}

	if err := repo.Delete(ctx, tenantA, draftFormA, draftVariant.ID); err != nil {
		t.Fatalf("tenant A delete draft variant: %v", err)
	}
	if _, err := repo.Get(ctx, tenantA, draftFormA, draftVariant.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted draft variant lookup err=%v; want ErrNotFound", err)
	}
	if err := repo.Delete(ctx, tenantB, formB, tenantBVariant.ID); err != nil {
		t.Fatalf("tenant B delete own variant: %v", err)
	}
}
