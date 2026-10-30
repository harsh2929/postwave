package content

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// countingResolver records how many DNS lookups a scan actually issues and how
// many run at once.
type countingResolver struct {
	mu       sync.Mutex
	lookups  int64
	inFlight int64
	peak     int64
}

func (c *countingResolver) LookupTXT(_ context.Context, _ string) ([]string, error) {
	atomic.AddInt64(&c.lookups, 1)
	now := atomic.AddInt64(&c.inFlight, 1)
	c.mu.Lock()
	if now > c.peak {
		c.peak = now
	}
	c.mu.Unlock()
	defer atomic.AddInt64(&c.inFlight, -1)
	return nil, nil
}

func (c *countingResolver) LookupAddr(_ context.Context, _ string) ([]string, error) {
	return nil, nil
}

// TestLinkReputationBoundsOutboundDNS pins both dimensions of a bound that did
// not exist.
//
// LinkReputationDetailed used to start one goroutine per unique host with no
// limit and no cap on how many hosts were classified. The link list arrives on
// a request body capped at 1 MiB, which still admits roughly 75,000 unique
// hosts — so one scan could spawn 75,000 goroutines and issue up to 150,000 DNS
// TXT queries inside its 2-second window.
//
// The memory spike is the lesser problem. URIBL and SURBL are public services
// that rate-limit and blocklist resolvers exceeding free-use thresholds, so a
// single abusive message could get this deployment's resolver banned — which
// degrades link reputation for every tenant, not just the sender.
func TestLinkReputationBoundsOutboundDNS(t *testing.T) {
	links := make([]string, 0, 5000)
	for i := 0; i < 5000; i++ {
		links = append(links, fmt.Sprintf("https://host-%d.example.test/x", i))
	}

	resolver := &countingResolver{}
	scanner := NewWithResolver(resolver)
	report := scanner.LinkReputationDetailed(context.Background(), links)

	// Every link is still reported — the cap changes how a host is CLASSIFIED,
	// never whether it appears.
	if len(report.Links) != len(links) {
		t.Fatalf("got %d link rows, want %d", len(report.Links), len(links))
	}

	// At most two lookups (URIBL + SURBL) per classified host.
	maxLookups := int64(maxDNSClassifiedHosts * 2)
	if got := atomic.LoadInt64(&resolver.lookups); got > maxLookups {
		t.Errorf("issued %d DNS lookups for 5000 hosts; cap allows at most %d", got, maxLookups)
	}
	if resolver.peak > maxConcurrentHostLookups {
		t.Errorf("peak concurrent lookups %d exceeds the pool width %d", resolver.peak, maxConcurrentHostLookups)
	}

	// Hosts past the cap must be WARN with a stated reason, never OK — a scan
	// must not report a host clean when it never looked at it.
	unchecked := 0
	for _, l := range report.Links {
		if strings.Contains(l.Reason, "not checked") {
			unchecked++
			if l.Status != repWarn {
				t.Errorf("unchecked host %s reported as %v, want warn", l.Host, l.Status)
			}
		}
	}
	if unchecked == 0 {
		t.Fatal("no host was reported as unchecked; the cap did not engage")
	}
}

// TestLinkReputationLeavesOrdinaryMessagesAlone is the guard-the-guard: a
// realistic email must be classified exactly as before, or the bound would be
// a silent downgrade of every scan.
func TestLinkReputationLeavesOrdinaryMessagesAlone(t *testing.T) {
	links := []string{
		"https://example.com/a",
		"https://cdn.example.com/b",
		"https://blog.example.org/c",
	}
	resolver := &countingResolver{}
	report := NewWithResolver(resolver).LinkReputationDetailed(context.Background(), links)

	if len(report.Links) != len(links) {
		t.Fatalf("got %d rows, want %d", len(report.Links), len(links))
	}
	for _, l := range report.Links {
		if strings.Contains(l.Reason, "not checked") {
			t.Errorf("a 3-host message hit the cap: %s", l.Reason)
		}
		if l.Status != repOK {
			t.Errorf("host %s classified %v, want ok", l.Host, l.Status)
		}
	}
	if report.Aggregate != repOK {
		t.Errorf("aggregate %v, want ok", report.Aggregate)
	}
}
