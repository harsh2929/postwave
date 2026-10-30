// SPDX-License-Identifier: AGPL-3.0-only
package integration_writeback

import (
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

// Outbound HTTP for the write-back adapters, bound to the same host policy the
// READ path has always enforced.
//
// ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
// Every one of the seven adapters built a bare `&http.Client{Timeout: …}` and
// dialled a destination derived from TENANT-SUPPLIED settings. Shopify is the
// clearest case: `shopifyGraphQLEndpoint` lets an `api_base_url` setting win
// outright with nothing but a trailing-slash trim, and the resulting URL was
// dialled by a client with no policy — while `integration_egress` pins the
// commerce/shopify READ path to myshopify.com and shopify.com.
//
// So the same tenant setting was host-checked when we read from a provider and
// unchecked when we wrote back to it, with the tenant's credentials attached.
// That is an SSRF surface: an `api_base_url` pointing at a link-local or
// internal address would have been dialled, and the write-back worker runs
// server-side with no user watching.
//
// ── WHY IT SURVIVED ────────────────────────────────────────────────────────
// `integration_egress/raw_client_guard_test.go` exists to catch exactly this
// and iterates a HAND-WRITTEN list of nine package names. This package was not
// on it, so the guard was green while seven providers violated the rule it
// enforces. See `TestEveryEgressingPackageIsGuarded`, which now derives that
// list instead of trusting it.
//
// ── WHAT THIS DOES ─────────────────────────────────────────────────────────
// Every provider here already had a policy in the checked-in inventory; the
// write path simply never asked for it. `writebackFamilies` maps each provider
// onto the family whose policy applies, and both entry points below route
// through `integration_egress`, including an injected client — a test double is
// still allowed, but a real client handed in by a caller gets the policy too.
var writebackFamilies = map[string]string{
	ProviderShopify:     integration_egress.FamilyCommerce,
	ProviderWooCommerce: integration_egress.FamilyCommerce,
	ProviderHubSpot:     integration_egress.FamilyCRM,
	ProviderSalesforce:  integration_egress.FamilyCRM,
	ProviderPipedrive:   integration_egress.FamilyCRM,
	ProviderZoho:        integration_egress.FamilyCRM,
	ProviderKlaviyo:     integration_egress.FamilyMarketing,
}

// egressClient returns the policy-bound client for a provider.
//
// An unknown provider gets the CRM policy for a provider name that does not
// exist, which resolves to the inventory's default-deny rather than to an
// unpoliced client. Failing closed matters more here than a tidy error: the
// caller is about to send a tenant's credentials somewhere.
func egressClient(provider string, injected *http.Client) *http.Client {
	family, ok := writebackFamilies[provider]
	if !ok {
		family = integration_egress.FamilyCRM
	}
	if injected != nil {
		return integration_egress.EnforceClient(injected, family, provider, writebackHTTPTimeout)
	}
	return integration_egress.NewClient(family, provider, writebackHTTPTimeout)
}
