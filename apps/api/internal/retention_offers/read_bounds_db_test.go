// SPDX-License-Identifier: AGPL-3.0-only

package retention_offers

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/paywall"
)

// TestAdminReadBoundsFailClosed proves the SQL limit+1 contract against a
// migrated PostgreSQL schema. It covers the exact 1,000-row success boundary
// and the 1,001-row typed failure for offers, funnel tiles, and their
// supporting paywall-tier registry.
func TestAdminReadBoundsFailClosed(t *testing.T) {
	appDatabaseURL := strings.TrimSpace(os.Getenv("POSTWAVE_RETENTION_BOUNDS_TEST_DATABASE_URL"))
	if appDatabaseURL == "" {
		appDatabaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	adminDatabaseURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminDatabaseURL == "" {
		adminDatabaseURL = strings.TrimSpace(os.Getenv("POSTWAVE_ADMIN_DATABASE_URL"))
	}
	if appDatabaseURL == "" || adminDatabaseURL == "" {
		t.Skip("an application DSN (POSTWAVE_RETENTION_BOUNDS_TEST_DATABASE_URL or DATABASE_URL) and an admin DSN (POSTWAVE_TEST_ADMIN_DATABASE_URL or POSTWAVE_ADMIN_DATABASE_URL) are required for retention read-bound DB proof")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	appPool, err := pgxpool.New(ctx, appDatabaseURL)
	if err != nil {
		t.Fatalf("connect retention read-bound application database: %v", err)
	}
	t.Cleanup(appPool.Close)
	adminPool, err := pgxpool.New(ctx, adminDatabaseURL)
	if err != nil {
		t.Fatalf("connect retention read-bound fixture database: %v", err)
	}
	t.Cleanup(adminPool.Close)

	var appUser string
	var appBypassesRLS bool
	if err := appPool.QueryRow(ctx, `
SELECT current_user,
       COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), false)
`).Scan(&appUser, &appBypassesRLS); err != nil {
		t.Fatalf("inspect retention read-bound application role: %v", err)
	}
	if appUser != "postwave_app" || appBypassesRLS {
		t.Skipf("application DSN must use non-bypass postwave_app; got user=%q bypassrls=%v", appUser, appBypassesRLS)
	}

	var schemaReady bool
	if err := adminPool.QueryRow(ctx, `
SELECT to_regclass('public.tenants') IS NOT NULL
   AND to_regclass('public.paywall_tiers') IS NOT NULL
   AND to_regclass('public.retention_offers') IS NOT NULL
   AND to_regclass('public.retention_offer_events') IS NOT NULL`).Scan(&schemaReady); err != nil {
		t.Fatalf("inspect retention read-bound schema: %v", err)
	}
	if !schemaReady {
		t.Fatal("configured database is missing the retention-offer/paywall schema")
	}

	tenantID := uuid.NewString()
	slug := "retention-bound-" + strings.ReplaceAll(tenantID, "-", "")[:16]
	if _, err := adminPool.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Retention read-bound proof', 'studio')`, tenantID, slug); err != nil {
		t.Fatalf("seed retention read-bound tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		if _, cleanupErr := adminPool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); cleanupErr != nil {
			t.Errorf("cleanup retention read-bound tenant: %v", cleanupErr)
		}
	})

	if _, err := adminPool.Exec(ctx, `
INSERT INTO paywall_tiers (tenant_id, name, active)
SELECT $1::uuid, 'Read bound tier ' || lpad(series::text, 4, '0'), true
  FROM generate_series(1, $2::integer) AS series`, tenantID, MaxReadRows); err != nil {
		t.Fatalf("seed %d paywall tiers: %v", MaxReadRows, err)
	}
	if _, err := adminPool.Exec(ctx, `
INSERT INTO retention_offers (
    tenant_id, paywall_tier_id, percent_off, duration_months, active
)
SELECT tenant_id, id, 10, 1, true
  FROM paywall_tiers
 WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		t.Fatalf("seed %d retention offers: %v", MaxReadRows, err)
	}

	retentionRepo := &Repo{Pool: appPool}
	tierRepo := &paywall.Repo{Pool: appPool}
	assertExactBoundarySucceeds(t, ctx, retentionRepo, tierRepo, tenantID)

	var overflowTierID string
	if err := adminPool.QueryRow(ctx, `
INSERT INTO paywall_tiers (tenant_id, name, active)
VALUES ($1::uuid, 'Read bound tier overflow', true)
RETURNING id::text`, tenantID).Scan(&overflowTierID); err != nil {
		t.Fatalf("seed overflow paywall tier: %v", err)
	}
	if _, err := adminPool.Exec(ctx, `
INSERT INTO retention_offers (
    tenant_id, paywall_tier_id, percent_off, duration_months, active
)
VALUES ($1::uuid, $2::uuid, 10, 1, true)`, tenantID, overflowTierID); err != nil {
		t.Fatalf("seed overflow retention offer: %v", err)
	}

	offers, err := retentionRepo.ListOffers(ctx, tenantID)
	assertRetentionReadOverflow(t, "offers", offers, err)
	tiles, err := retentionRepo.LoadFunnel(ctx, tenantID)
	assertRetentionReadOverflow(t, "funnel", tiles, err)
	tiers, err := tierRepo.ListTiers(ctx, tenantID)
	if tiers != nil {
		t.Fatalf("oversized tier read returned %d partial rows; want nil", len(tiers))
	}
	if !errors.Is(err, paywall.ErrTierReadSetTooLarge) {
		t.Fatalf("oversized tier read error = %v, want ErrTierReadSetTooLarge", err)
	}
	var tierLimit *paywall.TierReadSetTooLargeError
	if !errors.As(err, &tierLimit) || tierLimit.Limit != paywall.MaxTierReadRows {
		t.Fatalf("oversized tier typed error = %+v, want limit %d", tierLimit, paywall.MaxTierReadRows)
	}

	// There is intentionally no migration in this remediation. Prove that an
	// over-bound legacy/direct-SQL value cannot leak as a malformed 200 while
	// documenting that the offending row must be repaired before this complete
	// non-paginated read can succeed again.
	if _, err := adminPool.Exec(ctx, `DELETE FROM paywall_tiers WHERE id = $1::uuid`, overflowTierID); err != nil {
		t.Fatalf("remove row-count overflow fixture: %v", err)
	}
	for _, fieldCase := range []struct {
		field string
		query string
	}{
		{
			field: "headline",
			query: `UPDATE retention_offers
                       SET headline = repeat('h', $2)
                     WHERE id = (SELECT id FROM retention_offers WHERE tenant_id = $1::uuid LIMIT 1)`,
		},
		{
			field: "body",
			query: `UPDATE retention_offers
                       SET body = repeat('b', $2)
                     WHERE id = (SELECT id FROM retention_offers WHERE tenant_id = $1::uuid LIMIT 1)`,
		},
		{
			field: "stripe_coupon_id",
			query: `UPDATE retention_offers
                       SET stripe_coupon_id = repeat('p', $2)
                     WHERE id = (SELECT id FROM retention_offers WHERE tenant_id = $1::uuid LIMIT 1)`,
		},
	} {
		if _, err := adminPool.Exec(ctx, `
UPDATE retention_offers
   SET headline = NULL, body = NULL, stripe_coupon_id = NULL
 WHERE tenant_id = $1::uuid`, tenantID); err != nil {
			t.Fatalf("reset stored field fixture: %v", err)
		}
		maximum := map[string]int{
			"headline": MaxHeadlineBytes, "body": MaxBodyBytes,
			"stripe_coupon_id": MaxProviderReferenceBytes,
		}[fieldCase.field]
		if _, err := adminPool.Exec(ctx, fieldCase.query, tenantID, maximum+1); err != nil {
			t.Fatalf("seed oversized stored %s: %v", fieldCase.field, err)
		}
		offers, err := retentionRepo.ListOffers(ctx, tenantID)
		if offers != nil {
			t.Fatalf("oversized stored %s returned %d partial rows; want nil", fieldCase.field, len(offers))
		}
		if !errors.Is(err, ErrOfferFieldInvalid) {
			t.Fatalf("oversized stored %s error = %v, want ErrOfferFieldInvalid", fieldCase.field, err)
		}
		var typed *OfferFieldError
		if !errors.As(err, &typed) || typed.Field != fieldCase.field || typed.MaxBytes != maximum {
			t.Fatalf("oversized stored %s typed error = %+v", fieldCase.field, typed)
		}
	}

	var legacyTierID, legacyTierName string
	if err := adminPool.QueryRow(ctx, `
SELECT id::text, name
  FROM paywall_tiers
 WHERE tenant_id = $1::uuid
 ORDER BY id
 LIMIT 1`, tenantID).Scan(&legacyTierID, &legacyTierName); err != nil {
		t.Fatalf("select supporting tier field fixture: %v", err)
	}
	for _, fieldCase := range []struct {
		field   string
		maximum int
		seed    string
		reset   string
	}{
		{
			field: "name", maximum: paywall.MaxTierNameBytes,
			seed:  `UPDATE paywall_tiers SET name = repeat('n', $2) WHERE id = $1::uuid`,
			reset: `UPDATE paywall_tiers SET name = $2 WHERE id = $1::uuid`,
		},
		{
			field: "description", maximum: paywall.MaxTierDescriptionBytes,
			seed:  `UPDATE paywall_tiers SET description = repeat('d', $2) WHERE id = $1::uuid`,
			reset: `UPDATE paywall_tiers SET description = NULL WHERE id = $1::uuid`,
		},
		{
			field: "stripe_price_id", maximum: paywall.MaxTierProviderReferenceBytes,
			seed:  `UPDATE paywall_tiers SET stripe_price_id = repeat('p', $2) WHERE id = $1::uuid`,
			reset: `UPDATE paywall_tiers SET stripe_price_id = NULL WHERE id = $1::uuid`,
		},
	} {
		if _, err := adminPool.Exec(ctx, fieldCase.seed, legacyTierID, fieldCase.maximum+1); err != nil {
			t.Fatalf("seed oversized stored tier %s: %v", fieldCase.field, err)
		}
		tiers, err := tierRepo.ListTiers(ctx, tenantID)
		if tiers != nil {
			t.Fatalf("oversized stored tier %s returned %d partial rows; want nil", fieldCase.field, len(tiers))
		}
		if !errors.Is(err, paywall.ErrTierFieldInvalid) {
			t.Fatalf("oversized stored tier %s error = %v, want ErrTierFieldInvalid", fieldCase.field, err)
		}
		var typed *paywall.TierFieldError
		if !errors.As(err, &typed) || typed.Field != fieldCase.field || typed.MaxBytes != fieldCase.maximum {
			t.Fatalf("oversized stored tier %s typed error = %+v", fieldCase.field, typed)
		}
		if fieldCase.field == "name" {
			if _, err := adminPool.Exec(ctx, fieldCase.reset, legacyTierID, legacyTierName); err != nil {
				t.Fatalf("reset stored tier name: %v", err)
			}
		} else if _, err := adminPool.Exec(ctx, fieldCase.reset, legacyTierID); err != nil {
			t.Fatalf("reset stored tier %s: %v", fieldCase.field, err)
		}
	}
}

func assertExactBoundarySucceeds(
	t *testing.T,
	ctx context.Context,
	retentionRepo *Repo,
	tierRepo *paywall.Repo,
	tenantID string,
) {
	t.Helper()
	offers, err := retentionRepo.ListOffers(ctx, tenantID)
	if err != nil || len(offers) != MaxReadRows {
		t.Fatalf("offer boundary read = (%d rows, %v), want (%d, nil)", len(offers), err, MaxReadRows)
	}
	tiles, err := retentionRepo.LoadFunnel(ctx, tenantID)
	if err != nil || len(tiles) != MaxReadRows {
		t.Fatalf("funnel boundary read = (%d rows, %v), want (%d, nil)", len(tiles), err, MaxReadRows)
	}
	tiers, err := tierRepo.ListTiers(ctx, tenantID)
	if err != nil || len(tiers) != paywall.MaxTierReadRows {
		t.Fatalf("tier boundary read = (%d rows, %v), want (%d, nil)", len(tiers), err, paywall.MaxTierReadRows)
	}
}

func assertRetentionReadOverflow[T any](t *testing.T, resource string, rows []T, err error) {
	t.Helper()
	if rows != nil {
		t.Fatalf("oversized %s read returned %d partial rows; want nil", resource, len(rows))
	}
	if !errors.Is(err, ErrReadSetTooLarge) {
		t.Fatalf("oversized %s read error = %v, want ErrReadSetTooLarge", resource, err)
	}
	var typed *ReadSetTooLargeError
	if !errors.As(err, &typed) || typed.Resource != resource || typed.Limit != MaxReadRows {
		t.Fatalf("oversized %s typed error = %+v, want resource=%s limit=%d", resource, typed, resource, MaxReadRows)
	}
}
