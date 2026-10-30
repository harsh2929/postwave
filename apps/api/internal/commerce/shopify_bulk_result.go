package commerce

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

const (
	shopifyBulkResultDefaultMaxLineBytes = 8 << 20
	shopifyBulkResultDefaultBatchSize    = 500
)

type ShopifyJSONLBulkResultImporter struct {
	HTTPClient           *http.Client
	MaxLineBytes         int
	AllowUnsafeLocalURLs bool
}

type ShopifyBulkResultBatchImporter interface {
	ImportBulkResultBatches(ctx context.Context, integration Integration, object, resultURL string, opts ShopifyBulkResultBatchImportOptions) (ShopifyBulkResultImportSummary, error)
}

type ShopifyBulkResultBatchImportOptions struct {
	SkipLines int64
	BatchSize int
	OnBatch   func(SyncRequest, int64) error
}

type ShopifyBulkResultImportSummary struct {
	LinesProcessed  int64
	LinesSkipped    int64
	BatchesImported int
	Customers       int
	Products        int
	Orders          int
}

func (i ShopifyJSONLBulkResultImporter) ImportBulkResult(ctx context.Context, integration Integration, object, resultURL string) (SyncRequest, error) {
	object = normalizeShopifyBackfillObject(object)
	if !validShopifyBackfillObject(object) || object == "complete" {
		return SyncRequest{}, fmt.Errorf("unsupported Shopify bulk result object %q", object)
	}
	if err := validateShopifyBulkResultURL(resultURL, i.AllowUnsafeLocalURLs); err != nil {
		return SyncRequest{}, err
	}
	client := commerceEgressClient(i.HTTPClient, ProviderShopify, 2*time.Minute)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, resultURL, nil)
	if err != nil {
		return SyncRequest{}, err
	}
	req.Header.Set("Accept", "application/jsonl, application/json, text/plain")
	resp, err := client.Do(req)
	if err != nil {
		return SyncRequest{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		raw, _ := readResponseBodyLimited(resp.Body, 4096)
		return SyncRequest{}, fmt.Errorf("shopify bulk result download %d: %s", resp.StatusCode, responseSnippet(raw))
	}
	return decodeShopifyBulkResultJSONL(resp.Body, object, i.maxLineBytes())
}

func (i ShopifyJSONLBulkResultImporter) ImportBulkResultBatches(ctx context.Context, integration Integration, object, resultURL string, opts ShopifyBulkResultBatchImportOptions) (ShopifyBulkResultImportSummary, error) {
	object = normalizeShopifyBackfillObject(object)
	if !validShopifyBackfillObject(object) || object == "complete" {
		return ShopifyBulkResultImportSummary{}, fmt.Errorf("unsupported Shopify bulk result object %q", object)
	}
	if err := validateShopifyBulkResultURL(resultURL, i.AllowUnsafeLocalURLs); err != nil {
		return ShopifyBulkResultImportSummary{}, err
	}
	client := commerceEgressClient(i.HTTPClient, ProviderShopify, 2*time.Minute)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, resultURL, nil)
	if err != nil {
		return ShopifyBulkResultImportSummary{}, err
	}
	req.Header.Set("Accept", "application/jsonl, application/json, text/plain")
	resp, err := client.Do(req)
	if err != nil {
		return ShopifyBulkResultImportSummary{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		raw, _ := readResponseBodyLimited(resp.Body, 4096)
		return ShopifyBulkResultImportSummary{}, fmt.Errorf("shopify bulk result download %d: %s", resp.StatusCode, responseSnippet(raw))
	}
	return decodeShopifyBulkResultJSONLBatches(resp.Body, object, i.maxLineBytes(), opts)
}

func (i ShopifyJSONLBulkResultImporter) maxLineBytes() int {
	if i.MaxLineBytes <= 0 {
		return shopifyBulkResultDefaultMaxLineBytes
	}
	return i.MaxLineBytes
}

func validateShopifyBulkResultURL(raw string, allowUnsafeLocal bool) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return fmt.Errorf("invalid Shopify bulk result URL: %w", err)
	}
	if u.Scheme != "https" {
		return fmt.Errorf("invalid Shopify bulk result URL: https is required")
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("invalid Shopify bulk result URL: missing host")
	}
	if allowUnsafeLocal {
		return nil
	}
	if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return fmt.Errorf("invalid Shopify bulk result URL: local host is not allowed")
	}
	if addr, err := netip.ParseAddr(host); err == nil && !addr.IsGlobalUnicast() {
		return fmt.Errorf("invalid Shopify bulk result URL: non-public address is not allowed")
	}
	if ip := net.ParseIP(host); ip != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()) {
		return fmt.Errorf("invalid Shopify bulk result URL: private address is not allowed")
	}
	return nil
}

func decodeShopifyBulkResultJSONL(r io.Reader, object string, maxLineBytes int) (SyncRequest, error) {
	switch normalizeShopifyBackfillObject(object) {
	case "customers":
		return decodeShopifyBulkCustomersJSONL(r, maxLineBytes)
	case "products":
		return decodeShopifyBulkProductsJSONL(r, maxLineBytes)
	case "orders":
		return decodeShopifyBulkOrdersJSONL(r, maxLineBytes)
	default:
		return SyncRequest{}, fmt.Errorf("unsupported Shopify bulk result object %q", object)
	}
}

func decodeShopifyBulkResultJSONLBatches(r io.Reader, object string, maxLineBytes int, opts ShopifyBulkResultBatchImportOptions) (ShopifyBulkResultImportSummary, error) {
	if opts.OnBatch == nil {
		return ShopifyBulkResultImportSummary{}, fmt.Errorf("Shopify bulk batch import callback is required")
	}
	if opts.SkipLines < 0 {
		opts.SkipLines = 0
	}
	opts.BatchSize = normalizeShopifyBulkResultBatchSize(opts.BatchSize)
	switch normalizeShopifyBackfillObject(object) {
	case "customers":
		return decodeShopifyBulkCustomersJSONLBatches(r, maxLineBytes, opts)
	case "products":
		return decodeShopifyBulkProductsJSONLBatches(r, maxLineBytes, opts)
	case "orders":
		return decodeShopifyBulkOrdersJSONLBatches(r, maxLineBytes, opts)
	default:
		return ShopifyBulkResultImportSummary{}, fmt.Errorf("unsupported Shopify bulk result object %q", object)
	}
}

func decodeShopifyBulkCustomersJSONL(r io.Reader, maxLineBytes int) (SyncRequest, error) {
	req := SyncRequest{}
	err := eachShopifyBulkJSONLRecord(r, maxLineBytes, func(raw map[string]any) error {
		if stringField(raw, "__parentId") != "" {
			return nil
		}
		req.Customers = append(req.Customers, shopifyCustomerFromBulkJSONL(raw))
		return nil
	})
	return req, err
}

func decodeShopifyBulkCustomersJSONLBatches(r io.Reader, maxLineBytes int, opts ShopifyBulkResultBatchImportOptions) (ShopifyBulkResultImportSummary, error) {
	summary := ShopifyBulkResultImportSummary{LinesSkipped: opts.SkipLines}
	batch := SyncRequest{}
	flush := func(lineOffset int64) error {
		return flushShopifyBulkResultBatch(&summary, &batch, lineOffset, opts.OnBatch)
	}
	linesRead, err := eachShopifyBulkJSONLRecordWithOffset(r, maxLineBytes, opts.SkipLines, func(raw map[string]any, lineOffset int64) error {
		if stringField(raw, "__parentId") != "" {
			return nil
		}
		batch.Customers = append(batch.Customers, shopifyCustomerFromBulkJSONL(raw))
		if len(batch.Customers) >= opts.BatchSize {
			return flush(lineOffset)
		}
		return nil
	})
	summary.LinesProcessed = maxInt64(summary.LinesProcessed, linesRead)
	if err != nil {
		return summary, err
	}
	return summary, flush(linesRead)
}

func decodeShopifyBulkProductsJSONL(r io.Reader, maxLineBytes int) (SyncRequest, error) {
	req := SyncRequest{}
	err := eachShopifyBulkJSONLRecord(r, maxLineBytes, func(raw map[string]any) error {
		if stringField(raw, "__parentId") != "" {
			return nil
		}
		req.Products = append(req.Products, shopifyProductFromBulkJSONL(raw))
		return nil
	})
	return req, err
}

func decodeShopifyBulkProductsJSONLBatches(r io.Reader, maxLineBytes int, opts ShopifyBulkResultBatchImportOptions) (ShopifyBulkResultImportSummary, error) {
	summary := ShopifyBulkResultImportSummary{LinesSkipped: opts.SkipLines}
	batch := SyncRequest{}
	flush := func(lineOffset int64) error {
		return flushShopifyBulkResultBatch(&summary, &batch, lineOffset, opts.OnBatch)
	}
	linesRead, err := eachShopifyBulkJSONLRecordWithOffset(r, maxLineBytes, opts.SkipLines, func(raw map[string]any, lineOffset int64) error {
		if stringField(raw, "__parentId") != "" {
			return nil
		}
		batch.Products = append(batch.Products, shopifyProductFromBulkJSONL(raw))
		if len(batch.Products) >= opts.BatchSize {
			return flush(lineOffset)
		}
		return nil
	})
	summary.LinesProcessed = maxInt64(summary.LinesProcessed, linesRead)
	if err != nil {
		return summary, err
	}
	return summary, flush(linesRead)
}

func decodeShopifyBulkOrdersJSONL(r io.Reader, maxLineBytes int) (SyncRequest, error) {
	roots := []map[string]any{}
	lineItemsByParent := map[string][]any{}
	err := eachShopifyBulkJSONLRecord(r, maxLineBytes, func(raw map[string]any) error {
		parentID := stringField(raw, "__parentId")
		if parentID != "" {
			lineItemsByParent[parentID] = append(lineItemsByParent[parentID], shopifyLineItemFromBulkJSONL(raw))
			return nil
		}
		roots = append(roots, raw)
		return nil
	})
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{Orders: make([]OrderInput, 0, len(roots))}
	for _, root := range roots {
		id := stringField(root, "id")
		req.Orders = append(req.Orders, shopifyOrderFromBulkJSONL(root, lineItemsByParent[id]))
	}
	return req, nil
}

func decodeShopifyBulkOrdersJSONLBatches(r io.Reader, maxLineBytes int, opts ShopifyBulkResultBatchImportOptions) (ShopifyBulkResultImportSummary, error) {
	summary := ShopifyBulkResultImportSummary{LinesSkipped: opts.SkipLines}
	batch := SyncRequest{}
	var pendingRoot map[string]any
	var pendingLineItems []any
	flushBatch := func(lineOffset int64) error {
		return flushShopifyBulkResultBatch(&summary, &batch, lineOffset, opts.OnBatch)
	}
	finalizePendingRoot := func(lineOffset int64) error {
		if pendingRoot == nil {
			return nil
		}
		batch.Orders = append(batch.Orders, shopifyOrderFromBulkJSONL(pendingRoot, pendingLineItems))
		pendingRoot = nil
		pendingLineItems = nil
		if len(batch.Orders) >= opts.BatchSize {
			return flushBatch(lineOffset)
		}
		return nil
	}
	linesRead, err := eachShopifyBulkJSONLRecordWithOffset(r, maxLineBytes, opts.SkipLines, func(raw map[string]any, lineOffset int64) error {
		parentID := stringField(raw, "__parentId")
		if parentID != "" {
			if pendingRoot != nil && parentID == stringField(pendingRoot, "id") {
				pendingLineItems = append(pendingLineItems, shopifyLineItemFromBulkJSONL(raw))
			}
			return nil
		}
		if err := finalizePendingRoot(lineOffset - 1); err != nil {
			return err
		}
		pendingRoot = raw
		pendingLineItems = nil
		return nil
	})
	summary.LinesProcessed = maxInt64(summary.LinesProcessed, linesRead)
	if err != nil {
		return summary, err
	}
	if err := finalizePendingRoot(linesRead); err != nil {
		return summary, err
	}
	return summary, flushBatch(linesRead)
}

func eachShopifyBulkJSONLRecord(r io.Reader, maxLineBytes int, fn func(map[string]any) error) error {
	_, err := eachShopifyBulkJSONLRecordWithOffset(r, maxLineBytes, 0, func(raw map[string]any, _ int64) error {
		return fn(raw)
	})
	return err
}

func eachShopifyBulkJSONLRecordWithOffset(r io.Reader, maxLineBytes int, skipLines int64, fn func(map[string]any, int64) error) (int64, error) {
	if maxLineBytes <= 0 {
		maxLineBytes = shopifyBulkResultDefaultMaxLineBytes
	}
	if skipLines < 0 {
		skipLines = 0
	}
	reader := bufio.NewReaderSize(r, 64*1024)
	var lineOffset int64
	for {
		line, err := readShopifyJSONLLine(reader, maxLineBytes)
		if err == io.EOF {
			return lineOffset, nil
		}
		if err != nil {
			return lineOffset, err
		}
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		lineOffset++
		if lineOffset <= skipLines {
			continue
		}
		var raw map[string]any
		dec := json.NewDecoder(bytes.NewReader(line))
		dec.UseNumber()
		if err := dec.Decode(&raw); err != nil {
			return lineOffset, fmt.Errorf("decode Shopify bulk JSONL: %w", err)
		}
		if err := fn(raw, lineOffset); err != nil {
			return lineOffset, err
		}
	}
}

func flushShopifyBulkResultBatch(summary *ShopifyBulkResultImportSummary, batch *SyncRequest, lineOffset int64, fn func(SyncRequest, int64) error) error {
	if batch == nil || !syncRequestHasPayload(*batch) {
		return nil
	}
	req := *batch
	if err := fn(req, lineOffset); err != nil {
		return err
	}
	summary.BatchesImported++
	summary.Customers += len(req.Customers)
	summary.Products += len(req.Products)
	summary.Orders += len(req.Orders)
	summary.LinesProcessed = maxInt64(summary.LinesProcessed, lineOffset)
	*batch = SyncRequest{}
	return nil
}

func normalizeShopifyBulkResultBatchSize(batchSize int) int {
	if batchSize <= 0 {
		return shopifyBulkResultDefaultBatchSize
	}
	if batchSize > 5000 {
		return 5000
	}
	return batchSize
}

func readShopifyJSONLLine(r *bufio.Reader, maxLineBytes int) ([]byte, error) {
	line := []byte{}
	for {
		part, isPrefix, err := r.ReadLine()
		if len(part) > 0 {
			line = append(line, part...)
			if len(line) > maxLineBytes {
				return nil, fmt.Errorf("Shopify bulk JSONL line exceeds %d bytes", maxLineBytes)
			}
		}
		if err != nil {
			if err == io.EOF && len(line) > 0 {
				return line, nil
			}
			return nil, err
		}
		if !isPrefix {
			return line, nil
		}
	}
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func shopifyCustomerFromBulkJSONL(raw map[string]any) CustomerInput {
	email := mapField(raw, "defaultEmailAddress")
	tags := stringSlice(raw["tags"])
	return shopifyCustomerFromGraphQL(
		stringField(raw, "id"),
		stringField(raw, "firstName"),
		stringField(raw, "lastName"),
		tags,
		&struct {
			EmailAddress   string `json:"emailAddress"`
			MarketingState string `json:"marketingState"`
		}{
			EmailAddress:   stringField(email, "emailAddress"),
			MarketingState: stringField(email, "marketingState"),
		},
	)
}

func shopifyProductFromBulkJSONL(raw map[string]any) ProductInput {
	imageURL := ""
	if featured := mapField(raw, "featuredMedia"); len(featured) > 0 {
		imageURL = stringField(mapField(featured, "image"), "url")
	}
	price := mapField(mapField(raw, "priceRangeV2"), "minVariantPrice")
	return shopifyProductFromGraphQL(
		stringField(raw, "id"),
		stringField(raw, "title"),
		stringField(raw, "handle"),
		stringField(raw, "onlineStoreUrl"),
		imageURL,
		shopifyMoney{Amount: stringField(price, "amount"), CurrencyCode: stringField(price, "currencyCode")},
	)
}

func shopifyOrderFromBulkJSONL(raw map[string]any, lineItems []any) OrderInput {
	mapped := map[string]any{
		"admin_graphql_api_id":     stringField(raw, "id"),
		"id":                       stringField(raw, "id"),
		"name":                     stringField(raw, "name"),
		"email":                    stringField(raw, "email"),
		"created_at":               stringField(raw, "createdAt"),
		"processed_at":             stringField(raw, "processedAt"),
		"updated_at":               stringField(raw, "updatedAt"),
		"cancelled_at":             stringField(raw, "cancelledAt"),
		"cancel_reason":            stringField(raw, "cancelReason"),
		"financial_status":         strings.ToLower(stringField(raw, "displayFinancialStatus")),
		"currency":                 stringField(raw, "currencyCode"),
		"subtotal_price":           moneyAmount(raw, "subtotalPriceSet"),
		"total_discounts":          moneyAmount(raw, "totalDiscountsSet"),
		"total_tax":                moneyAmount(raw, "totalTaxSet"),
		"total_price":              moneyAmount(raw, "totalPriceSet"),
		"total_shipping_price_set": moneySetRaw(raw, "totalShippingPriceSet"),
		"line_items":               lineItems,
		"source":                   "shopify_admin_graphql_bulk",
	}
	return orderFromMap(mapped)
}

func shopifyLineItemFromBulkJSONL(raw map[string]any) map[string]any {
	return map[string]any{
		"admin_graphql_api_id": stringField(raw, "id"),
		"id":                   stringField(raw, "id"),
		"product_id":           stringField(mapField(raw, "product"), "id"),
		"variant_id":           stringField(mapField(raw, "variant"), "id"),
		"title":                stringField(raw, "name"),
		"quantity":             intField(raw, "quantity"),
		"price":                moneyAmount(raw, "originalUnitPriceSet"),
	}
}

func moneyAmount(raw map[string]any, key string) string {
	return stringField(mapField(mapField(raw, key), "shopMoney"), "amount")
}

func moneyCurrency(raw map[string]any, key string) string {
	return stringField(mapField(mapField(raw, key), "shopMoney"), "currencyCode")
}

func moneySetRaw(raw map[string]any, key string) map[string]any {
	return map[string]any{
		"shop_money": map[string]any{
			"amount":        moneyAmount(raw, key),
			"currency_code": moneyCurrency(raw, key),
		},
	}
}

func mapField(raw map[string]any, key string) map[string]any {
	if raw == nil {
		return map[string]any{}
	}
	out, _ := raw[key].(map[string]any)
	if out != nil {
		return out
	}
	if nested, ok := raw[key].(string); ok {
		trimmed := strings.TrimSpace(nested)
		if strings.HasPrefix(trimmed, "{") {
			dec := json.NewDecoder(strings.NewReader(trimmed))
			dec.UseNumber()
			if err := dec.Decode(&out); err == nil && out != nil {
				return out
			}
		}
	}
	return map[string]any{}
}

func stringSlice(v any) []string {
	items, _ := v.([]any)
	if len(items) == 0 {
		if s := strings.TrimSpace(fmt.Sprint(v)); s != "" && s != "<nil>" {
			return parseTags(s)
		}
		return []string{}
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if s := strings.TrimSpace(fmt.Sprint(item)); s != "" {
			out = append(out, s)
		}
	}
	return out
}
