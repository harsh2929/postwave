package commerce

import "time"

const (
	ProviderShopify       = "shopify"
	ProviderWooCommerce   = "woocommerce"
	ProviderBigCommerce   = "bigcommerce"
	ProviderAdobeCommerce = "adobe-commerce"
	ProviderStripe        = "stripe"
	ProviderSquare        = "square"
	ProviderPayPal        = "paypal"
	ProviderRazorpay      = "razorpay"
	ProviderWixStores     = "wix-stores"
	ProviderSquarespace   = "squarespace-commerce"
)

type Config struct {
	ShopifyClientID              string
	ShopifyClientSecret          string
	ShopifyScopes                []string
	ShopifyOAuthRedirectURL      string
	ShopifyStateSecret           string
	ShopifyWebhookSecret         string
	AllowUnsignedShopifyWebhooks bool
}

type Integration struct {
	ID            string                `json:"id"`
	TenantID      string                `json:"tenant_id,omitempty"`
	Provider      string                `json:"provider"`
	ShopDomain    string                `json:"shop_domain,omitempty"`
	Status        string                `json:"status"`
	Scopes        []string              `json:"scopes"`
	Settings      map[string]any        `json:"settings"`
	WebhookSecret string                `json:"-"`
	AccessToken   string                `json:"-"`
	SyncCursor    string                `json:"sync_cursor,omitempty"`
	SyncState     *IntegrationSyncState `json:"sync_state,omitempty"`
	LastSyncAt    *time.Time            `json:"last_sync_at,omitempty"`
	ErrorMessage  string                `json:"error_message,omitempty"`
	CreatedAt     time.Time             `json:"created_at"`
	UpdatedAt     time.Time             `json:"updated_at"`
}

type IntegrationSyncState struct {
	CursorKind       string `json:"cursor_kind"`
	Mode             string `json:"mode,omitempty"`
	Object           string `json:"object,omitempty"`
	OperationID      string `json:"operation_id,omitempty"`
	LineOffset       int64  `json:"line_offset,omitempty"`
	Attempts         int    `json:"attempts,omitempty"`
	NextAttemptAt    string `json:"next_attempt_at,omitempty"`
	LastStatus       string `json:"last_status,omitempty"`
	LastError        string `json:"last_error,omitempty"`
	RetryDue         bool   `json:"retry_due,omitempty"`
	RetryWaitSeconds int64  `json:"retry_wait_seconds,omitempty"`
	Complete         bool   `json:"complete,omitempty"`
}

type IntegrationInput struct {
	Provider      string         `json:"provider"`
	ShopDomain    string         `json:"shop_domain"`
	Status        string         `json:"status"`
	Scopes        []string       `json:"scopes"`
	Settings      map[string]any `json:"settings"`
	CredentialRef string         `json:"credential_ref,omitempty"`
	AccessToken   string         `json:"-"`
	WebhookSecret string         `json:"-"`
}

type DisconnectCleanupEvidence struct {
	Provider                string   `json:"provider"`
	Status                  string   `json:"status"`
	RecordedAt              string   `json:"recorded_at,omitempty"`
	PostwaveStatus          string   `json:"postwave_status"`
	ProviderCleanupPosture  string   `json:"provider_cleanup_posture"`
	ManagedProviderCleanup  bool     `json:"managed_provider_cleanup"`
	ProviderScopeType       string   `json:"provider_scope_type,omitempty"`
	ProviderScopeID         string   `json:"provider_scope_id,omitempty"`
	WebhookEndpoint         string   `json:"webhook_endpoint,omitempty"`
	WebhookIDs              []string `json:"webhook_ids,omitempty"`
	CredentialRefPresent    bool     `json:"credential_ref_present,omitempty"`
	WebhookSecretRefPresent bool     `json:"webhook_secret_ref_present,omitempty"`
	WebhookCleanupStatus    string   `json:"webhook_cleanup_status"`
	CredentialCleanupStatus string   `json:"credential_cleanup_status"`
	PostwaveEffects         []string `json:"postwave_effects,omitempty"`
	ProviderConsoleActions  []string `json:"provider_console_actions,omitempty"`
	ProviderCleanupEvidence []string `json:"provider_cleanup_evidence,omitempty"`
}

type DisconnectResponse struct {
	OK              bool                       `json:"ok"`
	ProviderCleanup *DisconnectCleanupEvidence `json:"provider_cleanup,omitempty"`
}

type ProviderDeletion struct {
	SourceID string         `json:"source_id"`
	Provider string         `json:"provider,omitempty"`
	Topic    string         `json:"topic,omitempty"`
	Raw      map[string]any `json:"raw,omitempty"`
}

type ProviderEventInput struct {
	EventType       string         `json:"event_type"`
	Provider        string         `json:"provider,omitempty"`
	Topic           string         `json:"topic,omitempty"`
	SourceID        string         `json:"source_id,omitempty"`
	ProviderEventID string         `json:"provider_event_id,omitempty"`
	CustomerEmail   string         `json:"customer_email,omitempty"`
	Metadata        map[string]any `json:"metadata,omitempty"`
}

type OAuthStartResponse struct {
	Provider     string   `json:"provider"`
	ShopDomain   string   `json:"shop_domain"`
	AuthorizeURL string   `json:"authorize_url"`
	State        string   `json:"state"`
	Scopes       []string `json:"scopes"`
	Local        bool     `json:"local"`
}

type OAuthCallbackResponse struct {
	Integration         *Integration                    `json:"integration"`
	Local               bool                            `json:"local"`
	WebhookRegistration *ShopifyWebhookReconcileSummary `json:"webhook_registration,omitempty"`
}

type ShopifyWebhookTopic struct {
	GraphQLTopic string `json:"graphql_topic"`
	HTTPTopic    string `json:"http_topic"`
}

type ShopifyWebhookRegistration struct {
	ID      string `json:"id,omitempty"`
	Topic   string `json:"topic"`
	URI     string `json:"uri"`
	Created bool   `json:"created"`
}

type ShopifyWebhookReconcileSummary struct {
	Endpoint      string                       `json:"endpoint"`
	RegisteredAt  time.Time                    `json:"registered_at"`
	Subscriptions []ShopifyWebhookRegistration `json:"subscriptions"`
}

type ShopifyWebhookCleanupSummary struct {
	Endpoint      string                       `json:"endpoint"`
	CleanedUpAt   time.Time                    `json:"cleaned_up_at"`
	Subscriptions []ShopifyWebhookRegistration `json:"subscriptions"`
}

type ShopifyCustomerRedaction struct {
	CustomerSourceIDs []string `json:"customer_source_ids,omitempty"`
	Emails            []string `json:"emails,omitempty"`
	OrderSourceIDs    []string `json:"order_source_ids,omitempty"`
	Reason            string   `json:"reason,omitempty"`
}

type ShopifyCustomerDataRequest struct {
	RequestID         string   `json:"request_id,omitempty"`
	CustomerSourceIDs []string `json:"customer_source_ids,omitempty"`
	Emails            []string `json:"emails,omitempty"`
	OrderSourceIDs    []string `json:"order_source_ids,omitempty"`
	Reason            string   `json:"reason,omitempty"`
}

type ShopifyCustomerDataRequestBundle struct {
	RequestID         string     `json:"request_id,omitempty"`
	IntegrationID     string     `json:"integration_id"`
	ShopDomain        string     `json:"shop_domain,omitempty"`
	CustomerSourceIDs []string   `json:"customer_source_ids,omitempty"`
	Emails            []string   `json:"emails,omitempty"`
	OrderSourceIDs    []string   `json:"order_source_ids,omitempty"`
	Customers         []Customer `json:"customers"`
	Orders            []Order    `json:"orders"`
	GeneratedAt       time.Time  `json:"generated_at"`
}

type SyncRequest struct {
	Customers        []CustomerInput      `json:"customers"`
	Products         []ProductInput       `json:"products"`
	ProductDeletions []ProviderDeletion   `json:"product_deletions,omitempty"`
	Orders           []OrderInput         `json:"orders"`
	ProviderEvents   []ProviderEventInput `json:"provider_events,omitempty"`
	Cursor           string               `json:"cursor"`
}

type SyncSummary struct {
	CustomersUpserted int    `json:"customers_upserted"`
	ProductsUpserted  int    `json:"products_upserted"`
	ProductsDeleted   int    `json:"products_deleted,omitempty"`
	OrdersUpserted    int    `json:"orders_upserted"`
	EventsRecorded    int    `json:"events_recorded,omitempty"`
	Cursor            string `json:"cursor,omitempty"`
}

type ShopifyBulkBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	CustomersUpserted int    `json:"customers_upserted"`
	ProductsUpserted  int    `json:"products_upserted"`
	OrdersUpserted    int    `json:"orders_upserted"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

type ShopifyAsyncBulkBackfillSummary struct {
	IntegrationID         string `json:"integration_id"`
	OperationID           string `json:"operation_id,omitempty"`
	Object                string `json:"object,omitempty"`
	Status                string `json:"status"`
	ErrorCode             string `json:"error_code,omitempty"`
	ObjectCount           string `json:"object_count,omitempty"`
	RootObjectCount       string `json:"root_object_count,omitempty"`
	FileSize              string `json:"file_size,omitempty"`
	CreatedAt             string `json:"created_at,omitempty"`
	CompletedAt           string `json:"completed_at,omitempty"`
	ResultURLPresent      bool   `json:"result_url_present,omitempty"`
	PartialDataURLPresent bool   `json:"partial_data_url_present,omitempty"`
	Imported              bool   `json:"imported,omitempty"`
	LinesProcessed        int64  `json:"lines_processed,omitempty"`
	BatchesImported       int    `json:"batches_imported,omitempty"`
	CustomersUpserted     int    `json:"customers_upserted,omitempty"`
	ProductsUpserted      int    `json:"products_upserted,omitempty"`
	OrdersUpserted        int    `json:"orders_upserted,omitempty"`
	Cursor                string `json:"cursor,omitempty"`
	Message               string `json:"message,omitempty"`
	ResultURL             string `json:"-"`
	PartialDataURL        string `json:"-"`
}

type ShopifyBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type ShopifyTokenRevocationEvidence struct {
	ExplicitRevokeEndpoint bool     `json:"explicit_revoke_endpoint"`
	ProviderMechanism      string   `json:"provider_mechanism"`
	PostwaveDisconnect     string   `json:"postwave_disconnect"`
	Docs                   []string `json:"docs"`
}

type PageInfo struct {
	Total   int `json:"total"`
	Page    int `json:"page"`
	PerPage int `json:"per_page"`
}

type CatalogInput struct {
	IntegrationID   string         `json:"integration_id"`
	Name            string         `json:"name"`
	SourceType      string         `json:"source_type"`
	FeedURL         string         `json:"feed_url"`
	Status          string         `json:"status"`
	Locale          string         `json:"locale"`
	DefaultCurrency string         `json:"default_currency"`
	Settings        map[string]any `json:"settings"`
}

type Catalog struct {
	ID              string         `json:"id"`
	TenantID        string         `json:"tenant_id,omitempty"`
	IntegrationID   string         `json:"integration_id,omitempty"`
	Name            string         `json:"name"`
	SourceType      string         `json:"source_type"`
	FeedURL         string         `json:"feed_url,omitempty"`
	Status          string         `json:"status"`
	Locale          string         `json:"locale,omitempty"`
	DefaultCurrency string         `json:"default_currency"`
	Settings        map[string]any `json:"settings,omitempty"`
	LastSyncAt      *time.Time     `json:"last_sync_at,omitempty"`
	ErrorMessage    string         `json:"error_message,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

type CatalogProductImportInput struct {
	Products []CatalogProductImportProduct `json:"products"`
	Replace  bool                          `json:"replace,omitempty"`
}

type CatalogProductImportProduct struct {
	SourceID   string           `json:"source_id"`
	Title      string           `json:"title"`
	URL        string           `json:"url,omitempty"`
	ImageURL   string           `json:"image_url,omitempty"`
	PriceCents int              `json:"price_cents,omitempty"`
	Currency   string           `json:"currency,omitempty"`
	Collection string           `json:"collection,omitempty"`
	Position   int              `json:"position,omitempty"`
	Variants   []map[string]any `json:"variants,omitempty"`
	Raw        map[string]any   `json:"raw,omitempty"`
}

type CatalogProductImportSummary struct {
	CatalogID            string    `json:"catalog_id"`
	IntegrationID        string    `json:"integration_id"`
	ProductsSeen         int       `json:"products_seen"`
	ProductsUpserted     int       `json:"products_upserted"`
	CatalogItemsUpserted int       `json:"catalog_items_upserted"`
	ProductsSkipped      int       `json:"products_skipped"`
	ImportedAt           time.Time `json:"imported_at"`
}

type ProductFeedInput struct {
	Name              string         `json:"name"`
	FeedType          string         `json:"feed_type"`
	Status            string         `json:"status"`
	Criteria          map[string]any `json:"criteria"`
	Fallback          map[string]any `json:"fallback"`
	MaxItems          int            `json:"max_items"`
	ExcludeOutOfStock *bool          `json:"exclude_out_of_stock,omitempty"`
}

type ProductFeed struct {
	ID                string         `json:"id"`
	TenantID          string         `json:"tenant_id,omitempty"`
	CatalogID         string         `json:"catalog_id,omitempty"`
	Name              string         `json:"name"`
	FeedType          string         `json:"feed_type"`
	Status            string         `json:"status"`
	Criteria          map[string]any `json:"criteria"`
	Fallback          map[string]any `json:"fallback"`
	MaxItems          int            `json:"max_items"`
	ExcludeOutOfStock bool           `json:"exclude_out_of_stock"`
	CreatedAt         time.Time      `json:"created_at"`
	UpdatedAt         time.Time      `json:"updated_at"`
}

type ProductFeedResolveInput struct {
	SubscriberEmail   string         `json:"subscriber_email,omitempty"`
	MaxItems          int            `json:"max_items,omitempty"`
	ExcludeOutOfStock *bool          `json:"exclude_out_of_stock,omitempty"`
	Context           map[string]any `json:"context,omitempty"`
}

type ResolvedProductFeedItem struct {
	ProductID           string         `json:"product_id"`
	VariantID           string         `json:"variant_id,omitempty"`
	SourceID            string         `json:"source_id"`
	VariantSourceID     string         `json:"variant_source_id,omitempty"`
	Title               string         `json:"title"`
	ImageURL            string         `json:"image_url,omitempty"`
	URL                 string         `json:"url,omitempty"`
	PriceCents          int            `json:"price_cents"`
	CompareAtPriceCents *int           `json:"compare_at_price_cents,omitempty"`
	Currency            string         `json:"currency"`
	Available           bool           `json:"available"`
	Reason              string         `json:"reason,omitempty"`
	Rank                int            `json:"rank"`
	Metadata            map[string]any `json:"metadata,omitempty"`
}

type ResolvedProductFeed struct {
	FeedID            string                    `json:"feed_id"`
	CatalogID         string                    `json:"catalog_id,omitempty"`
	FeedType          string                    `json:"feed_type"`
	SubscriberEmail   string                    `json:"subscriber_email,omitempty"`
	ExcludeOutOfStock bool                      `json:"exclude_out_of_stock"`
	Items             []ResolvedProductFeedItem `json:"items"`
	PageInfo
}

type CartRecoveryLinkInput struct {
	CartOrderID   string         `json:"cart_order_id,omitempty"`
	SourceCartID  string         `json:"source_cart_id"`
	CustomerEmail string         `json:"customer_email,omitempty"`
	RecoveryURL   string         `json:"recovery_url"`
	Status        string         `json:"status,omitempty"`
	ExpiresAt     *time.Time     `json:"expires_at,omitempty"`
	Metadata      map[string]any `json:"metadata"`
}

type CartRecoveryLink struct {
	ID            string         `json:"id"`
	TenantID      string         `json:"tenant_id,omitempty"`
	IntegrationID string         `json:"integration_id,omitempty"`
	CartOrderID   string         `json:"cart_order_id,omitempty"`
	SourceCartID  string         `json:"source_cart_id"`
	CustomerEmail string         `json:"customer_email,omitempty"`
	RecoveryURL   string         `json:"recovery_url"`
	Status        string         `json:"status"`
	ExpiresAt     *time.Time     `json:"expires_at,omitempty"`
	Metadata      map[string]any `json:"metadata"`
	CreatedAt     time.Time      `json:"created_at"`
	UpdatedAt     time.Time      `json:"updated_at"`
}

type BackInStockSubscriptionInput struct {
	VariantID       string         `json:"variant_id,omitempty"`
	SubscriberID    string         `json:"subscriber_id,omitempty"`
	SubscriberEmail string         `json:"subscriber_email,omitempty"`
	ExpiresAt       *time.Time     `json:"expires_at,omitempty"`
	Metadata        map[string]any `json:"metadata"`
}

type BackInStockSubscription struct {
	ID              string         `json:"id"`
	TenantID        string         `json:"tenant_id,omitempty"`
	IntegrationID   string         `json:"integration_id,omitempty"`
	ProductID       string         `json:"product_id"`
	VariantID       string         `json:"variant_id,omitempty"`
	SubscriberID    string         `json:"subscriber_id,omitempty"`
	SubscriberEmail string         `json:"subscriber_email,omitempty"`
	Status          string         `json:"status"`
	RequestedAt     time.Time      `json:"requested_at"`
	EligibleAt      *time.Time     `json:"eligible_at,omitempty"`
	NotifiedAt      *time.Time     `json:"notified_at,omitempty"`
	ExpiresAt       *time.Time     `json:"expires_at,omitempty"`
	Metadata        map[string]any `json:"metadata"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

type PriceDropWatcherInput struct {
	VariantID          string         `json:"variant_id,omitempty"`
	SubscriberID       string         `json:"subscriber_id,omitempty"`
	SubscriberEmail    string         `json:"subscriber_email,omitempty"`
	OriginalPriceCents int            `json:"original_price_cents,omitempty"`
	TargetPriceCents   *int           `json:"target_price_cents,omitempty"`
	MinDropPercent     *int           `json:"min_drop_percent,omitempty"`
	Currency           string         `json:"currency,omitempty"`
	ExpiresAt          *time.Time     `json:"expires_at,omitempty"`
	Metadata           map[string]any `json:"metadata"`
}

type PriceDropWatcher struct {
	ID                 string         `json:"id"`
	TenantID           string         `json:"tenant_id,omitempty"`
	IntegrationID      string         `json:"integration_id,omitempty"`
	ProductID          string         `json:"product_id"`
	VariantID          string         `json:"variant_id,omitempty"`
	SubscriberID       string         `json:"subscriber_id,omitempty"`
	SubscriberEmail    string         `json:"subscriber_email,omitempty"`
	OriginalPriceCents int            `json:"original_price_cents"`
	TargetPriceCents   *int           `json:"target_price_cents,omitempty"`
	MinDropPercent     *int           `json:"min_drop_percent,omitempty"`
	Currency           string         `json:"currency"`
	Status             string         `json:"status"`
	WatchedAt          time.Time      `json:"watched_at"`
	EligibleAt         *time.Time     `json:"eligible_at,omitempty"`
	NotifiedAt         *time.Time     `json:"notified_at,omitempty"`
	ExpiresAt          *time.Time     `json:"expires_at,omitempty"`
	Metadata           map[string]any `json:"metadata"`
	CreatedAt          time.Time      `json:"created_at"`
	UpdatedAt          time.Time      `json:"updated_at"`
}

type CommerceLifecycleEvaluationSummary struct {
	BackInStockEligible int       `json:"back_in_stock_eligible"`
	PriceDropEligible   int       `json:"price_drop_eligible"`
	EvaluatedAt         time.Time `json:"evaluated_at"`
}

type CommerceLifecycleReport struct {
	IntegrationID      string         `json:"integration_id"`
	GeneratedAt        time.Time      `json:"generated_at"`
	CartRecovery       LifecycleStats `json:"cart_recovery"`
	BackInStock        LifecycleStats `json:"back_in_stock"`
	PriceDrop          LifecycleStats `json:"price_drop"`
	EventsLast30Days   map[string]int `json:"events_last_30_days"`
	EligibleLast30Days int            `json:"eligible_last_30_days"`
	NotifiedPending    int            `json:"notified_pending"`
}

type LifecycleStats struct {
	Total    int            `json:"total"`
	ByStatus map[string]int `json:"by_status"`
}

type LifecycleEvaluationTarget struct {
	TenantID      string `json:"tenant_id"`
	IntegrationID string `json:"integration_id"`
}

type CustomerInput struct {
	SourceID         string         `json:"source_id"`
	Email            string         `json:"email"`
	FirstName        string         `json:"first_name"`
	LastName         string         `json:"last_name"`
	AcceptsMarketing bool           `json:"accepts_marketing"`
	Tags             []string       `json:"tags"`
	Raw              map[string]any `json:"raw"`
}

type Customer struct {
	ID               string         `json:"id"`
	SourceID         string         `json:"source_id"`
	Email            string         `json:"email,omitempty"`
	FirstName        string         `json:"first_name,omitempty"`
	LastName         string         `json:"last_name,omitempty"`
	AcceptsMarketing bool           `json:"accepts_marketing"`
	Tags             []string       `json:"tags"`
	Raw              map[string]any `json:"raw,omitempty"`
	CreatedAt        time.Time      `json:"created_at"`
	UpdatedAt        time.Time      `json:"updated_at"`
}

type ProductInput struct {
	SourceID   string         `json:"source_id"`
	Title      string         `json:"title"`
	URL        string         `json:"url"`
	ImageURL   string         `json:"image_url"`
	PriceCents int            `json:"price_cents"`
	Currency   string         `json:"currency"`
	Raw        map[string]any `json:"raw"`
}

type Product struct {
	ID         string         `json:"id"`
	SourceID   string         `json:"source_id"`
	Title      string         `json:"title"`
	URL        string         `json:"url,omitempty"`
	ImageURL   string         `json:"image_url,omitempty"`
	PriceCents int            `json:"price_cents"`
	Currency   string         `json:"currency"`
	Raw        map[string]any `json:"raw,omitempty"`
	CreatedAt  time.Time      `json:"created_at"`
	UpdatedAt  time.Time      `json:"updated_at"`
}

type ProductVariant struct {
	ID                  string         `json:"id"`
	TenantID            string         `json:"tenant_id,omitempty"`
	IntegrationID       string         `json:"integration_id,omitempty"`
	ProductID           string         `json:"product_id"`
	SourceID            string         `json:"source_id"`
	SKU                 string         `json:"sku,omitempty"`
	Title               string         `json:"title,omitempty"`
	OptionValues        map[string]any `json:"option_values"`
	PriceCents          int            `json:"price_cents"`
	CompareAtPriceCents *int           `json:"compare_at_price_cents,omitempty"`
	Currency            string         `json:"currency"`
	InventoryQuantity   *int           `json:"inventory_quantity,omitempty"`
	InventoryPolicy     string         `json:"inventory_policy"`
	Available           bool           `json:"available"`
	ImageURL            string         `json:"image_url,omitempty"`
	URL                 string         `json:"url,omitempty"`
	Raw                 map[string]any `json:"raw,omitempty"`
	CreatedAt           time.Time      `json:"created_at"`
	UpdatedAt           time.Time      `json:"updated_at"`
}

type InventorySnapshot struct {
	ID              string         `json:"id"`
	TenantID        string         `json:"tenant_id,omitempty"`
	IntegrationID   string         `json:"integration_id,omitempty"`
	ProductID       string         `json:"product_id"`
	VariantID       string         `json:"variant_id,omitempty"`
	Quantity        *int           `json:"quantity,omitempty"`
	Available       bool           `json:"available"`
	InventoryPolicy string         `json:"inventory_policy"`
	ObservedAt      time.Time      `json:"observed_at"`
	SourceEventID   string         `json:"source_event_id,omitempty"`
	Metadata        map[string]any `json:"metadata"`
}

type PriceHistoryPoint struct {
	ID                  string         `json:"id"`
	TenantID            string         `json:"tenant_id,omitempty"`
	IntegrationID       string         `json:"integration_id,omitempty"`
	ProductID           string         `json:"product_id"`
	VariantID           string         `json:"variant_id,omitempty"`
	PriceCents          int            `json:"price_cents"`
	CompareAtPriceCents *int           `json:"compare_at_price_cents,omitempty"`
	Currency            string         `json:"currency"`
	ObservedAt          time.Time      `json:"observed_at"`
	SourceEventID       string         `json:"source_event_id,omitempty"`
	Metadata            map[string]any `json:"metadata"`
}

type OrderInput struct {
	SourceID      string           `json:"source_id"`
	CustomerEmail string           `json:"customer_email"`
	Status        string           `json:"status"`
	SubtotalCents int              `json:"subtotal_cents"`
	DiscountCents int              `json:"discount_cents"`
	ShippingCents int              `json:"shipping_cents"`
	TaxCents      int              `json:"tax_cents"`
	TotalCents    int              `json:"total_cents"`
	Currency      string           `json:"currency"`
	CampaignID    string           `json:"campaign_id"`
	Attribution   map[string]any   `json:"attribution"`
	LineItems     []map[string]any `json:"line_items"`
	OrderedAt     *time.Time       `json:"ordered_at"`
	Raw           map[string]any   `json:"raw"`
}

type Order struct {
	ID            string           `json:"id"`
	SourceID      string           `json:"source_id"`
	CustomerEmail string           `json:"customer_email,omitempty"`
	Status        string           `json:"status"`
	SubtotalCents int              `json:"subtotal_cents"`
	DiscountCents int              `json:"discount_cents"`
	ShippingCents int              `json:"shipping_cents"`
	TaxCents      int              `json:"tax_cents"`
	TotalCents    int              `json:"total_cents"`
	Currency      string           `json:"currency"`
	CampaignID    string           `json:"campaign_id,omitempty"`
	Attribution   map[string]any   `json:"attribution"`
	LineItems     []map[string]any `json:"line_items"`
	OrderedAt     time.Time        `json:"ordered_at"`
	Raw           map[string]any   `json:"raw,omitempty"`
	CreatedAt     time.Time        `json:"created_at"`
	UpdatedAt     time.Time        `json:"updated_at"`
}

type Event struct {
	ID              int64          `json:"id"`
	EventType       string         `json:"event_type"`
	CustomerEmail   string         `json:"customer_email,omitempty"`
	OrderID         string         `json:"order_id,omitempty"`
	ProviderEventID string         `json:"provider_event_id,omitempty"`
	ProviderTopic   string         `json:"provider_topic,omitempty"`
	Metadata        map[string]any `json:"metadata"`
	At              time.Time      `json:"at"`
}

type CustomersPage struct {
	Items      []Customer `json:"items"`
	NextCursor string     `json:"next_cursor,omitempty"`
}

type ProductsPage struct {
	Items      []Product `json:"items"`
	NextCursor string    `json:"next_cursor,omitempty"`
}

type OrdersPage struct {
	Items      []Order `json:"items"`
	NextCursor string  `json:"next_cursor,omitempty"`
}

type EventsPage struct {
	Items      []Event `json:"items"`
	NextCursor string  `json:"next_cursor,omitempty"`
}

type CatalogsPage struct {
	Items      []Catalog `json:"items"`
	NextCursor string    `json:"next_cursor,omitempty"`
}

type ProductFeedsPage struct {
	Items      []ProductFeed `json:"items"`
	NextCursor string        `json:"next_cursor,omitempty"`
}

type CartRecoveryLinksPage struct {
	Items      []CartRecoveryLink `json:"items"`
	NextCursor string             `json:"next_cursor,omitempty"`
}

type BackInStockSubscriptionsPage struct {
	Items      []BackInStockSubscription `json:"items"`
	NextCursor string                    `json:"next_cursor,omitempty"`
}

type PriceDropWatchersPage struct {
	Items      []PriceDropWatcher `json:"items"`
	NextCursor string             `json:"next_cursor,omitempty"`
}

type ProductVariantsPage struct {
	Items      []ProductVariant `json:"items"`
	NextCursor string           `json:"next_cursor,omitempty"`
}

type InventorySnapshotsPage struct {
	Items      []InventorySnapshot `json:"items"`
	NextCursor string              `json:"next_cursor,omitempty"`
}

type PriceHistoryPage struct {
	Items      []PriceHistoryPoint `json:"items"`
	NextCursor string              `json:"next_cursor,omitempty"`
}

type Analytics struct {
	Customers         int            `json:"customers"`
	Products          int            `json:"products"`
	Orders            int            `json:"orders"`
	RevenueCents      int            `json:"revenue_cents"`
	AverageOrderCents int            `json:"average_order_cents"`
	Currency          string         `json:"currency"`
	OrdersByStatus    map[string]int `json:"orders_by_status"`
	LastOrderAt       *time.Time     `json:"last_order_at,omitempty"`
}

type WebhookClaim string

const (
	WebhookClaimed    WebhookClaim = "claimed"
	WebhookProcessed  WebhookClaim = "processed"
	WebhookInProgress WebhookClaim = "in_progress"
)
