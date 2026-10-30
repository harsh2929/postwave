// SPDX-License-Identifier: AGPL-3.0-only
//
// freshchat.go — native Freshchat provider runtime.
//
// Freshchat does not expose a broad ticket-shaped export in the same style as
// Zendesk or Freshdesk. The documented read path starts with paged users, then
// retrieves each user's conversations and the messages for each conversation.
// Webhooks are ID-oriented, so the webhook adapter reuses RefreshConversation to
// hydrate canonical support rows before writing them.
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
	freshchatDefaultUserAgent      = "Moosewave Freshchat Integration"
	freshchatResponseMaxBytes      = 16 << 20
	freshchatDefaultUserPageSize   = 100
	freshchatMaxUserPageSize       = 100
	freshchatMessagePageSize       = 50
	freshchatMessagePageMaxLoops   = 100
	freshchatCursorPrefix          = "freshchat:"
	freshchatCursorComplete        = "freshchat:complete"
	freshchatDefaultFreshchatHost  = ".freshchat.com"
	freshchatDefaultFreshworksHost = ".myfreshworks.com"
)

type FreshchatCredentials struct {
	Token      string
	Domain     string
	APIBaseURL string
	UserAgent  string
}

type FreshchatCredentialResolver interface {
	ResolveFreshchat(ctx context.Context, tenantID string, integration Integration) (FreshchatCredentials, error)
}

type freshchatCredentialPayload struct {
	Token        string `json:"token"`
	APIKey       string `json:"api_key"`
	AccessToken  string `json:"access_token"`
	BearerToken  string `json:"bearer_token"`
	Account      string `json:"account_domain"`
	Domain       string `json:"domain"`
	WorkspaceURL string `json:"workspace_url"`
	APIBaseURL   string `json:"api_base_url"`
	UserAgent    string `json:"user_agent"`
}

func (p freshchatCredentialPayload) credentials() (FreshchatCredentials, error) {
	creds := FreshchatCredentials{
		Token:      strings.TrimSpace(firstString(p.Token, p.APIKey, p.AccessToken, p.BearerToken)),
		Domain:     normalizeFreshchatDomain(firstString(p.Account, p.Domain, p.WorkspaceURL)),
		APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:  strings.TrimSpace(p.UserAgent),
	}
	if creds.Token == "" {
		return FreshchatCredentials{}, fmt.Errorf("freshchat requires a token")
	}
	return creds, nil
}

type FreshchatSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r FreshchatSecretsCredentialResolver) ResolveFreshchat(ctx context.Context, _ string, integration Integration) (FreshchatCredentials, error) {
	if r.Secrets == nil {
		return FreshchatCredentials{}, fmt.Errorf("freshchat credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return FreshchatCredentials{}, fmt.Errorf("freshchat credentials_ref is required")
	}
	var payload freshchatCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withFreshchatSettings(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return FreshchatCredentials{}, fmt.Errorf("resolve freshchat credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withFreshchatSettings(creds, integration), nil
			}
		}
	}
	creds, err := freshchatCredentialPayload{Token: raw}.credentials()
	if err != nil {
		return FreshchatCredentials{}, err
	}
	return withFreshchatSettings(creds, integration), nil
}

func withFreshchatSettings(creds FreshchatCredentials, integration Integration) FreshchatCredentials {
	if creds.Domain == "" {
		creds.Domain = normalizeFreshchatDomain(firstString(
			settingString(integration.Settings, "account_domain"),
			settingString(integration.Settings, "domain"),
			settingString(integration.Settings, "workspace_url"),
		))
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type FreshchatBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type FreshchatConversationRefresher interface {
	RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID, userID string) (SyncRequest, error)
}

type FreshchatRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials FreshchatCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type freshchatUser struct {
	ID          string         `json:"id"`
	Email       string         `json:"email"`
	FirstName   string         `json:"first_name"`
	LastName    string         `json:"last_name"`
	Phone       string         `json:"phone"`
	PhoneNumber string         `json:"phone_number"`
	ReferenceID string         `json:"reference_id"`
	RestoreID   string         `json:"restore_id"`
	CreatedTime string         `json:"created_time"`
	UpdatedTime string         `json:"updated_time"`
	Properties  map[string]any `json:"properties"`
}

type freshchatUsersResponse struct {
	Users      []freshchatUser      `json:"users"`
	Pagination freshchatPagination  `json:"pagination"`
	Link       freshchatLinkWrapper `json:"link"`
}

type freshchatConversationRef struct {
	ID string `json:"id"`
}

type freshchatUserConversationsResponse struct {
	Conversations []freshchatConversationRef `json:"conversations"`
}

type freshchatConversationResponse struct {
	Conversation freshchatConversation `json:"conversation"`
}

type freshchatConversation struct {
	ID              string         `json:"id"`
	ConversationID  string         `json:"conversation_id"`
	Status          string         `json:"status"`
	ChannelID       string         `json:"channel_id"`
	AssignedAgentID string         `json:"assigned_agent_id"`
	AssignedGroupID string         `json:"assigned_group_id"`
	CreatedTime     string         `json:"created_time"`
	UpdatedTime     string         `json:"updated_time"`
	Properties      map[string]any `json:"properties"`
}

type freshchatMessagesResponse struct {
	Messages   []freshchatMessage   `json:"messages"`
	Pagination freshchatPagination  `json:"pagination"`
	Link       freshchatLinkWrapper `json:"link"`
	Links      freshchatLinkWrapper `json:"links"`
}

type freshchatPagination struct {
	TotalPages   int `json:"total_pages"`
	CurrentPage  int `json:"current_page"`
	ItemsPerPage int `json:"items_per_page"`
}

type freshchatLinkWrapper struct {
	Next     freshchatLink `json:"next"`
	NextPage freshchatLink `json:"next_page"`
}

type freshchatLink struct {
	Href string `json:"href"`
}

type freshchatMessage struct {
	ID             string                 `json:"id"`
	ConversationID string                 `json:"conversation_id"`
	UserID         string                 `json:"user_id"`
	ActorID        string                 `json:"actor_id"`
	ActorType      string                 `json:"actor_type"`
	MessageType    string                 `json:"message_type"`
	MessageSource  string                 `json:"message_source"`
	CreatedTime    string                 `json:"created_time"`
	MessageParts   []freshchatMessagePart `json:"message_parts"`
}

type freshchatMessagePart struct {
	Text        freshchatMessageText `json:"text"`
	File        map[string]any       `json:"file"`
	Image       map[string]any       `json:"image"`
	Content     string               `json:"content"`
	ContentType string               `json:"content_type"`
}

type freshchatMessageText struct {
	Content     string `json:"content"`
	ContentType string `json:"content_type"`
}

func (b FreshchatRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderFreshchat {
		return SyncRequest{}, fmt.Errorf("freshchat backfill requires a Freshchat integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("freshchat credential resolver is not configured")
	}
	page, done := freshchatPageCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: freshchatCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveFreshchat(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderFreshchat, 30*time.Second)
	baseURL := freshchatBaseURL(b.APIBaseURL, creds)
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("freshchat account_domain or api_base_url is required")
	}
	pageSize := freshchatPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("items_per_page", strconv.Itoa(pageSize))
	if sortBy := strings.TrimSpace(settingString(integration.Settings, "sort_by")); sortBy != "" {
		query.Set("sort_by", sortBy)
	}
	if sortOrder := strings.TrimSpace(settingString(integration.Settings, "sort_order")); sortOrder != "" {
		query.Set("sort_order", sortOrder)
	}

	var users freshchatUsersResponse
	if err := freshchatDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/v2/users", query, &users); err != nil {
		return SyncRequest{}, err
	}
	tickets := []TicketInput{}
	messages := []MessageInput{}
	seenConversations := map[string]bool{}
	for _, user := range users.Users {
		if strings.TrimSpace(user.ID) == "" || strings.TrimSpace(user.Email) == "" {
			continue
		}
		userTickets, userMessages, err := b.freshchatUserConversationRows(ctx, client, baseURL, creds, integration, user, seenConversations)
		if err != nil {
			return SyncRequest{}, err
		}
		tickets = append(tickets, userTickets...)
		messages = append(messages, userMessages...)
	}
	nextCursor := freshchatCursorComplete
	if freshchatHasNextPage(users.Pagination, users.Link, page, len(users.Users), pageSize) {
		nextCursor = freshchatCursorPrefix + strconv.Itoa(page+1)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: nextCursor}), nil
}

func (b FreshchatRESTBackfiller) RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID, userID string) (SyncRequest, error) {
	if integration.Provider != ProviderFreshchat {
		return SyncRequest{}, fmt.Errorf("freshchat refresh requires a Freshchat integration")
	}
	conversationID = strings.TrimSpace(conversationID)
	userID = strings.TrimSpace(userID)
	if conversationID == "" {
		return SyncRequest{}, fmt.Errorf("freshchat conversation id is required")
	}
	if userID == "" {
		return SyncRequest{}, fmt.Errorf("freshchat user id is required for conversation refresh")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("freshchat credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveFreshchat(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderFreshchat, 30*time.Second)
	baseURL := freshchatBaseURL(b.APIBaseURL, creds)
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("freshchat account_domain or api_base_url is required")
	}
	user, err := freshchatFetchUser(ctx, client, baseURL, creds, b.UserAgent, userID)
	if err != nil {
		return SyncRequest{}, err
	}
	conv, err := freshchatFetchConversation(ctx, client, baseURL, creds, b.UserAgent, conversationID)
	if err != nil {
		return SyncRequest{}, err
	}
	if !freshchatConversationMatchesChannel(conv, settingString(integration.Settings, "channel_id")) {
		return SyncRequest{RunMode: "webhook", Cursor: "freshchat-webhook-" + conversationID}, nil
	}
	ticket, ok := mapFreshchatConversation(conv, user)
	if !ok {
		return SyncRequest{RunMode: "webhook", Cursor: "freshchat-webhook-" + conversationID}, nil
	}
	msgs, err := fetchFreshchatConversationMessages(ctx, client, baseURL, creds, b.UserAgent, freshchatConversationID(conv), ticket)
	if err != nil {
		return SyncRequest{}, err
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: msgs, Cursor: "freshchat-webhook-" + conversationID}), nil
}

func (b FreshchatRESTBackfiller) freshchatUserConversationRows(ctx context.Context, client *http.Client, baseURL string, creds FreshchatCredentials, integration Integration, user freshchatUser, seen map[string]bool) ([]TicketInput, []MessageInput, error) {
	var refs freshchatUserConversationsResponse
	path := "/v2/users/" + url.PathEscape(strings.TrimSpace(user.ID)) + "/conversations"
	if err := freshchatDoJSON(ctx, client, baseURL, creds, b.UserAgent, path, nil, &refs); err != nil {
		return nil, nil, err
	}
	tickets := []TicketInput{}
	messages := []MessageInput{}
	for _, ref := range refs.Conversations {
		convID := strings.TrimSpace(ref.ID)
		if convID == "" || seen[convID] {
			continue
		}
		seen[convID] = true
		conv, err := freshchatFetchConversation(ctx, client, baseURL, creds, b.UserAgent, convID)
		if err != nil {
			return nil, nil, err
		}
		if !freshchatConversationMatchesChannel(conv, settingString(integration.Settings, "channel_id")) {
			continue
		}
		ticket, ok := mapFreshchatConversation(conv, user)
		if !ok {
			continue
		}
		tickets = append(tickets, ticket)
		thread, err := fetchFreshchatConversationMessages(ctx, client, baseURL, creds, b.UserAgent, freshchatConversationID(conv), ticket)
		if err != nil {
			return nil, nil, err
		}
		messages = append(messages, thread...)
	}
	return tickets, messages, nil
}

func freshchatFetchUser(ctx context.Context, client *http.Client, baseURL string, creds FreshchatCredentials, userAgent, userID string) (freshchatUser, error) {
	var out freshchatUser
	path := "/v2/users/" + url.PathEscape(strings.TrimSpace(userID))
	if err := freshchatDoJSON(ctx, client, baseURL, creds, userAgent, path, nil, &out); err != nil {
		return freshchatUser{}, err
	}
	return out, nil
}

func freshchatFetchConversation(ctx context.Context, client *http.Client, baseURL string, creds FreshchatCredentials, userAgent, conversationID string) (freshchatConversation, error) {
	path := "/v2/conversations/" + url.PathEscape(strings.TrimSpace(conversationID))
	var raw map[string]json.RawMessage
	if err := freshchatDoJSON(ctx, client, baseURL, creds, userAgent, path, nil, &raw); err != nil {
		return freshchatConversation{}, err
	}
	if data, ok := raw["conversation"]; ok {
		var out freshchatConversation
		if err := json.Unmarshal(data, &out); err != nil {
			return freshchatConversation{}, fmt.Errorf("decode freshchat conversation %s: %w", path, err)
		}
		return out, nil
	}
	encoded, _ := json.Marshal(raw)
	var direct freshchatConversation
	_ = json.Unmarshal(encoded, &direct)
	return direct, nil
}

func fetchFreshchatConversationMessages(ctx context.Context, client *http.Client, baseURL string, creds FreshchatCredentials, userAgent, conversationID string, ticket TicketInput) ([]MessageInput, error) {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return nil, nil
	}
	messages := []MessageInput{}
	for page := 1; page <= freshchatMessagePageMaxLoops; page++ {
		query := url.Values{}
		query.Set("page", strconv.Itoa(page))
		query.Set("items_per_page", strconv.Itoa(freshchatMessagePageSize))
		var out freshchatMessagesResponse
		path := "/v2/conversations/" + url.PathEscape(conversationID) + "/messages"
		if err := freshchatDoJSON(ctx, client, baseURL, creds, userAgent, path, query, &out); err != nil {
			return nil, err
		}
		for i, msg := range out.Messages {
			if mapped, ok := mapFreshchatMessage(msg, ticket, i); ok {
				messages = append(messages, mapped)
			}
		}
		if !freshchatHasNextPage(out.Pagination, firstNonEmptyFreshchatLinks(out.Link, out.Links), page, len(out.Messages), freshchatMessagePageSize) {
			break
		}
	}
	return messages, nil
}

func mapFreshchatConversation(conv freshchatConversation, user freshchatUser) (TicketInput, bool) {
	email := strings.ToLower(strings.TrimSpace(user.Email))
	id := freshchatConversationID(conv)
	if email == "" || id == "" {
		return TicketInput{}, false
	}
	name := strings.TrimSpace(strings.Join(cleanStrings([]string{user.FirstName, user.LastName}), " "))
	out := TicketInput{
		SourceID:       "freshchat://conversation/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  name,
		Status:         strings.TrimSpace(conv.Status),
		Properties: map[string]any{
			"freshchat_conversation_id": id,
			"freshchat_user_id":         strings.TrimSpace(user.ID),
			"freshchat_reference_id":    strings.TrimSpace(user.ReferenceID),
			"freshchat_restore_id":      strings.TrimSpace(user.RestoreID),
		},
	}
	if channelID := strings.TrimSpace(conv.ChannelID); channelID != "" {
		out.Properties["freshchat_channel_id"] = channelID
	}
	if assignedAgentID := strings.TrimSpace(conv.AssignedAgentID); assignedAgentID != "" {
		out.Assignee = assignedAgentID
		out.Properties["freshchat_assigned_agent_id"] = assignedAgentID
	}
	if assignedGroupID := strings.TrimSpace(conv.AssignedGroupID); assignedGroupID != "" {
		out.Properties["freshchat_assigned_group_id"] = assignedGroupID
	}
	if phone := strings.TrimSpace(firstString(user.Phone, user.PhoneNumber)); phone != "" {
		out.Properties["freshchat_user_phone"] = phone
	}
	if len(conv.Properties) > 0 {
		out.Properties["freshchat_conversation_properties"] = conv.Properties
		if priority := strings.TrimSpace(fmt.Sprint(conv.Properties["priority"])); priority != "" && priority != "<nil>" {
			out.Priority = priority
		}
	}
	if t := parseZendeskTime(firstString(conv.UpdatedTime, conv.CreatedTime)); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func mapFreshchatMessage(message freshchatMessage, ticket TicketInput, index int) (MessageInput, bool) {
	conversationID := firstString(message.ConversationID, ticket.ConversationID)
	if conversationID == "" {
		return MessageInput{}, false
	}
	bodyText, bodyHTML, attachmentCount := freshchatMessageBodies(message.MessageParts)
	if bodyText == "" && bodyHTML == "" && attachmentCount == 0 {
		return MessageInput{}, false
	}
	messageID := strings.TrimSpace(firstString(message.ID, fmt.Sprintf("%s-%d", conversationID, index)))
	return MessageInput{
		SourceID:       "freshchat://message/" + messageID,
		ConversationID: conversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      freshchatMessageDirection(message.ActorType),
		SenderType:     freshchatMessageSenderType(message.ActorType),
		Sender:         firstString(message.ActorID, message.UserID),
		BodyText:       bodyText,
		BodyHTML:       bodyHTML,
		Properties: map[string]any{
			"freshchat_message_id":       strings.TrimSpace(message.ID),
			"freshchat_actor_id":         strings.TrimSpace(message.ActorID),
			"freshchat_actor_type":       strings.TrimSpace(message.ActorType),
			"freshchat_message_type":     strings.TrimSpace(message.MessageType),
			"freshchat_message_source":   strings.TrimSpace(message.MessageSource),
			"freshchat_user_id":          strings.TrimSpace(message.UserID),
			"freshchat_attachment_count": attachmentCount,
		},
		OccurredAt: parseZendeskTime(message.CreatedTime),
	}, true
}

func freshchatMessageBodies(parts []freshchatMessagePart) (string, string, int) {
	texts := []string{}
	htmls := []string{}
	attachments := 0
	for _, part := range parts {
		content := strings.TrimSpace(firstString(part.Text.Content, part.Content))
		contentType := strings.ToLower(strings.TrimSpace(firstString(part.Text.ContentType, part.ContentType)))
		if content != "" {
			if strings.Contains(contentType, "html") {
				htmls = append(htmls, content)
			} else {
				texts = append(texts, content)
			}
		}
		if len(part.File) > 0 || len(part.Image) > 0 {
			attachments++
		}
	}
	return strings.Join(texts, "\n"), strings.Join(htmls, "\n"), attachments
}

func freshchatMessageDirection(actorType string) string {
	switch strings.ToLower(strings.TrimSpace(actorType)) {
	case "agent", "bot", "system":
		return "outbound"
	default:
		return "inbound"
	}
}

func freshchatMessageSenderType(actorType string) string {
	switch strings.ToLower(strings.TrimSpace(actorType)) {
	case "agent":
		return "agent"
	case "bot", "system":
		return "system"
	default:
		return "customer"
	}
}

func freshchatConversationID(conv freshchatConversation) string {
	return strings.TrimSpace(firstString(conv.ConversationID, conv.ID))
}

func freshchatConversationMatchesChannel(conv freshchatConversation, channelID string) bool {
	channelID = strings.TrimSpace(channelID)
	return channelID == "" || strings.TrimSpace(conv.ChannelID) == channelID
}

func freshchatBaseURL(override string, creds FreshchatCredentials) string {
	if v := strings.TrimRight(strings.TrimSpace(override), "/"); v != "" {
		return v
	}
	if v := strings.TrimRight(strings.TrimSpace(creds.APIBaseURL), "/"); v != "" {
		return v
	}
	domain := normalizeFreshchatDomain(creds.Domain)
	if domain == "" {
		return ""
	}
	if strings.Contains(domain, ".") {
		return "https://" + domain
	}
	return "https://" + domain + freshchatDefaultFreshchatHost
}

func normalizeFreshchatDomain(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "https://")
	value = strings.TrimPrefix(value, "http://")
	if slash := strings.Index(value, "/"); slash >= 0 {
		value = value[:slash]
	}
	value = strings.TrimSuffix(strings.TrimSpace(value), ".")
	return value
}

func freshchatDoJSON(ctx context.Context, client *http.Client, baseURL string, creds FreshchatCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse freshchat API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	if query != nil {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.Token))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, freshchatDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, freshchatResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return FreshchatRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode freshchat response %s: %w", path, err)
	}
	return nil
}

type FreshchatRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e FreshchatRESTError) Error() string {
	if e.Path == "" {
		if e.RetryAfter > 0 {
			return fmt.Sprintf("freshchat REST failed %d; retry after %s: %s", e.StatusCode, e.RetryAfter, e.Snippet)
		}
		return fmt.Sprintf("freshchat REST failed %d: %s", e.StatusCode, e.Snippet)
	}
	if e.RetryAfter > 0 {
		return fmt.Sprintf("freshchat REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("freshchat REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func freshchatPageCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == freshchatCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, freshchatCursorPrefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}

func decodeFreshchatCursor(cursor string) string {
	page, done := freshchatPageCursor(cursor)
	if done {
		return freshchatCursorComplete
	}
	if page <= 1 {
		return ""
	}
	return strconv.Itoa(page)
}

func freshchatPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return freshchatDefaultUserPageSize
	}
	if n > freshchatMaxUserPageSize {
		return freshchatMaxUserPageSize
	}
	return n
}

func freshchatHasNextPage(p freshchatPagination, links freshchatLinkWrapper, page, count, pageSize int) bool {
	if strings.TrimSpace(firstString(links.Next.Href, links.NextPage.Href)) != "" {
		return true
	}
	if p.TotalPages > 0 {
		current := p.CurrentPage
		if current <= 0 {
			current = page
		}
		return current < p.TotalPages
	}
	return count >= pageSize && pageSize > 0
}

func firstNonEmptyFreshchatLinks(values ...freshchatLinkWrapper) freshchatLinkWrapper {
	for _, value := range values {
		if firstString(value.Next.Href, value.NextPage.Href) != "" {
			return value
		}
	}
	return freshchatLinkWrapper{}
}
