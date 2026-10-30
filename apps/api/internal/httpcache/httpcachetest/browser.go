// SPDX-License-Identifier: AGPL-3.0-only

// Package httpcachetest replays requests through a private HTTP cache that
// reuses responses the way a browser's does (RFC 9111 for a private cache,
// plus RFC 5861 stale-while-revalidate), so a test can ask the question a
// cache policy exists to answer: after a write, does the reader's next read
// reach the server, and does it see the write?
//
// A header assertion alone cannot answer that. `private, max-age=10,
// stale-while-revalidate=60` reads as harmless ("ten seconds"), yet a browser
// honouring it answers the refetch a client issues straight after its own
// write from disk, with the pre-write body, for up to seventy seconds. This
// cache applies those rules, so a test states the behaviour and the policy
// string is free to be spelled any correct way.
//
// It models what the API's policies can exercise, not a whole browser: one
// stored response per URL (selected by Vary), explicit freshness (max-age,
// Expires) and the Last-Modified heuristic, no-cache / must-revalidate /
// no-store, validation with If-None-Match and If-Modified-Since, 304 header
// refresh, and invalidation of the target URI by a successful unsafe request
// (RFC 9111 §4.4) — except when that request carries If-Match, which Chromium
// was observed not to invalidate on. Nothing else is invalidated: an item
// write never refreshes its collection's URL. A test that passes here
// therefore leans on no invalidation a browser would not perform.
package httpcachetest

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Source says how the cache answered one request.
type Source int

const (
	// FromOrigin — the handler produced the full response.
	FromOrigin Source = iota
	// FromCache — a stored response was reused without contacting the origin.
	FromCache
	// Revalidated — the origin confirmed the stored response with 304 and the
	// stored body was served.
	Revalidated
)

func (s Source) String() string {
	switch s {
	case FromCache:
		return "served from the browser cache without reaching the server"
	case Revalidated:
		return "revalidated with the server (304) and served from the browser cache"
	default:
		return "fetched from the server"
	}
}

// Response is what the page's fetch() would have received.
type Response struct {
	Status int
	Header http.Header
	Body   []byte
	Source Source
}

// Browser is a private HTTP cache in front of Handler.
type Browser struct {
	Handler http.Handler

	mu      sync.Mutex
	now     time.Time
	store   map[string]*storedResponse
	origins []string
}

type storedResponse struct {
	status   int
	header   http.Header
	body     []byte
	storedAt time.Time
	// varied holds the request's value for every header the response Vary'd
	// on, so a request with different credentials cannot reuse it.
	varied map[string]string
}

// NewBrowser returns an empty cache in front of handler. Its clock starts at
// an arbitrary instant and only moves when Advance is called, so freshness is
// deterministic.
func NewBrowser(handler http.Handler) *Browser {
	return &Browser{
		Handler: handler,
		now:     time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC),
		store:   map[string]*storedResponse{},
	}
}

// Advance moves the cache's clock forward.
func (b *Browser) Advance(d time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.now = b.now.Add(d)
}

// OriginRequests lists "METHOD URI" for every request that reached the
// handler, in order — including validations and background revalidations.
func (b *Browser) OriginRequests() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.origins...)
}

// Do sends req through the cache.
func (b *Browser) Do(req *http.Request) Response {
	b.mu.Lock()
	defer b.mu.Unlock()
	key := req.URL.RequestURI()
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		res := b.forward(req)
		// RFC 9111 §4.4: a non-error response to an unsafe request
		// invalidates the target URI — and nothing else. Chromium skips
		// even that when the write is conditional on If-Match.
		if res.Status >= 200 && res.Status < 400 && req.Header.Get("If-Match") == "" {
			delete(b.store, key)
		}
		return res
	}
	stored := b.store[key]
	if stored == nil || !stored.matches(req) {
		return b.fetchAndStore(req, key)
	}
	directives := parseCacheControl(stored.header)
	age := b.now.Sub(stored.storedAt)
	lifetime := stored.freshnessLifetime(directives)
	if !directives.has("no-cache") && age < lifetime {
		return stored.response(FromCache)
	}
	if !directives.has("no-cache") && !directives.has("must-revalidate") {
		if swr, ok := directives.seconds("stale-while-revalidate"); ok && age < lifetime+swr {
			// The caller gets the stale copy now; the refresh only reaches
			// the cache, for whoever asks next.
			served := stored.response(FromCache)
			b.revalidate(req, key, stored)
			return served
		}
	}
	return b.revalidate(req, key, stored)
}

func (b *Browser) fetchAndStore(req *http.Request, key string) Response {
	res := b.forward(req)
	if storable(req, res) {
		b.store[key] = newStoredResponse(req, res, b.now)
	} else {
		delete(b.store, key)
	}
	return res
}

func (b *Browser) revalidate(req *http.Request, key string, stored *storedResponse) Response {
	conditional := req.Clone(req.Context())
	if etag := stored.header.Get("ETag"); etag != "" {
		conditional.Header.Set("If-None-Match", etag)
	}
	if modified := stored.header.Get("Last-Modified"); modified != "" {
		conditional.Header.Set("If-Modified-Since", modified)
	}
	res := b.forward(conditional)
	if res.Status == http.StatusNotModified {
		// RFC 9111 §4.3.4: the 304's headers replace the stored ones.
		for name, values := range res.Header {
			stored.header[name] = append([]string(nil), values...)
		}
		stored.storedAt = b.now
		return stored.response(Revalidated)
	}
	if storable(req, res) {
		b.store[key] = newStoredResponse(req, res, b.now)
	} else {
		delete(b.store, key)
	}
	return res
}

func (b *Browser) forward(req *http.Request) Response {
	b.origins = append(b.origins, req.Method+" "+req.URL.RequestURI())
	recorder := httptest.NewRecorder()
	b.Handler.ServeHTTP(recorder, req)
	result := recorder.Result()
	defer func() { _ = result.Body.Close() }()
	return Response{
		Status: recorder.Code,
		Header: result.Header.Clone(),
		Body:   append([]byte(nil), recorder.Body.Bytes()...),
		Source: FromOrigin,
	}
}

func newStoredResponse(req *http.Request, res Response, at time.Time) *storedResponse {
	varied := map[string]string{}
	for _, name := range varyNames(res.Header) {
		varied[name] = req.Header.Get(name)
	}
	return &storedResponse{
		status:   res.Status,
		header:   res.Header.Clone(),
		body:     append([]byte(nil), res.Body...),
		storedAt: at,
		varied:   varied,
	}
}

func (s *storedResponse) matches(req *http.Request) bool {
	for name, value := range s.varied {
		if name == "*" || req.Header.Get(name) != value {
			return false
		}
	}
	return true
}

func (s *storedResponse) response(source Source) Response {
	return Response{
		Status: s.status,
		Header: s.header.Clone(),
		Body:   append([]byte(nil), s.body...),
		Source: source,
	}
}

// freshnessLifetime follows RFC 9111 §4.2.1 for a private cache (s-maxage is
// for shared caches only).
func (s *storedResponse) freshnessLifetime(d directives) time.Duration {
	if maxAge, ok := d.seconds("max-age"); ok {
		return maxAge
	}
	if expires := s.header.Get("Expires"); expires != "" {
		expiry, err := http.ParseTime(expires)
		if err != nil {
			return 0
		}
		date, err := http.ParseTime(s.header.Get("Date"))
		if err != nil {
			date = s.storedAt
		}
		return expiry.Sub(date)
	}
	// §4.2.2 heuristic freshness: browsers grant a tenth of the time since
	// Last-Modified to a response that carries no explicit freshness.
	if modified, err := http.ParseTime(s.header.Get("Last-Modified")); err == nil && heuristicallyCacheable(s.status) {
		date, dateErr := http.ParseTime(s.header.Get("Date"))
		if dateErr != nil {
			date = s.storedAt
		}
		return date.Sub(modified) / 10
	}
	return 0
}

// storable follows RFC 9111 §3 for a private cache: no no-store, and either an
// explicit cacheability signal (public, private, max-age, Expires) or a status
// that is cacheable by default.
func storable(req *http.Request, res Response) bool {
	if req.Method != http.MethodGet || res.Status < 200 || res.Status == http.StatusNotModified {
		return false
	}
	d := parseCacheControl(res.Header)
	if d.has("no-store") {
		return false
	}
	_, maxAge := d.seconds("max-age")
	return maxAge || res.Header.Get("Expires") != "" || d.has("public") ||
		d.has("private") || heuristicallyCacheable(res.Status)
}

// heuristicallyCacheable lists the statuses RFC 9110 §15.1 makes cacheable by
// default.
func heuristicallyCacheable(status int) bool {
	switch status {
	case 200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501:
		return true
	}
	return false
}

func varyNames(h http.Header) []string {
	var names []string
	for _, value := range h.Values("Vary") {
		for _, name := range strings.Split(value, ",") {
			if name = strings.TrimSpace(name); name != "" {
				names = append(names, http.CanonicalHeaderKey(name))
			}
		}
	}
	return names
}

type directives map[string]string

func parseCacheControl(h http.Header) directives {
	out := directives{}
	for _, value := range h.Values("Cache-Control") {
		for _, part := range strings.Split(value, ",") {
			name, arg, _ := strings.Cut(strings.TrimSpace(part), "=")
			if name = strings.ToLower(strings.TrimSpace(name)); name != "" {
				out[name] = strings.Trim(strings.TrimSpace(arg), `"`)
			}
		}
	}
	return out
}

func (d directives) has(name string) bool {
	_, ok := d[name]
	return ok
}

// seconds reads a delta-seconds directive. A malformed value counts as
// present-but-zero, which RFC 9111 §1.2.2 treats as stale.
func (d directives) seconds(name string) (time.Duration, bool) {
	raw, ok := d[name]
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0, true
	}
	return time.Duration(n) * time.Second, true
}
