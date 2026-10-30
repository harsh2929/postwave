package commerce

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	shopifyAdminAPIVersion              = "2026-04"
	shopifyAdminGraphQLMaxResponseBytes = 4 << 20
	shopifyBackfillDefaultPageSize      = 50
	shopifyBackfillCursorPrefix         = "shopify:"
	shopifyBackfillCursorComplete       = "shopify:complete"
	shopifyBulkOperationCursorPrefix    = "shopify_bulk:"
	shopifyBulkRetryInitialDelay        = 15 * time.Minute
	shopifyBulkRetryMaxDelay            = 6 * time.Hour
)

type ShopifyBackfiller interface {
	BackfillPage(ctx context.Context, integration Integration, cursor string) (SyncRequest, error)
}

type ShopifyBulkOperator interface {
	StartBulkBackfill(ctx context.Context, integration Integration, object string) (ShopifyAsyncBulkBackfillSummary, error)
	PollBulkBackfill(ctx context.Context, integration Integration, operationID, object string) (ShopifyAsyncBulkBackfillSummary, error)
}

type ShopifyBulkResultImporter interface {
	ImportBulkResult(ctx context.Context, integration Integration, object, resultURL string) (SyncRequest, error)
}

type ShopifyWebhookRegistrar interface {
	ReconcileWebhooks(ctx context.Context, integration Integration, appBaseURL string) (ShopifyWebhookReconcileSummary, error)
	CleanupWebhooks(ctx context.Context, integration Integration, appBaseURL string) (ShopifyWebhookCleanupSummary, error)
}

type ShopifyAdminGraphQLBackfiller struct {
	HTTPClient *http.Client
	PageSize   int
}

type ShopifyAdminGraphQLBulkOperator struct {
	HTTPClient *http.Client
}

type ShopifyAdminGraphQLWebhookRegistrar struct {
	HTTPClient *http.Client
	Topics     []ShopifyWebhookTopic
}

type ShopifyGraphQLHTTPError struct {
	StatusCode int
	RetryAfter time.Duration
	Body       string
}

func (e *ShopifyGraphQLHTTPError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("shopify graphql http %d retry_after=%s", e.StatusCode, e.RetryAfter)
	}
	return fmt.Sprintf("shopify graphql http %d", e.StatusCode)
}

type ShopifyGraphQLError struct {
	Message    string         `json:"message"`
	Path       []any          `json:"path,omitempty"`
	Extensions map[string]any `json:"extensions,omitempty"`
}

type ShopifyGraphQLErrors struct {
	Errors []ShopifyGraphQLError
	Cost   *ShopifyGraphQLCost
}

func (e *ShopifyGraphQLErrors) Error() string {
	msgs := make([]string, 0, len(e.Errors))
	for _, item := range e.Errors {
		if strings.TrimSpace(item.Message) != "" {
			msgs = append(msgs, item.Message)
		}
	}
	if len(msgs) == 0 {
		return "shopify graphql error"
	}
	return "shopify graphql: " + strings.Join(msgs, "; ")
}

type ShopifyGraphQLExtensions struct {
	Cost *ShopifyGraphQLCost `json:"cost,omitempty"`
}

type ShopifyGraphQLCost struct {
	RequestedQueryCost int                          `json:"requestedQueryCost"`
	ActualQueryCost    int                          `json:"actualQueryCost"`
	ThrottleStatus     ShopifyGraphQLThrottleStatus `json:"throttleStatus"`
}

type ShopifyGraphQLThrottleStatus struct {
	MaximumAvailable   float64 `json:"maximumAvailable"`
	CurrentlyAvailable float64 `json:"currentlyAvailable"`
	RestoreRate        float64 `json:"restoreRate"`
}

type shopifyAdminGraphQLClient struct {
	shop       string
	token      string
	httpClient *http.Client
}

func newShopifyAdminGraphQLClient(integration Integration, httpClient *http.Client) (*shopifyAdminGraphQLClient, error) {
	shop := NormalizeShopDomain(integration.ShopDomain)
	if !ValidShopifyShopDomain(shop) {
		return nil, fmt.Errorf("shopify integration has invalid shop domain")
	}
	token := strings.TrimSpace(integration.AccessToken)
	if token == "" {
		return nil, fmt.Errorf("shopify integration missing OAuth access token")
	}
	httpClient = commerceEgressClient(httpClient, ProviderShopify, 15*time.Second)
	return &shopifyAdminGraphQLClient{shop: shop, token: token, httpClient: httpClient}, nil
}

func (c *shopifyAdminGraphQLClient) endpoint() string {
	return "https://" + c.shop + "/admin/api/" + shopifyAdminAPIVersion + "/graphql.json"
}

func (c *shopifyAdminGraphQLClient) query(ctx context.Context, query string, variables map[string]any, out any) (ShopifyGraphQLExtensions, error) {
	body, err := json.Marshal(map[string]any{
		"query":     query,
		"variables": nonNilMap(variables),
	})
	if err != nil {
		return ShopifyGraphQLExtensions{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint(), bytes.NewReader(body))
	if err != nil {
		return ShopifyGraphQLExtensions{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Shopify-Access-Token", c.token)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return ShopifyGraphQLExtensions{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, readErr := readResponseBodyLimited(resp.Body, shopifyAdminGraphQLMaxResponseBytes)
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if readErr != nil {
			return ShopifyGraphQLExtensions{}, fmt.Errorf("shopify graphql response: %w", readErr)
		}
		return ShopifyGraphQLExtensions{}, &ShopifyGraphQLHTTPError{
			StatusCode: resp.StatusCode,
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
			Body:       responseSnippet(raw),
		}
	}
	if readErr != nil {
		return ShopifyGraphQLExtensions{}, fmt.Errorf("shopify graphql response: %w", readErr)
	}
	var envelope struct {
		Data       json.RawMessage          `json:"data"`
		Errors     []ShopifyGraphQLError    `json:"errors"`
		Extensions ShopifyGraphQLExtensions `json:"extensions"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return ShopifyGraphQLExtensions{}, err
	}
	if len(envelope.Errors) > 0 {
		return envelope.Extensions, &ShopifyGraphQLErrors{Errors: envelope.Errors, Cost: envelope.Extensions.Cost}
	}
	if out != nil {
		if len(envelope.Data) == 0 {
			return envelope.Extensions, fmt.Errorf("shopify graphql response missing data")
		}
		if err := json.Unmarshal(envelope.Data, out); err != nil {
			return envelope.Extensions, err
		}
	}
	return envelope.Extensions, nil
}

var defaultShopifyWebhookTopics = []ShopifyWebhookTopic{
	{GraphQLTopic: "CUSTOMERS_CREATE", HTTPTopic: "customers/create"},
	{GraphQLTopic: "CUSTOMERS_UPDATE", HTTPTopic: "customers/update"},
	{GraphQLTopic: "CUSTOMERS_ENABLE", HTTPTopic: "customers/enable"},
	{GraphQLTopic: "CUSTOMERS_DISABLE", HTTPTopic: "customers/disable"},
	{GraphQLTopic: "PRODUCTS_CREATE", HTTPTopic: "products/create"},
	{GraphQLTopic: "PRODUCTS_UPDATE", HTTPTopic: "products/update"},
	{GraphQLTopic: "ORDERS_CREATE", HTTPTopic: "orders/create"},
	{GraphQLTopic: "ORDERS_UPDATED", HTTPTopic: "orders/updated"},
	{GraphQLTopic: "ORDERS_PAID", HTTPTopic: "orders/paid"},
	{GraphQLTopic: "ORDERS_CANCELLED", HTTPTopic: "orders/cancelled"},
	{GraphQLTopic: "ORDERS_FULFILLED", HTTPTopic: "orders/fulfilled"},
	{GraphQLTopic: "REFUNDS_CREATE", HTTPTopic: "refunds/create"},
	{GraphQLTopic: "CARTS_CREATE", HTTPTopic: "carts/create"},
	{GraphQLTopic: "CARTS_UPDATE", HTTPTopic: "carts/update"},
	{GraphQLTopic: "CHECKOUTS_CREATE", HTTPTopic: "checkouts/create"},
	{GraphQLTopic: "CHECKOUTS_UPDATE", HTTPTopic: "checkouts/update"},
	{GraphQLTopic: "BULK_OPERATIONS_FINISH", HTTPTopic: "bulk_operations/finish"},
	{GraphQLTopic: "APP_UNINSTALLED", HTTPTopic: "app/uninstalled"},
}

func DefaultShopifyWebhookTopics() []ShopifyWebhookTopic {
	out := make([]ShopifyWebhookTopic, len(defaultShopifyWebhookTopics))
	copy(out, defaultShopifyWebhookTopics)
	return out
}

func (r ShopifyAdminGraphQLWebhookRegistrar) ReconcileWebhooks(ctx context.Context, integration Integration, appBaseURL string) (ShopifyWebhookReconcileSummary, error) {
	client, err := newShopifyAdminGraphQLClient(integration, r.HTTPClient)
	if err != nil {
		return ShopifyWebhookReconcileSummary{}, err
	}
	endpoint := strings.TrimRight(strings.TrimSpace(appBaseURL), "/")
	if endpoint == "" {
		return ShopifyWebhookReconcileSummary{}, fmt.Errorf("shopify webhook base URL is required")
	}
	endpoint += "/api/public/commerce/shopify/webhooks"
	topics := r.Topics
	if len(topics) == 0 {
		topics = DefaultShopifyWebhookTopics()
	}
	existing, err := client.webhookSubscriptionLookup(ctx)
	if err != nil {
		return ShopifyWebhookReconcileSummary{}, err
	}
	summary := ShopifyWebhookReconcileSummary{
		Endpoint:      endpoint,
		RegisteredAt:  time.Now().UTC(),
		Subscriptions: make([]ShopifyWebhookRegistration, 0, len(topics)),
	}
	for _, topic := range topics {
		graphQLTopic := strings.TrimSpace(topic.GraphQLTopic)
		if graphQLTopic == "" {
			continue
		}
		if sub, ok := existing[graphQLTopic+" "+endpoint]; ok {
			summary.Subscriptions = append(summary.Subscriptions, ShopifyWebhookRegistration{
				ID:      sub.ID,
				Topic:   graphQLTopic,
				URI:     sub.URI,
				Created: false,
			})
			continue
		}
		created, err := client.createWebhookSubscription(ctx, graphQLTopic, endpoint)
		if err != nil {
			return ShopifyWebhookReconcileSummary{}, err
		}
		summary.Subscriptions = append(summary.Subscriptions, ShopifyWebhookRegistration{
			ID:      created.ID,
			Topic:   created.Topic,
			URI:     created.URI,
			Created: true,
		})
	}
	return summary, nil
}

func (r ShopifyAdminGraphQLWebhookRegistrar) CleanupWebhooks(ctx context.Context, integration Integration, appBaseURL string) (ShopifyWebhookCleanupSummary, error) {
	client, err := newShopifyAdminGraphQLClient(integration, r.HTTPClient)
	if err != nil {
		return ShopifyWebhookCleanupSummary{}, err
	}
	endpoint := strings.TrimRight(strings.TrimSpace(appBaseURL), "/")
	if endpoint == "" {
		return ShopifyWebhookCleanupSummary{}, fmt.Errorf("shopify webhook base URL is required")
	}
	endpoint += "/api/public/commerce/shopify/webhooks"
	topics := r.Topics
	if len(topics) == 0 {
		topics = DefaultShopifyWebhookTopics()
	}
	managedTopics := map[string]struct{}{}
	for _, topic := range topics {
		if graphQLTopic := strings.TrimSpace(topic.GraphQLTopic); graphQLTopic != "" {
			managedTopics[graphQLTopic] = struct{}{}
		}
	}
	existing, err := client.listWebhookSubscriptions(ctx)
	if err != nil {
		return ShopifyWebhookCleanupSummary{}, err
	}
	summary := ShopifyWebhookCleanupSummary{
		Endpoint:      endpoint,
		CleanedUpAt:   time.Now().UTC(),
		Subscriptions: []ShopifyWebhookRegistration{},
	}
	for _, sub := range existing {
		if sub.URI != endpoint {
			continue
		}
		if _, ok := managedTopics[sub.Topic]; !ok {
			continue
		}
		deletedID, err := client.deleteWebhookSubscription(ctx, sub.ID)
		if err != nil {
			return ShopifyWebhookCleanupSummary{}, err
		}
		if deletedID == "" {
			deletedID = sub.ID
		}
		summary.Subscriptions = append(summary.Subscriptions, ShopifyWebhookRegistration{
			ID:      deletedID,
			Topic:   sub.Topic,
			URI:     sub.URI,
			Created: false,
		})
	}
	return summary, nil
}

type shopifyWebhookSubscription struct {
	ID    string
	Topic string
	URI   string
}

const shopifyWebhookSubscriptionsQuery = `
query PostwaveShopifyWebhookSubscriptions($first: Int!, $after: String) {
  webhookSubscriptions(first: $first, after: $after) {
    edges {
      node {
        id
        topic
        uri
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

func (c *shopifyAdminGraphQLClient) webhookSubscriptionLookup(ctx context.Context) (map[string]shopifyWebhookSubscription, error) {
	subscriptions, err := c.listWebhookSubscriptions(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]shopifyWebhookSubscription{}
	for _, sub := range subscriptions {
		out[sub.Topic+" "+sub.URI] = sub
	}
	return out, nil
}

func (c *shopifyAdminGraphQLClient) listWebhookSubscriptions(ctx context.Context) ([]shopifyWebhookSubscription, error) {
	out := []shopifyWebhookSubscription{}
	after := ""
	for {
		var data struct {
			WebhookSubscriptions struct {
				Edges []struct {
					Node struct {
						ID    string `json:"id"`
						Topic string `json:"topic"`
						URI   string `json:"uri"`
					} `json:"node"`
				} `json:"edges"`
				PageInfo shopifyGraphQLPageInfo `json:"pageInfo"`
			} `json:"webhookSubscriptions"`
		}
		if _, err := c.query(ctx, shopifyWebhookSubscriptionsQuery, map[string]any{
			"first": 100,
			"after": nullableCursor(after),
		}, &data); err != nil {
			return nil, err
		}
		for _, edge := range data.WebhookSubscriptions.Edges {
			node := edge.Node
			topic := strings.TrimSpace(node.Topic)
			uri := strings.TrimSpace(node.URI)
			if topic == "" || uri == "" {
				continue
			}
			out = append(out, shopifyWebhookSubscription{ID: node.ID, Topic: topic, URI: uri})
		}
		pageInfo := data.WebhookSubscriptions.PageInfo
		if !pageInfo.HasNextPage || strings.TrimSpace(pageInfo.EndCursor) == "" {
			break
		}
		after = pageInfo.EndCursor
	}
	return out, nil
}

const shopifyWebhookSubscriptionCreateMutation = `
mutation PostwaveShopifyWebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription {
      id
      topic
      uri
    }
    userErrors {
      field
      message
    }
  }
}`

type shopifyUserError struct {
	Field   []string `json:"field"`
	Message string   `json:"message"`
}

func (c *shopifyAdminGraphQLClient) createWebhookSubscription(ctx context.Context, topic, uri string) (shopifyWebhookSubscription, error) {
	var data struct {
		WebhookSubscriptionCreate struct {
			WebhookSubscription *struct {
				ID    string `json:"id"`
				Topic string `json:"topic"`
				URI   string `json:"uri"`
			} `json:"webhookSubscription"`
			UserErrors []shopifyUserError `json:"userErrors"`
		} `json:"webhookSubscriptionCreate"`
	}
	if _, err := c.query(ctx, shopifyWebhookSubscriptionCreateMutation, map[string]any{
		"topic": topic,
		"webhookSubscription": map[string]any{
			"uri": uri,
		},
	}, &data); err != nil {
		return shopifyWebhookSubscription{}, err
	}
	if len(data.WebhookSubscriptionCreate.UserErrors) > 0 {
		return shopifyWebhookSubscription{}, fmt.Errorf("shopify webhook subscription %s: %s", topic, shopifyUserErrors(data.WebhookSubscriptionCreate.UserErrors))
	}
	if data.WebhookSubscriptionCreate.WebhookSubscription == nil {
		return shopifyWebhookSubscription{}, fmt.Errorf("shopify webhook subscription %s: missing subscription response", topic)
	}
	sub := data.WebhookSubscriptionCreate.WebhookSubscription
	return shopifyWebhookSubscription{ID: sub.ID, Topic: sub.Topic, URI: sub.URI}, nil
}

const shopifyWebhookSubscriptionDeleteMutation = `
mutation PostwaveShopifyWebhookSubscriptionDelete($id: ID!) {
  webhookSubscriptionDelete(id: $id) {
    deletedWebhookSubscriptionId
    userErrors {
      field
      message
    }
  }
}`

func (c *shopifyAdminGraphQLClient) deleteWebhookSubscription(ctx context.Context, id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", fmt.Errorf("shopify webhook subscription id is required")
	}
	var data struct {
		WebhookSubscriptionDelete struct {
			DeletedWebhookSubscriptionID string             `json:"deletedWebhookSubscriptionId"`
			UserErrors                   []shopifyUserError `json:"userErrors"`
		} `json:"webhookSubscriptionDelete"`
	}
	if _, err := c.query(ctx, shopifyWebhookSubscriptionDeleteMutation, map[string]any{"id": id}, &data); err != nil {
		return "", err
	}
	if len(data.WebhookSubscriptionDelete.UserErrors) > 0 {
		return "", fmt.Errorf("shopify webhook subscription delete %s: %s", id, shopifyUserErrors(data.WebhookSubscriptionDelete.UserErrors))
	}
	return strings.TrimSpace(data.WebhookSubscriptionDelete.DeletedWebhookSubscriptionID), nil
}

func shopifyUserErrors(errors []shopifyUserError) string {
	msgs := make([]string, 0, len(errors))
	for _, item := range errors {
		if strings.TrimSpace(item.Message) != "" {
			msgs = append(msgs, item.Message)
		}
	}
	if len(msgs) == 0 {
		return "unknown user error"
	}
	return strings.Join(msgs, "; ")
}

func parseRetryAfter(raw string) time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(raw); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(raw); err == nil {
		if d := time.Until(at); d > 0 {
			return d
		}
	}
	return 0
}

func responseSnippet(raw []byte) string {
	const max = 512
	s := strings.TrimSpace(string(raw))
	if len(s) > max {
		return s[:max]
	}
	return s
}

type shopifyBackfillState struct {
	Object string `json:"object"`
	After  string `json:"after,omitempty"`
}

type shopifyBulkOperationCursor struct {
	Object        string `json:"object"`
	OperationID   string `json:"operation_id"`
	LineOffset    int64  `json:"line_offset,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

func (b ShopifyAdminGraphQLBackfiller) BackfillPage(ctx context.Context, integration Integration, cursor string) (SyncRequest, error) {
	client, err := newShopifyAdminGraphQLClient(integration, b.HTTPClient)
	if err != nil {
		return SyncRequest{}, err
	}
	state, err := decodeShopifyBackfillCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "complete" {
		return SyncRequest{Cursor: shopifyBackfillCursorComplete}, nil
	}
	first := b.PageSize
	if first <= 0 {
		first = shopifyBackfillDefaultPageSize
	}
	if first > 100 {
		first = 100
	}
	for attempts := 0; attempts < len(shopifyBackfillObjectOrder); attempts++ {
		req, nextState, err := client.fetchBackfillObject(ctx, state, first)
		if err != nil {
			return SyncRequest{}, err
		}
		state = nextState
		req.Cursor = encodeShopifyBackfillCursor(state)
		if syncRequestHasPayload(req) || state.Object == "complete" {
			return req, nil
		}
	}
	return SyncRequest{Cursor: shopifyBackfillCursorComplete}, nil
}

var shopifyBackfillObjectOrder = []string{"customers", "products", "orders"}

func decodeShopifyBackfillCursor(cursor string) (shopifyBackfillState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || strings.HasPrefix(cursor, "sync-") {
		return shopifyBackfillState{Object: "customers"}, nil
	}
	if cursor == shopifyBackfillCursorComplete {
		return shopifyBackfillState{Object: "complete"}, nil
	}
	if !strings.HasPrefix(cursor, shopifyBackfillCursorPrefix) {
		return shopifyBackfillState{}, fmt.Errorf("invalid shopify backfill cursor")
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, shopifyBackfillCursorPrefix))
	if err != nil {
		return shopifyBackfillState{}, fmt.Errorf("invalid shopify backfill cursor: %w", err)
	}
	var state shopifyBackfillState
	if err := json.Unmarshal(raw, &state); err != nil {
		return shopifyBackfillState{}, fmt.Errorf("invalid shopify backfill cursor: %w", err)
	}
	state.Object = normalizeShopifyBackfillObject(state.Object)
	if !validShopifyBackfillObject(state.Object) {
		return shopifyBackfillState{}, fmt.Errorf("invalid shopify backfill cursor object")
	}
	return state, nil
}

func encodeShopifyBackfillCursor(state shopifyBackfillState) string {
	state.Object = normalizeShopifyBackfillObject(state.Object)
	if state.Object == "complete" {
		return shopifyBackfillCursorComplete
	}
	raw, _ := json.Marshal(state)
	return shopifyBackfillCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func decodeShopifyBulkOperationCursor(cursor string) (shopifyBulkOperationCursor, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return shopifyBulkOperationCursor{}, false, nil
	}
	if !strings.HasPrefix(cursor, shopifyBulkOperationCursorPrefix) {
		return shopifyBulkOperationCursor{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, shopifyBulkOperationCursorPrefix))
	if err != nil {
		return shopifyBulkOperationCursor{}, true, fmt.Errorf("invalid shopify bulk operation cursor: %w", err)
	}
	var state shopifyBulkOperationCursor
	if err := json.Unmarshal(raw, &state); err != nil {
		return shopifyBulkOperationCursor{}, true, fmt.Errorf("invalid shopify bulk operation cursor: %w", err)
	}
	state.Object = normalizeShopifyBackfillObject(state.Object)
	state.OperationID = strings.TrimSpace(state.OperationID)
	if state.LineOffset < 0 {
		state.LineOffset = 0
	}
	if state.OperationID == "" {
		return shopifyBulkOperationCursor{}, true, fmt.Errorf("invalid shopify bulk operation cursor: missing operation id")
	}
	if !validShopifyBackfillObject(state.Object) || state.Object == "complete" {
		return shopifyBulkOperationCursor{}, true, fmt.Errorf("invalid shopify bulk operation cursor object")
	}
	return state, true, nil
}

func encodeShopifyBulkOperationCursor(state shopifyBulkOperationCursor) string {
	state.Object = normalizeShopifyBackfillObject(state.Object)
	state.OperationID = strings.TrimSpace(state.OperationID)
	if state.LineOffset < 0 {
		state.LineOffset = 0
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return shopifyBulkOperationCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func shopifyBulkOperationCursorDue(state shopifyBulkOperationCursor, now time.Time) bool {
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

func shopifyBulkOperationRetryCursor(state shopifyBulkOperationCursor, status string, retryErr error, now time.Time) string {
	state.Attempts++
	state.LastStatus = strings.ToUpper(strings.TrimSpace(status))
	if state.LastStatus == "" {
		state.LastStatus = "ERROR"
	}
	if retryErr != nil {
		state.LastError = retryErr.Error()
	}
	state.NextAttemptAt = now.UTC().Add(shopifyBulkRetryDelay(state.Attempts)).Format(time.RFC3339)
	return encodeShopifyBulkOperationCursor(state)
}

func shopifyBulkOperationActiveCursor(state shopifyBulkOperationCursor, status string) string {
	state.Attempts = 0
	state.NextAttemptAt = ""
	state.LastError = ""
	state.LastStatus = strings.ToUpper(strings.TrimSpace(status))
	return encodeShopifyBulkOperationCursor(state)
}

func shopifyBulkRetryDelay(attempt int) time.Duration {
	if attempt <= 1 {
		return shopifyBulkRetryInitialDelay
	}
	delay := shopifyBulkRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= shopifyBulkRetryMaxDelay {
			return shopifyBulkRetryMaxDelay
		}
	}
	return delay
}

func truncateString(value string, max int) string {
	if max <= 0 || len(value) <= max {
		return value
	}
	return value[:max]
}

func normalizeShopifyBackfillObject(object string) string {
	return strings.ToLower(strings.TrimSpace(object))
}

func validShopifyBackfillObject(object string) bool {
	object = normalizeShopifyBackfillObject(object)
	if object == "complete" {
		return true
	}
	for _, item := range shopifyBackfillObjectOrder {
		if object == item {
			return true
		}
	}
	return false
}

func nextShopifyBackfillObject(object string) string {
	for idx, item := range shopifyBackfillObjectOrder {
		if item == object {
			if idx+1 < len(shopifyBackfillObjectOrder) {
				return shopifyBackfillObjectOrder[idx+1]
			}
			return "complete"
		}
	}
	return "complete"
}

func (c *shopifyAdminGraphQLClient) fetchBackfillObject(ctx context.Context, state shopifyBackfillState, first int) (SyncRequest, shopifyBackfillState, error) {
	switch state.Object {
	case "customers":
		return c.fetchCustomersPage(ctx, state.After, first)
	case "products":
		return c.fetchProductsPage(ctx, state.After, first)
	case "orders":
		return c.fetchOrdersPage(ctx, state.After, first)
	default:
		return SyncRequest{}, shopifyBackfillState{Object: "complete"}, nil
	}
}

func (b ShopifyAdminGraphQLBulkOperator) StartBulkBackfill(ctx context.Context, integration Integration, object string) (ShopifyAsyncBulkBackfillSummary, error) {
	object = normalizeShopifyBackfillObject(object)
	if object == "" || object == "complete" {
		object = "customers"
	}
	queryDoc, err := shopifyBulkBackfillQuery(object)
	if err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	client, err := newShopifyAdminGraphQLClient(integration, b.HTTPClient)
	if err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	op, err := client.runBulkOperation(ctx, queryDoc)
	if err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	summary := op.summary(integration.ID, object)
	summary.Cursor = encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{Object: object, OperationID: op.ID})
	summary.Message = "Shopify bulk operation started; poll the same backfill endpoint with mode=bulk_async to monitor JSONL readiness."
	return summary, nil
}

func (b ShopifyAdminGraphQLBulkOperator) PollBulkBackfill(ctx context.Context, integration Integration, operationID, object string) (ShopifyAsyncBulkBackfillSummary, error) {
	operationID = strings.TrimSpace(operationID)
	if operationID == "" {
		return ShopifyAsyncBulkBackfillSummary{}, fmt.Errorf("shopify bulk operation id is required")
	}
	object = normalizeShopifyBackfillObject(object)
	if object == "" || object == "complete" {
		object = "customers"
	}
	if !validShopifyBackfillObject(object) || object == "complete" {
		return ShopifyAsyncBulkBackfillSummary{}, fmt.Errorf("unsupported Shopify bulk backfill object %q", object)
	}
	client, err := newShopifyAdminGraphQLClient(integration, b.HTTPClient)
	if err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	op, err := client.bulkOperation(ctx, operationID)
	if err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	summary := op.summary(integration.ID, object)
	summary.Cursor = encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{Object: object, OperationID: operationID})
	switch strings.ToUpper(summary.Status) {
	case "COMPLETED":
		summary.Message = "Shopify bulk operation completed; result URL is ready for JSONL import and expires after Shopify's availability window."
	case "FAILED", "CANCELED", "CANCELING":
		summary.Message = "Shopify bulk operation did not complete successfully; inspect error_code and partial_data_url availability."
	default:
		summary.Message = "Shopify bulk operation is still running; poll again later or wait for the bulk_operations/finish webhook."
	}
	return summary, nil
}

type shopifyBulkOperation struct {
	ID              string               `json:"id"`
	Status          string               `json:"status"`
	ErrorCode       string               `json:"errorCode"`
	CreatedAt       string               `json:"createdAt"`
	CompletedAt     string               `json:"completedAt"`
	ObjectCount     shopifyUnsignedInt64 `json:"objectCount"`
	RootObjectCount shopifyUnsignedInt64 `json:"rootObjectCount"`
	FileSize        shopifyUnsignedInt64 `json:"fileSize"`
	URL             string               `json:"url"`
	PartialDataURL  string               `json:"partialDataUrl"`
}

type shopifyUnsignedInt64 string

func (n *shopifyUnsignedInt64) UnmarshalJSON(raw []byte) error {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		*n = ""
		return nil
	}
	if strings.HasPrefix(s, `"`) {
		var quoted string
		if err := json.Unmarshal(raw, &quoted); err != nil {
			return err
		}
		s = strings.TrimSpace(quoted)
	}
	if s != "" {
		for _, r := range s {
			if r < '0' || r > '9' {
				return fmt.Errorf("invalid unsigned integer %q", s)
			}
		}
	}
	*n = shopifyUnsignedInt64(s)
	return nil
}

func (n shopifyUnsignedInt64) String() string {
	return string(n)
}

func (op shopifyBulkOperation) summary(integrationID, object string) ShopifyAsyncBulkBackfillSummary {
	return ShopifyAsyncBulkBackfillSummary{
		IntegrationID:         integrationID,
		OperationID:           op.ID,
		Object:                object,
		Status:                strings.ToUpper(strings.TrimSpace(op.Status)),
		ErrorCode:             strings.TrimSpace(op.ErrorCode),
		ObjectCount:           op.ObjectCount.String(),
		RootObjectCount:       op.RootObjectCount.String(),
		FileSize:              op.FileSize.String(),
		CreatedAt:             strings.TrimSpace(op.CreatedAt),
		CompletedAt:           strings.TrimSpace(op.CompletedAt),
		ResultURLPresent:      strings.TrimSpace(op.URL) != "",
		PartialDataURLPresent: strings.TrimSpace(op.PartialDataURL) != "",
		ResultURL:             strings.TrimSpace(op.URL),
		PartialDataURL:        strings.TrimSpace(op.PartialDataURL),
	}
}

func (c *shopifyAdminGraphQLClient) runBulkOperation(ctx context.Context, queryDoc string) (shopifyBulkOperation, error) {
	var data struct {
		BulkOperationRunQuery struct {
			BulkOperation *shopifyBulkOperation       `json:"bulkOperation"`
			UserErrors    []shopifyBulkOperationError `json:"userErrors"`
		} `json:"bulkOperationRunQuery"`
	}
	if _, err := c.query(ctx, shopifyBulkOperationRunQueryMutation, map[string]any{"query": queryDoc}, &data); err != nil {
		return shopifyBulkOperation{}, err
	}
	if len(data.BulkOperationRunQuery.UserErrors) > 0 {
		return shopifyBulkOperation{}, fmt.Errorf("shopify bulk operation: %s", formatShopifyBulkOperationErrors(data.BulkOperationRunQuery.UserErrors))
	}
	if data.BulkOperationRunQuery.BulkOperation == nil || strings.TrimSpace(data.BulkOperationRunQuery.BulkOperation.ID) == "" {
		return shopifyBulkOperation{}, fmt.Errorf("shopify bulk operation response missing operation")
	}
	return *data.BulkOperationRunQuery.BulkOperation, nil
}

func (c *shopifyAdminGraphQLClient) bulkOperation(ctx context.Context, operationID string) (shopifyBulkOperation, error) {
	var data struct {
		BulkOperation *shopifyBulkOperation `json:"bulkOperation"`
	}
	if _, err := c.query(ctx, shopifyBulkOperationQuery, map[string]any{"id": operationID}, &data); err != nil {
		return shopifyBulkOperation{}, err
	}
	if data.BulkOperation == nil || strings.TrimSpace(data.BulkOperation.ID) == "" {
		return shopifyBulkOperation{}, fmt.Errorf("shopify bulk operation %q not found", operationID)
	}
	return *data.BulkOperation, nil
}

type shopifyBulkOperationError struct {
	Field   []string `json:"field"`
	Message string   `json:"message"`
}

func formatShopifyBulkOperationErrors(items []shopifyBulkOperationError) string {
	parts := make([]string, 0, len(items))
	for _, item := range items {
		msg := strings.TrimSpace(item.Message)
		if msg == "" {
			msg = "unknown error"
		}
		if len(item.Field) > 0 {
			msg = strings.Join(item.Field, ".") + ": " + msg
		}
		parts = append(parts, msg)
	}
	if len(parts) == 0 {
		return "unknown error"
	}
	return strings.Join(parts, "; ")
}

func shopifyBulkBackfillQuery(object string) (string, error) {
	switch normalizeShopifyBackfillObject(object) {
	case "customers":
		return shopifyBulkCustomersQuery, nil
	case "products":
		return shopifyBulkProductsQuery, nil
	case "orders":
		return shopifyBulkOrdersQuery, nil
	default:
		return "", fmt.Errorf("unsupported Shopify bulk backfill object %q", object)
	}
}

const shopifyBulkOperationRunQueryMutation = `
mutation PostwaveShopifyBulkOperationRunQuery($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation {
      id
      status
      createdAt
    }
    userErrors {
      field
      message
    }
  }
}`

const shopifyBulkOperationQuery = `
query PostwaveShopifyBulkOperation($id: ID!) {
  bulkOperation(id: $id) {
    id
    status
    errorCode
    createdAt
    completedAt
    objectCount
    rootObjectCount
    fileSize
    url
    partialDataUrl
  }
}`

const shopifyBulkCustomersQuery = `{
  customers {
    edges {
      node {
        id
        firstName
        lastName
        tags
        defaultEmailAddress {
          emailAddress
          marketingState
        }
      }
    }
  }
}`

const shopifyBulkProductsQuery = `{
  products {
    edges {
      node {
        id
        title
        handle
        onlineStoreUrl
        featuredMedia {
          ... on MediaImage {
            image {
              url
            }
          }
        }
        priceRangeV2 {
          minVariantPrice {
            amount
            currencyCode
          }
        }
      }
    }
  }
}`

const shopifyBulkOrdersQuery = `{
  orders {
    edges {
      node {
        id
        name
        email
        createdAt
        processedAt
        updatedAt
        cancelledAt
        cancelReason
        displayFinancialStatus
        currencyCode
        subtotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalDiscountsSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalShippingPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalTaxSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        lineItems {
          edges {
            node {
              id
              name
              quantity
              originalUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              product {
                id
              }
              variant {
                id
                title
              }
            }
          }
        }
      }
    }
  }
}`

type shopifyGraphQLPageInfo struct {
	HasNextPage bool   `json:"hasNextPage"`
	EndCursor   string `json:"endCursor"`
}

const shopifyCustomersQuery = `
query PostwaveShopifyCustomers($first: Int!, $after: String) {
  customers(first: $first, after: $after, sortKey: ID) {
    edges {
      cursor
      node {
        id
        firstName
        lastName
        tags
        defaultEmailAddress {
          emailAddress
          marketingState
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

func (c *shopifyAdminGraphQLClient) fetchCustomersPage(ctx context.Context, after string, first int) (SyncRequest, shopifyBackfillState, error) {
	var data struct {
		Customers struct {
			Edges []struct {
				Cursor string `json:"cursor"`
				Node   struct {
					ID                  string   `json:"id"`
					FirstName           string   `json:"firstName"`
					LastName            string   `json:"lastName"`
					Tags                []string `json:"tags"`
					DefaultEmailAddress *struct {
						EmailAddress   string `json:"emailAddress"`
						MarketingState string `json:"marketingState"`
					} `json:"defaultEmailAddress"`
				} `json:"node"`
			} `json:"edges"`
			PageInfo shopifyGraphQLPageInfo `json:"pageInfo"`
		} `json:"customers"`
	}
	vars := map[string]any{"first": first, "after": nullableCursor(after)}
	if _, err := c.query(ctx, shopifyCustomersQuery, vars, &data); err != nil {
		return SyncRequest{}, shopifyBackfillState{}, err
	}
	req := SyncRequest{Customers: make([]CustomerInput, 0, len(data.Customers.Edges))}
	for _, edge := range data.Customers.Edges {
		req.Customers = append(req.Customers, shopifyCustomerFromGraphQL(edge.Node.ID, edge.Node.FirstName, edge.Node.LastName, edge.Node.Tags, edge.Node.DefaultEmailAddress))
	}
	return req, nextState("customers", data.Customers.PageInfo), nil
}

func shopifyCustomerFromGraphQL(id, firstName, lastName string, tags []string, email *struct {
	EmailAddress   string `json:"emailAddress"`
	MarketingState string `json:"marketingState"`
}) CustomerInput {
	raw := map[string]any{
		"admin_graphql_api_id": id,
		"id":                   id,
		"first_name":           firstName,
		"last_name":            lastName,
		"tags":                 strings.Join(tags, ", "),
		"source":               "shopify_admin_graphql",
	}
	if email != nil {
		raw["email"] = email.EmailAddress
		raw["accepts_marketing"] = strings.EqualFold(email.MarketingState, "SUBSCRIBED")
		raw["email_marketing_state"] = email.MarketingState
	}
	return customerFromMap(raw)
}

const shopifyProductsQuery = `
query PostwaveShopifyProducts($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: ID) {
    edges {
      cursor
      node {
        id
        title
        handle
        onlineStoreUrl
        featuredMedia {
          ... on MediaImage {
            image {
              url
            }
          }
        }
        priceRangeV2 {
          minVariantPrice {
            amount
            currencyCode
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

func (c *shopifyAdminGraphQLClient) fetchProductsPage(ctx context.Context, after string, first int) (SyncRequest, shopifyBackfillState, error) {
	var data struct {
		Products struct {
			Edges []struct {
				Cursor string `json:"cursor"`
				Node   struct {
					ID             string `json:"id"`
					Title          string `json:"title"`
					Handle         string `json:"handle"`
					OnlineStoreURL string `json:"onlineStoreUrl"`
					FeaturedMedia  *struct {
						Image *struct {
							URL string `json:"url"`
						} `json:"image"`
					} `json:"featuredMedia"`
					PriceRangeV2 struct {
						MinVariantPrice shopifyMoney `json:"minVariantPrice"`
					} `json:"priceRangeV2"`
				} `json:"node"`
			} `json:"edges"`
			PageInfo shopifyGraphQLPageInfo `json:"pageInfo"`
		} `json:"products"`
	}
	vars := map[string]any{"first": first, "after": nullableCursor(after)}
	if _, err := c.query(ctx, shopifyProductsQuery, vars, &data); err != nil {
		return SyncRequest{}, shopifyBackfillState{}, err
	}
	req := SyncRequest{Products: make([]ProductInput, 0, len(data.Products.Edges))}
	for _, edge := range data.Products.Edges {
		imageURL := ""
		if edge.Node.FeaturedMedia != nil && edge.Node.FeaturedMedia.Image != nil {
			imageURL = edge.Node.FeaturedMedia.Image.URL
		}
		req.Products = append(req.Products, shopifyProductFromGraphQL(
			edge.Node.ID,
			edge.Node.Title,
			edge.Node.Handle,
			edge.Node.OnlineStoreURL,
			imageURL,
			edge.Node.PriceRangeV2.MinVariantPrice,
		))
	}
	return req, nextState("products", data.Products.PageInfo), nil
}

type shopifyMoney struct {
	Amount       string `json:"amount"`
	CurrencyCode string `json:"currencyCode"`
}

func shopifyProductFromGraphQL(id, title, handle, url, imageURL string, price shopifyMoney) ProductInput {
	raw := map[string]any{
		"admin_graphql_api_id": id,
		"id":                   id,
		"title":                title,
		"handle":               handle,
		"online_store_url":     url,
		"image":                map[string]any{"src": imageURL},
		"variants":             []any{map[string]any{"price": price.Amount}},
		"source":               "shopify_admin_graphql",
	}
	out := productFromMap(raw)
	if strings.TrimSpace(price.CurrencyCode) != "" {
		out.Currency = strings.ToUpper(strings.TrimSpace(price.CurrencyCode))
	}
	return out
}

const shopifyOrdersQuery = `
query PostwaveShopifyOrders($first: Int!, $after: String) {
  orders(first: $first, after: $after, sortKey: ID) {
    edges {
      cursor
      node {
        id
        name
        email
        createdAt
        processedAt
        updatedAt
        cancelledAt
        cancelReason
        displayFinancialStatus
        currencyCode
        subtotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalDiscountsSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalShippingPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalTaxSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        lineItems(first: 100) {
          edges {
            node {
              id
              name
              quantity
              originalUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              product {
                id
              }
              variant {
                id
                title
              }
            }
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

func (c *shopifyAdminGraphQLClient) fetchOrdersPage(ctx context.Context, after string, first int) (SyncRequest, shopifyBackfillState, error) {
	var data struct {
		Orders struct {
			Edges []struct {
				Cursor string           `json:"cursor"`
				Node   shopifyOrderNode `json:"node"`
			} `json:"edges"`
			PageInfo shopifyGraphQLPageInfo `json:"pageInfo"`
		} `json:"orders"`
	}
	vars := map[string]any{"first": first, "after": nullableCursor(after)}
	if _, err := c.query(ctx, shopifyOrdersQuery, vars, &data); err != nil {
		return SyncRequest{}, shopifyBackfillState{}, err
	}
	req := SyncRequest{Orders: make([]OrderInput, 0, len(data.Orders.Edges))}
	for _, edge := range data.Orders.Edges {
		req.Orders = append(req.Orders, shopifyOrderFromGraphQL(edge.Node))
	}
	return req, nextState("orders", data.Orders.PageInfo), nil
}

type shopifyOrderNode struct {
	ID                     string          `json:"id"`
	Name                   string          `json:"name"`
	Email                  string          `json:"email"`
	CreatedAt              string          `json:"createdAt"`
	ProcessedAt            string          `json:"processedAt"`
	UpdatedAt              string          `json:"updatedAt"`
	CancelledAt            string          `json:"cancelledAt"`
	CancelReason           string          `json:"cancelReason"`
	DisplayFinancialStatus string          `json:"displayFinancialStatus"`
	CurrencyCode           string          `json:"currencyCode"`
	SubtotalPriceSet       shopifyMoneySet `json:"subtotalPriceSet"`
	TotalDiscountsSet      shopifyMoneySet `json:"totalDiscountsSet"`
	TotalShippingPriceSet  shopifyMoneySet `json:"totalShippingPriceSet"`
	TotalTaxSet            shopifyMoneySet `json:"totalTaxSet"`
	TotalPriceSet          shopifyMoneySet `json:"totalPriceSet"`
	LineItems              struct {
		Edges []struct {
			Node struct {
				ID                   string          `json:"id"`
				Name                 string          `json:"name"`
				Quantity             int             `json:"quantity"`
				OriginalUnitPriceSet shopifyMoneySet `json:"originalUnitPriceSet"`
				Product              *struct {
					ID string `json:"id"`
				} `json:"product"`
				Variant *struct {
					ID    string `json:"id"`
					Title string `json:"title"`
				} `json:"variant"`
			} `json:"node"`
		} `json:"edges"`
	} `json:"lineItems"`
}

type shopifyMoneySet struct {
	ShopMoney shopifyMoney `json:"shopMoney"`
}

func (s shopifyMoneySet) amount() string {
	return strings.TrimSpace(s.ShopMoney.Amount)
}

func (s shopifyMoneySet) currency() string {
	return strings.ToUpper(strings.TrimSpace(s.ShopMoney.CurrencyCode))
}

func shopifyOrderFromGraphQL(n shopifyOrderNode) OrderInput {
	lineItems := make([]any, 0, len(n.LineItems.Edges))
	for _, edge := range n.LineItems.Edges {
		productID := ""
		if edge.Node.Product != nil {
			productID = edge.Node.Product.ID
		}
		variantID := ""
		if edge.Node.Variant != nil {
			variantID = edge.Node.Variant.ID
		}
		lineItems = append(lineItems, map[string]any{
			"admin_graphql_api_id": edge.Node.ID,
			"id":                   edge.Node.ID,
			"product_id":           productID,
			"variant_id":           variantID,
			"title":                edge.Node.Name,
			"quantity":             edge.Node.Quantity,
			"price":                edge.Node.OriginalUnitPriceSet.amount(),
		})
	}
	currency := firstNonEmpty(n.CurrencyCode, n.TotalPriceSet.currency(), n.SubtotalPriceSet.currency(), "USD")
	raw := map[string]any{
		"admin_graphql_api_id":     n.ID,
		"id":                       n.ID,
		"name":                     n.Name,
		"email":                    n.Email,
		"created_at":               n.CreatedAt,
		"processed_at":             n.ProcessedAt,
		"updated_at":               n.UpdatedAt,
		"cancelled_at":             n.CancelledAt,
		"cancel_reason":            n.CancelReason,
		"financial_status":         strings.ToLower(n.DisplayFinancialStatus),
		"currency":                 currency,
		"subtotal_price":           n.SubtotalPriceSet.amount(),
		"total_discounts":          n.TotalDiscountsSet.amount(),
		"total_tax":                n.TotalTaxSet.amount(),
		"total_price":              n.TotalPriceSet.amount(),
		"total_shipping_price_set": moneySetMap(n.TotalShippingPriceSet),
		"line_items":               lineItems,
		"source":                   "shopify_admin_graphql",
	}
	return orderFromMap(raw)
}

func moneySetMap(set shopifyMoneySet) map[string]any {
	return map[string]any{
		"shop_money": map[string]any{
			"amount":        set.amount(),
			"currency_code": set.currency(),
		},
	}
}

func nullableCursor(cursor string) any {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return nil
	}
	return cursor
}

func nextState(object string, page shopifyGraphQLPageInfo) shopifyBackfillState {
	if page.HasNextPage {
		return shopifyBackfillState{Object: object, After: page.EndCursor}
	}
	return shopifyBackfillState{Object: nextShopifyBackfillObject(object)}
}
