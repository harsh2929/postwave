// SPDX-License-Identifier: AGPL-3.0-only
//
// action_webhook_test.go — regression tests for the Phase-0 fix
// p0-inbound-routes-double-emit.
//
// Before the fix, doWebhook delegated through a trio of helpers
// (doWebhookRich -> doWebhookWithCapture -> doWebhookEmitWithResp ->
// doWebhook). Each "rich" layer was capable of re-emitting the
// outbound HTTP POST while the layer above also emitted, so a single
// matched route could deliver a webhook up to 2× the intended count
// per attempt — and combined with the per-route retry budget, an
// ActionRetryMax=3 route could emit up to 6 POSTs for one match.
//
// The fix collapses all three helpers into a single doWebhook
// executor that returns (status, snippet, error). These tests assert:
//
//   1. doWebhook performs EXACTLY ONE HTTP POST per call.
//   2. The captured status reflects the real upstream response (not
//      hard-coded 200) and a non-empty body snippet is recorded.
//   3. executeWithRetry honours the retry budget LINEARLY — exactly
//      N POSTs for N attempts, no doubling.

package inbound_email

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// newTestDeps returns an ActionDeps with the test http.Client wired in
// so requests hit the local httptest.Server without the SSRF-safe
// transport refusing 127.0.0.1.
func newTestDeps(client *http.Client) *ActionDeps {
	return &ActionDeps{HTTP: client}
}

// TestDoWebhook_SingleEmitPerCall asserts the executor performs
// exactly one outbound POST per invocation. This is the core
// regression — the prior helper-chain could fire two POSTs per call.
func TestDoWebhook_SingleEmitPerCall(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	deps := newTestDeps(srv.Client())
	route := Route{ID: "r1", Name: "r1"}
	act := RouteAction{Kind: "webhook", URL: srv.URL}
	email := Email{From: "a@b", To: "c@d", Subject: "s"}

	status, snippet, err := deps.doWebhook(context.Background(),
		"00000000-0000-0000-0000-000000000001", route, act, email, 7)
	if err != nil {
		t.Fatalf("doWebhook err: %v", err)
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("expected exactly 1 POST, got %d", got)
	}
	if status != 200 {
		t.Errorf("expected captured status 200, got %d", status)
	}
	if snippet == "" {
		t.Errorf("expected a non-empty response snippet, got empty")
	}
}

// TestDoWebhook_SurfacesRealUpstreamStatus locks in that the captured
// httpStatus reflects what the upstream actually replied (e.g. 500),
// not the hard-coded "200 on success / 0 on error" the prior code
// returned.
func TestDoWebhook_SurfacesRealUpstreamStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"err":"boom"}`))
	}))
	defer srv.Close()

	deps := newTestDeps(srv.Client())
	route := Route{ID: "r1", Name: "r1"}
	act := RouteAction{Kind: "webhook", URL: srv.URL}
	email := Email{From: "a@b", To: "c@d", Subject: "s"}

	status, snippet, err := deps.doWebhook(context.Background(),
		"00000000-0000-0000-0000-000000000001", route, act, email, 7)
	if err == nil {
		t.Fatalf("expected error on 500 upstream, got nil")
	}
	if status != http.StatusInternalServerError {
		t.Errorf("expected status 500, got %d", status)
	}
	if snippet == "" {
		t.Errorf("expected snippet captured on 500, got empty")
	}
}

// TestExecuteOneRich_WebhookSingleEmit verifies the dispatch layer
// used by executeWithRetry only invokes the upstream once per attempt
// — the runResult is populated by lifting (status, snippet, err) out
// of doWebhook, NOT by issuing a second POST to capture the body.
func TestExecuteOneRich_WebhookSingleEmit(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`accepted`))
	}))
	defer srv.Close()

	deps := newTestDeps(srv.Client())
	route := Route{ID: "r1", Name: "r1"}
	act := RouteAction{Kind: "webhook", URL: srv.URL}
	email := Email{From: "a@b", To: "c@d", Subject: "s"}

	res := deps.executeOneRich(context.Background(),
		"00000000-0000-0000-0000-000000000001", route, act, email, 7)
	if res.err != nil {
		t.Fatalf("executeOneRich err: %v", res.err)
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("expected exactly 1 POST from executeOneRich, got %d", got)
	}
	if res.httpStatus != http.StatusAccepted {
		t.Errorf("expected httpStatus=202 to flow through, got %d", res.httpStatus)
	}
	if res.responseSnippet == "" {
		t.Errorf("expected snippet to flow through, got empty")
	}
}

// TestExecuteWithRetry_NoDoubleEmit is the primary regression for the
// double-emit bug. With ActionRetryMax=2 (i.e. up to 3 attempts) and
// an upstream that always returns 500, we must see EXACTLY 3 POSTs —
// not 6 — and the recorded attempts count must equal the POST count.
//
// Pre-fix this test would see 6 POSTs because each attempt fired
// through both the "rich" capture path and the original doWebhook.
func TestExecuteWithRetry_NoDoubleEmit(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`fail`))
	}))
	defer srv.Close()

	deps := newTestDeps(srv.Client())
	route := Route{
		ID:                        "r1",
		Name:                      "r1",
		ActionRetryMax:            2, // 1 initial + 2 retries = 3 attempts
		ActionRetryBackoffSeconds: 1,
	}
	act := RouteAction{Kind: "webhook", URL: srv.URL}
	email := Email{From: "a@b", To: "c@d", Subject: "s"}

	// Bound the test runtime — backoff 1s + 2s between attempts.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, attempts := deps.executeWithRetry(ctx,
		"00000000-0000-0000-0000-000000000001", route, act, email, 7)
	if res.err == nil {
		t.Fatalf("expected error after all retries failed, got nil")
	}
	if attempts != 3 {
		t.Fatalf("expected 3 attempts, got %d", attempts)
	}
	if got := atomic.LoadInt32(&hits); got != 3 {
		t.Fatalf("expected exactly 3 POSTs (one per attempt), got %d — "+
			"double-emit regression?", got)
	}
	if res.httpStatus != http.StatusInternalServerError {
		t.Errorf("expected last attempt's real upstream status (500), got %d",
			res.httpStatus)
	}
}

// TestExecuteWithRetry_SucceedsOnRetry locks in the happy retry path:
// upstream fails on attempt 1, succeeds on attempt 2 — we see exactly
// 2 POSTs (one per attempt, no duplication) and the final runResult
// surfaces the 200 status.
func TestExecuteWithRetry_SucceedsOnRetry(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&hits, 1)
		if n == 1 {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`first-fail`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`ok`))
	}))
	defer srv.Close()

	deps := newTestDeps(srv.Client())
	route := Route{
		ID:                        "r1",
		Name:                      "r1",
		ActionRetryMax:            3,
		ActionRetryBackoffSeconds: 1,
	}
	act := RouteAction{Kind: "webhook", URL: srv.URL}
	email := Email{From: "a@b", To: "c@d", Subject: "s"}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, attempts := deps.executeWithRetry(ctx,
		"00000000-0000-0000-0000-000000000001", route, act, email, 7)
	if res.err != nil {
		t.Fatalf("expected nil err after retry success, got %v", res.err)
	}
	if attempts != 2 {
		t.Fatalf("expected exactly 2 attempts, got %d", attempts)
	}
	if got := atomic.LoadInt32(&hits); got != 2 {
		t.Fatalf("expected exactly 2 POSTs, got %d", got)
	}
	if res.httpStatus != http.StatusOK {
		t.Errorf("expected final status 200, got %d", res.httpStatus)
	}
}
