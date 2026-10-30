// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"errors"
	"flag"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

// Provider origins are code-owned. In particular, neither a tenant setting nor
// a credential payload can replace one of these values.
const (
	zeroBounceOrigin = "https://api.zerobounce.net"
	// Real-time /v2/validatebatch shares the primary API origin. The separate
	// bulkapi host is for asynchronous file workflows, which this adapter does
	// not use.
	zeroBounceBulkOrigin = zeroBounceOrigin
	kickboxOrigin        = "https://api.kickbox.com"
)

var errProviderRedirect = errors.New("verification provider redirects are disabled")

type providerOriginKind uint8

const (
	providerPrimaryOrigin providerOriginKind = iota + 1
	providerBulkOrigin
)

func officialProviderOrigin(provider string, kind providerOriginKind) (string, error) {
	var raw string
	switch {
	case provider == ProviderZeroBounce && kind == providerPrimaryOrigin:
		raw = zeroBounceOrigin
	case provider == ProviderZeroBounce && kind == providerBulkOrigin:
		raw = zeroBounceBulkOrigin
	case provider == ProviderKickbox && kind == providerPrimaryOrigin:
		raw = kickboxOrigin
	default:
		return "", errors.New("verification provider has no official origin")
	}
	if err := validateOfficialProviderOrigin(provider, kind, raw); err != nil {
		return "", err
	}
	return raw, nil
}

// validateOfficialProviderOrigin is deliberately stricter than a general URL
// validator: an origin must have exactly the vendor's HTTPS hostname and no
// userinfo, explicit port, path, query, or fragment. API paths are appended by
// the driver from constants after this check.
func validateOfficialProviderOrigin(provider string, kind providerOriginKind, raw string) error {
	want := ""
	switch {
	case provider == ProviderZeroBounce && kind == providerPrimaryOrigin:
		want = zeroBounceOrigin
	case provider == ProviderZeroBounce && kind == providerBulkOrigin:
		want = zeroBounceBulkOrigin
	case provider == ProviderKickbox && kind == providerPrimaryOrigin:
		want = kickboxOrigin
	default:
		return errors.New("verification provider has no official origin")
	}

	u, err := url.Parse(raw)
	if err != nil || u == nil || u.Scheme != "https" || u.User != nil ||
		u.Port() != "" || u.Path != "" || u.RawPath != "" || u.RawQuery != "" ||
		u.Fragment != "" || u.Opaque != "" || !strings.EqualFold(u.Hostname(), mustHostname(want)) ||
		raw != want {
		return errors.New("verification provider origin is not an approved official HTTPS origin")
	}
	return integration_egress.ValidateURL(integration_egress.FamilyVerification, provider, raw)
}

func mustHostname(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u == nil {
		panic("invalid checked-in verification provider origin")
	}
	return u.Hostname()
}

func newProviderHTTPClient(provider string, timeout time.Duration) *http.Client {
	return newProviderHTTPClientWithResponseHeaderTimeout(provider, timeout, 0)
}

func newProviderHTTPClientWithResponseHeaderTimeout(
	provider string,
	timeout, responseHeaderTimeout time.Duration,
) *http.Client {
	var client *http.Client
	if responseHeaderTimeout > 0 {
		client = integration_egress.NewClientWithResponseHeaderTimeout(
			integration_egress.FamilyVerification,
			provider,
			timeout,
			responseHeaderTimeout,
		)
	} else {
		client = integration_egress.NewClient(
			integration_egress.FamilyVerification,
			provider,
			timeout,
		)
	}
	// Even an official-origin redirect is unnecessary for these stable API
	// endpoints. Refusing every redirect prevents accidental credential replay
	// and makes a provider-side routing change fail visibly.
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errProviderRedirect
	}
	return client
}

var (
	zeroBounceHTTPClient      = newProviderHTTPClient(ProviderZeroBounce, DefaultProviderTimeout)
	zeroBounceBatchHTTPClient = newProviderHTTPClientWithResponseHeaderTimeout(
		ProviderZeroBounce,
		ZeroBounceBatchHTTPTimeout,
		ZeroBounceBatchResponseHeaderTimeout,
	)
	kickboxHTTPClient = newProviderHTTPClient(ProviderKickbox, DefaultProviderTimeout)
)

func productionProviderHTTPClient(provider string) *http.Client {
	switch provider {
	case ProviderZeroBounce:
		return zeroBounceHTTPClient
	case ProviderKickbox:
		return kickboxHTTPClient
	default:
		panic("unknown verification provider HTTP client")
	}
}

func productionZeroBounceBatchHTTPClient() *http.Client {
	return zeroBounceBatchHTTPClient
}

// providerTestHooks is the only endpoint/client injection seam. It is
// unexported and ignored outside a `go test` binary, so API input and
// production composition cannot enable it.
type providerTestHooks struct {
	baseURL string
	bulkURL string
	client  *http.Client
}

func providerTestHooksEnabled() bool { return flag.Lookup("test.v") != nil }
