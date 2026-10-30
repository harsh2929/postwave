// SPDX-License-Identifier: AGPL-3.0-only
//
// seedlist.go — SeedRegistry implementations.
//
// The customer-facing /providers + /tests endpoints need to know
// which seed addresses to advertise. There are two sources of truth:
//
//  1. The deliverability service's seedlist YAML (production). The
//     service loads it at boot and projects it, credential-free, over
//     the signed internal endpoint declared as
//     inboxrealitycontract.SeedlistPath. HTTPSeedRegistry in
//     http_seed_registry.go is the client.
//
//  2. A static fallback shipped here so the gateway boots even when
//     the deliverability service is unreachable. It returns ONLY the
//     provider catalog (no addresses) — without real seed addresses
//     the customer's dispatcher can't actually send the test, but
//     the dashboard at least renders the provider matrix.
//
// The composition root prefers HTTPSeedRegistry and falls back to
// StaticSeedRegistry only when the deliverability trust boundary is
// unconfigured. A catalog-only registry cannot create a test.

package inboxreality

import "context"

// StaticSeedRegistry returns the canonical eight providers with zero
// seed addresses. Useful as a boot-time fallback and in tests.
type StaticSeedRegistry struct{}

// Seeds returns an empty slice — the static registry has no real
// addresses to hand out. CreateTest fails closed instead of minting a test that
// no controlled mailbox can execute. Reaching this in production means the
// deliverability trust boundary is unconfigured; HTTPSeedRegistry is the
// registry that can actually create a test.
func (StaticSeedRegistry) Seeds(_ context.Context) ([]SeedAddress, error) {
	return []SeedAddress{}, nil
}

// ProviderInfo returns the canonical catalog with seedCount=0 and
// hasCategorizer=true for every provider in AllProviders.
func (StaticSeedRegistry) ProviderInfo(_ context.Context) ([]ProviderInfo, error) {
	out := make([]ProviderInfo, 0, len(AllProviders))
	for _, p := range AllProviders {
		out = append(out, ProviderInfo{
			Provider:       p,
			Label:          p.DisplayName(),
			SeedCount:      0,
			HasCategorizer: true,
		})
	}
	return out, nil
}
