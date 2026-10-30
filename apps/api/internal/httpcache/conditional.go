// SPDX-License-Identifier: AGPL-3.0-only
//
// conditional.go — chi-compatible middleware that turns a handler's
// fully-rendered response into a 304 Not Modified when the client's
// If-None-Match matches the resolved ETag.
//
// Why a buffering middleware instead of pushing ETag negotiation into
// every handler:
//
//   - The Tier A / Tier B helpers in etag.go let a handler short-
//     circuit early, but only the handlers that opted in actually do
//     so. Most GET endpoints just writeJSON() and return. Wrapping
//     them here covers the long tail without touching ~200 call
//     sites.
//   - The handler still runs (so we don't gain CPU back); we only
//     save bandwidth. That's an acceptable v1 trade — bandwidth is
//     the dominant per-request cost for the JSON payloads this
//     gateway serves, and skipping the handler would require an
//     in-process cache keyed by (tenant, route, query) we don't have
//     yet.
//
// The middleware only fires for GET and HEAD. Anything that mutates
// state must not be 304'd; per RFC 7232 §3.2 If-None-Match on PUT/
// POST is a precondition test for lost-update detection (412), which
// individual handlers already implement when relevant.
//
// If a handler already set ETag (e.g. newsletter_feed, podcast) we
// honor that tag instead of computing a fresh one — they have first-
// hand knowledge of the resource version and the weak hash here
// would just disagree.

package httpcache

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
)

// Conditional returns a middleware that buffers GET/HEAD responses,
// computes a weak ETag over the body if the handler didn't set one,
// and rewrites the response to 304 Not Modified when If-None-Match
// matches.
//
// Non-GET/HEAD requests, error responses (>=400), and SSE / chunked
// streams are passed through untouched. The 304 response retains
// only the headers a conditional response is allowed to carry per
// RFC 7232 §4.1: ETag, Cache-Control, Vary, Date.
func Conditional() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				next.ServeHTTP(w, r)
				return
			}
			bw := &bufferedWriter{
				ResponseWriter: w,
				headers:        http.Header{},
				status:         http.StatusOK,
			}
			next.ServeHTTP(bw, r)

			// Streaming handlers (SSE, chunked downloads) call Flush
			// or push their own Content-Encoding — we must not
			// retroactively rewrite them.
			if bw.streamed {
				bw.flushUnchanged(w)
				return
			}
			// Error responses or explicit no-store / no-cache —
			// don't interfere with the handler's caching intent.
			if bw.status >= 400 || hasNoStore(bw.headers) {
				bw.flushUnchanged(w)
				return
			}

			// Prefer the handler's own ETag; otherwise weak-hash the
			// rendered body. HEAD responses have no body to hash —
			// upstream handlers normally still emit the same headers
			// they would for GET, but if no ETag is present we have
			// nothing to negotiate and pass through.
			etag := strings.TrimSpace(bw.headers.Get("ETag"))
			if etag == "" {
				if r.Method == http.MethodHead || bw.buf.Len() == 0 {
					bw.flushUnchanged(w)
					return
				}
				etag = weakHashOfBytes(bw.buf.Bytes())
				bw.headers.Set("ETag", etag)
			}

			if ifNoneMatch := r.Header.Get("If-None-Match"); ifNoneMatch != "" &&
				matchesAnyWeak(ifNoneMatch, etag) {
				write304(w, bw.headers)
				return
			}
			bw.flushUnchanged(w)
		})
	}
}

// bufferedWriter intercepts WriteHeader / Write so we can inspect
// the rendered body before forwarding it. Streaming hints (Flush /
// Hijacker) flip the streamed flag and the buffered bytes are
// drained immediately.
type bufferedWriter struct {
	http.ResponseWriter
	headers     http.Header
	buf         bytes.Buffer
	status      int
	wroteHeader bool
	streamed    bool
}

func (b *bufferedWriter) Header() http.Header { return b.headers }

func (b *bufferedWriter) WriteHeader(code int) {
	if b.wroteHeader {
		return
	}
	b.status = code
	b.wroteHeader = true
}

func (b *bufferedWriter) Write(p []byte) (int, error) {
	if !b.wroteHeader {
		b.WriteHeader(http.StatusOK)
	}
	if b.streamed {
		return b.ResponseWriter.Write(p)
	}
	return b.buf.Write(p)
}

// Flush marks the response as streaming and forwards anything we
// already buffered. After this point Write goes straight to the
// underlying ResponseWriter; we cannot 304 it anymore.
//
// The flush itself goes through http.ResponseController so it walks every
// wrapper between here and net/http. Asserting http.Flusher on the next
// writer stopped at the first wrapper that did not declare Flush — the cost
// header writer did not — and every Server-Sent Events frame then waited in
// net/http's buffer until the write timeout closed the connection.
func (b *bufferedWriter) Flush() {
	if !b.streamed {
		b.streamed = true
		copyHeaders(b.ResponseWriter.Header(), b.headers)
		if b.wroteHeader {
			b.ResponseWriter.WriteHeader(b.status)
		}
		if b.buf.Len() > 0 {
			_, _ = b.ResponseWriter.Write(b.buf.Bytes())
			b.buf.Reset()
		}
	}
	_ = http.NewResponseController(b.ResponseWriter).Flush()
}

// Unwrap exposes the wrapped writer to http.ResponseController, so a
// streaming handler can move the write deadline. Flush stays declared here:
// the controller finds it first, which is what switches the buffer off.
func (b *bufferedWriter) Unwrap() http.ResponseWriter { return b.ResponseWriter }

func (b *bufferedWriter) flushUnchanged(w http.ResponseWriter) {
	if b.streamed {
		return
	}
	copyHeaders(w.Header(), b.headers)
	if b.wroteHeader {
		w.WriteHeader(b.status)
	}
	if b.buf.Len() > 0 {
		_, _ = w.Write(b.buf.Bytes())
	}
}

// write304 rewrites the response as 304 Not Modified, preserving
// only the headers RFC 7232 §4.1 allows. We deliberately drop
// Content-Length so net/http doesn't complain about the empty body.
func write304(w http.ResponseWriter, src http.Header) {
	dst := w.Header()
	for _, k := range []string{"ETag", "Cache-Control", "Vary", "Date", "Expires"} {
		if v := src.Get(k); v != "" {
			dst.Set(k, v)
		}
		// Vary can have multiple values; replay them all.
		if k == "Vary" {
			if vs := src.Values(k); len(vs) > 1 {
				dst.Del(k)
				for _, v := range vs {
					dst.Add(k, v)
				}
			}
		}
	}
	dst.Del("Content-Length")
	dst.Del("Content-Type")
	dst.Del("Content-Encoding")
	w.WriteHeader(http.StatusNotModified)
}

func copyHeaders(dst, src http.Header) {
	for k, vs := range src {
		dst.Del(k)
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}

func hasNoStore(h http.Header) bool {
	cc := strings.ToLower(h.Get("Cache-Control"))
	return strings.Contains(cc, "no-store")
}

// matchesAnyWeak parses an If-None-Match list and weak-compares each
// entry against etag. Per RFC 7232 §2.3.2 weak comparison strips the
// optional W/ prefix on BOTH sides before byte-equal comparison.
//
// A bare "*" in the list always matches (per RFC 7232 §3.2) — used
// by clients that want a 304 if any representation exists.
func matchesAnyWeak(ifNoneMatch, etag string) bool {
	want := stripWeak(etag)
	for _, raw := range strings.Split(ifNoneMatch, ",") {
		tok := strings.TrimSpace(raw)
		if tok == "" {
			continue
		}
		if tok == "*" {
			return true
		}
		if stripWeak(tok) == want {
			return true
		}
	}
	return false
}

func stripWeak(tag string) string {
	tag = strings.TrimSpace(tag)
	if strings.HasPrefix(tag, "W/") || strings.HasPrefix(tag, "w/") {
		return tag[2:]
	}
	return tag
}

// weakHashOfBytes mirrors ETagWeak but skips the JSON round-trip:
// the body has already been rendered, so we hash the wire bytes
// directly. Format stays compatible with ETagWeak (W/"sha256-…").
func weakHashOfBytes(body []byte) string {
	if len(body) == 0 {
		return `W/"empty"`
	}
	sum := sha256.Sum256(body)
	return `W/"sha256-` + hex.EncodeToString(sum[:])[:16] + `"`
}
