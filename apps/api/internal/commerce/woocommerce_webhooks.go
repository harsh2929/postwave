package commerce

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const woocommerceWebhookResponseMaxBytes = 2 << 20

var defaultWooCommerceWebhookTopics = []string{
	"coupon.created",
	"coupon.updated",
	"coupon.deleted",
	"customer.created",
	"customer.updated",
	"customer.deleted",
	"product.created",
	"product.updated",
	"product.deleted",
	"order.created",
	"order.updated",
	"order.deleted",
}

var optionalWooCommerceSubscriptionWebhookTopics = []string{
	"subscription.created",
	"subscription.updated",
	"subscription.deleted",
}

type WooCommerceWebhookRegistrar interface {
	ReconcileWebhooks(ctx context.Context, integration Integration, appBaseURL string) (WooCommerceWebhookReconcileSummary, error)
	CleanupWebhooks(ctx context.Context, integration Integration, appBaseURL string) (WooCommerceWebhookCleanupSummary, error)
}

type WooCommerceWebhookRegistration struct {
	ID      string `json:"id,omitempty"`
	Topic   string `json:"topic"`
	URI     string `json:"uri"`
	Status  string `json:"status,omitempty"`
	Created bool   `json:"created,omitempty"`
	Updated bool   `json:"updated,omitempty"`
	Deleted bool   `json:"deleted,omitempty"`
}

type WooCommerceWebhookReconcileSummary struct {
	Endpoint      string                           `json:"endpoint"`
	RegisteredAt  time.Time                        `json:"registered_at"`
	Subscriptions []WooCommerceWebhookRegistration `json:"subscriptions"`
}

type WooCommerceWebhookCleanupSummary struct {
	Endpoint      string                           `json:"endpoint"`
	CleanedUpAt   time.Time                        `json:"cleaned_up_at"`
	Subscriptions []WooCommerceWebhookRegistration `json:"subscriptions"`
}

type WooCommerceRESTWebhookRegistrar struct {
	HTTPClient           *http.Client
	Credentials          CommerceCredentialResolver
	Topics               []string
	AllowUnsafeLocalURLs bool
}

type wooCommerceWebhookSubscription struct {
	ID          string
	Topic       string
	DeliveryURL string
	Status      string
}

func (r WooCommerceRESTWebhookRegistrar) ReconcileWebhooks(ctx context.Context, integration Integration, appBaseURL string) (WooCommerceWebhookReconcileSummary, error) {
	if integration.Provider != ProviderWooCommerce {
		return WooCommerceWebhookReconcileSummary{}, fmt.Errorf("woocommerce webhook registration requires a WooCommerce integration")
	}
	if strings.TrimSpace(integration.WebhookSecret) == "" {
		return WooCommerceWebhookReconcileSummary{}, fmt.Errorf("woocommerce webhook secret is required")
	}
	client, baseURL, creds, err := r.client(ctx, integration)
	if err != nil {
		return WooCommerceWebhookReconcileSummary{}, err
	}
	endpoint := wooCommerceWebhookEndpoint(appBaseURL)
	existing, err := r.listWebhooks(ctx, client, baseURL, creds)
	if err != nil {
		return WooCommerceWebhookReconcileSummary{}, err
	}
	summary := WooCommerceWebhookReconcileSummary{
		Endpoint:      endpoint,
		RegisteredAt:  time.Now().UTC(),
		Subscriptions: []WooCommerceWebhookRegistration{},
	}
	for _, topic := range r.topics(integration) {
		if sub, ok := findWooCommerceWebhook(existing, topic, endpoint); ok {
			reg := WooCommerceWebhookRegistration{ID: sub.ID, Topic: sub.Topic, URI: sub.DeliveryURL, Status: sub.Status}
			if sub.Status != "active" {
				updated, err := r.updateWebhookStatus(ctx, client, baseURL, creds, sub.ID, "active")
				if err != nil {
					return WooCommerceWebhookReconcileSummary{}, err
				}
				reg.Status = updated.Status
				reg.Updated = true
			}
			summary.Subscriptions = append(summary.Subscriptions, reg)
			continue
		}
		created, err := r.createWebhook(ctx, client, baseURL, creds, topic, endpoint, integration.WebhookSecret)
		if err != nil {
			return WooCommerceWebhookReconcileSummary{}, err
		}
		summary.Subscriptions = append(summary.Subscriptions, WooCommerceWebhookRegistration{
			ID:      created.ID,
			Topic:   created.Topic,
			URI:     created.DeliveryURL,
			Status:  created.Status,
			Created: true,
		})
	}
	return summary, nil
}

func (r WooCommerceRESTWebhookRegistrar) CleanupWebhooks(ctx context.Context, integration Integration, appBaseURL string) (WooCommerceWebhookCleanupSummary, error) {
	if integration.Provider != ProviderWooCommerce {
		return WooCommerceWebhookCleanupSummary{}, fmt.Errorf("woocommerce webhook cleanup requires a WooCommerce integration")
	}
	client, baseURL, creds, err := r.client(ctx, integration)
	if err != nil {
		return WooCommerceWebhookCleanupSummary{}, err
	}
	endpoint := wooCommerceWebhookEndpoint(appBaseURL)
	existing, err := r.listWebhooks(ctx, client, baseURL, creds)
	if err != nil {
		return WooCommerceWebhookCleanupSummary{}, err
	}
	summary := WooCommerceWebhookCleanupSummary{
		Endpoint:      endpoint,
		CleanedUpAt:   time.Now().UTC(),
		Subscriptions: []WooCommerceWebhookRegistration{},
	}
	topics := stringSet(r.topics(integration))
	for _, sub := range existing {
		if strings.TrimSpace(sub.DeliveryURL) != endpoint {
			continue
		}
		if _, ok := topics[normalizeWooCommerceWebhookTopic(sub.Topic)]; !ok {
			continue
		}
		deleted, err := r.deleteWebhook(ctx, client, baseURL, creds, sub.ID)
		if err != nil {
			return WooCommerceWebhookCleanupSummary{}, err
		}
		summary.Subscriptions = append(summary.Subscriptions, WooCommerceWebhookRegistration{
			ID:      firstNonEmpty(deleted.ID, sub.ID),
			Topic:   firstNonEmpty(deleted.Topic, sub.Topic),
			URI:     firstNonEmpty(deleted.DeliveryURL, sub.DeliveryURL),
			Status:  firstNonEmpty(deleted.Status, sub.Status),
			Deleted: true,
		})
	}
	return summary, nil
}

func (r WooCommerceRESTWebhookRegistrar) client(ctx context.Context, integration Integration) (*http.Client, string, WooCommerceCredentials, error) {
	resolver := r.Credentials
	if resolver == nil {
		return nil, "", WooCommerceCredentials{}, fmt.Errorf("woocommerce credential resolver is not configured")
	}
	creds, err := resolver.ResolveWooCommerce(ctx, integration.TenantID, integration)
	if err != nil {
		return nil, "", WooCommerceCredentials{}, err
	}
	if strings.TrimSpace(creds.ConsumerKey) == "" || strings.TrimSpace(creds.ConsumerSecret) == "" {
		return nil, "", WooCommerceCredentials{}, fmt.Errorf("woocommerce credentials are incomplete")
	}
	baseURL, err := wooCommerceStoreAPIBase(integration, r.AllowUnsafeLocalURLs)
	if err != nil {
		return nil, "", WooCommerceCredentials{}, err
	}
	client := commerceEgressClient(r.HTTPClient, ProviderWooCommerce, woocommerceRequestTimeout)
	return client, baseURL, creds, nil
}

func (r WooCommerceRESTWebhookRegistrar) listWebhooks(ctx context.Context, client *http.Client, baseURL string, creds WooCommerceCredentials) ([]wooCommerceWebhookSubscription, error) {
	out := []wooCommerceWebhookSubscription{}
	page := 1
	for {
		var raw []map[string]any
		headers, err := r.do(ctx, client, baseURL, creds, http.MethodGet, "webhooks", map[string]string{
			"page":     strconv.Itoa(page),
			"per_page": "100",
		}, nil, &raw)
		if err != nil {
			return nil, err
		}
		for _, item := range raw {
			out = append(out, wooCommerceWebhookSubscription{
				ID:          stringField(item, "id"),
				Topic:       normalizeWooCommerceWebhookTopic(stringField(item, "topic")),
				DeliveryURL: strings.TrimSpace(stringField(item, "delivery_url")),
				Status:      strings.ToLower(strings.TrimSpace(stringField(item, "status"))),
			})
		}
		totalPages := intHeader(headers.Get("X-WP-TotalPages"))
		if totalPages <= 0 || page >= totalPages {
			break
		}
		page++
	}
	return out, nil
}

func (r WooCommerceRESTWebhookRegistrar) createWebhook(ctx context.Context, client *http.Client, baseURL string, creds WooCommerceCredentials, topic, endpoint, secret string) (wooCommerceWebhookSubscription, error) {
	var raw map[string]any
	_, err := r.do(ctx, client, baseURL, creds, http.MethodPost, "webhooks", nil, map[string]any{
		"name":         "Moosewave " + strings.ReplaceAll(normalizeWooCommerceWebhookTopic(topic), ".", " "),
		"topic":        normalizeWooCommerceWebhookTopic(topic),
		"delivery_url": endpoint,
		"secret":       secret,
		"status":       "active",
	}, &raw)
	if err != nil {
		return wooCommerceWebhookSubscription{}, err
	}
	return wooCommerceWebhookFromMap(raw), nil
}

func (r WooCommerceRESTWebhookRegistrar) updateWebhookStatus(ctx context.Context, client *http.Client, baseURL string, creds WooCommerceCredentials, id, status string) (wooCommerceWebhookSubscription, error) {
	var raw map[string]any
	_, err := r.do(ctx, client, baseURL, creds, http.MethodPut, "webhooks/"+url.PathEscape(id), nil, map[string]any{
		"status": status,
	}, &raw)
	if err != nil {
		return wooCommerceWebhookSubscription{}, err
	}
	return wooCommerceWebhookFromMap(raw), nil
}

func (r WooCommerceRESTWebhookRegistrar) deleteWebhook(ctx context.Context, client *http.Client, baseURL string, creds WooCommerceCredentials, id string) (wooCommerceWebhookSubscription, error) {
	var raw map[string]any
	_, err := r.do(ctx, client, baseURL, creds, http.MethodDelete, "webhooks/"+url.PathEscape(id), map[string]string{"force": "true"}, nil, &raw)
	if err != nil {
		return wooCommerceWebhookSubscription{}, err
	}
	return wooCommerceWebhookFromMap(raw), nil
}

func (r WooCommerceRESTWebhookRegistrar) do(ctx context.Context, client *http.Client, baseURL string, creds WooCommerceCredentials, method, path string, query map[string]string, body any, out any) (http.Header, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(path, "/"))
	if err != nil {
		return nil, err
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
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(strings.TrimSpace(creds.ConsumerKey), strings.TrimSpace(creds.ConsumerSecret))
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	rawBody, readErr := readResponseBodyLimited(resp.Body, woocommerceWebhookResponseMaxBytes)
	if readErr != nil {
		return nil, readErr
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("woocommerce REST %s %s failed %d: %s", method, path, resp.StatusCode, responseSnippet(rawBody))
	}
	if out != nil {
		dec := json.NewDecoder(bytes.NewReader(rawBody))
		dec.UseNumber()
		if err := dec.Decode(out); err != nil && err != io.EOF {
			return nil, fmt.Errorf("decode woocommerce webhook response: %w", err)
		}
	}
	return resp.Header.Clone(), nil
}

func allWooCommerceWebhookTopics() []string {
	out := make([]string, 0, len(defaultWooCommerceWebhookTopics)+len(optionalWooCommerceSubscriptionWebhookTopics))
	out = append(out, defaultWooCommerceWebhookTopics...)
	out = append(out, optionalWooCommerceSubscriptionWebhookTopics...)
	return out
}

func (r WooCommerceRESTWebhookRegistrar) topics(integration Integration) []string {
	topics := r.Topics
	if len(topics) == 0 {
		topics = append([]string(nil), defaultWooCommerceWebhookTopics...)
		if settingBool(integration.Settings, "subscriptions_enabled") {
			topics = allWooCommerceWebhookTopics()
		}
	}
	out := make([]string, 0, len(topics))
	seen := map[string]struct{}{}
	for _, topic := range topics {
		topic = normalizeWooCommerceWebhookTopic(topic)
		if topic == "" {
			continue
		}
		if _, ok := seen[topic]; ok {
			continue
		}
		seen[topic] = struct{}{}
		out = append(out, topic)
	}
	return out
}

func findWooCommerceWebhook(items []wooCommerceWebhookSubscription, topic, endpoint string) (wooCommerceWebhookSubscription, bool) {
	topic = normalizeWooCommerceWebhookTopic(topic)
	endpoint = strings.TrimSpace(endpoint)
	for _, item := range items {
		if normalizeWooCommerceWebhookTopic(item.Topic) == topic && strings.TrimSpace(item.DeliveryURL) == endpoint {
			return item, true
		}
	}
	return wooCommerceWebhookSubscription{}, false
}

func wooCommerceWebhookFromMap(raw map[string]any) wooCommerceWebhookSubscription {
	return wooCommerceWebhookSubscription{
		ID:          stringField(raw, "id"),
		Topic:       normalizeWooCommerceWebhookTopic(stringField(raw, "topic")),
		DeliveryURL: strings.TrimSpace(stringField(raw, "delivery_url")),
		Status:      strings.ToLower(strings.TrimSpace(stringField(raw, "status"))),
	}
}

func wooCommerceWebhookEndpoint(appBaseURL string) string {
	return strings.TrimRight(strings.TrimSpace(appBaseURL), "/") + "/api/public/commerce/woocommerce/webhooks"
}

func stringSet(values []string) map[string]struct{} {
	out := map[string]struct{}{}
	for _, value := range values {
		out[strings.TrimSpace(value)] = struct{}{}
	}
	return out
}
