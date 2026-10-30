package commerce

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

type ProviderField struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Required bool   `json:"required,omitempty"`
	Secret   bool   `json:"secret,omitempty"`
	Help     string `json:"help,omitempty"`
}

type ProviderSpec struct {
	Provider         string          `json:"provider"`
	Name             string          `json:"name"`
	Category         string          `json:"category"`
	AuthMode         string          `json:"auth_mode"`
	Managed          bool            `json:"managed"`
	RuntimeStatus    string          `json:"runtime_status"`
	SyncModel        string          `json:"sync_model,omitempty"`
	VerificationMode string          `json:"verification_mode,omitempty"`
	Capabilities     []string        `json:"capabilities"`
	RequiredSettings []ProviderField `json:"required_settings"`
	OptionalSettings []ProviderField `json:"optional_settings,omitempty"`
	Scopes           []string        `json:"scopes"`
	WebhookTopics    []string        `json:"webhook_topics,omitempty"`
	SyncObjects      []string        `json:"sync_objects"`
	DocsURL          string          `json:"docs_url"`
}

var (
	errRawCredentialSetting = errors.New("raw credentials are not accepted in settings; store them in the credential vault and pass credential_ref")
	errShopifyOAuth         = errors.New("Shopify uses OAuth; start with GET /api/v1/commerce/shopify/oauth/start")
)

const (
	commerceSyncModelShopify     = "shopify_oauth_webhook_graphql_backfill"
	commerceSyncModelWoo         = "woocommerce_rest_backfill"
	commerceSyncModelBig         = "bigcommerce_rest_backfill"
	commerceSyncModelStripe      = "stripe_restricted_key_webhook_backfill"
	commerceSyncModelSquare      = "square_oauth_webhook_rest_backfill"
	commerceSyncModelPayPal      = "paypal_oauth_reporting_webhook_backfill"
	commerceSyncModelRazorpay    = "razorpay_basic_auth_webhook_rest_backfill"
	commerceSyncModelAdobe       = "adobe_commerce_token_webhook_rest_backfill"
	commerceSyncModelWix         = "wix_app_instance_rest_webhook_backfill"
	commerceSyncModelSquarespace = "squarespace_api_key_oauth_webhook_rest_backfill"
	commerceSyncModelIngest      = "postwave_commerce_ingest"
	commerceVerificationIngest   = "canonical_payload"
)

var commerceProviderSpecs = []ProviderSpec{
	{
		Provider:      ProviderShopify,
		Name:          "Shopify",
		Category:      "ecommerce",
		AuthMode:      "oauth",
		Managed:       true,
		RuntimeStatus: "partial",
		Capabilities:  []string{"profiles", "events", "commerce", "orders", "products", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "shop_domain", Label: "Shop domain", Required: true, Help: "Example: brand.myshopify.com"},
		},
		Scopes:        []string{"read_customers", "read_products", "read_orders"},
		WebhookTopics: []string{"customers/create", "customers/update", "customers/enable", "customers/disable", "customers/data_request", "customers/redact", "products/create", "products/update", "orders/create", "orders/updated", "orders/paid", "orders/cancelled", "orders/fulfilled", "refunds/create", "carts/create", "carts/update", "checkouts/create", "checkouts/update", "bulk_operations/finish", "app/uninstalled", "shop/redact"},
		SyncObjects:   []string{"customers", "products", "orders", "cart_recovery_links", "events"},
		DocsURL:       "/docs/integrations/shopify",
	},
	{
		Provider:      ProviderWooCommerce,
		Name:          "WooCommerce",
		Category:      "ecommerce",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		SyncModel:     commerceSyncModelWoo,
		Capabilities:  []string{"profiles", "events", "commerce", "orders", "products", "subscriptions"},
		RequiredSettings: []ProviderField{
			{Key: "store_url", Label: "Store URL", Required: true, Help: "Canonical WordPress/WooCommerce store URL"},
			{Key: "credential_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the WooCommerce consumer key and secret"},
		},
		OptionalSettings: []ProviderField{
			{Key: "subscriptions_enabled", Label: "WooCommerce Subscriptions extension", Help: "Enable only when the store has WooCommerce Subscriptions installed; Moosewave then manages subscription lifecycle webhooks."},
		},
		Scopes:        []string{"read_customers", "read_products", "read_orders"},
		WebhookTopics: allWooCommerceWebhookTopics(),
		SyncObjects:   []string{"customers", "products", "orders", "refunds", "subscriptions", "events"},
		DocsURL:       "/docs/integrations/woocommerce",
	},
	{
		Provider:      ProviderBigCommerce,
		Name:          "BigCommerce",
		Category:      "ecommerce",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		SyncModel:     commerceSyncModelBig,
		Capabilities:  []string{"profiles", "events", "commerce", "orders", "products", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "store_hash", Label: "Store hash", Required: true, Help: "The BigCommerce store hash from the API path"},
			{Key: "credential_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the BigCommerce access token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "channel_id", Label: "Channel ID", Help: "Optional storefront/channel selector for multi-store catalogs"},
			{Key: "webhook_auth_ref", Label: "Webhook auth reference", Help: "Vault reference for configured webhook custom-header or basic-auth verification"},
		},
		Scopes:        []string{"store_v2_customers_read_only", "store_v2_products_read_only", "store_v2_orders_read_only"},
		WebhookTopics: defaultBigCommerceWebhookScopes,
		SyncObjects:   []string{"customers", "products", "orders", "refunds", "transactions", "events"},
		DocsURL:       "/docs/integrations/bigcommerce",
	},
	{
		Provider:      ProviderAdobeCommerce,
		Name:          "Adobe Commerce",
		Category:      "ecommerce",
		AuthMode:      "access_token_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		SyncModel:     commerceSyncModelAdobe,
		Capabilities:  []string{"profiles", "events", "commerce", "orders", "products", "automation_triggers"},
		RequiredSettings: []ProviderField{
			{Key: "base_url", Label: "Store base URL", Required: true, Help: "Adobe Commerce or Magento 2 base URL"},
			{Key: "credential_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing an Adobe Commerce integration or IMS access token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "store_view_code", Label: "Store view code", Help: "Optional store view selector for multi-store catalogs"},
			{Key: "website_id", Label: "Website ID", Help: "Optional Adobe Commerce website ID"},
			{Key: "event_auth_ref", Label: "Event auth reference", Help: "Vault reference for the shared secret configured on Adobe Commerce Webhooks or Adobe I/O Events delivery"},
			{Key: "deployment_mode", Label: "Deployment mode", Help: "Optional paas or saas selector; SaaS sends the store view through the Store header"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional override when the API host differs from the storefront base URL"},
		},
		Scopes:        []string{"Magento_Customer::customer", "Magento_Catalog::products", "Magento_Sales::sales", "Magento_Webapi::webapi"},
		WebhookTopics: []string{"customer.created", "customer.updated", "catalog.product.save_after", "sales_order_place_after", "sales_order_invoice_pay", "sales_order_creditmemo_refund"},
		SyncObjects:   []string{"customers", "products", "orders", "creditmemos", "refunds", "events"},
		DocsURL:       "/docs/integrations/adobe-commerce",
	},
	{
		Provider:      ProviderWixStores,
		Name:          "Wix Stores",
		Category:      "ecommerce",
		AuthMode:      "oauth_app_instance_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		SyncModel:     commerceSyncModelWix,
		Capabilities:  []string{"profiles", "events", "commerce", "orders", "products", "subscriptions", "payments", "refunds", "bookings", "ticketing"},
		RequiredSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Wix site identifier for the store"},
			{Key: "instance_id", Label: "App instance ID", Required: true, Help: "Wix app instance ID used with app credentials to mint access tokens"},
			{Key: "store_id", Label: "Store ID", Required: true, Help: "Wix Stores app/store identifier"},
			{Key: "credential_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Wix app credentials or an app-instance access token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Help: "Optional Wix account identifier"},
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Wix webhook verification"},
			{Key: "webhook_public_key_ref", Label: "Webhook public key reference", Help: "Vault reference containing the Wix app webhook public key used to verify official JWT payloads"},
			{Key: "catalog_version", Label: "Catalog version", Help: "Optional v1 or v3 selector; Wix sites support one catalog API generation at a time"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Wix API base URL override for testing or regional gateways"},
			{Key: "token_url", Label: "Token URL", Help: "Optional OAuth token endpoint override for testing"},
		},
		Scopes: []string{"stores.read", "orders.read", "contacts.read", "pricing-plans.read", "bookings.read", "events.read", "payments.read", "manage-your-app"},
		WebhookTopics: []string{
			"wix.ecom.v1.order.created",
			"wix.ecom.v1.order.updated",
			"wix.ecom.v1.order.canceled",
			"wix.ecom.v1.order.committed",
			"wix.ecom.v1.payment.created",
			"wix.ecom.v1.payment.updated",
			"wix.ecom.v1.refund.created",
			"wix.ecom.v1.refund.updated",
			"wix.ecom.v1.refund.failed",
			"wix.contacts.v4.contact.created",
			"wix.contacts.v4.contact.updated",
			"wix.contacts.v4.contact.deleted",
			"wix.stores.catalog.v1.product.created",
			"wix.stores.catalog.v1.product.changed",
			"wix.stores.catalog.v1.product.deleted",
			"wix.stores.catalog.v3.product.created",
			"wix.stores.catalog.v3.product.updated",
			"wix.stores.catalog.v3.product.deleted",
			"wix.catalog.v3.product.updated",
			"wix.pricing_plans.v2.order_purchased",
			"wix.pricing_plans.v2.order_updated",
			"wix.pricing_plans.v2.order_canceled",
			"wix.pricing_plans.v2.order_expired",
			"wix.bookings.v2.booking.created",
			"wix.bookings.v2.booking.updated",
			"wix.bookings.v2.booking.canceled",
			"wix.events.v1.ticket.purchased",
			"wix.events.v1.order.updated",
			"wix.events.v1.registration.updated",
			"wix.events.v1.registration.canceled",
			"wix.app.v1.instance.installed",
			"wix.app.v1.instance.removed",
		},
		SyncObjects: []string{"contacts", "customers", "products", "orders", "payments", "refunds", "subscriptions", "bookings", "tickets", "events"},
		DocsURL:     "/docs/integrations/wix-stores",
	},
	{
		Provider:      ProviderSquarespace,
		Name:          "Squarespace Commerce",
		Category:      "ecommerce",
		AuthMode:      "api_key_or_oauth_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		SyncModel:     commerceSyncModelSquarespace,
		Capabilities:  []string{"profiles", "events", "commerce", "orders", "products"},
		RequiredSettings: []ProviderField{
			{Key: "site_id", Label: "Site ID", Required: true, Help: "Squarespace site identifier"},
			{Key: "credential_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Squarespace API credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "store_url", Label: "Store URL", Help: "Optional public storefront URL"},
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for commerce webhook verification"},
			{Key: "api_base_url", Label: "API base URL", Help: "Optional Squarespace API base URL override for testing"},
			{Key: "user_agent", Label: "User-Agent", Help: "Custom User-Agent sent to Squarespace Commerce APIs"},
		},
		Scopes:        []string{"website.orders.read", "website.products.read", "website.contacts.read", "website.webhook_subscriptions"},
		WebhookTopics: []string{"order.create", "order.update", "contact.create", "contact.update", "contact.delete", "extension.uninstall"},
		SyncObjects:   []string{"customers", "products", "orders", "events"},
		DocsURL:       "/docs/integrations/squarespace-commerce",
	},
	{
		Provider:      ProviderStripe,
		Name:          "Stripe",
		Category:      "payments",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		SyncModel:     commerceSyncModelStripe,
		Capabilities:  []string{"profiles", "events", "commerce", "orders"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Connected Stripe account identifier"},
			{Key: "credential_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Stripe restricted key"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Stripe webhook signing secret"},
		},
		Scopes: []string{
			"customers:read",
			"checkout_sessions:read",
			"payment_intents:read",
			"charges:read",
			"disputes:read",
			"invoices:read",
			"credit_notes:read",
			"subscriptions:read",
			"refunds:read",
			"events:read",
		},
		WebhookTopics: []string{
			"customer.created",
			"customer.updated",
			"customer.deleted",
			"checkout.session.completed",
			"checkout.session.async_payment_succeeded",
			"checkout.session.async_payment_failed",
			"checkout.session.expired",
			"payment_intent.succeeded",
			"payment_intent.payment_failed",
			"payment_intent.canceled",
			"charge.succeeded",
			"charge.failed",
			"charge.captured",
			"charge.updated",
			"charge.refunded",
			"charge.dispute.created",
			"charge.dispute.updated",
			"charge.dispute.closed",
			"charge.dispute.funds_withdrawn",
			"charge.dispute.funds_reinstated",
			"invoice.created",
			"invoice.finalized",
			"invoice.paid",
			"invoice.payment_succeeded",
			"invoice.payment_failed",
			"invoice.updated",
			"invoice.voided",
			"invoice.marked_uncollectible",
			"invoice.deleted",
			"credit_note.created",
			"credit_note.updated",
			"credit_note.voided",
			"refund.created",
			"refund.updated",
			"refund.failed",
			"customer.subscription.created",
			"customer.subscription.updated",
			"customer.subscription.deleted",
			"customer.subscription.paused",
			"customer.subscription.resumed",
			"customer.subscription.pending_update_applied",
			"customer.subscription.pending_update_expired",
			"customer.subscription.trial_will_end",
		},
		SyncObjects: []string{"customers", "checkout_sessions", "payment_intents", "charges", "disputes", "invoices", "credit_notes", "subscriptions", "refunds", "orders", "events"},
		DocsURL:     "/docs/integrations/stripe",
	},
	{
		Provider:      ProviderSquare,
		Name:          "Square",
		Category:      "payments",
		AuthMode:      "oauth_or_app_token_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		SyncModel:     commerceSyncModelSquare,
		Capabilities:  []string{"profiles", "events", "commerce", "orders", "products"},
		RequiredSettings: []ProviderField{
			{Key: "merchant_id", Label: "Merchant ID", Required: true, Help: "Square merchant identifier"},
			{Key: "credential_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing the Square seller OAuth token or app token"},
		},
		OptionalSettings: []ProviderField{
			{Key: "location_id", Label: "Location ID", Help: "Optional Square location selector"},
			{Key: "location_ids", Label: "Location IDs", Help: "Optional comma-separated Square location IDs for order searches; Moosewave discovers active locations when omitted"},
			{Key: "webhook_signature_ref", Label: "Webhook signature reference", Help: "Vault reference for Square webhook signature key; validation uses notification URL plus raw body"},
			{Key: "webhook_notification_url", Label: "Webhook notification URL", Help: "Exact Square notification URL used when calculating webhook signatures behind proxies"},
		},
		Scopes:        []string{"CUSTOMERS_READ", "ORDERS_READ", "PAYMENTS_READ", "ITEMS_READ", "MERCHANT_PROFILE_READ"},
		WebhookTopics: []string{"customer.created", "customer.updated", "customer.deleted", "catalog.version.updated", "payment.created", "payment.updated", "refund.created", "refund.updated"},
		SyncObjects:   []string{"customers", "catalog_products", "products", "orders", "payments", "refunds", "events"},
		DocsURL:       "/docs/integrations/square",
	},
	{
		Provider:      ProviderPayPal,
		Name:          "PayPal",
		Category:      "payments",
		AuthMode:      "client_credentials_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		SyncModel:     commerceSyncModelPayPal,
		Capabilities:  []string{"profiles", "events", "commerce", "orders"},
		RequiredSettings: []ProviderField{
			{Key: "merchant_id", Label: "Merchant ID", Required: true, Help: "PayPal merchant account identifier"},
			{Key: "credential_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing PayPal REST app credentials"},
		},
		OptionalSettings: []ProviderField{
			{Key: "environment", Label: "Environment", Help: "live or sandbox"},
			{Key: "webhook_id", Label: "Webhook ID", Help: "PayPal webhook ID used for event verification"},
			{Key: "backfill_start", Label: "Backfill start", Help: "Optional RFC3339 start time for Transaction Search pulls"},
			{Key: "backfill_end", Label: "Backfill end", Help: "Optional RFC3339 end time for Transaction Search pulls"},
			{Key: "reporting_window_days", Label: "Reporting window days", Help: "Optional Transaction Search window size, capped at PayPal's 31-day maximum"},
		},
		Scopes: []string{
			"https://uri.paypal.com/services/payments/payment/authcapture",
			"https://uri.paypal.com/services/reporting/search/read",
			"https://uri.paypal.com/services/subscriptions",
			"https://uri.paypal.com/services/applications/webhooks",
		},
		WebhookTopics: []string{
			"CHECKOUT.ORDER.APPROVED",
			"CHECKOUT.ORDER.COMPLETED",
			"PAYMENT.CAPTURE.COMPLETED",
			"PAYMENT.CAPTURE.PENDING",
			"PAYMENT.CAPTURE.DECLINED",
			"PAYMENT.CAPTURE.REFUNDED",
			"PAYMENT.CAPTURE.REVERSED",
			"PAYMENT.REFUND.PENDING",
			"PAYMENT.REFUND.FAILED",
			"PAYMENT.SALE.COMPLETED",
			"PAYMENT.SALE.PENDING",
			"PAYMENT.SALE.DENIED",
			"PAYMENT.SALE.REFUNDED",
			"PAYMENT.SALE.REVERSED",
			"BILLING.SUBSCRIPTION.CREATED",
			"BILLING.SUBSCRIPTION.ACTIVATED",
			"BILLING.SUBSCRIPTION.UPDATED",
			"BILLING.SUBSCRIPTION.PAYMENT.FAILED",
			"BILLING.SUBSCRIPTION.CANCELLED",
			"BILLING.SUBSCRIPTION.SUSPENDED",
			"BILLING.SUBSCRIPTION.EXPIRED",
			"INVOICING.INVOICE.CREATED",
			"INVOICING.INVOICE.SCHEDULED",
			"INVOICING.INVOICE.UPDATED",
			"INVOICING.INVOICE.PAID",
			"INVOICING.INVOICE.REFUNDED",
			"INVOICING.INVOICE.CANCELLED",
			"CATALOG.PRODUCT.CREATED",
			"CATALOG.PRODUCT.UPDATED",
			"CATALOG.PRODUCT.DELETED",
		},
		SyncObjects: []string{"transactions", "orders", "refunds", "subscription_events", "invoice_events", "catalog_product_events", "events"},
		DocsURL:     "/docs/integrations/paypal",
	},
	{
		Provider:      ProviderRazorpay,
		Name:          "Razorpay",
		Category:      "payments",
		AuthMode:      "api_key_ref",
		Managed:       true,
		RuntimeStatus: "partial",
		SyncModel:     commerceSyncModelRazorpay,
		Capabilities:  []string{"profiles", "events", "commerce", "orders"},
		RequiredSettings: []ProviderField{
			{Key: "account_id", Label: "Account ID", Required: true, Help: "Razorpay account identifier"},
			{Key: "credential_ref", Label: "Credential reference", Required: true, Help: "Vault reference containing Razorpay key ID and key secret"},
		},
		OptionalSettings: []ProviderField{
			{Key: "webhook_secret_ref", Label: "Webhook secret reference", Help: "Vault reference for Razorpay webhook signature verification"},
			{Key: "settlement_currency", Label: "Settlement currency", Help: "Optional default settlement currency"},
			{Key: "backfill_from", Label: "Backfill from", Help: "Optional UNIX timestamp lower bound for historical list API pulls"},
			{Key: "backfill_to", Label: "Backfill to", Help: "Optional UNIX timestamp upper bound for historical list API pulls"},
		},
		Scopes:        []string{"customers:read", "orders:read", "payments:read", "webhooks:read"},
		WebhookTopics: []string{"payment.authorized", "payment.captured", "payment.failed", "order.paid", "refund.created", "refund.processed", "refund.failed", "refund.speed_changed"},
		SyncObjects:   []string{"customers", "orders", "payments", "refunds", "events"},
		DocsURL:       "/docs/integrations/razorpay",
	},
}

func CommerceProviderSpecs() []ProviderSpec {
	out := make([]ProviderSpec, 0, len(commerceProviderSpecs))
	for _, spec := range commerceProviderSpecs {
		out = append(out, withCommerceSpecDefaults(spec))
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Category != out[j].Category {
			return out[i].Category < out[j].Category
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func CommerceProviderSpec(provider string) (ProviderSpec, bool) {
	key := strings.ToLower(strings.TrimSpace(provider))
	for _, spec := range commerceProviderSpecs {
		if spec.Provider == key {
			return withCommerceSpecDefaults(spec), true
		}
	}
	return ProviderSpec{}, false
}

func withCommerceSpecDefaults(spec ProviderSpec) ProviderSpec {
	if spec.Provider == ProviderShopify {
		if spec.SyncModel == "" {
			spec.SyncModel = commerceSyncModelShopify
		}
		if spec.VerificationMode == "" {
			spec.VerificationMode = "shopify_oauth_and_raw_body_hmac"
		}
		return spec
	}
	if spec.SyncModel == "" {
		spec.SyncModel = commerceSyncModelIngest
	}
	if spec.VerificationMode == "" {
		spec.VerificationMode = commerceVerificationMode(spec.Provider)
	}
	if spec.SyncModel == commerceSyncModelIngest {
		spec.Scopes = []string{}
		spec.WebhookTopics = []string{}
		spec.SyncObjects = withoutString(spec.SyncObjects, "events")
		spec.OptionalSettings = withoutProviderFields(spec.OptionalSettings,
			"webhook_secret_ref",
			"webhook_signature_ref",
			"webhook_auth_ref",
			"event_auth_ref",
		)
	}
	return spec
}

func commerceVerificationMode(provider string) string {
	switch provider {
	case ProviderWooCommerce:
		return "woocommerce_raw_body_hmac_helper"
	case ProviderBigCommerce:
		return "postwave_custom_header_secret"
	case ProviderAdobeCommerce:
		return "adobe_commerce_event_auth_pending"
	case ProviderWixStores:
		return "wix_signed_jwt_or_bridge_secret"
	case ProviderSquarespace:
		return "squarespace_raw_body_hmac_helper"
	case ProviderStripe:
		return "stripe_signature_helper"
	case ProviderSquare:
		return "square_notification_url_hmac_helper"
	case ProviderPayPal:
		return "paypal_verify_webhook_signature_api"
	case ProviderRazorpay:
		return "razorpay_raw_body_hmac_helper"
	default:
		return commerceVerificationIngest
	}
}

func normalizeManagedIntegrationInput(in IntegrationInput) (IntegrationInput, ProviderSpec, error) {
	in.Provider = strings.ToLower(strings.TrimSpace(in.Provider))
	if in.Provider == "" {
		return IntegrationInput{}, ProviderSpec{}, errors.New("provider is required")
	}
	spec, ok := CommerceProviderSpec(in.Provider)
	if !ok {
		return IntegrationInput{}, ProviderSpec{}, fmt.Errorf("unsupported commerce provider %q", in.Provider)
	}
	if spec.Provider == ProviderShopify {
		return IntegrationInput{}, ProviderSpec{}, errShopifyOAuth
	}

	settings := copySettings(in.Settings)
	delete(settings, "provider_cleanup")
	if rawCredentialSetting(settings) != "" {
		return IntegrationInput{}, ProviderSpec{}, errRawCredentialSetting
	}
	if spec.SyncModel == commerceSyncModelIngest {
		deleteSettings(settings, "webhook_secret_ref", "webhook_signature_ref", "webhook_auth_ref", "event_auth_ref")
	}
	if spec.Provider == ProviderBigCommerce {
		rawStoreHash := settingString(settings, "store_hash")
		if normalizedStoreHash, ok := normalizeBigCommerceStoreHash(rawStoreHash); ok {
			settings["store_hash"] = normalizedStoreHash
		} else if rawStoreHash != "" {
			return IntegrationInput{}, ProviderSpec{}, errors.New("store_hash must be a BigCommerce store hash or API path containing /stores/{store_hash}")
		}
	}
	credentialRef := firstString(in.CredentialRef, settingString(settings, "credential_ref"), settingString(settings, "credentials_ref"))
	if credentialRef != "" {
		settings["credential_ref"] = credentialRef
		delete(settings, "credentials_ref")
	}
	if err := requireProviderSettings(spec, in, settings); err != nil {
		return IntegrationInput{}, ProviderSpec{}, err
	}
	if err := integration_egress.ValidateSettings(integration_egress.FamilyCommerce, spec.Provider, settings); err != nil {
		return IntegrationInput{}, ProviderSpec{}, err
	}

	in.Settings = settings
	in.CredentialRef = credentialRef
	in.ShopDomain = firstString(in.ShopDomain, derivedStoreIdentifier(spec.Provider, settings))
	in.ShopDomain = strings.TrimSpace(in.ShopDomain)
	if in.ShopDomain == "" {
		return IntegrationInput{}, ProviderSpec{}, errors.New("store identifier is required")
	}
	if in.Status = strings.ToLower(strings.TrimSpace(in.Status)); in.Status == "" {
		in.Status = "connected"
	}
	if len(in.Scopes) == 0 {
		in.Scopes = append([]string(nil), spec.Scopes...)
	}
	if spec.SyncModel == commerceSyncModelIngest {
		in.Scopes = []string{}
	}
	settings["managed_by_postwave"] = true
	settings["provider_status"] = spec.RuntimeStatus
	settings["sync_model"] = spec.SyncModel
	settings["verification_mode"] = spec.VerificationMode
	settings["egress_policy_version"] = "v1"
	if _, ok := settings["created_via"]; !ok {
		settings["created_via"] = "commerce_provider_registry"
	}
	in.AccessToken = ""
	in.WebhookSecret = ""
	return in, spec, nil
}

func copySettings(in map[string]any) map[string]any {
	out := make(map[string]any, len(in)+4)
	for k, v := range in {
		out[strings.ToLower(strings.TrimSpace(k))] = v
	}
	return out
}

func withoutProviderFields(fields []ProviderField, keys ...string) []ProviderField {
	blocked := map[string]struct{}{}
	for _, key := range keys {
		blocked[strings.ToLower(strings.TrimSpace(key))] = struct{}{}
	}
	out := make([]ProviderField, 0, len(fields))
	for _, field := range fields {
		if _, ok := blocked[strings.ToLower(strings.TrimSpace(field.Key))]; ok {
			continue
		}
		out = append(out, field)
	}
	return out
}

func withoutString(values []string, needle string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == needle {
			continue
		}
		out = append(out, value)
	}
	return out
}

func deleteSettings(settings map[string]any, keys ...string) {
	for _, key := range keys {
		delete(settings, strings.ToLower(strings.TrimSpace(key)))
	}
}

func requireProviderSettings(spec ProviderSpec, in IntegrationInput, settings map[string]any) error {
	for _, field := range spec.RequiredSettings {
		key := strings.ToLower(field.Key)
		switch key {
		case "credential_ref":
			if firstString(in.CredentialRef, settingString(settings, "credential_ref"), settingString(settings, "credentials_ref")) == "" {
				return errors.New("credential_ref is required")
			}
		case "shop_domain":
			if firstString(in.ShopDomain, settingString(settings, key)) == "" {
				return fmt.Errorf("%s is required", key)
			}
		default:
			if settingString(settings, key) == "" {
				return fmt.Errorf("%s is required", key)
			}
		}
	}
	return nil
}

func normalizeBigCommerceStoreHash(raw string) (string, bool) {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = strings.TrimRight(value, "/")
	if value == "" {
		return "", false
	}
	if i := strings.Index(value, "/stores/"); i >= 0 {
		value = value[i+len("/stores/"):]
	}
	if strings.HasPrefix(value, "stores/") {
		value = strings.TrimPrefix(value, "stores/")
	}
	if i := strings.Index(value, "/"); i >= 0 {
		value = value[:i]
	}
	if value == "" {
		return "", false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return "", false
		}
	}
	return value, true
}

func derivedStoreIdentifier(provider string, settings map[string]any) string {
	switch provider {
	case ProviderBigCommerce:
		return settingString(settings, "store_hash")
	case ProviderAdobeCommerce:
		return settingString(settings, "base_url")
	case ProviderWooCommerce:
		return settingString(settings, "store_url")
	case ProviderWixStores:
		return firstString(settingString(settings, "store_id"), settingString(settings, "site_id"))
	case ProviderSquarespace:
		return firstString(settingString(settings, "site_id"), settingString(settings, "store_url"))
	case ProviderStripe:
		return settingString(settings, "account_id")
	case ProviderSquare:
		return firstString(settingString(settings, "merchant_id"), settingString(settings, "location_id"))
	case ProviderPayPal:
		return settingString(settings, "merchant_id")
	case ProviderRazorpay:
		return settingString(settings, "account_id")
	default:
		return ""
	}
}

func rawCredentialSetting(settings map[string]any) string {
	for _, key := range []string{
		"access_token",
		"api_key",
		"api_secret",
		"ck",
		"client_secret",
		"cs",
		"consumer_key",
		"consumer_secret",
		"endpoint_secret",
		"key_secret",
		"password",
		"private_key",
		"refresh_token",
		"restricted_key",
		"secret",
		"secret_key",
		"signing_secret",
		"stripe_endpoint_secret",
		"stripe_restricted_key",
		"stripe_secret_key",
		"stripe_signing_secret",
		"token",
		"webhook_secret",
		"webhook_signature_key",
		"signature_key",
	} {
		if _, ok := settings[key]; ok {
			return key
		}
	}
	return ""
}

func settingString(settings map[string]any, key string) string {
	v, ok := settings[strings.ToLower(key)]
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

func settingBool(settings map[string]any, key string) bool {
	v, ok := settings[strings.ToLower(key)]
	if !ok || v == nil {
		return false
	}
	switch typed := v.(type) {
	case bool:
		return typed
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "1", "true", "yes", "y", "on", "enabled":
			return true
		default:
			return false
		}
	default:
		return strings.EqualFold(strings.TrimSpace(fmt.Sprint(typed)), "true") || strings.TrimSpace(fmt.Sprint(typed)) == "1"
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
