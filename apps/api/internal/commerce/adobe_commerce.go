package commerce

import (
	"bytes"
	"context"
	"crypto/subtle"
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
	adobeCommerceCursorPrefix      = "adobe_commerce:"
	adobeCommerceRetryCursorPrefix = "adobe_commerce_retry:"
	adobeCommerceCursorComplete    = "adobe_commerce:complete"
	adobeCommerceResponseMaxBytes  = 8 << 20
	adobeCommerceDefaultPageSize   = 100
	adobeCommerceMaxPageSize       = 300
	adobeCommerceRetryInitialDelay = 15 * time.Minute
	adobeCommerceRetryMaxDelay     = 6 * time.Hour
)

var adobeCommerceBackfillObjectOrder = []string{"customers", "products", "orders", "creditmemos"}

type AdobeCommerceCredentials struct {
	AccessToken    string
	WebhookSecret  string
	APIBaseURL     string
	DeploymentMode string
}

type AdobeCommerceCredentialResolver interface {
	ResolveAdobeCommerce(context.Context, string, Integration) (AdobeCommerceCredentials, error)
}

type AdobeCommerceBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type AdobeCommerceRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials AdobeCommerceCredentialResolver
	APIBaseURL  string
	PageSize    int
}

type adobeCommerceBackfillState struct {
	Object string `json:"object"`
	Page   int    `json:"page,omitempty"`
}

type adobeCommerceRetryState struct {
	Cursor        string `json:"cursor"`
	Object        string `json:"object,omitempty"`
	Page          int    `json:"page,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type adobeCommerceSearchResponse struct {
	Items      []map[string]any `json:"items"`
	TotalCount int              `json:"total_count"`
}

type AdobeCommerceRateLimitError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e AdobeCommerceRateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("adobe commerce REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("adobe commerce REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func (b AdobeCommerceRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderAdobeCommerce {
		return SyncRequest{}, fmt.Errorf("adobe commerce backfill requires an Adobe Commerce integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("adobe commerce credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveAdobeCommerce(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("adobe commerce access_token is required")
	}
	state, err := decodeAdobeCommerceBackfillCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "complete" {
		return SyncRequest{Cursor: adobeCommerceCursorComplete}, nil
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	client := commerceEgressClient(b.HTTPClient, ProviderAdobeCommerce, 30*time.Second)
	baseURL, storeHeader, err := adobeCommerceRESTBaseURL(integration, creds, b.APIBaseURL)
	if err != nil {
		return SyncRequest{}, err
	}
	page, err := b.fetchPage(ctx, client, baseURL, storeHeader, creds, state)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{}
	switch state.Object {
	case "customers":
		req.Customers = make([]CustomerInput, 0, len(page.Items))
		for _, item := range page.Items {
			if customer := adobeCommerceCustomerInput(item); customer.SourceID != "" {
				req.Customers = append(req.Customers, customer)
			}
		}
	case "products":
		req.Products = make([]ProductInput, 0, len(page.Items))
		for _, item := range page.Items {
			if product := adobeCommerceProductInput(item); product.SourceID != "" {
				req.Products = append(req.Products, product)
			}
		}
	case "orders":
		req.Orders = make([]OrderInput, 0, len(page.Items))
		for _, item := range page.Items {
			if order := adobeCommerceOrderInput(item); order.SourceID != "" {
				req.Orders = append(req.Orders, order)
			}
		}
	case "creditmemos":
		req.ProviderEvents = make([]ProviderEventInput, 0, len(page.Items))
		for _, item := range page.Items {
			if event := adobeCommerceCreditMemoEvent("creditmemo.created", item); event.SourceID != "" {
				req.ProviderEvents = append(req.ProviderEvents, event)
			}
		}
	default:
		return SyncRequest{}, fmt.Errorf("unsupported Adobe Commerce object %q", state.Object)
	}
	req.Cursor = encodeAdobeCommerceBackfillCursor(nextAdobeCommerceBackfillState(state, page, normalizeAdobeCommercePageSize(b.PageSize)))
	return req, nil
}

func (b AdobeCommerceRESTBackfiller) fetchPage(ctx context.Context, client *http.Client, baseURL, storeHeader string, creds AdobeCommerceCredentials, state adobeCommerceBackfillState) (adobeCommerceSearchResponse, error) {
	path, err := adobeCommerceObjectPath(state.Object)
	if err != nil {
		return adobeCommerceSearchResponse{}, err
	}
	q := url.Values{}
	q.Set("searchCriteria[currentPage]", strconv.Itoa(maxInt(state.Page, 1)))
	q.Set("searchCriteria[pageSize]", strconv.Itoa(normalizeAdobeCommercePageSize(b.PageSize)))
	q.Set("searchCriteria[sortOrders][0][field]", adobeCommerceSortField(state.Object))
	q.Set("searchCriteria[sortOrders][0][direction]", "ASC")
	return adobeCommerceDoJSON(ctx, client, baseURL, storeHeader, creds, http.MethodGet, path, q, nil)
}

func adobeCommerceDoJSON(ctx context.Context, client *http.Client, baseURL, storeHeader string, creds AdobeCommerceCredentials, method, path string, query url.Values, body any) (adobeCommerceSearchResponse, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + path)
	if err != nil {
		return adobeCommerceSearchResponse{}, err
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
		return adobeCommerceSearchResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	if strings.TrimSpace(storeHeader) != "" {
		req.Header.Set("Store", strings.TrimSpace(storeHeader))
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return adobeCommerceSearchResponse{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := readResponseBodyLimited(resp.Body, adobeCommerceResponseMaxBytes)
	if err != nil {
		return adobeCommerceSearchResponse{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return adobeCommerceSearchResponse{}, AdobeCommerceRateLimitError{
				Path:       path,
				StatusCode: resp.StatusCode,
				RetryAfter: adobeCommerceRetryAfter(resp.Header),
				Snippet:    responseSnippet(raw),
			}
		}
		return adobeCommerceSearchResponse{}, fmt.Errorf("adobe commerce REST %s failed %d: %s", path, resp.StatusCode, responseSnippet(raw))
	}
	var out adobeCommerceSearchResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return adobeCommerceSearchResponse{}, fmt.Errorf("decode adobe commerce %s response: %w", path, err)
	}
	return out, nil
}

func decodeAdobeCommerceBackfillCursor(cursor string) (adobeCommerceBackfillState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return adobeCommerceBackfillState{Object: "customers", Page: 1}, nil
	}
	if cursor == adobeCommerceCursorComplete {
		return adobeCommerceBackfillState{Object: "complete"}, nil
	}
	if !strings.HasPrefix(cursor, adobeCommerceCursorPrefix) {
		return adobeCommerceBackfillState{}, fmt.Errorf("invalid Adobe Commerce cursor")
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, adobeCommerceCursorPrefix))
	if err != nil {
		return adobeCommerceBackfillState{}, fmt.Errorf("decode Adobe Commerce cursor: %w", err)
	}
	var state adobeCommerceBackfillState
	if err := json.Unmarshal(raw, &state); err != nil {
		return adobeCommerceBackfillState{}, fmt.Errorf("parse Adobe Commerce cursor: %w", err)
	}
	state.Object = normalizeAdobeCommerceBackfillObject(state.Object)
	if state.Page <= 0 {
		state.Page = 1
	}
	if !validAdobeCommerceBackfillObject(state.Object) {
		return adobeCommerceBackfillState{}, fmt.Errorf("invalid Adobe Commerce cursor object")
	}
	return state, nil
}

func encodeAdobeCommerceBackfillCursor(state adobeCommerceBackfillState) string {
	state.Object = normalizeAdobeCommerceBackfillObject(state.Object)
	if state.Object == "" || state.Object == "complete" {
		return adobeCommerceCursorComplete
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	raw, _ := json.Marshal(state)
	return adobeCommerceCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func nextAdobeCommerceBackfillState(state adobeCommerceBackfillState, page adobeCommerceSearchResponse, pageSize int) adobeCommerceBackfillState {
	if pageSize <= 0 {
		pageSize = adobeCommerceDefaultPageSize
	}
	if len(page.Items) >= pageSize || (page.TotalCount > 0 && state.Page*pageSize < page.TotalCount) {
		state.Page++
		return state
	}
	return adobeCommerceBackfillState{Object: nextAdobeCommerceBackfillObject(state.Object), Page: 1}
}

func nextAdobeCommerceBackfillObject(object string) string {
	object = normalizeAdobeCommerceBackfillObject(object)
	if object == "" {
		return adobeCommerceBackfillObjectOrder[0]
	}
	for idx, item := range adobeCommerceBackfillObjectOrder {
		if item == object {
			if idx+1 < len(adobeCommerceBackfillObjectOrder) {
				return adobeCommerceBackfillObjectOrder[idx+1]
			}
			return "complete"
		}
	}
	return "complete"
}

func normalizeAdobeCommerceBackfillObject(object string) string {
	object = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(object, "-", "_")))
	switch object {
	case "customer":
		return "customers"
	case "product":
		return "products"
	case "order":
		return "orders"
	case "creditmemo", "credit_memo", "credit_memos", "refund", "refunds":
		return "creditmemos"
	default:
		return object
	}
}

func validAdobeCommerceBackfillObject(object string) bool {
	if object == "complete" {
		return true
	}
	for _, item := range adobeCommerceBackfillObjectOrder {
		if object == item {
			return true
		}
	}
	return false
}

func normalizeAdobeCommercePageSize(size int) int {
	if size <= 0 {
		return adobeCommerceDefaultPageSize
	}
	if size > adobeCommerceMaxPageSize {
		return adobeCommerceMaxPageSize
	}
	return size
}

func adobeCommerceObjectPath(object string) (string, error) {
	switch normalizeAdobeCommerceBackfillObject(object) {
	case "customers":
		return "/customers/search", nil
	case "products":
		return "/products", nil
	case "orders":
		return "/orders", nil
	case "creditmemos":
		return "/creditmemos", nil
	default:
		return "", fmt.Errorf("unsupported Adobe Commerce object %q", object)
	}
}

func adobeCommerceSortField(object string) string {
	switch normalizeAdobeCommerceBackfillObject(object) {
	case "products":
		return "entity_id"
	default:
		return "entity_id"
	}
}

func decodeAdobeCommerceRetryCursor(cursor string) (adobeCommerceRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, adobeCommerceRetryCursorPrefix) {
		return adobeCommerceRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, adobeCommerceRetryCursorPrefix))
	if err != nil {
		return adobeCommerceRetryState{}, true, fmt.Errorf("decode Adobe Commerce retry cursor: %w", err)
	}
	var state adobeCommerceRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return adobeCommerceRetryState{}, true, fmt.Errorf("parse Adobe Commerce retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeAdobeCommerceBackfillCursor(adobeCommerceBackfillState{Object: "customers", Page: 1})
	}
	if underlying, err := decodeAdobeCommerceBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.Page = underlying.Page
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeAdobeCommerceRetryCursor(state adobeCommerceRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeAdobeCommerceBackfillCursor(adobeCommerceBackfillState{Object: "customers", Page: 1})
	}
	if underlying, err := decodeAdobeCommerceBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.Page = underlying.Page
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return adobeCommerceRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func adobeCommerceRetryCursorDue(state adobeCommerceRetryState, now time.Time) bool {
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

func adobeCommerceBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := adobeCommerceRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeAdobeCommerceRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(adobeCommerceRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeAdobeCommerceRetryCursor(state)
}

func adobeCommerceRetryDelay(attempt int, err error) time.Duration {
	var rateLimit AdobeCommerceRateLimitError
	if err != nil && errors.As(err, &rateLimit) && rateLimit.RetryAfter > 0 {
		if rateLimit.RetryAfter > adobeCommerceRetryMaxDelay {
			return adobeCommerceRetryMaxDelay
		}
		return rateLimit.RetryAfter
	}
	if attempt <= 1 {
		return adobeCommerceRetryInitialDelay
	}
	delay := adobeCommerceRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= adobeCommerceRetryMaxDelay {
			return adobeCommerceRetryMaxDelay
		}
	}
	return delay
}

func adobeCommerceRetryAfter(headers http.Header) time.Duration {
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

func adobeCommerceRESTBaseURL(integration Integration, creds AdobeCommerceCredentials, override string) (string, string, error) {
	base := strings.TrimRight(firstNonEmpty(override, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), settingString(integration.Settings, "base_url")), "/")
	if base == "" {
		return "", "", fmt.Errorf("adobe commerce base_url is required")
	}
	mode := strings.ToLower(firstNonEmpty(creds.DeploymentMode, settingString(integration.Settings, "deployment_mode")))
	storeView := strings.TrimSpace(firstNonEmpty(settingString(integration.Settings, "store_view_code"), settingString(integration.Settings, "store")))
	if mode == "saas" || strings.Contains(strings.ToLower(base), ".api.commerce.adobe.com") {
		return strings.TrimRight(base, "/") + "/V1", firstNonEmpty(storeView, "default"), nil
	}
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, "/rest") || strings.Contains(base, "/rest/") {
		return strings.TrimRight(base, "/") + "/V1", "", nil
	}
	if storeView != "" {
		return base + "/rest/" + url.PathEscape(storeView) + "/V1", "", nil
	}
	return base + "/rest/V1", "", nil
}

type adobeCommerceWebhookEvent struct {
	Topic   string
	BaseURL string
	Payload map[string]any
}

func decodeAdobeCommerceWebhookEvent(body []byte, r *http.Request) (adobeCommerceWebhookEvent, error) {
	var payload map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&payload); err != nil {
		return adobeCommerceWebhookEvent{}, fmt.Errorf("decode adobe commerce webhook body: %w", err)
	}
	if payload == nil {
		payload = map[string]any{}
	}
	topic := firstNonEmpty(
		r.Header.Get("X-Adobe-Commerce-Event"),
		r.Header.Get("X-Magento-Event"),
		r.Header.Get("X-Postwave-Event"),
		r.URL.Query().Get("topic"),
		stringField(payload, "eventName"),
		stringField(payload, "event_name"),
		stringField(payload, "topic"),
		stringField(payload, "name"),
	)
	baseURL := firstNonEmpty(
		r.Header.Get("X-Adobe-Commerce-Base-Url"),
		r.Header.Get("X-Magento-Base-Url"),
		r.Header.Get("X-Postwave-Store-Url"),
		r.URL.Query().Get("base_url"),
		stringField(payload, "base_url"),
		stringField(payload, "store_base_url"),
		stringField(mapField(payload, "store"), "base_url"),
	)
	return adobeCommerceWebhookEvent{
		Topic:   strings.TrimSpace(topic),
		BaseURL: normalizeAdobeCommerceStoreBaseURL(baseURL),
		Payload: payload,
	}, nil
}

func (d *Deps) AdobeCommerceWebhook(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 1 << 20
	body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Adobe Commerce webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	event, err := decodeAdobeCommerceWebhookEvent(body, r)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	if event.BaseURL == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_base_url", "Adobe Commerce webhook base_url could not be resolved")
		return
	}
	if event.Topic == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_event", "Adobe Commerce webhook event topic is required")
		return
	}
	integration, err := d.Repo.FindAdobeCommerceIntegrationByBaseURL(r.Context(), event.BaseURL)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "adobe commerce integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resolver := d.adobeCommerceCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Adobe Commerce credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveAdobeCommerce(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if strings.TrimSpace(creds.WebhookSecret) == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_secret", "Adobe Commerce webhook shared secret is not configured")
		return
	}
	if !verifyAdobeCommerceWebhookSecret(creds.WebhookSecret, r.Header) {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "Adobe Commerce webhook shared secret did not match")
		return
	}
	webhookID := firstNonEmpty(
		r.Header.Get("X-Adobe-Commerce-Webhook-Id"),
		r.Header.Get("X-Magento-Webhook-Id"),
		r.Header.Get("X-Request-Id"),
		stringField(event.Payload, "webhook_id"),
		stringField(event.Payload, "event_id"),
		localWebhookID(event.BaseURL, event.Topic, body),
	)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderAdobeCommerce, webhookID, event.Topic, body)
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
	if err := d.dispatchAdobeCommerceWebhook(r.Context(), integration, event); err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderAdobeCommerce, webhookID, err)
		if d.Logger != nil {
			d.Logger.Warn("adobe commerce webhook dispatch failed", "base_url", event.BaseURL, "topic", event.Topic, "err", err.Error())
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderAdobeCommerce, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func verifyAdobeCommerceWebhookSecret(secret string, headers http.Header) bool {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return false
	}
	candidates := []string{
		headers.Get("X-Postwave-Webhook-Secret"),
		headers.Get("X-Adobe-Commerce-Webhook-Secret"),
		headers.Get("X-Magento-Webhook-Secret"),
		headers.Get("X-Webhook-Secret"),
	}
	if auth := strings.TrimSpace(headers.Get("Authorization")); strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		candidates = append(candidates, strings.TrimSpace(auth[len("bearer "):]))
	}
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(candidate), []byte(secret)) == 1 {
			return true
		}
	}
	return false
}

func (d *Deps) dispatchAdobeCommerceWebhook(ctx context.Context, integration *Integration, event adobeCommerceWebhookEvent) error {
	if integration == nil {
		return nil
	}
	topic := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(event.Topic, "/", ".")))
	switch {
	case strings.Contains(topic, "customer"):
		customer := adobeCommerceCustomerInput(adobeCommerceWebhookEntity(event, "customer"))
		if customer.SourceID == "" {
			return fmt.Errorf("adobe commerce customer webhook missing customer id")
		}
		return d.Repo.UpsertCustomer(ctx, integration.TenantID, integration.ID, customer)
	case strings.Contains(topic, "product") || strings.Contains(topic, "catalog"):
		product := adobeCommerceProductInput(adobeCommerceWebhookEntity(event, "product"))
		if product.SourceID == "" {
			return fmt.Errorf("adobe commerce product webhook missing product id")
		}
		return d.Repo.UpsertProduct(ctx, integration.TenantID, integration.ID, product)
	case strings.Contains(topic, "creditmemo") || strings.Contains(topic, "refund"):
		eventInput := adobeCommerceCreditMemoEvent(event.Topic, adobeCommerceWebhookEntity(event, "creditmemo"))
		if eventInput.SourceID == "" {
			return fmt.Errorf("adobe commerce credit memo webhook missing id")
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, eventInput)
	case strings.Contains(topic, "order") || strings.Contains(topic, "sales_order") || strings.Contains(topic, "invoice"):
		order := adobeCommerceOrderInput(adobeCommerceWebhookEntity(event, "order"))
		if order.SourceID == "" {
			return fmt.Errorf("adobe commerce order webhook missing order id")
		}
		return d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, order)
	default:
		return nil
	}
}

func adobeCommerceWebhookEntity(event adobeCommerceWebhookEvent, kind string) map[string]any {
	raw := nonNilMap(event.Payload)
	if entity := mapField(raw, kind); len(entity) > 0 {
		return entity
	}
	data := mapField(raw, "data")
	if entity := mapField(data, kind); len(entity) > 0 {
		return entity
	}
	singular := strings.TrimSuffix(kind, "s")
	if entity := mapField(raw, singular); len(entity) > 0 {
		return entity
	}
	if entity := mapField(data, singular); len(entity) > 0 {
		return entity
	}
	if kind == "creditmemo" {
		for _, key := range []string{"credit_memo", "refund"} {
			if entity := mapField(raw, key); len(entity) > 0 {
				return entity
			}
			if entity := mapField(data, key); len(entity) > 0 {
				return entity
			}
		}
	}
	if entity := mapField(data, "entity"); len(entity) > 0 {
		return entity
	}
	if len(data) > 0 && adobeCommercePayloadLooksLike(data, kind) {
		return data
	}
	if adobeCommercePayloadLooksLike(raw, kind) {
		return raw
	}
	return data
}

func adobeCommercePayloadLooksLike(raw map[string]any, kind string) bool {
	switch kind {
	case "customer":
		return stringField(raw, "email") != "" && firstNonEmpty(stringField(raw, "id"), stringField(raw, "entity_id"), stringField(raw, "customer_id")) != ""
	case "product":
		return firstNonEmpty(stringField(raw, "sku"), stringField(raw, "name")) != "" && firstNonEmpty(stringField(raw, "id"), stringField(raw, "entity_id"), stringField(raw, "sku")) != ""
	case "order":
		return firstNonEmpty(stringField(raw, "increment_id"), stringField(raw, "entity_id"), stringField(raw, "order_id")) != ""
	case "creditmemo":
		return firstNonEmpty(stringField(raw, "increment_id"), stringField(raw, "entity_id"), stringField(raw, "creditmemo_id")) != ""
	default:
		return false
	}
}

func adobeCommerceCustomerInput(raw map[string]any) CustomerInput {
	sourceID := adobeCommerceSourceID("customer", firstNonEmpty(stringField(raw, "id"), stringField(raw, "entity_id"), stringField(raw, "customer_id")))
	return CustomerInput{
		SourceID:         sourceID,
		Email:            strings.ToLower(strings.TrimSpace(stringField(raw, "email"))),
		FirstName:        firstNonEmpty(stringField(raw, "firstname"), stringField(raw, "first_name")),
		LastName:         firstNonEmpty(stringField(raw, "lastname"), stringField(raw, "last_name")),
		AcceptsMarketing: boolField(raw, "accepts_marketing"),
		Tags:             []string{"adobe_commerce_customer"},
		Raw: map[string]any{
			"source":            ProviderAdobeCommerce,
			"source_id":         sourceID,
			"group_id":          stringField(raw, "group_id"),
			"store_id":          stringField(raw, "store_id"),
			"website_id":        stringField(raw, "website_id"),
			"created_at":        stringField(raw, "created_at"),
			"updated_at":        stringField(raw, "updated_at"),
			"custom_attributes": rawArray(raw["custom_attributes"]),
			"addresses":         rawArray(raw["addresses"]),
			"provider_raw":      nonNilMap(raw),
		},
	}
}

func adobeCommerceProductInput(raw map[string]any) ProductInput {
	id := firstNonEmpty(stringField(raw, "id"), stringField(raw, "entity_id"), stringField(raw, "sku"))
	sourceID := adobeCommerceSourceID("product", id)
	currency := strings.ToUpper(firstNonEmpty(stringField(raw, "currency"), stringField(raw, "currency_code"), adobeCommerceCustomAttributeString(raw, "currency"), "USD"))
	urlKey := firstNonEmpty(adobeCommerceCustomAttributeString(raw, "url_key"), stringField(raw, "url_key"))
	productURL := firstNonEmpty(stringField(raw, "product_url"), stringField(raw, "url"))
	if productURL == "" && urlKey != "" {
		productURL = "/" + strings.Trim(urlKey, "/") + ".html"
	}
	priceCents := cents(firstNonNil(raw["price"], adobeCommerceCustomAttributeString(raw, "price")))
	return ProductInput{
		SourceID:   sourceID,
		Title:      firstNonEmpty(stringField(raw, "name"), stringField(raw, "title"), stringField(raw, "sku")),
		URL:        productURL,
		ImageURL:   adobeCommerceProductImage(raw),
		PriceCents: priceCents,
		Currency:   currency,
		Raw: map[string]any{
			"source":                ProviderAdobeCommerce,
			"source_id":             sourceID,
			"sku":                   stringField(raw, "sku"),
			"attribute_set_id":      stringField(raw, "attribute_set_id"),
			"type_id":               stringField(raw, "type_id"),
			"status":                stringField(raw, "status"),
			"visibility":            stringField(raw, "visibility"),
			"custom_attributes":     rawArray(raw["custom_attributes"]),
			"extension_attributes":  nonNilMap(mapField(raw, "extension_attributes")),
			"media_gallery_entries": rawArray(raw["media_gallery_entries"]),
			// One variant carrying the Magento stock_item so the catalog tracks
			// inventory and back-in-stock fires on restock (matching the
			// commerce platforms that already materialise variants).
			"variants":     adobeCommerceProductVariants(raw, priceCents),
			"provider_raw": nonNilMap(raw),
		},
	}
}

// adobeCommerceProductVariants builds a single inventory-bearing variant from a
// Magento product's extension_attributes.stock_item. Mapping to the shared
// variant contract (upsertProductVariant -> variantAvailable):
//   - backorders allowed  -> inventory_policy "continue" (always purchasable);
//   - is_in_stock == false -> inventory_quantity 0 (out of stock; restock to a
//     positive qty / in-stock flips availability and triggers back-in-stock);
//   - managed stock        -> inventory_quantity = qty;
//   - untracked stock      -> quantity left nil (treated as available).
func adobeCommerceProductVariants(raw map[string]any, priceCents int) []any {
	stock := mapField(mapField(raw, "extension_attributes"), "stock_item")
	sku := firstNonEmpty(stringField(raw, "sku"), stringField(raw, "id"), stringField(raw, "entity_id"))
	variant := map[string]any{
		"id":    firstNonEmpty(sku, stringField(raw, "id")),
		"sku":   sku,
		"title": firstNonEmpty(stringField(raw, "name"), sku),
		"price": float64(priceCents) / 100,
	}
	// Magento backorders: 0=No, 1=Yes, 2=Yes+notify. >0 means backorders allowed.
	if intField(stock, "backorders") > 0 {
		variant["inventory_policy"] = "continue"
	} else {
		variant["inventory_policy"] = "deny"
	}
	if len(stock) > 0 {
		if !boolField(stock, "is_in_stock") {
			variant["inventory_quantity"] = float64(0)
		} else if boolField(stock, "manage_stock") {
			// Store qty as a float64 the shared decoder (nullableInt -> intField)
			// reliably parses. The Adobe response decoder uses UseNumber, so a raw
			// qty is a json.Number DECIMAL ("5.0000") whose Int64() fails and
			// silently collapses to 0 — normalise it first.
			if qty, ok := adobeStockQty(stock["qty"]); ok {
				variant["inventory_quantity"] = qty
			}
		}
	}
	return []any{variant}
}

// adobeStockQty coerces a Magento stock qty (json.Number / float64 / string /
// int) to a float64. Returns ok=false when absent or unparseable so the caller
// leaves the quantity nil (treated as available — untracked).
func adobeStockQty(v any) (float64, bool) {
	switch t := v.(type) {
	case nil:
		return 0, false
	case float64:
		return t, true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		return f, err == nil
	default:
		return 0, false
	}
}

func adobeCommerceOrderInput(raw map[string]any) OrderInput {
	id := firstNonEmpty(stringField(raw, "entity_id"), stringField(raw, "id"), stringField(raw, "increment_id"), stringField(raw, "order_id"))
	sourceID := adobeCommerceSourceID("order", id)
	currency := strings.ToUpper(firstNonEmpty(stringField(raw, "order_currency_code"), stringField(raw, "base_currency_code"), stringField(raw, "global_currency_code"), "USD"))
	discount := cents(firstNonNil(raw["discount_amount"], raw["base_discount_amount"]))
	return OrderInput{
		SourceID:      sourceID,
		CustomerEmail: strings.ToLower(strings.TrimSpace(firstNonEmpty(stringField(raw, "customer_email"), stringField(mapField(raw, "billing_address"), "email")))),
		Status:        adobeCommerceOrderStatus(firstNonEmpty(stringField(raw, "status"), stringField(raw, "state"))),
		SubtotalCents: cents(firstNonNil(raw["subtotal"], raw["base_subtotal"])),
		DiscountCents: absoluteCents(discount),
		ShippingCents: cents(firstNonNil(raw["shipping_amount"], raw["base_shipping_amount"])),
		TaxCents:      cents(firstNonNil(raw["tax_amount"], raw["base_tax_amount"])),
		TotalCents:    cents(firstNonNil(raw["grand_total"], raw["base_grand_total"], raw["total_paid"])),
		Currency:      currency,
		Attribution: map[string]any{
			"source":               ProviderAdobeCommerce,
			"object":               "order",
			"increment_id":         stringField(raw, "increment_id"),
			"state":                stringField(raw, "state"),
			"status":               stringField(raw, "status"),
			"quote_id":             stringField(raw, "quote_id"),
			"customer_id":          stringField(raw, "customer_id"),
			"coupon_code":          stringField(raw, "coupon_code"),
			"discount_description": stringField(raw, "discount_description"),
			"shipping_description": stringField(raw, "shipping_description"),
			"store_id":             stringField(raw, "store_id"),
			"store_name":           stringField(raw, "store_name"),
			"payment_method":       stringField(mapField(raw, "payment"), "method"),
			"payment":              nonNilMap(mapField(raw, "payment")),
			"billing_address":      nonNilMap(mapField(raw, "billing_address")),
			"extension_attributes": nonNilMap(mapField(raw, "extension_attributes")),
			"provider_raw":         nonNilMap(raw),
		},
		LineItems: adobeCommerceLineItems(rawArray(raw["items"]), currency),
		OrderedAt: parseTimeAny(firstNonNil(raw["created_at"], raw["updated_at"])),
		Raw: map[string]any{
			"source":       ProviderAdobeCommerce,
			"source_id":    sourceID,
			"provider_raw": nonNilMap(raw),
		},
	}
}

func adobeCommerceCreditMemoEvent(topic string, raw map[string]any) ProviderEventInput {
	id := firstNonEmpty(stringField(raw, "entity_id"), stringField(raw, "id"), stringField(raw, "increment_id"), stringField(raw, "creditmemo_id"))
	sourceID := adobeCommerceSourceID("creditmemo", id)
	eventType := adobeCommerceProviderEventType(topic)
	amount := cents(firstNonNil(raw["grand_total"], raw["base_grand_total"], raw["subtotal"]))
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderAdobeCommerce,
		Topic:           strings.TrimSpace(topic),
		SourceID:        sourceID,
		ProviderEventID: eventType + ":" + sourceID,
		CustomerEmail:   strings.ToLower(strings.TrimSpace(firstNonEmpty(stringField(raw, "customer_email"), stringField(mapField(raw, "billing_address"), "email")))),
		Metadata: map[string]any{
			"source":       ProviderAdobeCommerce,
			"object":       "creditmemo",
			"source_id":    sourceID,
			"increment_id": stringField(raw, "increment_id"),
			"order_id":     stringField(raw, "order_id"),
			"order_source": adobeCommerceSourceID("order", stringField(raw, "order_id")),
			"state":        stringField(raw, "state"),
			"status":       stringField(raw, "status"),
			"amount_cents": amount,
			"refund_cents": absoluteCents(amount),
			"currency":     strings.ToUpper(firstNonEmpty(stringField(raw, "order_currency_code"), stringField(raw, "base_currency_code"), "USD")),
			"created_at":   stringField(raw, "created_at"),
			"provider_raw": nonNilMap(raw),
		},
	}
}

func adobeCommerceLineItems(items []any, fallbackCurrency string) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id := firstNonEmpty(stringField(m, "item_id"), stringField(m, "id"), stringField(m, "sku"))
		currency := strings.ToUpper(firstNonEmpty(stringField(m, "currency"), fallbackCurrency))
		out = append(out, map[string]any{
			"source_id":       adobeCommerceSourceID("order_item", id),
			"product_id":      stringField(m, "product_id"),
			"sku":             stringField(m, "sku"),
			"title":           firstNonEmpty(stringField(m, "name"), stringField(m, "title"), stringField(m, "sku")),
			"quantity":        maxInt(intField(m, "qty_ordered"), intField(m, "qty")),
			"price_cents":     cents(firstNonNil(m["price"], m["base_price"], m["original_price"])),
			"subtotal_cents":  cents(firstNonNil(m["row_total"], m["base_row_total"])),
			"discount_cents":  absoluteCents(cents(firstNonNil(m["discount_amount"], m["base_discount_amount"]))),
			"total_tax_cents": cents(firstNonNil(m["tax_amount"], m["base_tax_amount"])),
			"currency":        currency,
			"provider_raw":    nonNilMap(m),
		})
	}
	if out == nil {
		return []map[string]any{}
	}
	return out
}

func adobeCommerceOrderStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "complete", "processing", "paid", "closed":
		return "paid"
	case "canceled", "cancelled":
		return "cancelled"
	case "refunded":
		return "refunded"
	default:
		return "pending"
	}
}

func adobeCommerceProviderEventType(topic string) string {
	topic = strings.ToLower(strings.TrimSpace(topic))
	switch {
	case strings.Contains(topic, "refund") || strings.Contains(topic, "creditmemo"):
		return "refund_created"
	case strings.Contains(topic, "subscription") && strings.Contains(topic, "delete"):
		return "subscription_deleted"
	case strings.Contains(topic, "subscription"):
		return "subscription_updated"
	case strings.Contains(topic, "invoice") && strings.Contains(topic, "pay"):
		return "invoice_paid"
	case strings.Contains(topic, "invoice"):
		return "invoice_updated"
	default:
		return "transaction_updated"
	}
}

func adobeCommerceSourceID(kind, id string) string {
	id = strings.TrimSpace(id)
	if id == "" || id == "<nil>" {
		return ""
	}
	return "adobe-commerce://" + strings.TrimSpace(kind) + "/" + id
}

func normalizeAdobeCommerceStoreBaseURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if u, err := url.Parse(raw); err == nil && u.Scheme != "" && u.Host != "" {
		u.Path = strings.TrimRight(strings.TrimSuffix(u.Path, "/rest"), "/")
		u.RawQuery = ""
		u.Fragment = ""
		return strings.TrimRight(u.String(), "/")
	}
	return strings.TrimRight(raw, "/")
}

func adobeCommerceCustomAttributeString(raw map[string]any, code string) string {
	code = strings.ToLower(strings.TrimSpace(code))
	for _, item := range rawArray(raw["custom_attributes"]) {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if strings.ToLower(strings.TrimSpace(stringField(m, "attribute_code"))) == code {
			return stringField(m, "value")
		}
	}
	return ""
}

func adobeCommerceProductImage(raw map[string]any) string {
	for _, item := range rawArray(raw["media_gallery_entries"]) {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if file := strings.TrimSpace(stringField(m, "file")); file != "" {
			return file
		}
	}
	for _, key := range []string{"image", "small_image", "thumbnail"} {
		if value := adobeCommerceCustomAttributeString(raw, key); value != "" && value != "no_selection" {
			return value
		}
	}
	return ""
}
