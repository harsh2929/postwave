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
	payPalCursorPrefix      = "paypal:"
	payPalRetryCursorPrefix = "paypal_retry:"
	payPalCursorComplete    = "paypal:complete"
	payPalResponseMaxBytes  = 8 << 20
	payPalDefaultPageSize   = 100
	payPalMaxPageSize       = 500
	payPalMaxWindowDays     = 31
	payPalRetryInitialDelay = 15 * time.Minute
	payPalRetryMaxDelay     = 6 * time.Hour
)

type PayPalCredentials struct {
	ClientID     string
	ClientSecret string
	WebhookID    string
	Environment  string
}

type PayPalCredentialResolver interface {
	ResolvePayPal(context.Context, string, Integration) (PayPalCredentials, error)
}

type PayPalBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type PayPalWebhookVerifier interface {
	VerifyPayPalWebhook(ctx context.Context, creds PayPalCredentials, event payPalWebhookEvent, headers http.Header, rawBody []byte) error
}

type PayPalWebhookResourceFetcher interface {
	FetchPayPalWebhookResource(ctx context.Context, tenantID string, integration Integration, creds PayPalCredentials, event payPalWebhookEvent) (payPalWebhookEvent, error)
}

type PayPalRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials PayPalCredentialResolver
	APIBaseURL  string
	PageSize    int
	Now         func() time.Time
}

type PayPalRESTWebhookVerifier struct {
	HTTPClient  *http.Client
	Credentials PayPalCredentialResolver
	APIBaseURL  string
}

type PayPalRESTWebhookResourceFetcher struct {
	HTTPClient *http.Client
	APIBaseURL string
}

type payPalBackfillState struct {
	Object   string `json:"object"`
	Start    string `json:"start"`
	End      string `json:"end"`
	FinalEnd string `json:"final_end,omitempty"`
	Page     int    `json:"page,omitempty"`
}

type payPalRetryState struct {
	Cursor        string `json:"cursor"`
	Object        string `json:"object,omitempty"`
	Page          int    `json:"page,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type payPalTokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
}

type payPalTransactionSearchResponse struct {
	TransactionDetails []map[string]any `json:"transaction_details"`
	Page               int              `json:"page"`
	TotalItems         int              `json:"total_items"`
	TotalPages         int              `json:"total_pages"`
}

type PayPalRateLimitError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e PayPalRateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("paypal REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("paypal REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func (b PayPalRESTBackfiller) now() time.Time {
	if b.Now != nil {
		return b.Now().UTC()
	}
	return time.Now().UTC()
}

func (b PayPalRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderPayPal {
		return SyncRequest{}, fmt.Errorf("paypal backfill requires a PayPal integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("paypal credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolvePayPal(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return SyncRequest{}, fmt.Errorf("paypal client_id and client_secret are required")
	}
	state, err := decodePayPalBackfillCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "" {
		state = defaultPayPalBackfillState(integration, b.now())
	}
	if state.Object == "complete" {
		return SyncRequest{Cursor: payPalCursorComplete}, nil
	}
	client := commerceEgressClient(b.HTTPClient, ProviderPayPal, 30*time.Second)
	baseURL := strings.TrimRight(b.APIBaseURL, "/")
	if baseURL == "" {
		baseURL = payPalAPIBaseURL(creds, integration)
	}
	token, err := payPalAccessToken(ctx, client, baseURL, creds)
	if err != nil {
		return SyncRequest{}, err
	}
	page, err := b.fetchTransactionPage(ctx, client, baseURL, token, state)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{}
	for _, detail := range page.TransactionDetails {
		if customer := payPalCustomerInput(detail); customer.SourceID != "" {
			req.Customers = append(req.Customers, customer)
		}
		if payPalTransactionIsRefund(detail) {
			if event := payPalRefundEvent("transaction.refund", detail); event.SourceID != "" {
				req.ProviderEvents = append(req.ProviderEvents, event)
			}
			continue
		}
		if order := payPalTransactionOrder(detail); order.SourceID != "" {
			req.Orders = append(req.Orders, order)
		}
	}
	req.Cursor = encodePayPalBackfillCursor(nextPayPalBackfillState(state, page))
	return req, nil
}

func (b PayPalRESTBackfiller) fetchTransactionPage(ctx context.Context, client *http.Client, baseURL, token string, state payPalBackfillState) (payPalTransactionSearchResponse, error) {
	path := "/v1/reporting/transactions"
	q := url.Values{}
	q.Set("start_date", state.Start)
	q.Set("end_date", state.End)
	q.Set("fields", "all")
	q.Set("page_size", strconv.Itoa(normalizePayPalPageSize(b.PageSize)))
	q.Set("page", strconv.Itoa(maxInt(state.Page, 1)))
	var out payPalTransactionSearchResponse
	if err := payPalDoJSON(ctx, client, baseURL, token, http.MethodGet, path, q, nil, &out); err != nil {
		return payPalTransactionSearchResponse{}, err
	}
	if out.Page == 0 {
		out.Page = state.Page
	}
	return out, nil
}

func (v PayPalRESTWebhookVerifier) VerifyPayPalWebhook(ctx context.Context, creds PayPalCredentials, event payPalWebhookEvent, headers http.Header, rawBody []byte) error {
	client := commerceEgressClient(v.HTTPClient, ProviderPayPal, 30*time.Second)
	baseURL := strings.TrimRight(v.APIBaseURL, "/")
	if baseURL == "" {
		baseURL = payPalAPIBaseURL(creds, Integration{})
	}
	token, err := payPalAccessToken(ctx, client, baseURL, creds)
	if err != nil {
		return err
	}
	payload := map[string]any{
		"auth_algo":         headers.Get("Paypal-Auth-Algo"),
		"cert_url":          headers.Get("Paypal-Cert-Url"),
		"transmission_id":   headers.Get("Paypal-Transmission-Id"),
		"transmission_sig":  headers.Get("Paypal-Transmission-Sig"),
		"transmission_time": headers.Get("Paypal-Transmission-Time"),
		"webhook_id":        creds.WebhookID,
		"webhook_event":     payPalVerificationWebhookEvent(event, rawBody),
	}
	var out struct {
		VerificationStatus string `json:"verification_status"`
	}
	if err := payPalDoJSON(ctx, client, baseURL, token, http.MethodPost, "/v1/notifications/verify-webhook-signature", nil, payload, &out); err != nil {
		return err
	}
	if strings.ToUpper(strings.TrimSpace(out.VerificationStatus)) != "SUCCESS" {
		return ErrInvalidSignature
	}
	return nil
}

func payPalVerificationWebhookEvent(event payPalWebhookEvent, rawBody []byte) any {
	var raw any
	dec := json.NewDecoder(bytes.NewReader(rawBody))
	dec.UseNumber()
	if err := dec.Decode(&raw); err == nil && raw != nil {
		return raw
	}
	return event
}

func (f PayPalRESTWebhookResourceFetcher) FetchPayPalWebhookResource(ctx context.Context, _ string, integration Integration, creds PayPalCredentials, event payPalWebhookEvent) (payPalWebhookEvent, error) {
	if !payPalWebhookShouldFetchResource(event) {
		return event, nil
	}
	path, ok := payPalWebhookResourceFetchPath(event)
	if !ok {
		return event, nil
	}
	client := commerceEgressClient(f.HTTPClient, ProviderPayPal, 30*time.Second)
	baseURL := strings.TrimRight(f.APIBaseURL, "/")
	if baseURL == "" {
		baseURL = payPalAPIBaseURL(creds, integration)
	}
	token, err := payPalAccessToken(ctx, client, baseURL, creds)
	if err != nil {
		return event, err
	}
	var resource map[string]any
	if err := payPalDoJSON(ctx, client, baseURL, token, http.MethodGet, path, nil, nil, &resource); err != nil {
		return event, err
	}
	if len(resource) == 0 {
		return event, nil
	}
	if orderID := payPalCaptureRelatedOrderID(resource); orderID != "" && payPalWebhookCanMergeCaptureOrder(event.EventType) {
		var order map[string]any
		err := payPalDoJSON(ctx, client, baseURL, token, http.MethodGet, "/v2/checkout/orders/"+url.PathEscape(orderID), nil, nil, &order)
		if err != nil {
			var rateLimit PayPalRateLimitError
			if errors.As(err, &rateLimit) {
				return event, err
			}
		} else if len(order) > 0 {
			resource = payPalMergeCaptureOrder(resource, orderID, order)
		}
	}
	event.Resource = resource
	return event, nil
}

func payPalAccessToken(ctx context.Context, client *http.Client, baseURL string, creds PayPalCredentials) (string, error) {
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/v1/oauth2/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(strings.TrimSpace(creds.ClientID), strings.TrimSpace(creds.ClientSecret))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := readResponseBodyLimited(resp.Body, payPalResponseMaxBytes)
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return "", PayPalRateLimitError{Path: "/v1/oauth2/token", StatusCode: resp.StatusCode, RetryAfter: payPalRetryAfter(resp.Header), Snippet: responseSnippet(raw)}
		}
		return "", fmt.Errorf("paypal token failed %d: %s", resp.StatusCode, responseSnippet(raw))
	}
	var out payPalTokenResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("decode paypal token response: %w", err)
	}
	token := strings.TrimSpace(out.AccessToken)
	if token == "" {
		return "", fmt.Errorf("paypal token response missing access_token")
	}
	return token, nil
}

func payPalDoJSON(ctx context.Context, client *http.Client, baseURL, token, method, path string, query url.Values, body any, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + path)
	if err != nil {
		return err
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
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("PayPal-Enforce-ISO8601-Format", "true")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := readResponseBodyLimited(resp.Body, payPalResponseMaxBytes)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return PayPalRateLimitError{Path: path, StatusCode: resp.StatusCode, RetryAfter: payPalRetryAfter(resp.Header), Snippet: responseSnippet(raw)}
		}
		return fmt.Errorf("paypal REST %s failed %d: %s", path, resp.StatusCode, responseSnippet(raw))
	}
	if out == nil {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil && err != io.EOF {
		return fmt.Errorf("decode paypal %s response: %w", path, err)
	}
	return nil
}

func decodePayPalBackfillCursor(cursor string) (payPalBackfillState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return payPalBackfillState{}, nil
	}
	if cursor == payPalCursorComplete {
		return payPalBackfillState{Object: "complete"}, nil
	}
	if !strings.HasPrefix(cursor, payPalCursorPrefix) {
		return payPalBackfillState{}, fmt.Errorf("invalid PayPal cursor")
	}
	var state payPalBackfillState
	if err := json.Unmarshal([]byte(strings.TrimPrefix(cursor, payPalCursorPrefix)), &state); err != nil {
		return payPalBackfillState{}, fmt.Errorf("decode PayPal cursor: %w", err)
	}
	state.Object = normalizePayPalBackfillObject(state.Object)
	if state.Page <= 0 {
		state.Page = 1
	}
	return state, nil
}

func encodePayPalBackfillCursor(state payPalBackfillState) string {
	state.Object = normalizePayPalBackfillObject(state.Object)
	if state.Object == "" || state.Object == "complete" {
		return payPalCursorComplete
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	raw, _ := json.Marshal(state)
	return payPalCursorPrefix + string(raw)
}

func normalizePayPalBackfillObject(object string) string {
	object = strings.TrimSpace(strings.ReplaceAll(object, "-", "_"))
	switch object {
	case "", "transaction", "transactions":
		return "transactions"
	default:
		return object
	}
}

func defaultPayPalBackfillState(integration Integration, now time.Time) payPalBackfillState {
	finalEnd := settingTime(integration.Settings, "backfill_end")
	if finalEnd.IsZero() {
		finalEnd = now.UTC()
	}
	start := settingTime(integration.Settings, "backfill_start")
	if start.IsZero() {
		start = finalEnd.Add(-payPalWindowDuration(integration))
	}
	end := start.Add(payPalWindowDuration(integration))
	if end.After(finalEnd) {
		end = finalEnd
	}
	return payPalBackfillState{
		Object:   "transactions",
		Start:    start.UTC().Format(time.RFC3339),
		End:      end.UTC().Format(time.RFC3339),
		FinalEnd: finalEnd.UTC().Format(time.RFC3339),
		Page:     1,
	}
}

func nextPayPalBackfillState(state payPalBackfillState, page payPalTransactionSearchResponse) payPalBackfillState {
	totalPages := page.TotalPages
	if totalPages <= 0 && len(page.TransactionDetails) >= payPalDefaultPageSize {
		totalPages = state.Page + 1
	}
	if totalPages > state.Page {
		state.Page++
		return state
	}
	windowEnd, err := time.Parse(time.RFC3339, state.End)
	if err != nil {
		return payPalBackfillState{Object: "complete"}
	}
	finalEnd, err := time.Parse(time.RFC3339, state.FinalEnd)
	if err != nil || state.FinalEnd == "" {
		return payPalBackfillState{Object: "complete"}
	}
	if !windowEnd.Before(finalEnd) {
		return payPalBackfillState{Object: "complete"}
	}
	nextEnd := windowEnd.Add(payPalMaxWindowDays * 24 * time.Hour)
	if nextEnd.After(finalEnd) {
		nextEnd = finalEnd
	}
	return payPalBackfillState{
		Object:   "transactions",
		Start:    windowEnd.UTC().Format(time.RFC3339),
		End:      nextEnd.UTC().Format(time.RFC3339),
		FinalEnd: finalEnd.UTC().Format(time.RFC3339),
		Page:     1,
	}
}

func normalizePayPalPageSize(size int) int {
	if size <= 0 {
		return payPalDefaultPageSize
	}
	if size > payPalMaxPageSize {
		return payPalMaxPageSize
	}
	return size
}

func payPalWindowDuration(integration Integration) time.Duration {
	days := intField(integration.Settings, "reporting_window_days")
	if days <= 0 || days > payPalMaxWindowDays {
		days = payPalMaxWindowDays
	}
	return time.Duration(days) * 24 * time.Hour
}

func settingTime(settings map[string]any, key string) time.Time {
	raw := settingString(settings, key)
	if raw == "" {
		return time.Time{}
	}
	if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
		return time.Unix(n, 0).UTC()
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC()
	}
	return time.Time{}
}

func decodePayPalRetryCursor(cursor string) (payPalRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, payPalRetryCursorPrefix) {
		return payPalRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, payPalRetryCursorPrefix))
	if err != nil {
		return payPalRetryState{}, true, fmt.Errorf("decode PayPal retry cursor: %w", err)
	}
	var state payPalRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return payPalRetryState{}, true, fmt.Errorf("parse PayPal retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if underlying, err := decodePayPalBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.Page = underlying.Page
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodePayPalRetryCursor(state payPalRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if underlying, err := decodePayPalBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.Page = underlying.Page
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return payPalRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func payPalRetryCursorDue(state payPalRetryState, now time.Time) bool {
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

func payPalBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := payPalRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodePayPalRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(payPalRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodePayPalRetryCursor(state)
}

func payPalRetryDelay(attempt int, err error) time.Duration {
	var rateLimit PayPalRateLimitError
	if err != nil && errors.As(err, &rateLimit) && rateLimit.RetryAfter > 0 {
		if rateLimit.RetryAfter > payPalRetryMaxDelay {
			return payPalRetryMaxDelay
		}
		return rateLimit.RetryAfter
	}
	if attempt <= 1 {
		return payPalRetryInitialDelay
	}
	delay := payPalRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= payPalRetryMaxDelay {
			return payPalRetryMaxDelay
		}
	}
	return delay
}

func payPalRetryAfter(headers http.Header) time.Duration {
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

type payPalWebhookEvent struct {
	ID              string         `json:"id"`
	CreateTime      string         `json:"create_time"`
	ResourceType    string         `json:"resource_type"`
	EventVersion    string         `json:"event_version"`
	EventType       string         `json:"event_type"`
	Summary         string         `json:"summary"`
	ResourceVersion string         `json:"resource_version"`
	Resource        map[string]any `json:"resource"`
	Links           []any          `json:"links,omitempty"`
}

func decodePayPalWebhookEvent(body []byte) (payPalWebhookEvent, error) {
	var event payPalWebhookEvent
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&event); err != nil {
		return payPalWebhookEvent{}, fmt.Errorf("decode paypal webhook body: %w", err)
	}
	event.ID = strings.TrimSpace(event.ID)
	event.EventType = strings.TrimSpace(event.EventType)
	if event.Resource == nil {
		event.Resource = map[string]any{}
	}
	return event, nil
}

func payPalWebhookShouldFetchResource(event payPalWebhookEvent) bool {
	topic := strings.ToUpper(strings.TrimSpace(event.EventType))
	raw := event.Resource
	if stringField(raw, "id") == "" {
		return false
	}
	if _, ok := payPalWebhookResourceFetchPath(event); !ok {
		return false
	}
	switch {
	case payPalWebhookIsOrder(topic):
		return payPalResourceAmountCents(raw) == 0 ||
			payPalResourceCurrency(raw) == "" ||
			stringField(raw, "status") == "" ||
			payPalMerchantIDFromResource(raw) == "" ||
			(payPalWebhookCustomerEmail(raw) == "" && len(payPalPurchaseUnitLineItems(raw, payPalResourceCurrency(raw))) == 0)
	case payPalWebhookIsRefund(topic):
		return payPalResourceAmountCents(raw) == 0 ||
			payPalResourceCurrency(raw) == "" ||
			stringField(raw, "status") == "" ||
			payPalMerchantIDFromResource(raw) == ""
	case strings.HasPrefix(topic, "BILLING.SUBSCRIPTION."):
		return stringField(raw, "status") == "" ||
			payPalMerchantIDFromResource(raw) == "" ||
			stringField(mapField(raw, "subscriber"), "email_address") == "" ||
			firstNonEmpty(stringField(raw, "plan_id"), stringField(mapField(raw, "billing_info"), "plan_id")) == ""
	case strings.HasPrefix(topic, "INVOICING.INVOICE."):
		return stringField(raw, "status") == "" ||
			payPalMerchantIDFromResource(raw) == "" ||
			payPalInvoiceRecipientEmail(raw) == "" ||
			firstNonEmpty(stringField(raw, "invoice_number"), stringField(mapField(raw, "detail"), "invoice_number")) == ""
	default:
		return false
	}
}

func payPalWebhookResourceFetchPath(event payPalWebhookEvent) (string, bool) {
	topic := strings.ToUpper(strings.TrimSpace(event.EventType))
	id := strings.TrimSpace(stringField(event.Resource, "id"))
	if id == "" {
		return "", false
	}
	escaped := url.PathEscape(id)
	switch {
	case topic == "CHECKOUT.ORDER.APPROVED" || topic == "CHECKOUT.ORDER.COMPLETED":
		return "/v2/checkout/orders/" + escaped, true
	case topic == "PAYMENT.CAPTURE.COMPLETED" ||
		topic == "PAYMENT.CAPTURE.PENDING" ||
		topic == "PAYMENT.CAPTURE.DECLINED" ||
		topic == "PAYMENT.CAPTURE.REFUNDED" ||
		topic == "PAYMENT.CAPTURE.REVERSED":
		if payPalWebhookResourceLooksLikeRefund(event) {
			return "/v2/payments/refunds/" + escaped, true
		}
		return "/v2/payments/captures/" + escaped, true
	case topic == "PAYMENT.REFUND.PENDING" || topic == "PAYMENT.REFUND.FAILED":
		return "/v2/payments/refunds/" + escaped, true
	case strings.HasPrefix(topic, "BILLING.SUBSCRIPTION."):
		return "/v1/billing/subscriptions/" + escaped, true
	case strings.HasPrefix(topic, "INVOICING.INVOICE."):
		return "/v2/invoicing/invoices/" + escaped, true
	default:
		return "", false
	}
}

func payPalWebhookResourceLooksLikeRefund(event payPalWebhookEvent) bool {
	topic := strings.ToUpper(strings.TrimSpace(event.EventType))
	if strings.HasPrefix(topic, "PAYMENT.REFUND.") {
		return true
	}
	resourceType := strings.ToLower(strings.TrimSpace(event.ResourceType))
	return strings.Contains(resourceType, "refund") || strings.TrimSpace(stringField(event.Resource, "capture_id")) != ""
}

func payPalWebhookCanMergeCaptureOrder(topic string) bool {
	topic = strings.ToUpper(strings.TrimSpace(topic))
	return topic == "PAYMENT.CAPTURE.COMPLETED" ||
		topic == "PAYMENT.CAPTURE.PENDING" ||
		topic == "PAYMENT.CAPTURE.DECLINED"
}

func payPalCaptureRelatedOrderID(raw map[string]any) string {
	return firstNonEmpty(
		stringField(mapField(mapField(raw, "supplementary_data"), "related_ids"), "order_id"),
		stringField(mapField(raw, "related_ids"), "order_id"),
		stringField(raw, "order_id"),
	)
}

func payPalMergeCaptureOrder(capture map[string]any, orderID string, order map[string]any) map[string]any {
	if capture == nil {
		capture = map[string]any{}
	}
	if strings.TrimSpace(orderID) != "" {
		capture["order_id"] = strings.TrimSpace(orderID)
	}
	for _, key := range []string{"payer", "purchase_units"} {
		if _, exists := capture[key]; !exists {
			if value, ok := order[key]; ok {
				capture[key] = value
			}
		}
	}
	capture["paypal_order"] = nonNilMap(order)
	return capture
}

func payPalWebhookCustomerEmail(raw map[string]any) string {
	return strings.ToLower(strings.TrimSpace(firstNonEmpty(
		stringField(mapField(raw, "payer"), "email_address"),
		stringField(raw, "payer_email"),
		stringField(mapField(raw, "subscriber"), "email_address"),
		payPalInvoiceRecipientEmail(raw),
	)))
}

func payPalValidateWebhookMerchant(expected string, event payPalWebhookEvent) error {
	expected = normalizePayPalMerchantID(expected)
	got := normalizePayPalMerchantID(payPalMerchantIDFromWebhook(event))
	if expected != "" && got != "" && got != expected {
		return fmt.Errorf("paypal webhook resource merchant %q does not match integration merchant %q", got, expected)
	}
	return nil
}

func (d *Deps) dispatchPayPalWebhook(ctx context.Context, integration *Integration, event payPalWebhookEvent) error {
	if integration == nil {
		return nil
	}
	topic := strings.ToUpper(strings.TrimSpace(event.EventType))
	switch {
	case payPalWebhookIsOrder(topic):
		order := payPalWebhookOrder(topic, event.Resource)
		if order.SourceID == "" {
			return fmt.Errorf("paypal webhook missing order/capture id")
		}
		return d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, order)
	case payPalWebhookIsRefund(topic):
		refund := payPalWebhookProviderEvent(topic, event)
		if refund.SourceID == "" {
			return fmt.Errorf("paypal webhook missing refund/capture id")
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, refund)
	case payPalWebhookIsProviderEvent(topic):
		providerEvent := payPalWebhookProviderEvent(topic, event)
		if providerEvent.SourceID == "" {
			return nil
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, providerEvent)
	default:
		return nil
	}
}

func payPalTransactionOrder(detail map[string]any) OrderInput {
	info := mapField(detail, "transaction_info")
	payer := mapField(detail, "payer_info")
	amount := mapField(info, "transaction_amount")
	sourceID := payPalIDSource("transaction", stringField(info, "transaction_id"))
	currency := strings.ToUpper(stringField(amount, "currency_code"))
	total := cents(stringField(amount, "value"))
	return OrderInput{
		SourceID:      sourceID,
		CustomerEmail: strings.ToLower(strings.TrimSpace(stringField(payer, "email_address"))),
		Status:        payPalTransactionStatus(stringField(info, "transaction_status")),
		TotalCents:    total,
		Currency:      defaulted(currency, "USD"),
		Attribution: map[string]any{
			"source":                 ProviderPayPal,
			"object":                 "transaction",
			"transaction_id":         stringField(info, "transaction_id"),
			"transaction_event_code": stringField(info, "transaction_event_code"),
			"paypal_account_id":      stringField(info, "paypal_account_id"),
			"invoice_id":             stringField(info, "invoice_id"),
			"custom_field":           stringField(info, "custom_field"),
			"transaction_status":     stringField(info, "transaction_status"),
			"fee_amount":             nonNilMap(mapField(info, "fee_amount")),
			"provider_raw":           nonNilMap(detail),
		},
		LineItems: payPalLineItems(detail, currency),
		OrderedAt: parseTimeAny(firstNonEmpty(
			stringField(info, "transaction_initiation_date"),
			stringField(info, "transaction_updated_date"),
		)),
		Raw: map[string]any{
			"source":       ProviderPayPal,
			"source_id":    sourceID,
			"provider_raw": nonNilMap(detail),
		},
	}
}

func payPalCustomerInput(detail map[string]any) CustomerInput {
	payer := mapField(detail, "payer_info")
	accountID := stringField(payer, "account_id")
	email := strings.ToLower(strings.TrimSpace(stringField(payer, "email_address")))
	name := mapField(payer, "payer_name")
	sourceID := payPalIDSource("payer", firstNonEmpty(accountID, email))
	return CustomerInput{
		SourceID:         sourceID,
		Email:            email,
		FirstName:        stringField(name, "given_name"),
		LastName:         stringField(name, "surname"),
		AcceptsMarketing: true,
		Tags:             []string{"paypal_customer"},
		Raw: map[string]any{
			"source":       ProviderPayPal,
			"source_id":    sourceID,
			"account_id":   accountID,
			"country_code": stringField(payer, "country_code"),
			"payer_status": stringField(payer, "payer_status"),
			"provider_raw": nonNilMap(detail),
		},
	}
}

func payPalRefundEvent(topic string, detail map[string]any) ProviderEventInput {
	info := mapField(detail, "transaction_info")
	amount := cents(stringField(mapField(info, "transaction_amount"), "value"))
	sourceID := payPalIDSource("transaction", stringField(info, "transaction_id"))
	return ProviderEventInput{
		EventType:       "refund_created",
		Provider:        ProviderPayPal,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: "refund_created:" + sourceID,
		CustomerEmail:   strings.ToLower(strings.TrimSpace(stringField(mapField(detail, "payer_info"), "email_address"))),
		Metadata: map[string]any{
			"source":                 ProviderPayPal,
			"topic":                  topic,
			"object":                 "transaction",
			"source_id":              sourceID,
			"transaction_id":         stringField(info, "transaction_id"),
			"transaction_event_code": stringField(info, "transaction_event_code"),
			"transaction_status":     stringField(info, "transaction_status"),
			"amount_cents":           amount,
			"refund_cents":           absoluteCents(amount),
			"currency":               strings.ToUpper(stringField(mapField(info, "transaction_amount"), "currency_code")),
			"invoice_id":             stringField(info, "invoice_id"),
			"custom_field":           stringField(info, "custom_field"),
			"provider_raw":           nonNilMap(detail),
		},
	}
}

func payPalWebhookOrder(topic string, raw map[string]any) OrderInput {
	sourceKind := payPalWebhookSourceKind(topic)
	sourceID := payPalIDSource(sourceKind, stringField(raw, "id"))
	amount := firstNonNil(
		mapField(raw, "amount")["value"],
		mapField(raw, "seller_receivable_breakdown")["gross_amount"],
		mapField(raw, "purchase_units")["amount"],
	)
	total := payPalResourceAmountCents(raw)
	currency := payPalResourceCurrency(raw)
	return OrderInput{
		SourceID:      sourceID,
		CustomerEmail: strings.ToLower(strings.TrimSpace(firstNonEmpty(stringField(mapField(raw, "payer"), "email_address"), stringField(raw, "payer_email")))),
		Status:        payPalWebhookOrderStatus(topic, stringField(raw, "status")),
		TotalCents:    total,
		Currency:      defaulted(currency, "USD"),
		Attribution: map[string]any{
			"source":       ProviderPayPal,
			"object":       sourceKind,
			"topic":        topic,
			"status":       stringField(raw, "status"),
			"invoice_id":   stringField(raw, "invoice_id"),
			"custom_id":    stringField(raw, "custom_id"),
			"amount":       amount,
			"provider_raw": nonNilMap(raw),
		},
		LineItems: payPalPurchaseUnitLineItems(raw, currency),
		OrderedAt: parseTimeAny(firstNonEmpty(stringField(raw, "create_time"), stringField(raw, "update_time"))),
		Raw: map[string]any{
			"source":       ProviderPayPal,
			"source_id":    sourceID,
			"provider_raw": nonNilMap(raw),
		},
	}
}

func payPalWebhookProviderEvent(topic string, event payPalWebhookEvent) ProviderEventInput {
	raw := event.Resource
	eventType := payPalProviderEventType(topic)
	sourceKind := payPalWebhookSourceKind(topic)
	sourceID := payPalIDSource(sourceKind, stringField(raw, "id"))
	amount := payPalResourceAmountCents(raw)
	providerEventID := eventType + ":" + sourceID
	if strings.TrimSpace(event.ID) != "" {
		providerEventID = eventType + ":paypal://webhook/" + strings.TrimSpace(event.ID)
	}
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderPayPal,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: providerEventID,
		CustomerEmail: strings.ToLower(strings.TrimSpace(firstNonEmpty(
			stringField(mapField(raw, "payer"), "email_address"),
			stringField(raw, "payer_email"),
			stringField(mapField(raw, "subscriber"), "email_address"),
			payPalInvoiceRecipientEmail(raw),
		))),
		Metadata: map[string]any{
			"source":               ProviderPayPal,
			"topic":                topic,
			"object":               sourceKind,
			"source_id":            sourceID,
			"provider_event_id":    strings.TrimSpace(event.ID),
			"resource_type":        event.ResourceType,
			"resource_version":     event.ResourceVersion,
			"event_version":        event.EventVersion,
			"summary":              event.Summary,
			"create_time":          event.CreateTime,
			"status":               stringField(raw, "status"),
			"amount_cents":         amount,
			"refund_cents":         absoluteCents(amount),
			"currency":             payPalResourceCurrency(raw),
			"invoice_number":       firstNonEmpty(stringField(raw, "invoice_number"), stringField(mapField(raw, "detail"), "invoice_number")),
			"subscription_plan_id": firstNonEmpty(stringField(raw, "plan_id"), stringField(mapField(raw, "billing_info"), "plan_id")),
			"subscriber_email":     stringField(mapField(raw, "subscriber"), "email_address"),
			"merchant_id":          payPalMerchantIDFromResource(raw),
			"provider_raw":         nonNilMap(raw),
		},
	}
}

func payPalInvoiceRecipientEmail(raw map[string]any) string {
	for _, item := range rawArray(raw["primary_recipients"]) {
		recipient, _ := item.(map[string]any)
		if recipient == nil {
			continue
		}
		if email := stringField(mapField(recipient, "billing_info"), "email_address"); email != "" {
			return email
		}
	}
	return ""
}

func payPalLineItems(detail map[string]any, fallbackCurrency string) []map[string]any {
	items := []map[string]any{}
	for _, item := range rawArray(mapField(detail, "cart_info")["item_details"]) {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		currency := firstNonEmpty(stringField(mapField(m, "item_amount"), "currency_code"), fallbackCurrency)
		items = append(items, map[string]any{
			"source_id":    payPalIDSource("item", firstNonEmpty(stringField(m, "item_code"), stringField(m, "invoice_number"), stringField(m, "item_name"))),
			"title":        firstNonEmpty(stringField(m, "item_name"), stringField(m, "item_description"), "PayPal item"),
			"quantity":     intField(m, "item_quantity"),
			"price_cents":  cents(stringField(mapField(m, "item_unit_price"), "value")),
			"total_cents":  cents(firstNonEmpty(stringField(mapField(m, "total_item_amount"), "value"), stringField(mapField(m, "item_amount"), "value"))),
			"currency":     strings.ToUpper(currency),
			"provider_raw": nonNilMap(m),
		})
	}
	return items
}

func payPalPurchaseUnitLineItems(raw map[string]any, fallbackCurrency string) []map[string]any {
	items := []map[string]any{}
	for _, unit := range rawArray(raw["purchase_units"]) {
		unitMap, ok := unit.(map[string]any)
		if !ok {
			continue
		}
		for _, item := range rawArray(unitMap["items"]) {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			currency := firstNonEmpty(stringField(mapField(m, "unit_amount"), "currency_code"), fallbackCurrency)
			items = append(items, map[string]any{
				"source_id":    payPalIDSource("item", firstNonEmpty(stringField(m, "sku"), stringField(m, "name"))),
				"title":        firstNonEmpty(stringField(m, "name"), "PayPal item"),
				"quantity":     intField(m, "quantity"),
				"price_cents":  cents(stringField(mapField(m, "unit_amount"), "value")),
				"total_cents":  cents(stringField(mapField(m, "unit_amount"), "value")) * maxInt(intField(m, "quantity"), 1),
				"currency":     strings.ToUpper(currency),
				"provider_raw": nonNilMap(m),
			})
		}
	}
	return items
}

func payPalResourceAmountCents(raw map[string]any) int {
	for _, candidate := range []any{
		mapField(raw, "amount")["value"],
		mapField(mapField(raw, "seller_receivable_breakdown"), "gross_amount")["value"],
		mapField(raw, "gross_amount")["value"],
	} {
		if strings.TrimSpace(fmt.Sprint(candidate)) != "" && strings.TrimSpace(fmt.Sprint(candidate)) != "<nil>" {
			return cents(candidate)
		}
	}
	for _, unit := range rawArray(raw["purchase_units"]) {
		if m, ok := unit.(map[string]any); ok {
			if amount := cents(stringField(mapField(m, "amount"), "value")); amount != 0 {
				return amount
			}
		}
	}
	return 0
}

func payPalResourceCurrency(raw map[string]any) string {
	for _, candidate := range []string{
		stringField(mapField(raw, "amount"), "currency_code"),
		stringField(mapField(mapField(raw, "seller_receivable_breakdown"), "gross_amount"), "currency_code"),
		stringField(mapField(raw, "gross_amount"), "currency_code"),
	} {
		if strings.TrimSpace(candidate) != "" {
			return strings.ToUpper(candidate)
		}
	}
	for _, unit := range rawArray(raw["purchase_units"]) {
		if m, ok := unit.(map[string]any); ok {
			if currency := stringField(mapField(m, "amount"), "currency_code"); currency != "" {
				return strings.ToUpper(currency)
			}
		}
	}
	return ""
}

func payPalTransactionIsRefund(detail map[string]any) bool {
	info := mapField(detail, "transaction_info")
	amount := cents(stringField(mapField(info, "transaction_amount"), "value"))
	code := strings.ToUpper(stringField(info, "transaction_event_code"))
	status := strings.ToUpper(stringField(info, "transaction_status"))
	return amount < 0 || status == "V" || strings.Contains(code, "REFUND") || strings.HasPrefix(code, "T11")
}

func payPalTransactionStatus(status string) string {
	switch strings.ToUpper(strings.TrimSpace(status)) {
	case "S":
		return "paid"
	case "V":
		return "refunded"
	case "D":
		return "cancelled"
	default:
		return "pending"
	}
}

func payPalWebhookOrderStatus(topic, status string) string {
	topic = strings.ToUpper(strings.TrimSpace(topic))
	if strings.Contains(topic, "COMPLETED") || strings.EqualFold(status, "COMPLETED") || strings.EqualFold(status, "CAPTURED") {
		return "paid"
	}
	if strings.Contains(topic, "DECLINED") || strings.Contains(topic, "DENIED") || strings.EqualFold(status, "DECLINED") || strings.EqualFold(status, "DENIED") {
		return "cancelled"
	}
	if strings.Contains(topic, "REFUNDED") || strings.EqualFold(status, "REFUNDED") {
		return "refunded"
	}
	return "pending"
}

func payPalWebhookIsOrder(topic string) bool {
	return topic == "CHECKOUT.ORDER.APPROVED" ||
		topic == "CHECKOUT.ORDER.COMPLETED" ||
		topic == "PAYMENT.CAPTURE.COMPLETED" ||
		topic == "PAYMENT.CAPTURE.PENDING" ||
		topic == "PAYMENT.CAPTURE.DECLINED" ||
		topic == "PAYMENT.SALE.COMPLETED" ||
		topic == "PAYMENT.SALE.PENDING" ||
		topic == "PAYMENT.SALE.DENIED"
}

func payPalWebhookIsRefund(topic string) bool {
	return topic == "PAYMENT.CAPTURE.REFUNDED" ||
		topic == "PAYMENT.CAPTURE.REVERSED" ||
		topic == "PAYMENT.REFUND.PENDING" ||
		topic == "PAYMENT.REFUND.FAILED" ||
		topic == "PAYMENT.SALE.REFUNDED" ||
		topic == "PAYMENT.SALE.REVERSED"
}

func payPalWebhookIsProviderEvent(topic string) bool {
	return strings.HasPrefix(topic, "BILLING.SUBSCRIPTION.") ||
		strings.HasPrefix(topic, "INVOICING.INVOICE.") ||
		strings.HasPrefix(topic, "CATALOG.PRODUCT.")
}

func payPalProviderEventType(topic string) string {
	topic = strings.ToUpper(strings.TrimSpace(topic))
	switch {
	case strings.Contains(topic, "REFUND.FAILED"):
		return "refund_failed"
	case strings.Contains(topic, "REFUND"), strings.Contains(topic, "REVERSED"):
		return "refund_created"
	case strings.Contains(topic, "SUBSCRIPTION.CREATED"), strings.Contains(topic, "SUBSCRIPTION.ACTIVATED"):
		return "subscription_created"
	case strings.Contains(topic, "SUBSCRIPTION.CANCELLED"), strings.Contains(topic, "SUBSCRIPTION.EXPIRED"):
		return "subscription_deleted"
	case strings.Contains(topic, "SUBSCRIPTION.PAYMENT.FAILED"):
		return "subscription_updated"
	case strings.Contains(topic, "SUBSCRIPTION."):
		return "subscription_updated"
	case strings.Contains(topic, "INVOICE.CREATED"):
		return "invoice_created"
	case strings.Contains(topic, "INVOICE.PAID"):
		return "invoice_paid"
	case strings.Contains(topic, "INVOICE.REFUNDED"):
		return "refund_created"
	case strings.Contains(topic, "INVOICE.CANCELLED"):
		return "invoice_voided"
	case strings.Contains(topic, "INVOICE."):
		return "invoice_updated"
	case strings.Contains(topic, "PRODUCT.CREATED"):
		return "product_created"
	case strings.Contains(topic, "PRODUCT.UPDATED"):
		return "product_updated"
	case strings.Contains(topic, "PRODUCT.DELETED"):
		return "product_deleted"
	default:
		return "transaction_updated"
	}
}

func payPalWebhookSourceKind(topic string) string {
	topic = strings.ToUpper(strings.TrimSpace(topic))
	switch {
	case strings.Contains(topic, "ORDER"):
		return "order"
	case strings.Contains(topic, "INVOICE"):
		return "invoice"
	case strings.Contains(topic, "CAPTURE"):
		return "capture"
	case strings.Contains(topic, "REFUND"):
		return "refund"
	case strings.Contains(topic, "SALE"):
		return "sale"
	case strings.Contains(topic, "SUBSCRIPTION"):
		return "subscription"
	case strings.Contains(topic, "PRODUCT"):
		return "product"
	default:
		return "resource"
	}
}

func payPalMerchantIDFromWebhook(event payPalWebhookEvent) string {
	return payPalMerchantIDFromResource(event.Resource)
}

func payPalMerchantIDFromResource(raw map[string]any) string {
	candidates := []string{
		stringField(mapField(raw, "payee"), "merchant_id"),
		stringField(mapField(raw, "payee"), "merchantId"),
		stringField(raw, "merchant_id"),
		stringField(raw, "payee_merchant_id"),
		stringField(mapField(raw, "merchant_info"), "merchant_id"),
		stringField(mapField(raw, "invoicer"), "merchant_id"),
		stringField(mapField(raw, "invoicer"), "merchantId"),
	}
	for _, unit := range rawArray(raw["purchase_units"]) {
		if m, ok := unit.(map[string]any); ok {
			candidates = append(candidates, stringField(mapField(m, "payee"), "merchant_id"))
		}
	}
	for _, candidate := range candidates {
		if normalized := normalizePayPalMerchantID(candidate); normalized != "" {
			return normalized
		}
	}
	return ""
}

func payPalIDSource(kind, id string) string {
	id = strings.TrimSpace(id)
	if id == "" || id == "<nil>" {
		return ""
	}
	return "paypal://" + strings.TrimSpace(kind) + "/" + id
}

func normalizePayPalMerchantID(raw string) string {
	return strings.TrimSpace(raw)
}

func normalizePayPalEnvironment(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "sandbox", "test":
		return "sandbox"
	default:
		return "live"
	}
}

func payPalAPIBaseURL(creds PayPalCredentials, integration Integration) string {
	if base := strings.TrimRight(settingString(integration.Settings, "api_base_url"), "/"); base != "" {
		return base
	}
	if normalizePayPalEnvironment(creds.Environment) == "sandbox" {
		return "https://api-m.sandbox.paypal.com"
	}
	return "https://api-m.paypal.com"
}
