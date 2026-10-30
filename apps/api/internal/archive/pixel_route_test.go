// SPDX-License-Identifier: AGPL-3.0-only
//
// pixel_route_test.go — verifies archive-pixel-rate-limit-bypass.
//
// The view-count pixel must be registered ONLY by MountPixelRoute, not
// by MountPublicRoutes. The whole point of the gap fix is that operators
// can attach a dedicated higher-limit limiter (600/min/IP) to the pixel
// instead of sharing the 10/min/IP human-form limiter that silently
// throttled corporate-NAT viewers after the 10th hit.
//
// If a future refactor accidentally re-mounts the pixel inside
// MountPublicRoutes, every operator that follows the documented wiring
// pattern (MountPublicRoutes inside the public 10/min group, then
// MountPixelRoute outside with its own limiter) will end up with TWO
// handlers registered for `/pixel.gif` — chi's behaviour on duplicate
// routes is "first wins", and the in-group limited copy would win,
// silently re-introducing the bug. This test fails fast on that.
package archive

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

// TestMountPublicRoutes_DoesNotMountPixel verifies that the pixel
// endpoint is NOT served when only MountPublicRoutes is wired. A
// regression here would re-introduce the rate-limit-bypass bug — the
// pixel would end up double-mounted (once under the shared 10/min/IP
// limiter inside the public group, once under the dedicated limiter
// outside) and chi's first-mount-wins semantics would route every
// pixel hit back through the throttled handler.
func TestMountPublicRoutes_DoesNotMountPixel(t *testing.T) {
	t.Parallel()
	d := &Deps{Repo: nil}
	r := chi.NewRouter()
	d.MountPublicRoutes(r)

	req := httptest.NewRequest(http.MethodGet, "/api/public/archive/acme/issue-42/pixel.gif", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("MountPublicRoutes leaked /pixel.gif: status=%d (want 404 so MountPixelRoute owns it)", rr.Code)
	}
}

// TestMountPixelRoute_MountsPixel verifies the symmetric guarantee:
// MountPixelRoute alone is sufficient to serve the pixel. We don't
// care about the response body / status code in detail (the handler
// hits the nil Repo and panics deep inside, but chi's routing
// decision happens before the handler runs); we only verify the
// route MATCHES, i.e. chi doesn't return 404 from the trie.
func TestMountPixelRoute_MountsPixel(t *testing.T) {
	t.Parallel()
	d := &Deps{Repo: nil}
	r := chi.NewRouter()
	d.MountPixelRoute(r)

	// chi exposes a Walk helper that walks the trie without invoking
	// the handler — perfect for asserting route existence without
	// standing up a Repo / database. Finding our pattern proves
	// MountPixelRoute did its job.
	const want = "/api/public/archive/{tenant_slug}/{campaign_slug}/pixel.gif"
	found := false
	walk := func(method string, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if route == want {
			found = true
		}
		return nil
	}
	if err := chi.Walk(r, walk); err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	if !found {
		t.Fatalf("MountPixelRoute did not register %q", want)
	}
}
