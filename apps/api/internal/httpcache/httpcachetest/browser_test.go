// SPDX-License-Identifier: AGPL-3.0-only

package httpcachetest

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// versionedOrigin reproduces the server of the Chromium experiment the cache
// diagnosis ran (scratchpad caching/local-browser-cache.js): GET answers the
// current version with a strong ETag and the policy under test, and honours
// If-None-Match with a 304; any write bumps the version.
type versionedOrigin struct {
	version int
	policy  string
}

func (o *versionedOrigin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		o.version++
		_, _ = fmt.Fprintf(w, `{"v":%d}`, o.version)
		return
	}
	etag := fmt.Sprintf(`"v%d"`, o.version)
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", o.policy)
	w.Header().Set("Vary", "Cookie")
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = fmt.Fprintf(w, `{"v":%d}`, o.version)
}

// The expectations are what Chromium DID in that experiment, not what this
// package computes: with the old AuthRead header a same-URL write without
// If-Match refreshed the next read, while an If-Match write and a write to a
// sub-URL left it stale; with either revalidating header every read was fresh.
// If the model drifts from the browser, this table says so.
func TestBrowserMatchesTheObservedChromiumExperiment(t *testing.T) {
	t.Parallel()
	const (
		swr     = "private, max-age=10, stale-while-revalidate=60"
		noCache = "private, no-cache"
		maxAge0 = "private, max-age=0, must-revalidate"
	)
	cases := []struct {
		policy, write string
		stale         bool
	}{
		{swr, "PUT", false},
		{swr, "PATCH", false},
		{swr, "DELETE", false},
		{swr, "POST", false},
		{swr, "PATCH+If-Match", true},
		{swr, "PUT+If-Match", true},
		{swr, "DELETE-collection", true},
	}
	for _, revalidating := range []string{noCache, maxAge0} {
		for _, write := range []string{"PUT", "PATCH", "DELETE", "POST", "PATCH+If-Match", "PUT+If-Match", "DELETE-collection"} {
			cases = append(cases, struct {
				policy, write string
				stale         bool
			}{revalidating, write, false})
		}
	}
	for _, tc := range cases {
		t.Run(tc.policy+"/"+tc.write, func(t *testing.T) {
			t.Parallel()
			origin := &versionedOrigin{version: 1, policy: tc.policy}
			browser := NewBrowser(origin)
			const path = "/r"

			before := browser.Do(httptest.NewRequest(http.MethodGet, path, nil))
			method, conditional := strings.CutSuffix(tc.write, "+If-Match")
			target := path
			if m, ok := strings.CutSuffix(method, "-collection"); ok {
				method, target = m, path+"/item-1"
			}
			write := httptest.NewRequest(method, target, strings.NewReader("{}"))
			if conditional {
				write.Header.Set("If-Match", before.Header.Get("ETag"))
			}
			written := browser.Do(write)
			after := browser.Do(httptest.NewRequest(http.MethodGet, path, nil))

			if stale := string(after.Body) != string(written.Body); stale != tc.stale {
				t.Fatalf("after %s the read returned %s (%s) while the write returned %s; Chromium was observed stale=%v",
					tc.write, after.Body, after.Source, written.Body, tc.stale)
			}
		})
	}
}

// The stale-while-revalidate window hands the caller the stale copy and only
// refreshes the cache — the client's query cache never sees the refresh.
func TestBrowserStaleWhileRevalidateServesTheStaleCopy(t *testing.T) {
	t.Parallel()
	origin := &versionedOrigin{version: 1, policy: "private, max-age=10, stale-while-revalidate=60"}
	browser := NewBrowser(origin)
	browser.Do(httptest.NewRequest(http.MethodGet, "/r", nil))
	origin.version = 2
	browser.Advance(30 * time.Second)

	stale := browser.Do(httptest.NewRequest(http.MethodGet, "/r", nil))
	if stale.Source != FromCache || string(stale.Body) != `{"v":1}` {
		t.Fatalf("inside the SWR window: %s %s, want the stored v1 from cache", stale.Body, stale.Source)
	}
	fresh := browser.Do(httptest.NewRequest(http.MethodGet, "/r", nil))
	if string(fresh.Body) != `{"v":2}` {
		t.Fatalf("after the background revalidation: %s, want v2", fresh.Body)
	}
}

// A response with explicit freshness is stored whatever its status — which is
// how a 503 carrying the read policy was replayed to every retry.
func TestBrowserStoresAnErrorThatCarriesFreshness(t *testing.T) {
	t.Parallel()
	calls := 0
	browser := NewBrowser(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.Header().Set("Cache-Control", "private, max-age=10, stale-while-revalidate=60")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	browser.Do(httptest.NewRequest(http.MethodGet, "/x", nil))
	retry := browser.Do(httptest.NewRequest(http.MethodGet, "/x", nil))
	if retry.Source != FromCache || calls != 1 {
		t.Fatalf("retry = %s after %d origin calls; the observed browser replayed the 503 from cache", retry.Source, calls)
	}
}

func TestBrowserNeverStoresNoStore(t *testing.T) {
	t.Parallel()
	calls := 0
	browser := NewBrowser(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.Header().Set("Cache-Control", "private, no-store")
		_, _ = w.Write([]byte("x"))
	}))
	browser.Do(httptest.NewRequest(http.MethodGet, "/x", nil))
	again := browser.Do(httptest.NewRequest(http.MethodGet, "/x", nil))
	if again.Source != FromOrigin || calls != 2 {
		t.Fatalf("a no-store response was reused: %s after %d origin calls", again.Source, calls)
	}
}

// Vary keeps one principal's stored response away from another's request.
func TestBrowserSelectsStoredResponsesByVary(t *testing.T) {
	t.Parallel()
	browser := NewBrowser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, max-age=60")
		w.Header().Set("Vary", "Cookie")
		_, _ = w.Write([]byte(r.Header.Get("Cookie")))
	}))
	first := httptest.NewRequest(http.MethodGet, "/x", nil)
	first.Header.Set("Cookie", "session=a")
	browser.Do(first)
	second := httptest.NewRequest(http.MethodGet, "/x", nil)
	second.Header.Set("Cookie", "session=b")
	if got := browser.Do(second); got.Source != FromOrigin || string(got.Body) != "session=b" {
		t.Fatalf("another session's request got %q (%s)", got.Body, got.Source)
	}
}
