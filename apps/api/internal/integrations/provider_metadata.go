// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"reflect"
	"strings"

	analyticsintegrations "github.com/postwave/postwave/apps/api/internal/analytics_integrations"
	"github.com/postwave/postwave/apps/api/internal/commerce"
	crmintegrations "github.com/postwave/postwave/apps/api/internal/crm_integrations"
	leadintegrations "github.com/postwave/postwave/apps/api/internal/lead_integrations"
	loyaltyintegrations "github.com/postwave/postwave/apps/api/internal/loyalty_integrations"
	marketingintegrations "github.com/postwave/postwave/apps/api/internal/marketing_integrations"
	reviewintegrations "github.com/postwave/postwave/apps/api/internal/review_integrations"
	subscriptionintegrations "github.com/postwave/postwave/apps/api/internal/subscription_integrations"
	supportintegrations "github.com/postwave/postwave/apps/api/internal/support_integrations"
	"github.com/postwave/postwave/apps/api/internal/warehouse"
)

type providerFieldMetadata struct {
	Key      string
	Label    string
	Required bool
	Secret   bool
	Help     string
}

type managedProviderMetadata struct {
	Provider       string
	Name           string
	Surface        string
	BasePath       string
	AuthMode       string
	RuntimeStatus  string
	SyncModel      string
	Verification   string
	RequiredFields []providerFieldMetadata
	OptionalFields []providerFieldMetadata
	Scopes         []string
	SyncObjects    []string
	WebhookTopics  []string
	DocsURL        string
	ActionPaths    map[string]string
}

func managedProviderMetadataForItem(item CatalogItem) (managedProviderMetadata, bool) {
	provider := connectionIDProvider(item)
	switch {
	case hasSource(item, "marketing_integration"):
		spec, ok := marketingintegrations.ProviderSpecByKey(provider)
		if !ok {
			return managedProviderMetadata{}, false
		}
		actionPaths := map[string]string{
			"connect/start": "POST /api/v1/marketing-integrations",
			"sync":          "POST /api/v1/marketing-integrations/{id}/sync",
			"backfill":      "POST /api/v1/marketing-integrations/{id}/backfill",
			"pause":         "POST /api/v1/marketing-integrations/{id}/pause",
			"disconnect":    "DELETE /api/v1/marketing-integrations/{id}",
			"runs":          "GET /api/v1/marketing-integrations/{id}/runs",
		}
		if spec.Provider == marketingintegrations.ProviderKlaviyo {
			actionPaths["oauth/availability"] = "GET /api/v1/marketing-integrations/klaviyo/oauth/availability"
			actionPaths["oauth/start"] = "GET /api/v1/marketing-integrations/klaviyo/oauth/start"
			actionPaths["oauth/callback"] = "GET /api/v1/marketing-integrations/klaviyo/oauth/callback"
			actionPaths["provider-cleanup/acknowledge"] = "POST /api/v1/marketing-integrations/{id}/provider-cleanup/acknowledge"
		}
		return managedProviderMetadata{
			Provider:       spec.Provider,
			Name:           spec.Name,
			Surface:        "Marketing integrations",
			BasePath:       "/api/v1/marketing-integrations",
			AuthMode:       spec.AuthMode,
			RuntimeStatus:  spec.RuntimeStatus,
			SyncModel:      spec.SyncModel,
			Verification:   spec.VerificationMode,
			RequiredFields: specFields(spec.RequiredSettings),
			OptionalFields: specFields(spec.OptionalSettings),
			Scopes:         append([]string(nil), spec.Scopes...),
			SyncObjects:    append([]string(nil), spec.SyncObjects...),
			WebhookTopics:  append([]string(nil), spec.WebhookTopics...),
			DocsURL:        spec.DocsURL,
			ActionPaths:    actionPaths,
		}, true
	case hasSource(item, "commerce"):
		spec, ok := commerce.CommerceProviderSpec(provider)
		if !ok {
			return managedProviderMetadata{}, false
		}
		actionPaths := map[string]string(nil)
		if spec.Provider == commerce.ProviderShopify {
			actionPaths = map[string]string{
				"connect/start": "GET /api/v1/commerce/shopify/oauth/start?shop={shop_domain}",
			}
		}
		return managedProviderMetadata{
			Provider:       spec.Provider,
			Name:           spec.Name,
			Surface:        "Commerce integrations",
			BasePath:       "/api/v1/commerce/integrations",
			AuthMode:       spec.AuthMode,
			RuntimeStatus:  spec.RuntimeStatus,
			SyncModel:      spec.SyncModel,
			Verification:   spec.VerificationMode,
			RequiredFields: specFields(spec.RequiredSettings),
			OptionalFields: specFields(spec.OptionalSettings),
			Scopes:         append([]string(nil), spec.Scopes...),
			SyncObjects:    append([]string(nil), spec.SyncObjects...),
			WebhookTopics:  append([]string(nil), spec.WebhookTopics...),
			DocsURL:        spec.DocsURL,
			ActionPaths:    actionPaths,
		}, true
	case hasSource(item, "crm"):
		spec, ok := crmintegrations.ProviderSpecByKey(provider)
		if !ok {
			return managedProviderMetadata{}, false
		}
		return managedProviderMetadata{
			Provider:       spec.Provider,
			Name:           spec.Name,
			Surface:        "CRM integrations",
			BasePath:       "/api/v1/crm/integrations",
			AuthMode:       spec.AuthMode,
			RuntimeStatus:  spec.RuntimeStatus,
			SyncModel:      spec.SyncModel,
			Verification:   spec.VerificationMode,
			RequiredFields: specFields(spec.RequiredSettings),
			OptionalFields: specFields(spec.OptionalSettings),
			Scopes:         append([]string(nil), spec.Scopes...),
			SyncObjects:    append([]string(nil), spec.SyncObjects...),
			WebhookTopics:  append([]string(nil), spec.WebhookTopics...),
			DocsURL:        spec.DocsURL,
		}, true
	case hasSource(item, "lead_capture"):
		spec, ok := leadintegrations.ProviderSpecByKey(provider)
		if !ok {
			return managedProviderMetadata{}, false
		}
		return managedProviderMetadata{
			Provider:       spec.Provider,
			Name:           spec.Name,
			Surface:        "Lead integrations",
			BasePath:       "/api/v1/lead-integrations",
			AuthMode:       spec.AuthMode,
			RuntimeStatus:  spec.RuntimeStatus,
			SyncModel:      spec.SyncModel,
			Verification:   spec.VerificationMode,
			RequiredFields: specFields(spec.RequiredSettings),
			OptionalFields: specFields(spec.OptionalSettings),
			Scopes:         append([]string(nil), spec.Scopes...),
			SyncObjects:    append([]string(nil), spec.SyncObjects...),
			WebhookTopics:  append([]string(nil), spec.WebhookTopics...),
			DocsURL:        spec.DocsURL,
		}, true
	case hasSource(item, "review_integration"):
		spec, ok := reviewintegrations.ProviderSpecByKey(provider)
		if !ok {
			return managedProviderMetadata{}, false
		}
		return managedProviderMetadata{
			Provider:       spec.Provider,
			Name:           spec.Name,
			Surface:        "Review integrations",
			BasePath:       "/api/v1/review-integrations",
			AuthMode:       spec.AuthMode,
			RuntimeStatus:  spec.RuntimeStatus,
			SyncModel:      spec.SyncModel,
			Verification:   spec.VerificationMode,
			RequiredFields: specFields(spec.RequiredSettings),
			OptionalFields: specFields(spec.OptionalSettings),
			Scopes:         append([]string(nil), spec.Scopes...),
			SyncObjects:    append([]string(nil), spec.SyncObjects...),
			WebhookTopics:  append([]string(nil), spec.WebhookTopics...),
			DocsURL:        spec.DocsURL,
		}, true
	case hasSource(item, "loyalty_integration"):
		spec, ok := loyaltyintegrations.ProviderSpecByKey(provider)
		if !ok {
			return managedProviderMetadata{}, false
		}
		return managedProviderMetadata{
			Provider:       spec.Provider,
			Name:           spec.Name,
			Surface:        "Loyalty integrations",
			BasePath:       "/api/v1/loyalty-integrations",
			AuthMode:       spec.AuthMode,
			RuntimeStatus:  spec.RuntimeStatus,
			SyncModel:      spec.SyncModel,
			Verification:   spec.VerificationMode,
			RequiredFields: specFields(spec.RequiredSettings),
			OptionalFields: specFields(spec.OptionalSettings),
			Scopes:         append([]string(nil), spec.Scopes...),
			SyncObjects:    append([]string(nil), spec.SyncObjects...),
			WebhookTopics:  append([]string(nil), spec.WebhookTopics...),
			DocsURL:        spec.DocsURL,
		}, true
	case hasSource(item, "subscription_integration"):
		spec, ok := subscriptionintegrations.ProviderSpecByKey(provider)
		if !ok {
			return managedProviderMetadata{}, false
		}
		return managedProviderMetadata{
			Provider:       spec.Provider,
			Name:           spec.Name,
			Surface:        "Subscription integrations",
			BasePath:       "/api/v1/subscription-integrations",
			AuthMode:       spec.AuthMode,
			RuntimeStatus:  spec.RuntimeStatus,
			SyncModel:      spec.SyncModel,
			Verification:   spec.VerificationMode,
			RequiredFields: specFields(spec.RequiredSettings),
			OptionalFields: specFields(spec.OptionalSettings),
			Scopes:         append([]string(nil), spec.Scopes...),
			SyncObjects:    append([]string(nil), spec.SyncObjects...),
			WebhookTopics:  append([]string(nil), spec.WebhookTopics...),
			DocsURL:        spec.DocsURL,
		}, true
	case hasSource(item, "support_integration"):
		spec, ok := supportintegrations.ProviderSpecByKey(provider)
		if !ok {
			return managedProviderMetadata{}, false
		}
		return managedProviderMetadata{
			Provider: spec.Provider, Name: spec.Name,
			Surface: "Support integrations (release-held)", RuntimeStatus: "held",
			SyncModel: "unavailable", Verification: "unavailable",
		}, true
	case hasSource(item, "analytics_integration"):
		spec, ok := analyticsintegrations.ProviderSpecByKey(provider)
		if !ok {
			return managedProviderMetadata{}, false
		}
		return managedProviderMetadata{
			Provider:       spec.Provider,
			Name:           spec.Name,
			Surface:        "Analytics integrations",
			BasePath:       "/api/v1/analytics-integrations",
			AuthMode:       spec.AuthMode,
			RuntimeStatus:  spec.RuntimeStatus,
			SyncModel:      spec.SyncModel,
			Verification:   spec.VerificationMode,
			RequiredFields: specFields(spec.RequiredSettings),
			OptionalFields: specFields(spec.OptionalSettings),
			Scopes:         append([]string(nil), spec.Scopes...),
			SyncObjects:    append([]string(nil), spec.SyncObjects...),
			WebhookTopics:  append([]string(nil), spec.WebhookTopics...),
			DocsURL:        spec.DocsURL,
		}, true
	case hasSource(item, "warehouse"):
		spec, ok := warehouse.ProviderSpecByKey(provider)
		if !ok {
			return managedProviderMetadata{}, false
		}
		return managedProviderMetadata{
			Provider:       spec.Provider,
			Name:           spec.Name,
			Surface:        "Warehouse",
			BasePath:       "/api/v1/warehouse/connections",
			AuthMode:       spec.AuthMode,
			RuntimeStatus:  spec.RuntimeStatus,
			RequiredFields: specFields(spec.RequiredSettings),
			OptionalFields: specFields(spec.OptionalSettings),
			SyncObjects:    append([]string(nil), spec.SyncObjects...),
			DocsURL:        spec.DocsURL,
			ActionPaths: map[string]string{
				"sync":     "POST /api/v1/warehouse/connections/{id}/runs",
				"backfill": "POST /api/v1/warehouse/connections/{id}/runs",
			},
		}, true
	default:
		return managedProviderMetadata{}, false
	}
}

func isManagedProviderFamily(item CatalogItem) bool {
	return hasSource(item, "commerce") ||
		hasSource(item, "crm") ||
		hasSource(item, "lead_capture") ||
		hasSource(item, "review_integration") ||
		hasSource(item, "loyalty_integration") ||
		hasSource(item, "subscription_integration") ||
		hasSource(item, "analytics_integration") ||
		hasSource(item, "marketing_integration") ||
		hasSource(item, "warehouse")
}

func setupGuideForManagedProvider(item CatalogItem, meta managedProviderMetadata) []SetupStep {
	syncObjects := joinedOrDefault(meta.SyncObjects, "profiles, events, and provider objects")
	webhooks := joinedOrDefault(meta.WebhookTopics, "provider webhooks and scheduled sync runs")
	if isManagedAnalyticsPullerProvider(meta.Provider) {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the " + meta.Name + " credential reference and required provider identifiers through the Analytics integrations surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the " + meta.Name + " profile pull",
				Description: managedAnalyticsPullerSyncDescription(meta),
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify live analytics access",
				Description: "Watch analytics sync history, retry cursors, disconnect-safe local writes, and provider_cleanup evidence while live provider certification remains pending.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == commerce.ProviderWixStores {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Wix site, app instance, store identifier, credential reference, and webhook public-key reference through the Commerce integrations surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Wix provider pull",
				Description: "Pull " + syncObjects + " through Wix app-instance REST APIs, including Catalog V1/V3 product routing and eCommerce order search.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Wix app webhooks",
				Description: "Watch " + webhooks + " with signed JWT verification, durable idempotency, fetch fallback, retry cursors, delete evidence, and provider-event evidence.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == commerce.ProviderWooCommerce {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the WooCommerce store URL, consumer-key/secret credential reference, and optional subscriptions_enabled flag through the Commerce integrations surface; Moosewave keeps raw ck/cs values inside referenced secrets only.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the WooCommerce REST provider pull",
				Description: "Pull " + syncObjects + " through WooCommerce /wp-json/wc/v3 APIs, including Customers, Products, Orders, read-only Refunds, product variation pagination, coupon/refund order attribution, and optional Subscriptions extension snapshots.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify WooCommerce webhooks",
				Description: "Watch " + webhooks + " from managed WooCommerce webhooks with X-WC-Webhook-Signature verification, source and delivery idempotency, delete/coupon/refund/subscription evidence, force=true cleanup evidence, and Retry-After aware manual/scheduled retries.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == commerce.ProviderBigCommerce {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the BigCommerce store hash, API-account credential reference, optional channel ID, and webhook auth reference through the Commerce integrations surface; Moosewave manages /v3/hooks with a custom secret header.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the BigCommerce REST provider pull",
				Description: "Pull " + syncObjects + " through BigCommerce Admin REST APIs, including V3 customer/product envelopes, product variants/images, and V2 orders enriched with order products/coupons.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify BigCommerce webhooks",
				Description: "Watch " + webhooks + " from managed /v3/hooks with X-Postwave-Webhook-Secret verification, ID-only fetch fanout, durable idempotency, delete/archive routing, refund/transaction evidence, and X-Rate-Limit-Time-Reset-Ms aware scheduled retries.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == commerce.ProviderAdobeCommerce {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Adobe Commerce/Magento base URL, bearer-token credential reference, optional store view, deployment mode, SaaS API base URL, website ID, and event auth reference through the Commerce integrations surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Adobe Commerce REST provider pull",
				Description: "Pull " + syncObjects + " through Adobe Commerce REST APIs using searchCriteria currentPage/pageSize pagination, PaaS /rest/V1 or SaaS Store-header routing, and ascending entity sorting.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Adobe Commerce webhooks",
				Description: "Watch " + webhooks + " with merchant-configured shared-secret or Bearer verification, durable idempotency, refund evidence, and Retry-After aware scheduled retries while managed webhook provisioning remains certification work.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == commerce.ProviderSquarespace {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Squarespace site identifier, API-key or OAuth credential reference, webhook secret reference, API base URL override, and required User-Agent through the Commerce integrations surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Squarespace REST provider pull",
				Description: "Pull " + syncObjects + " through Squarespace Commerce APIs, including Contacts, product-list pages with product-detail enrichment, and Orders.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Squarespace webhooks",
				Description: "Watch " + webhooks + " with raw-body HMAC verification, order fetch fallback, contact delete evidence, durable idempotency, and Retry-After aware scheduled retries.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == commerce.ProviderStripe {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Stripe account ID, restricted-key credential reference, and webhook signing-secret reference through the Commerce integrations surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Stripe REST provider pull",
				Description: "Pull " + syncObjects + " through Stripe list APIs, including disputes, credit notes, and full invoice line-item pagination when invoice snapshots are partial.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Stripe webhooks",
				Description: "Watch " + webhooks + " with raw-body Stripe-Signature verification, durable idempotency, delete evidence, provider-event evidence, and Retry-After aware scheduled retries.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == commerce.ProviderSquare {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Square merchant ID, OAuth/app-token credential reference, location selectors, exact webhook notification URL, and webhook signature-key reference through the Commerce integrations surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Square REST provider pull",
				Description: "Pull " + syncObjects + " through Square APIs, including active-location discovery, Catalog ITEM product/variation mapping, and deleted ITEM tombstones.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Square webhooks",
				Description: "Watch " + webhooks + " with raw-body HMAC validation using the exact notification URL, durable idempotency, catalog-version product refresh, customer delete evidence, refund evidence, and Retry-After aware scheduled retries.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == commerce.ProviderPayPal {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the PayPal merchant ID, REST app client ID/client secret credential reference, environment, webhook ID, RFC3339 backfill bounds, and reporting window size through the Commerce integrations surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the PayPal Transaction Search pull",
				Description: "Pull historical transactions, customers, orders, and refund evidence through PayPal Transaction Search using OAuth Bearer tokens, fields=all, page/page_size pagination, and 31-day reporting windows.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify PayPal webhooks",
				Description: "Watch " + webhooks + " with PayPal Verify Webhook Signature API validation, transmission header capture, webhook ID checks, sparse resource hydration for allowlisted Orders, Captures, Refunds, Subscriptions, and Invoices REST resources, durable idempotency, provider-event evidence, and Retry-After aware scheduled retries.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == commerce.ProviderRazorpay {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Razorpay account ID, key ID/key secret credential reference, optional webhook signing-secret reference, settlement currency, and UNIX timestamp backfill bounds through the Commerce integrations surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Razorpay REST provider pull",
				Description: "Pull " + syncObjects + " through Razorpay APIs using Basic Auth, count/skip pagination, and optional from/to timestamp filters.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Razorpay webhooks",
				Description: "Watch " + webhooks + " with raw-body X-Razorpay-Signature HMAC validation, x-razorpay-event-id idempotency, refund evidence, and Retry-After aware scheduled retries.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderWix {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Wix site, app instance, credential reference, namespace, and webhook public-key reference through the Lead integrations surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Wix Forms and Contacts pull",
				Description: "Pull " + syncObjects + " through Wix app-instance REST APIs with cursor checkpoints and retry metadata.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Wix app webhooks",
				Description: "Watch " + webhooks + " with signed JWT verification, durable idempotency, ID-only fetch fallback, lifecycle recovery, and contact-delete evidence.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderTypeform {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Typeform form ID, personal/OAuth token credential reference, webhook signing-secret reference, optional response region, response type, page size, webhook tag, verify_ssl, default tags, and list routing through the Lead integrations surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Typeform Responses API provider pull",
				Description: "Pull form metadata and responses through Typeform /forms/{form_id} and /forms/{form_id}/responses using Bearer auth, response-link-aware routing, page_size caps, response_type filters, and after-cursor pagination.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Typeform webhooks",
				Description: "Watch " + webhooks + " from the managed /forms/{form_id}/webhooks/{tag} upsert plus read-back verification with enabled event types, secret-backed Typeform-Signature verification, optional partial responses, returned/persisted provider_cleanup evidence on disconnect, typeform_retry cursors, and live-certification status in health views.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderFillout {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Fillout form ID, Bearer API-key credential reference, optional webhook token reference, API region/base URL, page size, submission filters, default tags, and list routing through the Lead integrations surface; Moosewave stores raw API keys and webhook tokens only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Fillout REST provider pull",
				Description: "Pull form metadata and submissions through Fillout /forms/{formId} and /forms/{formId}/submissions using limit/offset pagination, totalResponses/pageCount cursors, submission filters, and question/calculation/url-parameter/scheduling/payment mapping.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Fillout webhooks",
				Description: "Watch " + webhooks + " from the managed /webhook/create registration with URL-token verification, token-free stored endpoint metadata, durable idempotency, returned/persisted provider_cleanup evidence for /webhook/delete cleanup, fillout_retry cursors, and US/EU/self-hosted live-certification status in health views.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderPaperform {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Paperform form slug or ID, Bearer API-key credential reference, optional API base URL, page size, form name, date filters, default tags, and list routing through the Lead integrations surface; Moosewave stores raw API keys only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Paperform REST provider pull",
				Description: "Pull submissions through Paperform /forms/{slug_or_id}/submissions using skip/limit pagination, has_more cursors, ASC created_at ordering, and data-key identity mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Paperform live access",
				Description: "Review paperform_retry cursor health, provider_cleanup evidence, Retry-After behavior, and live Paperform account certification status; provider-managed webhooks, API-key revocation proof, duplicate export cleanup, reconnect proof, and data-delete proof remain outside the local puller slice.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderFormstack {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Formstack form ID, Personal Access Token credential reference, optional API base URL, page size, form name, date filters, default tags, and list routing through the Lead integrations surface; Moosewave stores raw PATs only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Formstack REST provider pull",
				Description: "Pull submissions through Formstack /api/v2025/forms/{formId}/submissions using pageNumber/pageSize pagination, page.totalPages cursors, expanded legacy field data, and field identity mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Formstack live access",
				Description: "Review formstack_retry cursor health, provider_cleanup evidence, Retry-After behavior, encrypted-form behavior, and live Formstack account certification status; provider-managed webhooks, PAT revocation proof, duplicate export cleanup, reconnect proof, and data-delete proof remain outside the local puller slice.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderSurveyMonkey {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the SurveyMonkey survey ID, OAuth credential reference, optional collector filter, page size, timestamp filters, question identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw OAuth tokens only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the SurveyMonkey bulk response pull",
				Description: "Pull survey details for question and answer labels, then pull responses through SurveyMonkey /v3/surveys/{survey_id}/responses/bulk using per_page pagination, links.next cursors, optional collector/status/timestamp filters, and answer identity mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify SurveyMonkey live access",
				Description: "Review surveymonkey_retry cursor health, provider_cleanup evidence, Retry-After behavior, OAuth scope/app-review status, response pagination/filter behavior, and live SurveyMonkey account certification status; provider-managed webhooks, token revocation proof, duplicate export cleanup, reconnect proof, and data-delete proof remain outside the local puller slice.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderUnbounce {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Unbounce page ID, OAuth/API-key credential reference, optional API base URL, page size, created-at filters, field identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw OAuth tokens and API keys only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Unbounce Leads API pull",
				Description: "Pull form-field labels through Unbounce /pages/{page_id}/form_fields, then pull leads through /pages/{page_id}/leads using from/to/offset/limit pagination and field identity mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Unbounce live access",
				Description: "Review unbounce_retry cursor health, provider_cleanup evidence, Retry-After behavior, OAuth/API-key access, lead pagination/filter behavior, and live Unbounce account certification status; provider-managed webhooks, token/API-key revocation proof, duplicate export cleanup, reconnect proof, and data-delete proof remain outside the local puller slice.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderInstapage {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Instapage workspace ID, page ID, personal API token credential reference, optional API base URL, UNIX-second/RFC3339 filters, field identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw Instapage tokens only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Instapage submissions pull",
				Description: "Pull submissions through Instapage /v1/workspaces/{workspaceId}/submissions using page filters, timeframe windows, nextPageToken cursors, and field identity mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Instapage live access",
				Description: "Review instapage_retry cursor health, provider_cleanup evidence, Retry-After behavior, token access, submission pagination/filter behavior, and live Instapage workspace certification status; provider-managed webhooks, token revocation proof, duplicate export cleanup, reconnect proof, and data-delete proof remain outside the local puller slice.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderLeadpages {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Leadpages form ID, Bearer API-key or OAuth access-token credential reference, optional page/account context, API base URL, page size, timestamp filters, field identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw Leadpages tokens only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Leadpages form submissions pull",
				Description: "Pull submissions through Leadpages /api/forms/{form_id}/submissions, follow provider cursor/next-link/page hints when returned, keep a local submitted-at/ID watermark, and map field values into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Leadpages live access",
				Description: "Review leadpages_retry cursor health, provider_cleanup evidence, API-key/OAuth access, response schema, pagination behavior, rate limits, dashboard webhook/export cleanup, reconnect proof, data-delete proof, and live Leadpages account certification status.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.Provider123FormBuilder {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the 123FormBuilder form ID, JWT or token-exchange login credential reference, optional US/EU API base URL, page size, start-date filters, content-field identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw JWT/login material only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the 123FormBuilder submissions pull",
				Description: "Pull submissions through REST API v2 /forms/{form_id}/submissions using JWT query auth, page/per_page pagination, start_submission_id continuation checkpoints, and content-field mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify 123FormBuilder live access",
				Description: "Review 123formbuilder_retry cursor health, provider_cleanup evidence, US/EU account access, token exchange, pagination behavior, start_submission_id semantics, provider dashboard webhook/export cleanup, reconnect proof, data-delete proof, and live 123FormBuilder account certification status.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderFormsite {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Formsite API base URL, user directory, form directory, access-token credential reference, optional page size, result filters, item identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw access tokens only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Formsite REST provider pull",
				Description: "Pull results through Formsite /api/v2/{user_dir}/forms/{form_dir}/results using page/limit pagination, Pagination-* response headers, optional date/result-ID filters, and item identity mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Formsite live access",
				Description: "Review formsite_retry cursor health, provider_cleanup evidence, Retry-After behavior, Professional-plan API access, shard-specific API base URL behavior, and live Formsite account certification status; provider-managed webhooks/server posts, token revocation proof, duplicate export cleanup, reconnect proof, and data-delete proof remain outside the local puller slice.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderCognitoForms {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Cognito Forms form ID, grid view ID, Bearer API-key credential reference, optional REST/OData base URLs, local ID batch size, field identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw Cognito Forms API keys only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Cognito Forms OData/REST provider pull",
				Description: "Discover entry IDs through Cognito Forms OData grid views, hydrate each entry through the REST API, locally batch IDs by last_id cursor, and map field values into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Cognito Forms live access",
				Description: "Review cognito_forms_retry cursor health, provider_cleanup evidence, API-key scope and revocation behavior, selected grid-view field visibility, ID monotonicity/updated-entry behavior, duplicate destination cleanup, reconnect proof, data-delete proof, and live Cognito Forms account certification status.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderNinjaForms {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the WordPress site URL, Ninja Forms form ID, route-token credential reference, optional form name, field identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw route tokens only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Configure the Ninja Forms Webhooks action",
				Description: "Point the Ninja Forms Webhooks add-on action at the Moosewave public receiver, include site_url, form_id, and the route token in the mapped request, and use GET or POST delivery with form-encoded or JSON fields.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Ninja Forms live access",
				Description: "Review lead webhook idempotency, provider_cleanup evidence, GET/POST/JSON/form delivery behavior, route-token success/failure behavior, duplicate Webhooks action cleanup, reconnect proof, data-delete proof, and live WordPress/Ninja Forms certification status.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderOutgrow {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Outgrow account ID, campaign/calculator/quiz ID, route-token or Basic-auth credential reference, optional content name, field identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw Outgrow tokens and Basic auth credentials only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Configure the Outgrow Webhook destination",
				Description: "Point the Outgrow Webhook URL at the Moosewave public receiver, include static account_id and campaign_id routing parameters, configure Basic authentication or the Moosewave route token, and send JSON lead/visit/result payloads.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Outgrow live access",
				Description: "Review lead webhook idempotency, provider_cleanup evidence, JSON/form delivery behavior, Basic-auth and route-token success/failure behavior, duplicate Webhook destination cleanup, reconnect proof, data-delete proof, and live Outgrow certification status.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderGravityForms {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the WordPress site URL, Gravity Forms form ID, WordPress Application Password or Gravity Forms REST key/secret credential reference, optional page size, entry status/search filters, field identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw WordPress and Gravity Forms credentials only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Gravity Forms Entries REST pull",
				Description: "Pull entries through Gravity Forms /wp-json/gf/v2/forms/{form_id}/entries using _labels=1, paging[page_size], paging[offset], sorting, optional status/search filters, and field-label identity mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Gravity Forms live access",
				Description: "Review gravity_forms_retry cursor health, provider_cleanup evidence, REST API enablement, HTTPS Basic-auth credential behavior, entry pagination/filter behavior, and live WordPress/Gravity Forms certification status; provider-managed webhooks/feeds, credential revocation proof, duplicate export/feed cleanup, reconnect proof, and data-delete proof remain outside the local puller slice.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderWPForms {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the WordPress site URL, numeric WPForms form ID, WordPress Application Password credential reference, optional page size, entry status/type/search/date filters, field identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw WordPress credentials only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the WPForms Abilities API pull",
				Description: "Pull form metadata through wpforms/get-form and Pro entries through wpforms/search-entries using bracketed input parameters, page/limit cursors, include_fields=true, optional status/type/search/date filters, and field-label identity mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify WPForms live access",
				Description: "Review wpforms_retry cursor health, provider_cleanup evidence, WordPress 6.9+ Abilities API availability, WPForms 1.9.9+ Pro entry access, Application Password Basic-auth behavior, entry pagination/filter behavior, and live WordPress/WPForms certification status; provider-managed webhooks/feeds, credential revocation proof, duplicate export/feed cleanup, reconnect proof, and data-delete proof remain outside the local puller slice.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderFormidableForms {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the WordPress site URL, Formidable Forms form ID, WordPress Application Password or Formidable API-key credential reference, optional page size, search/sort filters, field identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw WordPress and Formidable credentials only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Formidable Forms Entries REST pull",
				Description: "Pull form metadata, fields, and entries through /wp-json/frm/v2/forms/{form_id}, /fields, and /entries using page/page_size cursors, optional search/sort filters, and field-label identity mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Formidable Forms live access",
				Description: "Review formidable_forms_retry cursor health, provider_cleanup evidence, Formidable API add-on availability, WordPress/Application Password or Formidable API-key Basic-auth behavior, entry pagination/filter behavior, and live WordPress/Formidable certification status; provider-managed webhooks/API actions/feeds, credential revocation proof, duplicate export/feed cleanup, reconnect proof, and data-delete proof remain outside the local puller slice.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderFeathery {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Feathery form ID, API-key credential reference, optional regional API base URL, page size, timestamp filters, field identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw API keys only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Feathery Submissions API pull",
				Description: "Pull submissions through Feathery /api/form/submission/ using form_id, page_size, next URL pagination, optional start_time/created/completed filters, and field-value identity mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Feathery live access",
				Description: "Review feathery_retry cursor health, provider_cleanup evidence, Retry-After behavior, next URL pagination, timestamp watermark behavior, and live Feathery workspace certification status; provider-managed webhooks, API-key revocation proof, duplicate export cleanup, reconnect proof, and data-delete proof remain outside the local puller slice.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderFormaloo {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Formaloo form slug or ID, x-api-key plus API-secret or authorization-token credential reference, optional workspace ID, page size, timestamp filters, row-data identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw API keys, API secrets, and tokens only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Formaloo Rows API pull",
				Description: "Pull rows through Formaloo /v3.0/forms/{slug}/rows/ using x-api-key plus JWT authorization, page/page_size pagination, optional workspace headers, timestamp filters, and row data identity mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Formaloo live access",
				Description: "Review formaloo_retry cursor health, provider_cleanup evidence, token exchange, page/page_size pagination, timestamp watermark behavior, workspace header behavior, and live Formaloo workspace certification status; provider-managed webhooks, API-key/API-secret/token revocation proof, duplicate export cleanup, reconnect proof, and data-delete proof remain outside the local puller slice.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderGoogleForms {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Google Forms form ID, OAuth access-token credential reference, optional page size, form name, timestamp lower bound, question identity mappings, default tags, and list routing through the Lead integrations surface; Moosewave stores raw OAuth tokens only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Google Forms Responses API pull",
				Description: "Pull form metadata through /v1/forms/{formId}, then responses through /v1/forms/{formId}/responses using pageSize/pageToken pagination, RFC3339 timestamp filters, and question-label identity mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Google Forms live access",
				Description: "Review google_forms_retry cursor health, provider_cleanup evidence, Retry-After behavior, OAuth scope/app-verification status, timestamp filter behavior, and live Google Workspace certification status; Cloud Pub/Sub watch renewal, Apps Script/Sheets cleanup, token revocation proof, duplicate export cleanup, reconnect proof, and data-delete proof remain outside the local puller slice.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderTally {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Tally form ID, Bearer API-key credential reference, optional API base URL, page size, form name, default tags, and list routing through the Lead integrations surface; Moosewave stores raw API keys only in referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Tally REST provider pull",
				Description: "Pull submissions through Tally /forms/{formId}/submissions using page/limit pagination, hasMore cursors, and field identity mapping into canonical profiles, lists, and lead events.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Tally live access",
				Description: "Review tally_retry cursor health, provider_cleanup evidence, Retry-After behavior, and live Tally account certification status; provider-managed webhooks, token revocation proof, duplicate export cleanup, reconnect proof, and data-delete proof remain outside the local puller slice.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderJotform {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Jotform form ID, API-key credential reference, webhook token reference, regional/custom API host settings, page size, default tags, and list routing through the Lead integrations surface; Moosewave keeps raw API keys and webhook tokens inside referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Jotform REST provider pull",
				Description: "Pull form metadata, questions, and submissions through Jotform /form/{formID}, /form/{formID}/questions, and /form/{formID}/submissions using APIKEY auth, offset/limit pagination, regional API hosts, and canonical answer-field mapping.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Jotform webhooks",
				Description: "Watch " + webhooks + " from the managed /form/{formID}/webhooks registration with existing-hook reuse, safe token-free endpoint storage, shared-token verification, JSON/form-url-encoded/multipart payload decoding, returned/persisted provider_cleanup evidence on disconnect, jotform_retry cursors, and live-certification status in health views.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == leadintegrations.ProviderWebflow {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Webflow site ID, OAuth/API-token credential reference, webhook signing-secret reference, optional form ID, form element ID, form name filter, page size, default tags, and list routing through the Lead integrations surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Webflow Data API provider pull",
				Description: "Pull site-level or form-scoped submissions through Webflow /v2/sites/{site_id}/form_submissions and /v2/sites/{site_id}/forms/{form_id}/submissions using Bearer auth, forms:read scope, elementId filtering, limit/offset pagination, and canonical form-response mapping.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Certify Webflow webhooks",
				Description: "Watch " + webhooks + " from the managed Webflow webhook lifecycle: stored /v2/webhooks/{webhook_id} validation, /v2/sites/{site_id}/webhooks repair/reuse/create, optional form-name filter, form-aware routing, x-webflow-timestamp and x-webflow-signature verification, durable delivery idempotency, endpoint-match cleanup fallback with returned/persisted provider_cleanup evidence, webflow_retry cursors, and live-certification status in health views.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == crmintegrations.ProviderPipedrive {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Connect Pipedrive through the CRM OAuth start/callback flow, or save a company domain and API-token/OAuth credential reference manually; optional managed webhooks for persons, deals, organizations, and activities use Basic Auth values from the referenced or managed secret and are routed by stored webhook/install identity.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Pipedrive CRM pull",
				Description: "Pull " + syncObjects + " through Pipedrive API v2 with cursor checkpoints, API-token query auth or OAuth Bearer auth, page-size caps, contact mapping, deal event mapping, organization enrichment, activity event mapping, scheduled retry cursors, and local-write disconnect guards.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Review webhooks and remaining gaps",
				Description: "Watch CRM sync history, OAuth refresh/revocation storage, Pipedrive uninstall callback cleanup, scheduled retry cursor evidence, row-preserving disconnect evidence, and managed person/deal/organization/activity webhook route/idempotency evidence while live Pipedrive certification remains partial.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == crmintegrations.ProviderZohoCRM {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Zoho organization ID, OAuth access-token credential reference, data center, and optional custom-view/list routing through the CRM integrations surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Zoho CRM V8 records pull",
				Description: "Pull " + syncObjects + " through Zoho CRM /crm/v8/Contacts and /crm/v8/Leads with Zoho-oauthtoken auth, page/page-token checkpoints, per_page caps, and canonical contact mapping.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Review remaining native gaps",
				Description: "Watch CRM sync history, managed OAuth refresh, scheduled retry cursors, manual retry preservation, and disconnect revocation/local credential cleanup evidence while Notification API channels, Accounts/Deals/activities fanout, connected-app/notification cleanup certification, and live Zoho certification remain partial.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == crmintegrations.ProviderDynamics365 {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Dataverse environment URL and OAuth access-token credential reference through the CRM integrations surface; Moosewave stores raw Microsoft tokens only inside referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Dataverse Contacts/Leads pull",
				Description: "Pull " + syncObjects + " through Dataverse /api/data/v9.2/contacts and /api/data/v9.2/leads with OAuth Bearer auth, OData nextLink checkpoints, odata.maxpagesize caps, formatted-value annotations, and canonical contact mapping.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Review remaining native gaps",
				Description: "Watch CRM sync history, managed OAuth refresh, scheduled retry cursors, manual retry preservation, and local managed credential cleanup evidence while change tracking/webhooks, Accounts/Opportunities/activities/list fanout, Microsoft Entra/app cleanup certification, and live Microsoft Dataverse certification remain partial.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == crmintegrations.ProviderKeap {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Keap account ID and OAuth, Personal Access Token, or Service Account Key credential reference through the CRM integrations surface; Moosewave stores raw Keap credentials only inside referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Keap REST v2 Contacts pull",
				Description: "Pull " + syncObjects + " through Keap /rest/v2/contacts, or /rest/v2/tags/{tag_id}/contacts when tag_id is configured, with Bearer auth, page_token checkpoints, page_size caps, and canonical contact mapping.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Review remaining native gaps",
				Description: "Watch CRM sync history, managed OAuth refresh for OAuth credentials, scheduled retry cursors, manual retry preservation, and local managed credential cleanup evidence while full tag membership fanout, campaigns, orders, appointments, webhooks, provider credential cleanup certification, and live Keap certification remain partial.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == reviewintegrations.ProviderYotpo {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Yotpo store/account label and a credential reference containing JSON {app_key, secret}; Moosewave stores raw Yotpo API material only inside referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Yotpo Reviews REST pull",
				Description: "Pull " + syncObjects + " through Yotpo token exchange and /v1/apps/{app_key}/reviews with count/page pagination, page-size caps, yotpo: checkpoints, scheduled yotpo_retry continuation, optional product/order UUID enrichment plus order-line product fallback, resolved review customer_id/customer evidence, and canonical review/reviewer mapping; tokenized review_create/review_updated ingest with integration-scoped WebhookMessageId idempotency is available through the review webhook-ingest endpoint.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Review remaining native gaps",
				Description: "Watch review sync history while signed verification, provider-managed webhook registration/cleanup automation with live cleanup proof, broader product refresh beyond lookup-only order-line matching, and live brand certification remain partial.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == loyaltyintegrations.ProviderSmile {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save the Smile.io shop domain and API-token credential reference; add account_id plus webhook_secret_ref containing the Smile app client secret when signed app webhooks are enabled. Moosewave stores raw Smile credentials only inside referenced secrets.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the Smile.io Customers and events REST pull",
				Description: "Pull " + syncObjects + " through Smile.io /v1/customers, /v1/points_transactions, and /v1/reward_fulfillments with Bearer auth, page/cursor pagination, updated_at_min incremental event polling after smile:complete, scheduled smile_retry continuation, and canonical loyalty member/event mapping.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Review remaining native gaps",
				Description: "Watch loyalty sync history while provider webhook cleanup proof and live store certification remain partial.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if isManagedSubscriptionPullerProvider(meta.Provider) {
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save credential references and non-secret provider settings through the Subscription integrations surface; raw provider credentials and webhook secrets stay out of public settings for this read-puller slice.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run the " + meta.Name + " provider pull",
				Description: managedSubscriptionPullerSyncDescription(meta),
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Review remaining native gaps",
				Description: "Watch subscription_sync_runs, scheduled subscription provider retry cursors, canonical subscription/shipment imports, disconnect-safe local writes, and provider_cleanup evidence while provider-managed webhooks/callbacks, credential cleanup proof, reconnect/data-delete proof, extended objects, and live provider certification remain open.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if meta.Provider == warehouse.ProviderSnowflake {
		return []SetupStep{
			{
				Title:          "Create the managed Snowflake connection",
				Description:    "Save the Snowflake account, warehouse, database, schema, credential reference, and optional role/qualified stage/import table through the Warehouse surface; raw Snowflake keys, tokens, and passwords stay in referenced secrets only.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Run a Snowflake load-plan manifest job",
				Description: "Prepare auditable " + syncObjects + " export/import manifests with provider_target_uri, stored handoff bundle metadata, per-object JSONL handoff artifacts, destination schema DDL/validation previews, snowflake_load_plan plus snowflake_provider_job evidence with ordered statement plans, dry_run no-side-effect planning, retry_count prior-failure evidence, linked SnowflakeSQLExecutor artifact verification/export-copy/import-query execution evidence, opt-in SELECT 1 provider-health probe evidence on the connection health route, local cleanup acknowledgement, and provider_driver_attachment=manifest_worker evidence; live Snowflake account certification, provider-error/backoff proof, returned-row materialization, schema discovery, and Snowflake-side cleanup proof remain full-availability gates.",
				Action:      "Sync",
				Path:        item.SetupPath,
			},
			{
				Title:       "Review driver attachment health",
				Description: "Watch warehouse run history, target URI evidence, load-plan readiness, manifest-worker health, and opt-in SELECT 1 provider-health probe evidence while certified live account validation and schema/table discovery remain open.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	if isPostwaveIngestSyncModel(meta.SyncModel) {
		topics := joinedOrDefault(meta.WebhookTopics, "source event families")
		verification := joinedOrDefault([]string{meta.Verification}, "provider-specific or Moosewave ingest-token verification")
		return []SetupStep{
			{
				Title:          "Create the managed " + meta.Name + " connection",
				Description:    "Save credential references and provider settings through the existing " + meta.Surface + " surface.",
				Action:         "Connect",
				Path:           item.SetupPath,
				RequiredFields: providerFieldKeys(meta.RequiredFields),
			},
			{
				Title:       "Import canonical rows",
				Description: "Send canonical Moosewave rows into the managed surface; provider API pullers for " + syncObjects + " stay partial until the connector worker is implemented.",
				Action:      "Import",
				Path:        item.SetupPath,
			},
			{
				Title:       "Monitor native ingest health",
				Description: "Watch " + topics + " with " + verification + " metadata in run history and audit views.",
				Action:      "Review health",
				Path:        item.SetupPath,
			},
		}
	}
	return []SetupStep{
		{
			Title:          "Create the managed " + meta.Name + " connection",
			Description:    "Save credential references and provider settings through the existing " + meta.Surface + " surface.",
			Action:         "Connect",
			Path:           item.SetupPath,
			RequiredFields: providerFieldKeys(meta.RequiredFields),
		},
		{
			Title:       "Run the first sync",
			Description: "Sync " + syncObjects + " and inspect retry/error details before enabling automations.",
			Action:      "Sync",
			Path:        item.SetupPath,
		},
		{
			Title:       "Monitor native health",
			Description: "Watch " + webhooks + " in the unified health, sync history, and audit views.",
			Action:      "Review health",
			Path:        item.SetupPath,
		},
	}
}

func isManagedSubscriptionPullerProvider(provider string) bool {
	switch provider {
	case subscriptionintegrations.ProviderSkio,
		subscriptionintegrations.ProviderAfterShip,
		subscriptionintegrations.ProviderShipStation,
		subscriptionintegrations.ProviderChargebee,
		subscriptionintegrations.ProviderLoopSubscriptions,
		subscriptionintegrations.ProviderSealSubscriptions,
		subscriptionintegrations.ProviderAppstle,
		subscriptionintegrations.ProviderBoldSubscriptions:
		return true
	default:
		return false
	}
}

func managedSubscriptionPullerSyncDescription(meta managedProviderMetadata) string {
	switch meta.Provider {
	case subscriptionintegrations.ProviderSkio:
		return "Pull subscriptions through Skio GraphQL Subscriptions with credential-reference auth, limit/offset pagination, skio: checkpoints, scheduled retry continuation, and canonical subscription/event mapping."
	case subscriptionintegrations.ProviderAfterShip:
		return "Pull tracking rows through AfterShip /v4/trackings with credential-reference auth, page/limit pagination, aftership: checkpoints, scheduled retry continuation, and canonical shipment/event mapping."
	case subscriptionintegrations.ProviderShipStation:
		return "Pull order-to-shipment rows through ShipStation /orders with credential-reference Basic auth, page/pageSize pagination, optional order_status filtering, shipstation: checkpoints, scheduled retry continuation, and canonical shipment/event mapping."
	case subscriptionintegrations.ProviderChargebee:
		return "Pull subscriptions through Chargebee /api/v2/subscriptions with credential-reference Basic auth, site_id-scoped offset pagination, chargebee: checkpoints, scheduled retry continuation, and canonical subscription/event mapping."
	case subscriptionintegrations.ProviderLoopSubscriptions:
		return "Pull subscriptions through Loop /admin/2023-10/subscription with credential-reference auth, pageNo/pageSize pagination, loop: checkpoints, scheduled retry continuation, and canonical subscription/event mapping."
	case subscriptionintegrations.ProviderAppstle:
		return "Pull subscription contracts through Appstle /api/external/v2/subscription-contracts with credential-reference auth, page/size pagination, appstle: checkpoints, scheduled retry continuation, and canonical subscription/event mapping."
	case subscriptionintegrations.ProviderSealSubscriptions:
		return "Pull subscriptions through Seal /subscriptions with credential-reference auth, page pagination, seal: checkpoints, scheduled retry continuation, and canonical subscription/event mapping."
	case subscriptionintegrations.ProviderBoldSubscriptions:
		return "Pull subscriptions through Bold /subscriptions/v1/shops/{shop}/subscriptions with credential-reference auth, shop_identifier-scoped page/per_page pagination, bold: checkpoints, scheduled retry continuation, and canonical subscription/event mapping."
	default:
		return "Pull provider rows with credential-reference auth, provider-specific pagination, scheduled retry continuation, and canonical subscription/shipment mapping."
	}
}

func managedSubscriptionPullerRequiredFields(provider string) []string {
	object := "subscriptions"
	if provider == subscriptionintegrations.ProviderAfterShip || provider == subscriptionintegrations.ProviderShipStation {
		object = "shipments"
	}
	token := strings.ReplaceAll(provider, "-", "_")
	return []string{"id", object + "|empty_" + token + "_provider_pull"}
}

func isManagedAnalyticsPullerProvider(provider string) bool {
	switch provider {
	case analyticsintegrations.ProviderPostHog,
		analyticsintegrations.ProviderTripleWhale,
		analyticsintegrations.ProviderMixpanel,
		analyticsintegrations.ProviderAmplitude:
		return true
	default:
		return false
	}
}

func managedAnalyticsPullerSyncDescription(meta managedProviderMetadata) string {
	switch meta.Provider {
	case analyticsintegrations.ProviderPostHog:
		return "Pull profiles through PostHog GET /api/projects/{project_id}/persons with credential-reference auth, bounded limit pagination, PostHog next-page checkpoints, scheduled analytics retry continuation, and canonical profile mapping."
	case analyticsintegrations.ProviderTripleWhale:
		return "Pull profiles through Triple Whale customer pages over configured or rolling date windows with credential-reference auth, page checkpoints, scheduled analytics retry continuation, and canonical profile mapping."
	case analyticsintegrations.ProviderMixpanel:
		return "Pull profiles through Mixpanel POST /api/query/engage with credential-reference auth, project_id/session_id page checkpoints, scheduled analytics retry continuation, and canonical profile mapping."
	case analyticsintegrations.ProviderAmplitude:
		return "Pull profiles through Amplitude asynchronous Behavioral Cohort export request/status/download checkpoints with credential-reference auth, bounded poll attempts, scheduled analytics retry continuation, and canonical profile mapping."
	default:
		return "Pull analytics profiles with credential-reference auth, provider-specific pagination or async-export checkpoints, scheduled analytics retry continuation, and canonical profile mapping."
	}
}

func managedAnalyticsPullerRequiredFields(provider string) []string {
	token := strings.ReplaceAll(provider, "-", "_")
	return []string{"id", "profiles|empty_" + token + "_provider_pull"}
}

func decorateManagedProviderLifecycleResponse(resp actionResponse, meta managedProviderMetadata, action string) actionResponse {
	resp.DelegatedTo = managedProviderEndpointFor(meta, action)
	if meta.Surface == "Commerce integrations" {
		return decorateCommerceLifecycleResponse(resp, meta, action)
	}
	if meta.Surface == "Marketing integrations" {
		return decorateMarketingLifecycleResponse(resp, meta, action)
	}
	switch action {
	case "connect/start", "connect/callback":
		resp.RequiredFields = providerFieldKeys(meta.RequiredFields)
		if meta.Provider == crmintegrations.ProviderHubSpot {
			resp.Message = "Create or update the managed HubSpot CRM connection with portal_id and a credential reference for a HubSpot private app token, or start the managed OAuth install flow. Moosewave owns OAuth token exchange/refresh, contact REST backfill through HubSpot's current CRM objects API, configured Lists API membership fanout with provider-list segment evidence when sync_list_memberships is enabled, opt-in native Moosewave list membership adds plus complete-scan stale repair for owned memberships when list_membership_map is configured, opt-in deal association event fanout when sync_deals is enabled, app-level signed contact webhooks, and scheduled retry cursors; historical legacy owner reconciliation, broader deal lifecycle coverage, and live portal certification remain partial."
		} else if meta.Provider == crmintegrations.ProviderSalesforce {
			resp.Message = "Create or update the managed Salesforce CRM connection with org_id and a managed connected-app OAuth credential ref, or an existing credential ref plus instance_url. Moosewave owns OAuth start/callback, encrypted credential storage, proactive and reactive token refresh, SOQL Contact/Lead pulls, CampaignMember event fanout by Contact/Lead email, provider-segment evidence, opt-in native Moosewave list membership adds, explicit removal-signal soft-removes, and complete-scan stale repair for owned mapped Campaign memberships when campaign_membership_map is configured, Task activity fanout through TYPEOF Who Contact/Lead email mapping, scheduled retry cursors, and managed refresh-token revocation on disconnect; live Salesforce org certification remains the full-availability gate. CDC/Platform Events are a future streaming enhancement outside this SOQL runtime slice."
		} else if meta.Provider == crmintegrations.ProviderPipedrive {
			resp.Message = "Create or update the managed Pipedrive CRM connection through the OAuth start/callback flow or with company_domain and a credential reference containing an API token or OAuth token metadata. Moosewave owns encrypted OAuth refresh-token storage, /users/me install identity capture, automatic refresh, refresh-token revocation, Pipedrive uninstall callback cleanup, persons/deals/organizations/activities backfill through Pipedrive API v2, scheduled retry cursors, row-preserving disconnect evidence, plus optional managed provider webhooks with route identity checks and integration-scoped body-hash idempotency; live Pipedrive certification remains partial."
		} else if meta.Provider == crmintegrations.ProviderZohoCRM {
			resp.Message = "Create or update the managed Zoho CRM connection with organization_id, data_center, and an OAuth access-token or managed OAuth credential reference. Moosewave owns Zoho CRM V8 Contacts and Leads backfill through /crm/v8/{module}, managed OAuth refresh, scheduled retry cursors, manual retry preservation, disconnect refresh-token revocation, and local managed OAuth credential cleanup; Notification API channels, Accounts/Deals/activities fanout, connected-app/notification cleanup certification, and live Zoho certification remain partial."
		} else if meta.Provider == crmintegrations.ProviderDynamics365 {
			resp.Message = "Create or update the managed Microsoft Dynamics 365 connection with environment_url and an OAuth access-token or managed OAuth credential reference. Moosewave owns Dataverse Contacts and Leads backfill through /api/data/v9.2, managed OAuth refresh, scheduled retry cursors, manual retry preservation, and local managed OAuth credential cleanup evidence; change tracking/webhooks, Accounts/Opportunities/activities/list fanout, Microsoft Entra/app cleanup certification, and live Dataverse certification remain partial."
		} else if meta.Provider == crmintegrations.ProviderKeap {
			resp.Message = "Create or update the managed Keap connection with account_id and a credential reference containing an OAuth access token, Personal Access Token, or Service Account Key. Moosewave owns Keap REST v2 Contacts backfill through /rest/v2/contacts with optional tag_id-scoped pulls, managed OAuth refresh when OAuth credentials are used, scheduled retry cursors, manual retry preservation, and local managed OAuth/PAT/SAK credential cleanup evidence; full tag/campaign/order/appointment/webhook fanout, provider credential cleanup certification, and live Keap certification remain partial."
		} else if meta.Provider == subscriptionintegrations.ProviderRecharge {
			resp.Message = "Create or update the managed Recharge connection with store_domain, a Recharge API-token credential reference, optional page_size, and optional webhook_secret_ref for X-Recharge-Hmac-Sha256 verification. Moosewave owns subscriptions REST backfill, scheduled retry cursors, tokenized webhook ingest with optional Recharge signature verification and durable delivery claims for subscription and charge events, and persisted operator-managed provider_cleanup readiness evidence on disconnect; live merchant certification remains partial."
		} else if isManagedSubscriptionPullerProvider(meta.Provider) {
			resp.Message = "Create or update the managed " + meta.Name + " connection with credential references and non-secret provider settings. Moosewave owns the implemented read-puller slice with scheduled retry cursors, canonical subscription/shipment mapping, run history, disconnect-safe local writes, returned/persisted operator-managed provider_cleanup evidence, and local cleanup acknowledgement; provider-managed webhooks/callbacks, credential cleanup proof, reconnect/data-delete proof, extended objects, and live provider certification remain partial."
		} else if meta.Provider == reviewintegrations.ProviderYotpo {
			resp.Message = "Create or update the managed Yotpo review connection with a store/account label, a credential reference containing app_key plus secret, and optional commerce_integration_id for product/order UUID lookup, order-line product fallback, and customer lookup evidence. Moosewave owns Yotpo token exchange, paged Reviews REST backfill, scheduled yotpo_retry continuation, lookup-only product/order UUID enrichment, resolved order-line product fallback, resolved review customer_id linkage, customer metadata/profile/event evidence, tokenized review_create/review_updated ingest with WebhookMessageId idempotency, canonical review/reviewer/event mapping, run history, persisted operator-managed provider_cleanup readiness evidence on disconnect, and local cleanup acknowledgment for operator attestation; signed verification, provider-managed webhook registration/cleanup automation, broader product refresh behavior, and live brand certification remain partial."
		} else if meta.Provider == loyaltyintegrations.ProviderSmile {
			resp.Message = "Create or update the managed Smile.io loyalty connection with shop_domain and a credential reference containing API-token material. When signed app webhooks are enabled, account_id and webhook_secret_ref containing the Smile app client secret are both required so Moosewave can route by Smile account_id before verifying Smile-Signature. Moosewave owns Smile.io Customers REST backfill, historical and incremental points transaction/reward fulfillment polling, account-id-routed signed app webhook ingest, durable callback idempotency, scheduled smile_retry continuation, points balance/VIP tier mapping, canonical loyalty profile/event upserts, run history, persisted operator-managed provider_cleanup readiness evidence on disconnect, and local cleanup acknowledgment for operator attestation; managed cleanup automation and live store certification remain partial."
		} else if meta.Provider == supportintegrations.ProviderZendesk {
			resp.Message = "Create or update the managed Zendesk connection with subdomain, a credential reference containing either OAuth access-token material or Zendesk email plus API token, optional incremental_export_enabled plus incremental_start_time for Incremental Export pulls, and optional webhook_secret_ref plus zendesk_webhook_id for signed callback verification and stored-webhook cleanup. Moosewave owns Tickets API backfill, opt-in Incremental Export cursor pulls, requester-user side-loading, cursor checkpoints, scheduled zendesk_retry continuation, signed Zendesk ticket/comment webhook ingest, sparse ticket-id callback refresh, durable callback idempotency, canonical support mapping, run history, and best-effort stored-webhook deletion with persisted provider_cleanup evidence on disconnect; live workspace certification remains partial."
		} else if meta.Provider == supportintegrations.ProviderIntercom {
			resp.Message = "Create or update the managed Intercom connection with workspace_id, a credential reference containing OAuth access-token material, optional page_size/API host settings for Conversations REST pulls, and optional webhook_secret_ref for X-Hub-Signature verification. Moosewave owns /conversations backfill with cached /contacts/{id} requester fallback, per-conversation /conversations/{id} detail hydration for source plus conversation-part support-message rows up to Intercom's 500-part API limit, author/contact/assignee evidence, signed app webhook ingest, sparse /conversations/{id} callback refresh, durable callback idempotency, starting_after cursor checkpoints, scheduled intercom_retry continuation, canonical support/profile/message/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; richer Admin/participant enrichment, attachment expansion, managed app-webhook cleanup automation, duplicate/manual target audit, and live workspace certification remain before RuntimeAvailable promotion."
		} else if meta.Provider == supportintegrations.ProviderHelpScout {
			resp.Message = "Create or update the managed Help Scout connection with mailbox_id, a credential reference containing OAuth client_id/client_secret material, optional status/API host settings for mailbox-scoped Conversations REST pulls, and optional webhook_secret_ref plus help_scout_webhook_id for signed callback verification. Moosewave owns OAuth token exchange, /v2/conversations backfill with embedded thread requests plus /v2/conversations/{id}/threads fallback, signed Help Scout app webhook ingest, sparse conversation-id callback refresh, durable callback idempotency, page checkpoints, scheduled help_scout_retry continuation, canonical support/profile/message/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed provider cleanup automation and live mailbox certification remain partial."
		} else if meta.Provider == supportintegrations.ProviderFreshdesk {
			resp.Message = "Create or update the managed Freshdesk connection with account_domain and a credential reference containing API-key material, plus optional page_size, product_id, API host settings for Tickets REST pulls, webhook_secret_ref, and freshdesk_webhook_id for authenticated automation callbacks. Moosewave owns account-domain normalization, /api/v2/tickets backfill with include=requester embedding, local product_id filtering, authenticated webhook ingest, sparse /api/v2/tickets/{id} callback refresh, durable callback idempotency, page checkpoints, scheduled freshdesk_retry continuation, Retry-After-aware provider errors, canonical support/profile/event mapping, run history, and persisted operator-managed provider_cleanup readiness evidence on disconnect; managed provider cleanup automation and live helpdesk certification remain partial."
		} else if meta.Provider == supportintegrations.ProviderGorgias {
			resp.Message = "Create or update the managed Gorgias connection with account_domain, a credential reference containing email plus API key material, optional commerce_integration_id for lookup-only commerce UUID enrichment, and optional webhook_secret_ref plus gorgias_http_integration_id for authenticated HTTP integration callbacks and best-effort stored HTTP integration cleanup. Moosewave owns Tickets API backfill with embedded customer email mapping, bounded payload-present Shopify/Recharge/order evidence preservation, lookup-only order/customer/product UUID resolution against existing commerce rows, cursor checkpoints, scheduled gorgias_retry continuation, authenticated ticket/message callback ingest, sparse ticket-id callback refresh, durable callback idempotency, canonical support/profile/event sinks, run history, and best-effort DELETE /api/integrations/{id} cleanup with persisted provider_cleanup evidence on disconnect; official hmac_secret header certification, stored HTTP integration deletion certification, rule/duplicate integration cleanup proof, API-key cleanup, and live helpdesk certification remain partial."
		} else if meta.Provider == warehouse.ProviderSnowflake {
			resp.Message = "Create or update the managed Snowflake warehouse connection with account, warehouse, database, schema, optional qualified stage, and a credential reference containing Snowflake key-pair, OAuth, PAT, or workload-identity material. Moosewave owns local validation, stored audit-safe manifest handoff bundles, per-object JSONL load-plan artifacts, destination schema DDL/validation previews, COPY/query provider-job request planning with ordered statement plans, dry_run no-side-effect planning, retry_count prior-failure evidence, linked SnowflakeSQLExecutor artifact verification/local export-copy/query/health execution evidence, opt-in SELECT 1 provider-health probe evidence, import-mapping mutation guards after disconnect, row-preserving disconnect with persisted provider_cleanup readiness evidence, local provider-cleanup acknowledgement, run history, and provider_driver_attachment health; live SQL/COPY account certification evidence, remote row materialization, schema discovery, provider-side cleanup automation, provider-aware backoff, and full live account certification remain partial."
		} else if meta.Provider == leadintegrations.ProviderWix {
			resp.Message = "Create or update the managed Wix Forms and Contacts connection with Wix app-instance OAuth credentials, site/app identifiers, credential references, webhook public-key storage, and the local runtime-complete/live-cert-pending contract."
		} else if meta.Provider == leadintegrations.ProviderTypeform {
			resp.Message = "Create or update the managed Typeform connection with form_id, personal-token or externally managed OAuth access-token credential refs, optional webhook_secret_ref, response region/type settings, webhook tag, verify_ssl, managed /forms/{form_id}/webhooks/{tag} upsert plus read-back verification, and returned/persisted provider_cleanup evidence on managed webhook disconnect; live Typeform certification remains pending."
		} else if meta.Provider == leadintegrations.ProviderSurveyMonkey {
			resp.Message = "Create or update the managed SurveyMonkey connection with survey_id, OAuth Bearer credential refs, optional collector_id, page size, timestamp/status filters, survey name, question identity mappings, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled /v3/surveys/{survey_id}/details plus /v3/surveys/{survey_id}/responses/bulk pulls with surveymonkey_retry continuation plus operator-managed provider_cleanup evidence on disconnect; provider-managed webhooks, OAuth app review/token revocation proof, duplicate export cleanup, reconnect proof, data-delete proof, and live SurveyMonkey account certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderUnbounce {
			resp.Message = "Create or update the managed Unbounce connection with page_id, OAuth Bearer or API-key credential refs, optional API base URL, page size, created-at filters, page/form names, field identity mappings, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled /pages/{page_id}/form_fields plus /pages/{page_id}/leads pulls with unbounce_retry continuation plus operator-managed provider_cleanup evidence on disconnect; provider-managed webhooks, OAuth/API-key revocation proof, duplicate export cleanup, reconnect proof, data-delete proof, and live Unbounce account/API certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderLeadpages {
			resp.Message = "Create or update the managed Leadpages connection with form_id, Bearer API-key or OAuth access-token credential refs, optional account/page context, API base URL, page size, timestamp filters, field identity mappings, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled /api/forms/{form_id}/submissions pulls with leadpages_retry continuation plus operator-managed provider_cleanup evidence on disconnect; live response schema, pagination behavior, rate limits, API-key/OAuth revocation proof, dashboard webhook/export cleanup, reconnect proof, data-delete proof, and live Leadpages certification remain pending."
		} else if meta.Provider == leadintegrations.Provider123FormBuilder {
			resp.Message = "Create or update the managed 123FormBuilder connection with form_id, JWT or token-exchange login credential refs, optional account/region context, REST API v2 base URL, page size, start_date/start_submission_id evidence, content-field identity mappings, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled /forms/{form_id}/submissions pulls with 123formbuilder_retry continuation plus operator-managed provider_cleanup evidence on disconnect; live US/EU account certification, JWT/login credential rotation proof, provider-side webhook/export cleanup, reconnect proof, data-delete proof, and start_submission_id semantics certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderCarrd {
			resp.Message = "Create or update the managed Carrd connection with site_id, form_id, a credential reference containing the Custom URL route token, optional form name, identity field mappings, default tags, and list routing. Moosewave owns the public Carrd Custom URL receiver for GET, POST, AJAX JSON, form-encoded, multipart, and XML submissions, route-token verification, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; Carrd Pro Plus live-site setup, Custom URL destination removal, route-token rotation, reconnect proof, data-delete proof, and live Carrd certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderOptinMonster {
			resp.Message = "Create or update the managed OptinMonster connection with account_id, campaign_id, a credential reference containing the Moosewave route token configured on the OptinMonster Webhook URL, optional campaign name, identity field mappings, default tags, and list routing. Moosewave owns the public OptinMonster Webhook receiver for JSON lead/campaign/meta/smart_tags payloads, account/campaign route resolution, route-token verification, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; OptinMonster Pro live-account setup, Webhook destination removal, route-token rotation, reconnect proof, data-delete proof, and live OptinMonster certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderPrivy {
			resp.Message = "Create or update the managed Privy connection with account_id, campaign_id, a credential reference containing the Basic auth username/password configured on the Privy custom Webhook, optional campaign name, identity field mappings, default tags, and list routing. Moosewave owns the public Privy custom Webhook receiver for signup/contact JSON payloads, account/campaign route resolution, Basic auth verification, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; live Privy account setup, custom Webhook destination removal, Basic auth rotation, reconnect proof, data-delete proof, and live Privy certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderConvertFlow {
			resp.Message = "Create or update the managed ConvertFlow connection with account_id, campaign_id, a credential reference containing the Moosewave route token configured on the ConvertFlow webhook automation URL, optional site/campaign name, identity field mappings, default tags, and list routing. Moosewave owns the public ConvertFlow custom Webhook receiver for fields-submitted/contact/conversion JSON payloads, account/campaign route resolution, route-token verification, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; live ConvertFlow account setup, webhook automation removal, route-token rotation, reconnect proof, data-delete proof, and live ConvertFlow certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderSleeknote {
			resp.Message = "Create or update the managed Sleeknote connection with account_id, campaign_id, a credential reference containing the Moosewave route token configured on the Sleeknote custom integration URL, optional site/campaign name, identity field mappings, default tags, and list routing. Moosewave owns the public Sleeknote custom integration receiver for GET, form-encoded POST, and JSON signup payloads, account/campaign route resolution, route-token verification, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; live Sleeknote account setup, custom integration removal, route-token rotation, reconnect proof, data-delete proof, and live Sleeknote certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderWisepops {
			resp.Message = "Create or update the managed Wisepops connection with account_id, campaign_id, a credential reference containing the Wisepops API key used for X-Wisepops-Signature verification, optional hook_id/campaign name, identity field mappings, default tags, and list routing. Moosewave owns the public Wisepops signed Webhook receiver for contact-array or wrapper JSON payloads, account/campaign route resolution, raw-body HMAC-SHA256 verification, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; live Wisepops account setup, hook removal, API-key rotation, reconnect proof, data-delete proof, and live Wisepops certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderPoptin {
			resp.Message = "Create or update the managed Poptin connection with account_id, popup_id, a credential reference containing the Moosewave route token configured on the Poptin Webhooks integration URL, optional site/popup name, identity field mappings, default tags, and list routing. Moosewave owns the public Poptin Webhooks receiver for GET, form-encoded POST, and JSON popup lead payloads, account/popup route resolution, route-token verification, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; live Poptin account setup, Webhooks integration removal, route-token rotation, reconnect proof, data-delete proof, and live Poptin certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderHelloBar {
			resp.Message = "Create or update the managed Hello Bar connection with site_id, campaign_id, a credential reference containing the Moosewave route token configured on the Hello Bar Webhook URL, optional account/bar name, identity field mappings, default tags, and list routing. Moosewave owns the public Hello Bar Webhook receiver for GET, form-encoded POST, and JSON subscriber payloads, site/campaign route resolution, route-token verification, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; live Hello Bar account setup, Webhook removal, route-token rotation, reconnect proof, data-delete proof, and live Hello Bar certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderLandingi {
			resp.Message = "Create or update the managed Landingi connection with account_id, page_id, a credential reference containing the Moosewave route token configured on the Landingi Webhook URL or request header, optional form/page name, identity field mappings, default tags, and list routing. Moosewave owns the public Landingi Webhook receiver for GET, form-encoded POST, and JSON lead payloads, account/page route resolution, optional form_id filtering, route-token verification, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; live Landingi account setup, Webhook integration removal, route-token rotation, reconnect proof, data-delete proof, and live Landingi certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderKickoffLabs {
			resp.Message = "Create or update the managed KickoffLabs connection with account_id, campaign_id, a credential reference containing the Moosewave route token configured on the KickoffLabs outbound Webhook URL, optional page/campaign name, identity field mappings, default tags, and list routing. Moosewave owns the public KickoffLabs outbound Webhook receiver for GET, form-encoded POST, and JSON lead/referral/reward payloads, account/campaign route resolution, optional page_id filtering, route-token verification, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; live KickoffLabs account setup, outbound Webhook removal, route-token rotation, reconnect proof, data-delete proof, and live KickoffLabs certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderNinjaForms {
			resp.Message = "Create or update the managed Ninja Forms connection with site_url, form_id, a credential reference containing the Moosewave route token configured in the Ninja Forms Webhooks action, optional form name, identity field mappings, default tags, and list routing. Moosewave owns the public Ninja Forms Webhooks add-on receiver for GET, form-encoded POST, and JSON submission payloads, WordPress site/form route resolution, route-token verification, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; live WordPress/Ninja Forms setup, Webhooks action removal, route-token rotation, reconnect proof, data-delete proof, and live Ninja Forms certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderOutgrow {
			resp.Message = "Create or update the managed Outgrow connection with account_id, campaign_id, a credential reference containing the Moosewave route token or Basic auth credentials configured on the Outgrow Webhook destination, optional calculator/quiz name, identity field mappings, default tags, and list routing. Moosewave owns the public Outgrow Webhook receiver for JSON/form lead, visit, and result payloads, account/campaign route resolution, optional calculator_id or quiz_id filtering, Basic-or-route-token verification, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; live Outgrow account setup, Webhook removal, credential rotation, reconnect proof, data-delete proof, and live Outgrow certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderShortStack {
			resp.Message = "Create or update the managed ShortStack connection with account_id, campaign_id, a credential reference containing the ShortStack Webhook form integration secret key, optional form/campaign name, identity field mappings, default tags, and list routing. Moosewave owns the public ShortStack Webhook form integration receiver for form-encoded POST and JSON entry payloads, account/campaign route resolution, X-SS-Signature HMAC-SHA1 verification over the raw body, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; live ShortStack account setup, Webhook form integration removal, secret rotation, reconnect proof, data-delete proof, and live ShortStack certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderRiddle {
			resp.Message = "Create or update the managed Riddle connection with account_id, quiz_id, a credential reference containing the Riddle signature key or Moosewave route token configured on the webhook destination, optional campaign/riddle name, identity field mappings, default tags, and list routing. Moosewave owns the public Riddle Webhook receiver for JSON lead/result payloads, account/quiz route resolution, signature-or-route-token verification, durable lead webhook idempotency, canonical profile/list/event import, run history, disconnected-row fail-closed behavior, and operator-managed provider_cleanup evidence on disconnect; live Riddle account setup, Webhook removal, credential rotation, reconnect proof, data-delete proof, and live Riddle certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderFillout {
			resp.Message = "Create or update the managed Fillout connection with form_id, Bearer API-key credential refs, optional webhook_secret_ref, EU/custom API base URL routing, submission filters, auto-registered /webhook/create URL-token webhook setup, and returned/persisted provider_cleanup evidence on managed webhook disconnect; live Fillout certification remains pending."
		} else if meta.Provider == leadintegrations.ProviderPaperform {
			resp.Message = "Create or update the managed Paperform connection with form_id slug or ID, Bearer API-key credential refs, optional API base URL, page size, form name, date filters, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled /forms/{slug_or_id}/submissions pulls with paperform_retry continuation plus operator-managed provider_cleanup evidence on disconnect; provider-managed webhooks, API-key revocation proof, duplicate export cleanup, reconnect proof, data-delete proof, and live Paperform certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderFormstack {
			resp.Message = "Create or update the managed Formstack connection with form_id, Bearer Personal Access Token credential refs, optional API base URL, page size, form name, date filters, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled /api/v2025/forms/{formId}/submissions pulls with formstack_retry continuation plus operator-managed provider_cleanup evidence on disconnect; provider-managed webhooks, PAT revocation proof, duplicate export cleanup, reconnect proof, encrypted-form password certification, data-delete proof, and live Formstack certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderFormsite {
			resp.Message = "Create or update the managed Formsite connection with api_base_url, account_id/user_dir, form_id/form_dir, bearer access-token credential refs, optional page size, form name, result filters, item identity mappings, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled /api/v2/{user_dir}/forms/{form_dir}/results pulls with formsite_retry continuation plus operator-managed provider_cleanup evidence on disconnect; provider-managed webhooks/server posts, token revocation proof, duplicate export cleanup, reconnect proof, data-delete proof, Professional-plan access, and live Formsite certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderCognitoForms {
			resp.Message = "Create or update the managed Cognito Forms connection with form_id, view_id, Bearer API-key credential refs, optional REST/OData base URLs, local ID batch size, field identity mappings, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled OData grid-view entry ID discovery plus REST entry hydration with cognito_forms_retry continuation and operator-managed provider_cleanup evidence on disconnect; API-key revocation, selected grid-view field visibility, ID monotonicity/updated-entry behavior, duplicate OData/export/webhook cleanup, reconnect proof, data-delete proof, and live Cognito Forms certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderGravityForms {
			resp.Message = "Create or update the managed Gravity Forms connection with site_url, form_id, WordPress Application Password or Gravity Forms REST credential refs, optional page size, entry status/search filters, field identity mappings, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled /wp-json/gf/v2/forms/{form_id}/entries pulls with gravity_forms_retry continuation plus operator-managed provider_cleanup evidence on disconnect; REST API enablement, HTTPS credential proof, provider-managed webhook/feed cleanup, credential revocation proof, reconnect proof, data-delete proof, and live WordPress/Gravity Forms certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderWPForms {
			resp.Message = "Create or update the managed WPForms connection with site_url, numeric form_id, WordPress Application Password credential refs, optional page size, entry status/type/search/date filters, field identity mappings, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled WordPress Abilities API pulls through wpforms/get-form and wpforms/search-entries with wpforms_retry continuation plus operator-managed provider_cleanup evidence on disconnect; WordPress 6.9+, WPForms 1.9.9+ Pro entry access, credential revocation proof, provider-managed webhook/feed cleanup, reconnect proof, data-delete proof, and live WordPress/WPForms certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderFormidableForms {
			resp.Message = "Create or update the managed Formidable Forms connection with site_url, form_id, WordPress Application Password or Formidable API-key credential refs, optional page size, search/sort filters, field identity mappings, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled /wp-json/frm/v2/forms/{form_id}, /fields, and /entries pulls with formidable_forms_retry continuation plus operator-managed provider_cleanup evidence on disconnect; Formidable API add-on/license proof, credential revocation proof, provider-managed webhook/API-action/feed cleanup, reconnect proof, data-delete proof, and live WordPress/Formidable certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderFeathery {
			resp.Message = "Create or update the managed Feathery connection with form_id, Token API-key credential refs, optional regional API base URL, page size, form name, timestamp filters, field identity mappings, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled /api/form/submission/ pulls with feathery_retry continuation plus operator-managed provider_cleanup evidence on disconnect; provider-managed webhooks, API-key revocation proof, duplicate export cleanup, reconnect proof, data-delete proof, and live Feathery workspace certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderFormaloo {
			resp.Message = "Create or update the managed Formaloo connection with form_id or form_slug, x-api-key plus API-secret or authorization-token credential refs, optional workspace ID, API base URL, page size, timestamp/search/tag filters, row-data identity mappings, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled /v3.0/forms/{slug}/rows/ pulls with formaloo_retry continuation plus operator-managed provider_cleanup evidence on disconnect; provider-managed webhooks, API-key/API-secret/token revocation proof, duplicate export cleanup, reconnect proof, data-delete proof, and live Formaloo workspace certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderGoogleForms {
			resp.Message = "Create or update the managed Google Forms connection with form_id, OAuth access-token credential refs, optional API base URL, page size, form name, RFC3339 timestamp lower bound, question identity mappings, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled /v1/forms/{formId} plus /v1/forms/{formId}/responses pulls with google_forms_retry continuation plus operator-managed provider_cleanup evidence on disconnect; Cloud Pub/Sub watches, OAuth app verification, token revocation proof, duplicate Apps Script/Sheets/webhook cleanup, reconnect proof, data-delete proof, and live Google Workspace certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderTally {
			resp.Message = "Create or update the managed Tally connection with form_id, Bearer API-key credential refs, optional API base URL, page size, form name, default tags, and list routing. Moosewave owns explicit, connect-time, and scheduled /forms/{formId}/submissions pulls with tally_retry continuation plus operator-managed provider_cleanup evidence on disconnect; provider-managed webhooks, token revocation proof, duplicate export cleanup, reconnect proof, data-delete proof, and live Tally certification remain pending."
		} else if meta.Provider == leadintegrations.ProviderJotform {
			resp.Message = "Create or update the managed Jotform connection with form_id, APIKEY credential refs, optional webhook_secret_ref, Standard/EU/HIPAA/custom API host routing, managed form webhook list/reuse/create setup, and returned/persisted provider_cleanup evidence on managed webhook disconnect; live Jotform certification remains pending."
		} else if meta.Provider == leadintegrations.ProviderWebflow {
			resp.Message = "Create or update the managed Webflow connection with site_id, OAuth/API-token credential refs, optional webhook_secret_ref, form_id/form_element_id/form_name filters, stored /v2/webhooks/{webhook_id} validation, managed /v2/sites/{site_id}/webhooks repair/reuse/create setup, and returned/persisted provider_cleanup evidence on managed webhook disconnect; live Webflow certification remains pending."
		} else if meta.Provider == leadintegrations.ProviderFacebookLeadAds {
			resp.Message = "Create or update the managed Facebook Lead Ads connection with page_id, form_id, a Meta Graph OAuth credential reference, and optional webhook_secret_ref containing the Meta app secret. Moosewave owns explicit and scheduled /{form_id}/leads REST backfill, managed Page leadgen subscription reconciliation/cleanup, signed leadgen webhook verification, lead-ID follow-up fetch, durable delivery claims, canonical submission mapping, and returned/persisted provider_cleanup evidence for managed Page subscription disconnect cleanup; page/form ownership certification and live Meta app-review evidence remain partial."
		} else if meta.Provider == leadintegrations.ProviderGoogleLeadForms {
			resp.Message = "Create or update the managed Google Lead Form Extensions connection with customer_id, lead_form_asset_id, optional campaign_id/login_customer_id, and a credential reference containing Google Ads OAuth access-token plus developer-token material. Moosewave owns explicit, connect-time, and scheduled GoogleAdsService.Search backfill for lead_form_submission_data into canonical submissions plus operator-managed provider_cleanup evidence on disconnect; live Google Ads account/API certification, ownership/export-window evidence, duplicate/manual CRM export audit, and data-delete proof remain before full availability."
		} else if isManagedAnalyticsPullerProvider(meta.Provider) {
			resp.Message = "Create or update the managed " + meta.Name + " analytics connection with credential references and provider identifiers. Moosewave owns explicit, connect-time, and scheduled analytics profile pulls, retry cursors, run history, disconnect-safe local writes, and persisted operator-managed provider_cleanup evidence; provider webhooks, event/report/warehouse expansion, credential cleanup proof, reconnect/data-delete proof, and live provider certification remain before full availability."
		} else {
			resp.Message = "Create or update the managed " + meta.Surface + " connection using " + readableAuthMode(meta.AuthMode) + " credentials."
		}
	case "sync":
		if meta.Provider == crmintegrations.ProviderHubSpot {
			resp.RequiredFields = []string{"id", "contacts|list_memberships|deal_events|empty_hubspot_provider_pull"}
			resp.Message = "Trigger a HubSpot CRM provider pull with an empty request, import canonical contacts/events directly, or let signed app-webhook deliveries refresh changed contacts. The native puller uses Bearer auth, /crm/objects/2026-03/contacts by default, after-cursor pagination, configured contact properties, optional sync_list_memberships fanout through /crm/v3/lists/{listId}/memberships plus contact batch reads with provider-list segment evidence and complete-scan stale repair for owned memberships, optional list_membership_map materialization into native Moosewave lists, optional sync_deals fanout through /crm/objects/2026-03/deals with contact/company associations plus batch reads, deal-to-CRM-event mapping by associated contact email, run-history checkpoints, and scheduled retry cursors; historical legacy owner reconciliation, broader deal lifecycle coverage, and live portal certification remain partial."
		} else if meta.Provider == crmintegrations.ProviderSalesforce {
			resp.RequiredFields = []string{"id", "contacts|leads|campaign_member_events|task_events|empty_salesforce_provider_pull"}
			resp.Message = "Trigger a Salesforce CRM SOQL provider pull with an empty request, import canonical contacts/events directly, or let the scheduled salesforce_retry continuation resume due cursors. The native puller uses OAuth Bearer auth with managed token refresh, one-shot reactive INVALID_SESSION_ID refresh, /services/data/v67.0/query by default, Sforce-Query-Options batch sizing, Contact then Lead then CampaignMember then Task queries, nextRecordsUrl cursor checkpoints, CampaignMember-to-CRM-event mapping, optional campaign_membership_map materialization into native Moosewave list adds, explicit removal-signal soft-removes, complete-scan stale repair for owned mapped Campaign memberships, Task-to-CRM-activity mapping through TYPEOF Who Contact/Lead emails, and CRM run history; live Salesforce certification remains before full availability."
		} else if meta.Provider == crmintegrations.ProviderPipedrive {
			resp.RequiredFields = []string{"id", "persons|deals|organizations|activities|empty_pipedrive_provider_pull"}
			resp.Message = "Trigger a Pipedrive CRM provider pull with an empty request, or import canonical contacts and events directly. The native puller uses /api/v2/persons, /api/v2/deals, /api/v2/organizations, and /api/v2/activities with API-token query auth or OAuth Bearer auth, limit/cursor pagination, stable source IDs, object filters, CRM run-history checkpoints, scheduled pipedrive_retry continuation, not-due retry filtering, and SYNC_FAILED preservation; live certification remains partial."
		} else if meta.Provider == crmintegrations.ProviderZohoCRM {
			resp.RequiredFields = []string{"id", "contacts|leads|empty_zoho_provider_pull"}
			resp.Message = "Trigger a Zoho CRM V8 records provider pull with an empty request, import canonical contacts directly, or let scheduled zoho_retry continuation process due installs. The native puller uses Authorization: Zoho-oauthtoken with managed token refresh, /crm/v8/Contacts then /crm/v8/Leads, per_page/page/page_token pagination, stable Zoho source IDs, manual retry-cursor skip/resume/failure preservation, and CRM run-history checkpoints; Accounts, Deals, activities, notifications, cleanup proof, and live certification remain partial."
		} else if meta.Provider == crmintegrations.ProviderDynamics365 {
			resp.RequiredFields = []string{"id", "contacts|leads|empty_dynamics365_provider_pull"}
			resp.Message = "Trigger a Microsoft Dynamics 365 Dataverse provider pull with an empty request, import canonical contacts directly, or let scheduled dynamics365_retry continuation process due installs. The native puller uses OAuth Bearer auth with managed token refresh, /api/data/v9.2/contacts then /api/data/v9.2/leads, OData nextLink pagination, stable Dataverse source IDs, manual retry-cursor skip/resume/failure preservation, and CRM run-history checkpoints; Accounts, Opportunities, activities, lists, change tracking, cleanup proof, and live certification remain partial."
		} else if meta.Provider == crmintegrations.ProviderKeap {
			resp.RequiredFields = []string{"id", "contacts|empty_keap_provider_pull"}
			resp.Message = "Trigger a Keap REST v2 Contacts provider pull with an empty request, import canonical contacts directly, or let scheduled keap_retry continuation process due installs. The native puller uses Bearer auth with managed token refresh when OAuth credentials are stored, /rest/v2/contacts, optional /rest/v2/tags/{tag_id}/contacts, page_token pagination, stable Keap source IDs, manual retry-cursor skip/resume/failure preservation, and CRM run-history checkpoints; full tags, campaigns, orders, appointments, webhooks, cleanup proof, and live certification remain partial."
		} else if meta.Provider == subscriptionintegrations.ProviderRecharge {
			resp.RequiredFields = []string{"id", "subscriptions|empty_recharge_provider_pull"}
			resp.Message = "Trigger a Recharge subscriptions provider pull with an empty request, import canonical subscription rows directly, or ingest tokenized subscription/charge webhooks with optional Recharge signature verification and durable delivery claims through the public endpoint. The native puller uses X-Recharge-Access-Token auth, /subscriptions, limit/cursor pagination, canonical subscription mapping, lifecycle event mapping, scheduled recharge_retry continuation, and subscription run history; disconnect persists operator-managed provider_cleanup readiness evidence and local cleanup acknowledgment records operator attestation while live merchant certification remains partial."
		} else if isManagedSubscriptionPullerProvider(meta.Provider) {
			resp.RequiredFields = managedSubscriptionPullerRequiredFields(meta.Provider)
			resp.Message = "Trigger a " + meta.Name + " provider pull with an empty request or import canonical rows directly. " + managedSubscriptionPullerSyncDescription(meta) + " Disconnect persists operator-managed provider_cleanup readiness evidence and local cleanup acknowledgment records operator attestation; provider-managed webhooks/callbacks, credential cleanup proof, extended objects, and live provider certification remain before full availability."
		} else if isManagedAnalyticsPullerProvider(meta.Provider) {
			resp.RequiredFields = managedAnalyticsPullerRequiredFields(meta.Provider)
			resp.Message = "Trigger a " + meta.Name + " analytics profile pull with an empty request or import canonical profiles directly. " + managedAnalyticsPullerSyncDescription(meta) + " Disconnect persists operator-managed provider_cleanup readiness evidence and local cleanup acknowledgment records operator attestation; provider-managed webhooks, event/report/warehouse expansion, credential cleanup proof, reconnect/data-delete proof, and live provider certification remain before full availability."
		} else if meta.Provider == reviewintegrations.ProviderYotpo {
			resp.RequiredFields = []string{"id", "reviews|empty_yotpo_provider_pull"}
			resp.Message = "Trigger a Yotpo Reviews REST provider pull with an empty request, import canonical review rows directly, accept tokenized review_create/review_updated webhook deliveries through the review webhook-ingest endpoint, or let scheduled yotpo_retry continuation process due installs. The native puller exchanges app_key/secret for a token, calls /v1/apps/{app_key}/reviews, uses count/page pagination capped at 100, persists yotpo: cursor checkpoints, performs lookup-only product/order evidence resolution to existing commerce UUIDs, can resolve product_id from matched existing order line items after order lookup, and maps customer evidence to the canonical review customer_id column plus metadata when commerce_integration_id is configured. It maps reviews into canonical review/profile/event sinks and dedupes tokenized webhook deliveries by WebhookMessageId. Review payload product evidence does not create or refresh commerce product rows; unresolved product misses carry product_refresh_required handoff metadata, disconnect persists provider_cleanup readiness evidence, and the acknowledgment endpoint records local operator attestation while signed verification, provider-managed webhook registration/cleanup automation, and live brand certification remain partial."
		} else if meta.Provider == loyaltyintegrations.ProviderSmile {
			resp.RequiredFields = []string{"id", "members|events|empty_smile_provider_pull"}
			resp.Message = "Delegate a Smile.io Customers/points/rewards REST provider pull to the concrete loyalty sync endpoint with an empty request, import canonical loyalty members and events directly, accept account-id-routed signed Smile app webhooks with integration-scoped durable delivery claims, or let scheduled smile_retry continuation process due installs. The native puller uses Bearer auth, /v1/customers page/page_size pagination plus /v1/points_transactions and /v1/reward_fulfillments cursor pagination, carries updated_at_min incremental event watermarks after smile:complete, preserves SYNC_FAILED retry cursors for fully failed local writes, refreshes member state during event phases, and maps customer points/VIP tier data plus points/reward history including pending rewards into loyalty sinks; managed cleanup automation and live store certification remain partial."
		} else if meta.Provider == supportintegrations.ProviderZendesk {
			resp.RequiredFields = []string{"id", "tickets|empty_zendesk_provider_pull"}
			resp.Message = "Trigger a Zendesk Tickets API provider pull with an empty request, opt into Incremental Export via incremental_export_enabled plus incremental_start_time, import canonical support rows directly, accept signed Zendesk ticket/comment webhooks with durable delivery claims and sparse ticket-id refresh, or let scheduled zendesk_retry continuation process due installs. The native puller uses OAuth Bearer or email/token Basic auth, /api/v2/tickets.json cursor pagination by default, /api/v2/incremental/tickets/cursor when enabled, /api/v2/tickets/{id}.json for sparse callback refresh, include=users side-loading for requester emails, canonical ticket/profile/event mapping, and support run history; disconnect best-effort deletes the stored zendesk_webhook_id and persists provider_cleanup evidence while live workspace certification remains partial."
		} else if meta.Provider == supportintegrations.ProviderIntercom {
			resp.RequiredFields = []string{"id", "conversations|empty_intercom_provider_pull"}
			resp.Message = "Trigger an Intercom Conversations REST provider pull with an empty request, import canonical support rows directly, accept signed Intercom app webhooks with durable delivery claims and sparse conversation refresh, or let scheduled intercom_retry continuation process due installs. The native puller uses OAuth Bearer auth, /conversations, per_page caps, starting_after cursor pagination, per-conversation /conversations/{id} detail hydration for source plus conversation-part support-message rows up to Intercom's 500-part API limit, safe source-author or cached contact lookup requester mapping, author/contact/assignee evidence, canonical support/profile/message/event mapping, and support run history; disconnect persists provider_cleanup readiness evidence while richer Admin/participant enrichment, attachment expansion, managed app-webhook cleanup automation, duplicate/manual target audit, and live workspace certification remain before RuntimeAvailable promotion."
		} else if meta.Provider == supportintegrations.ProviderHelpScout {
			resp.RequiredFields = []string{"id", "conversations|empty_helpscout_provider_pull"}
			resp.Message = "Trigger a Help Scout Conversations REST provider pull with an empty request, import canonical support rows directly, accept signed Help Scout app webhooks with durable delivery claims and sparse conversation refresh, or let scheduled help_scout_retry continuation process due installs. The native puller exchanges OAuth client credentials through /v2/oauth2/token, calls /v2/conversations with mailbox/status filters, embed=threads, and page checkpoints, maps primary-customer or thread-customer emails plus customer/user/note threads into canonical support/profile/message/event rows, and records support run history; disconnect persists provider_cleanup readiness evidence while managed cleanup automation and live mailbox certification remain partial."
		} else if meta.Provider == supportintegrations.ProviderFreshdesk {
			resp.RequiredFields = []string{"id", "tickets|empty_freshdesk_provider_pull"}
			resp.Message = "Trigger a Freshdesk Tickets REST provider pull with an empty request, import canonical support rows directly, accept authenticated Freshdesk automation webhooks with durable delivery claims and sparse ticket refresh, or let scheduled freshdesk_retry continuation process due installs. The native puller uses API-key Basic auth, /api/v2/tickets with include=requester, per_page/page checkpoints, optional local product_id filtering over returned ticket payloads, ticket or embedded-requester email mapping into canonical support/profile/event rows, Retry-After-aware provider errors, and support run history; disconnect persists provider_cleanup readiness evidence while managed cleanup automation and live helpdesk certification remain partial."
		} else if meta.Provider == supportintegrations.ProviderGorgias {
			resp.RequiredFields = []string{"id", "tickets|empty_gorgias_provider_pull"}
			resp.Message = "Trigger a Gorgias Tickets API provider pull with an empty request, import canonical support rows directly, accept authenticated Gorgias HTTP integration callbacks with durable delivery claims and sparse ticket-id refresh, or let scheduled gorgias_retry continuation process due installs. The native puller uses email/API-key Basic auth, /api/tickets cursor pagination by default, /api/tickets/{id} for sparse callback refresh, embedded customer email mapping, payload-present Shopify/Recharge/order evidence preservation in ticket/message properties, lookup-only commerce order/customer/product UUID resolution when commerce_integration_id is configured, canonical ticket/profile/event sinks, and support run history; disconnect best-effort deletes stored gorgias_http_integration_id values through DELETE /api/integrations/{id} and persists provider_cleanup evidence while official hmac_secret header certification, rule/duplicate integration cleanup proof, API-key cleanup, and live helpdesk certification remain partial."
		} else if meta.Provider == warehouse.ProviderSnowflake {
			resp.RequiredFields = []string{"id", "object_selection|manifest_run"}
			resp.Message = "Trigger a Snowflake warehouse manifest run. The local-runtime-complete warehouse export/health slice validates Snowflake settings, records provider_target_uri and provider_driver_attachment=manifest_worker, stores export handoff bundles and per-object JSONL load-plan artifacts when warehouse object storage is configured, emits destination schema DDL/validation previews, snowflake_load_plan_state plus snowflake_provider_job evidence with ordered statement plans, records retry_count prior-failure evidence for retry runs, makes dry_run export/import runs side-effect-safe, verifies artifacts, and passes executable COPY/import-query/health requests to the linked SnowflakeSQLExecutor. Live Snowflake account certification, remote query-row materialization, provider-aware retry proof, and Snowflake-side cleanup proof remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderTypeform {
			resp.RequiredFields = []string{"id", "responses|empty_typeform_provider_pull"}
			resp.Message = "Trigger a Typeform Responses API provider pull for form metadata and responses via /forms/{form_id}/responses with page_size caps, response_type filters, after-cursor traversal, and signed webhook evidence in lead sync history."
		} else if meta.Provider == leadintegrations.ProviderSurveyMonkey {
			resp.RequiredFields = []string{"id", "responses|empty_surveymonkey_provider_pull"}
			resp.Message = "Trigger a SurveyMonkey bulk Responses API provider pull with an empty request or import canonical submissions directly. The native puller uses OAuth Bearer credential refs, /v3/surveys/{survey_id}/details label hydration, /v3/surveys/{survey_id}/responses/bulk per_page pagination capped at 100, links.next checkpoints, optional collector/status/timestamp filters, answer identity mapping, lead sync history, and scheduled surveymonkey_retry continuation; provider-managed webhooks and live SurveyMonkey certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderUnbounce {
			resp.RequiredFields = []string{"id", "leads|empty_unbounce_provider_pull"}
			resp.Message = "Trigger an Unbounce Leads API provider pull with an empty request or import canonical submissions directly. The native puller uses OAuth Bearer or API-key Basic credential refs, /pages/{page_id}/form_fields label hydration, /pages/{page_id}/leads offset/limit pagination capped at 1000, from/to timestamp filters, field identity mapping, lead sync history, and scheduled unbounce_retry continuation; provider-managed webhooks and live Unbounce certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderLeadpages {
			resp.RequiredFields = []string{"id", "submissions|empty_leadpages_provider_pull"}
			resp.Message = "Trigger a Leadpages form submissions provider pull with an empty request or import canonical submissions directly. The native puller uses Bearer API-key or OAuth credential refs, /api/forms/{form_id}/submissions, provider cursor/next-link/page hints when returned, local submitted-at/ID watermarks, field identity mapping, lead sync history, and scheduled leadpages_retry continuation; live Leadpages response/pagination certification remains before full availability."
		} else if meta.Provider == leadintegrations.Provider123FormBuilder {
			resp.RequiredFields = []string{"id", "submissions|empty_123formbuilder_provider_pull"}
			resp.Message = "Trigger a 123FormBuilder REST API v2 submissions provider pull with an empty request or import canonical submissions directly. The native puller uses JWT query auth from credential refs or /token exchange, /forms/{form_id}/submissions, page/per_page pagination capped at 1000, start_submission_id checkpoints, content-field identity mapping, lead sync history, and scheduled 123formbuilder_retry continuation; live 123FormBuilder account and incremental-semantics certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderCarrd {
			resp.RequiredFields = []string{"id", "submissions|carrd_custom_url_delivery"}
			resp.Message = "Process Carrd leads through the public Custom URL receiver or import canonical submissions directly. The Carrd runtime verifies the vault-backed route token, resolves site_id/form_id, dedupes webhook deliveries, maps Carrd fields into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; Carrd does not claim a provider REST puller in this slice, so live Custom URL setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderOptinMonster {
			resp.RequiredFields = []string{"id", "submissions|optinmonster_webhook_delivery"}
			resp.Message = "Process OptinMonster leads through the public Webhook receiver or import canonical submissions directly. The OptinMonster runtime verifies the vault-backed route token, resolves account_id/campaign_id, dedupes webhook deliveries, maps JSON lead/campaign/meta/smart_tags payloads into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; OptinMonster does not claim a provider REST puller in this slice, so live Webhook setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderPrivy {
			resp.RequiredFields = []string{"id", "submissions|privy_custom_webhook_delivery"}
			resp.Message = "Process Privy signups through the public custom Webhook receiver or import canonical submissions directly. The Privy runtime verifies Basic auth credentials from the vault-backed reference, resolves account_id/campaign_id, dedupes webhook deliveries, maps signup/contact and campaign JSON payloads into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; Privy does not claim a provider REST puller in this slice, so live custom Webhook setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderConvertFlow {
			resp.RequiredFields = []string{"id", "submissions|convertflow_webhook_delivery"}
			resp.Message = "Process ConvertFlow fields-submitted/contact/conversion events through the public custom Webhook receiver or import canonical submissions directly. The ConvertFlow runtime verifies the vault-backed route token, resolves account_id/campaign_id, dedupes webhook deliveries, maps contact, field, and campaign/CTA/form JSON payloads into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; ConvertFlow does not claim a provider REST puller in this slice, so live webhook automation setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderSleeknote {
			resp.RequiredFields = []string{"id", "submissions|sleeknote_custom_integration_delivery"}
			resp.Message = "Process Sleeknote signups through the public custom integration receiver or import canonical submissions directly. The Sleeknote runtime verifies the vault-backed route token, resolves account_id/campaign_id, dedupes webhook deliveries, maps GET/form/JSON signup payloads including guid, CustomerId, SleeknoteId, and SignupPage into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; Sleeknote does not claim a provider REST puller in this slice, so live custom integration setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderWisepops {
			resp.RequiredFields = []string{"id", "submissions|wisepops_webhook_delivery"}
			resp.Message = "Process Wisepops leads through the public signed Webhook receiver or import canonical submissions directly. The Wisepops runtime verifies X-Wisepops-Signature as a raw-body HMAC-SHA256 hex digest with the vault-backed API key, resolves account_id/campaign_id, dedupes webhook deliveries, maps contact-array or wrapper JSON payloads into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; Wisepops does not claim a provider REST puller in this slice, so live hook setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderPoptin {
			resp.RequiredFields = []string{"id", "submissions|poptin_webhook_delivery"}
			resp.Message = "Process Poptin popup leads through the public Webhooks receiver or import canonical submissions directly. The Poptin runtime verifies the vault-backed route token, resolves account_id/popup_id, dedupes webhook deliveries, maps GET/form/JSON popup lead payloads into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; Poptin does not claim a provider REST puller in this slice, so live Webhooks setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderHelloBar {
			resp.RequiredFields = []string{"id", "submissions|hello_bar_webhook_delivery"}
			resp.Message = "Process Hello Bar subscribers through the public Webhook receiver or import canonical submissions directly. The Hello Bar runtime verifies the vault-backed route token, resolves site_id/campaign_id, dedupes webhook deliveries, maps GET/form/JSON subscriber payloads into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; Hello Bar does not claim a provider REST puller in this slice, so live Webhook setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderLandingi {
			resp.RequiredFields = []string{"id", "submissions|landingi_webhook_delivery"}
			resp.Message = "Process Landingi leads through the public Webhook receiver or import canonical submissions directly. The Landingi runtime verifies the vault-backed route token, resolves account_id/page_id with optional form_id filtering, dedupes webhook deliveries, maps GET/form/JSON lead payloads into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; Landingi does not claim a provider REST puller in this slice, so live Webhook setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderKickoffLabs {
			resp.RequiredFields = []string{"id", "submissions|kickofflabs_webhook_delivery"}
			resp.Message = "Process KickoffLabs leads, referrals, and rewards through the public outbound Webhook receiver or import canonical submissions directly. The KickoffLabs runtime verifies the vault-backed route token, resolves account_id/campaign_id with optional page_id filtering, dedupes webhook deliveries, maps form/JSON lead/referral/reward payloads into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; KickoffLabs does not claim a provider REST puller in this slice, so live outbound Webhook setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderNinjaForms {
			resp.RequiredFields = []string{"id", "submissions|ninja_forms_webhook_delivery"}
			resp.Message = "Process Ninja Forms submissions through the public Webhooks add-on receiver or import canonical submissions directly. The Ninja Forms runtime verifies the vault-backed route token, resolves site_url/form_id, dedupes webhook deliveries, maps GET/form/JSON submission payloads into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; Ninja Forms does not claim a provider REST puller in this slice, so live Webhooks action setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderOutgrow {
			resp.RequiredFields = []string{"id", "submissions|outgrow_webhook_delivery"}
			resp.Message = "Process Outgrow leads, visits, and calculated results through the public Webhook receiver or import canonical submissions directly. The Outgrow runtime verifies the vault-backed route token or Basic auth credentials, resolves account_id/campaign_id with optional calculator_id or quiz_id filtering, dedupes webhook deliveries, maps JSON/form payloads into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; Outgrow does not claim a provider REST puller in this slice, so live Webhook setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderShortStack {
			resp.RequiredFields = []string{"id", "submissions|shortstack_webhook_delivery"}
			resp.Message = "Process ShortStack entries through the public signed Webhook form integration receiver or import canonical submissions directly. The ShortStack runtime verifies X-SS-Signature with the vault-backed secret key, resolves account_id/campaign_id, dedupes webhook deliveries, maps form/JSON entry payloads into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; ShortStack does not claim a provider REST puller in this slice, so live Webhook form integration setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderRiddle {
			resp.RequiredFields = []string{"id", "submissions|riddle_webhook_delivery"}
			resp.Message = "Process Riddle leads and results through the public Webhook receiver or import canonical submissions directly. The Riddle runtime verifies a vault-backed signature key or route token, resolves account_id/quiz_id with optional campaign_id filtering, dedupes webhook deliveries, maps JSON form/result payloads into canonical profile/list/event imports, records lead sync history, and fails closed after disconnect; Riddle does not claim a provider REST puller in this slice, so live Webhook setup and historical export/import certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderFillout {
			resp.RequiredFields = []string{"id", "submissions|empty_fillout_provider_pull"}
			resp.Message = "Trigger a Fillout REST provider pull for form metadata and submissions via /forms/{formId}/submissions with limit/offset pagination, submission filters, totalResponses/pageCount-aware cursors, and URL-token webhook evidence in lead sync history."
		} else if meta.Provider == leadintegrations.ProviderFormsite {
			resp.RequiredFields = []string{"id", "results|empty_formsite_provider_pull"}
			resp.Message = "Trigger a Formsite REST provider pull with an empty request or import canonical submissions directly. The native puller uses bearer credential refs, /api/v2/{user_dir}/forms/{form_dir}/results, page/limit pagination capped at 500, Pagination-* continuation headers, optional date/result-ID filters, item identity mapping, lead sync history, and scheduled formsite_retry continuation; provider-managed webhooks/server posts and live Formsite certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderCognitoForms {
			resp.RequiredFields = []string{"id", "entries|empty_cognito_forms_provider_pull"}
			resp.Message = "Trigger a Cognito Forms OData/REST provider pull with an empty request or import canonical submissions directly. The native puller uses Bearer API-key credential refs, /api/odata/Forms({form_id}) metadata, /api/forms/{form_id}/schema field labels, /api/odata/Forms({form_id})/Views({view_id})/Entries ID discovery, REST /api/forms/{form_id}/entries/{entry_id} hydration, local last_id batching capped at 50 hydrated entries, field identity mapping, lead sync history, and scheduled cognito_forms_retry continuation; live Cognito Forms certification remains before full availability."
		} else if meta.Provider == leadintegrations.ProviderGravityForms {
			resp.RequiredFields = []string{"id", "entries|empty_gravity_forms_provider_pull"}
			resp.Message = "Trigger a Gravity Forms Entries REST provider pull with an empty request or import canonical submissions directly. The native puller uses WordPress Application Password or Gravity Forms REST Basic credential refs, /wp-json/gf/v2/forms/{form_id}/entries, _labels=1, page_size/offset pagination, optional status/search filters, field-label identity mapping, lead sync history, and scheduled gravity_forms_retry continuation; provider-managed webhooks/feeds and live WordPress/Gravity Forms certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderWPForms {
			resp.RequiredFields = []string{"id", "entries|empty_wpforms_provider_pull"}
			resp.Message = "Trigger a WPForms Abilities API provider pull with an empty request or import canonical submissions directly. The native puller uses WordPress Application Password Basic credential refs, wpforms/get-form metadata hydration, wpforms/search-entries page/limit pagination capped at 100, include_fields=true, optional status/type/search/date filters, field-label identity mapping, lead sync history, and scheduled wpforms_retry continuation; provider-managed webhooks/feeds and live WordPress/WPForms certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderFormidableForms {
			resp.RequiredFields = []string{"id", "entries|empty_formidable_forms_provider_pull"}
			resp.Message = "Trigger a Formidable Forms Entries REST provider pull with an empty request or import canonical submissions directly. The native puller uses WordPress Application Password or Formidable API-key Basic credential refs, /wp-json/frm/v2/forms/{form_id}, /fields, and /entries, page/page_size pagination capped at 200, optional search/sort filters, field-label identity mapping, lead sync history, and scheduled formidable_forms_retry continuation; provider-managed webhooks/API actions/feeds and live WordPress/Formidable certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderFeathery {
			resp.RequiredFields = []string{"id", "submissions|empty_feathery_provider_pull"}
			resp.Message = "Trigger a Feathery REST provider pull with an empty request or import canonical submissions directly. The native puller uses Token credential refs, /api/form/submission/?form_id=..., page_size pagination capped at 1000, next URL checkpoints, optional timestamp/completed filters, field-value identity mapping, lead sync history, and scheduled feathery_retry continuation; provider-managed webhooks and live Feathery certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderFormaloo {
			resp.RequiredFields = []string{"id", "rows|empty_formaloo_provider_pull"}
			resp.Message = "Trigger a Formaloo Rows API provider pull with an empty request or import canonical submissions directly. The native puller uses x-api-key plus JWT credential refs, /v3.0/forms/{slug}/rows/, page/page_size pagination, optional workspace headers and timestamp/search/tag filters, row-data identity mapping, lead sync history, and scheduled formaloo_retry continuation; provider-managed webhooks and live Formaloo certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderGoogleForms {
			resp.RequiredFields = []string{"id", "responses|empty_google_forms_provider_pull"}
			resp.Message = "Trigger a Google Forms Responses API provider pull with an empty request or import canonical submissions directly. The native puller uses OAuth Bearer credential refs, /v1/forms/{formId} metadata hydration, /v1/forms/{formId}/responses pageToken pagination, RFC3339 timestamp filters, question-answer identity mapping, lead sync history, and scheduled google_forms_retry continuation; Cloud Pub/Sub watches and live Google Workspace certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderTally {
			resp.RequiredFields = []string{"id", "submissions|empty_tally_provider_pull"}
			resp.Message = "Trigger a Tally REST provider pull with an empty request or import canonical submissions directly. The native puller uses Bearer credential refs, /forms/{formId}/submissions, page/limit pagination capped at 500, hasMore checkpoints, field identity mapping, lead sync history, and scheduled tally_retry continuation; provider-managed webhooks and live Tally certification remain before full availability."
		} else if meta.Provider == leadintegrations.ProviderJotform {
			resp.RequiredFields = []string{"id", "submissions|empty_jotform_provider_pull"}
			resp.Message = "Trigger a Jotform REST provider pull for form metadata, questions, and submissions via /form/{formID}/submissions with APIKEY auth, offset/limit pagination, regional API hosts, and shared-token webhook evidence in lead sync history."
		} else if meta.Provider == leadintegrations.ProviderWebflow {
			resp.RequiredFields = []string{"id", "submissions|empty_webflow_provider_pull"}
			resp.Message = "Trigger a Webflow Data API provider pull for site-level or form-scoped submissions via /v2/sites/{site_id}/form_submissions or /v2/sites/{site_id}/forms/{form_id}/submissions with forms:read scope, elementId filtering, limit/offset pagination, Retry-After-aware retry cursors, and signed webhook evidence with durable delivery idempotency in lead sync history."
		} else if meta.Provider == leadintegrations.ProviderWix {
			resp.Message = "Trigger a Wix Forms and Contacts provider pull for submissions and contacts, then inspect lead sync history, webhook idempotency state, and contact-delete evidence."
		} else if meta.Provider == leadintegrations.ProviderFacebookLeadAds {
			resp.RequiredFields = []string{"id", "leads|empty_facebook_lead_ads_provider_pull"}
			resp.Message = "Trigger a Facebook Lead Ads Graph provider pull with an empty request, receive signed leadgen webhook deliveries, or import canonical submissions directly. The native runtime uses Meta OAuth Bearer auth, /{form_id}/leads, managed Page leadgen subscriptions, /{leadgen_id} webhook follow-up fetches, field_data identity mapping, ad/campaign attribution fields, Graph after-cursor checkpoints, lead sync history, durable webhook claims, and scheduled facebook_lead_ads_retry continuation; ownership checks and live app-review evidence remain partial."
		} else if meta.Provider == leadintegrations.ProviderGoogleLeadForms {
			resp.RequiredFields = []string{"id", "lead_form_submission_data|empty_google_lead_forms_provider_pull"}
			resp.Message = "Trigger a Google Lead Form Extensions Google Ads API provider pull with an empty request, or import canonical submissions directly. The native puller uses OAuth Bearer auth, developer-token headers, optional login-customer-id, /customers/{customer_id}/googleAds:search, GAQL filters for lead_form_submission_data asset/campaign, submission_date_time/id watermark checkpoints, standard/custom field mapping, lead sync history, and scheduled google_lead_forms_retry continuation; live Google Ads certification remains before full availability."
		} else if isPostwaveIngestSyncModel(meta.SyncModel) {
			resp.Message = "Import canonical " + meta.Name + " rows through the managed provider surface and watch run history."
		} else {
			resp.Message = "Trigger an incremental " + meta.Surface + " sync for " + meta.Name + " and watch sync history."
		}
	case "backfill":
		if meta.Provider == crmintegrations.ProviderHubSpot {
			resp.RequiredFields = []string{"id", "empty_hubspot_provider_pull"}
			resp.Message = "Start a historical HubSpot contact, configured list-membership, and opt-in deal association event backfill with HubSpot after-cursor checkpoints, page-size caps, credential-reference Bearer auth, contact/deal/company property mapping, Lists API membership traversal with provider-list segment evidence and complete-scan stale repair for owned memberships, optional list_membership_map materialization into native Moosewave lists, deal contact/company association traversal, batch reads by ID, Retry-After-aware provider errors, scheduled retry continuation, and sync history. Historical legacy owner reconciliation, broader deal lifecycle coverage, and live HubSpot portal certification remain required before full availability."
		} else if meta.Provider == crmintegrations.ProviderSalesforce {
			resp.RequiredFields = []string{"id", "empty_salesforce_provider_pull"}
			resp.Message = "Start a historical Salesforce Contact, Lead, CampaignMember, and Task backfill with SOQL query locators, Sforce-Query-Options batch-size control, OAuth Bearer credential refs, proactive and reactive managed token refresh, Retry-After-aware provider errors, CampaignMember CRM event fanout, optional campaign_membership_map materialization into native Moosewave list adds, explicit removal-signal soft-removes, complete-scan stale repair for owned mapped Campaign memberships, Task activity fanout by Contact/Lead Who email, scheduled salesforce_retry continuation, and sync history. Live Salesforce certification remains required before full availability."
		} else if meta.Provider == crmintegrations.ProviderPipedrive {
			resp.RequiredFields = []string{"id", "empty_pipedrive_provider_pull"}
			resp.Message = "Start a historical Pipedrive backfill across persons, deals, organizations, and activities with Pipedrive API v2 limit/cursor checkpoints, API-token or OAuth Bearer credential refs with automatic managed-token refresh, Retry-After-aware provider errors, scheduled pipedrive_retry cursors with not-due filtering, person-to-contact mapping, deal event mapping, identity-safe organization enrichment, activity event mapping, disconnect-safe local writes, and sync history. Live Pipedrive certification work remains required before full availability."
		} else if meta.Provider == crmintegrations.ProviderZohoCRM {
			resp.RequiredFields = []string{"id", "empty_zoho_provider_pull"}
			resp.Message = "Start a historical Zoho CRM Contacts and Leads backfill with /crm/v8 module pages, per_page caps, page/page_token checkpoints, Zoho-oauthtoken credential refs with managed refresh, Retry-After-aware provider errors, scheduled zoho_retry continuation, manual retry-cursor skip/resume/failure preservation, contact/lead mapping, and sync history. Notification API channels, Accounts, Deals, activities, cleanup proof, and live Zoho certification remain required before full availability."
		} else if meta.Provider == crmintegrations.ProviderDynamics365 {
			resp.RequiredFields = []string{"id", "empty_dynamics365_provider_pull"}
			resp.Message = "Start a historical Microsoft Dynamics 365 Dataverse Contacts and Leads backfill with /api/data/v9.2 table pages, odata.maxpagesize caps, @odata.nextLink checkpoints, OAuth Bearer credential refs with managed refresh, Retry-After-aware provider errors, scheduled dynamics365_retry continuation, manual retry-cursor skip/resume/failure preservation, contact/lead mapping, and sync history. Change tracking/webhooks, Accounts, Opportunities, activities, marketing lists, cleanup proof, and live Dataverse certification remain required before full availability."
		} else if meta.Provider == crmintegrations.ProviderKeap {
			resp.RequiredFields = []string{"id", "empty_keap_provider_pull"}
			resp.Message = "Start a historical Keap Contacts backfill with REST v2 pages, page_size caps, page_token checkpoints, OAuth/PAT/SAK Bearer credential refs with managed OAuth refresh when available, Retry-After-aware provider errors, scheduled keap_retry continuation, manual retry-cursor skip/resume/failure preservation, contact mapping, and sync history. Full tag membership fanout, campaigns, orders, appointments, webhooks, cleanup proof, and live Keap certification remain required before full availability."
		} else if meta.Provider == subscriptionintegrations.ProviderRecharge {
			resp.RequiredFields = []string{"id", "empty_recharge_provider_pull"}
			resp.Message = "Start a historical Recharge subscription backfill with /subscriptions cursor checkpoints, page-size caps, API-token credential refs, Retry-After-aware provider errors, scheduled recharge_retry continuation, canonical subscription mapping, durable tokenized webhook delivery evidence, and subscription sync history. Disconnect persists operator-managed provider_cleanup readiness evidence, and local cleanup acknowledgment records operator attestation; live Recharge merchant certification remains required before full availability."
		} else if isManagedSubscriptionPullerProvider(meta.Provider) {
			resp.RequiredFields = []string{"id", "empty_" + strings.ReplaceAll(meta.Provider, "-", "_") + "_provider_pull"}
			resp.Message = "Start a historical " + meta.Name + " provider backfill. " + managedSubscriptionPullerSyncDescription(meta) + " Retry failures preserve subscription provider retry cursors and sync history; provider-managed webhooks/callbacks, credential cleanup proof, reconnect/data-delete proof, extended objects, and live provider certification remain required before full availability."
		} else if isManagedAnalyticsPullerProvider(meta.Provider) {
			resp.RequiredFields = []string{"id", "empty_" + strings.ReplaceAll(meta.Provider, "-", "_") + "_provider_pull"}
			resp.Message = "Start a historical " + meta.Name + " analytics profile backfill. " + managedAnalyticsPullerSyncDescription(meta) + " Retry failures preserve analytics provider retry cursors and sync history; provider-managed webhooks, event/report/warehouse expansion, credential cleanup proof, reconnect/data-delete proof, and live provider certification remain required before full availability."
		} else if meta.Provider == reviewintegrations.ProviderYotpo {
			resp.RequiredFields = []string{"id", "empty_yotpo_provider_pull"}
			resp.Message = "Start a historical Yotpo reviews backfill with app_key/secret token exchange, /v1/apps/{app_key}/reviews count/page checkpoints, page-size caps, Retry-After-aware provider errors, scheduled yotpo_retry continuation, lookup-only product/order UUID enrichment, order-line product fallback from existing commerce orders, resolved review customer_id linkage plus customer lookup evidence, tokenized review_create/review_updated ingest evidence, canonical review/reviewer/event mapping, and review sync history. Unresolved product misses carry product_refresh_required handoff metadata, disconnect persists provider_cleanup readiness evidence, and local cleanup acknowledgment records operator attestation; signed Yotpo webhook verification, provider-managed webhook registration/cleanup automation, broader product refresh behavior, and live brand certification remain required before full availability."
		} else if meta.Provider == loyaltyintegrations.ProviderSmile {
			resp.RequiredFields = []string{"id", "empty_smile_provider_pull"}
			resp.Message = "Start a historical Smile.io customer and event backfill with /v1/customers page/page_size checkpoints, /v1/points_transactions and /v1/reward_fulfillments cursor checkpoints, updated_at_min incremental event polling after smile:complete, page-size caps, API-token credential refs, Retry-After-aware provider errors, scheduled smile_retry continuation, account-id-routed signed app webhook ingest, points/VIP tier member mapping, points/reward/customer update event mapping, loyalty sync history, persisted operator-managed provider_cleanup readiness evidence on disconnect, and local cleanup acknowledgment for operator attestation. Managed cleanup automation and live store certification remain required before full availability."
		} else if meta.Provider == supportintegrations.ProviderZendesk {
			resp.RequiredFields = []string{"id", "empty_zendesk_provider_pull"}
			resp.Message = "Start a historical Zendesk ticket backfill with /api/v2/tickets.json cursor checkpoints by default or opt-in /api/v2/incremental/tickets/cursor checkpoints when incremental_export_enabled and incremental_start_time are configured. Both paths use page-size caps, OAuth/API-token credential refs, requester-user side-loading, Retry-After-aware provider errors, scheduled zendesk_retry continuation, signed ticket/comment webhook ingest, sparse ticket-id callback refresh, durable callback idempotency, canonical support mapping, and support sync history. Disconnect best-effort deletes the stored zendesk_webhook_id and persists provider_cleanup evidence; live workspace certification remains required before full availability."
		} else if meta.Provider == supportintegrations.ProviderIntercom {
			resp.RequiredFields = []string{"id", "empty_intercom_provider_pull"}
			resp.Message = "Start a historical Intercom conversation backfill with /conversations starting_after cursor checkpoints, page-size caps, OAuth credential refs, cached /contacts/{id} requester fallback, Retry-After-aware provider errors, scheduled intercom_retry continuation, per-conversation /conversations/{id} detail hydration for source plus conversation-part support-message rows up to Intercom's 500-part API limit, canonical support/profile/message/event mapping, signed X-Hub-Signature app webhook ingest, sparse /conversations/{id} callback refresh, durable callback idempotency, and support sync history. Disconnect persists provider_cleanup readiness evidence; richer Admin/participant enrichment, attachment expansion, managed app-webhook cleanup automation, duplicate/manual target audit, and live workspace certification remain before RuntimeAvailable promotion."
		} else if meta.Provider == supportintegrations.ProviderHelpScout {
			resp.RequiredFields = []string{"id", "empty_helpscout_provider_pull"}
			resp.Message = "Start a historical Help Scout conversation/thread backfill with /v2/oauth2/token client-credential exchange, /v2/conversations mailbox/status filters, embed=threads, page checkpoints, Retry-After and X-RateLimit-Retry-After-aware provider errors, scheduled help_scout_retry continuation, canonical support/profile/message/event mapping, and support sync history. Signed app webhook routing, durable callback idempotency, sparse conversation refresh, and disconnect provider_cleanup readiness evidence are wired; managed cleanup automation and live mailbox certification remain required before full availability."
		} else if meta.Provider == supportintegrations.ProviderFreshdesk {
			resp.RequiredFields = []string{"id", "empty_freshdesk_provider_pull"}
			resp.Message = "Start a historical Freshdesk ticket backfill with /api/v2/tickets include=requester page checkpoints, page-size caps, optional local product_id filtering, API-key credential refs, account-domain normalization, Retry-After-aware provider errors, scheduled freshdesk_retry continuation, authenticated automation-webhook ingest, sparse /api/v2/tickets/{id} callback refresh, durable callback idempotency, canonical support/profile/event mapping, and support sync history. Disconnect persists provider_cleanup readiness evidence; managed cleanup automation and live helpdesk certification remain required before full availability."
		} else if meta.Provider == supportintegrations.ProviderGorgias {
			resp.RequiredFields = []string{"id", "empty_gorgias_provider_pull"}
			resp.Message = "Start a historical Gorgias ticket backfill with /api/tickets cursor checkpoints, page-size caps, email/API-key credential refs, embedded customer mapping, bounded payload-present Shopify/Recharge/order evidence preservation, lookup-only commerce order/customer/product UUID resolution with refresh-required handoff metadata for misses, Retry-After-aware provider errors, scheduled gorgias_retry continuation, authenticated ticket/message callback ingest, sparse ticket-id callback refresh, durable callback idempotency, canonical support/profile/event sinks, and support sync history. Disconnect best-effort deletes stored Gorgias HTTP integration IDs and persists provider_cleanup evidence; official hmac_secret header certification, stored HTTP integration deletion certification, rule/duplicate integration cleanup proof, API-key cleanup, and live helpdesk certification remain required before full availability."
		} else if meta.Provider == warehouse.ProviderSnowflake {
			resp.RequiredFields = []string{"id"}
			resp.Message = "Start a Snowflake historical warehouse manifest run for the selected warehouse objects. Export runs record delivery_state=prepared_manifest with a stored Moosewave handoff bundle, per-object JSONL load-plan artifacts, destination schema DDL/validation previews, deterministic COPY SQL/provider-job planning with ordered statement plans, retry_count prior-failure evidence for retry runs, dry_run artifact/executor side-effect guards, and SnowflakeSQLExecutor artifact-verification/execution metrics when stage/storage/credential refs are present; import runs without staged rows record loader_state=import_plan_ready when import_table prerequisites are present, otherwise waiting_for_provider_driver, with snowflake_import_plan and ordered query provider-job evidence. Dry-run imports skip product-event materialization, row-error inserts, and cursor advancement. Live Snowflake account certification, returned-row materialization, provider retry/rate-limit proof, cleanup proof, and full account certification remain required before full availability."
		} else if meta.Provider == leadintegrations.ProviderTypeform {
			resp.RequiredFields = []string{"id", "empty_typeform_provider_pull"}
			resp.Message = "Start a historical Typeform responses backfill with Retrieve Form routing, page_size caps, response_type filters, after-cursor checkpoints, typeform_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderFillout {
			resp.RequiredFields = []string{"id", "empty_fillout_provider_pull"}
			resp.Message = "Start a historical Fillout submissions backfill with form metadata, limit/offset cursors, filters, pageCount/totalResponses accounting, fillout_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderSurveyMonkey {
			resp.RequiredFields = []string{"id", "empty_surveymonkey_provider_pull"}
			resp.Message = "Start a historical SurveyMonkey responses backfill with survey detail label hydration, /v3/surveys/{survey_id}/responses/bulk per_page and links.next cursors, timestamp watermarks, answer identity mapping, Retry-After-aware provider errors, surveymonkey_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderUnbounce {
			resp.RequiredFields = []string{"id", "empty_unbounce_provider_pull"}
			resp.Message = "Start a historical Unbounce leads backfill with /pages/{page_id}/form_fields label hydration, /pages/{page_id}/leads offset/limit cursors, timestamp watermarks, field identity mapping, Retry-After-aware provider errors, unbounce_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderLeadpages {
			resp.RequiredFields = []string{"id", "empty_leadpages_provider_pull"}
			resp.Message = "Start a historical Leadpages submissions backfill with /api/forms/{form_id}/submissions, provider cursor/next-link/page hints when returned, local submitted-at/ID watermarks, flexible field mapping, Retry-After-aware provider errors, leadpages_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.Provider123FormBuilder {
			resp.RequiredFields = []string{"id", "empty_123formbuilder_provider_pull"}
			resp.Message = "Start a historical 123FormBuilder submissions backfill with REST API v2 /forms/{form_id}/submissions, JWT query auth, page/per_page cursors capped at 1000, start_submission_id duplicate-safe checkpoints, content-field mapping, Retry-After-aware provider errors, 123formbuilder_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderCarrd {
			resp.RequiredFields = []string{"id", "submissions|manual_carrd_export"}
			resp.Message = "Carrd historical backfill is manual-import only in this runtime slice. Use Carrd exports or prior form data to submit canonical lead submissions through Moosewave while new leads arrive through the route-token Custom URL receiver; live Carrd certification must prove Pro Plus setup, Custom URL delivery formats, destination cleanup, token rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderOptinMonster {
			resp.RequiredFields = []string{"id", "submissions|manual_optinmonster_export"}
			resp.Message = "OptinMonster historical backfill is manual-import only in this runtime slice. Use OptinMonster exports or prior lead data to submit canonical lead submissions through Moosewave while new leads arrive through the route-token Webhook receiver; live OptinMonster certification must prove Pro account setup, JSON Webhook delivery shape, destination cleanup, token rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderPrivy {
			resp.RequiredFields = []string{"id", "submissions|manual_privy_export"}
			resp.Message = "Privy historical backfill is manual-import only in this runtime slice. Use Privy exports or prior signup data to submit canonical lead submissions through Moosewave while new signups arrive through the Basic-authenticated custom Webhook receiver; live Privy certification must prove account setup, signup/contact delivery shape, custom Webhook cleanup, Basic auth rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderConvertFlow {
			resp.RequiredFields = []string{"id", "submissions|manual_convertflow_export"}
			resp.Message = "ConvertFlow historical backfill is manual-import only in this runtime slice. Use ConvertFlow exports or prior contact/submission data to submit canonical lead submissions through Moosewave while new events arrive through the route-token custom Webhook receiver; live ConvertFlow certification must prove account setup, fields-submitted/contact/conversion delivery shape, webhook automation cleanup, route-token rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderSleeknote {
			resp.RequiredFields = []string{"id", "submissions|manual_sleeknote_export"}
			resp.Message = "Sleeknote historical backfill is manual-import only in this runtime slice. Use Sleeknote exports or prior signup data to submit canonical lead submissions through Moosewave while new signups arrive through the route-token custom integration receiver; live Sleeknote certification must prove account setup, GET/form/JSON delivery shape, custom integration cleanup, route-token rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderWisepops {
			resp.RequiredFields = []string{"id", "submissions|manual_wisepops_export"}
			resp.Message = "Wisepops historical backfill is manual-import only in this runtime slice. Use Wisepops exports or prior contact data to submit canonical lead submissions through Moosewave while new leads arrive through the signed Webhook receiver; live Wisepops certification must prove hook setup, contact-array delivery shape, HMAC signature behavior, hook cleanup, API-key rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderPoptin {
			resp.RequiredFields = []string{"id", "submissions|manual_poptin_export"}
			resp.Message = "Poptin historical backfill is manual-import only in this runtime slice. Use Poptin exports or prior popup lead data to submit canonical lead submissions through Moosewave while new leads arrive through the route-token Webhooks receiver; live Poptin certification must prove account setup, delivery shape, Webhooks cleanup, route-token rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderHelloBar {
			resp.RequiredFields = []string{"id", "submissions|manual_hello_bar_export"}
			resp.Message = "Hello Bar historical backfill is manual-import only in this runtime slice. Use Hello Bar exports or prior subscriber data to submit canonical lead submissions through Moosewave while new subscribers arrive through the route-token Webhook receiver; live Hello Bar certification must prove account setup, GET/POST/JSON delivery shape, Webhook cleanup, route-token rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderLandingi {
			resp.RequiredFields = []string{"id", "submissions|manual_landingi_export"}
			resp.Message = "Landingi historical backfill is manual-import only in this runtime slice. Use Landingi exports or prior lead data to submit canonical lead submissions through Moosewave while new leads arrive through the route-token Webhook receiver; live Landingi certification must prove account setup, GET/POST/JSON delivery shape, Webhook integration cleanup, route-token rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderKickoffLabs {
			resp.RequiredFields = []string{"id", "submissions|manual_kickofflabs_export"}
			resp.Message = "KickoffLabs historical backfill is manual-import only in this runtime slice. Use KickoffLabs exports or prior lead/referral/reward data to submit canonical lead submissions through Moosewave while new events arrive through the route-token outbound Webhook receiver; live KickoffLabs certification must prove account setup, GET/POST/JSON delivery shape, outbound Webhook cleanup, route-token rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderNinjaForms {
			resp.RequiredFields = []string{"id", "submissions|manual_ninja_forms_export"}
			resp.Message = "Ninja Forms historical backfill is manual-import only in this runtime slice. Use Ninja Forms exports or prior WordPress form submission data to submit canonical lead submissions through Moosewave while new submissions arrive through the route-token Webhooks add-on receiver; live Ninja Forms certification must prove WordPress setup, GET/POST/JSON/form delivery shape, Webhooks action cleanup, route-token rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderOutgrow {
			resp.RequiredFields = []string{"id", "submissions|manual_outgrow_export"}
			resp.Message = "Outgrow historical backfill is manual-import only in this runtime slice. Use Outgrow exports or prior lead/result data to submit canonical lead submissions through Moosewave while new leads arrive through the Basic-or-route-token Webhook receiver; live Outgrow certification must prove account setup, JSON/form delivery shape, Webhook cleanup, credential rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderShortStack {
			resp.RequiredFields = []string{"id", "submissions|manual_shortstack_export"}
			resp.Message = "ShortStack historical backfill is manual-import only in this runtime slice. Use ShortStack exports or prior entry data to submit canonical lead submissions through Moosewave while new entries arrive through the signed Webhook form integration receiver; live ShortStack certification must prove account setup, form/JSON delivery shape, X-SS-Signature verification, Webhook integration cleanup, secret rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderRiddle {
			resp.RequiredFields = []string{"id", "submissions|manual_riddle_export"}
			resp.Message = "Riddle historical backfill is manual-import only in this runtime slice. Use Riddle exports or prior lead/result data to submit canonical lead submissions through Moosewave while new leads arrive through the signature-or-route-token Webhook receiver; live Riddle certification must prove account setup, JSON delivery shape, signature or route-token verification, Webhook cleanup, credential rotation, reconnect, and data-delete behavior before full availability."
		} else if meta.Provider == leadintegrations.ProviderPaperform {
			resp.RequiredFields = []string{"id", "empty_paperform_provider_pull"}
			resp.Message = "Start a historical Paperform submissions backfill with /forms/{slug_or_id}/submissions skip/limit cursors, has_more continuation, data-key identity mapping, Retry-After-aware provider errors, paperform_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderFormstack {
			resp.RequiredFields = []string{"id", "empty_formstack_provider_pull"}
			resp.Message = "Start a historical Formstack submissions backfill with /api/v2025/forms/{formId}/submissions pageNumber/pageSize cursors, page.totalPages continuation, expanded legacy field mapping, Retry-After-aware provider errors, formstack_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderFormsite {
			resp.RequiredFields = []string{"id", "empty_formsite_provider_pull"}
			resp.Message = "Start a historical Formsite results backfill with /api/v2/{user_dir}/forms/{form_dir}/results page/limit cursors, Pagination-* continuation headers, item identity mapping, Retry-After-aware provider errors, formsite_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderCognitoForms {
			resp.RequiredFields = []string{"id", "empty_cognito_forms_provider_pull"}
			resp.Message = "Start a historical Cognito Forms entry backfill with /api/odata/Forms({form_id}) form metadata, /api/forms/{form_id}/schema field metadata, /api/odata/Forms({form_id})/Views({view_id})/Entries ID discovery, REST /api/forms/{form_id}/entries/{entry_id} hydration, local last_id cursors, Retry-After-aware provider errors, cognito_forms_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderGravityForms {
			resp.RequiredFields = []string{"id", "empty_gravity_forms_provider_pull"}
			resp.Message = "Start a historical Gravity Forms entries backfill with /wp-json/gf/v2/forms/{form_id}/entries _labels=1, paging[page_size]/paging[offset] cursors, sorting/status/search filters, field-label identity mapping, Retry-After-aware generic WordPress/provider errors, gravity_forms_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderWPForms {
			resp.RequiredFields = []string{"id", "empty_wpforms_provider_pull"}
			resp.Message = "Start a historical WPForms entries backfill with wpforms/get-form metadata hydration, wpforms/search-entries page/limit cursors, include_fields=true, optional status/type/search/date filters, field-label identity mapping, Retry-After-aware generic WordPress/provider errors, wpforms_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderFormidableForms {
			resp.RequiredFields = []string{"id", "empty_formidable_forms_provider_pull"}
			resp.Message = "Start a historical Formidable Forms entries backfill with /wp-json/frm/v2/forms/{form_id}, /fields, and /entries page/page_size cursors, optional search/sort filters, field-label identity mapping, Retry-After-aware generic WordPress/provider errors, formidable_forms_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderFeathery {
			resp.RequiredFields = []string{"id", "empty_feathery_provider_pull"}
			resp.Message = "Start a historical Feathery submissions backfill with /api/form/submission/ form_id pulls, page_size and next URL cursors, timestamp watermarks, field-value identity mapping, Retry-After-aware provider errors, feathery_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderFormaloo {
			resp.RequiredFields = []string{"id", "empty_formaloo_provider_pull"}
			resp.Message = "Start a historical Formaloo rows backfill with /v3.0/forms/{slug}/rows/ page/page_size or next URL cursors, row slug/date watermarks, optional workspace headers and timestamp/search/tag filters, row-data identity mapping, Retry-After-aware provider errors, formaloo_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderGoogleForms {
			resp.RequiredFields = []string{"id", "empty_google_forms_provider_pull"}
			resp.Message = "Start a historical Google Forms response backfill with /v1/forms/{formId} metadata hydration, /v1/forms/{formId}/responses pageToken cursors, timestamp watermarks, question-label identity mapping, Retry-After-aware provider errors, google_forms_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderTally {
			resp.RequiredFields = []string{"id", "empty_tally_provider_pull"}
			resp.Message = "Start a historical Tally submissions backfill with /forms/{formId}/submissions page/limit cursors, hasMore continuation, field identity mapping, Retry-After-aware provider errors, tally_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderJotform {
			resp.RequiredFields = []string{"id", "empty_jotform_provider_pull"}
			resp.Message = "Start a historical Jotform submissions backfill with form/question metadata, offset/limit cursors, regional API hosts, jotform_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderWebflow {
			resp.RequiredFields = []string{"id", "empty_webflow_provider_pull"}
			resp.Message = "Start a historical Webflow submissions backfill with site/form-scoped endpoint selection, elementId filters, limit/offset cursors, pagination totals, webflow_retry cursors, scheduled continuation, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderWix {
			resp.Message = "Start a historical Wix Forms and Contacts backfill with cursor checkpoints, retry cursors, signed webhook evidence, and live-certification status available in health views."
		} else if meta.Provider == leadintegrations.ProviderFacebookLeadAds {
			resp.RequiredFields = []string{"id", "empty_facebook_lead_ads_provider_pull"}
			resp.Message = "Start a Facebook Lead Ads historical REST backfill with /{form_id}/leads after-cursor checkpoints, page-size caps, credential-reference Bearer auth, field_data-to-submission mapping, ad attribution evidence, Retry-After-aware provider errors, scheduled facebook_lead_ads_retry continuation, and lead sync history. Managed Page leadgen subscription reconciliation, signed leadgen webhook ingest, and /{leadgen_id} follow-up fetches are wired; Meta lead retention limits, ownership certification, and live app-review evidence remain required before full availability."
		} else if meta.Provider == leadintegrations.ProviderGoogleLeadForms {
			resp.RequiredFields = []string{"id", "empty_google_lead_forms_provider_pull"}
			resp.Message = "Start a Google Lead Form Extensions historical Google Ads API backfill with /customers/{customer_id}/googleAds:search, GAQL LIMIT 1000 batches, submission_date_time/id watermark checkpoints, OAuth/developer-token credential refs, standard and custom lead-form field mapping, Retry-After-aware provider errors, scheduled google_lead_forms_retry continuation, and lead sync history. Google Ads API lead export is limited to recent lead form data, documented up to 60 days; live Google Ads certification remains required before full availability."
		} else if isPostwaveIngestSyncModel(meta.SyncModel) {
			resp.Message = "Import historical canonical " + meta.Name + " rows; provider-side backfill workers are not implied by this action."
		} else {
			resp.Message = "Start a historical " + meta.Surface + " backfill for " + joinedOrDefault(meta.SyncObjects, "provider objects") + "."
		}
	case "pause":
		resp.RequiredFields = []string{"id"}
		resp.Message = "Pause the managed " + meta.Surface + " connection without deleting credentials or audit history."
	case "disconnect":
		resp.RequiredFields = []string{"id"}
		if meta.Provider == crmintegrations.ProviderHubSpot {
			resp.Message = "Disconnect the managed HubSpot CRM connection in Moosewave, revoke managed OAuth refresh tokens when present, and delete local managed OAuth credential envelopes. Private app token revocation, duplicate/manual webhook cleanup, app uninstall review, and provider-console list/deal settings may still require HubSpot-side action until live certification lands."
		} else if meta.Provider == crmintegrations.ProviderSalesforce {
			resp.Message = "Disconnect the managed Salesforce CRM connection in Moosewave, revoke managed OAuth refresh tokens when present, and delete local managed OAuth credential envelopes. Connected App policy changes, duplicate/manual credential cleanup, and provider-side data-delete evidence remain Salesforce-side actions for live certification."
		} else if meta.Provider == crmintegrations.ProviderPipedrive {
			resp.Message = "Disconnect the managed Pipedrive CRM connection in Moosewave by marking the row disconnected, preserving run/webhook audit history, cleaning up stored Moosewave-owned webhook registrations when available, revoking managed OAuth refresh tokens through Pipedrive /oauth/revoke, and deleting local managed OAuth credential envelopes before finalizing the disconnected row. API-token revocation and duplicate/manual webhook cleanup may still require Pipedrive admin action until live certification lands."
		} else if meta.Provider == crmintegrations.ProviderZohoCRM {
			resp.Message = "Disconnect the managed Zoho CRM connection in Moosewave. Moosewave revokes managed Zoho refresh tokens when present, deletes local managed OAuth credential envelopes, and persists provider_cleanup evidence; connected-app cleanup, Notification API channel deletion, and provider-side workflow/Deals settings remain Zoho-side certification/operator actions."
		} else if meta.Provider == crmintegrations.ProviderDynamics365 {
			resp.Message = "Disconnect the managed Microsoft Dynamics 365 connection in Moosewave. Moosewave deletes local managed OAuth credential envelopes and persists provider_cleanup evidence; Microsoft Entra token/app cleanup, Dataverse change tracking/webhook cleanup, and provider-side workflow/solution settings remain Microsoft-side certification/operator actions because this connector has no provider revocation endpoint."
		} else if meta.Provider == crmintegrations.ProviderKeap {
			resp.Message = "Disconnect the managed Keap connection in Moosewave. Moosewave deletes local managed OAuth/PAT/SAK credential envelopes and persists provider_cleanup evidence; Keap token/app cleanup, webhook cleanup, and provider-side campaign/order settings remain Keap-side certification/operator actions because this connector has no provider revocation endpoint."
		} else if meta.Provider == subscriptionintegrations.ProviderRecharge {
			resp.Message = "Disconnect the managed Recharge connection in Moosewave. The subscription disconnect response returns provider_cleanup readiness evidence and stores the same operator-action checklist in integration settings, showing the local row is disconnected, scheduled Recharge pulls stop, and tokenized subscription webhook ingest no longer resolves the row. POST /api/v1/subscription-integrations/{id}/provider-cleanup/acknowledge records local operator attestation after the checklist is completed. Recharge API-token revocation, provider-console webhook cleanup, and duplicate/manual webhook audit remain operator-managed provider-console actions until managed cleanup automation and live merchant certification land."
		} else if isManagedSubscriptionPullerProvider(meta.Provider) {
			resp.Message = "Disconnect the managed " + meta.Name + " connection in Moosewave. The subscription disconnect response returns provider_cleanup readiness evidence and stores the same operator-action checklist in integration settings, showing the local row is disconnected, scheduled " + meta.Name + " provider pulls stop, and local sync/audit evidence is preserved. POST /api/v1/subscription-integrations/{id}/provider-cleanup/acknowledge records local operator attestation after the checklist is completed. Provider credential revocation, provider-console webhook/callback cleanup, duplicate/manual target audit, and live " + meta.Name + " certification remain operator-managed provider-console actions until managed cleanup automation is certified."
		} else if isManagedAnalyticsPullerProvider(meta.Provider) {
			resp.Message = "Disconnect the managed " + meta.Name + " analytics connection in Moosewave. The analytics disconnect response returns provider_cleanup readiness evidence and stores the same operator-action checklist in integration settings, showing the local row is disconnected, scheduled " + meta.Name + " profile pulls stop, manual sync/backfill rejects disconnected rows, and local sync/audit evidence is preserved. POST /api/v1/analytics-integrations/{id}/provider-cleanup/acknowledge records local operator attestation after the checklist is completed. Provider credential revocation, provider-console project/cohort/export cleanup, duplicate/manual target audit, and live " + meta.Name + " certification remain operator-managed provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == reviewintegrations.ProviderYotpo {
			resp.Message = "Disconnect the managed Yotpo review connection in Moosewave. The review disconnect response returns provider_cleanup readiness evidence and stores the same operator-action checklist in integration settings, showing the local row is disconnected, scheduled Yotpo pulls stop, and tokenized review webhook ingest no longer resolves the row. POST /api/v1/review-integrations/{id}/provider-cleanup/acknowledge records local operator attestation after the checklist is completed. Yotpo app secret rotation, API credential revocation, provider-console webhook target cleanup, duplicate/manual webhook audit, and tokenized ingest URL removal from Yotpo remain operator-managed provider-console actions until managed cleanup automation and live brand certification land."
		} else if meta.Provider == loyaltyintegrations.ProviderSmile {
			resp.Message = "Disconnect the managed Smile.io loyalty connection in Moosewave. The loyalty disconnect response returns provider_cleanup evidence and stores the same operator-action checklist in integration settings, showing the local row is disconnected, scheduled Smile pulls stop, and account_id-routed Smile app webhooks no longer resolve the row. The Smile-only disconnected-row acknowledgment endpoint records local operator attestation after the checklist is completed; Smile-side API-token revocation, app-webhook target cleanup, secret rotation, and duplicate/manual webhook audit remain operator-managed provider-console actions until managed cleanup automation and live store certification land."
		} else if meta.Provider == supportintegrations.ProviderZendesk {
			resp.Message = "Disconnect the managed Zendesk support connection in Moosewave. The support disconnect response returns provider_cleanup evidence and stores the same checklist in integration settings, showing the local row is disconnected, scheduled Zendesk pulls stop, signed Zendesk callbacks no longer resolve the row, and the stored zendesk_webhook_id was deleted, already absent, skipped, or failed with non-secret provider evidence. Zendesk OAuth/API-token revocation, trigger cleanup, and duplicate/manual webhook audit remain operator-managed provider-console actions until live workspace certification lands."
		} else if meta.Provider == supportintegrations.ProviderIntercom {
			resp.Message = "Disconnect the managed Intercom support connection in Moosewave. The support disconnect response returns provider_cleanup readiness evidence and stores the same operator-action checklist in integration settings, showing the local row is disconnected, scheduled Intercom pulls stop, and signed Intercom app webhooks no longer resolve the row. Intercom OAuth-token revocation, app uninstall cleanup, webhook deletion, and duplicate/manual webhook audit remain operator-managed provider-console actions until managed cleanup automation and live workspace certification land."
		} else if meta.Provider == supportintegrations.ProviderHelpScout {
			resp.Message = "Disconnect the managed Help Scout support connection in Moosewave. The support disconnect response returns provider_cleanup readiness evidence and stores the same operator-action checklist in integration settings, showing the local row is disconnected, scheduled Help Scout pulls stop, and signed Help Scout app webhooks no longer resolve the row. Help Scout OAuth app credential rotation, webhook deletion, and duplicate/manual webhook audit remain operator-managed provider-console actions until managed cleanup automation and live mailbox certification land."
		} else if meta.Provider == supportintegrations.ProviderFreshdesk {
			resp.Message = "Disconnect the managed Freshdesk support connection in Moosewave. The support disconnect response returns provider_cleanup readiness evidence and stores the same operator-action checklist in integration settings, showing the local row is disconnected, scheduled Freshdesk pulls stop, and authenticated automation webhooks no longer resolve the row. Freshdesk API-key rotation, automation webhook deletion, and duplicate/manual webhook audit remain operator-managed provider-console actions until managed cleanup automation and live helpdesk certification land."
		} else if meta.Provider == supportintegrations.ProviderGorgias {
			resp.Message = "Disconnect the managed Gorgias support connection in Moosewave. The support disconnect response returns provider_cleanup evidence and stores the same checklist in integration settings, showing the local row is disconnected, scheduled Gorgias pulls stop, authenticated callbacks no longer resolve the row, and the stored gorgias_http_integration_id was deleted, already absent, skipped, or failed with non-secret provider evidence. Gorgias API-key revocation, rule references, integration app cleanup, and duplicate/manual HTTP integration audit remain operator-managed provider-console actions until live cleanup certification lands."
		} else if meta.Provider == warehouse.ProviderSnowflake {
			resp.Message = "Disconnect the managed Snowflake warehouse connection in Moosewave by marking the row disconnected, excluding it from ordinary lists and scheduled/manual runs, blocking import-mapping and reverse-ETL mutations, preserving run/mapping/audit history, keeping health disconnected even when older runs failed, persisting config.provider_cleanup readiness evidence, and exposing provider-cleanup/acknowledge for local operator attestation. Snowflake user, role, grant, stage, task, stream, warehouse, and key/OAuth/PAT cleanup remain Snowflake-account actions until provider-driver cleanup is certified."
		} else if meta.Provider == leadintegrations.ProviderTypeform {
			resp.Message = "Disconnect the managed Typeform lead connection in Moosewave after deleting or verifying absence of the stored Moosewave-owned /forms/{form_id}/webhooks/{tag} registration when available. The lead disconnect response returns provider_cleanup evidence and stores the same scoped evidence in integration settings. Typeform personal-token or externally managed OAuth access-token revocation and duplicate/manual webhook cleanup may still require dashboard action until live certification."
		} else if meta.Provider == leadintegrations.ProviderFillout {
			resp.Message = "Disconnect the managed Fillout lead connection in Moosewave after deleting the stored Moosewave-owned /webhook/delete registration when available. The lead disconnect response returns provider_cleanup evidence and stores the same scoped evidence in integration settings. Fillout API-key revocation and duplicate/manual webhook cleanup may still require dashboard action until live certification."
		} else if meta.Provider == leadintegrations.ProviderSurveyMonkey {
			resp.Message = "Disconnect the managed SurveyMonkey lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled SurveyMonkey pulls stop and local sync/audit evidence is preserved. SurveyMonkey OAuth token rotation/revocation, survey/collector/app access review, duplicate/manual webhook or export cleanup, reconnect proof, data-delete proof, and live SurveyMonkey certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderUnbounce {
			resp.Message = "Disconnect the managed Unbounce lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled Unbounce pulls stop and local sync/audit evidence is preserved. Unbounce OAuth/API-key rotation or revocation, page/app access review, duplicate/manual webhook or export cleanup, reconnect proof, data-delete proof, and live Unbounce certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderLeadpages {
			resp.Message = "Disconnect the managed Leadpages lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled Leadpages pulls stop and local sync/audit evidence is preserved. Leadpages API-key/OAuth token rotation or revocation, page/form access review, duplicate/manual dashboard webhook, export, or integration cleanup, reconnect proof, data-delete proof, and live Leadpages certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.Provider123FormBuilder {
			resp.Message = "Disconnect the managed 123FormBuilder lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled 123FormBuilder pulls stop and local sync/audit evidence is preserved. 123FormBuilder JWT/login credential rotation, form access review, duplicate/manual webhook, export, or integration cleanup, reconnect proof, data-delete proof, and live 123FormBuilder certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderInstapage {
			resp.Message = "Disconnect the managed Instapage lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled Instapage pulls stop and local sync/audit evidence is preserved. Instapage personal API token rotation or revocation, workspace/page access review, duplicate/manual webhook or export cleanup, reconnect proof, data-delete proof, and live Instapage certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderCarrd {
			resp.Message = "Disconnect the managed Carrd lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, Carrd Custom URL deliveries fail closed before writes, and webhook/run audit evidence is preserved. Carrd Custom URL destination removal, route-token rotation, duplicate/manual destination audit, reconnect proof, data-delete proof, and live Carrd certification remain provider-console/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderOptinMonster {
			resp.Message = "Disconnect the managed OptinMonster lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, OptinMonster Webhook deliveries fail closed before writes, and webhook/run audit evidence is preserved. OptinMonster Webhook destination removal, route-token rotation, duplicate/manual destination audit, reconnect proof, data-delete proof, and live OptinMonster certification remain provider-console/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderPrivy {
			resp.Message = "Disconnect the managed Privy lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, Privy custom Webhook deliveries fail closed before writes, and webhook/run audit evidence is preserved. Privy custom Webhook destination removal, Basic auth rotation, duplicate/manual destination audit, reconnect proof, data-delete proof, and live Privy certification remain provider-console/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderConvertFlow {
			resp.Message = "Disconnect the managed ConvertFlow lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, ConvertFlow custom Webhook deliveries fail closed before writes, and webhook/run audit evidence is preserved. ConvertFlow webhook automation removal, route-token rotation, duplicate/manual automation audit, reconnect proof, data-delete proof, and live ConvertFlow certification remain provider-console/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderSleeknote {
			resp.Message = "Disconnect the managed Sleeknote lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, Sleeknote custom integration deliveries fail closed before writes, and webhook/run audit evidence is preserved. Sleeknote custom integration removal, route-token rotation, duplicate/manual integration audit, reconnect proof, data-delete proof, and live Sleeknote certification remain provider-console/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderWisepops {
			resp.Message = "Disconnect the managed Wisepops lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, Wisepops signed Webhook deliveries fail closed before writes, and webhook/run audit evidence is preserved. Wisepops hook removal, API-key rotation, duplicate/manual hook audit, reconnect proof, data-delete proof, and live Wisepops certification remain provider-console/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderPoptin {
			resp.Message = "Disconnect the managed Poptin lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, Poptin Webhooks deliveries fail closed before writes, and webhook/run audit evidence is preserved. Poptin Webhooks integration removal, route-token rotation, duplicate/manual integration audit, reconnect proof, data-delete proof, and live Poptin certification remain provider-console/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderHelloBar {
			resp.Message = "Disconnect the managed Hello Bar lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, Hello Bar Webhook deliveries fail closed before writes, and webhook/run audit evidence is preserved. Hello Bar Webhook removal, route-token rotation, duplicate/manual webhook audit, reconnect proof, data-delete proof, and live Hello Bar certification remain provider-console/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderLandingi {
			resp.Message = "Disconnect the managed Landingi lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, Landingi Webhook deliveries fail closed before writes, and webhook/run audit evidence is preserved. Landingi Webhook integration removal, route-token rotation, duplicate/manual webhook audit, reconnect proof, data-delete proof, and live Landingi certification remain provider-console/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderKickoffLabs {
			resp.Message = "Disconnect the managed KickoffLabs lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, KickoffLabs outbound Webhook deliveries fail closed before writes, and webhook/run audit evidence is preserved. KickoffLabs outbound Webhook removal, route-token rotation, duplicate/manual webhook audit, reconnect proof, data-delete proof, and live KickoffLabs certification remain provider-console/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderNinjaForms {
			resp.Message = "Disconnect the managed Ninja Forms lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, Ninja Forms Webhooks action deliveries fail closed before writes, and webhook/run audit evidence is preserved. Ninja Forms Webhooks action removal, route-token rotation, duplicate/manual action audit, reconnect proof, data-delete proof, and live WordPress/Ninja Forms certification remain WordPress admin/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderOutgrow {
			resp.Message = "Disconnect the managed Outgrow lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, Outgrow Webhook deliveries fail closed before writes, and webhook/run audit evidence is preserved. Outgrow Webhook removal, route-token or Basic-auth credential rotation, duplicate/manual webhook audit, reconnect proof, data-delete proof, and live Outgrow certification remain provider-console/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderShortStack {
			resp.Message = "Disconnect the managed ShortStack lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, ShortStack Webhook form integration deliveries fail closed before writes, and webhook/run audit evidence is preserved. ShortStack Webhook form integration removal, secret rotation, duplicate/manual form integration audit, reconnect proof, data-delete proof, and live ShortStack certification remain provider-console/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderRiddle {
			resp.Message = "Disconnect the managed Riddle lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing the local row is disconnected, Riddle Webhook deliveries fail closed before writes, and webhook/run audit evidence is preserved. Riddle Webhook cleanup, signature-key or route-token rotation, duplicate/manual webhook audit, reconnect proof, data-delete proof, and live Riddle certification remain provider-console/operator actions until certified."
		} else if meta.Provider == leadintegrations.ProviderPaperform {
			resp.Message = "Disconnect the managed Paperform lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled Paperform pulls stop and local sync/audit evidence is preserved. Paperform API-key rotation, form access review, duplicate/manual webhook or export cleanup, reconnect proof, data-delete proof, and live Paperform certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderFormstack {
			resp.Message = "Disconnect the managed Formstack lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled Formstack pulls stop and local sync/audit evidence is preserved. Formstack PAT rotation, form access review, duplicate/manual webhook or export cleanup, reconnect proof, encrypted-form password cleanup, data-delete proof, and live Formstack certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderFormsite {
			resp.Message = "Disconnect the managed Formsite lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled Formsite pulls stop and local sync/audit evidence is preserved. Formsite access-token rotation, form access review, duplicate/manual webhook, server post, or export cleanup, reconnect proof, data-delete proof, Professional-plan access, and live Formsite certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderCognitoForms {
			resp.Message = "Disconnect the managed Cognito Forms lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled Cognito Forms pulls stop and local sync/audit evidence is preserved. Cognito Forms API-key rotation, Form:Read/Entry:Read scope review, selected grid-view field review, duplicate/manual OData consumer, webhook, export, or automation cleanup, reconnect proof, data-delete proof, and live Cognito Forms certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderGravityForms {
			resp.Message = "Disconnect the managed Gravity Forms lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled Gravity Forms pulls stop and local sync/audit evidence is preserved. WordPress Application Password or Gravity Forms REST credential rotation/revocation, REST API enablement review, duplicate/manual webhook, feed, notification, or export cleanup, reconnect proof, data-delete proof, and live WordPress/Gravity Forms certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderWPForms {
			resp.Message = "Disconnect the managed WPForms lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled WPForms pulls stop and local sync/audit evidence is preserved. WordPress Application Password rotation/revocation, WordPress 6.9+/WPForms Pro access review, duplicate/manual webhook, feed, notification, or export cleanup, reconnect proof, data-delete proof, and live WordPress/WPForms certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderFeathery {
			resp.Message = "Disconnect the managed Feathery lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled Feathery pulls stop and local sync/audit evidence is preserved. Feathery API-key rotation, form/workspace access review, duplicate/manual webhook or export cleanup, reconnect proof, data-delete proof, and live Feathery certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderFormaloo {
			resp.Message = "Disconnect the managed Formaloo lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled Formaloo pulls stop and local sync/audit evidence is preserved. Formaloo API-key/API-secret/token rotation, workspace/form access review, duplicate/manual webhook or export cleanup, reconnect proof, data-delete proof, and live Formaloo certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderGoogleForms {
			resp.Message = "Disconnect the managed Google Forms lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled Google Forms pulls stop and local sync/audit evidence is preserved. Google OAuth token rotation/revocation, Forms and Drive sharing review, duplicate/manual Pub/Sub watch, Apps Script trigger, linked Sheet, or webhook bridge cleanup, reconnect proof, data-delete proof, and live Google Workspace certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderTally {
			resp.Message = "Disconnect the managed Tally lead connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings, showing scheduled Tally pulls stop and local sync/audit evidence is preserved. Tally API-token rotation, form access review, duplicate/manual webhook or export cleanup, reconnect proof, data-delete proof, and live Tally certification remain provider-console actions until managed cleanup automation is certified."
		} else if meta.Provider == leadintegrations.ProviderJotform {
			resp.Message = "Disconnect the managed Jotform lead connection in Moosewave after deleting or verifying absence of the stored Moosewave-owned /form/{formID}/webhooks/{webhookID} registration when available. The lead disconnect response returns provider_cleanup evidence and stores the same scoped evidence in integration settings. Jotform API-key revocation and duplicate/manual webhook cleanup may still require dashboard action until live certification."
		} else if meta.Provider == leadintegrations.ProviderWebflow {
			resp.Message = "Disconnect the managed Webflow lead connection in Moosewave after deleting the stored Moosewave-owned /v2/webhooks/{webhook_id} registration, or listing site webhooks to delete the exact Moosewave endpoint/filter match when the stored ID is missing or stale. The lead disconnect response returns provider_cleanup evidence and stores the same scoped evidence in integration settings. Webflow OAuth/app token revocation, duplicate/manual webhook cleanup, and signing-secret rotation may still require dashboard action until live certification."
		} else if meta.Provider == leadintegrations.ProviderWix {
			resp.Message = "Disconnect the managed Wix lead connection in Moosewave. Wix app/dashboard webhook subscriptions and app uninstall remain provider-console actions."
		} else if meta.Provider == leadintegrations.ProviderFacebookLeadAds {
			resp.Message = "Disconnect the managed Facebook Lead Ads connection in Moosewave after deleting the stored Moosewave-owned Page leadgen app subscription when available. The lead disconnect response returns provider_cleanup evidence and stores the same scoped evidence in integration settings. Meta OAuth token revocation, Page/app permission cleanup, duplicate/manual CRM integration audit, and app-review/provider-console evidence remain Meta-side actions until live certification."
		} else if meta.Provider == leadintegrations.ProviderGoogleLeadForms {
			resp.Message = "Disconnect the managed Google Lead Form Extensions connection in Moosewave. The lead disconnect response returns provider_cleanup evidence and stores the same operator-managed checklist in integration settings. Google Ads OAuth token revocation, developer-token rotation, lead form asset permissions, duplicate/manual CRM export cleanup, and data-delete evidence remain Google Ads-side actions until live certification."
		} else if isPostwaveIngestSyncModel(meta.SyncModel) {
			resp.Message = "Disconnect the managed " + meta.Surface + " connection in Moosewave. Provider-side apps, API keys, OAuth installs, webhooks, or tokens may still need provider-console cleanup."
		} else {
			resp.Message = "Disconnect the managed " + meta.Surface + " connection; provider-side credential revocation depends on the owning surface."
		}
	}
	return resp
}

func decorateCommerceLifecycleResponse(resp actionResponse, meta managedProviderMetadata, action string) actionResponse {
	switch action {
	case "connect/start", "connect/callback":
		resp.RequiredFields = providerFieldKeys(meta.RequiredFields)
		if meta.Provider == commerce.ProviderShopify {
			resp.Message = "Start Shopify OAuth through the commerce OAuth endpoint; Moosewave owns signed state, webhook subscription reconciliation, mandatory privacy webhook handling, encrypted install-secret storage, raw-body webhook verification, dedupe, canonical ingest, scheduled Admin GraphQL backfill, cart recovery, and discount-code capture."
			return resp
		}
		if meta.Provider == commerce.ProviderWixStores {
			resp.Message = "Create or update the managed Wix Stores connection using site_id, instance_id, store_id, credential_ref, and webhook_public_key_ref. Moosewave owns app-instance token minting, signed JWT app webhook ingest, REST backfill, lifecycle recovery, retry cursors, delete evidence, and provider-event evidence; the local runtime is complete pending live Wix certification."
			return resp
		}
		if meta.Provider == commerce.ProviderWooCommerce {
			resp.Message = "Create or update the managed WooCommerce connection using store_url, credential_ref, and optional subscriptions_enabled. Moosewave owns consumer-key/secret credential refs, /wp-json/wc/v3 REST backfill, managed webhook reconciliation, X-WC-Webhook-Signature verification, manual/scheduled retry cursors, scheduled continuation, delete/coupon/refund evidence, optional Subscriptions extension evidence, and returned/persisted Moosewave-owned webhook cleanup evidence; live store certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderBigCommerce {
			resp.Message = "Create or update the managed BigCommerce connection using store_hash, credential_ref, optional channel_id, and webhook_auth_ref. Moosewave owns X-Auth-Token credential refs, fixed Admin REST routing, V3 Customers/Catalog Products, V2 Orders, managed /v3/hooks, X-Postwave-Webhook-Secret callback verification, retry cursors, scheduled continuation, delete/archive routing, and refund/transaction evidence; live store certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderAdobeCommerce {
			resp.Message = "Create or update the managed Adobe Commerce connection using base_url, credential_ref, optional store_view_code, deployment_mode, api_base_url, website_id, and event_auth_ref. Moosewave owns bearer-token credential refs, PaaS/on-prem /rest/V1 and SaaS Store-header REST backfill, merchant-configured webhook verification, retry cursors, scheduled continuation, and refund evidence; live Magento/Adobe certification and managed webhook provisioning remain required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderSquarespace {
			resp.Message = "Create or update the managed Squarespace Commerce connection using site_id, credential_ref, optional webhook_secret_ref, and User-Agent. Moosewave owns credential-reference auth, Contacts/Products/Orders REST backfill, product detail enrichment, signed webhook ingest, retry cursors, and scheduled continuation; OAuth-only webhook subscription creation still needs live certification."
			return resp
		}
		if meta.Provider == commerce.ProviderStripe {
			resp.Message = "Create or update the managed Stripe connection using account_id, credential_ref, and optional webhook_secret_ref. Moosewave owns restricted-key auth, REST backfill, charge/payment-method/dispute/credit-note evidence, invoice line-item pagination, signed webhook ingest, retry cursors, scheduled continuation, and customer delete evidence; live account certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderSquare {
			resp.Message = "Create or update the managed Square connection using merchant_id, credential_ref, optional location selectors, webhook_notification_url, and webhook_signature_ref. Moosewave owns OAuth/app-token auth, REST backfill for customers/catalog products/deletions/orders/payments/refunds, active-location discovery, exact-notification-URL webhook verification, catalog.version.updated product refresh, retry cursors, scheduled continuation, and customer/product delete evidence; live merchant certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderPayPal {
			resp.Message = "Create or update the managed PayPal connection using merchant_id, credential_ref, optional environment, webhook_id, RFC3339 backfill bounds, and reporting window size. Moosewave owns client-credential OAuth token exchange, Transaction Search backfill, PayPal Verify Webhook Signature API validation, sparse webhook resource hydration for allowlisted Orders, Captures, Refunds, Subscriptions, and Invoices REST resources, retry cursors, scheduled continuation, customer/order/refund mapping, and subscription/invoice provider-event evidence; live merchant certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderRazorpay {
			resp.Message = "Create or update the managed Razorpay connection using account_id, credential_ref, optional webhook_secret_ref, settlement currency, and UNIX timestamp backfill bounds. Moosewave owns Basic Auth credential refs, REST backfill for customers/orders/payments/refunds, X-Razorpay-Signature verification, x-razorpay-event-id idempotency, retry cursors, scheduled continuation, and refund evidence; live account certification remains required before full availability."
			return resp
		}
		resp.Message = "Create or update the managed Commerce integrations foundation using credential references only. Raw credentials are rejected, and this does not imply provider historical pullers or callback registration."
	case "sync":
		resp.RequiredFields = []string{"id", "customers|products|orders|empty_shopify_provider_pull"}
		if meta.Provider == commerce.ProviderShopify {
			resp.Message = "Shopify sync accepts canonical rows, an empty request for a one-page Admin GraphQL provider pull using the saved OAuth token, or mode=bulk_async for Admin GraphQL Bulk Operation launch/poll/import using shopify_bulk: retry and line-offset cursors; live provider certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderWixStores {
			resp.RequiredFields = []string{"id", "customers|products|orders|empty_wix_provider_pull"}
			resp.Message = "Wix Stores sync accepts canonical rows or an empty request for the next app-instance REST provider pull across Contacts, Catalog V1/V3 products, and eCommerce orders; signed webhook/delete evidence is available, and live Wix certification remains the only full-availability gate."
			return resp
		}
		if meta.Provider == commerce.ProviderWooCommerce {
			resp.RequiredFields = []string{"id", "customers|products|orders|refunds|subscriptions|empty_woocommerce_provider_pull"}
			resp.Message = "WooCommerce sync accepts canonical rows or an empty request for the next REST provider pull across Customers, Products with variation enrichment, Orders with coupon/refund attribution, read-only Refunds, and optional Subscriptions extension snapshots; manual pulls honor woocommerce_retry cursors before calling the provider; live WooCommerce store certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderBigCommerce {
			resp.RequiredFields = []string{"id", "customers|products|orders|empty_bigcommerce_provider_pull"}
			resp.Message = "BigCommerce sync accepts canonical rows or an empty request for the next REST provider pull across V3 Customers, Catalog Products/images/variants, and V2 Orders enriched with order products/coupons; live BigCommerce store certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderAdobeCommerce {
			resp.RequiredFields = []string{"id", "customers|products|orders|refunds|empty_adobe_commerce_provider_pull"}
			resp.Message = "Adobe Commerce sync accepts canonical rows or an empty request for the next REST provider pull across Customers, Products, Orders, and Credit Memos using bearer auth, searchCriteria currentPage/pageSize pagination, PaaS /rest/V1 or SaaS Store-header routing, and ascending entity sorting; live Magento/Adobe certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderSquarespace {
			resp.RequiredFields = []string{"id", "customers|products|orders|empty_squarespace_provider_pull"}
			resp.Message = "Squarespace Commerce sync accepts canonical rows or an empty request for the next REST provider pull across Contacts, product-list pages plus product-detail enrichment, and Orders; live Squarespace certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderStripe {
			resp.RequiredFields = []string{"id", "customers|products|orders|empty_stripe_provider_pull"}
			resp.Message = "Stripe sync accepts canonical rows or an empty request for the next REST provider pull across Customers, Checkout Sessions, PaymentIntents, Charges with payment-method evidence, Disputes, invoices with full line-item pagination, Credit Notes, subscriptions, and refunds; live Stripe certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderSquare {
			resp.RequiredFields = []string{"id", "customers|products|orders|empty_square_provider_pull"}
			resp.Message = "Square sync accepts canonical rows or an empty request for the next REST provider pull across Customers, Catalog ITEM products/variations/deletions, Orders, Payments, and Refunds; signed catalog.version.updated webhooks trigger a bounded catalog-products refresh; live Square merchant certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderPayPal {
			resp.RequiredFields = []string{"id", "customers|orders|refunds|empty_paypal_provider_pull"}
			resp.Message = "PayPal sync accepts canonical rows or an empty request for the next Transaction Search REST provider pull across customer, order, and refund evidence using OAuth Bearer tokens, fields=all, page/page_size pagination, and 31-day reporting windows; verified webhooks can hydrate sparse allowlisted PayPal resources before dispatch; live PayPal merchant certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderRazorpay {
			resp.RequiredFields = []string{"id", "customers|orders|payments|refunds|empty_razorpay_provider_pull"}
			resp.Message = "Razorpay sync accepts canonical rows or an empty request for the next REST provider pull across Customers, Orders, Payments, and Refunds using Basic Auth, count/skip pagination, and optional UNIX timestamp filters; live Razorpay account certification remains required before full availability."
			return resp
		}
		resp.RequiredFields = []string{"id", "customers|products|orders"}
		resp.Message = "Import canonical customers, products, or orders through the commerce sync endpoint. This provider offers canonical-row import only: empty provider-pull requests and provider callback registration are outside its advertised capabilities."
	case "backfill":
		resp.RequiredFields = []string{"id", "customers|products|orders|empty_shopify_provider_pull"}
		if meta.Provider == commerce.ProviderShopify {
			resp.Message = "Shopify backfill can pull one Admin GraphQL page by default, run bounded multi-page pulls with /backfill?mode=bulk, launch/poll/import Admin GraphQL Bulk Operations with mode=bulk_async, process bulk_operations/finish imports, and continue cursor or shopify_bulk: retry work through the scheduled background worker; live provider certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderWixStores {
			resp.RequiredFields = []string{"id", "empty_wix_provider_pull"}
			resp.Message = "Wix Stores backfill pulls bounded REST pages with cursor checkpoints, Catalog V1/V3 routing, Retry-After aware retry cursors, and scheduled-worker continuation; the local runtime is complete pending live Wix certification."
			return resp
		}
		if meta.Provider == commerce.ProviderWooCommerce {
			resp.RequiredFields = []string{"id", "empty_woocommerce_provider_pull"}
			resp.Message = "WooCommerce backfill pulls bounded REST pages with Customers, Products, Orders, Refunds, optional Subscriptions, product-variation pagination, per_page/page checkpoints, X-WP-TotalPages pagination, manual/scheduled Retry-After aware retry cursors, and scheduled-worker continuation; live WooCommerce store certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderBigCommerce {
			resp.RequiredFields = []string{"id", "empty_bigcommerce_provider_pull"}
			resp.Message = "BigCommerce backfill pulls bounded REST pages with V3 Customers, Catalog Products/images/variants, and V2 Orders enriched with order products/coupons, page/limit checkpoints, X-Rate-Limit-Time-Reset-Ms / Retry-After aware retry cursors, and scheduled-worker continuation; live BigCommerce store certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderAdobeCommerce {
			resp.RequiredFields = []string{"id", "empty_adobe_commerce_provider_pull"}
			resp.Message = "Adobe Commerce backfill pulls bounded REST pages with Customers, Products, Orders, and Credit Memo checkpoints, searchCriteria currentPage/pageSize pagination, PaaS/SaaS routing, Retry-After aware retry cursors, and scheduled-worker continuation; live Magento/Adobe certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderSquarespace {
			resp.RequiredFields = []string{"id", "empty_squarespace_provider_pull"}
			resp.Message = "Squarespace Commerce backfill pulls bounded REST pages with Contacts/Products/Orders cursor checkpoints, product detail enrichment, Retry-After aware retry cursors, and scheduled-worker continuation; live Squarespace certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderStripe {
			resp.RequiredFields = []string{"id", "empty_stripe_provider_pull"}
			resp.Message = "Stripe backfill pulls bounded REST pages with object checkpoints, charge/payment-method evidence, dispute evidence, credit-note evidence, full invoice line-item pagination, Retry-After aware retry cursors, and scheduled-worker continuation; live Stripe certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderSquare {
			resp.RequiredFields = []string{"id", "empty_square_provider_pull"}
			resp.Message = "Square backfill pulls bounded REST pages with Customers, Catalog ITEM products/variations/deletions, Orders, Payments, and Refunds checkpoints, active-location discovery, catalog-version refresh reuse, manual/scheduled Retry-After aware retry cursors, and scheduled-worker continuation; live Square merchant certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderPayPal {
			resp.RequiredFields = []string{"id", "empty_paypal_provider_pull"}
			resp.Message = "PayPal backfill pulls bounded Transaction Search pages with RFC3339 start/end checkpoints, 31-day reporting windows, page/page_size pagination, Retry-After aware retry cursors, and scheduled-worker continuation; live PayPal merchant certification remains required before full availability."
			return resp
		}
		if meta.Provider == commerce.ProviderRazorpay {
			resp.RequiredFields = []string{"id", "empty_razorpay_provider_pull"}
			resp.Message = "Razorpay backfill pulls bounded REST pages with Customers, Orders, Payments, and Refunds checkpoints, count/skip pagination, optional from/to timestamp filters, Retry-After aware retry cursors, and scheduled-worker continuation; live Razorpay account certification remains required before full availability."
			return resp
		}
		resp.RequiredFields = []string{"id", "customers|products|orders"}
		resp.Message = "Import historical canonical commerce rows. This provider offers caller-supplied row backfill only: empty provider-pull requests and managed historical workers are outside its advertised capabilities."
	case "pause":
		resp.RequiredFields = []string{"id"}
		resp.Message = "Pause the managed Commerce integrations connection in Moosewave without deleting credentials or audit history. Provider-side app, API-key, and webhook cleanup remains operator-managed."
	case "disconnect":
		resp.RequiredFields = []string{"id"}
		if meta.Provider == commerce.ProviderShopify {
			resp.Message = "Disconnect deletes Moosewave-owned Shopify webhook subscriptions and the local encrypted install token before removing the integration row; Shopify's current OAuth docs do not expose an explicit token-revocation endpoint, so merchant app uninstall/app-uninstalled is the provider-side invalidation path."
			return resp
		}
		if meta.Provider == commerce.ProviderWixStores {
			resp.Message = "Disconnect removes the Moosewave Wix Stores connection, stops sync, and preserves audit evidence. Wix app/dashboard webhook subscriptions and app uninstall remain provider-console actions because Wix self-managed webhooks are dashboard configured."
			return resp
		}
		if meta.Provider == commerce.ProviderWooCommerce {
			resp.Message = "Disconnect marks the Moosewave WooCommerce connection disconnected, stops sync, preserves audit evidence, returns/persists provider_cleanup evidence, and deletes only Moosewave-managed webhooks matching the stored endpoint/topics with force=true. WooCommerce REST API key revocation and legacy/manual webhooks may still require WordPress admin cleanup until live certification."
			return resp
		}
		if meta.Provider == commerce.ProviderBigCommerce {
			resp.Message = "Disconnect marks the Moosewave BigCommerce connection disconnected, stops sync, preserves audit evidence, returns/persists provider_cleanup evidence, and deletes only Moosewave-owned /v3/hooks matching the stored endpoint/scopes. BigCommerce API account token revocation and provider-side webhook audit may still require control panel cleanup until live certification."
			return resp
		}
		if meta.Provider == commerce.ProviderAdobeCommerce {
			resp.Message = "Disconnect removes the Moosewave Adobe Commerce connection, stops sync, and preserves audit evidence. Adobe/Magento access-token revocation, shared-secret rotation, and merchant-configured webhook definition cleanup remain Admin/module actions until managed webhook provisioning is certified."
			return resp
		}
		if meta.Provider == commerce.ProviderSquarespace {
			resp.Message = "Disconnect removes the Moosewave Squarespace Commerce connection, stops sync, and preserves audit evidence. OAuth-only Squarespace webhook subscriptions and API/OAuth credential revocation may still require provider-console cleanup until managed subscription deletion is certified."
			return resp
		}
		if meta.Provider == commerce.ProviderStripe {
			resp.Message = "Disconnect marks the Moosewave Stripe connection disconnected, stops sync, preserves audit evidence, and returns plus persists provider_cleanup readiness evidence. Stripe restricted-key revocation, webhook endpoint deletion, duplicate endpoint audit, and signing-secret rotation remain provider-dashboard actions until managed app/webhook provisioning is certified."
			return resp
		}
		if meta.Provider == commerce.ProviderSquare {
			resp.Message = "Disconnect marks the Moosewave Square connection disconnected, stops sync, preserves audit evidence, and returns plus persists provider_cleanup readiness evidence. Square OAuth revocation/app-token cleanup, webhook subscription deletion, duplicate notification URL audit, and signature-key rotation remain Square Developer Console actions until managed app provisioning is certified."
			return resp
		}
		if meta.Provider == commerce.ProviderPayPal {
			resp.Message = "Disconnect marks the Moosewave PayPal connection disconnected, stops sync, preserves audit evidence, and returns plus persists provider_cleanup readiness evidence. PayPal REST app credentials, webhook ID cleanup, and dashboard webhook subscription deletion remain provider-dashboard actions until managed app provisioning is certified."
			return resp
		}
		if meta.Provider == commerce.ProviderRazorpay {
			resp.Message = "Disconnect removes the Moosewave Razorpay connection, stops sync, and preserves audit evidence. Razorpay keys, webhook endpoint cleanup, and webhook signing-secret rotation remain provider-dashboard actions until managed app provisioning is certified."
			return resp
		}
		resp.Message = "Disconnect the managed Commerce integrations connection in Moosewave and revoke its credential reference. Provider-side apps, API keys, webhooks, or Shopify app uninstall cleanup may still need provider-console action."
	}
	return resp
}

func isPostwaveIngestSyncModel(syncModel string) bool {
	switch syncModel {
	case "postwave_commerce_ingest", "postwave_crm_import", "postwave_submission_ingest", "postwave_review_ingest", "postwave_loyalty_ingest", "postwave_subscription_ingest", "postwave_support_ingest", "postwave_analytics_ingest":
		return true
	default:
		return false
	}
}

func managedProviderEndpointFor(meta managedProviderMetadata, action string) string {
	if meta.ActionPaths != nil {
		if path := meta.ActionPaths[action]; path != "" {
			return path
		}
	}
	return managedEndpointFor(meta.BasePath, action)
}

func managedProviderAuthModes(item CatalogItem) ([]string, bool) {
	meta, ok := managedProviderMetadataForItem(item)
	if !ok {
		return nil, false
	}
	modes := []string{meta.AuthMode}
	for _, key := range providerOptionalAuthModeKeys(meta.OptionalFields) {
		modes = append(modes, key)
	}
	return uniqueStrings(modes), true
}

func providerOptionalAuthModeKeys(fields []providerFieldMetadata) []string {
	authRefKeys := map[string]bool{
		"event_auth_ref":         true,
		"notification_token_ref": true,
		"webhook_auth_ref":       true,
		"webhook_route_token":    true,
		"webhook_secret_ref":     true,
		"webhook_signature_ref":  true,
	}
	out := []string{}
	for _, field := range fields {
		if authRefKeys[field.Key] {
			out = append(out, field.Key)
		}
	}
	return out
}

func managedProviderDataObjects(item CatalogItem) []string {
	meta, ok := managedProviderMetadataForItem(item)
	if !ok {
		return nil
	}
	return uniqueStrings(meta.SyncObjects)
}

func managedProviderEventTopics(item CatalogItem) []string {
	meta, ok := managedProviderMetadataForItem(item)
	if !ok {
		return nil
	}
	return uniqueStrings(meta.WebhookTopics)
}

func providerFieldKeys(fields []providerFieldMetadata) []string {
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		out = append(out, field.Key)
	}
	return uniqueStrings(out)
}

func decorateMarketingLifecycleResponse(resp actionResponse, meta managedProviderMetadata, action string) actionResponse {
	prefix := strings.TrimSpace(meta.Provider)
	if prefix == "" {
		prefix = "marketing"
	}
	handoff := prefix + "_handoff"
	sourceEvents := containsString(meta.SyncObjects, "profile_source_events") || containsString(meta.SyncObjects, "contact_source_events")
	delegated := "migration adapter"
	if sourceEvents {
		delegated = "migration/source-event adapter"
	}
	switch action {
	case "connect/start", "connect/callback":
		resp.RequiredFields = providerFieldKeys(meta.RequiredFields)
		resp.Message = "Create the native " + meta.Name + " provider row with credential references and provider settings through /api/v1/marketing-integrations. Raw provider secrets are rejected from settings; the data-plane import remains delegated to the " + delegated + " until native webhooks, writeback, cleanup automation, and live certification land."
	case "sync":
		resp.RequiredFields = []string{"id"}
		resp.Message = "Record a " + meta.Name + " native partial sync run and " + handoff + " provider-row cursor against the provider row while API-backed import"
		if sourceEvents {
			resp.Message += " and changed-record polling"
		}
		resp.Message += " remain delegated to the " + delegated + "."
	case "backfill":
		resp.RequiredFields = []string{"id"}
		resp.Message = "Record a " + meta.Name + " native partial backfill run and delegated " + handoff + " cursor evidence against the provider row; the actual " + joinedOrDefault(meta.SyncObjects, "marketing objects") + " pull still uses the reusable migration adapter."
	case "pause":
		resp.RequiredFields = []string{"id"}
		resp.Message = "Pause the " + meta.Name + " native provider row while preserving provider settings, sync history, and delegated migration evidence."
	case "disconnect":
		resp.RequiredFields = []string{"id"}
		if meta.Provider == marketingintegrations.ProviderKlaviyo {
			resp.Message = "Mark the Klaviyo marketing integration row disconnected, preserve run/webhook/audit evidence, persist provider_cleanup guidance, delete managed OAuth credential envelopes, and revoke managed OAuth tokens when present. POST /api/v1/marketing-integrations/{id}/provider-cleanup/acknowledge records local operator attestation after private-key, duplicate-webhook, and writeback cleanup review. Klaviyo private API-key revocation, duplicate/manual webhook audits, provider-side writeback cleanup, and live OAuth cleanup evidence remain Klaviyo account actions until provider-side cleanup certification lands."
		} else {
			resp.Message = "Mark the " + meta.Name + " marketing integration row disconnected, preserve run/audit evidence, and persist provider-cleanup guidance. Provider credential revocation, webhook cleanup, writeback cleanup, and duplicate provider-console connection cleanup remain operator-managed until live cleanup automation is certified."
		}
	default:
		resp.Message = meta.Name + " is managed through the Marketing integrations provider-row foundation."
	}
	return resp
}

func providerHasField(fields []providerFieldMetadata, key string) bool {
	for _, field := range fields {
		if field.Key == key {
			return true
		}
	}
	return false
}

func specFields(fields any) []providerFieldMetadata {
	value := reflect.ValueOf(fields)
	if value.Kind() != reflect.Slice {
		return nil
	}
	out := make([]providerFieldMetadata, 0, value.Len())
	for i := 0; i < value.Len(); i++ {
		field := value.Index(i)
		if field.Kind() == reflect.Pointer {
			if field.IsNil() {
				continue
			}
			field = field.Elem()
		}
		out = append(out, providerFieldMetadata{
			Key:      reflectedString(field, "Key"),
			Label:    reflectedString(field, "Label"),
			Required: reflectedBool(field, "Required"),
			Secret:   reflectedBool(field, "Secret"),
			Help:     reflectedString(field, "Help"),
		})
	}
	return out
}

func reflectedString(value reflect.Value, name string) string {
	field := value.FieldByName(name)
	if !field.IsValid() || field.Kind() != reflect.String {
		return ""
	}
	return field.String()
}

func reflectedBool(value reflect.Value, name string) bool {
	field := value.FieldByName(name)
	if !field.IsValid() || field.Kind() != reflect.Bool {
		return false
	}
	return field.Bool()
}

func readableAuthMode(mode string) string {
	mode = strings.TrimSpace(mode)
	if mode == "" {
		return "credential reference"
	}
	mode = strings.ReplaceAll(mode, "_", " ")
	mode = strings.ReplaceAll(mode, "-", " ")
	return mode
}

func joinedOrDefault(values []string, fallback string) string {
	values = uniqueStrings(values)
	if len(values) == 0 {
		return fallback
	}
	return strings.Join(values, ", ")
}
