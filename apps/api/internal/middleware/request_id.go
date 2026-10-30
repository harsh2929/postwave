// SPDX-License-Identifier: AGPL-3.0-only

package middleware

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"fmt"
	"net/http"
	"sync/atomic"

	chimiddleware "github.com/go-chi/chi/v5/middleware"
)

// RequestID gives every request the id that logs and error envelopes carry,
// exactly where chi's middleware.RequestID puts it (chimiddleware.RequestIDKey,
// so chimiddleware.GetReqID and httperror keep working), in the same
// "<process prefix>-<counter>" shape.
//
// The difference is the prefix. chi derives it from os.Hostname(), which on
// the EC2 hosts the API runs on is "ip-172-31-36-118.us-west-2.compute.internal"
// — a private address and region that every 500 envelope then handed to the
// user, and every client printed in its error toast ("(request
// ip-172-31-36-118.us-west-2.compute.internal/wy1XmWewbl-014132)"). This
// prefix is random per process: it still groups one process's requests, and
// says nothing about where that process runs.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := inboundRequestID(r.Header.Get(chimiddleware.RequestIDHeader))
		if id == "" {
			id = fmt.Sprintf("%s-%06d", requestIDPrefix, requestIDCounter.Add(1))
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), chimiddleware.RequestIDKey, id)))
	})
}

var (
	requestIDPrefix  = newRequestIDPrefix()
	requestIDCounter atomic.Uint64
)

func newRequestIDPrefix() string {
	var b [10]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand does not fail on supported platforms; a fixed prefix is
		// still host-free, and the counter keeps ids unique within the process.
		return "req"
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b[:])[:12]
}

// maxInboundRequestIDBytes bounds a caller-supplied id. An upstream proxy or
// client may propagate its own id for correlation; anything longer, or
// outside a conservative charset, is replaced rather than echoed into logs and
// error envelopes.
const maxInboundRequestIDBytes = 128

func inboundRequestID(value string) string {
	if value == "" || len(value) > maxInboundRequestIDBytes {
		return ""
	}
	for _, c := range value {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '-', c == '_', c == '.', c == ':':
		default:
			return ""
		}
	}
	return value
}
