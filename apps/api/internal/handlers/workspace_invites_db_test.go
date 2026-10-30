// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed lifecycle tests for the SETC-010 invite surface, guarded by
// DATABASE_URL. Reuses the workspace-members test helpers (memberTestPool /
// seedMemberTenant / seedMember / newMemberRequest) since both are the same
// Settings > Team screen in the same package.
package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func decodeInviteCreate(t *testing.T, body []byte) (WorkspaceInvite, string) {
	t.Helper()
	var out struct {
		Invite WorkspaceInvite `json:"invite"`
		Token  string          `json:"token"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode create response: %v (body=%s)", err, body)
	}
	return out.Invite, out.Token
}

func TestCreateInvite_Lifecycle_DB(t *testing.T) {
	pool := memberTestPool(t)
	tenant := seedMemberTenant(t, pool)
	ownerID := seedMember(t, pool, tenant, "owner@example.test", "owner")
	h := &WorkspaceInvitesHandlers{Pool: pool}

	// Owner mints an editor invite.
	rec := httptest.NewRecorder()
	h.CreateInvite(rec, newMemberRequest(t, http.MethodPost, "/api/v1/workspace/invites",
		`{"email":"new@example.test","role":"editor"}`, tenant, ownerID, "owner"))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	invite, token := decodeInviteCreate(t, rec.Body.Bytes())
	if token == "" || invite.Email != "new@example.test" || invite.Role != "editor" {
		t.Fatalf("create response = %+v, token empty = %v", invite, token == "")
	}

	// Only SHA-256(token) is stored — never the plaintext.
	sum := sha256.Sum256([]byte(token))
	tx, err := db.WithTenant(context.Background(), pool, tenant)
	if err != nil {
		t.Fatal(err)
	}
	var storedHash []byte
	var storedPlainLike int
	if err := tx.QueryRow(context.Background(), `
SELECT token_hash, count(*) FILTER (WHERE token_hash = $2)
  FROM team_invitations WHERE id = $1::uuid GROUP BY token_hash`,
		invite.ID, []byte(token)).Scan(&storedHash, &storedPlainLike); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("read stored hash: %v", err)
	}
	_ = tx.Commit(context.Background())
	if string(storedHash) != string(sum[:]) {
		t.Fatalf("stored hash != sha256(token)")
	}
	if storedPlainLike != 0 {
		t.Fatalf("token stored in plaintext form")
	}

	// Re-inviting the same email while pending → 409 invite_pending.
	rec = httptest.NewRecorder()
	h.CreateInvite(rec, newMemberRequest(t, http.MethodPost, "/api/v1/workspace/invites",
		`{"email":"new@example.test","role":"admin"}`, tenant, ownerID, "owner"))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "invite_pending") {
		t.Fatalf("dup invite: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	// Inviting an existing member's email → 409 already_member.
	rec = httptest.NewRecorder()
	h.CreateInvite(rec, newMemberRequest(t, http.MethodPost, "/api/v1/workspace/invites",
		`{"email":"owner@example.test","role":"admin"}`, tenant, ownerID, "owner"))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "already_member") {
		t.Fatalf("member invite: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	// An admin cannot invite at the owner role → 403.
	adminID := seedMember(t, pool, tenant, "admin@example.test", "admin")
	rec = httptest.NewRecorder()
	h.CreateInvite(rec, newMemberRequest(t, http.MethodPost, "/api/v1/workspace/invites",
		`{"email":"boss@example.test","role":"owner"}`, tenant, adminID, "admin"))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "owner_role_required") {
		t.Fatalf("admin invites owner: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	// ListInvites returns the pending one and never leaks a token.
	rec = httptest.NewRecorder()
	h.ListInvites(rec, newMemberRequest(t, http.MethodGet, "/api/v1/workspace/invites", "", tenant, ownerID, "owner"))
	if rec.Code != http.StatusOK {
		t.Fatalf("list: status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "token") {
		t.Fatalf("list leaked a token field: %s", rec.Body.String())
	}
	var listed struct {
		Invites []WorkspaceInvite `json:"invites"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &listed)
	if len(listed.Invites) != 1 || listed.Invites[0].ID != invite.ID {
		t.Fatalf("list = %+v, want the one pending invite", listed.Invites)
	}

	// Revoke → list empty.
	revokeReq := withChiURLParam(newMemberRequest(t, http.MethodDelete,
		"/api/v1/workspace/invites/"+invite.ID, "", tenant, ownerID, "owner"), "id", invite.ID)
	rec = httptest.NewRecorder()
	h.RevokeInvite(rec, revokeReq)
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ListInvites(rec, newMemberRequest(t, http.MethodGet, "/api/v1/workspace/invites", "", tenant, ownerID, "owner"))
	_ = json.Unmarshal(rec.Body.Bytes(), &listed)
	if len(listed.Invites) != 0 {
		t.Fatalf("after revoke, list = %+v, want empty", listed.Invites)
	}
}

// An invite that expired without being accepted must not permanently block
// re-inviting the address (the expired row is hidden from ListInvites, so the
// admin can't revoke it). CreateInvite supersedes it.
func TestCreateInvite_ExpiredIsReissuable_DB(t *testing.T) {
	pool := memberTestPool(t)
	tenant := seedMemberTenant(t, pool)
	ownerID := seedMember(t, pool, tenant, "owner2@example.test", "owner")
	h := &WorkspaceInvitesHandlers{Pool: pool}

	// Seed an EXPIRED, unaccepted invite directly.
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("stale-token"))
	if _, err := tx.Exec(ctx, `
INSERT INTO team_invitations (tenant_id, email, role, token_hash, expires_at)
VALUES ($1::uuid, 'stale@example.test', 'editor', $2, now() - interval '1 hour')`,
		tenant, sum[:]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed expired invite: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// Re-inviting the same address now SUCCEEDS (not 409) and supersedes it.
	rec := httptest.NewRecorder()
	h.CreateInvite(rec, newMemberRequest(t, http.MethodPost, "/api/v1/workspace/invites",
		`{"email":"stale@example.test","role":"admin"}`, tenant, ownerID, "owner"))
	if rec.Code != http.StatusCreated {
		t.Fatalf("re-invite expired: status = %d, body = %s", rec.Code, rec.Body.String())
	}

	// Exactly one row remains for the email, and it is the new live one.
	tx2, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatal(err)
	}
	var rows, live int
	if err := tx2.QueryRow(ctx, `
SELECT count(*), count(*) FILTER (WHERE expires_at > now())
  FROM team_invitations WHERE tenant_id=$1::uuid AND lower(email::text)='stale@example.test'`,
		tenant).Scan(&rows, &live); err != nil {
		_ = tx2.Rollback(ctx)
		t.Fatalf("count: %v", err)
	}
	_ = tx2.Commit(ctx)
	if rows != 1 || live != 1 {
		t.Fatalf("after re-invite: rows=%d live=%d, want 1/1", rows, live)
	}
}

func TestCreateInvite_ReservesPlanSeats_DB(t *testing.T) {
	pool := memberTestPool(t)
	tenant := seedMemberTenant(t, pool)
	ownerID := seedMember(t, pool, tenant, "seat-owner@example.test", "owner")
	seedMember(t, pool, tenant, "seat-editor@example.test", "editor")
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE tenants SET tier='launch' WHERE id=$1::uuid`, tenant); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	h := &WorkspaceInvitesHandlers{Pool: pool}
	first := httptest.NewRecorder()
	h.CreateInvite(first, newMemberRequest(t, http.MethodPost, "/api/v1/workspace/invites",
		`{"email":"seat-three@example.test","role":"viewer"}`, tenant, ownerID, "owner"))
	if first.Code != http.StatusCreated {
		t.Fatalf("final available seat: status=%d body=%s", first.Code, first.Body.String())
	}

	// The live invite reserves the third Launch seat before redemption.
	over := httptest.NewRecorder()
	h.CreateInvite(over, newMemberRequest(t, http.MethodPost, "/api/v1/workspace/invites",
		`{"email":"seat-four@example.test","role":"viewer"}`, tenant, ownerID, "owner"))
	if over.Code != http.StatusPaymentRequired ||
		!strings.Contains(over.Body.String(), `"code":"plan_limit_exceeded"`) ||
		!strings.Contains(over.Body.String(), `"resource":"seats"`) ||
		!strings.Contains(over.Body.String(), `"limit":3`) {
		t.Fatalf("over-cap invitation: status=%d body=%s", over.Code, over.Body.String())
	}
}
