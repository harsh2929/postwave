// SPDX-License-Identifier: AGPL-3.0-only

package offers

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/actionticket"
	"github.com/postwave/postwave/apps/api/internal/db"
)

func seedActionOffer(t *testing.T, ctx context.Context, pool *db.Pool) (string, string, string) {
	t.Helper()
	var ready bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.offer_decline_decisions') IS NOT NULL
   AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'action_tickets'
          AND column_name = 'resource_version'
   )`).Scan(&ready); err != nil || !ready {
		t.Fatalf("configured database does not have migration 2014: ready=%v err=%v", ready, err)
	}
	tenantID, offerID, userID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'offer-action-test', $2, 'pro')`,
		tenantID, "offer-action-"+strings.ReplaceAll(tenantID, "-", "")[:16]); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO offers (
    id, tenant_id, type, title, description, valid_from, valid_until,
    action_url, inventory_state
)
VALUES ($1::uuid, $2::uuid, 'discount', 'Stay with Moosewave', '20 percent off',
        statement_timestamp() - interval '1 minute',
        statement_timestamp() + interval '30 minutes',
        'https://billing.example.test/accept', 'in_stock')`, offerID, tenantID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(context.Background()) }()
		_, _ = cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(context.Background())
	})
	return tenantID, offerID, userID
}

func TestReleaseHeldOfferDeclineCannotMintATicketDB(t *testing.T) {
	ctx := context.Background()
	pool := bridgeTestPool(t, ctx)
	tenantID, offerID, userID := seedActionOffer(t, ctx, pool)
	offerRepo := &Repo{Pool: pool}
	tickets := &actionticket.Repo{Pool: pool, Binder: offerRepo}

	if _, err := tickets.Mint(ctx, tenantID, userID, "offer.decline", "offer", offerID, 0); !errors.Is(err, actionticket.ErrUnknownAction) {
		t.Fatalf("release-held offer decline mint error = %v, want unknown action", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM offer_decline_decisions
 WHERE tenant_id = $1::uuid AND offer_id = $2::uuid AND user_id = $3::uuid`,
		tenantID, offerID, userID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("release-held action wrote %d decision receipts", count)
	}
	var appCanUpdate, appCanDelete bool
	if err := tx.QueryRow(ctx, `
SELECT has_table_privilege('postwave_app', 'offer_decline_decisions', 'UPDATE'),
       has_table_privilege('postwave_app', 'offer_decline_decisions', 'DELETE')`).
		Scan(&appCanUpdate, &appCanDelete); err != nil {
		t.Fatal(err)
	}
	if appCanUpdate || appCanDelete {
		t.Fatalf("immutable receipt grants update/delete = %v/%v", appCanUpdate, appCanDelete)
	}
}

func TestDormantOfferBindingChangesWhenTheOfferChangesDB(t *testing.T) {
	ctx := context.Background()
	pool := bridgeTestPool(t, ctx)
	tenantID, offerID, _ := seedActionOffer(t, ctx, pool)
	offerRepo := &Repo{Pool: pool}
	before, err := offerRepo.BindActionResource(ctx, tenantID, "offer.decline", "offer", offerID)
	if err != nil {
		t.Fatal(err)
	}

	mutate, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mutate.Exec(ctx, `
UPDATE offers SET description = 'A materially different offer'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, offerID); err != nil {
		_ = mutate.Rollback(ctx)
		t.Fatal(err)
	}
	if err := mutate.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	after, err := offerRepo.BindActionResource(ctx, tenantID, "offer.decline", "offer", offerID)
	if err != nil {
		t.Fatal(err)
	}
	if !lowerSHA256(before.Version) || !lowerSHA256(after.Version) || before.Version == after.Version {
		t.Fatalf("offer binding did not change across a material mutation: before=%q after=%q",
			before.Version, after.Version)
	}
}
