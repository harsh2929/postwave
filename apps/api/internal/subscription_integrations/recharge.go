// SPDX-License-Identifier: AGPL-3.0-only
//
// recharge.go — native Recharge provider runtime.
//
// Recharge is the dominant Shopify subscription platform; subscription
// lifecycle (upcoming charge, dunning, churn, skip/swap) powers the
// highest-ROI retention flows. This file adds the provider-facing half the
// subscription_integrations foundation lacked: a credential resolver, a REST
// puller over the Subscriptions API, canonical mapping, and webhook event
// mapping (the HMAC verifier already lives in signatures.go).
package subscription_integrations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	rechargeDefaultAPIBaseURL = "https://api.rechargeapps.com"
	rechargeDefaultUserAgent  = "Moosewave Recharge Integration"
	rechargeResponseMaxBytes  = 8 << 20
	rechargeDefaultPageSize   = 250
	rechargeMaxPageSize       = 250
	rechargeCursorPrefix      = "recharge:"
	rechargeCursorComplete    = "recharge:complete"
)

var errNotJSONSecret = errors.New("subscription_integrations: secret is not JSON")

// RechargeCredentials carries the resolved Recharge API access token.
type RechargeCredentials struct {
	AccessToken string
	APIBaseURL  string
	APIVersion  string
	UserAgent   string
}

type RechargeCredentialResolver interface {
	ResolveRecharge(ctx context.Context, tenantID string, integration Integration) (RechargeCredentials, error)
}

// SubscriptionRuntimeSecretResolver is the trusted secrets backend.
type SubscriptionRuntimeSecretResolver interface {
	Get(ctx context.Context, ref string) (string, error)
	GetJSON(ctx context.Context, ref string, out any) error
}

type rechargeCredentialPayload struct {
	AccessToken string `json:"access_token"`
	Token       string `json:"token"`
	APIKey      string `json:"api_key"`
	APIBaseURL  string `json:"api_base_url"`
	APIVersion  string `json:"api_version"`
	UserAgent   string `json:"user_agent"`
}

func (p rechargeCredentialPayload) credentials() (RechargeCredentials, error) {
	token := strings.TrimSpace(firstString(p.AccessToken, p.Token, p.APIKey))
	if token == "" {
		return RechargeCredentials{}, fmt.Errorf("recharge access_token is required")
	}
	return RechargeCredentials{
		AccessToken: token,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		APIVersion:  strings.TrimSpace(p.APIVersion),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

// RechargeSecretsCredentialResolver resolves credentials_ref through the vault.
type RechargeSecretsCredentialResolver struct {
	Secrets SubscriptionRuntimeSecretResolver
}

func (r RechargeSecretsCredentialResolver) ResolveRecharge(ctx context.Context, _ string, integration Integration) (RechargeCredentials, error) {
	if r.Secrets == nil {
		return RechargeCredentials{}, fmt.Errorf("recharge credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return RechargeCredentials{}, fmt.Errorf("recharge credentials_ref is required")
	}
	var payload rechargeCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return RechargeCredentials{}, fmt.Errorf("resolve recharge credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return RechargeCredentials{}, fmt.Errorf("recharge credentials %q are empty", ref)
	}
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			return payload.credentials()
		}
	}
	return rechargeCredentialPayload{AccessToken: raw}.credentials()
}

// RechargeBackfiller pulls a page of subscriptions into canonical form.
type RechargeBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type RechargeRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials RechargeCredentialResolver
	APIBaseURL  string
	APIVersion  string
	UserAgent   string
	PageSize    int
}

type rechargeSubscription struct {
	ID                     json.Number `json:"id"`
	CustomerID             json.Number `json:"customer_id"`
	Email                  string      `json:"email"`
	Status                 string      `json:"status"`
	ExternalProductID      string      `json:"external_product_id"`
	ProductTitle           string      `json:"product_title"`
	SKU                    string      `json:"sku"`
	NextChargeScheduledAt  string      `json:"next_charge_scheduled_at"`
	CancelledAt            string      `json:"cancelled_at"`
	OrderIntervalFrequency string      `json:"order_interval_frequency"`
	OrderIntervalUnit      string      `json:"order_interval_unit"`
	UpdatedAt              string      `json:"updated_at"`
}

type rechargeScalar string

func (v *rechargeScalar) UnmarshalJSON(raw []byte) error {
	value := strings.TrimSpace(string(raw))
	if value == "" || value == "null" {
		*v = ""
		return nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		*v = rechargeScalar(strings.TrimSpace(s))
		return nil
	}
	*v = rechargeScalar(value)
	return nil
}

func (v rechargeScalar) String() string {
	return strings.TrimSpace(string(v))
}

type rechargeCharge struct {
	ID              rechargeScalar   `json:"id"`
	Email           string           `json:"email"`
	CustomerID      rechargeScalar   `json:"customer_id"`
	SubscriptionID  rechargeScalar   `json:"subscription_id"`
	SubscriptionIDs []rechargeScalar `json:"subscription_ids"`
	OrderID         rechargeScalar   `json:"order_id"`
	ExternalOrderID rechargeScalar   `json:"external_order_id"`
	Status          string           `json:"status"`
	Type            string           `json:"type"`
	TotalPrice      rechargeScalar   `json:"total_price"`
	SubtotalPrice   rechargeScalar   `json:"subtotal_price"`
	TotalTax        rechargeScalar   `json:"total_tax"`
	TotalDiscounts  rechargeScalar   `json:"total_discounts"`
	TotalRefunds    rechargeScalar   `json:"total_refunds"`
	Currency        string           `json:"currency"`
	ScheduledAt     string           `json:"scheduled_at"`
	ProcessedAt     string           `json:"processed_at"`
	CreatedAt       string           `json:"created_at"`
	UpdatedAt       string           `json:"updated_at"`
	Customer        struct {
		ID    rechargeScalar `json:"id"`
		Email string         `json:"email"`
	} `json:"customer"`
	Subscriptions []struct {
		ID             rechargeScalar `json:"id"`
		SubscriptionID rechargeScalar `json:"subscription_id"`
	} `json:"subscriptions"`
	LineItems []struct {
		ID                rechargeScalar `json:"id"`
		SubscriptionID    rechargeScalar `json:"subscription_id"`
		ExternalProductID rechargeScalar `json:"external_product_id"`
		ProductTitle      string         `json:"product_title"`
		SKU               string         `json:"sku"`
		Quantity          rechargeScalar `json:"quantity"`
		Price             rechargeScalar `json:"price"`
	} `json:"line_items"`
}

type rechargeSubscriptionsResponse struct {
	Subscriptions []rechargeSubscription `json:"subscriptions"`
	NextCursor    string                 `json:"next_cursor"`
}

func (b RechargeRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderRecharge {
		return SyncRequest{}, fmt.Errorf("recharge backfill requires a Recharge integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("recharge credential resolver is not configured")
	}
	state := decodeRechargeCursor(cursor)
	if state == rechargeCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: rechargeCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveRecharge(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := subscriptionEgressClient(b.HTTPClient, ProviderRecharge, 20*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), rechargeDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("limit", strconv.Itoa(rechargePageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
	if state != "" {
		query.Set("cursor", state)
	}

	var out rechargeSubscriptionsResponse
	if err := rechargeDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/subscriptions", query, &out); err != nil {
		return SyncRequest{}, err
	}
	subs := make([]SubscriptionInput, 0, len(out.Subscriptions))
	for _, s := range out.Subscriptions {
		if sub, ok := mapRechargeSubscription(s, integration); ok {
			subs = append(subs, sub)
		}
	}
	nextCursor := rechargeCursorComplete
	if strings.TrimSpace(out.NextCursor) != "" {
		nextCursor = rechargeCursorPrefix + strings.TrimSpace(out.NextCursor)
	}
	return SyncRequest{RunMode: "backfill", Subscriptions: subs, Cursor: nextCursor}, nil
}

func mapRechargeSubscription(s rechargeSubscription, integration Integration) (SubscriptionInput, bool) {
	email := strings.ToLower(strings.TrimSpace(s.Email))
	if email == "" {
		return SubscriptionInput{}, false
	}
	id := strings.TrimSpace(s.ID.String())
	out := SubscriptionInput{
		SourceID:       "recharge://subscription/" + id,
		Email:          email,
		CustomerID:     strings.TrimSpace(s.CustomerID.String()),
		SubscriptionID: id,
		Status:         strings.TrimSpace(s.Status),
		ProductID:      strings.TrimSpace(firstString(s.ExternalProductID, s.ProductTitle)),
		SKU:            strings.TrimSpace(s.SKU),
		Frequency:      strings.TrimSpace(strings.TrimSpace(s.OrderIntervalFrequency + " " + s.OrderIntervalUnit)),
		Properties: map[string]any{
			"recharge_subscription_id": id,
			"recharge_product_title":   s.ProductTitle,
		},
	}
	if t := parseRechargeTime(s.NextChargeScheduledAt); t != nil {
		out.NextChargeAt = t
	}
	if t := parseRechargeTime(s.CancelledAt); t != nil {
		out.CancelledAt = t
	}
	if t := parseRechargeTime(s.UpdatedAt); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func rechargeDoJSON(ctx context.Context, client *http.Client, baseURL string, creds RechargeCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse recharge API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Recharge-Access-Token", strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	if v := strings.TrimSpace(firstString(creds.APIVersion, "2021-11")); v != "" {
		req.Header.Set("X-Recharge-Version", v)
	}
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, rechargeDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, rechargeResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return RechargeRESTError{StatusCode: resp.StatusCode, RetryAfter: parseRechargeRetryAfter(resp.Header.Get("Retry-After")), Snippet: rechargeTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode recharge response %s: %w", path, err)
	}
	return nil
}

// RechargeRESTError carries the provider status + Retry-After for retry cursors.
type RechargeRESTError struct {
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e RechargeRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("recharge REST failed %d; retry after %s: %s", e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("recharge REST failed %d: %s", e.StatusCode, e.Snippet)
}

func decodeRechargeCursor(cursor string) string {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return ""
	}
	if cursor == rechargeCursorComplete {
		return rechargeCursorComplete
	}
	return strings.TrimPrefix(cursor, rechargeCursorPrefix)
}

func rechargePageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return rechargeDefaultPageSize
	}
	if n > rechargeMaxPageSize {
		return rechargeMaxPageSize
	}
	return n
}

func parseRechargeTime(value string) *time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			utc := parsed.UTC()
			return &utc
		}
	}
	return nil
}

func parseRechargeRetryAfter(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	return 0
}

func rechargeTruncate(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit]
}

// rechargeHexSHA256 reproduces Recharge's webhook signature (hex(sha256(secret+body))).
func rechargeHexSHA256(secret string, body []byte) string {
	sum := sha256.Sum256(append([]byte(secret), body...))
	return hex.EncodeToString(sum[:])
}

// mapRechargeWebhookEvent maps a Recharge webhook payload into a canonical
// subscription upsert (subscription topics) or lifecycle event (charge topics).
func mapRechargeWebhookEvent(topic string, body []byte, integration Integration) (SyncRequest, bool) {
	topic = strings.ToLower(strings.TrimSpace(topic))
	switch {
	case strings.HasPrefix(topic, "subscription/"):
		var payload struct {
			Subscription rechargeSubscription `json:"subscription"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			return SyncRequest{}, false
		}
		if sub, ok := mapRechargeSubscription(payload.Subscription, integration); ok {
			return SyncRequest{RunMode: "webhook", Subscriptions: []SubscriptionInput{sub}}, true
		}
	case strings.HasPrefix(topic, "charge/"):
		var payload struct {
			Charge rechargeCharge `json:"charge"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			return SyncRequest{}, false
		}
		email := strings.ToLower(strings.TrimSpace(firstString(payload.Charge.Email, payload.Charge.Customer.Email)))
		if email == "" {
			return SyncRequest{}, false
		}
		chargeID := payload.Charge.ID.String()
		subscriptionID := firstRechargeSubscriptionID(payload.Charge)
		orderID := firstString(payload.Charge.OrderID.String(), payload.Charge.ExternalOrderID.String())
		status := strings.TrimSpace(payload.Charge.Status)
		props := rechargeChargeProperties(topic, payload.Charge)
		occurredAt := parseRechargeTime(firstString(
			payload.Charge.ProcessedAt,
			payload.Charge.UpdatedAt,
			payload.Charge.CreatedAt,
			payload.Charge.ScheduledAt,
		))
		sourceID := "recharge://charge/" + firstString(chargeID, orderID, subscriptionID, email+"-"+strings.ReplaceAll(topic, "/", "-"))
		return SyncRequest{RunMode: "webhook", Events: []LifecycleEventInput{{
			SourceID:       sourceID,
			Email:          email,
			EventName:      "recharge." + strings.ReplaceAll(topic, "/", "."),
			SubscriptionID: subscriptionID,
			OrderID:        orderID,
			Status:         status,
			Properties:     props,
			OccurredAt:     occurredAt,
		}}}, true
	}
	return SyncRequest{}, false
}

func firstRechargeSubscriptionID(charge rechargeCharge) string {
	if id := charge.SubscriptionID.String(); id != "" {
		return id
	}
	for _, id := range charge.SubscriptionIDs {
		if value := id.String(); value != "" {
			return value
		}
	}
	for _, sub := range charge.Subscriptions {
		if id := firstString(sub.SubscriptionID.String(), sub.ID.String()); id != "" {
			return id
		}
	}
	for _, item := range charge.LineItems {
		if id := item.SubscriptionID.String(); id != "" {
			return id
		}
	}
	return ""
}

func rechargeChargeProperties(topic string, charge rechargeCharge) map[string]any {
	props := map[string]any{"recharge_topic": topic}
	addRechargeStringProp(props, "recharge_charge_id", charge.ID.String())
	addRechargeStringProp(props, "recharge_customer_id", firstString(charge.CustomerID.String(), charge.Customer.ID.String()))
	addRechargeStringProp(props, "recharge_order_id", charge.OrderID.String())
	addRechargeStringProp(props, "recharge_external_order_id", charge.ExternalOrderID.String())
	addRechargeStringProp(props, "recharge_charge_status", charge.Status)
	addRechargeStringProp(props, "recharge_charge_type", charge.Type)
	addRechargeStringProp(props, "recharge_currency", charge.Currency)
	addRechargeStringProp(props, "recharge_total_price", charge.TotalPrice.String())
	addRechargeStringProp(props, "recharge_subtotal_price", charge.SubtotalPrice.String())
	addRechargeStringProp(props, "recharge_total_tax", charge.TotalTax.String())
	addRechargeStringProp(props, "recharge_total_discounts", charge.TotalDiscounts.String())
	addRechargeStringProp(props, "recharge_total_refunds", charge.TotalRefunds.String())
	addRechargeStringProp(props, "recharge_scheduled_at", charge.ScheduledAt)
	addRechargeStringProp(props, "recharge_processed_at", charge.ProcessedAt)
	addRechargeStringProp(props, "recharge_created_at", charge.CreatedAt)
	addRechargeStringProp(props, "recharge_updated_at", charge.UpdatedAt)
	if ids := rechargeChargeSubscriptionIDs(charge); len(ids) > 0 {
		props["recharge_subscription_ids"] = ids
	}
	if items := rechargeChargeLineItems(charge); len(items) > 0 {
		props["recharge_line_items"] = items
	}
	return props
}

func addRechargeStringProp(props map[string]any, key, value string) {
	if value = strings.TrimSpace(value); value != "" {
		props[key] = value
	}
}

func rechargeChargeSubscriptionIDs(charge rechargeCharge) []string {
	seen := map[string]struct{}{}
	out := []string{}
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	add(charge.SubscriptionID.String())
	for _, id := range charge.SubscriptionIDs {
		add(id.String())
	}
	for _, sub := range charge.Subscriptions {
		add(firstString(sub.SubscriptionID.String(), sub.ID.String()))
	}
	for _, item := range charge.LineItems {
		add(item.SubscriptionID.String())
	}
	return out
}

func rechargeChargeLineItems(charge rechargeCharge) []map[string]any {
	out := make([]map[string]any, 0, len(charge.LineItems))
	for _, item := range charge.LineItems {
		row := map[string]any{}
		addRechargeStringProp(row, "id", item.ID.String())
		addRechargeStringProp(row, "subscription_id", item.SubscriptionID.String())
		addRechargeStringProp(row, "external_product_id", item.ExternalProductID.String())
		addRechargeStringProp(row, "product_title", item.ProductTitle)
		addRechargeStringProp(row, "sku", item.SKU)
		addRechargeStringProp(row, "quantity", item.Quantity.String())
		addRechargeStringProp(row, "price", item.Price.String())
		if len(row) > 0 {
			out = append(out, row)
		}
	}
	return out
}
