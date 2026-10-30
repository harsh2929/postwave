// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// Staging logged about a third of its 5xx for requests nobody was waiting
// for: the segment builder superseding a count, a page closing mid-load. Each
// cancelled request failed with its own cancellation ("db: begin tx: context
// canceled"), and the handler answered as for any failure. WriteInternal
// logged ERROR http.internal_error and sent 500; the MFA gate, unable to read
// the policy on a cancelled context, sent 503. The access log, the
// pw_http_requests_total 5xx series behind the release alert, and the load
// balancer's target-5xx count all recorded server errors.
//
// These tests drive the real root chain (useRootMiddleware, as run() composes
// it) over a real connection that the client really closes.

// clientClosedLog is a goroutine-safe sink for the JSON logger shared by the
// access log and the handlers.
type clientClosedLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *clientClosedLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *clientClosedLog) records(t *testing.T) []map[string]any {
	t.Helper()
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(l.buf.String()), "\n") {
		if line == "" {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("log line is not JSON: %q: %v", line, err)
		}
		out = append(out, rec)
	}
	return out
}

// accessLog waits for the access-log record of the request to path.
func (l *clientClosedLog) accessLog(t *testing.T, path string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, rec := range l.records(t) {
			if rec["msg"] == "http.request" && rec["path"] == path {
				return rec
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no access-log record for %s", path)
	return nil
}

// forRequest returns every record carrying the request id.
func (l *clientClosedLog) forRequest(t *testing.T, requestID string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, rec := range l.records(t) {
		if rec["request_id"] == requestID {
			out = append(out, rec)
		}
	}
	return out
}

type clientClosedHarness struct {
	server *httptest.Server
	log    *clientClosedLog
	logger *slog.Logger
	router chi.Router
	// entered is signalled by a handler once it is running, so the client
	// cancels while the handler is in flight rather than before it starts.
	entered chan struct{}
}

func newClientClosedHarness(t *testing.T) *clientClosedHarness {
	t.Helper()
	sink := &clientClosedLog{}
	logger := slog.New(slog.NewJSONHandler(sink, &slog.HandlerOptions{Level: slog.LevelDebug}))
	router := chi.NewRouter()
	useRootMiddleware(router, logger, config.Config{}, nil)
	return &clientClosedHarness{log: sink, logger: logger, router: router, entered: make(chan struct{}, 1)}
}

func (h *clientClosedHarness) start(t *testing.T) {
	t.Helper()
	h.server = httptest.NewServer(h.router)
	t.Cleanup(h.server.Close)
}

// cancelMidRequest sends GET path, waits until the handler is running, then
// closes the request from the client side, as a browser does when a fetch is
// aborted.
func (h *clientClosedHarness) cancelMidRequest(t *testing.T, path string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		resp, err := h.server.Client().Do(req)
		if resp != nil {
			_ = resp.Body.Close()
		}
		done <- err
	}()
	select {
	case <-h.entered:
	case <-time.After(3 * time.Second):
		t.Fatalf("handler for %s never started", path)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("client request error = %v, want context.Canceled", err)
	}
}

// get sends GET path and returns the status and body the client received.
func (h *clientClosedHarness) get(t *testing.T, path string) (int, string) {
	t.Helper()
	resp, err := h.server.Client().Get(h.server.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func requestsByClass(route, class string) float64 {
	return testutil.ToFloat64(observability.HTTPRequestsTotal.WithLabelValues(http.MethodGet, class, route))
}

func accessStatus(t *testing.T, rec map[string]any) int {
	t.Helper()
	status, ok := rec["status"].(float64)
	if !ok {
		t.Fatalf("access log has no numeric status: %v", rec)
	}
	return int(status)
}

func requireNoErrorRecord(t *testing.T, records []map[string]any) {
	t.Helper()
	for _, rec := range records {
		if rec["level"] == "ERROR" {
			t.Fatalf("a request the client closed was logged at ERROR: %v", rec)
		}
	}
}

func requireErrorRecord(t *testing.T, records []map[string]any, errContains string) {
	t.Helper()
	for _, rec := range records {
		if rec["level"] == "ERROR" && rec["msg"] == "http.internal_error" {
			if got, _ := rec["err"].(string); strings.Contains(got, errContains) {
				return
			}
		}
	}
	t.Fatalf("no ERROR http.internal_error carrying %q in %v", errContains, records)
}

func TestClientClosedRequestIsRecordedAs499NotAServerError(t *testing.T) {
	const route = "/api/v1/test/client-closed/internal"
	h := newClientClosedHarness(t)
	// A DB-backed handler whose transaction begins after the client left: the
	// shape of POST /api/v1/segments/preview when the builder supersedes a
	// count, and of list-health and subscribers on a closed page.
	h.router.Get(route, func(w http.ResponseWriter, r *http.Request) {
		h.entered <- struct{}{}
		<-r.Context().Done()
		httperror.WriteInternal(w, h.logger, fmt.Errorf("db: begin tx: %w", r.Context().Err()), r.Context())
	})
	h.start(t)
	before4xx, before5xx := requestsByClass(route, "4xx"), requestsByClass(route, "5xx")

	h.cancelMidRequest(t, route)

	access := h.log.accessLog(t, route)
	if got := accessStatus(t, access); got != httperror.StatusClientClosedRequest {
		t.Fatalf("access log status = %d, want 499", got)
	}
	records := h.log.forRequest(t, access["request_id"].(string))
	requireNoErrorRecord(t, records)
	var noted bool
	for _, rec := range records {
		if rec["msg"] == "http.client_closed_request" && rec["level"] == "INFO" &&
			rec["err"] == "db: begin tx: context canceled" {
			noted = true
		}
	}
	if !noted {
		t.Fatalf("the cancellation's cause was not kept at INFO: %v", records)
	}
	if got := requestsByClass(route, "5xx") - before5xx; got != 0 {
		t.Fatalf("pw_http_requests_total 5xx grew by %v for a request the client closed", got)
	}
	if got := requestsByClass(route, "4xx") - before4xx; got != 1 {
		t.Fatalf("pw_http_requests_total 4xx grew by %v, want 1", got)
	}
}

func TestServerErrorWrittenAfterTheClientLeftIsRecordedAs499(t *testing.T) {
	const route = "/api/v1/test/client-closed/unavailable"
	h := newClientClosedHarness(t)
	// Not every failure goes through WriteInternal. The MFA gate answers 503
	// mfa_policy_unavailable when its policy lookup fails, and it failed on
	// staging because the lookup ran on a cancelled context.
	h.router.Get(route, func(w http.ResponseWriter, r *http.Request) {
		h.entered <- struct{}{}
		<-r.Context().Done()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":{"code":"mfa_policy_unavailable","message":"MFA policy could not be verified"}}`))
	})
	h.start(t)
	before4xx, before5xx := requestsByClass(route, "4xx"), requestsByClass(route, "5xx")

	h.cancelMidRequest(t, route)

	if got := accessStatus(t, h.log.accessLog(t, route)); got != httperror.StatusClientClosedRequest {
		t.Fatalf("access log status = %d, want 499", got)
	}
	if got := requestsByClass(route, "5xx") - before5xx; got != 0 {
		t.Fatalf("pw_http_requests_total 5xx grew by %v for a request the client closed", got)
	}
	if got := requestsByClass(route, "4xx") - before4xx; got != 1 {
		t.Fatalf("pw_http_requests_total 4xx grew by %v, want 1", got)
	}
}

func TestRequestAbandonedWithoutAnswerIsRecordedAs499(t *testing.T) {
	const route = "/api/v1/test/client-closed/abandoned"
	h := newClientClosedHarness(t)
	h.router.Get(route, func(_ http.ResponseWriter, r *http.Request) {
		h.entered <- struct{}{}
		<-r.Context().Done()
	})
	h.start(t)
	before2xx := requestsByClass(route, "2xx")

	h.cancelMidRequest(t, route)

	if got := accessStatus(t, h.log.accessLog(t, route)); got != httperror.StatusClientClosedRequest {
		t.Fatalf("access log status = %d, want 499", got)
	}
	if got := requestsByClass(route, "2xx") - before2xx; got != 0 {
		t.Fatalf("an abandoned request was counted as 2xx (%v)", got)
	}
}

func TestGenuineServerErrorIsStill500AndLoggedAsError(t *testing.T) {
	const route = "/api/v1/test/client-closed/genuine"
	h := newClientClosedHarness(t)
	h.router.Get(route, func(w http.ResponseWriter, r *http.Request) {
		httperror.WriteInternal(w, h.logger, errors.New(`db: relation "segments" does not exist`), r.Context())
	})
	h.start(t)
	before5xx := requestsByClass(route, "5xx")

	status, body := h.get(t, route)

	if status != http.StatusInternalServerError || !strings.Contains(body, `"internal_error"`) {
		t.Fatalf("client got %d %s, want 500 internal_error", status, body)
	}
	access := h.log.accessLog(t, route)
	if got := accessStatus(t, access); got != http.StatusInternalServerError {
		t.Fatalf("access log status = %d, want 500", got)
	}
	requireErrorRecord(t, h.log.forRequest(t, access["request_id"].(string)), "does not exist")
	if got := requestsByClass(route, "5xx") - before5xx; got != 1 {
		t.Fatalf("pw_http_requests_total 5xx grew by %v, want 1", got)
	}
}

func TestServerSideTimeoutIsStill500AndLoggedAsError(t *testing.T) {
	const route = "/api/v1/test/client-closed/timeout"
	h := newClientClosedHarness(t)
	// Our own deadline expiring is a server problem even though it, too,
	// ends a context. The client is still connected and waiting.
	h.router.Get(route, func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Millisecond)
		defer cancel()
		<-ctx.Done()
		httperror.WriteInternal(w, h.logger, fmt.Errorf("db: begin tx: %w", ctx.Err()), ctx)
	})
	h.start(t)
	before5xx := requestsByClass(route, "5xx")

	status, _ := h.get(t, route)

	if status != http.StatusInternalServerError {
		t.Fatalf("client got %d, want 500 for a server-side timeout", status)
	}
	access := h.log.accessLog(t, route)
	if got := accessStatus(t, access); got != http.StatusInternalServerError {
		t.Fatalf("access log status = %d, want 500", got)
	}
	requireErrorRecord(t, h.log.forRequest(t, access["request_id"].(string)), "context deadline exceeded")
	if got := requestsByClass(route, "5xx") - before5xx; got != 1 {
		t.Fatalf("pw_http_requests_total 5xx grew by %v, want 1", got)
	}
}

func TestPanicAfterTheClientLeftIsStill500(t *testing.T) {
	const route = "/api/v1/test/client-closed/panic"
	h := newClientClosedHarness(t)
	// A panic is a server fault whether or not anyone is waiting for the
	// answer. jsonRecoverer sits outside ClientClosedRequests, so its 500 is
	// never rewritten.
	h.router.Get(route, func(_ http.ResponseWriter, r *http.Request) {
		h.entered <- struct{}{}
		<-r.Context().Done()
		panic("send on closed channel")
	})
	h.start(t)

	h.cancelMidRequest(t, route)

	access := h.log.accessLog(t, route)
	if got := accessStatus(t, access); got != http.StatusInternalServerError {
		t.Fatalf("access log status = %d, want 500 for a panic", got)
	}
	var logged bool
	for _, rec := range h.log.forRequest(t, access["request_id"].(string)) {
		if rec["level"] == "ERROR" && rec["msg"] == "panic recovered" {
			logged = true
		}
	}
	if !logged {
		t.Fatal("the panic was not logged at ERROR")
	}
}
