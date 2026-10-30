// SPDX-License-Identifier: AGPL-3.0-only
//
// route_contract_test.go — pins the routes registered by MountRoutes
// to the URLs that apps/desktop/src/lib/api-client.ts's
// `privacyPortalApi` block calls. Before the p0-privacy-portal-routes
// fix the frontend was calling `/api/v1/privacy/portal/regions` while
// the backend mounted `/api/v1/privacy/regions`, so every operator
// click on the Privacy Portal page returned 404 in production. This
// test ensures the two halves stay in lockstep: any future drift
// (handler renamed, prefix changed, route deleted) fails this test
// before the change reaches the desktop build.
//
// The list below MUST mirror every URL literal under
// `privacyPortalApi` in api-client.ts. When you add a new endpoint,
// add the (method, route-template) pair here too. Path-parameter
// segments are written with chi's `{name}` placeholder so chi.Walk
// can match them — the api-client uses encodeURIComponent(id), so
// the per-call URL is the template with the placeholder filled in.

package privacy_portal

import (
	"net/http"
	"sort"
	"testing"

	"github.com/go-chi/chi/v5"
)

// expectedRoutes is the contract: every URL in api-client.ts's
// privacyPortalApi block, in (method, route-template) form. Keep
// sorted by route for diff readability.
var expectedRoutes = []struct {
	Method string
	Route  string
	APIRef string // pointer back to api-client.ts so reviewers can verify
}{
	{http.MethodGet, "/api/v1/privacy/portal", "privacyPortalApi.get"},
	{http.MethodGet, "/api/v1/privacy/portal/double-optin/pending", "privacyPortalApi.doubleOptin.listPending"},
	{http.MethodPost, "/api/v1/privacy/portal/double-optin/{id}/cancel", "privacyPortalApi.doubleOptin.cancel"},
	{http.MethodPost, "/api/v1/privacy/portal/double-optin/{id}/resend", "privacyPortalApi.doubleOptin.resend"},
	{http.MethodGet, "/api/v1/privacy/portal/preference-center", "privacyPortalApi.getPreferenceCustomization"},
	{http.MethodPatch, "/api/v1/privacy/portal/preference-center", "privacyPortalApi.savePreferenceCustomization"},
	{http.MethodPost, "/api/v1/privacy/portal/regions", "privacyPortalApi.regions.create"},
	{http.MethodDelete, "/api/v1/privacy/portal/regions/{id}", "privacyPortalApi.regions.remove"},
}

// TestMountRoutes_MatchesFrontendContract walks the chi trie and
// asserts every (method, route-template) pair in expectedRoutes is
// registered by MountRoutes. The handlers themselves are not invoked
// — chi.Walk inspects the trie structure, which is what we care
// about: the URL has to MATCH, the handler can stub its Repo.
func TestMountRoutes_MatchesFrontendContract(t *testing.T) {
	t.Parallel()

	// Use a non-nil Repo with a nil Pool so MountRoutes proceeds past
	// its early-return guard. The handlers won't actually run during
	// this trie-walk test.
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := chi.NewRouter()
	d.MountRoutes(r)

	type routeKey struct {
		Method string
		Route  string
	}
	seen := map[routeKey]bool{}
	walk := func(method string, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		seen[routeKey{Method: method, Route: route}] = true
		return nil
	}
	if err := chi.Walk(r, walk); err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}

	var missing []string
	for _, want := range expectedRoutes {
		if !seen[routeKey{Method: want.Method, Route: want.Route}] {
			missing = append(missing, want.Method+" "+want.Route+"  (called by "+want.APIRef+")")
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		t.Fatalf("MountRoutes is missing %d frontend route(s):\n  %s",
			len(missing), joinLines(missing))
	}
}

// TestMountRoutes_NoLegacyPrefixLeaks pins the inverse contract: the
// old "/api/v1/privacy/regions" / "/api/v1/privacy/double-optin/..."
// routes — the ones the frontend was NEVER calling but the backend
// used to mount — must NOT exist. Otherwise a future regression
// could quietly re-introduce them and the contract test above would
// still pass (because the new routes also exist), but a CDN cache or
// auth-proxy with a prefix matcher could route to the wrong handler.
func TestMountRoutes_NoLegacyPrefixLeaks(t *testing.T) {
	t.Parallel()

	d := &Deps{Repo: &Repo{Pool: nil}}
	r := chi.NewRouter()
	d.MountRoutes(r)

	legacy := []string{
		"/api/v1/privacy/regions",
		"/api/v1/privacy/regions/{id}",
		"/api/v1/privacy/double-optin/pending",
		"/api/v1/preference-center/customization",
	}

	leaked := map[string]bool{}
	walk := func(_ string, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		for _, l := range legacy {
			if route == l {
				leaked[l] = true
			}
		}
		return nil
	}
	if err := chi.Walk(r, walk); err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	if len(leaked) > 0 {
		keys := make([]string, 0, len(leaked))
		for k := range leaked {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		t.Fatalf("MountRoutes leaked %d legacy route(s) the frontend never calls:\n  %s",
			len(keys), joinLines(keys))
	}
}

func joinLines(xs []string) string {
	out := ""
	for i, x := range xs {
		if i > 0 {
			out += "\n  "
		}
		out += x
	}
	return out
}
