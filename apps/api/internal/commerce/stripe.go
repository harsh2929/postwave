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
	stripeCursorPrefix        = "stripe:"
	stripeRetryCursorPrefix   = "stripe_retry:"
	stripeCursorComplete      = "stripe:complete"
	stripeResponseMaxBytes    = 8 << 20
	stripeRetryInitialDelay   = 15 * time.Minute
	stripeRetryMaxDelay       = 6 * time.Hour
	stripeInvoiceLineMaxPages = 100
)

var stripeBackfillObjectOrder = []string{"customers", "checkout_sessions", "payment_intents", "charges", "disputes", "invoices", "credit_notes", "subscriptions", "refunds"}

type StripeCredentials struct {
	APIKey        string
	WebhookSecret string
}

type StripeCredentialResolver interface {
	ResolveStripe(context.Context, string, Integration) (StripeCredentials, error)
}

type StripeBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type StripeRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials StripeCredentialResolver
	APIBaseURL  string
	PageSize    int
}

type stripeBackfillState struct {
	Object        string `json:"object"`
	StartingAfter string `json:"starting_after,omitempty"`
}

type stripeRetryState struct {
	Cursor        string `json:"cursor"`
	Object        string `json:"object,omitempty"`
	StartingAfter string `json:"starting_after,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type stripeListResponse struct {
	Data    []map[string]any `json:"data"`
	HasMore bool             `json:"has_more"`
}

type StripeRateLimitError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e StripeRateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("stripe REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("stripe REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func (b StripeRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderStripe {
		return SyncRequest{}, fmt.Errorf("stripe backfill requires a Stripe integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("stripe credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveStripe(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.APIKey) == "" {
		return SyncRequest{}, fmt.Errorf("stripe restricted key is required")
	}
	state, err := decodeStripeBackfillCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "" {
		state = stripeBackfillState{Object: "customers"}
	}
	if state.Object == "complete" {
		return SyncRequest{Cursor: stripeCursorComplete}, nil
	}
	client := commerceEgressClient(b.HTTPClient, ProviderStripe, 30*time.Second)
	baseURL := strings.TrimRight(b.APIBaseURL, "/")
	if baseURL == "" {
		baseURL = "https://api.stripe.com"
	}
	page, err := b.fetchPage(ctx, client, baseURL, creds, state)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{}
	switch state.Object {
	case "customers":
		req.Customers = make([]CustomerInput, 0, len(page.Data))
		for _, item := range page.Data {
			req.Customers = append(req.Customers, stripeCustomerInput(item))
		}
	case "checkout_sessions":
		req.Customers = make([]CustomerInput, 0, len(page.Data))
		req.Orders = make([]OrderInput, 0, len(page.Data))
		for _, item := range page.Data {
			if customer := stripeCheckoutCustomer(item); customer.SourceID != "" {
				req.Customers = append(req.Customers, customer)
			}
			if order := stripeCheckoutOrder(item); order.SourceID != "" {
				req.Orders = append(req.Orders, order)
			}
		}
	case "payment_intents":
		req.Orders = make([]OrderInput, 0, len(page.Data))
		for _, item := range page.Data {
			if order := stripePaymentIntentOrder(item); order.SourceID != "" {
				req.Orders = append(req.Orders, order)
			}
		}
	case "charges":
		req.ProviderEvents = make([]ProviderEventInput, 0, len(page.Data))
		for _, item := range page.Data {
			if event := stripeChargeEvent(stripeChargeBackfillTopic(item), item); event.SourceID != "" {
				req.ProviderEvents = append(req.ProviderEvents, event)
			}
		}
	case "disputes":
		req.ProviderEvents = make([]ProviderEventInput, 0, len(page.Data))
		for _, item := range page.Data {
			if event := stripeDisputeEvent("charge.dispute.updated", item); event.SourceID != "" {
				req.ProviderEvents = append(req.ProviderEvents, event)
			}
		}
	case "invoices":
		page.Data, err = b.enrichInvoiceLines(ctx, client, baseURL, creds, page.Data)
		if err != nil {
			return SyncRequest{}, err
		}
		req.Orders = make([]OrderInput, 0, len(page.Data))
		req.ProviderEvents = make([]ProviderEventInput, 0, len(page.Data))
		for _, item := range page.Data {
			if order := stripeInvoiceOrder(item); order.SourceID != "" {
				req.Orders = append(req.Orders, order)
			}
			if event := stripeInvoiceEvent("invoice.updated", item); event.SourceID != "" {
				req.ProviderEvents = append(req.ProviderEvents, event)
			}
		}
	case "credit_notes":
		req.ProviderEvents = make([]ProviderEventInput, 0, len(page.Data))
		for _, item := range page.Data {
			if event := stripeCreditNoteEvent("credit_note.created", item); event.SourceID != "" {
				req.ProviderEvents = append(req.ProviderEvents, event)
			}
		}
	case "subscriptions":
		req.ProviderEvents = make([]ProviderEventInput, 0, len(page.Data))
		for _, item := range page.Data {
			if event := stripeSubscriptionEvent("customer.subscription.updated", item); event.SourceID != "" {
				req.ProviderEvents = append(req.ProviderEvents, event)
			}
		}
	case "refunds":
		req.ProviderEvents = make([]ProviderEventInput, 0, len(page.Data))
		for _, item := range page.Data {
			if event := stripeRefundEvent("refund.created", item); event.SourceID != "" {
				req.ProviderEvents = append(req.ProviderEvents, event)
			}
		}
	default:
		return SyncRequest{}, fmt.Errorf("unsupported Stripe object %q", state.Object)
	}
	if page.HasMore && len(page.Data) > 0 {
		req.Cursor = encodeStripeBackfillCursor(stripeBackfillState{
			Object:        state.Object,
			StartingAfter: stripeObjectID(page.Data[len(page.Data)-1]),
		})
	} else {
		req.Cursor = encodeStripeBackfillCursor(stripeBackfillState{Object: nextStripeBackfillObject(state.Object)})
	}
	return req, nil
}

func (b StripeRESTBackfiller) fetchPage(ctx context.Context, client *http.Client, baseURL string, creds StripeCredentials, state stripeBackfillState) (stripeListResponse, error) {
	path, err := stripeAPIPathForObject(state.Object)
	if err != nil {
		return stripeListResponse{}, err
	}
	u, err := url.Parse(baseURL + path)
	if err != nil {
		return stripeListResponse{}, err
	}
	q := u.Query()
	q.Set("limit", strconv.Itoa(normalizeStripePageSize(b.PageSize)))
	if state.Object == "subscriptions" {
		q.Set("status", "all")
	}
	if state.StartingAfter != "" {
		q.Set("starting_after", state.StartingAfter)
	}
	u.RawQuery = q.Encode()
	return stripeDoList(ctx, client, u.String(), creds.APIKey, path)
}

func (b StripeRESTBackfiller) enrichInvoiceLines(ctx context.Context, client *http.Client, baseURL string, creds StripeCredentials, invoices []map[string]any) ([]map[string]any, error) {
	out := append([]map[string]any(nil), invoices...)
	for idx, invoice := range out {
		if !stripeInvoiceNeedsLinePagination(invoice) {
			continue
		}
		invoiceID := stripeObjectID(invoice)
		if invoiceID == "" {
			continue
		}
		lines, err := b.fetchInvoiceLines(ctx, client, baseURL, creds, invoiceID)
		if err != nil {
			return nil, err
		}
		out[idx] = mergeStripeInvoiceLines(invoice, lines)
	}
	return out, nil
}

func (b StripeRESTBackfiller) fetchInvoiceLines(ctx context.Context, client *http.Client, baseURL string, creds StripeCredentials, invoiceID string) ([]map[string]any, error) {
	path := "/v1/invoices/" + url.PathEscape(strings.TrimSpace(invoiceID)) + "/lines"
	out := []map[string]any{}
	startingAfter := ""
	for page := 0; page < stripeInvoiceLineMaxPages; page++ {
		u, err := url.Parse(baseURL + path)
		if err != nil {
			return nil, err
		}
		q := u.Query()
		q.Set("limit", strconv.Itoa(normalizeStripePageSize(b.PageSize)))
		if startingAfter != "" {
			q.Set("starting_after", startingAfter)
		}
		u.RawQuery = q.Encode()
		resp, err := stripeDoList(ctx, client, u.String(), creds.APIKey, path)
		if err != nil {
			return nil, err
		}
		out = append(out, resp.Data...)
		if !resp.HasMore || len(resp.Data) == 0 {
			return out, nil
		}
		startingAfter = stripeObjectID(resp.Data[len(resp.Data)-1])
		if startingAfter == "" {
			return out, nil
		}
	}
	return nil, fmt.Errorf("stripe invoice %s line pagination exceeded %d pages", invoiceID, stripeInvoiceLineMaxPages)
}

func stripeInvoiceNeedsLinePagination(raw map[string]any) bool {
	lines := mapField(raw, "lines")
	if len(lines) == 0 {
		return false
	}
	if boolField(lines, "has_more") {
		return true
	}
	total := intField(lines, "total_count")
	return total > len(rawArray(lines["data"]))
}

func mergeStripeInvoiceLines(raw map[string]any, lines []map[string]any) map[string]any {
	out := make(map[string]any, len(raw)+1)
	for k, v := range raw {
		out[k] = v
	}
	lineList := map[string]any{}
	for k, v := range mapField(raw, "lines") {
		lineList[k] = v
	}
	data := make([]any, 0, len(lines))
	for _, line := range lines {
		data = append(data, line)
	}
	lineList["data"] = data
	lineList["has_more"] = false
	lineList["total_count"] = len(lines)
	out["lines"] = lineList
	return out
}

func stripeDoList(ctx context.Context, client *http.Client, requestURL, apiKey, path string) (stripeListResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return stripeListResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return stripeListResponse{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := readResponseBodyLimited(resp.Body, stripeResponseMaxBytes)
	if err != nil {
		return stripeListResponse{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return stripeListResponse{}, StripeRateLimitError{
				Path:       path,
				StatusCode: resp.StatusCode,
				RetryAfter: stripeRetryAfter(resp.Header),
				Snippet:    responseSnippet(raw),
			}
		}
		return stripeListResponse{}, fmt.Errorf("stripe REST %s failed %d: %s", path, resp.StatusCode, responseSnippet(raw))
	}
	var out stripeListResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return stripeListResponse{}, fmt.Errorf("decode stripe %s response: %w", path, err)
	}
	return out, nil
}

func decodeStripeBackfillCursor(cursor string) (stripeBackfillState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return stripeBackfillState{}, nil
	}
	if cursor == stripeCursorComplete {
		return stripeBackfillState{Object: "complete"}, nil
	}
	if !strings.HasPrefix(cursor, stripeCursorPrefix) {
		return stripeBackfillState{}, fmt.Errorf("invalid Stripe cursor")
	}
	var state stripeBackfillState
	if err := json.Unmarshal([]byte(strings.TrimPrefix(cursor, stripeCursorPrefix)), &state); err != nil {
		return stripeBackfillState{}, fmt.Errorf("decode Stripe cursor: %w", err)
	}
	state.Object = normalizeStripeBackfillObject(state.Object)
	state.StartingAfter = strings.TrimSpace(state.StartingAfter)
	return state, nil
}

func encodeStripeBackfillCursor(state stripeBackfillState) string {
	state.Object = normalizeStripeBackfillObject(state.Object)
	if state.Object == "" || state.Object == "complete" {
		return stripeCursorComplete
	}
	raw, _ := json.Marshal(state)
	return stripeCursorPrefix + string(raw)
}

func nextStripeBackfillObject(object string) string {
	object = normalizeStripeBackfillObject(object)
	if object == "" {
		return stripeBackfillObjectOrder[0]
	}
	for idx, item := range stripeBackfillObjectOrder {
		if item == object {
			if idx+1 < len(stripeBackfillObjectOrder) {
				return stripeBackfillObjectOrder[idx+1]
			}
			return "complete"
		}
	}
	return "complete"
}

func normalizeStripePageSize(size int) int {
	if size <= 0 {
		return 100
	}
	if size > 100 {
		return 100
	}
	return size
}

func normalizeStripeBackfillObject(object string) string {
	object = strings.TrimSpace(object)
	object = strings.ReplaceAll(object, "-", "_")
	object = strings.ReplaceAll(object, "/", "_")
	switch object {
	case "checkout_sessions", "checkout_session":
		return "checkout_sessions"
	case "payment_intents", "payment_intent":
		return "payment_intents"
	case "charges", "charge":
		return "charges"
	case "disputes", "dispute":
		return "disputes"
	case "customer":
		return "customers"
	case "invoice":
		return "invoices"
	case "credit_notes", "credit_note", "creditnote":
		return "credit_notes"
	case "subscription":
		return "subscriptions"
	case "refund":
		return "refunds"
	default:
		return object
	}
}

func stripeAPIPathForObject(object string) (string, error) {
	switch normalizeStripeBackfillObject(object) {
	case "customers":
		return "/v1/customers", nil
	case "checkout_sessions":
		return "/v1/checkout/sessions", nil
	case "payment_intents":
		return "/v1/payment_intents", nil
	case "charges":
		return "/v1/charges", nil
	case "disputes":
		return "/v1/disputes", nil
	case "invoices":
		return "/v1/invoices", nil
	case "credit_notes":
		return "/v1/credit_notes", nil
	case "subscriptions":
		return "/v1/subscriptions", nil
	case "refunds":
		return "/v1/refunds", nil
	default:
		return "", fmt.Errorf("unsupported Stripe object %q", object)
	}
}

func decodeStripeRetryCursor(cursor string) (stripeRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, stripeRetryCursorPrefix) {
		return stripeRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, stripeRetryCursorPrefix))
	if err != nil {
		return stripeRetryState{}, true, fmt.Errorf("decode Stripe retry cursor: %w", err)
	}
	var state stripeRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return stripeRetryState{}, true, fmt.Errorf("parse Stripe retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeStripeBackfillCursor(stripeBackfillState{Object: "customers"})
	}
	if underlying, err := decodeStripeBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.StartingAfter = underlying.StartingAfter
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeStripeRetryCursor(state stripeRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeStripeBackfillCursor(stripeBackfillState{Object: "customers"})
	}
	if underlying, err := decodeStripeBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.StartingAfter = underlying.StartingAfter
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return stripeRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func stripeRetryCursorDue(state stripeRetryState, now time.Time) bool {
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

func stripeBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := stripeRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeStripeRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(stripeRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeStripeRetryCursor(state)
}

func stripeRetryDelay(attempt int, err error) time.Duration {
	var rateLimit StripeRateLimitError
	if err != nil && errors.As(err, &rateLimit) && rateLimit.RetryAfter > 0 {
		if rateLimit.RetryAfter > stripeRetryMaxDelay {
			return stripeRetryMaxDelay
		}
		return rateLimit.RetryAfter
	}
	if attempt <= 1 {
		return stripeRetryInitialDelay
	}
	delay := stripeRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= stripeRetryMaxDelay {
			return stripeRetryMaxDelay
		}
	}
	return delay
}

func stripeRetryAfter(headers http.Header) time.Duration {
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

type stripeWebhookEvent struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Account string `json:"account"`
	Data    struct {
		Object map[string]any `json:"object"`
	} `json:"data"`
}

func decodeStripeWebhookEvent(body []byte) (stripeWebhookEvent, error) {
	var event stripeWebhookEvent
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&event); err != nil {
		return stripeWebhookEvent{}, fmt.Errorf("decode stripe webhook body: %w", err)
	}
	event.Type = strings.TrimSpace(event.Type)
	event.Account = normalizeStripeAccountID(event.Account)
	if event.Data.Object == nil {
		event.Data.Object = map[string]any{}
	}
	return event, nil
}

func (d *Deps) dispatchStripeWebhook(ctx context.Context, integration *Integration, event stripeWebhookEvent) error {
	if integration == nil {
		return nil
	}
	object := nonNilMap(event.Data.Object)
	switch strings.TrimSpace(event.Type) {
	case "customer.created", "customer.updated":
		in := stripeCustomerInput(object)
		if in.SourceID == "" {
			return fmt.Errorf("stripe customer missing id")
		}
		return d.Repo.UpsertCustomer(ctx, integration.TenantID, integration.ID, in)
	case "customer.deleted":
		sourceID := stripeSourceID("customer", object)
		if sourceID == "" {
			return fmt.Errorf("stripe customer deletion missing id")
		}
		return d.Repo.DeleteCustomer(ctx, integration.TenantID, integration.ID, ProviderDeletion{
			SourceID: sourceID,
			Provider: ProviderStripe,
			Topic:    event.Type,
			Raw:      object,
		})
	case "payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.canceled":
		in := stripePaymentIntentOrder(object)
		if in.SourceID == "" {
			return fmt.Errorf("stripe payment_intent missing id")
		}
		return d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, in)
	case "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed":
		if customer := stripeCheckoutCustomer(object); customer.SourceID != "" {
			if err := d.Repo.UpsertCustomer(ctx, integration.TenantID, integration.ID, customer); err != nil {
				return err
			}
		}
		order := stripeCheckoutOrder(object)
		if order.SourceID == "" {
			return fmt.Errorf("stripe checkout session missing id")
		}
		return d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, order)
	case "checkout.session.expired":
		event := stripeCheckoutSessionEvent(event.Type, object)
		if event.SourceID == "" {
			return nil
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, event)
	case "invoice.created", "invoice.finalized", "invoice.paid", "invoice.payment_succeeded", "invoice.payment_failed", "invoice.updated", "invoice.voided", "invoice.marked_uncollectible", "invoice.deleted":
		if order := stripeInvoiceOrder(object); order.SourceID != "" {
			if err := d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, order); err != nil {
				return err
			}
		}
		event := stripeInvoiceEvent(event.Type, object)
		if event.SourceID == "" {
			return nil
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, event)
	case "charge.succeeded", "charge.failed", "charge.captured", "charge.updated", "charge.refunded":
		event := stripeChargeEvent(event.Type, object)
		if event.SourceID == "" {
			return nil
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, event)
	case "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated":
		event := stripeDisputeEvent(event.Type, object)
		if event.SourceID == "" {
			return nil
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, event)
	case "refund.created", "refund.updated", "refund.failed":
		event := stripeRefundEvent(event.Type, object)
		if event.SourceID == "" {
			return nil
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, event)
	case "credit_note.created", "credit_note.updated", "credit_note.voided":
		event := stripeCreditNoteEvent(event.Type, object)
		if event.SourceID == "" {
			return nil
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, event)
	case "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed", "customer.subscription.pending_update_applied", "customer.subscription.pending_update_expired", "customer.subscription.trial_will_end":
		event := stripeSubscriptionEvent(event.Type, object)
		if event.SourceID == "" {
			return nil
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, event)
	default:
		return nil
	}
}

func stripeWebhookAccountID(event stripeWebhookEvent, fallback string) string {
	return normalizeStripeAccountID(firstNonEmpty(event.Account, fallback))
}

func normalizeStripeAccountID(raw string) string {
	value := strings.TrimSpace(raw)
	value = strings.TrimRight(value, "/")
	return value
}

func stripeCustomerInput(raw map[string]any) CustomerInput {
	name := stringField(raw, "name")
	first, last := splitStripeName(name)
	email := strings.ToLower(strings.TrimSpace(stringField(raw, "email")))
	sourceID := stripeSourceID("customer", raw)
	return CustomerInput{
		SourceID:         sourceID,
		Email:            email,
		FirstName:        first,
		LastName:         last,
		AcceptsMarketing: false,
		Tags:             []string{"stripe_customer"},
		Raw: map[string]any{
			"source":       ProviderStripe,
			"source_id":    sourceID,
			"name":         name,
			"phone":        stringField(raw, "phone"),
			"currency":     strings.ToUpper(stringField(raw, "currency")),
			"metadata":     nonNilMap(mapField(raw, "metadata")),
			"provider_raw": nonNilMap(raw),
		},
	}
}

func stripePaymentIntentOrder(raw map[string]any) OrderInput {
	sourceID := stripeSourceID("payment_intent", raw)
	status := stripeOrderStatus(stringField(raw, "status"))
	email := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		stringField(raw, "receipt_email"),
		stringField(mapField(raw, "billing_details"), "email"),
		stringField(mapField(raw, "metadata"), "customer_email"),
	)))
	total := intField(raw, "amount_received")
	if total <= 0 {
		total = intField(raw, "amount")
	}
	currency := strings.ToUpper(stringField(raw, "currency"))
	orderedAt := unixTimeField(raw, "created")
	return OrderInput{
		SourceID:      sourceID,
		CustomerEmail: email,
		Status:        status,
		TotalCents:    total,
		Currency:      currency,
		Attribution: map[string]any{
			"source":               ProviderStripe,
			"object":               "payment_intent",
			"customer_source_id":   stripeIDSource("customer", stringField(raw, "customer")),
			"customer":             stringField(raw, "customer"),
			"latest_charge":        stringField(raw, "latest_charge"),
			"payment_method":       stringField(raw, "payment_method"),
			"payment_method_types": rawArray(raw["payment_method_types"]),
			"description":          stringField(raw, "description"),
			"metadata":             nonNilMap(mapField(raw, "metadata")),
		},
		LineItems: []map[string]any{{
			"source_id":    sourceID + "/amount",
			"title":        firstNonEmpty(stringField(raw, "description"), "Stripe payment"),
			"quantity":     1,
			"total_cents":  total,
			"currency":     currency,
			"provider_raw": nonNilMap(raw),
		}},
		OrderedAt: orderedAt,
		Raw: map[string]any{
			"source":       ProviderStripe,
			"source_id":    sourceID,
			"provider_raw": nonNilMap(raw),
		},
	}
}

func stripeCheckoutCustomer(raw map[string]any) CustomerInput {
	customerID := stringField(raw, "customer")
	customerDetails := mapField(raw, "customer_details")
	email := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		stringField(customerDetails, "email"),
		stringField(raw, "customer_email"),
	)))
	if customerID == "" && email == "" {
		return CustomerInput{}
	}
	name := stringField(customerDetails, "name")
	first, last := splitStripeName(name)
	sourceID := stripeIDSource("customer", firstNonEmpty(customerID, email))
	return CustomerInput{
		SourceID:         sourceID,
		Email:            email,
		FirstName:        first,
		LastName:         last,
		AcceptsMarketing: strings.EqualFold(stringField(mapField(raw, "consent"), "promotions"), "opt_in"),
		Tags:             []string{"stripe_checkout"},
		Raw: map[string]any{
			"source":       ProviderStripe,
			"source_id":    sourceID,
			"checkout_id":  stringField(raw, "id"),
			"provider_raw": nonNilMap(raw),
		},
	}
}

func stripeCheckoutOrder(raw map[string]any) OrderInput {
	sourceID := stripeSourceID("checkout_session", raw)
	customerDetails := mapField(raw, "customer_details")
	email := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		stringField(customerDetails, "email"),
		stringField(raw, "customer_email"),
	)))
	total := intField(raw, "amount_total")
	currency := strings.ToUpper(stringField(raw, "currency"))
	orderedAt := unixTimeField(raw, "created")
	return OrderInput{
		SourceID:      sourceID,
		CustomerEmail: email,
		Status:        stripeCheckoutStatus(raw),
		SubtotalCents: intField(raw, "amount_subtotal"),
		TotalCents:    total,
		Currency:      currency,
		Attribution: map[string]any{
			"source":              ProviderStripe,
			"object":              "checkout_session",
			"customer_source_id":  stripeIDSource("customer", stringField(raw, "customer")),
			"customer":            stringField(raw, "customer"),
			"client_reference_id": stringField(raw, "client_reference_id"),
			"payment_intent":      stringField(raw, "payment_intent"),
			"subscription":        stringField(raw, "subscription"),
			"mode":                stringField(raw, "mode"),
			"metadata":            nonNilMap(mapField(raw, "metadata")),
		},
		LineItems: []map[string]any{{
			"source_id":    sourceID + "/amount",
			"title":        "Stripe Checkout",
			"quantity":     1,
			"total_cents":  total,
			"currency":     currency,
			"provider_raw": nonNilMap(raw),
		}},
		OrderedAt: orderedAt,
		Raw: map[string]any{
			"source":       ProviderStripe,
			"source_id":    sourceID,
			"provider_raw": nonNilMap(raw),
		},
	}
}

func stripeInvoiceOrder(raw map[string]any) OrderInput {
	sourceID := stripeSourceID("invoice", raw)
	email := strings.ToLower(strings.TrimSpace(stringField(raw, "customer_email")))
	total := intField(raw, "amount_paid")
	if total <= 0 {
		total = intField(raw, "total")
	}
	if total <= 0 {
		total = intField(raw, "amount_due")
	}
	currency := strings.ToUpper(stringField(raw, "currency"))
	orderedAt := firstStripeUnixTime(raw, "status_transitions.paid_at", "created")
	return OrderInput{
		SourceID:      sourceID,
		CustomerEmail: email,
		Status:        stripeInvoiceStatus(raw),
		SubtotalCents: intField(raw, "subtotal"),
		TotalCents:    total,
		Currency:      currency,
		Attribution: map[string]any{
			"source":             ProviderStripe,
			"object":             "invoice",
			"customer_source_id": stripeIDSource("customer", stringField(raw, "customer")),
			"customer":           stringField(raw, "customer"),
			"customer_name":      stringField(raw, "customer_name"),
			"subscription":       stringField(raw, "subscription"),
			"payment_intent":     stringField(raw, "payment_intent"),
			"billing_reason":     stringField(raw, "billing_reason"),
			"collection_method":  stringField(raw, "collection_method"),
			"hosted_invoice_url": stringField(raw, "hosted_invoice_url"),
			"invoice_pdf":        stringField(raw, "invoice_pdf"),
			"amount_due":         intField(raw, "amount_due"),
			"amount_paid":        intField(raw, "amount_paid"),
			"amount_remaining":   intField(raw, "amount_remaining"),
			"amount_shipping":    intField(raw, "amount_shipping"),
			"amount_overpaid":    intField(raw, "amount_overpaid"),
			"total_discount":     stripeInvoiceDiscountTotal(raw),
			"post_credit_amount": intField(raw, "post_payment_credit_notes_amount"),
			"pre_credit_amount":  intField(raw, "pre_payment_credit_notes_amount"),
			"metadata":           nonNilMap(mapField(raw, "metadata")),
			"status_transitions": nonNilMap(mapField(raw, "status_transitions")),
			"webhooks_delivered": intField(raw, "webhooks_delivered_at"),
			"latest_revision":    stringField(raw, "latest_revision"),
		},
		LineItems: stripeInvoiceLineItems(raw),
		OrderedAt: orderedAt,
		Raw: map[string]any{
			"source":       ProviderStripe,
			"source_id":    sourceID,
			"provider_raw": nonNilMap(raw),
		},
	}
}

func stripeOrderStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "succeeded":
		return "paid"
	case "canceled":
		return "cancelled"
	case "requires_payment_method", "requires_confirmation":
		return "cancelled"
	default:
		return "pending"
	}
}

func stripeInvoiceStatus(raw map[string]any) string {
	switch strings.ToLower(strings.TrimSpace(stringField(raw, "status"))) {
	case "paid":
		return "paid"
	case "void":
		return "cancelled"
	case "uncollectible":
		return "cancelled"
	case "open", "draft":
		return "pending"
	default:
		if boolField(raw, "paid") {
			return "paid"
		}
		return "pending"
	}
}

func stripeCheckoutStatus(raw map[string]any) string {
	if strings.EqualFold(stringField(raw, "payment_status"), "paid") {
		return "paid"
	}
	if strings.EqualFold(stringField(raw, "payment_status"), "failed") {
		return "cancelled"
	}
	switch strings.ToLower(stringField(raw, "status")) {
	case "complete":
		return "paid"
	case "expired":
		return "cancelled"
	default:
		return "pending"
	}
}

func stripeSourceID(kind string, raw map[string]any) string {
	return stripeIDSource(kind, stripeObjectID(raw))
}

func stripeIDSource(kind, id string) string {
	id = strings.TrimSpace(id)
	if id == "" || id == "<nil>" {
		return ""
	}
	return "stripe://" + strings.TrimSpace(kind) + "/" + id
}

func stripeObjectID(raw map[string]any) string {
	return stringField(raw, "id")
}

func stripeCheckoutSessionEvent(topic string, raw map[string]any) ProviderEventInput {
	sourceID := stripeSourceID("checkout_session", raw)
	eventType := "checkout_session_updated"
	if strings.EqualFold(topic, "checkout.session.expired") {
		eventType = "checkout_session_expired"
	}
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderStripe,
		Topic:           strings.TrimSpace(topic),
		SourceID:        sourceID,
		ProviderEventID: eventType + ":" + sourceID,
		CustomerEmail: strings.ToLower(strings.TrimSpace(firstNonEmpty(
			stringField(mapField(raw, "customer_details"), "email"),
			stringField(raw, "customer_email"),
		))),
		Metadata: map[string]any{
			"source":         ProviderStripe,
			"topic":          strings.TrimSpace(topic),
			"object":         "checkout_session",
			"source_id":      sourceID,
			"status":         stringField(raw, "status"),
			"payment_status": stringField(raw, "payment_status"),
			"customer":       stringField(raw, "customer"),
			"payment_intent": stringField(raw, "payment_intent"),
			"subscription":   stringField(raw, "subscription"),
			"mode":           stringField(raw, "mode"),
			"amount_total":   intField(raw, "amount_total"),
			"currency":       strings.ToUpper(stringField(raw, "currency")),
			"expires_at":     stripeUnixTimeString(raw, "expires_at"),
			"provider_raw":   nonNilMap(raw),
		},
	}
}

func stripeChargeBackfillTopic(raw map[string]any) string {
	if strings.EqualFold(stringField(raw, "status"), "failed") || stringField(raw, "failure_code") != "" {
		return "charge.failed"
	}
	if boolField(raw, "refunded") || intField(raw, "amount_refunded") > 0 {
		return "charge.refunded"
	}
	if boolField(raw, "paid") || strings.EqualFold(stringField(raw, "status"), "succeeded") {
		return "charge.succeeded"
	}
	return "charge.updated"
}

func stripeChargeEvent(topic string, raw map[string]any) ProviderEventInput {
	topic = strings.TrimSpace(topic)
	eventType := "transaction_updated"
	if topic == "charge.succeeded" {
		eventType = "transaction_created"
	}
	sourceID := stripeSourceID("charge", raw)
	email := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		stringField(mapField(raw, "billing_details"), "email"),
		stringField(raw, "receipt_email"),
		stringField(mapField(raw, "metadata"), "customer_email"),
	)))
	amount := intField(raw, "amount")
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderStripe,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: eventType + ":" + sourceID,
		CustomerEmail:   email,
		Metadata: map[string]any{
			"source":                 ProviderStripe,
			"topic":                  topic,
			"object":                 "charge",
			"source_id":              sourceID,
			"amount_cents":           amount,
			"amount_refunded_cents":  intField(raw, "amount_refunded"),
			"captured":               boolField(raw, "captured"),
			"paid":                   boolField(raw, "paid"),
			"refunded":               boolField(raw, "refunded"),
			"disputed":               boolField(raw, "disputed"),
			"currency":               strings.ToUpper(stringField(raw, "currency")),
			"status":                 stringField(raw, "status"),
			"failure_code":           stringField(raw, "failure_code"),
			"failure_message":        stringField(raw, "failure_message"),
			"customer":               stringField(raw, "customer"),
			"customer_source_id":     stripeIDSource("customer", stringField(raw, "customer")),
			"payment_intent":         stringField(raw, "payment_intent"),
			"payment_method":         stringField(raw, "payment_method"),
			"balance_transaction":    stringField(raw, "balance_transaction"),
			"receipt_email":          email,
			"receipt_number":         stringField(raw, "receipt_number"),
			"receipt_url":            stringField(raw, "receipt_url"),
			"created":                stripeUnixTimeString(raw, "created"),
			"billing_details":        nonNilMap(mapField(raw, "billing_details")),
			"payment_method_details": nonNilMap(mapField(raw, "payment_method_details")),
			"outcome":                nonNilMap(mapField(raw, "outcome")),
			"fraud_details":          nonNilMap(mapField(raw, "fraud_details")),
			"metadata":               nonNilMap(mapField(raw, "metadata")),
			"provider_raw":           nonNilMap(raw),
		},
	}
}

func stripeRefundEvent(topic string, raw map[string]any) ProviderEventInput {
	topic = strings.TrimSpace(topic)
	eventType := "refund_created"
	switch topic {
	case "refund.updated", "charge.refund.updated":
		eventType = "refund_updated"
	case "refund.failed":
		eventType = "refund_failed"
	}
	sourceID := stripeSourceID("refund", raw)
	amount := intField(raw, "amount")
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderStripe,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: eventType + ":" + sourceID,
		Metadata: map[string]any{
			"source":              ProviderStripe,
			"topic":               topic,
			"object":              "refund",
			"source_id":           sourceID,
			"amount_cents":        amount,
			"refund_cents":        absoluteCents(amount),
			"currency":            strings.ToUpper(stringField(raw, "currency")),
			"status":              stringField(raw, "status"),
			"reason":              stringField(raw, "reason"),
			"charge":              stringField(raw, "charge"),
			"payment_intent":      stringField(raw, "payment_intent"),
			"balance_transaction": stringField(raw, "balance_transaction"),
			"receipt_number":      stringField(raw, "receipt_number"),
			"created":             stripeUnixTimeString(raw, "created"),
			"destination_details": nonNilMap(mapField(raw, "destination_details")),
			"metadata":            nonNilMap(mapField(raw, "metadata")),
			"provider_raw":        nonNilMap(raw),
		},
	}
}

func stripeDisputeEvent(topic string, raw map[string]any) ProviderEventInput {
	topic = strings.TrimSpace(topic)
	eventType := "dispute_updated"
	switch topic {
	case "charge.dispute.created":
		eventType = "dispute_created"
	case "charge.dispute.closed":
		eventType = "dispute_closed"
	case "charge.dispute.funds_withdrawn":
		eventType = "dispute_funds_withdrawn"
	case "charge.dispute.funds_reinstated":
		eventType = "dispute_funds_reinstated"
	}
	sourceID := stripeSourceID("dispute", raw)
	amount := intField(raw, "amount")
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderStripe,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: eventType + ":" + sourceID,
		Metadata: map[string]any{
			"source":                 ProviderStripe,
			"topic":                  topic,
			"object":                 "dispute",
			"source_id":              sourceID,
			"amount_cents":           amount,
			"dispute_amount_cents":   amount,
			"currency":               strings.ToUpper(stringField(raw, "currency")),
			"status":                 stringField(raw, "status"),
			"reason":                 stringField(raw, "reason"),
			"charge":                 stringField(raw, "charge"),
			"charge_source_id":       stripeIDSource("charge", stringField(raw, "charge")),
			"payment_intent":         stringField(raw, "payment_intent"),
			"balance_transactions":   stripeBalanceTransactionIDs(rawArray(raw["balance_transactions"])),
			"evidence_details":       nonNilMap(mapField(raw, "evidence_details")),
			"payment_method_details": nonNilMap(mapField(raw, "payment_method_details")),
			"is_charge_refundable":   boolField(raw, "is_charge_refundable"),
			"created":                stripeUnixTimeString(raw, "created"),
			"metadata":               nonNilMap(mapField(raw, "metadata")),
			"provider_raw":           nonNilMap(raw),
		},
	}
}

func stripeCreditNoteEvent(topic string, raw map[string]any) ProviderEventInput {
	topic = strings.TrimSpace(topic)
	eventType := "credit_note_created"
	switch topic {
	case "credit_note.updated":
		eventType = "credit_note_updated"
	case "credit_note.voided":
		eventType = "credit_note_voided"
	}
	sourceID := stripeSourceID("credit_note", raw)
	amount := firstPositiveInt(intField(raw, "total"), intField(raw, "amount"))
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderStripe,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: eventType + ":" + sourceID,
		Metadata: map[string]any{
			"source":                   ProviderStripe,
			"topic":                    topic,
			"object":                   "credit_note",
			"source_id":                sourceID,
			"amount_cents":             amount,
			"credit_note_amount_cents": amount,
			"subtotal_cents":           intField(raw, "subtotal"),
			"total_cents":              intField(raw, "total"),
			"currency":                 strings.ToUpper(stringField(raw, "currency")),
			"status":                   stringField(raw, "status"),
			"reason":                   stringField(raw, "reason"),
			"type":                     stringField(raw, "type"),
			"number":                   stringField(raw, "number"),
			"memo":                     stringField(raw, "memo"),
			"invoice":                  stringField(raw, "invoice"),
			"invoice_source_id":        stripeIDSource("invoice", stringField(raw, "invoice")),
			"customer":                 stringField(raw, "customer"),
			"customer_source_id":       stripeIDSource("customer", stringField(raw, "customer")),
			"refund":                   stringField(raw, "refund"),
			"refund_source_id":         stripeIDSource("refund", stringField(raw, "refund")),
			"customer_balance_txn":     stringField(raw, "customer_balance_transaction"),
			"out_of_band_amount":       intField(raw, "out_of_band_amount"),
			"pre_payment_amount":       intField(raw, "pre_payment_amount"),
			"post_payment_amount":      intField(raw, "post_payment_amount"),
			"created":                  stripeUnixTimeString(raw, "created"),
			"voided_at":                stripeUnixTimeString(raw, "voided_at"),
			"lines":                    stripeCreditNoteLineItems(raw),
			"metadata":                 nonNilMap(mapField(raw, "metadata")),
			"provider_raw":             nonNilMap(raw),
		},
	}
}

func stripeBalanceTransactionIDs(items []any) []string {
	out := []string{}
	for _, item := range items {
		switch typed := item.(type) {
		case string:
			if id := strings.TrimSpace(typed); id != "" {
				out = append(out, id)
			}
		case map[string]any:
			if id := stringField(typed, "id"); id != "" {
				out = append(out, id)
			}
		}
	}
	return out
}

func stripeCreditNoteLineItems(raw map[string]any) []map[string]any {
	lines := rawArray(mapField(raw, "lines")["data"])
	out := make([]map[string]any, 0, len(lines))
	for idx, item := range lines {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		sourceID := stripeIDSource("credit_note_line", stringField(m, "id"))
		if sourceID == "" {
			sourceID = stripeSourceID("credit_note", raw) + "/line/" + strconv.Itoa(idx+1)
		}
		out = append(out, map[string]any{
			"source_id":         sourceID,
			"title":             firstNonEmpty(stringField(m, "description"), stringField(m, "invoice_line_item"), "Stripe credit note line"),
			"type":              stringField(m, "type"),
			"quantity":          intField(m, "quantity"),
			"amount_cents":      intField(m, "amount"),
			"discount_cents":    intField(m, "discount_amount"),
			"unit_amount_cents": intField(m, "unit_amount"),
			"invoice_line_item": stringField(m, "invoice_line_item"),
			"provider_raw":      nonNilMap(m),
		})
	}
	return out
}

func firstPositiveInt(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func stripeSubscriptionEvent(topic string, raw map[string]any) ProviderEventInput {
	topic = strings.TrimSpace(topic)
	eventType := "subscription_updated"
	switch topic {
	case "customer.subscription.created":
		eventType = "subscription_created"
	case "customer.subscription.deleted":
		eventType = "subscription_deleted"
	}
	sourceID := stripeSourceID("subscription", raw)
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderStripe,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: eventType + ":" + sourceID,
		Metadata: map[string]any{
			"source":               ProviderStripe,
			"topic":                topic,
			"object":               "subscription",
			"source_id":            sourceID,
			"status":               stringField(raw, "status"),
			"customer":             stringField(raw, "customer"),
			"customer_source_id":   stripeIDSource("customer", stringField(raw, "customer")),
			"currency":             strings.ToUpper(stringField(raw, "currency")),
			"latest_invoice":       stringField(raw, "latest_invoice"),
			"collection_method":    stringField(raw, "collection_method"),
			"cancel_at_period_end": boolField(raw, "cancel_at_period_end"),
			"created":              stripeUnixTimeString(raw, "created"),
			"start_date":           stripeUnixTimeString(raw, "start_date"),
			"trial_start":          stripeUnixTimeString(raw, "trial_start"),
			"trial_end":            stripeUnixTimeString(raw, "trial_end"),
			"cancel_at":            stripeUnixTimeString(raw, "cancel_at"),
			"canceled_at":          stripeUnixTimeString(raw, "canceled_at"),
			"ended_at":             stripeUnixTimeString(raw, "ended_at"),
			"current_period_start": stripeSubscriptionItemUnix(raw, "current_period_start"),
			"current_period_end":   stripeSubscriptionItemUnix(raw, "current_period_end"),
			"items":                stripeSubscriptionItems(raw),
			"metadata":             nonNilMap(mapField(raw, "metadata")),
			"cancellation_details": nonNilMap(mapField(raw, "cancellation_details")),
			"provider_raw":         nonNilMap(raw),
		},
	}
}

func stripeInvoiceEvent(topic string, raw map[string]any) ProviderEventInput {
	topic = strings.TrimSpace(topic)
	eventType := strings.ReplaceAll(topic, ".", "_")
	if topic == "invoice.payment_succeeded" {
		eventType = "invoice_paid"
	}
	sourceID := stripeSourceID("invoice", raw)
	email := strings.ToLower(strings.TrimSpace(stringField(raw, "customer_email")))
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderStripe,
		Topic:           topic,
		SourceID:        sourceID,
		ProviderEventID: eventType + ":" + sourceID,
		CustomerEmail:   email,
		Metadata: map[string]any{
			"source":             ProviderStripe,
			"topic":              topic,
			"object":             "invoice",
			"source_id":          sourceID,
			"status":             stringField(raw, "status"),
			"customer_email":     email,
			"customer":           stringField(raw, "customer"),
			"customer_source_id": stripeIDSource("customer", stringField(raw, "customer")),
			"subscription":       stringField(raw, "subscription"),
			"payment_intent":     stringField(raw, "payment_intent"),
			"billing_reason":     stringField(raw, "billing_reason"),
			"collection_method":  stringField(raw, "collection_method"),
			"currency":           strings.ToUpper(stringField(raw, "currency")),
			"subtotal_cents":     intField(raw, "subtotal"),
			"total_cents":        intField(raw, "total"),
			"amount_due":         intField(raw, "amount_due"),
			"amount_paid":        intField(raw, "amount_paid"),
			"amount_remaining":   intField(raw, "amount_remaining"),
			"hosted_invoice_url": stringField(raw, "hosted_invoice_url"),
			"invoice_pdf":        stringField(raw, "invoice_pdf"),
			"status_transitions": nonNilMap(mapField(raw, "status_transitions")),
			"lines":              stripeInvoiceLineItems(raw),
			"metadata":           nonNilMap(mapField(raw, "metadata")),
			"provider_raw":       nonNilMap(raw),
		},
	}
}

func stripeInvoiceLineItems(raw map[string]any) []map[string]any {
	lines := rawArray(mapField(raw, "lines")["data"])
	out := make([]map[string]any, 0, len(lines))
	for idx, item := range lines {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		sourceID := stripeIDSource("invoice_line", stringField(m, "id"))
		if sourceID == "" {
			sourceID = stripeSourceID("invoice", raw) + "/line/" + strconv.Itoa(idx+1)
		}
		out = append(out, map[string]any{
			"source_id":    sourceID,
			"title":        firstNonEmpty(stringField(m, "description"), stringField(mapField(m, "price"), "nickname"), stripeLineProductID(m), "Stripe invoice line"),
			"quantity":     intField(m, "quantity"),
			"total_cents":  intField(m, "amount"),
			"currency":     strings.ToUpper(firstNonEmpty(stringField(m, "currency"), stringField(raw, "currency"))),
			"price":        stripeLinePriceID(m),
			"product":      stripeLineProductID(m),
			"subscription": stripeLineSubscriptionID(m),
			"period":       nonNilMap(mapField(m, "period")),
			"provider_raw": nonNilMap(m),
		})
	}
	if len(out) == 0 {
		sourceID := stripeSourceID("invoice", raw)
		total := intField(raw, "total")
		out = append(out, map[string]any{
			"source_id":    sourceID + "/amount",
			"title":        firstNonEmpty(stringField(raw, "description"), "Stripe invoice"),
			"quantity":     1,
			"total_cents":  total,
			"currency":     strings.ToUpper(stringField(raw, "currency")),
			"provider_raw": nonNilMap(raw),
		})
	}
	return out
}

func stripeLinePriceID(raw map[string]any) string {
	if id := stringField(mapField(raw, "price"), "id"); id != "" {
		return id
	}
	return firstNonEmpty(
		stringField(mapField(mapField(raw, "pricing"), "price_details"), "price"),
		stringField(raw, "price"),
	)
}

func stripeLineProductID(raw map[string]any) string {
	return firstNonEmpty(
		stringField(mapField(mapField(raw, "price"), "product"), "id"),
		stringField(mapField(raw, "price"), "product"),
		stringField(mapField(mapField(raw, "pricing"), "price_details"), "product"),
	)
}

func stripeLineSubscriptionID(raw map[string]any) string {
	parent := mapField(raw, "parent")
	return firstNonEmpty(
		stringField(raw, "subscription"),
		stringField(mapField(parent, "subscription_item_details"), "subscription"),
		stringField(mapField(parent, "invoice_item_details"), "subscription"),
	)
}

func stripeInvoiceDiscountTotal(raw map[string]any) int {
	total := 0
	for _, item := range rawArray(raw["total_discount_amounts"]) {
		m, _ := item.(map[string]any)
		total += intField(m, "amount")
	}
	return total
}

func stripeSubscriptionItems(raw map[string]any) []map[string]any {
	items := rawArray(mapField(raw, "items")["data"])
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		price := mapField(m, "price")
		recurring := mapField(price, "recurring")
		out = append(out, map[string]any{
			"source_id":            stripeIDSource("subscription_item", stringField(m, "id")),
			"subscription":         stringField(m, "subscription"),
			"quantity":             intField(m, "quantity"),
			"price":                stringField(price, "id"),
			"product":              stringField(price, "product"),
			"unit_amount":          intField(price, "unit_amount"),
			"currency":             strings.ToUpper(stringField(price, "currency")),
			"interval":             stringField(recurring, "interval"),
			"interval_count":       intField(recurring, "interval_count"),
			"current_period_start": stripeUnixTimeString(m, "current_period_start"),
			"current_period_end":   stripeUnixTimeString(m, "current_period_end"),
			"metadata":             nonNilMap(mapField(m, "metadata")),
			"provider_raw":         nonNilMap(m),
		})
	}
	return out
}

func stripeSubscriptionItemUnix(raw map[string]any, key string) string {
	for _, item := range rawArray(mapField(raw, "items")["data"]) {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		if out := stripeUnixTimeString(m, key); out != "" {
			return out
		}
	}
	return ""
}

func firstStripeUnixTime(raw map[string]any, keys ...string) *time.Time {
	for _, key := range keys {
		var value int
		if strings.Contains(key, ".") {
			parts := strings.SplitN(key, ".", 2)
			value = intField(mapField(raw, parts[0]), parts[1])
		} else {
			value = intField(raw, key)
		}
		if value > 0 {
			t := time.Unix(int64(value), 0).UTC()
			return &t
		}
	}
	return nil
}

func stripeUnixTimeString(raw map[string]any, key string) string {
	value := intField(raw, key)
	if value <= 0 {
		return ""
	}
	return time.Unix(int64(value), 0).UTC().Format(time.RFC3339)
}

func splitStripeName(name string) (string, string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", ""
	}
	parts := strings.Fields(name)
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.Join(parts[1:], " ")
}

func unixTimeField(raw map[string]any, key string) *time.Time {
	value := intField(raw, key)
	if value <= 0 {
		return nil
	}
	t := time.Unix(int64(value), 0).UTC()
	return &t
}
