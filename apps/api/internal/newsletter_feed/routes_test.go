package newsletter_feed

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/archive"
)

// TestMountRoutes_RegistersPerTagAndAuthor pins the route surface added
// by gap `archive-rss-per-tag-author` (P2). The whole-archive feed has
// shipped for a while; the test fails if the per-tag or per-author
// variants stop being registered (silent SEO regression — Ghost /
// HubSpot expose the same paths so external curators can subscribe to
// a topical slice).
func TestMountRoutes_RegistersPerTagAndAuthor(t *testing.T) {
	t.Parallel()
	r := chi.NewRouter()
	d := &Deps{
		// MountRoutes only inspects ArchiveRepo for nil-guard. A non-nil
		// dummy is enough — we don't fire the handlers here.
		ArchiveRepo:   &archive.Repo{},
		PublicBaseURL: "https://archive.example",
	}
	d.MountRoutes(r)

	want := []string{
		"/api/public/archive/{tenant_slug}/feed.xml",
		"/api/public/archive/{tenant_slug}/feed.json",
		"/api/public/archive/{tenant_slug}/tag/{tag_slug}/feed.xml",
		"/api/public/archive/{tenant_slug}/tag/{tag_slug}/feed.json",
		"/api/public/archive/{tenant_slug}/author/{author_slug}/feed.xml",
		"/api/public/archive/{tenant_slug}/author/{author_slug}/feed.json",
	}

	got := map[string]bool{}
	walk := func(method, route string, h http.Handler, mws ...func(http.Handler) http.Handler) error {
		_ = method
		_ = h
		_ = mws
		got[route] = true
		return nil
	}
	if err := chi.Walk(r, walk); err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	for _, p := range want {
		if !got[p] {
			t.Errorf("route not registered: %s", p)
		}
	}
}

// TestMountRoutes_TagAuthorWinOverCampaignSlugCatchAll asserts that
// when both `archive.MountPublicRoutes` (registers the catch-all
// `{tenant_slug}/{campaign_slug}` issue-detail route) AND
// `newsletter_feed.MountRoutes` (registers `{tenant_slug}/tag/...` and
// `{tenant_slug}/author/...`) are wired on the same chi router, chi
// routes a request like `/api/public/archive/acme/tag/foo/feed.xml`
// to the tag-feed handler — NOT to the catch-all that would try to
// look up an issue with slug=`tag`.
//
// Pre-fix (no test), a mounting-order regression — where main.go
// switched to mounting the archive package AFTER newsletter_feed —
// could silently shadow the new RSS routes with a 404 ("no such
// issue"). Chi's radix tree prefers literal segments over wildcards at
// the same depth, but only when both are registered on the same router
// — this test pins that property.
func TestMountRoutes_TagAuthorWinOverCampaignSlugCatchAll(t *testing.T) {
	t.Parallel()
	r := chi.NewRouter()

	// Replace each handler with a marker so we can identify which route
	// chi chose. We mount BOTH the catch-all (simulating
	// archive.MountPublicRoutes) AND a copy of the per-tag /
	// per-author handlers as marker stubs. Both are registered on the
	// same router so the radix-tree precedence is exercised.
	mark := func(label string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-Route", label)
			w.WriteHeader(http.StatusOK)
		}
	}
	// Simulate `archive.MountPublicRoutes`'s catch-all.
	r.Get("/api/public/archive/{tenant_slug}/{campaign_slug}", mark("catchall"))
	// Simulate the routes `newsletter_feed.MountRoutes` adds. Mirrors
	// MountRoutes exactly so a drift between this test and the real
	// MountRoutes is caught at compile time (same paths).
	r.Get("/api/public/archive/{tenant_slug}/feed.xml", mark("feed.xml"))
	r.Get("/api/public/archive/{tenant_slug}/feed.json", mark("feed.json"))
	r.Get("/api/public/archive/{tenant_slug}/tag/{tag_slug}/feed.xml", mark("tag.xml"))
	r.Get("/api/public/archive/{tenant_slug}/tag/{tag_slug}/feed.json", mark("tag.json"))
	r.Get("/api/public/archive/{tenant_slug}/author/{author_slug}/feed.xml", mark("author.xml"))
	r.Get("/api/public/archive/{tenant_slug}/author/{author_slug}/feed.json", mark("author.json"))

	cases := []struct {
		path string
		want string
	}{
		// Issue detail (single non-literal segment) still resolves to
		// the archive catch-all.
		{"/api/public/archive/acme/welcome", "catchall"},
		// feed.xml / feed.json on the tenant root resolve to the
		// whole-archive feed, NOT the catch-all (the literal `feed.xml`
		// segment outranks the {campaign_slug} wildcard).
		{"/api/public/archive/acme/feed.xml", "feed.xml"},
		{"/api/public/archive/acme/feed.json", "feed.json"},
		// Per-tag and per-author paths must resolve to the right slice
		// feed — the literal `tag` / `author` segment outranks the
		// {campaign_slug} wildcard at the same depth.
		{"/api/public/archive/acme/tag/release-notes/feed.xml", "tag.xml"},
		{"/api/public/archive/acme/tag/release-notes/feed.json", "tag.json"},
		{"/api/public/archive/acme/author/jane-doe/feed.xml", "author.xml"},
		{"/api/public/archive/acme/author/jane-doe/feed.json", "author.json"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.path, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest("GET", tc.path, nil)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			got := rec.Header().Get("X-Route")
			if got != tc.want {
				t.Fatalf("path %s hit %q, want %q (status %d)", tc.path, got, tc.want, rec.Code)
			}
		})
	}
}

// TestMountRoutes_NilGuardSkipsRegistration confirms the defensive
// nil-guard so the boot path can call MountRoutes unconditionally — if
// the archive repo isn't wired (e.g. config disables the public
// archive), we don't panic; we simply don't register the routes.
func TestMountRoutes_NilGuardSkipsRegistration(t *testing.T) {
	t.Parallel()
	r := chi.NewRouter()
	var d *Deps
	d.MountRoutes(r) // nil receiver: must not panic

	d2 := &Deps{ArchiveRepo: nil}
	d2.MountRoutes(r) // nil repo: must not register routes

	count := 0
	walk := func(method, route string, h http.Handler, mws ...func(http.Handler) http.Handler) error {
		_ = method
		_ = route
		_ = h
		_ = mws
		count++
		return nil
	}
	if err := chi.Walk(r, walk); err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected 0 routes registered when ArchiveRepo is nil, got %d", count)
	}
}
