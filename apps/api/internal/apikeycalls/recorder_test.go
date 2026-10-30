// SPDX-License-Identifier: AGPL-3.0-only
//
// recorder_test.go — exercises the bounded async sink that replaces
// the original per-request goroutine fan-out in RecorderMiddleware.
// The full middleware integration (HTTP -> Enqueue -> Insert) is
// covered by the existing _db_test.go guarded paths; these tests
// just lock down the bounded-buffer + worker-pool contract.

package apikeycalls

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// stubSink is a deterministic recorderSink — counts calls and can be
// configured with a fixed per-call delay so tests can drive the
// worker pool into back-pressure on demand.
type stubSink struct {
	mu       sync.Mutex
	count    int
	delay    time.Duration
	failNext bool
}

type captureSink struct {
	mu   sync.Mutex
	call *Call
}

func (s *captureSink) Insert(_ context.Context, c *Call) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := *c
	s.call = &copy
	return nil
}

func (s *captureSink) captured() *Call {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.call == nil {
		return nil
	}
	copy := *s.call
	return &copy
}

func (s *stubSink) Insert(ctx context.Context, c *Call) error {
	if s.delay > 0 {
		select {
		case <-time.After(s.delay):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.mu.Lock()
	s.count++
	s.mu.Unlock()
	return nil
}

func (s *stubSink) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.count
}

func waitFor(d time.Duration, pred func() bool) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if pred() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return pred()
}

func TestRecorder_NilSafe(t *testing.T) {
	var r *Recorder
	if r.Enqueue(Call{TenantID: "t"}) {
		t.Fatal("nil recorder should not report queued")
	}
	if r.QueueDepth() != 0 {
		t.Fatal("nil QueueDepth should be 0")
	}
	r.Close() // must not panic
}

func TestRecorder_HappyPath(t *testing.T) {
	oldBuf, oldWorkers := RecorderBufferSize, RecorderWorkers
	RecorderBufferSize, RecorderWorkers = 64, 2
	defer func() { RecorderBufferSize, RecorderWorkers = oldBuf, oldWorkers }()

	sink := &stubSink{}
	r := NewRecorder(sink, nil)
	defer r.Close()

	const n = 20
	for i := 0; i < n; i++ {
		if !r.Enqueue(Call{TenantID: "t1", Method: "GET", Path: "/x"}) {
			t.Fatalf("Enqueue %d returned false under steady state", i)
		}
	}
	if !waitFor(2*time.Second, func() bool { return sink.callCount() == n }) {
		t.Fatalf("expected %d sink calls, got %d", n, sink.callCount())
	}
}

func TestRecorder_DropsWhenBufferFull(t *testing.T) {
	// Tiny buffer + single slow worker so we deterministically
	// over-fill the channel.
	oldBuf, oldWorkers := RecorderBufferSize, RecorderWorkers
	RecorderBufferSize, RecorderWorkers = 2, 1
	defer func() { RecorderBufferSize, RecorderWorkers = oldBuf, oldWorkers }()

	sink := &stubSink{delay: 200 * time.Millisecond}
	r := NewRecorder(sink, nil)
	defer r.Close()

	var drops atomic.Int32
	for i := 0; i < 50; i++ {
		if !r.Enqueue(Call{TenantID: "t1"}) {
			drops.Add(1)
		}
	}
	if drops.Load() == 0 {
		t.Fatalf("expected drops under buffer pressure, got 0")
	}
}

func TestRecorder_CloseDrains(t *testing.T) {
	oldBuf, oldWorkers := RecorderBufferSize, RecorderWorkers
	RecorderBufferSize, RecorderWorkers = 32, 2
	defer func() { RecorderBufferSize, RecorderWorkers = oldBuf, oldWorkers }()

	sink := &stubSink{}
	r := NewRecorder(sink, nil)

	const n = 25
	for i := 0; i < n; i++ {
		r.Enqueue(Call{TenantID: "t1"})
	}
	r.Close() // blocks until drained or RecorderShutdownTimeout
	if got := sink.callCount(); got != n {
		t.Fatalf("expected %d calls after Close, got %d", n, got)
	}
}

func TestRecorder_EnqueueAfterClose(t *testing.T) {
	oldBuf, oldWorkers := RecorderBufferSize, RecorderWorkers
	RecorderBufferSize, RecorderWorkers = 8, 1
	defer func() { RecorderBufferSize, RecorderWorkers = oldBuf, oldWorkers }()

	sink := &stubSink{}
	r := NewRecorder(sink, nil)
	r.Close()
	if r.Enqueue(Call{TenantID: "t1"}) {
		t.Fatal("Enqueue after Close should return false (must not panic on closed channel)")
	}
}

func TestRecorder_ConcurrentCloseAndEnqueueDoesNotPanic(t *testing.T) {
	oldBuf, oldWorkers := RecorderBufferSize, RecorderWorkers
	RecorderBufferSize, RecorderWorkers = 256, 2
	defer func() { RecorderBufferSize, RecorderWorkers = oldBuf, oldWorkers }()

	r := NewRecorder(&stubSink{}, nil)
	start := make(chan struct{})
	var producers sync.WaitGroup
	for i := 0; i < 32; i++ {
		producers.Add(1)
		go func() {
			defer producers.Done()
			<-start
			for attempt := 0; attempt < 250; attempt++ {
				_ = r.Enqueue(Call{TenantID: "t1"})
			}
		}()
	}
	close(start)
	r.Close()
	producers.Wait()
	// Close is idempotent and must remain safe after concurrent producers
	// observe the closed state.
	r.Close()
}

func TestRecorderMiddlewarePersistsOnlyMinimizedRequestMetadata(t *testing.T) {
	oldBuf, oldWorkers := RecorderBufferSize, RecorderWorkers
	RecorderBufferSize, RecorderWorkers = 8, 1
	defer func() { RecorderBufferSize, RecorderWorkers = oldBuf, oldWorkers }()

	sink := &captureSink{}
	recorder := NewRecorder(sink, nil)
	defer recorder.Close()
	router := chi.NewRouter()
	router.Use(RecorderMiddleware(recorder))
	router.Post("/api/v1/subscribers/{id}", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusNoContent)
	})

	body := `{"email":"person@example.test","password":"super-secret","subject":"private subject"}`
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/subscribers/recipient-secret?stream_token=url-secret&email=person%40example.test",
		strings.NewReader(body),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "postwave-mcp-server/1.2.3 private-host-fingerprint")
	request.Header.Set(McpToolHeader, "person@example.test")
	request.Header.Set("X-Forwarded-For", "203.0.113.99")
	request.RemoteAddr = "198.51.100.20:4567"
	ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-1"})
	ctx = middleware.WithAPIKeyAuth(ctx)
	router.ServeHTTP(httptest.NewRecorder(), request.WithContext(ctx))

	if !waitFor(time.Second, func() bool { return sink.captured() != nil }) {
		t.Fatal("recorder did not persist call")
	}
	call := sink.captured()
	if call.Path != "/api/v1/subscribers/{id}" {
		t.Fatalf("path=%q", call.Path)
	}
	if call.QueryString != "key_count=2" {
		t.Fatalf("query summary=%q", call.QueryString)
	}
	if call.UserAgent != "postwave-mcp-server/1.2.3" || call.RemoteIP != "" {
		t.Fatalf("ua/ip not minimized: ua=%q ip=%q", call.UserAgent, call.RemoteIP)
	}
	if call.ToolName != "post:subscribers" {
		t.Fatalf("untrusted tool label persisted: %q", call.ToolName)
	}
	metadata := string(call.RequestBody)
	for _, secret := range []string{"person@example.test", "super-secret", "private subject", "url-secret", "recipient-secret"} {
		if strings.Contains(metadata+call.Path+call.QueryString+call.UserAgent+call.RemoteIP+call.ToolName, secret) {
			t.Fatalf("secret %q survived minimized recorder row: %+v", secret, call)
		}
	}
}
