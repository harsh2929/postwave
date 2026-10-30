package commerce

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
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
	wixStoresCursorPrefix      = "wix_stores:"
	wixStoresRetryCursorPrefix = "wix_stores_retry:"
	wixStoresCursorComplete    = "wix_stores:complete"
	wixStoresResponseMaxBytes  = 8 << 20
	wixStoresDefaultPageSize   = 100
	wixStoresMaxPageSize       = 100
	wixStoresRetryInitialDelay = 15 * time.Minute
	wixStoresRetryMaxDelay     = 6 * time.Hour
)

var wixStoresBackfillObjectOrder = []string{"contacts", "products", "orders"}

type WixStoresCredentials struct {
	AccessToken      string
	ClientID         string
	ClientSecret     string
	InstanceID       string
	WebhookSecret    string
	WebhookPublicKey string
	AppID            string
	APIBaseURL       string
	TokenURL         string
}

type WixStoresCredentialResolver interface {
	ResolveWixStores(context.Context, string, Integration) (WixStoresCredentials, error)
}

type WixStoresBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type WixStoresRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials WixStoresCredentialResolver
	APIBaseURL  string
	PageSize    int
}

type wixStoresBackfillState struct {
	Object string `json:"object"`
	Cursor string `json:"cursor,omitempty"`
}

type wixStoresRetryState struct {
	Cursor         string `json:"cursor"`
	Object         string `json:"object,omitempty"`
	ProviderCursor string `json:"provider_cursor,omitempty"`
	Attempts       int    `json:"attempts,omitempty"`
	NextAttemptAt  string `json:"next_attempt_at,omitempty"`
	LastStatus     string `json:"last_status,omitempty"`
	LastError      string `json:"last_error,omitempty"`
}

type wixStoresSearchResponse struct {
	Contacts       []map[string]any `json:"contacts"`
	Products       []map[string]any `json:"products"`
	Orders         []map[string]any `json:"orders"`
	Items          []map[string]any `json:"items"`
	PagingMetadata map[string]any   `json:"pagingMetadata"`
	Metadata       map[string]any   `json:"metadata"`

	nextCursorOverride string
}

type WixStoresRateLimitError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e WixStoresRateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("wix stores REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("wix stores REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func (b WixStoresRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderWixStores {
		return SyncRequest{}, fmt.Errorf("wix stores backfill requires a Wix Stores integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("wix stores credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveWixStores(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := commerceEgressClient(b.HTTPClient, ProviderWixStores, 30*time.Second)
	baseURL := strings.TrimRight(firstNonEmpty(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), "https://www.wixapis.com"), "/")
	token := strings.TrimSpace(creds.AccessToken)
	if token == "" {
		token, err = wixStoresAccessToken(ctx, client, baseURL, creds, integration)
		if err != nil {
			return SyncRequest{}, err
		}
	}
	state, err := decodeWixStoresBackfillCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "complete" {
		return SyncRequest{Cursor: wixStoresCursorComplete}, nil
	}
	page, err := b.fetchPage(ctx, client, baseURL, token, integration, state)
	if err != nil {
		return SyncRequest{}, err
	}
	items := page.items(state.Object)
	req := SyncRequest{}
	switch state.Object {
	case "contacts":
		req.Customers = make([]CustomerInput, 0, len(items))
		for _, item := range items {
			if customer := wixStoresContactCustomer(item); customer.SourceID != "" {
				req.Customers = append(req.Customers, customer)
			}
		}
	case "products":
		req.Products = make([]ProductInput, 0, len(items))
		for _, item := range items {
			if product := wixStoresProductInput(item); product.SourceID != "" {
				req.Products = append(req.Products, product)
			}
		}
	case "orders":
		req.Orders = make([]OrderInput, 0, len(items))
		for _, item := range items {
			if order := wixStoresOrderInput(item); order.SourceID != "" {
				req.Orders = append(req.Orders, order)
			}
		}
	default:
		return SyncRequest{}, fmt.Errorf("unsupported Wix Stores object %q", state.Object)
	}
	next := page.nextCursor()
	if next != "" {
		req.Cursor = encodeWixStoresBackfillCursor(wixStoresBackfillState{Object: state.Object, Cursor: next})
	} else {
		req.Cursor = encodeWixStoresBackfillCursor(wixStoresBackfillState{Object: nextWixStoresBackfillObject(state.Object)})
	}
	return req, nil
}

func (b WixStoresRESTBackfiller) fetchPage(ctx context.Context, client *http.Client, baseURL, token string, integration Integration, state wixStoresBackfillState) (wixStoresSearchResponse, error) {
	path, err := wixStoresObjectPath(ctx, client, baseURL, token, integration, state.Object)
	if err != nil {
		return wixStoresSearchResponse{}, err
	}
	pageSize := normalizeWixStoresPageSize(b.PageSize)
	body := wixStoresSearchBodyForPath(state.Object, state.Cursor, pageSize, path)
	page, err := wixStoresDoJSON(ctx, client, baseURL, token, integration, http.MethodPost, path, nil, body)
	if err != nil {
		return wixStoresSearchResponse{}, err
	}
	page.nextCursorOverride = page.nextCursorForPath(path, state.Object, state.Cursor, pageSize)
	return page, nil
}

func wixStoresDoJSON(ctx context.Context, client *http.Client, baseURL, token string, integration Integration, method, path string, query url.Values, body any) (wixStoresSearchResponse, error) {
	raw, err := wixStoresDoJSONBytes(ctx, client, baseURL, token, integration, method, path, query, body)
	if err != nil {
		return wixStoresSearchResponse{}, err
	}
	var out wixStoresSearchResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return wixStoresSearchResponse{}, fmt.Errorf("decode wix stores %s response: %w", path, err)
	}
	return out, nil
}

func wixStoresDoMapJSON(ctx context.Context, client *http.Client, baseURL, token string, integration Integration, method, path string, query url.Values, body any) (map[string]any, error) {
	raw, err := wixStoresDoJSONBytes(ctx, client, baseURL, token, integration, method, path, query, body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return nil, fmt.Errorf("decode wix stores %s response: %w", path, err)
	}
	return nonNilMap(out), nil
}

func wixStoresDoJSONBytes(ctx context.Context, client *http.Client, baseURL, token string, integration Integration, method, path string, query url.Values, body any) ([]byte, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + path)
	if err != nil {
		return nil, err
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
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	req.Header.Set("Accept", "application/json")
	if siteID := strings.TrimSpace(settingString(integration.Settings, "site_id")); siteID != "" {
		req.Header.Set("wix-site-id", siteID)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := readResponseBodyLimited(resp.Body, wixStoresResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return nil, WixStoresRateLimitError{Path: path, StatusCode: resp.StatusCode, RetryAfter: wixStoresRetryAfter(resp.Header), Snippet: responseSnippet(raw)}
		}
		return nil, fmt.Errorf("wix stores REST %s failed %d: %s", path, resp.StatusCode, responseSnippet(raw))
	}
	return raw, nil
}

func wixStoresAccessToken(ctx context.Context, client *http.Client, baseURL string, creds WixStoresCredentials, integration Integration) (string, error) {
	instanceID := firstNonEmpty(creds.InstanceID, settingString(integration.Settings, "instance_id"))
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" || strings.TrimSpace(instanceID) == "" {
		return "", fmt.Errorf("wix stores app client_id, client_secret, and instance_id are required to mint an access token")
	}
	payload := map[string]any{
		"grant_type":    "client_credentials",
		"client_id":     strings.TrimSpace(creds.ClientID),
		"client_secret": strings.TrimSpace(creds.ClientSecret),
		"instance_id":   strings.TrimSpace(instanceID),
	}
	raw, _ := json.Marshal(payload)
	tokenURL := strings.TrimSpace(firstNonEmpty(creds.TokenURL, settingString(integration.Settings, "token_url")))
	if tokenURL == "" {
		tokenURL = strings.TrimRight(baseURL, "/") + "/oauth2/token"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := readResponseBodyLimited(resp.Body, wixStoresResponseMaxBytes)
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return "", WixStoresRateLimitError{Path: "/oauth2/token", StatusCode: resp.StatusCode, RetryAfter: wixStoresRetryAfter(resp.Header), Snippet: responseSnippet(body)}
		}
		return "", fmt.Errorf("wix stores token failed %d: %s", resp.StatusCode, responseSnippet(body))
	}
	token, err := decodeWixStoresToken(body)
	if err != nil {
		return "", err
	}
	return token, nil
}

func decodeWixStoresToken(raw []byte) (string, error) {
	var out struct {
		AccessToken      string `json:"access_token"`
		AccessTokenCamel string `json:"accessToken"`
		Token            string `json:"token"`
		Body             any    `json:"body"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("decode wix token response: %w", err)
	}
	if token := normalizeWixStoresTokenValue(firstNonEmpty(out.AccessToken, out.AccessTokenCamel, out.Token)); token != "" {
		return token, nil
	}
	switch body := out.Body.(type) {
	case string:
		var nested map[string]any
		if err := json.Unmarshal([]byte(body), &nested); err == nil {
			if token := wixStoresTokenValueFromMap(nested); token != "" {
				return token, nil
			}
		}
	case map[string]any:
		if token := wixStoresTokenValueFromMap(body); token != "" {
			return token, nil
		}
	}
	return "", fmt.Errorf("wix token response missing access_token")
}

func wixStoresTokenValueFromMap(values map[string]any) string {
	for _, key := range []string{"access_token", "accessToken", "token"} {
		if token := normalizeWixStoresTokenValue(fmt.Sprint(values[key])); token != "" {
			return token
		}
	}
	return ""
}

func normalizeWixStoresTokenValue(raw string) string {
	token := strings.TrimSpace(raw)
	if token == "" || token == "<nil>" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(token), "bearer ") {
		return strings.TrimSpace(token[len("bearer "):])
	}
	return token
}

func (p wixStoresSearchResponse) items(object string) []map[string]any {
	switch normalizeWixStoresBackfillObject(object) {
	case "contacts":
		if len(p.Contacts) > 0 {
			return p.Contacts
		}
	case "products":
		if len(p.Products) > 0 {
			return p.Products
		}
	case "orders":
		if len(p.Orders) > 0 {
			return p.Orders
		}
	}
	return p.Items
}

func (p wixStoresSearchResponse) nextCursor() string {
	if p.nextCursorOverride != "" {
		return p.nextCursorOverride
	}
	for _, root := range []map[string]any{p.PagingMetadata, p.Metadata} {
		if len(root) == 0 {
			continue
		}
		if cursor := stringField(mapField(root, "cursors"), "next"); cursor != "" {
			return cursor
		}
		if cursor := stringField(root, "nextCursor"); cursor != "" {
			return cursor
		}
	}
	return ""
}

func (p wixStoresSearchResponse) nextCursorForPath(path, object, currentCursor string, limit int) string {
	if normalizeWixStoresBackfillObject(object) != "products" || !strings.Contains(path, "/stores-reader/v1/") {
		return ""
	}
	items := p.items("products")
	if len(items) == 0 {
		return ""
	}
	offset := wixStoresOffsetCursor(currentCursor)
	nextOffset := offset + len(items)
	if total, ok := p.totalCount(); ok && nextOffset >= total {
		return ""
	}
	if len(items) < limit {
		return ""
	}
	return strconv.Itoa(nextOffset)
}

func (p wixStoresSearchResponse) totalCount() (int, bool) {
	for _, root := range []map[string]any{p.PagingMetadata, p.Metadata} {
		for _, key := range []string{"total", "totalCount", "total_count", "totalResults", "total_results"} {
			if total := intField(root, key); total > 0 {
				return total, true
			}
		}
	}
	return 0, false
}

func decodeWixStoresBackfillCursor(cursor string) (wixStoresBackfillState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return wixStoresBackfillState{Object: "contacts"}, nil
	}
	if cursor == wixStoresCursorComplete {
		return wixStoresBackfillState{Object: "complete"}, nil
	}
	if !strings.HasPrefix(cursor, wixStoresCursorPrefix) {
		return wixStoresBackfillState{}, fmt.Errorf("invalid Wix Stores cursor")
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, wixStoresCursorPrefix))
	if err != nil {
		return wixStoresBackfillState{}, fmt.Errorf("decode Wix Stores cursor: %w", err)
	}
	var state wixStoresBackfillState
	if err := json.Unmarshal(raw, &state); err != nil {
		return wixStoresBackfillState{}, fmt.Errorf("parse Wix Stores cursor: %w", err)
	}
	state.Object = normalizeWixStoresBackfillObject(state.Object)
	if !validWixStoresBackfillObject(state.Object) {
		return wixStoresBackfillState{}, fmt.Errorf("invalid Wix Stores cursor object")
	}
	return state, nil
}

func encodeWixStoresBackfillCursor(state wixStoresBackfillState) string {
	state.Object = normalizeWixStoresBackfillObject(state.Object)
	if state.Object == "" || state.Object == "complete" {
		return wixStoresCursorComplete
	}
	raw, _ := json.Marshal(state)
	return wixStoresCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func nextWixStoresBackfillObject(object string) string {
	object = normalizeWixStoresBackfillObject(object)
	for idx, item := range wixStoresBackfillObjectOrder {
		if item == object {
			if idx+1 < len(wixStoresBackfillObjectOrder) {
				return wixStoresBackfillObjectOrder[idx+1]
			}
			return "complete"
		}
	}
	return "complete"
}

func normalizeWixStoresBackfillObject(object string) string {
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

func validWixStoresBackfillObject(object string) bool {
	if object == "complete" {
		return true
	}
	for _, item := range wixStoresBackfillObjectOrder {
		if object == item {
			return true
		}
	}
	return false
}

func normalizeWixStoresPageSize(size int) int {
	if size <= 0 {
		return wixStoresDefaultPageSize
	}
	if size > wixStoresMaxPageSize {
		return wixStoresMaxPageSize
	}
	return size
}

func wixStoresObjectPath(ctx context.Context, client *http.Client, baseURL, token string, integration Integration, object string) (string, error) {
	switch normalizeWixStoresBackfillObject(object) {
	case "contacts":
		return "/contacts/v4/contacts/query", nil
	case "products":
		version, err := wixStoresCatalogVersion(ctx, client, baseURL, token, integration)
		if err != nil {
			return "", err
		}
		if version == "v1" {
			return "/stores-reader/v1/products/query", nil
		}
		return "/stores/v3/products/query", nil
	case "orders":
		return "/ecom/v1/orders/search", nil
	default:
		return "", fmt.Errorf("unsupported Wix Stores object %q", object)
	}
}

func wixStoresCatalogVersion(ctx context.Context, client *http.Client, baseURL, token string, integration Integration) (string, error) {
	if version := normalizeWixStoresCatalogVersion(settingString(integration.Settings, "catalog_version")); version != "" && version != "auto" {
		return version, nil
	}
	out, err := wixStoresDoMapJSON(ctx, client, baseURL, token, integration, http.MethodGet, "/stores/v3/provision/version", nil, nil)
	if err != nil {
		return "", fmt.Errorf("detect wix stores catalog version: %w", err)
	}
	version := normalizeWixStoresCatalogVersion(firstNonEmpty(
		stringField(out, "catalogVersion"),
		stringField(out, "catalog_version"),
		stringField(out, "version"),
		stringField(out, "installedVersion"),
		stringField(out, "installed_version"),
		stringField(mapField(out, "catalog"), "version"),
		stringField(mapField(out, "storesCatalog"), "version"),
		stringField(mapField(out, "stores_catalog"), "version"),
		stringField(mapField(out, "body"), "catalogVersion"),
		stringField(mapField(out, "body"), "version"),
	))
	if version == "" {
		return "", fmt.Errorf("detect wix stores catalog version: response missing catalog version")
	}
	return version, nil
}

func normalizeWixStoresCatalogVersion(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = strings.ReplaceAll(value, "_", "")
	value = strings.ReplaceAll(value, "-", "")
	value = strings.ReplaceAll(value, " ", "")
	switch {
	case value == "", value == "<nil>":
		return ""
	case value == "auto":
		return "auto"
	case value == "v1", value == "1", value == "catalogv1", strings.Contains(value, "version1"):
		return "v1"
	case value == "v3", value == "3", value == "catalogv3", strings.Contains(value, "version3"):
		return "v3"
	default:
		return ""
	}
}

func wixStoresSearchBody(object, cursor string, limit int) map[string]any {
	cursorPaging := map[string]any{"limit": limit}
	if strings.TrimSpace(cursor) != "" {
		cursorPaging["cursor"] = strings.TrimSpace(cursor)
	}
	switch normalizeWixStoresBackfillObject(object) {
	case "orders":
		return map[string]any{"search": map[string]any{
			"cursorPaging": cursorPaging,
			"sort":         []map[string]any{{"fieldName": "createdDate", "order": "ASC"}},
		}}
	default:
		return map[string]any{"query": map[string]any{"cursorPaging": cursorPaging}}
	}
}

func wixStoresSearchBodyForPath(object, cursor string, limit int, path string) map[string]any {
	if normalizeWixStoresBackfillObject(object) == "products" && strings.Contains(path, "/stores-reader/v1/") {
		return map[string]any{"query": map[string]any{
			"paging": map[string]any{
				"limit":  limit,
				"offset": wixStoresOffsetCursor(cursor),
			},
		}}
	}
	return wixStoresSearchBody(object, cursor, limit)
}

func wixStoresOffsetCursor(cursor string) int {
	offset, err := strconv.Atoi(strings.TrimSpace(cursor))
	if err != nil || offset < 0 {
		return 0
	}
	return offset
}

func decodeWixStoresRetryCursor(cursor string) (wixStoresRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, wixStoresRetryCursorPrefix) {
		return wixStoresRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, wixStoresRetryCursorPrefix))
	if err != nil {
		return wixStoresRetryState{}, true, fmt.Errorf("decode Wix Stores retry cursor: %w", err)
	}
	var state wixStoresRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return wixStoresRetryState{}, true, fmt.Errorf("parse Wix Stores retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeWixStoresBackfillCursor(wixStoresBackfillState{Object: "contacts"})
	}
	if underlying, err := decodeWixStoresBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.ProviderCursor = underlying.Cursor
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeWixStoresRetryCursor(state wixStoresRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeWixStoresBackfillCursor(wixStoresBackfillState{Object: "contacts"})
	}
	if underlying, err := decodeWixStoresBackfillCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.ProviderCursor = underlying.Cursor
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return wixStoresRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func wixStoresRetryCursorDue(state wixStoresRetryState, now time.Time) bool {
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

func wixStoresBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := wixStoresRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeWixStoresRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(wixStoresRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeWixStoresRetryCursor(state)
}

func wixStoresRetryDelay(attempt int, err error) time.Duration {
	var rateLimit WixStoresRateLimitError
	if err != nil && errors.As(err, &rateLimit) && rateLimit.RetryAfter > 0 {
		if rateLimit.RetryAfter > wixStoresRetryMaxDelay {
			return wixStoresRetryMaxDelay
		}
		return rateLimit.RetryAfter
	}
	if attempt <= 1 {
		return wixStoresRetryInitialDelay
	}
	delay := wixStoresRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= wixStoresRetryMaxDelay {
			return wixStoresRetryMaxDelay
		}
	}
	return delay
}

func wixStoresRetryAfter(headers http.Header) time.Duration {
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

type wixStoresWebhookEvent struct {
	ID         string
	Topic      string
	EntityFQDN string
	Slug       string
	EntityID   string
	SiteID     string
	InstanceID string
	AppID      string
	Payload    map[string]any
}

func decodeWixStoresWebhookEvent(body []byte, r *http.Request) (wixStoresWebhookEvent, error) {
	var payload map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&payload); err != nil {
		return wixStoresWebhookEvent{}, fmt.Errorf("decode wix stores webhook body: %w", err)
	}
	if payload == nil {
		payload = map[string]any{}
	}
	return wixStoresWebhookEventFromMap(payload, r), nil
}

func wixStoresWebhookEventFromMap(payload map[string]any, r *http.Request) wixStoresWebhookEvent {
	payload = nonNilMap(payload)
	data := mapField(payload, "data")
	created := mapField(payload, "createdEvent")
	if len(created) == 0 {
		created = mapField(payload, "created_event")
	}
	updated := mapField(payload, "updatedEvent")
	if len(updated) == 0 {
		updated = mapField(payload, "updated_event")
	}
	deleted := mapField(payload, "deletedEvent")
	if len(deleted) == 0 {
		deleted = mapField(payload, "deleted_event")
	}
	eventRoot := firstNonEmptyMap(created, updated, deleted, data, payload)
	var headers http.Header
	var query url.Values
	if r != nil {
		headers = r.Header
		query = r.URL.Query()
	} else {
		headers = http.Header{}
		query = url.Values{}
	}
	topic := firstNonEmpty(
		headers.Get("X-Wix-Event-Type"),
		headers.Get("X-Wix-Event"),
		headers.Get("X-Postwave-Event"),
		query.Get("topic"),
		stringField(payload, "eventType"),
		stringField(payload, "event_type"),
		stringField(payload, "topic"),
		stringField(eventRoot, "eventType"),
		stringField(eventRoot, "event_type"),
		stringField(eventRoot, "topic"),
		wixStoresWebhookEnvelopeTopic(payload),
	)
	siteID := normalizeWixSiteID(firstNonEmpty(
		headers.Get("X-Wix-Site-Id"),
		headers.Get("wix-site-id"),
		query.Get("site_id"),
		stringField(payload, "siteId"),
		stringField(payload, "site_id"),
		stringField(mapField(payload, "instance"), "siteId"),
		stringField(data, "siteId"),
		stringField(data, "site_id"),
		stringField(mapField(data, "instance"), "siteId"),
		stringField(mapField(payload, "site"), "id"),
		stringField(mapField(data, "site"), "id"),
	))
	entityFQDN := firstNonEmpty(
		stringField(payload, "entityFqdn"),
		stringField(payload, "entity_fqdn"),
		stringField(eventRoot, "entityFqdn"),
		stringField(eventRoot, "entity_fqdn"),
	)
	slug := firstNonEmpty(stringField(payload, "slug"), stringField(eventRoot, "slug"))
	if topic == "" && entityFQDN != "" && slug != "" {
		topic = entityFQDN + "." + slug
	}
	event := wixStoresWebhookEvent{
		ID: firstNonEmpty(
			stringField(payload, "eventId"),
			stringField(payload, "event_id"),
			stringField(payload, "id"),
			stringField(eventRoot, "eventId"),
			stringField(eventRoot, "event_id"),
			stringField(eventRoot, "id"),
		),
		Topic:      topic,
		EntityFQDN: entityFQDN,
		Slug:       slug,
		EntityID: firstNonEmpty(
			stringField(payload, "entityId"),
			stringField(payload, "entityID"),
			stringField(payload, "entity_id"),
			stringField(eventRoot, "entityId"),
			stringField(eventRoot, "entityID"),
			stringField(eventRoot, "entity_id"),
		),
		SiteID: siteID,
		InstanceID: firstNonEmpty(
			stringField(payload, "instanceId"),
			stringField(payload, "instance_id"),
			stringField(data, "instanceId"),
			stringField(data, "instance_id"),
			stringField(eventRoot, "instanceId"),
			stringField(eventRoot, "instance_id"),
			stringField(mapField(payload, "instance"), "id"),
			stringField(mapField(data, "instance"), "id"),
		),
		AppID: firstNonEmpty(
			stringField(payload, "appId"),
			stringField(payload, "app_id"),
			stringField(data, "appId"),
			stringField(data, "app_id"),
			stringField(eventRoot, "appId"),
			stringField(eventRoot, "app_id"),
		),
		Payload: payload,
	}
	if event.ID == "" {
		body, _ := json.Marshal(payload)
		event.ID = localWebhookID(firstNonEmpty(event.SiteID, event.InstanceID, event.AppID), event.Topic, body)
	}
	return event
}

func firstNonEmptyMap(values ...map[string]any) map[string]any {
	for _, value := range values {
		if len(value) > 0 {
			return value
		}
	}
	return map[string]any{}
}

func wixStoresWebhookEnvelopeTopic(payload map[string]any) string {
	entity := strings.TrimSpace(firstNonEmpty(
		stringField(payload, "entityFqdn"),
		stringField(payload, "entity_fqdn"),
		stringField(mapField(payload, "data"), "entityFqdn"),
		stringField(mapField(payload, "metadata"), "entityFqdn"),
	))
	slug := strings.TrimSpace(firstNonEmpty(
		stringField(payload, "slug"),
		stringField(mapField(payload, "data"), "slug"),
		stringField(mapField(payload, "metadata"), "slug"),
	))
	if entity == "" || slug == "" {
		return ""
	}
	return entity + "." + slug
}

func (d *Deps) WixStoresWebhook(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 1 << 20
	body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Wix Stores webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	event, integration, creds, err := d.decodeAndVerifyWixStoresWebhook(r.Context(), body, r)
	if err != nil {
		status := http.StatusBadRequest
		code := "invalid_payload"
		if errors.Is(err, ErrMissingSecret) || errors.Is(err, ErrMissingSignature) || errors.Is(err, ErrInvalidSignature) || errors.Is(err, ErrExpiredState) {
			status = http.StatusUnauthorized
			code = "invalid_signature"
		}
		if errors.Is(err, ErrNotFound) {
			status = http.StatusNotFound
			code = "integration_not_found"
		}
		httperror.Write(w, status, code, httperror.MessageForStatus(status))
		return
	}
	if event.Topic == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_event", "Wix webhook event topic is required")
		return
	}
	webhookID := firstNonEmpty(r.Header.Get("X-Wix-Event-Id"), r.Header.Get("X-Request-Id"), event.ID, localWebhookID(firstNonEmpty(event.SiteID, event.InstanceID), event.Topic, body))
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderWixStores, webhookID, event.Topic, body)
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
	if strings.TrimSpace(integration.Status) != "" && !strings.EqualFold(strings.TrimSpace(integration.Status), "connected") && !wixStoresWebhookIsLifecycleTopic(event.Topic) {
		if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderWixStores, webhookID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true, "event_id": event.ID, "reason": "integration_not_connected"})
		return
	}
	if err := d.dispatchWixStoresWebhook(r.Context(), integration, event, creds); err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderWixStores, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderWixStores, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (d *Deps) decodeAndVerifyWixStoresWebhook(ctx context.Context, body []byte, r *http.Request) (wixStoresWebhookEvent, *Integration, WixStoresCredentials, error) {
	if d == nil || d.Repo == nil {
		return wixStoresWebhookEvent{}, nil, WixStoresCredentials{}, fmt.Errorf("wix stores webhook repo is not configured")
	}
	resolver := d.wixStoresCredentialResolver()
	if resolver == nil {
		return wixStoresWebhookEvent{}, nil, WixStoresCredentials{}, fmt.Errorf("wix stores credential resolver is not configured")
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return wixStoresWebhookEvent{}, nil, WixStoresCredentials{}, fmt.Errorf("empty Wix Stores webhook body")
	}
	if trimmed[0] != '{' {
		claims, err := decodeWixStoresWebhookJWTUnverified(string(trimmed))
		if err != nil {
			return wixStoresWebhookEvent{}, nil, WixStoresCredentials{}, err
		}
		event := wixStoresWebhookEventFromMap(claims, r)
		integration, err := d.findWixStoresIntegration(ctx, event)
		if err != nil {
			return wixStoresWebhookEvent{}, nil, WixStoresCredentials{}, err
		}
		creds, err := resolver.ResolveWixStores(ctx, integration.TenantID, *integration)
		if err != nil {
			return wixStoresWebhookEvent{}, nil, WixStoresCredentials{}, err
		}
		verified, err := VerifyWixStoresWebhookJWT(creds.WebhookPublicKey, string(trimmed), d.now(), firstNonEmpty(creds.AppID, creds.ClientID, settingString(integration.Settings, "app_id"), settingString(integration.Settings, "client_id")))
		if err != nil {
			return wixStoresWebhookEvent{}, nil, WixStoresCredentials{}, err
		}
		return wixStoresWebhookEventFromMap(verified, r), integration, creds, nil
	}
	event, err := decodeWixStoresWebhookEvent(body, r)
	if err != nil {
		return wixStoresWebhookEvent{}, nil, WixStoresCredentials{}, err
	}
	integration, err := d.findWixStoresIntegration(ctx, event)
	if err != nil {
		return wixStoresWebhookEvent{}, nil, WixStoresCredentials{}, err
	}
	creds, err := resolver.ResolveWixStores(ctx, integration.TenantID, *integration)
	if err != nil {
		return wixStoresWebhookEvent{}, nil, WixStoresCredentials{}, err
	}
	if err := verifyWixStoresWebhookSecretValue(creds.WebhookSecret, r.Header); err != nil {
		return wixStoresWebhookEvent{}, nil, WixStoresCredentials{}, err
	}
	return event, integration, creds, nil
}

func (d *Deps) findWixStoresIntegration(ctx context.Context, event wixStoresWebhookEvent) (*Integration, error) {
	if d == nil || d.Repo == nil {
		return nil, ErrNotFound
	}
	for _, id := range []string{event.SiteID, event.InstanceID, event.AppID} {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		integration, err := d.Repo.FindWixStoresIntegrationBySiteID(ctx, id)
		if err == nil {
			return integration, nil
		}
		if !errors.Is(err, ErrNotFound) {
			return nil, err
		}
	}
	return nil, ErrNotFound
}

func verifyWixStoresWebhookSecret(secret string, headers http.Header) bool {
	return verifyWixStoresWebhookSecretValue(secret, headers) == nil
}

func verifyWixStoresWebhookSecretValue(secret string, headers http.Header) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingSecret
	}
	candidates := []string{
		headers.Get("X-Postwave-Webhook-Secret"),
		headers.Get("X-Wix-Webhook-Secret"),
		headers.Get("X-Webhook-Secret"),
	}
	if auth := strings.TrimSpace(headers.Get("Authorization")); strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		candidates = append(candidates, strings.TrimSpace(auth[len("bearer "):]))
	}
	seenCandidate := false
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		seenCandidate = true
		if subtle.ConstantTimeCompare([]byte(candidate), []byte(secret)) == 1 {
			return nil
		}
	}
	if !seenCandidate {
		return ErrMissingSignature
	}
	return ErrInvalidSignature
}

type wixStoresWebhookJWTHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
}

func VerifyWixStoresWebhookJWT(publicKeyPEM, token string, now time.Time, audience string) (map[string]any, error) {
	publicKeyPEM = strings.TrimSpace(publicKeyPEM)
	if publicKeyPEM == "" {
		return nil, ErrMissingSecret
	}
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return nil, ErrMissingSignature
	}
	enc := base64.RawURLEncoding
	headerBytes, err := enc.DecodeString(parts[0])
	if err != nil {
		return nil, ErrInvalidSignature
	}
	var header wixStoresWebhookJWTHeader
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return nil, ErrInvalidSignature
	}
	if !strings.EqualFold(strings.TrimSpace(header.Alg), "RS256") {
		return nil, ErrInvalidSignature
	}
	signature, err := enc.DecodeString(parts[2])
	if err != nil {
		return nil, ErrInvalidSignature
	}
	pub, err := parseWixStoresRSAPublicKey([]byte(publicKeyPEM))
	if err != nil {
		return nil, ErrInvalidSignature
	}
	signingInput := []byte(parts[0] + "." + parts[1])
	digest := sha256.Sum256(signingInput)
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], signature); err != nil {
		return nil, ErrInvalidSignature
	}
	claims, err := decodeWixStoresWebhookJWTUnverified(token)
	if err != nil {
		return nil, ErrInvalidSignature
	}
	if err := validateWixStoresWebhookClaims(claims, now, audience); err != nil {
		return nil, err
	}
	return claims, nil
}

func decodeWixStoresWebhookJWTUnverified(token string) (map[string]any, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return nil, ErrMissingSignature
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrInvalidSignature
	}
	var claims map[string]any
	dec := json.NewDecoder(bytes.NewReader(payloadBytes))
	dec.UseNumber()
	if err := dec.Decode(&claims); err != nil && err != io.EOF {
		return nil, ErrInvalidSignature
	}
	return nonNilMap(claims), nil
}

func validateWixStoresWebhookClaims(claims map[string]any, now time.Time, audience string) error {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if iss := stringField(claims, "iss"); iss != "" && iss != "wix.com" {
		return ErrInvalidSignature
	}
	if exp, ok := wixStoresNumericClaim(claims["exp"]); ok && now.Unix() > exp+300 {
		return ErrExpiredState
	}
	if iat, ok := wixStoresNumericClaim(claims["iat"]); ok && iat > now.Add(5*time.Minute).Unix() {
		return ErrInvalidSignature
	}
	if audience = strings.TrimSpace(audience); audience != "" {
		if rawAud, ok := claims["aud"]; ok && !wixStoresClaimAudienceContains(rawAud, audience) {
			return ErrInvalidSignature
		}
	}
	return nil
}

func parseWixStoresRSAPublicKey(material []byte) (*rsa.PublicKey, error) {
	block, _ := pem.Decode(bytes.TrimSpace(material))
	if block == nil {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(material)))
		if err != nil {
			return nil, errors.New("wix stores webhook public key is not PEM or base64 DER")
		}
		return parseWixStoresRSAPublicKeyDER(decoded)
	}
	switch block.Type {
	case "PUBLIC KEY":
		pub, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		key, ok := pub.(*rsa.PublicKey)
		if !ok {
			return nil, errors.New("wix stores webhook public key is not RSA")
		}
		return key, nil
	case "RSA PUBLIC KEY":
		return x509.ParsePKCS1PublicKey(block.Bytes)
	case "CERTIFICATE":
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, err
		}
		key, ok := cert.PublicKey.(*rsa.PublicKey)
		if !ok {
			return nil, errors.New("wix stores webhook certificate public key is not RSA")
		}
		return key, nil
	default:
		return nil, fmt.Errorf("unsupported Wix Stores public key PEM type %q", block.Type)
	}
}

func parseWixStoresRSAPublicKeyDER(der []byte) (*rsa.PublicKey, error) {
	pub, err := x509.ParsePKIXPublicKey(der)
	if err == nil {
		if key, ok := pub.(*rsa.PublicKey); ok {
			return key, nil
		}
	}
	return x509.ParsePKCS1PublicKey(der)
}

func wixStoresNumericClaim(value any) (int64, bool) {
	switch typed := value.(type) {
	case json.Number:
		n, err := typed.Int64()
		return n, err == nil
	case float64:
		return int64(typed), true
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return n, err == nil
	default:
		return 0, false
	}
}

func wixStoresClaimAudienceContains(raw any, audience string) bool {
	audience = strings.TrimSpace(audience)
	switch typed := raw.(type) {
	case string:
		return typed == audience
	case []any:
		for _, item := range typed {
			if strings.TrimSpace(fmt.Sprint(item)) == audience {
				return true
			}
		}
	}
	return false
}

func (d *Deps) dispatchWixStoresWebhook(ctx context.Context, integration *Integration, event wixStoresWebhookEvent, creds WixStoresCredentials) error {
	if integration == nil {
		return nil
	}
	topic := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(event.Topic, "/", ".")))
	if wixStoresWebhookIsAppRemoved(topic) {
		return d.Repo.MarkWixStoresUninstalled(ctx, integration.TenantID, integration.ID)
	}
	if wixStoresWebhookIsAppInstalled(topic) {
		return d.recordWixStoresAppInstalled(ctx, integration, event, creds)
	}
	switch {
	case wixStoresWebhookIsProviderEventTopic(topic):
		providerEvent := wixStoresProviderEvent(event)
		if providerEvent.EventType == "" {
			return nil
		}
		return d.Repo.RecordProviderEvent(ctx, integration.TenantID, integration.ID, providerEvent)
	case strings.Contains(topic, "contact"):
		entity := wixStoresWebhookEntity(event, "contact")
		if wixStoresWebhookIsDelete(event) {
			deletion := wixStoresDeletion("contact", event, entity)
			if deletion.SourceID == "" {
				return fmt.Errorf("wix contact delete webhook missing contact id")
			}
			return d.Repo.DeleteCustomer(ctx, integration.TenantID, integration.ID, deletion)
		}
		if wixStoresWebhookEntityNeedsFetch(entity, "contact") {
			fetched, err := d.fetchWixStoresWebhookEntity(ctx, integration, event, creds, "contact")
			if err != nil {
				return err
			}
			entity = fetched
		}
		customer := wixStoresContactCustomer(entity)
		if customer.SourceID == "" {
			return fmt.Errorf("wix contact webhook missing contact id")
		}
		return d.Repo.UpsertCustomer(ctx, integration.TenantID, integration.ID, customer)
	case strings.Contains(topic, "product") || strings.Contains(topic, "catalog"):
		entity := wixStoresWebhookEntity(event, "product")
		if wixStoresWebhookIsDelete(event) {
			deletion := wixStoresDeletion("product", event, entity)
			if deletion.SourceID == "" {
				return fmt.Errorf("wix product delete webhook missing product id")
			}
			return d.Repo.DeleteProduct(ctx, integration.TenantID, integration.ID, deletion)
		}
		if wixStoresWebhookEntityNeedsFetch(entity, "product") {
			fetched, err := d.fetchWixStoresWebhookEntity(ctx, integration, event, creds, "product")
			if err != nil {
				return err
			}
			entity = fetched
		}
		product := wixStoresProductInput(entity)
		if product.SourceID == "" {
			return fmt.Errorf("wix product webhook missing product id")
		}
		return d.Repo.UpsertProduct(ctx, integration.TenantID, integration.ID, product)
	case strings.Contains(topic, "order"):
		entity := wixStoresWebhookEntity(event, "order")
		if wixStoresWebhookEntityNeedsFetch(entity, "order") {
			fetched, err := d.fetchWixStoresWebhookEntity(ctx, integration, event, creds, "order")
			if err != nil {
				return err
			}
			entity = fetched
		}
		order := wixStoresOrderInput(entity)
		if order.SourceID == "" {
			return fmt.Errorf("wix order webhook missing order id")
		}
		return d.Repo.UpsertOrder(ctx, integration.TenantID, integration.ID, order)
	default:
		return nil
	}
}

func wixStoresWebhookIsProviderEventTopic(topic string) bool {
	topic = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(topic, "/", ".")))
	if topic == "" {
		return false
	}
	switch {
	case strings.Contains(topic, "pricing") || strings.Contains(topic, "plan") || strings.Contains(topic, "subscription"):
		return true
	case strings.Contains(topic, "booking") || strings.Contains(topic, "reservation") || strings.Contains(topic, "appointment"):
		return true
	case strings.Contains(topic, "wix.events") || strings.Contains(topic, "ticket") || strings.Contains(topic, "rsvp") || strings.Contains(topic, "guest"):
		return true
	case strings.Contains(topic, "payment") || strings.Contains(topic, "transaction") || strings.Contains(topic, "refund") || strings.Contains(topic, "invoice") || strings.Contains(topic, "checkout"):
		return true
	default:
		return false
	}
}

func wixStoresProviderEvent(event wixStoresWebhookEvent) ProviderEventInput {
	topic := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(event.Topic, "/", ".")))
	object := wixStoresProviderEventObject(topic)
	eventType := wixStoresProviderEventType(topic)
	sourceID := wixStoresProviderEventSourceID(object, event)
	providerEventID := strings.TrimSpace(event.ID)
	if providerEventID != "" {
		providerEventID = "wix:" + providerEventID
	} else if sourceID != "" {
		providerEventID = eventType + ":" + sourceID
	}
	return ProviderEventInput{
		EventType:       eventType,
		Provider:        ProviderWixStores,
		Topic:           strings.TrimSpace(event.Topic),
		SourceID:        sourceID,
		ProviderEventID: providerEventID,
		CustomerEmail:   wixStoresProviderEventCustomerEmail(event),
		Metadata: map[string]any{
			"source":       ProviderWixStores,
			"topic":        strings.TrimSpace(event.Topic),
			"object":       object,
			"source_id":    sourceID,
			"event_id":     event.ID,
			"site_id":      event.SiteID,
			"instance_id":  event.InstanceID,
			"app_id":       event.AppID,
			"entity_fqdn":  event.EntityFQDN,
			"slug":         event.Slug,
			"entity_id":    event.EntityID,
			"provider_raw": nonNilMap(event.Payload),
		},
	}
}

func wixStoresProviderEventObject(topic string) string {
	switch {
	case strings.Contains(topic, "refund"):
		return "refund"
	case strings.Contains(topic, "pricing") || strings.Contains(topic, "plan") || strings.Contains(topic, "subscription"):
		return "subscription"
	case strings.Contains(topic, "booking") || strings.Contains(topic, "reservation") || strings.Contains(topic, "appointment"):
		return "booking"
	case strings.Contains(topic, "ticket"):
		return "ticket"
	case strings.Contains(topic, "wix.events") || strings.Contains(topic, "rsvp") || strings.Contains(topic, "guest"):
		return "event_registration"
	case strings.Contains(topic, "invoice"):
		return "invoice"
	case strings.Contains(topic, "checkout"):
		return "checkout_session"
	default:
		return "transaction"
	}
}

func wixStoresProviderEventType(topic string) string {
	topic = strings.ToLower(strings.TrimSpace(topic))
	switch {
	case strings.Contains(topic, "refund") && strings.Contains(topic, "fail"):
		return "refund_failed"
	case strings.Contains(topic, "refund") && (strings.Contains(topic, "process") || strings.Contains(topic, "complete")):
		return "refund_processed"
	case strings.Contains(topic, "refund") && (strings.Contains(topic, "update") || strings.Contains(topic, "speed")):
		return "refund_updated"
	case strings.Contains(topic, "refund"):
		return "refund_created"
	case strings.Contains(topic, "pricing") || strings.Contains(topic, "plan") || strings.Contains(topic, "subscription"):
		if wixStoresTopicContainsAny(topic, "delete", "deleted", "cancel", "canceled", "cancelled", "expire", "expired", "end", "ended") {
			return "subscription_deleted"
		}
		if wixStoresTopicContainsAny(topic, "create", "created", "purchase", "purchased", "start", "started", "activate", "activated", "order_purchased") {
			return "subscription_created"
		}
		return "subscription_updated"
	case strings.Contains(topic, "booking") || strings.Contains(topic, "reservation") || strings.Contains(topic, "appointment"):
		if wixStoresTopicContainsAny(topic, "cancel", "canceled", "cancelled", "delete", "deleted") {
			return "booking_cancelled"
		}
		if wixStoresTopicContainsAny(topic, "create", "created", "booked", "confirm", "confirmed", "reserve", "reserved") {
			return "booking_created"
		}
		return "booking_updated"
	case strings.Contains(topic, "ticket") || strings.Contains(topic, "wix.events") || strings.Contains(topic, "rsvp") || strings.Contains(topic, "guest"):
		if wixStoresTopicContainsAny(topic, "cancel", "canceled", "cancelled", "delete", "deleted") {
			return "event_registration_cancelled"
		}
		if wixStoresTopicContainsAny(topic, "purchase", "purchased", "checkout", "order", "created", "confirmed", "registered") {
			return "ticket_purchased"
		}
		return "event_registration_updated"
	case strings.Contains(topic, "invoice") && strings.Contains(topic, "fail"):
		return "invoice_payment_failed"
	case strings.Contains(topic, "invoice") && strings.Contains(topic, "paid"):
		return "invoice_paid"
	case strings.Contains(topic, "invoice") && strings.Contains(topic, "void"):
		return "invoice_voided"
	case strings.Contains(topic, "invoice"):
		return "invoice_updated"
	case strings.Contains(topic, "checkout") && strings.Contains(topic, "expire"):
		return "checkout_session_expired"
	case strings.Contains(topic, "checkout"):
		return "checkout_session_updated"
	case strings.Contains(topic, "payment") || strings.Contains(topic, "transaction"):
		if wixStoresTopicContainsAny(topic, "create", "created", "paid", "capture", "captured", "succeed", "succeeded", "complete", "completed") {
			return "transaction_created"
		}
		return "transaction_updated"
	default:
		return "transaction_updated"
	}
}

func wixStoresTopicContainsAny(topic string, parts ...string) bool {
	for _, part := range parts {
		if strings.Contains(topic, part) {
			return true
		}
	}
	return false
}

func wixStoresProviderEventSourceID(object string, event wixStoresWebhookEvent) string {
	id := strings.TrimSpace(firstNonEmpty(
		event.EntityID,
		stringField(event.Payload, "entityId"),
		stringField(event.Payload, "entity_id"),
		stringField(mapField(event.Payload, "data"), "entityId"),
		stringField(mapField(event.Payload, "data"), "entity_id"),
		firstNonEmpty(
			stringField(wixStoresWebhookEntity(event, object), "id"),
			stringField(wixStoresWebhookEntity(event, object), "_id"),
			stringField(wixStoresWebhookEntity(event, object), object+"Id"),
			stringField(wixStoresWebhookEntity(event, object), object+"_id"),
		),
		wixStoresFindProviderEventID(nonNilMap(event.Payload), object, 0),
		event.ID,
	))
	if id == "" {
		return ""
	}
	return "wix://" + strings.TrimSpace(object) + "/" + id
}

func wixStoresFindProviderEventID(value any, object string, depth int) string {
	if depth > 6 {
		return ""
	}
	keys := []string{"id", "_id", "entityId", "entity_id", object + "Id", object + "_id"}
	switch object {
	case "subscription":
		keys = append(keys, "subscriptionId", "subscription_id", "orderId", "order_id", "planOrderId", "plan_order_id")
	case "booking":
		keys = append(keys, "bookingId", "booking_id", "reservationId", "reservation_id", "appointmentId", "appointment_id")
	case "ticket":
		keys = append(keys, "ticketId", "ticket_id", "ticketNumber", "ticket_number", "orderId", "order_id")
	case "event_registration":
		keys = append(keys, "guestId", "guest_id", "registrationId", "registration_id", "orderId", "order_id", "ticketNumber", "ticket_number")
	case "refund":
		keys = append(keys, "refundId", "refund_id", "paymentId", "payment_id", "transactionId", "transaction_id")
	case "invoice":
		keys = append(keys, "invoiceId", "invoice_id")
	case "checkout_session":
		keys = append(keys, "checkoutId", "checkout_id", "checkoutSessionId", "checkout_session_id")
	default:
		keys = append(keys, "paymentId", "payment_id", "transactionId", "transaction_id")
	}
	switch typed := value.(type) {
	case map[string]any:
		for _, key := range keys {
			if id := strings.TrimSpace(fmt.Sprint(typed[key])); id != "" && id != "<nil>" {
				return id
			}
		}
		for _, nested := range typed {
			if id := wixStoresFindProviderEventID(nested, object, depth+1); id != "" {
				return id
			}
		}
	case []any:
		for _, nested := range typed {
			if id := wixStoresFindProviderEventID(nested, object, depth+1); id != "" {
				return id
			}
		}
	}
	return ""
}

func wixStoresProviderEventCustomerEmail(event wixStoresWebhookEvent) string {
	if email := wixStoresFindEmail(nonNilMap(event.Payload), 0); email != "" {
		return strings.ToLower(strings.TrimSpace(email))
	}
	return ""
}

func wixStoresFindEmail(value any, depth int) string {
	if depth > 6 {
		return ""
	}
	switch typed := value.(type) {
	case map[string]any:
		for _, key := range []string{"email", "emailAddress", "email_address", "buyerEmail", "buyer_email", "customerEmail", "customer_email"} {
			if email := strings.TrimSpace(fmt.Sprint(typed[key])); email != "" && email != "<nil>" && strings.Contains(email, "@") {
				return email
			}
		}
		for _, key := range []string{"buyerInfo", "buyer_info", "customer", "contact", "guest", "member", "purchaser", "buyer", "form", "data", "entity"} {
			if email := wixStoresFindEmail(typed[key], depth+1); email != "" {
				return email
			}
		}
		for _, nested := range typed {
			if email := wixStoresFindEmail(nested, depth+1); email != "" {
				return email
			}
		}
	case []any:
		for _, nested := range typed {
			if email := wixStoresFindEmail(nested, depth+1); email != "" {
				return email
			}
		}
	}
	return ""
}

func wixStoresWebhookIsAppInstalled(topic string) bool {
	topic = strings.ToLower(strings.TrimSpace(topic))
	return (strings.Contains(topic, "app") || strings.Contains(topic, "instance")) &&
		(strings.Contains(topic, "installed") || strings.Contains(topic, ".created"))
}

func wixStoresWebhookIsAppRemoved(topic string) bool {
	topic = strings.ToLower(strings.TrimSpace(topic))
	return (strings.Contains(topic, "app") || strings.Contains(topic, "instance")) &&
		(strings.Contains(topic, "removed") || strings.Contains(topic, "uninstalled") || strings.Contains(topic, ".deleted"))
}

func wixStoresWebhookIsLifecycleTopic(topic string) bool {
	topic = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(topic, "/", ".")))
	return wixStoresWebhookIsAppInstalled(topic) || wixStoresWebhookIsAppRemoved(topic)
}

func (d *Deps) recordWixStoresAppInstalled(ctx context.Context, integration *Integration, event wixStoresWebhookEvent, creds WixStoresCredentials) error {
	if integration == nil {
		return nil
	}
	settings := copySettings(integration.Settings)
	if event.SiteID != "" {
		settings["site_id"] = event.SiteID
	}
	if event.InstanceID != "" {
		settings["instance_id"] = event.InstanceID
	}
	if event.AppID != "" {
		settings["app_id"] = event.AppID
	}
	settings["wix_app_instance_status"] = "installed"
	settings["wix_app_instance_last_event_id"] = event.ID
	settings["wix_app_instance_seen_at"] = d.now().UTC().Format(time.RFC3339)
	settings["wix_app_instance_event"] = nonNilMap(event.Payload)
	if appInstance, err := d.fetchWixStoresAppInstance(ctx, integration, creds); err == nil && len(appInstance) > 0 {
		settings["wix_app_instance"] = appInstance
		if siteID := wixStoresAppInstanceSiteID(appInstance); siteID != "" {
			settings["site_id"] = siteID
		}
		if storeID := wixStoresAppInstanceStoreID(appInstance); storeID != "" {
			settings["store_id"] = storeID
		}
	}
	_, err := d.Repo.UpsertIntegration(ctx, integration.TenantID, IntegrationInput{
		Provider:   ProviderWixStores,
		ShopDomain: firstNonEmpty(integration.ShopDomain, settingString(settings, "store_id"), settingString(settings, "site_id"), event.InstanceID),
		Status:     "connected",
		Scopes:     integration.Scopes,
		Settings:   settings,
	})
	return err
}

func (d *Deps) fetchWixStoresAppInstance(ctx context.Context, integration *Integration, creds WixStoresCredentials) (map[string]any, error) {
	if integration == nil {
		return nil, fmt.Errorf("wix app instance fetch missing integration")
	}
	client := commerceEgressClient(d.HTTPClient, ProviderWixStores, 30*time.Second)
	baseURL := strings.TrimRight(firstNonEmpty(creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), "https://www.wixapis.com"), "/")
	token := strings.TrimSpace(creds.AccessToken)
	var err error
	if token == "" {
		token, err = wixStoresAccessToken(ctx, client, baseURL, creds, *integration)
		if err != nil {
			return nil, err
		}
	}
	out, err := wixStoresDoMapJSON(ctx, client, baseURL, token, *integration, http.MethodGet, "/apps/v1/instance", nil, nil)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func wixStoresAppInstanceSiteID(raw map[string]any) string {
	for _, root := range []map[string]any{raw, mapField(raw, "instance"), mapField(raw, "appInstance"), mapField(raw, "app_instance")} {
		if len(root) == 0 {
			continue
		}
		if id := firstNonEmpty(stringField(root, "siteId"), stringField(root, "site_id")); id != "" {
			return normalizeWixSiteID(id)
		}
		if siteID := firstNonEmpty(stringField(mapField(root, "site"), "id"), stringField(mapField(root, "site"), "siteId")); siteID != "" {
			return normalizeWixSiteID(siteID)
		}
	}
	if siteID := firstNonEmpty(stringField(mapField(raw, "site"), "id"), stringField(mapField(raw, "site"), "siteId")); siteID != "" {
		return normalizeWixSiteID(siteID)
	}
	return ""
}

func wixStoresAppInstanceStoreID(raw map[string]any) string {
	installed := rawArray(mapField(raw, "site")["installedWixApps"])
	if len(installed) == 0 {
		installed = rawArray(mapField(mapField(raw, "instance"), "site")["installedWixApps"])
	}
	for _, item := range installed {
		app, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name := strings.ToLower(firstNonEmpty(stringField(app, "name"), stringField(app, "appName"), stringField(app, "app_name")))
		if strings.Contains(name, "stores") || strings.Contains(name, "store") {
			if id := firstNonEmpty(stringField(app, "id"), stringField(app, "appId"), stringField(app, "instanceId")); id != "" {
				return strings.TrimSpace(id)
			}
		}
	}
	return ""
}

func (d *Deps) fetchWixStoresWebhookEntity(ctx context.Context, integration *Integration, event wixStoresWebhookEvent, creds WixStoresCredentials, kind string) (map[string]any, error) {
	if integration == nil {
		return nil, fmt.Errorf("wix %s webhook missing integration", kind)
	}
	id := wixStoresWebhookEntityID(event, kind)
	if id == "" {
		return nil, fmt.Errorf("wix %s webhook missing entity id", kind)
	}
	client := commerceEgressClient(d.HTTPClient, ProviderWixStores, 30*time.Second)
	baseURL := strings.TrimRight(firstNonEmpty(creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), "https://www.wixapis.com"), "/")
	token := strings.TrimSpace(creds.AccessToken)
	var err error
	if token == "" {
		token, err = wixStoresAccessToken(ctx, client, baseURL, creds, *integration)
		if err != nil {
			return nil, err
		}
	}
	path, envelope, err := wixStoresWebhookFetchPath(ctx, client, baseURL, token, *integration, kind, id)
	if err != nil {
		return nil, err
	}
	out, err := wixStoresDoMapJSON(ctx, client, baseURL, token, *integration, http.MethodGet, path, nil, nil)
	if err != nil {
		return nil, err
	}
	return wixStoresEntityFromResponse(out, envelope), nil
}

func wixStoresWebhookFetchPath(ctx context.Context, client *http.Client, baseURL, token string, integration Integration, kind, id string) (string, string, error) {
	escapedID := url.PathEscape(strings.TrimSpace(id))
	switch kind {
	case "contact":
		return "/contacts/v4/contacts/" + escapedID, "contact", nil
	case "product":
		version, err := wixStoresCatalogVersion(ctx, client, baseURL, token, integration)
		if err != nil {
			return "", "", err
		}
		if version == "v1" {
			return "/stores-reader/v1/products/" + escapedID, "product", nil
		}
		return "/stores/v3/products/" + escapedID, "product", nil
	case "order":
		return "/ecom/v1/orders/" + escapedID, "order", nil
	default:
		return "", "", fmt.Errorf("unsupported wix stores webhook fetch kind %q", kind)
	}
}

func wixStoresWebhookEntity(event wixStoresWebhookEvent, kind string) map[string]any {
	raw := nonNilMap(event.Payload)
	if entity := mapField(raw, kind); len(entity) > 0 {
		return entity
	}
	data := mapField(raw, "data")
	if entity := mapField(data, kind); len(entity) > 0 {
		return entity
	}
	if entity := mapField(raw, "entity"); len(entity) > 0 {
		return entity
	}
	if entity := mapField(data, "entity"); len(entity) > 0 {
		return entity
	}
	for _, key := range []string{"createdEvent", "updatedEvent", "deletedEvent", "entityEvent"} {
		if entity := mapField(mapField(raw, key), "entity"); len(entity) > 0 {
			return entity
		}
		if entity := mapField(mapField(data, key), "entity"); len(entity) > 0 {
			return entity
		}
	}
	if len(data) > 0 {
		return data
	}
	if id := wixStoresWebhookEntityID(event, kind); id != "" {
		return map[string]any{"id": id}
	}
	return map[string]any{}
}

func wixStoresWebhookEntityID(event wixStoresWebhookEvent, kind string) string {
	raw := nonNilMap(event.Payload)
	data := mapField(raw, "data")
	entity := wixStoresWebhookEntityNoFallback(event, kind)
	return firstNonEmpty(
		wixStoresEntityID(entity, kind),
		stringField(raw, "entityId"),
		stringField(raw, "entityID"),
		stringField(raw, "entity_id"),
		stringField(data, "entityId"),
		stringField(data, "entityID"),
		stringField(data, "entity_id"),
		stringField(mapField(raw, "metadata"), "entityId"),
		stringField(mapField(raw, "createdEvent"), "entityId"),
		stringField(mapField(raw, "updatedEvent"), "entityId"),
		stringField(mapField(raw, "deletedEvent"), "entityId"),
	)
}

func wixStoresWebhookEntityNoFallback(event wixStoresWebhookEvent, kind string) map[string]any {
	raw := nonNilMap(event.Payload)
	if entity := mapField(raw, kind); len(entity) > 0 {
		return entity
	}
	data := mapField(raw, "data")
	if entity := mapField(data, kind); len(entity) > 0 {
		return entity
	}
	if entity := mapField(raw, "entity"); len(entity) > 0 {
		return entity
	}
	if entity := mapField(data, "entity"); len(entity) > 0 {
		return entity
	}
	for _, key := range []string{"createdEvent", "updatedEvent", "deletedEvent", "entityEvent"} {
		if entity := mapField(mapField(raw, key), "entity"); len(entity) > 0 {
			return entity
		}
		if entity := mapField(mapField(data, key), "entity"); len(entity) > 0 {
			return entity
		}
	}
	if len(data) > 0 {
		return data
	}
	return map[string]any{}
}

func wixStoresWebhookEntityNeedsFetch(entity map[string]any, kind string) bool {
	if wixStoresEntityID(entity, kind) == "" {
		return true
	}
	switch kind {
	case "contact":
		return stringField(mapField(entity, "primaryInfo"), "email") == "" &&
			stringField(entity, "email") == "" &&
			len(mapField(mapField(entity, "info"), "name")) == 0
	case "product":
		return stringField(entity, "name") == "" &&
			stringField(entity, "title") == "" &&
			len(mapField(entity, "price")) == 0 &&
			len(mapField(entity, "priceData")) == 0
	case "order":
		return len(mapField(entity, "priceSummary")) == 0 &&
			len(mapField(entity, "total")) == 0 &&
			len(rawArray(entity["lineItems"])) == 0 &&
			len(rawArray(entity["line_items"])) == 0
	default:
		return false
	}
}

func wixStoresWebhookIsDelete(event wixStoresWebhookEvent) bool {
	topic := strings.ToLower(strings.TrimSpace(event.Topic))
	slug := strings.ToLower(strings.TrimSpace(firstNonEmpty(
		stringField(event.Payload, "slug"),
		stringField(mapField(event.Payload, "data"), "slug"),
	)))
	return strings.Contains(topic, "deleted") || strings.Contains(topic, ".delete") || slug == "deleted" || slug == "delete"
}

func wixStoresDeletion(kind string, event wixStoresWebhookEvent, entity map[string]any) ProviderDeletion {
	id := firstNonEmpty(wixStoresEntityID(entity, kind), wixStoresWebhookEntityID(event, kind))
	return ProviderDeletion{
		SourceID: wixStoresSourceID(kind, id),
		Provider: ProviderWixStores,
		Topic:    event.Topic,
		Raw:      nonNilMap(event.Payload),
	}
}

func wixStoresEntityFromResponse(raw map[string]any, envelope string) map[string]any {
	if entity := mapField(raw, envelope); len(entity) > 0 {
		return entity
	}
	if entity := mapField(raw, "entity"); len(entity) > 0 {
		return entity
	}
	if entity := mapField(mapField(raw, "body"), envelope); len(entity) > 0 {
		return entity
	}
	return nonNilMap(raw)
}

func wixStoresEntityID(raw map[string]any, kind string) string {
	switch kind {
	case "contact":
		return firstNonEmpty(stringField(raw, "id"), stringField(raw, "_id"), stringField(raw, "contactId"), stringField(raw, "contact_id"))
	case "product":
		return firstNonEmpty(stringField(raw, "id"), stringField(raw, "_id"), stringField(raw, "productId"), stringField(raw, "product_id"))
	case "order":
		return firstNonEmpty(stringField(raw, "id"), stringField(raw, "_id"), stringField(raw, "orderId"), stringField(raw, "order_id"))
	default:
		return firstNonEmpty(stringField(raw, "id"), stringField(raw, "_id"))
	}
}

func wixStoresContactCustomer(raw map[string]any) CustomerInput {
	id := firstNonEmpty(stringField(raw, "id"), stringField(raw, "_id"), stringField(raw, "contactId"))
	info := mapField(raw, "info")
	name := mapField(info, "name")
	email := firstNonEmpty(
		stringField(mapField(raw, "primaryInfo"), "email"),
		stringField(mapField(info, "emails"), "email"),
		stringField(raw, "email"),
		wixStoresFirstEmail(rawArray(info["emails"])),
	)
	return CustomerInput{
		SourceID:         wixStoresSourceID("contact", id),
		Email:            strings.ToLower(strings.TrimSpace(email)),
		FirstName:        firstNonEmpty(stringField(name, "first"), stringField(raw, "firstName"), stringField(raw, "first_name")),
		LastName:         firstNonEmpty(stringField(name, "last"), stringField(raw, "lastName"), stringField(raw, "last_name")),
		AcceptsMarketing: boolField(raw, "acceptsMarketing"),
		Tags:             wixStoresContactTags(raw),
		Raw: map[string]any{
			"source":       ProviderWixStores,
			"source_id":    wixStoresSourceID("contact", id),
			"revision":     stringField(raw, "revision"),
			"labels":       rawArray(info["labelKeys"]),
			"provider_raw": nonNilMap(raw),
		},
	}
}

func wixStoresProductInput(raw map[string]any) ProductInput {
	id := firstNonEmpty(stringField(raw, "id"), stringField(raw, "_id"), stringField(raw, "productId"))
	priceCents, currency := wixStoresProductPrice(raw)
	slug := firstNonEmpty(stringField(raw, "slug"), stringField(raw, "urlPart"), stringField(mapField(raw, "seoData"), "slug"))
	productURL := firstNonEmpty(stringField(raw, "url"), stringField(raw, "productPageUrl"))
	if productURL == "" && slug != "" {
		productURL = "/product-page/" + strings.Trim(slug, "/")
	}
	return ProductInput{
		SourceID:   wixStoresSourceID("product", id),
		Title:      firstNonEmpty(stringField(raw, "name"), stringField(raw, "title"), stringField(raw, "sku")),
		URL:        productURL,
		ImageURL:   wixStoresProductImage(raw),
		PriceCents: priceCents,
		Currency:   strings.ToUpper(firstNonEmpty(currency, "USD")),
		Raw: map[string]any{
			"source":       ProviderWixStores,
			"source_id":    wixStoresSourceID("product", id),
			"sku":          stringField(raw, "sku"),
			"product_type": firstNonEmpty(stringField(raw, "productType"), stringField(raw, "product_type")),
			"visible":      boolField(raw, "visible"),
			"variants":     rawArray(raw["variants"]),
			"provider_raw": nonNilMap(raw),
		},
	}
}

func wixStoresOrderInput(raw map[string]any) OrderInput {
	id := firstNonEmpty(stringField(raw, "id"), stringField(raw, "_id"), stringField(raw, "orderId"))
	total, currency := wixStoresMoney(mapField(mapField(raw, "priceSummary"), "total"))
	if total == 0 {
		total, currency = wixStoresMoney(mapField(raw, "total"))
	}
	subtotal, _ := wixStoresMoney(mapField(mapField(raw, "priceSummary"), "subtotal"))
	discount, _ := wixStoresMoney(mapField(mapField(raw, "priceSummary"), "discount"))
	shipping, _ := wixStoresMoney(mapField(mapField(raw, "priceSummary"), "shipping"))
	tax, _ := wixStoresMoney(mapField(mapField(raw, "priceSummary"), "tax"))
	buyer := mapField(raw, "buyerInfo")
	return OrderInput{
		SourceID:      wixStoresSourceID("order", id),
		CustomerEmail: strings.ToLower(strings.TrimSpace(firstNonEmpty(stringField(buyer, "email"), stringField(raw, "email")))),
		Status:        wixStoresOrderStatus(firstNonEmpty(stringField(raw, "status"), stringField(raw, "paymentStatus"), stringField(raw, "fulfillmentStatus"))),
		SubtotalCents: subtotal,
		DiscountCents: absoluteCents(discount),
		ShippingCents: shipping,
		TaxCents:      tax,
		TotalCents:    total,
		Currency:      strings.ToUpper(firstNonEmpty(currency, stringField(raw, "currency"), "USD")),
		Attribution: map[string]any{
			"source":             ProviderWixStores,
			"number":             stringField(raw, "number"),
			"display_id":         stringField(raw, "displayId"),
			"checkout_id":        stringField(raw, "checkoutId"),
			"buyer_info":         nonNilMap(buyer),
			"payment_status":     stringField(raw, "paymentStatus"),
			"fulfillment_status": stringField(raw, "fulfillmentStatus"),
			"provider_raw":       nonNilMap(raw),
		},
		LineItems: wixStoresLineItems(rawArray(firstNonNil(raw["lineItems"], raw["line_items"])), currency),
		OrderedAt: parseTimeAny(firstNonNil(raw["createdDate"], raw["created_at"], raw["dateCreated"])),
		Raw: map[string]any{
			"source":       ProviderWixStores,
			"source_id":    wixStoresSourceID("order", id),
			"provider_raw": nonNilMap(raw),
		},
	}
}

func wixStoresLineItems(items []any, fallbackCurrency string) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		price, currency := wixStoresMoney(firstMapField(m, "price", "itemPrice", "totalPrice"))
		quantity := maxInt(intField(m, "quantity"), 1)
		total, totalCurrency := wixStoresMoney(firstMapField(m, "totalPrice", "lineItemPrice", "fullPrice"))
		if total == 0 {
			total = price * quantity
			totalCurrency = currency
		}
		out = append(out, map[string]any{
			"source_id":    wixStoresSourceID("order_item", firstNonEmpty(stringField(m, "id"), stringField(m, "_id"), stringField(m, "lineItemId"), stringField(m, "productId"))),
			"product_id":   stringField(m, "productId"),
			"variant_id":   stringField(m, "variantId"),
			"sku":          firstNonEmpty(stringField(m, "sku"), stringField(mapField(m, "catalogReference"), "appId")),
			"title":        firstNonEmpty(stringField(m, "productName"), stringField(m, "name"), stringField(m, "title")),
			"quantity":     quantity,
			"price_cents":  price,
			"total_cents":  total,
			"currency":     strings.ToUpper(firstNonEmpty(currency, totalCurrency, fallbackCurrency)),
			"provider_raw": nonNilMap(m),
		})
	}
	if out == nil {
		return []map[string]any{}
	}
	return out
}

func wixStoresProductPrice(raw map[string]any) (int, string) {
	for _, candidate := range []map[string]any{
		mapField(raw, "price"),
		mapField(raw, "actualPrice"),
		mapField(mapField(raw, "actualPriceRange"), "minValue"),
		mapField(mapField(raw, "priceData"), "price"),
	} {
		if len(candidate) == 0 {
			continue
		}
		amount, currency := wixStoresMoney(candidate)
		if amount != 0 || currency != "" {
			return amount, currency
		}
	}
	for _, item := range rawArray(raw["variants"]) {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		amount, currency := wixStoresMoney(firstMapField(m, "price", "actualPrice"))
		if amount != 0 || currency != "" {
			return amount, currency
		}
	}
	return cents(raw["price"]), firstNonEmpty(stringField(raw, "currency"), stringField(raw, "currencyCode"))
}

func wixStoresMoney(raw map[string]any) (int, string) {
	if len(raw) == 0 {
		return 0, ""
	}
	amount := firstNonNil(raw["amount"], raw["value"], raw["formattedAmount"])
	return cents(amount), strings.ToUpper(firstNonEmpty(stringField(raw, "currency"), stringField(raw, "currencyCode")))
}

func firstMapField(raw map[string]any, keys ...string) map[string]any {
	for _, key := range keys {
		if m := mapField(raw, key); len(m) > 0 {
			return m
		}
	}
	return map[string]any{}
}

func wixStoresProductImage(raw map[string]any) string {
	candidates := []map[string]any{
		mapField(mapField(mapField(raw, "media"), "mainMedia"), "image"),
		mapField(mapField(raw, "media"), "mainMedia"),
		mapField(raw, "image"),
	}
	for _, item := range rawArray(mapField(raw, "media")["items"]) {
		if m, ok := item.(map[string]any); ok {
			candidates = append(candidates, mapField(m, "image"), m)
		}
	}
	for _, candidate := range candidates {
		for _, key := range []string{"url", "src", "fileUrl"} {
			if value := stringField(candidate, key); value != "" {
				return value
			}
		}
	}
	return ""
}

func wixStoresFirstEmail(items []any) string {
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if email := firstNonEmpty(stringField(m, "email"), stringField(m, "emailAddress")); email != "" {
			return email
		}
	}
	return ""
}

func wixStoresContactTags(raw map[string]any) []string {
	tags := []string{"wix_contact"}
	info := mapField(raw, "info")
	for _, item := range rawArray(info["labelKeys"]) {
		label := strings.TrimSpace(fmt.Sprint(item))
		if label != "" && label != "<nil>" {
			tags = append(tags, label)
		}
	}
	return compactStrings(tags)
}

func wixStoresOrderStatus(status string) string {
	switch strings.ToUpper(strings.TrimSpace(status)) {
	case "APPROVED", "PAID", "COMPLETED", "FULFILLED":
		return "paid"
	case "CANCELED", "CANCELLED", "DECLINED":
		return "cancelled"
	case "REFUNDED", "PARTIALLY_REFUNDED":
		return "refunded"
	default:
		return "pending"
	}
}

func wixStoresSourceID(kind, id string) string {
	id = strings.TrimSpace(id)
	if id == "" || id == "<nil>" {
		return ""
	}
	return "wix://" + strings.TrimSpace(kind) + "/" + id
}

func normalizeWixSiteID(raw string) string {
	return strings.TrimSpace(raw)
}
