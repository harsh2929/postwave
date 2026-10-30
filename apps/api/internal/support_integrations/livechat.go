// SPDX-License-Identifier: AGPL-3.0-only
//
// livechat.go — native LiveChat provider runtime.
//
// LiveChat (Agent Chat API). Bearer PAT, POST /v3.6/agent/action/list_archives
// with {limit, page_id}. Each chat embeds its participants in a users array;
// the customer's email/name are read directly from the type=="customer" entry
// (no sideload). Maps to canonical TicketInput via the support providerPull,
// paging on next_page_id.
package support_integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	liveChatDefaultAPIBaseURL = "https://api.livechatinc.com"
	liveChatDefaultUserAgent  = "Moosewave LiveChat Integration"
	liveChatResponseMaxBytes  = 16 << 20
	liveChatDefaultPageSize   = 100
	liveChatMaxPageSize       = 100
	liveChatCursorPrefix      = "livechat:"
	liveChatCursorComplete    = "livechat:complete"
)

type LiveChatCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type LiveChatCredentialResolver interface {
	ResolveLiveChat(ctx context.Context, tenantID string, integration Integration) (LiveChatCredentials, error)
}

type liveChatCredentialPayload struct {
	AccessToken string `json:"access_token"`
	Token       string `json:"token"`
	APIKey      string `json:"api_key"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p liveChatCredentialPayload) credentials() (LiveChatCredentials, error) {
	token := strings.TrimSpace(firstString(p.AccessToken, p.Token, p.APIKey))
	if token == "" {
		return LiveChatCredentials{}, fmt.Errorf("livechat access_token is required")
	}
	return LiveChatCredentials{AccessToken: token, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type LiveChatSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r LiveChatSecretsCredentialResolver) ResolveLiveChat(ctx context.Context, _ string, integration Integration) (LiveChatCredentials, error) {
	if r.Secrets == nil {
		return LiveChatCredentials{}, fmt.Errorf("livechat credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return LiveChatCredentials{}, fmt.Errorf("livechat credentials_ref is required")
	}
	var payload liveChatCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withLiveChatBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return LiveChatCredentials{}, fmt.Errorf("resolve livechat credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withLiveChatBaseURL(creds, integration), nil
			}
		}
	}
	creds, err := liveChatCredentialPayload{AccessToken: raw}.credentials()
	if err != nil {
		return LiveChatCredentials{}, err
	}
	return withLiveChatBaseURL(creds, integration), nil
}

func withLiveChatBaseURL(creds LiveChatCredentials, integration Integration) LiveChatCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type LiveChatBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type LiveChatWebhookManager interface {
	RegisterLiveChatWebhook(ctx context.Context, tenantID string, integration Integration, input LiveChatWebhookRegistrationInput) (LiveChatWebhookRegistrationResult, error)
	UnregisterLiveChatWebhook(ctx context.Context, tenantID string, integration Integration, providerWebhookID, ownerClientID string) (LiveChatWebhookCleanupResult, error)
}

type LiveChatWebhookRegistrationInput struct {
	URL           string
	Action        string
	SecretKey     string
	OwnerClientID string
	Description   string
}

type LiveChatWebhookRegistrationResult struct {
	ProviderWebhookID string `json:"provider_webhook_id"`
	Action            string `json:"action"`
}

type LiveChatWebhookCleanupResult struct {
	ProviderWebhookID  string `json:"provider_webhook_id"`
	Status             string `json:"status"`
	ProviderStatusCode int    `json:"provider_status_code,omitempty"`
}

type LiveChatRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials LiveChatCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type liveChatChat struct {
	ID    string `json:"id"`
	Users []struct {
		Type  string `json:"type"`
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"users"`
	Thread struct {
		ID string `json:"id"`
	} `json:"thread"`
}

type liveChatArchivesResponse struct {
	Chats      []liveChatChat `json:"chats"`
	NextPageID string         `json:"next_page_id"`
}

func (b LiveChatRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderLiveChat {
		return SyncRequest{}, fmt.Errorf("livechat backfill requires a LiveChat integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("livechat credential resolver is not configured")
	}
	cursor = strings.TrimSpace(cursor)
	if cursor == liveChatCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: liveChatCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveLiveChat(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderLiveChat, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), liveChatDefaultAPIBaseURL)
	reqBody := map[string]any{"limit": liveChatPageSize(firstString(settingString(integration.Settings, "page_size"), fmt.Sprintf("%d", b.PageSize)))}
	if groupIDs := liveChatGroupIDs(integration.Settings); len(groupIDs) > 0 {
		reqBody["filters"] = map[string]any{"group_ids": groupIDs}
	}
	if strings.HasPrefix(cursor, liveChatCursorPrefix) {
		reqBody["page_id"] = strings.TrimPrefix(cursor, liveChatCursorPrefix)
	}

	var out liveChatArchivesResponse
	if err := liveChatDoPost(ctx, client, baseURL, creds, b.UserAgent, "/v3.6/agent/action/list_archives", reqBody, &out); err != nil {
		return SyncRequest{}, err
	}
	tickets := make([]TicketInput, 0, len(out.Chats))
	for _, chat := range out.Chats {
		if mapped, ok := mapLiveChatChat(chat); ok {
			tickets = append(tickets, mapped)
		}
	}
	nextCursor := liveChatCursorComplete
	if strings.TrimSpace(out.NextPageID) != "" && len(out.Chats) > 0 {
		nextCursor = liveChatCursorPrefix + strings.TrimSpace(out.NextPageID)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Cursor: nextCursor}, nil
}

func (b LiveChatRESTBackfiller) RegisterLiveChatWebhook(ctx context.Context, tenantID string, integration Integration, input LiveChatWebhookRegistrationInput) (LiveChatWebhookRegistrationResult, error) {
	if integration.Provider != ProviderLiveChat {
		return LiveChatWebhookRegistrationResult{}, fmt.Errorf("livechat webhook registration requires a LiveChat integration")
	}
	if b.Credentials == nil {
		return LiveChatWebhookRegistrationResult{}, fmt.Errorf("livechat credential resolver is not configured")
	}
	webhookURL := strings.TrimSpace(input.URL)
	action := strings.TrimSpace(input.Action)
	secretKey := strings.TrimSpace(input.SecretKey)
	ownerClientID := strings.TrimSpace(input.OwnerClientID)
	if webhookURL == "" {
		return LiveChatWebhookRegistrationResult{}, fmt.Errorf("livechat webhook URL is required")
	}
	if action == "" {
		return LiveChatWebhookRegistrationResult{}, fmt.Errorf("livechat webhook action is required")
	}
	if secretKey == "" {
		return LiveChatWebhookRegistrationResult{}, fmt.Errorf("livechat webhook secret_key is required")
	}
	if ownerClientID == "" {
		return LiveChatWebhookRegistrationResult{}, fmt.Errorf("livechat owner_client_id is required")
	}
	creds, err := b.Credentials.ResolveLiveChat(ctx, tenantID, integration)
	if err != nil {
		return LiveChatWebhookRegistrationResult{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderLiveChat, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), liveChatDefaultAPIBaseURL)
	body := map[string]any{
		"url":             webhookURL,
		"action":          action,
		"secret_key":      secretKey,
		"owner_client_id": ownerClientID,
		"type":            "license",
	}
	if description := strings.TrimSpace(input.Description); description != "" {
		body["description"] = description
	}
	var out struct {
		ID        string `json:"id"`
		WebhookID string `json:"webhook_id"`
	}
	if err := liveChatDoPost(ctx, client, baseURL, creds, b.UserAgent, "/v3.3/configuration/action/register_webhook", body, &out); err != nil {
		return LiveChatWebhookRegistrationResult{}, err
	}
	providerID := strings.TrimSpace(firstString(out.ID, out.WebhookID))
	if providerID == "" {
		return LiveChatWebhookRegistrationResult{}, fmt.Errorf("livechat register_webhook response missing id")
	}
	return LiveChatWebhookRegistrationResult{ProviderWebhookID: providerID, Action: action}, nil
}

func (b LiveChatRESTBackfiller) UnregisterLiveChatWebhook(ctx context.Context, tenantID string, integration Integration, providerWebhookID, ownerClientID string) (LiveChatWebhookCleanupResult, error) {
	if integration.Provider != ProviderLiveChat {
		return LiveChatWebhookCleanupResult{}, fmt.Errorf("livechat webhook cleanup requires a LiveChat integration")
	}
	if b.Credentials == nil {
		return LiveChatWebhookCleanupResult{}, fmt.Errorf("livechat credential resolver is not configured")
	}
	providerWebhookID = strings.TrimSpace(providerWebhookID)
	ownerClientID = strings.TrimSpace(ownerClientID)
	if providerWebhookID == "" {
		return LiveChatWebhookCleanupResult{}, fmt.Errorf("livechat provider webhook id is required")
	}
	if ownerClientID == "" {
		return LiveChatWebhookCleanupResult{}, fmt.Errorf("livechat owner_client_id is required")
	}
	creds, err := b.Credentials.ResolveLiveChat(ctx, tenantID, integration)
	if err != nil {
		return LiveChatWebhookCleanupResult{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderLiveChat, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), liveChatDefaultAPIBaseURL)
	body := map[string]any{
		"id":              providerWebhookID,
		"owner_client_id": ownerClientID,
	}
	if err := liveChatDoPost(ctx, client, baseURL, creds, b.UserAgent, "/v3.3/configuration/action/unregister_webhook", body, nil); err != nil {
		var restErr LiveChatRESTError
		if errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound {
			return LiveChatWebhookCleanupResult{ProviderWebhookID: providerWebhookID, Status: "already_absent", ProviderStatusCode: http.StatusNotFound}, nil
		}
		return LiveChatWebhookCleanupResult{}, err
	}
	return LiveChatWebhookCleanupResult{ProviderWebhookID: providerWebhookID, Status: "deleted", ProviderStatusCode: http.StatusOK}, nil
}

func mapLiveChatChat(chat liveChatChat) (TicketInput, bool) {
	email, name := "", ""
	for _, u := range chat.Users {
		if strings.EqualFold(strings.TrimSpace(u.Type), "customer") {
			if v := strings.ToLower(strings.TrimSpace(u.Email)); v != "" {
				email = v
				name = strings.TrimSpace(u.Name)
				break
			}
		}
	}
	if email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(chat.ID)
	return TicketInput{
		SourceID:       "livechat://chat/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  name,
		Status:         "archived",
		Properties:     map[string]any{"livechat_chat_id": id, "livechat_thread_id": strings.TrimSpace(chat.Thread.ID)},
	}, true
}

func liveChatDoPost(ctx context.Context, client *http.Client, baseURL string, creds LiveChatCredentials, userAgent, path string, body any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, liveChatDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, liveChatResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return LiveChatRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(raw), 500)}
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode livechat response %s: %w", path, err)
	}
	return nil
}

type LiveChatRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e LiveChatRESTError) Error() string {
	if e.Path == "" {
		if e.RetryAfter > 0 {
			return fmt.Sprintf("livechat REST failed %d; retry after %s: %s", e.StatusCode, e.RetryAfter, e.Snippet)
		}
		return fmt.Sprintf("livechat REST failed %d: %s", e.StatusCode, e.Snippet)
	}
	if e.RetryAfter > 0 {
		return fmt.Sprintf("livechat REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("livechat REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func liveChatPageSize(raw string) int {
	n := 0
	for _, c := range strings.TrimSpace(raw) {
		if c < '0' || c > '9' {
			n = 0
			break
		}
		n = n*10 + int(c-'0')
	}
	if n <= 0 {
		return liveChatDefaultPageSize
	}
	if n > liveChatMaxPageSize {
		return liveChatMaxPageSize
	}
	return n
}

func liveChatGroupIDs(settings map[string]any) []int {
	raw := strings.TrimSpace(firstString(settingString(settings, "group_id"), settingString(settings, "group_ids")))
	if raw == "" {
		return nil
	}
	ids := []int{}
	seen := map[int]bool{}
	for _, part := range strings.Split(raw, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || n <= 0 || seen[n] {
			continue
		}
		ids = append(ids, n)
		seen[n] = true
	}
	return ids
}
