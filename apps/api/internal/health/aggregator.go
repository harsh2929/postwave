// SPDX-License-Identifier: AGPL-3.0-only
//
// Package health implements the status-page backend: a periodic
// aggregator that pings each configured service URL and persists the
// outcome to service_health_pings, plus an HTTP handler that assembles
// a public response from the latest pings + the incidents table.
//
// This package owns the "trust" half of the trust+ops layer:
//
//   - Aggregator goroutine (Run) — every Interval (default 60s) issues a
//     GET to each configured service URL with a 5-second timeout. The
//     response body is parsed: 200 + body "{status:\"ok\"}" → ok; 200
//     with a body that names "degraded" → degraded; anything else (incl.
//     timeouts, transports errors, non-2xx) → down. One ping row is
//     INSERTED per (service, tick).
//   - Retention reaper — once a day the aggregator DELETEs any ping
//     older than 90 days. Runs on its own ticker (RetentionInterval,
//     default 24h) so a slow probe doesn't starve cleanup.
//
// The handler in handler.go consumes the persisted rows; this file
// stays HTTP-server-free.
//
// SIGTERM contract: Run takes a context and returns when it is
// cancelled. main.go wires the cancel into the shared shutdown signal
// chain.
package health

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Status is the canonical health classification we persist.
//
// We deliberately use a string-typed enum rather than ints so an operator
// reading the table directly sees "ok" / "degraded" / "down" in plain
// text.
type Status string

const (
	StatusOK       Status = "ok"
	StatusDegraded Status = "degraded"
	StatusDown     Status = "down"
)

// Target is a single (name, url) pair the aggregator probes. Targets are
// parsed once from SERVICE_HEALTH_URLS at startup; we don't reload them
// at runtime.
type Target struct {
	Name string // e.g. "api", "voice"
	URL  string // full URL, e.g. "http://voice:8081/health"
}

// Pool is the narrow surface the aggregator needs. Defined as an
// interface so unit tests can stub Exec without standing up a real pgx
// pool.
type Pool interface {
	Exec(ctx context.Context, sql string, args ...any) (pgxExecResult, error)
}

// pgxExecResult is the slice we use from pgconn.CommandTag — only zero
// methods today, but keeping the indirection lets tests return a typed
// nil without importing pgconn.
type pgxExecResult interface{}

// pgxPoolAdapter wraps *pgxpool.Pool to satisfy the local Pool
// interface. main.go always wires the real pgxpool.Pool; the adapter
// just narrows the return type.
type pgxPoolAdapter struct{ Pool *pgxpool.Pool }

func (a pgxPoolAdapter) Exec(ctx context.Context, sql string, args ...any) (pgxExecResult, error) {
	if a.Pool == nil {
		return nil, errors.New("nil pool")
	}
	tag, err := a.Pool.Exec(ctx, sql, args...)
	return tag, err
}

// Aggregator is the periodic health-checker.
//
// Construct via NewAggregator. Call Run in its own goroutine; it blocks
// until the context is cancelled.
type Aggregator struct {
	Pool              Pool
	Targets           []Target
	Interval          time.Duration // default 60s
	HTTPTimeout       time.Duration // default 5s, per-probe
	RetentionInterval time.Duration // default 24h
	RetentionWindow   time.Duration // default 90d
	Logger            *slog.Logger

	httpClient *http.Client

	// last is the most-recent classification per service. Read by the
	// handler when assembling the public response.
	mu   sync.RWMutex
	last map[string]Ping
}

// Ping is one persisted observation. Exported so the handler can return
// the most-recent ping per service.
type Ping struct {
	Service    string
	PingedAt   time.Time
	Status     Status
	LatencyMS  int
	HTTPStatus int
	Error      string
}

// NewAggregator constructs an Aggregator with sensible defaults. Pass a
// real pgxpool.Pool from main.go; tests build their own Pool stub.
func NewAggregator(pool *pgxpool.Pool, targets []Target, logger *slog.Logger) *Aggregator {
	a := &Aggregator{
		Targets:           targets,
		Interval:          60 * time.Second,
		HTTPTimeout:       5 * time.Second,
		RetentionInterval: 24 * time.Hour,
		RetentionWindow:   90 * 24 * time.Hour,
		Logger:            logger,
		last:              map[string]Ping{},
	}
	if pool != nil {
		a.Pool = pgxPoolAdapter{Pool: pool}
	}
	a.httpClient = &http.Client{Timeout: a.HTTPTimeout}
	return a
}

// ParseTargets parses the comma-separated `name=url` env-var format used
// by SERVICE_HEALTH_URLS. Empty entries and malformed pairs are skipped
// with no error so an operator who appends a stray comma doesn't crash
// the API. Returns nil (not error) on an empty input.
//
// Format: "api=http://localhost:8080/health,voice=http://voice:8081/health"
func ParseTargets(raw string) []Target {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]Target, 0, len(parts))
	seen := map[string]bool{}
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		eq := strings.Index(p, "=")
		if eq <= 0 || eq == len(p)-1 {
			continue
		}
		name := strings.TrimSpace(p[:eq])
		url := strings.TrimSpace(p[eq+1:])
		if name == "" || url == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, Target{Name: name, URL: url})
	}
	return out
}

// Run is the goroutine entry point. Blocks until ctx is cancelled.
//
// Tick semantics:
//   - On entry: probe immediately so a freshly-restarted API doesn't
//     show "no data" for up to a full Interval.
//   - Then every Interval until cancelled.
//   - Retention reaper runs on its own ticker; a slow probe doesn't
//     stall it.
func (a *Aggregator) Run(ctx context.Context) {
	if a == nil || len(a.Targets) == 0 {
		if a != nil && a.Logger != nil {
			a.Logger.Info("health aggregator disabled (no targets)")
		}
		return
	}
	if a.httpClient == nil {
		a.httpClient = &http.Client{Timeout: a.timeout()}
	}
	a.tick(ctx)
	probe := time.NewTicker(a.interval())
	defer probe.Stop()
	reap := time.NewTicker(a.retentionInterval())
	defer reap.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-probe.C:
			a.tick(ctx)
		case <-reap.C:
			a.reap(ctx)
		}
	}
}

func (a *Aggregator) interval() time.Duration {
	if a.Interval > 0 {
		return a.Interval
	}
	return 60 * time.Second
}

func (a *Aggregator) timeout() time.Duration {
	if a.HTTPTimeout > 0 {
		return a.HTTPTimeout
	}
	return 5 * time.Second
}

func (a *Aggregator) retentionInterval() time.Duration {
	if a.RetentionInterval > 0 {
		return a.RetentionInterval
	}
	return 24 * time.Hour
}

func (a *Aggregator) retentionWindow() time.Duration {
	if a.RetentionWindow > 0 {
		return a.RetentionWindow
	}
	return 90 * 24 * time.Hour
}

// tick probes every target serially and persists each result. Probes
// run inline (not in goroutines) because the natural concurrency cap is
// already bounded by len(Targets) and the per-probe HTTP timeout, and
// inline keeps log ordering predictable.
func (a *Aggregator) tick(ctx context.Context) {
	for _, t := range a.Targets {
		if ctx.Err() != nil {
			return
		}
		p := a.probe(ctx, t)
		a.recordLast(p)
		if err := a.persist(ctx, p); err != nil && a.Logger != nil {
			a.Logger.Warn("health aggregator persist failed",
				"service", t.Name, "err", err.Error())
		}
	}
}

// probe issues a single HTTP GET against the target and classifies the
// response. The classification rules:
//
//	200 + JSON body with "status":"ok"        → ok
//	200 + JSON body naming "degraded"         → degraded
//	200 + body that doesn't parse / no status → ok (assume liveness probe)
//	non-2xx, transport error, or timeout      → down
//
// The "200 + unparseable body → ok" branch is intentional: many
// services return a plain text "OK" or empty 200, and treating those as
// down would create a false-positive flood the moment we add a service
// that doesn't speak our preferred JSON shape.
func (a *Aggregator) probe(ctx context.Context, t Target) Ping {
	p := Ping{Service: t.Name, PingedAt: time.Now().UTC(), Status: StatusDown}
	pctx, cancel := context.WithTimeout(ctx, a.timeout())
	defer cancel()
	req, err := http.NewRequestWithContext(pctx, http.MethodGet, t.URL, nil)
	if err != nil {
		p.Error = "build_request: " + err.Error()
		return p
	}
	start := time.Now()
	resp, err := a.httpClient.Do(req)
	p.LatencyMS = int(time.Since(start).Milliseconds())
	if err != nil {
		p.Error = err.Error()
		return p
	}
	defer func() { _ = resp.Body.Close() }()
	p.HTTPStatus = resp.StatusCode
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		p.Status = StatusDown
		p.Error = http.StatusText(resp.StatusCode)
		return p
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	switch classifyBody(body) {
	case StatusDegraded:
		p.Status = StatusDegraded
	case StatusDown:
		p.Status = StatusDown
	default:
		p.Status = StatusOK
	}
	return p
}

// classifyBody peeks at a small JSON body to detect explicit degraded
// signalling. We don't fail closed when JSON parsing fails — many
// services return plain text or empty 200; those count as ok. A
// "down"-named status field, however, is honored even if HTTP was 200.
func classifyBody(b []byte) Status {
	if len(b) == 0 {
		return StatusOK
	}
	// Cheap path: if the literal "degraded" or "down" appears in a
	// "status" key value, classify accordingly. Avoids a full JSON
	// decode for the 95% case.
	lower := strings.ToLower(string(b))
	if strings.Contains(lower, `"status"`) {
		var probe struct {
			Status string `json:"status"`
		}
		if err := json.Unmarshal(b, &probe); err == nil {
			switch strings.ToLower(strings.TrimSpace(probe.Status)) {
			case "ok", "healthy", "up":
				return StatusOK
			case "degraded", "warning", "warn":
				return StatusDegraded
			case "down", "fail", "failed", "outage":
				return StatusDown
			}
		}
	}
	return StatusOK
}

func (a *Aggregator) recordLast(p Ping) {
	a.mu.Lock()
	a.last[p.Service] = p
	a.mu.Unlock()
}

// LastPings returns the most-recent ping per service. The handler uses
// this to render the service grid. Returns a defensive copy so the
// caller can't mutate internal state.
func (a *Aggregator) LastPings() map[string]Ping {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make(map[string]Ping, len(a.last))
	for k, v := range a.last {
		out[k] = v
	}
	return out
}

// persist writes one row to service_health_pings. Errors here are
// non-fatal — we already recorded the ping in memory for the live grid;
// a transient DB error just means the historical chart won't include
// this datapoint.
func (a *Aggregator) persist(ctx context.Context, p Ping) error {
	if a.Pool == nil {
		return nil
	}
	var errStr any
	if p.Error != "" {
		errStr = p.Error
	}
	var httpStatus any
	if p.HTTPStatus > 0 {
		httpStatus = p.HTTPStatus
	}
	_, err := a.Pool.Exec(ctx, `
		INSERT INTO service_health_pings
		  (service, pinged_at, status, latency_ms, http_status, error)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, p.Service, p.PingedAt, string(p.Status), p.LatencyMS, httpStatus, errStr)
	return err
}

// reap deletes pings older than RetentionWindow. Runs once per
// RetentionInterval. The DELETE is unbounded but the partial index on
// (service, pinged_at DESC) makes the WHERE pinged_at < cutoff scan
// cheap and the delete itself runs in batches that pgx breaks into a
// single statement.
func (a *Aggregator) reap(ctx context.Context) {
	if a.Pool == nil {
		return
	}
	cutoff := time.Now().UTC().Add(-a.retentionWindow())
	if _, err := a.Pool.Exec(ctx,
		`DELETE FROM service_health_pings WHERE pinged_at < $1`, cutoff,
	); err != nil && a.Logger != nil {
		a.Logger.Warn("health aggregator retention sweep failed", "err", err.Error())
	}
}
