// SPDX-License-Identifier: AGPL-3.0-only
//
// zendesk.go — native Zendesk Support provider runtime.
//
// Zendesk is the support leader; tickets/conversations enrich subscriber
// profiles and trigger retention messaging (post-resolution NPS, churn-risk).
// This adds the provider-facing layer the support_integrations foundation
// lacked: a credential resolver (API-token or OAuth), a REST puller over the
// Tickets API with side-loaded requester emails, and canonical mapping.
package support_integrations

import (
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
	zendeskDefaultUserAgent = "Moosewave Zendesk Integration"
	zendeskResponseMaxBytes = 16 << 20
	zendeskDefaultPageSize  = 100
	zendeskMaxPageSize      = 100
	zendeskCursorPrefix     = "zendesk:"
	zendeskCursorComplete   = "zendesk:complete"

	zendeskIncrementalCursorPrefix    = "zendesk_incremental:"
	zendeskIncrementalDefaultPageSize = 1000
	zendeskIncrementalMaxPageSize     = 1000
	zendeskIncrementalExportEndpoint  = "/api/v2/incremental/tickets/cursor"
	zendeskIncrementalExportMode      = "incremental_export"
)

var errNotJSONSecret = errors.New("support_integrations: secret is not JSON")

type ZendeskCredentials struct {
	Email       string
	APIToken    string
	AccessToken string
	Subdomain   string
	APIBaseURL  string
	UserAgent   string
}

type ZendeskCredentialResolver interface {
	ResolveZendesk(ctx context.Context, tenantID string, integration Integration) (ZendeskCredentials, error)
}

// SupportRuntimeSecretResolver is the trusted secrets backend.
type SupportRuntimeSecretResolver interface {
	Get(ctx context.Context, ref string) (string, error)
	GetJSON(ctx context.Context, ref string, out any) error
}

type zendeskCredentialPayload struct {
	Email       string `json:"email"`
	APIToken    string `json:"api_token"`
	Token       string `json:"token"`
	AccessToken string `json:"access_token"`
	Subdomain   string `json:"subdomain"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p zendeskCredentialPayload) credentials() (ZendeskCredentials, error) {
	creds := ZendeskCredentials{
		Email:       strings.TrimSpace(p.Email),
		APIToken:    strings.TrimSpace(firstString(p.APIToken, p.Token)),
		AccessToken: strings.TrimSpace(p.AccessToken),
		Subdomain:   strings.TrimSpace(p.Subdomain),
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}
	if creds.AccessToken == "" && (creds.Email == "" || creds.APIToken == "") {
		return ZendeskCredentials{}, fmt.Errorf("zendesk requires an access_token or an email + api_token pair")
	}
	return creds, nil
}

type ZendeskSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r ZendeskSecretsCredentialResolver) ResolveZendesk(ctx context.Context, _ string, integration Integration) (ZendeskCredentials, error) {
	if r.Secrets == nil {
		return ZendeskCredentials{}, fmt.Errorf("zendesk credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return ZendeskCredentials{}, fmt.Errorf("zendesk credentials_ref is required")
	}
	var payload zendeskCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		creds, cerr := payload.credentials()
		if cerr == nil {
			return r.withSubdomain(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return ZendeskCredentials{}, fmt.Errorf("resolve zendesk credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			creds, cerr := payload.credentials()
			if cerr == nil {
				return r.withSubdomain(creds, integration), nil
			}
		}
	}
	// A bare string is treated as an OAuth access token.
	creds, err := zendeskCredentialPayload{AccessToken: raw}.credentials()
	if err != nil {
		return ZendeskCredentials{}, err
	}
	return r.withSubdomain(creds, integration), nil
}

func (r ZendeskSecretsCredentialResolver) withSubdomain(creds ZendeskCredentials, integration Integration) ZendeskCredentials {
	if creds.Subdomain == "" {
		creds.Subdomain = settingString(integration.Settings, "subdomain")
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = settingString(integration.Settings, "api_base_url")
	}
	return creds
}

type ZendeskBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type ZendeskTicketRefresher interface {
	RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketID string) (SyncRequest, error)
}

type ZendeskWebhookCleaner interface {
	DeleteZendeskWebhook(ctx context.Context, tenantID string, integration Integration, webhookID string) (ZendeskWebhookCleanupResult, error)
}

type ZendeskWebhookCleanupResult struct {
	WebhookID          string `json:"webhook_id"`
	Status             string `json:"status"`
	ProviderStatusCode int    `json:"provider_status_code,omitempty"`
}

type ZendeskRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials ZendeskCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type zendeskTicket struct {
	ID          json.Number `json:"id"`
	Subject     string      `json:"subject"`
	Status      string      `json:"status"`
	Priority    string      `json:"priority"`
	RequesterID json.Number `json:"requester_id"`
	AssigneeID  json.Number `json:"assignee_id"`
	Tags        []string    `json:"tags"`
	UpdatedAt   string      `json:"updated_at"`
}

type zendeskUser struct {
	ID    json.Number `json:"id"`
	Email string      `json:"email"`
	Name  string      `json:"name"`
}

type zendeskTicketsResponse struct {
	Tickets []zendeskTicket `json:"tickets"`
	Users   []zendeskUser   `json:"users"`
	Meta    struct {
		HasMore     bool   `json:"has_more"`
		AfterCursor string `json:"after_cursor"`
	} `json:"meta"`
}

type zendeskTicketResponse struct {
	Ticket zendeskTicket `json:"ticket"`
	Users  []zendeskUser `json:"users"`
}

type zendeskIncrementalTicketsResponse struct {
	Tickets     []zendeskTicket `json:"tickets"`
	Users       []zendeskUser   `json:"users"`
	AfterCursor string          `json:"after_cursor"`
	EndOfStream bool            `json:"end_of_stream"`
	EndTime     int64           `json:"end_time"`
	Count       int             `json:"count"`
}

type zendeskIncrementalCursorState struct {
	Cursor    string `json:"cursor,omitempty"`
	StartTime int64  `json:"start_time,omitempty"`
}

func (b ZendeskRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderZendesk {
		return SyncRequest{}, fmt.Errorf("zendesk backfill requires a Zendesk integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("zendesk credential resolver is not configured")
	}
	if zendeskShouldUseIncrementalExport(integration, cursor) {
		return b.backfillIncrementalPage(ctx, tenantID, integration, cursor)
	}
	state := decodeZendeskCursor(cursor)
	if state == zendeskCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: zendeskCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveZendesk(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderZendesk, 30*time.Second)
	baseURL := zendeskBaseURL(b.APIBaseURL, creds)
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("zendesk subdomain or api_base_url is required")
	}
	query := url.Values{}
	query.Set("include", "users")
	query.Set("page[size]", strconv.Itoa(zendeskPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
	if state != "" {
		query.Set("page[after]", state)
	}

	var out zendeskTicketsResponse
	if err := zendeskDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v2/tickets.json", query, &out); err != nil {
		return SyncRequest{}, err
	}
	emails := zendeskEmailsByUserID(out.Users)
	tickets := make([]TicketInput, 0, len(out.Tickets))
	for _, tk := range out.Tickets {
		if mapped, ok := mapZendeskTicket(tk, emails); ok {
			tickets = append(tickets, mapped)
		}
	}
	nextCursor := zendeskCursorComplete
	if out.Meta.HasMore && strings.TrimSpace(out.Meta.AfterCursor) != "" {
		nextCursor = zendeskCursorPrefix + strings.TrimSpace(out.Meta.AfterCursor)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Cursor: nextCursor}, nil
}

func (b ZendeskRESTBackfiller) RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketID string) (SyncRequest, error) {
	if integration.Provider != ProviderZendesk {
		return SyncRequest{}, fmt.Errorf("zendesk ticket refresh requires a Zendesk integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("zendesk credential resolver is not configured")
	}
	ticketID = strings.TrimSpace(ticketID)
	if ticketID == "" {
		return SyncRequest{}, fmt.Errorf("zendesk ticket id is required")
	}
	creds, err := b.Credentials.ResolveZendesk(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderZendesk, 30*time.Second)
	baseURL := zendeskBaseURL(b.APIBaseURL, creds)
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("zendesk subdomain or api_base_url is required")
	}
	query := url.Values{}
	query.Set("include", "users")
	var out zendeskTicketResponse
	path := "/api/v2/tickets/" + url.PathEscape(ticketID) + ".json"
	if err := zendeskDoJSON(ctx, client, baseURL, creds, b.UserAgent, path, query, &out); err != nil {
		return SyncRequest{}, err
	}
	emails := zendeskEmailsByUserID(out.Users)
	if mapped, ok := mapZendeskTicket(out.Ticket, emails); ok {
		return SyncRequest{RunMode: "webhook", Tickets: []TicketInput{mapped}, Cursor: "zendesk-refresh-" + ticketID}, nil
	}
	return SyncRequest{RunMode: "webhook", Cursor: "zendesk-refresh-" + ticketID}, nil
}

func (b ZendeskRESTBackfiller) DeleteZendeskWebhook(ctx context.Context, tenantID string, integration Integration, webhookID string) (ZendeskWebhookCleanupResult, error) {
	if integration.Provider != ProviderZendesk {
		return ZendeskWebhookCleanupResult{}, fmt.Errorf("zendesk webhook cleanup requires a Zendesk integration")
	}
	if b.Credentials == nil {
		return ZendeskWebhookCleanupResult{}, fmt.Errorf("zendesk credential resolver is not configured")
	}
	webhookID = strings.TrimSpace(webhookID)
	if webhookID == "" {
		return ZendeskWebhookCleanupResult{}, fmt.Errorf("zendesk webhook id is required")
	}
	creds, err := b.Credentials.ResolveZendesk(ctx, tenantID, integration)
	if err != nil {
		return ZendeskWebhookCleanupResult{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderZendesk, 30*time.Second)
	baseURL := zendeskBaseURL(b.APIBaseURL, creds)
	if baseURL == "" {
		return ZendeskWebhookCleanupResult{}, fmt.Errorf("zendesk subdomain or api_base_url is required")
	}
	path := "/api/v2/webhooks/" + url.PathEscape(webhookID)
	if err := zendeskDo(ctx, client, http.MethodDelete, baseURL, creds, b.UserAgent, path, nil, nil); err != nil {
		var restErr ZendeskRESTError
		if errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound {
			return ZendeskWebhookCleanupResult{WebhookID: webhookID, Status: "already_absent", ProviderStatusCode: http.StatusNotFound}, nil
		}
		return ZendeskWebhookCleanupResult{}, err
	}
	return ZendeskWebhookCleanupResult{WebhookID: webhookID, Status: "deleted", ProviderStatusCode: http.StatusNoContent}, nil
}

func (b ZendeskRESTBackfiller) backfillIncrementalPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	creds, err := b.Credentials.ResolveZendesk(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderZendesk, 30*time.Second)
	baseURL := zendeskBaseURL(b.APIBaseURL, creds)
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("zendesk subdomain or api_base_url is required")
	}
	state, err := zendeskIncrementalCursorStateFor(integration.Settings, cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	query := url.Values{}
	query.Set("include", "users")
	query.Set("per_page", strconv.Itoa(zendeskIncrementalPageSize(firstString(
		settingString(integration.Settings, "incremental_page_size"),
		settingString(integration.Settings, "page_size"),
		strconv.Itoa(b.PageSize),
	))))
	if state.Cursor != "" {
		query.Set("cursor", state.Cursor)
	} else {
		query.Set("start_time", strconv.FormatInt(state.StartTime, 10))
	}

	var out zendeskIncrementalTicketsResponse
	if err := zendeskDoJSON(ctx, client, baseURL, creds, b.UserAgent, zendeskIncrementalExportEndpoint, query, &out); err != nil {
		return SyncRequest{}, err
	}
	emails := zendeskEmailsByUserID(out.Users)
	tickets := make([]TicketInput, 0, len(out.Tickets))
	for _, tk := range out.Tickets {
		if mapped, ok := mapZendeskTicket(tk, emails); ok {
			tickets = append(tickets, mapped)
		}
	}
	nextState, err := zendeskNextIncrementalCursor(state, out)
	if err != nil {
		return SyncRequest{}, err
	}
	return SyncRequest{
		RunMode:       "backfill",
		Tickets:       tickets,
		Cursor:        encodeZendeskIncrementalCursor(nextState),
		StopAfterPage: out.EndOfStream,
	}, nil
}

func zendeskEmailsByUserID(users []zendeskUser) map[string]string {
	emails := make(map[string]string, len(users))
	for _, u := range users {
		emails[strings.TrimSpace(u.ID.String())] = strings.ToLower(strings.TrimSpace(u.Email))
	}
	return emails
}

func mapZendeskTicket(tk zendeskTicket, emails map[string]string) (TicketInput, bool) {
	email := emails[strings.TrimSpace(tk.RequesterID.String())]
	if email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(tk.ID.String())
	out := TicketInput{
		SourceID:       "zendesk://ticket/" + id,
		ConversationID: id,
		Email:          email,
		Subject:        strings.TrimSpace(tk.Subject),
		Status:         strings.TrimSpace(tk.Status),
		Priority:       strings.TrimSpace(tk.Priority),
		Tags:           tk.Tags,
		Properties: map[string]any{
			"zendesk_ticket_id":   id,
			"zendesk_assignee_id": strings.TrimSpace(tk.AssigneeID.String()),
		},
	}
	if t := parseZendeskTime(tk.UpdatedAt); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func zendeskBaseURL(override string, creds ZendeskCredentials) string {
	if v := strings.TrimRight(strings.TrimSpace(override), "/"); v != "" {
		return v
	}
	if v := strings.TrimRight(strings.TrimSpace(creds.APIBaseURL), "/"); v != "" {
		return v
	}
	if sub := strings.TrimSpace(creds.Subdomain); sub != "" {
		return "https://" + sub + ".zendesk.com"
	}
	return ""
}

func zendeskDoJSON(ctx context.Context, client *http.Client, baseURL string, creds ZendeskCredentials, userAgent, path string, query url.Values, out any) error {
	return zendeskDo(ctx, client, http.MethodGet, baseURL, creds, userAgent, path, query, out)
}

func zendeskDo(ctx context.Context, client *http.Client, method, baseURL string, creds ZendeskCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse zendesk API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return err
	}
	if strings.TrimSpace(creds.AccessToken) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	} else {
		basic := base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(creds.Email) + "/token:" + strings.TrimSpace(creds.APIToken)))
		req.Header.Set("Authorization", "Basic "+basic)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, zendeskDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, zendeskResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return ZendeskRESTError{StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode zendesk response %s: %w", path, err)
	}
	return nil
}

type ZendeskRESTError struct {
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e ZendeskRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("zendesk REST failed %d; retry after %s: %s", e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("zendesk REST failed %d: %s", e.StatusCode, e.Snippet)
}

func decodeZendeskCursor(cursor string) string {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return ""
	}
	if cursor == zendeskCursorComplete {
		return zendeskCursorComplete
	}
	if strings.HasPrefix(cursor, zendeskIncrementalCursorPrefix) {
		state, ok, err := decodeZendeskIncrementalCursor(cursor)
		if err == nil && ok {
			if state.Cursor != "" {
				return state.Cursor
			}
			if state.StartTime > 0 {
				return strconv.FormatInt(state.StartTime, 10)
			}
		}
	}
	return strings.TrimPrefix(cursor, zendeskCursorPrefix)
}

func zendeskShouldUseIncrementalExport(integration Integration, cursor string) bool {
	cursor = strings.TrimSpace(cursor)
	if strings.HasPrefix(cursor, zendeskIncrementalCursorPrefix) {
		return true
	}
	for _, key := range []string{"incremental_export_enabled", "use_incremental_export", "zendesk_incremental_export_enabled"} {
		if zendeskSettingBool(integration.Settings, key) {
			return true
		}
	}
	mode := strings.ToLower(strings.TrimSpace(firstString(
		settingString(integration.Settings, "sync_mode"),
		settingString(integration.Settings, "backfill_mode"),
		settingString(integration.Settings, "zendesk_sync_mode"),
		settingString(integration.Settings, "strategy"),
	)))
	mode = strings.ReplaceAll(mode, "-", "_")
	return mode == zendeskIncrementalExportMode || mode == "incremental"
}

func zendeskIncrementalCursorStateFor(settings map[string]any, cursor string) (zendeskIncrementalCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor != "" {
		state, ok, err := decodeZendeskIncrementalCursor(cursor)
		if err != nil {
			return zendeskIncrementalCursorState{}, err
		}
		if ok {
			if state.Cursor == "" && state.StartTime <= 0 {
				return zendeskIncrementalCursorState{}, fmt.Errorf("zendesk incremental cursor is empty")
			}
			return state, nil
		}
	}
	start, err := zendeskIncrementalStartTime(settings)
	if err != nil {
		return zendeskIncrementalCursorState{}, err
	}
	return zendeskIncrementalCursorState{StartTime: start}, nil
}

func encodeZendeskIncrementalCursor(state zendeskIncrementalCursorState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" && state.StartTime <= 0 {
		return ""
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return ""
	}
	return zendeskIncrementalCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func decodeZendeskIncrementalCursor(cursor string) (zendeskIncrementalCursorState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, zendeskIncrementalCursorPrefix) {
		return zendeskIncrementalCursorState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, zendeskIncrementalCursorPrefix))
	if err != nil {
		return zendeskIncrementalCursorState{}, true, fmt.Errorf("decode zendesk incremental cursor: %w", err)
	}
	var state zendeskIncrementalCursorState
	if err := json.Unmarshal(raw, &state); err != nil {
		return zendeskIncrementalCursorState{}, true, fmt.Errorf("parse zendesk incremental cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	return state, true, nil
}

func zendeskIncrementalStartTime(settings map[string]any) (int64, error) {
	raw := strings.TrimSpace(firstString(
		settingString(settings, "incremental_start_time"),
		settingString(settings, "incremental_start_timestamp"),
		settingString(settings, "start_time"),
	))
	if raw == "" {
		return 0, fmt.Errorf("zendesk incremental_export_enabled requires incremental_start_time as Unix seconds or RFC3339")
	}
	if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
		return n, nil
	}
	if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		return parsed.UTC().Unix(), nil
	}
	return 0, fmt.Errorf("zendesk incremental_start_time must be Unix seconds or RFC3339")
}

func zendeskNextIncrementalCursor(current zendeskIncrementalCursorState, out zendeskIncrementalTicketsResponse) (zendeskIncrementalCursorState, error) {
	if cursor := strings.TrimSpace(out.AfterCursor); cursor != "" {
		return zendeskIncrementalCursorState{Cursor: cursor}, nil
	}
	if out.EndTime > 0 {
		return zendeskIncrementalCursorState{StartTime: out.EndTime}, nil
	}
	if out.EndOfStream {
		return current, nil
	}
	return zendeskIncrementalCursorState{}, fmt.Errorf("zendesk incremental export response missing after_cursor")
}

func zendeskSettingBool(settings map[string]any, key string) bool {
	switch strings.ToLower(strings.TrimSpace(settingString(settings, key))) {
	case "1", "t", "true", "yes", "y", "on", "enabled":
		return true
	default:
		return false
	}
}

func zendeskPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return zendeskDefaultPageSize
	}
	if n > zendeskMaxPageSize {
		return zendeskMaxPageSize
	}
	return n
}

func zendeskIncrementalPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return zendeskIncrementalDefaultPageSize
	}
	if n > zendeskIncrementalMaxPageSize {
		return zendeskIncrementalMaxPageSize
	}
	return n
}

func parseZendeskTime(value string) *time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05Z", "2006-01-02T15:04:05"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			utc := parsed.UTC()
			return &utc
		}
	}
	return nil
}

func parseZendeskRetryAfter(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	return 0
}

func zendeskTruncate(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit]
}
