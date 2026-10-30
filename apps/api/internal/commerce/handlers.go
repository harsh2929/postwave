package commerce

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

type Store interface {
	ListIntegrations(context.Context, string) ([]Integration, error)
	GetIntegration(context.Context, string, string) (*Integration, error)
	SetIntegrationStatus(context.Context, string, string, string) (*Integration, error)
	DisconnectIntegrationWithProviderCleanup(context.Context, string, string, *DisconnectCleanupEvidence) error
	DeleteIntegration(context.Context, string, string) error
	FindShopifyIntegrationByShop(context.Context, string) (*Integration, error)
	FindWooCommerceIntegrationByStoreURL(context.Context, string) (*Integration, error)
	FindWooCommerceIntegrationByTenantStoreURL(context.Context, string, string) (*Integration, error)
	FindBigCommerceIntegrationByStoreHash(context.Context, string) (*Integration, error)
	FindBigCommerceIntegrationByTenantStoreHash(context.Context, string, string) (*Integration, error)
	FindStripeIntegrationByAccountID(context.Context, string) (*Integration, error)
	FindSquareIntegrationByMerchantID(context.Context, string) (*Integration, error)
	FindPayPalIntegrationByMerchantID(context.Context, string) (*Integration, error)
	FindRazorpayIntegrationByAccountID(context.Context, string) (*Integration, error)
	FindAdobeCommerceIntegrationByBaseURL(context.Context, string) (*Integration, error)
	FindWixStoresIntegrationBySiteID(context.Context, string) (*Integration, error)
	FindSquarespaceIntegrationBySiteID(context.Context, string) (*Integration, error)
	UpsertIntegration(context.Context, string, IntegrationInput) (*Integration, error)
	ListCatalogs(context.Context, string, int, pagination.Cursor) (*CatalogsPage, error)
	UpsertCatalog(context.Context, string, CatalogInput) (*Catalog, error)
	ImportCatalogProducts(context.Context, string, string, CatalogProductImportInput, time.Time) (*CatalogProductImportSummary, error)
	ListProductFeeds(context.Context, string, string, int, pagination.Cursor) (*ProductFeedsPage, error)
	UpsertProductFeed(context.Context, string, string, ProductFeedInput) (*ProductFeed, error)
	ResolveProductFeed(context.Context, string, string, string, ProductFeedResolveInput) (*ResolvedProductFeed, error)
	ListCartRecoveryLinks(context.Context, string, string, string, int, pagination.Cursor) (*CartRecoveryLinksPage, error)
	UpsertCartRecoveryLink(context.Context, string, string, CartRecoveryLinkInput) (*CartRecoveryLink, error)
	ListBackInStockSubscriptions(context.Context, string, string, string, int, pagination.Cursor) (*BackInStockSubscriptionsPage, error)
	CreateBackInStockSubscription(context.Context, string, string, string, BackInStockSubscriptionInput) (*BackInStockSubscription, error)
	ListPriceDropWatchers(context.Context, string, string, string, int, pagination.Cursor) (*PriceDropWatchersPage, error)
	CreatePriceDropWatcher(context.Context, string, string, string, PriceDropWatcherInput) (*PriceDropWatcher, error)
	EvaluateLifecycleTriggers(context.Context, string, string, time.Time) (*CommerceLifecycleEvaluationSummary, error)
	LifecycleReport(context.Context, string, string, time.Time) (*CommerceLifecycleReport, error)
	Sync(context.Context, string, string, SyncRequest, time.Time) (*SyncSummary, error)
	ListCustomers(context.Context, string, string, int, pagination.Cursor) (*CustomersPage, error)
	ListProducts(context.Context, string, string, int, pagination.Cursor) (*ProductsPage, error)
	ListProductVariants(context.Context, string, string, string, int, pagination.Cursor) (*ProductVariantsPage, error)
	ListInventorySnapshots(context.Context, string, string, string, int, pagination.Cursor) (*InventorySnapshotsPage, error)
	ListPriceHistory(context.Context, string, string, string, int, pagination.Cursor) (*PriceHistoryPage, error)
	ListOrders(context.Context, string, string, int, pagination.Cursor) (*OrdersPage, error)
	ListEvents(context.Context, string, string, int, pagination.Cursor) (*EventsPage, error)
	Analytics(context.Context, string, string) (*Analytics, error)
	ClaimWebhook(context.Context, string, string, string, string, string, []byte) (WebhookClaim, error)
	SetIntegrationSync(context.Context, string, string, string, time.Time, error) error
	MarkWebhookProcessed(context.Context, string, string, string) error
	MarkWebhookFailed(context.Context, string, string, string, error) error
	MarkShopifyUninstalled(context.Context, string, string) error
	MarkWixStoresUninstalled(context.Context, string, string) error
	RedactShopifyCustomer(context.Context, string, string, ShopifyCustomerRedaction) error
	CollectShopifyCustomerDataRequest(context.Context, string, string, ShopifyCustomerDataRequest, time.Time) (*ShopifyCustomerDataRequestBundle, error)
	UpsertCustomer(context.Context, string, string, CustomerInput) error
	UpsertProduct(context.Context, string, string, ProductInput) error
	UpsertOrder(context.Context, string, string, OrderInput) error
	RecordProviderEvent(context.Context, string, string, ProviderEventInput) error
	DeleteCustomer(context.Context, string, string, ProviderDeletion) error
	DeleteProduct(context.Context, string, string, ProviderDeletion) error
	DeleteOrder(context.Context, string, string, ProviderDeletion) error
}

type Deps struct {
	Repo                        Store
	Config                      Config
	HTTPClient                  *http.Client
	ShopifyBackfiller           ShopifyBackfiller
	ShopifyBulkOperator         ShopifyBulkOperator
	ShopifyBulkImporter         ShopifyBulkResultImporter
	WooCommerceBackfiller       WooCommerceBackfiller
	BigCommerceBackfiller       BigCommerceBackfiller
	BigCommerceRecordFetcher    BigCommerceRecordFetcher
	BigCommerceCredentials      BigCommerceCredentialResolver
	StripeBackfiller            StripeBackfiller
	StripeCredentials           StripeCredentialResolver
	SquareBackfiller            SquareBackfiller
	SquareCredentials           SquareCredentialResolver
	PayPalBackfiller            PayPalBackfiller
	PayPalCredentials           PayPalCredentialResolver
	PayPalWebhookVerifier       PayPalWebhookVerifier
	PayPalResourceFetcher       PayPalWebhookResourceFetcher
	RazorpayBackfiller          RazorpayBackfiller
	RazorpayCredentials         RazorpayCredentialResolver
	AdobeCommerceBackfiller     AdobeCommerceBackfiller
	AdobeCommerceCredentials    AdobeCommerceCredentialResolver
	WixStoresBackfiller         WixStoresBackfiller
	WixStoresCredentials        WixStoresCredentialResolver
	SquarespaceBackfiller       SquarespaceBackfiller
	SquarespaceRecordFetcher    SquarespaceRecordFetcher
	SquarespaceCredentials      SquarespaceCredentialResolver
	CredentialResolver          CommerceCredentialResolver
	ShopifyWebhookRegistrar     ShopifyWebhookRegistrar
	WooCommerceWebhookRegistrar WooCommerceWebhookRegistrar
	BigCommerceWebhookRegistrar BigCommerceWebhookRegistrar
	Logger                      *slog.Logger
	Now                         func() time.Time
	// VerifyBackInStockProof validates a storefront CAPTCHA/signed identity
	// assertion before an email address enters the lifecycle list. The public
	// route remains unmounted until production supplies this verifier.
	VerifyBackInStockProof func(ctx context.Context, shopDomain, productID, email, proof string) error
}

const (
	commerceJSONMaxBodyBytes             int64 = 64 << 10 // 64 KiB
	commerceImportMaxBodyBytes           int64 = 1 << 20  // 1 MiB
	commerceShopifyTokenResponseMaxBytes int64 = 1 << 20
)

var errIntegrationDisconnected = errors.New("commerce integration is disconnected")

func Mount(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/commerce/providers", d.ListProviders)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/commerce/integrations", d.ListIntegrations)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/commerce/integrations", d.CreateIntegration)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/integrations/{id}", d.GetIntegration)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/commerce/integrations/{id}/sync", d.SyncIntegration)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/commerce/integrations/{id}/backfill", d.SyncIntegration)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/commerce/integrations/{id}/pause", d.PauseIntegration)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/commerce/integrations/{id}", d.DeleteIntegration)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/catalogs", d.ListCatalogs)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/commerce/catalogs", d.CreateCatalog)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/commerce/catalogs/{catalog_id}/import", d.ImportCatalogProducts)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/catalogs/{catalog_id}/feeds", d.ListProductFeeds)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/commerce/catalogs/{catalog_id}/feeds", d.CreateProductFeed)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Post("/api/v1/commerce/catalogs/{catalog_id}/feeds/{feed_id}/resolve", d.ResolveProductFeed)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/integrations/{id}/cart-recovery-links", d.ListCartRecoveryLinks)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/commerce/integrations/{id}/cart-recovery-links", d.UpsertCartRecoveryLink)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/integrations/{id}/back-in-stock-subscriptions", d.ListBackInStockSubscriptions)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/commerce/integrations/{id}/products/{product_id}/back-in-stock-subscriptions", d.CreateBackInStockSubscription)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/integrations/{id}/price-drop-watchers", d.ListPriceDropWatchers)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/commerce/integrations/{id}/products/{product_id}/price-drop-watchers", d.CreatePriceDropWatcher)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/commerce/integrations/{id}/lifecycle/evaluate", d.EvaluateLifecycleTriggers)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/integrations/{id}/lifecycle/report", d.LifecycleReport)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/integrations/{id}/customers", d.ListCustomers)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/integrations/{id}/products", d.ListProducts)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/integrations/{id}/products/{product_id}/variants", d.ListProductVariants)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/integrations/{id}/products/{product_id}/inventory", d.ListInventorySnapshots)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/integrations/{id}/products/{product_id}/price-history", d.ListPriceHistory)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/integrations/{id}/orders", d.ListOrders)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/integrations/{id}/events", d.ListEvents)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/commerce/integrations/{id}/analytics", d.Analytics)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/commerce/shopify/oauth/start", d.StartShopifyOAuth)
}

func MountPublic(r chi.Router, d *Deps) {
	r.Get("/api/public/commerce/shopify/oauth/callback", d.ShopifyOAuthCallback)
	r.Post("/api/public/commerce/shopify/webhooks", d.ShopifyWebhook)
	r.Post("/api/public/commerce/shopify/privacy", d.ShopifyPrivacyWebhook)
	r.Post("/api/public/commerce/woocommerce/webhooks", d.WooCommerceWebhook)
	r.Post("/api/public/commerce/bigcommerce/webhooks", d.BigCommerceWebhook)
	r.Post("/api/public/commerce/stripe/webhooks", d.StripeWebhook)
	r.Post("/api/public/commerce/square/webhooks", d.SquareWebhook)
	r.Post("/api/public/commerce/paypal/webhooks", d.PayPalWebhook)
	r.Post("/api/public/commerce/razorpay/webhooks", d.RazorpayWebhook)
	r.Post("/api/public/commerce/adobe-commerce/webhooks", d.AdobeCommerceWebhook)
	r.Post("/api/public/commerce/wix-stores/webhooks", d.WixStoresWebhook)
	r.Post("/api/public/commerce/squarespace/webhooks", d.SquarespaceWebhook)
	// The former anonymous back-in-stock intake is intentionally not mounted.
	// It may be re-enabled only with a production Storefront proof verifier
	// (CAPTCHA or signed customer assertion) and edge rate limiting.
}

func (d *Deps) ListProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"items": CommerceProviderSpecs()})
}

func (d *Deps) ListIntegrations(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListIntegrations(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	out = decorateIntegrationListSyncState(out, d.now())
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetIntegration(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.GetIntegration(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	decorateIntegrationSyncState(out, d.now())
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateIntegration(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in IntegrationInput
	if err := httpbody.DecodeJSON(w, r, commerceJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	normalized, _, err := normalizeManagedIntegrationInput(in)
	if err != nil {
		switch {
		case errors.Is(err, errShopifyOAuth):
			httperror.Write(w, http.StatusUnprocessableEntity, "shopify_oauth_required", err.Error())
		case errors.Is(err, errRawCredentialSetting):
			httperror.Write(w, http.StatusUnprocessableEntity, "raw_credentials_rejected", err.Error())
		default:
			httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		}
		return
	}
	if normalized.Provider == ProviderWooCommerce {
		if normalized.WebhookSecret == "" {
			existing, err := d.Repo.FindWooCommerceIntegrationByTenantStoreURL(r.Context(), t.ID, normalized.ShopDomain)
			if err != nil && !errors.Is(err, ErrNotFound) {
				httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
				return
			}
			if existing != nil && strings.TrimSpace(existing.WebhookSecret) != "" {
				normalized.WebhookSecret = strings.TrimSpace(existing.WebhookSecret)
			} else {
				secret, err := generateCommerceWebhookSecret()
				if err != nil {
					httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
					return
				}
				normalized.WebhookSecret = secret
			}
		}
		summary, err := d.reconcileWooCommerceWebhooks(r.Context(), Integration{
			TenantID:      t.ID,
			Provider:      ProviderWooCommerce,
			ShopDomain:    normalized.ShopDomain,
			Settings:      normalized.Settings,
			WebhookSecret: normalized.WebhookSecret,
		}, shopifyWebhookBaseURL(r, d.Config))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_registration_failed", httperror.MessageInternal)
			return
		}
		normalized.Settings["woocommerce_webhook_endpoint"] = summary.Endpoint
		normalized.Settings["woocommerce_webhook_registered_at"] = summary.RegisteredAt.Format(time.RFC3339)
		normalized.Settings["woocommerce_webhook_subscriptions"] = summary.Subscriptions
	}
	if normalized.Provider == ProviderBigCommerce {
		if normalized.WebhookSecret == "" {
			existing, err := d.Repo.FindBigCommerceIntegrationByTenantStoreHash(r.Context(), t.ID, normalized.ShopDomain)
			if err != nil && !errors.Is(err, ErrNotFound) {
				httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
				return
			}
			if existing != nil && strings.TrimSpace(existing.WebhookSecret) != "" {
				normalized.WebhookSecret = strings.TrimSpace(existing.WebhookSecret)
			} else {
				secret, err := generateCommerceWebhookSecret()
				if err != nil {
					httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
					return
				}
				normalized.WebhookSecret = secret
			}
		}
		summary, err := d.reconcileBigCommerceWebhooks(r.Context(), Integration{
			TenantID:      t.ID,
			Provider:      ProviderBigCommerce,
			ShopDomain:    normalized.ShopDomain,
			Settings:      normalized.Settings,
			WebhookSecret: normalized.WebhookSecret,
		}, shopifyWebhookBaseURL(r, d.Config))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_registration_failed", httperror.MessageInternal)
			return
		}
		normalized.Settings["bigcommerce_webhook_endpoint"] = summary.Endpoint
		normalized.Settings["bigcommerce_webhook_registered_at"] = summary.RegisteredAt.Format(time.RFC3339)
		normalized.Settings["bigcommerce_webhook_subscriptions"] = summary.Subscriptions
	}
	out, err := d.Repo.UpsertIntegration(r.Context(), t.ID, normalized)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// Klaviyo-style: import the store's trailing order/customer/product history
	// immediately on connect (background, bounded). Opt-out via settings.
	writeJSON(w, http.StatusCreated, out)
	d.maybeBackfillOnConnect(out)
}

func (d *Deps) PauseIntegration(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	integration, err := d.Repo.GetIntegration(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if integration != nil && strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
		return
	}
	out, err := d.Repo.SetIntegrationStatus(r.Context(), t.ID, id, "paused")
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration not found")
			return
		}
		if errors.Is(err, errIntegrationDisconnected) {
			httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteIntegration(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	integration, err := d.Repo.GetIntegration(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if integration != nil && strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		writeJSON(w, http.StatusOK, DisconnectResponse{OK: true, ProviderCleanup: disconnectCleanupEvidenceFromSettings(integration.Settings)})
		return
	}
	var cleanup *DisconnectCleanupEvidence
	if integration != nil && integration.Provider == ProviderShopify && strings.TrimSpace(integration.AccessToken) != "" {
		summary, err := d.cleanupShopifyWebhooks(r.Context(), *integration, shopifyWebhookBaseURLForIntegration(r, d.Config, *integration))
		if err != nil {
			writeShopifyBackfillError(w, err)
			return
		}
		cleanup = shopifyDisconnectCleanupEvidence(*integration, &summary, true)
	} else if integration != nil && integration.Provider == ProviderShopify {
		cleanup = shopifyDisconnectCleanupEvidence(*integration, nil, false)
	} else if integration != nil && integration.Provider == ProviderWooCommerce && settingString(integration.Settings, "woocommerce_webhook_endpoint") != "" {
		summary, err := d.cleanupWooCommerceWebhooks(r.Context(), *integration, wooCommerceWebhookBaseURLForIntegration(r, d.Config, *integration))
		if err != nil {
			writeCommerceBackfillError(w, err)
			return
		}
		cleanup = wooCommerceDisconnectCleanupEvidence(*integration, &summary, true)
	} else if integration != nil && integration.Provider == ProviderWooCommerce {
		cleanup = wooCommerceDisconnectCleanupEvidence(*integration, nil, false)
	} else if integration != nil && integration.Provider == ProviderStripe {
		cleanup = stripeDisconnectCleanupEvidence(*integration)
	} else if integration != nil && integration.Provider == ProviderSquare {
		cleanup = squareDisconnectCleanupEvidence(*integration)
	} else if integration != nil && integration.Provider == ProviderPayPal {
		cleanup = payPalDisconnectCleanupEvidence(*integration)
	} else if integration != nil && integration.Provider == ProviderRazorpay {
		cleanup = razorpayDisconnectCleanupEvidence(*integration)
	} else if integration != nil && integration.Provider == ProviderAdobeCommerce {
		cleanup = adobeCommerceDisconnectCleanupEvidence(*integration)
	} else if integration != nil && integration.Provider == ProviderSquarespace {
		cleanup = squarespaceDisconnectCleanupEvidence(*integration)
	} else if integration != nil && integration.Provider == ProviderBigCommerce && settingString(integration.Settings, "bigcommerce_webhook_endpoint") == "" {
		cleanup = bigCommerceDisconnectCleanupEvidence(*integration, nil, false)
	}
	if integration != nil && integration.Provider == ProviderBigCommerce && settingString(integration.Settings, "bigcommerce_webhook_endpoint") != "" {
		summary, err := d.cleanupBigCommerceWebhooks(r.Context(), *integration, bigCommerceWebhookBaseURLForIntegration(r, d.Config, *integration))
		if err != nil {
			writeCommerceBackfillError(w, err)
			return
		}
		cleanup = bigCommerceDisconnectCleanupEvidence(*integration, &summary, true)
	}
	if err := d.Repo.DisconnectIntegrationWithProviderCleanup(r.Context(), t.ID, id, cleanup); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, DisconnectResponse{OK: true, ProviderCleanup: cleanup})
}

func shopifyDisconnectCleanupEvidence(integration Integration, summary *ShopifyWebhookCleanupSummary, cleanupAttempted bool) *DisconnectCleanupEvidence {
	status := "operator_action_required"
	var webhookStatus string
	managed := cleanupAttempted
	evidence := []string{
		shopifyDisconnectEvidenceText,
	}
	endpoint := settingString(integration.Settings, "shopify_webhook_endpoint")
	webhookIDs := []string{}
	if summary != nil {
		endpoint = firstNonEmpty(summary.Endpoint, endpoint)
		for _, sub := range summary.Subscriptions {
			if strings.TrimSpace(sub.ID) != "" {
				webhookIDs = append(webhookIDs, strings.TrimSpace(sub.ID))
			}
		}
	}
	switch {
	case cleanupAttempted && len(webhookIDs) > 0:
		status = "managed_webhook_cleanup_completed"
		webhookStatus = "deleted_postwave_managed_webhooks"
		evidence = append(evidence, "Moosewave called Shopify Admin GraphQL webhookSubscriptionDelete for stored Moosewave-managed webhook subscription IDs")
	case cleanupAttempted:
		status = "managed_webhook_cleanup_checked"
		webhookStatus = "no_matching_postwave_managed_webhooks"
		evidence = append(evidence, "Moosewave checked Shopify webhook subscriptions for the stored Moosewave endpoint and found no matching managed topics to delete")
	default:
		webhookStatus = "skipped_no_shopify_access_token"
		evidence = append(evidence, "Moosewave did not call Shopify webhook deletion APIs because no encrypted Shopify access token was available on this row")
	}
	return &DisconnectCleanupEvidence{
		Provider:                ProviderShopify,
		Status:                  status,
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "postwave_managed_webhooks_operator_managed_app_uninstall",
		ManagedProviderCleanup:  managed,
		ProviderScopeType:       "shopify_shop_domain",
		ProviderScopeID:         integration.ShopDomain,
		WebhookEndpoint:         endpoint,
		WebhookIDs:              webhookIDs,
		WebhookCleanupStatus:    webhookStatus,
		CredentialCleanupStatus: "operator_uninstall_shopify_app_or_remove_custom_app_token",
		PostwaveEffects: []string{
			"local commerce integration is marked disconnected",
			"manual and scheduled Shopify provider pulls stop for this integration",
			"signed Shopify webhooks and privacy callbacks no longer resolve this integration",
			"commerce sync, webhook, privacy, and provider-event audit history is retained",
		},
		ProviderConsoleActions: []string{
			"uninstall the Moosewave Shopify app or remove the custom app install if the shop should no longer grant access",
			"audit Shopify app/webhook subscriptions for duplicate, legacy, or manually created Moosewave delivery URLs",
			"confirm app/uninstalled, privacy webhook, and token invalidation evidence during live certification",
		},
		ProviderCleanupEvidence: evidence,
	}
}

func wooCommerceDisconnectCleanupEvidence(integration Integration, summary *WooCommerceWebhookCleanupSummary, cleanupAttempted bool) *DisconnectCleanupEvidence {
	status := "operator_action_required"
	var webhookStatus string
	managed := false
	evidence := []string{
		"Moosewave did not call WooCommerce REST API key revocation during disconnect",
	}
	endpoint := settingString(integration.Settings, "woocommerce_webhook_endpoint")
	webhookIDs := []string{}
	if summary != nil {
		endpoint = firstNonEmpty(summary.Endpoint, endpoint)
		for _, sub := range summary.Subscriptions {
			if strings.TrimSpace(sub.ID) != "" {
				webhookIDs = append(webhookIDs, strings.TrimSpace(sub.ID))
			}
		}
	}
	switch {
	case cleanupAttempted && len(webhookIDs) > 0:
		status = "managed_webhook_cleanup_completed"
		webhookStatus = "deleted_postwave_managed_webhooks"
		managed = true
		evidence = append(evidence, "Moosewave called WooCommerce /wp-json/wc/v3/webhooks/{id}?force=true for stored Moosewave-managed webhook IDs")
	case cleanupAttempted:
		status = "managed_webhook_cleanup_checked"
		webhookStatus = "no_matching_postwave_managed_webhooks"
		managed = true
		evidence = append(evidence, "Moosewave listed WooCommerce webhooks for the stored Moosewave endpoint and found no matching managed topics to delete")
	default:
		webhookStatus = "skipped_no_postwave_endpoint_evidence"
		evidence = append(evidence, "Moosewave did not call WooCommerce webhook deletion APIs because no Moosewave-owned webhook endpoint metadata was stored")
	}
	storeURL := firstNonEmpty(integration.ShopDomain, settingString(integration.Settings, "store_url"))
	return &DisconnectCleanupEvidence{
		Provider:                ProviderWooCommerce,
		Status:                  status,
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "postwave_managed_webhooks_operator_managed_credentials",
		ManagedProviderCleanup:  managed,
		ProviderScopeType:       "woocommerce_store_url",
		ProviderScopeID:         storeURL,
		WebhookEndpoint:         endpoint,
		WebhookIDs:              webhookIDs,
		WebhookCleanupStatus:    webhookStatus,
		CredentialCleanupStatus: "operator_revoke_or_rotate_wordpress_rest_api_key",
		PostwaveEffects: []string{
			"local commerce integration is marked disconnected",
			"manual and scheduled WooCommerce provider pulls stop for this integration",
			"signed WooCommerce webhook callbacks no longer resolve this integration",
			"commerce sync, webhook, and provider-event audit history is retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the WooCommerce REST API key in WordPress admin if it is no longer used",
			"audit WooCommerce webhooks for duplicate, legacy, or manually created Moosewave delivery URLs",
			"remove any remaining provider-side webhook definitions that Moosewave did not create or could not match",
		},
		ProviderCleanupEvidence: evidence,
	}
}

func stripeDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	accountID := firstNonEmpty(integration.ShopDomain, settingString(integration.Settings, "account_id"))
	return &DisconnectCleanupEvidence{
		Provider:                ProviderStripe,
		Status:                  "operator_action_required",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_stripe_dashboard",
		ManagedProviderCleanup:  false,
		ProviderScopeType:       "stripe_account_id",
		ProviderScopeID:         accountID,
		CredentialRefPresent:    settingString(integration.Settings, "credential_ref") != "",
		WebhookSecretRefPresent: settingString(integration.Settings, "webhook_secret_ref") != "",
		WebhookCleanupStatus:    "operator_delete_or_disable_stripe_webhook_endpoint",
		CredentialCleanupStatus: "operator_revoke_or_rotate_stripe_restricted_key",
		PostwaveEffects: []string{
			"local commerce integration is marked disconnected",
			"manual and scheduled Stripe provider pulls stop for this integration",
			"signed Stripe webhook callbacks no longer resolve this integration",
			"commerce sync, webhook, and provider-event audit history is retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Stripe restricted key if it is no longer used",
			"delete or disable the Stripe webhook endpoint pointing at Moosewave",
			"rotate the Stripe webhook signing secret if the endpoint remains shared",
			"audit Stripe Dashboard for duplicate or manually created Moosewave webhook endpoints",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave does not delete Stripe Dashboard webhook endpoints during API disconnect",
			"Moosewave does not call Stripe restricted-key revocation during API disconnect",
			"Stripe-side webhook endpoint deletion, key revocation, and signing-secret rotation remain operator-managed",
		},
	}
}

func payPalDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	merchantID := firstNonEmpty(settingString(integration.Settings, "merchant_id"), integration.ShopDomain)
	merchantID = normalizePayPalMerchantID(merchantID)
	webhookID := strings.TrimSpace(settingString(integration.Settings, "webhook_id"))
	webhookIDs := []string{}
	if webhookID != "" {
		webhookIDs = append(webhookIDs, webhookID)
	}
	return &DisconnectCleanupEvidence{
		Provider:                ProviderPayPal,
		Status:                  "operator_action_required",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_paypal_developer_dashboard",
		ManagedProviderCleanup:  false,
		ProviderScopeType:       "paypal_merchant_id",
		ProviderScopeID:         merchantID,
		WebhookIDs:              webhookIDs,
		CredentialRefPresent:    settingString(integration.Settings, "credential_ref") != "",
		WebhookCleanupStatus:    "operator_delete_or_disable_paypal_webhook",
		CredentialCleanupStatus: "operator_revoke_or_rotate_paypal_rest_app_credentials",
		PostwaveEffects: []string{
			"local commerce integration is marked disconnected",
			"manual and scheduled PayPal Transaction Search provider pulls stop for this integration",
			"PayPal webhook callbacks no longer resolve this integration",
			"commerce sync, webhook, and provider-event audit history is retained",
		},
		ProviderConsoleActions: []string{
			"delete or disable the PayPal webhook pointing at Moosewave in the PayPal Developer Dashboard",
			"revoke or rotate the PayPal REST app client secret if it is no longer used",
			"audit PayPal Developer Dashboard for duplicate or manually created Moosewave webhook URLs",
			"remove the PayPal REST app only after confirming no other Moosewave or non-Moosewave workflows use it",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave does not delete PayPal Developer Dashboard webhooks during API disconnect",
			"Moosewave does not call PayPal REST app credential revocation during API disconnect",
			"PayPal-side webhook deletion, REST app credential rotation, and duplicate webhook audits remain operator-managed until managed app provisioning is certified",
		},
	}
}

func razorpayDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	accountID := strings.TrimSpace(firstNonEmpty(settingString(integration.Settings, "account_id"), integration.ShopDomain))
	return &DisconnectCleanupEvidence{
		Provider:                ProviderRazorpay,
		Status:                  "operator_action_required",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_razorpay_dashboard",
		ManagedProviderCleanup:  false,
		ProviderScopeType:       "razorpay_account_id",
		ProviderScopeID:         accountID,
		WebhookEndpoint:         strings.TrimSpace(firstNonEmpty(settingString(integration.Settings, "razorpay_webhook_endpoint"), settingString(integration.Settings, "webhook_endpoint"))),
		CredentialRefPresent:    razorpayCredentialRef(integration) != "",
		WebhookSecretRefPresent: strings.TrimSpace(integration.WebhookSecret) != "" || settingString(integration.Settings, "webhook_secret_ref") != "" || settingString(integration.Settings, "webhook_signing_secret_ref") != "",
		WebhookCleanupStatus:    "operator_delete_or_disable_razorpay_webhook_endpoint",
		CredentialCleanupStatus: "operator_revoke_or_rotate_razorpay_key_secret",
		PostwaveEffects: []string{
			"local commerce integration is marked disconnected",
			"manual and scheduled Razorpay provider pulls stop for this integration",
			"signed Razorpay webhook callbacks no longer resolve this integration",
			"commerce sync, webhook, and provider-event audit history is retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Razorpay key secret if it is no longer used",
			"delete or disable the Razorpay webhook endpoint pointing at Moosewave",
			"rotate the Razorpay webhook signing secret after accounting for retried deliveries signed with the old secret",
			"audit the Razorpay Dashboard for duplicate or manually created Moosewave webhook endpoints",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave does not delete Razorpay Dashboard webhook endpoints during API disconnect",
			"Moosewave does not call Razorpay key-secret revocation during API disconnect",
			"Razorpay-side webhook endpoint deletion, key rotation, signing-secret rotation, and duplicate webhook audits remain operator-managed until managed dashboard/API cleanup is certified",
		},
	}
}

func squareDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	return &DisconnectCleanupEvidence{
		Provider:                ProviderSquare,
		Status:                  "operator_action_required",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_square_developer_console",
		ManagedProviderCleanup:  false,
		ProviderScopeType:       "square_merchant_id",
		ProviderScopeID:         squareMerchantID(integration),
		WebhookEndpoint:         strings.TrimSpace(settingString(integration.Settings, "webhook_notification_url")),
		CredentialRefPresent:    settingString(integration.Settings, "credential_ref") != "",
		WebhookSecretRefPresent: strings.TrimSpace(integration.WebhookSecret) != "" || squareWebhookSignatureRef(integration) != "",
		WebhookCleanupStatus:    "operator_delete_or_disable_square_webhook_subscription",
		CredentialCleanupStatus: "operator_revoke_or_rotate_square_oauth_or_app_token",
		PostwaveEffects: []string{
			"local commerce integration is marked disconnected",
			"manual and scheduled Square provider pulls stop for this integration",
			"signed Square webhook callbacks no longer resolve this integration",
			"commerce sync, webhook, and provider-event audit history is retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Square OAuth seller token or app token if it is no longer used",
			"delete or disable the Square webhook subscription pointing at Moosewave in the Square Developer Console",
			"rotate the Square webhook signature key if the webhook subscription remains shared",
			"audit Square Developer Console for duplicate or manually created Moosewave webhook notification URLs",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave does not delete Square Developer Console webhook subscriptions during API disconnect",
			"Moosewave does not call Square OAuth token revocation or app-token cleanup during API disconnect",
			"Square-side webhook subscription deletion, credential rotation, signature-key rotation, and duplicate notification URL audits remain operator-managed until managed app provisioning is certified",
		},
	}
}

func adobeCommerceDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	storeScope := firstNonEmpty(settingString(integration.Settings, "base_url"), integration.ShopDomain, settingString(integration.Settings, "api_base_url"))
	if normalized := normalizeAdobeCommerceStoreBaseURL(storeScope); normalized != "" {
		storeScope = normalized
	}
	return &DisconnectCleanupEvidence{
		Provider:                ProviderAdobeCommerce,
		Status:                  "operator_action_required",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_adobe_commerce_admin_or_module",
		ManagedProviderCleanup:  false,
		ProviderScopeType:       "adobe_commerce_base_url",
		ProviderScopeID:         storeScope,
		WebhookEndpoint:         strings.TrimSpace(firstNonEmpty(settingString(integration.Settings, "adobe_commerce_webhook_endpoint"), settingString(integration.Settings, "webhook_endpoint"))),
		CredentialRefPresent:    adobeCommerceCredentialRef(integration) != "" || strings.TrimSpace(integration.AccessToken) != "",
		WebhookSecretRefPresent: adobeCommerceEventAuthRef(integration) != "",
		WebhookCleanupStatus:    "operator_delete_or_disable_adobe_commerce_webhook_definition",
		CredentialCleanupStatus: "operator_revoke_or_rotate_adobe_commerce_access_token",
		PostwaveEffects: []string{
			"local commerce integration is marked disconnected",
			"manual and scheduled Adobe Commerce provider pulls stop for this integration",
			"Adobe Commerce webhook callbacks no longer resolve this integration",
			"commerce sync, webhook, and provider-event audit history is retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Adobe Commerce admin token or IMS access token if it is no longer used",
			"delete or disable Adobe Commerce Webhooks, Adobe I/O Events, or Magento module deliveries pointing at Moosewave",
			"rotate the Adobe/Magento shared secret or Bearer verifier if the provider webhook remains shared",
			"audit Adobe Commerce Admin or module configuration for duplicate or manually created Moosewave delivery URLs",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave does not delete Adobe Commerce Admin, Adobe I/O Events, or Magento module webhook definitions during API disconnect",
			"Moosewave does not call Adobe Commerce admin-token, IMS-token, or module credential revocation during API disconnect",
			"Adobe/Magento-side webhook cleanup, credential rotation, and duplicate delivery audits remain operator-managed until a certified managed module or SaaS Admin flow is attached",
		},
	}
}

func squarespaceDisconnectCleanupEvidence(integration Integration) *DisconnectCleanupEvidence {
	return &DisconnectCleanupEvidence{
		Provider:                ProviderSquarespace,
		Status:                  "operator_action_required",
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_squarespace_oauth_webhook_subscriptions",
		ManagedProviderCleanup:  false,
		ProviderScopeType:       "squarespace_site_id",
		ProviderScopeID:         strings.TrimSpace(settingString(integration.Settings, "site_id")),
		WebhookEndpoint:         strings.TrimSpace(firstNonEmpty(settingString(integration.Settings, "squarespace_webhook_endpoint"), settingString(integration.Settings, "webhook_endpoint"))),
		CredentialRefPresent:    squarespaceCredentialRef(integration) != "" || strings.TrimSpace(integration.AccessToken) != "",
		WebhookSecretRefPresent: strings.TrimSpace(integration.WebhookSecret) != "" || squarespaceWebhookSecretRef(integration) != "",
		WebhookCleanupStatus:    "operator_delete_or_disable_squarespace_webhook_subscription",
		CredentialCleanupStatus: "operator_revoke_or_rotate_squarespace_api_key_or_oauth_token",
		PostwaveEffects: []string{
			"local commerce integration is marked disconnected",
			"manual and scheduled Squarespace provider pulls stop for this integration",
			"signed Squarespace webhook callbacks no longer resolve this integration",
			"commerce sync, webhook, and provider-event audit history is retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Squarespace API key or OAuth token if it is no longer used",
			"delete or disable the Squarespace webhook subscription pointing at Moosewave through the OAuth app flow",
			"rotate the Squarespace webhook secret if the subscription remains shared",
			"audit Squarespace app/site settings for duplicate or manually created Moosewave delivery URLs",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave does not delete Squarespace OAuth webhook subscriptions during API disconnect",
			"Moosewave does not call Squarespace API-key or OAuth-token revocation during API disconnect",
			"Squarespace-side webhook subscription cleanup, credential rotation, webhook-secret rotation, and duplicate target audits remain operator-managed until managed OAuth subscription cleanup is certified",
		},
	}
}

func bigCommerceDisconnectCleanupEvidence(integration Integration, summary *BigCommerceWebhookCleanupSummary, cleanupAttempted bool) *DisconnectCleanupEvidence {
	status := "operator_action_required"
	webhookStatus := "skipped_no_postwave_endpoint_evidence"
	managed := false
	endpoint := settingString(integration.Settings, "bigcommerce_webhook_endpoint")
	webhookIDs := []string{}
	evidence := []string{
		"Moosewave does not revoke BigCommerce API account credentials during disconnect",
	}
	if summary != nil {
		endpoint = firstNonEmpty(summary.Endpoint, endpoint)
		for _, sub := range summary.Subscriptions {
			if strings.TrimSpace(sub.ID) != "" {
				webhookIDs = append(webhookIDs, strings.TrimSpace(sub.ID))
			}
		}
	}
	switch {
	case cleanupAttempted && len(webhookIDs) > 0:
		status = "managed_webhook_cleanup_completed"
		webhookStatus = "deleted_postwave_managed_hooks"
		managed = true
		evidence = append(evidence, "Moosewave deleted BigCommerce /v3/hooks entries matching the stored endpoint and managed scopes")
	case cleanupAttempted:
		status = "managed_webhook_cleanup_checked"
		webhookStatus = "no_matching_postwave_managed_hooks"
		managed = true
		evidence = append(evidence, "Moosewave listed BigCommerce /v3/hooks for the stored endpoint and found no matching managed scopes to delete")
	default:
		evidence = append(evidence, "Moosewave did not call BigCommerce hook deletion APIs because no Moosewave-owned hook endpoint metadata was stored")
	}
	storeHash := firstNonEmpty(settingString(integration.Settings, "store_hash"), integration.ShopDomain)
	if normalized, ok := normalizeBigCommerceStoreHash(storeHash); ok {
		storeHash = normalized
	}
	return &DisconnectCleanupEvidence{
		Provider:                ProviderBigCommerce,
		Status:                  status,
		RecordedAt:              time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "postwave_managed_hooks_operator_managed_api_account",
		ManagedProviderCleanup:  managed,
		ProviderScopeType:       "bigcommerce_store_hash",
		ProviderScopeID:         storeHash,
		WebhookEndpoint:         endpoint,
		WebhookIDs:              webhookIDs,
		CredentialRefPresent:    settingString(integration.Settings, "credential_ref") != "",
		WebhookSecretRefPresent: strings.TrimSpace(integration.WebhookSecret) != "" || settingString(integration.Settings, "webhook_secret_ref") != "",
		WebhookCleanupStatus:    webhookStatus,
		CredentialCleanupStatus: "operator_revoke_or_rotate_bigcommerce_api_account_token",
		PostwaveEffects: []string{
			"local commerce integration is marked disconnected",
			"manual and scheduled BigCommerce provider pulls stop for this integration",
			"BigCommerce webhook callbacks no longer resolve this integration",
			"commerce sync, webhook, and provider-event audit history is retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the BigCommerce API account access token if it is no longer used",
			"audit BigCommerce webhooks for duplicate, legacy, or manually created Moosewave delivery URLs",
			"remove any remaining provider-side hook definitions that Moosewave did not create or could not match",
		},
		ProviderCleanupEvidence: evidence,
	}
}

func disconnectCleanupEvidenceFromSettings(settings map[string]any) *DisconnectCleanupEvidence {
	raw, ok := settings["provider_cleanup"]
	if !ok || raw == nil {
		return nil
	}
	payload, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var out DisconnectCleanupEvidence
	if err := json.Unmarshal(payload, &out); err != nil {
		return nil
	}
	if out.Provider == "" && out.Status == "" {
		return nil
	}
	return &out
}

func (d *Deps) ListCatalogs(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 50, 200)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	out, err := d.Repo.ListCatalogs(r.Context(), t.ID, limit, cursor)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateCatalog(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in CatalogInput
	if err := httpbody.DecodeJSON(w, r, commerceJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "catalog name is required")
		return
	}
	out, err := d.Repo.UpsertCatalog(r.Context(), t.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) ImportCatalogProducts(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in CatalogProductImportInput
	if err := httpbody.DecodeJSON(w, r, commerceImportMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(in.Products) == 0 {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "products is required")
		return
	}
	if len(in.Products) > 1000 {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "products cannot exceed 1000 per import")
		return
	}
	out, err := d.Repo.ImportCatalogProducts(r.Context(), t.ID, chi.URLParam(r, "catalog_id"), in, d.now())
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", "catalog not found")
		case errors.Is(err, ErrCatalogRequiresIntegration):
			httperror.Write(w, http.StatusUnprocessableEntity, "catalog_requires_integration", "catalog import requires integration_id")
		default:
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	writeJSON(w, http.StatusAccepted, out)
}

func (d *Deps) ListProductFeeds(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 50, 200)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	out, err := d.Repo.ListProductFeeds(r.Context(), t.ID, chi.URLParam(r, "catalog_id"), limit, cursor)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "catalog not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateProductFeed(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in ProductFeedInput
	if err := httpbody.DecodeJSON(w, r, commerceJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "feed name is required")
		return
	}
	if in.MaxItems < 0 || in.MaxItems > 50 {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "max_items must be between 1 and 50 when provided")
		return
	}
	out, err := d.Repo.UpsertProductFeed(r.Context(), t.ID, chi.URLParam(r, "catalog_id"), in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "catalog not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) ResolveProductFeed(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in ProductFeedResolveInput
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, commerceJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	in.SubscriberEmail = strings.ToLower(strings.TrimSpace(in.SubscriberEmail))
	if in.MaxItems < 0 || in.MaxItems > 50 {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "max_items must be between 1 and 50 when provided")
		return
	}
	out, err := d.Repo.ResolveProductFeed(r.Context(), t.ID, chi.URLParam(r, "catalog_id"), chi.URLParam(r, "feed_id"), in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "catalog or feed not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ListCartRecoveryLinks(w http.ResponseWriter, r *http.Request) {
	d.listCommerceStatusResource(w, r, func(ctx context.Context, tenantID, integrationID, status string, limit int, cursor pagination.Cursor) (any, error) {
		return d.Repo.ListCartRecoveryLinks(ctx, tenantID, integrationID, status, limit, cursor)
	})
}

func (d *Deps) UpsertCartRecoveryLink(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in CartRecoveryLinkInput
	if err := httpbody.DecodeJSON(w, r, commerceJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.SourceCartID = strings.TrimSpace(in.SourceCartID)
	in.RecoveryURL = strings.TrimSpace(in.RecoveryURL)
	in.CustomerEmail = strings.ToLower(strings.TrimSpace(in.CustomerEmail))
	in.Status = strings.ToLower(strings.TrimSpace(in.Status))
	if in.SourceCartID == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "source_cart_id is required")
		return
	}
	if in.RecoveryURL == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "recovery_url is required")
		return
	}
	if in.Status != "" && !validCartRecoveryStatus(in.Status) {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "status must be active, converted, expired, or disabled")
		return
	}
	out, err := d.Repo.UpsertCartRecoveryLink(r.Context(), t.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration or cart order not found")
			return
		}
		if errors.Is(err, errIntegrationDisconnected) {
			httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) ListBackInStockSubscriptions(w http.ResponseWriter, r *http.Request) {
	d.listCommerceStatusResource(w, r, func(ctx context.Context, tenantID, integrationID, status string, limit int, cursor pagination.Cursor) (any, error) {
		return d.Repo.ListBackInStockSubscriptions(ctx, tenantID, integrationID, status, limit, cursor)
	})
}

func (d *Deps) CreateBackInStockSubscription(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in BackInStockSubscriptionInput
	if err := httpbody.DecodeJSON(w, r, commerceJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.SubscriberID = strings.TrimSpace(in.SubscriberID)
	in.SubscriberEmail = strings.ToLower(strings.TrimSpace(in.SubscriberEmail))
	in.VariantID = strings.TrimSpace(in.VariantID)
	if in.SubscriberID == "" && in.SubscriberEmail == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "subscriber_id or subscriber_email is required")
		return
	}
	out, err := d.Repo.CreateBackInStockSubscription(r.Context(), t.ID, chi.URLParam(r, "id"), chi.URLParam(r, "product_id"), in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration, product, or variant not found")
			return
		}
		if errors.Is(err, errIntegrationDisconnected) {
			httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) ListPriceDropWatchers(w http.ResponseWriter, r *http.Request) {
	d.listCommerceStatusResource(w, r, func(ctx context.Context, tenantID, integrationID, status string, limit int, cursor pagination.Cursor) (any, error) {
		return d.Repo.ListPriceDropWatchers(ctx, tenantID, integrationID, status, limit, cursor)
	})
}

func (d *Deps) CreatePriceDropWatcher(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in PriceDropWatcherInput
	if err := httpbody.DecodeJSON(w, r, commerceJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.SubscriberID = strings.TrimSpace(in.SubscriberID)
	in.SubscriberEmail = strings.ToLower(strings.TrimSpace(in.SubscriberEmail))
	in.VariantID = strings.TrimSpace(in.VariantID)
	in.Currency = strings.ToUpper(strings.TrimSpace(in.Currency))
	if in.SubscriberID == "" && in.SubscriberEmail == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "subscriber_id or subscriber_email is required")
		return
	}
	if in.TargetPriceCents == nil && in.MinDropPercent == nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "target_price_cents or min_drop_percent is required")
		return
	}
	if in.TargetPriceCents != nil && *in.TargetPriceCents < 0 {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "target_price_cents must be non-negative")
		return
	}
	if in.MinDropPercent != nil && (*in.MinDropPercent < 1 || *in.MinDropPercent > 100) {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "min_drop_percent must be between 1 and 100")
		return
	}
	out, err := d.Repo.CreatePriceDropWatcher(r.Context(), t.ID, chi.URLParam(r, "id"), chi.URLParam(r, "product_id"), in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration, product, or variant not found")
			return
		}
		if errors.Is(err, errIntegrationDisconnected) {
			httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) EvaluateLifecycleTriggers(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.EvaluateLifecycleTriggers(r.Context(), t.ID, chi.URLParam(r, "id"), d.now())
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration not found")
			return
		}
		if errors.Is(err, errIntegrationDisconnected) {
			httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) LifecycleReport(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.LifecycleReport(r.Context(), t.ID, chi.URLParam(r, "id"), d.now())
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) StartShopifyOAuth(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	shop := NormalizeShopDomain(r.URL.Query().Get("shop"))
	if !ValidShopifyShopDomain(shop) {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "shop must be a *.myshopify.com domain")
		return
	}
	cfg := d.Config
	if shopifyCredentialsMissing(cfg) && isProductionRuntime() {
		httperror.Write(w, http.StatusServiceUnavailable, "shopify_not_configured", "Shopify OAuth requires SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in production")
		return
	}
	if cfg.ShopifyOAuthRedirectURL == "" {
		cfg.ShopifyOAuthRedirectURL = externalBaseURL(r) + "/api/public/commerce/shopify/oauth/callback"
	}
	state, err := BuildOAuthState(cfg.ShopifyStateSecret, t.ID, shop, newNonce(), d.now())
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	authorizeURL, local := buildShopifyAuthorizeURL(cfg, shop, state)
	writeJSON(w, http.StatusOK, OAuthStartResponse{
		Provider:     ProviderShopify,
		ShopDomain:   shop,
		AuthorizeURL: authorizeURL,
		State:        state,
		Scopes:       cfg.scopes(),
		Local:        local,
	})
}

func (d *Deps) ShopifyOAuthCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	shop := NormalizeShopDomain(q.Get("shop"))
	if !ValidShopifyShopDomain(shop) {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "shop must be a *.myshopify.com domain")
		return
	}
	// HMAC verification is REQUIRED. Audit (integration-auth CRITICAL #1):
	// the prior `&&` gate meant a callback with no `hmac` query param
	// silently bypassed verification and exchanged the `code` with
	// only the `state` nonce as proof. A crafted callback with no
	// hmac could install a fake integration. Fail closed on empty
	// secret too — every other HMAC path in the codebase does.
	if d.Config.ShopifyClientSecret == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "shopify_unconfigured",
			"SHOPIFY_CLIENT_SECRET not set; OAuth callback rejected")
		return
	}
	if q.Get("hmac") == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_hmac",
			"Shopify OAuth callback missing required hmac param")
		return
	}
	if err := VerifyShopifyOAuthHMAC(d.Config.ShopifyClientSecret, q); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_hmac", "request authentication failed")
		return
	}
	tenantID, stateShop, err := ParseOAuthState(d.Config.ShopifyStateSecret, q.Get("state"), d.now(), 30*time.Minute)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_state", "request authentication failed")
		return
	}
	if stateShop != shop {
		httperror.Write(w, http.StatusUnauthorized, "shop_mismatch", "oauth state shop does not match callback shop")
		return
	}
	token, local, err := d.exchangeShopifyCode(r.Context(), shop, q.Get("code"))
	if err != nil {
		httperror.Write(w, http.StatusBadGateway, "token_exchange_failed", "Shopify token exchange failed")
		return
	}
	settings := map[string]any{
		"oauth_connected_at": d.now().UTC().Format(time.RFC3339),
		"local":              local,
	}
	var webhookRegistration *ShopifyWebhookReconcileSummary
	if !local {
		summary, err := d.reconcileShopifyWebhooks(r.Context(), Integration{
			Provider:    ProviderShopify,
			ShopDomain:  shop,
			AccessToken: token,
		}, shopifyWebhookBaseURL(r, d.Config))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_registration_failed", httperror.MessageInternal)
			return
		}
		webhookRegistration = &summary
		settings["shopify_webhook_endpoint"] = summary.Endpoint
		settings["shopify_webhook_registered_at"] = summary.RegisteredAt.Format(time.RFC3339)
		settings["shopify_webhook_subscriptions"] = summary.Subscriptions
	}
	integration, err := d.Repo.UpsertIntegration(r.Context(), tenantID, IntegrationInput{
		Provider:      ProviderShopify,
		ShopDomain:    shop,
		Status:        "connected",
		Scopes:        d.Config.scopes(),
		Settings:      settings,
		AccessToken:   token,
		WebhookSecret: firstNonEmpty(d.Config.ShopifyWebhookSecret, d.Config.ShopifyClientSecret),
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, OAuthCallbackResponse{Integration: integration, Local: local, WebhookRegistration: webhookRegistration})
}

func (d *Deps) reconcileShopifyWebhooks(ctx context.Context, integration Integration, appBaseURL string) (ShopifyWebhookReconcileSummary, error) {
	registrar := d.ShopifyWebhookRegistrar
	if registrar == nil {
		registrar = ShopifyAdminGraphQLWebhookRegistrar{HTTPClient: d.HTTPClient}
	}
	return registrar.ReconcileWebhooks(ctx, integration, appBaseURL)
}

func (d *Deps) cleanupShopifyWebhooks(ctx context.Context, integration Integration, appBaseURL string) (ShopifyWebhookCleanupSummary, error) {
	registrar := d.ShopifyWebhookRegistrar
	if registrar == nil {
		registrar = ShopifyAdminGraphQLWebhookRegistrar{HTTPClient: d.HTTPClient}
	}
	return registrar.CleanupWebhooks(ctx, integration, appBaseURL)
}

func (d *Deps) reconcileWooCommerceWebhooks(ctx context.Context, integration Integration, appBaseURL string) (WooCommerceWebhookReconcileSummary, error) {
	registrar := d.WooCommerceWebhookRegistrar
	if registrar == nil {
		registrar = WooCommerceRESTWebhookRegistrar{
			HTTPClient:  d.HTTPClient,
			Credentials: d.CredentialResolver,
		}
	}
	return registrar.ReconcileWebhooks(ctx, integration, appBaseURL)
}

func (d *Deps) cleanupWooCommerceWebhooks(ctx context.Context, integration Integration, appBaseURL string) (WooCommerceWebhookCleanupSummary, error) {
	registrar := d.WooCommerceWebhookRegistrar
	if registrar == nil {
		registrar = WooCommerceRESTWebhookRegistrar{
			HTTPClient:  d.HTTPClient,
			Credentials: d.CredentialResolver,
		}
	}
	return registrar.CleanupWebhooks(ctx, integration, appBaseURL)
}

func (d *Deps) reconcileBigCommerceWebhooks(ctx context.Context, integration Integration, appBaseURL string) (BigCommerceWebhookReconcileSummary, error) {
	registrar := d.BigCommerceWebhookRegistrar
	if registrar == nil {
		registrar = BigCommerceRESTWebhookRegistrar{
			HTTPClient:  d.HTTPClient,
			Credentials: d.bigCommerceCredentialResolver(),
		}
	}
	return registrar.ReconcileWebhooks(ctx, integration, appBaseURL)
}

func (d *Deps) cleanupBigCommerceWebhooks(ctx context.Context, integration Integration, appBaseURL string) (BigCommerceWebhookCleanupSummary, error) {
	registrar := d.BigCommerceWebhookRegistrar
	if registrar == nil {
		registrar = BigCommerceRESTWebhookRegistrar{
			HTTPClient:  d.HTTPClient,
			Credentials: d.bigCommerceCredentialResolver(),
		}
	}
	return registrar.CleanupWebhooks(ctx, integration, appBaseURL)
}

func (d *Deps) bigCommerceRecordFetcher() BigCommerceRecordFetcher {
	if d == nil {
		return nil
	}
	if d.BigCommerceRecordFetcher != nil {
		return d.BigCommerceRecordFetcher
	}
	return BigCommerceRESTBackfiller{
		HTTPClient:  d.HTTPClient,
		Credentials: d.bigCommerceCredentialResolver(),
	}
}

func (d *Deps) SyncIntegration(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	var in SyncRequest
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, commerceJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	if isAsyncShopifyBulkBackfillRequest(r) || isBulkShopifyBackfillRequest(r) || syncRequestHasPayload(in) {
		integration, err := d.Repo.GetIntegration(r.Context(), t.ID, id)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				httperror.Write(w, http.StatusNotFound, "not_found", "integration not found")
				return
			}
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		if integration != nil && strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
			httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
			return
		}
	}
	if isAsyncShopifyBulkBackfillRequest(r) {
		summary, err := d.shopifyAsyncBulkBackfill(r.Context(), t.ID, id, in.Cursor, shopifyAsyncBulkObjectFromRequest(r))
		if err != nil {
			writeShopifyBackfillError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, summary)
		return
	}
	if isBulkShopifyBackfillRequest(r) {
		summary, err := d.shopifyBulkBackfill(r.Context(), t.ID, id, in.Cursor, shopifyBulkBackfillMaxPagesFromRequest(r))
		if err != nil {
			writeShopifyBackfillError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, summary)
		return
	}
	var backfillMeta providerBackfillMeta
	providerPulled := false
	if !syncRequestHasPayload(in) {
		pulled, meta, ok, err := d.providerBackfillRequest(r.Context(), t.ID, id, in.Cursor)
		if err != nil {
			if errors.Is(err, errIntegrationDisconnected) {
				httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
				return
			}
			writeCommerceBackfillError(w, err)
			return
		}
		if ok {
			backfillMeta = meta
			providerPulled = true
			in = pulled
			if !syncRequestHasPayload(in) {
				writeJSON(w, http.StatusAccepted, SyncSummary{Cursor: in.Cursor})
				return
			}
		}
	}
	out, err := d.Repo.Sync(r.Context(), t.ID, id, in, d.now())
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration not found")
			return
		}
		if errors.Is(err, ErrSyncPayloadRequired) {
			httperror.Write(w, http.StatusUnprocessableEntity, "payload_required", "commerce sync/backfill requires canonical customers, products, product deletions, orders, or provider events")
			return
		}
		if providerPulled {
			retryCursor, ok := commerceProviderRetryCursor(backfillMeta.Provider, backfillMeta.Cursor, "SYNC_FAILED", err, d.now())
			if ok {
				_ = d.Repo.SetIntegrationSync(r.Context(), t.ID, id, retryCursor, d.now(), err)
			}
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusAccepted, out)
}

type providerBackfillMeta struct {
	Provider string
	Cursor   string
}

func (d *Deps) providerBackfillRequest(ctx context.Context, tenantID, integrationID, cursor string) (SyncRequest, providerBackfillMeta, bool, error) {
	integration, err := d.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return SyncRequest{}, providerBackfillMeta{}, false, nil
		}
		return SyncRequest{}, providerBackfillMeta{}, false, err
	}
	if integration == nil {
		return SyncRequest{}, providerBackfillMeta{}, false, nil
	}
	if strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		return SyncRequest{}, providerBackfillMeta{}, false, errIntegrationDisconnected
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	meta := providerBackfillMeta{Provider: integration.Provider, Cursor: cursor}
	switch integration.Provider {
	case ProviderShopify:
		backfiller := d.ShopifyBackfiller
		if backfiller == nil {
			backfiller = ShopifyAdminGraphQLBackfiller{HTTPClient: d.HTTPClient}
		}
		out, err := backfiller.BackfillPage(ctx, *integration, cursor)
		return out, meta, true, err
	case ProviderWooCommerce:
		out, effectiveCursor, err := d.wooCommerceProviderBackfillRequest(ctx, tenantID, integration, cursor)
		meta.Cursor = effectiveCursor
		return out, meta, true, err
	case ProviderBigCommerce:
		out, effectiveCursor, err := d.bigCommerceProviderBackfillRequest(ctx, tenantID, integration, cursor)
		meta.Cursor = effectiveCursor
		return out, meta, true, err
	case ProviderStripe:
		out, effectiveCursor, err := d.stripeProviderBackfillRequest(ctx, tenantID, integration, cursor)
		meta.Cursor = effectiveCursor
		return out, meta, true, err
	case ProviderSquare:
		out, effectiveCursor, err := d.squareProviderBackfillRequest(ctx, tenantID, integration, cursor)
		meta.Cursor = effectiveCursor
		return out, meta, true, err
	case ProviderPayPal:
		out, effectiveCursor, err := d.payPalProviderBackfillRequest(ctx, tenantID, integration, cursor)
		meta.Cursor = effectiveCursor
		return out, meta, true, err
	case ProviderRazorpay:
		backfiller := d.RazorpayBackfiller
		if backfiller == nil {
			backfiller = RazorpayRESTBackfiller{
				HTTPClient:  d.HTTPClient,
				Credentials: d.razorpayCredentialResolver(),
			}
		}
		out, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		return out, meta, true, err
	case ProviderAdobeCommerce:
		backfiller := d.AdobeCommerceBackfiller
		if backfiller == nil {
			backfiller = AdobeCommerceRESTBackfiller{
				HTTPClient:  d.HTTPClient,
				Credentials: d.adobeCommerceCredentialResolver(),
			}
		}
		out, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		return out, meta, true, err
	case ProviderWixStores:
		backfiller := d.WixStoresBackfiller
		if backfiller == nil {
			backfiller = WixStoresRESTBackfiller{
				HTTPClient:  d.HTTPClient,
				Credentials: d.wixStoresCredentialResolver(),
			}
		}
		out, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		return out, meta, true, err
	case ProviderSquarespace:
		backfiller := d.SquarespaceBackfiller
		if backfiller == nil {
			backfiller = SquarespaceRESTBackfiller{
				HTTPClient:  d.HTTPClient,
				Credentials: d.squarespaceCredentialResolver(),
			}
		}
		out, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		return out, meta, true, err
	default:
		return SyncRequest{}, providerBackfillMeta{}, false, nil
	}
}

func (d *Deps) wooCommerceProviderBackfillRequest(ctx context.Context, tenantID string, integration *Integration, cursor string) (SyncRequest, string, error) {
	effectiveCursor := strings.TrimSpace(cursor)
	if retry, ok, err := decodeWooCommerceRetryCursor(effectiveCursor); err != nil {
		return SyncRequest{}, effectiveCursor, err
	} else if ok {
		if !wooCommerceRetryCursorDue(retry, d.now()) {
			return SyncRequest{Cursor: effectiveCursor}, effectiveCursor, nil
		}
		effectiveCursor = retry.Cursor
	}
	backfiller := d.WooCommerceBackfiller
	if backfiller == nil {
		backfiller = WooCommerceRESTBackfiller{
			HTTPClient:  d.HTTPClient,
			Credentials: d.CredentialResolver,
		}
	}
	out, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
	if err != nil {
		retryCursor := wooCommerceBackfillRetryCursor(effectiveCursor, "BACKFILL_FAILED", err, d.now())
		_ = d.Repo.SetIntegrationSync(ctx, tenantID, integration.ID, retryCursor, d.now(), err)
		return SyncRequest{}, effectiveCursor, err
	}
	return out, effectiveCursor, nil
}

func (d *Deps) bigCommerceProviderBackfillRequest(ctx context.Context, tenantID string, integration *Integration, cursor string) (SyncRequest, string, error) {
	effectiveCursor := strings.TrimSpace(cursor)
	retryCursorBase := effectiveCursor
	if retry, ok, err := decodeBigCommerceRetryCursor(effectiveCursor); err != nil {
		return SyncRequest{}, retryCursorBase, err
	} else if ok {
		if !bigCommerceRetryCursorDue(retry, d.now()) {
			return SyncRequest{Cursor: effectiveCursor}, retryCursorBase, nil
		}
		effectiveCursor = retry.Cursor
	}
	backfiller := d.BigCommerceBackfiller
	if backfiller == nil {
		backfiller = BigCommerceRESTBackfiller{
			HTTPClient:  d.HTTPClient,
			Credentials: d.bigCommerceCredentialResolver(),
		}
	}
	out, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
	if err != nil {
		retryCursor := bigCommerceBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, d.now())
		_ = d.Repo.SetIntegrationSync(ctx, tenantID, integration.ID, retryCursor, d.now(), err)
		return SyncRequest{}, retryCursorBase, err
	}
	return out, retryCursorBase, nil
}

func (d *Deps) stripeProviderBackfillRequest(ctx context.Context, tenantID string, integration *Integration, cursor string) (SyncRequest, string, error) {
	effectiveCursor := strings.TrimSpace(cursor)
	if retry, ok, err := decodeStripeRetryCursor(effectiveCursor); err != nil {
		return SyncRequest{}, effectiveCursor, err
	} else if ok {
		if !stripeRetryCursorDue(retry, d.now()) {
			return SyncRequest{Cursor: effectiveCursor}, effectiveCursor, nil
		}
		effectiveCursor = retry.Cursor
	}
	backfiller := d.StripeBackfiller
	if backfiller == nil {
		backfiller = StripeRESTBackfiller{
			HTTPClient:  d.HTTPClient,
			Credentials: d.stripeCredentialResolver(),
		}
	}
	out, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
	if err != nil {
		retryCursor := stripeBackfillRetryCursor(effectiveCursor, "BACKFILL_FAILED", err, d.now())
		_ = d.Repo.SetIntegrationSync(ctx, tenantID, integration.ID, retryCursor, d.now(), err)
		return SyncRequest{}, effectiveCursor, err
	}
	return out, effectiveCursor, nil
}

func (d *Deps) payPalProviderBackfillRequest(ctx context.Context, tenantID string, integration *Integration, cursor string) (SyncRequest, string, error) {
	effectiveCursor := strings.TrimSpace(cursor)
	retryCursorBase := effectiveCursor
	if retry, ok, err := decodePayPalRetryCursor(effectiveCursor); err != nil {
		return SyncRequest{}, retryCursorBase, err
	} else if ok {
		if !payPalRetryCursorDue(retry, d.now()) {
			return SyncRequest{Cursor: effectiveCursor}, retryCursorBase, nil
		}
		effectiveCursor = retry.Cursor
	}
	backfiller := d.PayPalBackfiller
	if backfiller == nil {
		backfiller = PayPalRESTBackfiller{
			HTTPClient:  d.HTTPClient,
			Credentials: d.payPalCredentialResolver(),
		}
	}
	out, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
	if err != nil {
		retryCursor := payPalBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, d.now())
		_ = d.Repo.SetIntegrationSync(ctx, tenantID, integration.ID, retryCursor, d.now(), err)
		return SyncRequest{}, retryCursorBase, err
	}
	return out, retryCursorBase, nil
}

func (d *Deps) squareProviderBackfillRequest(ctx context.Context, tenantID string, integration *Integration, cursor string) (SyncRequest, string, error) {
	effectiveCursor := strings.TrimSpace(cursor)
	retryCursorBase := effectiveCursor
	if retry, ok, err := decodeSquareRetryCursor(effectiveCursor); err != nil {
		return SyncRequest{}, retryCursorBase, err
	} else if ok {
		if !squareRetryCursorDue(retry, d.now()) {
			return SyncRequest{Cursor: effectiveCursor}, retryCursorBase, nil
		}
		effectiveCursor = retry.Cursor
	}
	backfiller := d.SquareBackfiller
	if backfiller == nil {
		backfiller = SquareRESTBackfiller{
			HTTPClient:  d.HTTPClient,
			Credentials: d.squareCredentialResolver(),
		}
	}
	out, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
	if err != nil {
		retryCursor := squareBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, d.now())
		_ = d.Repo.SetIntegrationSync(ctx, integration.TenantID, integration.ID, retryCursor, d.now(), err)
		return SyncRequest{}, retryCursorBase, err
	}
	return out, retryCursorBase, nil
}

func commerceProviderRetryCursor(provider, cursor, status string, retryErr error, now time.Time) (string, bool) {
	switch provider {
	case ProviderWooCommerce:
		return wooCommerceBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderBigCommerce:
		return bigCommerceBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderStripe:
		return stripeBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderPayPal:
		return payPalBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderSquare:
		return squareBackfillRetryCursor(cursor, status, retryErr, now), true
	default:
		return "", false
	}
}

func (d *Deps) bigCommerceCredentialResolver() BigCommerceCredentialResolver {
	if d == nil {
		return nil
	}
	if d.BigCommerceCredentials != nil {
		return d.BigCommerceCredentials
	}
	if resolver, ok := d.CredentialResolver.(BigCommerceCredentialResolver); ok {
		return resolver
	}
	return nil
}

func (d *Deps) stripeCredentialResolver() StripeCredentialResolver {
	if d == nil {
		return nil
	}
	if d.StripeCredentials != nil {
		return d.StripeCredentials
	}
	if resolver, ok := d.CredentialResolver.(StripeCredentialResolver); ok {
		return resolver
	}
	return nil
}

func (d *Deps) squareCredentialResolver() SquareCredentialResolver {
	if d == nil {
		return nil
	}
	if d.SquareCredentials != nil {
		return d.SquareCredentials
	}
	if resolver, ok := d.CredentialResolver.(SquareCredentialResolver); ok {
		return resolver
	}
	return nil
}

func (d *Deps) payPalCredentialResolver() PayPalCredentialResolver {
	if d == nil {
		return nil
	}
	if d.PayPalCredentials != nil {
		return d.PayPalCredentials
	}
	if resolver, ok := d.CredentialResolver.(PayPalCredentialResolver); ok {
		return resolver
	}
	return nil
}

func (d *Deps) payPalWebhookVerifier() PayPalWebhookVerifier {
	if d == nil {
		return nil
	}
	if d.PayPalWebhookVerifier != nil {
		return d.PayPalWebhookVerifier
	}
	return PayPalRESTWebhookVerifier{
		HTTPClient:  d.HTTPClient,
		Credentials: d.payPalCredentialResolver(),
	}
}

func (d *Deps) payPalWebhookResourceFetcher() PayPalWebhookResourceFetcher {
	if d == nil {
		return nil
	}
	if d.PayPalResourceFetcher != nil {
		return d.PayPalResourceFetcher
	}
	return PayPalRESTWebhookResourceFetcher{HTTPClient: d.HTTPClient}
}

func (d *Deps) razorpayCredentialResolver() RazorpayCredentialResolver {
	if d == nil {
		return nil
	}
	if d.RazorpayCredentials != nil {
		return d.RazorpayCredentials
	}
	if resolver, ok := d.CredentialResolver.(RazorpayCredentialResolver); ok {
		return resolver
	}
	return nil
}

func (d *Deps) adobeCommerceCredentialResolver() AdobeCommerceCredentialResolver {
	if d == nil {
		return nil
	}
	if d.AdobeCommerceCredentials != nil {
		return d.AdobeCommerceCredentials
	}
	if resolver, ok := d.CredentialResolver.(AdobeCommerceCredentialResolver); ok {
		return resolver
	}
	return nil
}

func (d *Deps) wixStoresCredentialResolver() WixStoresCredentialResolver {
	if d == nil {
		return nil
	}
	if d.WixStoresCredentials != nil {
		return d.WixStoresCredentials
	}
	if resolver, ok := d.CredentialResolver.(WixStoresCredentialResolver); ok {
		return resolver
	}
	return nil
}

func (d *Deps) squarespaceCredentialResolver() SquarespaceCredentialResolver {
	if d == nil {
		return nil
	}
	if d.SquarespaceCredentials != nil {
		return d.SquarespaceCredentials
	}
	if resolver, ok := d.CredentialResolver.(SquarespaceCredentialResolver); ok {
		return resolver
	}
	return nil
}

func (d *Deps) squarespaceRecordFetcher() SquarespaceRecordFetcher {
	if d == nil {
		return nil
	}
	if d.SquarespaceRecordFetcher != nil {
		return d.SquarespaceRecordFetcher
	}
	return SquarespaceRESTBackfiller{
		HTTPClient:  d.HTTPClient,
		Credentials: d.squarespaceCredentialResolver(),
	}
}

func (d *Deps) shopifyBackfillRequest(ctx context.Context, tenantID, integrationID, cursor string) (SyncRequest, bool, error) {
	integration, err := d.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return SyncRequest{}, false, nil
		}
		return SyncRequest{}, false, err
	}
	if integration == nil || integration.Provider != ProviderShopify {
		return SyncRequest{}, false, nil
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	backfiller := d.ShopifyBackfiller
	if backfiller == nil {
		backfiller = ShopifyAdminGraphQLBackfiller{HTTPClient: d.HTTPClient}
	}
	out, err := backfiller.BackfillPage(ctx, *integration, cursor)
	return out, true, err
}

func (d *Deps) shopifyBulkBackfill(ctx context.Context, tenantID, integrationID, cursor string, maxPages int) (ShopifyBulkBackfillSummary, error) {
	backfiller := d.ShopifyBackfiller
	if backfiller == nil {
		backfiller = ShopifyAdminGraphQLBackfiller{HTTPClient: d.HTTPClient}
	}
	runner := ShopifyBulkBackfillRunner{
		Store:      d.Repo,
		Backfiller: backfiller,
		MaxPages:   maxPages,
		Now:        d.now,
	}
	return runner.Run(ctx, tenantID, integrationID, cursor)
}

func (d *Deps) shopifyAsyncBulkBackfill(ctx context.Context, tenantID, integrationID, cursor, object string) (ShopifyAsyncBulkBackfillSummary, error) {
	integration, err := d.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	if integration == nil {
		return ShopifyAsyncBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderShopify {
		return ShopifyAsyncBulkBackfillSummary{}, fmt.Errorf("shopify async bulk backfill requires a Shopify integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	operator := d.ShopifyBulkOperator
	if operator == nil {
		operator = ShopifyAdminGraphQLBulkOperator{HTTPClient: d.HTTPClient}
	}
	var summary ShopifyAsyncBulkBackfillSummary
	state, ok, decodeErr := decodeShopifyBulkOperationCursor(cursor)
	if decodeErr != nil {
		return ShopifyAsyncBulkBackfillSummary{}, decodeErr
	}
	if ok {
		summary, err = operator.PollBulkBackfill(ctx, *integration, state.OperationID, state.Object)
	} else {
		if strings.TrimSpace(object) == "" {
			backfillState, cursorErr := decodeShopifyBackfillCursor(cursor)
			if cursorErr != nil {
				return ShopifyAsyncBulkBackfillSummary{}, cursorErr
			}
			object = backfillState.Object
		}
		summary, err = operator.StartBulkBackfill(ctx, *integration, object)
	}
	if err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	if strings.EqualFold(summary.Status, "COMPLETED") && strings.TrimSpace(summary.ResultURL) != "" {
		return d.importShopifyAsyncBulkResult(ctx, tenantID, integrationID, *integration, summary)
	}
	if strings.EqualFold(summary.Status, "COMPLETED") {
		return d.completeShopifyAsyncBulkWithoutResult(ctx, tenantID, integrationID, summary)
	}
	if strings.TrimSpace(summary.Cursor) == "" && strings.TrimSpace(summary.OperationID) != "" {
		summary.Cursor = encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{
			Object:      firstNonEmpty(summary.Object, object, "customers"),
			OperationID: summary.OperationID,
		})
	}
	syncErr := shopifyBulkOperationSyncError(summary)
	if syncErr != nil {
		if state, ok, err := decodeShopifyBulkOperationCursor(summary.Cursor); err == nil && ok {
			summary.Cursor = shopifyBulkOperationRetryCursor(state, summary.Status, syncErr, d.now())
			summary.Message = "Shopify bulk operation failed; retry metadata was recorded for operator review."
		}
	}
	if err := d.Repo.SetIntegrationSync(ctx, tenantID, integrationID, summary.Cursor, d.now(), syncErr); err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	return summary, nil
}

func (d *Deps) completeShopifyAsyncBulkWithoutResult(ctx context.Context, tenantID, integrationID string, summary ShopifyAsyncBulkBackfillSummary) (ShopifyAsyncBulkBackfillSummary, error) {
	object := normalizeShopifyBackfillObject(summary.Object)
	summary.Cursor = encodeShopifyBackfillCursor(shopifyBackfillState{Object: nextShopifyBackfillObject(object)})
	summary.ResultURLPresent = false
	summary.Message = "Shopify bulk operation completed with no result URL; treated as no records and advanced to the next resource."
	if err := d.Repo.SetIntegrationSync(ctx, tenantID, integrationID, summary.Cursor, d.now(), nil); err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	return summary, nil
}

func (d *Deps) importShopifyAsyncBulkResult(ctx context.Context, tenantID, integrationID string, integration Integration, summary ShopifyAsyncBulkBackfillSummary) (ShopifyAsyncBulkBackfillSummary, error) {
	importer := d.ShopifyBulkImporter
	if importer == nil {
		importer = ShopifyJSONLBulkResultImporter{HTTPClient: d.HTTPClient}
	}
	return shopifyAsyncBulkResultImportRunner{
		Store:    d.Repo,
		Importer: importer,
		Now:      d.now,
	}.Import(ctx, tenantID, integrationID, integration, summary)
}

func shopifyBulkOperationSyncError(summary ShopifyAsyncBulkBackfillSummary) error {
	switch strings.ToUpper(strings.TrimSpace(summary.Status)) {
	case "FAILED", "CANCELED", "CANCELING":
		msg := "shopify bulk operation " + strings.ToLower(summary.Status)
		if strings.TrimSpace(summary.ErrorCode) != "" {
			msg += ": " + summary.ErrorCode
		}
		return errors.New(msg)
	default:
		return nil
	}
}

func isAsyncShopifyBulkBackfillRequest(r *http.Request) bool {
	if r == nil || !strings.HasSuffix(r.URL.Path, "/backfill") {
		return false
	}
	q := r.URL.Query()
	mode := strings.TrimSpace(q.Get("mode"))
	return strings.EqualFold(mode, "bulk_async") ||
		strings.EqualFold(mode, "async_bulk") ||
		strings.EqualFold(mode, "graphql_bulk") ||
		strings.EqualFold(q.Get("async_bulk"), "true")
}

func isBulkShopifyBackfillRequest(r *http.Request) bool {
	if r == nil || !strings.HasSuffix(r.URL.Path, "/backfill") {
		return false
	}
	q := r.URL.Query()
	return strings.EqualFold(q.Get("mode"), "bulk") || strings.EqualFold(q.Get("bulk"), "true")
}

func shopifyAsyncBulkObjectFromRequest(r *http.Request) string {
	if r == nil {
		return ""
	}
	return normalizeShopifyBackfillObject(firstNonEmpty(r.URL.Query().Get("object"), r.URL.Query().Get("resource")))
}

func shopifyBulkBackfillMaxPagesFromRequest(r *http.Request) int {
	if r == nil {
		return 0
	}
	raw := strings.TrimSpace(firstNonEmpty(r.URL.Query().Get("pages"), r.URL.Query().Get("max_pages")))
	if raw == "" {
		return 0
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0
	}
	return n
}

func writeShopifyBackfillError(w http.ResponseWriter, err error) {
	var httpErr *ShopifyGraphQLHTTPError
	if errors.As(err, &httpErr) {
		status := http.StatusBadGateway
		code := "shopify_graphql_failed"
		if httpErr.StatusCode == http.StatusTooManyRequests {
			status = http.StatusTooManyRequests
			code = "shopify_rate_limited"
			if httpErr.RetryAfter > 0 {
				w.Header().Set("Retry-After", strconv.Itoa(int(httpErr.RetryAfter.Seconds())))
			}
		}
		httperror.Write(w, status, code, httperror.MessageForStatus(status))
		return
	}
	var gqlErr *ShopifyGraphQLErrors
	if errors.As(err, &gqlErr) {
		httperror.Write(w, http.StatusBadGateway, "shopify_graphql_error", httperror.MessageInternal)
		return
	}
	httperror.Write(w, http.StatusUnprocessableEntity, "shopify_backfill_unavailable", httperror.MessageForStatus(http.StatusUnprocessableEntity))
}

func writeCommerceBackfillError(w http.ResponseWriter, err error) {
	var httpErr *ShopifyGraphQLHTTPError
	if errors.As(err, &httpErr) {
		writeShopifyBackfillError(w, err)
		return
	}
	var gqlErr *ShopifyGraphQLErrors
	if errors.As(err, &gqlErr) {
		writeShopifyBackfillError(w, err)
		return
	}
	httperror.Write(w, http.StatusUnprocessableEntity, "commerce_backfill_unavailable", httperror.MessageForStatus(http.StatusUnprocessableEntity))
}

func (d *Deps) ListCustomers(w http.ResponseWriter, r *http.Request) {
	d.listCommerceResource(w, r, func(ctx context.Context, tenantID, integrationID string, limit int, cursor pagination.Cursor) (any, error) {
		return d.Repo.ListCustomers(ctx, tenantID, integrationID, limit, cursor)
	})
}

func (d *Deps) ListProducts(w http.ResponseWriter, r *http.Request) {
	d.listCommerceResource(w, r, func(ctx context.Context, tenantID, integrationID string, limit int, cursor pagination.Cursor) (any, error) {
		return d.Repo.ListProducts(ctx, tenantID, integrationID, limit, cursor)
	})
}

func (d *Deps) ListProductVariants(w http.ResponseWriter, r *http.Request) {
	d.listProductResource(w, r, func(ctx context.Context, tenantID, integrationID, productID string, limit int, cursor pagination.Cursor) (any, error) {
		return d.Repo.ListProductVariants(ctx, tenantID, integrationID, productID, limit, cursor)
	})
}

func (d *Deps) ListInventorySnapshots(w http.ResponseWriter, r *http.Request) {
	d.listProductResource(w, r, func(ctx context.Context, tenantID, integrationID, productID string, limit int, cursor pagination.Cursor) (any, error) {
		return d.Repo.ListInventorySnapshots(ctx, tenantID, integrationID, productID, limit, cursor)
	})
}

func (d *Deps) ListPriceHistory(w http.ResponseWriter, r *http.Request) {
	d.listProductResource(w, r, func(ctx context.Context, tenantID, integrationID, productID string, limit int, cursor pagination.Cursor) (any, error) {
		return d.Repo.ListPriceHistory(ctx, tenantID, integrationID, productID, limit, cursor)
	})
}

func (d *Deps) ListOrders(w http.ResponseWriter, r *http.Request) {
	d.listCommerceResource(w, r, func(ctx context.Context, tenantID, integrationID string, limit int, cursor pagination.Cursor) (any, error) {
		return d.Repo.ListOrders(ctx, tenantID, integrationID, limit, cursor)
	})
}

func (d *Deps) ListEvents(w http.ResponseWriter, r *http.Request) {
	d.listCommerceResource(w, r, func(ctx context.Context, tenantID, integrationID string, limit int, cursor pagination.Cursor) (any, error) {
		return d.Repo.ListEvents(ctx, tenantID, integrationID, limit, cursor)
	})
}

func (d *Deps) Analytics(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.Analytics(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type commerceListFunc func(context.Context, string, string, int, pagination.Cursor) (any, error)
type commerceStatusListFunc func(context.Context, string, string, string, int, pagination.Cursor) (any, error)
type productListFunc func(context.Context, string, string, string, int, pagination.Cursor) (any, error)

func (d *Deps) listCommerceResource(w http.ResponseWriter, r *http.Request, list commerceListFunc) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 50, 200)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	out, err := list(r.Context(), t.ID, chi.URLParam(r, "id"), limit, cursor)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) listCommerceStatusResource(w http.ResponseWriter, r *http.Request, list commerceStatusListFunc) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 50, 200)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	status := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("status")))
	out, err := list(r.Context(), t.ID, chi.URLParam(r, "id"), status, limit, cursor)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) listProductResource(w http.ResponseWriter, r *http.Request, list productListFunc) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 50, 200)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	out, err := list(r.Context(), t.ID, chi.URLParam(r, "id"), chi.URLParam(r, "product_id"), limit, cursor)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "product not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func validCartRecoveryStatus(status string) bool {
	switch status {
	case "active", "converted", "expired", "disabled":
		return true
	default:
		return false
	}
}

func (d *Deps) ShopifyWebhook(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 4 << 20
	body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Shopify webhook payload exceeds 4 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	shop := NormalizeShopDomain(firstNonEmpty(
		r.Header.Get("X-Shopify-Shop-Domain"),
		r.URL.Query().Get("shop"),
	))
	if !ValidShopifyShopDomain(shop) {
		httperror.Write(w, http.StatusBadRequest, "missing_shop", "X-Shopify-Shop-Domain is required")
		return
	}
	integration, err := d.Repo.FindShopifyIntegrationByShop(r.Context(), shop)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "shopify integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	secret := firstNonEmpty(integration.WebhookSecret, d.Config.ShopifyWebhookSecret, d.Config.ShopifyClientSecret)
	sig := r.Header.Get("X-Shopify-Hmac-Sha256")
	if secret == "" || sig == "" {
		if !d.Config.AllowUnsignedShopifyWebhooks {
			httperror.Write(w, http.StatusUnauthorized, "invalid_hmac", "missing Shopify webhook signature or secret")
			return
		}
	} else if err := VerifyShopifyWebhookHMAC(secret, body, sig); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_hmac", "request authentication failed")
		return
	}
	// X-Shopify-Triggered-At freshness check (integration-auth HIGH #4).
	// Shopify's HMAC doesn't bind a timestamp, so a captured (body,
	// signature) pair could be replayed indefinitely. Shopify sends
	// X-Shopify-Triggered-At (RFC3339) on every webhook — we reject when
	// the request is more than 5 min stale. Attackers who control
	// the Triggered-At header on a captured body still bypass this (the
	// HMAC doesn't bind the header), but the check catches casual
	// replay-from-log attacks and matches the Postmark pattern.
	if raw := strings.TrimSpace(firstNonEmpty(
		r.Header.Get("X-Shopify-Triggered-At"),
		r.Header.Get("X-Shopify-Sent-At"),
	)); raw != "" {
		if sent, perr := time.Parse(time.RFC3339, raw); perr == nil {
			drift := time.Since(sent)
			if drift < 0 {
				drift = -drift
			}
			if drift > 5*time.Minute {
				httperror.Write(w, http.StatusUnauthorized, "stale_request",
					"X-Shopify-Triggered-At drifts more than 5 min from server clock")
				return
			}
		}
	}
	topic := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Shopify-Topic")))
	if topic == "" {
		topic = strings.ToLower(strings.TrimSpace(r.URL.Query().Get("topic")))
	}
	webhookID := firstNonEmpty(r.Header.Get("X-Shopify-Webhook-Id"), localWebhookID(shop, topic, body))
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderShopify, webhookID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		w.WriteHeader(http.StatusOK)
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "webhook is already being processed")
		return
	}
	if err := d.dispatchShopifyWebhook(r.Context(), integration, topic, body); err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderShopify, webhookID, err)
		if d.Logger != nil {
			d.Logger.Warn("shopify webhook dispatch failed", "shop", shop, "topic", topic, "err", err.Error())
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderShopify, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (d *Deps) WooCommerceWebhook(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 4 << 20
	body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "WooCommerce webhook payload exceeds 4 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	source, err := normalizeWooCommerceStoreOrigin(firstNonEmpty(
		r.Header.Get("X-WC-Webhook-Source"),
		r.URL.Query().Get("store_url"),
	))
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "missing_source", "X-WC-Webhook-Source is required")
		return
	}
	integration, err := d.Repo.FindWooCommerceIntegrationByStoreURL(r.Context(), source)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "woocommerce integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	secret := strings.TrimSpace(integration.WebhookSecret)
	sig := r.Header.Get("X-WC-Webhook-Signature")
	if secret == "" || sig == "" {
		httperror.Write(w, http.StatusUnauthorized, "invalid_hmac", "missing WooCommerce webhook signature or secret")
		return
	}
	if err := VerifyWooCommerceWebhookSignature(secret, body, sig); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_hmac", "request authentication failed")
		return
	}
	topic := normalizeWooCommerceWebhookTopic(firstNonEmpty(
		r.Header.Get("X-WC-Webhook-Topic"),
		wooCommerceTopicFromResourceEvent(r.Header.Get("X-WC-Webhook-Resource"), r.Header.Get("X-WC-Webhook-Event")),
		r.URL.Query().Get("topic"),
	))
	if topic == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_topic", "X-WC-Webhook-Topic is required")
		return
	}
	webhookID := wooCommerceWebhookID(source, topic, body, r.Header.Get("X-WC-Webhook-ID"), r.Header.Get("X-WC-Webhook-Delivery-ID"))
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderWooCommerce, webhookID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		w.WriteHeader(http.StatusOK)
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "webhook is already being processed")
		return
	}
	if err := d.dispatchWooCommerceWebhook(r.Context(), integration, topic, body); err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderWooCommerce, webhookID, err)
		if d.Logger != nil {
			d.Logger.Warn("woocommerce webhook dispatch failed", "source", source, "topic", topic, "err", err.Error())
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderWooCommerce, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (d *Deps) BigCommerceWebhook(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 1 << 20
	body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "BigCommerce webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeBigCommerceWebhookBody(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	storeHash, err := bigCommerceWebhookStoreHash(payload, r.URL.Query().Get("store_hash"))
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "missing_source", err.Error())
		return
	}
	integration, err := d.Repo.FindBigCommerceIntegrationByStoreHash(r.Context(), storeHash)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "bigcommerce integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := verifyBigCommerceWebhookSecret(integration.WebhookSecret, r.Header.Get(bigCommerceWebhookSecretHeader)); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_webhook_secret", "request authentication failed")
		return
	}
	topic := normalizeBigCommerceWebhookScope(firstNonEmpty(payload.Scope, r.URL.Query().Get("scope")))
	if topic == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_scope", "BigCommerce webhook scope is required")
		return
	}
	webhookID := bigCommerceWebhookID(storeHash, topic, payload, body, r.Header.Get("X-Bc-Webhook-Id"), r.Header.Get("X-BigCommerce-Webhook-Id"))
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderBigCommerce, webhookID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		w.WriteHeader(http.StatusOK)
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "webhook is already being processed")
		return
	}
	if err := d.dispatchBigCommerceWebhook(r.Context(), integration, payload); err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderBigCommerce, webhookID, err)
		if d.Logger != nil {
			d.Logger.Warn("bigcommerce webhook dispatch failed", "store_hash", storeHash, "topic", topic, "err", err.Error())
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderBigCommerce, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (d *Deps) StripeWebhook(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 1 << 20
	body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Stripe webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	event, err := decodeStripeWebhookEvent(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	accountID := stripeWebhookAccountID(event, r.URL.Query().Get("account_id"))
	if accountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "Stripe webhook account ID is required")
		return
	}
	integration, err := d.Repo.FindStripeIntegrationByAccountID(r.Context(), accountID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "stripe integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resolver := d.stripeCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Stripe credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveStripe(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if strings.TrimSpace(creds.WebhookSecret) == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_secret", "Stripe webhook signing secret is not configured")
		return
	}
	if err := VerifyStripeWebhookSignature(creds.WebhookSecret, r.Header.Get("Stripe-Signature"), body, d.now(), 0); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	topic := strings.TrimSpace(event.Type)
	if topic == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_type", "Stripe webhook event type is required")
		return
	}
	webhookID := firstNonEmpty(strings.TrimSpace(event.ID), localWebhookID(accountID, topic, body))
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderStripe, webhookID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		w.WriteHeader(http.StatusOK)
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "webhook is already being processed")
		return
	}
	if err := d.dispatchStripeWebhook(r.Context(), integration, event); err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderStripe, webhookID, err)
		if d.Logger != nil {
			d.Logger.Warn("stripe webhook dispatch failed", "account_id", accountID, "topic", topic, "err", err.Error())
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderStripe, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (d *Deps) SquareWebhook(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 1 << 20
	body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Square webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	event, err := decodeSquareWebhookEvent(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	if event.MerchantID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_merchant_id", "Square webhook merchant_id is required")
		return
	}
	integration, err := d.Repo.FindSquareIntegrationByMerchantID(r.Context(), event.MerchantID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "square integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resolver := d.squareCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Square credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveSquare(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if strings.TrimSpace(creds.WebhookSignatureKey) == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_signature_key", "Square webhook signature key is not configured")
		return
	}
	notificationURL := squareWebhookNotificationURL(r, integration)
	if err := VerifySquareWebhookSignature(creds.WebhookSignatureKey, notificationURL, body, r.Header.Get("x-square-hmacsha256-signature")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	topic := strings.TrimSpace(event.Type)
	if topic == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_type", "Square webhook event type is required")
		return
	}
	webhookID := firstNonEmpty(event.EventID, localWebhookID(event.MerchantID, topic, body))
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderSquare, webhookID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		w.WriteHeader(http.StatusOK)
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "webhook is already being processed")
		return
	}
	if err := d.dispatchSquareWebhook(r.Context(), integration, event); err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderSquare, webhookID, err)
		if d.Logger != nil {
			d.Logger.Warn("square webhook dispatch failed", "merchant_id", event.MerchantID, "topic", topic, "err", err.Error())
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderSquare, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (d *Deps) PayPalWebhook(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 1 << 20
	body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "PayPal webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	event, err := decodePayPalWebhookEvent(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	merchantID := firstNonEmpty(payPalMerchantIDFromWebhook(event), strings.TrimSpace(r.URL.Query().Get("merchant_id")))
	if merchantID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_merchant_id", "PayPal webhook merchant_id could not be resolved")
		return
	}
	integration, err := d.Repo.FindPayPalIntegrationByMerchantID(r.Context(), merchantID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "paypal integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resolver := d.payPalCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "PayPal credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolvePayPal(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if strings.TrimSpace(creds.WebhookID) == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_id", "PayPal webhook ID is not configured")
		return
	}
	verifier := d.payPalWebhookVerifier()
	if verifier == nil {
		httperror.Write(w, http.StatusInternalServerError, "webhook_verifier_not_configured", "PayPal webhook verifier is not configured")
		return
	}
	if err := verifier.VerifyPayPalWebhook(r.Context(), creds, event, r.Header, body); err != nil {
		writePayPalWebhookVerificationError(w, err)
		return
	}
	topic := strings.TrimSpace(event.EventType)
	if topic == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_event_type", "PayPal webhook event_type is required")
		return
	}
	webhookID := firstNonEmpty(strings.TrimSpace(event.ID), strings.TrimSpace(r.Header.Get("Paypal-Transmission-Id")), localWebhookID(merchantID, topic, body))
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderPayPal, webhookID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		w.WriteHeader(http.StatusOK)
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "webhook is already being processed")
		return
	}
	if payPalWebhookShouldFetchResource(event) {
		fetcher := d.payPalWebhookResourceFetcher()
		if fetcher != nil {
			event, err = fetcher.FetchPayPalWebhookResource(r.Context(), integration.TenantID, *integration, creds, event)
			if err != nil {
				_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderPayPal, webhookID, err)
				if d.Logger != nil {
					d.Logger.Warn("paypal webhook resource fetch failed", "merchant_id", merchantID, "topic", topic, "err", err.Error())
				}
				httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
			if err := payPalValidateWebhookMerchant(merchantID, event); err != nil {
				_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderPayPal, webhookID, err)
				if d.Logger != nil {
					d.Logger.Warn("paypal webhook merchant mismatch", "merchant_id", merchantID, "topic", topic, "err", err.Error())
				}
				httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
		}
	}
	if err := d.dispatchPayPalWebhook(r.Context(), integration, event); err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderPayPal, webhookID, err)
		if d.Logger != nil {
			d.Logger.Warn("paypal webhook dispatch failed", "merchant_id", merchantID, "topic", topic, "err", err.Error())
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderPayPal, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func writePayPalWebhookVerificationError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrInvalidSignature) {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	var rateLimit PayPalRateLimitError
	if errors.As(err, &rateLimit) {
		if retryAfter := retryAfterHeaderValue(rateLimit.RetryAfter); retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_verification_retryable", httperror.MessageInternal)
		return
	}
	httperror.Write(w, http.StatusBadGateway, "webhook_verification_failed", httperror.MessageInternal)
}

func retryAfterHeaderValue(delay time.Duration) string {
	if delay <= 0 {
		return ""
	}
	seconds := int64((delay + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	return strconv.FormatInt(seconds, 10)
}

func (d *Deps) RazorpayWebhook(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 1 << 20
	body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Razorpay webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	event, err := decodeRazorpayWebhookEvent(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	if event.AccountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "Razorpay webhook account_id is required")
		return
	}
	integration, err := d.Repo.FindRazorpayIntegrationByAccountID(r.Context(), event.AccountID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "razorpay integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resolver := d.razorpayCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Razorpay credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveRazorpay(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if strings.TrimSpace(creds.WebhookSecret) == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_secret", "Razorpay webhook signing secret is not configured")
		return
	}
	if err := VerifyRazorpayWebhookSignature(creds.WebhookSecret, body, r.Header.Get("X-Razorpay-Signature")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	topic := strings.TrimSpace(event.Event)
	if topic == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_event", "Razorpay webhook event is required")
		return
	}
	webhookID := firstNonEmpty(strings.TrimSpace(r.Header.Get("x-razorpay-event-id")), localWebhookID(event.AccountID, topic, body))
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderRazorpay, webhookID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		w.WriteHeader(http.StatusOK)
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "webhook is already being processed")
		return
	}
	if err := d.dispatchRazorpayWebhook(r.Context(), integration, event); err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderRazorpay, webhookID, err)
		if d.Logger != nil {
			d.Logger.Warn("razorpay webhook dispatch failed", "account_id", event.AccountID, "topic", topic, "err", err.Error())
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderRazorpay, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (d *Deps) ShopifyPrivacyWebhook(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 1 << 20
	body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Shopify privacy webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := parseShopifyPrivacyWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	shop := NormalizeShopDomain(firstNonEmpty(
		r.Header.Get("X-Shopify-Shop-Domain"),
		payload.ShopDomain,
		r.URL.Query().Get("shop"),
	))
	if !ValidShopifyShopDomain(shop) {
		httperror.Write(w, http.StatusBadRequest, "missing_shop", "X-Shopify-Shop-Domain or shop_domain is required")
		return
	}
	topic := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		r.Header.Get("X-Shopify-Topic"),
		r.URL.Query().Get("topic"),
	)))
	if topic == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_topic", "X-Shopify-Topic is required")
		return
	}
	if topic != "customers/data_request" && topic != "customers/redact" && topic != "shop/redact" {
		httperror.Write(w, http.StatusUnprocessableEntity, "unsupported_topic", "unsupported Shopify privacy topic")
		return
	}

	integration, lookupErr := d.Repo.FindShopifyIntegrationByShop(r.Context(), shop)
	if lookupErr != nil && !errors.Is(lookupErr, ErrNotFound) {
		httperror.WriteInternal(w, d.Logger, lookupErr, r.Context())
		return
	}
	secret := firstNonEmpty(d.Config.ShopifyWebhookSecret, d.Config.ShopifyClientSecret)
	if secret == "" && integration != nil {
		secret = integration.WebhookSecret
	}
	sig := r.Header.Get("X-Shopify-Hmac-Sha256")
	if secret == "" || sig == "" {
		if !d.Config.AllowUnsignedShopifyWebhooks {
			httperror.Write(w, http.StatusUnauthorized, "invalid_hmac", "missing Shopify privacy webhook signature or secret")
			return
		}
	} else if err := VerifyShopifyWebhookHMAC(secret, body, sig); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_hmac", "request authentication failed")
		return
	}
	if !shopifyWebhookFresh(r) {
		httperror.Write(w, http.StatusUnauthorized, "stale_request",
			"X-Shopify-Triggered-At drifts more than 5 min from server clock")
		return
	}
	if integration == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}

	webhookID := firstNonEmpty(r.Header.Get("X-Shopify-Webhook-Id"), localWebhookID(shop, topic, body))
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderShopify, webhookID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		w.WriteHeader(http.StatusOK)
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "webhook is already being processed")
		return
	}

	if err := d.dispatchShopifyPrivacyWebhook(r.Context(), integration, topic, payload); err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderShopify, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderShopify, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (d *Deps) dispatchShopifyPrivacyWebhook(ctx context.Context, integration *Integration, topic string, payload shopifyPrivacyWebhookPayload) error {
	switch topic {
	case "customers/data_request":
		_, err := d.Repo.CollectShopifyCustomerDataRequest(ctx, integration.TenantID, integration.ID, payload.customerDataRequest(), d.now())
		return err
	case "customers/redact":
		return d.Repo.RedactShopifyCustomer(ctx, integration.TenantID, integration.ID, payload.customerRedaction())
	case "shop/redact":
		return d.Repo.DeleteIntegration(ctx, integration.TenantID, integration.ID)
	default:
		return nil
	}
}

func (d *Deps) dispatchShopifyWebhook(ctx context.Context, integration *Integration, topic string, body []byte) error {
	switch topic {
	case "customers/create", "customers/update", "customers/enable", "customers/disable":
		in, err := ShopifyCustomerInput(body)
		if err != nil {
			return err
		}
		if in.SourceID == "" {
			return fmt.Errorf("shopify customer missing id")
		}
		return d.Repo.UpsertCustomer(ctx, integration.TenantID, integration.ID, in)
	case "products/create", "products/update":
		in, err := ShopifyProductInput(body)
		if err != nil {
			return err
		}
		if in.SourceID == "" || in.Title == "" {
			return fmt.Errorf("shopify product missing id or title")
		}
		return d.Repo.UpsertProduct(ctx, integration.TenantID, integration.ID, in)
	case "orders/create", "orders/updated", "orders/paid", "orders/cancelled", "orders/fulfilled", "refunds/create":
		in, err := ShopifyOrderInput(body)
		if err != nil {
			return err
		}
		if in.SourceID == "" {
			return fmt.Errorf("shopify order missing id")
		}
		return d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, in)
	case "carts/create", "carts/update", "checkouts/create", "checkouts/update":
		in, ok, err := ShopifyCartRecoveryLinkInput(body)
		if err != nil {
			return err
		}
		if !ok {
			return nil
		}
		_, err = d.Repo.UpsertCartRecoveryLink(ctx, integration.TenantID, integration.ID, in)
		return err
	case "bulk_operations/finish":
		return d.recordShopifyBulkOperationFinish(ctx, integration, body)
	case "app/uninstalled":
		return d.Repo.MarkShopifyUninstalled(ctx, integration.TenantID, integration.ID)
	default:
		return nil
	}
}

func (d *Deps) dispatchWooCommerceWebhook(ctx context.Context, integration *Integration, topic string, body []byte) error {
	raw, err := decodeWooCommerceWebhookBody(body)
	if err != nil {
		return err
	}
	switch normalizeWooCommerceWebhookTopic(topic) {
	case "coupon.created", "coupon.updated", "coupon.deleted":
		event := wooCommerceCouponEvent(topic, raw)
		if event.SourceID == "" {
			return fmt.Errorf("woocommerce coupon webhook missing id")
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, event)
	case "subscription.created", "subscription.updated", "subscription.deleted":
		event := wooCommerceSubscriptionEvent(topic, raw)
		if event.SourceID == "" {
			return fmt.Errorf("woocommerce subscription webhook missing id")
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, event)
	case "customer.created", "customer.updated":
		req, err := wooCommerceSyncRequest("customers", []map[string]any{raw})
		if err != nil {
			return err
		}
		if len(req.Customers) != 1 || req.Customers[0].SourceID == "" {
			return fmt.Errorf("woocommerce customer missing id")
		}
		return d.Repo.UpsertCustomer(ctx, integration.TenantID, integration.ID, req.Customers[0])
	case "product.created", "product.updated":
		req, err := wooCommerceSyncRequest("products", []map[string]any{raw})
		if err != nil {
			return err
		}
		if len(req.Products) != 1 || req.Products[0].SourceID == "" || req.Products[0].Title == "" {
			return fmt.Errorf("woocommerce product missing id or title")
		}
		return d.Repo.UpsertProduct(ctx, integration.TenantID, integration.ID, req.Products[0])
	case "order.created", "order.updated":
		req, err := wooCommerceSyncRequest("orders", []map[string]any{raw})
		if err != nil {
			return err
		}
		if len(req.Orders) != 1 || req.Orders[0].SourceID == "" {
			return fmt.Errorf("woocommerce order missing id")
		}
		return d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, req.Orders[0])
	case "customer.deleted":
		deletion := wooCommerceDeletion("customer", topic, raw)
		if deletion.SourceID == "" {
			return fmt.Errorf("woocommerce customer delete missing id")
		}
		return d.Repo.DeleteCustomer(ctx, integration.TenantID, integration.ID, deletion)
	case "product.deleted":
		deletion := wooCommerceDeletion("product", topic, raw)
		if deletion.SourceID == "" {
			return fmt.Errorf("woocommerce product delete missing id")
		}
		return d.Repo.DeleteProduct(ctx, integration.TenantID, integration.ID, deletion)
	case "order.deleted":
		deletion := wooCommerceDeletion("order", topic, raw)
		if deletion.SourceID == "" {
			return fmt.Errorf("woocommerce order delete missing id")
		}
		return d.Repo.DeleteOrder(ctx, integration.TenantID, integration.ID, deletion)
	default:
		return nil
	}
}

func (d *Deps) dispatchBigCommerceWebhook(ctx context.Context, integration *Integration, payload bigCommerceWebhookPayload) error {
	if integration == nil {
		return nil
	}
	fetcher := d.bigCommerceRecordFetcher()
	if fetcher == nil {
		return fmt.Errorf("bigcommerce record fetcher is not configured")
	}
	resourceID := bigCommerceWebhookResourceID(payload)
	if resourceID == "" || resourceID == "<nil>" {
		return fmt.Errorf("bigcommerce webhook missing resource id")
	}
	switch normalizeBigCommerceWebhookScope(payload.Scope) {
	case "store/customer/created", "store/customer/updated":
		in, err := fetcher.FetchCustomer(ctx, integration.TenantID, *integration, resourceID)
		if err != nil {
			return err
		}
		if in.SourceID == "" {
			return fmt.Errorf("bigcommerce customer missing id")
		}
		return d.Repo.UpsertCustomer(ctx, integration.TenantID, integration.ID, in)
	case "store/product/created", "store/product/updated", "store/product/inventory/updated", "store/product/inventory/order/updated":
		in, err := fetcher.FetchProduct(ctx, integration.TenantID, *integration, resourceID)
		if err != nil {
			return err
		}
		if in.SourceID == "" || in.Title == "" {
			return fmt.Errorf("bigcommerce product missing id or title")
		}
		return d.Repo.UpsertProduct(ctx, integration.TenantID, integration.ID, in)
	case "store/order/created", "store/order/updated", "store/order/statusUpdated", "store/order/statusupdated":
		in, err := fetcher.FetchOrder(ctx, integration.TenantID, *integration, resourceID)
		if err != nil {
			return err
		}
		if in.SourceID == "" {
			return fmt.Errorf("bigcommerce order missing id")
		}
		return d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, in)
	case "store/order/refund/created":
		in, err := fetcher.FetchOrder(ctx, integration.TenantID, *integration, resourceID)
		if err != nil {
			return err
		}
		if in.SourceID == "" {
			return fmt.Errorf("bigcommerce order missing id")
		}
		if err := d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, in); err != nil {
			return err
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, bigCommerceRefundEvent(payload))
	case "store/order/transaction/created", "store/order/transaction/updated":
		in, err := fetcher.FetchOrder(ctx, integration.TenantID, *integration, resourceID)
		if err != nil {
			return err
		}
		if in.SourceID == "" {
			return fmt.Errorf("bigcommerce order missing id")
		}
		if err := d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, in); err != nil {
			return err
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, bigCommerceTransactionEvent(payload))
	case "store/customer/deleted", "store/customer/archived":
		return d.Repo.DeleteCustomer(ctx, integration.TenantID, integration.ID, ProviderDeletion{
			SourceID: bigCommerceSourceID("customer", map[string]any{"id": resourceID}),
			Provider: ProviderBigCommerce,
			Topic:    normalizeBigCommerceWebhookScope(payload.Scope),
			Raw:      nonNilMap(payload.Data),
		})
	case "store/product/deleted", "store/product/archived":
		return d.Repo.DeleteProduct(ctx, integration.TenantID, integration.ID, ProviderDeletion{
			SourceID: bigCommerceSourceID("product", map[string]any{"id": resourceID}),
			Provider: ProviderBigCommerce,
			Topic:    normalizeBigCommerceWebhookScope(payload.Scope),
			Raw:      nonNilMap(payload.Data),
		})
	case "store/order/deleted", "store/order/archived":
		return d.Repo.DeleteOrder(ctx, integration.TenantID, integration.ID, ProviderDeletion{
			SourceID: bigCommerceSourceID("order", map[string]any{"id": resourceID}),
			Provider: ProviderBigCommerce,
			Topic:    normalizeBigCommerceWebhookScope(payload.Scope),
			Raw:      nonNilMap(payload.Data),
		})
	default:
		return nil
	}
}

func bigCommerceRefundEvent(payload bigCommerceWebhookPayload) ProviderEventInput {
	topic := normalizeBigCommerceWebhookScope(payload.Scope)
	data := nonNilMap(payload.Data)
	refund := mapField(data, "refund")
	orderID := firstNonEmpty(stringField(data, "id"), stringField(data, "order_id"))
	refundID := firstNonEmpty(stringField(refund, "refund_id"), stringField(data, "refund_id"), payload.Hash, orderID)
	sourceID := bigCommerceSourceID("refund", map[string]any{"id": refundID})
	return ProviderEventInput{
		EventType:       "refund_created",
		Provider:        ProviderBigCommerce,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: "refund_created:" + sourceID,
		Metadata: map[string]any{
			"source":          ProviderBigCommerce,
			"topic":           topic,
			"object":          "refund",
			"source_id":       sourceID,
			"order_source_id": bigCommerceSourceID("order", map[string]any{"id": orderID}),
			"order_id":        orderID,
			"refund_id":       refundID,
			"provider_hash":   payload.Hash,
			"provider_raw":    data,
		},
	}
}

func bigCommerceTransactionEvent(payload bigCommerceWebhookPayload) ProviderEventInput {
	topic := normalizeBigCommerceWebhookScope(payload.Scope)
	eventType := strings.ReplaceAll(strings.TrimPrefix(topic, "store/order/"), "/", "_")
	data := nonNilMap(payload.Data)
	orderID := firstNonEmpty(stringField(data, "order_id"), stringField(data, "id"))
	transactionID := firstNonEmpty(stringField(data, "transaction_id"), payload.Hash, orderID)
	sourceID := bigCommerceSourceID("transaction", map[string]any{"id": transactionID})
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderBigCommerce,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: eventType + ":" + sourceID,
		Metadata: map[string]any{
			"source":                  ProviderBigCommerce,
			"topic":                   topic,
			"object":                  "transaction",
			"source_id":               sourceID,
			"order_source_id":         bigCommerceSourceID("order", map[string]any{"id": orderID}),
			"order_id":                orderID,
			"transaction_id":          transactionID,
			"transaction_status":      stringField(data, "transaction_status"),
			"transaction_type":        stringField(data, "transaction_type"),
			"platform_transaction_id": stringField(data, "platform_transaction_id"),
			"provider_transaction_id": stringField(data, "provider_transaction_id"),
			"result":                  mapField(data, "result"),
			"provider_hash":           payload.Hash,
			"provider_raw":            data,
		},
	}
}

func wooCommerceCouponEvent(topic string, raw map[string]any) ProviderEventInput {
	topic = normalizeWooCommerceWebhookTopic(topic)
	eventType := strings.ReplaceAll(topic, ".", "_")
	sourceID := wooCommerceSourceID("coupon", raw)
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderWooCommerce,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: eventType + ":" + sourceID,
		Metadata: map[string]any{
			"source":        ProviderWooCommerce,
			"topic":         topic,
			"object":        "coupon",
			"source_id":     sourceID,
			"code":          stringField(raw, "code"),
			"discount_type": stringField(raw, "discount_type"),
			"amount":        stringField(raw, "amount"),
			"provider_raw":  nonNilMap(raw),
		},
	}
}

func wooCommerceSubscriptionEvent(topic string, raw map[string]any) ProviderEventInput {
	topic = normalizeWooCommerceWebhookTopic(topic)
	eventType := strings.ReplaceAll(topic, ".", "_")
	sourceID := wooCommerceSourceID("subscription", raw)
	email := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		stringField(mapField(raw, "billing"), "email"),
		stringField(raw, "customer_email"),
		stringField(raw, "email"),
	)))
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderWooCommerce,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: eventType + ":" + sourceID,
		CustomerEmail:   email,
		Metadata: map[string]any{
			"source":               ProviderWooCommerce,
			"topic":                topic,
			"object":               "subscription",
			"source_id":            sourceID,
			"status":               stringField(raw, "status"),
			"customer_email":       email,
			"customer_id":          stringField(raw, "customer_id"),
			"parent_order_id":      stringField(raw, "parent_id"),
			"currency":             strings.ToUpper(stringField(raw, "currency")),
			"total_cents":          cents(raw["total"]),
			"billing_period":       stringField(raw, "billing_period"),
			"billing_interval":     stringField(raw, "billing_interval"),
			"start_date":           firstNonEmpty(stringField(raw, "start_date_gmt"), stringField(raw, "start_date")),
			"trial_end_date":       firstNonEmpty(stringField(raw, "trial_end_date_gmt"), stringField(raw, "trial_end_date")),
			"next_payment_date":    firstNonEmpty(stringField(raw, "next_payment_date_gmt"), stringField(raw, "next_payment_date")),
			"last_payment_date":    firstNonEmpty(stringField(raw, "last_payment_date_gmt"), stringField(raw, "last_payment_date")),
			"end_date":             firstNonEmpty(stringField(raw, "end_date_gmt"), stringField(raw, "end_date")),
			"payment_method":       stringField(raw, "payment_method"),
			"payment_method_title": stringField(raw, "payment_method_title"),
			"transaction_id":       stringField(raw, "transaction_id"),
			"discount_codes":       wooCommerceCouponCodes(raw["coupon_lines"]),
			"coupon_lines":         wooCommerceCouponLines(raw["coupon_lines"]),
			"line_items":           wooCommerceLineItems(raw["line_items"]),
			"provider_raw":         nonNilMap(raw),
		},
	}
}

func wooCommerceDeletion(kind, topic string, raw map[string]any) ProviderDeletion {
	return ProviderDeletion{
		SourceID: wooCommerceSourceID(kind, raw),
		Provider: ProviderWooCommerce,
		Topic:    normalizeWooCommerceWebhookTopic(topic),
		Raw:      nonNilMap(raw),
	}
}

func decodeWooCommerceWebhookBody(body []byte) (map[string]any, error) {
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode woocommerce webhook payload: %w", err)
	}
	if raw == nil {
		return nil, fmt.Errorf("decode woocommerce webhook payload: empty object")
	}
	return raw, nil
}

type shopifyBulkOperationFinishPayload struct {
	AdminGraphQLAPIID string `json:"admin_graphql_api_id"`
	Status            string `json:"status"`
	ErrorCode         string `json:"error_code"`
	Type              string `json:"type"`
}

func (d *Deps) recordShopifyBulkOperationFinish(ctx context.Context, integration *Integration, body []byte) error {
	var payload shopifyBulkOperationFinishPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return err
	}
	if !strings.EqualFold(strings.TrimSpace(payload.Type), "query") {
		return nil
	}
	state, ok, err := decodeShopifyBulkOperationCursor(integration.SyncCursor)
	if err != nil || !ok {
		return err
	}
	if state.OperationID != strings.TrimSpace(payload.AdminGraphQLAPIID) {
		return nil
	}
	status := strings.ToUpper(strings.TrimSpace(payload.Status))
	summary := ShopifyAsyncBulkBackfillSummary{
		IntegrationID: integration.ID,
		OperationID:   state.OperationID,
		Object:        state.Object,
		Status:        status,
		ErrorCode:     strings.TrimSpace(payload.ErrorCode),
		Cursor:        integration.SyncCursor,
	}
	if err := shopifyBulkOperationSyncError(summary); err != nil {
		retryCursor := shopifyBulkOperationRetryCursor(state, status, err, d.now())
		return d.Repo.SetIntegrationSync(ctx, integration.TenantID, integration.ID, retryCursor, d.now(), err)
	}
	if status != "COMPLETED" {
		return d.Repo.SetIntegrationSync(ctx, integration.TenantID, integration.ID, integration.SyncCursor, d.now(), nil)
	}
	operator := d.ShopifyBulkOperator
	if operator == nil {
		operator = ShopifyAdminGraphQLBulkOperator{HTTPClient: d.HTTPClient}
	}
	polled, err := operator.PollBulkBackfill(ctx, *integration, state.OperationID, state.Object)
	if err != nil {
		retryCursor := shopifyBulkOperationRetryCursor(state, "POLL_FAILED", err, d.now())
		_ = d.Repo.SetIntegrationSync(ctx, integration.TenantID, integration.ID, retryCursor, d.now(), err)
		return err
	}
	if strings.TrimSpace(polled.ResultURL) == "" {
		_, err := d.completeShopifyAsyncBulkWithoutResult(ctx, integration.TenantID, integration.ID, polled)
		return err
	}
	_, err = d.importShopifyAsyncBulkResult(ctx, integration.TenantID, integration.ID, *integration, polled)
	if err != nil {
		retryCursor := shopifyBulkOperationRetryCursor(state, "IMPORT_FAILED", err, d.now())
		_ = d.Repo.SetIntegrationSync(ctx, integration.TenantID, integration.ID, retryCursor, d.now(), err)
		return err
	}
	return nil
}

func (d *Deps) exchangeShopifyCode(ctx context.Context, shop, code string) (token string, local bool, err error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return "", false, fmt.Errorf("missing code")
	}
	if shopifyCredentialsMissing(d.Config) || code == "local-dev" {
		if isProductionRuntime() {
			return "", false, fmt.Errorf("local Shopify OAuth is disabled in production")
		}
		return "local-dev-token", true, nil
	}
	form := url.Values{}
	form.Set("client_id", d.Config.ShopifyClientID)
	form.Set("client_secret", d.Config.ShopifyClientSecret)
	form.Set("code", code)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+shop+"/admin/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", false, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := commerceEgressClient(d.HTTPClient, ProviderShopify, 10*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, readErr := readResponseBodyLimited(resp.Body, commerceShopifyTokenResponseMaxBytes)
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if readErr != nil {
			return "", false, fmt.Errorf("shopify token endpoint %d: %w", resp.StatusCode, readErr)
		}
		return "", false, fmt.Errorf("shopify token endpoint %d", resp.StatusCode)
	}
	if readErr != nil {
		return "", false, fmt.Errorf("shopify token response: %w", readErr)
	}
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", false, err
	}
	if strings.TrimSpace(out.AccessToken) == "" {
		return "", false, fmt.Errorf("shopify token response missing access_token")
	}
	return out.AccessToken, false, nil
}

func shopifyCredentialsMissing(cfg Config) bool {
	return strings.TrimSpace(cfg.ShopifyClientID) == "" || strings.TrimSpace(cfg.ShopifyClientSecret) == ""
}

func isProductionRuntime() bool {
	for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
		v := strings.TrimSpace(os.Getenv(key))
		if strings.EqualFold(v, "production") || strings.EqualFold(v, "prod") {
			return true
		}
	}
	return false
}

func readResponseBodyLimited(r io.Reader, maxBytes int64) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > maxBytes {
		return nil, fmt.Errorf("response body too large")
	}
	return raw, nil
}

func (d *Deps) now() time.Time {
	if d.Now != nil {
		return d.Now().UTC()
	}
	return time.Now().UTC()
}

func externalBaseURL(r *http.Request) string {
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto == "" {
		proto = "http"
		if r.TLS != nil {
			proto = "https"
		}
	}
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	return proto + "://" + host
}

func shopifyWebhookBaseURL(r *http.Request, cfg Config) string {
	if raw := strings.TrimSpace(cfg.ShopifyOAuthRedirectURL); raw != "" {
		if u, err := url.Parse(raw); err == nil && u.Scheme != "" && u.Host != "" {
			return u.Scheme + "://" + u.Host
		}
	}
	return externalBaseURL(r)
}

func shopifyWebhookBaseURLForIntegration(r *http.Request, cfg Config, integration Integration) string {
	if raw, ok := integration.Settings["shopify_webhook_endpoint"].(string); ok {
		raw = strings.TrimSpace(raw)
		if raw != "" {
			if strings.HasSuffix(raw, "/api/public/commerce/shopify/webhooks") {
				return strings.TrimSuffix(raw, "/api/public/commerce/shopify/webhooks")
			}
			if u, err := url.Parse(raw); err == nil && u.Scheme != "" && u.Host != "" {
				return u.Scheme + "://" + u.Host
			}
		}
	}
	return shopifyWebhookBaseURL(r, cfg)
}

func wooCommerceWebhookBaseURLForIntegration(r *http.Request, cfg Config, integration Integration) string {
	if raw, ok := integration.Settings["woocommerce_webhook_endpoint"].(string); ok {
		raw = strings.TrimSpace(raw)
		if raw != "" {
			if strings.HasSuffix(raw, "/api/public/commerce/woocommerce/webhooks") {
				return strings.TrimSuffix(raw, "/api/public/commerce/woocommerce/webhooks")
			}
			if u, err := url.Parse(raw); err == nil && u.Scheme != "" && u.Host != "" {
				return u.Scheme + "://" + u.Host
			}
		}
	}
	return shopifyWebhookBaseURL(r, cfg)
}

func bigCommerceWebhookBaseURLForIntegration(r *http.Request, cfg Config, integration Integration) string {
	if raw, ok := integration.Settings["bigcommerce_webhook_endpoint"].(string); ok {
		raw = strings.TrimSpace(raw)
		if raw != "" {
			if strings.HasSuffix(raw, "/api/public/commerce/bigcommerce/webhooks") {
				return strings.TrimSuffix(raw, "/api/public/commerce/bigcommerce/webhooks")
			}
			if u, err := url.Parse(raw); err == nil && u.Scheme != "" && u.Host != "" {
				return u.Scheme + "://" + u.Host
			}
		}
	}
	return shopifyWebhookBaseURL(r, cfg)
}

func shopifyWebhookFresh(r *http.Request) bool {
	raw := strings.TrimSpace(firstNonEmpty(
		r.Header.Get("X-Shopify-Triggered-At"),
		r.Header.Get("X-Shopify-Sent-At"),
	))
	if raw == "" {
		return true
	}
	sent, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return true
	}
	drift := time.Since(sent)
	if drift < 0 {
		drift = -drift
	}
	return drift <= 5*time.Minute
}

type shopifyPrivacyWebhookPayload struct {
	ShopID          json.Number   `json:"shop_id"`
	ShopDomain      string        `json:"shop_domain"`
	OrdersRequested []json.Number `json:"orders_requested"`
	Customer        *struct {
		ID    json.Number `json:"id"`
		Email string      `json:"email"`
		Phone string      `json:"phone"`
	} `json:"customer"`
	DataRequest *struct {
		ID json.Number `json:"id"`
	} `json:"data_request"`
	OrdersToRedact []json.Number `json:"orders_to_redact"`
}

func parseShopifyPrivacyWebhookPayload(body []byte) (shopifyPrivacyWebhookPayload, error) {
	var payload shopifyPrivacyWebhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return shopifyPrivacyWebhookPayload{}, err
	}
	return payload, nil
}

func (p shopifyPrivacyWebhookPayload) customerRedaction() ShopifyCustomerRedaction {
	out := ShopifyCustomerRedaction{Reason: "shopify_customers_redact"}
	if p.Customer != nil {
		out.CustomerSourceIDs = append(out.CustomerSourceIDs, shopifySourceIDVariants("Customer", p.Customer.ID)...)
		if email := strings.ToLower(strings.TrimSpace(p.Customer.Email)); email != "" {
			out.Emails = append(out.Emails, email)
		}
	}
	for _, id := range p.OrdersToRedact {
		out.OrderSourceIDs = append(out.OrderSourceIDs, shopifySourceIDVariants("Order", id)...)
	}
	out.CustomerSourceIDs = compactStrings(out.CustomerSourceIDs)
	out.Emails = compactStrings(out.Emails)
	out.OrderSourceIDs = compactStrings(out.OrderSourceIDs)
	return out
}

func (p shopifyPrivacyWebhookPayload) customerDataRequest() ShopifyCustomerDataRequest {
	out := ShopifyCustomerDataRequest{Reason: "shopify_customers_data_request"}
	if p.DataRequest != nil {
		out.RequestID = strings.TrimSpace(p.DataRequest.ID.String())
	}
	if p.Customer != nil {
		out.CustomerSourceIDs = append(out.CustomerSourceIDs, shopifySourceIDVariants("Customer", p.Customer.ID)...)
		if email := strings.ToLower(strings.TrimSpace(p.Customer.Email)); email != "" {
			out.Emails = append(out.Emails, email)
		}
	}
	for _, id := range p.OrdersRequested {
		out.OrderSourceIDs = append(out.OrderSourceIDs, shopifySourceIDVariants("Order", id)...)
	}
	out.CustomerSourceIDs = compactStrings(out.CustomerSourceIDs)
	out.Emails = compactStrings(out.Emails)
	out.OrderSourceIDs = compactStrings(out.OrderSourceIDs)
	return out
}

func shopifySourceIDVariants(kind string, id json.Number) []string {
	raw := strings.TrimSpace(id.String())
	if raw == "" {
		return nil
	}
	out := []string{raw}
	if !strings.HasPrefix(raw, "gid://") {
		out = append(out, "gid://shopify/"+kind+"/"+raw)
	}
	return out
}

func compactStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func localWebhookID(shop, topic string, body []byte) string {
	sum := fmt.Sprintf("%x", body)
	if len(sum) > 64 {
		sum = sum[:64]
	}
	return strings.Join([]string{"local", shop, topic, sum}, ":")
}

func normalizeWooCommerceWebhookTopic(topic string) string {
	return strings.ToLower(strings.TrimSpace(strings.ReplaceAll(topic, "/", ".")))
}

func wooCommerceTopicFromResourceEvent(resource, event string) string {
	resource = strings.ToLower(strings.TrimSpace(resource))
	event = strings.ToLower(strings.TrimSpace(event))
	if resource == "" || event == "" {
		return ""
	}
	return resource + "." + event
}

func wooCommerceWebhookID(source, topic string, body []byte, webhookID, deliveryID string) string {
	bodyTag := fmt.Sprintf("%x", body)
	if len(bodyTag) > 64 {
		bodyTag = bodyTag[:64]
	}
	parts := []string{
		"woocommerce",
		strings.TrimSpace(source),
		normalizeWooCommerceWebhookTopic(topic),
		strings.TrimSpace(webhookID),
		strings.TrimSpace(deliveryID),
	}
	if parts[3] == "" && parts[4] == "" {
		return localWebhookID(source, topic, body)
	}
	if parts[4] == "" {
		parts = append(parts, bodyTag)
	}
	return strings.Join(parts, ":")
}

func generateCommerceWebhookSecret() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate commerce webhook secret: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
