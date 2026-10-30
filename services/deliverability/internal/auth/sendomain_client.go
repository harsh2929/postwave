// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP client for the cross-service send-domain → tenant lookup
// exposed by apps/api at /api/internal/send-domains/lookup.
//
// The deliverability service uses this from DefaultTenantResolver to
// resolve a DMARC report's policy_published.domain to the owning
// tenant when the envelope-To plus-addressing strategy doesn't match.
//
// Caching: a small in-process map keeps lookups off the gateway for
// the common case of a few dozen verified domains polled every 15
// minutes. Both successful (tenant_id) and negative (not_found)
// results are cached to avoid retry storms when an unmapped domain
// receives reports from many ESPs in the same batch. TTL is 10
// minutes — short enough that a domain ownership change settles
// within one DMARC poll interval.

package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ErrNotFound is returned by SendDomainClient.LookupTenant when the
// gateway responds 404 — i.e. the domain isn't claimed by any tenant
// or is not yet verified. Callers (DefaultTenantResolver in particular)
// should treat this as "no mapping" rather than a transport error so
// they can fall through silently to the fallback strategy.
var ErrNotFound = errors.New("sendomain client: tenant not found for domain")

// defaultClientTimeout matches the apps/api internal-token routes'
// expected response time. The lookup is a single indexed-row read so
// any latency above ~1s is almost certainly transport, not query.
const defaultClientTimeout = 5 * time.Second

// defaultCacheTTL bounds how long we trust a cached tenant_id (or
// not-found result). A domain rarely changes ownership, but we need a
// ceiling so that re-verification or transfer settles eventually.
const defaultCacheTTL = 10 * time.Minute
const sendDomainLookupMaxResponseBytes int64 = 64 << 10

// cachedLookup is one entry in the SendDomainClient cache. notFound
// is encoded as (TenantID == "" && Err == ErrNotFound) so we can
// memoize negative results without a magic sentinel.
type cachedLookup struct {
	TenantID  string
	Err       error // nil on hit, ErrNotFound on memoized miss
	ExpiresAt time.Time
}

// SendDomainClient calls /api/internal/send-domains/lookup on apps/api.
//
// Zero value is unsafe — BaseURL must be set. AuthToken is required by
// the gateway in production; an empty token will get a 401. HTTPClient
// defaults to a 5s-timeout client. Cache is a sync.Map keyed by
// lowercase domain.
type SendDomainClient struct {
	BaseURL    string
	AuthToken  string
	HTTPClient *http.Client
	// CacheTTL overrides the default 10-minute TTL. Tests use shorter
	// values to exercise expiration; production should leave it at the
	// default.
	CacheTTL time.Duration

	// Cache is intentionally a sync.Map (not a map+mutex) because the
	// access pattern is read-heavy with rare writes — once each verified
	// domain is resolved, every subsequent DMARC report from the same
	// ESP for that domain is a cache hit. sync.Map is optimized for
	// exactly that pattern.
	Cache sync.Map // domain (string) -> cachedLookup
}

// LookupTenant returns the tenant id that owns domain.
//
// Returns ErrNotFound when the gateway responds 404 (no row, or row
// not verified). Returns a wrapped transport error otherwise.
//
// The cache is consulted first; misses are populated from the network
// response. Both positive and negative outcomes are cached so a
// noisy unmapped domain can't drown the gateway in repeated lookups.
func (c *SendDomainClient) LookupTenant(ctx context.Context, domain string) (string, error) {
	if c == nil {
		return "", errors.New("sendomain client: nil receiver")
	}
	domain = strings.ToLower(strings.TrimSpace(domain))
	if domain == "" {
		return "", errors.New("sendomain client: empty domain")
	}
	if c.BaseURL == "" {
		return "", errors.New("sendomain client: BaseURL not configured")
	}

	now := time.Now()
	if v, ok := c.Cache.Load(domain); ok {
		if entry, ok2 := v.(cachedLookup); ok2 && now.Before(entry.ExpiresAt) {
			if entry.Err != nil {
				return "", entry.Err
			}
			return entry.TenantID, nil
		}
		// Expired — drop so the request below repopulates.
		c.Cache.Delete(domain)
	}

	tenantID, err := c.fetch(ctx, domain)
	c.cacheStore(domain, tenantID, err)
	return tenantID, err
}

// fetch is the un-cached path: builds the request, parses the
// response, and returns either (tenant_id, nil), ("", ErrNotFound), or
// ("", wrappedErr).
func (c *SendDomainClient) fetch(ctx context.Context, domain string) (string, error) {
	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultClientTimeout}
	}

	endpoint, err := sendDomainLookupURL(c.BaseURL, domain)
	if err != nil {
		return "", fmt.Errorf("sendomain client: build request URL: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", fmt.Errorf("sendomain client: build request: %w", err)
	}
	if c.AuthToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.AuthToken)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("sendomain client: do: %w", err)
	}
	defer func() {
		// Drain to allow connection reuse, then close.
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	switch resp.StatusCode {
	case http.StatusOK:
		var body struct {
			TenantID string `json:"tenant_id"`
		}
		if resp.ContentLength > sendDomainLookupMaxResponseBytes {
			return "", errors.New("sendomain client: response body too large")
		}
		if err := decodeJSONLimited(resp.Body, sendDomainLookupMaxResponseBytes, &body); err != nil {
			return "", fmt.Errorf("sendomain client: decode 200 body: %w", err)
		}
		if body.TenantID == "" {
			return "", errors.New("sendomain client: 200 response missing tenant_id")
		}
		return body.TenantID, nil
	case http.StatusNotFound:
		return "", ErrNotFound
	case http.StatusUnauthorized, http.StatusForbidden:
		return "", fmt.Errorf("sendomain client: auth rejected (status %d)", resp.StatusCode)
	case http.StatusBadRequest:
		return "", fmt.Errorf("sendomain client: bad request (domain rejected by gateway): %s", domain)
	default:
		return "", fmt.Errorf("sendomain client: unexpected status %d", resp.StatusCode)
	}
}

func decodeJSONLimited(r io.Reader, maxBytes int64, out any) error {
	buf, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(buf)) > maxBytes {
		return errors.New("response body too large")
	}
	return json.Unmarshal(buf, out)
}

// cacheStore inserts (or refreshes) the cache entry for domain. We
// only memoize the two outcomes the resolver can act on: a tenant id
// (success) and ErrNotFound (memoized miss). Transport / auth /
// gateway errors are NOT cached — they're transient and re-trying on
// the next report is the correct behavior.
func (c *SendDomainClient) cacheStore(domain, tenantID string, err error) {
	switch {
	case err == nil:
		c.Cache.Store(domain, cachedLookup{
			TenantID:  tenantID,
			ExpiresAt: time.Now().Add(c.ttl()),
		})
	case errors.Is(err, ErrNotFound):
		c.Cache.Store(domain, cachedLookup{
			Err:       ErrNotFound,
			ExpiresAt: time.Now().Add(c.ttl()),
		})
	}
	// Other errors: leave the cache untouched so the next call retries.
}

func (c *SendDomainClient) ttl() time.Duration {
	if c.CacheTTL > 0 {
		return c.CacheTTL
	}
	return defaultCacheTTL
}

func sendDomainLookupURL(baseRaw, domain string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe base URL")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/api/internal/send-domains/lookup"
	q := base.Query()
	q.Set("domain", domain)
	base.RawQuery = q.Encode()
	return base.String(), nil
}
