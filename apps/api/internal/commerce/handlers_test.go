package commerce

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

type fakeStore struct {
	integration           *Integration
	lastTenantID          string
	lastIntegrationInput  IntegrationInput
	lastStatus            string
	deletedID             string
	disconnectedID        string
	disconnectCleanup     *DisconnectCleanupEvidence
	lastWooStoreURL       string
	lastBigStoreHash      string
	lastStripeAccountID   string
	lastSquareMerchantID  string
	lastPayPalMerchantID  string
	lastRazorpayAccountID string
	lastAdobeBaseURL      string
	lastWixSiteID         string
	lastSquarespaceSiteID string
	redaction             ShopifyCustomerRedaction
	dataRequest           ShopifyCustomerDataRequest
	wixUninstalled        bool
	claim                 WebhookClaim
	lastCartRecovery      CartRecoveryLinkInput
	customers             []CustomerInput
	products              []ProductInput
	orders                []OrderInput
	providerEvents        []ProviderEventInput
	deletedCustomers      []ProviderDeletion
	deletedProducts       []ProviderDeletion
	deletedOrders         []ProviderDeletion
	processed             int
	failed                int
	lastFailedErr         error
	lastSyncRequest       SyncRequest
	lastSyncRequests      []SyncRequest
	lastSyncCursor        string
	lastSyncAt            time.Time
	lastSyncErr           error
	syncErr               error
	shopifyTargets        []ShopifyBackfillTarget
	shopifyBulkTargets    []ShopifyBackfillTarget
	listedLimit           int
	listedStaleBefore     time.Time
	listedBulkLimit       int
	listedBulkStaleBefore time.Time
}

func (f *fakeStore) isDisconnected() bool {
	return f != nil && f.integration != nil && strings.EqualFold(strings.TrimSpace(f.integration.Status), "disconnected")
}

type fakeShopifyBackfiller struct {
	integration Integration
	cursor      string
	req         SyncRequest
	err         error
}

func (f *fakeShopifyBackfiller) BackfillPage(_ context.Context, integration Integration, cursor string) (SyncRequest, error) {
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeWooCommerceBackfiller struct {
	tenantID    string
	integration Integration
	cursor      string
	req         SyncRequest
	err         error
}

func (f *fakeWooCommerceBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeBigCommerceBackfiller struct {
	tenantID    string
	integration Integration
	cursor      string
	req         SyncRequest
	err         error
}

func (f *fakeBigCommerceBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeStripeBackfiller struct {
	tenantID    string
	integration Integration
	cursor      string
	req         SyncRequest
	err         error
}

func (f *fakeStripeBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeSquareBackfiller struct {
	tenantID    string
	integration Integration
	cursor      string
	req         SyncRequest
	err         error
}

func (f *fakeSquareBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakePayPalBackfiller struct {
	tenantID    string
	integration Integration
	cursor      string
	req         SyncRequest
	err         error
}

func (f *fakePayPalBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeRazorpayBackfiller struct {
	tenantID    string
	integration Integration
	cursor      string
	req         SyncRequest
	err         error
}

func (f *fakeRazorpayBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeAdobeCommerceBackfiller struct {
	tenantID    string
	integration Integration
	cursor      string
	req         SyncRequest
	err         error
}

func (f *fakeAdobeCommerceBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeWixStoresBackfiller struct {
	tenantID    string
	integration Integration
	cursor      string
	req         SyncRequest
	err         error
}

func (f *fakeWixStoresBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeSquarespaceBackfiller struct {
	tenantID    string
	integration Integration
	cursor      string
	req         SyncRequest
	err         error
}

func (f *fakeSquarespaceBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeStripeCredentialResolver struct {
	tenantID    string
	integration Integration
	creds       StripeCredentials
	err         error
}

func (f *fakeStripeCredentialResolver) ResolveStripe(_ context.Context, tenantID string, integration Integration) (StripeCredentials, error) {
	f.tenantID = tenantID
	f.integration = integration
	return f.creds, f.err
}

type fakeSquareCredentialResolver struct {
	tenantID    string
	integration Integration
	creds       SquareCredentials
	err         error
}

func (f *fakeSquareCredentialResolver) ResolveSquare(_ context.Context, tenantID string, integration Integration) (SquareCredentials, error) {
	f.tenantID = tenantID
	f.integration = integration
	return f.creds, f.err
}

type fakePayPalCredentialResolver struct {
	tenantID    string
	integration Integration
	creds       PayPalCredentials
	err         error
}

func (f *fakePayPalCredentialResolver) ResolvePayPal(_ context.Context, tenantID string, integration Integration) (PayPalCredentials, error) {
	f.tenantID = tenantID
	f.integration = integration
	return f.creds, f.err
}

type fakePayPalWebhookVerifier struct {
	creds   PayPalCredentials
	event   payPalWebhookEvent
	headers http.Header
	body    []byte
	err     error
}

func (f *fakePayPalWebhookVerifier) VerifyPayPalWebhook(_ context.Context, creds PayPalCredentials, event payPalWebhookEvent, headers http.Header, body []byte) error {
	f.creds = creds
	f.event = event
	f.headers = headers.Clone()
	f.body = append([]byte(nil), body...)
	return f.err
}

type fakePayPalResourceFetcher struct {
	tenantID    string
	integration Integration
	creds       PayPalCredentials
	event       payPalWebhookEvent
	out         payPalWebhookEvent
	err         error
	calls       int
}

func (f *fakePayPalResourceFetcher) FetchPayPalWebhookResource(_ context.Context, tenantID string, integration Integration, creds PayPalCredentials, event payPalWebhookEvent) (payPalWebhookEvent, error) {
	f.calls++
	f.tenantID = tenantID
	f.integration = integration
	f.creds = creds
	f.event = event
	if f.err != nil {
		return event, f.err
	}
	if f.out.EventType == "" {
		return event, nil
	}
	return f.out, nil
}

type fakeRazorpayCredentialResolver struct {
	tenantID    string
	integration Integration
	creds       RazorpayCredentials
	err         error
}

func (f *fakeRazorpayCredentialResolver) ResolveRazorpay(_ context.Context, tenantID string, integration Integration) (RazorpayCredentials, error) {
	f.tenantID = tenantID
	f.integration = integration
	return f.creds, f.err
}

type fakeAdobeCommerceCredentialResolver struct {
	tenantID    string
	integration Integration
	creds       AdobeCommerceCredentials
	err         error
}

func (f *fakeAdobeCommerceCredentialResolver) ResolveAdobeCommerce(_ context.Context, tenantID string, integration Integration) (AdobeCommerceCredentials, error) {
	f.tenantID = tenantID
	f.integration = integration
	return f.creds, f.err
}

type fakeWixStoresCredentialResolver struct {
	tenantID    string
	integration Integration
	creds       WixStoresCredentials
	err         error
}

func (f *fakeWixStoresCredentialResolver) ResolveWixStores(_ context.Context, tenantID string, integration Integration) (WixStoresCredentials, error) {
	f.tenantID = tenantID
	f.integration = integration
	return f.creds, f.err
}

type fakeSquarespaceCredentialResolver struct {
	tenantID    string
	integration Integration
	creds       SquarespaceCredentials
	err         error
}

func (f *fakeSquarespaceCredentialResolver) ResolveSquarespace(_ context.Context, tenantID string, integration Integration) (SquarespaceCredentials, error) {
	f.tenantID = tenantID
	f.integration = integration
	return f.creds, f.err
}

type fakeSquarespaceRecordFetcher struct {
	tenantID    string
	integration Integration
	orderID     string
	order       OrderInput
	err         error
}

func (f *fakeSquarespaceRecordFetcher) FetchSquarespaceOrder(_ context.Context, tenantID string, integration Integration, orderID string) (OrderInput, error) {
	f.tenantID = tenantID
	f.integration = integration
	f.orderID = orderID
	return f.order, f.err
}

type fakeBigCommerceWebhookRegistrar struct {
	integration    Integration
	appBaseURL     string
	cleanup        bool
	reconcileSum   BigCommerceWebhookReconcileSummary
	cleanupSummary BigCommerceWebhookCleanupSummary
	err            error
}

func (f *fakeBigCommerceWebhookRegistrar) ReconcileWebhooks(_ context.Context, integration Integration, appBaseURL string) (BigCommerceWebhookReconcileSummary, error) {
	f.integration = integration
	f.appBaseURL = appBaseURL
	if f.err != nil {
		return BigCommerceWebhookReconcileSummary{}, f.err
	}
	if f.reconcileSum.Endpoint == "" {
		f.reconcileSum = BigCommerceWebhookReconcileSummary{
			Endpoint:     appBaseURL + "/api/public/commerce/bigcommerce/webhooks",
			RegisteredAt: time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC),
			Subscriptions: []BigCommerceWebhookRegistration{{
				ID:          "hook_1",
				Scope:       "store/order/updated",
				Destination: appBaseURL + "/api/public/commerce/bigcommerce/webhooks",
				Active:      true,
				Created:     true,
			}},
		}
	}
	return f.reconcileSum, nil
}

func (f *fakeBigCommerceWebhookRegistrar) CleanupWebhooks(_ context.Context, integration Integration, appBaseURL string) (BigCommerceWebhookCleanupSummary, error) {
	f.integration = integration
	f.appBaseURL = appBaseURL
	f.cleanup = true
	if f.err != nil {
		return BigCommerceWebhookCleanupSummary{}, f.err
	}
	if f.cleanupSummary.Endpoint == "" {
		f.cleanupSummary = BigCommerceWebhookCleanupSummary{
			Endpoint:    appBaseURL + "/api/public/commerce/bigcommerce/webhooks",
			CleanedUpAt: time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC),
			Subscriptions: []BigCommerceWebhookRegistration{{
				ID:          "hook_1",
				Scope:       "store/order/updated",
				Destination: appBaseURL + "/api/public/commerce/bigcommerce/webhooks",
				Deleted:     true,
			}},
		}
	}
	return f.cleanupSummary, nil
}

type fakeBigCommerceRecordFetcher struct {
	customerID string
	productID  string
	orderID    string
	customer   CustomerInput
	product    ProductInput
	order      OrderInput
	err        error
}

func (f *fakeBigCommerceRecordFetcher) FetchCustomer(_ context.Context, _ string, _ Integration, id string) (CustomerInput, error) {
	f.customerID = id
	if f.err != nil {
		return CustomerInput{}, f.err
	}
	return f.customer, nil
}

func (f *fakeBigCommerceRecordFetcher) FetchProduct(_ context.Context, _ string, _ Integration, id string) (ProductInput, error) {
	f.productID = id
	if f.err != nil {
		return ProductInput{}, f.err
	}
	return f.product, nil
}

func (f *fakeBigCommerceRecordFetcher) FetchOrder(_ context.Context, _ string, _ Integration, id string) (OrderInput, error) {
	f.orderID = id
	if f.err != nil {
		return OrderInput{}, f.err
	}
	return f.order, nil
}

type fakeShopifyBulkOperator struct {
	startedIntegration Integration
	startedObject      string
	polledIntegration  Integration
	polledOperationID  string
	polledObject       string
	startSummary       ShopifyAsyncBulkBackfillSummary
	pollSummary        ShopifyAsyncBulkBackfillSummary
	err                error
}

func (f *fakeShopifyBulkOperator) StartBulkBackfill(_ context.Context, integration Integration, object string) (ShopifyAsyncBulkBackfillSummary, error) {
	f.startedIntegration = integration
	f.startedObject = object
	if f.err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, f.err
	}
	out := f.startSummary
	if out.Status == "" {
		out = ShopifyAsyncBulkBackfillSummary{
			IntegrationID: integration.ID,
			OperationID:   "gid://shopify/BulkOperation/100",
			Object:        object,
			Status:        "CREATED",
		}
	}
	return out, nil
}

func (f *fakeShopifyBulkOperator) PollBulkBackfill(_ context.Context, integration Integration, operationID, object string) (ShopifyAsyncBulkBackfillSummary, error) {
	f.polledIntegration = integration
	f.polledOperationID = operationID
	f.polledObject = object
	if f.err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, f.err
	}
	out := f.pollSummary
	if out.Status == "" {
		out = ShopifyAsyncBulkBackfillSummary{
			IntegrationID:    integration.ID,
			OperationID:      operationID,
			Object:           object,
			Status:           "COMPLETED",
			ResultURLPresent: true,
		}
	}
	return out, nil
}

type fakeShopifyBulkImporter struct {
	integration Integration
	object      string
	resultURL   string
	req         SyncRequest
	err         error
}

func (f *fakeShopifyBulkImporter) ImportBulkResult(_ context.Context, integration Integration, object, resultURL string) (SyncRequest, error) {
	f.integration = integration
	f.object = object
	f.resultURL = resultURL
	return f.req, f.err
}

type sequenceShopifyBackfiller struct {
	integration Integration
	cursors     []string
	pages       []SyncRequest
	err         error
	errAt       int
	calls       int
}

func (f *sequenceShopifyBackfiller) BackfillPage(_ context.Context, integration Integration, cursor string) (SyncRequest, error) {
	f.integration = integration
	f.cursors = append(f.cursors, cursor)
	if f.err != nil && f.calls == f.errAt {
		f.calls++
		return SyncRequest{}, f.err
	}
	if f.calls >= len(f.pages) {
		f.calls++
		return SyncRequest{Cursor: shopifyBackfillCursorComplete}, nil
	}
	out := f.pages[f.calls]
	f.calls++
	return out, nil
}

type fakeShopifyWebhookRegistrar struct {
	integration Integration
	baseURL     string
	cleanup     bool
	summary     ShopifyWebhookReconcileSummary
	cleanupOut  ShopifyWebhookCleanupSummary
	err         error
}

func (f *fakeShopifyWebhookRegistrar) ReconcileWebhooks(_ context.Context, integration Integration, baseURL string) (ShopifyWebhookReconcileSummary, error) {
	f.integration = integration
	f.baseURL = baseURL
	if f.err != nil {
		return ShopifyWebhookReconcileSummary{}, f.err
	}
	if f.summary.Endpoint == "" {
		f.summary = ShopifyWebhookReconcileSummary{
			Endpoint:     strings.TrimRight(baseURL, "/") + "/api/public/commerce/shopify/webhooks",
			RegisteredAt: time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC),
			Subscriptions: []ShopifyWebhookRegistration{{
				ID:      "gid://shopify/WebhookSubscription/1",
				Topic:   "APP_UNINSTALLED",
				URI:     strings.TrimRight(baseURL, "/") + "/api/public/commerce/shopify/webhooks",
				Created: true,
			}},
		}
	}
	return f.summary, nil
}

func (f *fakeShopifyWebhookRegistrar) CleanupWebhooks(_ context.Context, integration Integration, baseURL string) (ShopifyWebhookCleanupSummary, error) {
	f.integration = integration
	f.baseURL = baseURL
	f.cleanup = true
	if f.err != nil {
		return ShopifyWebhookCleanupSummary{}, f.err
	}
	if f.cleanupOut.Endpoint == "" {
		f.cleanupOut = ShopifyWebhookCleanupSummary{
			Endpoint:    strings.TrimRight(baseURL, "/") + "/api/public/commerce/shopify/webhooks",
			CleanedUpAt: time.Date(2026, 6, 18, 12, 30, 0, 0, time.UTC),
			Subscriptions: []ShopifyWebhookRegistration{{
				ID:    "gid://shopify/WebhookSubscription/1",
				Topic: "APP_UNINSTALLED",
				URI:   strings.TrimRight(baseURL, "/") + "/api/public/commerce/shopify/webhooks",
			}},
		}
	}
	return f.cleanupOut, nil
}

type fakeWooCommerceWebhookRegistrar struct {
	integration Integration
	baseURL     string
	cleanup     bool
	summary     WooCommerceWebhookReconcileSummary
	cleanupOut  WooCommerceWebhookCleanupSummary
	err         error
}

func (f *fakeWooCommerceWebhookRegistrar) ReconcileWebhooks(_ context.Context, integration Integration, baseURL string) (WooCommerceWebhookReconcileSummary, error) {
	f.integration = integration
	f.baseURL = baseURL
	if f.err != nil {
		return WooCommerceWebhookReconcileSummary{}, f.err
	}
	if f.summary.Endpoint == "" {
		f.summary = WooCommerceWebhookReconcileSummary{
			Endpoint:     strings.TrimRight(baseURL, "/") + "/api/public/commerce/woocommerce/webhooks",
			RegisteredAt: time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC),
			Subscriptions: []WooCommerceWebhookRegistration{{
				ID:      "142",
				Topic:   "order.updated",
				URI:     strings.TrimRight(baseURL, "/") + "/api/public/commerce/woocommerce/webhooks",
				Created: true,
			}},
		}
	}
	return f.summary, nil
}

func (f *fakeWooCommerceWebhookRegistrar) CleanupWebhooks(_ context.Context, integration Integration, baseURL string) (WooCommerceWebhookCleanupSummary, error) {
	f.integration = integration
	f.baseURL = baseURL
	f.cleanup = true
	if f.err != nil {
		return WooCommerceWebhookCleanupSummary{}, f.err
	}
	if f.cleanupOut.Endpoint == "" {
		f.cleanupOut = WooCommerceWebhookCleanupSummary{
			Endpoint:    strings.TrimRight(baseURL, "/") + "/api/public/commerce/woocommerce/webhooks",
			CleanedUpAt: time.Date(2026, 6, 18, 12, 30, 0, 0, time.UTC),
			Subscriptions: []WooCommerceWebhookRegistration{{
				ID:      "142",
				Topic:   "order.updated",
				URI:     strings.TrimRight(baseURL, "/") + "/api/public/commerce/woocommerce/webhooks",
				Deleted: true,
			}},
		}
	}
	return f.cleanupOut, nil
}

func (f *fakeStore) ListIntegrations(context.Context, string) ([]Integration, error) {
	return []Integration{*f.integration}, nil
}
func (f *fakeStore) GetIntegration(context.Context, string, string) (*Integration, error) {
	return f.integration, nil
}
func (f *fakeStore) SetIntegrationStatus(_ context.Context, _ string, _ string, status string) (*Integration, error) {
	if f.integration == nil {
		return nil, ErrNotFound
	}
	if f.isDisconnected() {
		return nil, errIntegrationDisconnected
	}
	f.lastStatus = status
	out := *f.integration
	out.Status = status
	return &out, nil
}
func (f *fakeStore) DisconnectIntegrationWithProviderCleanup(_ context.Context, _ string, id string, cleanup *DisconnectCleanupEvidence) error {
	f.disconnectedID = id
	f.disconnectCleanup = cleanup
	if f.integration == nil {
		return ErrNotFound
	}
	f.integration.Status = "disconnected"
	if cleanup != nil {
		if f.integration.Settings == nil {
			f.integration.Settings = map[string]any{}
		}
		f.integration.Settings["provider_cleanup"] = cleanup
	}
	return nil
}
func (f *fakeStore) DeleteIntegration(_ context.Context, _ string, id string) error {
	f.deletedID = id
	if f.integration == nil {
		return ErrNotFound
	}
	return nil
}
func (f *fakeStore) FindShopifyIntegrationByShop(context.Context, string) (*Integration, error) {
	if f.integration == nil {
		return nil, ErrNotFound
	}
	if strings.EqualFold(strings.TrimSpace(f.integration.Status), "disconnected") {
		return nil, ErrNotFound
	}
	return f.integration, nil
}
func (f *fakeStore) FindWooCommerceIntegrationByStoreURL(_ context.Context, storeURL string) (*Integration, error) {
	f.lastWooStoreURL = storeURL
	if f.integration == nil {
		return nil, ErrNotFound
	}
	if strings.EqualFold(strings.TrimSpace(f.integration.Status), "disconnected") {
		return nil, ErrNotFound
	}
	return f.integration, nil
}
func (f *fakeStore) FindWooCommerceIntegrationByTenantStoreURL(_ context.Context, tenantID, storeURL string) (*Integration, error) {
	f.lastTenantID = tenantID
	f.lastWooStoreURL = storeURL
	if f.integration == nil || f.integration.Provider != ProviderWooCommerce {
		return nil, ErrNotFound
	}
	return f.integration, nil
}
func (f *fakeStore) FindBigCommerceIntegrationByStoreHash(_ context.Context, storeHash string) (*Integration, error) {
	f.lastBigStoreHash = storeHash
	if f.integration == nil || f.integration.Provider != ProviderBigCommerce {
		return nil, ErrNotFound
	}
	return f.integration, nil
}
func (f *fakeStore) FindBigCommerceIntegrationByTenantStoreHash(_ context.Context, tenantID, storeHash string) (*Integration, error) {
	f.lastTenantID = tenantID
	f.lastBigStoreHash = storeHash
	if f.integration == nil || f.integration.Provider != ProviderBigCommerce {
		return nil, ErrNotFound
	}
	return f.integration, nil
}
func (f *fakeStore) FindStripeIntegrationByAccountID(_ context.Context, accountID string) (*Integration, error) {
	f.lastStripeAccountID = accountID
	if f.integration == nil || f.integration.Provider != ProviderStripe {
		return nil, ErrNotFound
	}
	return f.integration, nil
}
func (f *fakeStore) FindSquareIntegrationByMerchantID(_ context.Context, merchantID string) (*Integration, error) {
	f.lastSquareMerchantID = merchantID
	if f.integration == nil || f.integration.Provider != ProviderSquare {
		return nil, ErrNotFound
	}
	return f.integration, nil
}
func (f *fakeStore) FindPayPalIntegrationByMerchantID(_ context.Context, merchantID string) (*Integration, error) {
	f.lastPayPalMerchantID = merchantID
	if f.integration == nil || f.integration.Provider != ProviderPayPal {
		return nil, ErrNotFound
	}
	if strings.EqualFold(strings.TrimSpace(f.integration.Status), "disconnected") {
		return nil, ErrNotFound
	}
	return f.integration, nil
}
func (f *fakeStore) FindRazorpayIntegrationByAccountID(_ context.Context, accountID string) (*Integration, error) {
	f.lastRazorpayAccountID = accountID
	if f.integration == nil || f.integration.Provider != ProviderRazorpay {
		return nil, ErrNotFound
	}
	return f.integration, nil
}
func (f *fakeStore) FindAdobeCommerceIntegrationByBaseURL(_ context.Context, baseURL string) (*Integration, error) {
	f.lastAdobeBaseURL = baseURL
	if f.integration == nil || f.integration.Provider != ProviderAdobeCommerce {
		return nil, ErrNotFound
	}
	return f.integration, nil
}
func (f *fakeStore) FindWixStoresIntegrationBySiteID(_ context.Context, siteID string) (*Integration, error) {
	f.lastWixSiteID = siteID
	if f.integration == nil || f.integration.Provider != ProviderWixStores {
		return nil, ErrNotFound
	}
	return f.integration, nil
}
func (f *fakeStore) FindSquarespaceIntegrationBySiteID(_ context.Context, siteID string) (*Integration, error) {
	f.lastSquarespaceSiteID = siteID
	if f.integration == nil || f.integration.Provider != ProviderSquarespace {
		return nil, ErrNotFound
	}
	return f.integration, nil
}
func (f *fakeStore) UpsertIntegration(_ context.Context, tenantID string, in IntegrationInput) (*Integration, error) {
	f.lastTenantID = tenantID
	f.lastIntegrationInput = in
	if f.integration == nil {
		return &Integration{
			ID:            "int_1",
			TenantID:      tenantID,
			Provider:      in.Provider,
			ShopDomain:    in.ShopDomain,
			Status:        in.Status,
			Scopes:        in.Scopes,
			Settings:      in.Settings,
			WebhookSecret: in.WebhookSecret,
			CreatedAt:     time.Now().UTC(),
			UpdatedAt:     time.Now().UTC(),
		}, nil
	}
	return f.integration, nil
}
func (f *fakeStore) ListCatalogs(context.Context, string, int, pagination.Cursor) (*CatalogsPage, error) {
	return &CatalogsPage{Items: []Catalog{{ID: "cat_1", Name: "Default catalog"}}}, nil
}
func (f *fakeStore) UpsertCatalog(context.Context, string, CatalogInput) (*Catalog, error) {
	return &Catalog{ID: "cat_1", Name: "Default catalog", SourceType: "manual", Status: "active", DefaultCurrency: "USD"}, nil
}
func (f *fakeStore) ImportCatalogProducts(context.Context, string, string, CatalogProductImportInput, time.Time) (*CatalogProductImportSummary, error) {
	return &CatalogProductImportSummary{CatalogID: "cat_1", IntegrationID: "int_1", ProductsSeen: 1, ProductsUpserted: 1, CatalogItemsUpserted: 1, ImportedAt: time.Now().UTC()}, nil
}
func (f *fakeStore) ListProductFeeds(context.Context, string, string, int, pagination.Cursor) (*ProductFeedsPage, error) {
	return &ProductFeedsPage{Items: []ProductFeed{{ID: "feed_1", Name: "Featured", FeedType: "manual"}}}, nil
}
func (f *fakeStore) UpsertProductFeed(context.Context, string, string, ProductFeedInput) (*ProductFeed, error) {
	return &ProductFeed{ID: "feed_1", Name: "Featured", FeedType: "manual", Status: "draft", MaxItems: 3, ExcludeOutOfStock: true}, nil
}
func (f *fakeStore) ResolveProductFeed(context.Context, string, string, string, ProductFeedResolveInput) (*ResolvedProductFeed, error) {
	return &ResolvedProductFeed{FeedID: "feed_1", FeedType: "manual", Items: []ResolvedProductFeedItem{{ProductID: "p_1", SourceID: "p_1", Title: "Desk lamp", PriceCents: 2500, Currency: "USD", Available: true, Rank: 1}}, PageInfo: PageInfo{Total: 1, Page: 1, PerPage: 3}}, nil
}
func (f *fakeStore) ListCartRecoveryLinks(context.Context, string, string, string, int, pagination.Cursor) (*CartRecoveryLinksPage, error) {
	return &CartRecoveryLinksPage{Items: []CartRecoveryLink{{ID: "link_1", SourceCartID: "cart_1", RecoveryURL: "https://example.test/cart", Status: "active"}}}, nil
}
func (f *fakeStore) UpsertCartRecoveryLink(_ context.Context, _, _ string, in CartRecoveryLinkInput) (*CartRecoveryLink, error) {
	if f.isDisconnected() {
		return nil, errIntegrationDisconnected
	}
	f.lastCartRecovery = in
	return &CartRecoveryLink{ID: "link_1", SourceCartID: in.SourceCartID, RecoveryURL: in.RecoveryURL, Status: defaulted(in.Status, "active")}, nil
}
func (f *fakeStore) ListBackInStockSubscriptions(context.Context, string, string, string, int, pagination.Cursor) (*BackInStockSubscriptionsPage, error) {
	return &BackInStockSubscriptionsPage{Items: []BackInStockSubscription{{ID: "bis_1", ProductID: "p_1", SubscriberEmail: "buyer@example.com", Status: "waiting"}}}, nil
}
func (f *fakeStore) CreateBackInStockSubscription(context.Context, string, string, string, BackInStockSubscriptionInput) (*BackInStockSubscription, error) {
	if f.isDisconnected() {
		return nil, errIntegrationDisconnected
	}
	return &BackInStockSubscription{ID: "bis_1", ProductID: "p_1", SubscriberEmail: "buyer@example.com", Status: "waiting"}, nil
}
func (f *fakeStore) ListPriceDropWatchers(context.Context, string, string, string, int, pagination.Cursor) (*PriceDropWatchersPage, error) {
	return &PriceDropWatchersPage{Items: []PriceDropWatcher{{ID: "pd_1", ProductID: "p_1", SubscriberEmail: "buyer@example.com", OriginalPriceCents: 2500, Currency: "USD", Status: "watching"}}}, nil
}
func (f *fakeStore) CreatePriceDropWatcher(context.Context, string, string, string, PriceDropWatcherInput) (*PriceDropWatcher, error) {
	if f.isDisconnected() {
		return nil, errIntegrationDisconnected
	}
	target := 2000
	return &PriceDropWatcher{ID: "pd_1", ProductID: "p_1", SubscriberEmail: "buyer@example.com", OriginalPriceCents: 2500, TargetPriceCents: &target, Currency: "USD", Status: "watching"}, nil
}
func (f *fakeStore) EvaluateLifecycleTriggers(context.Context, string, string, time.Time) (*CommerceLifecycleEvaluationSummary, error) {
	if f.isDisconnected() {
		return nil, errIntegrationDisconnected
	}
	return &CommerceLifecycleEvaluationSummary{BackInStockEligible: 1, PriceDropEligible: 1, EvaluatedAt: time.Now().UTC()}, nil
}
func (f *fakeStore) LifecycleReport(context.Context, string, string, time.Time) (*CommerceLifecycleReport, error) {
	return &CommerceLifecycleReport{
		IntegrationID:      "int_1",
		CartRecovery:       LifecycleStats{Total: 1, ByStatus: map[string]int{"active": 1}},
		BackInStock:        LifecycleStats{Total: 1, ByStatus: map[string]int{"eligible": 1}},
		PriceDrop:          LifecycleStats{Total: 1, ByStatus: map[string]int{"watching": 1}},
		EventsLast30Days:   map[string]int{"back_in_stock_eligible": 1},
		EligibleLast30Days: 1,
		NotifiedPending:    1,
		GeneratedAt:        time.Now().UTC(),
	}, nil
}
func (f *fakeStore) Sync(_ context.Context, _ string, _ string, in SyncRequest, _ time.Time) (*SyncSummary, error) {
	f.lastSyncRequest = in
	f.lastSyncRequests = append(f.lastSyncRequests, in)
	f.deletedProducts = append(f.deletedProducts, in.ProductDeletions...)
	if f.syncErr != nil {
		return nil, f.syncErr
	}
	return &SyncSummary{
		CustomersUpserted: len(in.Customers),
		ProductsUpserted:  len(in.Products),
		ProductsDeleted:   len(in.ProductDeletions),
		OrdersUpserted:    len(in.Orders),
		EventsRecorded:    len(in.ProviderEvents),
		Cursor:            in.Cursor,
	}, nil
}
func (f *fakeStore) SetIntegrationSync(_ context.Context, _ string, _ string, cursor string, at time.Time, syncErr error) error {
	f.lastSyncCursor = cursor
	f.lastSyncAt = at
	f.lastSyncErr = syncErr
	return nil
}
func (f *fakeStore) ListCustomers(context.Context, string, string, int, pagination.Cursor) (*CustomersPage, error) {
	return &CustomersPage{Items: []Customer{{SourceID: "c_1"}}}, nil
}
func (f *fakeStore) ListProducts(context.Context, string, string, int, pagination.Cursor) (*ProductsPage, error) {
	return &ProductsPage{Items: []Product{{SourceID: "p_1", Title: "Product"}}}, nil
}
func (f *fakeStore) ListProductVariants(context.Context, string, string, string, int, pagination.Cursor) (*ProductVariantsPage, error) {
	return &ProductVariantsPage{Items: []ProductVariant{{SourceID: "v_1", ProductID: "p_1", PriceCents: 2500, Currency: "USD", Available: true}}}, nil
}
func (f *fakeStore) ListInventorySnapshots(context.Context, string, string, string, int, pagination.Cursor) (*InventorySnapshotsPage, error) {
	return &InventorySnapshotsPage{Items: []InventorySnapshot{{ProductID: "p_1", Available: true, InventoryPolicy: "unknown"}}}, nil
}
func (f *fakeStore) ListPriceHistory(context.Context, string, string, string, int, pagination.Cursor) (*PriceHistoryPage, error) {
	return &PriceHistoryPage{Items: []PriceHistoryPoint{{ProductID: "p_1", PriceCents: 2500, Currency: "USD"}}}, nil
}
func (f *fakeStore) ListOrders(context.Context, string, string, int, pagination.Cursor) (*OrdersPage, error) {
	return &OrdersPage{Items: []Order{{SourceID: "o_1", Status: "paid"}}}, nil
}
func (f *fakeStore) ListEvents(context.Context, string, string, int, pagination.Cursor) (*EventsPage, error) {
	return &EventsPage{Items: []Event{{EventType: "order_created"}}}, nil
}
func (f *fakeStore) Analytics(context.Context, string, string) (*Analytics, error) {
	return &Analytics{Customers: 1, Products: 1, Orders: 1, RevenueCents: 2500, Currency: "USD", OrdersByStatus: map[string]int{"paid": 1}}, nil
}
func (f *fakeStore) ClaimWebhook(context.Context, string, string, string, string, string, []byte) (WebhookClaim, error) {
	if f.claim == "" {
		return WebhookClaimed, nil
	}
	return f.claim, nil
}
func (f *fakeStore) MarkWebhookProcessed(context.Context, string, string, string) error {
	f.processed++
	return nil
}
func (f *fakeStore) MarkWebhookFailed(_ context.Context, _, _, _ string, err error) error {
	f.failed++
	f.lastFailedErr = err
	return nil
}
func (f *fakeStore) MarkShopifyUninstalled(context.Context, string, string) error {
	return nil
}
func (f *fakeStore) MarkWixStoresUninstalled(context.Context, string, string) error {
	f.wixUninstalled = true
	if f.integration != nil {
		f.integration.Status = "needs_auth"
	}
	return nil
}
func (f *fakeStore) RedactShopifyCustomer(_ context.Context, _ string, _ string, redaction ShopifyCustomerRedaction) error {
	f.redaction = redaction
	return nil
}
func (f *fakeStore) CollectShopifyCustomerDataRequest(_ context.Context, _ string, integrationID string, request ShopifyCustomerDataRequest, generatedAt time.Time) (*ShopifyCustomerDataRequestBundle, error) {
	f.dataRequest = request
	return &ShopifyCustomerDataRequestBundle{
		RequestID:     request.RequestID,
		IntegrationID: integrationID,
		Customers:     []Customer{{SourceID: firstString(request.CustomerSourceIDs...), Email: firstString(request.Emails...)}},
		Orders:        []Order{{SourceID: firstString(request.OrderSourceIDs...)}},
		GeneratedAt:   generatedAt,
	}, nil
}
func (f *fakeStore) UpsertCustomer(_ context.Context, _, _ string, in CustomerInput) error {
	f.customers = append(f.customers, in)
	return nil
}
func (f *fakeStore) UpsertProduct(_ context.Context, _, _ string, in ProductInput) error {
	f.products = append(f.products, in)
	return nil
}
func (f *fakeStore) UpsertOrder(_ context.Context, _, _ string, in OrderInput) error {
	f.orders = append(f.orders, in)
	return nil
}
func (f *fakeStore) RecordProviderEvent(_ context.Context, _, _ string, in ProviderEventInput) error {
	f.providerEvents = append(f.providerEvents, in)
	return nil
}
func (f *fakeStore) DeleteCustomer(_ context.Context, _, _ string, in ProviderDeletion) error {
	f.deletedCustomers = append(f.deletedCustomers, in)
	return nil
}
func (f *fakeStore) DeleteProduct(_ context.Context, _, _ string, in ProviderDeletion) error {
	f.deletedProducts = append(f.deletedProducts, in)
	return nil
}
func (f *fakeStore) DeleteOrder(_ context.Context, _, _ string, in ProviderDeletion) error {
	f.deletedOrders = append(f.deletedOrders, in)
	return nil
}

func commerceReqWithID(method, target, id string, body io.Reader) *http.Request {
	req := httptest.NewRequest(method, target, body)
	req.Header.Set("Content-Type", "application/json")
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", id)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-1"})
	return req.WithContext(ctx)
}

func commerceReqWithIDAndProduct(method, target, id, productID string, body io.Reader) *http.Request {
	req := commerceReqWithID(method, target, id, body)
	chi.RouteContext(req.Context()).URLParams.Add("product_id", productID)
	return req
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func hexHMACSHA256(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func signWixStoresJWTForTest(t *testing.T, key *rsa.PrivateKey, claims map[string]any) string {
	t.Helper()
	header := map[string]any{"alg": "RS256", "typ": "JWT"}
	headerJSON, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	enc := base64.RawURLEncoding
	signingInput := enc.EncodeToString(headerJSON) + "." + enc.EncodeToString(claimsJSON)
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return signingInput + "." + enc.EncodeToString(signature)
}

func hasProviderField(fields []ProviderField, key string) bool {
	for _, field := range fields {
		if field.Key == key {
			return true
		}
	}
	return false
}

func hasString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func signShopifyOAuthQuery(secret string, values url.Values) url.Values {
	out := url.Values{}
	for key, vals := range values {
		for _, value := range vals {
			out.Add(key, value)
		}
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(shopifyOAuthMessage(out)))
	out.Set("hmac", hex.EncodeToString(mac.Sum(nil)))
	return out
}

func TestShopifyWebhookDispatchesVerifiedCustomer(t *testing.T) {
	body := []byte(`{"id":42,"email":"buyer@example.com","accepts_marketing":true}`)
	store := &fakeStore{integration: &Integration{
		ID: "00000000-0000-0000-0000-000000000002", TenantID: "00000000-0000-0000-0000-000000000001",
		Provider: ProviderShopify, ShopDomain: "demo.myshopify.com", WebhookSecret: "secret",
	}}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/shopify/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Shopify-Shop-Domain", "demo.myshopify.com")
	req.Header.Set("X-Shopify-Topic", "customers/create")
	req.Header.Set("X-Shopify-Webhook-Id", "wh_1")
	req.Header.Set("X-Shopify-Hmac-Sha256", signShopifyTest("secret", body))
	rec := httptest.NewRecorder()

	deps.ShopifyWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.customers) != 1 || store.customers[0].SourceID != "42" {
		t.Fatalf("customers = %+v", store.customers)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestShopifyWebhookDoesNotResolveDisconnectedIntegration(t *testing.T) {
	body := []byte(`{"id":42,"email":"buyer@example.com","accepts_marketing":true}`)
	store := &fakeStore{integration: &Integration{
		ID: "00000000-0000-0000-0000-000000000002", TenantID: "00000000-0000-0000-0000-000000000001",
		Provider: ProviderShopify, ShopDomain: "demo.myshopify.com", Status: "disconnected", WebhookSecret: "secret",
	}}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/shopify/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Shopify-Shop-Domain", "demo.myshopify.com")
	req.Header.Set("X-Shopify-Topic", "customers/create")
	req.Header.Set("X-Shopify-Webhook-Id", "wh_1")
	req.Header.Set("X-Shopify-Hmac-Sha256", signShopifyTest("secret", body))
	rec := httptest.NewRecorder()

	deps.ShopifyWebhook(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.customers) != 0 || store.processed != 0 || store.failed != 0 {
		t.Fatalf("disconnected row should not ingest callback: customers=%+v processed=%d failed=%d", store.customers, store.processed, store.failed)
	}
}

func TestWooCommerceWebhookDispatchesVerifiedOrder(t *testing.T) {
	body := []byte(`{
		"id":55,
		"status":"processing",
		"currency":"USD",
		"total":"42.50",
		"billing":{"email":"BUYER@EXAMPLE.COM"},
		"line_items":[{"id":9,"product_id":7,"name":"Beanie","quantity":2,"price":"18.50"}]
	}`)
	store := &fakeStore{integration: &Integration{
		ID:            "00000000-0000-0000-0000-000000000002",
		TenantID:      "00000000-0000-0000-0000-000000000001",
		Provider:      ProviderWooCommerce,
		ShopDomain:    "https://store.example",
		WebhookSecret: "wc-secret",
	}}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/woocommerce/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-WC-Webhook-Source", "https://store.example/")
	req.Header.Set("X-WC-Webhook-Topic", "order.updated")
	req.Header.Set("X-WC-Webhook-ID", "142")
	req.Header.Set("X-WC-Webhook-Delivery-ID", "9001")
	req.Header.Set("X-WC-Webhook-Signature", signShopifyTest("wc-secret", body))
	rec := httptest.NewRecorder()

	deps.WooCommerceWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastWooStoreURL != "https://store.example" {
		t.Fatalf("store lookup = %q", store.lastWooStoreURL)
	}
	if len(store.orders) != 1 || store.orders[0].SourceID != "woocommerce://order/55" || store.orders[0].CustomerEmail != "buyer@example.com" {
		t.Fatalf("orders = %+v", store.orders)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestWooCommerceWebhookDoesNotResolveDisconnectedIntegration(t *testing.T) {
	body := []byte(`{"id":55,"status":"processing","billing":{"email":"BUYER@EXAMPLE.COM"}}`)
	store := &fakeStore{integration: &Integration{
		ID:            "00000000-0000-0000-0000-000000000002",
		TenantID:      "00000000-0000-0000-0000-000000000001",
		Provider:      ProviderWooCommerce,
		ShopDomain:    "https://store.example",
		Status:        "disconnected",
		WebhookSecret: "wc-secret",
	}}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/woocommerce/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-WC-Webhook-Source", "https://store.example/")
	req.Header.Set("X-WC-Webhook-Topic", "order.updated")
	req.Header.Set("X-WC-Webhook-ID", "142")
	req.Header.Set("X-WC-Webhook-Delivery-ID", "9001")
	req.Header.Set("X-WC-Webhook-Signature", signShopifyTest("wc-secret", body))
	rec := httptest.NewRecorder()

	deps.WooCommerceWebhook(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.orders) != 0 || store.processed != 0 || store.failed != 0 {
		t.Fatalf("disconnected row should not ingest callback: orders=%+v processed=%d failed=%d", store.orders, store.processed, store.failed)
	}
}

func TestWooCommerceWebhookDispatchesVerifiedOrderDelete(t *testing.T) {
	body := []byte(`{"id":55,"status":"trash","billing":{"email":"buyer@example.com"}}`)
	store := &fakeStore{integration: &Integration{
		ID:            "00000000-0000-0000-0000-000000000002",
		TenantID:      "00000000-0000-0000-0000-000000000001",
		Provider:      ProviderWooCommerce,
		ShopDomain:    "https://store.example",
		WebhookSecret: "wc-secret",
	}}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/woocommerce/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-WC-Webhook-Source", "https://store.example/")
	req.Header.Set("X-WC-Webhook-Topic", "order.deleted")
	req.Header.Set("X-WC-Webhook-ID", "143")
	req.Header.Set("X-WC-Webhook-Delivery-ID", "9002")
	req.Header.Set("X-WC-Webhook-Signature", signShopifyTest("wc-secret", body))
	rec := httptest.NewRecorder()

	deps.WooCommerceWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.deletedOrders) != 1 || store.deletedOrders[0].SourceID != "woocommerce://order/55" || store.deletedOrders[0].Topic != "order.deleted" {
		t.Fatalf("deleted orders = %+v", store.deletedOrders)
	}
	if len(store.orders) != 0 {
		t.Fatalf("delete webhook should not upsert order rows: %+v", store.orders)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestWooCommerceWebhookDispatchesVerifiedCustomerAndProductDeletes(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:            "00000000-0000-0000-0000-000000000002",
		TenantID:      "00000000-0000-0000-0000-000000000001",
		Provider:      ProviderWooCommerce,
		ShopDomain:    "https://store.example",
		WebhookSecret: "wc-secret",
	}}
	deps := &Deps{Repo: store}
	cases := []struct {
		topic string
		body  []byte
	}{
		{topic: "customer.deleted", body: []byte(`{"id":77,"email":"old@example.com"}`)},
		{topic: "product.deleted", body: []byte(`{"id":88,"name":"Archived Beanie"}`)},
	}
	for idx, tc := range cases {
		req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/woocommerce/webhooks", strings.NewReader(string(tc.body)))
		req.Header.Set("X-WC-Webhook-Source", "https://store.example/")
		req.Header.Set("X-WC-Webhook-Topic", tc.topic)
		req.Header.Set("X-WC-Webhook-ID", fmt.Sprintf("wh_%d", idx+1))
		req.Header.Set("X-WC-Webhook-Delivery-ID", fmt.Sprintf("delivery_%d", idx+1))
		req.Header.Set("X-WC-Webhook-Signature", signShopifyTest("wc-secret", tc.body))
		rec := httptest.NewRecorder()

		deps.WooCommerceWebhook(rec, req)

		if rec.Code != http.StatusAccepted {
			t.Fatalf("%s status = %d body=%s", tc.topic, rec.Code, rec.Body.String())
		}
	}
	if len(store.deletedCustomers) != 1 || store.deletedCustomers[0].SourceID != "woocommerce://customer/77" {
		t.Fatalf("deleted customers = %+v", store.deletedCustomers)
	}
	if len(store.deletedProducts) != 1 || store.deletedProducts[0].SourceID != "woocommerce://product/88" {
		t.Fatalf("deleted products = %+v", store.deletedProducts)
	}
	if len(store.customers) != 0 || len(store.products) != 0 || store.processed != 2 {
		t.Fatalf("unexpected upserts customers=%+v products=%+v processed=%d", store.customers, store.products, store.processed)
	}
}

func TestWooCommerceWebhookDispatchesVerifiedCouponEvents(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:            "00000000-0000-0000-0000-000000000002",
		TenantID:      "00000000-0000-0000-0000-000000000001",
		Provider:      ProviderWooCommerce,
		ShopDomain:    "https://store.example",
		WebhookSecret: "wc-secret",
	}}
	deps := &Deps{Repo: store}
	cases := []struct {
		topic     string
		eventType string
		body      []byte
	}{
		{topic: "coupon.created", eventType: "coupon_created", body: []byte(`{"id":719,"code":"10off","discount_type":"percent","amount":"10.00"}`)},
		{topic: "coupon.updated", eventType: "coupon_updated", body: []byte(`{"id":719,"code":"10off","discount_type":"fixed_cart","amount":"12.00"}`)},
		{topic: "coupon.deleted", eventType: "coupon_deleted", body: []byte(`{"id":719,"code":"10off","discount_type":"fixed_cart","amount":"12.00"}`)},
	}
	for idx, tc := range cases {
		req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/woocommerce/webhooks", strings.NewReader(string(tc.body)))
		req.Header.Set("X-WC-Webhook-Source", "https://store.example/")
		req.Header.Set("X-WC-Webhook-Topic", tc.topic)
		req.Header.Set("X-WC-Webhook-ID", fmt.Sprintf("coupon_wh_%d", idx+1))
		req.Header.Set("X-WC-Webhook-Delivery-ID", fmt.Sprintf("coupon_delivery_%d", idx+1))
		req.Header.Set("X-WC-Webhook-Signature", signShopifyTest("wc-secret", tc.body))
		rec := httptest.NewRecorder()

		deps.WooCommerceWebhook(rec, req)

		if rec.Code != http.StatusAccepted {
			t.Fatalf("%s status = %d body=%s", tc.topic, rec.Code, rec.Body.String())
		}
	}
	if len(store.providerEvents) != len(cases) {
		t.Fatalf("provider events = %+v", store.providerEvents)
	}
	for idx, tc := range cases {
		event := store.providerEvents[idx]
		if event.EventType != tc.eventType || event.Topic != tc.topic || event.SourceID != "woocommerce://coupon/719" || event.ProviderEventID != tc.eventType+":woocommerce://coupon/719" {
			t.Fatalf("event[%d] = %+v", idx, event)
		}
		if event.Metadata["code"] != "10off" || event.Metadata["source"] != ProviderWooCommerce {
			t.Fatalf("metadata[%d] = %+v", idx, event.Metadata)
		}
	}
	if len(store.customers) != 0 || len(store.products) != 0 || len(store.orders) != 0 || store.processed != 3 {
		t.Fatalf("unexpected upserts customers=%+v products=%+v orders=%+v processed=%d", store.customers, store.products, store.orders, store.processed)
	}
}

func TestWooCommerceWebhookDispatchesVerifiedSubscriptionEvents(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:            "00000000-0000-0000-0000-000000000002",
		TenantID:      "00000000-0000-0000-0000-000000000001",
		Provider:      ProviderWooCommerce,
		ShopDomain:    "https://store.example",
		WebhookSecret: "wc-secret",
		Settings:      map[string]any{"subscriptions_enabled": true},
	}}
	deps := &Deps{Repo: store}
	body := []byte(`{
		"id": 881,
		"status": "active",
		"customer_id": 42,
		"parent_id": 55,
		"currency": "USD",
		"total": "29.00",
		"billing_period": "month",
		"billing_interval": "1",
		"start_date_gmt": "2026-06-01T00:00:00",
		"trial_end_date_gmt": "2026-06-08T00:00:00",
		"next_payment_date_gmt": "2026-07-01T00:00:00",
		"payment_method": "stripe",
		"payment_method_title": "Credit card",
		"transaction_id": "txn_sub_881",
		"billing": {"email": "BUYER@example.com"},
		"coupon_lines": [{"id": 901, "code": "VIP20", "discount": "5.00"}],
		"line_items": [{
			"id": 11,
			"product_id": 7,
			"variation_id": 8,
			"name": "Monthly box",
			"quantity": 1,
			"total": "29.00",
			"sku": "BOX-MONTHLY"
		}]
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/woocommerce/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-WC-Webhook-Source", "https://store.example/")
	req.Header.Set("X-WC-Webhook-Topic", "subscription.updated")
	req.Header.Set("X-WC-Webhook-ID", "sub_wh_1")
	req.Header.Set("X-WC-Webhook-Delivery-ID", "sub_delivery_1")
	req.Header.Set("X-WC-Webhook-Signature", signShopifyTest("wc-secret", body))
	rec := httptest.NewRecorder()

	deps.WooCommerceWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.providerEvents) != 1 {
		t.Fatalf("provider events = %+v", store.providerEvents)
	}
	event := store.providerEvents[0]
	if event.EventType != "subscription_updated" || event.Topic != "subscription.updated" || event.SourceID != "woocommerce://subscription/881" || event.CustomerEmail != "buyer@example.com" {
		t.Fatalf("event = %+v", event)
	}
	if event.ProviderEventID != "subscription_updated:woocommerce://subscription/881" {
		t.Fatalf("provider event id = %q", event.ProviderEventID)
	}
	if event.Metadata["billing_period"] != "month" || event.Metadata["billing_interval"] != "1" || event.Metadata["total_cents"] != 2900 || event.Metadata["payment_method"] != "stripe" {
		t.Fatalf("metadata = %+v", event.Metadata)
	}
	codes, _ := event.Metadata["discount_codes"].([]string)
	if len(codes) != 1 || codes[0] != "VIP20" {
		t.Fatalf("discount codes = %+v", event.Metadata["discount_codes"])
	}
	lineItems, _ := event.Metadata["line_items"].([]map[string]any)
	if len(lineItems) != 1 || lineItems[0]["sku"] != "BOX-MONTHLY" || lineItems[0]["total_cents"] != 2900 {
		t.Fatalf("line items = %+v", event.Metadata["line_items"])
	}
	if len(store.orders) != 0 || store.processed != 1 {
		t.Fatalf("unexpected order upserts=%+v processed=%d", store.orders, store.processed)
	}
}

func TestWooCommerceWebhookRejectsInvalidSignature(t *testing.T) {
	body := []byte(`{"id":55,"status":"processing"}`)
	store := &fakeStore{integration: &Integration{
		ID:            "00000000-0000-0000-0000-000000000002",
		TenantID:      "00000000-0000-0000-0000-000000000001",
		Provider:      ProviderWooCommerce,
		ShopDomain:    "https://store.example",
		WebhookSecret: "wc-secret",
	}}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/woocommerce/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-WC-Webhook-Source", "https://store.example/")
	req.Header.Set("X-WC-Webhook-Topic", "order.updated")
	req.Header.Set("X-WC-Webhook-ID", "142")
	req.Header.Set("X-WC-Webhook-Delivery-ID", "9001")
	req.Header.Set("X-WC-Webhook-Signature", signShopifyTest("different-secret", body))
	rec := httptest.NewRecorder()

	deps.WooCommerceWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.orders) != 0 || store.processed != 0 {
		t.Fatalf("unexpected dispatch orders=%+v processed=%d", store.orders, store.processed)
	}
}

func TestShopifyWebhookDispatchesCheckoutToCartRecovery(t *testing.T) {
	body := []byte(`{
		"id": 123456,
		"token": "checkout_token_1",
		"cart_token": "cart_token_1",
		"email": "Buyer@Example.COM",
		"abandoned_checkout_url": "https://demo.myshopify.com/checkouts/recover/abc",
		"currency": "usd",
		"subtotal_price": "40.00",
		"total_discounts": "5.00",
		"total_price": "35.00",
		"discount_codes": [{"code": "WELCOME10", "amount": "5.00"}],
		"line_items": [{"id": 1, "product_id": 99, "variant_id": 100, "title": "Template Pack", "quantity": 1, "price": "40.00"}]
	}`)
	store := &fakeStore{integration: &Integration{
		ID: "00000000-0000-0000-0000-000000000002", TenantID: "00000000-0000-0000-0000-000000000001",
		Provider: ProviderShopify, ShopDomain: "demo.myshopify.com", WebhookSecret: "secret",
	}}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/shopify/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Shopify-Shop-Domain", "demo.myshopify.com")
	req.Header.Set("X-Shopify-Topic", "checkouts/update")
	req.Header.Set("X-Shopify-Webhook-Id", "wh_checkout_1")
	req.Header.Set("X-Shopify-Hmac-Sha256", signShopifyTest("secret", body))
	rec := httptest.NewRecorder()

	deps.ShopifyWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastCartRecovery.SourceCartID != "cart_token_1" || store.lastCartRecovery.CustomerEmail != "buyer@example.com" {
		t.Fatalf("cart recovery = %+v", store.lastCartRecovery)
	}
	if store.lastCartRecovery.RecoveryURL != "https://demo.myshopify.com/checkouts/recover/abc" || store.lastCartRecovery.Status != "active" {
		t.Fatalf("cart recovery link/status = %+v", store.lastCartRecovery)
	}
	codes, _ := store.lastCartRecovery.Metadata["discount_codes"].([]string)
	if len(codes) != 1 || codes[0] != "WELCOME10" || store.lastCartRecovery.Metadata["discount_cents"] != 500 {
		t.Fatalf("cart recovery metadata = %+v", store.lastCartRecovery.Metadata)
	}
	if len(store.orders) != 0 {
		t.Fatalf("checkout webhook should not upsert an order: %+v", store.orders)
	}
}

// TestShopifyWebhookFreshnessGate covers the X-Shopify-Triggered-At
// drift check (integration-auth HIGH #4). The signature alone
// doesn't bind a timestamp, so a captured (body, signature) pair
// could be replayed indefinitely; the freshness check at least
// catches casual log-replay attacks.
//
// Five cases pinned:
//   - header absent → accept (back-compat with non-Shopify-sourced
//     test traffic).
//   - within 5 min → accept.
//   - 6 min stale  → reject 401 stale_request.
//   - 6 min in the future (clock skew) → reject (drift is absolute).
//   - malformed RFC3339 → silently accept (we don't fail-closed on
//     a header we couldn't parse; the HMAC was already valid).
func TestShopifyWebhookFreshnessGate(t *testing.T) {
	cases := []struct {
		name        string
		triggeredAt string
		useFallback bool
		wantStatus  int
		wantCode    string // error.code in body; "" if status==202
	}{
		{name: "header absent", wantStatus: http.StatusAccepted},
		{name: "within window", triggeredAt: time.Now().UTC().Add(-1 * time.Minute).Format(time.RFC3339), wantStatus: http.StatusAccepted},
		{name: "stale by 6 min", triggeredAt: time.Now().UTC().Add(-6 * time.Minute).Format(time.RFC3339), wantStatus: http.StatusUnauthorized, wantCode: "stale_request"},
		{name: "future by 6 min", triggeredAt: time.Now().UTC().Add(6 * time.Minute).Format(time.RFC3339), wantStatus: http.StatusUnauthorized, wantCode: "stale_request"},
		{name: "malformed header", triggeredAt: "not-a-timestamp", wantStatus: http.StatusAccepted},
		{name: "legacy sent-at fallback", triggeredAt: time.Now().UTC().Add(-1 * time.Minute).Format(time.RFC3339), useFallback: true, wantStatus: http.StatusAccepted},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := []byte(`{"id":42,"email":"buyer@example.com","accepts_marketing":true}`)
			store := &fakeStore{integration: &Integration{
				ID: "00000000-0000-0000-0000-000000000002", TenantID: "00000000-0000-0000-0000-000000000001",
				Provider: ProviderShopify, ShopDomain: "demo.myshopify.com", WebhookSecret: "secret",
			}}
			deps := &Deps{Repo: store}
			req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/shopify/webhooks", strings.NewReader(string(body)))
			req.Header.Set("X-Shopify-Shop-Domain", "demo.myshopify.com")
			req.Header.Set("X-Shopify-Topic", "customers/create")
			req.Header.Set("X-Shopify-Webhook-Id", "wh_freshness_"+tc.name)
			req.Header.Set("X-Shopify-Hmac-Sha256", signShopifyTest("secret", body))
			if tc.triggeredAt != "" {
				if tc.useFallback {
					req.Header.Set("X-Shopify-Sent-At", tc.triggeredAt)
				} else {
					req.Header.Set("X-Shopify-Triggered-At", tc.triggeredAt)
				}
			}
			rec := httptest.NewRecorder()
			deps.ShopifyWebhook(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d body=%s", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantCode != "" && !strings.Contains(rec.Body.String(), tc.wantCode) {
				t.Errorf("body does not contain error code %q; body=%s", tc.wantCode, rec.Body.String())
			}
			// Accept-path sanity: the dispatcher should have run + the
			// fake should have seen exactly one customer upsert.
			if tc.wantStatus == http.StatusAccepted && len(store.customers) != 1 {
				t.Errorf("accept path: customers = %d, want 1", len(store.customers))
			}
			// Reject-path sanity: the dispatcher must NOT run when the
			// freshness gate rejects; otherwise a stale replay still
			// pollutes the store.
			if tc.wantStatus != http.StatusAccepted && len(store.customers) != 0 {
				t.Errorf("reject path: customers = %d, want 0 (dispatcher fired despite reject)", len(store.customers))
			}
		})
	}
}

func TestShopifyWebhookRejectsUnsignedByDefault(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID: "00000000-0000-0000-0000-000000000002", TenantID: "00000000-0000-0000-0000-000000000001",
		Provider: ProviderShopify, ShopDomain: "demo.myshopify.com", WebhookSecret: "secret",
	}}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/shopify/webhooks", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Shopify-Shop-Domain", "demo.myshopify.com")
	req.Header.Set("X-Shopify-Topic", "customers/create")
	rec := httptest.NewRecorder()

	deps.ShopifyWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestShopifyPrivacyWebhookRedactsCustomerData(t *testing.T) {
	body := []byte(`{
		"shop_id":954889,
		"shop_domain":"demo.myshopify.com",
		"customer":{"id":191167,"email":"JOHN@example.com","phone":"555-625-1199"},
		"orders_to_redact":[299938,280263]
	}`)
	store := &fakeStore{integration: &Integration{
		ID: "00000000-0000-0000-0000-000000000002", TenantID: "00000000-0000-0000-0000-000000000001",
		Provider: ProviderShopify, ShopDomain: "demo.myshopify.com", WebhookSecret: "secret",
	}}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/shopify/privacy", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Shopify-Topic", "customers/redact")
	req.Header.Set("X-Shopify-Webhook-Id", "privacy_1")
	req.Header.Set("X-Shopify-Hmac-Sha256", signShopifyTest("secret", body))
	rec := httptest.NewRecorder()

	deps.ShopifyPrivacyWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !hasString(store.redaction.CustomerSourceIDs, "191167") || !hasString(store.redaction.CustomerSourceIDs, "gid://shopify/Customer/191167") {
		t.Fatalf("customer redaction ids = %+v", store.redaction.CustomerSourceIDs)
	}
	if len(store.redaction.Emails) != 1 || store.redaction.Emails[0] != "john@example.com" {
		t.Fatalf("redaction emails = %+v", store.redaction.Emails)
	}
	if !hasString(store.redaction.OrderSourceIDs, "299938") || !hasString(store.redaction.OrderSourceIDs, "gid://shopify/Order/280263") {
		t.Fatalf("order redaction ids = %+v", store.redaction.OrderSourceIDs)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestShopifyPrivacyWebhookCollectsCustomerDataRequest(t *testing.T) {
	body := []byte(`{
		"shop_id":954889,
		"shop_domain":"demo.myshopify.com",
		"orders_requested":[299938,280263],
		"customer":{"id":191167,"email":"JOHN@example.com","phone":"555-625-1199"},
		"data_request":{"id":9999}
	}`)
	store := &fakeStore{integration: &Integration{
		ID: "00000000-0000-0000-0000-000000000002", TenantID: "00000000-0000-0000-0000-000000000001",
		Provider: ProviderShopify, ShopDomain: "demo.myshopify.com", WebhookSecret: "secret",
	}}
	deps := &Deps{Repo: store, Now: func() time.Time {
		return time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	}}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/shopify/privacy", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Shopify-Topic", "customers/data_request")
	req.Header.Set("X-Shopify-Webhook-Id", "privacy_data_1")
	req.Header.Set("X-Shopify-Hmac-Sha256", signShopifyTest("secret", body))
	rec := httptest.NewRecorder()

	deps.ShopifyPrivacyWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.dataRequest.RequestID != "9999" {
		t.Fatalf("request id = %q", store.dataRequest.RequestID)
	}
	if !hasString(store.dataRequest.CustomerSourceIDs, "191167") || !hasString(store.dataRequest.CustomerSourceIDs, "gid://shopify/Customer/191167") {
		t.Fatalf("customer request ids = %+v", store.dataRequest.CustomerSourceIDs)
	}
	if len(store.dataRequest.Emails) != 1 || store.dataRequest.Emails[0] != "john@example.com" {
		t.Fatalf("request emails = %+v", store.dataRequest.Emails)
	}
	if !hasString(store.dataRequest.OrderSourceIDs, "299938") || !hasString(store.dataRequest.OrderSourceIDs, "gid://shopify/Order/280263") {
		t.Fatalf("order request ids = %+v", store.dataRequest.OrderSourceIDs)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestShopifyPrivacyPayloadBuildsDataRequestFromEmailOnlyCustomer(t *testing.T) {
	payload, err := parseShopifyPrivacyWebhookPayload([]byte(`{
		"shop_id":954889,
		"shop_domain":"demo.myshopify.com",
		"orders_requested":[299938],
		"customer":{"email":"email-only@example.com"},
		"data_request":{"id":7777}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	req := payload.customerDataRequest()
	if req.RequestID != "7777" {
		t.Fatalf("request id = %q", req.RequestID)
	}
	if len(req.CustomerSourceIDs) != 0 {
		t.Fatalf("email-only customer should not produce numeric customer IDs: %+v", req.CustomerSourceIDs)
	}
	if len(req.Emails) != 1 || req.Emails[0] != "email-only@example.com" {
		t.Fatalf("emails = %+v", req.Emails)
	}
	if !hasString(req.OrderSourceIDs, "299938") || !hasString(req.OrderSourceIDs, "gid://shopify/Order/299938") {
		t.Fatalf("order ids = %+v", req.OrderSourceIDs)
	}
}

func TestShopifyPrivacyWebhookShopRedactDeletesIntegration(t *testing.T) {
	body := []byte(`{"shop_id":954889,"shop_domain":"demo.myshopify.com"}`)
	store := &fakeStore{integration: &Integration{
		ID: "00000000-0000-0000-0000-000000000002", TenantID: "00000000-0000-0000-0000-000000000001",
		Provider: ProviderShopify, ShopDomain: "demo.myshopify.com", WebhookSecret: "secret",
	}}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/shopify/privacy", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Shopify-Topic", "shop/redact")
	req.Header.Set("X-Shopify-Webhook-Id", "privacy_shop_1")
	req.Header.Set("X-Shopify-Hmac-Sha256", signShopifyTest("secret", body))
	rec := httptest.NewRecorder()

	deps.ShopifyPrivacyWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.deletedID != "00000000-0000-0000-0000-000000000002" {
		t.Fatalf("deletedID = %q", store.deletedID)
	}
}

func TestExchangeShopifyCodeUsesDocumentedFormRequest(t *testing.T) {
	deps := &Deps{
		Config: Config{
			ShopifyClientID:     "client-id",
			ShopifyClientSecret: "client-secret",
		},
		HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if got := r.Method; got != http.MethodPost {
				t.Fatalf("method = %q", got)
			}
			if got := r.URL.String(); got != "https://demo.myshopify.com/admin/oauth/access_token" {
				t.Fatalf("request URL = %q", got)
			}
			if got := r.Header.Get("Content-Type"); got != "application/x-www-form-urlencoded" {
				t.Fatalf("Content-Type = %q", got)
			}
			if got := r.Header.Get("Accept"); got != "application/json" {
				t.Fatalf("Accept = %q", got)
			}
			raw, err := io.ReadAll(r.Body)
			if err != nil {
				t.Fatalf("read request body: %v", err)
			}
			form, err := url.ParseQuery(string(raw))
			if err != nil {
				t.Fatalf("parse request body: %v", err)
			}
			if form.Get("client_id") != "client-id" || form.Get("client_secret") != "client-secret" || form.Get("code") != "code-123" {
				t.Fatalf("form = %v", form)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Status:     "200 OK",
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"access_token":"token-123"}`)),
				Request:    r,
			}, nil
		})},
	}

	token, local, err := deps.exchangeShopifyCode(context.Background(), "demo.myshopify.com", "code-123")
	if err != nil {
		t.Fatalf("exchangeShopifyCode: %v", err)
	}
	if token != "token-123" || local {
		t.Fatalf("token/local = %q/%v", token, local)
	}
}

func TestShopifyOAuthCallbackRegistersWebhooksBeforeSavingInstall(t *testing.T) {
	now := time.Date(2026, 6, 18, 10, 0, 0, 0, time.UTC)
	state, err := BuildOAuthState("state-secret", "00000000-0000-0000-0000-000000000001", "demo.myshopify.com", "nonce-1", now)
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeStore{}
	registrar := &fakeShopifyWebhookRegistrar{}
	deps := &Deps{
		Repo: store,
		Config: Config{
			ShopifyClientID:         "client-id",
			ShopifyClientSecret:     "client-secret",
			ShopifyStateSecret:      "state-secret",
			ShopifyOAuthRedirectURL: "https://app.postwave.test/api/public/commerce/shopify/oauth/callback",
			ShopifyWebhookSecret:    "webhook-secret",
		},
		Now:                     func() time.Time { return now },
		ShopifyWebhookRegistrar: registrar,
		HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			return jsonResponse(http.StatusOK, `{"access_token":"shpat_live"}`), nil
		})},
	}
	q := url.Values{}
	q.Set("shop", "demo.myshopify.com")
	q.Set("timestamp", "1781786400")
	q.Set("code", "code-123")
	q.Set("state", state)
	q = signShopifyOAuthQuery("client-secret", q)
	req := httptest.NewRequest(http.MethodGet, "/api/public/commerce/shopify/oauth/callback?"+q.Encode(), nil)
	rec := httptest.NewRecorder()

	deps.ShopifyOAuthCallback(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.integration.ShopDomain != "demo.myshopify.com" || registrar.integration.AccessToken != "shpat_live" {
		t.Fatalf("registrar integration = %+v", registrar.integration)
	}
	if registrar.baseURL != "https://app.postwave.test" {
		t.Fatalf("registrar baseURL = %q", registrar.baseURL)
	}
	if store.lastIntegrationInput.AccessToken != "shpat_live" || store.lastIntegrationInput.WebhookSecret != "webhook-secret" {
		t.Fatalf("stored install input = %+v", store.lastIntegrationInput)
	}
	if store.lastIntegrationInput.Settings["shopify_webhook_endpoint"] == "" {
		t.Fatalf("settings missing webhook endpoint: %+v", store.lastIntegrationInput.Settings)
	}
	var res OAuthCallbackResponse
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if res.WebhookRegistration == nil || len(res.WebhookRegistration.Subscriptions) != 1 {
		t.Fatalf("webhook registration response = %+v", res.WebhookRegistration)
	}
}

func TestExchangeShopifyCodeCapsSuccessResponseBody(t *testing.T) {
	deps := &Deps{
		Config: Config{
			ShopifyClientID:     "client-id",
			ShopifyClientSecret: "client-secret",
		},
		HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if got := r.URL.String(); got != "https://demo.myshopify.com/admin/oauth/access_token" {
				t.Fatalf("request URL = %q", got)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Status:     "200 OK",
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(strings.Repeat("{", int(commerceShopifyTokenResponseMaxBytes)+1))),
				Request:    r,
			}, nil
		})},
	}

	_, _, err := deps.exchangeShopifyCode(context.Background(), "demo.myshopify.com", "code")
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("exchangeShopifyCode error = %v, want response body too large", err)
	}
}

func TestStartShopifyOAuthRejectsLocalFallbackInProduction(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")

	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/commerce/shopify/oauth/start?shop=demo.myshopify.com", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.StartShopifyOAuth(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "internal_error") || strings.Contains(rec.Body.String(), "shopify_not_configured") {
		t.Fatalf("5xx body was not centrally redacted: %s", rec.Body.String())
	}
}

func TestListProvidersDisclosesShopifyGraphQLBackfillFoundation(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/commerce/providers", nil)
	rec := httptest.NewRecorder()

	deps.ListProviders(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Items []ProviderSpec `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	for _, item := range res.Items {
		if item.Provider != ProviderShopify {
			continue
		}
		if item.RuntimeStatus != "partial" || item.SyncModel != commerceSyncModelShopify {
			t.Fatalf("Shopify spec must remain partial with the owned sync model, got %+v", item)
		}
		if !hasString(item.SyncObjects, "customers") || !hasString(item.SyncObjects, "orders") {
			t.Fatalf("Shopify spec missing current commerce sync objects: %+v", item)
		}
		if !hasString(item.WebhookTopics, "bulk_operations/finish") {
			t.Fatalf("Shopify spec must disclose async bulk completion webhook support: %+v", item)
		}
		return
	}
	t.Fatalf("Shopify provider missing from %+v", res.Items)
}

func TestListProvidersIncludesManagedBigCommerce(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/commerce/providers", nil)
	rec := httptest.NewRecorder()

	deps.ListProviders(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Items []ProviderSpec `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	for _, item := range res.Items {
		if item.Provider == ProviderBigCommerce {
			if !item.Managed || item.AuthMode != "api_key_ref" || item.RuntimeStatus != "partial" {
				t.Fatalf("unexpected BigCommerce spec: %+v", item)
			}
			if !hasProviderField(item.RequiredSettings, "credential_ref") {
				t.Fatalf("BigCommerce spec must expose API credential refs: %+v", item)
			}
			if !hasProviderField(item.OptionalSettings, "channel_id") || !hasProviderField(item.OptionalSettings, "webhook_auth_ref") {
				t.Fatalf("BigCommerce spec must expose channel and webhook auth settings: %+v", item)
			}
			if item.SyncModel != commerceSyncModelBig || item.VerificationMode != "postwave_custom_header_secret" || !hasString(item.SyncObjects, "customers") || !hasString(item.SyncObjects, "orders") {
				t.Fatalf("BigCommerce spec should expose managed runtime sync objects: %+v", item)
			}
			if !hasString(item.Scopes, "store_v2_products_read_only") ||
				!hasString(item.SyncObjects, "refunds") ||
				!hasString(item.SyncObjects, "transactions") ||
				!hasString(item.WebhookTopics, "store/order/updated") ||
				!hasString(item.WebhookTopics, "store/customer/deleted") ||
				!hasString(item.WebhookTopics, "store/product/inventory/updated") ||
				!hasString(item.WebhookTopics, "store/order/archived") ||
				!hasString(item.WebhookTopics, "store/order/refund/created") ||
				!hasString(item.WebhookTopics, "store/order/transaction/created") {
				t.Fatalf("BigCommerce spec missing OAuth scopes/webhook topics: %+v", item)
			}
			return
		}
	}
	t.Fatalf("BigCommerce provider missing from %+v", res.Items)
}

func TestListProvidersIncludesManagedWooCommerce(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/commerce/providers", nil)
	rec := httptest.NewRecorder()

	deps.ListProviders(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Items []ProviderSpec `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	for _, item := range res.Items {
		if item.Provider != ProviderWooCommerce {
			continue
		}
		if !item.Managed || item.AuthMode != "api_key_ref" || item.RuntimeStatus != "partial" {
			t.Fatalf("unexpected WooCommerce spec: %+v", item)
		}
		if !hasProviderField(item.RequiredSettings, "credential_ref") {
			t.Fatalf("WooCommerce spec must expose API credential refs: %+v", item)
		}
		if hasProviderField(item.OptionalSettings, "webhook_secret_ref") {
			t.Fatalf("WooCommerce spec should use the generated encrypted webhook secret, not a manual secret ref: %+v", item)
		}
		if item.SyncModel != commerceSyncModelWoo || len(item.Scopes) != 3 {
			t.Fatalf("WooCommerce spec should expose the REST backfill model and read scopes: %+v", item)
		}
		if !hasProviderField(item.OptionalSettings, "subscriptions_enabled") || !hasString(item.Capabilities, "subscriptions") {
			t.Fatalf("WooCommerce spec should disclose optional Subscriptions extension coverage: %+v", item)
		}
		if len(item.WebhookTopics) != len(allWooCommerceWebhookTopics()) || !hasString(item.WebhookTopics, "order.updated") || !hasString(item.WebhookTopics, "subscription.updated") || !hasString(item.SyncObjects, "refunds") || !hasString(item.SyncObjects, "subscriptions") || !hasString(item.SyncObjects, "events") {
			t.Fatalf("WooCommerce spec should expose the managed webhook topics it registers: %+v", item)
		}
		return
	}
	t.Fatalf("WooCommerce provider missing from %+v", res.Items)
}

func TestListProvidersIncludesManagedPaymentConnectors(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/commerce/providers", nil)
	rec := httptest.NewRecorder()

	deps.ListProviders(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Items []ProviderSpec `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	seen := map[string]ProviderSpec{}
	for _, item := range res.Items {
		seen[item.Provider] = item
	}
	paypal, ok := seen[ProviderPayPal]
	if !ok {
		t.Fatalf("PayPal provider missing from %+v", res.Items)
	}
	if !paypal.Managed || paypal.Category != "payments" || paypal.RuntimeStatus != "partial" {
		t.Fatalf("unexpected PayPal spec: %+v", paypal)
	}
	if paypal.AuthMode != "client_credentials_ref" || !hasProviderField(paypal.RequiredSettings, "merchant_id") || !hasProviderField(paypal.RequiredSettings, "credential_ref") || !hasProviderField(paypal.OptionalSettings, "webhook_id") {
		t.Fatalf("PayPal spec should expose merchant, client credentials, and webhook ID refs: %+v", paypal)
	}
	if paypal.SyncModel != commerceSyncModelPayPal || len(paypal.WebhookTopics) == 0 || len(paypal.Scopes) == 0 {
		t.Fatalf("PayPal should expose managed reporting/webhook metadata: %+v", paypal)
	}
	if paypal.VerificationMode != "paypal_verify_webhook_signature_api" {
		t.Fatalf("PayPal verification mode should expose Verify Webhook Signature API, got %q", paypal.VerificationMode)
	}
	if !hasString(paypal.WebhookTopics, "PAYMENT.CAPTURE.COMPLETED") ||
		!hasString(paypal.WebhookTopics, "PAYMENT.CAPTURE.REVERSED") ||
		!hasString(paypal.WebhookTopics, "PAYMENT.SALE.PENDING") ||
		!hasString(paypal.WebhookTopics, "PAYMENT.SALE.DENIED") ||
		!hasString(paypal.WebhookTopics, "PAYMENT.SALE.REVERSED") ||
		!hasString(paypal.WebhookTopics, "BILLING.SUBSCRIPTION.PAYMENT.FAILED") ||
		!hasString(paypal.WebhookTopics, "INVOICING.INVOICE.PAID") ||
		!hasString(paypal.WebhookTopics, "CATALOG.PRODUCT.UPDATED") ||
		!hasString(paypal.SyncObjects, "transactions") ||
		!hasString(paypal.SyncObjects, "refunds") ||
		!hasString(paypal.SyncObjects, "invoice_events") ||
		!hasString(paypal.SyncObjects, "subscription_events") ||
		!hasString(paypal.SyncObjects, "catalog_product_events") {
		t.Fatalf("PayPal spec should disclose payment/subscription/invoice/catalog webhook evidence and transaction backfill: %+v", paypal)
	}
}

func TestListProvidersIncludesStripeAndSquarePrecisionMetadata(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/commerce/providers", nil)
	rec := httptest.NewRecorder()

	deps.ListProviders(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Items []ProviderSpec `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	seen := map[string]ProviderSpec{}
	for _, item := range res.Items {
		seen[item.Provider] = item
	}
	stripe, ok := seen[ProviderStripe]
	if !ok {
		t.Fatalf("Stripe provider missing from %+v", res.Items)
	}
	if !hasProviderField(stripe.RequiredSettings, "account_id") || !hasProviderField(stripe.RequiredSettings, "credential_ref") || !hasProviderField(stripe.OptionalSettings, "webhook_secret_ref") {
		t.Fatalf("Stripe spec should expose account, restricted-key, and webhook-secret refs: %+v", stripe)
	}
	if stripe.AuthMode != "api_key_ref" || stripe.SyncModel != commerceSyncModelStripe || len(stripe.WebhookTopics) == 0 || len(stripe.Scopes) == 0 {
		t.Fatalf("Stripe spec should expose managed backfill/webhook metadata: %+v", stripe)
	}
	if !hasString(stripe.WebhookTopics, "checkout.session.completed") ||
		!hasString(stripe.WebhookTopics, "charge.succeeded") ||
		!hasString(stripe.WebhookTopics, "charge.dispute.created") ||
		!hasString(stripe.WebhookTopics, "invoice.created") ||
		!hasString(stripe.WebhookTopics, "invoice.finalized") ||
		!hasString(stripe.WebhookTopics, "invoice.updated") ||
		!hasString(stripe.WebhookTopics, "invoice.deleted") ||
		!hasString(stripe.WebhookTopics, "credit_note.voided") ||
		!hasString(stripe.WebhookTopics, "customer.subscription.pending_update_applied") ||
		!hasString(stripe.WebhookTopics, "customer.subscription.trial_will_end") ||
		!hasString(stripe.SyncObjects, "payment_intents") ||
		!hasString(stripe.SyncObjects, "charges") ||
		!hasString(stripe.SyncObjects, "disputes") ||
		!hasString(stripe.SyncObjects, "credit_notes") ||
		!hasString(stripe.Scopes, "charges:read") ||
		!hasString(stripe.Scopes, "disputes:read") ||
		!hasString(stripe.Scopes, "credit_notes:read") {
		t.Fatalf("Stripe spec should disclose checkout/charge/dispute/invoice/credit-note/subscription webhooks plus payment intent, charge, dispute, and credit-note backfill: %+v", stripe)
	}
	square, ok := seen[ProviderSquare]
	if !ok {
		t.Fatalf("Square provider missing from %+v", res.Items)
	}
	if square.AuthMode != "oauth_or_app_token_ref" || !hasProviderField(square.OptionalSettings, "webhook_signature_ref") {
		t.Fatalf("Square spec should expose token refs and managed webhook signature setup: %+v", square)
	}
	if square.SyncModel != commerceSyncModelSquare || len(square.WebhookTopics) == 0 || len(square.Scopes) == 0 {
		t.Fatalf("Square spec should expose managed backfill/webhook metadata: %+v", square)
	}
	if !hasString(square.Scopes, "CUSTOMERS_READ") ||
		!hasString(square.Scopes, "MERCHANT_PROFILE_READ") ||
		!hasString(square.WebhookTopics, "payment.created") ||
		!hasString(square.WebhookTopics, "catalog.version.updated") ||
		!hasString(square.SyncObjects, "refunds") {
		t.Fatalf("Square spec should disclose REST scopes, catalog/payment webhooks, and refund backfill: %+v", square)
	}
	razorpay, ok := seen[ProviderRazorpay]
	if !ok {
		t.Fatalf("Razorpay provider missing from %+v", res.Items)
	}
	if razorpay.AuthMode != "api_key_ref" || !hasProviderField(razorpay.RequiredSettings, "account_id") || !hasProviderField(razorpay.RequiredSettings, "credential_ref") || !hasProviderField(razorpay.OptionalSettings, "webhook_secret_ref") {
		t.Fatalf("Razorpay spec should expose account, key, and webhook-secret refs: %+v", razorpay)
	}
	if razorpay.SyncModel != commerceSyncModelRazorpay || len(razorpay.WebhookTopics) == 0 || len(razorpay.Scopes) == 0 {
		t.Fatalf("Razorpay spec should expose managed backfill/webhook metadata: %+v", razorpay)
	}
	if !hasString(razorpay.WebhookTopics, "payment.captured") || !hasString(razorpay.WebhookTopics, "refund.processed") || !hasString(razorpay.SyncObjects, "payments") || !hasString(razorpay.SyncObjects, "refunds") {
		t.Fatalf("Razorpay spec should disclose payment/refund webhooks and backfill objects: %+v", razorpay)
	}
}

func TestListProvidersIncludesManagedCreatorCommerceConnectors(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/commerce/providers", nil)
	rec := httptest.NewRecorder()

	deps.ListProviders(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Items []ProviderSpec `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	seen := map[string]ProviderSpec{}
	for _, item := range res.Items {
		seen[item.Provider] = item
	}
	for _, provider := range []string{ProviderWixStores, ProviderSquarespace} {
		item, ok := seen[provider]
		if !ok {
			t.Fatalf("%s provider missing from %+v", provider, res.Items)
		}
		if !item.Managed || item.Category != "ecommerce" || item.RuntimeStatus != "partial" {
			t.Fatalf("unexpected %s spec: %+v", provider, item)
		}
		if len(item.RequiredSettings) == 0 || len(item.SyncObjects) == 0 {
			t.Fatalf("incomplete %s spec: %+v", provider, item)
		}
	}
}

func TestListProvidersIncludesWixAndSquarespacePrecisionMetadata(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/commerce/providers", nil)
	rec := httptest.NewRecorder()

	deps.ListProviders(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Items []ProviderSpec `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	seen := map[string]ProviderSpec{}
	for _, item := range res.Items {
		seen[item.Provider] = item
	}
	wix, ok := seen[ProviderWixStores]
	if !ok {
		t.Fatalf("Wix Stores provider missing from %+v", res.Items)
	}
	if wix.AuthMode != "oauth_app_instance_ref" || !hasProviderField(wix.RequiredSettings, "instance_id") {
		t.Fatalf("Wix Stores spec should expose app-instance token setup: %+v", wix)
	}
	if wix.SyncModel != commerceSyncModelWix ||
		!hasProviderField(wix.OptionalSettings, "catalog_version") ||
		len(wix.WebhookTopics) == 0 ||
		!hasString(wix.SyncObjects, "orders") ||
		!hasString(wix.SyncObjects, "subscriptions") ||
		!hasString(wix.SyncObjects, "bookings") ||
		!hasString(wix.SyncObjects, "tickets") ||
		!hasString(wix.WebhookTopics, "wix.ecom.v1.order.canceled") ||
		!hasString(wix.WebhookTopics, "wix.contacts.v4.contact.deleted") ||
		!hasString(wix.WebhookTopics, "wix.stores.catalog.v3.product.deleted") ||
		!hasString(wix.WebhookTopics, "wix.pricing_plans.v2.order_purchased") ||
		!hasString(wix.WebhookTopics, "wix.events.v1.ticket.purchased") {
		t.Fatalf("Wix Stores spec should expose managed REST/webhook/catalog metadata: %+v", wix)
	}
	squarespace, ok := seen[ProviderSquarespace]
	if !ok {
		t.Fatalf("Squarespace provider missing from %+v", res.Items)
	}
	if squarespace.AuthMode != "api_key_or_oauth_ref" || !hasProviderField(squarespace.OptionalSettings, "webhook_secret_ref") {
		t.Fatalf("Squarespace spec should expose API/OAuth refs with webhook secret setup: %+v", squarespace)
	}
	if squarespace.SyncModel != commerceSyncModelSquarespace || len(squarespace.WebhookTopics) == 0 || !hasString(squarespace.SyncObjects, "orders") {
		t.Fatalf("Squarespace spec should expose managed REST/webhook/backfill metadata: %+v", squarespace)
	}
}

func TestListProvidersIncludesAdobeCommerceConnector(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/commerce/providers", nil)
	rec := httptest.NewRecorder()

	deps.ListProviders(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Items []ProviderSpec `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	for _, item := range res.Items {
		if item.Provider != ProviderAdobeCommerce {
			continue
		}
		if !item.Managed || item.Category != "ecommerce" || item.AuthMode != "access_token_ref" || item.RuntimeStatus != "partial" {
			t.Fatalf("unexpected Adobe Commerce spec: %+v", item)
		}
		if !hasProviderField(item.RequiredSettings, "credential_ref") {
			t.Fatalf("Adobe Commerce spec should expose token refs: %+v", item)
		}
		if !hasProviderField(item.OptionalSettings, "event_auth_ref") || item.SyncModel != commerceSyncModelAdobe || len(item.WebhookTopics) == 0 || len(item.Scopes) == 0 {
			t.Fatalf("Adobe Commerce spec should expose managed REST/webhook metadata: %+v", item)
		}
		if !hasString(item.SyncObjects, "creditmemos") || !hasString(item.WebhookTopics, "sales_order_creditmemo_refund") || !hasString(item.Scopes, "Magento_Sales::sales") {
			t.Fatalf("Adobe Commerce spec should disclose sales/refund sync details: %+v", item)
		}
		return
	}
	t.Fatalf("Adobe Commerce provider missing from %+v", res.Items)
}

func TestCreateIntegrationCreatesBigCommerceWithCredentialRef(t *testing.T) {
	store := &fakeStore{}
	registrar := &fakeBigCommerceWebhookRegistrar{}
	deps := &Deps{Repo: store, BigCommerceWebhookRegistrar: registrar}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations", strings.NewReader(`{
		"provider":"bigcommerce",
		"settings":{
			"store_hash":"https://api.bigcommerce.com/stores/ABC123/v3/",
			"credential_ref":"cred_bigcommerce_1",
			"channel_id":"1"
		}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateIntegration(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	got := store.lastIntegrationInput
	if store.lastTenantID != "tenant-1" || got.Provider != ProviderBigCommerce || got.ShopDomain != "abc123" || got.Status != "connected" {
		t.Fatalf("stored input = %+v tenant=%s", got, store.lastTenantID)
	}
	if got.Settings["store_hash"] != "abc123" {
		t.Fatalf("store hash was not normalized: %+v", got.Settings)
	}
	if got.CredentialRef != "cred_bigcommerce_1" || got.Settings["credential_ref"] != "cred_bigcommerce_1" {
		t.Fatalf("credential ref not preserved: %+v", got)
	}
	if _, ok := got.Settings["access_token"]; ok {
		t.Fatalf("raw access token leaked into settings: %+v", got.Settings)
	}
	if !hasString(got.Scopes, "store_v2_products_read_only") || got.Settings["managed_by_postwave"] != true || got.Settings["sync_model"] != commerceSyncModelBig {
		t.Fatalf("expected managed scopes/settings, got %+v", got)
	}
	if registrar.integration.WebhookSecret == "" || registrar.integration.Settings["store_hash"] != "abc123" {
		t.Fatalf("registrar integration = %+v", registrar.integration)
	}
	if got.WebhookSecret == "" || got.Settings["bigcommerce_webhook_endpoint"] == "" || got.Settings["bigcommerce_webhook_subscriptions"] == nil {
		t.Fatalf("webhook settings not persisted: %+v", got)
	}
}

func TestCreateBigCommerceIntegrationReusesExistingWebhookSecret(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:            "int_existing",
		TenantID:      "tenant-1",
		Provider:      ProviderBigCommerce,
		ShopDomain:    "abc123",
		WebhookSecret: "existing-bc-secret",
		Settings:      map[string]any{"store_hash": "abc123"},
	}}
	registrar := &fakeBigCommerceWebhookRegistrar{}
	deps := &Deps{Repo: store, BigCommerceWebhookRegistrar: registrar}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations", strings.NewReader(`{
		"provider":"bigcommerce",
		"settings":{
			"store_hash":"abc123",
			"credential_ref":"cred_bigcommerce_1"
		}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateIntegration(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastBigStoreHash != "abc123" || store.lastTenantID != "tenant-1" {
		t.Fatalf("lookup store=%q tenant=%q", store.lastBigStoreHash, store.lastTenantID)
	}
	if store.lastIntegrationInput.WebhookSecret != "existing-bc-secret" || registrar.integration.WebhookSecret != "existing-bc-secret" {
		t.Fatalf("stored=%q registrar=%q", store.lastIntegrationInput.WebhookSecret, registrar.integration.WebhookSecret)
	}
}

func TestCreateIntegrationRejectsInvalidBigCommerceStoreHash(t *testing.T) {
	store := &fakeStore{}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations", strings.NewReader(`{
		"provider":"bigcommerce",
		"settings":{
			"store_hash":"https://api.bigcommerce.com/not-stores/abc123/v3/",
			"credential_ref":"cred_bigcommerce_1"
		}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "store_hash") {
		t.Fatalf("body = %s, want store_hash validation", rec.Body.String())
	}
	if store.lastIntegrationInput.Provider != "" {
		t.Fatalf("invalid BigCommerce request should not upsert: %+v", store.lastIntegrationInput)
	}
}

func TestCreateIntegrationCreatesRazorpayWithCredentialRef(t *testing.T) {
	store := &fakeStore{}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations", strings.NewReader(`{
		"provider":"razorpay",
		"settings":{
			"account_id":"acc_123",
			"credential_ref":"cred_razorpay_live",
			"webhook_secret_ref":"cred_razorpay_webhook"
		}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateIntegration(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	got := store.lastIntegrationInput
	if got.Provider != ProviderRazorpay || got.ShopDomain != "acc_123" || got.CredentialRef != "cred_razorpay_live" {
		t.Fatalf("stored input = %+v", got)
	}
	if got.Settings["provider_status"] != "partial" || got.Settings["managed_by_postwave"] != true || got.Settings["sync_model"] != commerceSyncModelRazorpay {
		t.Fatalf("expected managed payment settings, got %+v", got.Settings)
	}
	if !hasString(got.Scopes, "payments:read") || got.Settings["webhook_secret_ref"] != "cred_razorpay_webhook" {
		t.Fatalf("Razorpay native connection should preserve scopes and webhook ref: %+v", got)
	}
}

func TestCreateIntegrationCreatesAdobeCommerceWithCredentialRef(t *testing.T) {
	store := &fakeStore{}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations", strings.NewReader(`{
		"provider":"adobe-commerce",
		"settings":{
			"base_url":"https://magento.example.com",
			"credential_ref":"cred_adobe_commerce_1",
			"store_view_code":"default"
		}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateIntegration(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	got := store.lastIntegrationInput
	if got.Provider != ProviderAdobeCommerce || got.ShopDomain != "https://magento.example.com" || got.CredentialRef != "cred_adobe_commerce_1" {
		t.Fatalf("stored input = %+v", got)
	}
	if got.Settings["provider_status"] != "partial" || got.Settings["managed_by_postwave"] != true || got.Settings["sync_model"] != commerceSyncModelAdobe {
		t.Fatalf("expected managed Adobe Commerce settings, got %+v", got.Settings)
	}
	if !hasString(got.Scopes, "Magento_Sales::sales") || got.Settings["store_view_code"] != "default" {
		t.Fatalf("Adobe Commerce native connection should preserve scopes and store view: %+v", got)
	}
}

func TestCreateIntegrationRejectsRawCredentials(t *testing.T) {
	store := &fakeStore{}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations", strings.NewReader(`{
		"provider":"bigcommerce",
		"settings":{"store_hash":"abc123","access_token":"shh"}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("body = %s, want raw_credentials_rejected", rec.Body.String())
	}
	if store.lastIntegrationInput.Provider != "" {
		t.Fatalf("raw credential request should not upsert: %+v", store.lastIntegrationInput)
	}
}

func TestCreateIntegrationRejectsWooCommerceCredentialAliases(t *testing.T) {
	store := &fakeStore{}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations", strings.NewReader(`{
		"provider":"woocommerce",
		"settings":{"store_url":"https://store.example","credential_ref":"cred_wc_1","ck":"shh","cs":"nope"}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("body = %s, want raw_credentials_rejected", rec.Body.String())
	}
	if store.lastIntegrationInput.Provider != "" {
		t.Fatalf("raw credential request should not upsert: %+v", store.lastIntegrationInput)
	}
}

func TestCreateIntegrationRejectsStripeRawSecretAliases(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{
			name: "restricted key",
			body: `{
				"provider":"stripe",
				"settings":{
					"account_id":"acct_123",
					"credential_ref":"cred_stripe",
					"restricted_key":"rk_live_secret"
				}
			}`,
		},
		{
			name: "secret key",
			body: `{
				"provider":"stripe",
				"settings":{
					"account_id":"acct_123",
					"credential_ref":"cred_stripe",
					"secret_key":"sk_live_secret"
				}
			}`,
		},
		{
			name: "webhook endpoint secret",
			body: `{
				"provider":"stripe",
				"settings":{
					"account_id":"acct_123",
					"credential_ref":"cred_stripe",
					"endpoint_secret":"whsec_secret"
				}
			}`,
		},
		{
			name: "prefixed signing secret",
			body: `{
				"provider":"stripe",
				"settings":{
					"account_id":"acct_123",
					"credential_ref":"cred_stripe",
					"stripe_signing_secret":"whsec_secret"
				}
			}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			deps := &Deps{Repo: store}
			req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
			rec := httptest.NewRecorder()

			deps.CreateIntegration(rec, req)

			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
				t.Fatalf("body = %s, want raw_credentials_rejected", rec.Body.String())
			}
			if store.lastIntegrationInput.Provider != "" {
				t.Fatalf("raw Stripe credential request should not upsert: %+v", store.lastIntegrationInput)
			}
		})
	}
}

func TestCreateWooCommerceIntegrationRegistersWebhooksAndStoresGeneratedSecret(t *testing.T) {
	store := &fakeStore{}
	registrar := &fakeWooCommerceWebhookRegistrar{}
	deps := &Deps{Repo: store, WooCommerceWebhookRegistrar: registrar}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations", strings.NewReader(`{
		"provider":"woocommerce",
		"settings":{
			"store_url":"https://store.example",
			"credential_ref":"cred_wc_1"
		}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "app.postwave.test")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateIntegration(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	got := store.lastIntegrationInput
	if got.Provider != ProviderWooCommerce || got.ShopDomain != "https://store.example" || got.CredentialRef != "cred_wc_1" {
		t.Fatalf("stored input = %+v", got)
	}
	if strings.TrimSpace(got.WebhookSecret) == "" {
		t.Fatalf("expected generated webhook secret in integration input: %+v", got)
	}
	if registrar.integration.Provider != ProviderWooCommerce || registrar.integration.WebhookSecret != got.WebhookSecret {
		t.Fatalf("registrar integration = %+v stored secret=%q", registrar.integration, got.WebhookSecret)
	}
	if registrar.baseURL != "https://app.postwave.test" {
		t.Fatalf("registrar baseURL = %q", registrar.baseURL)
	}
	if got.Settings["woocommerce_webhook_endpoint"] != "https://app.postwave.test/api/public/commerce/woocommerce/webhooks" {
		t.Fatalf("settings missing WooCommerce endpoint: %+v", got.Settings)
	}
	if got.Settings["woocommerce_webhook_registered_at"] == "" || got.Settings["woocommerce_webhook_subscriptions"] == nil {
		t.Fatalf("settings missing WooCommerce registration metadata: %+v", got.Settings)
	}
	if got.Settings["managed_by_postwave"] != true || got.Settings["sync_model"] != commerceSyncModelWoo || len(got.Scopes) != 3 {
		t.Fatalf("expected managed WooCommerce sync metadata, got %+v scopes=%+v", got.Settings, got.Scopes)
	}
	if _, ok := got.Settings["webhook_secret"]; ok {
		t.Fatalf("raw webhook secret leaked into settings: %+v", got.Settings)
	}
}

func TestCreateWooCommerceIntegrationReusesExistingWebhookSecret(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:            "int_existing",
		Provider:      ProviderWooCommerce,
		ShopDomain:    "https://store.example",
		WebhookSecret: "existing-secret",
		Settings:      map[string]any{"store_url": "https://store.example", "credential_ref": "cred_wc_old"},
	}}
	registrar := &fakeWooCommerceWebhookRegistrar{}
	deps := &Deps{Repo: store, WooCommerceWebhookRegistrar: registrar}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations", strings.NewReader(`{
		"provider":"woocommerce",
		"settings":{
			"store_url":"https://store.example",
			"credential_ref":"cred_wc_new"
		}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateIntegration(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastWooStoreURL != "https://store.example" {
		t.Fatalf("lookup store URL = %q", store.lastWooStoreURL)
	}
	if store.lastIntegrationInput.WebhookSecret != "existing-secret" || registrar.integration.WebhookSecret != "existing-secret" {
		t.Fatalf("stored=%q registrar=%q", store.lastIntegrationInput.WebhookSecret, registrar.integration.WebhookSecret)
	}
}

func TestCreateWooCommerceIntegrationFailsWhenWebhookRegistrationFails(t *testing.T) {
	store := &fakeStore{}
	registrar := &fakeWooCommerceWebhookRegistrar{err: errors.New("provider refused")}
	deps := &Deps{Repo: store, WooCommerceWebhookRegistrar: registrar}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations", strings.NewReader(`{
		"provider":"woocommerce",
		"settings":{
			"store_url":"https://store.example",
			"credential_ref":"cred_wc_1"
		}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateIntegration(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "internal_error") || strings.Contains(rec.Body.String(), "webhook_registration_failed") {
		t.Fatalf("5xx body was not centrally redacted: %s", rec.Body.String())
	}
	if store.lastIntegrationInput.Provider != "" {
		t.Fatalf("failed webhook registration should not upsert: %+v", store.lastIntegrationInput)
	}
}

func TestCreateIntegrationKeepsShopifyOnOAuth(t *testing.T) {
	store := &fakeStore{}
	deps := &Deps{Repo: store}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations", strings.NewReader(`{
		"provider":"shopify",
		"shop_domain":"demo.myshopify.com"
	}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "shopify_oauth_required") {
		t.Fatalf("body = %s, want shopify_oauth_required", rec.Body.String())
	}
	if store.lastIntegrationInput.Provider != "" {
		t.Fatalf("shopify create should not upsert: %+v", store.lastIntegrationInput)
	}
}

func TestIntegrationLifecycleHandlersGetPauseAndDelete(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		Provider:   ProviderBigCommerce,
		ShopDomain: "store.example",
		Status:     "active",
		Settings:   map[string]any{"credential_ref": "vault://commerce/bigcommerce"},
		CreatedAt:  time.Now().UTC(),
		UpdatedAt:  time.Now().UTC(),
	}}
	deps := &Deps{Repo: store}

	req := commerceReqWithID(http.MethodGet, "/api/v1/commerce/integrations/int_1", "int_1", nil)
	rec := httptest.NewRecorder()
	deps.GetIntegration(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got Integration
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.ID != "int_1" || got.Provider != ProviderBigCommerce {
		t.Fatalf("unexpected integration response: %+v", got)
	}

	req = commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/pause", "int_1", nil)
	rec = httptest.NewRecorder()
	deps.PauseIntegration(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("pause status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastStatus != "paused" {
		t.Fatalf("expected paused status write, got %q", store.lastStatus)
	}

	req = commerceReqWithID(http.MethodDelete, "/api/v1/commerce/integrations/int_1", "int_1", nil)
	rec = httptest.NewRecorder()
	deps.DeleteIntegration(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.disconnectedID != "int_1" {
		t.Fatalf("expected disconnected id int_1, got %q", store.disconnectedID)
	}
}

func TestPauseIntegrationRejectsDisconnectedRow(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		Provider: ProviderBigCommerce,
		Status:   "disconnected",
		Settings: map[string]any{
			"provider_cleanup": map[string]any{"status": "operator_action_required"},
		},
	}}
	deps := &Deps{Repo: store}

	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/pause", "int_1", nil)
	rec := httptest.NewRecorder()
	deps.PauseIntegration(rec, req)

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
		t.Fatalf("pause disconnected status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastStatus != "" {
		t.Fatalf("disconnected pause should not write status, got %q", store.lastStatus)
	}
}

func TestDeleteBigCommerceIntegrationReturnsProviderCleanupEvidence(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:            "int_1",
		Provider:      ProviderBigCommerce,
		ShopDomain:    "stores/ABC123",
		Status:        "active",
		WebhookSecret: "whsec_bigcommerce",
		Settings: map[string]any{
			"store_hash":                   "ABC123",
			"credential_ref":               "vault://commerce/bigcommerce",
			"bigcommerce_webhook_endpoint": "https://app.postwave.test/api/public/commerce/bigcommerce/webhooks",
		},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}}
	registrar := &fakeBigCommerceWebhookRegistrar{}
	deps := &Deps{Repo: store, BigCommerceWebhookRegistrar: registrar}

	req := commerceReqWithID(http.MethodDelete, "/api/v1/commerce/integrations/int_1", "int_1", nil)
	rec := httptest.NewRecorder()
	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !registrar.cleanup || registrar.appBaseURL != "https://app.postwave.test" {
		t.Fatalf("registrar cleanup=%v base=%q", registrar.cleanup, registrar.appBaseURL)
	}
	var out DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.ProviderCleanup == nil ||
		out.ProviderCleanup.Provider != ProviderBigCommerce ||
		out.ProviderCleanup.Status != "managed_webhook_cleanup_completed" ||
		out.ProviderCleanup.ProviderScopeID != "abc123" ||
		out.ProviderCleanup.WebhookEndpoint != "https://app.postwave.test/api/public/commerce/bigcommerce/webhooks" ||
		!out.ProviderCleanup.ManagedProviderCleanup ||
		len(out.ProviderCleanup.WebhookIDs) != 1 ||
		out.ProviderCleanup.WebhookIDs[0] != "hook_1" ||
		out.ProviderCleanup.CredentialCleanupStatus != "operator_revoke_or_rotate_bigcommerce_api_account_token" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	if store.disconnectCleanup == nil || store.integration.Settings["provider_cleanup"] == nil {
		t.Fatalf("provider cleanup should be persisted, cleanup=%+v settings=%+v", store.disconnectCleanup, store.integration.Settings)
	}
}

func TestGetIntegrationExposesShopifyBulkSyncState(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	cursor := encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{
		Object:        "products",
		OperationID:   "gid://shopify/BulkOperation/700",
		LineOffset:    2400,
		Attempts:      2,
		NextAttemptAt: now.Add(30 * time.Minute).Format(time.RFC3339),
		LastStatus:    "IMPORT_FAILED",
		LastError:     "temporary download failure",
	})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		Provider:   ProviderShopify,
		ShopDomain: "demo.myshopify.com",
		Status:     "error",
		SyncCursor: cursor,
	}}
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return now },
	}
	req := commerceReqWithID(http.MethodGet, "/api/v1/commerce/integrations/int_1", "int_1", nil)
	rec := httptest.NewRecorder()

	deps.GetIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got Integration
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.SyncState == nil {
		t.Fatalf("missing sync state: %+v", got)
	}
	if got.SyncState.CursorKind != "shopify_bulk" ||
		got.SyncState.Mode != "async_bulk_operation" ||
		got.SyncState.Object != "products" ||
		got.SyncState.OperationID != "gid://shopify/BulkOperation/700" ||
		got.SyncState.LineOffset != 2400 ||
		got.SyncState.Attempts != 2 ||
		got.SyncState.LastStatus != "IMPORT_FAILED" ||
		got.SyncState.LastError != "temporary download failure" ||
		got.SyncState.RetryDue ||
		got.SyncState.RetryWaitSeconds != 1800 {
		t.Fatalf("sync state = %+v", got.SyncState)
	}
}

func TestDeleteShopifyIntegrationCleansProviderWebhooks(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:          "int_shopify",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "shpat_123",
		Settings: map[string]any{
			"shopify_webhook_endpoint": "https://app.postwave.test/api/public/commerce/shopify/webhooks",
		},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}}
	registrar := &fakeShopifyWebhookRegistrar{}
	deps := &Deps{Repo: store, ShopifyWebhookRegistrar: registrar}
	req := commerceReqWithID(http.MethodDelete, "/api/v1/commerce/integrations/int_shopify", "int_shopify", nil)
	rec := httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !registrar.cleanup {
		t.Fatal("expected Shopify webhook cleanup")
	}
	if registrar.integration.AccessToken != "shpat_123" || registrar.baseURL != "https://app.postwave.test" {
		t.Fatalf("cleanup input = integration:%+v baseURL:%q", registrar.integration, registrar.baseURL)
	}
	if store.disconnectedID != "int_shopify" {
		t.Fatalf("disconnectedID = %q", store.disconnectedID)
	}
	var out DisconnectResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v body=%s", err, rec.Body.String())
	}
	if !out.OK || out.ProviderCleanup == nil {
		t.Fatalf("missing Shopify cleanup response: %+v", out)
	}
	if out.ProviderCleanup.Provider != ProviderShopify ||
		out.ProviderCleanup.Status != "managed_webhook_cleanup_completed" ||
		out.ProviderCleanup.ProviderScopeType != "shopify_shop_domain" ||
		out.ProviderCleanup.ProviderScopeID != "demo.myshopify.com" ||
		out.ProviderCleanup.WebhookEndpoint != "https://app.postwave.test/api/public/commerce/shopify/webhooks" ||
		out.ProviderCleanup.WebhookCleanupStatus != "deleted_postwave_managed_webhooks" ||
		out.ProviderCleanup.CredentialCleanupStatus != "operator_uninstall_shopify_app_or_remove_custom_app_token" ||
		!out.ProviderCleanup.ManagedProviderCleanup ||
		len(out.ProviderCleanup.WebhookIDs) != 1 ||
		out.ProviderCleanup.WebhookIDs[0] != "gid://shopify/WebhookSubscription/1" {
		t.Fatalf("unexpected Shopify cleanup response: %+v", out.ProviderCleanup)
	}
	if store.disconnectCleanup == nil || store.integration.Settings["provider_cleanup"] == nil {
		t.Fatalf("Shopify cleanup evidence was not persisted in fake store")
	}
}

func TestDeleteWooCommerceIntegrationCleansProviderWebhooks(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:            "int_woo",
		Provider:      ProviderWooCommerce,
		ShopDomain:    "https://store.example",
		WebhookSecret: "wc-secret",
		Settings: map[string]any{
			"credential_ref":               "cred_wc_1",
			"woocommerce_webhook_endpoint": "https://app.postwave.test/api/public/commerce/woocommerce/webhooks",
		},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}}
	registrar := &fakeWooCommerceWebhookRegistrar{}
	deps := &Deps{Repo: store, WooCommerceWebhookRegistrar: registrar}
	req := commerceReqWithID(http.MethodDelete, "/api/v1/commerce/integrations/int_woo", "int_woo", nil)
	rec := httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !registrar.cleanup {
		t.Fatal("expected WooCommerce webhook cleanup")
	}
	if registrar.integration.WebhookSecret != "wc-secret" || registrar.baseURL != "https://app.postwave.test" {
		t.Fatalf("cleanup input = integration:%+v baseURL:%q", registrar.integration, registrar.baseURL)
	}
	if store.disconnectedID != "int_woo" {
		t.Fatalf("disconnectedID = %q", store.disconnectedID)
	}
	if store.deletedID != "" {
		t.Fatalf("hard delete should not run on normal disconnect, deletedID = %q", store.deletedID)
	}
	var out DisconnectResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v body=%s", err, rec.Body.String())
	}
	if !out.OK || out.ProviderCleanup == nil {
		t.Fatalf("missing cleanup response: %+v", out)
	}
	if out.ProviderCleanup.Status != "managed_webhook_cleanup_completed" ||
		out.ProviderCleanup.WebhookCleanupStatus != "deleted_postwave_managed_webhooks" ||
		!out.ProviderCleanup.ManagedProviderCleanup ||
		len(out.ProviderCleanup.WebhookIDs) != 1 ||
		out.ProviderCleanup.WebhookIDs[0] != "142" ||
		out.ProviderCleanup.CredentialCleanupStatus != "operator_revoke_or_rotate_wordpress_rest_api_key" {
		t.Fatalf("unexpected cleanup response: %+v", out.ProviderCleanup)
	}
	if store.disconnectCleanup == nil || store.integration.Settings["provider_cleanup"] == nil {
		t.Fatalf("cleanup evidence was not persisted in fake store")
	}
}

func TestDeleteWooCommerceIntegrationSkipsCleanupForLegacyManualWebhook(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:         "int_woo_legacy",
		Provider:   ProviderWooCommerce,
		ShopDomain: "https://store.example",
		Settings:   map[string]any{"credential_ref": "cred_wc_1"},
		CreatedAt:  time.Now().UTC(),
		UpdatedAt:  time.Now().UTC(),
	}}
	registrar := &fakeWooCommerceWebhookRegistrar{}
	deps := &Deps{Repo: store, WooCommerceWebhookRegistrar: registrar}
	req := commerceReqWithID(http.MethodDelete, "/api/v1/commerce/integrations/int_woo_legacy", "int_woo_legacy", nil)
	rec := httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.cleanup {
		t.Fatal("legacy WooCommerce rows without Moosewave endpoint metadata should not clean provider webhooks")
	}
	if store.disconnectedID != "int_woo_legacy" {
		t.Fatalf("disconnectedID = %q", store.disconnectedID)
	}
	var out DisconnectResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v body=%s", err, rec.Body.String())
	}
	if out.ProviderCleanup == nil ||
		out.ProviderCleanup.Status != "operator_action_required" ||
		out.ProviderCleanup.WebhookCleanupStatus != "skipped_no_postwave_endpoint_evidence" ||
		out.ProviderCleanup.ManagedProviderCleanup {
		t.Fatalf("unexpected legacy cleanup response: %+v", out.ProviderCleanup)
	}
}

func TestDeleteStripeIntegrationReturnsOperatorManagedCleanupEvidence(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:         "int_stripe",
		TenantID:   "tenant-1",
		Provider:   ProviderStripe,
		ShopDomain: "acct_123",
		Status:     "connected",
		Settings: map[string]any{
			"account_id":         "acct_123",
			"credential_ref":     "cred_stripe",
			"webhook_secret_ref": "cred_stripe_webhook",
			"provider_cleanup":   map[string]any{"status": "stale"},
			"irrelevant_setting": "kept",
		},
	}}
	deps := &Deps{Repo: store}
	req := commerceReqWithID(http.MethodDelete, "/api/v1/commerce/integrations/int_stripe", "int_stripe", nil)
	rec := httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.disconnectedID != "int_stripe" {
		t.Fatalf("disconnectedID = %q", store.disconnectedID)
	}
	var out DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !out.OK || out.ProviderCleanup == nil {
		t.Fatalf("unexpected disconnect response: %+v", out)
	}
	if out.ProviderCleanup.Provider != ProviderStripe ||
		out.ProviderCleanup.Status != "operator_action_required" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderCleanupPosture != "operator_managed_stripe_dashboard" ||
		out.ProviderCleanup.ProviderScopeID != "acct_123" ||
		!out.ProviderCleanup.CredentialRefPresent ||
		!out.ProviderCleanup.WebhookSecretRefPresent ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_delete_or_disable_stripe_webhook_endpoint" ||
		out.ProviderCleanup.CredentialCleanupStatus != "operator_revoke_or_rotate_stripe_restricted_key" {
		t.Fatalf("unexpected Stripe cleanup response: %+v", out.ProviderCleanup)
	}
	if store.disconnectCleanup == nil || store.integration.Settings["provider_cleanup"] == nil {
		t.Fatalf("expected persisted Stripe provider cleanup evidence")
	}
	firstRecordedAt := out.ProviderCleanup.RecordedAt
	store.disconnectedID = ""
	store.disconnectCleanup = nil
	rec = httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("repeat status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.disconnectedID != "" || store.disconnectCleanup != nil {
		t.Fatalf("repeat disconnect should not rewrite cleanup: id=%q cleanup=%+v", store.disconnectedID, store.disconnectCleanup)
	}
	var repeat DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&repeat); err != nil {
		t.Fatalf("decode repeat response: %v", err)
	}
	if repeat.ProviderCleanup == nil ||
		repeat.ProviderCleanup.ProviderCleanupPosture != "operator_managed_stripe_dashboard" ||
		repeat.ProviderCleanup.RecordedAt != firstRecordedAt {
		t.Fatalf("repeat response should preserve existing cleanup evidence: %+v first_recorded_at=%q", repeat.ProviderCleanup, firstRecordedAt)
	}
}

func TestDeletePayPalIntegrationReturnsOperatorManagedCleanupEvidence(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:       "int_paypal",
		TenantID: "tenant-1",
		Provider: ProviderPayPal,
		Status:   "connected",
		Settings: map[string]any{
			"merchant_id":        " merchant_123 ",
			"credential_ref":     "cred_paypal",
			"webhook_id":         "WH-123",
			"provider_cleanup":   map[string]any{"status": "stale"},
			"irrelevant_setting": "kept",
		},
	}}
	deps := &Deps{Repo: store}
	req := commerceReqWithID(http.MethodDelete, "/api/v1/commerce/integrations/int_paypal", "int_paypal", nil)
	rec := httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.disconnectedID != "int_paypal" {
		t.Fatalf("disconnectedID = %q", store.disconnectedID)
	}
	var out DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !out.OK || out.ProviderCleanup == nil {
		t.Fatalf("unexpected disconnect response: %+v", out)
	}
	if out.ProviderCleanup.Provider != ProviderPayPal ||
		out.ProviderCleanup.Status != "operator_action_required" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderCleanupPosture != "operator_managed_paypal_developer_dashboard" ||
		out.ProviderCleanup.ProviderScopeType != "paypal_merchant_id" ||
		out.ProviderCleanup.ProviderScopeID != "merchant_123" ||
		!out.ProviderCleanup.CredentialRefPresent ||
		len(out.ProviderCleanup.WebhookIDs) != 1 ||
		out.ProviderCleanup.WebhookIDs[0] != "WH-123" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_delete_or_disable_paypal_webhook" ||
		out.ProviderCleanup.CredentialCleanupStatus != "operator_revoke_or_rotate_paypal_rest_app_credentials" {
		t.Fatalf("unexpected PayPal cleanup response: %+v", out.ProviderCleanup)
	}
	if store.disconnectCleanup == nil || store.integration.Settings["provider_cleanup"] == nil {
		t.Fatalf("expected persisted PayPal provider cleanup evidence")
	}
	firstRecordedAt := out.ProviderCleanup.RecordedAt
	store.disconnectedID = ""
	store.disconnectCleanup = nil
	rec = httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("repeat status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.disconnectedID != "" || store.disconnectCleanup != nil {
		t.Fatalf("repeat disconnect should not rewrite cleanup: id=%q cleanup=%+v", store.disconnectedID, store.disconnectCleanup)
	}
	var repeat DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&repeat); err != nil {
		t.Fatalf("decode repeat response: %v", err)
	}
	if repeat.ProviderCleanup == nil ||
		repeat.ProviderCleanup.ProviderCleanupPosture != "operator_managed_paypal_developer_dashboard" ||
		repeat.ProviderCleanup.RecordedAt != firstRecordedAt {
		t.Fatalf("repeat response should preserve existing cleanup evidence: %+v first_recorded_at=%q", repeat.ProviderCleanup, firstRecordedAt)
	}
}

func TestDeleteRazorpayIntegrationReturnsOperatorManagedCleanupEvidence(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:       "int_razorpay",
		TenantID: "tenant-1",
		Provider: ProviderRazorpay,
		Status:   "connected",
		Settings: map[string]any{
			"account_id":         " acc_123 ",
			"credential_ref":     "cred_razorpay",
			"webhook_secret_ref": "cred_razorpay_webhook",
			"webhook_endpoint":   " https://api.postwave.test/api/public/commerce/razorpay/webhooks ",
			"provider_cleanup":   map[string]any{"status": "stale"},
			"irrelevant_setting": "kept",
		},
	}}
	deps := &Deps{Repo: store}
	req := commerceReqWithID(http.MethodDelete, "/api/v1/commerce/integrations/int_razorpay", "int_razorpay", nil)
	rec := httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.disconnectedID != "int_razorpay" {
		t.Fatalf("disconnectedID = %q", store.disconnectedID)
	}
	var out DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !out.OK || out.ProviderCleanup == nil {
		t.Fatalf("unexpected disconnect response: %+v", out)
	}
	if out.ProviderCleanup.Provider != ProviderRazorpay ||
		out.ProviderCleanup.Status != "operator_action_required" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderCleanupPosture != "operator_managed_razorpay_dashboard" ||
		out.ProviderCleanup.ProviderScopeType != "razorpay_account_id" ||
		out.ProviderCleanup.ProviderScopeID != "acc_123" ||
		out.ProviderCleanup.WebhookEndpoint != "https://api.postwave.test/api/public/commerce/razorpay/webhooks" ||
		!out.ProviderCleanup.CredentialRefPresent ||
		!out.ProviderCleanup.WebhookSecretRefPresent ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_delete_or_disable_razorpay_webhook_endpoint" ||
		out.ProviderCleanup.CredentialCleanupStatus != "operator_revoke_or_rotate_razorpay_key_secret" {
		t.Fatalf("unexpected Razorpay cleanup response: %+v", out.ProviderCleanup)
	}
	if store.disconnectCleanup == nil || store.integration.Settings["provider_cleanup"] == nil {
		t.Fatalf("expected persisted Razorpay provider cleanup evidence")
	}
	firstRecordedAt := out.ProviderCleanup.RecordedAt
	store.disconnectedID = ""
	store.disconnectCleanup = nil
	rec = httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("repeat status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.disconnectedID != "" || store.disconnectCleanup != nil {
		t.Fatalf("repeat disconnect should not rewrite cleanup: id=%q cleanup=%+v", store.disconnectedID, store.disconnectCleanup)
	}
	var repeat DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&repeat); err != nil {
		t.Fatalf("decode repeat response: %v", err)
	}
	if repeat.ProviderCleanup == nil ||
		repeat.ProviderCleanup.ProviderCleanupPosture != "operator_managed_razorpay_dashboard" ||
		repeat.ProviderCleanup.RecordedAt != firstRecordedAt {
		t.Fatalf("repeat response should preserve existing cleanup evidence: %+v first_recorded_at=%q", repeat.ProviderCleanup, firstRecordedAt)
	}
}

func TestDeleteSquareIntegrationReturnsOperatorManagedCleanupEvidence(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:       "int_square",
		TenantID: "tenant-1",
		Provider: ProviderSquare,
		Status:   "connected",
		Settings: map[string]any{
			"merchant_id":              " MERCHANT123 ",
			"credential_ref":           "cred_square",
			"signature_key_ref":        "sig_square",
			"webhook_notification_url": " https://api.postwave.test/api/public/commerce/square/webhooks ",
			"provider_cleanup":         map[string]any{"status": "stale"},
			"irrelevant_setting":       "kept",
		},
	}}
	deps := &Deps{Repo: store}
	req := commerceReqWithID(http.MethodDelete, "/api/v1/commerce/integrations/int_square", "int_square", nil)
	rec := httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.disconnectedID != "int_square" {
		t.Fatalf("disconnectedID = %q", store.disconnectedID)
	}
	var out DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !out.OK || out.ProviderCleanup == nil {
		t.Fatalf("unexpected disconnect response: %+v", out)
	}
	if out.ProviderCleanup.Provider != ProviderSquare ||
		out.ProviderCleanup.Status != "operator_action_required" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderCleanupPosture != "operator_managed_square_developer_console" ||
		out.ProviderCleanup.ProviderScopeType != "square_merchant_id" ||
		out.ProviderCleanup.ProviderScopeID != "MERCHANT123" ||
		out.ProviderCleanup.WebhookEndpoint != "https://api.postwave.test/api/public/commerce/square/webhooks" ||
		!out.ProviderCleanup.CredentialRefPresent ||
		!out.ProviderCleanup.WebhookSecretRefPresent ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_delete_or_disable_square_webhook_subscription" ||
		out.ProviderCleanup.CredentialCleanupStatus != "operator_revoke_or_rotate_square_oauth_or_app_token" {
		t.Fatalf("unexpected Square cleanup response: %+v", out.ProviderCleanup)
	}
	if store.disconnectCleanup == nil || store.integration.Settings["provider_cleanup"] == nil {
		t.Fatalf("expected persisted Square provider cleanup evidence")
	}
	firstRecordedAt := out.ProviderCleanup.RecordedAt
	store.disconnectedID = ""
	store.disconnectCleanup = nil
	rec = httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("repeat status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.disconnectedID != "" || store.disconnectCleanup != nil {
		t.Fatalf("repeat disconnect should not rewrite cleanup: id=%q cleanup=%+v", store.disconnectedID, store.disconnectCleanup)
	}
	var repeat DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&repeat); err != nil {
		t.Fatalf("decode repeat response: %v", err)
	}
	if repeat.ProviderCleanup == nil ||
		repeat.ProviderCleanup.ProviderCleanupPosture != "operator_managed_square_developer_console" ||
		repeat.ProviderCleanup.RecordedAt != firstRecordedAt {
		t.Fatalf("repeat response should preserve existing cleanup evidence: %+v first_recorded_at=%q", repeat.ProviderCleanup, firstRecordedAt)
	}
}

func TestDeleteAdobeCommerceIntegrationReturnsOperatorManagedCleanupEvidence(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:       "int_adobe",
		TenantID: "tenant-1",
		Provider: ProviderAdobeCommerce,
		Status:   "connected",
		Settings: map[string]any{
			"base_url":                       " https://magento.example.com/ ",
			"credential_ref":                 "cred_adobe",
			"event_auth_ref":                 "cred_adobe_webhook",
			"webhook_endpoint":               " https://api.postwave.test/api/public/commerce/adobe-commerce/webhooks ",
			"provider_cleanup":               map[string]any{"status": "stale"},
			"adobe_commerce_ignored_setting": "kept",
		},
	}}
	deps := &Deps{Repo: store}
	req := commerceReqWithID(http.MethodDelete, "/api/v1/commerce/integrations/int_adobe", "int_adobe", nil)
	rec := httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.disconnectedID != "int_adobe" {
		t.Fatalf("disconnectedID = %q", store.disconnectedID)
	}
	var out DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !out.OK || out.ProviderCleanup == nil {
		t.Fatalf("unexpected disconnect response: %+v", out)
	}
	if out.ProviderCleanup.Provider != ProviderAdobeCommerce ||
		out.ProviderCleanup.Status != "operator_action_required" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderCleanupPosture != "operator_managed_adobe_commerce_admin_or_module" ||
		out.ProviderCleanup.ProviderScopeType != "adobe_commerce_base_url" ||
		out.ProviderCleanup.ProviderScopeID != "https://magento.example.com" ||
		out.ProviderCleanup.WebhookEndpoint != "https://api.postwave.test/api/public/commerce/adobe-commerce/webhooks" ||
		!out.ProviderCleanup.CredentialRefPresent ||
		!out.ProviderCleanup.WebhookSecretRefPresent ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_delete_or_disable_adobe_commerce_webhook_definition" ||
		out.ProviderCleanup.CredentialCleanupStatus != "operator_revoke_or_rotate_adobe_commerce_access_token" {
		t.Fatalf("unexpected Adobe Commerce cleanup response: %+v", out.ProviderCleanup)
	}
	if store.disconnectCleanup == nil || store.integration.Settings["provider_cleanup"] == nil {
		t.Fatalf("expected persisted Adobe Commerce provider cleanup evidence")
	}
	firstRecordedAt := out.ProviderCleanup.RecordedAt
	store.disconnectedID = ""
	store.disconnectCleanup = nil
	rec = httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("repeat status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.disconnectedID != "" || store.disconnectCleanup != nil {
		t.Fatalf("repeat disconnect should not rewrite cleanup: id=%q cleanup=%+v", store.disconnectedID, store.disconnectCleanup)
	}
	var repeat DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&repeat); err != nil {
		t.Fatalf("decode repeat response: %v", err)
	}
	if repeat.ProviderCleanup == nil ||
		repeat.ProviderCleanup.ProviderCleanupPosture != "operator_managed_adobe_commerce_admin_or_module" ||
		repeat.ProviderCleanup.RecordedAt != firstRecordedAt {
		t.Fatalf("repeat response should preserve existing cleanup evidence: %+v first_recorded_at=%q", repeat.ProviderCleanup, firstRecordedAt)
	}
}

func TestDeleteSquarespaceIntegrationReturnsOperatorManagedCleanupEvidence(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:       "int_squarespace",
		TenantID: "tenant-1",
		Provider: ProviderSquarespace,
		Status:   "connected",
		Settings: map[string]any{
			"site_id":            " site_123 ",
			"credential_ref":     "cred_squarespace",
			"webhook_secret_ref": "cred_squarespace_webhook",
			"webhook_endpoint":   " https://api.postwave.test/api/public/commerce/squarespace/webhooks ",
			"provider_cleanup":   map[string]any{"status": "stale"},
		},
	}}
	deps := &Deps{Repo: store}
	req := commerceReqWithID(http.MethodDelete, "/api/v1/commerce/integrations/int_squarespace", "int_squarespace", nil)
	rec := httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.disconnectedID != "int_squarespace" {
		t.Fatalf("disconnectedID = %q", store.disconnectedID)
	}
	var out DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !out.OK || out.ProviderCleanup == nil {
		t.Fatalf("unexpected disconnect response: %+v", out)
	}
	if out.ProviderCleanup.Provider != ProviderSquarespace ||
		out.ProviderCleanup.Status != "operator_action_required" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderCleanupPosture != "operator_managed_squarespace_oauth_webhook_subscriptions" ||
		out.ProviderCleanup.ProviderScopeType != "squarespace_site_id" ||
		out.ProviderCleanup.ProviderScopeID != "site_123" ||
		out.ProviderCleanup.WebhookEndpoint != "https://api.postwave.test/api/public/commerce/squarespace/webhooks" ||
		!out.ProviderCleanup.CredentialRefPresent ||
		!out.ProviderCleanup.WebhookSecretRefPresent ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_delete_or_disable_squarespace_webhook_subscription" ||
		out.ProviderCleanup.CredentialCleanupStatus != "operator_revoke_or_rotate_squarespace_api_key_or_oauth_token" {
		t.Fatalf("unexpected Squarespace cleanup response: %+v", out.ProviderCleanup)
	}
	if store.disconnectCleanup == nil || store.integration.Settings["provider_cleanup"] == nil {
		t.Fatalf("expected persisted Squarespace provider cleanup evidence")
	}
	firstRecordedAt := out.ProviderCleanup.RecordedAt
	store.disconnectedID = ""
	store.disconnectCleanup = nil
	rec = httptest.NewRecorder()

	deps.DeleteIntegration(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("repeat status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.disconnectedID != "" || store.disconnectCleanup != nil {
		t.Fatalf("repeat disconnect should not rewrite cleanup: id=%q cleanup=%+v", store.disconnectedID, store.disconnectCleanup)
	}
	var repeat DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&repeat); err != nil {
		t.Fatalf("decode repeat response: %v", err)
	}
	if repeat.ProviderCleanup == nil ||
		repeat.ProviderCleanup.ProviderCleanupPosture != "operator_managed_squarespace_oauth_webhook_subscriptions" ||
		repeat.ProviderCleanup.RecordedAt != firstRecordedAt {
		t.Fatalf("repeat response should preserve existing cleanup evidence: %+v first_recorded_at=%q", repeat.ProviderCleanup, firstRecordedAt)
	}
}

func TestSyncIntegrationRequiresCanonicalPayloadRows(t *testing.T) {
	store := &fakeStore{syncErr: ErrSyncPayloadRequired}
	deps := &Deps{Repo: store}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/sync", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_required") {
		t.Fatalf("body = %s, want payload_required", rec.Body.String())
	}
	if syncRequestHasPayload(store.lastSyncRequest) {
		t.Fatalf("empty request should remain empty, got %+v", store.lastSyncRequest)
	}
}

func TestSyncIntegrationPullsShopifyBackfillWhenPayloadEmpty(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:          "int_1",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "shpat_123",
		SyncCursor:  encodeShopifyBackfillCursor(shopifyBackfillState{Object: "products"}),
	}}
	backfiller := &fakeShopifyBackfiller{req: SyncRequest{
		Products: []ProductInput{{SourceID: "gid://shopify/Product/1", Title: "Desk lamp", PriceCents: 2500, Currency: "USD"}},
		Cursor:   encodeShopifyBackfillCursor(shopifyBackfillState{Object: "orders"}),
	}}
	deps := &Deps{Repo: store, ShopifyBackfiller: backfiller}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.integration.AccessToken != "shpat_123" || !strings.Contains(backfiller.cursor, shopifyBackfillCursorPrefix) {
		t.Fatalf("backfiller input = integration:%+v cursor:%q", backfiller.integration, backfiller.cursor)
	}
	if len(store.lastSyncRequest.Products) != 1 || store.lastSyncRequest.Cursor != backfiller.req.Cursor {
		t.Fatalf("sync request = %+v", store.lastSyncRequest)
	}
}

func TestSyncIntegrationPullsWooCommerceBackfillWhenPayloadEmpty(t *testing.T) {
	cursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "products", Page: 2})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderWooCommerce,
		ShopDomain: "https://store.example",
		Settings:   map[string]any{"store_url": "https://store.example", "credential_ref": "cred_wc_1"},
		SyncCursor: cursor,
	}}
	backfiller := &fakeWooCommerceBackfiller{req: SyncRequest{
		Products: []ProductInput{{SourceID: "woocommerce://product/7", Title: "Beanie", PriceCents: 1999, Currency: "USD"}},
		Cursor:   encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "orders", Page: 1}),
	}}
	deps := &Deps{Repo: store, WooCommerceBackfiller: backfiller}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.tenantID != "tenant-1" || backfiller.cursor != cursor || backfiller.integration.Provider != ProviderWooCommerce {
		t.Fatalf("backfiller tenant=%q cursor=%q integration=%+v", backfiller.tenantID, backfiller.cursor, backfiller.integration)
	}
	if len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.Products) != 1 {
		t.Fatalf("sync requests=%+v", store.lastSyncRequests)
	}
	if store.lastSyncRequest.Cursor != backfiller.req.Cursor {
		t.Fatalf("cursor = %q", store.lastSyncRequest.Cursor)
	}
}

func TestSyncIntegrationStoresWooCommerceRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "orders", Page: 3})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderWooCommerce,
		ShopDomain: "https://store.example",
		Settings:   map[string]any{"store_url": "https://store.example", "credential_ref": "cred_wc_1"},
		SyncCursor: cursor,
	}}
	backfiller := &fakeWooCommerceBackfiller{err: WooCommerceRateLimitError{Path: "/wp-json/wc/v3/orders", StatusCode: http.StatusTooManyRequests, RetryAfter: 2 * time.Minute}}
	deps := &Deps{Repo: store, WooCommerceBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor {
		t.Fatalf("backfiller cursor = %q", backfiller.cursor)
	}
	retry, ok, err := decodeWooCommerceRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt == "" || store.lastSyncErr == nil {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationSkipsWooCommerceRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "orders", Page: 3})
	retryCursor := encodeWooCommerceRetryCursor(wooCommerceRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderWooCommerce,
		ShopDomain: "https://store.example",
		Settings:   map[string]any{"store_url": "https://store.example", "credential_ref": "cred_wc_1"},
		SyncCursor: retryCursor,
	}}
	backfiller := &fakeWooCommerceBackfiller{}
	deps := &Deps{Repo: store, WooCommerceBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != "" || len(store.lastSyncRequests) != 0 || store.lastSyncCursor != "" {
		t.Fatalf("backfiller cursor=%q syncRequests=%+v storedCursor=%q", backfiller.cursor, store.lastSyncRequests, store.lastSyncCursor)
	}
}

func TestSyncIntegrationStoresWooCommerceRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "orders", Page: 3})
	syncErr := errors.New("sync unavailable")
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderWooCommerce,
		ShopDomain: "https://store.example",
		Settings:   map[string]any{"store_url": "https://store.example", "credential_ref": "cred_wc_1"},
		SyncCursor: cursor,
	}, syncErr: syncErr}
	backfiller := &fakeWooCommerceBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "woocommerce://order/123", CustomerEmail: "buyer@example.com"}},
		Cursor: encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "refunds", Page: 1}),
	}}
	deps := &Deps{Repo: store, WooCommerceBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	retry, ok, err := decodeWooCommerceRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.LastStatus != "SYNC_FAILED" || store.lastSyncErr != syncErr {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationPullsBigCommerceBackfillWhenPayloadEmpty(t *testing.T) {
	cursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "products", Page: 2})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderBigCommerce,
		ShopDomain: "abc123",
		Settings:   map[string]any{"store_hash": "abc123", "credential_ref": "cred_bc"},
		SyncCursor: cursor,
	}}
	backfiller := &fakeBigCommerceBackfiller{req: SyncRequest{
		Products: []ProductInput{{SourceID: "bigcommerce://product/7", Title: "Beanie", PriceCents: 1999, Currency: "USD"}},
		Cursor:   encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "orders", Page: 1}),
	}}
	deps := &Deps{Repo: store, BigCommerceBackfiller: backfiller}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.tenantID != "tenant-1" || backfiller.cursor != cursor || backfiller.integration.Provider != ProviderBigCommerce {
		t.Fatalf("backfiller tenant=%q cursor=%q integration=%+v", backfiller.tenantID, backfiller.cursor, backfiller.integration)
	}
	if len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.Products) != 1 {
		t.Fatalf("sync requests=%+v", store.lastSyncRequests)
	}
	if store.lastSyncRequest.Cursor != backfiller.req.Cursor {
		t.Fatalf("cursor = %q", store.lastSyncRequest.Cursor)
	}
}

func TestSyncIntegrationStoresBigCommerceRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "orders", Page: 3})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderBigCommerce,
		ShopDomain: "abc123",
		Settings:   map[string]any{"store_hash": "abc123", "credential_ref": "cred_bc"},
		SyncCursor: cursor,
	}}
	backfiller := &fakeBigCommerceBackfiller{err: BigCommerceRateLimitError{Path: "/v2/orders", StatusCode: http.StatusTooManyRequests, RetryAfter: 2 * time.Minute}}
	deps := &Deps{Repo: store, BigCommerceBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor {
		t.Fatalf("backfiller cursor = %q", backfiller.cursor)
	}
	retry, ok, err := decodeBigCommerceRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt == "" || store.lastSyncErr == nil {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationSkipsBigCommerceRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "orders", Page: 3})
	retryCursor := encodeBigCommerceRetryCursor(bigCommerceRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderBigCommerce,
		ShopDomain: "abc123",
		Settings:   map[string]any{"store_hash": "abc123", "credential_ref": "cred_bc"},
		SyncCursor: retryCursor,
	}}
	backfiller := &fakeBigCommerceBackfiller{}
	deps := &Deps{Repo: store, BigCommerceBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != "" || len(store.lastSyncRequests) != 0 || store.lastSyncCursor != "" {
		t.Fatalf("backfiller cursor=%q syncRequests=%+v storedCursor=%q", backfiller.cursor, store.lastSyncRequests, store.lastSyncCursor)
	}
}

func TestSyncIntegrationResumesBigCommerceRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "orders", Page: 3})
	retryCursor := encodeBigCommerceRetryCursor(bigCommerceRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderBigCommerce,
		ShopDomain: "abc123",
		Settings:   map[string]any{"store_hash": "abc123", "credential_ref": "cred_bc"},
		SyncCursor: retryCursor,
	}}
	backfiller := &fakeBigCommerceBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "bigcommerce://order/123", CustomerEmail: "buyer@example.com"}},
		Cursor: bigCommerceCursorComplete,
	}}
	deps := &Deps{Repo: store, BigCommerceBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor || len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.Orders) != 1 {
		t.Fatalf("backfiller cursor=%q syncRequests=%+v", backfiller.cursor, store.lastSyncRequests)
	}
}

func TestSyncIntegrationPreservesBigCommerceRetryAttemptsOnDueBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "orders", Page: 3})
	retryCursor := encodeBigCommerceRetryCursor(bigCommerceRetryState{
		Cursor:        cursor,
		Attempts:      2,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderBigCommerce,
		ShopDomain: "abc123",
		Settings:   map[string]any{"store_hash": "abc123", "credential_ref": "cred_bc"},
		SyncCursor: retryCursor,
	}}
	backfiller := &fakeBigCommerceBackfiller{err: BigCommerceRateLimitError{Path: "/v2/orders", StatusCode: http.StatusTooManyRequests, RetryAfter: 2 * time.Minute}}
	deps := &Deps{Repo: store, BigCommerceBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor {
		t.Fatalf("backfiller cursor = %q want %q", backfiller.cursor, cursor)
	}
	retry, ok, err := decodeBigCommerceRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.Object != "orders" || retry.Page != 3 || retry.Attempts != 3 ||
		retry.LastStatus != "BACKFILL_FAILED" ||
		retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) ||
		store.lastSyncErr == nil {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationStoresBigCommerceRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "orders", Page: 3})
	syncErr := errors.New("sync unavailable")
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderBigCommerce,
		ShopDomain: "abc123",
		Settings:   map[string]any{"store_hash": "abc123", "credential_ref": "cred_bc"},
		SyncCursor: cursor,
	}, syncErr: syncErr}
	backfiller := &fakeBigCommerceBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "bigcommerce://order/123", CustomerEmail: "buyer@example.com"}},
		Cursor: bigCommerceCursorComplete,
	}}
	deps := &Deps{Repo: store, BigCommerceBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	retry, ok, err := decodeBigCommerceRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.LastStatus != "SYNC_FAILED" || store.lastSyncErr != syncErr {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationPreservesBigCommerceRetryAttemptsOnDueSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "orders", Page: 3})
	retryCursor := encodeBigCommerceRetryCursor(bigCommerceRetryState{
		Cursor:        cursor,
		Attempts:      2,
		LastStatus:    "SYNC_FAILED",
		LastError:     "sync unavailable",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	syncErr := errors.New("sync unavailable again")
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderBigCommerce,
		ShopDomain: "abc123",
		Settings:   map[string]any{"store_hash": "abc123", "credential_ref": "cred_bc"},
		SyncCursor: retryCursor,
	}, syncErr: syncErr}
	backfiller := &fakeBigCommerceBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "bigcommerce://order/123", CustomerEmail: "buyer@example.com"}},
		Cursor: bigCommerceCursorComplete,
	}}
	deps := &Deps{Repo: store, BigCommerceBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor {
		t.Fatalf("backfiller cursor = %q want %q", backfiller.cursor, cursor)
	}
	retry, ok, err := decodeBigCommerceRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.Object != "orders" || retry.Page != 3 || retry.Attempts != 3 ||
		retry.LastStatus != "SYNC_FAILED" ||
		retry.NextAttemptAt != now.Add(time.Hour).Format(time.RFC3339) ||
		store.lastSyncErr != syncErr {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationPullsStripeBackfillWhenPayloadEmpty(t *testing.T) {
	cursor := encodeStripeBackfillCursor(stripeBackfillState{Object: "payment_intents"})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderStripe,
		ShopDomain: "acct_123",
		Settings:   map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"},
		SyncCursor: cursor,
	}}
	backfiller := &fakeStripeBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "stripe://payment_intent/pi_123", CustomerEmail: "buyer@example.com", Status: "paid", TotalCents: 4200, Currency: "USD"}},
		Cursor: stripeCursorComplete,
	}}
	deps := &Deps{Repo: store, StripeBackfiller: backfiller}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.tenantID != "tenant-1" || backfiller.cursor != cursor || backfiller.integration.Provider != ProviderStripe {
		t.Fatalf("backfiller tenant=%q cursor=%q integration=%+v", backfiller.tenantID, backfiller.cursor, backfiller.integration)
	}
	if len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.Orders) != 1 {
		t.Fatalf("sync requests=%+v", store.lastSyncRequests)
	}
	if store.lastSyncRequest.Cursor != stripeCursorComplete {
		t.Fatalf("cursor = %q", store.lastSyncRequest.Cursor)
	}
}

func TestSyncIntegrationStoresStripeRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeStripeBackfillCursor(stripeBackfillState{Object: "payment_intents", StartingAfter: "pi_123"})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderStripe,
		ShopDomain: "acct_123",
		Settings:   map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"},
		SyncCursor: cursor,
	}}
	backfiller := &fakeStripeBackfiller{err: StripeRateLimitError{Path: "/v1/payment_intents", StatusCode: http.StatusTooManyRequests, RetryAfter: 2 * time.Minute, Snippet: "slow down"}}
	deps := &Deps{Repo: store, StripeBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor {
		t.Fatalf("backfiller cursor = %q", backfiller.cursor)
	}
	retry, ok, err := decodeStripeRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) || store.lastSyncErr == nil {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationSkipsStripeRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeStripeBackfillCursor(stripeBackfillState{Object: "payment_intents", StartingAfter: "pi_123"})
	retryCursor := encodeStripeRetryCursor(stripeRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderStripe,
		ShopDomain: "acct_123",
		Settings:   map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"},
		SyncCursor: retryCursor,
	}}
	backfiller := &fakeStripeBackfiller{}
	deps := &Deps{Repo: store, StripeBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != "" || len(store.lastSyncRequests) != 0 || store.lastSyncCursor != "" {
		t.Fatalf("backfiller cursor=%q syncRequests=%+v storedCursor=%q", backfiller.cursor, store.lastSyncRequests, store.lastSyncCursor)
	}
}

func TestSyncIntegrationResumesStripeRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeStripeBackfillCursor(stripeBackfillState{Object: "payment_intents", StartingAfter: "pi_123"})
	retryCursor := encodeStripeRetryCursor(stripeRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderStripe,
		ShopDomain: "acct_123",
		Settings:   map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"},
		SyncCursor: retryCursor,
	}}
	backfiller := &fakeStripeBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "stripe://payment_intent/pi_456", CustomerEmail: "buyer@example.com"}},
		Cursor: stripeCursorComplete,
	}}
	deps := &Deps{Repo: store, StripeBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor || len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.Orders) != 1 {
		t.Fatalf("backfiller cursor=%q syncRequests=%+v", backfiller.cursor, store.lastSyncRequests)
	}
}

func TestSyncIntegrationStoresStripeRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeStripeBackfillCursor(stripeBackfillState{Object: "payment_intents", StartingAfter: "pi_123"})
	syncErr := errors.New("sync unavailable")
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderStripe,
		ShopDomain: "acct_123",
		Settings:   map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"},
		SyncCursor: cursor,
	}, syncErr: syncErr}
	backfiller := &fakeStripeBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "stripe://payment_intent/pi_456", CustomerEmail: "buyer@example.com"}},
		Cursor: stripeCursorComplete,
	}}
	deps := &Deps{Repo: store, StripeBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	retry, ok, err := decodeStripeRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.LastStatus != "SYNC_FAILED" || store.lastSyncErr != syncErr {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationPullsSquareBackfillWhenPayloadEmpty(t *testing.T) {
	cursor := encodeSquareBackfillCursor(squareBackfillState{Object: "payments"})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderSquare,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_square"},
		SyncCursor: cursor,
	}}
	backfiller := &fakeSquareBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "square://payment/pay_123", CustomerEmail: "buyer@example.com", Status: "paid", TotalCents: 4200, Currency: "USD"}},
		Cursor: squareCursorComplete,
	}}
	deps := &Deps{Repo: store, SquareBackfiller: backfiller}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.tenantID != "tenant-1" || backfiller.cursor != cursor || backfiller.integration.Provider != ProviderSquare {
		t.Fatalf("backfiller tenant=%q cursor=%q integration=%+v", backfiller.tenantID, backfiller.cursor, backfiller.integration)
	}
	if len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.Orders) != 1 {
		t.Fatalf("sync requests=%+v", store.lastSyncRequests)
	}
	if store.lastSyncRequest.Cursor != squareCursorComplete {
		t.Fatalf("cursor = %q", store.lastSyncRequest.Cursor)
	}
}

func TestSyncIntegrationStoresSquareRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeSquareBackfillCursor(squareBackfillState{Object: "payments", Cursor: "cursor-payments"})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderSquare,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_square"},
		SyncCursor: cursor,
	}}
	backfiller := &fakeSquareBackfiller{err: SquareRateLimitError{Path: "/v2/payments", StatusCode: http.StatusTooManyRequests, RetryAfter: 90 * time.Second}}
	deps := &Deps{Repo: store, SquareBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor {
		t.Fatalf("backfiller cursor = %q", backfiller.cursor)
	}
	retry, ok, err := decodeSquareRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt == "" || store.lastSyncErr == nil {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationSkipsSquareRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeSquareBackfillCursor(squareBackfillState{Object: "payments", Cursor: "cursor-payments"})
	retryCursor := encodeSquareRetryCursor(squareRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderSquare,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_square"},
		SyncCursor: retryCursor,
	}}
	backfiller := &fakeSquareBackfiller{}
	deps := &Deps{Repo: store, SquareBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != "" || len(store.lastSyncRequests) != 0 || store.lastSyncCursor != "" {
		t.Fatalf("backfiller cursor=%q syncRequests=%+v storedCursor=%q", backfiller.cursor, store.lastSyncRequests, store.lastSyncCursor)
	}
}

func TestSyncIntegrationStoresSquareRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeSquareBackfillCursor(squareBackfillState{Object: "payments", Cursor: "cursor-payments"})
	syncErr := errors.New("sync unavailable")
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderSquare,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_square"},
		SyncCursor: cursor,
	}, syncErr: syncErr}
	backfiller := &fakeSquareBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "square://payment/pay_123", CustomerEmail: "buyer@example.com"}},
		Cursor: squareCursorComplete,
	}}
	deps := &Deps{Repo: store, SquareBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	retry, ok, err := decodeSquareRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.LastStatus != "SYNC_FAILED" || store.lastSyncErr != syncErr {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationPreservesSquareRetryAttemptsOnDueBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeSquareBackfillCursor(squareBackfillState{Object: "payments", Cursor: "cursor-payments"})
	retryCursor := encodeSquareRetryCursor(squareRetryState{
		Cursor:        cursor,
		Attempts:      2,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderSquare,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_square"},
		SyncCursor: retryCursor,
	}}
	backfiller := &fakeSquareBackfiller{err: SquareRateLimitError{Path: "/v2/payments", StatusCode: http.StatusTooManyRequests, RetryAfter: 90 * time.Second}}
	deps := &Deps{Repo: store, SquareBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor {
		t.Fatalf("backfiller cursor = %q", backfiller.cursor)
	}
	retry, ok, err := decodeSquareRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.Attempts != 3 || retry.LastStatus != "BACKFILL_FAILED" ||
		retry.NextAttemptAt != now.Add(90*time.Second).Format(time.RFC3339) || store.lastSyncErr == nil {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationPreservesSquareRetryAttemptsOnDueSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeSquareBackfillCursor(squareBackfillState{Object: "payments", Cursor: "cursor-payments"})
	retryCursor := encodeSquareRetryCursor(squareRetryState{
		Cursor:        cursor,
		Attempts:      2,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	syncErr := errors.New("sync unavailable")
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderSquare,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_square"},
		SyncCursor: retryCursor,
	}, syncErr: syncErr}
	backfiller := &fakeSquareBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "square://payment/pay_123", CustomerEmail: "buyer@example.com"}},
		Cursor: squareCursorComplete,
	}}
	deps := &Deps{Repo: store, SquareBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor {
		t.Fatalf("backfiller cursor = %q", backfiller.cursor)
	}
	retry, ok, err := decodeSquareRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.Attempts != 3 || retry.LastStatus != "SYNC_FAILED" || store.lastSyncErr != syncErr {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationPullsPayPalBackfillWhenPayloadEmpty(t *testing.T) {
	cursor := encodePayPalBackfillCursor(payPalBackfillState{Object: "transactions", Start: "2026-06-01T00:00:00Z", End: "2026-06-18T00:00:00Z", FinalEnd: "2026-06-18T00:00:00Z", Page: 1})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderPayPal,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal"},
		SyncCursor: cursor,
	}}
	backfiller := &fakePayPalBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "paypal://transaction/txn_123", CustomerEmail: "buyer@example.com", Status: "paid", TotalCents: 4200, Currency: "USD"}},
		Cursor: payPalCursorComplete,
	}}
	deps := &Deps{Repo: store, PayPalBackfiller: backfiller}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.tenantID != "tenant-1" || backfiller.cursor != cursor || backfiller.integration.Provider != ProviderPayPal {
		t.Fatalf("backfiller tenant=%q cursor=%q integration=%+v", backfiller.tenantID, backfiller.cursor, backfiller.integration)
	}
	if len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.Orders) != 1 {
		t.Fatalf("sync requests=%+v", store.lastSyncRequests)
	}
	if store.lastSyncRequest.Cursor != payPalCursorComplete {
		t.Fatalf("cursor = %q", store.lastSyncRequest.Cursor)
	}
}

func TestSyncIntegrationStoresPayPalRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodePayPalBackfillCursor(payPalBackfillState{Object: "transactions", Start: "2026-06-01T00:00:00Z", End: "2026-06-18T00:00:00Z", FinalEnd: "2026-06-18T00:00:00Z", Page: 2})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderPayPal,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal"},
		SyncCursor: cursor,
	}}
	backfiller := &fakePayPalBackfiller{err: PayPalRateLimitError{Path: "/v1/reporting/transactions", StatusCode: http.StatusTooManyRequests, RetryAfter: 2 * time.Minute, Snippet: "slow down"}}
	deps := &Deps{Repo: store, PayPalBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor {
		t.Fatalf("backfiller cursor = %q", backfiller.cursor)
	}
	retry, ok, err := decodePayPalRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) || store.lastSyncErr == nil {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationSkipsPayPalRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodePayPalBackfillCursor(payPalBackfillState{Object: "transactions", Start: "2026-06-01T00:00:00Z", End: "2026-06-18T00:00:00Z", FinalEnd: "2026-06-18T00:00:00Z", Page: 2})
	retryCursor := encodePayPalRetryCursor(payPalRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderPayPal,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal"},
		SyncCursor: retryCursor,
	}}
	backfiller := &fakePayPalBackfiller{}
	deps := &Deps{Repo: store, PayPalBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != "" || len(store.lastSyncRequests) != 0 || store.lastSyncCursor != "" {
		t.Fatalf("backfiller cursor=%q syncRequests=%+v storedCursor=%q", backfiller.cursor, store.lastSyncRequests, store.lastSyncCursor)
	}
}

func TestSyncIntegrationResumesPayPalRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodePayPalBackfillCursor(payPalBackfillState{Object: "transactions", Start: "2026-06-01T00:00:00Z", End: "2026-06-18T00:00:00Z", FinalEnd: "2026-06-18T00:00:00Z", Page: 2})
	retryCursor := encodePayPalRetryCursor(payPalRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderPayPal,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal"},
		SyncCursor: retryCursor,
	}}
	backfiller := &fakePayPalBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "paypal://transaction/txn_456", CustomerEmail: "buyer@example.com"}},
		Cursor: payPalCursorComplete,
	}}
	deps := &Deps{Repo: store, PayPalBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor || len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.Orders) != 1 {
		t.Fatalf("backfiller cursor=%q syncRequests=%+v", backfiller.cursor, store.lastSyncRequests)
	}
}

func TestSyncIntegrationStoresPayPalRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodePayPalBackfillCursor(payPalBackfillState{Object: "transactions", Start: "2026-06-01T00:00:00Z", End: "2026-06-18T00:00:00Z", FinalEnd: "2026-06-18T00:00:00Z", Page: 2})
	syncErr := errors.New("sync unavailable")
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderPayPal,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal"},
		SyncCursor: cursor,
	}, syncErr: syncErr}
	backfiller := &fakePayPalBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "paypal://transaction/txn_456", CustomerEmail: "buyer@example.com"}},
		Cursor: payPalCursorComplete,
	}}
	deps := &Deps{Repo: store, PayPalBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	retry, ok, err := decodePayPalRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.LastStatus != "SYNC_FAILED" || store.lastSyncErr != syncErr {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationPreservesPayPalRetryAttemptsOnDueBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodePayPalBackfillCursor(payPalBackfillState{Object: "transactions", Start: "2026-06-01T00:00:00Z", End: "2026-06-18T00:00:00Z", FinalEnd: "2026-06-18T00:00:00Z", Page: 2})
	retryCursor := encodePayPalRetryCursor(payPalRetryState{
		Cursor:        cursor,
		Attempts:      2,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderPayPal,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal"},
		SyncCursor: retryCursor,
	}}
	backfiller := &fakePayPalBackfiller{err: PayPalRateLimitError{Path: "/v1/reporting/transactions", StatusCode: http.StatusTooManyRequests, RetryAfter: 2 * time.Minute, Snippet: "slow down"}}
	deps := &Deps{Repo: store, PayPalBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor {
		t.Fatalf("backfiller cursor = %q", backfiller.cursor)
	}
	retry, ok, err := decodePayPalRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.Object != "transactions" || retry.Page != 2 || retry.Attempts != 3 ||
		retry.LastStatus != "BACKFILL_FAILED" ||
		retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) ||
		store.lastSyncErr == nil {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestSyncIntegrationPreservesPayPalRetryAttemptsOnDueSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodePayPalBackfillCursor(payPalBackfillState{Object: "transactions", Start: "2026-06-01T00:00:00Z", End: "2026-06-18T00:00:00Z", FinalEnd: "2026-06-18T00:00:00Z", Page: 2})
	retryCursor := encodePayPalRetryCursor(payPalRetryState{
		Cursor:        cursor,
		Attempts:      2,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	syncErr := errors.New("sync unavailable")
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderPayPal,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal"},
		SyncCursor: retryCursor,
	}, syncErr: syncErr}
	backfiller := &fakePayPalBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "paypal://transaction/txn_456", CustomerEmail: "buyer@example.com"}},
		Cursor: payPalCursorComplete,
	}}
	deps := &Deps{Repo: store, PayPalBackfiller: backfiller, Now: func() time.Time { return now }}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.cursor != cursor {
		t.Fatalf("backfiller cursor = %q", backfiller.cursor)
	}
	retry, ok, err := decodePayPalRetryCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.Cursor != cursor || retry.Object != "transactions" || retry.Page != 2 || retry.Attempts != 3 ||
		retry.LastStatus != "SYNC_FAILED" || store.lastSyncErr != syncErr {
		t.Fatalf("retry=%+v storedErr=%v", retry, store.lastSyncErr)
	}
}

func TestPayPalWebhookVerifiesSignatureAndUpsertsCapture(t *testing.T) {
	body := []byte(`{
		"id":"WH-123",
		"event_type":"PAYMENT.CAPTURE.COMPLETED",
		"resource_type":"capture",
		"resource":{
			"id":"CAPTURE123",
			"status":"COMPLETED",
			"amount":{"value":"42.00","currency_code":"USD"},
			"payee":{"merchant_id":"MERCHANT123"},
			"payer":{"email_address":"BUYER@example.com"},
			"create_time":"2026-06-18T12:00:00Z"
		}
	}`)
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderPayPal,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal", "webhook_id": "WH-ID"},
	}}
	verifier := &fakePayPalWebhookVerifier{}
	deps := &Deps{
		Repo:                  store,
		PayPalCredentials:     &fakePayPalCredentialResolver{creds: PayPalCredentials{ClientID: "client", ClientSecret: "secret", WebhookID: "WH-ID"}},
		PayPalWebhookVerifier: verifier,
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/paypal/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Paypal-Transmission-Id", "tx_123")
	req.Header.Set("Paypal-Transmission-Sig", "sig")
	req.Header.Set("Paypal-Transmission-Time", "2026-06-18T12:00:01Z")
	req.Header.Set("Paypal-Auth-Algo", "SHA256withRSA")
	req.Header.Set("Paypal-Cert-Url", "https://api-m.paypal.com/certs/test")
	rec := httptest.NewRecorder()

	deps.PayPalWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastPayPalMerchantID != "MERCHANT123" {
		t.Fatalf("merchant lookup = %q", store.lastPayPalMerchantID)
	}
	if verifier.creds.WebhookID != "WH-ID" || verifier.event.EventType != "PAYMENT.CAPTURE.COMPLETED" || string(verifier.body) != string(body) {
		t.Fatalf("verifier creds=%+v event=%+v body=%s", verifier.creds, verifier.event, string(verifier.body))
	}
	if len(store.orders) != 1 {
		t.Fatalf("orders = %+v", store.orders)
	}
	order := store.orders[0]
	if order.SourceID != "paypal://capture/CAPTURE123" || order.CustomerEmail != "buyer@example.com" || order.Status != "paid" || order.TotalCents != 4200 || order.Currency != "USD" {
		t.Fatalf("order = %+v", order)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestPayPalWebhookHydratesSparseCheckoutOrder(t *testing.T) {
	body := []byte(`{
		"id":"WH-SPARSE",
		"event_type":"CHECKOUT.ORDER.COMPLETED",
		"resource_type":"checkout-order",
		"resource":{"id":"ORDER123"}
	}`)
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderPayPal,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal", "webhook_id": "WH-ID"},
	}}
	verifier := &fakePayPalWebhookVerifier{}
	fetcher := &fakePayPalResourceFetcher{out: payPalWebhookEvent{
		ID:           "WH-SPARSE",
		EventType:    "CHECKOUT.ORDER.COMPLETED",
		ResourceType: "checkout-order",
		Resource: map[string]any{
			"id":     "ORDER123",
			"status": "COMPLETED",
			"payer":  map[string]any{"email_address": "BUYER@example.com"},
			"purchase_units": []any{map[string]any{
				"amount": map[string]any{"value": "42.00", "currency_code": "USD"},
				"payee":  map[string]any{"merchant_id": "MERCHANT123"},
				"items": []any{map[string]any{
					"name":        "Newsletter plan",
					"quantity":    "2",
					"unit_amount": map[string]any{"value": "21.00", "currency_code": "USD"},
				}},
			}},
		},
	}}
	deps := &Deps{
		Repo:                  store,
		PayPalCredentials:     &fakePayPalCredentialResolver{creds: PayPalCredentials{ClientID: "client", ClientSecret: "secret", WebhookID: "WH-ID"}},
		PayPalWebhookVerifier: verifier,
		PayPalResourceFetcher: fetcher,
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/paypal/webhooks?merchant_id=MERCHANT123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Paypal-Transmission-Id", "tx_sparse")
	req.Header.Set("Paypal-Transmission-Sig", "sig")
	req.Header.Set("Paypal-Transmission-Time", "2026-06-18T12:00:01Z")
	req.Header.Set("Paypal-Auth-Algo", "SHA256withRSA")
	req.Header.Set("Paypal-Cert-Url", "https://api-m.paypal.com/certs/test")
	rec := httptest.NewRecorder()

	deps.PayPalWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastPayPalMerchantID != "MERCHANT123" || verifier.event.EventType != "CHECKOUT.ORDER.COMPLETED" {
		t.Fatalf("paypal routing merchant=%q verifier=%+v", store.lastPayPalMerchantID, verifier.event)
	}
	if fetcher.calls != 1 || fetcher.tenantID != "tenant-1" || fetcher.event.Resource["id"] != "ORDER123" || fetcher.creds.WebhookID != "WH-ID" {
		t.Fatalf("fetcher calls=%d tenant=%q event=%+v creds=%+v", fetcher.calls, fetcher.tenantID, fetcher.event, fetcher.creds)
	}
	if len(store.orders) != 1 {
		t.Fatalf("orders = %+v", store.orders)
	}
	order := store.orders[0]
	if order.SourceID != "paypal://order/ORDER123" || order.CustomerEmail != "buyer@example.com" || order.TotalCents != 4200 || len(order.LineItems) != 1 {
		t.Fatalf("order = %+v", order)
	}
	if store.processed != 1 || store.failed != 0 {
		t.Fatalf("processed=%d failed=%d err=%v", store.processed, store.failed, store.lastFailedErr)
	}
}

func TestPayPalWebhookRejectsHydratedMerchantMismatch(t *testing.T) {
	body := []byte(`{
		"id":"WH-MISMATCH",
		"event_type":"CHECKOUT.ORDER.COMPLETED",
		"resource_type":"checkout-order",
		"resource":{"id":"ORDER123"}
	}`)
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderPayPal,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal", "webhook_id": "WH-ID"},
	}}
	fetcher := &fakePayPalResourceFetcher{out: payPalWebhookEvent{
		ID:           "WH-MISMATCH",
		EventType:    "CHECKOUT.ORDER.COMPLETED",
		ResourceType: "checkout-order",
		Resource: map[string]any{
			"id":     "ORDER123",
			"status": "COMPLETED",
			"purchase_units": []any{map[string]any{
				"amount": map[string]any{"value": "42.00", "currency_code": "USD"},
				"payee":  map[string]any{"merchant_id": "OTHERMERCHANT"},
			}},
		},
	}}
	deps := &Deps{
		Repo:                  store,
		PayPalCredentials:     &fakePayPalCredentialResolver{creds: PayPalCredentials{ClientID: "client", ClientSecret: "secret", WebhookID: "WH-ID"}},
		PayPalWebhookVerifier: &fakePayPalWebhookVerifier{},
		PayPalResourceFetcher: fetcher,
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/paypal/webhooks?merchant_id=MERCHANT123", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PayPalWebhook(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if fetcher.calls != 1 || len(store.orders) != 0 || store.processed != 0 || store.failed != 1 {
		t.Fatalf("fetcher=%d orders=%+v processed=%d failed=%d", fetcher.calls, store.orders, store.processed, store.failed)
	}
	if store.lastFailedErr == nil || !strings.Contains(store.lastFailedErr.Error(), "does not match") {
		t.Fatalf("failed err = %v", store.lastFailedErr)
	}
}

func TestPayPalWebhookRecordsInvoiceAndSubscriptionBillingEvents(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderPayPal,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal", "webhook_id": "WH-ID"},
	}}
	verifier := &fakePayPalWebhookVerifier{}
	deps := &Deps{
		Repo:                  store,
		PayPalCredentials:     &fakePayPalCredentialResolver{creds: PayPalCredentials{ClientID: "client", ClientSecret: "secret", WebhookID: "WH-ID"}},
		PayPalWebhookVerifier: verifier,
	}

	invoiceBody := []byte(`{
		"id":"WH-INVOICE-1",
		"event_type":"INVOICING.INVOICE.PAID",
		"resource_type":"invoices",
		"resource":{
			"id":"INV2-ABCD",
			"status":"PAID",
			"invoice_number":"INV-2026-001",
			"invoicer":{"merchant_id":"MERCHANT123"},
			"amount":{"value":"42.00","currency_code":"USD"},
			"primary_recipients":[{"billing_info":{"email_address":"BUYER@example.com"}}]
		}
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/paypal/webhooks", strings.NewReader(string(invoiceBody)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Paypal-Transmission-Id", "tx_invoice")
	req.Header.Set("Paypal-Transmission-Sig", "sig")
	req.Header.Set("Paypal-Transmission-Time", "2026-06-18T12:00:01Z")
	req.Header.Set("Paypal-Auth-Algo", "SHA256withRSA")
	req.Header.Set("Paypal-Cert-Url", "https://api-m.paypal.com/certs/test")
	rec := httptest.NewRecorder()

	deps.PayPalWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("invoice status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastPayPalMerchantID != "MERCHANT123" || verifier.event.EventType != "INVOICING.INVOICE.PAID" {
		t.Fatalf("paypal invoice routing merchant=%q verifier=%+v", store.lastPayPalMerchantID, verifier.event)
	}
	if len(store.providerEvents) != 1 {
		t.Fatalf("provider events = %+v", store.providerEvents)
	}
	invoice := store.providerEvents[0]
	if invoice.EventType != "invoice_paid" ||
		invoice.Topic != "INVOICING.INVOICE.PAID" ||
		invoice.SourceID != "paypal://invoice/INV2-ABCD" ||
		invoice.ProviderEventID != "invoice_paid:paypal://webhook/WH-INVOICE-1" ||
		invoice.CustomerEmail != "buyer@example.com" {
		t.Fatalf("invoice event = %+v", invoice)
	}
	if invoice.Metadata["merchant_id"] != "MERCHANT123" || invoice.Metadata["invoice_number"] != "INV-2026-001" {
		t.Fatalf("invoice metadata = %+v", invoice.Metadata)
	}

	subscriptionBody := []byte(`{
		"id":"WH-SUB-1",
		"event_type":"BILLING.SUBSCRIPTION.PAYMENT.FAILED",
		"resource_type":"subscription",
		"resource":{
			"id":"I-SUB123",
			"status":"SUSPENDED",
			"plan_id":"P-PLAN123",
			"payee":{"merchant_id":"MERCHANT123"},
			"subscriber":{"email_address":"subscriber@example.com"}
		}
	}`)
	req = httptest.NewRequest(http.MethodPost, "/api/public/commerce/paypal/webhooks", strings.NewReader(string(subscriptionBody)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Paypal-Transmission-Id", "tx_sub")
	req.Header.Set("Paypal-Transmission-Sig", "sig")
	req.Header.Set("Paypal-Transmission-Time", "2026-06-18T12:00:02Z")
	req.Header.Set("Paypal-Auth-Algo", "SHA256withRSA")
	req.Header.Set("Paypal-Cert-Url", "https://api-m.paypal.com/certs/test")
	rec = httptest.NewRecorder()

	deps.PayPalWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("subscription status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.providerEvents) != 2 {
		t.Fatalf("provider events = %+v", store.providerEvents)
	}
	subscription := store.providerEvents[1]
	if subscription.EventType != "subscription_updated" ||
		subscription.Topic != "BILLING.SUBSCRIPTION.PAYMENT.FAILED" ||
		subscription.SourceID != "paypal://subscription/I-SUB123" ||
		subscription.ProviderEventID != "subscription_updated:paypal://webhook/WH-SUB-1" ||
		subscription.CustomerEmail != "subscriber@example.com" {
		t.Fatalf("subscription event = %+v", subscription)
	}
	if subscription.Metadata["merchant_id"] != "MERCHANT123" || subscription.Metadata["subscription_plan_id"] != "P-PLAN123" {
		t.Fatalf("subscription metadata = %+v", subscription.Metadata)
	}
}

func TestPayPalWebhookRejectsFailedVerification(t *testing.T) {
	body := []byte(`{"id":"WH-123","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAPTURE123","payee":{"merchant_id":"MERCHANT123"}}}`)
	store := &fakeStore{integration: &Integration{ID: "int_1", TenantID: "tenant-1", Provider: ProviderPayPal, Settings: map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal", "webhook_id": "WH-ID"}}}
	deps := &Deps{
		Repo:                  store,
		PayPalCredentials:     &fakePayPalCredentialResolver{creds: PayPalCredentials{ClientID: "client", ClientSecret: "secret", WebhookID: "WH-ID"}},
		PayPalWebhookVerifier: &fakePayPalWebhookVerifier{err: ErrInvalidSignature},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/paypal/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PayPalWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.orders) != 0 || store.processed != 0 {
		t.Fatalf("webhook should not dispatch orders=%+v processed=%d", store.orders, store.processed)
	}
}

func TestPayPalWebhookVerificationRateLimitIsRetryable(t *testing.T) {
	body := []byte(`{"id":"WH-123","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAPTURE123","payee":{"merchant_id":"MERCHANT123"}}}`)
	store := &fakeStore{integration: &Integration{ID: "int_1", TenantID: "tenant-1", Provider: ProviderPayPal, Settings: map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal", "webhook_id": "WH-ID"}}}
	deps := &Deps{
		Repo:              store,
		PayPalCredentials: &fakePayPalCredentialResolver{creds: PayPalCredentials{ClientID: "client", ClientSecret: "secret", WebhookID: "WH-ID"}},
		PayPalWebhookVerifier: &fakePayPalWebhookVerifier{err: PayPalRateLimitError{
			Path:       "/v1/notifications/verify-webhook-signature",
			StatusCode: http.StatusTooManyRequests,
			RetryAfter: 45 * time.Second,
			Snippet:    "rate limited",
		}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/paypal/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PayPalWebhook(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "45" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if len(store.orders) != 0 || store.processed != 0 {
		t.Fatalf("webhook should not dispatch orders=%+v processed=%d", store.orders, store.processed)
	}
}

func TestPayPalWebhookRejectsSparseResourceWithoutMerchantRouting(t *testing.T) {
	body := []byte(`{"id":"WH-123","event_type":"CHECKOUT.ORDER.APPROVED","resource":{"id":"ORDER123"}}`)
	store := &fakeStore{integration: &Integration{ID: "int_1", TenantID: "tenant-1", Provider: ProviderPayPal, Settings: map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal", "webhook_id": "WH-ID"}}}
	deps := &Deps{
		Repo:                  store,
		PayPalCredentials:     &fakePayPalCredentialResolver{creds: PayPalCredentials{ClientID: "client", ClientSecret: "secret", WebhookID: "WH-ID"}},
		PayPalWebhookVerifier: &fakePayPalWebhookVerifier{},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/paypal/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PayPalWebhook(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "missing_merchant_id") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastPayPalMerchantID != "" || len(store.orders) != 0 || store.processed != 0 {
		t.Fatalf("webhook should not resolve or dispatch merchant=%q orders=%+v processed=%d", store.lastPayPalMerchantID, store.orders, store.processed)
	}
}

func TestPayPalWebhookDisconnectedIntegrationNotResolved(t *testing.T) {
	body := []byte(`{"id":"WH-123","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAPTURE123","payee":{"merchant_id":"MERCHANT123"}}}`)
	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		TenantID: "tenant-1",
		Provider: ProviderPayPal,
		Status:   "disconnected",
		Settings: map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_paypal", "webhook_id": "WH-ID"},
	}}
	deps := &Deps{
		Repo:                  store,
		PayPalCredentials:     &fakePayPalCredentialResolver{creds: PayPalCredentials{ClientID: "client", ClientSecret: "secret", WebhookID: "WH-ID"}},
		PayPalWebhookVerifier: &fakePayPalWebhookVerifier{},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/paypal/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PayPalWebhook(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.orders) != 0 || store.processed != 0 {
		t.Fatalf("webhook should not dispatch orders=%+v processed=%d", store.orders, store.processed)
	}
}

func TestDispatchPayPalWebhookUpsertsSaleCompletedOrder(t *testing.T) {
	store := &fakeStore{integration: &Integration{ID: "int_1", TenantID: "tenant-1", Provider: ProviderPayPal}}
	deps := &Deps{Repo: store}

	err := deps.dispatchPayPalWebhook(context.Background(), store.integration, payPalWebhookEvent{
		ID:        "WH-SALE-1",
		EventType: "PAYMENT.SALE.COMPLETED",
		Resource: map[string]any{
			"id":          "SALE123",
			"state":       "completed",
			"amount":      map[string]any{"total": "42.00", "currency": "USD"},
			"payee":       map[string]any{"merchant_id": "MERCHANT123"},
			"payer":       map[string]any{"payer_info": map[string]any{"email": "BUYER@example.com"}},
			"create_time": "2026-06-18T12:00:00Z",
		},
	})

	if err != nil {
		t.Fatal(err)
	}
	if len(store.orders) != 1 || store.orders[0].SourceID != "paypal://sale/SALE123" || store.orders[0].Status != "paid" {
		t.Fatalf("orders=%+v", store.orders)
	}
}

func TestSyncIntegrationPullsRazorpayBackfillWhenPayloadEmpty(t *testing.T) {
	cursor := encodeRazorpayBackfillCursor(razorpayBackfillState{Object: "payments"})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderRazorpay,
		ShopDomain: "acc_123",
		Settings:   map[string]any{"account_id": "acc_123", "credential_ref": "cred_razorpay"},
		SyncCursor: cursor,
	}}
	backfiller := &fakeRazorpayBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "razorpay://payment/pay_123", CustomerEmail: "buyer@example.com", Status: "paid", TotalCents: 4200, Currency: "INR"}},
		Cursor: razorpayCursorComplete,
	}}
	deps := &Deps{Repo: store, RazorpayBackfiller: backfiller}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.tenantID != "tenant-1" || backfiller.cursor != cursor || backfiller.integration.Provider != ProviderRazorpay {
		t.Fatalf("backfiller tenant=%q cursor=%q integration=%+v", backfiller.tenantID, backfiller.cursor, backfiller.integration)
	}
	if len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.Orders) != 1 {
		t.Fatalf("sync requests=%+v", store.lastSyncRequests)
	}
	if store.lastSyncRequest.Cursor != razorpayCursorComplete {
		t.Fatalf("cursor = %q", store.lastSyncRequest.Cursor)
	}
}

func TestSyncIntegrationPullsAdobeCommerceBackfillWhenPayloadEmpty(t *testing.T) {
	cursor := encodeAdobeCommerceBackfillCursor(adobeCommerceBackfillState{Object: "orders", Page: 2})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderAdobeCommerce,
		ShopDomain: "https://magento.example.com",
		Settings:   map[string]any{"base_url": "https://magento.example.com", "credential_ref": "cred_adobe"},
		SyncCursor: cursor,
	}}
	backfiller := &fakeAdobeCommerceBackfiller{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "adobe-commerce://order/100", CustomerEmail: "buyer@example.com", Status: "paid", TotalCents: 4200, Currency: "USD"}},
		Cursor: adobeCommerceCursorComplete,
	}}
	deps := &Deps{Repo: store, AdobeCommerceBackfiller: backfiller}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.tenantID != "tenant-1" || backfiller.cursor != cursor || backfiller.integration.Provider != ProviderAdobeCommerce {
		t.Fatalf("backfiller tenant=%q cursor=%q integration=%+v", backfiller.tenantID, backfiller.cursor, backfiller.integration)
	}
	if len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.Orders) != 1 {
		t.Fatalf("sync requests=%+v", store.lastSyncRequests)
	}
	if store.lastSyncRequest.Cursor != adobeCommerceCursorComplete {
		t.Fatalf("cursor = %q", store.lastSyncRequest.Cursor)
	}
}

func TestSyncIntegrationPullsWixStoresBackfillWhenPayloadEmpty(t *testing.T) {
	cursor := encodeWixStoresBackfillCursor(wixStoresBackfillState{Object: "products", Cursor: "product_cursor_2"})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderWixStores,
		ShopDomain: "site_123",
		Settings: map[string]any{
			"site_id":        "site_123",
			"instance_id":    "instance_123",
			"store_id":       "store_123",
			"credential_ref": "cred_wix",
		},
		SyncCursor: cursor,
	}}
	backfiller := &fakeWixStoresBackfiller{req: SyncRequest{
		Products: []ProductInput{{SourceID: "wix://product/prod_123", Title: "Canvas tote", PriceCents: 2400, Currency: "USD"}},
		Cursor:   encodeWixStoresBackfillCursor(wixStoresBackfillState{Object: "orders"}),
	}}
	deps := &Deps{Repo: store, WixStoresBackfiller: backfiller}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.tenantID != "tenant-1" || backfiller.cursor != cursor || backfiller.integration.Provider != ProviderWixStores {
		t.Fatalf("backfiller tenant=%q cursor=%q integration=%+v", backfiller.tenantID, backfiller.cursor, backfiller.integration)
	}
	if len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.Products) != 1 {
		t.Fatalf("sync requests=%+v", store.lastSyncRequests)
	}
	if store.lastSyncRequest.Cursor != backfiller.req.Cursor {
		t.Fatalf("cursor = %q", store.lastSyncRequest.Cursor)
	}
}

func TestSyncIntegrationPullsSquarespaceBackfillWhenPayloadEmpty(t *testing.T) {
	cursor := encodeSquarespaceBackfillCursor(squarespaceBackfillState{Object: "products", Cursor: "product_cursor_2"})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderSquarespace,
		ShopDomain: "site_123",
		Settings: map[string]any{
			"site_id":        "site_123",
			"credential_ref": "cred_squarespace",
		},
		SyncCursor: cursor,
	}}
	backfiller := &fakeSquarespaceBackfiller{req: SyncRequest{
		Products: []ProductInput{{SourceID: "squarespace://product/prod_123", Title: "Canvas tote", PriceCents: 2400, Currency: "USD"}},
		Cursor:   encodeSquarespaceBackfillCursor(squarespaceBackfillState{Object: "orders"}),
	}}
	deps := &Deps{Repo: store, SquarespaceBackfiller: backfiller}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.tenantID != "tenant-1" || backfiller.cursor != cursor || backfiller.integration.Provider != ProviderSquarespace {
		t.Fatalf("backfiller tenant=%q cursor=%q integration=%+v", backfiller.tenantID, backfiller.cursor, backfiller.integration)
	}
	if len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.Products) != 1 {
		t.Fatalf("sync requests=%+v", store.lastSyncRequests)
	}
	if store.lastSyncRequest.Cursor != backfiller.req.Cursor {
		t.Fatalf("cursor = %q", store.lastSyncRequest.Cursor)
	}
}

func TestRazorpayWebhookVerifiesSignatureAndUpsertsPayment(t *testing.T) {
	secret := "rzp_webhook_secret"
	body := []byte(`{
		"entity":"event",
		"account_id":"acc_123",
		"event":"payment.captured",
		"contains":["payment"],
		"payload":{"payment":{"entity":{
			"id":"pay_123",
			"entity":"payment",
			"amount":4200,
			"currency":"INR",
			"status":"captured",
			"email":"BUYER@example.com",
			"order_id":"order_123",
			"created_at":1781784000
		}}}
	}`)
	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		TenantID: "tenant-1",
		Provider: ProviderRazorpay,
		Settings: map[string]any{
			"account_id":          "acc_123",
			"credential_ref":      "cred_razorpay",
			"webhook_secret_ref":  "cred_razorpay_webhook",
			"settlement_currency": "INR",
		},
	}}
	deps := &Deps{
		Repo:                store,
		RazorpayCredentials: &fakeRazorpayCredentialResolver{creds: RazorpayCredentials{KeyID: "rzp_test_key", KeySecret: "rzp_test_secret", WebhookSecret: secret}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/razorpay/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Razorpay-Signature", hexHMACSHA256(secret, body))
	req.Header.Set("x-razorpay-event-id", "evt_123")
	rec := httptest.NewRecorder()

	deps.RazorpayWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastRazorpayAccountID != "acc_123" {
		t.Fatalf("account lookup = %q", store.lastRazorpayAccountID)
	}
	if len(store.orders) != 1 {
		t.Fatalf("orders = %+v", store.orders)
	}
	order := store.orders[0]
	if order.SourceID != "razorpay://payment/pay_123" || order.CustomerEmail != "buyer@example.com" || order.Status != "paid" || order.TotalCents != 4200 || order.Currency != "INR" {
		t.Fatalf("order = %+v", order)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestRazorpayWebhookRejectsBadSignature(t *testing.T) {
	body := []byte(`{"entity":"event","account_id":"acc_123","event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_123"}}}}`)
	store := &fakeStore{integration: &Integration{ID: "int_1", TenantID: "tenant-1", Provider: ProviderRazorpay, Settings: map[string]any{"account_id": "acc_123", "credential_ref": "cred_razorpay"}}}
	deps := &Deps{
		Repo:                store,
		RazorpayCredentials: &fakeRazorpayCredentialResolver{creds: RazorpayCredentials{KeyID: "rzp_test_key", KeySecret: "rzp_test_secret", WebhookSecret: "correct_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/razorpay/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Razorpay-Signature", hexHMACSHA256("wrong_secret", body))
	rec := httptest.NewRecorder()

	deps.RazorpayWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.orders) != 0 || store.processed != 0 {
		t.Fatalf("webhook should not dispatch orders=%+v processed=%d", store.orders, store.processed)
	}
}

func TestAdobeCommerceWebhookVerifiesSharedSecretAndUpsertsOrder(t *testing.T) {
	secret := "adobe_webhook_secret"
	body := []byte(`{
		"eventName":"sales_order_place_after",
		"data":{"order":{
			"entity_id":100,
			"increment_id":"000100",
			"status":"complete",
			"state":"complete",
			"customer_email":"BUYER@example.com",
			"grand_total":"42.00",
			"order_currency_code":"USD",
			"items":[{"item_id":5,"sku":"TEE-BLACK","name":"Black tee","qty_ordered":2,"price":"21.00","row_total":"42.00"}],
			"created_at":"2026-06-18T12:00:00Z"
		}}
	}`)
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderAdobeCommerce,
		ShopDomain: "https://magento.example.com",
		Settings:   map[string]any{"base_url": "https://magento.example.com", "credential_ref": "cred_adobe", "event_auth_ref": "cred_adobe_webhook"},
	}}
	deps := &Deps{
		Repo:                     store,
		AdobeCommerceCredentials: &fakeAdobeCommerceCredentialResolver{creds: AdobeCommerceCredentials{WebhookSecret: secret}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/adobe-commerce/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Adobe-Commerce-Base-Url", "https://magento.example.com/")
	req.Header.Set("X-Adobe-Commerce-Webhook-Secret", secret)
	req.Header.Set("X-Adobe-Commerce-Webhook-Id", "evt_adobe_123")
	rec := httptest.NewRecorder()

	deps.AdobeCommerceWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastAdobeBaseURL != "https://magento.example.com" {
		t.Fatalf("base URL lookup = %q", store.lastAdobeBaseURL)
	}
	if len(store.orders) != 1 {
		t.Fatalf("orders = %+v", store.orders)
	}
	order := store.orders[0]
	if order.SourceID != "adobe-commerce://order/100" || order.CustomerEmail != "buyer@example.com" || order.Status != "paid" || order.TotalCents != 4200 || order.Currency != "USD" {
		t.Fatalf("order = %+v", order)
	}
	if len(order.LineItems) != 1 || order.LineItems[0]["sku"] != "TEE-BLACK" || order.LineItems[0]["price_cents"] != 2100 {
		t.Fatalf("line items = %+v", order.LineItems)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestAdobeCommerceWebhookRejectsBadSharedSecret(t *testing.T) {
	body := []byte(`{"eventName":"sales_order_place_after","data":{"order":{"entity_id":100}}}`)
	store := &fakeStore{integration: &Integration{ID: "int_1", TenantID: "tenant-1", Provider: ProviderAdobeCommerce, Settings: map[string]any{"base_url": "https://magento.example.com", "credential_ref": "cred_adobe"}}}
	deps := &Deps{
		Repo:                     store,
		AdobeCommerceCredentials: &fakeAdobeCommerceCredentialResolver{creds: AdobeCommerceCredentials{WebhookSecret: "correct_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/adobe-commerce/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Adobe-Commerce-Base-Url", "https://magento.example.com")
	req.Header.Set("X-Adobe-Commerce-Webhook-Secret", "wrong_secret")
	rec := httptest.NewRecorder()

	deps.AdobeCommerceWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.orders) != 0 || store.processed != 0 {
		t.Fatalf("webhook should not dispatch orders=%+v processed=%d", store.orders, store.processed)
	}
}

func TestWixStoresWebhookVerifiesHeaderSharedSecretAndUpsertsOrder(t *testing.T) {
	secret := "wix_webhook_secret"
	body := []byte(`{
		"eventId":"evt_wix_123",
		"eventType":"wix.stores.order_created",
		"siteId":"site_123",
		"data":{"order":{
			"id":"order_1",
			"number":"1001",
			"status":"APPROVED",
			"buyerInfo":{"email":"BUYER@example.com"},
			"priceSummary":{"total":{"amount":"42.00","currency":"USD"}},
			"lineItems":[{"id":"line_1","sku":"TEE-BLACK","productName":"Black tee","quantity":2,"price":{"amount":"21.00","currency":"USD"}}],
			"createdDate":"2026-06-18T12:00:00Z"
		}}
	}`)
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderWixStores,
		ShopDomain: "site_123",
		Settings:   map[string]any{"site_id": "site_123", "credential_ref": "cred_wix", "webhook_secret_ref": "cred_wix_webhook"},
	}}
	deps := &Deps{
		Repo:                 store,
		WixStoresCredentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{WebhookSecret: secret}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/wix-stores/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wix-Site-Id", "site_123")
	req.Header.Set("X-Wix-Event-Type", "wix.stores.order_created")
	req.Header.Set("X-Wix-Webhook-Secret", secret)
	req.Header.Set("X-Wix-Event-Id", "evt_wix_123")
	rec := httptest.NewRecorder()

	deps.WixStoresWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastWixSiteID != "site_123" {
		t.Fatalf("site lookup = %q", store.lastWixSiteID)
	}
	if len(store.orders) != 1 {
		t.Fatalf("orders = %+v", store.orders)
	}
	order := store.orders[0]
	if order.SourceID != "wix://order/order_1" || order.CustomerEmail != "buyer@example.com" || order.Status != "paid" || order.TotalCents != 4200 || order.Currency != "USD" {
		t.Fatalf("order = %+v", order)
	}
	if len(order.LineItems) != 1 || order.LineItems[0]["sku"] != "TEE-BLACK" || order.LineItems[0]["price_cents"] != 2100 {
		t.Fatalf("line items = %+v", order.LineItems)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestWixStoresWebhookRecordsPricingPlanProviderEvent(t *testing.T) {
	secret := "wix_webhook_secret"
	body := []byte(`{
		"eventId":"evt_wix_plan_123",
		"eventType":"wix.pricing_plans.v2.order_purchased",
		"siteId":"site_123",
		"data":{"order":{
			"id":"plan_order_1",
			"buyer":{"email":"MEMBER@example.com"},
			"planId":"plan_123",
			"status":"ACTIVE"
		}}
	}`)
	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		TenantID: "tenant-1",
		Provider: ProviderWixStores,
		Settings: map[string]any{
			"site_id":        "site_123",
			"credential_ref": "cred_wix",
		},
	}}
	deps := &Deps{
		Repo:                 store,
		WixStoresCredentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{WebhookSecret: secret}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/wix-stores/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wix-Webhook-Secret", secret)
	rec := httptest.NewRecorder()

	deps.WixStoresWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.providerEvents) != 1 || len(store.orders) != 0 {
		t.Fatalf("provider events=%+v orders=%+v", store.providerEvents, store.orders)
	}
	event := store.providerEvents[0]
	if event.EventType != "subscription_created" ||
		event.Topic != "wix.pricing_plans.v2.order_purchased" ||
		event.SourceID != "wix://subscription/plan_order_1" ||
		event.CustomerEmail != "member@example.com" ||
		event.ProviderEventID != "wix:evt_wix_plan_123" {
		t.Fatalf("event=%+v", event)
	}
	if event.Metadata["object"] != "subscription" || event.Metadata["site_id"] != "site_123" {
		t.Fatalf("metadata=%+v", event.Metadata)
	}
}

func TestWixStoresWebhookRecordsBookingAndTicketProviderEvents(t *testing.T) {
	secret := "wix_webhook_secret"
	cases := []struct {
		name       string
		body       string
		eventType  string
		sourceID   string
		objectName string
		email      string
	}{
		{
			name: "booking cancellation",
			body: `{
				"eventId":"evt_wix_booking_1",
				"eventType":"wix.bookings.v2.booking.canceled",
				"siteId":"site_123",
				"data":{"booking":{"id":"booking_123","contactDetails":{"email":"BOOKER@example.com"}}}
			}`,
			eventType:  "booking_cancelled",
			sourceID:   "wix://booking/booking_123",
			objectName: "booking",
			email:      "booker@example.com",
		},
		{
			name: "event ticket purchase",
			body: `{
				"eventId":"evt_wix_ticket_1",
				"eventType":"wix.events.v1.ticket.purchased",
				"siteId":"site_123",
				"data":{"ticket":{"ticketNumber":"TICKET-123","guest":{"email":"GUEST@example.com"}}}
			}`,
			eventType:  "ticket_purchased",
			sourceID:   "wix://ticket/TICKET-123",
			objectName: "ticket",
			email:      "guest@example.com",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{integration: &Integration{
				ID:       "int_1",
				TenantID: "tenant-1",
				Provider: ProviderWixStores,
				Settings: map[string]any{
					"site_id":        "site_123",
					"credential_ref": "cred_wix",
				},
			}}
			deps := &Deps{
				Repo:                 store,
				WixStoresCredentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{WebhookSecret: secret}},
			}
			req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/wix-stores/webhooks", strings.NewReader(tc.body))
			req.Header.Set("X-Wix-Webhook-Secret", secret)
			rec := httptest.NewRecorder()

			deps.WixStoresWebhook(rec, req)

			if rec.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if len(store.providerEvents) != 1 || len(store.orders) != 0 {
				t.Fatalf("provider events=%+v orders=%+v", store.providerEvents, store.orders)
			}
			event := store.providerEvents[0]
			if event.EventType != tc.eventType || event.SourceID != tc.sourceID || event.CustomerEmail != tc.email {
				t.Fatalf("event=%+v", event)
			}
			if event.Metadata["object"] != tc.objectName {
				t.Fatalf("metadata=%+v", event.Metadata)
			}
		})
	}
}

func TestWixStoresWebhookRejectsBadHeaderSharedSecret(t *testing.T) {
	body := []byte(`{"eventType":"wix.stores.order_created","siteId":"site_123","data":{"order":{"id":"order_1"}}}`)
	store := &fakeStore{integration: &Integration{ID: "int_1", TenantID: "tenant-1", Provider: ProviderWixStores, Settings: map[string]any{"site_id": "site_123", "credential_ref": "cred_wix"}}}
	deps := &Deps{
		Repo:                 store,
		WixStoresCredentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{WebhookSecret: "correct_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/wix-stores/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wix-Site-Id", "site_123")
	req.Header.Set("X-Wix-Webhook-Secret", "wrong_secret")
	rec := httptest.NewRecorder()

	deps.WixStoresWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.orders) != 0 || store.processed != 0 {
		t.Fatalf("webhook should not dispatch orders=%+v processed=%d", store.orders, store.processed)
	}
}

func TestWixStoresWebhookVerifiesSharedSecretAndUpsertsOrder(t *testing.T) {
	secret := "wix_webhook_secret"
	body := []byte(`{
		"eventId":"evt_wix_123",
		"eventType":"wix.stores.order_created",
		"siteId":"site_123",
		"data":{"order":{
			"id":"order_123",
			"status":"APPROVED",
			"buyerInfo":{"email":"BUYER@example.com"},
			"priceSummary":{
				"subtotal":{"amount":"40.00","currency":"USD"},
				"shipping":{"amount":"1.00","currency":"USD"},
				"tax":{"amount":"1.00","currency":"USD"},
				"total":{"amount":"42.00","currency":"USD"}
			},
			"lineItems":[{"id":"line_1","productId":"prod_123","sku":"TOTE-BLACK","productName":"Black tote","quantity":2,"price":{"amount":"21.00","currency":"USD"}}],
			"createdDate":"2026-06-18T12:00:00Z"
		}}
	}`)
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderWixStores,
		ShopDomain: "site_123",
		Settings: map[string]any{
			"site_id":            "site_123",
			"instance_id":        "instance_123",
			"store_id":           "store_123",
			"credential_ref":     "cred_wix",
			"webhook_secret_ref": "cred_wix_webhook",
		},
	}}
	deps := &Deps{
		Repo:                 store,
		WixStoresCredentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{WebhookSecret: secret}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/wix-stores/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wix-Webhook-Secret", secret)
	rec := httptest.NewRecorder()

	deps.WixStoresWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastWixSiteID != "site_123" {
		t.Fatalf("site lookup = %q", store.lastWixSiteID)
	}
	if len(store.orders) != 1 {
		t.Fatalf("orders = %+v", store.orders)
	}
	order := store.orders[0]
	if order.SourceID != "wix://order/order_123" || order.CustomerEmail != "buyer@example.com" || order.Status != "paid" || order.TotalCents != 4200 || order.Currency != "USD" {
		t.Fatalf("order = %+v", order)
	}
	if len(order.LineItems) != 1 || order.LineItems[0]["sku"] != "TOTE-BLACK" || order.LineItems[0]["price_cents"] != 2100 {
		t.Fatalf("line items = %+v", order.LineItems)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestWixStoresWebhookRejectsBadSharedSecret(t *testing.T) {
	body := []byte(`{"eventId":"evt_wix_123","eventType":"wix.stores.order_created","siteId":"site_123","data":{"order":{"id":"order_123"}}}`)
	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		TenantID: "tenant-1",
		Provider: ProviderWixStores,
		Settings: map[string]any{
			"site_id":        "site_123",
			"credential_ref": "cred_wix",
		},
	}}
	deps := &Deps{
		Repo:                 store,
		WixStoresCredentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{WebhookSecret: "correct_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/wix-stores/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wix-Webhook-Secret", "wrong_secret")
	rec := httptest.NewRecorder()

	deps.WixStoresWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.orders) != 0 || store.processed != 0 {
		t.Fatalf("webhook should not dispatch orders=%+v processed=%d", store.orders, store.processed)
	}
}

func TestWixStoresWebhookFetchesLightweightOrderEvent(t *testing.T) {
	secret := "wix_webhook_secret"
	body := []byte(`{"id":"evt_wix_123","entityFqdn":"wix.ecom.v1.order","slug":"created","entityId":"order_123","siteId":"site_123"}`)
	var gotPath string
	var gotAuth string
	var gotSiteID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotSiteID = r.Header.Get("wix-site-id")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"order":{
			"id":"order_123",
			"status":"APPROVED",
			"buyerInfo":{"email":"BUYER@example.com"},
			"priceSummary":{"total":{"amount":"42.00","currency":"USD"}},
			"lineItems":[{"id":"line_1","productId":"prod_123","sku":"TOTE-BLACK","productName":"Black tote","quantity":2,"price":{"amount":"21.00","currency":"USD"}}],
			"createdDate":"2026-06-18T12:00:00Z"
		}}`))
	}))
	defer srv.Close()

	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		TenantID: "tenant-1",
		Provider: ProviderWixStores,
		Settings: map[string]any{
			"site_id":        "site_123",
			"credential_ref": "cred_wix",
			"api_base_url":   srv.URL,
		},
	}}
	deps := &Deps{
		Repo:                 store,
		HTTPClient:           srv.Client(),
		WixStoresCredentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{AccessToken: "access_123", WebhookSecret: secret}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/wix-stores/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wix-Webhook-Secret", secret)
	rec := httptest.NewRecorder()

	deps.WixStoresWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if gotPath != "/ecom/v1/orders/order_123" || gotAuth != "Bearer access_123" || gotSiteID != "site_123" {
		t.Fatalf("fetch path=%q auth=%q site=%q", gotPath, gotAuth, gotSiteID)
	}
	if len(store.orders) != 1 {
		t.Fatalf("orders = %+v", store.orders)
	}
	order := store.orders[0]
	if order.SourceID != "wix://order/order_123" || order.CustomerEmail != "buyer@example.com" || order.TotalCents != 4200 {
		t.Fatalf("order = %+v", order)
	}
}

func TestWixStoresWebhookDeletesLightweightContactEvent(t *testing.T) {
	secret := "wix_webhook_secret"
	body := []byte(`{"id":"evt_wix_456","entityFqdn":"wix.contacts.v4.contact","slug":"deleted","entityId":"contact_123","siteId":"site_123"}`)
	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		TenantID: "tenant-1",
		Provider: ProviderWixStores,
		Settings: map[string]any{
			"site_id":        "site_123",
			"credential_ref": "cred_wix",
		},
	}}
	deps := &Deps{
		Repo:                 store,
		WixStoresCredentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{AccessToken: "access_123", WebhookSecret: secret}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/wix-stores/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wix-Webhook-Secret", secret)
	rec := httptest.NewRecorder()

	deps.WixStoresWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.deletedCustomers) != 1 {
		t.Fatalf("deleted customers = %+v", store.deletedCustomers)
	}
	deletion := store.deletedCustomers[0]
	if deletion.SourceID != "wix://contact/contact_123" || deletion.Provider != ProviderWixStores || deletion.Topic == "" {
		t.Fatalf("deletion = %+v", deletion)
	}
	if len(store.customers) != 0 || store.processed != 1 {
		t.Fatalf("unexpected customers=%+v processed=%d", store.customers, store.processed)
	}
}

func TestWixStoresWebhookVerifiesSignedJWTAndFetchesOrder(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	publicKey := pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: x509.MarshalPKCS1PublicKey(&key.PublicKey)})
	claims := map[string]any{
		"iss":        "wix.com",
		"aud":        "app_123",
		"iat":        time.Now().UTC().Add(-time.Minute).Unix(),
		"exp":        time.Now().UTC().Add(time.Hour).Unix(),
		"id":         "evt_wix_jwt_123",
		"entityFqdn": "wix.ecom.v1.order",
		"slug":       "created",
		"entityId":   "order_123",
		"instanceId": "instance_123",
	}
	token := signWixStoresJWTForTest(t, key, claims)
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if auth := r.Header.Get("Authorization"); auth != "Bearer access_123" {
			t.Fatalf("auth=%q", auth)
		}
		if siteID := r.Header.Get("wix-site-id"); siteID != "site_123" {
			t.Fatalf("site=%q", siteID)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"order":{
			"id":"order_123",
			"status":"APPROVED",
			"buyerInfo":{"email":"BUYER@example.com"},
			"priceSummary":{"total":{"amount":"42.00","currency":"USD"}},
			"lineItems":[{"id":"line_1","sku":"TOTE-BLACK","productName":"Black tote","quantity":2,"price":{"amount":"21.00","currency":"USD"}}]
		}}`))
	}))
	defer srv.Close()

	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderWixStores,
		ShopDomain: "site_123",
		Settings: map[string]any{
			"site_id":        "site_123",
			"instance_id":    "instance_123",
			"app_id":         "app_123",
			"credential_ref": "cred_wix",
			"api_base_url":   srv.URL,
		},
	}}
	deps := &Deps{
		Repo:       store,
		HTTPClient: srv.Client(),
		WixStoresCredentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{
			AccessToken:      "access_123",
			WebhookPublicKey: string(publicKey),
			AppID:            "app_123",
		}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/wix-stores/webhooks", strings.NewReader(token))
	rec := httptest.NewRecorder()

	deps.WixStoresWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastWixSiteID != "instance_123" {
		t.Fatalf("lookup = %q", store.lastWixSiteID)
	}
	if gotPath != "/ecom/v1/orders/order_123" {
		t.Fatalf("path=%q", gotPath)
	}
	if len(store.orders) != 1 || store.orders[0].SourceID != "wix://order/order_123" {
		t.Fatalf("orders=%+v", store.orders)
	}
	if store.processed != 1 {
		t.Fatalf("processed=%d", store.processed)
	}
}

func TestWixStoresWebhookMarksAppRemovedFromSignedJWT(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	publicKey := pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: x509.MarshalPKCS1PublicKey(&key.PublicKey)})
	token := signWixStoresJWTForTest(t, key, map[string]any{
		"iss":        "wix.com",
		"aud":        "app_123",
		"iat":        time.Now().UTC().Add(-time.Minute).Unix(),
		"exp":        time.Now().UTC().Add(time.Hour).Unix(),
		"id":         "evt_wix_removed_123",
		"entityFqdn": "wix.app.v1.instance",
		"slug":       "removed",
		"instanceId": "instance_123",
	})
	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		TenantID: "tenant-1",
		Provider: ProviderWixStores,
		Status:   "connected",
		Settings: map[string]any{
			"instance_id":    "instance_123",
			"app_id":         "app_123",
			"credential_ref": "cred_wix",
		},
	}}
	deps := &Deps{
		Repo: store,
		WixStoresCredentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{
			WebhookPublicKey: string(publicKey),
			AppID:            "app_123",
		}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/wix-stores/webhooks", strings.NewReader(token))
	rec := httptest.NewRecorder()

	deps.WixStoresWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !store.wixUninstalled || store.integration.Status != "needs_auth" {
		t.Fatalf("uninstalled=%v integration=%+v", store.wixUninstalled, store.integration)
	}
	if store.processed != 1 {
		t.Fatalf("processed=%d", store.processed)
	}
}

func TestWixStoresWebhookRecoversNeedsAuthFromSignedInstallJWT(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	publicKey := pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: x509.MarshalPKCS1PublicKey(&key.PublicKey)})
	token := signWixStoresJWTForTest(t, key, map[string]any{
		"iss":        "wix.com",
		"aud":        "app_123",
		"iat":        time.Now().UTC().Add(-time.Minute).Unix(),
		"exp":        time.Now().UTC().Add(time.Hour).Unix(),
		"id":         "evt_wix_installed_123",
		"entityFqdn": "wix.app.v1.instance",
		"slug":       "installed",
		"instanceId": "instance_123",
		"siteId":     "site_123",
		"appId":      "app_123",
	})
	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		TenantID: "tenant-1",
		Provider: ProviderWixStores,
		Status:   "needs_auth",
		Settings: map[string]any{
			"instance_id":    "instance_123",
			"site_id":        "site_123",
			"app_id":         "app_123",
			"credential_ref": "cred_wix",
		},
	}}
	deps := &Deps{
		Repo: store,
		WixStoresCredentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{
			WebhookPublicKey: string(publicKey),
			AppID:            "app_123",
		}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/wix-stores/webhooks", strings.NewReader(token))
	rec := httptest.NewRecorder()

	deps.WixStoresWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastIntegrationInput.Provider != ProviderWixStores || store.lastIntegrationInput.Status != "connected" {
		t.Fatalf("last integration input=%+v", store.lastIntegrationInput)
	}
	if got := settingString(store.lastIntegrationInput.Settings, "wix_app_instance_status"); got != "installed" {
		t.Fatalf("wix_app_instance_status=%q settings=%+v", got, store.lastIntegrationInput.Settings)
	}
	if len(store.orders) != 0 || len(store.customers) != 0 || len(store.products) != 0 || store.processed != 1 {
		t.Fatalf("unexpected dispatch orders=%+v customers=%+v products=%+v processed=%d", store.orders, store.customers, store.products, store.processed)
	}
}

func TestWixStoresWebhookIgnoresDataEventWhenIntegrationNeedsAuth(t *testing.T) {
	secret := "wix_webhook_secret"
	body := []byte(`{
		"eventId":"evt_wix_needs_auth_order",
		"eventType":"wix.ecom.v1.order.created",
		"siteId":"site_123",
		"data":{"order":{"id":"order_123","status":"APPROVED","buyerInfo":{"email":"buyer@example.com"},"priceSummary":{"total":{"amount":"42.00","currency":"USD"}}}}
	}`)
	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		TenantID: "tenant-1",
		Provider: ProviderWixStores,
		Status:   "needs_auth",
		Settings: map[string]any{
			"site_id":        "site_123",
			"credential_ref": "cred_wix",
		},
	}}
	deps := &Deps{
		Repo:                 store,
		WixStoresCredentials: &fakeWixStoresCredentialResolver{creds: WixStoresCredentials{WebhookSecret: secret}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/wix-stores/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wix-Webhook-Secret", secret)
	rec := httptest.NewRecorder()

	deps.WixStoresWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "integration_not_connected") {
		t.Fatalf("body=%s", rec.Body.String())
	}
	if len(store.orders) != 0 || len(store.customers) != 0 || len(store.products) != 0 {
		t.Fatalf("data webhook should be ignored orders=%+v customers=%+v products=%+v", store.orders, store.customers, store.products)
	}
	if store.processed != 1 {
		t.Fatalf("processed=%d", store.processed)
	}
}

func TestSquarespaceWebhookVerifiesSignatureAndFetchesOrder(t *testing.T) {
	secretHex := hex.EncodeToString([]byte("squarespace-webhook-secret"))
	body := []byte(`{
		"id":"evt_sq_123",
		"websiteId":"site_123",
		"subscriptionId":"sub_123",
		"topic":"order.create",
		"createdOn":"2026-06-18T12:00:00Z",
		"data":{"orderId":"order_123"}
	}`)
	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		TenantID: "tenant-1",
		Provider: ProviderSquarespace,
		Settings: map[string]any{
			"site_id":            "site_123",
			"credential_ref":     "cred_sq",
			"webhook_secret_ref": "cred_sq_webhook",
		},
	}}
	fetcher := &fakeSquarespaceRecordFetcher{order: OrderInput{
		SourceID:      "squarespace://order/order_123",
		CustomerEmail: "buyer@example.com",
		Status:        "paid",
		TotalCents:    4200,
		Currency:      "USD",
	}}
	deps := &Deps{
		Repo:                     store,
		SquarespaceCredentials:   &fakeSquarespaceCredentialResolver{creds: SquarespaceCredentials{WebhookSecret: secretHex}},
		SquarespaceRecordFetcher: fetcher,
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/squarespace/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Squarespace-Signature", signSquarespaceWebhookTest(secretHex, body))
	rec := httptest.NewRecorder()

	deps.SquarespaceWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastSquarespaceSiteID != "site_123" {
		t.Fatalf("site lookup = %q", store.lastSquarespaceSiteID)
	}
	if fetcher.orderID != "order_123" || fetcher.tenantID != "tenant-1" {
		t.Fatalf("fetcher order=%q tenant=%q", fetcher.orderID, fetcher.tenantID)
	}
	if len(store.orders) != 1 || store.orders[0].SourceID != "squarespace://order/order_123" {
		t.Fatalf("orders = %+v", store.orders)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestSquarespaceWebhookRejectsBadSignature(t *testing.T) {
	secretHex := hex.EncodeToString([]byte("squarespace-webhook-secret"))
	body := []byte(`{"id":"evt_sq_123","websiteId":"site_123","topic":"order.create","data":{"orderId":"order_123"}}`)
	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		TenantID: "tenant-1",
		Provider: ProviderSquarespace,
		Settings: map[string]any{"site_id": "site_123", "credential_ref": "cred_sq"},
	}}
	deps := &Deps{
		Repo:                   store,
		SquarespaceCredentials: &fakeSquarespaceCredentialResolver{creds: SquarespaceCredentials{WebhookSecret: secretHex}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/squarespace/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Squarespace-Signature", "bad")
	rec := httptest.NewRecorder()

	deps.SquarespaceWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.orders) != 0 || store.processed != 0 {
		t.Fatalf("webhook should not dispatch orders=%+v processed=%d", store.orders, store.processed)
	}
}

func TestSquarespaceWebhookUpsertsAndDeletesContacts(t *testing.T) {
	secretHex := hex.EncodeToString([]byte("squarespace-webhook-secret"))
	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		TenantID: "tenant-1",
		Provider: ProviderSquarespace,
		Settings: map[string]any{
			"site_id":            "site_123",
			"credential_ref":     "cred_sq",
			"webhook_secret_ref": "cred_sq_webhook",
		},
	}}
	deps := &Deps{
		Repo:                   store,
		SquarespaceCredentials: &fakeSquarespaceCredentialResolver{creds: SquarespaceCredentials{WebhookSecret: secretHex}},
	}
	createBody := []byte(`{
		"id":"evt_sq_contact_1",
		"websiteId":"site_123",
		"topic":"contact.update",
		"data":{"contact":{"contactId":"contact_123","firstName":"Ada","lastName":"Lovelace","primaryEmail":{"value":"ADA@example.com","acceptsMarketing":{"acceptsMarketing":true}}}}
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/squarespace/webhooks", strings.NewReader(string(createBody)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Squarespace-Signature", signSquarespaceWebhookTest(secretHex, createBody))
	rec := httptest.NewRecorder()

	deps.SquarespaceWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.customers) != 1 || store.customers[0].SourceID != "squarespace://contact/contact_123" || store.customers[0].Email != "ada@example.com" || !store.customers[0].AcceptsMarketing {
		t.Fatalf("customers = %+v", store.customers)
	}
	deleteBody := []byte(`{
		"id":"evt_sq_contact_2",
		"websiteId":"site_123",
		"topic":"contact.delete",
		"data":{"contactId":"contact_123","deletedOn":"2026-06-18T12:30:00Z"}
	}`)
	req = httptest.NewRequest(http.MethodPost, "/api/public/commerce/squarespace/webhooks", strings.NewReader(string(deleteBody)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Squarespace-Signature", signSquarespaceWebhookTest(secretHex, deleteBody))
	rec = httptest.NewRecorder()

	deps.SquarespaceWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.deletedCustomers) != 1 || store.deletedCustomers[0].SourceID != "squarespace://contact/contact_123" {
		t.Fatalf("deleted customers = %+v", store.deletedCustomers)
	}
}

func TestDispatchRazorpayWebhookRecordsRefundEvents(t *testing.T) {
	store := &fakeStore{}
	deps := &Deps{Repo: store}
	integration := &Integration{ID: "int_1", TenantID: "tenant-1", Provider: ProviderRazorpay}

	err := deps.dispatchRazorpayWebhook(context.Background(), integration, razorpayWebhookEvent{
		Event: "refund.processed",
		Payload: map[string]any{"refund": map[string]any{"entity": map[string]any{
			"id":              "rfnd_123",
			"amount":          json.Number("1200"),
			"currency":        "INR",
			"payment_id":      "pay_123",
			"status":          "processed",
			"speed_requested": "normal",
			"speed_processed": "normal",
			"created_at":      json.Number("1781784060"),
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(store.providerEvents) != 1 {
		t.Fatalf("provider events = %+v", store.providerEvents)
	}
	event := store.providerEvents[0]
	if event.EventType != "refund_processed" || event.SourceID != "razorpay://refund/rfnd_123" || event.ProviderEventID != "refund_processed:razorpay://refund/rfnd_123" {
		t.Fatalf("event = %+v", event)
	}
}

func TestDispatchAdobeCommerceWebhookRecordsCreditMemoEvents(t *testing.T) {
	store := &fakeStore{}
	deps := &Deps{Repo: store}
	integration := &Integration{ID: "int_1", TenantID: "tenant-1", Provider: ProviderAdobeCommerce}

	err := deps.dispatchAdobeCommerceWebhook(context.Background(), integration, adobeCommerceWebhookEvent{
		Topic: "sales_order_creditmemo_refund",
		Payload: map[string]any{"data": map[string]any{"creditmemo": map[string]any{
			"entity_id":           json.Number("66"),
			"increment_id":        "CM-66",
			"order_id":            json.Number("100"),
			"grand_total":         "12.00",
			"order_currency_code": "USD",
			"customer_email":      "BUYER@example.com",
			"created_at":          "2026-06-18T12:05:00Z",
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(store.providerEvents) != 1 {
		t.Fatalf("provider events = %+v", store.providerEvents)
	}
	event := store.providerEvents[0]
	if event.EventType != "refund_created" || event.SourceID != "adobe-commerce://creditmemo/66" || event.CustomerEmail != "buyer@example.com" {
		t.Fatalf("event = %+v", event)
	}
	if event.Metadata["refund_cents"] != 1200 {
		t.Fatalf("metadata = %+v", event.Metadata)
	}
}

func TestBigCommerceWebhookFetchesOrderAndUpserts(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:            "int_1",
		TenantID:      "tenant-1",
		Provider:      ProviderBigCommerce,
		ShopDomain:    "abc123",
		Settings:      map[string]any{"store_hash": "abc123"},
		WebhookSecret: "secret_bc",
	}}
	fetcher := &fakeBigCommerceRecordFetcher{order: OrderInput{
		SourceID:      "bigcommerce://order/149",
		CustomerEmail: "buyer@example.com",
		Status:        "paid",
		TotalCents:    12900,
		Currency:      "USD",
	}}
	deps := &Deps{Repo: store, BigCommerceRecordFetcher: fetcher}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/bigcommerce/webhooks", strings.NewReader(`{
		"producer":"stores/abc123",
		"scope":"store/order/updated",
		"data":{"type":"order","id":149},
		"hash":"hook_hash_1"
	}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(bigCommerceWebhookSecretHeader, "secret_bc")
	rec := httptest.NewRecorder()

	deps.BigCommerceWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastBigStoreHash != "abc123" || fetcher.orderID != "149" {
		t.Fatalf("lookup=%q fetcher order=%q", store.lastBigStoreHash, fetcher.orderID)
	}
	if len(store.orders) != 1 || store.orders[0].SourceID != "bigcommerce://order/149" {
		t.Fatalf("orders = %+v", store.orders)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestStripeWebhookVerifiesSignatureAndUpsertsCheckout(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	body := []byte(`{
		"id":"evt_123",
		"type":"checkout.session.completed",
		"account":"acct_123",
		"data":{"object":{
			"id":"cs_test_123",
			"customer":"cus_123",
			"customer_details":{"email":"BUYER@example.com","name":"Jane Doe"},
			"amount_subtotal":4000,
			"amount_total":4200,
			"currency":"usd",
			"payment_status":"paid",
			"status":"complete",
			"payment_intent":"pi_123",
			"created":1781784000
		}}
	}`)
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderStripe,
		ShopDomain: "acct_123",
		Settings: map[string]any{
			"account_id":         "acct_123",
			"credential_ref":     "cred_stripe",
			"webhook_secret_ref": "cred_stripe_webhook",
		},
	}}
	credentials := &fakeStripeCredentialResolver{creds: StripeCredentials{APIKey: "rk_test_123", WebhookSecret: "whsec_test_123"}}
	deps := &Deps{Repo: store, StripeCredentials: credentials, Now: func() time.Time { return now }}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/stripe/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Stripe-Signature", signStripeWebhookTest("whsec_test_123", now.Unix(), body))
	rec := httptest.NewRecorder()

	deps.StripeWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastStripeAccountID != "acct_123" {
		t.Fatalf("account lookup = %q", store.lastStripeAccountID)
	}
	if credentials.tenantID != "tenant-1" || credentials.integration.Provider != ProviderStripe {
		t.Fatalf("credential resolver tenant=%q integration=%+v", credentials.tenantID, credentials.integration)
	}
	if len(store.customers) != 1 || store.customers[0].SourceID != "stripe://customer/cus_123" || store.customers[0].Email != "buyer@example.com" {
		t.Fatalf("customers = %+v", store.customers)
	}
	if len(store.orders) != 1 || store.orders[0].SourceID != "stripe://checkout_session/cs_test_123" || store.orders[0].Status != "paid" || store.orders[0].TotalCents != 4200 {
		t.Fatalf("orders = %+v", store.orders)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestStripeWebhookRejectsBadSignature(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	body := []byte(`{"id":"evt_123","type":"customer.updated","account":"acct_123","data":{"object":{"id":"cus_123","email":"buyer@example.com"}}}`)
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderStripe,
		ShopDomain: "acct_123",
		Settings:   map[string]any{"account_id": "acct_123", "credential_ref": "cred_stripe"},
	}}
	deps := &Deps{
		Repo:              store,
		StripeCredentials: &fakeStripeCredentialResolver{creds: StripeCredentials{APIKey: "rk_test_123", WebhookSecret: "whsec_test_123"}},
		Now:               func() time.Time { return now },
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/stripe/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Stripe-Signature", signStripeWebhookTest("wrong", now.Unix(), body))
	rec := httptest.NewRecorder()

	deps.StripeWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.customers) != 0 || len(store.orders) != 0 || store.processed != 0 {
		t.Fatalf("unexpected side effects customers=%+v orders=%+v processed=%d", store.customers, store.orders, store.processed)
	}
}

func TestSquareWebhookVerifiesSignatureAndUpsertsPayment(t *testing.T) {
	notificationURL := "https://api.postwave.test/api/public/commerce/square/webhooks"
	body := []byte(`{
		"merchant_id":"MERCHANT123",
		"type":"payment.created",
		"event_id":"evt_square_123",
		"created_at":"2026-06-18T12:00:00Z",
		"data":{"type":"payment","id":"pay_123","object":{"payment":{
			"id":"pay_123",
			"amount_money":{"amount":4200,"currency":"USD"},
			"total_money":{"amount":4200,"currency":"USD"},
			"status":"COMPLETED",
			"buyer_email_address":"BUYER@example.com",
			"customer_id":"cust_123",
			"order_id":"ord_123",
			"location_id":"loc_123",
			"created_at":"2026-06-18T12:00:00Z"
		}}}
	}`)
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderSquare,
		ShopDomain: "MERCHANT123",
		Settings: map[string]any{
			"merchant_id":              "MERCHANT123",
			"credential_ref":           "cred_square",
			"webhook_signature_ref":    "cred_square_webhook",
			"webhook_notification_url": notificationURL,
		},
	}}
	credentials := &fakeSquareCredentialResolver{creds: SquareCredentials{AccessToken: "sq0atp_test", WebhookSignatureKey: "square_signature_key"}}
	deps := &Deps{Repo: store, SquareCredentials: credentials}
	req := httptest.NewRequest(http.MethodPost, notificationURL, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-square-hmacsha256-signature", signSquareWebhookTest("square_signature_key", notificationURL, body))
	rec := httptest.NewRecorder()

	deps.SquareWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastSquareMerchantID != "MERCHANT123" {
		t.Fatalf("merchant lookup = %q", store.lastSquareMerchantID)
	}
	if credentials.tenantID != "tenant-1" || credentials.integration.Provider != ProviderSquare {
		t.Fatalf("credential resolver tenant=%q integration=%+v", credentials.tenantID, credentials.integration)
	}
	if len(store.orders) != 1 || store.orders[0].SourceID != "square://payment/pay_123" || store.orders[0].Status != "paid" || store.orders[0].TotalCents != 4200 {
		t.Fatalf("orders = %+v", store.orders)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestSquareWebhookCatalogVersionRefreshesCatalogProducts(t *testing.T) {
	notificationURL := "https://api.postwave.test/api/public/commerce/square/webhooks"
	body := []byte(`{
		"merchant_id":"MERCHANT123",
		"type":"catalog.version.updated",
		"event_id":"evt_square_catalog_123",
		"created_at":"2026-06-18T12:00:00Z",
		"data":{"type":"catalog_version","id":"catver_123","object":{"catalog_version":{"updated_at":"2026-06-18T12:00:00Z"}}}
	}`)
	nextCursor := encodeSquareBackfillCursor(squareBackfillState{Object: "catalog_products", Cursor: "cursor-next"})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderSquare,
		ShopDomain: "MERCHANT123",
		Settings: map[string]any{
			"merchant_id":              "MERCHANT123",
			"credential_ref":           "cred_square",
			"webhook_signature_ref":    "cred_square_webhook",
			"webhook_notification_url": notificationURL,
		},
	}}
	backfiller := &fakeSquareBackfiller{req: SyncRequest{
		Products: []ProductInput{{
			SourceID: "square://product/item_123",
			Title:    "Catalog refresh product",
		}},
		ProductDeletions: []ProviderDeletion{{
			SourceID: "square://product/item_deleted",
			Provider: ProviderSquare,
			Topic:    "catalog.item.deleted",
		}},
		Cursor: nextCursor,
	}}
	deps := &Deps{
		Repo:              store,
		SquareBackfiller:  backfiller,
		SquareCredentials: &fakeSquareCredentialResolver{creds: SquareCredentials{AccessToken: "sq0atp_test", WebhookSignatureKey: "square_signature_key"}},
	}
	req := httptest.NewRequest(http.MethodPost, notificationURL, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-square-hmacsha256-signature", signSquareWebhookTest("square_signature_key", notificationURL, body))
	rec := httptest.NewRecorder()

	deps.SquareWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	startCursor := encodeSquareBackfillCursor(squareBackfillState{Object: "catalog_products"})
	if backfiller.tenantID != "tenant-1" || backfiller.cursor != startCursor || backfiller.integration.Provider != ProviderSquare {
		t.Fatalf("backfiller tenant=%q cursor=%q integration=%+v", backfiller.tenantID, backfiller.cursor, backfiller.integration)
	}
	if len(store.lastSyncRequests) != 1 || len(store.lastSyncRequest.Products) != 1 || len(store.lastSyncRequest.ProductDeletions) != 1 || store.lastSyncRequest.Cursor != nextCursor {
		t.Fatalf("sync requests=%+v last=%+v", store.lastSyncRequests, store.lastSyncRequest)
	}
	if store.lastSyncRequest.Products[0].SourceID != "square://product/item_123" {
		t.Fatalf("products=%+v", store.lastSyncRequest.Products)
	}
	if len(store.deletedProducts) != 1 || store.deletedProducts[0].SourceID != "square://product/item_deleted" {
		t.Fatalf("deleted products=%+v", store.deletedProducts)
	}
	if store.processed != 1 {
		t.Fatalf("processed = %d", store.processed)
	}
}

func TestSquareWebhookCatalogVersionStoresEmptyPageCursor(t *testing.T) {
	nextCursor := encodeSquareBackfillCursor(squareBackfillState{Object: "catalog_products", Cursor: "cursor-next"})
	store := &fakeStore{integration: &Integration{
		ID:       "int_1",
		TenantID: "tenant-1",
		Provider: ProviderSquare,
	}}
	backfiller := &fakeSquareBackfiller{req: SyncRequest{Cursor: nextCursor}}
	deps := &Deps{Repo: store, SquareBackfiller: backfiller}

	err := deps.dispatchSquareWebhook(context.Background(), store.integration, squareWebhookEvent{Type: "catalog.version.updated"})

	if err != nil {
		t.Fatal(err)
	}
	startCursor := encodeSquareBackfillCursor(squareBackfillState{Object: "catalog_products"})
	if backfiller.cursor != startCursor {
		t.Fatalf("cursor = %q", backfiller.cursor)
	}
	if len(store.lastSyncRequests) != 0 {
		t.Fatalf("unexpected sync requests=%+v", store.lastSyncRequests)
	}
	if store.lastSyncCursor != nextCursor || store.lastSyncErr != nil {
		t.Fatalf("sync cursor=%q err=%v", store.lastSyncCursor, store.lastSyncErr)
	}
}

func TestSquareWebhookRejectsBadSignature(t *testing.T) {
	notificationURL := "https://api.postwave.test/api/public/commerce/square/webhooks"
	body := []byte(`{"merchant_id":"MERCHANT123","type":"customer.updated","event_id":"evt_123","data":{"type":"customer","id":"cust_123","object":{"customer":{"id":"cust_123","email_address":"buyer@example.com"}}}}`)
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderSquare,
		ShopDomain: "MERCHANT123",
		Settings:   map[string]any{"merchant_id": "MERCHANT123", "credential_ref": "cred_square", "webhook_notification_url": notificationURL},
	}}
	deps := &Deps{
		Repo:              store,
		SquareCredentials: &fakeSquareCredentialResolver{creds: SquareCredentials{AccessToken: "sq0atp_test", WebhookSignatureKey: "square_signature_key"}},
	}
	req := httptest.NewRequest(http.MethodPost, notificationURL, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-square-hmacsha256-signature", signSquareWebhookTest("wrong_key", notificationURL, body))
	rec := httptest.NewRecorder()

	deps.SquareWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.customers) != 0 || len(store.orders) != 0 || store.processed != 0 {
		t.Fatalf("unexpected side effects customers=%+v orders=%+v processed=%d", store.customers, store.orders, store.processed)
	}
}

func TestDispatchSquareWebhookRecordsCustomerRefundAndDeletion(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderSquare,
		ShopDomain: "MERCHANT123",
	}}
	deps := &Deps{Repo: store}

	if err := deps.dispatchSquareWebhook(context.Background(), store.integration, squareWebhookEvent{
		Type: "customer.updated",
		Data: struct {
			Type   string         `json:"type"`
			ID     string         `json:"id"`
			Object map[string]any `json:"object"`
		}{Type: "customer", Object: map[string]any{"customer": map[string]any{
			"id":            "cust_123",
			"email_address": "BUYER@example.com",
			"given_name":    "Buyer",
		}}},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.customers) != 1 || store.customers[0].SourceID != "square://customer/cust_123" || store.customers[0].Email != "buyer@example.com" {
		t.Fatalf("customers = %+v", store.customers)
	}

	if err := deps.dispatchSquareWebhook(context.Background(), store.integration, squareWebhookEvent{
		Type: "refund.updated",
		Data: struct {
			Type   string         `json:"type"`
			ID     string         `json:"id"`
			Object map[string]any `json:"object"`
		}{Type: "refund", Object: map[string]any{"refund": map[string]any{
			"id":           "ref_123",
			"amount_money": map[string]any{"amount": json.Number("1200"), "currency": "USD"},
			"payment_id":   "pay_123",
			"order_id":     "ord_123",
			"status":       "COMPLETED",
		}}},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.providerEvents) != 1 || store.providerEvents[0].EventType != "refund_updated" || store.providerEvents[0].SourceID != "square://refund/ref_123" {
		t.Fatalf("provider events = %+v", store.providerEvents)
	}

	if err := deps.dispatchSquareWebhook(context.Background(), store.integration, squareWebhookEvent{
		Type: "customer.deleted",
		Data: struct {
			Type   string         `json:"type"`
			ID     string         `json:"id"`
			Object map[string]any `json:"object"`
		}{Type: "customer", ID: "cust_123", Object: map[string]any{"customer": map[string]any{"id": "cust_123"}}},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.deletedCustomers) != 1 || store.deletedCustomers[0].SourceID != "square://customer/cust_123" || store.deletedCustomers[0].Topic != "customer.deleted" {
		t.Fatalf("deleted customers = %+v", store.deletedCustomers)
	}
}

func TestDispatchStripeWebhookRecordsInvoiceRefundSubscriptionAndDeletion(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderStripe,
		ShopDomain: "acct_123",
	}}
	deps := &Deps{Repo: store}

	if err := deps.dispatchStripeWebhook(context.Background(), store.integration, stripeWebhookEvent{
		Type: "invoice.payment_failed",
		Data: struct {
			Object map[string]any `json:"object"`
		}{Object: map[string]any{
			"id":             "in_123",
			"customer":       "cus_123",
			"customer_email": "buyer@example.com",
			"amount_due":     json.Number("4200"),
			"total":          json.Number("4200"),
			"currency":       "usd",
			"status":         "open",
			"created":        json.Number("1781784000"),
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.orders) != 1 || store.orders[0].SourceID != "stripe://invoice/in_123" || store.orders[0].Status != "pending" {
		t.Fatalf("invoice orders = %+v", store.orders)
	}
	if len(store.providerEvents) != 1 || store.providerEvents[0].EventType != "invoice_payment_failed" || store.providerEvents[0].SourceID != "stripe://invoice/in_123" {
		t.Fatalf("invoice events = %+v", store.providerEvents)
	}

	if err := deps.dispatchStripeWebhook(context.Background(), store.integration, stripeWebhookEvent{
		Type: "refund.updated",
		Data: struct {
			Object map[string]any `json:"object"`
		}{Object: map[string]any{
			"id":             "re_123",
			"amount":         json.Number("1200"),
			"currency":       "usd",
			"status":         "succeeded",
			"payment_intent": "pi_123",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.providerEvents) != 2 || store.providerEvents[1].EventType != "refund_updated" || store.providerEvents[1].SourceID != "stripe://refund/re_123" {
		t.Fatalf("refund events = %+v", store.providerEvents)
	}

	if err := deps.dispatchStripeWebhook(context.Background(), store.integration, stripeWebhookEvent{
		Type: "customer.subscription.deleted",
		Data: struct {
			Object map[string]any `json:"object"`
		}{Object: map[string]any{
			"id":             "sub_123",
			"customer":       "cus_123",
			"status":         "canceled",
			"latest_invoice": "in_123",
			"currency":       "usd",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.providerEvents) != 3 || store.providerEvents[2].EventType != "subscription_deleted" || store.providerEvents[2].SourceID != "stripe://subscription/sub_123" {
		t.Fatalf("subscription events = %+v", store.providerEvents)
	}

	if err := deps.dispatchStripeWebhook(context.Background(), store.integration, stripeWebhookEvent{
		Type: "charge.succeeded",
		Data: struct {
			Object map[string]any `json:"object"`
		}{Object: map[string]any{
			"id":                  "ch_123",
			"amount":              json.Number("4200"),
			"currency":            "usd",
			"customer":            "cus_123",
			"payment_intent":      "pi_123",
			"payment_method":      "pm_123",
			"balance_transaction": "txn_123",
			"receipt_url":         "https://pay.stripe.com/receipts/ch_123",
			"status":              "succeeded",
			"paid":                true,
			"captured":            true,
			"billing_details": map[string]any{
				"email": "buyer@example.com",
				"name":  "Buyer Example",
			},
			"payment_method_details": map[string]any{
				"type": "card",
				"card": map[string]any{"brand": "visa", "last4": "4242"},
			},
			"outcome": map[string]any{"risk_level": "normal"},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.providerEvents) != 4 || store.providerEvents[3].EventType != "transaction_created" || store.providerEvents[3].SourceID != "stripe://charge/ch_123" {
		t.Fatalf("charge events = %+v", store.providerEvents)
	}
	if store.providerEvents[3].CustomerEmail != "buyer@example.com" || store.providerEvents[3].Metadata["payment_intent"] != "pi_123" {
		t.Fatalf("charge event metadata = %+v", store.providerEvents[3])
	}

	if err := deps.dispatchStripeWebhook(context.Background(), store.integration, stripeWebhookEvent{
		Type: "charge.dispute.created",
		Data: struct {
			Object map[string]any `json:"object"`
		}{Object: map[string]any{
			"id":             "dp_123",
			"amount":         json.Number("4200"),
			"currency":       "usd",
			"status":         "needs_response",
			"reason":         "fraudulent",
			"charge":         "ch_123",
			"payment_intent": "pi_123",
			"balance_transactions": []any{
				map[string]any{"id": "txn_dispute"},
			},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.providerEvents) != 5 || store.providerEvents[4].EventType != "dispute_created" || store.providerEvents[4].SourceID != "stripe://dispute/dp_123" {
		t.Fatalf("dispute events = %+v", store.providerEvents)
	}
	if store.providerEvents[4].Metadata["charge_source_id"] != "stripe://charge/ch_123" || store.providerEvents[4].Metadata["dispute_amount_cents"] != 4200 {
		t.Fatalf("dispute event metadata = %+v", store.providerEvents[4].Metadata)
	}

	if err := deps.dispatchStripeWebhook(context.Background(), store.integration, stripeWebhookEvent{
		Type: "credit_note.voided",
		Data: struct {
			Object map[string]any `json:"object"`
		}{Object: map[string]any{
			"id":       "cn_123",
			"amount":   json.Number("900"),
			"total":    json.Number("900"),
			"currency": "usd",
			"status":   "void",
			"invoice":  "in_123",
			"customer": "cus_123",
			"refund":   "re_123",
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.providerEvents) != 6 || store.providerEvents[5].EventType != "credit_note_voided" || store.providerEvents[5].SourceID != "stripe://credit_note/cn_123" {
		t.Fatalf("credit note events = %+v", store.providerEvents)
	}
	if store.providerEvents[5].Metadata["invoice_source_id"] != "stripe://invoice/in_123" || store.providerEvents[5].Metadata["credit_note_amount_cents"] != 900 {
		t.Fatalf("credit note event metadata = %+v", store.providerEvents[5].Metadata)
	}

	if err := deps.dispatchStripeWebhook(context.Background(), store.integration, stripeWebhookEvent{
		Type: "customer.deleted",
		Data: struct {
			Object map[string]any `json:"object"`
		}{Object: map[string]any{"id": "cus_123"}},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.deletedCustomers) != 1 || store.deletedCustomers[0].SourceID != "stripe://customer/cus_123" || store.deletedCustomers[0].Topic != "customer.deleted" {
		t.Fatalf("deleted customers = %+v", store.deletedCustomers)
	}
}

func TestDispatchBigCommerceWebhookHandlesLifecycleDeletesAndInventory(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:            "int_1",
		TenantID:      "tenant-1",
		Provider:      ProviderBigCommerce,
		ShopDomain:    "abc123",
		Settings:      map[string]any{"store_hash": "abc123"},
		WebhookSecret: "secret_bc",
	}}
	fetcher := &fakeBigCommerceRecordFetcher{product: ProductInput{
		SourceID: "bigcommerce://product/77",
		Title:    "Inventory-sensitive hoodie",
	}}
	deps := &Deps{Repo: store, BigCommerceRecordFetcher: fetcher}

	if err := deps.dispatchBigCommerceWebhook(context.Background(), store.integration, bigCommerceWebhookPayload{
		Scope: "store/product/inventory/updated",
		Data:  map[string]any{"type": "product", "id": 77},
	}); err != nil {
		t.Fatal(err)
	}
	if fetcher.productID != "77" || len(store.products) != 1 || store.products[0].SourceID != "bigcommerce://product/77" {
		t.Fatalf("inventory update fetcher=%q products=%+v", fetcher.productID, store.products)
	}

	if err := deps.dispatchBigCommerceWebhook(context.Background(), store.integration, bigCommerceWebhookPayload{
		Scope: "store/customer/deleted",
		Data:  map[string]any{"type": "customer", "id": 42},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.deletedCustomers) != 1 ||
		store.deletedCustomers[0].SourceID != "bigcommerce://customer/42" ||
		store.deletedCustomers[0].Topic != "store/customer/deleted" {
		t.Fatalf("deleted customers = %+v", store.deletedCustomers)
	}

	if err := deps.dispatchBigCommerceWebhook(context.Background(), store.integration, bigCommerceWebhookPayload{
		Scope: "store/product/deleted",
		Data:  map[string]any{"type": "product", "id": 77},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.deletedProducts) != 1 ||
		store.deletedProducts[0].SourceID != "bigcommerce://product/77" ||
		store.deletedProducts[0].Topic != "store/product/deleted" {
		t.Fatalf("deleted products = %+v", store.deletedProducts)
	}

	if err := deps.dispatchBigCommerceWebhook(context.Background(), store.integration, bigCommerceWebhookPayload{
		Scope: "store/order/archived",
		Data:  map[string]any{"type": "order", "id": 149},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.deletedOrders) != 1 ||
		store.deletedOrders[0].SourceID != "bigcommerce://order/149" ||
		store.deletedOrders[0].Topic != "store/order/archived" {
		t.Fatalf("deleted orders = %+v", store.deletedOrders)
	}
}

func TestDispatchBigCommerceWebhookRecordsRefundAndTransactionEvents(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:            "int_1",
		TenantID:      "tenant-1",
		Provider:      ProviderBigCommerce,
		ShopDomain:    "abc123",
		Settings:      map[string]any{"store_hash": "abc123"},
		WebhookSecret: "secret_bc",
	}}
	fetcher := &fakeBigCommerceRecordFetcher{order: OrderInput{
		SourceID: "bigcommerce://order/250",
		Status:   "refunded",
	}}
	deps := &Deps{Repo: store, BigCommerceRecordFetcher: fetcher}

	if err := deps.dispatchBigCommerceWebhook(context.Background(), store.integration, bigCommerceWebhookPayload{
		Scope: "store/order/refund/created",
		Hash:  "refund_hash",
		Data: map[string]any{
			"type":   "order",
			"id":     250,
			"refund": map[string]any{"refund_id": 3},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if fetcher.orderID != "250" || len(store.orders) != 1 || store.orders[0].SourceID != "bigcommerce://order/250" {
		t.Fatalf("refund order refresh fetcher=%q orders=%+v", fetcher.orderID, store.orders)
	}
	if len(store.providerEvents) != 1 {
		t.Fatalf("provider events = %+v", store.providerEvents)
	}
	refund := store.providerEvents[0]
	if refund.EventType != "refund_created" ||
		refund.Topic != "store/order/refund/created" ||
		refund.SourceID != "bigcommerce://refund/3" ||
		refund.ProviderEventID != "refund_created:bigcommerce://refund/3" {
		t.Fatalf("refund event = %+v", refund)
	}
	if refund.Metadata["order_source_id"] != "bigcommerce://order/250" || refund.Metadata["refund_id"] != "3" {
		t.Fatalf("refund metadata = %+v", refund.Metadata)
	}

	if err := deps.dispatchBigCommerceWebhook(context.Background(), store.integration, bigCommerceWebhookPayload{
		Scope: "store/order/transaction/created",
		Hash:  "transaction_hash",
		Data: map[string]any{
			"type":                    "transaction",
			"order_id":                "250",
			"transaction_id":          "176342342",
			"transaction_status":      "complete",
			"transaction_type":        "capture",
			"platform_transaction_id": "964899682",
			"provider_transaction_id": "CK65FBPKR472P4V5",
			"result":                  map[string]any{"code": "captured", "type": "success"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.orders) != 2 || len(store.providerEvents) != 2 {
		t.Fatalf("orders=%+v provider events=%+v", store.orders, store.providerEvents)
	}
	transaction := store.providerEvents[1]
	if transaction.EventType != "transaction_created" ||
		transaction.Topic != "store/order/transaction/created" ||
		transaction.SourceID != "bigcommerce://transaction/176342342" ||
		transaction.ProviderEventID != "transaction_created:bigcommerce://transaction/176342342" {
		t.Fatalf("transaction event = %+v", transaction)
	}
	if transaction.Metadata["order_source_id"] != "bigcommerce://order/250" ||
		transaction.Metadata["transaction_status"] != "complete" ||
		transaction.Metadata["transaction_type"] != "capture" {
		t.Fatalf("transaction metadata = %+v", transaction.Metadata)
	}
}

func TestBigCommerceWebhookRejectsBadSecret(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:            "int_1",
		TenantID:      "tenant-1",
		Provider:      ProviderBigCommerce,
		ShopDomain:    "abc123",
		Settings:      map[string]any{"store_hash": "abc123"},
		WebhookSecret: "secret_bc",
	}}
	deps := &Deps{Repo: store, BigCommerceRecordFetcher: &fakeBigCommerceRecordFetcher{}}
	req := httptest.NewRequest(http.MethodPost, "/api/public/commerce/bigcommerce/webhooks", strings.NewReader(`{
		"producer":"stores/abc123",
		"scope":"store/order/updated",
		"data":{"type":"order","id":149}
	}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(bigCommerceWebhookSecretHeader, "wrong")
	rec := httptest.NewRecorder()

	deps.BigCommerceWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.orders) != 0 || store.processed != 0 {
		t.Fatalf("unexpected side effects orders=%+v processed=%d", store.orders, store.processed)
	}
}

func TestSyncIntegrationRunsShopifyBulkBackfill(t *testing.T) {
	startCursor := encodeShopifyBackfillCursor(shopifyBackfillState{Object: "customers"})
	productsCursor := encodeShopifyBackfillCursor(shopifyBackfillState{Object: "products"})
	store := &fakeStore{integration: &Integration{
		ID:          "int_1",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "shpat_123",
		SyncCursor:  startCursor,
	}}
	backfiller := &sequenceShopifyBackfiller{pages: []SyncRequest{
		{
			Customers: []CustomerInput{{SourceID: "gid://shopify/Customer/1", Email: "buyer@example.com"}},
			Cursor:    productsCursor,
		},
		{
			Products: []ProductInput{{SourceID: "gid://shopify/Product/1", Title: "Desk lamp", PriceCents: 2500, Currency: "USD"}},
			Cursor:   shopifyBackfillCursorComplete,
		},
	}}
	deps := &Deps{
		Repo:              store,
		ShopifyBackfiller: backfiller,
		Now:               func() time.Time { return time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC) },
	}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill?mode=bulk&pages=5", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out ShopifyBulkBackfillSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Pages != 2 || !out.Complete || out.Cursor != shopifyBackfillCursorComplete {
		t.Fatalf("summary = %+v", out)
	}
	if out.CustomersUpserted != 1 || out.ProductsUpserted != 1 || out.OrdersUpserted != 0 {
		t.Fatalf("summary counts = %+v", out)
	}
	if len(store.lastSyncRequests) != 2 {
		t.Fatalf("sync request count = %d", len(store.lastSyncRequests))
	}
	if len(backfiller.cursors) != 2 || backfiller.cursors[0] != startCursor || backfiller.cursors[1] != productsCursor {
		t.Fatalf("backfill cursors = %+v", backfiller.cursors)
	}
}

func TestSyncIntegrationBulkBackfillRecordsFailureCursor(t *testing.T) {
	startCursor := encodeShopifyBackfillCursor(shopifyBackfillState{Object: "customers"})
	providerErr := errors.New("shopify unavailable")
	store := &fakeStore{integration: &Integration{
		ID:          "int_1",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "shpat_123",
		SyncCursor:  startCursor,
	}}
	backfiller := &sequenceShopifyBackfiller{err: providerErr}
	deps := &Deps{
		Repo:              store,
		ShopifyBackfiller: backfiller,
		Now:               func() time.Time { return time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC) },
	}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill?mode=bulk", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastSyncCursor != startCursor || !errors.Is(store.lastSyncErr, providerErr) {
		t.Fatalf("stored sync state cursor=%q err=%v", store.lastSyncCursor, store.lastSyncErr)
	}
	if len(store.lastSyncRequests) != 0 {
		t.Fatalf("unexpected sync calls: %+v", store.lastSyncRequests)
	}
}

func TestSyncIntegrationStartsShopifyAsyncBulkBackfill(t *testing.T) {
	store := &fakeStore{integration: &Integration{
		ID:          "int_1",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "shpat_123",
		SyncCursor:  encodeShopifyBackfillCursor(shopifyBackfillState{Object: "customers"}),
	}}
	operator := &fakeShopifyBulkOperator{}
	deps := &Deps{
		Repo:                store,
		ShopifyBulkOperator: operator,
		Now:                 func() time.Time { return time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC) },
	}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill?mode=bulk_async&object=orders", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out ShopifyAsyncBulkBackfillSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "CREATED" || out.OperationID != "gid://shopify/BulkOperation/100" {
		t.Fatalf("summary = %+v", out)
	}
	if operator.startedObject != "orders" || operator.startedIntegration.AccessToken != "shpat_123" {
		t.Fatalf("operator input object=%q integration=%+v", operator.startedObject, operator.startedIntegration)
	}
	state, ok, err := decodeShopifyBulkOperationCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("stored cursor %q err=%v ok=%v", store.lastSyncCursor, err, ok)
	}
	if state.Object != "orders" || state.OperationID != out.OperationID {
		t.Fatalf("stored cursor state = %+v", state)
	}
	if !store.lastSyncAt.Equal(time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)) || store.lastSyncErr != nil {
		t.Fatalf("stored sync at=%s err=%v", store.lastSyncAt, store.lastSyncErr)
	}
}

func TestSyncIntegrationPollsShopifyAsyncBulkBackfill(t *testing.T) {
	cursor := encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{Object: "products", OperationID: "gid://shopify/BulkOperation/200"})
	store := &fakeStore{integration: &Integration{
		ID:          "int_1",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "shpat_123",
		SyncCursor:  cursor,
	}}
	operator := &fakeShopifyBulkOperator{pollSummary: ShopifyAsyncBulkBackfillSummary{
		IntegrationID: "int_1",
		OperationID:   "gid://shopify/BulkOperation/200",
		Object:        "products",
		Status:        "RUNNING",
		ObjectCount:   "57",
	}}
	deps := &Deps{
		Repo:                store,
		ShopifyBulkOperator: operator,
		Now:                 func() time.Time { return time.Date(2026, 6, 18, 12, 5, 0, 0, time.UTC) },
	}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill?mode=async_bulk", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out ShopifyAsyncBulkBackfillSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "RUNNING" || out.ResultURLPresent || out.ObjectCount != "57" {
		t.Fatalf("summary = %+v", out)
	}
	if operator.polledOperationID != "gid://shopify/BulkOperation/200" || operator.polledObject != "products" {
		t.Fatalf("poll input id=%q object=%q", operator.polledOperationID, operator.polledObject)
	}
	if store.lastSyncCursor != cursor || store.lastSyncErr != nil {
		t.Fatalf("stored cursor=%q err=%v", store.lastSyncCursor, store.lastSyncErr)
	}
}

func TestSyncIntegrationAdvancesCompletedShopifyAsyncBulkWithoutResultURL(t *testing.T) {
	cursor := encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{Object: "customers", OperationID: "gid://shopify/BulkOperation/205"})
	store := &fakeStore{integration: &Integration{
		ID:          "int_1",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "shpat_123",
		SyncCursor:  cursor,
	}}
	operator := &fakeShopifyBulkOperator{pollSummary: ShopifyAsyncBulkBackfillSummary{
		IntegrationID: "int_1",
		OperationID:   "gid://shopify/BulkOperation/205",
		Object:        "customers",
		Status:        "COMPLETED",
	}}
	deps := &Deps{
		Repo:                store,
		ShopifyBulkOperator: operator,
		Now:                 func() time.Time { return time.Date(2026, 6, 18, 12, 6, 0, 0, time.UTC) },
	}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill?mode=bulk_async", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out ShopifyAsyncBulkBackfillSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "COMPLETED" || out.ResultURLPresent || out.Cursor == cursor {
		t.Fatalf("summary = %+v", out)
	}
	state, err := decodeShopifyBackfillCursor(out.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "products" || store.lastSyncCursor != out.Cursor {
		t.Fatalf("state=%+v stored=%q", state, store.lastSyncCursor)
	}
}

func TestSyncIntegrationImportsCompletedShopifyAsyncBulkResult(t *testing.T) {
	cursor := encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{Object: "products", OperationID: "gid://shopify/BulkOperation/210"})
	store := &fakeStore{integration: &Integration{
		ID:          "int_1",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "shpat_123",
		SyncCursor:  cursor,
	}}
	operator := &fakeShopifyBulkOperator{pollSummary: ShopifyAsyncBulkBackfillSummary{
		IntegrationID:    "int_1",
		OperationID:      "gid://shopify/BulkOperation/210",
		Object:           "products",
		Status:           "COMPLETED",
		ResultURLPresent: true,
		ResultURL:        "https://storage.googleapis.com/shopify/result.jsonl",
	}}
	importer := &fakeShopifyBulkImporter{req: SyncRequest{
		Products: []ProductInput{{SourceID: "gid://shopify/Product/1", Title: "Desk lamp", PriceCents: 2500, Currency: "USD"}},
	}}
	deps := &Deps{
		Repo:                store,
		ShopifyBulkOperator: operator,
		ShopifyBulkImporter: importer,
		Now:                 func() time.Time { return time.Date(2026, 6, 18, 12, 7, 0, 0, time.UTC) },
	}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill?mode=bulk_async", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out ShopifyAsyncBulkBackfillSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.Imported || out.ProductsUpserted != 1 || out.Cursor == cursor {
		t.Fatalf("summary = %+v", out)
	}
	if importer.object != "products" || importer.resultURL != "https://storage.googleapis.com/shopify/result.jsonl" {
		t.Fatalf("importer object=%q url=%q", importer.object, importer.resultURL)
	}
	if len(store.lastSyncRequest.Products) != 1 {
		t.Fatalf("sync request = %+v", store.lastSyncRequest)
	}
	state, err := decodeShopifyBackfillCursor(store.lastSyncRequest.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "orders" {
		t.Fatalf("next cursor state = %+v", state)
	}
}

func TestSyncIntegrationRecordsShopifyAsyncBulkFailure(t *testing.T) {
	cursor := encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{Object: "orders", OperationID: "gid://shopify/BulkOperation/300"})
	store := &fakeStore{integration: &Integration{
		ID:          "int_1",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "shpat_123",
		SyncCursor:  cursor,
	}}
	operator := &fakeShopifyBulkOperator{pollSummary: ShopifyAsyncBulkBackfillSummary{
		IntegrationID: "int_1",
		OperationID:   "gid://shopify/BulkOperation/300",
		Object:        "orders",
		Status:        "FAILED",
		ErrorCode:     "TIMEOUT",
	}}
	deps := &Deps{Repo: store, ShopifyBulkOperator: operator}
	req := commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/backfill?mode=bulk_async", "int_1", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	deps.SyncIntegration(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	state, ok, err := decodeShopifyBulkOperationCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("stored cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if state.Attempts != 1 || state.NextAttemptAt == "" || !strings.Contains(state.LastError, "TIMEOUT") {
		t.Fatalf("stored retry state=%+v err=%v", state, store.lastSyncErr)
	}
	if store.lastSyncErr == nil || !strings.Contains(store.lastSyncErr.Error(), "TIMEOUT") {
		t.Fatalf("stored cursor=%q err=%v", store.lastSyncCursor, store.lastSyncErr)
	}
}

func TestDispatchShopifyBulkOperationFinishWebhookImportsResult(t *testing.T) {
	cursor := encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{Object: "orders", OperationID: "gid://shopify/BulkOperation/400"})
	store := &fakeStore{integration: &Integration{
		ID:          "int_1",
		TenantID:    "tenant-1",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "shpat_123",
		SyncCursor:  cursor,
	}}
	operator := &fakeShopifyBulkOperator{pollSummary: ShopifyAsyncBulkBackfillSummary{
		IntegrationID:    "int_1",
		OperationID:      "gid://shopify/BulkOperation/400",
		Object:           "orders",
		Status:           "COMPLETED",
		ResultURLPresent: true,
		ResultURL:        "https://storage.googleapis.com/shopify/orders.jsonl",
	}}
	importer := &fakeShopifyBulkImporter{req: SyncRequest{
		Orders: []OrderInput{{SourceID: "gid://shopify/Order/1", CustomerEmail: "buyer@example.com", TotalCents: 5500, Currency: "USD"}},
	}}
	deps := &Deps{
		Repo:                store,
		ShopifyBulkOperator: operator,
		ShopifyBulkImporter: importer,
		Now:                 func() time.Time { return time.Date(2026, 6, 18, 12, 10, 0, 0, time.UTC) },
	}
	body := []byte(`{"admin_graphql_api_id":"gid://shopify/BulkOperation/400","status":"completed","type":"query"}`)

	if err := deps.dispatchShopifyWebhook(context.Background(), store.integration, "bulk_operations/finish", body); err != nil {
		t.Fatal(err)
	}
	if operator.polledOperationID != "gid://shopify/BulkOperation/400" || operator.polledObject != "orders" {
		t.Fatalf("poll input id=%q object=%q", operator.polledOperationID, operator.polledObject)
	}
	if importer.resultURL != "https://storage.googleapis.com/shopify/orders.jsonl" || importer.object != "orders" {
		t.Fatalf("importer object=%q url=%q", importer.object, importer.resultURL)
	}
	if len(store.lastSyncRequest.Orders) != 1 {
		t.Fatalf("sync request = %+v", store.lastSyncRequest)
	}
	if store.lastSyncRequest.Cursor != shopifyBackfillCursorComplete {
		t.Fatalf("cursor = %q", store.lastSyncRequest.Cursor)
	}
}

func TestDispatchShopifyBulkOperationFinishWebhookRecordsFailure(t *testing.T) {
	cursor := encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{Object: "orders", OperationID: "gid://shopify/BulkOperation/401"})
	store := &fakeStore{integration: &Integration{
		ID:         "int_1",
		TenantID:   "tenant-1",
		Provider:   ProviderShopify,
		SyncCursor: cursor,
	}}
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 18, 12, 10, 0, 0, time.UTC) },
	}
	body := []byte(`{"admin_graphql_api_id":"gid://shopify/BulkOperation/401","status":"failed","error_code":"TIMEOUT","type":"query"}`)

	if err := deps.dispatchShopifyWebhook(context.Background(), store.integration, "bulk_operations/finish", body); err != nil {
		t.Fatal(err)
	}
	state, ok, err := decodeShopifyBulkOperationCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("stored cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if state.Attempts != 1 || state.NextAttemptAt == "" || !strings.Contains(state.LastError, "TIMEOUT") {
		t.Fatalf("stored retry state=%+v err=%v", state, store.lastSyncErr)
	}
	if store.lastSyncErr == nil || !strings.Contains(store.lastSyncErr.Error(), "TIMEOUT") {
		t.Fatalf("stored cursor=%q err=%v", store.lastSyncCursor, store.lastSyncErr)
	}
}

func TestSyncRequestHasPayload(t *testing.T) {
	if syncRequestHasPayload(SyncRequest{}) {
		t.Fatal("empty sync request must not be treated as a provider pull")
	}
	if !syncRequestHasPayload(SyncRequest{Customers: []CustomerInput{{SourceID: "customer_1", Email: "buyer@example.com"}}}) {
		t.Fatal("customers payload should be accepted")
	}
	if !syncRequestHasPayload(SyncRequest{Products: []ProductInput{{SourceID: "product_1", Title: "Desk lamp"}}}) {
		t.Fatal("products payload should be accepted")
	}
	if !syncRequestHasPayload(SyncRequest{ProductDeletions: []ProviderDeletion{{SourceID: "product_1"}}}) {
		t.Fatal("product deletion payload should be accepted")
	}
	if !syncRequestHasPayload(SyncRequest{Orders: []OrderInput{{SourceID: "order_1", CustomerEmail: "buyer@example.com"}}}) {
		t.Fatal("orders payload should be accepted")
	}
	if !syncRequestHasPayload(SyncRequest{ProviderEvents: []ProviderEventInput{{EventType: "subscription_updated", SourceID: "woocommerce://subscription/1"}}}) {
		t.Fatal("provider event payload should be accepted")
	}
}

func TestCreateCatalogRequiresName(t *testing.T) {
	deps := &Deps{Repo: &fakeStore{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/catalogs", strings.NewReader(`{"source_type":"manual"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateCatalog(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "catalog name is required") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestCreateProductFeedRejectsInvalidMaxItems(t *testing.T) {
	deps := &Deps{Repo: &fakeStore{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/catalogs/cat_1/feeds", strings.NewReader(`{"name":"Featured","max_items":51}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateProductFeed(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "max_items") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestImportCatalogProductsRequiresProducts(t *testing.T) {
	deps := &Deps{Repo: &fakeStore{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/catalogs/cat_1/import", strings.NewReader(`{"products":[]}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.ImportCatalogProducts(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "products is required") {
		t.Fatalf("body = %s, want products validation", rec.Body.String())
	}
}

func TestResolveProductFeedRejectsInvalidMaxItems(t *testing.T) {
	deps := &Deps{Repo: &fakeStore{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/catalogs/cat_1/feeds/feed_1/resolve", strings.NewReader(`{"max_items":51}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.ResolveProductFeed(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "max_items") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestCatalogImportProductInputCarriesVariants(t *testing.T) {
	product := catalogImportProductInput(CatalogProductImportProduct{
		SourceID:   "sku-parent",
		Title:      "Desk lamp",
		PriceCents: 2500,
		Variants: []map[string]any{{
			"id":                 "variant-1",
			"title":              "Black",
			"price":              "25.00",
			"inventory_quantity": 4,
			"inventory_policy":   "deny",
		}},
	}, "USD")

	variants := productVariantMaps(product)
	if len(variants) != 1 {
		t.Fatalf("variants = %d, want 1", len(variants))
	}
	if got := sourceID(variants[0]); got != "variant-1" {
		t.Fatalf("variant source id = %q", got)
	}
}

func TestUpsertCartRecoveryLinkRequiresRecoveryURL(t *testing.T) {
	deps := &Deps{Repo: &fakeStore{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations/int_1/cart-recovery-links", strings.NewReader(`{"source_cart_id":"cart_1"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.UpsertCartRecoveryLink(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "recovery_url") {
		t.Fatalf("body = %s, want recovery_url", rec.Body.String())
	}
}

func TestCommerceLifecycleWritesRejectDisconnectedIntegration(t *testing.T) {
	for _, tc := range []struct {
		name    string
		request *http.Request
		call    func(*Deps, http.ResponseWriter, *http.Request)
	}{
		{
			name:    "cart_recovery",
			request: commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/cart-recovery-links", "int_1", strings.NewReader(`{"source_cart_id":"cart_1","recovery_url":"https://example.test/cart"}`)),
			call:    (*Deps).UpsertCartRecoveryLink,
		},
		{
			name:    "back_in_stock",
			request: commerceReqWithIDAndProduct(http.MethodPost, "/api/v1/commerce/integrations/int_1/products/p_1/back-in-stock-subscriptions", "int_1", "p_1", strings.NewReader(`{"subscriber_email":"buyer@example.com"}`)),
			call:    (*Deps).CreateBackInStockSubscription,
		},
		{
			name:    "price_drop",
			request: commerceReqWithIDAndProduct(http.MethodPost, "/api/v1/commerce/integrations/int_1/products/p_1/price-drop-watchers", "int_1", "p_1", strings.NewReader(`{"subscriber_email":"buyer@example.com","target_price_cents":1000}`)),
			call:    (*Deps).CreatePriceDropWatcher,
		},
		{
			name:    "lifecycle_evaluate",
			request: commerceReqWithID(http.MethodPost, "/api/v1/commerce/integrations/int_1/lifecycle/evaluate", "int_1", nil),
			call:    (*Deps).EvaluateLifecycleTriggers,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{integration: &Integration{
				ID:       "int_1",
				Provider: ProviderBigCommerce,
				Status:   "disconnected",
			}}
			deps := &Deps{Repo: store}
			rec := httptest.NewRecorder()

			tc.call(deps, rec, tc.request)

			if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestCreateBackInStockSubscriptionRequiresSubscriber(t *testing.T) {
	deps := &Deps{Repo: &fakeStore{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations/int_1/products/p_1/back-in-stock-subscriptions", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreateBackInStockSubscription(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "subscriber_id or subscriber_email") {
		t.Fatalf("body = %s, want subscriber validation", rec.Body.String())
	}
}

func TestCreatePriceDropWatcherRequiresThreshold(t *testing.T) {
	deps := &Deps{Repo: &fakeStore{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/commerce/integrations/int_1/products/p_1/price-drop-watchers", strings.NewReader(`{"subscriber_email":"buyer@example.com"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.CreatePriceDropWatcher(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "target_price_cents or min_drop_percent") {
		t.Fatalf("body = %s, want threshold validation", rec.Body.String())
	}
}

func TestLifecycleReportReturnsSummary(t *testing.T) {
	deps := &Deps{Repo: &fakeStore{}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/commerce/integrations/int_1/lifecycle/report", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()

	deps.LifecycleReport(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "notified_pending") {
		t.Fatalf("body = %s, want lifecycle summary", rec.Body.String())
	}
}

func TestProductVariantMapsFallsBackToDefaultVariant(t *testing.T) {
	variants := productVariantMaps(ProductInput{
		SourceID:   "product-1",
		Title:      "Desk lamp",
		PriceCents: 1299,
	})
	if len(variants) != 1 {
		t.Fatalf("variants = %d, want 1", len(variants))
	}
	if got := sourceID(variants[0]); got != "product-1" {
		t.Fatalf("default variant source id = %q", got)
	}
}

func TestVariantAvailableHonorsInventoryPolicy(t *testing.T) {
	if !variantAvailable(nil, "unknown") {
		t.Fatal("unknown inventory should remain available until a quantity is known")
	}
	if !variantAvailable(0, "continue") {
		t.Fatal("continue policy should allow selling through zero inventory")
	}
	if variantAvailable(0, "deny") {
		t.Fatal("deny policy with zero inventory should be unavailable")
	}
	if !variantAvailable(2, "deny") {
		t.Fatal("deny policy with positive inventory should be available")
	}
}

func TestExchangeShopifyCodeRejectsLocalFallbackInProduction(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")

	deps := &Deps{}
	_, _, err := deps.exchangeShopifyCode(context.Background(), "demo.myshopify.com", "local-dev")
	if err == nil || !strings.Contains(err.Error(), "local Shopify OAuth is disabled in production") {
		t.Fatalf("exchangeShopifyCode error = %v, want production local fallback rejection", err)
	}
}
