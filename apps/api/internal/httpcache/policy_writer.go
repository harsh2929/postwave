// SPDX-License-Identifier: AGPL-3.0-only

package httpcache

import "net/http"

// errorUncacheableWriter is the response side of WithPolicy: it withdraws the
// policy's freshness stamp from an error response.
//
// The stamp is written before the handler runs, because only then can a
// handler still override it; but the status is decided later, often by a
// helper (httperror.Write, a reverse proxy's ErrorHandler) that knows nothing
// about caching. So the decision is taken here, at the one moment the final
// status is known: if the status is an error and Cache-Control is still exactly
// what the policy stamped, the stamp is replaced with "private, no-store". A
// handler that chose its own error caching has changed the header, and keeps
// its choice.
//
// The wrapper must not cost a streaming handler anything. Flush is forwarded
// through http.NewResponseController, which reaches past writers that only
// expose Unwrap, and Unwrap lets that same controller find the connection for
// write deadlines and hijacking.
type errorUncacheableWriter struct {
	http.ResponseWriter
	// stamped is the Cache-Control value the policy wrote.
	stamped string
	// wroteHeader records that the final status is decided; a later
	// (superfluous) WriteHeader must not rewrite the headers of a response
	// that is already on its way.
	wroteHeader bool
}

func newErrorUncacheableWriter(w http.ResponseWriter, stamped string) *errorUncacheableWriter {
	return &errorUncacheableWriter{ResponseWriter: w, stamped: stamped}
}

func (w *errorUncacheableWriter) WriteHeader(code int) {
	// 1xx responses are interim (103 Early Hints); the final status follows.
	if !w.wroteHeader && code >= http.StatusOK {
		w.wroteHeader = true
		if code >= http.StatusBadRequest && cacheControl(w.Header()) == w.stamped {
			w.Header().Set("Cache-Control", noStoreDirective)
		}
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *errorUncacheableWriter) Write(p []byte) (int, error) {
	// A Write without WriteHeader is an implicit 200.
	w.wroteHeader = true
	return w.ResponseWriter.Write(p)
}

// FlushError is the flush http.NewResponseController prefers: it reports
// whether the bytes could be pushed, where Flush has to swallow the answer.
func (w *errorUncacheableWriter) FlushError() error {
	// Flushing commits the status net/http has by then (an implicit 200).
	w.wroteHeader = true
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *errorUncacheableWriter) Flush() {
	_ = w.FlushError()
}

// Unwrap exposes the underlying writer to http.NewResponseController.
func (w *errorUncacheableWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}
