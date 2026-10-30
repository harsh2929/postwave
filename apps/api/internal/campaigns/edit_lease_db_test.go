// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// One writer at a time.
//
// The approval fingerprint detects that what is about to send is not what was
// approved; If-Match detects a collision at write time. Both fire after two
// people have already done the work and one is about to lose it. A lease stops
// the second person starting.

func TestViewerLeaseProjectionRedactsAuthorizationIDsAndEmailLabels(t *testing.T) {
	lease := &EditLease{
		CampaignID:  "campaign-sensitive-id",
		HolderID:    "opaque-holder-authorization-id",
		HolderLabel: "ada.private@example.test",
		AcquiredAt:  time.Unix(10, 0).UTC(),
		ExpiresAt:   time.Unix(20, 0).UTC(),
	}
	raw, err := json.Marshal(viewerEditLease(lease))
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{
		lease.CampaignID, lease.HolderID, lease.HolderLabel, "holder_id", "campaign_id",
	} {
		if strings.Contains(string(raw), private) {
			t.Fatalf("viewer lease projection leaked %q: %s", private, raw)
		}
	}
	if !strings.Contains(string(raw), `"holder_label":"another editor"`) {
		t.Fatalf("viewer lease projection lost its privacy-safe coordination label: %s", raw)
	}
}

func TestViewerLeaseProjectionPreservesNonEmailServiceLabel(t *testing.T) {
	view := viewerEditLease(&EditLease{HolderLabel: "Campaign migration bot"})
	if view.HolderLabel != "Campaign migration bot" {
		t.Fatalf("holder label=%q, want the non-email service label", view.HolderLabel)
	}
}

func TestLeaseConflictProjectionAndMessageRedactEmailLabels(t *testing.T) {
	lease := EditLease{
		HolderID:    "opaque-holder-authorization-id",
		HolderLabel: "ada.private@example.test",
		AcquiredAt:  time.Unix(10, 0).UTC(),
		ExpiresAt:   time.Unix(20, 0).UTC(),
	}
	payload := map[string]any{
		"message": (&ErrEditLeaseHeld{Holder: lease}).Error(),
		"holder":  editLeaseConflictHolder(lease),
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{lease.HolderID, lease.HolderLabel, "holder_id"} {
		if strings.Contains(string(raw), private) {
			t.Fatalf("conflict projection leaked %q: %s", private, raw)
		}
	}
	if !strings.Contains(string(raw), "another editor") {
		t.Fatalf("conflict projection lost its privacy-safe coordination label: %s", raw)
	}
}

func leaseFixture(t *testing.T) (*Repo, string, string) {
	t.Helper()
	pool := dbForIntegration(t)
	tenantID := seedFingerprintTenant(t, pool)
	segID := seedSegment(t, pool, tenantID, `{"op":"and","rules":[]}`)
	campaignID := seedFingerprintCampaign(t, pool, tenantID, segID)
	return &Repo{Pool: pool}, tenantID, campaignID
}

func TestASecondEditorIsRefusedAndToldWho(t *testing.T) {
	repo, tenantID, campaignID := leaseFixture(t)
	ctx := context.Background()

	if _, err := repo.AcquireEditLease(ctx, tenantID, campaignID, "user-a", "Ada", 0); err != nil {
		t.Fatalf("first acquire: %v", err)
	}

	_, err := repo.AcquireEditLease(ctx, tenantID, campaignID, "user-b", "Grace", 0)
	var held *ErrEditLeaseHeld
	if !errors.As(err, &held) {
		t.Fatalf("second editor was allowed in: err = %v", err)
	}
	// Naming the holder is the point. "Someone else is editing this" sends the
	// person to ask around, which is the work the lease was meant to save.
	if held.Holder.HolderLabel != "Ada" {
		t.Errorf("holder label = %q, want the first editor's name", held.Holder.HolderLabel)
	}
	if !errorsContains(held.Error(), "Ada") {
		t.Errorf("the refusal message does not name the holder: %s", held.Error())
	}
}

func errorsContains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}

func TestTheHolderCanRenewItsOwnLease(t *testing.T) {
	// Acquire and renew are one call so a client polls one endpoint rather than
	// choosing between two and getting the choice wrong.
	repo, tenantID, campaignID := leaseFixture(t)
	ctx := context.Background()

	first, err := repo.AcquireEditLease(ctx, tenantID, campaignID, "user-a", "Ada", time.Minute)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	second, err := repo.AcquireEditLease(ctx, tenantID, campaignID, "user-a", "Ada", 2*time.Minute)
	if err != nil {
		t.Fatalf("renew: %v", err)
	}
	if !second.ExpiresAt.After(first.ExpiresAt) {
		t.Error("renewing did not extend the lease")
	}
	// "Editing since" must stay truthful across a renewal.
	if !second.AcquiredAt.Equal(first.AcquiredAt) {
		t.Errorf("acquired_at moved on renewal (%s → %s); the holder appears to "+
			"have just started every time they type",
			first.AcquiredAt, second.AcquiredAt)
	}
}

func TestAnExpiredLeaseIsTakeableByAnyone(t *testing.T) {
	// A held lease with no expiry is a campaign nobody can edit after someone
	// closes their laptop, and the only cure is an administrator.
	repo, tenantID, campaignID := leaseFixture(t)
	ctx := context.Background()

	if _, err := repo.AcquireEditLease(ctx, tenantID, campaignID, "user-a", "Ada", time.Millisecond); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	time.Sleep(20 * time.Millisecond)

	got, err := repo.AcquireEditLease(ctx, tenantID, campaignID, "user-b", "Grace", 0)
	if err != nil {
		t.Fatalf("an expired lease still blocked a new editor: %v", err)
	}
	if got.HolderID != "user-b" {
		t.Errorf("holder = %q, want the new editor", got.HolderID)
	}
}

func TestReleasingIsScopedToTheHolder(t *testing.T) {
	// If anyone could release, the way to bypass the lease would be to release
	// it first — which makes the whole mechanism advisory in the wrong
	// direction.
	repo, tenantID, campaignID := leaseFixture(t)
	ctx := context.Background()

	if _, err := repo.AcquireEditLease(ctx, tenantID, campaignID, "user-a", "Ada", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if err := repo.ReleaseEditLease(ctx, tenantID, campaignID, "user-b"); err != nil {
		t.Fatalf("release by a non-holder errored unexpectedly: %v", err)
	}
	if err := repo.AssertEditableBy(ctx, tenantID, campaignID, "user-b"); err == nil {
		t.Error("a non-holder released someone else's lease and then took it")
	}

	if err := repo.ReleaseEditLease(ctx, tenantID, campaignID, "user-a"); err != nil {
		t.Fatalf("holder release: %v", err)
	}
	if err := repo.AssertEditableBy(ctx, tenantID, campaignID, "user-b"); err != nil {
		t.Errorf("the campaign stayed locked after its holder released it: %v", err)
	}
}

func TestAnUnheldCampaignStaysEditable(t *testing.T) {
	// Backwards compatibility, and the reason this can ship without a client:
	// a caller that knows nothing about leases behaves exactly as before, and
	// only a genuine concurrent editor is stopped.
	repo, tenantID, campaignID := leaseFixture(t)
	if err := repo.AssertEditableBy(context.Background(), tenantID, campaignID, "anyone"); err != nil {
		t.Errorf("an unheld campaign refused an edit: %v", err)
	}
}

func TestAnAnonymousHolderIsRefused(t *testing.T) {
	// An empty holder cannot be told apart from any other empty holder, so the
	// lease would read as simultaneously held and renewable by everyone —
	// worse than having none.
	repo, tenantID, campaignID := leaseFixture(t)
	if _, err := repo.AcquireEditLease(context.Background(), tenantID, campaignID, "", "", 0); err == nil {
		t.Error("an anonymous holder acquired a lease")
	}
}

// The routes must actually take and enforce the lease.
//
// A tested mechanism nobody invokes protects nothing — the "described in the
// past tense" failure this ledger keeps catching, and one this session already
// committed twice with migration 1875's unpopulated and unfillable columns.

func leaseRequest(t *testing.T, method, campaignID, tenantID, userID, email string) (*httptest.ResponseRecorder, *http.Request) {
	t.Helper()
	req := httptest.NewRequest(method, "/api/v1/campaigns/"+campaignID+"/edit-lease", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", campaignID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID, Slug: "acme"})
	if userID != "" {
		ctx = middleware.WithUser(ctx, &middleware.User{ID: userID, Email: email})
	}
	return httptest.NewRecorder(), req.WithContext(ctx)
}

func TestTheRouteTakesAndRefusesTheLease(t *testing.T) {
	repo, tenantID, campaignID := leaseFixture(t)
	deps := &Deps{Repo: repo, Logger: slog.Default()}

	recA, reqA := leaseRequest(t, http.MethodPost, campaignID, tenantID, "user-a", "ada@example.test")
	deps.AcquireEditLeaseHandler(recA, reqA)
	if recA.Code != http.StatusOK {
		t.Fatalf("first acquire status = %d, want 200: %s", recA.Code, recA.Body.String())
	}
	for _, private := range []string{campaignID, "user-a", "ada@example.test", "holder_id"} {
		if strings.Contains(recA.Body.String(), private) {
			t.Fatalf("successful acquire leaked %q: %s", private, recA.Body.String())
		}
	}

	recB, reqB := leaseRequest(t, http.MethodPost, campaignID, tenantID, "user-b", "grace@example.test")
	deps.AcquireEditLeaseHandler(recB, reqB)
	// 409, not 403: the second editor IS allowed to edit this campaign, just not
	// while someone else is. A 403 sends them to an administrator about a
	// permission they already have.
	if recB.Code != http.StatusConflict {
		t.Fatalf("second acquire status = %d, want 409: %s", recB.Code, recB.Body.String())
	}
	if strings.Contains(recB.Body.String(), "ada@example.test") ||
		strings.Contains(recB.Body.String(), "user-a") {
		t.Errorf("the refusal leaked the holder's durable identity: %s", recB.Body.String())
	}
	if !strings.Contains(recB.Body.String(), "another editor") {
		t.Errorf("the refusal lost its privacy-safe holder label: %s", recB.Body.String())
	}
}

func TestEditLeaseRoutesRejectMalformedCampaignIDsBeforeRepositoryAccess(t *testing.T) {
	deps := &Deps{}
	tests := []struct {
		name   string
		method string
		handle func(http.ResponseWriter, *http.Request)
	}{
		{name: "get", method: http.MethodGet, handle: deps.GetEditLeaseHandler},
		{name: "acquire", method: http.MethodPost, handle: deps.AcquireEditLeaseHandler},
		{name: "release", method: http.MethodDelete, handle: deps.ReleaseEditLeaseHandler},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder, req := leaseRequest(t, test.method, "not-a-uuid",
				"11111111-1111-4111-8111-111111111111",
				"22222222-2222-4222-8222-222222222222", "editor@example.test")
			test.handle(recorder, req)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s, want 400", recorder.Code, recorder.Body.String())
			}
			if !strings.Contains(recorder.Body.String(), "invalid_campaign_id") {
				t.Fatalf("body=%s, want invalid_campaign_id", recorder.Body.String())
			}
		})
	}
}

func TestUpdateIsRefusedWhileAnotherEditorHoldsTheLease(t *testing.T) {
	// The enforcement, not just the endpoint. Without this the routes are
	// decoration: a client could take a lease and every other client would
	// carry on writing straight past it.
	repo, tenantID, campaignID := leaseFixture(t)
	deps := &Deps{Repo: repo, Logger: slog.Default()}

	if _, err := repo.AcquireEditLease(context.Background(), tenantID, campaignID,
		"user-a", "ada@example.test", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/campaigns/"+campaignID,
		strings.NewReader(`{"subject":"Rewritten by someone else"}`))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", campaignID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID, Slug: "acme"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: "user-b", Email: "grace@example.test"})
	deps.Update(rec, req.WithContext(ctx))

	if rec.Code != http.StatusConflict {
		t.Fatalf("update status = %d, want 409 while another editor holds the "+
			"lease: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "edit_lease_held") {
		t.Errorf("the refusal does not carry the lease code: %s", rec.Body.String())
	}
}

func TestTheHolderCanStillUpdate(t *testing.T) {
	// The mirror failure, and the one that would make the feature unusable:
	// locking the holder out of their own campaign.
	repo, tenantID, campaignID := leaseFixture(t)
	deps := &Deps{Repo: repo, Logger: slog.Default()}

	if _, err := repo.AcquireEditLease(context.Background(), tenantID, campaignID,
		"user-a", "ada@example.test", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/campaigns/"+campaignID,
		strings.NewReader(`{"subject":"Mine to edit"}`))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", campaignID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID, Slug: "acme"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: "user-a", Email: "ada@example.test"})
	deps.Update(rec, req.WithContext(ctx))

	if rec.Code == http.StatusConflict {
		t.Fatalf("the lease holder was locked out of their own campaign: %s", rec.Body.String())
	}
}

func TestAnUnheldCampaignUpdatesAsBefore(t *testing.T) {
	// Backwards compatibility: a client that knows nothing about leases must
	// behave exactly as it did.
	repo, tenantID, campaignID := leaseFixture(t)
	deps := &Deps{Repo: repo, Logger: slog.Default()}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/campaigns/"+campaignID,
		strings.NewReader(`{"subject":"No lease anywhere"}`))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", campaignID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID, Slug: "acme"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: "anyone", Email: "any@example.test"})
	deps.Update(rec, req.WithContext(ctx))

	if rec.Code == http.StatusConflict {
		t.Fatalf("an unheld campaign refused an edit: %s", rec.Body.String())
	}
}

// An EXPIRED lease must not keep refusing writes.
//
// `TestAnExpiredLeaseIsTakeableByAnyone` exercises the acquire path's upsert
// WHERE clause and never touches the read path — a review deleted
// `expires_at > now()` from `readEditLeaseTx` and the whole package stayed
// green. The bug that models is the worst one this feature could have: a
// campaign that refuses every edit forever while `AcquireEditLease` would hand
// the lease to anyone who asked.
func TestAssertEditableByIgnoresAnExpiredLease(t *testing.T) {
	repo, tenantID, campaignID := leaseFixture(t)
	ctx := context.Background()

	if _, err := repo.AcquireEditLease(ctx, tenantID, campaignID, "user-a", "Ada", time.Millisecond); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	time.Sleep(20 * time.Millisecond)

	if err := repo.AssertEditableBy(ctx, tenantID, campaignID, "user-b"); err != nil {
		t.Fatalf("an expired lease still refused an edit: %v — the campaign is "+
			"locked for everyone while the acquire path would give the lease away "+
			"to the first caller", err)
	}
	if holder, err := repo.EditLeaseHolder(ctx, tenantID, campaignID); err != nil || holder != nil {
		t.Errorf("EditLeaseHolder reported %v (err %v) for an expired lease; a "+
			"list view would show an editor who left", holder, err)
	}
}

func TestALeaseCannotBeTakenOnAnotherTenantsCampaign(t *testing.T) {
	// Foreign-key checks are NOT subject to row-level security, so before the
	// visibility check the FK was the only thing validating the id: a lease on
	// another tenant's campaign SUCCEEDED (written under your own tenant_id)
	// while a nonexistent id failed — an authenticated cross-tenant
	// campaign-existence oracle.
	repo, tenantA, campaignA := leaseFixture(t)
	_, tenantB, _ := leaseFixture(t)
	ctx := context.Background()

	_, err := repo.AcquireEditLease(ctx, tenantB, campaignA, "user-b", "Grace", 0)
	if !errors.Is(err, ErrCampaignNotFound) {
		t.Fatalf("tenant B took a lease on tenant A's campaign: err = %v", err)
	}

	// And a nonexistent campaign must give the SAME answer, or the difference
	// is the oracle.
	_, err2 := repo.AcquireEditLease(ctx, tenantB,
		"00000000-0000-0000-0000-000000000009", "user-b", "Grace", 0)
	if !errors.Is(err2, ErrCampaignNotFound) {
		t.Errorf("a nonexistent campaign gave a different error (%v) from a "+
			"cross-tenant one; the difference tells an attacker which ids exist", err2)
	}
	_ = tenantA
}

// The guard must reach past PATCH.
//
// An adversarial review counted ~30 campaign write paths and found exactly ONE
// guarded. The variants route is the sharpest of the rest: `campaign_variants`
// IS the delivered A/B content — sendloop resolves each recipient's subject and
// body from it — so writing there changes what people receive just as directly
// as editing the campaign body, and it was outside the lease entirely.

func TestTheRequestLevelGuardRefusesAnotherEditor(t *testing.T) {
	repo, tenantID, campaignID := leaseFixture(t)
	deps := &Deps{Repo: repo, Logger: slog.Default()}

	if _, err := repo.AcquireEditLease(context.Background(), tenantID, campaignID,
		"user-a", "ada@example.test", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/"+campaignID+"/variants", nil)
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID, Slug: "acme"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: "user-b", Email: "grace@example.test"})

	err := deps.AssertRequestEditable(req.WithContext(ctx), tenantID, campaignID)
	if err == nil {
		t.Fatal("a second editor was allowed to write delivered variant content " +
			"while another editor held the campaign")
	}
	if !strings.Contains(err.Error(), "another editor") || strings.Contains(err.Error(), "ada@example.test") {
		t.Errorf("the refusal must coordinate without exposing the holder email: %v", err)
	}
}

func TestTheRequestLevelGuardAllowsTheHolderAndTheUnheld(t *testing.T) {
	// Both mirror failures in one: locking the holder out of their own campaign,
	// and refusing writes on a campaign nobody is editing.
	repo, tenantID, campaignID := leaseFixture(t)
	deps := &Deps{Repo: repo, Logger: slog.Default()}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/"+campaignID+"/variants", nil)
	base := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID, Slug: "acme"})

	unheld := middleware.WithUser(base, &middleware.User{ID: "anyone", Email: "any@example.test"})
	if err := deps.AssertRequestEditable(req.WithContext(unheld), tenantID, campaignID); err != nil {
		t.Fatalf("an unheld campaign refused a variant write: %v", err)
	}

	if _, err := repo.AcquireEditLease(context.Background(), tenantID, campaignID,
		"user-a", "ada@example.test", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	holder := middleware.WithUser(base, &middleware.User{ID: "user-a", Email: "ada@example.test"})
	if err := deps.AssertRequestEditable(req.WithContext(holder), tenantID, campaignID); err != nil {
		t.Fatalf("the lease holder was refused their own campaign: %v", err)
	}
}

// Rescheduling is an edit, and must respect the lease.
//
// The send time is part of what an approver signed off on, and moving it is the
// change most likely to be made by someone who never opened the editor — two
// people placing the same campaign on different days is precisely the collision
// the lease exists to stop. Driven through `scheduleCampaign` itself: the first
// version of this wiring was disabled by a mutation and every test stayed green,
// because none of them called the handler.
func TestReschedulingIsRefusedWhileAnotherEditorHoldsTheLease(t *testing.T) {
	repo, tenantID, campaignID := leaseFixture(t)
	deps := &Deps{Repo: repo, Logger: slog.Default()}

	if _, err := repo.AcquireEditLease(context.Background(), tenantID, campaignID,
		"user-a", "ada@example.test", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/"+campaignID+"/schedule",
		strings.NewReader(`{"scheduled_at":"2026-12-01T09:00:00Z"}`))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", campaignID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID, Slug: "acme"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: "user-b", Email: "grace@example.test"})
	deps.scheduleCampaign(rec, req.WithContext(ctx))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 while another editor holds the lease: %s",
			rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "edit_lease_held") {
		t.Errorf("the refusal does not carry the lease code: %s", rec.Body.String())
	}
}

func TestTheHolderCanStillReschedule(t *testing.T) {
	// The mirror failure: locking the holder out of their own calendar.
	repo, tenantID, campaignID := leaseFixture(t)
	deps := &Deps{Repo: repo, Logger: slog.Default()}

	if _, err := repo.AcquireEditLease(context.Background(), tenantID, campaignID,
		"user-a", "ada@example.test", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/"+campaignID+"/schedule",
		strings.NewReader(`{"scheduled_at":"2026-12-01T09:00:00Z"}`))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", campaignID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID, Slug: "acme"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: "user-a", Email: "ada@example.test"})
	deps.scheduleCampaign(rec, req.WithContext(ctx))

	if rec.Code == http.StatusConflict {
		t.Fatalf("the lease holder was locked out of their own campaign's "+
			"calendar: %s", rec.Body.String())
	}
}

// The destructive and audience-changing paths are guarded too.
//
// Deleting a campaign someone else is editing is the most destructive version
// of this collision: the other editor's work does not conflict, it ceases to
// exist. Freezing REPLACES the audience and flips `audience_mode` to static,
// both of which are in the approval fingerprint.

func leaseGuardedRequest(t *testing.T, method, path, tenantID, campaignID, userID string) (*httptest.ResponseRecorder, *http.Request) {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", campaignID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID, Slug: "acme"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: userID, Email: userID + "@example.test"})
	return httptest.NewRecorder(), req.WithContext(ctx)
}

func TestDeleteIsRefusedWhileAnotherEditorHoldsTheLease(t *testing.T) {
	repo, tenantID, campaignID := leaseFixture(t)
	deps := &Deps{Repo: repo, Logger: slog.Default()}
	if _, err := repo.AcquireEditLease(context.Background(), tenantID, campaignID,
		"user-a", "ada@example.test", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}

	rec, req := leaseGuardedRequest(t, http.MethodDelete,
		"/api/v1/campaigns/"+campaignID, tenantID, campaignID, "user-b")
	deps.Delete(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: a campaign was deleted out from under "+
			"the person editing it. body=%s", rec.Code, rec.Body.String())
	}
	// And it must still be there.
	if _, err := repo.Get(context.Background(), tenantID, campaignID); err != nil {
		t.Errorf("the campaign was deleted despite the refusal: %v", err)
	}
}

func TestFreezingTheAudienceIsRefusedWhileAnotherEditorHoldsTheLease(t *testing.T) {
	repo, tenantID, campaignID := leaseFixture(t)
	deps := &Deps{Repo: repo, Logger: slog.Default()}
	if _, err := repo.AcquireEditLease(context.Background(), tenantID, campaignID,
		"user-a", "ada@example.test", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}

	rec, req := leaseGuardedRequest(t, http.MethodPost,
		"/api/v1/campaigns/"+campaignID+"/freeze-audience", tenantID, campaignID, "user-b")
	deps.freezeAudience(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: the audience was replaced under the "+
			"person editing it. body=%s", rec.Code, rec.Body.String())
	}
}

func TestTheHolderCanStillDeleteAndFreeze(t *testing.T) {
	// The mirror failure for both: locking the holder out of their own campaign.
	repo, tenantID, campaignID := leaseFixture(t)
	deps := &Deps{Repo: repo, Logger: slog.Default()}
	if _, err := repo.AcquireEditLease(context.Background(), tenantID, campaignID,
		"user-a", "ada@example.test", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}

	recF, reqF := leaseGuardedRequest(t, http.MethodPost,
		"/api/v1/campaigns/"+campaignID+"/freeze-audience", tenantID, campaignID, "user-a")
	deps.freezeAudience(recF, reqF)
	if recF.Code == http.StatusConflict {
		t.Errorf("the holder was refused their own freeze: %s", recF.Body.String())
	}

	recD, reqD := leaseGuardedRequest(t, http.MethodDelete,
		"/api/v1/campaigns/"+campaignID, tenantID, campaignID, "user-a")
	deps.Delete(recD, reqD)
	if recD.Code == http.StatusConflict {
		t.Errorf("the holder was refused their own delete: %s", recD.Body.String())
	}
}

func TestSendTimeOptimisationIsRefusedWhileAnotherEditorHoldsTheLease(t *testing.T) {
	// PSTO changes WHEN each recipient gets the campaign — part of the send an
	// approver reviewed, and an edit like any other.
	repo, tenantID, campaignID := leaseFixture(t)
	deps := &Deps{Repo: repo, Logger: slog.Default()}
	if _, err := repo.AcquireEditLease(context.Background(), tenantID, campaignID,
		"user-a", "ada@example.test", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch,
		"/api/v1/campaigns/"+campaignID+"/psto", strings.NewReader(`{"enabled":true}`))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", campaignID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID, Slug: "acme"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: "user-b", Email: "grace@example.test"})
	deps.patchPSTO(rec, req.WithContext(ctx))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", rec.Code, rec.Body.String())
	}
}

func TestPausingASendIsNOTBlockedByAnEditingLease(t *testing.T) {
	// The boundary, asserted rather than assumed. Pause/resume/cancel act on a
	// send already in flight and are the operator's emergency controls — a lease
	// is an EDITING concern, and blocking a cancel because a colleague has the
	// campaign open would be the worst possible moment to enforce it.
	repo, tenantID, campaignID := leaseFixture(t)
	deps := &Deps{Repo: repo, Logger: slog.Default()}
	if _, err := repo.AcquireEditLease(context.Background(), tenantID, campaignID,
		"user-a", "ada@example.test", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}

	rec, req := leaseGuardedRequest(t, http.MethodPost,
		"/api/v1/campaigns/"+campaignID+"/pause", tenantID, campaignID, "user-b")
	deps.PauseCampaign(rec, req)

	// Asserted on the CODE, not the status. A draft campaign cannot be paused
	// at all, so this returns 409 `invalid_transition` — the same status the
	// lease uses. Keying on the status alone made this test fail for a reason
	// that had nothing to do with what it claims to check, which is the same
	// ambiguity that makes a shared status code a poor assertion anywhere.
	if strings.Contains(rec.Body.String(), "edit_lease_held") {
		t.Fatalf("an editing lease blocked an operator pausing a send: %s",
			rec.Body.String())
	}
}
