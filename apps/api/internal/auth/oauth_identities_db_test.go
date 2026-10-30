// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"context"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The account-lockout guard is the whole point of SETC-021: never let a user
// remove their only way to sign in. Run under the non-privileged app role so
// the auth_idp_links tenant_visible RLS + grants are genuinely exercised:
//
//	DATABASE_URL=postgres://postwave_app:local-test-password-only@localhost/postwave_verify?sslmode=disable \
//	  go test ./internal/auth -run TestUnlinkIdPLockoutGuard
func TestUnlinkIdPLockoutGuard_DB(t *testing.T) {
	pool := cliAuthDB(t)
	repo := &Repo{Pool: pool, Pepper: make([]byte, 32)}
	ctx := context.Background()
	unique := cliUUID(t)

	phc, err := Hash("Sup3rSecret!passphrase", Recommended)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	// Owner has a password (CreateTenantWithOwner writes auth_credentials).
	tenantID, ownerID, err := repo.CreateTenantWithOwner(ctx, "Idp T", "idp-"+unique[:8], "owner-"+unique[:8]+"@x.test", phc)
	if err != nil {
		t.Fatalf("CreateTenantWithOwner: %v", err)
	}
	// Each tenant is deleted in a transaction bound to that tenant. The
	// tenants DELETE policy sees only the row whose id equals app.tenant_id;
	// the worker scope this cleanup used to open (db.WithWorkerScope sets
	// app.outbox_worker, not app.tenant_id) makes every row invisible, so the
	// DELETE matched nothing, reported no error, and each run left its
	// tenants in the shared database.
	t.Cleanup(func() { deleteAuthTestTenant(t, pool, tenantID) })

	// Seed a second, PASSWORDLESS user whose only login method is Google.
	oauthOnlyID := cliUUID(t)
	seedUser := func(id, email string, withPassword bool, providers ...string) {
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("WithTenant: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx,
			`INSERT INTO users (id, tenant_id, email, role, auth_provider) VALUES ($1::uuid,$2::uuid,$3,'admin',$4)`,
			id, tenantID, email, providers[0]); err != nil {
			t.Fatalf("seed user: %v", err)
		}
		if withPassword {
			if _, err := tx.Exec(ctx,
				`INSERT INTO auth_credentials (user_id, tenant_id, password_phc) VALUES ($1::uuid,$2::uuid,$3)`,
				id, tenantID, phc); err != nil {
				t.Fatalf("seed creds: %v", err)
			}
		}
		for _, p := range providers {
			if _, err := tx.Exec(ctx,
				`INSERT INTO auth_idp_links (user_id, provider, subject, email) VALUES ($1::uuid,$2,$3,$4)`,
				id, p, p+"-sub-"+id, email); err != nil {
				t.Fatalf("seed idp %s: %v", p, err)
			}
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit seed: %v", err)
		}
	}
	seedUser(oauthOnlyID, "google-only-"+unique[:8]+"@x.test", false, "google")

	// 1) The passwordless, Google-only user CANNOT unlink Google (lockout).
	if _, err := repo.UnlinkIdP(ctx, tenantID, oauthOnlyID, "google"); err != ErrLastLoginMethod {
		t.Fatalf("unlink last method = %v, want ErrLastLoginMethod", err)
	}
	// The link must still be there.
	if links, _ := repo.ListIdPLinks(ctx, tenantID, oauthOnlyID); len(links) != 1 {
		t.Fatalf("link count after blocked unlink = %d, want 1", len(links))
	}

	// 2) The same user, once they ALSO have Microsoft, CAN unlink Google.
	if _, err := (func() (bool, error) {
		tx, _ := db.WithTenant(ctx, pool, tenantID)
		defer func() { _ = tx.Rollback(ctx) }()
		_, e := tx.Exec(ctx, `INSERT INTO auth_idp_links (user_id, provider, subject, email) VALUES ($1::uuid,'microsoft',$2,$3)`,
			oauthOnlyID, "ms-sub-"+oauthOnlyID, "ms@x.test")
		if e != nil {
			return false, e
		}
		return true, tx.Commit(ctx)
	}()); err != nil {
		t.Fatalf("add microsoft: %v", err)
	}
	unlinked, err := repo.UnlinkIdP(ctx, tenantID, oauthOnlyID, "google")
	if err != nil || !unlinked {
		t.Fatalf("unlink google with ms present = %v, err %v; want true", unlinked, err)
	}
	if hp, _ := repo.UserHasPassword(ctx, tenantID, oauthOnlyID); hp {
		t.Fatal("oauth-only user should not have a password")
	}

	// 3) The owner (has a password) CAN unlink a Google link.
	seedLink := func(userID string) {
		tx, _ := db.WithTenant(ctx, pool, tenantID)
		defer func() { _ = tx.Rollback(ctx) }()
		_, _ = tx.Exec(ctx, `INSERT INTO auth_idp_links (user_id, provider, subject, email) VALUES ($1::uuid,'google',$2,$3)`,
			userID, "g-sub-"+userID, "o@x.test")
		_ = tx.Commit(ctx)
	}
	seedLink(ownerID)
	if hp, _ := repo.UserHasPassword(ctx, tenantID, ownerID); !hp {
		t.Fatal("owner must have a password")
	}
	unlinked, err = repo.UnlinkIdP(ctx, tenantID, ownerID, "google")
	if err != nil || !unlinked {
		t.Fatalf("owner unlink google = %v, err %v; want true", unlinked, err)
	}

	// 4) Unlinking a provider that isn't linked is a no-op (not an error).
	if unlinked, err := repo.UnlinkIdP(ctx, tenantID, ownerID, "google"); err != nil || unlinked {
		t.Fatalf("unlink absent provider = %v, err %v; want false/nil", unlinked, err)
	}

	// 5) A PASSKEY-only user (Google + a passkey, no password) CAN unlink Google
	//    — the guard must count webauthn_credentials as a standing method.
	passkeyUserID := cliUUID(t)
	seedUser(passkeyUserID, "passkey-"+unique[:8]+"@x.test", false, "google")
	func() {
		tx, _ := db.WithTenant(ctx, pool, tenantID)
		defer func() { _ = tx.Rollback(ctx) }()
		_, err := tx.Exec(ctx, `
INSERT INTO webauthn_credentials (tenant_id, user_id, credential_id, public_key, name)
VALUES ($1::uuid, $2::uuid, $3, $4, 'Test passkey')`,
			tenantID, passkeyUserID, []byte("cred-"+passkeyUserID), []byte("pk"))
		if err != nil {
			t.Fatalf("seed passkey: %v", err)
		}
		_ = tx.Commit(ctx)
	}()
	if hp, _ := repo.UserHasPasskey(ctx, tenantID, passkeyUserID); !hp {
		t.Fatal("passkey user should report a passkey")
	}
	unlinked, err = repo.UnlinkIdP(ctx, tenantID, passkeyUserID, "google")
	if err != nil || !unlinked {
		t.Fatalf("passkey-backed unlink google = %v, err %v; want true (passkey is a method)", unlinked, err)
	}
}
