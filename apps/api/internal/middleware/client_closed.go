// SPDX-License-Identifier: AGPL-3.0-only

package middleware

import (
	"context"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// ClientClosedRequests answers 499 in place of any server error written after
// the client closed the request, and 499 when a handler returns without
// answering a request the client closed.
//
// When a browser cancels a request (the segment builder superseding a count,
// a tab closing, a navigation), net/http cancels the request's context and
// whatever the handler was doing fails with that cancellation. Handlers then
// answer the way they answer any failure: WriteInternal's 500, the MFA gate's
// 503 "policy could not be verified", a repository's 503. Each of those went
// to the access log and to pw_http_requests_total as a 5xx, and to the load
// balancer as a target 5xx, although no client was there to receive it and
// nothing on the server was wrong. On staging that was about a third of all
// 5xx.
//
// Rewriting at the writer, rather than in each handler, covers every writer
// at once, including ones added later. The decision is made at the moment the
// status is written: if the client had already gone by then, the answer was
// for nobody. A server error written while the client was still connected is
// recorded as the server error it is, and a server-side timeout ends the
// context with DeadlineExceeded, which never matches.
//
// Mount it at the root, INSIDE the access log and HTTPRequestMetrics, so both
// record the status actually sent. jsonRecoverer sits outside it on purpose: a
// panic is a server fault whether or not the client stayed, so its 500 is
// never rewritten.
func ClientClosedRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cw := &clientClosedWriter{ResponseWriter: w, ctx: r.Context()}
		next.ServeHTTP(cw, r)
		if !cw.wroteHeader && httperror.ClientClosedRequest(r.Context()) {
			// net/http would otherwise send an implicit 200 for a request the
			// handler abandoned because the client left.
			cw.ResponseWriter.WriteHeader(httperror.StatusClientClosedRequest)
		}
	})
}

// clientClosedWriter applies httperror.ClientClosedStatus to the final status.
// Like the metrics recorder above it, it declares Flush and Unwrap so event
// streams keep flushing and http.ResponseController still reaches net/http.
type clientClosedWriter struct {
	http.ResponseWriter
	ctx         context.Context
	wroteHeader bool
}

func (c *clientClosedWriter) WriteHeader(code int) {
	// 1xx responses are informational and not final; let them through and
	// wait for the real status.
	if !c.wroteHeader && code >= http.StatusOK {
		c.wroteHeader = true
		code = httperror.ClientClosedStatus(c.ctx, code)
	}
	c.ResponseWriter.WriteHeader(code)
}

func (c *clientClosedWriter) Write(b []byte) (int, error) {
	c.wroteHeader = true
	return c.ResponseWriter.Write(b)
}

// Flush commits an implicit 200 just as Write does.
func (c *clientClosedWriter) Flush() {
	c.wroteHeader = true
	_ = http.NewResponseController(c.ResponseWriter).Flush()
}

// Unwrap exposes the wrapped writer to http.ResponseController.
func (c *clientClosedWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }
