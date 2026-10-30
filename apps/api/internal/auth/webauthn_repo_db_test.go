// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"context"
	"testing"
	"time"
)

// WebAuthn credential store + the PRE-SESSION resolver lookup (the discoverable
// login path), sign-count update, tenant-scoped management, and isolation.
//
// Run this under the non-privileged app role to genuinely exercise RLS + column
// grants (a superuser conn bypasses both and hides missing-grant/policy bugs):
//
//	DATABASE_URL=postgres://postwave_app:local-test-password-only@localhost/postwave_verify?sslmode=disable \
//	  go test ./internal/auth -run TestWebauthnCredentialResolver
func TestWebauthnCredentialResolverAndManagement_DB(t *testing.T) {
	pool := cliAuthDB(t)
	repo := &Repo{Pool: pool, Pepper: make([]byte, 32)}
	ctx := context.Background()
	unique := cliUUID(t)

	phc, err := Hash("Sup3rSecret!passphrase", Recommended)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	tenantA, userA, err := repo.CreateTenantWithOwner(ctx, "WA A", "wa-a-"+unique[:8], "wa-a-"+unique[:8]+"@x.test", phc)
	if err != nil {
		t.Fatalf("CreateTenantWithOwner A: %v", err)
	}
	tenantB, _, err := repo.CreateTenantWithOwner(ctx, "WA B", "wa-b-"+unique[:8], "wa-b-"+unique[:8]+"@x.test", phc)
	if err != nil {
		t.Fatalf("CreateTenantWithOwner B: %v", err)
	}
	// Each tenant is deleted in a transaction bound to that tenant. The
	// tenants DELETE policy sees only the row whose id equals app.tenant_id;
	// the worker scope this cleanup used to open (db.WithWorkerScope sets
	// app.outbox_worker, not app.tenant_id) makes every row invisible, so the
	// DELETE matched nothing, reported no error, and each run left its
	// tenants in the shared database.
	t.Cleanup(func() {
		for _, tid := range []string{tenantA, tenantB} {
			deleteAuthTestTenant(t, pool, tid)
		}
	})

	rawID := []byte("cred-raw-id-" + unique)
	stored, err := repo.StoreWebauthnCredential(ctx, tenantA, WebauthnCredential{
		UserID: userA, CredentialID: rawID, PublicKey: []byte("pub-key"),
		SignCount: 0, AAGUID: []byte("aaguid"), Transports: []string{"internal", "hybrid"},
		BackupEligible: true, BackupState: true, Name: "Test Passkey",
	})
	if err != nil {
		t.Fatalf("StoreWebauthnCredential: %v", err)
	}
	if stored.Name != "Test Passkey" {
		t.Fatalf("stored name = %q", stored.Name)
	}

	// PRE-SESSION resolver read by raw credential id (the discoverable login
	// path — no tenant context yet). Must find it AND report the owning tenant.
	found, err := repo.WebauthnCredentialByRawID(ctx, rawID)
	if err != nil {
		t.Fatalf("WebauthnCredentialByRawID: %v", err)
	}
	if found.TenantID != tenantA || found.UserID != userA {
		t.Fatalf("resolver lookup gave tenant/user %s/%s, want %s/%s", found.TenantID, found.UserID, tenantA, userA)
	}
	if string(found.PublicKey) != "pub-key" {
		t.Fatalf("resolver lookup lost the public key")
	}

	// Resolver: the user's full credential set (for assertion verification).
	all, err := repo.WebauthnCredentialsForUserResolver(ctx, userA)
	if err != nil || len(all) != 1 {
		t.Fatalf("WebauthnCredentialsForUserResolver = %d creds, err %v; want 1", len(all), err)
	}

	// Resolver: user by id → tenant + email (for session issue).
	u, err := repo.UserByIDResolver(ctx, userA)
	if err != nil || u.TenantID != tenantA {
		t.Fatalf("UserByIDResolver = %+v, err %v", u, err)
	}

	// Sign-count update (post-assertion clone-detection state).
	if err := repo.UpdateWebauthnSignCount(ctx, tenantA, rawID, 7); err != nil {
		t.Fatalf("UpdateWebauthnSignCount: %v", err)
	}
	after, _ := repo.WebauthnCredentialByRawID(ctx, rawID)
	if after.SignCount != 7 || after.LastUsedAt == nil {
		t.Fatalf("after sign-count update = %d / lastused %v, want 7 / non-nil", after.SignCount, after.LastUsedAt)
	}

	// Tenant-scoped management list.
	list, err := repo.ListWebauthnCredentials(ctx, tenantA, userA)
	if err != nil || len(list) != 1 {
		t.Fatalf("ListWebauthnCredentials(A) = %d, err %v; want 1", len(list), err)
	}
	// Isolation: tenant B has none of A's passkeys.
	otherList, err := repo.ListWebauthnCredentials(ctx, tenantB, userA)
	if err != nil {
		t.Fatalf("ListWebauthnCredentials(B): %v", err)
	}
	if len(otherList) != 0 {
		t.Fatalf("tenant B saw %d of tenant A's passkeys", len(otherList))
	}

	// Rename + delete are tenant+user scoped.
	ok, err := repo.RenameWebauthnCredential(ctx, tenantA, userA, stored.ID, "Renamed Key")
	if err != nil || !ok {
		t.Fatalf("RenameWebauthnCredential = %v, err %v", ok, err)
	}
	if bad, _ := repo.RenameWebauthnCredential(ctx, tenantB, userA, stored.ID, "Hijack"); bad {
		t.Fatal("tenant B was able to rename tenant A's passkey")
	}
	deleted, err := repo.DeleteWebauthnCredential(ctx, tenantA, userA, stored.ID)
	if err != nil || !deleted {
		t.Fatalf("DeleteWebauthnCredential = %v, err %v", deleted, err)
	}
	if gone, _ := repo.WebauthnCredentialByRawID(ctx, rawID); gone != nil {
		t.Fatal("credential still resolvable after delete")
	}
}

// The single-use nonce store: a stored challenge consumes exactly once, an
// expired one never consumes, and purpose is honored (a reg nonce can't satisfy
// a login finish). Run under postwave_app to prove the grants.
func TestWebauthnChallengeSingleUse_DB(t *testing.T) {
	pool := cliAuthDB(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	now := time.Now()
	hash := []byte("nonce-hash-" + cliUUID(t))

	if err := repo.StoreWebauthnChallenge(ctx, hash, "login", now.Add(5*time.Minute)); err != nil {
		t.Fatalf("StoreWebauthnChallenge: %v", err)
	}
	t.Cleanup(func() {
		cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = pool.Exec(cctx, `DELETE FROM webauthn_challenges WHERE challenge_hash = $1`, hash)
	})

	// Wrong purpose must not consume it.
	if ok, err := repo.ConsumeWebauthnChallenge(ctx, hash, "reg", now); err != nil || ok {
		t.Fatalf("consume with wrong purpose = %v, err %v; want false", ok, err)
	}
	// First correct consume succeeds.
	if ok, err := repo.ConsumeWebauthnChallenge(ctx, hash, "login", now); err != nil || !ok {
		t.Fatalf("first consume = %v, err %v; want true", ok, err)
	}
	// Replay: the nonce is gone, so a second consume fails — this is the replay
	// defense.
	if ok, err := repo.ConsumeWebauthnChallenge(ctx, hash, "login", now); err != nil || ok {
		t.Fatalf("replay consume = %v, err %v; want false", ok, err)
	}

	// An already-expired nonce never consumes.
	expiredHash := []byte("expired-" + cliUUID(t))
	if err := repo.StoreWebauthnChallenge(ctx, expiredHash, "login", now.Add(-time.Minute)); err != nil {
		t.Fatalf("store expired: %v", err)
	}
	t.Cleanup(func() {
		cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = pool.Exec(cctx, `DELETE FROM webauthn_challenges WHERE challenge_hash = $1`, expiredHash)
	})
	if ok, err := repo.ConsumeWebauthnChallenge(ctx, expiredHash, "login", now); err != nil || ok {
		t.Fatalf("expired consume = %v, err %v; want false", ok, err)
	}
}
