// SPDX-License-Identifier: AGPL-3.0-only

package httpcache_test

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httpcache/httpcachetest"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/serviceproxy"
)

// audienceFixture is a stand-in tenant: a list catalogue whose items can be
// deleted, and a form guarded by a strong version ETag and If-Match — the two
// shapes behind every report in the stale-dashboard cluster (a deleted list
// reappearing; a published form flipping back to draft and 412ing its next
// save).
type audienceFixture struct {
	lists       []string
	formVersion int
	formStatus  string
}

func (f *audienceFixture) formETag() string {
	return httpcache.ETagStrong("form", "f1", int64(f.formVersion))
}

// mountAudienceRoutes mounts the fixture with the middleware order main.go
// gives the authenticated group: Conditional outside the group policy. A
// non-nil routePolicy is stacked on one read, the way the analytics routes
// stack HeavyRead on the group's AuthRead.
func mountAudienceRoutes(f *audienceFixture, groupPolicy httpcache.Policy, routePolicy *httpcache.Policy) http.Handler {
	r := chi.NewRouter()
	r.Use(httpcache.Conditional())
	r.Use(httpcache.WithPolicy(groupPolicy))
	listRead := r.With()
	if routePolicy != nil {
		listRead = r.With(httpcache.WithPolicy(*routePolicy))
	}
	listRead.Get("/api/v1/lists", func(w http.ResponseWriter, _ *http.Request) {
		writeTestJSON(w, http.StatusOK, map[string]any{"data": f.lists})
	})
	r.Delete("/api/v1/lists/{name}", func(w http.ResponseWriter, req *http.Request) {
		f.lists = slices.DeleteFunc(f.lists, func(n string) bool { return n == chi.URLParam(req, "name") })
		w.WriteHeader(http.StatusNoContent)
	})
	r.Get("/api/v1/forms/f1", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("ETag", f.formETag())
		writeTestJSON(w, http.StatusOK, map[string]any{"status": f.formStatus})
	})
	r.Patch("/api/v1/forms/f1", func(w http.ResponseWriter, req *http.Request) {
		if httpcache.IfMatchFailed(req, f.formETag()) {
			httpcache.WritePreconditionFailed(w)
			return
		}
		var body struct {
			Status string `json:"status"`
		}
		_ = json.NewDecoder(req.Body).Decode(&body)
		f.formStatus = body.Status
		f.formVersion++
		w.Header().Set("ETag", f.formETag())
		writeTestJSON(w, http.StatusOK, map[string]any{"status": f.formStatus})
	})
	return r
}

func writeTestJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// sessionRequest carries a dashboard session the way the browser does, so the
// Vary: Cookie selection in the cache is exercised rather than bypassed.
func sessionRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Cookie", "pw_session=reader")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

func authenticatedReadCases() []struct {
	name        string
	group       httpcache.Policy
	routePolicy *httpcache.Policy
} {
	heavy := httpcache.HeavyRead()
	return []struct {
		name        string
		group       httpcache.Policy
		routePolicy *httpcache.Policy
	}{
		{name: "AuthRead", group: httpcache.AuthRead()},
		{name: "HeavyRead on the AuthRead group", group: httpcache.AuthRead(), routePolicy: &heavy},
	}
}

// A deleted list must not come back on the refetch the page issues straight
// after the delete. The delete targets the item URL; the refetch reads the
// collection URL, which no browser invalidates for an item write.
func TestAuthenticatedCollectionReadSeesTheReadersOwnDelete(t *testing.T) {
	t.Parallel()
	for _, tc := range authenticatedReadCases() {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			fixture := &audienceFixture{lists: []string{"newsletter", "diag-list"}}
			browser := httpcachetest.NewBrowser(mountAudienceRoutes(fixture, tc.group, tc.routePolicy))
			const catalogue = "/api/v1/lists?page=1&per_page=25"

			if first := browser.Do(sessionRequest(http.MethodGet, catalogue, "")); !strings.Contains(string(first.Body), "diag-list") {
				t.Fatalf("fixture catalogue = %s", first.Body)
			}
			if res := browser.Do(sessionRequest(http.MethodDelete, "/api/v1/lists/diag-list", "")); res.Status != http.StatusNoContent {
				t.Fatalf("delete status = %d", res.Status)
			}
			after := browser.Do(sessionRequest(http.MethodGet, catalogue, ""))
			if strings.Contains(string(after.Body), "diag-list") {
				t.Fatalf("the catalogue read straight after the delete was %s and still lists the deleted list: %s (Cache-Control %q)",
					after.Source, after.Body, after.Header.Get("Cache-Control"))
			}

			// Revalidating every read must not cost the body: an unchanged
			// catalogue is confirmed with a 304 and served from the cache.
			again := browser.Do(sessionRequest(http.MethodGet, catalogue, ""))
			if again.Source != httpcachetest.Revalidated || string(again.Body) != string(after.Body) {
				t.Fatalf("an unchanged catalogue was %s; want a 304 revalidation serving the stored body", again.Source)
			}
		})
	}
}

// Publish then Save: the refetch after the publish must carry the published
// status AND the new ETag, or the next If-Match save is refused with 412 and
// the editor raises a false "changed elsewhere" banner.
func TestAuthenticatedItemReadAfterAnIfMatchWriteCarriesTheNewVersion(t *testing.T) {
	t.Parallel()
	for _, tc := range authenticatedReadCases() {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			fixture := &audienceFixture{lists: []string{"Newsletter"}, formVersion: 1, formStatus: "draft"}
			browser := httpcachetest.NewBrowser(mountAudienceRoutes(fixture, tc.group, tc.routePolicy))

			loaded := browser.Do(sessionRequest(http.MethodGet, "/api/v1/forms/f1", ""))
			publish := sessionRequest(http.MethodPatch, "/api/v1/forms/f1", `{"status":"published"}`)
			publish.Header.Set("If-Match", loaded.Header.Get("ETag"))
			if res := browser.Do(publish); res.Status != http.StatusOK {
				t.Fatalf("publish status = %d: %s", res.Status, res.Body)
			}

			refetched := browser.Do(sessionRequest(http.MethodGet, "/api/v1/forms/f1", ""))
			if !strings.Contains(string(refetched.Body), `"published"`) {
				t.Fatalf("the refetch after Publish was %s and still reads %s", refetched.Source, refetched.Body)
			}
			save := sessionRequest(http.MethodPatch, "/api/v1/forms/f1", `{"status":"published"}`)
			save.Header.Set("If-Match", refetched.Header.Get("ETag"))
			if res := browser.Do(save); res.Status != http.StatusOK {
				t.Fatalf("Save after Publish echoed the refetched ETag %q and got %d: %s",
					refetched.Header.Get("ETag"), res.Status, res.Body)
			}
		})
	}
}

// Stacked policies must not repeat Vary names, and the authenticated policies
// must keep varying on both credentials.
func TestAuthenticatedReadPoliciesVaryOnCredentialsOnce(t *testing.T) {
	t.Parallel()
	for _, tc := range authenticatedReadCases() {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			fixture := &audienceFixture{lists: []string{"Newsletter"}}
			rec := httptest.NewRecorder()
			mountAudienceRoutes(fixture, tc.group, tc.routePolicy).ServeHTTP(rec, sessionRequest(http.MethodGet, "/api/v1/lists", ""))
			var names []string
			for _, value := range rec.Header().Values("Vary") {
				for _, name := range strings.Split(value, ",") {
					names = append(names, strings.TrimSpace(name))
				}
			}
			slices.Sort(names)
			if want := []string{"Accept-Encoding", "Authorization", "Cookie"}; !slices.Equal(names, want) {
				t.Fatalf("Vary = %v, want each of %v exactly once", names, want)
			}
		})
	}
}

// unreachableURL is an address that refuses connections: a server that has
// been started and closed again.
func unreachableURL(t *testing.T) string {
	t.Helper()
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	return gone.URL
}

// SP-B4: during an outage the policy's stamp used to ride on the error, so the
// browser stored the 502/503 and answered every retry with it — for minutes on
// the public policy — without the request reaching the server.
func TestErrorResponsesAreNeverStoredUnderAPolicy(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		policy httpcache.Policy
	}{
		{name: "AuthRead", policy: httpcache.AuthRead()},
		{name: "HeavyRead", policy: httpcache.HeavyRead()},
		{name: "PublicArchive", policy: httpcache.PublicArchive()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var up atomic.Bool
			healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				writeTestJSON(w, http.StatusOK, map[string]string{"reputation": "good"})
			}))
			t.Cleanup(healthy.Close)
			downstream := serviceproxy.New(serviceproxy.Options{Target: unreachableURL(t)})
			upstream := serviceproxy.New(serviceproxy.Options{Target: healthy.URL})

			r := chi.NewRouter()
			r.Use(httpcache.Conditional())
			r.Use(httpcache.WithPolicy(tc.policy))
			r.Get("/assurance", func(w http.ResponseWriter, _ *http.Request) {
				if !up.Load() {
					httperror.Write(w, http.StatusServiceUnavailable, "assurance_unavailable", "assurance is unavailable")
					return
				}
				writeTestJSON(w, http.StatusOK, map[string]string{"state": "ready"})
			})
			r.Get("/reputation", func(w http.ResponseWriter, req *http.Request) {
				if up.Load() {
					upstream.ServeHTTP(w, req)
					return
				}
				downstream.ServeHTTP(w, req)
			})
			r.Get("/missing", func(w http.ResponseWriter, _ *http.Request) {
				httperror.Write(w, http.StatusNotFound, "not_found", "no such thing")
			})
			browser := httpcachetest.NewBrowser(r)

			outage := map[string]httpcachetest.Response{}
			for path, wantStatus := range map[string]int{
				"/assurance":  http.StatusServiceUnavailable,
				"/reputation": http.StatusBadGateway,
				"/missing":    http.StatusNotFound,
			} {
				res := browser.Do(sessionRequest(http.MethodGet, path, ""))
				if res.Status != wantStatus {
					t.Fatalf("GET %s during the outage = %d, want %d", path, res.Status, wantStatus)
				}
				outage[path] = res
			}

			up.Store(true)
			for _, path := range []string{"/assurance", "/reputation"} {
				retry := browser.Do(sessionRequest(http.MethodGet, path, ""))
				if retry.Source != httpcachetest.FromOrigin || retry.Status != http.StatusOK {
					t.Fatalf("the retry of %s after the upstream recovered was %s with status %d; it must reach the server",
						path, retry.Source, retry.Status)
				}
			}
			for path, res := range outage {
				if got := res.Header.Get("Cache-Control"); got != "private, no-store" {
					t.Fatalf("GET %s %d carries Cache-Control %q; an error must never be stored", path, res.Status, got)
				}
				if !slices.Contains(res.Header.Values("Vary"), "Accept-Encoding") {
					t.Fatalf("GET %s %d dropped the policy's Vary: %v", path, res.Status, res.Header.Values("Vary"))
				}
			}
			// And a success still carries the policy, unchanged.
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, sessionRequest(http.MethodGet, "/assurance", ""))
			want := httptest.NewRecorder()
			tc.policy.Apply(want)
			if got := rec.Header().Get("Cache-Control"); got != want.Header().Get("Cache-Control") {
				t.Fatalf("a 200 under %s carries %q, want the policy's %q", tc.name, got, want.Header().Get("Cache-Control"))
			}
		})
	}
}

// The handler keeps the final say: an error path that chose its own caching
// is left alone, whichever way it chose.
func TestHandlerChosenErrorCachingSurvivesThePolicy(t *testing.T) {
	t.Parallel()
	for _, own := range []string{"no-store", "public, max-age=60"} {
		r := chi.NewRouter()
		r.Use(httpcache.WithPolicy(httpcache.PublicArchive()))
		r.Get("/x", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Cache-Control", own)
			w.WriteHeader(http.StatusNotFound)
		})
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
		if got := rec.Header().Get("Cache-Control"); got != own {
			t.Fatalf("handler set %q on its 404; the policy rewrote it to %q", own, got)
		}
	}
}

// Only the final status decides: an interim 103 does not, and a superfluous
// WriteHeader after a 200 must not rewrite the headers of a success.
func TestErrorOverrideActsOnTheFinalStatusOnly(t *testing.T) {
	t.Parallel()
	r := chi.NewRouter()
	r.Use(httpcache.WithPolicy(httpcache.AuthRead()))
	r.Get("/hinted-error", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusEarlyHints)
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	r.Get("/late-error", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
		w.WriteHeader(http.StatusInternalServerError)
	})
	// A real server: only net/http treats a 1xx as interim.
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)
	want := httptest.NewRecorder()
	httpcache.AuthRead().Apply(want)
	for path, expect := range map[string]struct {
		status       int
		cacheControl string
	}{
		"/hinted-error": {http.StatusServiceUnavailable, "private, no-store"},
		"/late-error":   {http.StatusOK, want.Header().Get("Cache-Control")},
	} {
		res, err := server.Client().Get(server.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		_ = res.Body.Close()
		if res.StatusCode != expect.status || res.Header.Get("Cache-Control") != expect.cacheControl {
			t.Fatalf("GET %s = %d with Cache-Control %q, want %d with %q",
				path, res.StatusCode, res.Header.Get("Cache-Control"), expect.status, expect.cacheControl)
		}
	}
}

// The error override wraps the writer, and must not become one more place a
// stream's flush or write deadline dies (SP-C5): served over a real
// connection, the first event reaches the client while the handler is still
// running, and the write deadline can be cleared through the wrapper.
func TestPolicyWriterKeepsStreamsFlowing(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	deadlineErr := make(chan error, 1)
	handler := httpcache.WithPolicy(httpcache.AuthRead())(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		rc := http.NewResponseController(w)
		deadlineErr <- rc.SetWriteDeadline(time.Time{})
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "event: ready\n\n")
		if err := rc.Flush(); err != nil {
			t.Errorf("flush through the policy writer: %v", err)
		}
		<-release
		_, _ = fmt.Fprint(w, "event: done\n\n")
	}))
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})

	// The client runs on its own goroutine: without a working flush even the
	// response headers stay in the server's buffer, and the test must report
	// that rather than wait for the handler forever.
	firstLine := make(chan string, 1)
	go func() {
		res, err := server.Client().Get(server.URL)
		if err != nil {
			firstLine <- "GET failed: " + err.Error()
			return
		}
		defer func() { _ = res.Body.Close() }()
		line, _ := bufio.NewReader(res.Body).ReadString('\n')
		firstLine <- line
	}()
	select {
	case line := <-firstLine:
		if line != "event: ready\n" {
			t.Fatalf("first streamed line = %q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the flushed event never reached the client while the handler was running")
	}
	if err := <-deadlineErr; err != nil {
		t.Fatalf("SetWriteDeadline through the policy writer: %v (Unwrap must expose the connection)", err)
	}
	close(release)

	// The recorder path too: http.Flusher users see the flush land.
	rec := httptest.NewRecorder()
	httpcache.WithPolicy(httpcache.AuthRead())(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.(http.Flusher).Flush()
	})).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if !rec.Flushed {
		t.Fatal("Flush through the policy writer did not reach the underlying writer")
	}
}

// Writes are untouched by a read policy and still no-store under Mutation.
func TestPolicyOnlyStampsReads(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		policy httpcache.Policy
		want   string
	}{
		{policy: httpcache.AuthRead(), want: ""},
		{policy: httpcache.Mutation(), want: "private, no-store"},
	} {
		r := chi.NewRouter()
		r.Use(httpcache.WithPolicy(tc.policy))
		r.Post("/x", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusCreated) })
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/x", nil))
		if got := rec.Header().Get("Cache-Control"); got != tc.want {
			t.Fatalf("POST under %+v carries Cache-Control %q, want %q", tc.policy, got, tc.want)
		}
	}
}
