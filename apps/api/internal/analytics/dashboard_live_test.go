// SPDX-License-Identifier: AGPL-3.0-only

package analytics

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestDashboardLive_ContainsInternalFetchErrors(t *testing.T) {
	d := &LiveDeps{
		Fetch: func(context.Context, string) (*DashboardStats, error) {
			return nil, errors.New("private database host and query detail")
		},
	}
	ctx := middleware.WithTenant(
		context.Background(),
		&middleware.Tenant{
			ID:   "00000000-0000-0000-0000-000000000001",
			Slug: "test",
		},
	)
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/dashboard/live",
		nil,
	).WithContext(ctx)
	rec := httptest.NewRecorder()

	d.Handle(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, "event: error") ||
		!strings.Contains(body, "analytics_stream_unavailable") {
		t.Fatalf("missing stable stream failure event: %s", body)
	}
	if strings.Contains(body, "private database host") {
		t.Fatalf("internal error leaked into SSE body: %s", body)
	}
}

func TestDashboardLiveStatsOptionsMatchRichSnapshotDefaults(t *testing.T) {
	opts := dashboardLiveStatsOptions()
	if opts.Range != "30d" || !opts.Compare || !opts.Sparklines {
		t.Fatalf("dashboard live options = %+v, want rich 30d snapshot", opts)
	}
}

// TestDashboardLive_NoTenantReturns401 mirrors the SequenceFunnel test —
// a request without a resolved tenant should fall straight to 401 with
// the standard `no_tenant` error envelope, not start streaming.
func TestDashboardLive_NoTenantReturns401(t *testing.T) {
	d := &LiveDeps{
		Fetch: func(ctx context.Context, tenantID string) (*DashboardStats, error) {
			return &DashboardStats{}, nil
		},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/dashboard/live", nil)
	rec := httptest.NewRecorder()
	d.Handle(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestDashboardLive_HeadersAndStatsEvents asserts that:
//  1. SSE Content-Type is set on the wire.
//  2. At least 2 `event: stats` blocks emit within 5 seconds (the 2-tick
//     guarantee from the task spec — proves the polling loop ticks).
//  3. The payload body is valid JSON shaped like DashboardStats.
//
// We use httptest.NewServer (not NewRecorder) because httptest.Recorder
// buffers the entire response body until the handler returns, which
// would force the test to wait for MaxDuration to elapse before reading
// any frames. NewServer streams chunks like a real HTTP client.
func TestDashboardLive_HeadersAndStatsEvents(t *testing.T) {
	tick := uint64(0)
	d := &LiveDeps{
		Fetch: func(ctx context.Context, tenantID string) (*DashboardStats, error) {
			n := int(atomic.AddUint64(&tick, 1))
			return &DashboardStats{
				SubscribersTotal:    1234 + n,
				SubscribersAdded30d: 42,
			}, nil
		},
		PollInterval:      100 * time.Millisecond,
		HeartbeatInterval: 5 * time.Second,
		MaxDuration:       3 * time.Second,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{
			ID:   "00000000-0000-0000-0000-000000000001",
			Slug: "test",
		})
		d.Handle(w, r.WithContext(ctx))
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// 1. Content-Type header set to text/event-stream.
	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", got)
	}

	// 2. Read until we've seen >= 2 `event: stats` frames or the deadline
	//    fires. We read in small chunks so the assertion fails fast on a
	//    missing emit rather than hanging the whole timeout window.
	buf := make([]byte, 1024)
	var collected strings.Builder
	deadline := time.After(4500 * time.Millisecond)
	for {
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for stats events; got: %s",
				collected.String())
		default:
		}
		n, err := resp.Body.Read(buf)
		if n > 0 {
			collected.Write(buf[:n])
			if strings.Count(collected.String(), "event: stats") >= 2 {
				goto haveTwoEvents
			}
		}
		if err != nil {
			break
		}
	}
haveTwoEvents:
	got := collected.String()
	if c := strings.Count(got, "event: stats"); c < 2 {
		t.Fatalf("got %d `event: stats` blocks, want >=2; payload=%s", c, got)
	}
	// Each event must be followed by a `data:` line whose JSON contains
	// at least the subscribers_total field — proves the marshaller wired
	// the right struct, not just emitted an empty event header.
	if !strings.Contains(got, `"subscribers_total"`) {
		t.Fatalf("missing subscribers_total in stream payload: %s", got)
	}
}

// TestDashboardLive_ContextCancelExits asserts the handler unblocks
// within 200ms once the request context is cancelled. Without a
// ctx-aware select the handler would wait a full PollInterval before
// noticing — that's a goroutine leak under client churn.
func TestDashboardLive_ContextCancelExits(t *testing.T) {
	d := &LiveDeps{
		Fetch: func(ctx context.Context, tenantID string) (*DashboardStats, error) {
			return &DashboardStats{}, nil
		},
		// Long poll/heartbeat/max so neither timer fires during the test —
		// only ctx.Done can wake the loop.
		PollInterval:      30 * time.Second,
		HeartbeatInterval: 30 * time.Second,
		MaxDuration:       30 * time.Second,
	}

	ctx, cancel := context.WithCancel(middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001", Slug: "test"}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/dashboard/live", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		d.Handle(rec, req)
		close(done)
	}()

	// Let the initial-snapshot write happen + handler enter the select.
	time.Sleep(20 * time.Millisecond)
	cancel()

	select {
	case <-done:
		// pass
	case <-time.After(200 * time.Millisecond):
		t.Fatalf("handler did not exit within 200ms of ctx cancel")
	}
}

// TestDashboardLive_MaxDurationCaps asserts the 5-min wall-clock cap
// (here injected as 100ms) terminates the handler even when ctx stays
// open. Goroutine-leak prevention for clients that hold idle EventSource
// connections forever.
func TestDashboardLive_MaxDurationCaps(t *testing.T) {
	d := &LiveDeps{
		Fetch: func(ctx context.Context, tenantID string) (*DashboardStats, error) {
			return &DashboardStats{}, nil
		},
		PollInterval:      30 * time.Second,
		HeartbeatInterval: 30 * time.Second,
		MaxDuration:       100 * time.Millisecond,
	}
	ctx := middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001", Slug: "test"})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/dashboard/live", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	start := time.Now()
	d.Handle(rec, req)
	elapsed := time.Since(start)
	if elapsed > 500*time.Millisecond {
		t.Fatalf("handler ran %v, want <500ms (MaxDuration=100ms)", elapsed)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", got)
	}
	// Initial snapshot still writes a stats frame even on the cap path.
	if !strings.Contains(rec.Body.String(), "event: stats") {
		t.Fatalf("expected initial stats event before max-duration; body=%s", rec.Body.String())
	}
}
