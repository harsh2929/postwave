package status

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Poller is the goroutine that probes each service every Interval and writes
// daily aggregates to service_health. Construct with NewPoller; call Run in
// its own goroutine.
type Poller struct {
	Pool     *pgxpool.Pool
	Handler  *Handler
	Interval time.Duration

	// ring is a per-service sliding window of the last 24h of samples used
	// to compute the daily aggregates. Bounded growth: each entry is ~24
	// bytes and we cap at 24*60 entries per service.
	mu   sync.Mutex
	ring map[string][]sample

	httpClient *http.Client
}

type sample struct {
	at        time.Time
	status    OverallStatus
	latencyMS int64
}

// NewPoller returns a configured poller.
func NewPoller(pool *pgxpool.Pool, h *Handler, interval time.Duration) *Poller {
	if interval <= 0 {
		interval = time.Minute
	}
	return &Poller{
		Pool:       pool,
		Handler:    h,
		Interval:   interval,
		ring:       map[string][]sample{},
		httpClient: &http.Client{Timeout: 2 * time.Second},
	}
}

// Run blocks; intended for use in a `go statusPoller.Run(ctx)` call.
func (p *Poller) Run(ctx context.Context) {
	t := time.NewTicker(p.Interval)
	defer t.Stop()
	rollupTicker := time.NewTicker(15 * time.Minute)
	defer rollupTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.tick(ctx)
		case <-rollupTicker.C:
			p.rollupYesterday(ctx)
		}
	}
}

func (p *Poller) tick(ctx context.Context) {
	for _, name := range p.Handler.Targets.names() {
		url := p.Handler.Targets.urlFor(name)
		st := p.probe(ctx, name, url)
		p.recordSample(name, st)
		p.Handler.SetLive(st)
	}
}

// probe issues a GET <baseURL>/health and classifies the result.
func (p *Poller) probe(ctx context.Context, name, baseURL string) ServiceStatus {
	st := ServiceStatus{Name: name, LastChecked: time.Now().UTC(), Status: StatusOutage}
	if baseURL == "" {
		st.Status = StatusOperational // not configured = not in scope
		return st
	}
	pctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	endpoint, err := healthURL(baseURL)
	if err != nil {
		return st
	}
	req, err := http.NewRequestWithContext(pctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return st
	}
	start := time.Now()
	resp, err := p.httpClient.Do(req)
	st.LatencyMS = time.Since(start).Milliseconds()
	if err != nil {
		return st
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode == http.StatusOK && st.LatencyMS < 1000:
		st.Status = StatusOperational
	case resp.StatusCode == http.StatusOK:
		st.Status = StatusDegraded
	case resp.StatusCode >= 500:
		st.Status = StatusOutage
	default:
		st.Status = StatusDegraded
	}
	return st
}

func healthURL(baseRaw string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid health base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported health base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe health base URL")
	}
	base.Path = strings.TrimRight(base.Path, "/") + healthPath
	return base.String(), nil
}

func (p *Poller) recordSample(name string, st ServiceStatus) {
	p.mu.Lock()
	defer p.mu.Unlock()
	r := append(p.ring[name], sample{at: st.LastChecked, status: st.Status, latencyMS: st.LatencyMS})
	cutoff := time.Now().UTC().Add(-24 * time.Hour)
	for len(r) > 0 && r[0].at.Before(cutoff) {
		r = r[1:]
	}
	if len(r) > 24*60 {
		r = r[len(r)-24*60:]
	}
	p.ring[name] = r
}

// rollupYesterday aggregates the prior UTC day from the ring and upserts a
// row into service_health. Called every 15 minutes; the UPSERT means
// repeated calls are idempotent.
func (p *Poller) rollupYesterday(ctx context.Context) {
	if p.Pool == nil {
		return
	}
	yesterday := time.Now().UTC().AddDate(0, 0, -1)
	dayStart := time.Date(yesterday.Year(), yesterday.Month(), yesterday.Day(), 0, 0, 0, 0, time.UTC)
	dayEnd := dayStart.Add(24 * time.Hour)
	p.mu.Lock()
	snapshot := make(map[string][]sample, len(p.ring))
	for k, v := range p.ring {
		cp := append([]sample(nil), v...)
		snapshot[k] = cp
	}
	p.mu.Unlock()
	for service, samples := range snapshot {
		var total, degraded, outage int
		for _, s := range samples {
			if s.at.Before(dayStart) || s.at.After(dayEnd) {
				continue
			}
			total++
			switch s.status {
			case StatusDegraded:
				degraded++
			case StatusOutage:
				outage++
			}
		}
		if total == 0 {
			continue
		}
		// Each sample represents Interval minutes of observation.
		minPerSample := int(p.Interval / time.Minute)
		if minPerSample == 0 {
			minPerSample = 1
		}
		degradedMin := degraded * minPerSample
		outageMin := outage * minPerSample
		uptimePct := 100.0 * float64(total-outage) / float64(total)
		_, _ = p.Pool.Exec(ctx, `
			INSERT INTO service_health (service, day, uptime_pct, degraded_minutes, outage_minutes)
			VALUES ($1, $2::date, $3, $4, $5)
			ON CONFLICT (service, day) DO UPDATE SET
				uptime_pct = EXCLUDED.uptime_pct,
				degraded_minutes = EXCLUDED.degraded_minutes,
				outage_minutes = EXCLUDED.outage_minutes
		`, service, dayStart, uptimePct, degradedMin, outageMin)
	}
}
