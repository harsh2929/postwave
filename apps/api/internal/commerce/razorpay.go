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
	razorpayCursorPrefix      = "razorpay:"
	razorpayRetryCursorPrefix = "razorpay_retry:"
	razorpayCursorComplete    = "razorpay:complete"
	razorpayResponseMaxBytes  = 8 << 20
	razorpayDefaultPageSize   = 100
	razorpayMaxPageSize       = 100
	razorpayRetryInitialDelay = 15 * time.Minute
	razorpayRetryMaxDelay     = 6 * time.Hour
)

var razorpayBackfillObjectOrder = []string{"customers", "orders", "payments", "refunds"}

type RazorpayCredentials struct {
	KeyID         string
	KeySecret     string
	WebhookSecret string
}

type RazorpayCredentialResolver interface {
	ResolveRazorpay(context.Context, string, Integration) (RazorpayCredentials, error)
}

type RazorpayBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type RazorpayRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials RazorpayCredentialResolver
	APIBaseURL  string
	PageSize    int
}

type razorpayBackfillState struct {
	Object string `json:"object"`
	Skip   int    `json:"skip,omitempty"`
}

type razorpayRetryState struct {
	Cursor        string `json:"cursor"`
	Object        string `json:"object,omitempty"`
	Skip          int    `json:"skip,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type razorpayAPIResponse struct {
	Entity string           `json:"entity"`
	Count  int              `json:"count"`
	Items  []map[string]any `json:"items"`
	Error  map[string]any   `json:"error"`
}

type RazorpayRateLimitError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e RazorpayRateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("razorpay REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("razorpay REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func (b RazorpayRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderRazorpay {
		return SyncRequest{}, fmt.Errorf("razorpay backfill requires a Razorpay integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("razorpay credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveRazorpay(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.KeyID) == "" || strings.TrimSpace(creds.KeySecret) == "" {
		return SyncRequest{}, fmt.Errorf("razorpay key_id and key_secret are required")
	}
	state, err := decodeRazorpayBackfillCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "" {
		state = razorpayBackfillState{Object: "customers"}
	}
	if state.Object == "complete" {
		return SyncRequest{Cursor: razorpayCursorComplete}, nil
	}
	client := commerceEgressClient(b.HTTPClient, ProviderRazorpay, 30*time.Second)
	baseURL := strings.TrimRight(b.APIBaseURL, "/")
	if baseURL == "" {
		baseURL = "https://api.razorpay.com"
	}
	page, err := b.fetchPage(ctx, client, baseURL, creds, integration, state)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{}
	switch state.Object {
	case "customers":
		req.Customers = make([]CustomerInput, 0, len(page.Items))
		for _, item := range page.Items {
			if customer := razorpayCustomerInput(item); customer.SourceID != "" {
				req.Customers = append(req.Customers, customer)
			}
		}
	case "orders":
		req.Orders = make([]OrderInput, 0, len(page.Items))
		for _, item := range page.Items {
			if order := razorpayOrderInput(item); order.SourceID != "" {
				req.Orders = append(req.Orders, order)
			}
		}
	case "payments":
		req.Orders = make([]OrderInput, 0, len(page.Items))
		for _, item := range page.Items {
			if order := razorpayPaymentOrder(item); order.SourceID != "" {
				req.Orders = append(req.Orders, order)
			}
		}
	case "refunds":
		req.ProviderEvents = make([]ProviderEventInput, 0, len(page.Items))
		for _, item := range page.Items {
			if event := razorpayRefundEvent("refund.created", item); event.SourceID != "" {
				req.ProviderEvents = append(req.ProviderEvents, event)
			}
		}
	default:
		return SyncRequest{}, fmt.Errorf("unsupported Razorpay object %q", state.Object)
	}
	pageSize := normalizeRazorpayPageSize(b.PageSize)
	if len(page.Items) >= pageSize {
		req.Cursor = encodeRazorpayBackfillCursor(razorpayBackfillState{Object: state.Object, Skip: state.Skip + len(page.Items)})
	} else {
		req.Cursor = encodeRazorpayBackfillCursor(razorpayBackfillState{Object: nextRazorpayBackfillObject(state.Object)})
	}
	return req, nil
}

func (b RazorpayRESTBackfiller) fetchPage(ctx context.Context, client *http.Client, baseURL string, creds RazorpayCredentials, integration Integration, state razorpayBackfillState) (razorpayAPIResponse, error) {
	path := "/v1/" + state.Object
	if state.Object == "refunds" {
		path = "/v1/refunds"
	}
	q := url.Values{}
	q.Set("count", strconv.Itoa(normalizeRazorpayPageSize(b.PageSize)))
	q.Set("skip", strconv.Itoa(maxInt(state.Skip, 0)))
	if from := razorpayTimestampSetting(integration, "backfill_from", "from"); from > 0 {
		q.Set("from", strconv.Itoa(from))
	}
	if to := razorpayTimestampSetting(integration, "backfill_to", "to"); to > 0 {
		q.Set("to", strconv.Itoa(to))
	}
	return b.doJSON(ctx, client, baseURL, creds, http.MethodGet, path, q)
}

func (b RazorpayRESTBackfiller) doJSON(ctx context.Context, client *http.Client, baseURL string, creds RazorpayCredentials, method, path string, query url.Values) (razorpayAPIResponse, error) {
	u, err := url.Parse(baseURL + path)
	if err != nil {
		return razorpayAPIResponse{}, err
	}
	if query != nil {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return razorpayAPIResponse{}, err
	}
	req.SetBasicAuth(strings.TrimSpace(creds.KeyID), strings.TrimSpace(creds.KeySecret))
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return razorpayAPIResponse{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := readResponseBodyLimited(resp.Body, razorpayResponseMaxBytes)
	if err != nil {
		return razorpayAPIResponse{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return razorpayAPIResponse{}, RazorpayRateLimitError{
				Path:       path,
				StatusCode: resp.StatusCode,
				RetryAfter: razorpayRetryAfter(resp.Header),
				Snippet:    responseSnippet(raw),
			}
		}
		return razorpayAPIResponse{}, fmt.Errorf("razorpay REST %s failed %d: %s", path, resp.StatusCode, responseSnippet(raw))
	}
	var out razorpayAPIResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return razorpayAPIResponse{}, fmt.Errorf("decode razorpay %s response: %w", path, err)
	}
	if len(out.Error) > 0 {
		return razorpayAPIResponse{}, fmt.Errorf("razorpay REST %s returned error: %v", path, out.Error)
	}
	return out, nil
}

func decodeRazorpayBackfillCursor(cursor string) (razorpayBackfillState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return razorpayBackfillState{}, nil
	}
	if cursor == razorpayCursorComplete {
		return razorpayBackfillState{Object: "complete"}, nil
	}
	if !strings.HasPrefix(cursor, razorpayCursorPrefix) {
		return razorpayBackfillState{}, fmt.Errorf("invalid Razorpay cursor")
	}
	var state razorpayBackfillState
	if err := json.Unmarshal([]byte(strings.TrimPrefix(cursor, razorpayCursorPrefix)), &state); err != nil {
		return razorpayBackfillState{}, fmt.Errorf("decode Razorpay cursor: %w", err)
	}
	state.Object = normalizeRazorpayBackfillObject(state.Object)
	if state.Skip < 0 {
		state.Skip = 0
	}
	return state, nil
}

func encodeRazorpayBackfillCursor(state razorpayBackfillState) string {
	state.Object = normalizeRazorpayBackfillObject(state.Object)
	if state.Object == "" || state.Object == "complete" {
		return razorpayCursorComplete
	}
	if state.Skip < 0 {
		state.Skip = 0
	}
	raw, _ := json.Marshal(state)
	return razorpayCursorPrefix + string(raw)
}

func nextRazorpayBackfillObject(object string) string {
	object = normalizeRazorpayBackfillObject(object)
	if object == "" {
		return razorpayBackfillObjectOrder[0]
	}
	for idx, item := range razorpayBackfillObjectOrder {
		if item == object {
			if idx+1 < len(razorpayBackfillObjectOrder) {
				return razorpayBackfillObjectOrder[idx+1]
			}
			return "complete"
		}
	}
	return "complete"
}

func normalizeRazorpayBackfillObject(object string) string {
	object = strings.TrimSpace(strings.ReplaceAll(object, "-", "_"))
	switch object {
	case "customer":
		return "customers"
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

func normalizeRazorpayPageSize(size int) int {
	if size <= 0 {
		return razorpayDefaultPageSize
	}
	if size > razorpayMaxPageSize {
		return razorpayMaxPageSize
	}
	return size
}

func decodeRazorpayRetryCursor(cursor string) (razorpayRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, razorpayRetryCursorPrefix) {
		return razorpayRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, razorpayRetryCursorPrefix))
	if err != nil {
		return razorpayRetryState{}, true, fmt.Errorf("decode Razorpay retry cursor: %w", err)
	}
	var state razorpayRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return razorpayRetryState{}, true, fmt.Errorf("parse Razorpay retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeRazorpayBackfillCursor(razorpayBackfillState{Object: "customers"})
	}
	if underlying, err := decodeRazorpayBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.Skip = underlying.Skip
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeRazorpayRetryCursor(state razorpayRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeRazorpayBackfillCursor(razorpayBackfillState{Object: "customers"})
	}
	if underlying, err := decodeRazorpayBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.Skip = underlying.Skip
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return razorpayRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func razorpayRetryCursorDue(state razorpayRetryState, now time.Time) bool {
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

func razorpayBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := razorpayRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeRazorpayRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(razorpayRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeRazorpayRetryCursor(state)
}

func razorpayRetryDelay(attempt int, err error) time.Duration {
	var rateLimit RazorpayRateLimitError
	if err != nil && errors.As(err, &rateLimit) && rateLimit.RetryAfter > 0 {
		if rateLimit.RetryAfter > razorpayRetryMaxDelay {
			return razorpayRetryMaxDelay
		}
		return rateLimit.RetryAfter
	}
	if attempt <= 1 {
		return razorpayRetryInitialDelay
	}
	delay := razorpayRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= razorpayRetryMaxDelay {
			return razorpayRetryMaxDelay
		}
	}
	return delay
}

func razorpayRetryAfter(headers http.Header) time.Duration {
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

type razorpayWebhookEvent struct {
	Entity    string         `json:"entity"`
	AccountID string         `json:"account_id"`
	Event     string         `json:"event"`
	Contains  []string       `json:"contains"`
	Payload   map[string]any `json:"payload"`
	CreatedAt any            `json:"created_at"`
}

func decodeRazorpayWebhookEvent(body []byte) (razorpayWebhookEvent, error) {
	var event razorpayWebhookEvent
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&event); err != nil {
		return razorpayWebhookEvent{}, fmt.Errorf("decode razorpay webhook body: %w", err)
	}
	event.AccountID = normalizeRazorpayAccountID(event.AccountID)
	event.Event = strings.TrimSpace(event.Event)
	if event.Payload == nil {
		event.Payload = map[string]any{}
	}
	return event, nil
}

func (d *Deps) dispatchRazorpayWebhook(ctx context.Context, integration *Integration, event razorpayWebhookEvent) error {
	if integration == nil {
		return nil
	}
	switch strings.TrimSpace(event.Event) {
	case "payment.authorized", "payment.captured", "payment.failed":
		payment := razorpayWebhookEntity(event, "payment")
		order := razorpayPaymentOrder(payment)
		if order.SourceID == "" {
			return fmt.Errorf("razorpay payment missing id")
		}
		return d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, order)
	case "order.paid":
		order := razorpayOrderInput(razorpayWebhookEntity(event, "order"))
		if order.SourceID == "" {
			return fmt.Errorf("razorpay order missing id")
		}
		return d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, order)
	case "refund.created", "refund.processed", "refund.failed", "refund.speed_changed":
		refund := razorpayRefundEvent(event.Event, razorpayWebhookEntity(event, "refund"))
		if refund.SourceID == "" {
			return fmt.Errorf("razorpay refund missing id")
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, refund)
	default:
		return nil
	}
}

func razorpayWebhookEntity(event razorpayWebhookEvent, key string) map[string]any {
	root := mapField(event.Payload, key)
	if entity := mapField(root, "entity"); len(entity) > 0 {
		return entity
	}
	return root
}

func razorpayCustomerInput(raw map[string]any) CustomerInput {
	sourceID := razorpaySourceID("customer", raw)
	name := stringField(raw, "name")
	first, last := splitStripeName(name)
	return CustomerInput{
		SourceID:         sourceID,
		Email:            strings.ToLower(strings.TrimSpace(stringField(raw, "email"))),
		FirstName:        first,
		LastName:         last,
		AcceptsMarketing: true,
		Tags:             []string{"razorpay_customer"},
		Raw: map[string]any{
			"source":       ProviderRazorpay,
			"source_id":    sourceID,
			"name":         name,
			"contact":      stringField(raw, "contact"),
			"gstin":        stringField(raw, "gstin"),
			"notes":        raw["notes"],
			"created_at":   intField(raw, "created_at"),
			"provider_raw": nonNilMap(raw),
		},
	}
}

func razorpayOrderInput(raw map[string]any) OrderInput {
	sourceID := razorpaySourceID("order", raw)
	total := intField(raw, "amount")
	paid := intField(raw, "amount_paid")
	if paid > 0 {
		total = paid
	}
	currency := strings.ToUpper(firstNonEmpty(stringField(raw, "currency"), settingCurrency(raw)))
	return OrderInput{
		SourceID:   sourceID,
		Status:     razorpayOrderStatus(stringField(raw, "status")),
		TotalCents: total,
		Currency:   currency,
		Attribution: map[string]any{
			"source":       ProviderRazorpay,
			"object":       "order",
			"receipt":      stringField(raw, "receipt"),
			"amount":       intField(raw, "amount"),
			"amount_paid":  paid,
			"amount_due":   intField(raw, "amount_due"),
			"attempts":     intField(raw, "attempts"),
			"offer_id":     stringField(raw, "offer_id"),
			"notes":        raw["notes"],
			"provider_raw": nonNilMap(raw),
		},
		LineItems: []map[string]any{{
			"source_id":    sourceID + "/amount",
			"title":        firstNonEmpty(stringField(raw, "receipt"), "Razorpay order"),
			"quantity":     1,
			"total_cents":  total,
			"currency":     currency,
			"provider_raw": nonNilMap(raw),
		}},
		OrderedAt: razorpayUnixTimePtr(intField(raw, "created_at")),
		Raw: map[string]any{
			"source":       ProviderRazorpay,
			"source_id":    sourceID,
			"provider_raw": nonNilMap(raw),
		},
	}
}

func razorpayPaymentOrder(raw map[string]any) OrderInput {
	sourceID := razorpaySourceID("payment", raw)
	total := intField(raw, "amount")
	currency := strings.ToUpper(firstNonEmpty(stringField(raw, "currency"), settingCurrency(raw)))
	return OrderInput{
		SourceID:      sourceID,
		CustomerEmail: strings.ToLower(strings.TrimSpace(stringField(raw, "email"))),
		Status:        razorpayPaymentStatus(stringField(raw, "status")),
		TotalCents:    total,
		Currency:      currency,
		Attribution: map[string]any{
			"source":            ProviderRazorpay,
			"object":            "payment",
			"order_id":          stringField(raw, "order_id"),
			"order_source_id":   razorpayIDSource("order", stringField(raw, "order_id")),
			"invoice_id":        stringField(raw, "invoice_id"),
			"method":            stringField(raw, "method"),
			"contact":           stringField(raw, "contact"),
			"amount_refunded":   intField(raw, "amount_refunded"),
			"refund_status":     stringField(raw, "refund_status"),
			"captured":          boolField(raw, "captured"),
			"international":     boolField(raw, "international"),
			"description":       stringField(raw, "description"),
			"bank":              stringField(raw, "bank"),
			"wallet":            stringField(raw, "wallet"),
			"vpa":               stringField(raw, "vpa"),
			"fee":               intField(raw, "fee"),
			"tax":               intField(raw, "tax"),
			"card_id":           stringField(raw, "card_id"),
			"card":              nonNilMap(mapField(raw, "card")),
			"upi":               nonNilMap(mapField(raw, "upi")),
			"acquirer_data":     nonNilMap(mapField(raw, "acquirer_data")),
			"error_code":        stringField(raw, "error_code"),
			"error_description": stringField(raw, "error_description"),
			"error_source":      stringField(raw, "error_source"),
			"error_step":        stringField(raw, "error_step"),
			"error_reason":      stringField(raw, "error_reason"),
			"notes":             raw["notes"],
			"provider_raw":      nonNilMap(raw),
		},
		LineItems: []map[string]any{{
			"source_id":    sourceID + "/amount",
			"title":        firstNonEmpty(stringField(raw, "description"), "Razorpay payment"),
			"quantity":     1,
			"total_cents":  total,
			"currency":     currency,
			"provider_raw": nonNilMap(raw),
		}},
		OrderedAt: razorpayUnixTimePtr(intField(raw, "created_at")),
		Raw: map[string]any{
			"source":       ProviderRazorpay,
			"source_id":    sourceID,
			"provider_raw": nonNilMap(raw),
		},
	}
}

func razorpayRefundEvent(topic string, raw map[string]any) ProviderEventInput {
	topic = strings.TrimSpace(topic)
	eventType := strings.ReplaceAll(topic, ".", "_")
	if eventType == "" || eventType == "refund_created" {
		eventType = "refund_created"
	}
	sourceID := razorpaySourceID("refund", raw)
	amount := intField(raw, "amount")
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderRazorpay,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: eventType + ":" + sourceID,
		Metadata: map[string]any{
			"source":          ProviderRazorpay,
			"topic":           topic,
			"object":          "refund",
			"source_id":       sourceID,
			"amount_cents":    amount,
			"refund_cents":    absoluteCents(amount),
			"currency":        strings.ToUpper(firstNonEmpty(stringField(raw, "currency"), settingCurrency(raw))),
			"payment_id":      stringField(raw, "payment_id"),
			"payment_source":  razorpayIDSource("payment", stringField(raw, "payment_id")),
			"status":          stringField(raw, "status"),
			"receipt":         stringField(raw, "receipt"),
			"speed_requested": stringField(raw, "speed_requested"),
			"speed_processed": stringField(raw, "speed_processed"),
			"notes":           raw["notes"],
			"acquirer_data":   nonNilMap(mapField(raw, "acquirer_data")),
			"created_at":      intField(raw, "created_at"),
			"provider_raw":    nonNilMap(raw),
		},
	}
}

func razorpayOrderStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "paid":
		return "paid"
	default:
		return "pending"
	}
}

func razorpayPaymentStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "captured", "refunded":
		return "paid"
	case "failed":
		return "cancelled"
	default:
		return "pending"
	}
}

func razorpaySourceID(kind string, raw map[string]any) string {
	return razorpayIDSource(kind, stringField(raw, "id"))
}

func razorpayIDSource(kind, id string) string {
	id = strings.TrimSpace(id)
	if id == "" || id == "<nil>" {
		return ""
	}
	return "razorpay://" + strings.TrimSpace(kind) + "/" + id
}

func normalizeRazorpayAccountID(raw string) string {
	return strings.TrimRight(strings.TrimSpace(raw), "/")
}

func razorpayTimestampSetting(integration Integration, keys ...string) int {
	for _, key := range keys {
		raw := settingString(integration.Settings, key)
		if raw == "" {
			continue
		}
		n, err := strconv.Atoi(raw)
		if err == nil && n > 0 {
			return n
		}
	}
	return 0
}

func razorpayUnixTimePtr(seconds int) *time.Time {
	if seconds <= 0 {
		return nil
	}
	t := time.Unix(int64(seconds), 0).UTC()
	return &t
}

func settingCurrency(raw map[string]any) string {
	return strings.TrimSpace(stringField(raw, "settlement_currency"))
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
