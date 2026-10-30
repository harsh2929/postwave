// SPDX-License-Identifier: AGPL-3.0-only

package actionticket

import (
	"context"
	"crypto/sha256"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A ticket authorises ONE action on ONE resource, ONCE, briefly.
//
// Every test here is about one of those four words, because a ticket that fails
// any of them is a credential in an inbox rather than a convenience.

func ticketPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping action ticket test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedTicketTenant(t *testing.T, pool *db.Pool) (tenantID, userID string) {
	t.Helper()
	ctx := context.Background()
	tenantID, userID = uuid.NewString(), uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'tkt', 'studio')`,
		tenantID, "tkt-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		_, _ = c.Exec(bg, `DELETE FROM action_tickets WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = c.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
	return tenantID, userID
}

func TestATicketRedeemsOnceAndThenNeverAgain(t *testing.T) {
	pool := ticketPool(t)
	ctx := context.Background()
	tenantID, userID := seedTicketTenant(t, pool)
	repo := &Repo{Pool: pool}

	ticket, err := repo.Mint(ctx, tenantID, userID, "approval.approve", "approval", "a-1", 0)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	if ticket.Secret == "" {
		t.Fatal("no secret returned; the link would authorise nothing")
	}

	got, err := repo.Redeem(ctx, ticket.Secret, "approval.approve", "approval", "a-1", "203.0.113.7")
	if err != nil {
		t.Fatalf("first redeem: %v", err)
	}
	if got.TenantID != tenantID || got.UserID != userID {
		t.Fatalf("redeemed as %+v, want tenant %s user %s", got, tenantID, userID)
	}

	// The second click on the same emailed button.
	if _, err := repo.Redeem(ctx, ticket.Secret, "approval.approve", "approval", "a-1", ""); err == nil {
		t.Fatal("a spent ticket redeemed a second time. An approval link in an " +
			"inbox would approve every time somebody opened the thread.")
	}
}

// The resource is on the ticket for a reason: a ticket minted to approve one
// thing must not act on another.
func TestATicketDoesNotRedeemAgainstADifferentActionOrResource(t *testing.T) {
	pool := ticketPool(t)
	ctx := context.Background()
	tenantID, userID := seedTicketTenant(t, pool)
	repo := &Repo{Pool: pool}

	ticket, err := repo.Mint(ctx, tenantID, userID, "approval.approve", "approval", "a-1", 0)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	for _, tc := range []struct {
		name                   string
		action, resKind, resID string
	}{
		{"a different action", "approval.reject", "approval", "a-1"},
		{"a different resource id", "approval.approve", "approval", "a-2"},
		{"a different resource kind", "approval.approve", "campaign", "a-1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := repo.Redeem(ctx, ticket.Secret, tc.action, tc.resKind, tc.resID, ""); err == nil {
				t.Fatalf("the ticket redeemed against %s/%s/%s; a link to approve one "+
					"thing would act on another", tc.action, tc.resKind, tc.resID)
			}
		})
	}
	// And it is still unspent, so a failed attempt has not burned it.
	if _, err := repo.Redeem(ctx, ticket.Secret, "approval.approve", "approval", "a-1", ""); err != nil {
		t.Fatalf("the ticket was consumed by a MISMATCHED attempt: %v. Somebody "+
			"could burn a person's approval link by guessing wrong ids.", err)
	}
}

func TestAnExpiredTicketDoesNotRedeem(t *testing.T) {
	pool := ticketPool(t)
	ctx := context.Background()
	tenantID, userID := seedTicketTenant(t, pool)
	repo := &Repo{Pool: pool}

	ticket, err := repo.Mint(ctx, tenantID, userID, "approval.approve", "approval", "a-1", 0)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	// Age it past its expiry.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE action_tickets SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1::uuid`,
		tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("age ticket: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Redeem(ctx, ticket.Secret, "approval.approve", "approval", "a-1", ""); err == nil {
		t.Fatal("an expired ticket redeemed; the link is a standing credential")
	}
}

// The secret must not be recoverable from the database.
func TestOnlyAHashIsStored(t *testing.T) {
	pool := ticketPool(t)
	ctx := context.Background()
	tenantID, userID := seedTicketTenant(t, pool)
	repo := &Repo{Pool: pool}

	ticket, err := repo.Mint(ctx, tenantID, userID, "approval.approve", "approval", "a-1", 0)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var stored []byte
	if err := tx.QueryRow(ctx,
		`SELECT secret_hash FROM action_tickets WHERE tenant_id = $1::uuid`, tenantID).Scan(&stored); err != nil {
		t.Fatalf("read hash: %v", err)
	}
	want := sha256.Sum256([]byte(ticket.Secret))
	if string(stored) != string(want[:]) {
		t.Fatal("the stored value is not the secret's SHA-256")
	}
	if string(stored) == ticket.Secret {
		t.Fatal("the secret itself is in the database; a disclosure hands over " +
			"usable tickets")
	}
}

// Two clicks race. Exactly one may win.
func TestConcurrentRedemptionsProduceExactlyOneWinner(t *testing.T) {
	pool := ticketPool(t)
	ctx := context.Background()
	tenantID, userID := seedTicketTenant(t, pool)
	repo := &Repo{Pool: pool}

	ticket, err := repo.Mint(ctx, tenantID, userID, "approval.approve", "approval", "a-1", 0)
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	const racers = 8
	var wg sync.WaitGroup
	results := make([]error, racers)
	wg.Add(racers)
	for i := 0; i < racers; i++ {
		go func(i int) {
			defer wg.Done()
			_, results[i] = repo.Redeem(ctx, ticket.Secret, "approval.approve", "approval", "a-1", "")
		}(i)
	}
	wg.Wait()

	winners := 0
	for _, err := range results {
		if err == nil {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("%d of %d concurrent redemptions succeeded; single use is a "+
			"read-then-write and an approval can be taken twice", winners, racers)
	}
}

// A ticket may only name an action the catalog knows. Otherwise minting could
// manufacture an affordance no surface renders and no reviewer has seen.
func TestATicketCannotBeMintedForAnUnknownAction(t *testing.T) {
	pool := ticketPool(t)
	ctx := context.Background()
	tenantID, userID := seedTicketTenant(t, pool)
	repo := &Repo{Pool: pool}

	if _, err := repo.Mint(ctx, tenantID, userID, "billing.wire_transfer", "invoice", "i-1", 0); err == nil {
		t.Fatal("minted a ticket for an action the catalog does not define")
	}
	if !KnownAction("approval.approve") {
		t.Fatal("a real catalog action was rejected; minting is broken for everything")
	}
	if KnownAction("") || KnownAction("nope") {
		t.Error("KnownAction accepts an action the catalog does not define")
	}
}

// The sweep clears unused expired tickets and KEEPS spent ones — those are the
// audit record of who acted.
func TestTheSweepKeepsRedeemedTicketsAndClearsAbandonedOnes(t *testing.T) {
	pool := ticketPool(t)
	ctx := context.Background()
	tenantID, userID := seedTicketTenant(t, pool)
	repo := &Repo{Pool: pool}

	used, err := repo.Mint(ctx, tenantID, userID, "approval.approve", "approval", "used-1", 0)
	if err != nil {
		t.Fatalf("mint used: %v", err)
	}
	if _, err := repo.Redeem(ctx, used.Secret, "approval.approve", "approval", "used-1", ""); err != nil {
		t.Fatalf("redeem: %v", err)
	}
	if _, err := repo.Mint(ctx, tenantID, userID, "approval.reject", "approval", "abandoned-1", 0); err != nil {
		t.Fatalf("mint abandoned: %v", err)
	}
	// Age both well past expiry.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE action_tickets SET expires_at = now() - interval '30 days' WHERE tenant_id = $1::uuid`,
		tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	if _, err := repo.SweepExpired(ctx, time.Hour); err != nil {
		t.Fatalf("SweepExpired: %v", err)
	}

	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = read.Rollback(ctx) }()
	var remaining int
	var usedRemaining int
	if err := read.QueryRow(ctx, `
SELECT count(*), count(*) FILTER (WHERE used_at IS NOT NULL)
  FROM action_tickets WHERE tenant_id = $1::uuid`, tenantID).Scan(&remaining, &usedRemaining); err != nil {
		t.Fatalf("count: %v", err)
	}
	if usedRemaining != 1 {
		t.Fatal("the sweep deleted a REDEEMED ticket. That row is the record of " +
			"who approved something and from where, and it is wanted exactly when " +
			"somebody asks.")
	}
	if remaining != 1 {
		t.Fatalf("%d tickets remain, want only the redeemed one; abandoned links "+
			"accumulate forever", remaining)
	}
}
