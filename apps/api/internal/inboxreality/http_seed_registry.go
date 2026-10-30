// SPDX-License-Identifier: AGPL-3.0-only

// http_seed_registry.go — the production SeedRegistry.
//
// The seedlist YAML is owned by the deliverability service, which is the only
// component holding the IMAP credentials that read those mailboxes. This
// client reads the service's catalog projection over the same signed internal
// channel as dispatch, and receives addresses only — never credentials.
//
// Historically this type was named in comments but never written, so the only
// registry that existed was the catalog-only fallback that returns zero seeds.
// That made manual Inbox Reality tests fail closed on every deployment.

package inboxreality

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
	"github.com/postwave/postwave/packages/runtime/internalsign"
)

// The catalog is a list of mailbox IDs and addresses; a megabyte is already
// several thousand seeds. The bound exists so an unexpected response body
// cannot be read into memory unbounded.
const maxSeedlistResponseBytes int64 = 1 << 20

type HTTPSeedRegistry struct {
	BaseURL       string
	BearerToken   string
	SigningSecret string
	HTTPClient    *http.Client
	Clock         func() time.Time
}

func (r *HTTPSeedRegistry) Validate() error {
	if r == nil || strings.TrimSpace(r.SigningSecret) == "" || strings.TrimSpace(r.BearerToken) == "" {
		return fmt.Errorf("inboxreality: seed registry requires a bearer token and signing secret")
	}
	if _, err := internalEndpoint(r.BaseURL, inboxrealitycontract.SeedlistPath); err != nil {
		return fmt.Errorf("inboxreality: seed registry endpoint: %w", err)
	}
	return nil
}

// Seeds returns the active controlled mailboxes.
//
// Every failure path returns an error rather than an empty slice. The
// orchestrator treats an empty list as ErrNoActiveSeeds — "you have not
// configured any seeds" — which would send an operator looking for missing
// configuration when the real fault is an unreachable dependency.
func (r *HTTPSeedRegistry) Seeds(ctx context.Context) ([]SeedAddress, error) {
	catalog, err := r.fetch(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]SeedAddress, 0, len(catalog.Seeds))
	for _, entry := range catalog.Seeds {
		address := strings.TrimSpace(entry.Address)
		mailboxID := strings.TrimSpace(entry.MailboxID)
		// A seed with no address or no identity cannot receive a test. Keeping
		// it would inflate the count and mint a test that never observes.
		if address == "" || mailboxID == "" {
			continue
		}
		provider := Provider(strings.TrimSpace(entry.Provider))
		out = append(out, SeedAddress{
			MailboxID:     mailboxID,
			Address:       address,
			Provider:      provider,
			ProviderLabel: provider.DisplayName(),
		})
	}
	return out, nil
}

// ProviderInfo returns the customer-facing provider matrix.
//
// It starts from the gateway's own AllProviders catalog and overlays the live
// counts, so a provider the service does not currently list still appears at
// zero. A column that disappears when its last seed is quarantined reads as
// "this provider was never supported" rather than "it has no capacity today".
func (r *HTTPSeedRegistry) ProviderInfo(ctx context.Context) ([]ProviderInfo, error) {
	catalog, err := r.fetch(ctx)
	if err != nil {
		return nil, err
	}
	live := make(map[Provider]inboxrealitycontract.SeedProvider, len(catalog.Providers))
	for _, provider := range catalog.Providers {
		live[Provider(strings.TrimSpace(provider.Provider))] = provider
	}
	out := make([]ProviderInfo, 0, len(AllProviders))
	for _, provider := range AllProviders {
		info := ProviderInfo{
			Provider: provider,
			// Display copy is the gateway's, never the service's.
			Label: provider.DisplayName(),
		}
		if reported, ok := live[provider]; ok {
			info.SeedCount = reported.SeedCount
			info.HasCategorizer = reported.HasCategorizer
		}
		out = append(out, info)
	}
	return out, nil
}

// VerifyProductionCapacity reports whether this deployment meets the private
// production release gate for controlled mailbox capacity.
//
// Deliberately NOT folded into fetch. A development deployment with fewer
// seeds can still exercise the path, while release certification asks this
// separate question and surfaces the answer to operators.
func (r *HTTPSeedRegistry) VerifyProductionCapacity(ctx context.Context) error {
	catalog, err := r.fetch(ctx)
	if err != nil {
		return err
	}
	return inboxrealitycontract.VerifyProductionSeedlistCapacity(catalog)
}

func (r *HTTPSeedRegistry) fetch(ctx context.Context) (inboxrealitycontract.SeedlistResponse, error) {
	var empty inboxrealitycontract.SeedlistResponse
	if err := r.Validate(); err != nil {
		return empty, err
	}
	endpoint, err := internalEndpoint(r.BaseURL, inboxrealitycontract.SeedlistPath)
	if err != nil {
		return empty, fmt.Errorf("inboxreality: seed registry endpoint: %w", err)
	}
	now := time.Now().UTC()
	if r.Clock != nil {
		now = r.Clock().UTC()
	}
	// Sign the path we will actually DELIVER, not the bare contract path. The
	// service verifies against r.URL.EscapedPath(), so when the configured base
	// URL carries a prefix — any path-routed ingress — signing the bare path
	// produces a signature over a different string than the one verified, and
	// every request 401s in precisely those deployments.
	target, err := url.Parse(endpoint)
	if err != nil {
		return empty, fmt.Errorf("inboxreality: seed catalog endpoint: %w", err)
	}
	signed, err := internalsign.Sign(r.SigningSecret, http.MethodGet,
		target.EscapedPath(), inboxrealitycontract.SeedlistRequestID, nil, now)
	if err != nil {
		return empty, fmt.Errorf("inboxreality: sign seed catalog request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return empty, fmt.Errorf("inboxreality: seed catalog request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(r.BearerToken))
	internalsign.Apply(request.Header, signed)

	client := r.HTTPClient
	if client == nil {
		// This sits in the request path of test creation, so it must fail fast
		// rather than hold the caller open on an unreachable service.
		client = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return empty, fmt.Errorf("inboxreality: seed catalog unreachable: %w", err)
	}
	defer func() { _, _ = io.Copy(io.Discard, response.Body); _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return empty, fmt.Errorf("inboxreality: seed catalog status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxSeedlistResponseBytes+1))
	if err != nil || int64(len(body)) > maxSeedlistResponseBytes {
		return empty, fmt.Errorf("inboxreality: seed catalog response too large or unreadable")
	}
	var catalog inboxrealitycontract.SeedlistResponse
	if err := json.Unmarshal(body, &catalog); err != nil {
		return empty, fmt.Errorf("inboxreality: seed catalog decode: %w", err)
	}
	// Refuse a catalog whose shape we do not recognise rather than reading a
	// future version's fields positionally and advertising the wrong mailboxes.
	if catalog.ContractVersion != inboxrealitycontract.SeedlistVersion {
		return empty, fmt.Errorf("inboxreality: seed catalog contract %q is not %q",
			catalog.ContractVersion, inboxrealitycontract.SeedlistVersion)
	}
	return catalog, nil
}
