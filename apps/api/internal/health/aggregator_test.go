// SPDX-License-Identifier: AGPL-3.0-only
package health

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakePool captures the SQL the aggregator emits without standing up
// pgxpool.
type fakePool struct {
	mu         sync.Mutex
	statements []fakeExec
	failOn     string // substring; if set, Exec for matching SQL returns an error
}

type fakeExec struct {
	sql  string
	args []any
}

func (f *fakePool) Exec(_ context.Context, sql string, args ...any) (pgxExecResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statements = append(f.statements, fakeExec{sql: sql, args: args})
	if f.failOn != "" && contains(sql, f.failOn) {
		return nil, errors.New("forced fail")
	}
	return nil, nil
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func (f *fakePool) inserts() []fakeExec {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []fakeExec{}
	for _, s := range f.statements {
		if contains(s.sql, "INSERT INTO service_health_pings") {
			out = append(out, s)
		}
	}
	return out
}

func TestParseTargets(t *testing.T) {
	cases := []struct {
		name  string
		raw   string
		count int
	}{
		{"empty", "", 0},
		{"single", "api=http://localhost:8080/health", 1},
		{"multi", "api=http://a/health,voice=http://v/health", 2},
		{"trailing comma", "api=http://a/health,", 1},
		{"malformed", "api=http://a/health,bad-pair,voice=http://v", 2},
		{"dup", "api=http://a/health,api=http://x/health", 1},
		{"whitespace", "  api = http://a/health , voice = http://v/health ", 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ParseTargets(c.raw)
			if len(got) != c.count {
				t.Fatalf("ParseTargets(%q) = %d targets, want %d (%+v)", c.raw, len(got), c.count, got)
			}
		})
	}
}

func TestClassifyBody(t *testing.T) {
	cases := []struct {
		body string
		want Status
	}{
		{"", StatusOK},
		{`{"status":"ok"}`, StatusOK},
		{`{"status":"healthy"}`, StatusOK},
		{`{"status":"degraded"}`, StatusDegraded},
		{`{"status":"warning"}`, StatusDegraded},
		{`{"status":"down"}`, StatusDown},
		{`{"status":"failed"}`, StatusDown},
		{`{"foo":"bar"}`, StatusOK},
		{"OK", StatusOK},
		{"plain text", StatusOK},
	}
	for _, c := range cases {
		if got := classifyBody([]byte(c.body)); got != c.want {
			t.Errorf("classifyBody(%q) = %s, want %s", c.body, got, c.want)
		}
	}
}

func TestAggregatorProbeHealthy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()

	a := NewAggregator(nil, []Target{{Name: "api", URL: srv.URL}}, nil)
	a.Pool = &fakePool{}
	a.HTTPTimeout = time.Second
	p := a.probe(context.Background(), Target{Name: "api", URL: srv.URL})
	if p.Status != StatusOK {
		t.Fatalf("status = %s, want ok", p.Status)
	}
	if p.HTTPStatus != 200 {
		t.Fatalf("http_status = %d, want 200", p.HTTPStatus)
	}
}

func TestAggregatorProbeDown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	a := NewAggregator(nil, []Target{{Name: "api", URL: srv.URL}}, nil)
	a.HTTPTimeout = time.Second
	p := a.probe(context.Background(), Target{Name: "api", URL: srv.URL})
	if p.Status != StatusDown {
		t.Fatalf("status = %s, want down", p.Status)
	}
	if p.HTTPStatus != 500 {
		t.Fatalf("http_status = %d, want 500", p.HTTPStatus)
	}
}

func TestAggregatorProbeDegraded(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"degraded"}`))
	}))
	defer srv.Close()

	a := NewAggregator(nil, []Target{{Name: "api", URL: srv.URL}}, nil)
	a.HTTPTimeout = time.Second
	p := a.probe(context.Background(), Target{Name: "api", URL: srv.URL})
	if p.Status != StatusDegraded {
		t.Fatalf("status = %s, want degraded", p.Status)
	}
}

func TestAggregatorProbeTimeoutCountsAsDown(t *testing.T) {
	// Server that never responds.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()

	a := NewAggregator(nil, []Target{{Name: "slow", URL: srv.URL}}, nil)
	a.HTTPTimeout = 50 * time.Millisecond
	a.httpClient = &http.Client{Timeout: 50 * time.Millisecond}
	p := a.probe(context.Background(), Target{Name: "slow", URL: srv.URL})
	if p.Status != StatusDown {
		t.Fatalf("status = %s, want down", p.Status)
	}
	if p.Error == "" {
		t.Fatalf("expected timeout error to be recorded")
	}
}

func TestAggregatorTickPersists(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()

	pool := &fakePool{}
	a := NewAggregator(nil, []Target{
		{Name: "api", URL: srv.URL},
		{Name: "voice", URL: srv.URL},
	}, nil)
	a.Pool = pool
	a.HTTPTimeout = time.Second
	a.tick(context.Background())
	if got := atomic.LoadInt32(&hits); got != 2 {
		t.Fatalf("expected 2 HTTP hits, got %d", got)
	}
	if n := len(pool.inserts()); n != 2 {
		t.Fatalf("expected 2 inserts, got %d", n)
	}
	if last := a.LastPings(); len(last) != 2 {
		t.Fatalf("expected 2 cached last-pings, got %d", len(last))
	}
}

func TestAggregatorRunCancellable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()

	a := NewAggregator(nil, []Target{{Name: "api", URL: srv.URL}}, nil)
	a.Pool = &fakePool{}
	a.Interval = 50 * time.Millisecond
	a.RetentionInterval = 100 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		a.Run(ctx)
		close(done)
	}()
	time.Sleep(120 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not exit within 2s of cancel")
	}
}

func TestAggregatorReapDeletes(t *testing.T) {
	pool := &fakePool{}
	a := NewAggregator(nil, []Target{}, nil)
	a.Pool = pool
	a.RetentionWindow = 24 * time.Hour
	a.reap(context.Background())
	pool.mu.Lock()
	defer pool.mu.Unlock()
	if len(pool.statements) != 1 {
		t.Fatalf("expected 1 reap statement, got %d", len(pool.statements))
	}
	if !contains(pool.statements[0].sql, "DELETE FROM service_health_pings") {
		t.Fatalf("expected DELETE statement, got: %s", pool.statements[0].sql)
	}
}

func TestAggregatorRunNoTargetsReturnsImmediately(t *testing.T) {
	a := NewAggregator(nil, nil, nil)
	a.Pool = &fakePool{}
	done := make(chan struct{})
	go func() {
		a.Run(context.Background())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run with empty targets should return immediately")
	}
}
