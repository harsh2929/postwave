package commerce

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	bigCommerceWebhookResponseMaxBytes = 2 << 20
	bigCommerceWebhookSecretHeader     = "X-Postwave-Webhook-Secret"
)

var defaultBigCommerceWebhookScopes = []string{
	"store/customer/created",
	"store/customer/updated",
	"store/customer/deleted",
	"store/product/created",
	"store/product/updated",
	"store/product/deleted",
	"store/product/inventory/updated",
	"store/product/inventory/order/updated",
	"store/order/created",
	"store/order/updated",
	"store/order/archived",
	"store/order/statusUpdated",
	"store/order/refund/created",
	"store/order/transaction/created",
	"store/order/transaction/updated",
}

type BigCommerceWebhookRegistrar interface {
	ReconcileWebhooks(ctx context.Context, integration Integration, appBaseURL string) (BigCommerceWebhookReconcileSummary, error)
	CleanupWebhooks(ctx context.Context, integration Integration, appBaseURL string) (BigCommerceWebhookCleanupSummary, error)
}

type BigCommerceWebhookRegistration struct {
	ID          string `json:"id,omitempty"`
	Scope       string `json:"scope"`
	Destination string `json:"destination"`
	Active      bool   `json:"active"`
	Created     bool   `json:"created,omitempty"`
	Updated     bool   `json:"updated,omitempty"`
	Deleted     bool   `json:"deleted,omitempty"`
}

type BigCommerceWebhookReconcileSummary struct {
	Endpoint      string                           `json:"endpoint"`
	RegisteredAt  time.Time                        `json:"registered_at"`
	Subscriptions []BigCommerceWebhookRegistration `json:"subscriptions"`
}

type BigCommerceWebhookCleanupSummary struct {
	Endpoint      string                           `json:"endpoint"`
	CleanedUpAt   time.Time                        `json:"cleaned_up_at"`
	Subscriptions []BigCommerceWebhookRegistration `json:"subscriptions"`
}

type BigCommerceRESTWebhookRegistrar struct {
	HTTPClient  *http.Client
	Credentials BigCommerceCredentialResolver
	Scopes      []string
	APIBaseURL  string
}

type bigCommerceWebhookSubscription struct {
	ID          string
	Scope       string
	Destination string
	Active      bool
}

func (r BigCommerceRESTWebhookRegistrar) ReconcileWebhooks(ctx context.Context, integration Integration, appBaseURL string) (BigCommerceWebhookReconcileSummary, error) {
	if integration.Provider != ProviderBigCommerce {
		return BigCommerceWebhookReconcileSummary{}, fmt.Errorf("bigcommerce webhook registration requires a BigCommerce integration")
	}
	if strings.TrimSpace(integration.WebhookSecret) == "" {
		return BigCommerceWebhookReconcileSummary{}, fmt.Errorf("bigcommerce webhook secret is required")
	}
	client, baseURL, creds, err := r.client(ctx, integration)
	if err != nil {
		return BigCommerceWebhookReconcileSummary{}, err
	}
	endpoint := bigCommerceWebhookEndpoint(appBaseURL)
	existing, err := r.listWebhooks(ctx, client, baseURL, creds)
	if err != nil {
		return BigCommerceWebhookReconcileSummary{}, err
	}
	summary := BigCommerceWebhookReconcileSummary{
		Endpoint:      endpoint,
		RegisteredAt:  time.Now().UTC(),
		Subscriptions: []BigCommerceWebhookRegistration{},
	}
	for _, scope := range r.scopes() {
		if sub, ok := findBigCommerceWebhook(existing, scope, endpoint); ok {
			reg := BigCommerceWebhookRegistration{ID: sub.ID, Scope: sub.Scope, Destination: sub.Destination, Active: sub.Active}
			if !sub.Active {
				updated, err := r.updateWebhook(ctx, client, baseURL, creds, sub.ID, true)
				if err != nil {
					return BigCommerceWebhookReconcileSummary{}, err
				}
				reg.Active = updated.Active
				reg.Updated = true
			}
			summary.Subscriptions = append(summary.Subscriptions, reg)
			continue
		}
		created, err := r.createWebhook(ctx, client, baseURL, creds, scope, endpoint, integration.WebhookSecret)
		if err != nil {
			return BigCommerceWebhookReconcileSummary{}, err
		}
		summary.Subscriptions = append(summary.Subscriptions, BigCommerceWebhookRegistration{
			ID:          created.ID,
			Scope:       created.Scope,
			Destination: created.Destination,
			Active:      created.Active,
			Created:     true,
		})
	}
	return summary, nil
}

func (r BigCommerceRESTWebhookRegistrar) CleanupWebhooks(ctx context.Context, integration Integration, appBaseURL string) (BigCommerceWebhookCleanupSummary, error) {
	if integration.Provider != ProviderBigCommerce {
		return BigCommerceWebhookCleanupSummary{}, fmt.Errorf("bigcommerce webhook cleanup requires a BigCommerce integration")
	}
	client, baseURL, creds, err := r.client(ctx, integration)
	if err != nil {
		return BigCommerceWebhookCleanupSummary{}, err
	}
	endpoint := bigCommerceWebhookEndpoint(appBaseURL)
	existing, err := r.listWebhooks(ctx, client, baseURL, creds)
	if err != nil {
		return BigCommerceWebhookCleanupSummary{}, err
	}
	summary := BigCommerceWebhookCleanupSummary{
		Endpoint:      endpoint,
		CleanedUpAt:   time.Now().UTC(),
		Subscriptions: []BigCommerceWebhookRegistration{},
	}
	scopes := stringSet(r.scopes())
	for _, sub := range existing {
		if strings.TrimSpace(sub.Destination) != endpoint {
			continue
		}
		if _, ok := scopes[normalizeBigCommerceWebhookScope(sub.Scope)]; !ok {
			continue
		}
		deleted, err := r.deleteWebhook(ctx, client, baseURL, creds, sub.ID)
		if err != nil {
			return BigCommerceWebhookCleanupSummary{}, err
		}
		summary.Subscriptions = append(summary.Subscriptions, BigCommerceWebhookRegistration{
			ID:          firstNonEmpty(deleted.ID, sub.ID),
			Scope:       firstNonEmpty(deleted.Scope, sub.Scope),
			Destination: firstNonEmpty(deleted.Destination, sub.Destination),
			Active:      deleted.Active,
			Deleted:     true,
		})
	}
	return summary, nil
}

func (r BigCommerceRESTWebhookRegistrar) client(ctx context.Context, integration Integration) (*http.Client, string, BigCommerceCredentials, error) {
	backfiller := BigCommerceRESTBackfiller{
		HTTPClient:  r.HTTPClient,
		Credentials: r.Credentials,
		APIBaseURL:  r.APIBaseURL,
	}
	return backfiller.client(ctx, integration.TenantID, integration)
}

func (r BigCommerceRESTWebhookRegistrar) listWebhooks(ctx context.Context, client *http.Client, baseURL string, creds BigCommerceCredentials) ([]bigCommerceWebhookSubscription, error) {
	out := []bigCommerceWebhookSubscription{}
	page := 1
	for {
		var raw struct {
			Data []map[string]any `json:"data"`
			Meta struct {
				Pagination struct {
					TotalPages int `json:"total_pages"`
				} `json:"pagination"`
			} `json:"meta"`
		}
		if err := r.do(ctx, client, baseURL, creds, http.MethodGet, "hooks", map[string]string{
			"page":  strconv.Itoa(page),
			"limit": "250",
		}, nil, &raw); err != nil {
			return nil, err
		}
		for _, item := range raw.Data {
			out = append(out, bigCommerceWebhookFromMap(item))
		}
		if raw.Meta.Pagination.TotalPages <= 0 || page >= raw.Meta.Pagination.TotalPages {
			break
		}
		page++
	}
	return out, nil
}

func (r BigCommerceRESTWebhookRegistrar) createWebhook(ctx context.Context, client *http.Client, baseURL string, creds BigCommerceCredentials, scope, endpoint, secret string) (bigCommerceWebhookSubscription, error) {
	var raw map[string]any
	if err := r.do(ctx, client, baseURL, creds, http.MethodPost, "hooks", nil, map[string]any{
		"scope":       normalizeBigCommerceWebhookScope(scope),
		"destination": endpoint,
		"is_active":   true,
		"headers": map[string]string{
			bigCommerceWebhookSecretHeader: secret,
		},
	}, &raw); err != nil {
		return bigCommerceWebhookSubscription{}, err
	}
	return bigCommerceWebhookFromMap(bigCommerceWebhookPayloadObject(raw)), nil
}

func (r BigCommerceRESTWebhookRegistrar) updateWebhook(ctx context.Context, client *http.Client, baseURL string, creds BigCommerceCredentials, id string, active bool) (bigCommerceWebhookSubscription, error) {
	var raw map[string]any
	if err := r.do(ctx, client, baseURL, creds, http.MethodPut, "hooks/"+url.PathEscape(id), nil, map[string]any{
		"is_active": active,
	}, &raw); err != nil {
		return bigCommerceWebhookSubscription{}, err
	}
	return bigCommerceWebhookFromMap(bigCommerceWebhookPayloadObject(raw)), nil
}

func (r BigCommerceRESTWebhookRegistrar) deleteWebhook(ctx context.Context, client *http.Client, baseURL string, creds BigCommerceCredentials, id string) (bigCommerceWebhookSubscription, error) {
	var raw map[string]any
	if err := r.do(ctx, client, baseURL, creds, http.MethodDelete, "hooks/"+url.PathEscape(id), nil, nil, &raw); err != nil {
		return bigCommerceWebhookSubscription{}, err
	}
	return bigCommerceWebhookFromMap(bigCommerceWebhookPayloadObject(raw)), nil
}

func (r BigCommerceRESTWebhookRegistrar) do(ctx context.Context, client *http.Client, baseURL string, creds BigCommerceCredentials, method, path string, query map[string]string, body any, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + "/v3/" + strings.TrimLeft(path, "/"))
	if err != nil {
		return err
	}
	q := u.Query()
	for k, v := range query {
		q.Set(k, v)
	}
	u.RawQuery = q.Encode()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Auth-Token", strings.TrimSpace(creds.AccessToken))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	rawBody, readErr := readResponseBodyLimited(resp.Body, bigCommerceWebhookResponseMaxBytes)
	if readErr != nil {
		return readErr
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("bigcommerce REST %s %s failed %d: %s", method, path, resp.StatusCode, responseSnippet(rawBody))
	}
	if out != nil && len(bytes.TrimSpace(rawBody)) > 0 {
		dec := json.NewDecoder(bytes.NewReader(rawBody))
		dec.UseNumber()
		if err := dec.Decode(out); err != nil && err != io.EOF {
			return fmt.Errorf("decode bigcommerce webhook response: %w", err)
		}
	}
	return nil
}

func (r BigCommerceRESTWebhookRegistrar) scopes() []string {
	scopes := r.Scopes
	if len(scopes) == 0 {
		scopes = defaultBigCommerceWebhookScopes
	}
	out := make([]string, 0, len(scopes))
	seen := map[string]struct{}{}
	for _, scope := range scopes {
		scope = normalizeBigCommerceWebhookScope(scope)
		if scope == "" {
			continue
		}
		if _, ok := seen[scope]; ok {
			continue
		}
		seen[scope] = struct{}{}
		out = append(out, scope)
	}
	return out
}

func findBigCommerceWebhook(items []bigCommerceWebhookSubscription, scope, endpoint string) (bigCommerceWebhookSubscription, bool) {
	scope = normalizeBigCommerceWebhookScope(scope)
	endpoint = strings.TrimSpace(endpoint)
	for _, item := range items {
		if normalizeBigCommerceWebhookScope(item.Scope) == scope && strings.TrimSpace(item.Destination) == endpoint {
			return item, true
		}
	}
	return bigCommerceWebhookSubscription{}, false
}

func bigCommerceWebhookFromMap(raw map[string]any) bigCommerceWebhookSubscription {
	return bigCommerceWebhookSubscription{
		ID:          stringField(raw, "id"),
		Scope:       normalizeBigCommerceWebhookScope(stringField(raw, "scope")),
		Destination: strings.TrimSpace(stringField(raw, "destination")),
		Active:      boolField(raw, "is_active"),
	}
}

func bigCommerceWebhookPayloadObject(raw map[string]any) map[string]any {
	if data, _ := raw["data"].(map[string]any); data != nil {
		return data
	}
	return raw
}

func bigCommerceWebhookEndpoint(appBaseURL string) string {
	return strings.TrimRight(strings.TrimSpace(appBaseURL), "/") + "/api/public/commerce/bigcommerce/webhooks"
}

func normalizeBigCommerceWebhookScope(scope string) string {
	scope = strings.TrimSpace(scope)
	if scope == "" {
		return ""
	}
	parts := strings.Split(scope, "/")
	for idx, part := range parts {
		if idx == len(parts)-1 && part == "statusUpdated" {
			continue
		}
		parts[idx] = strings.ToLower(part)
	}
	return strings.Join(parts, "/")
}

type bigCommerceWebhookPayload struct {
	StoreID  string         `json:"store_id"`
	Producer string         `json:"producer"`
	Scope    string         `json:"scope"`
	Data     map[string]any `json:"data"`
	Hash     string         `json:"hash"`
}

func decodeBigCommerceWebhookBody(body []byte) (bigCommerceWebhookPayload, error) {
	var payload bigCommerceWebhookPayload
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&payload); err != nil {
		return bigCommerceWebhookPayload{}, fmt.Errorf("decode bigcommerce webhook body: %w", err)
	}
	payload.Scope = normalizeBigCommerceWebhookScope(payload.Scope)
	if payload.Data == nil {
		payload.Data = map[string]any{}
	}
	return payload, nil
}

func bigCommerceWebhookStoreHash(payload bigCommerceWebhookPayload, fallback string) (string, error) {
	if storeHash, ok := normalizeBigCommerceStoreHash(payload.Producer); ok {
		return storeHash, nil
	}
	if storeHash, ok := normalizeBigCommerceStoreHash(fallback); ok {
		return storeHash, nil
	}
	return "", fmt.Errorf("bigcommerce webhook producer is required")
}

func bigCommerceWebhookResourceID(payload bigCommerceWebhookPayload) string {
	return strings.TrimSpace(fmt.Sprint(firstNonNil(payload.Data["id"], payload.Data["resource_id"], payload.Data["order_id"], payload.Data["product_id"], payload.Data["customer_id"])))
}

func bigCommerceWebhookID(storeHash, scope string, payload bigCommerceWebhookPayload, body []byte, headers ...string) string {
	values := append([]string{}, headers...)
	values = append(values, payload.Hash, localWebhookID(storeHash, scope, body))
	return firstNonEmpty(values...)
}

func verifyBigCommerceWebhookSecret(secret, provided string) error {
	secret = strings.TrimSpace(secret)
	provided = strings.TrimSpace(provided)
	if secret == "" || provided == "" {
		return fmt.Errorf("missing BigCommerce webhook secret")
	}
	if subtle.ConstantTimeCompare([]byte(secret), []byte(provided)) != 1 {
		return fmt.Errorf("invalid BigCommerce webhook secret")
	}
	return nil
}
