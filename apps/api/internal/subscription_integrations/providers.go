// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

var errRawCredentialSetting = errors.New("raw credentials are not accepted in settings; store them in the credential vault and pass credentials_ref")

var providerSpecs = []ProviderSpec{
	{
		Provider:      ProviderRecharge,
		Name:          "Recharge",
		Category:      "subscriptions",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "subscriptions", "commerce", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "store_domain", Label: "Store domain", Required: true, Help: "Shopify domain connected to Recharge"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Recharge API token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "api_version", Label: "API version", Help: "Optional pinned Recharge API version"},
			{Key: "page_size", Label: "Page size", Help: "Subscriptions per API page; capped at Recharge's 250 item limit"},
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference containing the Recharge webhook signing secret for X-Recharge-Hmac-Sha256 verification"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"customers", "subscriptions", "charges", "orders"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/recharge",
	},
	{
		Provider:      ProviderSkio,
		Name:          "Skio",
		Category:      "subscriptions",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "subscriptions", "commerce", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "store_domain", Label: "Store domain", Required: true, Help: "Shopify domain connected to Skio"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Skio API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "page_size", Label: "Page size", Help: "Subscriptions per GraphQL page; capped at Skio's runtime limit"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Skio GraphQL endpoint override for certification sandboxes"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"customers", "subscriptions"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/skio",
	},
	{
		Provider:      ProviderBoldSubscriptions,
		Name:          "Bold Subscriptions",
		Category:      "subscriptions",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "subscriptions", "commerce", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "shop_identifier", Label: "Shop identifier", Required: true, Help: "Bold shop identifier used in the Subscriptions API path"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Bold Subscriptions API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "store_domain", Label: "Store domain", Help: "Optional store domain for operator context"},
			{Key: "api_version_date", Label: "API version date", Help: "Optional pinned Bold API version date"},
			{Key: "page_size", Label: "Page size", Help: "Subscriptions per API page; capped at Bold's runtime limit"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Bold API base URL override for certification sandboxes"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"customers", "subscriptions"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/bold-subscriptions",
	},
	{
		Provider:      ProviderOrdergroove,
		Name:          "Ordergroove",
		Category:      "subscriptions",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "subscriptions", "commerce", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "merchant_id", Label: "Merchant ID", Required: true, Help: "Ordergroove merchant identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Ordergroove API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "store_domain", Label: "Store domain", Help: "Optional ecommerce store domain for context"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"customers", "subscriptions", "orders", "offers", "events"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/ordergroove",
	},
	{
		Provider:      ProviderLoopSubscriptions,
		Name:          "Loop Subscriptions",
		Category:      "subscriptions",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "subscriptions", "commerce", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "store_domain", Label: "Store domain", Required: true, Help: "Shopify domain connected to Loop Subscriptions"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Loop API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "page_size", Label: "Page size", Help: "Subscriptions per API page; capped at Loop's runtime limit"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Loop API base URL override for certification sandboxes"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"customers", "subscriptions"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/loop-subscriptions",
	},
	{
		Provider:      ProviderAppstle,
		Name:          "Appstle",
		Category:      "subscriptions",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "subscriptions", "commerce", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "store_domain", Label: "Store domain", Required: true, Help: "Shopify domain connected to Appstle"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Appstle API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "page_size", Label: "Page size", Help: "Subscription contracts per API page; capped at Appstle's runtime limit"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Appstle API base URL override for certification sandboxes"},
			{Key: "endpoint", Label: "Endpoint", Help: "Optional Appstle subscription-contract endpoint override for certification sandboxes"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"customers", "subscriptions"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/appstle",
	},
	{
		Provider:      ProviderSealSubscriptions,
		Name:          "Seal Subscriptions",
		Category:      "subscriptions",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "subscriptions", "commerce", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "store_domain", Label: "Store domain", Required: true, Help: "Shopify domain connected to Seal Subscriptions"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Seal Subscriptions API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "page_size", Label: "Page size", Help: "Subscriptions per API page; capped at Seal's runtime limit"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Seal API base URL override for certification sandboxes"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"customers", "subscriptions"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/seal-subscriptions",
	},
	{
		Provider:      ProviderChargebee,
		Name:          "Chargebee",
		Category:      "subscriptions",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "subscriptions", "commerce", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Chargebee site identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Chargebee API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "page_size", Label: "Page size", Help: "Subscriptions per API page; capped at Chargebee's runtime limit"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Chargebee API base URL override for certification sandboxes"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"customers", "subscriptions"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/chargebee",
	},
	{
		Provider:      ProviderAfterShip,
		Name:          "AfterShip",
		Category:      "shipping",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "AfterShip account or organization identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the AfterShip API key"},
		},
		OptionalSettings: []ProviderField{
			{Key: "page_size", Label: "Page size", Help: "Trackings per API page; capped at AfterShip's runtime limit"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional AfterShip API base URL override for certification sandboxes"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"shipments"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/aftership",
	},
	{
		Provider:      ProviderShipStation,
		Name:          "ShipStation",
		Category:      "shipping",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "ShipStation account or store identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing ShipStation API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "order_status", Label: "Order status", Help: "Optional ShipStation orderStatus filter"},
			{Key: "page_size", Label: "Page size", Help: "Orders per API page; capped at ShipStation's runtime limit"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional ShipStation API base URL override for certification sandboxes"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"shipments"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/shipstation",
	},
	{
		Provider:      ProviderShippo,
		Name:          "Shippo",
		Category:      "shipping",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Shippo account identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Shippo API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "store_domain", Label: "Store domain", Help: "Optional commerce store domain for shipment context"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"shipments", "transactions", "tracks", "addresses", "parcels"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/shippo",
	},
	{
		Provider:      ProviderEasyship,
		Name:          "Easyship",
		Category:      "shipping",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "company_id", Label: "Company ID", Required: true, Help: "Easyship company or store identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Easyship API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "store_domain", Label: "Store domain", Help: "Optional commerce store domain for shipment context"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"shipments", "orders", "couriers", "tracking_events"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/easyship",
	},
	{
		Provider:      ProviderShipBob,
		Name:          "ShipBob",
		Category:      "shipping",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "ShipBob merchant account identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing ShipBob API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "fulfillment_center_id", Label: "Fulfillment center ID", Help: "Optional fulfillment center filter"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"orders", "shipments", "fulfillments", "inventory", "tracking_events"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/shipbob",
	},
	{
		Provider:      ProviderEasyPost,
		Name:          "EasyPost",
		Category:      "shipping",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "EasyPost account identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing EasyPost API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "store_domain", Label: "Store domain", Help: "Optional commerce store domain for shipment context"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"shipments", "trackers", "batches", "scan_forms", "tracking_events"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/easypost",
	},
	{
		Provider:      ProviderNarvar,
		Name:          "Narvar",
		Category:      "shipping",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Narvar account or retailer identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Narvar API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "store_domain", Label: "Store domain", Help: "Optional commerce store domain for shipment context"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"orders", "shipments", "returns", "tracking_events", "notifications"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/narvar",
	},
	{
		Provider:      ProviderRoute,
		Name:          "Route",
		Category:      "shipping",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "merchant_id", Label: "Merchant ID", Required: true, Help: "Route merchant identifier"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Route API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "store_domain", Label: "Store domain", Help: "Optional commerce store domain for shipment context"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"orders", "shipments", "tracking_events", "claims"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/route",
	},
	{
		Provider:      ProviderMalomo,
		Name:          "Malomo",
		Category:      "shipping",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "shop_domain", Label: "Shop domain", Required: true, Help: "Shopify domain connected to Malomo"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Malomo API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "carrier_filter", Label: "Carrier filter", Help: "Optional carrier filter for tracking sync"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"orders", "fulfillments", "shipments", "tracking_events"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/malomo",
	},
	{
		Provider:      ProviderWonderment,
		Name:          "Wonderment",
		Category:      "shipping",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "orders", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "shop_domain", Label: "Shop domain", Required: true, Help: "Shopify domain connected to Wonderment"},
			{Key: "credentials_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Wonderment API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "carrier_filter", Label: "Carrier filter", Help: "Optional carrier filter for tracking sync"},
		},
		Scopes:        nil,
		SyncObjects:   []string{"orders", "shipments", "tracking_events", "delivery_promises"},
		WebhookTopics: nil,
		DocsURL:       "/docs/integrations/wonderment",
	},
}

func ProviderSpecs() []ProviderSpec {
	out := append([]ProviderSpec(nil), providerSpecs...)
	for i := range out {
		out[i] = withSubscriptionSpecDefaults(out[i])
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Name < out[j].Name
	})
	return out
}

func ProviderSpecByKey(provider string) (ProviderSpec, bool) {
	key := strings.ToLower(strings.TrimSpace(provider))
	for _, spec := range providerSpecs {
		if spec.Provider == key {
			return withSubscriptionSpecDefaults(spec), true
		}
	}
	return ProviderSpec{}, false
}

const (
	subscriptionSyncModelIngest = "postwave_subscription_ingest"
	rechargeSyncModelNative     = "recharge_subscriptions_rest_webhook_ingest"
	skioSyncModelNative         = "skio_subscriptions_graphql_offset_backfill"
	afterShipSyncModelNative    = "aftership_trackings_rest_page_backfill"
	shipStationSyncModelNative  = "shipstation_orders_shipments_rest_page_backfill"
	chargebeeSyncModelNative    = "chargebee_subscriptions_invoices_rest_offset_backfill"
	loopSyncModelNative         = "loop_subscriptions_rest_page_backfill"
	sealSyncModelNative         = "seal_subscriptions_rest_page_backfill"
	appstleSyncModelNative      = "appstle_subscriptions_rest_page_backfill"
	boldSyncModelNative         = "bold_subscriptions_rest_page_backfill"
)

var subscriptionCanonicalSyncObjects = []string{"subscriptions", "shipments", "events"}
var rechargeWebhookTopics = []string{"subscription/created", "subscription/updated", "subscription/deleted", "charge/created", "charge/updated", "charge/paid", "charge/failed"}

func withSubscriptionSpecDefaults(spec ProviderSpec) ProviderSpec {
	// Capabilities, RequiredSettings, Scopes and SyncObjects carry no
	// `omitempty`, so a nil slice marshals to JSON null rather than being left
	// out. Clients type all four as arrays, and a provider that simply needs no
	// scopes -- the ordinary case for an API-key integration -- handed them a
	// null that throws on the first .map().
	//
	// OptionalSettings and WebhookTopics are deliberately untouched: they DO
	// carry `omitempty`, so nil means "absent field", which is a shape clients
	// already handle.
	if spec.Capabilities == nil {
		spec.Capabilities = []string{}
	}
	if spec.RequiredSettings == nil {
		spec.RequiredSettings = []ProviderField{}
	}
	if spec.Scopes == nil {
		spec.Scopes = []string{}
	}
	if spec.SyncObjects == nil {
		spec.SyncObjects = []string{}
	}
	if spec.Provider == ProviderRecharge {
		if spec.SyncModel == "" {
			spec.SyncModel = rechargeSyncModelNative
		}
		if spec.VerificationMode == "" {
			spec.VerificationMode = subscriptionVerificationMode(spec.Provider)
		}
		spec.SyncObjects = []string{"subscriptions", "charges", "webhook_events"}
		spec.WebhookTopics = append([]string(nil), rechargeWebhookTopics...)
		return spec
	}
	if isNativeSubscriptionPullerProvider(spec.Provider) {
		if spec.SyncModel == "" {
			spec.SyncModel = nativeSubscriptionPullerSyncModel(spec.Provider)
		}
		if spec.VerificationMode == "" {
			spec.VerificationMode = subscriptionVerificationMode(spec.Provider)
		}
		spec.OptionalSettings = withoutProviderField(spec.OptionalSettings, "webhook_secret_ref")
		spec.WebhookTopics = nil
		return spec
	}
	if spec.SyncModel == "" {
		spec.SyncModel = subscriptionSyncModelIngest
	}
	if spec.VerificationMode == "" {
		spec.VerificationMode = subscriptionVerificationMode(spec.Provider)
	}
	if spec.SyncModel == subscriptionSyncModelIngest {
		// []string{}, not nil. This branch means "the ingest model has no OAuth
		// scopes", which is a true statement about an EMPTY set -- but Scopes
		// carries no `omitempty`, so nil says it in JSON as `null`, which is
		// what a client crashes on. The normalisation at the top of this
		// function cannot help: this assignment runs after it.
		//
		// WebhookTopics on the next line stays nil deliberately -- that field
		// DOES carry `omitempty`, so nil means "absent", not "null".
		spec.Scopes = []string{}
		spec.SyncObjects = append([]string(nil), subscriptionCanonicalSyncObjects...)
		spec.WebhookTopics = nil
		spec.VerificationMode = "postwave_ingest_token"
		spec.OptionalSettings = withoutProviderField(spec.OptionalSettings, "webhook_secret_ref")
	}
	return spec
}

func isNativeSubscriptionPullerProvider(provider string) bool {
	switch provider {
	case ProviderSkio, ProviderAfterShip, ProviderShipStation, ProviderChargebee,
		ProviderLoopSubscriptions, ProviderSealSubscriptions, ProviderAppstle,
		ProviderBoldSubscriptions:
		return true
	default:
		return false
	}
}

func nativeSubscriptionPullerSyncModel(provider string) string {
	switch provider {
	case ProviderSkio:
		return skioSyncModelNative
	case ProviderAfterShip:
		return afterShipSyncModelNative
	case ProviderShipStation:
		return shipStationSyncModelNative
	case ProviderChargebee:
		return chargebeeSyncModelNative
	case ProviderLoopSubscriptions:
		return loopSyncModelNative
	case ProviderSealSubscriptions:
		return sealSyncModelNative
	case ProviderAppstle:
		return appstleSyncModelNative
	case ProviderBoldSubscriptions:
		return boldSyncModelNative
	default:
		return subscriptionSyncModelIngest
	}
}

func withoutProviderField(fields []ProviderField, key string) []ProviderField {
	out := make([]ProviderField, 0, len(fields))
	for _, field := range fields {
		if strings.EqualFold(strings.TrimSpace(field.Key), key) {
			continue
		}
		out = append(out, field)
	}
	return out
}

func subscriptionVerificationMode(provider string) string {
	switch provider {
	case ProviderRecharge:
		return "recharge_api_token_subscriptions_pull_hmac_webhook_ingest_pending_live_certification"
	case ProviderSkio:
		return "skio_api_key_subscriptions_graphql_offset_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderAfterShip:
		return "aftership_api_key_trackings_rest_page_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderShipStation:
		return "shipstation_api_key_secret_orders_shipments_rest_page_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderChargebee:
		return "chargebee_api_key_subscriptions_invoices_rest_offset_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderLoopSubscriptions:
		return "loop_api_key_subscriptions_rest_page_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderSealSubscriptions:
		return "seal_api_key_subscriptions_rest_page_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderAppstle:
		return "appstle_api_key_subscriptions_rest_page_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	case ProviderBoldSubscriptions:
		return "bold_api_key_subscriptions_rest_page_backfill_scheduled_retry_pending_webhook_cleanup_live_certification"
	default:
		return "postwave_ingest_token"
	}
}

func normalizeIntegrationInput(in IntegrationInput) (IntegrationInput, ProviderSpec, error) {
	in.Provider = strings.ToLower(strings.TrimSpace(in.Provider))
	if in.Provider == "" {
		return IntegrationInput{}, ProviderSpec{}, errors.New("provider is required")
	}
	spec, ok := ProviderSpecByKey(in.Provider)
	if !ok {
		return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("unsupported subscription provider %q", in.Provider)
	}
	settings := copySettings(in.Settings)
	delete(settings, "provider_cleanup")
	if rawCredentialSetting(settings) != "" {
		return IntegrationInput{}, ProviderSpec{}, errRawCredentialSetting
	}
	credentialsRef := firstString(in.CredentialsRef, settingString(settings, "credentials_ref"), settingString(settings, "credential_ref"))
	if credentialsRef != "" {
		if looksLikeRawCredentialRef(credentialsRef) {
			return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("%w: credentials_ref looks like raw credential material", errRawCredentialSetting)
		}
		settings["credentials_ref"] = credentialsRef
		delete(settings, "credential_ref")
	}
	if spec.SyncModel == subscriptionSyncModelIngest {
		stripUnverifiedWebhookCredentialRefs(settings)
	} else {
		stripUndeclaredWebhookCredentialRefs(settings, spec)
	}
	for _, field := range spec.RequiredSettings {
		switch field.Key {
		case "credentials_ref":
			if credentialsRef == "" {
				return IntegrationInput{}, ProviderSpec{}, errors.New("credentials_ref is required")
			}
		default:
			if settingString(settings, field.Key) == "" {
				return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("%s is required", field.Key)
			}
		}
	}
	if err := integration_egress.ValidateSettings(integration_egress.FamilySubscription, spec.Provider, settings); err != nil {
		return IntegrationInput{}, ProviderSpec{}, err
	}
	if in.Name = strings.TrimSpace(in.Name); in.Name == "" {
		in.Name = spec.Name + " " + firstString(
			settingString(settings, "store_domain"),
			settingString(settings, "shop_domain"),
			settingString(settings, "account_id"),
			settingString(settings, "company_id"),
			settingString(settings, "merchant_id"),
			settingString(settings, "site_id"),
			settingString(settings, "warehouse_id"),
		)
	}
	if in.Status = strings.ToLower(strings.TrimSpace(in.Status)); in.Status == "" {
		in.Status = "connected"
	}
	if len(in.Scopes) == 0 {
		in.Scopes = append([]string(nil), spec.Scopes...)
	}
	settings["managed_by_postwave"] = true
	settings["provider_status"] = spec.RuntimeStatus
	settings["setup_surface"] = "subscription_integrations"
	settings["egress_policy_version"] = "v1"
	settings["sync_model"] = spec.SyncModel
	settings["verification_mode"] = spec.VerificationMode
	in.CredentialsRef = credentialsRef
	in.Settings = settings
	return in, spec, nil
}

func normalizeSyncRequest(in SyncRequest) SyncRequest {
	in.RunMode = strings.ToLower(strings.TrimSpace(in.RunMode))
	if in.RunMode == "" {
		in.RunMode = "manual"
	}
	in.Cursor = strings.TrimSpace(in.Cursor)
	for i := range in.Subscriptions {
		in.Subscriptions[i].SourceID = strings.TrimSpace(in.Subscriptions[i].SourceID)
		in.Subscriptions[i].Email = strings.ToLower(strings.TrimSpace(in.Subscriptions[i].Email))
		in.Subscriptions[i].CustomerID = strings.TrimSpace(in.Subscriptions[i].CustomerID)
		in.Subscriptions[i].SubscriptionID = strings.TrimSpace(in.Subscriptions[i].SubscriptionID)
		in.Subscriptions[i].Status = strings.ToLower(strings.TrimSpace(in.Subscriptions[i].Status))
		in.Subscriptions[i].ProductID = strings.TrimSpace(in.Subscriptions[i].ProductID)
		in.Subscriptions[i].SKU = strings.TrimSpace(in.Subscriptions[i].SKU)
		in.Subscriptions[i].Frequency = strings.TrimSpace(in.Subscriptions[i].Frequency)
	}
	for i := range in.Shipments {
		in.Shipments[i].SourceID = strings.TrimSpace(in.Shipments[i].SourceID)
		in.Shipments[i].Email = strings.ToLower(strings.TrimSpace(in.Shipments[i].Email))
		in.Shipments[i].OrderID = strings.TrimSpace(in.Shipments[i].OrderID)
		in.Shipments[i].TrackingNumber = strings.TrimSpace(in.Shipments[i].TrackingNumber)
		in.Shipments[i].Carrier = strings.TrimSpace(in.Shipments[i].Carrier)
		in.Shipments[i].Status = strings.ToLower(strings.TrimSpace(in.Shipments[i].Status))
	}
	for i := range in.Events {
		in.Events[i].SourceID = strings.TrimSpace(in.Events[i].SourceID)
		in.Events[i].Email = strings.ToLower(strings.TrimSpace(in.Events[i].Email))
		in.Events[i].EventName = strings.TrimSpace(in.Events[i].EventName)
		in.Events[i].SubscriptionID = strings.TrimSpace(in.Events[i].SubscriptionID)
		in.Events[i].OrderID = strings.TrimSpace(in.Events[i].OrderID)
		in.Events[i].TrackingNumber = strings.TrimSpace(in.Events[i].TrackingNumber)
		in.Events[i].Status = strings.ToLower(strings.TrimSpace(in.Events[i].Status))
	}
	return in
}

func copySettings(in map[string]any) map[string]any {
	out := make(map[string]any, len(in)+4)
	for k, v := range in {
		out[strings.ToLower(strings.TrimSpace(k))] = v
	}
	return out
}

func rawCredentialSetting(settings map[string]any) string {
	for _, key := range []string{
		"access_token",
		"api_key",
		"api_secret",
		"client_secret",
		"consumer_secret",
		"password",
		"private_app_token",
		"refresh_token",
		"secret",
		"token",
		"webhook_secret",
	} {
		if _, ok := settings[key]; ok {
			return key
		}
	}
	return ""
}

func stripUnverifiedWebhookCredentialRefs(settings map[string]any) {
	for _, key := range webhookCredentialRefSettingKeys {
		delete(settings, key)
	}
}

var webhookCredentialRefSettingKeys = []string{
	"webhook_secret_ref",
	"webhook_token_ref",
	"signing_secret_ref",
	"signature_secret_ref",
	"verification_token_ref",
}

func stripUndeclaredWebhookCredentialRefs(settings map[string]any, spec ProviderSpec) {
	for _, key := range webhookCredentialRefSettingKeys {
		if providerSpecDeclaresField(spec, key) {
			continue
		}
		delete(settings, key)
	}
}

func providerSpecDeclaresField(spec ProviderSpec, key string) bool {
	needle := strings.ToLower(strings.TrimSpace(key))
	for _, field := range append(append([]ProviderField{}, spec.RequiredSettings...), spec.OptionalSettings...) {
		if strings.ToLower(strings.TrimSpace(field.Key)) == needle {
			return true
		}
	}
	return false
}

func looksLikeRawCredentialRef(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return false
	}
	lower := strings.ToLower(trimmed)
	rawPrefixes := []string{
		"bearer ",
		"basic ",
		"sk_live_",
		"sk_test_",
		"rk_live_",
		"pk_live_",
		"shpat_",
		"xoxb-",
		"xoxp-",
		"ya29.",
		"ghp_",
		"gho_",
		"github_pat_",
		"glpat-",
		"pat-",
	}
	for _, prefix := range rawPrefixes {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	if strings.HasPrefix(lower, "eyj") || strings.HasPrefix(trimmed, "eyJ") {
		return true
	}
	if strings.ContainsAny(trimmed, " \t\r\n") {
		return true
	}
	return len(trimmed) > 80 && !strings.Contains(trimmed, ":") && !strings.Contains(trimmed, "/")
}

func settingString(settings map[string]any, key string) string {
	v, ok := settings[strings.ToLower(strings.TrimSpace(key))]
	if !ok || v == nil {
		return ""
	}
	switch typed := v.(type) {
	case string:
		return strings.TrimSpace(typed)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func firstString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
