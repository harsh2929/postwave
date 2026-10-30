package reputation

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// reputationSourceFailures tracks per-source aggregator errors. Sources
// (Postmaster Tools, SNDS, SenderScore, DNSBL probes) are flaky by
// nature — temporary 5xx, IP-block, quota-exceeded — so we don't fail
// the parent Fetch on a single source. The counter is the operator's
// "is provider X currently broken?" signal so a Grafana panel can
// chart provider health independent of our own logic.
//
// Cardinality: bounded by the number of registered sources (currently
// four). The `source` label is the value Source.Name() returns; new
// sources just add a new label value with no schema change.
var reputationSourceFailures = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "reputation_source_failures_total",
	Help: "Total times a Reputation Source returned an error during Aggregator.Fetch, partitioned by source name. Sources are skipped on error so partial data is still returned.",
}, []string{"source"})

// Aggregator runs all configured Sources concurrently and merges them.
// Per-domain results are cached for 24h to keep API quotas in check.
type Aggregator struct {
	Sources []Source
	TTL     time.Duration

	mu    sync.Mutex
	cache map[string]cacheEntry
}

type cacheEntry struct {
	at  time.Time
	rep domain.Reputation
}

// NewAggregator returns an aggregator with a 24h TTL.
func NewAggregator(sources ...Source) *Aggregator {
	return &Aggregator{
		Sources: sources,
		TTL:     24 * time.Hour,
		cache:   make(map[string]cacheEntry),
	}
}

// Fetch merges Reputation from every Source. Sources that error are
// logged at WARN (expected — sources are flaky) and skipped. The error
// is also accounted in reputation_source_failures_total{source} so
// dashboards can chart per-source health. Partial data is better than
// no data — Fetch never returns the source's error to the caller.
func (a *Aggregator) Fetch(ctx context.Context, domainName, ip string) (domain.Reputation, error) {
	key := domainName + "|" + ip
	a.mu.Lock()
	if e, ok := a.cache[key]; ok && time.Since(e.at) < a.TTL {
		a.mu.Unlock()
		return e.rep, nil
	}
	a.mu.Unlock()

	type result struct {
		name string
		rep  domain.Reputation
		err  error
	}
	results := make(chan result, len(a.Sources))
	var wg sync.WaitGroup
	for _, s := range a.Sources {
		s := s
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := s.Fetch(ctx, domainName, ip)
			results <- result{name: s.Name(), rep: r, err: err}
		}()
	}
	wg.Wait()
	close(results)

	merged := domain.Reputation{
		Domain:        domainName,
		IP:            ip,
		BlacklistHits: make([]string, 0),
		CheckedAt:     time.Now(),
	}
	for r := range results {
		if r.err != nil {
			// Warn (not Error) — flaky external sources are expected
			// to error transiently; a Grafana alert keys off the
			// counter rate, not log severity.
			slog.Warn("reputation: source failed",
				"source", r.name,
				"domain", domainName,
				"ip", ip,
				"err", r.err.Error())
			reputationSourceFailures.WithLabelValues(r.name).Inc()
			merged.SourcesFailed = append(merged.SourcesFailed, r.name)
			continue
		}
		merged.DataAvailable = true
		merged.SourcesSucceeded = append(merged.SourcesSucceeded, r.name)
		merge(&merged, r.rep)
	}

	a.mu.Lock()
	a.cache[key] = cacheEntry{at: time.Now(), rep: merged}
	a.mu.Unlock()
	return merged, nil
}

// merge folds non-zero fields of src into dst.
func merge(dst *domain.Reputation, src domain.Reputation) {
	if src.GoogleScore != "" {
		dst.GoogleScore = src.GoogleScore
	}
	if src.MicrosoftScore != "" {
		dst.MicrosoftScore = src.MicrosoftScore
	}
	if src.SenderScore != 0 {
		dst.SenderScore = src.SenderScore
	}
	if len(src.BlacklistHits) > 0 {
		dst.BlacklistHits = append(dst.BlacklistHits, src.BlacklistHits...)
	}
}
