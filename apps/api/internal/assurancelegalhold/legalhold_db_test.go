// SPDX-License-Identifier: AGPL-3.0-only

package assurancelegalhold

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A legal hold suspends deletion of evidence that a retention sweep would
// otherwise remove on schedule. The predicate lives in SQL, as one function
// every sweep calls, because the failure mode of copying it is that one sweep
// keeps deleting and nobody notices until the evidence is needed.

// Two connections on purpose.
//
// seedPool is privileged: fixtures have to insert tenants and campaigns, which
// RLS correctly forbids the application role from doing.
//
// holdDBPool is `postwave_app` — NOT a superuser, NOT BYPASSRLS. Every
// assertion below runs through it, because the question these tests answer is
// what the application and its retention workers can see. Running them as a
// superuser passes whatever the policies say, including nothing: an earlier
// revision of this file did exactly that and reported the hold predicate
// working under worker scope when the worker could not read a single hold.
func holdSeedPool(t *testing.T, ctx context.Context) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("POSTWAVE_LEGAL_HOLD_TEST_DATABASE_URL"))
	if url == "" {
		t.Skip("POSTWAVE_LEGAL_HOLD_TEST_DATABASE_URL is required for legal-hold DB proof")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect legal hold seed database: %v", err)
	}
	t.Cleanup(pool.Close)
	var ready bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.campaign_assurance_legal_holds') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatalf("inspect schema: %v", err)
	}
	if !ready {
		t.Fatal("configured database is missing campaign_assurance_legal_holds")
	}
	return pool
}

func holdDBPool(t *testing.T, ctx context.Context) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("POSTWAVE_LEGAL_HOLD_APP_TEST_DATABASE_URL"))
	if url == "" {
		t.Skip("POSTWAVE_LEGAL_HOLD_APP_TEST_DATABASE_URL (restricted postwave_app role) is required")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect legal hold app database: %v", err)
	}
	t.Cleanup(pool.Close)
	var superuser, bypassRLS bool
	if err := pool.QueryRow(ctx, `
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`).
		Scan(&superuser, &bypassRLS); err != nil {
		t.Fatalf("inspect current role: %v", err)
	}
	// Guard the guard. A superuser connection would make every RLS assertion
	// below vacuous while still reporting PASS.
	if superuser || bypassRLS {
		t.Fatal("the app test connection must not be a superuser or BYPASSRLS role")
	}
	return pool
}

func seedHoldTenant(t *testing.T, ctx context.Context, seed *db.Pool) (string, string) {
	t.Helper()
	tenantID, campaignID := uuid.NewString(), uuid.NewString()
	suffix := strings.ReplaceAll(tenantID, "-", "")[:16]
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, $3, 'sending')`,
		tenantID, "hold-"+suffix, "Hold "+suffix); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html)
VALUES ($1::uuid, $2::uuid, 'Hold proof', 'Subject', '<p>Body</p>')`,
		campaignID, tenantID); err != nil {
		t.Fatalf("seed campaign: %v", err)
	}
	t.Cleanup(func() {
		_, _ = seed.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	return tenantID, campaignID
}

// Goes through Active rather than querying the function directly: Active binds
// the tenant GUC the RLS policy reads, and a raw query on the app pool would
// see no holds and report "not held" for everything — the same false answer a
// mis-scoped sweep would get.
func active(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, campaignID string) bool {
	t.Helper()
	held, err := Active(ctx, pool, tenantID, campaignID)
	if err != nil {
		t.Fatalf("evaluate hold predicate: %v", err)
	}
	return held
}

func TestNoHoldMeansEvidenceIsSweepable(t *testing.T) {
	ctx := context.Background()
	pool := holdDBPool(t, ctx)
	seed := holdSeedPool(t, ctx)
	tenantID, campaignID := seedHoldTenant(t, ctx, seed)

	if active(t, ctx, pool, tenantID, campaignID) {
		t.Error("a tenant with no holds must not be held")
	}
}

func TestACampaignHoldCoversOnlyThatCampaign(t *testing.T) {
	ctx := context.Background()
	pool := holdDBPool(t, ctx)
	seed := holdSeedPool(t, ctx)
	tenantID, campaignID := seedHoldTenant(t, ctx, seed)
	otherCampaign := uuid.NewString()

	if _, err := Place(ctx, pool, PlaceInput{
		TenantID: tenantID, CampaignID: campaignID, Reason: "litigation hold ACME-1",
	}); err != nil {
		t.Fatalf("place hold: %v", err)
	}

	if !active(t, ctx, pool, tenantID, campaignID) {
		t.Error("the held campaign must report held")
	}
	if active(t, ctx, pool, tenantID, otherCampaign) {
		t.Error("an unrelated campaign must not be held by a campaign-scoped hold")
	}
}

// Image evidence (rasters, the OCR cache) carries no campaign column, so a
// sweep cannot prove a given raster does not belong to the held campaign. The
// only honest answer is that ANY active hold for the tenant suspends it, which
// is what a NULL campaign argument asks.
func TestATenantHasAnyHoldWhenAskedWithoutACampaign(t *testing.T) {
	ctx := context.Background()
	pool := holdDBPool(t, ctx)
	seed := holdSeedPool(t, ctx)
	tenantID, campaignID := seedHoldTenant(t, ctx, seed)

	if active(t, ctx, pool, tenantID, "") {
		t.Fatal("a tenant with no holds must not be held")
	}
	if _, err := Place(ctx, pool, PlaceInput{
		TenantID: tenantID, CampaignID: campaignID, Reason: "litigation hold ACME-1",
	}); err != nil {
		t.Fatalf("place hold: %v", err)
	}
	if !active(t, ctx, pool, tenantID, "") {
		t.Error("a campaign-scoped hold must still hold un-attributable tenant evidence")
	}
}

func TestATenantWideHoldCoversEveryCampaign(t *testing.T) {
	ctx := context.Background()
	pool := holdDBPool(t, ctx)
	seed := holdSeedPool(t, ctx)
	tenantID, _ := seedHoldTenant(t, ctx, seed)

	if _, err := Place(ctx, pool, PlaceInput{
		TenantID: tenantID, Reason: "regulator request",
	}); err != nil {
		t.Fatalf("place tenant-wide hold: %v", err)
	}

	if !active(t, ctx, pool, tenantID, uuid.NewString()) {
		t.Error("a tenant-wide hold must cover a campaign it never named")
	}
}

func TestReleasingAHoldMakesEvidenceSweepableAgain(t *testing.T) {
	ctx := context.Background()
	pool := holdDBPool(t, ctx)
	seed := holdSeedPool(t, ctx)
	tenantID, campaignID := seedHoldTenant(t, ctx, seed)

	hold, err := Place(ctx, pool, PlaceInput{
		TenantID: tenantID, CampaignID: campaignID, Reason: "litigation hold ACME-1",
	})
	if err != nil {
		t.Fatalf("place hold: %v", err)
	}
	if err := Release(ctx, pool, ReleaseInput{
		TenantID: tenantID, HoldID: hold.ID, Reason: "matter closed",
	}); err != nil {
		t.Fatalf("release hold: %v", err)
	}

	if active(t, ctx, pool, tenantID, campaignID) {
		t.Error("a released hold must not keep suspending the sweep")
	}
}

// A released hold stays on the record. Deleting it would destroy the evidence
// that evidence was preserved, which is the question a hold exists to answer.
func TestAReleasedHoldRemainsOnTheRecord(t *testing.T) {
	ctx := context.Background()
	pool := holdDBPool(t, ctx)
	seed := holdSeedPool(t, ctx)
	tenantID, campaignID := seedHoldTenant(t, ctx, seed)

	hold, err := Place(ctx, pool, PlaceInput{
		TenantID: tenantID, CampaignID: campaignID, Reason: "litigation hold ACME-1",
	})
	if err != nil {
		t.Fatalf("place hold: %v", err)
	}
	if err := Release(ctx, pool, ReleaseInput{
		TenantID: tenantID, HoldID: hold.ID, Reason: "matter closed",
	}); err != nil {
		t.Fatalf("release hold: %v", err)
	}

	var released bool
	var reason string
	if err := seed.QueryRow(ctx, `
SELECT released_at IS NOT NULL, COALESCE(release_reason, '')
  FROM campaign_assurance_legal_holds WHERE id = $1::uuid`, hold.ID).Scan(&released, &reason); err != nil {
		t.Fatalf("read released hold: %v", err)
	}
	if !released {
		t.Error("the released hold row must survive with its release recorded")
	}
	if reason != "matter closed" {
		t.Errorf("release_reason = %q, want %q", reason, "matter closed")
	}
}

// One active hold per scope. Two would make release ambiguous — releasing the
// one you can see would leave evidence held by one you cannot.
func TestASecondActiveHoldOnTheSameScopeIsRejected(t *testing.T) {
	ctx := context.Background()
	pool := holdDBPool(t, ctx)
	seed := holdSeedPool(t, ctx)
	tenantID, campaignID := seedHoldTenant(t, ctx, seed)

	if _, err := Place(ctx, pool, PlaceInput{
		TenantID: tenantID, CampaignID: campaignID, Reason: "first",
	}); err != nil {
		t.Fatalf("place first hold: %v", err)
	}
	if _, err := Place(ctx, pool, PlaceInput{
		TenantID: tenantID, CampaignID: campaignID, Reason: "second",
	}); err == nil {
		t.Error("a duplicate active hold on the same scope must be rejected")
	}
}

// A hold without a stated reason is not auditable, and the whole point of the
// row is that someone can later answer why the evidence was kept.
func TestAHoldRequiresAReason(t *testing.T) {
	ctx := context.Background()
	pool := holdDBPool(t, ctx)
	seed := holdSeedPool(t, ctx)
	tenantID, campaignID := seedHoldTenant(t, ctx, seed)

	if _, err := Place(ctx, pool, PlaceInput{
		TenantID: tenantID, CampaignID: campaignID, Reason: "   ",
	}); err == nil {
		t.Error("a blank reason must be rejected")
	}
}

// THE FAILURE THIS GUARDS
//
// Every retention sweep runs under db.WithWorkerScope, which sets
// app.outbox_worker and NOT app.tenant_id. The predicate is SECURITY INVOKER,
// so with only a tenant-scoped SELECT policy the worker sees zero holds,
// campaign_assurance_legal_hold_active returns false for everything, and the
// sweep deletes evidence that is under hold.
//
// That is a fail-OPEN default: the hold looks placed, the ledger looks right,
// and the evidence is gone anyway. The worker has to be able to read holds.
func TestTheSweepWorkerCanSeeHolds(t *testing.T) {
	ctx := context.Background()
	pool := holdDBPool(t, ctx)
	seed := holdSeedPool(t, ctx)
	tenantID, campaignID := seedHoldTenant(t, ctx, seed)

	if _, err := Place(ctx, pool, PlaceInput{
		TenantID: tenantID, CampaignID: campaignID, Reason: "litigation hold ACME-1",
	}); err != nil {
		t.Fatalf("place hold: %v", err)
	}

	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("worker scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var held bool
	if err := tx.QueryRow(ctx,
		`SELECT campaign_assurance_legal_hold_active($1::uuid, $2::uuid)`,
		tenantID, campaignID).Scan(&held); err != nil {
		t.Fatalf("evaluate hold under worker scope: %v", err)
	}
	if !held {
		t.Fatal("a retention worker must see the hold; not seeing it deletes held evidence")
	}

	// And the un-attributable form the image sweeps must use.
	var anyHeld bool
	if err := tx.QueryRow(ctx,
		`SELECT campaign_assurance_legal_hold_active($1::uuid, NULL)`,
		tenantID).Scan(&anyHeld); err != nil {
		t.Fatalf("evaluate tenant-wide hold under worker scope: %v", err)
	}
	if !anyHeld {
		t.Error("a retention worker must see that the tenant has any hold at all")
	}
}

// The operator surface has to show BOTH active and released holds. Showing only
// active ones would answer "what is held now" but not "was this evidence ever
// preserved", which is the question an audit actually asks.
func TestListReturnsActiveAndReleasedHoldsNewestFirst(t *testing.T) {
	ctx := context.Background()
	pool := holdDBPool(t, ctx)
	seed := holdSeedPool(t, ctx)
	tenantID, campaignID := seedHoldTenant(t, ctx, seed)

	released, err := Place(ctx, pool, PlaceInput{
		TenantID: tenantID, CampaignID: campaignID, Reason: "first matter",
	})
	if err != nil {
		t.Fatalf("place campaign hold: %v", err)
	}
	if err := Release(ctx, pool, ReleaseInput{
		TenantID: tenantID, HoldID: released.ID, Reason: "matter closed",
	}); err != nil {
		t.Fatalf("release: %v", err)
	}
	active, err := Place(ctx, pool, PlaceInput{
		TenantID: tenantID, Reason: "regulator request",
	})
	if err != nil {
		t.Fatalf("place tenant hold: %v", err)
	}

	holds, err := List(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(holds) != 2 {
		t.Fatalf("holds = %d, want 2 (the released one must still be listed)", len(holds))
	}
	if holds[0].ID != active.ID {
		t.Errorf("newest hold must come first, got %q", holds[0].ID)
	}
	if holds[0].CampaignID != "" {
		t.Errorf("the tenant-wide hold must report an empty campaign, got %q", holds[0].CampaignID)
	}
	if holds[1].ID != released.ID || holds[1].CampaignID != campaignID {
		t.Errorf("the released campaign hold is missing or mis-scoped: %+v", holds[1])
	}
}

// One tenant must never see another's holds — the reason text names matters and
// counterparties.
func TestListIsTenantScoped(t *testing.T) {
	ctx := context.Background()
	pool := holdDBPool(t, ctx)
	seed := holdSeedPool(t, ctx)
	mine, _ := seedHoldTenant(t, ctx, seed)
	theirs, theirCampaign := seedHoldTenant(t, ctx, seed)

	if _, err := Place(ctx, pool, PlaceInput{
		TenantID: theirs, CampaignID: theirCampaign, Reason: "their matter",
	}); err != nil {
		t.Fatalf("place other tenant hold: %v", err)
	}

	holds, err := List(ctx, pool, mine)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(holds) != 0 {
		t.Errorf("another tenant's holds are visible: %+v", holds)
	}
}
