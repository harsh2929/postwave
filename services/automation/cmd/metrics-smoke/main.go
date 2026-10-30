// metrics-smoke for the automation service. Boots the global Prometheus
// registry, optionally fires a recurrence-scanner sample so the
// CounterVec emits, scrapes the in-process /metrics handler, and prints
// FOUND / MISSING per expected name.
//
//	go run ./services/automation/cmd/metrics-smoke
//
// Not shipped to production.
package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"time"

	"github.com/postwave/postwave/services/automation/internal/worker"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	os.Exit(run())
}

func run() int {
	// Fire one observation in each branch so the CounterVec's two label
	// values (ok | error) both appear in the exposition.
	worker.SmokeObserveRun(1, nil)
	worker.SmokeObserveRun(0, errors.New("smoke"))

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
	missing := 0
	for _, n := range []string{
		"postwave_recurrence_scanner_runs_total",
		"postwave_recurrence_scanner_last_run_timestamp",
		"postwave_recurrence_scanner_processed_total",
	} {
		if strings.Contains(string(body), n) {
			fmt.Println("FOUND", n)
		} else {
			fmt.Println("MISSING", n)
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
