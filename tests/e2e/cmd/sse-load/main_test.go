package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestParseConfigRejectsUnauthenticatedRemoteTarget(t *testing.T) {
	_, err := parseConfig([]string{"-base-url", "https://staging.moosewave.com"}, func(string) string { return "" })
	if err == nil {
		t.Fatal("expected remote target without API key to fail")
	}
}

func TestParseConfigRejectsRemoteHTTPAndURLPayloads(t *testing.T) {
	for _, target := range []string{
		"http://staging.moosewave.com",
		"https://user:pass@staging.moosewave.com",
		"https://staging.moosewave.com/path",
		"https://staging.moosewave.com?target=other",
	} {
		t.Run(target, func(t *testing.T) {
			_, err := parseConfig([]string{"-base-url", target, "-api-key", "pw_test_key"}, func(string) string { return "" })
			if err == nil {
				t.Fatalf("expected %q to fail", target)
			}
		})
	}
}

func TestRunProbeMeasuresFirstByteAndHoldsConnections(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Tenant-Slug"); got != "demo" {
			http.Error(w, "missing local auth", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprint(w, "event: ready\ndata: {}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()

	cfg := config{
		BaseURL:        server.URL,
		TenantSlug:     "demo",
		Clients:        12,
		Hold:           40 * time.Millisecond,
		ConnectTimeout: time.Second,
		MaxP95:         time.Second,
		MaxDropRate:    0.005,
		Output:         filepath.Join(t.TempDir(), "summary.json"),
	}
	got := runProbe(cfg)
	if !got.Passed || got.Opened != cfg.Clients || got.EarlyDropped != 0 || got.FailedOpen != 0 {
		t.Fatalf("unexpected probe summary: %+v", got)
	}
	if got.ConnectP95MS <= 0 || got.ConnectP95MS >= 1000 {
		t.Fatalf("unexpected P95: %fms", got.ConnectP95MS)
	}
}

func TestRunProbeCountsEarlyDisconnects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprint(w, "event: ready\ndata: {}\n\n")
		w.(http.Flusher).Flush()
	}))
	defer server.Close()

	got := runProbe(config{
		BaseURL:        server.URL,
		TenantSlug:     "demo",
		Clients:        4,
		Hold:           100 * time.Millisecond,
		ConnectTimeout: time.Second,
		MaxP95:         time.Second,
		MaxDropRate:    0.005,
	})
	if got.Passed || got.EarlyDropped != 4 || got.DropRate != 1 {
		t.Fatalf("expected every early close to fail: %+v", got)
	}
}

func TestPercentile95UsesNearestRank(t *testing.T) {
	values := make([]time.Duration, 100)
	for i := range values {
		values[i] = time.Duration(i+1) * time.Millisecond
	}
	if got := percentile95(values); got != 95*time.Millisecond {
		t.Fatalf("p95 = %s, want 95ms", got)
	}
}
