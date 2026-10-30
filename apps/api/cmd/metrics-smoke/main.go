// metrics-smoke is an internal one-shot binary that boots the global
// Prometheus registry, exercises the helpers in apps/api/internal/sending
// and services/automation/internal/worker, and verifies /metrics emits
// the expected exposition lines. Used as a CI-friendly smoke-test for
// the observability wiring; not shipped to production.
//
//	go run ./apps/api/cmd/metrics-smoke
//
// Outputs FOUND / MISSING per metric name, exit 0 on success.
package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/sending"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	os.Exit(run())
}

func run() int {
	// Force one observation per CounterVec label so /metrics emits the
	// metric family on the smoke run; otherwise a Vec with zero samples
	// is registered but invisible in the exposition (which is correct
	// Prometheus behavior — we just need it visible for this smoke).
	for _, r := range []string{"sent", "failed", "skipped", "cancelled"} {
		sending.SmokeObserveRecipient(r)
	}

	srv := httptest.NewServer(promhttp.Handler())
	defer srv.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(srv.URL + "/metrics")
	if err != nil {
		fmt.Println("ERR:", err)
		return 1
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := readBodyLimited(resp.Body, 1<<20)
	if err != nil {
		fmt.Println("ERR:", err)
		return 1
	}
	fmt.Printf("STATUS=%d BYTES=%d\n", resp.StatusCode, len(body))
	want := []string{
		"postwave_sendloop_iterations_total",
		"postwave_sendloop_recipients_drained_total",
		"postwave_sendloop_quiet_hours_skips_total",
		"postwave_sendloop_rate_limit_denials_total",
		"postwave_sendloop_iteration_duration_seconds",
		"postwave_sendloop_last_success_timestamp",
	}
	missing := 0
	for _, n := range want {
		if strings.Contains(string(body), n) {
			fmt.Printf("FOUND %s\n", n)
		} else {
			fmt.Printf("MISSING %s\n", n)
			missing++
		}
	}
	if missing > 0 {
		return 1
	}
	return 0
}

func readBodyLimited(r io.Reader, maxBytes int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("response body too large")
	}
	return body, nil
}
