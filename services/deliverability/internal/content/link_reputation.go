// Real link-reputation analysis. Each link is hit against the public URI
// blocklist DNSBLs (URIBL multi.uribl.com and SURBL multi.surbl.org). Plus
// in-package heuristics: shortener detection, raw-IP-as-host, and
// mismatched display-vs-href anchor text.
//
// All DNS is gated by a Resolver interface so tests stay offline.
package content

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Resolver is the small DNS surface link-reputation needs. It mirrors the
// auth.Resolver shape so callers can pass the same instance.
type Resolver interface {
	LookupTXT(ctx context.Context, name string) ([]string, error)
	LookupAddr(ctx context.Context, addr string) ([]string, error)
}

// LookupHostA is satisfied by `*net.Resolver` and any test mock that wants
// to support direct A-record lookups for blocklist responses.
type LookupHostA interface {
	LookupHost(ctx context.Context, host string) ([]string, error)
}

// LinkRep is a per-link reputation outcome.
type LinkRep struct {
	URL    string       `json:"url"`
	Host   string       `json:"host"`
	Status domainStatus `json:"status"`
	Reason string       `json:"reason,omitempty"`
}

// domainStatus is an alias to keep the LinkRep struct portable while
// matching domain.AuthStatus values ("ok"|"warn"|"fail"). We don't import
// the domain package to avoid an import cycle on tests.
type domainStatus = string

const (
	repOK   domainStatus = "ok"
	repWarn domainStatus = "warn"
	repFail domainStatus = "fail"
)

// LinkReputationReport bundles per-link findings + the worst-case aggregate.
type LinkReputationReport struct {
	Links     []LinkRep `json:"links"`
	Aggregate string    `json:"aggregate"` // ok|warn|fail (matches domain.AuthStatus)
}

// LinkReputationDetailed runs all link checks concurrently with a 2s timeout
// per host. With no Resolver configured DNSBL queries are skipped (still
// returns shortener / IP / mismatch findings).
const (
	// maxDNSClassifiedHosts bounds how many unique link hosts one message may
	// send to the public blocklists. A real marketing email carries a handful;
	// this is generous by two orders of magnitude and still bounds abuse.
	maxDNSClassifiedHosts = 200
	// maxConcurrentHostLookups bounds simultaneous outbound DNS.
	maxConcurrentHostLookups = 16
)

func (s Scanner) LinkReputationDetailed(ctx context.Context, links []string) LinkReputationReport {
	uniqueHosts := map[string][]string{} // host → original urls
	hostOrder := []string{}
	for _, l := range links {
		u, err := url.Parse(l)
		if err != nil || u.Host == "" {
			continue
		}
		h := strings.ToLower(u.Hostname())
		if _, ok := uniqueHosts[h]; !ok {
			hostOrder = append(hostOrder, h)
		}
		uniqueHosts[h] = append(uniqueHosts[h], l)
	}

	type result struct {
		host   string
		status domainStatus
		reason string
	}
	// BOUNDED. This used to start one goroutine per unique host with no limit
	// and no cap on how many hosts were classified. The link list arrives on a
	// request body capped at 1 MiB, which still admits roughly 75,000 unique
	// hosts — so a single scan could spawn 75,000 goroutines and issue up to
	// 150,000 DNS TXT queries inside the 2-second window.
	//
	// The memory spike is the lesser problem. URIBL and SURBL are public
	// services that rate-limit and blocklist resolvers exceeding free-use
	// thresholds, so one abusive message could get this deployment's resolver
	// banned — which silently degrades link reputation for every tenant, not
	// just the sender.
	//
	// Hosts past the cap are reported as WARN with an explicit reason rather
	// than OK: the scan must not claim a host is clean when it never looked.
	classified := hostOrder
	var unchecked []string
	if len(classified) > maxDNSClassifiedHosts {
		unchecked = classified[maxDNSClassifiedHosts:]
		classified = classified[:maxDNSClassifiedHosts]
	}

	results := make(chan result, len(hostOrder))
	var wg sync.WaitGroup

	dnsCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	// A small worker pool rather than one goroutine per host. The DNS calls are
	// the cost here, not the scheduling, so a fixed width keeps outbound query
	// pressure predictable regardless of message size.
	slots := make(chan struct{}, maxConcurrentHostLookups)
	for _, host := range classified {
		wg.Add(1)
		go func(h string) {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			st, why := s.classifyHost(dnsCtx, h)
			results <- result{host: h, status: st, reason: why}
		}(host)
	}
	for _, host := range unchecked {
		wg.Add(1)
		go func(h string) {
			defer wg.Done()
			results <- result{
				host:   h,
				status: repWarn,
				reason: fmt.Sprintf("link host not checked: message has more than %d unique link hosts", maxDNSClassifiedHosts),
			}
		}(host)
	}
	go func() { wg.Wait(); close(results) }()

	statusByHost := map[string]result{}
	for r := range results {
		statusByHost[r.host] = r
	}

	out := LinkReputationReport{Aggregate: repOK}
	for _, host := range hostOrder {
		r := statusByHost[host]
		for _, raw := range uniqueHosts[host] {
			out.Links = append(out.Links, LinkRep{URL: raw, Host: host, Status: r.status, Reason: r.reason})
		}
		out.Aggregate = worse(out.Aggregate, r.status)
	}
	// Mismatched-display-vs-href is computed at scanner level via anchor list,
	// not raw URL list, so callers pass that separately if needed. Aggregate
	// captures host-level reputation here.
	return out
}

// classifyHost returns ok|warn|fail and the reason for a single host. It
// applies the heuristics first (shortener, raw IP), then DNSBL checks via
// the Resolver if configured.
func (s Scanner) classifyHost(ctx context.Context, host string) (domainStatus, string) {
	if host == "" {
		return repWarn, "empty host"
	}
	if ip := net.ParseIP(host); ip != nil {
		return repFail, "raw IP address used as host"
	}
	if isShortenerHost(host) {
		return repWarn, "URL shortener (" + host + ")"
	}
	if s.Resolver == nil {
		return repOK, ""
	}
	apex := apexOf(host)
	// URIBL multi list — TXT record present means listed; reason tags in TXT.
	if listed, why := dnsblHit(ctx, s.Resolver, apex+".multi.uribl.com"); listed {
		return repFail, "URIBL: " + why
	}
	// SURBL multi list
	if listed, why := dnsblHit(ctx, s.Resolver, apex+".multi.surbl.org"); listed {
		return repFail, "SURBL: " + why
	}
	return repOK, ""
}

// dnsblHit performs a TXT lookup; presence indicates listing. The TXT
// content is returned as the reason string so operators see the listing
// type (phish, malware, etc.).
func dnsblHit(ctx context.Context, r Resolver, name string) (bool, string) {
	if r == nil {
		return false, ""
	}
	txts, err := r.LookupTXT(ctx, name)
	if err != nil {
		var dnsErr *net.DNSError
		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			return false, ""
		}
		return false, "" // soft-fail: treat lookup errors as not-listed
	}
	if len(txts) == 0 {
		return false, ""
	}
	return true, strings.Join(txts, "; ")
}

// apexOf returns the registered domain (best-effort using the last two
// labels). Good enough for blocklist queries which expect the apex.
func apexOf(host string) string {
	parts := strings.Split(host, ".")
	if len(parts) <= 2 {
		return host
	}
	// Handle simple two-label TLDs like co.uk, com.au.
	last := parts[len(parts)-1]
	second := parts[len(parts)-2]
	twoLabelTLDs := map[string]bool{
		"co.uk": true, "co.in": true, "com.au": true, "co.jp": true, "com.br": true,
	}
	if twoLabelTLDs[second+"."+last] && len(parts) >= 3 {
		return strings.Join(parts[len(parts)-3:], ".")
	}
	return strings.Join(parts[len(parts)-2:], ".")
}

func worse(a, b domainStatus) domainStatus {
	rank := map[domainStatus]int{repOK: 0, repWarn: 1, repFail: 2}
	if rank[b] > rank[a] {
		return b
	}
	return a
}

// isShortenerHost — list curated from publicly maintained URL-shortener
// lists (Spam-blocklists.org, GitHub abuse-shorteners). ~30 entries.
func isShortenerHost(host string) bool {
	switch host {
	case "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "buff.ly",
		"is.gd", "tiny.cc", "cli.gs", "rebrand.ly", "shorturl.at",
		"cutt.ly", "rb.gy", "lnkd.in", "youtu.be", "fb.me",
		"ift.tt", "trib.al", "shor.tt", "shrturl.com", "po.st",
		"hyperurl.co", "tr.im", "snip.ly", "soo.gd", "v.gd",
		"qr.net", "lc.chat", "u.to", "x.gd", "smarturl.it":
		return true
	}
	return false
}
