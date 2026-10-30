// SPDX-License-Identifier: AGPL-3.0-only
//
// monitor.go — continuous DNSBL monitor. Given a set of subjects
// (IPs and/or domains the operator wants to track), polls every
// zone on a fixed cadence and writes Observation rows.
//
// Design choices:
//
//   • Per-subject, per-zone parallelism. The DNS fan-out is bounded
//     by a worker pool (default 32 concurrent in-flight lookups)
//     to avoid hammering the local resolver. 90 zones × 50 IPs =
//     4500 lookups per tick; at 32 in flight that's ~150 seconds
//     for a full pass — well under the recommended hourly cadence.
//
//   • Skip-if-recent. Each subject/zone pair only re-queries when
//     the last observation is older than MinAge (default 1h). A
//     restart of the monitor doesn't trigger a full re-poll if it
//     already finished a pass.
//
//   • Failure semantics. DNS errors (timeouts, refused) write an
//     observation with listed=false + error=<reason>. The dashboard
//     surfaces a per-zone health stat ("ix.dnsbl.manitu.net — 12
//     errors in the last hour"). Persistent errors auto-pause the
//     zone via the IsZoneHealthy() check.
//
//   • Pluggable storage. ObservationStore is the seam — production
//     wires the Postgres impl that writes to blocklist_observations;
//     tests pass a fake.

package blacklist

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// Observation is one row of the audit log.
type Observation struct {
	SubjectType string // "ip" | "domain"
	Subject     string // e.g. "203.0.113.10" or "example.com"
	Zone        string // e.g. "zen.spamhaus.org"
	Listed      bool
	Confidence  float64
	Error       string
	TenantID    string // empty for operator-owned subjects
	CheckedAt   time.Time
}

// ObservationStore is the persistence seam.
type ObservationStore interface {
	// Insert writes one observation row.
	Insert(ctx context.Context, o Observation) error
	// LatestObservedAt returns the most recent CheckedAt for the
	// (subjectType, subject, zone) tuple, or zero time when no row
	// exists. Used by the monitor's skip-if-recent gate.
	LatestObservedAt(ctx context.Context, subjectType, subject, zone string) (time.Time, error)
}

// MonitorTarget is one subject the operator wants tracked.
type MonitorTarget struct {
	SubjectType string // "ip" | "domain"
	Subject     string
	TenantID    string // empty for operator-owned (free pool) IPs
}

// Monitor polls a list of targets against the zone catalog. One
// Monitor instance is meant to be run as a goroutine via Run(ctx)
// and torn down via ctx cancellation. The orchestrator wraps Run in
// a backoff loop so a transient resolver failure doesn't kill the
// monitor for the whole tick cycle.
type Monitor struct {
	Client   *Client
	Store    ObservationStore
	Resolver *net.Resolver
	Zones    []Zone
	Targets  func(ctx context.Context) ([]MonitorTarget, error)
	// MinAge is the skip-if-recent threshold. Each (subject, zone)
	// pair is only re-queried when the last observation is older
	// than this. Default 1 hour.
	MinAge time.Duration
	// MaxConcurrency caps in-flight DNS lookups across all zones +
	// targets. Default 32.
	MaxConcurrency int
	// Clock is the time seam.
	Clock func() time.Time
}

// NewMonitor constructs a Monitor with sensible defaults.
func NewMonitor(client *Client, store ObservationStore, targets func(ctx context.Context) ([]MonitorTarget, error)) *Monitor {
	if client == nil {
		client = New()
	}
	return &Monitor{
		Client:         client,
		Store:          store,
		Resolver:       client.Resolver,
		Zones:          AllZones,
		Targets:        targets,
		MinAge:         time.Hour,
		MaxConcurrency: 32,
		Clock:          time.Now,
	}
}

// RunOnce executes one full pass and returns the number of
// observations recorded. Suitable for cron triggers and tests; the
// long-running Run() method composes RunOnce with a ticker + backoff.
func (m *Monitor) RunOnce(ctx context.Context) (int, error) {
	if m.Store == nil {
		return 0, errors.New("blacklist monitor: store not configured")
	}
	if m.Targets == nil {
		return 0, errors.New("blacklist monitor: targets fn not configured")
	}
	targets, err := m.Targets(ctx)
	if err != nil {
		return 0, fmt.Errorf("load targets: %w", err)
	}
	zones := m.Zones
	if len(zones) == 0 {
		zones = AllZones
	}
	concurrency := m.MaxConcurrency
	if concurrency <= 0 {
		concurrency = 32
	}
	clock := m.Clock
	if clock == nil {
		clock = time.Now
	}
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	var recordedMu sync.Mutex
	recorded := 0

	for _, t := range targets {
		t := t
		for _, z := range zones {
			z := z
			if !zoneMatchesSubject(z, t.SubjectType) {
				continue
			}
			wg.Add(1)
			sem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-sem }()
				if m.MinAge > 0 {
					last, err := m.Store.LatestObservedAt(ctx, t.SubjectType, t.Subject, z.Host)
					if err == nil && !last.IsZero() && clock().Sub(last) < m.MinAge {
						return // still fresh; skip
					}
				}
				obs := m.checkOne(ctx, t, z, clock())
				if err := m.Store.Insert(ctx, obs); err == nil {
					recordedMu.Lock()
					recorded++
					recordedMu.Unlock()
				}
			}()
		}
	}
	wg.Wait()
	return recorded, nil
}

// checkOne executes the DNS lookup for one (target, zone) and
// returns the corresponding Observation. Never returns an error —
// failures become Observations with Listed=false + Error set.
func (m *Monitor) checkOne(ctx context.Context, t MonitorTarget, z Zone, now time.Time) Observation {
	obs := Observation{
		SubjectType: t.SubjectType,
		Subject:     t.Subject,
		Zone:        z.Host,
		Confidence:  z.Confidence,
		TenantID:    t.TenantID,
		CheckedAt:   now,
	}
	var lookup string
	switch t.SubjectType {
	case "ip":
		lookup = reverseIP(t.Subject) + "." + z.Host
	case "domain":
		lookup = t.Subject + "." + z.Host
	default:
		obs.Error = "unknown subject_type"
		return obs
	}
	resolver := m.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	addrs, err := resolver.LookupHost(ctx, lookup)
	if err != nil {
		var dnsErr *net.DNSError
		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			// NXDOMAIN = clean.
			obs.Listed = false
			return obs
		}
		obs.Error = err.Error()
		return obs
	}
	obs.Listed = len(addrs) > 0
	return obs
}

// zoneMatchesSubject reports whether a zone's category matches the
// target subject type. IP zones can't query domains and vice versa.
func zoneMatchesSubject(z Zone, subjectType string) bool {
	switch z.Category {
	case "both":
		return true
	case "ip":
		return subjectType == "ip"
	case "domain":
		return subjectType == "domain"
	}
	return false
}

// IsZoneHealthy reports whether a zone has been answering recently.
// The caller looks at the last N observations on the zone and tags
// it unhealthy when more than half are Error != "". Used by the
// dashboard's "zone health" panel and by the auto-suppress decision
// (we don't auto-act on a zone that's been timing out for an hour).
func IsZoneHealthy(observations []Observation) bool {
	if len(observations) == 0 {
		return true
	}
	errs := 0
	for _, o := range observations {
		if o.Error != "" {
			errs++
		}
	}
	return errs*2 < len(observations)
}

// ShouldAutoSuppress reports whether a subject's recent observations
// warrant automatic suppression. Two conditions BOTH have to be true:
//
//  1. At least one tier-1 zone (confidence ≥ 0.95) has the subject
//     listed in the most-recent observation.
//  2. At least 2 separate zones have the subject listed (a single
//     hit on Spamhaus alone is suggestive but not action-worthy —
//     receivers will be doing their own check, and false positives
//     happen).
//
// The caller passes the latest-per-zone observations for one subject.
// The function is pure so the dashboard can render "this subject
// would be auto-suppressed now" without re-running DNS.
func ShouldAutoSuppress(observations []Observation) bool {
	tier1Hit := false
	listedCount := 0
	for _, o := range observations {
		if !o.Listed {
			continue
		}
		listedCount++
		if o.Confidence >= 0.95 {
			tier1Hit = true
		}
	}
	return tier1Hit && listedCount >= 2
}
