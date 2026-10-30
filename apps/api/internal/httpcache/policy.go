// SPDX-License-Identifier: AGPL-3.0-only

package httpcache

import (
	"fmt"
	"net/http"
	"strings"
)

// noStoreDirective is the one spelling of "never persist this response" the
// package emits. private keeps a shared cache out even when it ignores
// no-store; no-store keeps the browser's own cache out.
const noStoreDirective = "private, no-store"

// Policy declares how a handler wants its response cached. Apply
// turns the declaration into the right Cache-Control / Vary
// headers so callers stop hand-rolling visibility strings.
//
//   - MaxAgeSec   — freshness window during which a cache may reuse the
//     response WITHOUT asking the origin. Zero (the default) emits
//     "max-age=0, must-revalidate": every reuse is revalidated, and the
//     Conditional middleware answers an unchanged resource with 304.
//     A positive value is only correct for a response that cannot change
//     under its URL (content-addressed, immutable) or for anonymous public
//     reads. Never give it to data the reader can change: a browser keeps
//     serving the stored copy across the reader's own writes (see AuthRead).
//   - SMaxAgeSec  — shared-cache override; only emitted when > 0
//     and Visibility is "public" (CDN-side freshness budget).
//   - SWRSec      — stale-while-revalidate window; 0 disables. Same caveat
//     as MaxAgeSec: the stale copy is what the caller receives.
//   - Visibility  — "private" (per-user) or "public" (shared).
//     Empty defaults to "private", because tenant data is the
//     safer default in this codebase.
//   - NoStore     — when true, emits "private, no-store" and
//     ignores the freshness fields. Used for mutations + any
//     route that must never sit in a cache.
//   - Vary        — header names to add to the Vary list so
//     downstream caches key on them (Accept-Encoding, Cookie,
//     Authorization …).
type Policy struct {
	MaxAgeSec  int
	SMaxAgeSec int
	SWRSec     int
	Visibility string
	NoStore    bool
	Vary       []string
}

// Apply writes Cache-Control and Vary headers to w. Safe to call
// before or after ETag negotiation; it never sets a body.
func (p Policy) Apply(w http.ResponseWriter) {
	if p.NoStore {
		w.Header().Set("Cache-Control", noStoreDirective)
		// Vary still useful so a CDN that ignored no-store doesn't
		// pick a cross-tenant variant if/when it eventually caches.
		applyVary(w, p.Vary)
		return
	}
	vis := strings.ToLower(strings.TrimSpace(p.Visibility))
	if vis != "public" && vis != "private" {
		vis = "private"
	}
	parts := []string{vis}
	if p.MaxAgeSec > 0 {
		parts = append(parts, fmt.Sprintf("max-age=%d", p.MaxAgeSec))
	} else {
		// Explicit zero — force revalidation every hit. The
		// ETag still lets clients short-circuit with 304.
		parts = append(parts, "max-age=0", "must-revalidate")
	}
	if vis == "public" && p.SMaxAgeSec > 0 {
		parts = append(parts, fmt.Sprintf("s-maxage=%d", p.SMaxAgeSec))
	}
	if p.SWRSec > 0 {
		parts = append(parts, fmt.Sprintf("stale-while-revalidate=%d", p.SWRSec))
	}
	w.Header().Set("Cache-Control", strings.Join(parts, ", "))
	applyVary(w, p.Vary)
}

// applyVary adds each header name to Vary once. Policies stack — the
// authenticated group stamps AuthRead and a route may stamp its own policy on
// top — and a blind Add repeated every name ("Authorization, Cookie,
// Accept-Encoding, Authorization, Cookie, Accept-Encoding").
func applyVary(w http.ResponseWriter, vary []string) {
	present := map[string]bool{}
	for _, value := range w.Header().Values("Vary") {
		for _, name := range strings.Split(value, ",") {
			present[strings.ToLower(strings.TrimSpace(name))] = true
		}
	}
	for _, v := range vary {
		v = strings.TrimSpace(v)
		key := strings.ToLower(v)
		if v == "" || present[key] {
			continue
		}
		present[key] = true
		w.Header().Add("Vary", v)
	}
}

// Common policy presets. Callers should prefer these so the cache
// surface stays consistent across the API.

// AuthRead — per-tenant authenticated reads: collections, detail GETs,
// /auth/me, per-user settings. Every reuse is revalidated with the origin
// (`private, max-age=0, must-revalidate`); the Conditional middleware turns an
// unchanged revalidation into a bodyless 304, so the steady-state cost is one
// round trip, not a payload.
//
// It carried `max-age=10, stale-while-revalidate=60` until the reads the
// dashboard issues straight after its own writes came back from the
// browser's disk cache: a deleted list reappeared, a published form flipped
// back to draft and its stale ETag earned the next save a 412, added members
// and pasted contacts stayed invisible for up to 70 seconds. A browser only
// drops a stored GET when a write targets that exact URL — never a collection
// URL for an item write, and not at all when the write carries If-Match,
// which every concurrency-safe write here does — and the
// stale-while-revalidate refresh lands in the HTTP cache, never in the
// client's query cache. Clients own read reuse (TanStack Query staleTime and
// post-write invalidation); an HTTP freshness window silently overrules them.
//
// Varies on Authorization AND Cookie so neither bearer-token nor
// cookie-session payloads can leak across tenants when a CDN is
// eventually fronted.
func AuthRead() Policy {
	return Policy{
		Visibility: "private",
		Vary:       []string{"Authorization", "Cookie", "Accept-Encoding"},
	}
}

// HeavyRead — expensive aggregates (dashboard rollups, analytics, campaign
// reports). Deliberately the same revalidate-every-use policy as AuthRead:
// the dashboard reads these right after the writes that move them (a bulk
// delete changes the contact count; the layout and digest routes are one
// user's settings with their own PUTs), and a positive freshness window
// served the pre-write figures for minutes. Expense is bounded where it
// belongs — the clients' dashboard staleTime decides how often to ask, and
// an unchanged aggregate still revalidates to a bodyless 304. The preset
// stays a separate name so a route declares what it is, and so a future
// server-side result cache has one place to hook in.
func HeavyRead() Policy {
	return AuthRead()
}

// PublicArchive — anonymous public reads (archive HTML, podcast RSS,
// status). 5 min client freshness, 10 min shared-cache freshness,
// 1 hour SWR so a CDN edge keeps serving while the origin re-renders.
func PublicArchive() Policy {
	return Policy{
		MaxAgeSec:  300,
		SMaxAgeSec: 600,
		SWRSec:     3600,
		Visibility: "public",
		Vary:       []string{"Accept-Encoding"},
	}
}

// PublicMedium — retained for back-compat. Prefer PublicArchive for
// new callers; PublicMedium omits s-maxage and uses a tighter SWR.
func PublicMedium() Policy {
	return Policy{
		MaxAgeSec:  300,
		SWRSec:     900,
		Visibility: "public",
		Vary:       []string{"Accept-Encoding"},
	}
}

// Mutation — explicit no-store policy for write endpoints. Use this
// when wrapping a Group whose handlers must never sit in a cache.
func Mutation() Policy {
	return Policy{NoStore: true}
}

// NoStore — sensitive responses (auth tokens, exports). Forces
// caches to never persist the payload. Bypasses the normal
// max-age/SWR composition by writing the directive directly.
type noStorePolicy struct{}

func (noStorePolicy) Apply(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", noStoreDirective)
}

// NoStore returns an Applier that suppresses all caching. Retained
// for callers that prefer the Applier interface; Mutation() returns
// the same effect as a Policy value.
func NoStore() Applier { return noStorePolicy{} }

// Applier is the common interface satisfied by Policy and the
// no-store override, so handlers can accept either.
type Applier interface {
	Apply(w http.ResponseWriter)
}

// WithPolicy returns a chi-compatible middleware that stamps the
// given policy's Cache-Control + Vary headers on every GET/HEAD response.
//
// Mounted per-route-family (not globally) so policy decisions stay
// next to the route definitions in main.go. The middleware writes
// headers BEFORE the wrapped handler runs so handlers retain the
// final say — a handler that hand-rolls `Cache-Control: no-store`
// for an error path still wins.
//
// The stamp describes a representation of the resource, and an error is not
// one. When the response turns out to be an error (status >= 400) and its
// Cache-Control is still the policy's own stamp, it is replaced with
// "private, no-store" as the status is written. Otherwise a 503 from a
// struggling upstream inherited the read's freshness window, and every retry
// — the fetch layer's, the query client's, the user's Retry button — was
// answered from the browser cache without reaching the server, for up to the
// full stale window after the upstream had recovered.
//
// CRITICAL: when WithPolicy(AuthRead) wraps an authenticated route
// group, Vary: Authorization + Vary: Cookie land on every response.
// This is the cross-tenant cache-leak guard the strategy doc calls
// out — without it a CDN fronting the API could hand tenant A's
// payload to tenant B because the cache key didn't include the
// auth credential.
func WithPolicy(p Applier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Only stamp on GET/HEAD. Mutations get whatever the
			// handler emits (typically nothing, which means the
			// framework default of no caching) — applying max-age
			// to a POST 201 would mis-instruct shared caches.
			if r.Method == http.MethodGet || r.Method == http.MethodHead {
				p.Apply(w)
				w = newErrorUncacheableWriter(w, cacheControl(w.Header()))
			} else if mp, ok := p.(Policy); ok && mp.NoStore {
				// Belt-and-braces for write methods grouped under a
				// Mutation policy: still write no-store so a
				// misconfigured intermediary can't cache the body.
				w.Header().Set("Cache-Control", noStoreDirective)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// cacheControl reads Cache-Control as one string, however many field lines
// carry it.
func cacheControl(h http.Header) string {
	return strings.Join(h.Values("Cache-Control"), ", ")
}
