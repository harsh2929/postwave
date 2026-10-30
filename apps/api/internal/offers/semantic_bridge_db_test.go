// SPDX-License-Identifier: AGPL-3.0-only

package offers

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

func bridgeTestPool(t *testing.T, ctx context.Context) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL is required for the canonical offer bridge DB proof")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	t.Cleanup(pool.Close)
	var ready bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('public.offers') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatalf("inspect offers schema: %v", err)
	}
	if !ready {
		t.Fatal("configured database does not have migration 1946")
	}
	return pool
}

type bridgeFixture struct {
	tenantID string
	offerID  string
	otherID  string
}

func seedBridgeOffer(t *testing.T, ctx context.Context, pool *db.Pool) bridgeFixture {
	t.Helper()
	fixture := bridgeFixture{
		tenantID: uuid.NewString(), offerID: uuid.NewString(), otherID: uuid.NewString(),
	}
	tx, err := db.WithTenant(ctx, pool, fixture.tenantID)
	if err != nil {
		t.Fatalf("begin bridge fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $3, 'pro')`,
		fixture.tenantID, "bridge-"+fixture.tenantID[:8], "bridge-"+strings.ReplaceAll(fixture.tenantID, "-", "")[:16],
	); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO offers (id, tenant_id, type, title, description, price_cents, currency,
                    valid_until, action_url, inventory_state, metadata)
VALUES ($1::uuid, $2::uuid, 'discount', 'Spring sale', '20% off everything', 12900, 'USD',
        $3::timestamptz, 'https://example.test/buy', 'in_stock', '{"code":"SPRING20"}'::jsonb)`,
		fixture.offerID, fixture.tenantID, "2026-06-01T00:00:00Z",
	); err != nil {
		t.Fatalf("seed offer: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit bridge fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanup, err := db.WithTenant(context.Background(), pool, fixture.tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(context.Background()) }()
		_, _ = cleanup.Exec(context.Background(), `DELETE FROM offers WHERE tenant_id = $1::uuid`, fixture.tenantID)
		_, _ = cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID)
		_ = cleanup.Commit(context.Background())
	})
	return fixture
}

// The bridge is a name, so a change to the entity is visible through it.
//
// This is the property a snapshot cannot have. The semantic tree is identical
// across both resolutions here — the same reference, byte for byte — and the two
// answers differ because the ENTITY changed. An implementation that inlined or
// cached the first resolution returns the stale window and the stale inventory
// state, and fails.
func TestTheBridgeReflectsAChangeToTheCanonicalEntity(t *testing.T) {
	ctx := context.Background()
	pool := bridgeTestPool(t, ctx)
	fixture := seedBridgeOffer(t, ctx, pool)

	repo := &Repo{Pool: pool, Now: func() time.Time { return at("2026-05-01T12:00:00Z") }}
	reference := semanticemail.CanonicalOfferReference{
		NodeID:                   "blk_offer",
		CanonicalOfferID:         fixture.offerID,
		AuthoredCode:             "SPRING20",
		AuthoredAvailabilityEnds: "2026-06-01T00:00:00Z",
	}
	references := []semanticemail.CanonicalOfferReference{reference}

	before, err := repo.ResolveSemanticOffers(ctx, fixture.tenantID, references)
	if err != nil {
		t.Fatalf("resolve before: %v", err)
	}
	if len(before) != 1 || before[0].Missing || before[0].Offer == nil {
		t.Fatalf("bindings = %+v, want one resolved binding", before)
	}
	if before[0].NodeID != "blk_offer" {
		t.Fatalf("binding node id = %q; a disagreement has to point at a node an author can edit",
			before[0].NodeID)
	}
	if before[0].Offer.PriceCents == nil || *before[0].Offer.PriceCents != 12900 ||
		before[0].Offer.Currency != "USD" {
		t.Fatalf("resolved price = %+v/%q", before[0].Offer.PriceCents, before[0].Offer.Currency)
	}
	if got := before[0].Offer.ValidUntil; got == nil || !got.Equal(at("2026-06-01T00:00:00Z")) {
		t.Fatalf("resolved valid_until = %v", got)
	}
	if !before[0].Offer.Actionable(repo.now()) {
		t.Fatal("a live, in-stock, priced offer is not actionable through the bridge")
	}
	if len(before[0].Disagreements) != 0 {
		t.Fatalf("disagreements = %+v while the message and the entity agree", before[0].Disagreements)
	}

	// The entity moves. The message does not.
	mutate, err := db.WithTenant(ctx, pool, fixture.tenantID)
	if err != nil {
		t.Fatalf("begin mutation: %v", err)
	}
	if _, err := mutate.Exec(ctx, `
UPDATE offers SET valid_until = $2::timestamptz, inventory_state = 'sold_out', price_cents = 9900
 WHERE tenant_id = $1::uuid AND id = $3::uuid`,
		fixture.tenantID, "2026-05-20T00:00:00Z", fixture.offerID); err != nil {
		_ = mutate.Rollback(ctx)
		t.Fatalf("mutate offer: %v", err)
	}
	if err := mutate.Commit(ctx); err != nil {
		t.Fatalf("commit mutation: %v", err)
	}

	after, err := repo.ResolveSemanticOffers(ctx, fixture.tenantID, references)
	if err != nil {
		t.Fatalf("resolve after: %v", err)
	}
	if len(after) != 1 || after[0].Offer == nil {
		t.Fatalf("bindings = %+v", after)
	}
	if got := after[0].Offer.ValidUntil; got == nil || !got.Equal(at("2026-05-20T00:00:00Z")) {
		t.Fatalf("valid_until through the bridge = %v, want the CHANGED value; the bridge is "+
			"returning a snapshot rather than re-reading the entity", got)
	}
	if after[0].Offer.InventoryState != "sold_out" {
		t.Fatalf("inventory state through the bridge = %q, want sold_out", after[0].Offer.InventoryState)
	}
	if after[0].Offer.PriceCents == nil || *after[0].Offer.PriceCents != 9900 {
		t.Fatalf("price through the bridge = %+v, want the changed 9900", after[0].Offer.PriceCents)
	}
	if after[0].Offer.Actionable(repo.now()) {
		t.Fatal("a sold-out offer is still reported actionable through the bridge")
	}
	if !hasDisagreement(after[0].Disagreements, DisagreementAvailabilityEnds) ||
		!hasDisagreement(after[0].Disagreements, DisagreementInventoryState) {
		t.Fatalf("disagreements = %+v; the message still prints the old window and presents an "+
			"offer that is sold out, and neither was reported", after[0].Disagreements)
	}
}

// A message naming an offer that does not exist for this tenant reports Missing.
//
// It must not read as "no problem found". Row-level security FILTERS rather than
// refuses, so a cross-tenant reference simply returns no row — the binding is
// where that becomes visible.
func TestABridgeToAnAbsentOfferReportsMissing(t *testing.T) {
	ctx := context.Background()
	pool := bridgeTestPool(t, ctx)
	fixture := seedBridgeOffer(t, ctx, pool)

	repo := &Repo{Pool: pool, Now: func() time.Time { return at("2026-05-01T12:00:00Z") }}
	bindings, err := repo.ResolveSemanticOffers(ctx, fixture.tenantID, []semanticemail.CanonicalOfferReference{
		{NodeID: "blk_present", CanonicalOfferID: fixture.offerID},
		{NodeID: "blk_absent", CanonicalOfferID: fixture.otherID},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(bindings) != 2 {
		t.Fatalf("bindings = %+v, want one per reference in document order", bindings)
	}
	if bindings[0].Missing || bindings[0].Offer == nil {
		t.Fatalf("the present offer resolved as %+v", bindings[0])
	}
	if !bindings[1].Missing || bindings[1].Offer != nil {
		t.Fatalf("an offer that does not exist resolved as %+v", bindings[1])
	}
}

// A message in one tenant cannot resolve another tenant's offer.
func TestTheBridgeIsTenantScoped(t *testing.T) {
	ctx := context.Background()
	pool := bridgeTestPool(t, ctx)
	owner := seedBridgeOffer(t, ctx, pool)
	stranger := seedBridgeOffer(t, ctx, pool)

	repo := &Repo{Pool: pool, Now: func() time.Time { return at("2026-05-01T12:00:00Z") }}
	bindings, err := repo.ResolveSemanticOffers(ctx, stranger.tenantID,
		[]semanticemail.CanonicalOfferReference{{NodeID: "blk_offer", CanonicalOfferID: owner.offerID}})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(bindings) != 1 || !bindings[0].Missing || bindings[0].Offer != nil {
		t.Fatalf("a tenant resolved another tenant's offer through the bridge: %+v", bindings)
	}
}
