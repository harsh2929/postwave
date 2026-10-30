// SPDX-License-Identifier: AGPL-3.0-only

// catalog.go — the seed catalog as the API gateway is allowed to see it.
//
// The gateway needs to know which controlled mailboxes exist so it can offer a
// manual Inbox Reality test. It must NOT learn how to read them: the IMAP
// account, password, and secret references stay inside this service, which is
// the only component with a reason to open those mailboxes.
//
// That separation is enforced by the shape of the wire type rather than by
// remembering to strip fields — see inboxrealitycontract.SeedEntry.

package seedlist

import (
	"sort"
	"time"

	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
	"github.com/postwave/postwave/services/deliverability/internal/domain"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

func providerKey(raw string) domain.Provider { return domain.Provider(raw) }

// defaultCategorizers is the one place the provider→categorizer mapping is
// declared. The poller uses it to classify placements and the catalog uses it
// to report which providers can be classified at all; deriving both from this
// map keeps the advertised capability and the real one from drifting apart.
func defaultCategorizers() map[domain.Provider]categorizers.Categorizer {
	return map[domain.Provider]categorizers.Categorizer{
		domain.ProviderGmail:      categorizers.Gmail{},
		domain.ProviderOutlookCom: categorizers.Outlook{},
		domain.ProviderO365:       categorizers.Outlook{O365: true},
		domain.ProviderICloud:     categorizers.Apple{},
		domain.ProviderYahoo:      categorizers.Yahoo{},
		domain.ProviderProton:     categorizers.Proton{},
		domain.ProviderGMX:        categorizers.GMX{},
		domain.ProviderMailRu:     categorizers.MailRu{},
	}
}

func defaultCategorizerProviders() map[domain.Provider]struct{} {
	out := map[domain.Provider]struct{}{}
	for provider := range defaultCategorizers() {
		out[provider] = struct{}{}
	}
	return out
}

// Map iteration order is randomized, and an unstable provider matrix makes a
// response diff unreadable and a cached client render columns in a new order
// on every poll.
func sortProviders(providers []inboxrealitycontract.SeedProvider) {
	sort.Slice(providers, func(a, b int) bool {
		return providers[a].Provider < providers[b].Provider
	})
}

// Catalog projects the live registry into the internal seed catalog.
//
// Only ACTIVE mailboxes are published. A flagged or banned seed still sits in
// the registry — it is quarantined, not deleted — but it cannot produce a
// placement observation, so handing it to the gateway would mint a test that
// looks accepted and then never completes.
func Catalog(registry *Registry) inboxrealitycontract.SeedlistResponse {
	response := inboxrealitycontract.SeedlistResponse{
		ContractVersion: inboxrealitycontract.SeedlistVersion,
		Seeds:           []inboxrealitycontract.SeedEntry{},
		Providers:       []inboxrealitycontract.SeedProvider{},
		CapturedAt:      time.Now().UTC(),
	}
	if registry == nil {
		return response
	}

	categorizers := defaultCategorizerProviders()
	// Every provider that has a categorizer gets a row even with zero active
	// seeds, so the dashboard's provider matrix stays a stable shape rather
	// than having columns appear and vanish as seeds are quarantined.
	active := map[domain.Provider]int{}
	for provider := range categorizers {
		active[provider] = 0
	}

	for _, inbox := range registry.Snapshot() {
		if inbox == nil || inbox.Status != StatusActive {
			continue
		}
		// A seed with no resolved address cannot receive the test. Publishing
		// it would inflate the provider count with capacity that does not exist.
		if inbox.Address == "" {
			continue
		}
		active[inbox.Provider]++
		response.Seeds = append(response.Seeds, inboxrealitycontract.SeedEntry{
			MailboxID: inbox.ID,
			Provider:  string(inbox.Provider),
			Address:   inbox.Address,
		})
	}

	for provider, count := range active {
		_, hasCategorizer := categorizers[provider]
		response.Providers = append(response.Providers, inboxrealitycontract.SeedProvider{
			Provider:       string(provider),
			SeedCount:      count,
			HasCategorizer: hasCategorizer,
		})
	}
	sortProviders(response.Providers)
	return response
}
