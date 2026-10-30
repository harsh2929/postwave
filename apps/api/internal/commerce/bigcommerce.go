package commerce

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	bigCommerceCursorPrefix      = "bigcommerce:"
	bigCommerceRetryCursorPrefix = "bigcommerce_retry:"
	bigCommerceCursorComplete    = "bigcommerce:complete"
	bigCommerceDefaultPageSize   = 50
	bigCommerceMaxPageSize       = 250
	bigCommerceMaxResponseBytes  = 8 << 20
	bigCommerceRequestTimeout    = 30 * time.Second
	bigCommerceRetryInitialDelay = 15 * time.Minute
	bigCommerceRetryMaxDelay     = 6 * time.Hour
)

var bigCommerceObjectOrder = []string{"customers", "products", "orders"}

type BigCommerceCredentials struct {
	AccessToken string
}

type BigCommerceCredentialResolver interface {
	ResolveBigCommerce(context.Context, string, Integration) (BigCommerceCredentials, error)
}

type BigCommerceBackfiller interface {
	BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
}

type BigCommerceRecordFetcher interface {
	FetchCustomer(context.Context, string, Integration, string) (CustomerInput, error)
	FetchProduct(context.Context, string, Integration, string) (ProductInput, error)
	FetchOrder(context.Context, string, Integration, string) (OrderInput, error)
}

type BigCommerceRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials BigCommerceCredentialResolver
	PageSize    int
	APIBaseURL  string
}

type bigCommerceBackfillState struct {
	Object string `json:"object"`
	Page   int    `json:"page,omitempty"`
}

type bigCommerceRetryState struct {
	Cursor        string `json:"cursor"`
	Object        string `json:"object,omitempty"`
	Page          int    `json:"page,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type BigCommerceRateLimitError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e BigCommerceRateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("bigcommerce REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("bigcommerce REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

type bigCommerceV3Collection struct {
	Data []map[string]any `json:"data"`
	Meta struct {
		Pagination struct {
			TotalPages  int `json:"total_pages"`
			CurrentPage int `json:"current_page"`
		} `json:"pagination"`
	} `json:"meta"`
}

func (b BigCommerceRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderBigCommerce {
		return SyncRequest{}, fmt.Errorf("bigcommerce backfill requires a BigCommerce integration")
	}
	resolver := b.Credentials
	if resolver == nil {
		return SyncRequest{}, fmt.Errorf("bigcommerce credential resolver is not configured")
	}
	creds, err := resolver.ResolveBigCommerce(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("bigcommerce access token is required")
	}
	state, err := decodeBigCommerceBackfillCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "complete" {
		return SyncRequest{Cursor: bigCommerceCursorComplete}, nil
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	baseURL, err := bigCommerceStoreAPIBase(integration, b.APIBaseURL)
	if err != nil {
		return SyncRequest{}, err
	}
	client := commerceEgressClient(b.HTTPClient, ProviderBigCommerce, bigCommerceRequestTimeout)
	raw, totalPages, err := b.fetchObjectPage(ctx, client, baseURL, creds, integration, state.Object, state.Page)
	if err != nil {
		return SyncRequest{}, err
	}
	if len(raw) == 0 {
		return SyncRequest{Cursor: encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: nextBigCommerceBackfillObject(state.Object), Page: 1})}, nil
	}
	if state.Object == "products" {
		if err := b.enrichProductVariants(ctx, client, baseURL, creds, raw); err != nil {
			return SyncRequest{}, err
		}
	}
	if state.Object == "orders" {
		if err := b.enrichOrders(ctx, client, baseURL, creds, raw); err != nil {
			return SyncRequest{}, err
		}
	}
	req, err := bigCommerceSyncRequest(state.Object, raw, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	nextState := bigCommerceBackfillState{Object: state.Object, Page: state.Page + 1}
	if totalPages > 0 && state.Page >= totalPages {
		nextState = bigCommerceBackfillState{Object: nextBigCommerceBackfillObject(state.Object), Page: 1}
	}
	if totalPages == 0 && len(raw) < normalizeBigCommercePageSize(b.PageSize) {
		nextState = bigCommerceBackfillState{Object: nextBigCommerceBackfillObject(state.Object), Page: 1}
	}
	req.Cursor = encodeBigCommerceBackfillCursor(nextState)
	return req, nil
}

func (b BigCommerceRESTBackfiller) FetchCustomer(ctx context.Context, tenantID string, integration Integration, id string) (CustomerInput, error) {
	client, baseURL, creds, err := b.client(ctx, tenantID, integration)
	if err != nil {
		return CustomerInput{}, err
	}
	raw, _, err := b.fetchV3CollectionPage(ctx, client, baseURL, creds, "/v3/customers", 1, func(q url.Values) {
		q.Set("id:in", id)
		q.Set("limit", "1")
		q.Set("page", "1")
	})
	if err != nil {
		return CustomerInput{}, err
	}
	if len(raw) == 0 {
		return CustomerInput{}, fmt.Errorf("bigcommerce customer %s not found", id)
	}
	return bigCommerceCustomerInput(raw[0]), nil
}

func (b BigCommerceRESTBackfiller) FetchProduct(ctx context.Context, tenantID string, integration Integration, id string) (ProductInput, error) {
	client, baseURL, creds, err := b.client(ctx, tenantID, integration)
	if err != nil {
		return ProductInput{}, err
	}
	raw, _, err := b.fetchV3CollectionPage(ctx, client, baseURL, creds, "/v3/catalog/products", 1, func(q url.Values) {
		q.Set("id:in", id)
		q.Set("include", "images")
		q.Set("limit", "1")
		q.Set("page", "1")
	})
	if err != nil {
		return ProductInput{}, err
	}
	if len(raw) == 0 {
		return ProductInput{}, fmt.Errorf("bigcommerce product %s not found", id)
	}
	if err := b.enrichProductVariants(ctx, client, baseURL, creds, raw[:1]); err != nil {
		return ProductInput{}, err
	}
	return bigCommerceProductInput(raw[0], integration), nil
}

func (b BigCommerceRESTBackfiller) FetchOrder(ctx context.Context, tenantID string, integration Integration, id string) (OrderInput, error) {
	client, baseURL, creds, err := b.client(ctx, tenantID, integration)
	if err != nil {
		return OrderInput{}, err
	}
	rawBody, err := b.get(ctx, client, baseURL, creds, "/v2/orders/"+url.PathEscape(id), nil)
	if err != nil {
		return OrderInput{}, err
	}
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(rawBody))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil && err != io.EOF {
		return OrderInput{}, fmt.Errorf("decode bigcommerce order %s response: %w", id, err)
	}
	if len(raw) == 0 {
		return OrderInput{}, fmt.Errorf("bigcommerce order %s not found", id)
	}
	if err := b.enrichOrders(ctx, client, baseURL, creds, []map[string]any{raw}); err != nil {
		return OrderInput{}, err
	}
	return bigCommerceOrderInput(raw), nil
}

func (b BigCommerceRESTBackfiller) client(ctx context.Context, tenantID string, integration Integration) (*http.Client, string, BigCommerceCredentials, error) {
	if integration.Provider != ProviderBigCommerce {
		return nil, "", BigCommerceCredentials{}, fmt.Errorf("bigcommerce REST client requires a BigCommerce integration")
	}
	resolver := b.Credentials
	if resolver == nil {
		return nil, "", BigCommerceCredentials{}, fmt.Errorf("bigcommerce credential resolver is not configured")
	}
	creds, err := resolver.ResolveBigCommerce(ctx, tenantID, integration)
	if err != nil {
		return nil, "", BigCommerceCredentials{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return nil, "", BigCommerceCredentials{}, fmt.Errorf("bigcommerce access token is required")
	}
	baseURL, err := bigCommerceStoreAPIBase(integration, b.APIBaseURL)
	if err != nil {
		return nil, "", BigCommerceCredentials{}, err
	}
	client := commerceEgressClient(b.HTTPClient, ProviderBigCommerce, bigCommerceRequestTimeout)
	return client, baseURL, creds, nil
}

func (b BigCommerceRESTBackfiller) fetchObjectPage(ctx context.Context, client *http.Client, baseURL string, creds BigCommerceCredentials, integration Integration, object string, page int) ([]map[string]any, int, error) {
	switch object {
	case "customers":
		return b.fetchV3CollectionPage(ctx, client, baseURL, creds, "/v3/customers", page, func(q url.Values) {
			q.Set("limit", strconv.Itoa(normalizeBigCommercePageSize(b.PageSize)))
			q.Set("page", strconv.Itoa(page))
		})
	case "products":
		return b.fetchV3CollectionPage(ctx, client, baseURL, creds, "/v3/catalog/products", page, func(q url.Values) {
			q.Set("limit", strconv.Itoa(normalizeBigCommercePageSize(b.PageSize)))
			q.Set("page", strconv.Itoa(page))
			q.Set("include", "images")
			if channelID := settingString(integration.Settings, "channel_id"); channelID != "" {
				q.Set("channel_id:in", channelID)
			}
		})
	case "orders":
		raw, err := b.fetchV2Array(ctx, client, baseURL, creds, "/v2/orders", func(q url.Values) {
			q.Set("limit", strconv.Itoa(normalizeBigCommercePageSize(b.PageSize)))
			q.Set("page", strconv.Itoa(page))
			q.Set("sort", "date_created:asc")
			if channelID := settingString(integration.Settings, "channel_id"); channelID != "" {
				q.Set("channel_id", channelID)
			}
		})
		return raw, 0, err
	default:
		return nil, 0, fmt.Errorf("unsupported BigCommerce object %q", object)
	}
}

func (b BigCommerceRESTBackfiller) fetchV3CollectionPage(ctx context.Context, client *http.Client, baseURL string, creds BigCommerceCredentials, path string, page int, decorate func(url.Values)) ([]map[string]any, int, error) {
	rawBody, err := b.get(ctx, client, baseURL, creds, path, decorate)
	if err != nil {
		return nil, 0, err
	}
	var envelope bigCommerceV3Collection
	dec := json.NewDecoder(bytes.NewReader(rawBody))
	dec.UseNumber()
	if err := dec.Decode(&envelope); err != nil && err != io.EOF {
		return nil, 0, fmt.Errorf("decode bigcommerce %s page %d response: %w", path, page, err)
	}
	return envelope.Data, envelope.Meta.Pagination.TotalPages, nil
}

func (b BigCommerceRESTBackfiller) fetchV2Array(ctx context.Context, client *http.Client, baseURL string, creds BigCommerceCredentials, path string, decorate func(url.Values)) ([]map[string]any, error) {
	rawBody, err := b.get(ctx, client, baseURL, creds, path, decorate)
	if err != nil {
		return nil, err
	}
	var raw []map[string]any
	dec := json.NewDecoder(bytes.NewReader(rawBody))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil && err != io.EOF {
		return nil, fmt.Errorf("decode bigcommerce %s response: %w", path, err)
	}
	return raw, nil
}

func (b BigCommerceRESTBackfiller) get(ctx context.Context, client *http.Client, baseURL string, creds BigCommerceCredentials, path string, decorate func(url.Values)) ([]byte, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + path)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	if decorate != nil {
		decorate(q)
	}
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Auth-Token", strings.TrimSpace(creds.AccessToken))
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	rawBody, readErr := readResponseBodyLimited(resp.Body, bigCommerceMaxResponseBytes)
	if readErr != nil {
		return nil, readErr
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests {
			return nil, BigCommerceRateLimitError{
				Path:       path,
				StatusCode: resp.StatusCode,
				RetryAfter: bigCommerceRetryAfter(resp.Header),
				Snippet:    responseSnippet(rawBody),
			}
		}
		return nil, fmt.Errorf("bigcommerce REST %s failed %d: %s", path, resp.StatusCode, responseSnippet(rawBody))
	}
	return rawBody, nil
}

func (b BigCommerceRESTBackfiller) enrichProductVariants(ctx context.Context, client *http.Client, baseURL string, creds BigCommerceCredentials, products []map[string]any) error {
	for _, product := range products {
		productID := strings.TrimSpace(fmt.Sprint(firstNonNil(product["id"], "")))
		if productID == "" || productID == "<nil>" {
			continue
		}
		variants, err := b.fetchProductVariants(ctx, client, baseURL, creds, productID)
		if err != nil {
			return err
		}
		if len(variants) > 0 {
			product["variants"] = variants
		}
	}
	return nil
}

func (b BigCommerceRESTBackfiller) fetchProductVariants(ctx context.Context, client *http.Client, baseURL string, creds BigCommerceCredentials, productID string) ([]any, error) {
	out := []any{}
	for page := 1; ; page++ {
		path := "/v3/catalog/products/" + url.PathEscape(productID) + "/variants"
		raw, totalPages, err := b.fetchV3CollectionPage(ctx, client, baseURL, creds, path, page, func(q url.Values) {
			q.Set("limit", strconv.Itoa(normalizeBigCommercePageSize(b.PageSize)))
			q.Set("page", strconv.Itoa(page))
		})
		if err != nil {
			return nil, err
		}
		for _, item := range raw {
			out = append(out, item)
		}
		if totalPages <= 0 || page >= totalPages || len(raw) == 0 {
			break
		}
	}
	return out, nil
}

func (b BigCommerceRESTBackfiller) enrichOrders(ctx context.Context, client *http.Client, baseURL string, creds BigCommerceCredentials, orders []map[string]any) error {
	for _, order := range orders {
		orderID := strings.TrimSpace(fmt.Sprint(firstNonNil(order["id"], "")))
		if orderID == "" || orderID == "<nil>" {
			continue
		}
		products, err := b.fetchV2Array(ctx, client, baseURL, creds, "/v2/orders/"+url.PathEscape(orderID)+"/products", nil)
		if err != nil {
			return err
		}
		coupons, err := b.fetchV2Array(ctx, client, baseURL, creds, "/v2/orders/"+url.PathEscape(orderID)+"/coupons", nil)
		if err != nil {
			return err
		}
		order["products"] = mapsToAny(products)
		order["coupons"] = mapsToAny(coupons)
	}
	return nil
}

func bigCommerceSyncRequest(object string, raw []map[string]any, integration Integration) (SyncRequest, error) {
	switch object {
	case "customers":
		req := SyncRequest{Customers: make([]CustomerInput, 0, len(raw))}
		for _, item := range raw {
			req.Customers = append(req.Customers, bigCommerceCustomerInput(item))
		}
		return req, nil
	case "products":
		req := SyncRequest{Products: make([]ProductInput, 0, len(raw))}
		for _, item := range raw {
			req.Products = append(req.Products, bigCommerceProductInput(item, integration))
		}
		return req, nil
	case "orders":
		req := SyncRequest{Orders: make([]OrderInput, 0, len(raw))}
		for _, item := range raw {
			req.Orders = append(req.Orders, bigCommerceOrderInput(item))
		}
		return req, nil
	default:
		return SyncRequest{}, fmt.Errorf("unsupported BigCommerce object %q", object)
	}
}

func bigCommerceCustomerInput(raw map[string]any) CustomerInput {
	return CustomerInput{
		SourceID:         bigCommerceSourceID("customer", raw),
		Email:            strings.ToLower(strings.TrimSpace(stringField(raw, "email"))),
		FirstName:        stringField(raw, "first_name"),
		LastName:         stringField(raw, "last_name"),
		AcceptsMarketing: boolField(raw, "accepts_product_review_abandoned_cart_emails") || boolField(raw, "accepts_marketing"),
		Tags:             bigCommerceCustomerTags(raw),
		Raw:              nonNilMap(raw),
	}
}

func bigCommerceProductInput(raw map[string]any, integration Integration) ProductInput {
	currency := strings.ToUpper(firstNonEmpty(
		stringField(raw, "currency"),
		settingString(integration.Settings, "currency"),
		settingString(integration.Settings, "default_currency"),
	))
	return ProductInput{
		SourceID:   bigCommerceSourceID("product", raw),
		Title:      firstNonEmpty(stringField(raw, "name"), stringField(raw, "title")),
		URL:        stringField(mapField(raw, "custom_url"), "url"),
		ImageURL:   bigCommerceProductImageURL(raw),
		PriceCents: cents(firstNonNil(raw["calculated_price"], raw["price"], raw["sale_price"], raw["retail_price"])),
		Currency:   defaulted(currency, "USD"),
		Raw:        bigCommerceProductRaw(raw),
	}
}

func bigCommerceProductRaw(raw map[string]any) map[string]any {
	out := nonNilMap(raw)
	if variants, _ := out["variants"].([]any); len(variants) > 0 {
		mapped := make([]any, 0, len(variants))
		for _, item := range variants {
			variant, _ := item.(map[string]any)
			if variant == nil {
				continue
			}
			mapped = append(mapped, bigCommerceProductVariantRaw(raw, variant))
		}
		out["variants"] = mapped
	}
	return out
}

func bigCommerceProductVariantRaw(product map[string]any, raw map[string]any) map[string]any {
	out := nonNilMap(raw)
	out["source_id"] = bigCommerceSourceID("product_variant", raw)
	out["product_source_id"] = bigCommerceSourceID("product", product)
	out["title"] = bigCommerceVariationTitle(product, raw)
	out["price"] = firstNonNil(raw["calculated_price"], raw["price"], raw["sale_price"], raw["retail_price"])
	out["compare_at_price"] = bigCommerceCompareAtPrice(raw)
	out["inventory_quantity"] = firstNonNil(raw["inventory_level"], raw["inventory_quantity"])
	out["inventory_policy"] = bigCommerceInventoryPolicy(raw)
	out["available"] = !boolField(raw, "purchasing_disabled")
	out["image_url"] = stringField(raw, "image_url")
	out["url"] = stringField(mapField(product, "custom_url"), "url")
	for idx, option := range bigCommerceVariantOptions(raw["option_values"]) {
		if idx >= 3 {
			break
		}
		out[fmt.Sprintf("option%d", idx+1)] = option["value"]
		out[fmt.Sprintf("option%d_name", idx+1)] = option["name"]
	}
	return out
}

func bigCommerceVariationTitle(product map[string]any, raw map[string]any) string {
	productTitle := firstNonEmpty(stringField(product, "name"), stringField(product, "title"))
	options := []string{}
	for _, option := range bigCommerceVariantOptions(raw["option_values"]) {
		if value := stringField(option, "value"); value != "" {
			options = append(options, value)
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

func bigCommerceVariantOptions(v any) []map[string]any {
	items := rawArray(v)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		out = append(out, map[string]any{
			"id":        firstNonNil(m["id"], m["option_id"]),
			"name":      firstNonEmpty(stringField(m, "option_display_name"), stringField(m, "display_name"), stringField(m, "name")),
			"value":     firstNonEmpty(stringField(m, "label"), stringField(m, "display_value"), stringField(m, "value")),
			"option_id": firstNonNil(m["option_id"], m["id"]),
		})
	}
	return out
}

func bigCommerceProductImageURL(raw map[string]any) string {
	if image := mapField(raw, "primary_image"); image != nil {
		if url := firstNonEmpty(stringField(image, "url_standard"), stringField(image, "image_url"), stringField(image, "url_zoom"), stringField(image, "url_thumbnail")); url != "" {
			return url
		}
	}
	for _, item := range rawArray(raw["images"]) {
		image, _ := item.(map[string]any)
		if image == nil {
			continue
		}
		if url := firstNonEmpty(stringField(image, "url_standard"), stringField(image, "image_url"), stringField(image, "url_zoom"), stringField(image, "url_thumbnail")); url != "" {
			return url
		}
	}
	return ""
}

func bigCommerceOrderInput(raw map[string]any) OrderInput {
	email := stringField(mapField(raw, "billing_address"), "email")
	if email == "" {
		email = stringField(raw, "email")
	}
	return OrderInput{
		SourceID:      bigCommerceSourceID("order", raw),
		CustomerEmail: strings.ToLower(strings.TrimSpace(email)),
		Status:        bigCommerceOrderStatus(raw),
		SubtotalCents: cents(firstNonNil(raw["subtotal_inc_tax"], raw["subtotal_ex_tax"])),
		DiscountCents: cents(firstNonNil(raw["discount_amount"], raw["coupon_discount"])),
		ShippingCents: cents(firstNonNil(raw["shipping_cost_inc_tax"], raw["shipping_cost_ex_tax"])),
		TaxCents:      cents(raw["total_tax"]),
		TotalCents:    cents(firstNonNil(raw["total_inc_tax"], raw["total_ex_tax"])),
		Currency:      defaulted(strings.ToUpper(firstNonEmpty(stringField(raw, "currency_code"), stringField(raw, "default_currency_code"))), "USD"),
		Attribution:   bigCommerceOrderAttribution(raw),
		LineItems:     bigCommerceLineItems(raw["products"]),
		OrderedAt:     parseTimeAny(firstNonNil(raw["date_created"], raw["date_modified"])),
		Raw:           nonNilMap(raw),
	}
}

func bigCommerceOrderAttribution(raw map[string]any) map[string]any {
	return map[string]any{
		"source":           ProviderBigCommerce,
		"customer_id":      stringField(raw, "customer_id"),
		"cart_id":          stringField(raw, "cart_id"),
		"channel_id":       stringField(raw, "channel_id"),
		"payment_method":   stringField(raw, "payment_method"),
		"payment_provider": stringField(raw, "payment_provider_id"),
		"status":           stringField(raw, "status"),
		"status_id":        firstNonNil(raw["status_id"], ""),
		"discount_codes":   bigCommerceCouponCodes(raw["coupons"]),
		"coupon_lines":     bigCommerceCouponLines(raw["coupons"]),
	}
}

func bigCommerceLineItems(v any) []map[string]any {
	items := rawArray(v)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		out = append(out, map[string]any{
			"source_id":       bigCommerceSourceID("line_item", m),
			"product_id":      stringField(m, "product_id"),
			"variant_id":      stringField(m, "variant_id"),
			"title":           firstNonEmpty(stringField(m, "name"), stringField(m, "title")),
			"quantity":        intField(m, "quantity"),
			"price_cents":     cents(firstNonNil(m["price_inc_tax"], m["price_ex_tax"], m["base_price"])),
			"subtotal_cents":  cents(firstNonNil(m["total_inc_tax"], m["total_ex_tax"], m["base_total"])),
			"total_cents":     cents(firstNonNil(m["total_inc_tax"], m["total_ex_tax"], m["base_total"])),
			"total_tax_cents": cents(m["total_tax"]),
			"sku":             stringField(m, "sku"),
			"brand":           stringField(m, "brand"),
			"options":         rawArray(m["product_options"]),
			"discounts":       rawArray(m["applied_discounts"]),
			"raw":             nonNilMap(m),
		})
	}
	return out
}

func bigCommerceCouponCodes(v any) []string {
	items := rawArray(v)
	out := make([]string, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		code := stringField(m, "code")
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

func bigCommerceCouponLines(v any) []map[string]any {
	items := rawArray(v)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		out = append(out, map[string]any{
			"source_id":      bigCommerceSourceID("coupon", m),
			"code":           stringField(m, "code"),
			"amount_cents":   cents(firstNonNil(m["amount"], m["discount"])),
			"discount_cents": cents(firstNonNil(m["discount"], m["amount"])),
			"type":           firstNonNil(m["type"], ""),
			"raw":            nonNilMap(m),
		})
	}
	return out
}

func bigCommerceCustomerTags(raw map[string]any) []string {
	tags := stringSlice(raw["tags"])
	if groupID := strings.TrimSpace(fmt.Sprint(firstNonNil(raw["customer_group_id"], ""))); groupID != "" && groupID != "0" && groupID != "<nil>" {
		tags = append(tags, "bigcommerce_customer_group:"+groupID)
	}
	return tags
}

func bigCommerceCompareAtPrice(raw map[string]any) any {
	priceCents := cents(firstNonNil(raw["calculated_price"], raw["price"], raw["sale_price"]))
	for _, candidate := range []any{raw["retail_price"], raw["map_price"]} {
		if cents(candidate) > priceCents {
			return candidate
		}
	}
	return nil
}

func bigCommerceInventoryPolicy(raw map[string]any) string {
	if boolField(raw, "purchasing_disabled") {
		return "deny"
	}
	if strings.TrimSpace(fmt.Sprint(firstNonNil(raw["inventory_level"], ""))) == "" {
		return "unknown"
	}
	return "deny"
}

func bigCommerceOrderStatus(raw map[string]any) string {
	status := strings.ToLower(strings.TrimSpace(firstNonEmpty(stringField(raw, "status"), stringField(raw, "custom_status"))))
	switch status {
	case "completed", "shipped", "awaiting fulfillment", "awaiting shipment", "awaiting pickup", "partially shipped":
		return "paid"
	case "refunded", "partially refunded":
		return "refunded"
	case "cancelled", "canceled", "declined":
		return "cancelled"
	default:
		return "pending"
	}
}

func bigCommerceSourceID(kind string, raw map[string]any) string {
	id := strings.TrimSpace(fmt.Sprint(firstNonNil(raw["id"], raw["order_id"], raw["product_id"])))
	if id == "" || id == "<nil>" {
		return ""
	}
	return "bigcommerce://" + strings.TrimSpace(kind) + "/" + id
}

func bigCommerceStoreAPIBase(integration Integration, override string) (string, error) {
	storeHash, ok := normalizeBigCommerceStoreHash(firstNonEmpty(settingString(integration.Settings, "store_hash"), integration.ShopDomain))
	if !ok {
		return "", fmt.Errorf("bigcommerce store_hash is required")
	}
	base := strings.TrimRight(strings.TrimSpace(override), "/")
	if base == "" {
		base = "https://api.bigcommerce.com"
	}
	if strings.Contains(base, "/stores/") {
		return base, nil
	}
	return base + "/stores/" + storeHash, nil
}

func decodeBigCommerceBackfillCursor(cursor string) (bigCommerceBackfillState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return bigCommerceBackfillState{Object: "customers", Page: 1}, nil
	}
	if cursor == bigCommerceCursorComplete {
		return bigCommerceBackfillState{Object: "complete"}, nil
	}
	if !strings.HasPrefix(cursor, bigCommerceCursorPrefix) {
		return bigCommerceBackfillState{}, fmt.Errorf("invalid BigCommerce cursor")
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, bigCommerceCursorPrefix))
	if err != nil {
		return bigCommerceBackfillState{}, fmt.Errorf("decode BigCommerce cursor: %w", err)
	}
	var state bigCommerceBackfillState
	if err := json.Unmarshal(raw, &state); err != nil {
		return bigCommerceBackfillState{}, fmt.Errorf("parse BigCommerce cursor: %w", err)
	}
	state.Object = normalizeBigCommerceObject(state.Object)
	if state.Object == "" {
		state.Object = "customers"
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	return state, nil
}

func decodeBigCommerceRetryCursor(cursor string) (bigCommerceRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, bigCommerceRetryCursorPrefix) {
		return bigCommerceRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, bigCommerceRetryCursorPrefix))
	if err != nil {
		return bigCommerceRetryState{}, true, fmt.Errorf("decode BigCommerce retry cursor: %w", err)
	}
	var state bigCommerceRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return bigCommerceRetryState{}, true, fmt.Errorf("parse BigCommerce retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "customers", Page: 1})
	}
	if underlying, err := decodeBigCommerceBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.Page = underlying.Page
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeBigCommerceRetryCursor(state bigCommerceRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: "customers", Page: 1})
	}
	if underlying, err := decodeBigCommerceBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.Page = underlying.Page
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return bigCommerceRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func bigCommerceRetryCursorDue(state bigCommerceRetryState, now time.Time) bool {
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

func bigCommerceBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := bigCommerceRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeBigCommerceRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(bigCommerceRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeBigCommerceRetryCursor(state)
}

func bigCommerceRetryDelay(attempt int, err error) time.Duration {
	var rateLimit BigCommerceRateLimitError
	if err != nil && errors.As(err, &rateLimit) && rateLimit.RetryAfter > 0 {
		if rateLimit.RetryAfter > bigCommerceRetryMaxDelay {
			return bigCommerceRetryMaxDelay
		}
		return rateLimit.RetryAfter
	}
	if attempt <= 1 {
		return bigCommerceRetryInitialDelay
	}
	delay := bigCommerceRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= bigCommerceRetryMaxDelay {
			return bigCommerceRetryMaxDelay
		}
	}
	return delay
}

func bigCommerceRetryAfter(headers http.Header) time.Duration {
	if ms := intHeader(headers.Get("X-Rate-Limit-Time-Reset-Ms")); ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
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

func encodeBigCommerceBackfillCursor(state bigCommerceBackfillState) string {
	state.Object = normalizeBigCommerceObject(state.Object)
	if state.Object == "" {
		state.Object = "customers"
	}
	if state.Object == "complete" {
		return bigCommerceCursorComplete
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	raw, _ := json.Marshal(state)
	return bigCommerceCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func normalizeBigCommerceObject(object string) string {
	switch strings.ToLower(strings.TrimSpace(object)) {
	case "", "customer", "customers":
		return "customers"
	case "product", "products":
		return "products"
	case "order", "orders":
		return "orders"
	case "complete", "done":
		return "complete"
	default:
		return strings.ToLower(strings.TrimSpace(object))
	}
}

func nextBigCommerceBackfillObject(object string) string {
	object = normalizeBigCommerceObject(object)
	for idx, candidate := range bigCommerceObjectOrder {
		if candidate == object {
			if idx+1 < len(bigCommerceObjectOrder) {
				return bigCommerceObjectOrder[idx+1]
			}
			return "complete"
		}
	}
	return "complete"
}

func normalizeBigCommercePageSize(size int) int {
	if size <= 0 {
		return bigCommerceDefaultPageSize
	}
	if size > bigCommerceMaxPageSize {
		return bigCommerceMaxPageSize
	}
	return size
}

func mapsToAny(items []map[string]any) []any {
	out := make([]any, 0, len(items))
	for _, item := range items {
		out = append(out, item)
	}
	return out
}
