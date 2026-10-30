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
	squareCursorPrefix      = "square:"
	squareRetryCursorPrefix = "square_retry:"
	squareCursorComplete    = "square:complete"
	squareResponseMaxBytes  = 8 << 20
	squareDefaultPageSize   = 100
	squareMaxListPageSize   = 100
	squareMaxOrderPageSize  = 1000
	squareAPIVersion        = "2026-05-20"
	squareRetryInitialDelay = 15 * time.Minute
	squareRetryMaxDelay     = 6 * time.Hour
	squareCatalogPageSize   = 100
)

var squareBackfillObjectOrder = []string{"customers", "catalog_products", "orders", "payments", "refunds"}

type SquareCredentials struct {
	AccessToken         string
	WebhookSignatureKey string
}

type SquareCredentialResolver interface {
	ResolveSquare(context.Context, string, Integration) (SquareCredentials, error)
}

type SquareBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type SquareRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials SquareCredentialResolver
	APIBaseURL  string
	PageSize    int
}

type squareBackfillState struct {
	Object string `json:"object"`
	Cursor string `json:"cursor,omitempty"`
}

type squareRetryState struct {
	Cursor         string `json:"cursor"`
	Object         string `json:"object,omitempty"`
	ProviderCursor string `json:"provider_cursor,omitempty"`
	Attempts       int    `json:"attempts,omitempty"`
	NextAttemptAt  string `json:"next_attempt_at,omitempty"`
	LastStatus     string `json:"last_status,omitempty"`
	LastError      string `json:"last_error,omitempty"`
}

type squareAPIResponse struct {
	Customers []map[string]any `json:"customers"`
	Orders    []map[string]any `json:"orders"`
	Payments  []map[string]any `json:"payments"`
	Refunds   []map[string]any `json:"refunds"`
	Locations []map[string]any `json:"locations"`
	Objects   []map[string]any `json:"objects"`
	Related   []map[string]any `json:"related_objects"`
	Cursor    string           `json:"cursor"`
	Errors    []map[string]any `json:"errors"`
}

type SquareRateLimitError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e SquareRateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("square REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("square REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func (b SquareRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderSquare {
		return SyncRequest{}, fmt.Errorf("square backfill requires a Square integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("square credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveSquare(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("square access token is required")
	}
	state, err := decodeSquareBackfillCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "" {
		state = squareBackfillState{Object: "customers"}
	}
	if state.Object == "complete" {
		return SyncRequest{Cursor: squareCursorComplete}, nil
	}
	client := commerceEgressClient(b.HTTPClient, ProviderSquare, 30*time.Second)
	baseURL := strings.TrimRight(b.APIBaseURL, "/")
	if baseURL == "" {
		baseURL = "https://connect.squareup.com"
	}
	page, err := b.fetchPage(ctx, client, baseURL, creds, integration, state)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{}
	switch state.Object {
	case "customers":
		req.Customers = make([]CustomerInput, 0, len(page.Customers))
		for _, item := range page.Customers {
			req.Customers = append(req.Customers, squareCustomerInput(item))
		}
	case "catalog_products":
		products, deletions := squareCatalogProductChanges(page)
		req.Products = make([]ProductInput, 0, len(products))
		for _, item := range products {
			if item.SourceID != "" {
				req.Products = append(req.Products, item)
			}
		}
		req.ProductDeletions = make([]ProviderDeletion, 0, len(deletions))
		for _, deletion := range deletions {
			if deletion.SourceID != "" {
				req.ProductDeletions = append(req.ProductDeletions, deletion)
			}
		}
	case "orders":
		req.Orders = make([]OrderInput, 0, len(page.Orders))
		for _, item := range page.Orders {
			if order := squareOrderInput(item); order.SourceID != "" {
				req.Orders = append(req.Orders, order)
			}
		}
	case "payments":
		req.Orders = make([]OrderInput, 0, len(page.Payments))
		for _, item := range page.Payments {
			if order := squarePaymentOrder(item); order.SourceID != "" {
				req.Orders = append(req.Orders, order)
			}
		}
	case "refunds":
		req.ProviderEvents = make([]ProviderEventInput, 0, len(page.Refunds))
		for _, item := range page.Refunds {
			if event := squareRefundEvent("refund.created", item); event.SourceID != "" {
				req.ProviderEvents = append(req.ProviderEvents, event)
			}
		}
	default:
		return SyncRequest{}, fmt.Errorf("unsupported Square object %q", state.Object)
	}
	if strings.TrimSpace(page.Cursor) != "" {
		req.Cursor = encodeSquareBackfillCursor(squareBackfillState{Object: state.Object, Cursor: page.Cursor})
	} else {
		req.Cursor = encodeSquareBackfillCursor(squareBackfillState{Object: nextSquareBackfillObject(state.Object)})
	}
	return req, nil
}

func (b SquareRESTBackfiller) fetchPage(ctx context.Context, client *http.Client, baseURL string, creds SquareCredentials, integration Integration, state squareBackfillState) (squareAPIResponse, error) {
	switch state.Object {
	case "customers":
		body := map[string]any{
			"limit": normalizeSquareListPageSize(b.PageSize),
			"query": map[string]any{
				"sort": map[string]any{"field": "CREATED_AT", "order": "ASC"},
			},
		}
		if state.Cursor != "" {
			body["cursor"] = state.Cursor
		}
		return b.doJSON(ctx, client, baseURL, creds, http.MethodPost, "/v2/customers/search", nil, body)
	case "catalog_products":
		body := map[string]any{
			"object_types":            []string{"ITEM"},
			"include_related_objects": true,
			"include_deleted_objects": true,
			"limit":                   squareCatalogPageSize,
		}
		if state.Cursor != "" {
			body["cursor"] = state.Cursor
		}
		return b.doJSON(ctx, client, baseURL, creds, http.MethodPost, "/v2/catalog/search", nil, body)
	case "orders":
		locationIDs, err := b.squareLocationIDs(ctx, client, baseURL, creds, integration)
		if err != nil {
			return squareAPIResponse{}, err
		}
		if len(locationIDs) == 0 {
			return squareAPIResponse{Orders: []map[string]any{}}, nil
		}
		body := map[string]any{
			"location_ids":   locationIDs,
			"limit":          normalizeSquareOrderPageSize(b.PageSize),
			"return_entries": false,
			"query": map[string]any{
				"sort": map[string]any{"sort_field": "CLOSED_AT", "sort_order": "ASC"},
			},
		}
		if state.Cursor != "" {
			body["cursor"] = state.Cursor
		}
		return b.doJSON(ctx, client, baseURL, creds, http.MethodPost, "/v2/orders/search", nil, body)
	case "payments":
		q := url.Values{}
		q.Set("limit", strconv.Itoa(normalizeSquareListPageSize(b.PageSize)))
		q.Set("sort_order", "ASC")
		if state.Cursor != "" {
			q.Set("cursor", state.Cursor)
		}
		if locationID := squareLocationID(integration); locationID != "" {
			q.Set("location_id", locationID)
		}
		return b.doJSON(ctx, client, baseURL, creds, http.MethodGet, "/v2/payments", q, nil)
	case "refunds":
		q := url.Values{}
		q.Set("limit", strconv.Itoa(normalizeSquareListPageSize(b.PageSize)))
		q.Set("sort_order", "ASC")
		if state.Cursor != "" {
			q.Set("cursor", state.Cursor)
		}
		if locationID := squareLocationID(integration); locationID != "" {
			q.Set("location_id", locationID)
		}
		return b.doJSON(ctx, client, baseURL, creds, http.MethodGet, "/v2/refunds", q, nil)
	default:
		return squareAPIResponse{}, fmt.Errorf("unsupported Square object %q", state.Object)
	}
}

func (b SquareRESTBackfiller) squareLocationIDs(ctx context.Context, client *http.Client, baseURL string, creds SquareCredentials, integration Integration) ([]string, error) {
	if configured := squareLocationIDs(integration); len(configured) > 0 {
		return configured, nil
	}
	resp, err := b.doJSON(ctx, client, baseURL, creds, http.MethodGet, "/v2/locations", nil, nil)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, location := range resp.Locations {
		if strings.EqualFold(stringField(location, "status"), "INACTIVE") {
			continue
		}
		if id := strings.TrimSpace(stringField(location, "id")); id != "" {
			out = append(out, id)
		}
		if len(out) == 10 {
			break
		}
	}
	return out, nil
}

func (b SquareRESTBackfiller) doJSON(ctx context.Context, client *http.Client, baseURL string, creds SquareCredentials, method, path string, query url.Values, body any) (squareAPIResponse, error) {
	u, err := url.Parse(baseURL + path)
	if err != nil {
		return squareAPIResponse{}, err
	}
	if query != nil {
		u.RawQuery = query.Encode()
	}
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return squareAPIResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Square-Version", squareAPIVersion)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return squareAPIResponse{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := readResponseBodyLimited(resp.Body, squareResponseMaxBytes)
	if err != nil {
		return squareAPIResponse{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return squareAPIResponse{}, SquareRateLimitError{
				Path:       path,
				StatusCode: resp.StatusCode,
				RetryAfter: squareRetryAfter(resp.Header),
				Snippet:    responseSnippet(raw),
			}
		}
		return squareAPIResponse{}, fmt.Errorf("square REST %s failed %d: %s", path, resp.StatusCode, responseSnippet(raw))
	}
	var out squareAPIResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return squareAPIResponse{}, fmt.Errorf("decode square %s response: %w", path, err)
	}
	if len(out.Errors) > 0 {
		return squareAPIResponse{}, fmt.Errorf("square REST %s returned errors: %v", path, out.Errors)
	}
	return out, nil
}

func decodeSquareBackfillCursor(cursor string) (squareBackfillState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return squareBackfillState{}, nil
	}
	if cursor == squareCursorComplete {
		return squareBackfillState{Object: "complete"}, nil
	}
	if !strings.HasPrefix(cursor, squareCursorPrefix) {
		return squareBackfillState{}, fmt.Errorf("invalid Square cursor")
	}
	var state squareBackfillState
	if err := json.Unmarshal([]byte(strings.TrimPrefix(cursor, squareCursorPrefix)), &state); err != nil {
		return squareBackfillState{}, fmt.Errorf("decode Square cursor: %w", err)
	}
	state.Object = normalizeSquareBackfillObject(state.Object)
	state.Cursor = strings.TrimSpace(state.Cursor)
	return state, nil
}

func encodeSquareBackfillCursor(state squareBackfillState) string {
	state.Object = normalizeSquareBackfillObject(state.Object)
	if state.Object == "" || state.Object == "complete" {
		return squareCursorComplete
	}
	raw, _ := json.Marshal(state)
	return squareCursorPrefix + string(raw)
}

func nextSquareBackfillObject(object string) string {
	object = normalizeSquareBackfillObject(object)
	if object == "" {
		return squareBackfillObjectOrder[0]
	}
	for idx, item := range squareBackfillObjectOrder {
		if item == object {
			if idx+1 < len(squareBackfillObjectOrder) {
				return squareBackfillObjectOrder[idx+1]
			}
			return "complete"
		}
	}
	return "complete"
}

func normalizeSquareBackfillObject(object string) string {
	object = strings.TrimSpace(strings.ReplaceAll(object, "-", "_"))
	switch object {
	case "customer":
		return "customers"
	case "catalog_product", "catalog_products", "product", "products":
		return "catalog_products"
	case "order":
		return "orders"
	case "payment":
		return "payments"
	case "refund":
		return "refunds"
	default:
		return object
	}
}

func normalizeSquareListPageSize(size int) int {
	if size <= 0 {
		return squareDefaultPageSize
	}
	if size > squareMaxListPageSize {
		return squareMaxListPageSize
	}
	return size
}

func normalizeSquareOrderPageSize(size int) int {
	if size <= 0 {
		return 500
	}
	if size > squareMaxOrderPageSize {
		return squareMaxOrderPageSize
	}
	return size
}

func decodeSquareRetryCursor(cursor string) (squareRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, squareRetryCursorPrefix) {
		return squareRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, squareRetryCursorPrefix))
	if err != nil {
		return squareRetryState{}, true, fmt.Errorf("decode Square retry cursor: %w", err)
	}
	var state squareRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return squareRetryState{}, true, fmt.Errorf("parse Square retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeSquareBackfillCursor(squareBackfillState{Object: "customers"})
	}
	if underlying, err := decodeSquareBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.ProviderCursor = underlying.Cursor
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeSquareRetryCursor(state squareRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeSquareBackfillCursor(squareBackfillState{Object: "customers"})
	}
	if underlying, err := decodeSquareBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.ProviderCursor = underlying.Cursor
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return squareRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func squareRetryCursorDue(state squareRetryState, now time.Time) bool {
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

func squareBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := squareRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeSquareRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(squareRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeSquareRetryCursor(state)
}

func squareRetryDelay(attempt int, err error) time.Duration {
	var rateLimit SquareRateLimitError
	if err != nil && errors.As(err, &rateLimit) && rateLimit.RetryAfter > 0 {
		if rateLimit.RetryAfter > squareRetryMaxDelay {
			return squareRetryMaxDelay
		}
		return rateLimit.RetryAfter
	}
	if attempt <= 1 {
		return squareRetryInitialDelay
	}
	delay := squareRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= squareRetryMaxDelay {
			return squareRetryMaxDelay
		}
	}
	return delay
}

func squareRetryAfter(headers http.Header) time.Duration {
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

type squareWebhookEvent struct {
	MerchantID string `json:"merchant_id"`
	Type       string `json:"type"`
	EventID    string `json:"event_id"`
	CreatedAt  string `json:"created_at"`
	Data       struct {
		Type   string         `json:"type"`
		ID     string         `json:"id"`
		Object map[string]any `json:"object"`
	} `json:"data"`
}

func decodeSquareWebhookEvent(body []byte) (squareWebhookEvent, error) {
	var event squareWebhookEvent
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&event); err != nil {
		return squareWebhookEvent{}, fmt.Errorf("decode square webhook body: %w", err)
	}
	event.MerchantID = normalizeSquareMerchantID(event.MerchantID)
	event.Type = strings.TrimSpace(event.Type)
	event.EventID = strings.TrimSpace(event.EventID)
	if event.Data.Object == nil {
		event.Data.Object = map[string]any{}
	}
	return event, nil
}

func (d *Deps) dispatchSquareWebhook(ctx context.Context, integration *Integration, event squareWebhookEvent) error {
	if integration == nil {
		return nil
	}
	object := squareWebhookObject(event)
	switch strings.TrimSpace(event.Type) {
	case "customer.created", "customer.updated":
		in := squareCustomerInput(object)
		if in.SourceID == "" {
			return fmt.Errorf("square customer missing id")
		}
		return d.Repo.UpsertCustomer(ctx, integration.TenantID, integration.ID, in)
	case "customer.deleted":
		sourceID := squareIDSource("customer", firstNonEmpty(stringField(object, "id"), event.Data.ID))
		if sourceID == "" {
			return fmt.Errorf("square customer deletion missing id")
		}
		return d.Repo.DeleteCustomer(ctx, integration.TenantID, integration.ID, ProviderDeletion{
			SourceID: sourceID,
			Provider: ProviderSquare,
			Topic:    event.Type,
			Raw:      object,
		})
	case "catalog.version.updated":
		return d.refreshSquareCatalogProducts(ctx, integration)
	case "payment.created", "payment.updated":
		order := squarePaymentOrder(object)
		if order.SourceID == "" {
			return fmt.Errorf("square payment missing id")
		}
		return d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, order)
	case "refund.created", "refund.updated":
		providerEvent := squareRefundEvent(event.Type, object)
		if providerEvent.SourceID == "" {
			return fmt.Errorf("square refund missing id")
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, providerEvent)
	default:
		return nil
	}
}

func (d *Deps) refreshSquareCatalogProducts(ctx context.Context, integration *Integration) error {
	if integration == nil {
		return nil
	}
	if d == nil || d.Repo == nil {
		return fmt.Errorf("square catalog refresh requires commerce repo")
	}
	cursor := encodeSquareBackfillCursor(squareBackfillState{Object: "catalog_products"})
	backfiller := d.SquareBackfiller
	if backfiller == nil {
		backfiller = SquareRESTBackfiller{
			HTTPClient:  d.HTTPClient,
			Credentials: d.squareCredentialResolver(),
		}
	}
	if backfiller == nil {
		err := fmt.Errorf("square catalog refresh requires a Square backfiller")
		_ = d.Repo.SetIntegrationSync(ctx, integration.TenantID, integration.ID, squareBackfillRetryCursor(cursor, "WEBHOOK_REFRESH_FAILED", err, d.now()), d.now(), err)
		return err
	}
	req, err := backfiller.BackfillPage(ctx, integration.TenantID, *integration, cursor)
	if err != nil {
		retryCursor := squareBackfillRetryCursor(cursor, "WEBHOOK_REFRESH_FAILED", err, d.now())
		_ = d.Repo.SetIntegrationSync(ctx, integration.TenantID, integration.ID, retryCursor, d.now(), err)
		return err
	}
	if strings.TrimSpace(req.Cursor) != "" {
		cursor = req.Cursor
	} else {
		req.Cursor = cursor
	}
	if !syncRequestHasPayload(req) {
		return d.Repo.SetIntegrationSync(ctx, integration.TenantID, integration.ID, cursor, d.now(), nil)
	}
	if _, err := d.Repo.Sync(ctx, integration.TenantID, integration.ID, req, d.now()); err != nil {
		retryCursor := squareBackfillRetryCursor(cursor, "WEBHOOK_REFRESH_SYNC_FAILED", err, d.now())
		_ = d.Repo.SetIntegrationSync(ctx, integration.TenantID, integration.ID, retryCursor, d.now(), err)
		return err
	}
	return nil
}

func squareWebhookObject(event squareWebhookEvent) map[string]any {
	object := nonNilMap(event.Data.Object)
	for _, key := range []string{"customer", "payment", "refund", "order"} {
		if nested := mapField(object, key); len(nested) > 0 {
			return nested
		}
	}
	if typed := strings.TrimSpace(event.Data.Type); typed != "" {
		if nested := mapField(object, typed); len(nested) > 0 {
			return nested
		}
	}
	return object
}

func squareCustomerInput(raw map[string]any) CustomerInput {
	email := strings.ToLower(strings.TrimSpace(stringField(raw, "email_address")))
	sourceID := squareSourceID("customer", raw)
	return CustomerInput{
		SourceID:         sourceID,
		Email:            email,
		FirstName:        stringField(raw, "given_name"),
		LastName:         stringField(raw, "family_name"),
		AcceptsMarketing: !boolField(mapField(raw, "preferences"), "email_unsubscribed"),
		Tags:             []string{"square_customer"},
		Raw: map[string]any{
			"source":          ProviderSquare,
			"source_id":       sourceID,
			"company_name":    stringField(raw, "company_name"),
			"phone":           stringField(raw, "phone_number"),
			"reference_id":    stringField(raw, "reference_id"),
			"creation_source": stringField(raw, "creation_source"),
			"group_ids":       rawArray(raw["group_ids"]),
			"segment_ids":     rawArray(raw["segment_ids"]),
			"provider_raw":    nonNilMap(raw),
		},
	}
}

func squareOrderInput(raw map[string]any) OrderInput {
	sourceID := squareSourceID("order", raw)
	netAmounts := mapField(raw, "net_amounts")
	total := intField(mapField(raw, "total_money"), "amount")
	currency := strings.ToUpper(stringField(mapField(raw, "total_money"), "currency"))
	return OrderInput{
		SourceID:      sourceID,
		CustomerEmail: strings.ToLower(strings.TrimSpace(squareOrderEmail(raw))),
		Status:        squareOrderStatus(firstNonEmpty(stringField(raw, "state"), stringField(raw, "status"))),
		SubtotalCents: squareMoneyAmount(netAmounts, "total_money"),
		DiscountCents: squareMoneyAmount(netAmounts, "discount_money"),
		ShippingCents: squareMoneyAmount(netAmounts, "service_charge_money"),
		TaxCents:      squareMoneyAmount(netAmounts, "tax_money"),
		TotalCents:    total,
		Currency:      currency,
		Attribution: map[string]any{
			"source":             ProviderSquare,
			"object":             "order",
			"location_id":        stringField(raw, "location_id"),
			"customer_id":        stringField(raw, "customer_id"),
			"customer_source_id": squareIDSource("customer", stringField(raw, "customer_id")),
			"state":              stringField(raw, "state"),
			"ticket_name":        stringField(raw, "ticket_name"),
			"reference_id":       stringField(raw, "reference_id"),
			"version":            intField(raw, "version"),
			"fulfillments":       rawArray(raw["fulfillments"]),
			"tenders":            rawArray(raw["tenders"]),
			"returns":            rawArray(raw["returns"]),
			"refunds":            rawArray(raw["refunds"]),
			"provider_raw":       nonNilMap(raw),
		},
		LineItems: squareLineItems(raw),
		OrderedAt: squareTimePtr(firstNonEmpty(stringField(raw, "closed_at"), stringField(raw, "created_at"))),
		Raw: map[string]any{
			"source":       ProviderSquare,
			"source_id":    sourceID,
			"provider_raw": nonNilMap(raw),
		},
	}
}

func squarePaymentOrder(raw map[string]any) OrderInput {
	sourceID := squareSourceID("payment", raw)
	total := intField(mapField(raw, "total_money"), "amount")
	if total <= 0 {
		total = intField(mapField(raw, "amount_money"), "amount")
	}
	currency := strings.ToUpper(firstNonEmpty(
		stringField(mapField(raw, "total_money"), "currency"),
		stringField(mapField(raw, "amount_money"), "currency"),
	))
	return OrderInput{
		SourceID:      sourceID,
		CustomerEmail: strings.ToLower(strings.TrimSpace(stringField(raw, "buyer_email_address"))),
		Status:        squarePaymentStatus(stringField(raw, "status")),
		TotalCents:    total,
		Currency:      currency,
		Attribution: map[string]any{
			"source":              ProviderSquare,
			"object":              "payment",
			"order_source_id":     squareIDSource("order", stringField(raw, "order_id")),
			"order_id":            stringField(raw, "order_id"),
			"location_id":         stringField(raw, "location_id"),
			"customer_id":         stringField(raw, "customer_id"),
			"customer_source_id":  squareIDSource("customer", stringField(raw, "customer_id")),
			"source_type":         stringField(raw, "source_type"),
			"receipt_number":      stringField(raw, "receipt_number"),
			"receipt_url":         stringField(raw, "receipt_url"),
			"delay_action":        stringField(raw, "delay_action"),
			"delayed_until":       stringField(raw, "delayed_until"),
			"card_details":        nonNilMap(mapField(raw, "card_details")),
			"processing_fee":      rawArray(raw["processing_fee"]),
			"application_details": nonNilMap(mapField(raw, "application_details")),
			"risk_evaluation":     nonNilMap(mapField(raw, "risk_evaluation")),
			"version_token":       stringField(raw, "version_token"),
			"provider_raw":        nonNilMap(raw),
		},
		LineItems: []map[string]any{{
			"source_id":    sourceID + "/amount",
			"title":        firstNonEmpty(stringField(raw, "note"), "Square payment"),
			"quantity":     1,
			"total_cents":  total,
			"currency":     currency,
			"provider_raw": nonNilMap(raw),
		}},
		OrderedAt: squareTimePtr(stringField(raw, "created_at")),
		Raw: map[string]any{
			"source":       ProviderSquare,
			"source_id":    sourceID,
			"provider_raw": nonNilMap(raw),
		},
	}
}

func squareRefundEvent(topic string, raw map[string]any) ProviderEventInput {
	topic = strings.TrimSpace(topic)
	eventType := "refund_created"
	if strings.EqualFold(topic, "refund.updated") {
		eventType = "refund_updated"
	}
	sourceID := squareSourceID("refund", raw)
	amount := intField(mapField(raw, "amount_money"), "amount")
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderSquare,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: eventType + ":" + sourceID,
		Metadata: map[string]any{
			"source":          ProviderSquare,
			"topic":           topic,
			"object":          "refund",
			"source_id":       sourceID,
			"amount_cents":    amount,
			"refund_cents":    absoluteCents(amount),
			"currency":        strings.ToUpper(stringField(mapField(raw, "amount_money"), "currency")),
			"status":          stringField(raw, "status"),
			"reason":          stringField(raw, "reason"),
			"payment_id":      stringField(raw, "payment_id"),
			"payment_source":  squareIDSource("payment", stringField(raw, "payment_id")),
			"order_id":        stringField(raw, "order_id"),
			"order_source_id": squareIDSource("order", stringField(raw, "order_id")),
			"location_id":     stringField(raw, "location_id"),
			"created_at":      stringField(raw, "created_at"),
			"updated_at":      stringField(raw, "updated_at"),
			"processing_fee":  rawArray(raw["processing_fee"]),
			"provider_raw":    nonNilMap(raw),
		},
	}
}

func squareCatalogProductChanges(page squareAPIResponse) ([]ProductInput, []ProviderDeletion) {
	related := squareCatalogRelatedByID(page.Related)
	products := []ProductInput{}
	deletions := []ProviderDeletion{}
	for _, object := range page.Objects {
		if !strings.EqualFold(stringField(object, "type"), "ITEM") {
			continue
		}
		if boolField(object, "is_deleted") {
			if deletion := squareCatalogProductDeletion(object); deletion.SourceID != "" {
				deletions = append(deletions, deletion)
			}
			continue
		}
		product := squareCatalogProductInput(object, related)
		if product.SourceID != "" {
			products = append(products, product)
		}
	}
	return products, deletions
}

func squareCatalogProductDeletion(raw map[string]any) ProviderDeletion {
	sourceID := squareIDSource("product", stringField(raw, "id"))
	if sourceID == "" {
		return ProviderDeletion{}
	}
	return ProviderDeletion{
		SourceID: sourceID,
		Provider: ProviderSquare,
		Topic:    "catalog.item.deleted",
		Raw: map[string]any{
			"source":         ProviderSquare,
			"source_id":      sourceID,
			"catalog_object": nonNilMap(raw),
		},
	}
}

func squareCatalogRelatedByID(objects []map[string]any) map[string]map[string]any {
	out := make(map[string]map[string]any, len(objects))
	for _, object := range objects {
		if id := stringField(object, "id"); id != "" {
			out[id] = object
		}
	}
	return out
}

func squareCatalogProductInput(raw map[string]any, related map[string]map[string]any) ProductInput {
	data := mapField(raw, "item_data")
	sourceID := squareSourceID("product", raw)
	variants := squareCatalogProductVariants(raw, data)
	price, currency := squareCatalogPrimaryPrice(variants)
	imageURL := squareCatalogImageURL(data, related)
	return ProductInput{
		SourceID:   sourceID,
		Title:      firstNonEmpty(stringField(data, "name"), stringField(raw, "id")),
		URL:        firstNonEmpty(stringField(data, "ecom_uri"), stringField(data, "url")),
		ImageURL:   imageURL,
		PriceCents: price,
		Currency:   currency,
		Raw: map[string]any{
			"source":            ProviderSquare,
			"source_id":         sourceID,
			"catalog_object":    nonNilMap(raw),
			"product_type":      stringField(data, "product_type"),
			"visibility":        stringField(data, "visibility"),
			"categories":        rawArray(data["categories"]),
			"image_ids":         rawArray(data["image_ids"]),
			"tax_ids":           rawArray(data["tax_ids"]),
			"modifier_list_ids": rawArray(data["modifier_list_info"]),
			"variants":          mapsToAny(variants),
		},
	}
}

func squareCatalogProductVariants(raw, itemData map[string]any) []map[string]any {
	items := rawArray(itemData["variations"])
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		variation, _ := item.(map[string]any)
		if variation == nil || boolField(variation, "is_deleted") {
			continue
		}
		data := mapField(variation, "item_variation_data")
		money := mapField(data, "price_money")
		sourceID := squareSourceID("variant", variation)
		if sourceID == "" {
			sourceID = squareSourceID("product", raw) + "/variation/" + stringField(data, "name")
		}
		out = append(out, map[string]any{
			"id":                 sourceID,
			"source_id":          sourceID,
			"sku":                stringField(data, "sku"),
			"title":              firstNonEmpty(stringField(data, "name"), stringField(itemData, "name")),
			"price":              float64(intField(money, "amount")) / 100,
			"currency":           strings.ToUpper(stringField(money, "currency")),
			"inventory_policy":   "unknown",
			"inventory_quantity": nil,
			"option1":            stringField(data, "name"),
			"pricing_type":       stringField(data, "pricing_type"),
			"item_id":            stringField(data, "item_id"),
			"ordinal":            intField(data, "ordinal"),
			"track_inventory":    boolField(data, "track_inventory"),
			"sellable":           boolField(data, "sellable"),
			"stockable":          boolField(data, "stockable"),
			"provider_raw":       nonNilMap(variation),
		})
	}
	return out
}

func squareCatalogPrimaryPrice(variants []map[string]any) (int, string) {
	for _, variant := range variants {
		price := cents(variant["price"])
		currency := strings.ToUpper(stringField(variant, "currency"))
		if price != 0 || currency != "" {
			return price, currency
		}
	}
	return 0, ""
}

func squareCatalogImageURL(itemData map[string]any, related map[string]map[string]any) string {
	for _, idValue := range rawArray(itemData["image_ids"]) {
		id := strings.TrimSpace(fmt.Sprint(idValue))
		if id == "" || id == "<nil>" {
			continue
		}
		image := related[id]
		imageData := mapField(image, "image_data")
		if url := firstNonEmpty(stringField(imageData, "url"), stringField(imageData, "image_url")); url != "" {
			return url
		}
	}
	return ""
}

func squareLineItems(raw map[string]any) []map[string]any {
	items := rawArray(raw["line_items"])
	out := make([]map[string]any, 0, len(items))
	for idx, item := range items {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		sourceID := squareIDSource("line_item", firstNonEmpty(stringField(m, "uid"), stringField(m, "catalog_object_id")))
		if sourceID == "" {
			sourceID = squareSourceID("order", raw) + "/line/" + strconv.Itoa(idx+1)
		}
		totalMoney := mapField(m, "total_money")
		if len(totalMoney) == 0 {
			totalMoney = mapField(m, "base_price_money")
		}
		out = append(out, map[string]any{
			"source_id":         sourceID,
			"title":             firstNonEmpty(stringField(m, "name"), stringField(m, "item_type"), "Square item"),
			"quantity":          squareQuantity(m),
			"total_cents":       intField(totalMoney, "amount"),
			"currency":          strings.ToUpper(firstNonEmpty(stringField(totalMoney, "currency"), stringField(mapField(raw, "total_money"), "currency"))),
			"catalog_object_id": stringField(m, "catalog_object_id"),
			"variation_name":    stringField(m, "variation_name"),
			"note":              stringField(m, "note"),
			"modifiers":         rawArray(m["modifiers"]),
			"discounts":         rawArray(m["discounts"]),
			"taxes":             rawArray(m["taxes"]),
			"provider_raw":      nonNilMap(m),
		})
	}
	return out
}

func squareMoneyAmount(raw map[string]any, key string) int {
	if len(raw) == 0 {
		return 0
	}
	return intField(mapField(raw, key), "amount")
}

func squareQuantity(raw map[string]any) int {
	q := strings.TrimSpace(stringField(raw, "quantity"))
	if q == "" {
		return intField(raw, "quantity")
	}
	n, err := strconv.Atoi(q)
	if err != nil || n <= 0 {
		return 1
	}
	return n
}

func squareOrderEmail(raw map[string]any) string {
	for _, item := range rawArray(raw["fulfillments"]) {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		if email := stringField(mapField(m, "recipient"), "email_address"); email != "" {
			return email
		}
	}
	return ""
}

func squareOrderStatus(status string) string {
	switch strings.ToUpper(strings.TrimSpace(status)) {
	case "COMPLETED":
		return "paid"
	case "CANCELED", "CANCELLED":
		return "cancelled"
	default:
		return "pending"
	}
}

func squarePaymentStatus(status string) string {
	switch strings.ToUpper(strings.TrimSpace(status)) {
	case "COMPLETED":
		return "paid"
	case "CANCELED", "CANCELLED", "FAILED":
		return "cancelled"
	default:
		return "pending"
	}
}

func squareSourceID(kind string, raw map[string]any) string {
	return squareIDSource(kind, stringField(raw, "id"))
}

func squareIDSource(kind, id string) string {
	id = strings.TrimSpace(id)
	if id == "" || id == "<nil>" {
		return ""
	}
	return "square://" + strings.TrimSpace(kind) + "/" + id
}

func normalizeSquareMerchantID(raw string) string {
	return strings.TrimRight(strings.TrimSpace(raw), "/")
}

func squareMerchantID(integration Integration) string {
	return normalizeSquareMerchantID(firstNonEmpty(
		settingString(integration.Settings, "merchant_id"),
		integration.ShopDomain,
	))
}

func squareLocationID(integration Integration) string {
	return strings.TrimSpace(firstNonEmpty(
		settingString(integration.Settings, "location_id"),
		settingString(integration.Settings, "default_location_id"),
	))
}

func squareLocationIDs(integration Integration) []string {
	out := []string{}
	if id := squareLocationID(integration); id != "" {
		out = append(out, id)
	}
	for _, key := range []string{"location_ids", "locations"} {
		switch values := integration.Settings[key].(type) {
		case []string:
			out = append(out, values...)
		case []any:
			for _, value := range values {
				out = append(out, strings.TrimSpace(fmt.Sprint(value)))
			}
		case string:
			for _, value := range strings.Split(values, ",") {
				out = append(out, strings.TrimSpace(value))
			}
		}
	}
	seen := map[string]struct{}{}
	clean := []string{}
	for _, id := range out {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		clean = append(clean, id)
		if len(clean) == 10 {
			break
		}
	}
	return clean
}

func squareWebhookNotificationURL(r *http.Request, integration *Integration) string {
	if integration != nil {
		if configured := firstNonEmpty(
			settingString(integration.Settings, "webhook_notification_url"),
			settingString(integration.Settings, "notification_url"),
			settingString(integration.Settings, "square_webhook_notification_url"),
		); configured != "" {
			return configured
		}
	}
	proto := strings.TrimSpace(firstNonEmpty(r.Header.Get("X-Forwarded-Proto"), r.URL.Scheme))
	if proto == "" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	host := strings.TrimSpace(firstNonEmpty(r.Header.Get("X-Forwarded-Host"), r.Host))
	if host == "" {
		return ""
	}
	return proto + "://" + host + r.URL.RequestURI()
}

func squareTimePtr(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return nil
	}
	utc := t.UTC()
	return &utc
}
