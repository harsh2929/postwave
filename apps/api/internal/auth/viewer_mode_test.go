// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for SUB-091 View-as-Viewer admin affordance: the pure-logic
// guards on ToggleViewerMode (no-DB paths), the role-rank/down-only
// helpers, and the Me response shape with an effective-role override.
package auth

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// withSessionCookie attaches a syntactically-valid session cookie so
// currentSessionID(r) resolves a non-empty id without a DB.
func withSessionCookie(r *http.Request) *http.Request {
	tok, err := IssueSessionToken()
	if err != nil {
		panic(err)
	}
	r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: tok.String()})
	return r
}

func toggleRequest(t *testing.T, body any, user *middleware.User, withCookie bool) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(http.MethodPatch, "/api/v1/auth/me/viewer-mode", &buf)
	r.Header.Set("Content-Type", "application/json")
	if withCookie {
		r = withSessionCookie(r)
	}
	if user != nil {
		r = r.WithContext(middleware.WithUser(r.Context(), user))
	}
	return r
}

func TestToggleViewerMode_RequiresUser(t *testing.T) {
	d := &Deps{}
	w := httptest.NewRecorder()
	r := toggleRequest(t, ViewerModeInput{Enabled: true}, nil, true)
	d.ToggleViewerMode(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401; body=%s", w.Code, w.Body.String())
	}
}

func TestToggleViewerMode_ForbiddenForNonAdmin(t *testing.T) {
	for _, role := range []string{"editor", "viewer", "", "unknown"} {
		d := &Deps{}
		w := httptest.NewRecorder()
		u := &middleware.User{ID: "u1", Role: role}
		r := toggleRequest(t, ViewerModeInput{Enabled: true, Role: "viewer"}, u, true)
		d.ToggleViewerMode(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("role=%q: got %d, want 403; body=%s", role, w.Code, w.Body.String())
		}
	}
}

func TestToggleViewerMode_RequiresSessionCookie(t *testing.T) {
	d := &Deps{}
	w := httptest.NewRecorder()
	u := &middleware.User{ID: "u1", Role: "admin"}
	r := toggleRequest(t, ViewerModeInput{Enabled: true}, u, false /* no cookie */)
	d.ToggleViewerMode(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "no_session_cookie") {
		t.Fatalf("expected no_session_cookie code; body=%s", w.Body.String())
	}
}

func TestToggleViewerMode_InvalidRole(t *testing.T) {
	d := &Deps{}
	w := httptest.NewRecorder()
	u := &middleware.User{ID: "u1", Role: "owner"}
	r := toggleRequest(t, ViewerModeInput{Enabled: true, Role: "superadmin"}, u, true)
	d.ToggleViewerMode(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "invalid_role") {
		t.Fatalf("expected invalid_role; body=%s", w.Body.String())
	}
}

func TestToggleViewerMode_RefusesEscalation(t *testing.T) {
	// An admin trying to preview as owner (or as admin == same rank) must
	// be refused — the affordance is strictly down-only.
	cases := []struct{ durable, preview string }{
		{"admin", "owner"},
		{"admin", "admin"},
		{"owner", "owner"},
	}
	for _, c := range cases {
		d := &Deps{}
		w := httptest.NewRecorder()
		u := &middleware.User{ID: "u1", Role: c.durable}
		r := toggleRequest(t, ViewerModeInput{Enabled: true, Role: c.preview}, u, true)
		d.ToggleViewerMode(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("durable=%s preview=%s: got %d, want 403; body=%s",
				c.durable, c.preview, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "viewer_mode_not_downgrade") {
			t.Fatalf("durable=%s preview=%s: expected not_downgrade; body=%s",
				c.durable, c.preview, w.Body.String())
		}
	}
}

func TestRoleRank_Ordering(t *testing.T) {
	if !(roleRank("owner") < roleRank("admin") &&
		roleRank("admin") < roleRank("editor") &&
		roleRank("editor") < roleRank("viewer")) {
		t.Fatalf("role ranks not strictly ordered owner<admin<editor<viewer")
	}
	if roleRank("nonsense") <= roleRank("viewer") {
		t.Fatalf("unknown role should rank below viewer")
	}
}

func TestCanActivateViewerMode(t *testing.T) {
	for role, want := range map[string]bool{
		"owner":   true,
		"admin":   true,
		"editor":  false,
		"viewer":  false,
		"":        false,
		"unknown": false,
	} {
		if got := canActivateViewerMode(role); got != want {
			t.Fatalf("canActivateViewerMode(%q) = %v, want %v", role, got, want)
		}
	}
}

func TestIsKnownRole(t *testing.T) {
	for _, ok := range []string{"owner", "admin", "editor", "viewer"} {
		if !isKnownRole(ok) {
			t.Fatalf("isKnownRole(%q) should be true", ok)
		}
	}
	for _, bad := range []string{"", "super", "Owner", "VIEWER"} {
		if isKnownRole(bad) {
			t.Fatalf("isKnownRole(%q) should be false", bad)
		}
	}
}

// TestResolveEffectiveRole covers the SUB-091 session-resolver invariant
// fixed in middleware.go: an override is honored ONLY when it strictly
// DOWNGRADES the durable role (less privilege = greater roleRank). It must
// never widen access, and the steady state (no override) is a no-op.
func TestResolveEffectiveRole(t *testing.T) {
	cases := []struct {
		name     string
		durable  string
		override string
		want     string
	}{
		// The core regression: admin previewing as viewer DOES downgrade.
		{"admin downgrades to viewer", "admin", "viewer", "viewer"},
		{"owner downgrades to viewer", "owner", "viewer", "viewer"},
		{"admin downgrades to editor", "admin", "editor", "editor"},
		{"owner downgrades to admin", "owner", "admin", "admin"},
		// No override = durable role unchanged.
		{"no override falls back to durable", "admin", "", "admin"},
		{"no override viewer stays viewer", "viewer", "", "viewer"},
		// Escalation attempts via a stale/tampered override are IGNORED.
		{"viewer cannot escalate to admin", "viewer", "admin", "viewer"},
		{"editor cannot escalate to owner", "editor", "owner", "editor"},
		{"viewer cannot escalate to owner", "viewer", "owner", "viewer"},
		// Same-rank override is not a downgrade — ignored.
		{"same role is not a downgrade", "admin", "admin", "admin"},
	}
	for _, c := range cases {
		if got := resolveEffectiveRole(c.durable, c.override); got != c.want {
			t.Errorf("%s: resolveEffectiveRole(%q, %q) = %q, want %q",
				c.name, c.durable, c.override, got, c.want)
		}
	}
}

// TestMe_EffectiveRoleOverride verifies /me surfaces the SUB-091
// effective_role + viewer_mode flags. Repo is nil (TOTP lookup is
// guarded) so this stays DB-free.
func TestMe_EffectiveRoleOverride(t *testing.T) {
	d := &Deps{
		MeContextLookup: func(r *http.Request) (MeContext, bool) {
			return MeContext{
				TenantID:      "t1",
				UserID:        "u1",
				UserEmail:     "admin@example.com",
				UserRole:      "admin",
				EffectiveRole: "viewer", // preview active
			}, true
		},
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	d.Me(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var resp MeResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Role != "admin" {
		t.Errorf("durable Role = %q, want admin", resp.Role)
	}
	if resp.EffectiveRole != "viewer" {
		t.Errorf("EffectiveRole = %q, want viewer", resp.EffectiveRole)
	}
	if !resp.ViewerMode {
		t.Errorf("ViewerMode = false, want true")
	}
	if !resp.CanUseViewerMode {
		t.Errorf("CanUseViewerMode = false, want true for admin")
	}
}

// TestMe_NoOverride_FallsBackToDurable verifies the steady state: no
// override means effective_role == role and viewer_mode is false.
func TestMe_NoOverride_FallsBackToDurable(t *testing.T) {
	d := &Deps{
		MeContextLookup: func(r *http.Request) (MeContext, bool) {
			return MeContext{
				TenantID: "t1",
				UserID:   "u1",
				UserRole: "editor",
				// EffectiveRole intentionally empty.
			}, true
		},
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	d.Me(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var resp MeResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.EffectiveRole != "editor" {
		t.Errorf("EffectiveRole = %q, want editor (fallback)", resp.EffectiveRole)
	}
	if resp.ViewerMode {
		t.Errorf("ViewerMode = true, want false")
	}
	if resp.CanUseViewerMode {
		t.Errorf("CanUseViewerMode = true, want false for editor")
	}
}
