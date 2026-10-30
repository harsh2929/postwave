// SPDX-License-Identifier: MIT

package activecampaign

import (
	"net/url"
	"strings"
	"sync"
	"time"

	adapter "github.com/postwave/migrate/adapter"
)

var activeCampaignAccountLimiters sync.Map

const (
	activeCampaignRequestsPerSecond = 5
	activeCampaignProductionBurst   = 1
)

func sharedActiveCampaignLimiter(base string) *adapter.TokenBucket {
	key := activeCampaignRateLimitKey(base)
	if limiter, ok := activeCampaignAccountLimiters.Load(key); ok {
		return limiter.(*adapter.TokenBucket)
	}
	rate, burst := activeCampaignRequestsPerSecond, activeCampaignProductionBurst
	if strings.HasPrefix(key, "test:") && allowInsecureActiveCampaignTestLoopback {
		// HTTP fixture servers exercise contract behavior, not wall-clock
		// throttling. Keep production/provider buckets at the documented 5 RPS.
		rate, burst = 10_000, 10_000
	}
	created := adapter.NewTokenBucket(rate, time.Second, burst)
	actual, _ := activeCampaignAccountLimiters.LoadOrStore(key, created)
	return actual.(*adapter.TokenBucket)
}

func activeCampaignRateLimitKey(base string) string {
	u, err := url.Parse(strings.TrimSpace(base))
	if err != nil || u.Host == "" {
		return "invalid:" + strings.TrimSpace(base)
	}
	host := canonicalAccountHost(u)
	// Isolate httptest servers by port while still sharing a bucket for every
	// adapter/job pointed at the same test account.
	if isCanonicalLoopbackHost(host) {
		return "test:" + strings.ToLower(u.Host)
	}
	if account, ok := activeCampaignAccountName(host); ok {
		// ActiveCampaign may expose the same tenant through api-us1.com and
		// activehosted.com. Both aliases must consume one process-wide account
		// budget, matching the provider's per-account rate-limit contract.
		return "account:" + account
	}
	if allowed, err := isAllowedActiveCampaignAPIHost(host); err == nil && allowed {
		// Custom provider URLs have no documented cross-domain alias contract.
		// Share only by their exact canonical operator-approved hostname.
		return "host:" + host
	}
	return "invalid:" + host
}
