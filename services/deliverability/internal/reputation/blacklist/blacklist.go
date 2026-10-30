// Package blacklist queries DNSBLs (Spamhaus, SORBS, Barracuda, etc.) for a
// sending domain or IP. Pure DNS, no auth required.
package blacklist

import (
	"context"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// DefaultZones is a curated list of widely-used DNSBLs. Kept short: each
// query is a network round trip, and false positives from obscure lists
// hurt more than they help.
var DefaultZones = []string{
	"zen.spamhaus.org",
	"dbl.spamhaus.org",
	"bl.spamcop.net",
	"b.barracudacentral.org",
	"dnsbl.sorbs.net",
	"psbl.surriel.com",
	"cbl.abuseat.org",
	"truncate.gbudb.net",
	"all.s5h.net",
	"bl.mailspike.net",
	"ix.dnsbl.manitu.net",
	"dnsbl-1.uceprotect.net",
}

// Client performs DNSBL lookups.
type Client struct {
	Resolver *net.Resolver
	Zones    []string
}

// New returns a Client using net.DefaultResolver and DefaultZones.
func New() *Client {
	return &Client{Resolver: net.DefaultResolver, Zones: DefaultZones}
}

// Name implements Source.
func (c *Client) Name() string { return "dnsbl" }

// Fetch implements Source. Concurrent A-record lookups against each zone;
// any positive hit means the IP/domain is listed.
func (c *Client) Fetch(ctx context.Context, domainName, ip string) (domain.Reputation, error) {
	rep := domain.Reputation{
		Domain:    domainName,
		IP:        ip,
		CheckedAt: time.Now(),
	}
	hits := []string{}
	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, zone := range c.Zones {
		zone := zone
		// IP-based zones: reverse the IP and prepend.
		if ip != "" {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if listed, _ := c.lookup(ctx, reverseIP(ip)+"."+zone); listed {
					mu.Lock()
					hits = append(hits, zone)
					mu.Unlock()
				}
			}()
		}
		// Domain-based zones (DBL etc.) accept the bare domain.
		if domainName != "" && strings.Contains(zone, "dbl") {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if listed, _ := c.lookup(ctx, domainName+"."+zone); listed {
					mu.Lock()
					hits = append(hits, zone+" (domain)")
					mu.Unlock()
				}
			}()
		}
	}
	wg.Wait()
	rep.BlacklistHits = hits
	return rep, nil
}

func (c *Client) lookup(ctx context.Context, host string) (bool, error) {
	// Any A record means listed; NXDOMAIN means clean.
	addrs, err := c.Resolver.LookupHost(ctx, host)
	if err != nil {
		// DNSError for NXDOMAIN is not a real error from our perspective.
		var dnsErr *net.DNSError
		if asDNSErr(err, &dnsErr) && dnsErr.IsNotFound {
			return false, nil
		}
		return false, err
	}
	return len(addrs) > 0, nil
}

func asDNSErr(err error, target **net.DNSError) bool {
	if err == nil {
		return false
	}
	d, ok := err.(*net.DNSError)
	if !ok {
		return false
	}
	*target = d
	return true
}

func reverseIP(ip string) string {
	parts := strings.Split(ip, ".")
	if len(parts) != 4 {
		return ip
	}
	return parts[3] + "." + parts[2] + "." + parts[1] + "." + parts[0]
}
