// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed test for SETC-010 invite acceptance, guarded by DATABASE_URL.
// Reuses cliAuthDB / cliUUID from cli_auth_test.go (same package). Exercises
// the security-critical path: cross-tenant token lookup under the resolver
// GUC, user creation in the INVITE's tenant, single-use, expiry, and the
// duplicate-member guard.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/limits"
)

func seedInvitation(t *testing.T, pool *db.Pool, tenantID, email, role string, expiresAt time.Time) string {
	t.Helper()
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		t.Fatal(err)
	}
	token := hex.EncodeToString(buf)
	sum := sha256.Sum256([]byte(token))
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO team_invitations (tenant_id, email, role, token_hash, expires_at)
VALUES ($1::uuid, $2, $3, $4, $5)`, tenantID, email, role, sum[:], expiresAt); err != nil {
		t.Fatalf("seed invitation: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit invitation: %v", err)
	}
	return token
}

func TestAcceptInvitation_DB(t *testing.T) {
	pool := cliAuthDB(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	tenantID := cliUUID(t)

	// Seed the invited tenant.
	{
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("begin tenant: %v", err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid,$2,$2,'studio')`,
			tenantID, "invite-"+tenantID[:8]); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant (role needs INSERT on tenants): %v", err)
		}
		_ = tx.Commit(ctx)
	}
	// The tenant delete cascades to the users, credentials and invitations the
	// test wrote, and a failure is reported rather than discarded.
	t.Cleanup(func() { deleteAuthTestTenant(t, pool, tenantID) })

	// Happy path — the invited user is created in the INVITE's tenant.
	token := seedInvitation(t, pool, tenantID, "invitee@example.test", "editor", time.Now().Add(time.Hour))
	gotTenant, userID, email, err := repo.AcceptInvitation(ctx, token, "phc$argon2id$fake")
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if gotTenant != tenantID || email != "invitee@example.test" || userID == "" {
		t.Fatalf("accept returned tenant=%s user=%s email=%s", gotTenant, userID, email)
	}

	// The row lands in the invited tenant with the invited role, active, and
	// no external identity; a credential row exists; the invite is consumed.
	{
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		var role, status string
		var extNull bool
		if err := tx.QueryRow(ctx, `
SELECT role, status, external_user_id IS NULL FROM users WHERE id=$1::uuid`, userID).
			Scan(&role, &status, &extNull); err != nil {
			t.Fatalf("read user: %v", err)
		}
		if role != "editor" || status != "active" || !extNull {
			t.Fatalf("user role=%s status=%s extNull=%v, want editor/active/true", role, status, extNull)
		}
		var creds int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM auth_credentials WHERE user_id=$1::uuid`, userID).Scan(&creds); err != nil {
			t.Fatalf("read creds: %v", err)
		}
		if creds != 1 {
			t.Fatalf("auth_credentials count = %d, want 1", creds)
		}
		var accepted bool
		if err := tx.QueryRow(ctx, `
SELECT accepted_at IS NOT NULL AND accepted_by_user_id = $1::uuid
  FROM team_invitations WHERE lower(email::text) = 'invitee@example.test'`, userID).Scan(&accepted); err != nil {
			t.Fatalf("read invite: %v", err)
		}
		if !accepted {
			t.Fatalf("invitation not marked accepted by the new user")
		}
		_ = tx.Commit(ctx)
	}

	// Single-use: the same token cannot be redeemed twice.
	if _, _, _, err := repo.AcceptInvitation(ctx, token, "phc$argon2id$fake"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second accept err = %v, want ErrNotFound", err)
	}

	// Expired invitations are not redeemable.
	expiredToken := seedInvitation(t, pool, tenantID, "expired@example.test", "viewer", time.Now().Add(-time.Hour))
	if _, _, _, err := repo.AcceptInvitation(ctx, expiredToken, "phc$argon2id$fake"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired accept err = %v, want ErrNotFound", err)
	}

	// Studio has one seat. A live invite created before the workspace reached
	// its cap cannot become an extra member later.
	overCapToken := seedInvitation(t, pool, tenantID, "over-cap@example.test", "viewer", time.Now().Add(time.Hour))
	if _, _, _, err := repo.AcceptInvitation(ctx, overCapToken, "phc$argon2id$fake"); err == nil {
		t.Fatal("over-cap invitation unexpectedly accepted")
	} else {
		var limitErr *limits.Error
		if !errors.As(err, &limitErr) || limitErr.Resource != limits.ResourceSeats || limitErr.Limit != 1 || limitErr.Current != 1 {
			t.Fatalf("over-cap accept err = %#v, want one-seat plan limit", err)
		}
	}

	// Already-member: accepting for an email that is already a member returns a
	// clean sentinel, never a unique-index 500.
	{
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO users (tenant_id, email, role) VALUES ($1::uuid, 'dup@example.test', 'editor')`, tenantID); err != nil {
			t.Fatalf("seed dup member: %v", err)
		}
		_ = tx.Commit(ctx)
	}
	dupToken := seedInvitation(t, pool, tenantID, "dup@example.test", "admin", time.Now().Add(time.Hour))
	if _, _, _, err := repo.AcceptInvitation(ctx, dupToken, "phc$argon2id$fake"); !errors.Is(err, ErrAlreadyMember) {
		t.Fatalf("dup-member accept err = %v, want ErrAlreadyMember", err)
	}

	// A tampered/unknown token is rejected.
	if _, _, _, err := repo.AcceptInvitation(ctx, "deadbeef-not-a-real-token", "phc$argon2id$fake"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown token err = %v, want ErrNotFound", err)
	}
}
