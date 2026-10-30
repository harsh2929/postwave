// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/activation_firewall"
	"github.com/postwave/postwave/apps/api/internal/audience_destinations"
	"github.com/postwave/postwave/apps/api/internal/integration_writeback"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// AudienceActivationDeps carries the process-wide dependencies shared by the
// audience-sync, consent-firewall, reverse-ETL, and adjacent worker graphs.
// Optional integrations stay nilable so their existing degraded behavior is
// preserved; Router, Pool, and this graph itself are the structural boundary.
type AudienceActivationDeps struct {
	Suppressions   *suppressions.Store
	Secrets        audience_destinations.AudienceRuntimeSecretResolver
	HTTPClient     *http.Client
	KlaviyoStore   integration_writeback.KlaviyoCredentialStore
	RequireHTTPS   bool
	ReceiptSignKey string
}

// AudienceActivationSurface is the exact graph mounted on the authenticated
// router and reused by schedulers plus zero-copy activation. Returning these
// identities prevents workers from accidentally constructing divergent repos,
// adapter registries, filters, or receipt-signing configuration.
type AudienceActivationSurface struct {
	Filter       *activation_firewall.Filter
	ReceiptStore *activation_firewall.Repo
	ReceiptKey   string
	SyncRepo     *audience_destinations.Repo
	Adapters     audience_destinations.AdapterRegistry
	SyncRunner   *audience_destinations.SyncRunner
	Writeback    *integration_writeback.Deps
}

// MountAudienceActivationSurface assembles and registers audience syncs,
// credentialed audience destinations, integration write-back, and the consent
// firewall in their original order. The returned graph must be passed to the
// adjacent schedulers and zero-copy worker.
func MountAudienceActivationSurface(deps Deps) AudienceActivationSurface {
	if deps.Router == nil || deps.Pool == nil || deps.AudienceActivation == nil {
		return AudienceActivationSurface{}
	}

	graph := deps.AudienceActivation
	logger := deps.Log()
	filter := activation_firewall.New(
		&activation_firewall.PurposeBatchAdapter{Pool: deps.Pool},
		suppressions.NewConverger(graph.Suppressions, logger),
	)
	receiptStore := activation_firewall.NewRepo(deps.Pool)
	receiptKey := strings.TrimSpace(graph.ReceiptSignKey)
	if receiptKey == "" {
		logger.Warn("activation_firewall: POSTWAVE_RECEIPT_SIGNING_KEY unset — exclusion receipts will be unsigned (degraded tamper-evidence)")
	}

	syncRepo := &audience_destinations.Repo{Pool: deps.Pool}
	adapters := audience_destinations.DefaultAdapterRegistry()
	credentialResolver := audience_destinations.SecretsAudienceCredentialResolver{Secrets: graph.Secrets}
	syncRunner := &audience_destinations.SyncRunner{
		Repo:               syncRepo,
		HTTPClient:         graph.HTTPClient,
		Logger:             logger,
		Firewall:           filter,
		ReceiptStore:       receiptStore,
		ReceiptSignKey:     receiptKey,
		Adapters:           adapters,
		CredentialResolver: credentialResolver,
	}
	audience_destinations.MountSyncRoutes(deps.Router, &audience_destinations.SyncDeps{
		Repo:         syncRepo,
		Runner:       syncRunner,
		Logger:       logger,
		RequireHTTPS: graph.RequireHTTPS,
	})
	audience_destinations.MountRoutes(deps.Router, &audience_destinations.Deps{
		Repo:               syncRepo,
		CredentialResolver: credentialResolver,
		Logger:             logger,
		Adapters:           adapters,
		Runner:             syncRunner,
	})
	writeback := &integration_writeback.Deps{
		Repo: &integration_writeback.Repo{Pool: deps.Pool},
		Credentials: integration_writeback.MarketingAwareCredentialResolver{
			Secrets:      graph.Secrets,
			KlaviyoStore: graph.KlaviyoStore,
		},
		Adapters: map[string]integration_writeback.Adapter{
			integration_writeback.ProviderShopify:     integration_writeback.ShopifyWritebackAdapter{},
			integration_writeback.ProviderHubSpot:     integration_writeback.HubSpotWritebackAdapter{},
			integration_writeback.ProviderSalesforce:  integration_writeback.SalesforceWritebackAdapter{},
			integration_writeback.ProviderPipedrive:   integration_writeback.PipedriveWritebackAdapter{},
			integration_writeback.ProviderWooCommerce: integration_writeback.WooCommerceWritebackAdapter{},
			integration_writeback.ProviderZoho:        integration_writeback.ZohoWritebackAdapter{},
			integration_writeback.ProviderKlaviyo:     integration_writeback.KlaviyoWritebackAdapter{},
		},
		Logger: logger,
	}
	integration_writeback.MountRoutes(deps.Router, writeback)
	activation_firewall.MountSyncRoutes(deps.Router, &activation_firewall.SyncDeps{
		Filter:  filter,
		Store:   receiptStore,
		Source:  audience_destinations.NewFirewallMemberSource(syncRunner),
		SignKey: receiptKey,
		Logger:  logger,
	})
	activation_firewall.MountRoutes(deps.Router, &activation_firewall.Deps{
		Store:  receiptStore,
		Logger: logger,
	})

	return AudienceActivationSurface{
		Filter:       filter,
		ReceiptStore: receiptStore,
		ReceiptKey:   receiptKey,
		SyncRepo:     syncRepo,
		Adapters:     adapters,
		SyncRunner:   syncRunner,
		Writeback:    writeback,
	}
}
