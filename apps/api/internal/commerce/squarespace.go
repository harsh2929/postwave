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

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const (
	squarespaceCursorPrefix      = "squarespace:"
	squarespaceRetryCursorPrefix = "squarespace_retry:"
	squarespaceCursorComplete    = "squarespace:complete"
	squarespaceResponseMaxBytes  = 8 << 20
	squarespaceRetryInitialDelay = 15 * time.Minute
	squarespaceRetryMaxDelay     = 6 * time.Hour
	squarespaceDefaultUserAgent  = "Moosewave Squarespace Commerce Integration"
)

var squarespaceBackfillObjectOrder = []string{"contacts", "products", "orders"}

type SquarespaceCredentials struct {
	AccessToken   string
	WebhookSecret string
	APIBaseURL    string
	UserAgent     string
}

type SquarespaceCredentialResolver interface {
	ResolveSquarespace(context.Context, string, Integration) (SquarespaceCredentials, error)
}

type SquarespaceBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type SquarespaceRecordFetcher interface {
	FetchSquarespaceOrder(ctx context.Context, tenantID string, integration Integration, orderID string) (OrderInput, error)
}

type SquarespaceRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials SquarespaceCredentialResolver
	APIBaseURL  string
	UserAgent   string
}

type squarespaceBackfillState struct {
	Object string `json:"object"`
	Cursor string `json:"cursor,omitempty"`
}

type squarespaceRetryState struct {
	Cursor         string `json:"cursor"`
	Object         string `json:"object,omitempty"`
	ProviderCursor string `json:"provider_cursor,omitempty"`
	Attempts       int    `json:"attempts,omitempty"`
	NextAttemptAt  string `json:"next_attempt_at,omitempty"`
	LastStatus     string `json:"last_status,omitempty"`
	LastError      string `json:"last_error,omitempty"`
}

type squarespaceListResponse struct {
	Contacts   []map[string]any `json:"contacts"`
	Products   []map[string]any `json:"products"`
	Result     []map[string]any `json:"result"`
	Pagination map[string]any   `json:"pagination"`
}

type SquarespaceRateLimitError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e SquarespaceRateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("squarespace REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("squarespace REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func (b SquarespaceRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderSquarespace {
		return SyncRequest{}, fmt.Errorf("squarespace backfill requires a Squarespace Commerce integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("squarespace credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveSquarespace(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	token := strings.TrimSpace(creds.AccessToken)
	if token == "" {
		return SyncRequest{}, fmt.Errorf("squarespace access token or API key is required")
	}
	state, err := decodeSquarespaceBackfillCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "complete" {
		return SyncRequest{Cursor: squarespaceCursorComplete}, nil
	}
	client := commerceEgressClient(b.HTTPClient, ProviderSquarespace, 30*time.Second)
	baseURL := strings.TrimRight(firstNonEmpty(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), "https://api.squarespace.com"), "/")
	userAgent := firstNonEmpty(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), squarespaceDefaultUserAgent)
	page, err := b.fetchPage(ctx, client, baseURL, token, userAgent, state)
	if err != nil {
		return SyncRequest{}, err
	}
	items := page.items(state.Object)
	req := SyncRequest{}
	switch state.Object {
	case "contacts":
		req.Customers = make([]CustomerInput, 0, len(items))
		for _, item := range items {
			if customer := squarespaceContactCustomer(item); customer.SourceID != "" {
				req.Customers = append(req.Customers, customer)
			}
		}
	case "products":
		items, err = b.enrichProductDetails(ctx, client, baseURL, token, userAgent, items)
		if err != nil {
			return SyncRequest{}, err
		}
		req.Products = make([]ProductInput, 0, len(items))
		for _, item := range items {
			if product := squarespaceProductInput(item); product.SourceID != "" {
				req.Products = append(req.Products, product)
			}
		}
	case "orders":
		req.Orders = make([]OrderInput, 0, len(items))
		for _, item := range items {
			if order := squarespaceOrderInput(item); order.SourceID != "" {
				req.Orders = append(req.Orders, order)
			}
		}
	default:
		return SyncRequest{}, fmt.Errorf("unsupported Squarespace object %q", state.Object)
	}
	if next := page.nextCursor(); next != "" {
		req.Cursor = encodeSquarespaceBackfillCursor(squarespaceBackfillState{Object: state.Object, Cursor: next})
	} else {
		req.Cursor = encodeSquarespaceBackfillCursor(squarespaceBackfillState{Object: nextSquarespaceBackfillObject(state.Object)})
	}
	return req, nil
}

func (b SquarespaceRESTBackfiller) FetchSquarespaceOrder(ctx context.Context, tenantID string, integration Integration, orderID string) (OrderInput, error) {
	if integration.Provider != ProviderSquarespace {
		return OrderInput{}, fmt.Errorf("squarespace order fetch requires a Squarespace Commerce integration")
	}
	if strings.TrimSpace(orderID) == "" {
		return OrderInput{}, fmt.Errorf("squarespace order id is required")
	}
	if b.Credentials == nil {
		return OrderInput{}, fmt.Errorf("squarespace credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveSquarespace(ctx, tenantID, integration)
	if err != nil {
		return OrderInput{}, err
	}
	token := strings.TrimSpace(creds.AccessToken)
	if token == "" {
		return OrderInput{}, fmt.Errorf("squarespace access token or API key is required")
	}
	client := commerceEgressClient(b.HTTPClient, ProviderSquarespace, 30*time.Second)
	baseURL := strings.TrimRight(firstNonEmpty(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), "https://api.squarespace.com"), "/")
	userAgent := firstNonEmpty(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), squarespaceDefaultUserAgent)
	raw, err := squarespaceDoMap(ctx, client, baseURL, token, userAgent, http.MethodGet, "/1.0/commerce/orders/"+url.PathEscape(strings.TrimSpace(orderID)), nil)
	if err != nil {
		return OrderInput{}, err
	}
	return squarespaceOrderInput(raw), nil
}

func (b SquarespaceRESTBackfiller) fetchPage(ctx context.Context, client *http.Client, baseURL, token, userAgent string, state squarespaceBackfillState) (squarespaceListResponse, error) {
	path, err := squarespaceObjectPath(state.Object)
	if err != nil {
		return squarespaceListResponse{}, err
	}
	query := url.Values{}
	if cursor := strings.TrimSpace(state.Cursor); cursor != "" {
		query.Set("cursor", cursor)
	}
	return squarespaceDoList(ctx, client, baseURL, token, userAgent, path, query)
}

func (b SquarespaceRESTBackfiller) enrichProductDetails(ctx context.Context, client *http.Client, baseURL, token, userAgent string, items []map[string]any) ([]map[string]any, error) {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		id := stringField(item, "id")
		if id == "" || !squarespaceProductNeedsDetail(item) {
			continue
		}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return items, nil
	}
	details, err := squarespaceFetchProductDetails(ctx, client, baseURL, token, userAgent, ids)
	if err != nil {
		return nil, err
	}
	if len(details) == 0 {
		return items, nil
	}
	byID := make(map[string]map[string]any, len(details))
	for _, detail := range details {
		if id := stringField(detail, "id"); id != "" {
			byID[id] = detail
		}
	}
	out := append([]map[string]any(nil), items...)
	for idx, item := range out {
		if detail := byID[stringField(item, "id")]; len(detail) > 0 {
			out[idx] = mergeSquarespaceProductDetail(item, detail)
		}
	}
	return out, nil
}

func squarespaceFetchProductDetails(ctx context.Context, client *http.Client, baseURL, token, userAgent string, ids []string) ([]map[string]any, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	escaped := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id != "" {
			escaped = append(escaped, url.PathEscape(id))
		}
	}
	if len(escaped) == 0 {
		return nil, nil
	}
	page, err := squarespaceDoList(ctx, client, baseURL, token, userAgent, "/v2/commerce/products/"+strings.Join(escaped, ","), nil)
	if err != nil {
		return nil, err
	}
	return page.Products, nil
}

func squarespaceProductNeedsDetail(raw map[string]any) bool {
	if len(raw) == 0 {
		return false
	}
	if len(rawArray(raw["variants"])) == 0 && !squarespaceProductHasPrice(raw) {
		return true
	}
	if squarespaceProductImage(raw) == "" {
		return true
	}
	return false
}

func squarespaceProductHasPrice(raw map[string]any) bool {
	amount, currency := squarespaceProductPrice(raw)
	return amount != 0 || currency != ""
}

func mergeSquarespaceProductDetail(base, detail map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(detail))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range detail {
		out[k] = v
	}
	return out
}

func squarespaceDoList(ctx context.Context, client *http.Client, baseURL, token, userAgent, path string, query url.Values) (squarespaceListResponse, error) {
	raw, err := squarespaceDoRaw(ctx, client, baseURL, token, userAgent, http.MethodGet, path, query)
	if err != nil {
		return squarespaceListResponse{}, err
	}
	var out squarespaceListResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return squarespaceListResponse{}, fmt.Errorf("decode squarespace %s response: %w", path, err)
	}
	return out, nil
}

func squarespaceDoMap(ctx context.Context, client *http.Client, baseURL, token, userAgent, method, path string, query url.Values) (map[string]any, error) {
	raw, err := squarespaceDoRaw(ctx, client, baseURL, token, userAgent, method, path, query)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return nil, fmt.Errorf("decode squarespace %s response: %w", path, err)
	}
	return nonNilMap(out), nil
}

func squarespaceDoRaw(ctx context.Context, client *http.Client, baseURL, token, userAgent, method, path string, query url.Values) ([]byte, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + path)
	if err != nil {
		return nil, err
	}
	if query != nil {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstNonEmpty(userAgent, squarespaceDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := readResponseBodyLimited(resp.Body, squarespaceResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return nil, SquarespaceRateLimitError{Path: path, StatusCode: resp.StatusCode, RetryAfter: squarespaceRetryAfter(resp.Header), Snippet: responseSnippet(raw)}
		}
		return nil, fmt.Errorf("squarespace REST %s failed %d: %s", path, resp.StatusCode, responseSnippet(raw))
	}
	return raw, nil
}

func (p squarespaceListResponse) items(object string) []map[string]any {
	switch normalizeSquarespaceBackfillObject(object) {
	case "contacts":
		return p.Contacts
	case "products":
		return p.Products
	case "orders":
		return p.Result
	default:
		return nil
	}
}

func (p squarespaceListResponse) nextCursor() string {
	return firstNonEmpty(
		stringField(p.Pagination, "nextPageCursor"),
		stringField(p.Pagination, "cursor"),
	)
}

func squarespaceObjectPath(object string) (string, error) {
	switch normalizeSquarespaceBackfillObject(object) {
	case "contacts":
		return "/v1/contacts", nil
	case "products":
		return "/v2/commerce/products", nil
	case "orders":
		return "/1.0/commerce/orders", nil
	default:
		return "", fmt.Errorf("unsupported Squarespace object %q", object)
	}
}

func decodeSquarespaceBackfillCursor(cursor string) (squarespaceBackfillState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return squarespaceBackfillState{Object: "contacts"}, nil
	}
	if cursor == squarespaceCursorComplete {
		return squarespaceBackfillState{Object: "complete"}, nil
	}
	if !strings.HasPrefix(cursor, squarespaceCursorPrefix) {
		return squarespaceBackfillState{}, fmt.Errorf("invalid Squarespace cursor")
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, squarespaceCursorPrefix))
	if err != nil {
		return squarespaceBackfillState{}, fmt.Errorf("decode Squarespace cursor: %w", err)
	}
	var state squarespaceBackfillState
	if err := json.Unmarshal(raw, &state); err != nil {
		return squarespaceBackfillState{}, fmt.Errorf("parse Squarespace cursor: %w", err)
	}
	state.Object = normalizeSquarespaceBackfillObject(state.Object)
	if !validSquarespaceBackfillObject(state.Object) {
		return squarespaceBackfillState{}, fmt.Errorf("invalid Squarespace cursor object")
	}
	return state, nil
}

func encodeSquarespaceBackfillCursor(state squarespaceBackfillState) string {
	state.Object = normalizeSquarespaceBackfillObject(state.Object)
	if state.Object == "" || state.Object == "complete" {
		return squarespaceCursorComplete
	}
	raw, _ := json.Marshal(state)
	return squarespaceCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func nextSquarespaceBackfillObject(object string) string {
	object = normalizeSquarespaceBackfillObject(object)
	for idx, item := range squarespaceBackfillObjectOrder {
		if item == object {
			if idx+1 < len(squarespaceBackfillObjectOrder) {
				return squarespaceBackfillObjectOrder[idx+1]
			}
			return "complete"
		}
	}
	return "complete"
}

func normalizeSquarespaceBackfillObject(object string) string {
	object = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(object, "-", "_")))
	switch object {
	case "customer", "customers", "contact":
		return "contacts"
	case "product":
		return "products"
	case "order":
		return "orders"
	default:
		return object
	}
}

func validSquarespaceBackfillObject(object string) bool {
	if object == "complete" {
		return true
	}
	for _, item := range squarespaceBackfillObjectOrder {
		if item == object {
			return true
		}
	}
	return false
}

func decodeSquarespaceRetryCursor(cursor string) (squarespaceRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, squarespaceRetryCursorPrefix) {
		return squarespaceRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, squarespaceRetryCursorPrefix))
	if err != nil {
		return squarespaceRetryState{}, true, fmt.Errorf("decode Squarespace retry cursor: %w", err)
	}
	var state squarespaceRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return squarespaceRetryState{}, true, fmt.Errorf("parse Squarespace retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeSquarespaceBackfillCursor(squarespaceBackfillState{Object: "contacts"})
	}
	if underlying, err := decodeSquarespaceBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.ProviderCursor = underlying.Cursor
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeSquarespaceRetryCursor(state squarespaceRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeSquarespaceBackfillCursor(squarespaceBackfillState{Object: "contacts"})
	}
	if underlying, err := decodeSquarespaceBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.ProviderCursor = underlying.Cursor
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return squarespaceRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func squarespaceRetryCursorDue(state squarespaceRetryState, now time.Time) bool {
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

func squarespaceBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := squarespaceRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeSquarespaceRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(squarespaceRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeSquarespaceRetryCursor(state)
}

func squarespaceRetryDelay(attempt int, err error) time.Duration {
	var rateLimit SquarespaceRateLimitError
	if err != nil && errors.As(err, &rateLimit) && rateLimit.RetryAfter > 0 {
		if rateLimit.RetryAfter > squarespaceRetryMaxDelay {
			return squarespaceRetryMaxDelay
		}
		return rateLimit.RetryAfter
	}
	if attempt <= 1 {
		return squarespaceRetryInitialDelay
	}
	delay := squarespaceRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= squarespaceRetryMaxDelay {
			return squarespaceRetryMaxDelay
		}
	}
	return delay
}

func squarespaceRetryAfter(headers http.Header) time.Duration {
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

type squarespaceWebhookEvent struct {
	ID             string         `json:"id"`
	WebsiteID      string         `json:"websiteId"`
	SubscriptionID string         `json:"subscriptionId"`
	Topic          string         `json:"topic"`
	CreatedOn      string         `json:"createdOn"`
	Data           map[string]any `json:"data"`
	Raw            map[string]any `json:"-"`
}

func decodeSquarespaceWebhookEvent(body []byte) (squarespaceWebhookEvent, error) {
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return squarespaceWebhookEvent{}, fmt.Errorf("decode squarespace webhook body: %w", err)
	}
	if raw == nil {
		raw = map[string]any{}
	}
	data := mapField(raw, "data")
	return squarespaceWebhookEvent{
		ID:             stringField(raw, "id"),
		WebsiteID:      stringField(raw, "websiteId"),
		SubscriptionID: stringField(raw, "subscriptionId"),
		Topic:          stringField(raw, "topic"),
		CreatedOn:      stringField(raw, "createdOn"),
		Data:           data,
		Raw:            raw,
	}, nil
}

func (d *Deps) SquarespaceWebhook(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 1 << 20
	body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Squarespace webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	event, err := decodeSquarespaceWebhookEvent(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	if strings.TrimSpace(event.WebsiteID) == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_website_id", "Squarespace webhook websiteId is required")
		return
	}
	if strings.TrimSpace(event.Topic) == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_topic", "Squarespace webhook topic is required")
		return
	}
	if strings.TrimSpace(event.ID) == "" {
		event.ID = localWebhookID(event.WebsiteID, event.Topic, body)
	}
	integration, err := d.Repo.FindSquarespaceIntegrationBySiteID(r.Context(), event.WebsiteID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "squarespace integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resolver := d.squarespaceCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Squarespace credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveSquarespace(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifySquarespaceWebhookSignature(creds.WebhookSecret, body, r.Header.Get("Squarespace-Signature")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderSquarespace, event.ID, event.Topic, body)
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
	if err := d.dispatchSquarespaceWebhook(r.Context(), integration, event); err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderSquarespace, event.ID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderSquarespace, event.ID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (d *Deps) dispatchSquarespaceWebhook(ctx context.Context, integration *Integration, event squarespaceWebhookEvent) error {
	if integration == nil {
		return nil
	}
	topic := strings.ToLower(strings.TrimSpace(event.Topic))
	switch topic {
	case "order.create", "order.update":
		orderRaw := squarespaceWebhookOrderRaw(event)
		order := squarespaceOrderInput(orderRaw)
		if order.SourceID == "" {
			orderID := firstNonEmpty(stringField(event.Data, "orderId"), stringField(event.Data, "id"))
			fetcher := d.squarespaceRecordFetcher()
			if fetcher == nil {
				return fmt.Errorf("squarespace order webhook missing order payload and record fetcher is not configured")
			}
			var err error
			order, err = fetcher.FetchSquarespaceOrder(ctx, integration.TenantID, *integration, orderID)
			if err != nil {
				return err
			}
		}
		if order.SourceID == "" {
			return fmt.Errorf("squarespace order webhook missing order id")
		}
		return d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, order)
	case "contact.create", "contact.update":
		customer := squarespaceContactCustomer(squarespaceWebhookContactRaw(event))
		if customer.SourceID == "" {
			return fmt.Errorf("squarespace contact webhook missing contact id")
		}
		return d.Repo.UpsertCustomer(ctx, integration.TenantID, integration.ID, customer)
	case "contact.delete":
		contactID := firstNonEmpty(stringField(event.Data, "contactId"), stringField(event.Data, "id"))
		if contactID == "" {
			return fmt.Errorf("squarespace contact delete webhook missing contact id")
		}
		return d.Repo.DeleteCustomer(ctx, integration.TenantID, integration.ID, ProviderDeletion{
			SourceID: squarespaceSourceID("contact", contactID),
			Provider: ProviderSquarespace,
			Topic:    topic,
			Raw:      nonNilMap(event.Raw),
		})
	case "extension.uninstall":
		_, err := d.Repo.SetIntegrationStatus(ctx, integration.TenantID, integration.ID, "disconnected")
		return err
	default:
		return nil
	}
}

func squarespaceWebhookOrderRaw(event squarespaceWebhookEvent) map[string]any {
	if order := mapField(event.Data, "order"); len(order) > 0 {
		return order
	}
	return map[string]any{}
}

func squarespaceWebhookContactRaw(event squarespaceWebhookEvent) map[string]any {
	if contact := mapField(event.Data, "contact"); len(contact) > 0 {
		return contact
	}
	return map[string]any{}
}

func squarespaceContactCustomer(raw map[string]any) CustomerInput {
	id := firstNonEmpty(stringField(raw, "contactId"), stringField(raw, "id"))
	primaryEmail := mapField(raw, "primaryEmail")
	email := firstNonEmpty(
		stringField(primaryEmail, "value"),
		stringField(primaryEmail, "email"),
		stringField(raw, "email"),
	)
	return CustomerInput{
		SourceID:         squarespaceSourceID("contact", id),
		Email:            strings.ToLower(strings.TrimSpace(email)),
		FirstName:        firstNonEmpty(stringField(raw, "firstName"), stringField(raw, "first_name")),
		LastName:         firstNonEmpty(stringField(raw, "lastName"), stringField(raw, "last_name")),
		AcceptsMarketing: squarespaceAcceptsMarketing(raw),
		Tags:             compactStrings([]string{"squarespace_contact"}),
		Raw: map[string]any{
			"source":                   ProviderSquarespace,
			"source_id":                squarespaceSourceID("contact", id),
			"default_shipping_address": mapField(raw, "defaultShippingAddress"),
			"provider_raw":             nonNilMap(raw),
		},
	}
}

func squarespaceProductInput(raw map[string]any) ProductInput {
	id := firstNonEmpty(stringField(raw, "id"), stringField(raw, "productId"))
	price, currency := squarespaceProductPrice(raw)
	slug := firstNonEmpty(stringField(raw, "urlSlug"), stringField(raw, "slug"))
	productURL := firstNonEmpty(stringField(raw, "url"), stringField(raw, "fullUrl"))
	if productURL == "" && slug != "" {
		productURL = "/shop/p/" + strings.Trim(slug, "/")
	}
	return ProductInput{
		SourceID:   squarespaceSourceID("product", id),
		Title:      firstNonEmpty(stringField(raw, "name"), stringField(raw, "title"), stringField(raw, "sku")),
		URL:        productURL,
		ImageURL:   squarespaceProductImage(raw),
		PriceCents: price,
		Currency:   strings.ToUpper(firstNonEmpty(currency, stringField(raw, "currency"), "USD")),
		Raw: map[string]any{
			"source":       ProviderSquarespace,
			"source_id":    squarespaceSourceID("product", id),
			"product_type": firstNonEmpty(stringField(raw, "type"), stringField(raw, "productType")),
			"visible":      firstNonNil(raw["visible"], raw["enabled"]),
			"variants":     rawArray(raw["variants"]),
			"images":       rawArray(raw["images"]),
			"provider_raw": nonNilMap(raw),
		},
	}
}

func squarespaceOrderInput(raw map[string]any) OrderInput {
	id := firstNonEmpty(stringField(raw, "id"), stringField(raw, "orderId"))
	total, currency := squarespaceMoney(mapField(raw, "grandTotal"))
	subtotal, _ := squarespaceMoney(mapField(raw, "subtotal"))
	discount, _ := squarespaceMoney(mapField(raw, "discountTotal"))
	shipping, _ := squarespaceMoney(mapField(raw, "shippingTotal"))
	tax, _ := squarespaceMoney(mapField(raw, "taxTotal"))
	return OrderInput{
		SourceID:      squarespaceSourceID("order", id),
		CustomerEmail: strings.ToLower(strings.TrimSpace(stringField(raw, "customerEmail"))),
		Status:        squarespaceOrderStatus(firstNonEmpty(stringField(raw, "paymentState"), stringField(raw, "fulfillmentStatus"))),
		SubtotalCents: subtotal,
		DiscountCents: absoluteCents(discount),
		ShippingCents: shipping,
		TaxCents:      tax,
		TotalCents:    total,
		Currency:      strings.ToUpper(firstNonEmpty(currency, stringField(raw, "currency"), "USD")),
		Attribution: map[string]any{
			"source":             ProviderSquarespace,
			"order_number":       stringField(raw, "orderNumber"),
			"customer_id":        stringField(raw, "customerId"),
			"channel":            stringField(raw, "channel"),
			"channel_name":       stringField(raw, "channelName"),
			"payment_state":      stringField(raw, "paymentState"),
			"fulfillment_status": stringField(raw, "fulfillmentStatus"),
			"testmode":           raw["testmode"],
			"provider_raw":       nonNilMap(raw),
		},
		LineItems: squarespaceLineItems(rawArray(raw["lineItems"]), currency),
		OrderedAt: parseTimeAny(firstNonNil(raw["createdOn"], raw["created_at"])),
		Raw: map[string]any{
			"source":       ProviderSquarespace,
			"source_id":    squarespaceSourceID("order", id),
			"provider_raw": nonNilMap(raw),
		},
	}
}

func squarespaceLineItems(items []any, fallbackCurrency string) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		price, currency := squarespaceMoney(mapField(m, "unitPricePaid"))
		quantity := maxInt(intField(m, "quantity"), 1)
		total := price * quantity
		out = append(out, map[string]any{
			"source_id":    squarespaceSourceID("order_item", firstNonEmpty(stringField(m, "id"), stringField(m, "productId"), stringField(m, "variantId"))),
			"product_id":   stringField(m, "productId"),
			"variant_id":   stringField(m, "variantId"),
			"sku":          stringField(m, "sku"),
			"title":        firstNonEmpty(stringField(m, "productName"), stringField(m, "name"), stringField(m, "title")),
			"quantity":     quantity,
			"price_cents":  price,
			"total_cents":  total,
			"currency":     strings.ToUpper(firstNonEmpty(currency, fallbackCurrency)),
			"image_url":    stringField(m, "imageUrl"),
			"options":      rawArray(m["variantOptions"]),
			"provider_raw": nonNilMap(m),
		})
	}
	if out == nil {
		return []map[string]any{}
	}
	return out
}

func squarespaceAcceptsMarketing(raw map[string]any) bool {
	if boolField(raw, "acceptsMarketing") {
		return true
	}
	email := mapField(raw, "primaryEmail")
	accepts := mapField(email, "acceptsMarketing")
	return boolField(accepts, "acceptsMarketing")
}

func squarespaceProductPrice(raw map[string]any) (int, string) {
	for _, candidate := range []map[string]any{
		mapField(raw, "pricing"),
		mapField(raw, "price"),
		mapField(raw, "basePrice"),
		mapField(raw, "salePrice"),
	} {
		if amount, currency := squarespacePriceCandidate(candidate); amount != 0 || currency != "" {
			return amount, currency
		}
	}
	for _, item := range rawArray(raw["variants"]) {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if amount, currency := squarespacePriceCandidate(mapField(m, "pricing")); amount != 0 || currency != "" {
			return amount, currency
		}
		if amount, currency := squarespacePriceCandidate(mapField(m, "price")); amount != 0 || currency != "" {
			return amount, currency
		}
	}
	return cents(raw["price"]), stringField(raw, "currency")
}

func squarespacePriceCandidate(raw map[string]any) (int, string) {
	if len(raw) == 0 {
		return 0, ""
	}
	for _, key := range []string{"salePrice", "basePrice", "price", "value"} {
		if nested := mapField(raw, key); len(nested) > 0 {
			if amount, currency := squarespaceMoney(nested); amount != 0 || currency != "" {
				return amount, currency
			}
		}
		if amount := raw[key]; amount != nil {
			return cents(amount), firstNonEmpty(stringField(raw, "currency"), stringField(raw, "currencyCode"))
		}
	}
	return squarespaceMoney(raw)
}

func squarespaceMoney(raw map[string]any) (int, string) {
	if len(raw) == 0 {
		return 0, ""
	}
	amount := firstNonNil(raw["value"], raw["amount"], raw["formattedAmount"])
	return cents(amount), strings.ToUpper(firstNonEmpty(stringField(raw, "currency"), stringField(raw, "currencyCode")))
}

func squarespaceProductImage(raw map[string]any) string {
	for _, key := range []string{"imageUrl", "thumbnailUrl", "assetUrl"} {
		if value := stringField(raw, key); value != "" {
			return value
		}
	}
	for _, item := range rawArray(raw["images"]) {
		if m, ok := item.(map[string]any); ok {
			for _, key := range []string{"url", "assetUrl", "imageUrl"} {
				if value := stringField(m, key); value != "" {
					return value
				}
			}
		}
	}
	return ""
}

func squarespaceOrderStatus(status string) string {
	switch strings.ToUpper(strings.TrimSpace(status)) {
	case "PAID", "AUTHORIZED", "PARTIALLY_PAID", "FULFILLED":
		return "paid"
	case "REFUNDED", "REFUND_PENDING", "REFUND_FAILED":
		return "refunded"
	case "CANCELED", "CANCELLED", "FAILED":
		return "cancelled"
	default:
		return "pending"
	}
}

func squarespaceSourceID(kind, id string) string {
	id = strings.TrimSpace(id)
	if id == "" || id == "<nil>" {
		return ""
	}
	return "squarespace://" + strings.TrimSpace(kind) + "/" + id
}

func normalizeSquarespaceSiteID(raw string) string {
	return strings.TrimSpace(raw)
}
