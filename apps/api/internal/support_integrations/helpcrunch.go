// SPDX-License-Identifier: AGPL-3.0-only
//
// helpcrunch.go — native HelpCrunch provider runtime.
//
// HelpCrunch REST v1 exposes chats and per-chat messages with offset/limit
// pagination. Webhook payloads are ID-oriented and the public docs do not
// document request signatures, so provider-specific callbacks use an operator
// route token and sparse chat hydration.
package support_integrations

import (
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

const (
	helpCrunchDefaultAPIBaseURL    = "https://api.helpcrunch.com/v1"
	helpCrunchDefaultUserAgent     = "Moosewave HelpCrunch Integration"
	helpCrunchResponseMaxBytes     = 16 << 20
	helpCrunchCursorPrefix         = "helpcrunch:"
	helpCrunchCursorComplete       = "helpcrunch:complete"
	helpCrunchDefaultLimit         = 100
	helpCrunchMaxLimit             = 100
	helpCrunchMaxMessagePageLoops  = 100
	helpCrunchDefaultChatSort      = "chats.createdAt"
	helpCrunchDefaultSortDirection = "asc"
)

type HelpCrunchCredentials struct {
	APIKey     string
	APIBaseURL string
	UserAgent  string
}

type HelpCrunchCredentialResolver interface {
	ResolveHelpCrunch(ctx context.Context, tenantID string, integration Integration) (HelpCrunchCredentials, error)
}

type helpCrunchCredentialPayload struct {
	APIKey      string `json:"api_key"`
	Token       string `json:"token"`
	AccessToken string `json:"access_token"`
	BearerToken string `json:"bearer_token"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p helpCrunchCredentialPayload) credentials() (HelpCrunchCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token, p.AccessToken, p.BearerToken))
	if key == "" {
		return HelpCrunchCredentials{}, fmt.Errorf("helpcrunch api_key is required")
	}
	return HelpCrunchCredentials{
		APIKey:     strings.TrimPrefix(key, "Bearer "),
		APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:  strings.TrimSpace(p.UserAgent),
	}, nil
}

type HelpCrunchSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r HelpCrunchSecretsCredentialResolver) ResolveHelpCrunch(ctx context.Context, _ string, integration Integration) (HelpCrunchCredentials, error) {
	if r.Secrets == nil {
		return HelpCrunchCredentials{}, fmt.Errorf("helpcrunch credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return HelpCrunchCredentials{}, fmt.Errorf("helpcrunch credentials_ref is required")
	}
	var payload helpCrunchCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withHelpCrunchSettings(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return HelpCrunchCredentials{}, fmt.Errorf("resolve helpcrunch credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withHelpCrunchSettings(creds, integration), nil
			}
		}
	}
	creds, err := (helpCrunchCredentialPayload{APIKey: raw}).credentials()
	if err != nil {
		return HelpCrunchCredentials{}, err
	}
	return withHelpCrunchSettings(creds, integration), nil
}

func withHelpCrunchSettings(creds HelpCrunchCredentials, integration Integration) HelpCrunchCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type HelpCrunchBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type HelpCrunchChatRefresher interface {
	RefreshChat(ctx context.Context, tenantID string, integration Integration, chatID string) (SyncRequest, error)
}

type HelpCrunchRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials HelpCrunchCredentialResolver
	APIBaseURL  string
	UserAgent   string
	Limit       int
}

type helpCrunchChatsResponse struct {
	Data  []helpCrunchChat `json:"data"`
	Total int              `json:"total"`
	Meta  struct {
		Total int `json:"total"`
	} `json:"meta"`
}

type helpCrunchMessagesResponse struct {
	Data  []helpCrunchMessage `json:"data"`
	Total int                 `json:"total"`
	Meta  struct {
		Total int `json:"total"`
	} `json:"meta"`
}

type helpCrunchChat struct {
	ID                    int                 `json:"id"`
	Status                string              `json:"status"`
	ClosedBy              string              `json:"closedBy"`
	Rating                string              `json:"rating"`
	CreatedAt             string              `json:"createdAt"`
	ClosedAt              string              `json:"closedAt"`
	LastMessageAt         string              `json:"lastMessageAt"`
	LastCustomerMessageAt string              `json:"lastCustomerMessageAt"`
	LastMessageText       string              `json:"lastMessageText"`
	ApplicationID         int                 `json:"applicationId"`
	Customer              helpCrunchCustomer  `json:"customer"`
	Assignee              helpCrunchAgent     `json:"assignee"`
	Department            helpCrunchNamedID   `json:"department"`
	Agents                []helpCrunchAgent   `json:"agents"`
	Tags                  []string            `json:"tags"`
	Raw                   map[string]any      `json:"-"`
	Properties            map[string]any      `json:"properties,omitempty"`
	CustomData            map[string]any      `json:"customData,omitempty"`
	Source                string              `json:"source,omitempty"`
	Applications          []int               `json:"applications,omitempty"`
	CommunicatedAgents    []int               `json:"communicatedAgents,omitempty"`
	Extra                 map[string]any      `json:"-"`
	Unstructured          []map[string]string `json:"-"`
}

type helpCrunchMessage struct {
	ID            int                `json:"id"`
	Agent         helpCrunchAgent    `json:"agent"`
	Customer      helpCrunchCustomer `json:"customer"`
	Type          string             `json:"type"`
	Text          string             `json:"text"`
	Read          bool               `json:"read"`
	CreatedAt     string             `json:"createdAt"`
	UpdatedAt     string             `json:"updatedAt"`
	Edited        bool               `json:"edited"`
	BroadcastType string             `json:"broadcastType"`
	Chat          int                `json:"chat"`
	From          string             `json:"from"`
}

type helpCrunchCustomer struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Email  string `json:"email"`
	UserID string `json:"userId"`
}

type helpCrunchAgent struct {
	ID    int    `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
	Role  string `json:"role"`
}

type helpCrunchNamedID struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

func (b HelpCrunchRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderHelpCrunch {
		return SyncRequest{}, fmt.Errorf("helpcrunch backfill requires a HelpCrunch integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("helpcrunch credential resolver is not configured")
	}
	offset, done := helpCrunchOffsetCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: helpCrunchCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveHelpCrunch(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), helpCrunchDefaultAPIBaseURL)
	limit := helpCrunchLimit(firstString(settingString(integration.Settings, "limit"), settingString(integration.Settings, "page_size"), strconv.Itoa(b.Limit)))
	query := url.Values{}
	query.Set("offset", strconv.Itoa(offset))
	query.Set("limit", strconv.Itoa(limit))
	query.Set("sort", firstString(settingString(integration.Settings, "sort"), helpCrunchDefaultChatSort))
	query.Set("order", firstString(settingString(integration.Settings, "order"), helpCrunchDefaultSortDirection))
	var out helpCrunchChatsResponse
	if err := helpCrunchDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/chats", query, &out); err != nil {
		return SyncRequest{}, err
	}
	tickets := []TicketInput{}
	messages := []MessageInput{}
	for _, chat := range out.Data {
		if !helpCrunchChatAllowed(integration, chat) {
			continue
		}
		ticket, ok := mapHelpCrunchChat(chat)
		if !ok {
			continue
		}
		tickets = append(tickets, ticket)
		thread, err := b.fetchHelpCrunchMessages(ctx, client, baseURL, creds, integration, ticket.ConversationID, ticket)
		if err != nil {
			return SyncRequest{}, err
		}
		messages = append(messages, thread...)
	}
	total := firstPositive(out.Total, out.Meta.Total)
	next := offset + limit
	cursorOut := helpCrunchCursorComplete
	if total == 0 {
		if len(out.Data) >= limit {
			cursorOut = helpCrunchCursorPrefix + strconv.Itoa(next)
		}
	} else if next < total {
		cursorOut = helpCrunchCursorPrefix + strconv.Itoa(next)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: cursorOut}), nil
}

func (b HelpCrunchRESTBackfiller) RefreshChat(ctx context.Context, tenantID string, integration Integration, chatID string) (SyncRequest, error) {
	if integration.Provider != ProviderHelpCrunch {
		return SyncRequest{}, fmt.Errorf("helpcrunch refresh requires a HelpCrunch integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("helpcrunch credential resolver is not configured")
	}
	chatID = strings.TrimSpace(chatID)
	if chatID == "" {
		return SyncRequest{}, nil
	}
	creds, err := b.Credentials.ResolveHelpCrunch(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), helpCrunchDefaultAPIBaseURL)
	var chat helpCrunchChat
	if err := helpCrunchDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/chats/"+url.PathEscape(chatID), nil, &chat); err != nil {
		return SyncRequest{}, err
	}
	ticket, ok := mapHelpCrunchChat(chat)
	if !ok {
		return SyncRequest{RunMode: "webhook", Cursor: "helpcrunch-chat-" + chatID}, nil
	}
	messages, err := b.fetchHelpCrunchMessages(ctx, client, baseURL, creds, integration, ticket.ConversationID, ticket)
	if err != nil {
		return SyncRequest{}, err
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: "helpcrunch-chat-" + chatID}), nil
}

func (b HelpCrunchRESTBackfiller) fetchHelpCrunchMessages(ctx context.Context, client *http.Client, baseURL string, creds HelpCrunchCredentials, integration Integration, chatID string, ticket TicketInput) ([]MessageInput, error) {
	limit := helpCrunchLimit(firstString(settingString(integration.Settings, "message_limit"), settingString(integration.Settings, "message_page_size"), strconv.Itoa(helpCrunchDefaultLimit)))
	out := []MessageInput{}
	for offset, loops := 0, 0; loops < helpCrunchMaxMessagePageLoops; loops++ {
		query := url.Values{}
		query.Set("offset", strconv.Itoa(offset))
		query.Set("limit", strconv.Itoa(limit))
		var resp helpCrunchMessagesResponse
		if err := helpCrunchDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/chats/"+url.PathEscape(chatID)+"/messages", query, &resp); err != nil {
			return nil, err
		}
		out = append(out, mapHelpCrunchMessages(resp.Data, ticket)...)
		total := firstPositive(resp.Total, resp.Meta.Total)
		offset += limit
		if total > 0 {
			if offset >= total {
				return out, nil
			}
		} else if len(resp.Data) < limit {
			return out, nil
		}
	}
	return out, nil
}

func (b HelpCrunchRESTBackfiller) client() *http.Client {
	return supportEgressClient(b.HTTPClient, ProviderHelpCrunch, 30*time.Second)
}

func mapHelpCrunchChat(chat helpCrunchChat) (TicketInput, bool) {
	id := helpCrunchID(chat.ID)
	email := strings.ToLower(strings.TrimSpace(chat.Customer.Email))
	if id == "" || email == "" {
		return TicketInput{}, false
	}
	out := TicketInput{
		SourceID:       "helpcrunch://chat/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  chat.Customer.Name,
		Subject:        firstString(chat.LastMessageText, "HelpCrunch chat "+id),
		Status:         firstString(chat.Status, "open"),
		Assignee:       firstString(chat.Assignee.Email, chat.Assignee.Name),
		Tags:           chat.Tags,
		Properties: map[string]any{
			"helpcrunch_chat_id":          id,
			"helpcrunch_customer_id":      helpCrunchID(chat.Customer.ID),
			"helpcrunch_customer_user_id": chat.Customer.UserID,
			"helpcrunch_application_id":   helpCrunchID(chat.ApplicationID),
			"helpcrunch_department_id":    helpCrunchID(chat.Department.ID),
			"helpcrunch_rating":           chat.Rating,
			"helpcrunch_closed_by":        chat.ClosedBy,
		},
		UpdatedAt: firstTime(helpCrunchTime(chat.LastMessageAt), helpCrunchTime(chat.LastCustomerMessageAt), helpCrunchTime(chat.CreatedAt)),
	}
	return out, true
}

func mapHelpCrunchMessages(messages []helpCrunchMessage, ticket TicketInput) []MessageInput {
	out := []MessageInput{}
	for _, msg := range messages {
		if mapped, ok := mapHelpCrunchMessage(msg, ticket); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapHelpCrunchMessage(msg helpCrunchMessage, ticket TicketInput) (MessageInput, bool) {
	id := helpCrunchID(msg.ID)
	if id == "" || msg.Text == "" {
		return MessageInput{}, false
	}
	direction, senderType := helpCrunchMessageDirection(msg)
	return MessageInput{
		SourceID:       "helpcrunch://chat/" + ticket.ConversationID + "/message/" + id,
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender:         firstString(msg.Agent.Email, msg.Agent.Name, msg.Customer.Email, msg.Customer.Name),
		BodyText:       msg.Text,
		Properties: map[string]any{
			"helpcrunch_message_id":     id,
			"helpcrunch_message_type":   msg.Type,
			"helpcrunch_broadcast_type": msg.BroadcastType,
			"helpcrunch_read":           msg.Read,
			"helpcrunch_edited":         msg.Edited,
		},
		OccurredAt: firstTime(helpCrunchTime(msg.CreatedAt), helpCrunchTime(msg.UpdatedAt)),
	}, true
}

func helpCrunchMessageDirection(msg helpCrunchMessage) (string, string) {
	switch strings.ToLower(strings.TrimSpace(msg.From)) {
	case "customer", "user", "client":
		return "inbound", "customer"
	case "agent", "admin", "team":
		return "outbound", "agent"
	default:
		if msg.Agent.ID > 0 || msg.Agent.Email != "" {
			return "outbound", "agent"
		}
		return "inbound", "customer"
	}
}

func helpCrunchDoJSON(ctx context.Context, client *http.Client, baseURL string, creds HelpCrunchCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := helpCrunchBuildURL(baseURL, path, query)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.APIKey))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, helpCrunchDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, helpCrunchResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return HelpCrunchRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out != nil && len(body) > 0 {
		if err := json.Unmarshal(body, out); err != nil {
			return fmt.Errorf("decode helpcrunch response %s: %w", path, err)
		}
	}
	return nil
}

type HelpCrunchRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e HelpCrunchRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("helpcrunch REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("helpcrunch REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func helpCrunchBuildURL(baseURL, path string, query url.Values) (*url.URL, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/"))
	if err != nil {
		return nil, fmt.Errorf("parse helpcrunch API base URL: %w", err)
	}
	rel, err := url.Parse(path)
	if err != nil {
		return nil, fmt.Errorf("parse helpcrunch request path: %w", err)
	}
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		base = rel
	} else if strings.HasPrefix(rel.Path, "/v1/") {
		base.Path = rel.Path
	} else {
		base.Path = strings.TrimRight(base.Path, "/") + "/" + strings.TrimLeft(rel.Path, "/")
	}
	if query != nil {
		base.RawQuery = query.Encode()
	} else if rel.RawQuery != "" {
		base.RawQuery = rel.RawQuery
	}
	return base, nil
}

func helpCrunchOffsetCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == helpCrunchCursorComplete {
		return 0, true
	}
	cursor = strings.TrimPrefix(cursor, helpCrunchCursorPrefix)
	if cursor == "" {
		return 0, false
	}
	offset, err := strconv.Atoi(cursor)
	if err != nil || offset < 0 {
		return 0, false
	}
	return offset, false
}

func decodeHelpCrunchCursor(cursor string) string {
	if _, done := helpCrunchOffsetCursor(cursor); done {
		return helpCrunchCursorComplete
	}
	return strings.TrimPrefix(strings.TrimSpace(cursor), helpCrunchCursorPrefix)
}

func helpCrunchLimit(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return helpCrunchDefaultLimit
	}
	if n > helpCrunchMaxLimit {
		return helpCrunchMaxLimit
	}
	return n
}

func helpCrunchChatAllowed(integration Integration, chat helpCrunchChat) bool {
	if app := strings.TrimSpace(firstString(settingString(integration.Settings, "application_id"), settingString(integration.Settings, "widget_id"))); app != "" {
		if app != helpCrunchID(chat.ApplicationID) {
			return false
		}
	}
	if status := strings.TrimSpace(settingString(integration.Settings, "status")); status != "" {
		if !strings.EqualFold(status, chat.Status) {
			return false
		}
	}
	return true
}

func helpCrunchID(id int) string {
	if id <= 0 {
		return ""
	}
	return strconv.Itoa(id)
}

func helpCrunchTime(value string) *time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if parsed, err := strconv.ParseFloat(value, 64); err == nil && parsed > 0 {
		sec := int64(parsed)
		nsec := int64((parsed - float64(sec)) * 1_000_000_000)
		at := time.Unix(sec, nsec).UTC()
		return &at
	}
	return parseZendeskTime(value)
}

func firstPositive(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}
