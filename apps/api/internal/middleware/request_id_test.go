// SPDX-License-Identifier: AGPL-3.0-only

package middleware

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"github.com/postwave/postwave/apps/api/internal/httperror"
)

var generatedRequestID = regexp.MustCompile(`^[A-Z2-7]{12}-\d{6,}$`)

func requestIDFor(t *testing.T, inbound string) string {
	t.Helper()
	var got string
	handler := RequestID(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got = chimiddleware.GetReqID(r.Context())
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if inbound != "" {
		req.Header.Set(chimiddleware.RequestIDHeader, inbound)
	}
	handler.ServeHTTP(httptest.NewRecorder(), req)
	return got
}

// Every 500 envelope carries the request id, and every client prints it. It
// must not describe the machine that served the request.
func TestAnInternalErrorEnvelopeDoesNotNameTheHost(t *testing.T) {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		t.Skip("no hostname to compare against")
	}
	handler := RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httperror.WriteInternal(w, nil, errors.New("database unavailable"), r.Context())
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/campaigns", nil))

	if !strings.Contains(rec.Body.String(), `"request_id"`) {
		t.Fatalf("envelope has no request id to correlate with logs: %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), hostname) {
		t.Fatalf("envelope names the host %q: %s", hostname, rec.Body.String())
	}
}

func TestGeneratedRequestIDsAreUniqueAndHostFree(t *testing.T) {
	first, second := requestIDFor(t, ""), requestIDFor(t, "")
	for _, id := range []string{first, second} {
		if !generatedRequestID.MatchString(id) {
			t.Fatalf("request id %q does not have the <prefix>-<counter> shape", id)
		}
	}
	if first == second {
		t.Fatalf("two requests got the same id %q", first)
	}
}

// A proxy or client may propagate its own id for correlation; a value that
// could smuggle markup, paths or unbounded text is replaced, not echoed.
func TestAnInboundRequestIDIsHonouredOnlyWhenSafe(t *testing.T) {
	if got := requestIDFor(t, "edge-7f3a:trace.01"); got != "edge-7f3a:trace.01" {
		t.Fatalf("safe inbound id replaced with %q", got)
	}
	for _, unsafe := range []string{
		"ip-172-31-36-118.us-west-2.compute.internal/abc-000001",
		"<script>alert(1)</script>",
		strings.Repeat("a", maxInboundRequestIDBytes+1),
	} {
		if got := requestIDFor(t, unsafe); got == unsafe || !generatedRequestID.MatchString(got) {
			t.Fatalf("inbound id %q was kept as %q, want a generated id", unsafe, got)
		}
	}
}
