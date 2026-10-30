// SPDX-License-Identifier: AGPL-3.0-only
package accountdeletion

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/auth"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeStore struct {
	created  CreateParams
	request  Request
	replayed bool
	err      error
	status   *Request
}

func (f *fakeStore) Create(_ context.Context, p CreateParams) (Request, bool, error) {
	f.created = p
	return f.request, f.replayed, f.err
}

func (f *fakeStore) Status(_ context.Context, tenantID, userID string) (*Request, error) {
	f.created.TenantID = tenantID
	f.created.UserID = userID
	return f.status, f.err
}

type fakeReauth struct {
	method string
	err    error
	input  ReauthInput
	userID string
}

func (f *fakeReauth) Verify(_ context.Context, _ string, _, userID string, in ReauthInput) (string, error) {
	f.input, f.userID = in, userID
	return f.method, f.err
}

func TestDeleteSelf_AllSessionRolesDeleteOnlyActingUser(t *testing.T) {
	for _, role := range []string{"viewer", "editor", "admin", "owner"} {
		t.Run(role, func(t *testing.T) {
			now := time.Date(2026, 7, 15, 8, 0, 0, 0, time.UTC)
			store := &fakeStore{request: Request{
				ID: "prv-1", Status: "queued", RequestedAt: now,
				ExecuteAfter: now.Add(time.Hour), DueAt: now.Add(30 * 24 * time.Hour),
				RetentionExpiresAt: now.Add(6 * 365 * 24 * time.Hour),
			}}
			d := &Deps{Store: store, Reauth: &fakeReauth{method: "password"}, Now: func() time.Time { return now }}
			router := chi.NewRouter()
			router.Delete("/api/v1/account", d.DeleteSelf)

			req := deleteRequest(t, role, false, `{"confirmation":"DELETE MY ACCOUNT","password":"correct"}`)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if store.created.UserID != "acting-user" || store.created.TenantID != "tenant-1" {
				t.Fatalf("request escaped acting identity: %+v", store.created)
			}
			if store.created.ReauthMethod != "password" {
				t.Fatalf("reauth method=%q", store.created.ReauthMethod)
			}
		})
	}
}

func TestDeleteSelf_LastOwnerIsExplicitConflict(t *testing.T) {
	d := &Deps{Store: &fakeStore{err: ErrLastOwner}, Reauth: &fakeReauth{method: "password"}}
	rec := httptest.NewRecorder()
	d.DeleteSelf(rec, deleteRequest(t, "owner", false, `{"confirmation":"DELETE MY ACCOUNT","password":"correct"}`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec, "last_workspace_owner")
}

func TestLastOwnerInterlockDoesNotBlockMembersOrMultiOwnerWorkspaces(t *testing.T) {
	for _, tc := range []struct {
		role        string
		otherOwners int
		blocked     bool
	}{
		{role: "owner", otherOwners: 0, blocked: true},
		{role: "owner", otherOwners: 1, blocked: false},
		{role: "admin", otherOwners: 0, blocked: false},
		{role: "editor", otherOwners: 0, blocked: false},
		{role: "viewer", otherOwners: 0, blocked: false},
	} {
		if got := isLastOwner(tc.role, tc.otherOwners); got != tc.blocked {
			t.Fatalf("isLastOwner(%q,%d)=%v want=%v", tc.role, tc.otherOwners, got, tc.blocked)
		}
	}
}

func TestDeleteSelf_RejectsAPIKeysAndMissingSessionIdentity(t *testing.T) {
	for _, tc := range []struct {
		name   string
		apiKey bool
		user   bool
	}{
		{name: "api key", apiKey: true, user: true},
		{name: "no user", user: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			d := &Deps{Store: store, Reauth: &fakeReauth{method: "password"}}
			req := httptest.NewRequest(http.MethodDelete, "/api/v1/account", bytes.NewBufferString(`{"confirmation":"DELETE MY ACCOUNT"}`))
			req.Header.Set("Content-Type", "application/json")
			ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"})
			if tc.user {
				ctx = middleware.WithUser(ctx, &middleware.User{ID: "acting-user", TenantID: "tenant-1", Role: "admin"})
			}
			if tc.apiKey {
				ctx = middleware.WithAPIKeyAuth(ctx)
			}
			req = req.WithContext(ctx)
			rec := httptest.NewRecorder()
			d.DeleteSelf(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if store.created.UserID != "" {
				t.Fatal("store called for non-session request")
			}
		})
	}
}

func TestDeleteSelf_ConfirmationAndReauthenticationAreMandatory(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		err  error
		want int
		code string
	}{
		{name: "confirmation", body: `{"confirmation":"delete"}`, want: http.StatusBadRequest, code: "confirmation_mismatch"},
		{name: "password", body: `{"confirmation":"DELETE MY ACCOUNT"}`, err: ErrReauthFailed, want: http.StatusUnauthorized, code: "reauthentication_failed"},
		{name: "fresh oauth", body: `{"confirmation":"DELETE MY ACCOUNT"}`, err: ErrFreshAuth, want: http.StatusUnauthorized, code: "fresh_authentication_required"},
		{name: "mfa", body: `{"confirmation":"DELETE MY ACCOUNT"}`, err: ErrMFARequired, want: http.StatusUnauthorized, code: "mfa_code_required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &Deps{Store: &fakeStore{}, Reauth: &fakeReauth{method: "password", err: tc.err}}
			rec := httptest.NewRecorder()
			d.DeleteSelf(rec, deleteRequest(t, "viewer", false, tc.body))
			if rec.Code != tc.want {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			assertErrorCode(t, rec, tc.code)
		})
	}
}

func TestDeleteSelf_IdempotentReplayReturnsOriginalRequest(t *testing.T) {
	now := time.Now().UTC()
	store := &fakeStore{replayed: true, request: Request{
		ID: "same-request", Status: "queued", RequestedAt: now, ExecuteAfter: now,
		DueAt: now.Add(24 * time.Hour), RetentionExpiresAt: now.Add(365 * 24 * time.Hour),
	}}
	d := &Deps{Store: store, Reauth: &fakeReauth{method: "password"}, Now: func() time.Time { return now }}
	rec := httptest.NewRecorder()
	req := deleteRequest(t, "admin", false, `{"confirmation":"DELETE MY ACCOUNT","password":"correct"}`)
	req.Header.Set("Idempotency-Key", "retry-key")
	d.DeleteSelf(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got response
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Replayed || got.Request.ID != "same-request" || len(store.created.IdempotencyDigest) != sha256Size {
		t.Fatalf("response=%+v params=%+v", got, store.created)
	}
}

func TestStatusScopesLookupToActingUser(t *testing.T) {
	request := &Request{ID: "mine", Status: "queued", RetentionExpiresAt: time.Now().Add(time.Hour)}
	store := &fakeStore{status: request}
	d := &Deps{Store: store}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/account/deletion", nil)
	req = req.WithContext(middleware.WithUser(req.Context(), &middleware.User{ID: "acting-user", TenantID: "tenant-1"}))
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: "id.verifier"})
	rec := httptest.NewRecorder()
	d.Status(rec, req)
	if rec.Code != http.StatusOK || store.created.UserID != "acting-user" {
		t.Fatalf("status=%d lookup=%+v body=%s", rec.Code, store.created, rec.Body.String())
	}
}

const sha256Size = 32

func deleteRequest(t *testing.T, role string, apiKey bool, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/account", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: "id.verifier"})
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: "acting-user", TenantID: "tenant-1", Role: role})
	if apiKey {
		ctx = middleware.WithAPIKeyAuth(ctx)
	}
	return req.WithContext(ctx)
}

func assertErrorCode(t *testing.T, rec *httptest.ResponseRecorder, want string) {
	t.Helper()
	var got struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Error.Code != want {
		t.Fatalf("error code=%q want=%q body=%s", got.Error.Code, want, rec.Body.String())
	}
}
