// SPDX-License-Identifier: AGPL-3.0-only
//
// ada.go — native Ada provider runtime.
//
// Ada exposes tenant-scoped APIs under https://{ai_agent_domain}/api. Bulk
// support import uses the Data Export conversations endpoint with
// created_since/created_to windows; per-conversation message hydration uses the
// Data Export messages endpoint constrained by conversation_id.
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
	adaDefaultUserAgent  = "Moosewave Ada Integration"
	adaResponseMaxBytes  = 16 << 20
	adaCursorPrefix      = "ada:"
	adaCursorComplete    = "ada:complete"
	adaDefaultPageSize   = 100
	adaMaxPageSize       = 10000
	adaMaxMessagePages   = 20
	adaDefaultWindowDays = 60
)

type AdaCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type AdaCredentialResolver interface {
	ResolveAda(ctx context.Context, tenantID string, integration Integration) (AdaCredentials, error)
}

type adaCredentialPayload struct {
	AccessToken string `json:"access_token"`
	BearerToken string `json:"bearer_token"`
	Token       string `json:"token"`
	APIKey      string `json:"api_key"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p adaCredentialPayload) credentials() (AdaCredentials, error) {
	token := strings.TrimSpace(firstString(p.AccessToken, p.BearerToken, p.Token, p.APIKey))
	if token == "" {
		return AdaCredentials{}, fmt.Errorf("ada access_token is required")
	}
	return AdaCredentials{
		AccessToken: token,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

type AdaSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r AdaSecretsCredentialResolver) ResolveAda(ctx context.Context, _ string, integration Integration) (AdaCredentials, error) {
	if r.Secrets == nil {
		return AdaCredentials{}, fmt.Errorf("ada credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return AdaCredentials{}, fmt.Errorf("ada credentials_ref is required")
	}
	var payload adaCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withAdaSettings(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return AdaCredentials{}, fmt.Errorf("resolve ada credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withAdaSettings(creds, integration), nil
			}
		}
	}
	creds, err := adaCredentialPayload{AccessToken: strings.TrimPrefix(raw, "Bearer ")}.credentials()
	if err != nil {
		return AdaCredentials{}, err
	}
	return withAdaSettings(creds, integration), nil
}

func withAdaSettings(creds AdaCredentials, integration Integration) AdaCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	if creds.APIBaseURL == "" {
		if domain := adaIntegrationAgentDomain(integration); domain != "" {
			creds.APIBaseURL = "https://" + domain + "/api"
		}
	}
	return creds
}

type AdaBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type AdaConversationRefresher interface {
	RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error)
}

type AdaRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials AdaCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
	Now         func() time.Time
}

type adaCursorState struct {
	Stage        string `json:"stage,omitempty"`
	NextPageURI  string `json:"next_page_uri,omitempty"`
	CreatedSince string `json:"created_since,omitempty"`
	CreatedTo    string `json:"created_to,omitempty"`
}

type adaListResponse struct {
	Items   []map[string]any `json:"items"`
	Data    []map[string]any `json:"data"`
	Results []map[string]any `json:"results"`
	Records []map[string]any `json:"records"`
	Meta    struct {
		NextPageURI string `json:"next_page_uri"`
		NextPageURL string `json:"next_page_url"`
		Cursor      string `json:"cursor"`
	} `json:"meta"`
	NextPageURI string `json:"next_page_uri"`
	NextPageURL string `json:"next_page_url"`
}

func (b AdaRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderAda {
		return SyncRequest{}, fmt.Errorf("ada backfill requires an Ada integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("ada credential resolver is not configured")
	}
	state, done, err := adaBackfillCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: adaCursorComplete}, nil
	}
	if strings.TrimSpace(state.Stage) == "" {
		state.Stage = "conversations"
	}
	if state.Stage != "conversations" {
		return SyncRequest{}, fmt.Errorf("ada cursor has unknown stage %q", state.Stage)
	}
	if state.CreatedSince == "" || state.CreatedTo == "" {
		state.CreatedSince, state.CreatedTo = adaBackfillWindow(integration, b.now())
	}
	creds, err := b.Credentials.ResolveAda(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"))
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("ada api_base_url or ai_agent_domain is required")
	}

	var out adaListResponse
	if strings.TrimSpace(state.NextPageURI) != "" {
		if err := adaDoJSON(ctx, client, baseURL, creds, b.UserAgent, state.NextPageURI, nil, &out); err != nil {
			return SyncRequest{}, err
		}
	} else {
		query := url.Values{}
		query.Set("created_since", state.CreatedSince)
		query.Set("created_to", state.CreatedTo)
		query.Set("page_size", strconv.Itoa(adaPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
		if err := adaDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/v2/export/conversations", query, &out); err != nil {
			return SyncRequest{}, err
		}
	}

	endUsers := map[string]map[string]any{}
	tickets := []TicketInput{}
	messages := []MessageInput{}
	for _, conv := range adaListItems(out) {
		if !adaConversationAllowed(integration, conv) {
			continue
		}
		endUser := map[string]any(nil)
		if adaConversationEmail(conv, nil) == "" {
			endUserID := adaEndUserID(conv)
			if endUserID != "" {
				var ok bool
				endUser, ok = endUsers[endUserID]
				if !ok {
					fetched, err := b.fetchAdaEndUser(ctx, client, baseURL, creds, endUserID)
					if err != nil {
						var restErr AdaRESTError
						if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusNotFound {
							return SyncRequest{}, err
						}
					}
					endUser = fetched
					endUsers[endUserID] = endUser
				}
			}
		}
		ticket, ok := mapAdaConversation(conv, endUser)
		if !ok {
			continue
		}
		tickets = append(tickets, ticket)
		thread, err := b.fetchAdaExportMessagesForConversation(ctx, client, baseURL, creds, integration, ticket.ConversationID, state.CreatedSince, state.CreatedTo)
		if err != nil {
			var restErr AdaRESTError
			if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusNotFound {
				return SyncRequest{}, err
			}
		}
		messages = append(messages, mapAdaMessages(thread, ticket)...)
	}
	next := adaNextPage(out)
	nextCursor := adaCursorComplete
	if next != "" {
		state.NextPageURI = next
		nextCursor = adaEncodeCursor(state)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: nextCursor}), nil
}

func (b AdaRESTBackfiller) RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error) {
	if integration.Provider != ProviderAda {
		return SyncRequest{}, fmt.Errorf("ada refresh requires an Ada integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("ada credential resolver is not configured")
	}
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return SyncRequest{}, nil
	}
	creds, err := b.Credentials.ResolveAda(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"))
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("ada api_base_url or ai_agent_domain is required")
	}
	var raw map[string]any
	if err := adaDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/v2/conversations/"+url.PathEscape(conversationID)+"/", nil, &raw); err != nil {
		return SyncRequest{}, err
	}
	conv := adaFirstObject(raw, "conversation", "data", "item")
	if conv == nil {
		conv = raw
	}
	if adaConversationID(conv) == "" {
		conv["conversation_id"] = conversationID
	}
	endUser := map[string]any(nil)
	if adaConversationEmail(conv, nil) == "" {
		if endUserID := adaEndUserID(conv); endUserID != "" {
			fetched, err := b.fetchAdaEndUser(ctx, client, baseURL, creds, endUserID)
			if err != nil {
				var restErr AdaRESTError
				if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusNotFound {
					return SyncRequest{}, err
				}
			}
			endUser = fetched
		}
	}
	ticket, ok := mapAdaConversation(conv, endUser)
	if !ok {
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Cursor: "ada-webhook-" + conversationID}), nil
	}
	thread, err := b.fetchAdaConversationMessages(ctx, client, baseURL, creds, conversationID)
	if err != nil {
		var restErr AdaRESTError
		if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusNotFound {
			return SyncRequest{}, err
		}
	}
	return normalizeSyncRequest(SyncRequest{
		RunMode:  "webhook",
		Tickets:  []TicketInput{ticket},
		Messages: mapAdaMessages(thread, ticket),
		Cursor:   "ada-webhook-" + conversationID,
	}), nil
}

func (b AdaRESTBackfiller) client() *http.Client {
	return supportEgressClient(b.HTTPClient, ProviderAda, 30*time.Second)
}

func (b AdaRESTBackfiller) now() time.Time {
	if b.Now != nil {
		return b.Now().UTC()
	}
	return time.Now().UTC()
}

func (b AdaRESTBackfiller) fetchAdaEndUser(ctx context.Context, client *http.Client, baseURL string, creds AdaCredentials, endUserID string) (map[string]any, error) {
	endUserID = strings.TrimSpace(endUserID)
	if endUserID == "" {
		return nil, nil
	}
	var raw map[string]any
	if err := adaDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/v2/end-users/"+url.PathEscape(endUserID), nil, &raw); err != nil {
		return nil, err
	}
	if out := adaFirstObject(raw, "end_user", "user", "data", "item"); out != nil {
		return out, nil
	}
	return raw, nil
}

func (b AdaRESTBackfiller) fetchAdaExportMessagesForConversation(ctx context.Context, client *http.Client, baseURL string, creds AdaCredentials, integration Integration, conversationID, createdSince, createdTo string) ([]map[string]any, error) {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return nil, nil
	}
	out := []map[string]any{}
	next := ""
	for page := 0; page < adaMaxMessagePages; page++ {
		var resp adaListResponse
		if next != "" {
			if err := adaDoJSON(ctx, client, baseURL, creds, b.UserAgent, next, nil, &resp); err != nil {
				return nil, err
			}
		} else {
			query := url.Values{}
			query.Set("conversation_id", conversationID)
			query.Set("created_since", createdSince)
			query.Set("created_to", createdTo)
			query.Set("page_size", strconv.Itoa(adaPageSize(firstString(settingString(integration.Settings, "message_page_size"), settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
			if err := adaDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/v2/export/messages", query, &resp); err != nil {
				return nil, err
			}
		}
		out = append(out, adaListItems(resp)...)
		next = adaNextPage(resp)
		if next == "" {
			break
		}
	}
	return out, nil
}

func (b AdaRESTBackfiller) fetchAdaConversationMessages(ctx context.Context, client *http.Client, baseURL string, creds AdaCredentials, conversationID string) ([]map[string]any, error) {
	out := []map[string]any{}
	next := ""
	for page := 0; page < adaMaxMessagePages; page++ {
		var resp adaListResponse
		if next != "" {
			if err := adaDoJSON(ctx, client, baseURL, creds, b.UserAgent, next, nil, &resp); err != nil {
				return nil, err
			}
		} else {
			path := "/v2/conversations/" + url.PathEscape(strings.TrimSpace(conversationID)) + "/messages/"
			if err := adaDoJSON(ctx, client, baseURL, creds, b.UserAgent, path, nil, &resp); err != nil {
				return nil, err
			}
		}
		out = append(out, adaListItems(resp)...)
		next = adaNextPage(resp)
		if next == "" {
			break
		}
	}
	return out, nil
}

func mapAdaConversation(conv, endUser map[string]any) (TicketInput, bool) {
	id := adaConversationID(conv)
	if id == "" {
		return TicketInput{}, false
	}
	email := strings.ToLower(strings.TrimSpace(adaConversationEmail(conv, endUser)))
	if email == "" {
		return TicketInput{}, false
	}
	status := adaConversationStatus(conv)
	name := adaConversationRequesterName(conv, endUser)
	out := TicketInput{
		SourceID:       "ada://conversation/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  name,
		Subject:        firstString(adaString(conv, "subject"), adaString(conv, "title"), "Ada conversation"),
		Status:         status,
		Assignee:       firstString(adaString(conv, "assignee", "name"), adaString(conv, "human_agent", "name"), adaString(conv, "handoff_agent", "name")),
		Properties: map[string]any{
			"ada_conversation_id":     id,
			"ada_end_user_id":         adaEndUserID(conv),
			"ada_ai_agent_domain":     normalizeAdaAgentDomain(firstString(adaString(conv, "ai_agent_domain"), adaString(conv, "data", "ai_agent_domain"))),
			"ada_channel":             firstString(adaString(conv, "channel"), adaString(conv, "data", "channel")),
			"ada_handoff_integration": firstString(adaString(conv, "handoff_integration"), adaString(conv, "data", "handoff_integration")),
			"ada_created_at":          firstString(adaString(conv, "created_at"), adaString(conv, "created")),
			"ada_updated_at":          firstString(adaString(conv, "updated_at"), adaString(conv, "updated")),
		},
	}
	if t := parseZendeskTime(firstString(adaString(conv, "updated_at"), adaString(conv, "ended_at"), adaString(conv, "created_at"))); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func mapAdaMessages(messages []map[string]any, ticket TicketInput) []MessageInput {
	if len(messages) == 0 {
		return nil
	}
	out := make([]MessageInput, 0, len(messages))
	for idx, msg := range messages {
		if mapped, ok := mapAdaMessage(msg, ticket, idx); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapAdaMessage(msg map[string]any, ticket TicketInput, idx int) (MessageInput, bool) {
	conversationID := firstString(adaString(msg, "conversation_id"), adaString(msg, "conversation", "id"), ticket.ConversationID)
	if conversationID == "" {
		return MessageInput{}, false
	}
	body := adaMessageBody(msg)
	if body == "" {
		return MessageInput{}, false
	}
	messageID := firstString(adaString(msg, "message_id"), adaString(msg, "id"), fmt.Sprintf("%d", idx+1))
	direction, senderType := adaMessageDirection(firstString(adaString(msg, "author", "role"), adaString(msg, "sender", "role"), adaString(msg, "role"), adaString(msg, "author_type")))
	out := MessageInput{
		SourceID:       "ada://conversation/" + conversationID + "/message/" + messageID,
		ConversationID: conversationID,
		Email:          firstString(ticket.Email, strings.ToLower(adaConversationEmail(msg, nil))),
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender:         firstString(adaString(msg, "author", "name"), adaString(msg, "author", "display_name"), adaString(msg, "sender", "name"), adaString(msg, "sender", "id"), adaString(msg, "author", "id")),
		BodyText:       body,
		Properties: map[string]any{
			"ada_conversation_id": conversationID,
			"ada_message_id":      messageID,
			"ada_author_role":     firstString(adaString(msg, "author", "role"), adaString(msg, "role"), adaString(msg, "author_type")),
		},
	}
	if t := parseZendeskTime(firstString(adaString(msg, "created_at"), adaString(msg, "timestamp"), adaString(msg, "sent_at"))); t != nil {
		out.OccurredAt = t
	}
	return out, out.Email != ""
}

func adaConversationID(raw map[string]any) string {
	return strings.TrimSpace(firstString(
		adaString(raw, "conversation_id"),
		adaString(raw, "conversation", "id"),
		adaString(raw, "id"),
		adaString(raw, "data", "conversation_id"),
	))
}

func adaEndUserID(raw map[string]any) string {
	return strings.TrimSpace(firstString(
		adaString(raw, "end_user_id"),
		adaString(raw, "end_user", "id"),
		adaString(raw, "user", "id"),
		adaString(raw, "customer", "id"),
		adaString(raw, "data", "end_user_id"),
	))
}

func adaConversationEmail(raw, endUser map[string]any) string {
	return firstString(
		adaString(raw, "email"),
		adaString(raw, "end_user_email"),
		adaString(raw, "customer_email"),
		adaString(raw, "user", "email"),
		adaString(raw, "end_user", "email"),
		adaString(raw, "customer", "email"),
		adaString(raw, "profile", "email"),
		adaString(raw, "metavariables", "email"),
		adaString(raw, "data", "email"),
		adaString(raw, "data", "end_user", "email"),
		adaString(endUser, "email"),
		adaString(endUser, "profile", "email"),
		adaString(endUser, "metavariables", "email"),
	)
}

func adaConversationRequesterName(raw, endUser map[string]any) string {
	name := firstString(
		adaString(raw, "name"),
		adaString(raw, "end_user_name"),
		adaString(raw, "customer_name"),
		adaString(raw, "user", "name"),
		adaString(raw, "end_user", "name"),
		adaString(raw, "customer", "name"),
		adaString(endUser, "name"),
		adaString(endUser, "full_name"),
	)
	if name != "" {
		return name
	}
	return strings.TrimSpace(strings.Join(cleanStrings([]string{
		firstString(adaString(raw, "first_name"), adaString(raw, "end_user", "first_name"), adaString(endUser, "first_name")),
		firstString(adaString(raw, "last_name"), adaString(raw, "end_user", "last_name"), adaString(endUser, "last_name")),
	}), " "))
}

func adaConversationStatus(raw map[string]any) string {
	if status := firstString(adaString(raw, "status"), adaString(raw, "state")); status != "" {
		return status
	}
	if firstString(adaString(raw, "ended_at"), adaString(raw, "closed_at")) != "" {
		return "closed"
	}
	return "open"
}

func adaMessageBody(raw map[string]any) string {
	if content := adaString(raw, "content"); content != "" {
		return content
	}
	if content := adaValue(raw, "content"); content != nil {
		if s := firstString(adaStringFromAny(content, "text"), adaStringFromAny(content, "body"), adaStringFromAny(content, "value"), adaStringFromAny(content, "message")); s != "" {
			return s
		}
	}
	return firstString(adaString(raw, "text"), adaString(raw, "body"), adaString(raw, "message"), adaString(raw, "data", "content"))
}

func adaMessageDirection(role string) (string, string) {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "end_user", "user", "customer", "visitor":
		return "inbound", "customer"
	case "human_agent", "agent", "admin":
		return "outbound", "agent"
	case "ai_agent", "bot", "automation", "system":
		return "outbound", "ai"
	default:
		return "inbound", "customer"
	}
}

func adaConversationAllowed(integration Integration, conv map[string]any) bool {
	if channel := strings.TrimSpace(settingString(integration.Settings, "channel")); channel != "" {
		if !strings.EqualFold(channel, firstString(adaString(conv, "channel"), adaString(conv, "data", "channel"))) {
			return false
		}
	}
	if handoff := strings.TrimSpace(settingString(integration.Settings, "handoff_integration")); handoff != "" {
		if !strings.EqualFold(handoff, firstString(adaString(conv, "handoff_integration"), adaString(conv, "data", "handoff_integration"))) {
			return false
		}
	}
	return true
}

type AdaRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e AdaRESTError) Error() string {
	return fmt.Sprintf("ada REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func adaDoJSON(ctx context.Context, client *http.Client, baseURL string, creds AdaCredentials, userAgent, pathOrURL string, query url.Values, out any) error {
	u, err := adaBuildURL(baseURL, pathOrURL, query)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, adaDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, adaResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return AdaRESTError{
			Path:       pathOrURL,
			StatusCode: resp.StatusCode,
			RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    zendeskTruncate(string(body), 500),
		}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode ada response %s: %w", pathOrURL, err)
	}
	return nil
}

func adaBuildURL(baseURL, pathOrURL string, query url.Values) (*url.URL, error) {
	pathOrURL = strings.TrimSpace(pathOrURL)
	if pathOrURL == "" {
		return nil, fmt.Errorf("ada request path is required")
	}
	if strings.HasPrefix(pathOrURL, "http://") || strings.HasPrefix(pathOrURL, "https://") {
		u, err := url.Parse(pathOrURL)
		if err != nil {
			return nil, fmt.Errorf("parse ada next page URL: %w", err)
		}
		if query != nil {
			u.RawQuery = query.Encode()
		}
		return u, nil
	}
	base, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("parse ada API base URL: %w", err)
	}
	rel, err := url.Parse(pathOrURL)
	if err != nil {
		return nil, fmt.Errorf("parse ada request path: %w", err)
	}
	path := rel.Path
	if strings.HasPrefix(path, "/api/") {
		base.Path = path
	} else if strings.HasPrefix(path, "/") {
		base.Path = strings.TrimRight(base.Path, "/") + path
	} else {
		base.Path = strings.TrimRight(base.Path, "/") + "/" + path
	}
	if query != nil {
		base.RawQuery = query.Encode()
	} else if rel.RawQuery != "" {
		base.RawQuery = rel.RawQuery
	}
	return base, nil
}

func adaListItems(resp adaListResponse) []map[string]any {
	switch {
	case len(resp.Items) > 0:
		return resp.Items
	case len(resp.Data) > 0:
		return resp.Data
	case len(resp.Results) > 0:
		return resp.Results
	default:
		return resp.Records
	}
}

func adaNextPage(resp adaListResponse) string {
	return strings.TrimSpace(firstString(resp.Meta.NextPageURI, resp.Meta.NextPageURL, resp.NextPageURI, resp.NextPageURL, resp.Meta.Cursor))
}

func adaBackfillWindow(integration Integration, now time.Time) (string, string) {
	since := strings.TrimSpace(firstString(settingString(integration.Settings, "created_since"), settingString(integration.Settings, "backfill_since")))
	to := strings.TrimSpace(firstString(settingString(integration.Settings, "created_to"), settingString(integration.Settings, "backfill_to")))
	if since == "" {
		since = now.AddDate(0, 0, -adaDefaultWindowDays).UTC().Format(time.RFC3339)
	}
	if to == "" {
		if parsed := parseZendeskTime(since); parsed != nil {
			limit := parsed.AddDate(0, 0, adaDefaultWindowDays)
			if limit.After(now) {
				limit = now
			}
			to = limit.UTC().Format(time.RFC3339)
		} else {
			to = now.UTC().Format(time.RFC3339)
		}
	}
	return since, to
}

func adaBackfillCursor(cursor string) (adaCursorState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || cursor == "ada" {
		return adaCursorState{Stage: "conversations"}, false, nil
	}
	if cursor == adaCursorComplete {
		return adaCursorState{}, true, nil
	}
	if !strings.HasPrefix(cursor, adaCursorPrefix) {
		return adaCursorState{Stage: "conversations", NextPageURI: cursor}, false, nil
	}
	encoded := strings.TrimPrefix(cursor, adaCursorPrefix)
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return adaCursorState{}, false, fmt.Errorf("decode ada cursor: %w", err)
	}
	var state adaCursorState
	if err := json.Unmarshal(decoded, &state); err != nil {
		return adaCursorState{}, false, fmt.Errorf("parse ada cursor: %w", err)
	}
	if state.Stage == "" {
		state.Stage = "conversations"
	}
	return state, false, nil
}

func adaEncodeCursor(state adaCursorState) string {
	if state.Stage == "" {
		state.Stage = "conversations"
	}
	body, _ := json.Marshal(state)
	return adaCursorPrefix + base64.RawURLEncoding.EncodeToString(body)
}

func decodeAdaCursor(cursor string) string {
	state, done, err := adaBackfillCursor(cursor)
	if err != nil {
		return strings.TrimSpace(cursor)
	}
	if done {
		return adaCursorComplete
	}
	parts := []string{state.Stage}
	if state.NextPageURI != "" {
		parts = append(parts, state.NextPageURI)
	}
	if state.CreatedSince != "" {
		parts = append(parts, state.CreatedSince)
	}
	if state.CreatedTo != "" {
		parts = append(parts, state.CreatedTo)
	}
	return strings.Join(parts, ":")
}

func adaPageSize(value string) int {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n <= 0 {
		n = adaDefaultPageSize
	}
	if n < adaDefaultPageSize {
		return adaDefaultPageSize
	}
	if n > adaMaxPageSize {
		return adaMaxPageSize
	}
	return n
}

func adaIntegrationAgentDomain(integration Integration) string {
	return normalizeAdaAgentDomain(firstString(
		settingString(integration.Settings, "ai_agent_domain"),
		settingString(integration.Settings, "ada_ai_agent_domain"),
		settingString(integration.Settings, "bot_id"),
		settingString(integration.Settings, "provider_ai_agent_domain"),
		settingString(integration.Settings, "provider_domain"),
	))
}

func normalizeAdaAgentDomain(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "https://")
	value = strings.TrimPrefix(value, "http://")
	value = strings.TrimRight(value, "/")
	value = strings.TrimSuffix(value, "/api")
	if idx := strings.Index(value, "/"); idx >= 0 {
		value = value[:idx]
	}
	return strings.TrimSpace(value)
}

func adaFirstObject(raw map[string]any, keys ...string) map[string]any {
	for _, key := range keys {
		if v := adaValue(raw, key); v != nil {
			if m, ok := v.(map[string]any); ok {
				return m
			}
		}
	}
	return nil
}

func adaString(raw map[string]any, path ...string) string {
	if raw == nil {
		return ""
	}
	cur := any(raw)
	for _, key := range path {
		cur = adaValue(cur, key)
		if cur == nil {
			return ""
		}
	}
	return adaStringValue(cur)
}

func adaStringFromAny(raw any, path ...string) string {
	cur := raw
	for _, key := range path {
		cur = adaValue(cur, key)
		if cur == nil {
			return ""
		}
	}
	return adaStringValue(cur)
}

func adaValue(raw any, key string) any {
	m, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	if v, ok := m[key]; ok {
		return v
	}
	for k, v := range m {
		if strings.EqualFold(k, key) {
			return v
		}
	}
	return nil
}

func adaStringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case float64:
		return strings.TrimSpace(strconv.FormatFloat(typed, 'f', -1, 64))
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case bool:
		return strconv.FormatBool(typed)
	default:
		return ""
	}
}
