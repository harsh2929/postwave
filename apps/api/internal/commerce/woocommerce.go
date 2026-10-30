package commerce

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	woocommerceCursorPrefix                = "woocommerce:"
	woocommerceRetryCursorPrefix           = "woocommerce_retry:"
	woocommerceCursorComplete              = "woocommerce:complete"
	woocommerceDefaultPageSize             = 50
	woocommerceMaxPageSize                 = 100
	woocommerceMaxVariationPagesPerProduct = 100
	woocommerceMaxResponseBytes            = 8 << 20
	woocommerceRESTAPIVersion              = "wc/v3"
	woocommerceRequestTimeout              = 30 * time.Second
	woocommerceRetryInitialDelay           = 15 * time.Minute
	woocommerceRetryMaxDelay               = 6 * time.Hour
)

var woocommerceObjectOrder = []string{"customers", "products", "orders", "refunds"}

type WooCommerceCredentials struct {
	ConsumerKey    string
	ConsumerSecret string
}

type CommerceCredentialResolver interface {
	ResolveWooCommerce(context.Context, string, Integration) (WooCommerceCredentials, error)
}

type WooCommerceBackfiller interface {
	BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
}

type WooCommerceRESTBackfiller struct {
	HTTPClient           *http.Client
	Credentials          CommerceCredentialResolver
	PageSize             int
	AllowUnsafeLocalURLs bool
}

type wooCommerceBackfillState struct {
	Object string `json:"object"`
	Page   int    `json:"page,omitempty"`
}

type wooCommerceRetryState struct {
	Cursor        string `json:"cursor"`
	Object        string `json:"object,omitempty"`
	Page          int    `json:"page,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type WooCommerceRateLimitError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e WooCommerceRateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("woocommerce REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("woocommerce REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func (b WooCommerceRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderWooCommerce {
		return SyncRequest{}, fmt.Errorf("woocommerce backfill requires a WooCommerce integration")
	}
	resolver := b.Credentials
	if resolver == nil {
		return SyncRequest{}, fmt.Errorf("woocommerce credential resolver is not configured")
	}
	creds, err := resolver.ResolveWooCommerce(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.ConsumerKey) == "" || strings.TrimSpace(creds.ConsumerSecret) == "" {
		return SyncRequest{}, fmt.Errorf("woocommerce credentials are incomplete")
	}
	state, err := decodeWooCommerceBackfillCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "complete" {
		return SyncRequest{Cursor: woocommerceCursorComplete}, nil
	}
	if state.Object == "subscriptions" && !settingBool(integration.Settings, "subscriptions_enabled") {
		return SyncRequest{Cursor: woocommerceCursorComplete}, nil
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	baseURL, err := wooCommerceStoreAPIBase(integration, b.AllowUnsafeLocalURLs)
	if err != nil {
		return SyncRequest{}, err
	}
	client := commerceEgressClient(b.HTTPClient, ProviderWooCommerce, woocommerceRequestTimeout)
	raw, totalPages, err := b.fetchPage(ctx, client, baseURL, creds, state.Object, state.Page)
	if err != nil {
		return SyncRequest{}, err
	}
	if len(raw) == 0 {
		return SyncRequest{Cursor: encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: nextWooCommerceBackfillObjectForIntegration(state.Object, integration), Page: 1})}, nil
	}
	if normalizeWooCommerceObject(state.Object) == "products" {
		if err := b.enrichProductVariations(ctx, client, baseURL, creds, raw); err != nil {
			return SyncRequest{}, err
		}
	}
	req, err := wooCommerceSyncRequest(state.Object, raw)
	if err != nil {
		return SyncRequest{}, err
	}
	nextState := wooCommerceBackfillState{Object: state.Object, Page: state.Page + 1}
	if totalPages > 0 && state.Page >= totalPages {
		nextState = wooCommerceBackfillState{Object: nextWooCommerceBackfillObjectForIntegration(state.Object, integration), Page: 1}
	}
	req.Cursor = encodeWooCommerceBackfillCursor(nextState)
	return req, nil
}

func (b WooCommerceRESTBackfiller) fetchPage(ctx context.Context, client *http.Client, baseURL string, creds WooCommerceCredentials, object string, page int) ([]map[string]any, int, error) {
	return b.fetchCollectionPage(ctx, client, baseURL, creds, object, page, true)
}

func (b WooCommerceRESTBackfiller) fetchCollectionPage(ctx context.Context, client *http.Client, baseURL string, creds WooCommerceCredentials, object string, page int, includeDateOrder bool) ([]map[string]any, int, error) {
	u, err := url.Parse(baseURL + "/" + object)
	if err != nil {
		return nil, 0, err
	}
	q := u.Query()
	q.Set("per_page", strconv.Itoa(normalizeWooCommercePageSize(b.PageSize)))
	q.Set("page", strconv.Itoa(page))
	if includeDateOrder {
		q.Set("orderby", "date")
		q.Set("order", "asc")
	}
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, 0, err
	}
	req.SetBasicAuth(strings.TrimSpace(creds.ConsumerKey), strings.TrimSpace(creds.ConsumerSecret))
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	rawBody, readErr := readResponseBodyLimited(resp.Body, woocommerceMaxResponseBytes)
	if readErr != nil {
		return nil, 0, readErr
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return nil, 0, WooCommerceRateLimitError{
				Path:       object,
				StatusCode: resp.StatusCode,
				RetryAfter: wooCommerceRetryAfter(resp.Header),
				Snippet:    responseSnippet(rawBody),
			}
		}
		return nil, 0, fmt.Errorf("woocommerce REST %s page %d failed %d: %s", object, page, resp.StatusCode, responseSnippet(rawBody))
	}
	var raw []map[string]any
	dec := json.NewDecoder(bytes.NewReader(rawBody))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil && err != io.EOF {
		return nil, 0, fmt.Errorf("decode woocommerce %s response: %w", object, err)
	}
	totalPages := intHeader(resp.Header.Get("X-WP-TotalPages"))
	return raw, totalPages, nil
}

func (b WooCommerceRESTBackfiller) enrichProductVariations(ctx context.Context, client *http.Client, baseURL string, creds WooCommerceCredentials, products []map[string]any) error {
	for _, product := range products {
		if !wooCommerceProductMayHaveVariations(product) {
			continue
		}
		productID := strings.TrimSpace(fmt.Sprint(firstNonNil(product["id"], "")))
		if productID == "" || productID == "<nil>" {
			continue
		}
		variations, err := b.fetchProductVariations(ctx, client, baseURL, creds, productID)
		if err != nil {
			return err
		}
		if len(variations) == 0 {
			continue
		}
		rawVariants := make([]any, 0, len(variations))
		for _, variation := range variations {
			rawVariants = append(rawVariants, wooCommerceProductVariantRaw(product, variation))
		}
		product["variants"] = rawVariants
	}
	return nil
}

func (b WooCommerceRESTBackfiller) fetchProductVariations(ctx context.Context, client *http.Client, baseURL string, creds WooCommerceCredentials, productID string) ([]map[string]any, error) {
	out := []map[string]any{}
	page := 1
	for {
		if page > woocommerceMaxVariationPagesPerProduct {
			return nil, fmt.Errorf("woocommerce product %s variations exceeded %d pages", productID, woocommerceMaxVariationPagesPerProduct)
		}
		object := "products/" + url.PathEscape(productID) + "/variations"
		raw, totalPages, err := b.fetchCollectionPage(ctx, client, baseURL, creds, object, page, false)
		if err != nil {
			return nil, err
		}
		out = append(out, raw...)
		if totalPages > 0 && page >= totalPages {
			break
		}
		if len(raw) == 0 || len(raw) < normalizeWooCommercePageSize(b.PageSize) {
			break
		}
		page++
	}
	return out, nil
}

func decodeWooCommerceBackfillCursor(cursor string) (wooCommerceBackfillState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return wooCommerceBackfillState{Object: "customers", Page: 1}, nil
	}
	if cursor == woocommerceCursorComplete {
		return wooCommerceBackfillState{Object: "complete"}, nil
	}
	if !strings.HasPrefix(cursor, woocommerceCursorPrefix) {
		return wooCommerceBackfillState{Object: "customers", Page: 1}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, woocommerceCursorPrefix))
	if err != nil {
		return wooCommerceBackfillState{}, fmt.Errorf("invalid woocommerce backfill cursor: %w", err)
	}
	var state wooCommerceBackfillState
	if err := json.Unmarshal(raw, &state); err != nil {
		return wooCommerceBackfillState{}, fmt.Errorf("invalid woocommerce backfill cursor: %w", err)
	}
	state.Object = normalizeWooCommerceObject(state.Object)
	if !validWooCommerceBackfillObject(state.Object) {
		return wooCommerceBackfillState{}, fmt.Errorf("invalid woocommerce backfill cursor object")
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	return state, nil
}

func encodeWooCommerceBackfillCursor(state wooCommerceBackfillState) string {
	state.Object = normalizeWooCommerceObject(state.Object)
	if state.Object == "complete" {
		return woocommerceCursorComplete
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	raw, _ := json.Marshal(state)
	return woocommerceCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func decodeWooCommerceRetryCursor(cursor string) (wooCommerceRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, woocommerceRetryCursorPrefix) {
		return wooCommerceRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, woocommerceRetryCursorPrefix))
	if err != nil {
		return wooCommerceRetryState{}, true, fmt.Errorf("invalid woocommerce retry cursor: %w", err)
	}
	var state wooCommerceRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return wooCommerceRetryState{}, true, fmt.Errorf("invalid woocommerce retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Attempts < 0 {
		state.Attempts = 0
	}
	if state.Cursor == "" {
		state.Cursor = encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "customers", Page: 1})
	}
	underlying, err := decodeWooCommerceBackfillCursor(state.Cursor)
	if err != nil {
		return wooCommerceRetryState{}, true, err
	}
	state.Object = underlying.Object
	state.Page = underlying.Page
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	state.NextAttemptAt = strings.TrimSpace(state.NextAttemptAt)
	return state, true, nil
}

func encodeWooCommerceRetryCursor(state wooCommerceRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: "customers", Page: 1})
	}
	if underlying, err := decodeWooCommerceBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.Page = underlying.Page
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return woocommerceRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func wooCommerceRetryCursorDue(state wooCommerceRetryState, now time.Time) bool {
	next := strings.TrimSpace(state.NextAttemptAt)
	if next == "" {
		return true
	}
	at, err := time.Parse(time.RFC3339, next)
	if err != nil {
		return true
	}
	return !at.After(now.UTC())
}

func wooCommerceBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := wooCommerceRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeWooCommerceRetryCursor(cursor); err == nil && ok {
		state = existing
	}
	state.Attempts++
	state.LastStatus = strings.ToUpper(strings.TrimSpace(status))
	if state.LastStatus == "" {
		state.LastStatus = "ERROR"
	}
	if retryErr != nil {
		state.LastError = retryErr.Error()
	}
	state.NextAttemptAt = now.UTC().Add(wooCommerceRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeWooCommerceRetryCursor(state)
}

func wooCommerceRetryDelay(attempt int, err error) time.Duration {
	var rateLimit WooCommerceRateLimitError
	if err != nil && errors.As(err, &rateLimit) && rateLimit.RetryAfter > 0 {
		if rateLimit.RetryAfter > woocommerceRetryMaxDelay {
			return woocommerceRetryMaxDelay
		}
		return rateLimit.RetryAfter
	}
	if attempt <= 1 {
		return woocommerceRetryInitialDelay
	}
	delay := woocommerceRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= woocommerceRetryMaxDelay {
			return woocommerceRetryMaxDelay
		}
	}
	return delay
}

func wooCommerceRetryAfter(headers http.Header) time.Duration {
	if raw := strings.TrimSpace(headers.Get("Retry-After")); raw != "" {
		if seconds, err := strconv.Atoi(raw); err == nil && seconds > 0 {
			return time.Duration(seconds) * time.Second
		}
		if at, err := http.ParseTime(raw); err == nil {
			wait := time.Until(at)
			if wait > 0 {
				return wait
			}
		}
	}
	return 0
}

func wooCommerceSyncRequest(object string, raw []map[string]any) (SyncRequest, error) {
	switch normalizeWooCommerceObject(object) {
	case "customers":
		req := SyncRequest{Customers: make([]CustomerInput, 0, len(raw))}
		for _, item := range raw {
			req.Customers = append(req.Customers, wooCommerceCustomerInput(item))
		}
		return req, nil
	case "products":
		req := SyncRequest{Products: make([]ProductInput, 0, len(raw))}
		for _, item := range raw {
			req.Products = append(req.Products, wooCommerceProductInput(item))
		}
		return req, nil
	case "orders":
		req := SyncRequest{Orders: make([]OrderInput, 0, len(raw))}
		for _, item := range raw {
			req.Orders = append(req.Orders, wooCommerceOrderInput(item))
		}
		return req, nil
	case "subscriptions":
		req := SyncRequest{ProviderEvents: make([]ProviderEventInput, 0, len(raw))}
		for _, item := range raw {
			req.ProviderEvents = append(req.ProviderEvents, wooCommerceSubscriptionEvent("subscription.updated", item))
		}
		return req, nil
	case "refunds":
		req := SyncRequest{ProviderEvents: make([]ProviderEventInput, 0, len(raw))}
		for _, item := range raw {
			req.ProviderEvents = append(req.ProviderEvents, wooCommerceRefundEvent(item))
		}
		return req, nil
	default:
		return SyncRequest{}, fmt.Errorf("unsupported WooCommerce object %q", object)
	}
}

func wooCommerceCustomerInput(raw map[string]any) CustomerInput {
	return CustomerInput{
		SourceID:  wooCommerceSourceID("customer", raw),
		Email:     strings.ToLower(strings.TrimSpace(stringField(raw, "email"))),
		FirstName: stringField(raw, "first_name"),
		LastName:  stringField(raw, "last_name"),
		Tags:      stringSlice(raw["tags"]),
		Raw:       nonNilMap(raw),
	}
}

func wooCommerceProductInput(raw map[string]any) ProductInput {
	imageURL := ""
	if images, _ := raw["images"].([]any); len(images) > 0 {
		if image, _ := images[0].(map[string]any); image != nil {
			imageURL = stringField(image, "src")
		}
	}
	priceCents := cents(firstNonNil(raw["price"], raw["regular_price"], raw["sale_price"]))
	currency := strings.ToUpper(firstNonEmpty(
		stringField(raw, "currency"),
		stringField(raw, "currency_code"),
		stringField(mapField(raw, "prices"), "currency_code"),
	))
	return ProductInput{
		SourceID:   wooCommerceSourceID("product", raw),
		Title:      firstNonEmpty(stringField(raw, "name"), stringField(raw, "title")),
		URL:        stringField(raw, "permalink"),
		ImageURL:   imageURL,
		PriceCents: priceCents,
		Currency:   defaulted(currency, "USD"),
		Raw:        nonNilMap(raw),
	}
}

func wooCommerceProductMayHaveVariations(raw map[string]any) bool {
	if strings.EqualFold(stringField(raw, "type"), "variable") {
		return true
	}
	return len(rawArray(raw["variations"])) > 0
}

func wooCommerceProductVariantRaw(product map[string]any, raw map[string]any) map[string]any {
	out := nonNilMap(raw)
	out["source_id"] = wooCommerceSourceID("product_variant", raw)
	out["product_source_id"] = wooCommerceSourceID("product", product)
	out["parent_id"] = stringField(product, "id")
	out["title"] = wooCommerceVariationTitle(product, raw)
	out["price"] = firstNonNil(raw["price"], raw["regular_price"], raw["sale_price"])
	out["compare_at_price"] = wooCommerceVariationCompareAtPrice(raw)
	out["inventory_quantity"] = firstNonNil(raw["stock_quantity"], raw["inventory_quantity"])
	out["inventory_policy"] = wooCommerceVariationInventoryPolicy(raw)
	out["available"] = wooCommerceVariationAvailable(raw)
	out["image_url"] = stringField(mapField(raw, "image"), "src")
	out["url"] = firstNonEmpty(stringField(raw, "permalink"), stringField(product, "permalink"))
	attributes := wooCommerceVariationAttributes(raw["attributes"])
	for idx, attribute := range attributes {
		if idx >= 3 {
			break
		}
		out[fmt.Sprintf("option%d", idx+1)] = attribute["option"]
		out[fmt.Sprintf("option%d_name", idx+1)] = attribute["name"]
	}
	return out
}

func wooCommerceVariationTitle(product map[string]any, raw map[string]any) string {
	title := firstNonEmpty(stringField(raw, "name"), stringField(raw, "title"))
	if title != "" {
		return title
	}
	productTitle := firstNonEmpty(stringField(product, "name"), stringField(product, "title"))
	attributes := wooCommerceVariationAttributes(raw["attributes"])
	options := make([]string, 0, len(attributes))
	for _, attribute := range attributes {
		if option := stringField(attribute, "option"); option != "" {
			options = append(options, option)
		}
	}
	if productTitle == "" {
		return strings.Join(options, " / ")
	}
	if len(options) == 0 {
		return productTitle
	}
	return productTitle + " / " + strings.Join(options, " / ")
}

func wooCommerceVariationCompareAtPrice(raw map[string]any) any {
	regular := firstNonNil(raw["regular_price"], raw["compare_at_price"])
	if cents(regular) > cents(raw["price"]) {
		return regular
	}
	return nil
}

func wooCommerceVariationInventoryPolicy(raw map[string]any) string {
	backorders := strings.ToLower(strings.TrimSpace(stringField(raw, "backorders")))
	if backorders == "yes" || backorders == "notify" || boolField(raw, "backorders_allowed") {
		return "continue"
	}
	if stringField(raw, "stock_quantity") == "" && !boolField(raw, "manage_stock") {
		return "unknown"
	}
	return "deny"
}

func wooCommerceVariationAvailable(raw map[string]any) bool {
	if boolField(raw, "purchasable") || boolField(raw, "in_stock") {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(stringField(raw, "stock_status"))) {
	case "instock", "onbackorder":
		return true
	default:
		return false
	}
}

func wooCommerceVariationAttributes(v any) []map[string]any {
	items := rawArray(v)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		out = append(out, map[string]any{
			"id":     firstNonNil(m["id"], m["attribute_id"]),
			"name":   firstNonEmpty(stringField(m, "name"), stringField(m, "slug")),
			"slug":   stringField(m, "slug"),
			"option": stringField(m, "option"),
		})
	}
	return out
}

func wooCommerceOrderInput(raw map[string]any) OrderInput {
	email := stringField(mapField(raw, "billing"), "email")
	if email == "" {
		email = stringField(raw, "email")
	}
	orderedAt := parseTimeAny(firstNonNil(raw["date_paid_gmt"], raw["date_completed_gmt"], raw["date_created_gmt"], raw["date_created"]))
	return OrderInput{
		SourceID:      wooCommerceSourceID("order", raw),
		CustomerEmail: strings.ToLower(strings.TrimSpace(email)),
		Status:        wooCommerceOrderStatus(raw),
		SubtotalCents: cents(firstNonNil(raw["subtotal"], raw["total"])),
		DiscountCents: cents(raw["discount_total"]),
		ShippingCents: cents(raw["shipping_total"]),
		TaxCents:      cents(raw["total_tax"]),
		TotalCents:    cents(raw["total"]),
		Currency:      defaulted(strings.ToUpper(stringField(raw, "currency")), "USD"),
		Attribution:   wooCommerceOrderAttribution(raw),
		LineItems:     wooCommerceLineItems(raw["line_items"]),
		OrderedAt:     orderedAt,
		Raw:           nonNilMap(raw),
	}
}

func wooCommerceOrderAttribution(raw map[string]any) map[string]any {
	refundLines, refundCents := wooCommerceRefundLines(raw["refunds"])
	return map[string]any{
		"source":               "woocommerce",
		"created_via":          stringField(raw, "created_via"),
		"payment_method":       stringField(raw, "payment_method"),
		"payment_method_title": stringField(raw, "payment_method_title"),
		"transaction_id":       stringField(raw, "transaction_id"),
		"customer_id":          stringField(raw, "customer_id"),
		"customer_note":        stringField(raw, "customer_note"),
		"cart_hash":            stringField(raw, "cart_hash"),
		"discount_codes":       wooCommerceCouponCodes(raw["coupon_lines"]),
		"coupon_lines":         wooCommerceCouponLines(raw["coupon_lines"]),
		"refunds":              refundLines,
		"refund_cents":         refundCents,
	}
}

func wooCommerceLineItems(v any) []map[string]any {
	items, _ := v.([]any)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		out = append(out, map[string]any{
			"source_id":          wooCommerceSourceID("line_item", m),
			"product_id":         stringField(m, "product_id"),
			"variant_id":         stringField(m, "variation_id"),
			"title":              firstNonEmpty(stringField(m, "name"), stringField(m, "title")),
			"quantity":           intField(m, "quantity"),
			"price_cents":        cents(firstNonNil(m["price"], m["subtotal"], m["total"])),
			"subtotal_cents":     cents(m["subtotal"]),
			"subtotal_tax_cents": cents(m["subtotal_tax"]),
			"total_cents":        cents(m["total"]),
			"total_tax_cents":    cents(m["total_tax"]),
			"sku":                stringField(m, "sku"),
			"tax_class":          stringField(m, "tax_class"),
			"raw":                nonNilMap(m),
		})
	}
	return out
}

func wooCommerceCouponCodes(v any) []string {
	items := rawArray(v)
	out := make([]string, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		code := ""
		if m, ok := item.(map[string]any); ok {
			code = stringField(m, "code")
		} else {
			code = strings.TrimSpace(fmt.Sprint(item))
		}
		if code == "" {
			continue
		}
		key := strings.ToLower(code)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, code)
	}
	return out
}

func wooCommerceCouponLines(v any) []map[string]any {
	items := rawArray(v)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		out = append(out, map[string]any{
			"source_id":          wooCommerceSourceID("coupon_line", m),
			"code":               stringField(m, "code"),
			"discount_cents":     cents(m["discount"]),
			"discount_tax_cents": cents(m["discount_tax"]),
			"raw":                nonNilMap(m),
		})
	}
	return out
}

func wooCommerceRefundEvent(raw map[string]any) ProviderEventInput {
	sourceID := wooCommerceSourceID("refund", raw)
	amountCents := cents(firstNonNil(raw["amount"], raw["total"]))
	return ProviderEventInput{
		EventType:       "refund_created",
		Provider:        ProviderWooCommerce,
		Topic:           "refund.created",
		SourceID:        sourceID,
		ProviderEventID: "refund_created:" + sourceID,
		Metadata: map[string]any{
			"source":           ProviderWooCommerce,
			"topic":            "refund.created",
			"object":           "refund",
			"source_id":        sourceID,
			"order_source_id":  wooCommerceRefundOrderSourceID(raw),
			"parent_order_id":  stringField(raw, "parent_id"),
			"reason":           stringField(raw, "reason"),
			"amount_cents":     amountCents,
			"refund_cents":     absoluteCents(amountCents),
			"refunded_by":      stringField(raw, "refunded_by"),
			"refunded_payment": boolField(raw, "refunded_payment"),
			"date_created":     stringField(raw, "date_created"),
			"date_created_gmt": stringField(raw, "date_created_gmt"),
			"line_items":       wooCommerceLineItems(raw["line_items"]),
			"tax_lines":        rawArray(raw["tax_lines"]),
			"shipping_lines":   rawArray(raw["shipping_lines"]),
			"fee_lines":        rawArray(raw["fee_lines"]),
			"provider_raw":     nonNilMap(raw),
		},
	}
}

func wooCommerceRefundLines(v any) ([]map[string]any, int) {
	items := rawArray(v)
	out := make([]map[string]any, 0, len(items))
	totalRefundCents := 0
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		amountCents := cents(firstNonNil(m["amount"], m["total"]))
		totalRefundCents += absoluteCents(amountCents)
		out = append(out, map[string]any{
			"source_id":        wooCommerceSourceID("refund", m),
			"order_source_id":  wooCommerceRefundOrderSourceID(m),
			"reason":           stringField(m, "reason"),
			"amount_cents":     amountCents,
			"refund_cents":     absoluteCents(amountCents),
			"refunded_by":      stringField(m, "refunded_by"),
			"refunded_payment": boolField(m, "refunded_payment"),
			"date_created":     stringField(m, "date_created"),
			"date_created_gmt": stringField(m, "date_created_gmt"),
			"line_items":       wooCommerceLineItems(m["line_items"]),
			"shipping_lines":   rawArray(m["shipping_lines"]),
			"fee_lines":        rawArray(m["fee_lines"]),
			"raw":              nonNilMap(m),
		})
	}
	return out, totalRefundCents
}

func wooCommerceRefundOrderSourceID(raw map[string]any) string {
	if strings.TrimSpace(fmt.Sprint(firstNonNil(raw["parent_id"], ""))) == "" {
		return ""
	}
	return wooCommerceSourceID("order", map[string]any{"id": raw["parent_id"]})
}

func absoluteCents(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func wooCommerceOrderStatus(raw map[string]any) string {
	switch strings.ToLower(strings.TrimSpace(stringField(raw, "status"))) {
	case "completed", "processing":
		return "paid"
	case "refunded":
		return "refunded"
	case "cancelled", "canceled", "failed":
		return "cancelled"
	default:
		return "pending"
	}
}

func wooCommerceSourceID(kind string, raw map[string]any) string {
	id := strings.TrimSpace(fmt.Sprint(firstNonNil(raw["id"], raw["number"])))
	if id == "" || id == "<nil>" {
		return ""
	}
	return "woocommerce://" + strings.TrimSpace(kind) + "/" + id
}

func wooCommerceStoreAPIBase(integration Integration, allowUnsafeLocal bool) (string, error) {
	storeURL := firstNonEmpty(settingString(integration.Settings, "store_url"), integration.ShopDomain)
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(storeURL), "/"))
	if err != nil {
		return "", fmt.Errorf("invalid WooCommerce store_url: %w", err)
	}
	if u.Scheme != "https" && !(allowUnsafeLocal && u.Scheme == "http") {
		return "", fmt.Errorf("invalid WooCommerce store_url: https is required")
	}
	host := u.Hostname()
	if host == "" {
		return "", fmt.Errorf("invalid WooCommerce store_url: missing host")
	}
	if !allowUnsafeLocal {
		if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
			return "", fmt.Errorf("invalid WooCommerce store_url: local host is not allowed")
		}
		if addr, err := netip.ParseAddr(host); err == nil && !addr.IsGlobalUnicast() {
			return "", fmt.Errorf("invalid WooCommerce store_url: non-public address is not allowed")
		}
		if ip := net.ParseIP(host); ip != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()) {
			return "", fmt.Errorf("invalid WooCommerce store_url: private address is not allowed")
		}
	}
	return strings.TrimRight(u.String(), "/") + "/wp-json/" + woocommerceRESTAPIVersion, nil
}

func normalizeWooCommerceStoreOrigin(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("invalid WooCommerce store URL: %w", err)
	}
	if u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("invalid WooCommerce store URL: scheme and host are required")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	u.Path = ""
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimRight(u.String(), "/"), nil
}

func normalizeWooCommerceObject(object string) string {
	object = strings.ToLower(strings.TrimSpace(object))
	if object == "" {
		return "customers"
	}
	return object
}

func validWooCommerceBackfillObject(object string) bool {
	object = normalizeWooCommerceObject(object)
	if object == "complete" {
		return true
	}
	for _, item := range allWooCommerceBackfillObjects() {
		if item == object {
			return true
		}
	}
	return false
}

func nextWooCommerceBackfillObject(object string) string {
	return nextWooCommerceBackfillObjectForOrder(object, woocommerceObjectOrder)
}

func nextWooCommerceBackfillObjectForIntegration(object string, integration Integration) string {
	return nextWooCommerceBackfillObjectForOrder(object, wooCommerceBackfillObjectOrder(integration))
}

func nextWooCommerceBackfillObjectForOrder(object string, order []string) string {
	for idx, item := range order {
		if item == object {
			if idx+1 < len(order) {
				return order[idx+1]
			}
			return "complete"
		}
	}
	return "complete"
}

func wooCommerceBackfillObjectOrder(integration Integration) []string {
	out := append([]string(nil), woocommerceObjectOrder...)
	if settingBool(integration.Settings, "subscriptions_enabled") {
		out = append(out, "subscriptions")
	}
	return out
}

func allWooCommerceBackfillObjects() []string {
	out := append([]string(nil), woocommerceObjectOrder...)
	out = append(out, "subscriptions")
	return out
}

func normalizeWooCommercePageSize(pageSize int) int {
	if pageSize <= 0 {
		return woocommerceDefaultPageSize
	}
	if pageSize > woocommerceMaxPageSize {
		return woocommerceMaxPageSize
	}
	return pageSize
}

func intHeader(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	return n
}
