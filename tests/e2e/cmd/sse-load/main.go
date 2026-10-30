// Command sse-load opens real concurrent Server-Sent Events connections and
// fails when connection-open latency or early disconnects exceed the release
// budget. It exists because k6 buffers a streaming response until completion;
// timing a forced k6 timeout does not measure SSE connection latency.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const defaultTopics = "campaign.*"

type config struct {
	BaseURL        string
	APIKey         string
	TenantSlug     string
	Clients        int
	Hold           time.Duration
	ConnectTimeout time.Duration
	MaxP95         time.Duration
	MaxDropRate    float64
	Output         string
}

type connectionResult struct {
	Opened       bool
	EarlyDropped bool
	ConnectTime  time.Duration
	Failure      string
}

type summary struct {
	TargetOrigin        string         `json:"target_origin"`
	Attempted           int            `json:"attempted"`
	Opened              int            `json:"opened"`
	FailedOpen          int            `json:"failed_open"`
	EarlyDropped        int            `json:"early_dropped"`
	ConnectP95MS        float64        `json:"connect_p95_ms"`
	DropRate            float64        `json:"drop_rate"`
	RequiredMaxP95MS    float64        `json:"required_max_p95_ms"`
	RequiredMaxDropRate float64        `json:"required_max_drop_rate"`
	HoldSeconds         float64        `json:"hold_seconds"`
	Failures            map[string]int `json:"failures,omitempty"`
	Passed              bool           `json:"passed"`
}

func main() {
	cfg, err := parseConfig(os.Args[1:], os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "sse-load configuration error:", err)
		os.Exit(2)
	}

	result := runProbe(cfg)
	if err := writeSummary(cfg.Output, result); err != nil {
		fmt.Fprintln(os.Stderr, "write SSE load summary:", err)
		os.Exit(2)
	}

	fmt.Printf("SSE load: opened=%d/%d p95=%.1fms drop_rate=%.4f hold=%.1fs pass=%t\n",
		result.Opened, result.Attempted, result.ConnectP95MS, result.DropRate,
		result.HoldSeconds, result.Passed)
	if !result.Passed {
		os.Exit(1)
	}
}

func parseConfig(args []string, getenv func(string) string) (config, error) {
	fs := flag.NewFlagSet("sse-load", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	var cfg config
	fs.StringVar(&cfg.BaseURL, "base-url", getenv("POSTWAVE_LOAD_BASE_URL"), "API origin")
	fs.StringVar(&cfg.APIKey, "api-key", getenv("POSTWAVE_LOAD_API_KEY"), "scoped bearer API key")
	fs.StringVar(&cfg.TenantSlug, "tenant-slug", firstNonEmpty(getenv("POSTWAVE_LOAD_TENANT_SLUG"), "demo"), "loopback development tenant")
	fs.IntVar(&cfg.Clients, "clients", 500, "concurrent SSE connections")
	fs.DurationVar(&cfg.Hold, "hold", 10*time.Second, "minimum time each open connection is held")
	fs.DurationVar(&cfg.ConnectTimeout, "connect-timeout", 10*time.Second, "per-connection first-byte timeout")
	fs.DurationVar(&cfg.MaxP95, "max-p95", time.Second, "exclusive P95 first-byte budget")
	fs.Float64Var(&cfg.MaxDropRate, "max-drop-rate", 0.005, "exclusive failed/early-drop rate budget")
	fs.StringVar(&cfg.Output, "output", "sse-load-summary.json", "JSON summary path")
	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	if fs.NArg() != 0 {
		return config{}, errors.New("unexpected positional arguments")
	}

	cfg.BaseURL = strings.TrimSpace(cfg.BaseURL)
	cfg.APIKey = strings.TrimSpace(cfg.APIKey)
	cfg.TenantSlug = strings.TrimSpace(cfg.TenantSlug)
	cfg.Output = strings.TrimSpace(cfg.Output)
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return config{}, errors.New("base URL must be an absolute HTTP(S) origin")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return config{}, errors.New("base URL must be an origin without credentials, path, query, or fragment")
	}
	loopback := isLoopbackHost(u.Hostname())
	if loopback {
		if u.Scheme != "http" && u.Scheme != "https" {
			return config{}, errors.New("loopback base URL must use HTTP or HTTPS")
		}
		if cfg.APIKey == "" && cfg.TenantSlug == "" {
			return config{}, errors.New("loopback runs require an API key or development tenant slug")
		}
	} else {
		if u.Scheme != "https" {
			return config{}, errors.New("remote base URL must use HTTPS")
		}
		if cfg.APIKey == "" {
			return config{}, errors.New("POSTWAVE_LOAD_API_KEY is required for remote targets")
		}
	}
	if cfg.Clients < 1 || cfg.Clients > 5000 {
		return config{}, errors.New("clients must be between 1 and 5000")
	}
	if cfg.Hold <= 0 || cfg.ConnectTimeout <= 0 || cfg.MaxP95 <= 0 {
		return config{}, errors.New("hold, connect-timeout, and max-p95 must be positive")
	}
	if cfg.MaxDropRate <= 0 || cfg.MaxDropRate >= 1 {
		return config{}, errors.New("max-drop-rate must be greater than zero and less than one")
	}
	if cfg.Output == "" {
		return config{}, errors.New("output path is required")
	}

	// Normalize a single optional trailing slash so endpoint concatenation is
	// deterministic and the summary never contains credentials or query data.
	cfg.BaseURL = strings.TrimSuffix(u.String(), "/")
	return cfg, nil
}

func runProbe(cfg config) summary {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          cfg.Clients,
		MaxIdleConnsPerHost:   cfg.Clients,
		MaxConnsPerHost:       cfg.Clients,
		IdleConnTimeout:       cfg.Hold + cfg.ConnectTimeout,
		TLSHandshakeTimeout:   cfg.ConnectTimeout,
		ResponseHeaderTimeout: cfg.ConnectTimeout,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}

	start := make(chan struct{})
	results := make(chan connectionResult, cfg.Clients)
	var ready sync.WaitGroup
	ready.Add(cfg.Clients)
	for range cfg.Clients {
		go func() {
			ready.Done()
			<-start
			results <- openAndHold(client, cfg)
		}()
	}
	ready.Wait()
	close(start)

	latencies := make([]time.Duration, 0, cfg.Clients)
	failures := make(map[string]int)
	opened := 0
	earlyDropped := 0
	for range cfg.Clients {
		result := <-results
		if result.Opened {
			opened++
			latencies = append(latencies, result.ConnectTime)
		}
		if result.EarlyDropped {
			earlyDropped++
		}
		if result.Failure != "" {
			failures[result.Failure]++
		}
	}

	failedOpen := cfg.Clients - opened
	dropRate := float64(failedOpen+earlyDropped) / float64(cfg.Clients)
	p95 := percentile95(latencies)
	passed := len(latencies) > 0 && p95 < cfg.MaxP95 && dropRate < cfg.MaxDropRate
	u, _ := url.Parse(cfg.BaseURL)
	return summary{
		TargetOrigin:        u.Scheme + "://" + u.Host,
		Attempted:           cfg.Clients,
		Opened:              opened,
		FailedOpen:          failedOpen,
		EarlyDropped:        earlyDropped,
		ConnectP95MS:        milliseconds(p95),
		DropRate:            dropRate,
		RequiredMaxP95MS:    milliseconds(cfg.MaxP95),
		RequiredMaxDropRate: cfg.MaxDropRate,
		HoldSeconds:         cfg.Hold.Seconds(),
		Failures:            failures,
		Passed:              passed,
	}
}

func openAndHold(client *http.Client, cfg config) connectionResult {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var probeCancellation atomic.Bool
	deadline := time.AfterFunc(cfg.ConnectTimeout, func() {
		probeCancellation.Store(true)
		cancel()
	})
	defer func() { deadline.Stop() }()

	endpoint := cfg.BaseURL + "/api/v1/events?topics=" + url.QueryEscape(defaultTopics)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return connectionResult{Failure: "request_build"}
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	} else {
		req.Header.Set("X-Tenant-Slug", cfg.TenantSlug)
		req.Header.Set("X-Postwave-Role", "admin")
	}

	started := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return connectionResult{Failure: "connect_or_headers"}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.CopyN(io.Discard, resp.Body, 4096)
		return connectionResult{Failure: fmt.Sprintf("http_%d", resp.StatusCode)}
	}
	if !strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
		return connectionResult{Failure: "wrong_content_type"}
	}

	reader := bufio.NewReader(resp.Body)
	line, err := reader.ReadString('\n')
	if err != nil {
		return connectionResult{Failure: "first_byte"}
	}
	connectTime := time.Since(started)
	if !strings.HasPrefix(line, "event:") && !strings.HasPrefix(line, ":") {
		return connectionResult{Failure: "invalid_sse_preamble"}
	}

	if !deadline.Stop() && probeCancellation.Load() {
		return connectionResult{Failure: "connect_timeout"}
	}
	probeCancellation.Store(false)
	deadline = time.AfterFunc(cfg.Hold, func() {
		probeCancellation.Store(true)
		cancel()
	})
	holdStarted := time.Now()
	_, _ = io.Copy(io.Discard, reader)
	heldFor := time.Since(holdStarted)
	plannedClose := probeCancellation.Load()
	return connectionResult{
		Opened:       true,
		EarlyDropped: !plannedClose && heldFor < cfg.Hold,
		ConnectTime:  connectTime,
		Failure:      earlyDropLabel(!plannedClose && heldFor < cfg.Hold),
	}
}

func percentile95(values []time.Duration) time.Duration {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]time.Duration(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	// Nearest-rank percentile: ceil(0.95*n)-1, expressed with integers.
	index := (95*len(sorted) + 99) / 100
	if index < 1 {
		index = 1
	}
	return sorted[index-1]
}

func writeSummary(path string, value summary) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	return enc.Encode(value)
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func milliseconds(value time.Duration) float64 { return float64(value) / float64(time.Millisecond) }

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func earlyDropLabel(dropped bool) string {
	if dropped {
		return "early_drop"
	}
	return ""
}
