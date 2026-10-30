// SPDX-License-Identifier: AGPL-3.0-only
package subscribers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// TestHashSiteKey_MatchesConversionsAlgorithm — the public storefront path
// resolves the tenant from a pwk_ site key by SHA-256-hashing it and matching
// conversion_tracking_keys.key_hash. That must be byte-identical to
// conversions.HashTrackingKey or the lookup never matches. We recompute the
// hash here independently rather than importing conversions (which would
// couple the packages).
func TestHashSiteKey_MatchesConversionsAlgorithm(t *testing.T) {
	const plaintext = "pwk_deadbeefcafef00d"
	sum := sha256.Sum256([]byte(plaintext))
	want := hex.EncodeToString(sum[:])
	if got := hashSiteKey(plaintext); got != want {
		t.Fatalf("hashSiteKey(%q) = %q, want %q", plaintext, got, want)
	}
}

// TestPublicSiteKey_Precedence — the site key may arrive via the header or
// either query param. Header wins, then site_key, then key.
func TestPublicSiteKey_Precedence(t *testing.T) {
	cases := []struct {
		name   string
		header string
		query  string
		want   string
	}{
		{name: "header wins", header: "pwk_header", query: "?site_key=pwk_q", want: "pwk_header"},
		{name: "site_key param", query: "?site_key=pwk_sk", want: "pwk_sk"},
		{name: "key param fallback", query: "?key=pwk_k", want: "pwk_k"},
		{name: "site_key beats key", query: "?key=pwk_k&site_key=pwk_sk", want: "pwk_sk"},
		{name: "none", want: ""},
		{name: "trims whitespace", header: "  pwk_ws  ", want: "pwk_ws"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/api/public/subscribers/x/groups"+tc.query, nil)
			if tc.header != "" {
				r.Header.Set("X-Postwave-Site-Key", tc.header)
			}
			if got := publicSiteKey(r); got != tc.want {
				t.Fatalf("publicSiteKey = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestToStr — the group-membership jsonb sync reads name/category off
// jsonb-decoded maps; non-string and nil values coerce to "".
func TestToStr(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{in: "VIP", want: "VIP"},
		{in: nil, want: ""},
		{in: 42, want: ""},
		{in: true, want: ""},
		{in: "", want: ""},
	}
	for _, tc := range cases {
		if got := toStr(tc.in); got != tc.want {
			t.Errorf("toStr(%#v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestPublicGroupMembership_MissingSiteKey — without a site key the public
// handler must 401 before touching the repo (nil pool is safe here).
func TestPublicGroupMembership_MissingSiteKey(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/public/subscribers/person@example.com/groups", nil)
	w := httptest.NewRecorder()
	d.PublicGroupMembership(w, r)
	if w.Code != 401 {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestPublicGroupMembership_RequiresSubjectProofBeforeLookup(t *testing.T) {
	d := &Deps{}
	r := httptest.NewRequest("GET", "/api/public/subscribers/person@example.com/groups", nil)
	r.Header.Set("X-Postwave-Site-Key", "pwk_public")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("identifier", "person@example.com")
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	w := httptest.NewRecorder()
	d.PublicGroupMembership(w, r)
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "missing_subject_proof") {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control=%q", got)
	}
}

// TestGroupMemberships_NoTenant — the auth handler requires a tenant in
// context; without it, 401.
func TestGroupMemberships_NoTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/subscribers/abc/groups", nil)
	w := httptest.NewRecorder()
	d.GroupMemberships(w, r)
	if w.Code != 401 {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}
