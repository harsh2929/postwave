// SPDX-License-Identifier: AGPL-3.0-only
//
// reamaze.go — native Re:amaze provider runtime.
//
// Re:amaze is a Shopify-native helpdesk; conversation pull enriches subscriber
// profiles for CX-driven lifecycle flows. Mirrors the Gorgias/Zendesk pattern:
// a credential resolver (login email + API token, HTTP Basic, per-brand
// subdomain) + a REST puller over the Conversations API (page-number pagination
// with page_count) + canonical TicketInput mapping, dispatched via providerPull.
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
	reamazeDefaultUserAgent = "Moosewave Re:amaze Integration"
	reamazeResponseMaxBytes = 16 << 20
	reamazeCursorPrefix     = "reamaze:"
	reamazeCursorComplete   = "reamaze:complete"
)

type ReamazeCredentials struct {
	Email      string
	APIToken   string
	Brand      string
	APIBaseURL string
	UserAgent  string
}

type ReamazeCredentialResolver interface {
	ResolveReamaze(ctx context.Context, tenantID string, integration Integration) (ReamazeCredentials, error)
}

type reamazeCredentialPayload struct {
	Email      string `json:"email"`
	APIToken   string `json:"api_token"`
	Token      string `json:"token"`
	Brand      string `json:"brand"`
	Subdomain  string `json:"subdomain"`
	Domain     string `json:"domain"`
	Account    string `json:"account_domain"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p reamazeCredentialPayload) credentials() (ReamazeCredentials, error) {
	email := strings.TrimSpace(p.Email)
	token := strings.TrimSpace(firstString(p.APIToken, p.Token))
	if email == "" || token == "" {
		return ReamazeCredentials{}, fmt.Errorf("re:amaze email and api_token are required")
	}
	return ReamazeCredentials{Email: email, APIToken: token, Brand: strings.TrimSpace(firstString(p.Brand, p.Subdomain, p.Domain, p.Account)), APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type ReamazeSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r ReamazeSecretsCredentialResolver) ResolveReamaze(ctx context.Context, _ string, integration Integration) (ReamazeCredentials, error) {
	if r.Secrets == nil {
		return ReamazeCredentials{}, fmt.Errorf("re:amaze credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return ReamazeCredentials{}, fmt.Errorf("re:amaze credentials_ref is required")
	}
	var payload reamazeCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withReamazeBrand(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return ReamazeCredentials{}, fmt.Errorf("resolve re:amaze credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withReamazeBrand(creds, integration), nil
			}
		}
	}
	return ReamazeCredentials{}, fmt.Errorf("re:amaze requires a JSON {email, api_token} secret")
}

func withReamazeBrand(creds ReamazeCredentials, integration Integration) ReamazeCredentials {
	if creds.Brand == "" {
		creds.Brand = strings.TrimSpace(firstString(
			settingString(integration.Settings, "brand"),
			settingString(integration.Settings, "subdomain"),
			settingString(integration.Settings, "domain"),
			settingString(integration.Settings, "account_domain"),
		))
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type ReamazeBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type ReamazeConversationRefresher interface {
	RefreshConversation(ctx context.Context, tenantID string, integration Integration, slug string) (SyncRequest, error)
}

type ReamazeRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials ReamazeCredentialResolver
	APIBaseURL  string
	UserAgent   string
}

type reamazePerson struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

type reamazeCategory struct {
	Name    string      `json:"name"`
	Slug    string      `json:"slug"`
	Email   string      `json:"email"`
	Channel json.Number `json:"channel"`
}

type reamazeConversation struct {
	Subject             string          `json:"subject"`
	Slug                string          `json:"slug"`
	Status              int             `json:"status"`
	TagList             []string        `json:"tag_list"`
	Author              reamazePerson   `json:"author"`
	Assignee            *reamazePerson  `json:"assignee"`
	Category            reamazeCategory `json:"category"`
	UpdatedAt           string          `json:"updated_at"`
	CreatedAt           string          `json:"created_at"`
	LastCustomerMessage reamazeSnippet  `json:"last_customer_message"`
	LastStaffMessage    reamazeSnippet  `json:"last_staff_message"`
	Message             reamazeSnippet  `json:"message"`
}

type reamazeConversationsResponse struct {
	Conversations []reamazeConversation `json:"conversations"`
	PageCount     int                   `json:"page_count"`
	Page          int                   `json:"page"`
}

type reamazeSnippet struct {
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
}

type reamazeMessage struct {
	Body         string              `json:"body"`
	OriginalBody string              `json:"original_body"`
	Visibility   int                 `json:"visibility"`
	Origin       int                 `json:"origin"`
	OriginID     string              `json:"origin_id"`
	CreatedAt    string              `json:"created_at"`
	User         reamazePerson       `json:"user"`
	Recipients   []reamazePerson     `json:"recipients"`
	Conversation reamazeConversation `json:"conversation"`
}

type reamazeMessagesResponse struct {
	Messages  []reamazeMessage `json:"messages"`
	PageCount int              `json:"page_count"`
	Page      int              `json:"page"`
}

func (b ReamazeRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderReamaze {
		return SyncRequest{}, fmt.Errorf("re:amaze backfill requires a Re:amaze integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("re:amaze credential resolver is not configured")
	}
	page, done := reamazePageCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: reamazeCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveReamaze(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	baseURL, err := reamazeBaseURL(b.APIBaseURL, creds)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderReamaze, 30*time.Second)
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("sort", "updated")

	var out reamazeConversationsResponse
	if err := reamazeDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v1/conversations", query, &out); err != nil {
		return SyncRequest{}, err
	}
	tickets := make([]TicketInput, 0, len(out.Conversations))
	messages := []MessageInput{}
	for _, c := range out.Conversations {
		if mapped, ok := mapReamazeConversation(c); ok {
			tickets = append(tickets, mapped)
			thread, err := fetchReamazeConversationMessages(ctx, client, baseURL, creds, b.UserAgent, mapped.ConversationID)
			if err != nil {
				return SyncRequest{}, err
			}
			messages = append(messages, mapReamazeConversationMessages(thread, mapped)...)
		}
	}
	nextCursor := reamazeCursorComplete
	if out.PageCount > page && len(out.Conversations) > 0 {
		nextCursor = reamazeCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: nextCursor}, nil
}

func (b ReamazeRESTBackfiller) RefreshConversation(ctx context.Context, tenantID string, integration Integration, slug string) (SyncRequest, error) {
	if integration.Provider != ProviderReamaze {
		return SyncRequest{}, fmt.Errorf("re:amaze refresh requires a Re:amaze integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("re:amaze credential resolver is not configured")
	}
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook"}), nil
	}
	creds, err := b.Credentials.ResolveReamaze(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	baseURL, err := reamazeBaseURL(b.APIBaseURL, creds)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderReamaze, 30*time.Second)
	messages, err := fetchReamazeConversationMessages(ctx, client, baseURL, creds, b.UserAgent, slug)
	if err != nil {
		return SyncRequest{}, err
	}
	for _, message := range messages {
		conversation := message.Conversation
		conversation.Slug = firstString(conversation.Slug, slug)
		if ticket, ok := mapReamazeConversation(conversation); ok {
			return normalizeSyncRequest(SyncRequest{
				RunMode:  "webhook",
				Tickets:  []TicketInput{ticket},
				Messages: mapReamazeConversationMessages(messages, ticket),
				Cursor:   "reamaze-conversation-" + slug,
			}), nil
		}
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Cursor: "reamaze-conversation-" + slug}), nil
}

func mapReamazeConversation(c reamazeConversation) (TicketInput, bool) {
	email := strings.ToLower(strings.TrimSpace(c.Author.Email))
	if email == "" {
		return TicketInput{}, false
	}
	slug := strings.TrimSpace(c.Slug)
	out := TicketInput{
		SourceID:       "reamaze://conversation/" + slug,
		ConversationID: slug,
		Email:          email,
		RequesterName:  strings.TrimSpace(c.Author.Name),
		Subject:        strings.TrimSpace(c.Subject),
		Status:         reamazeStatusName(c.Status),
		Tags:           cleanStrings(c.TagList),
		Properties: map[string]any{
			"reamaze_slug":                     slug,
			"reamaze_status":                   c.Status,
			"reamaze_category_slug":            strings.TrimSpace(c.Category.Slug),
			"reamaze_category_name":            strings.TrimSpace(c.Category.Name),
			"reamaze_category_email":           strings.TrimSpace(c.Category.Email),
			"reamaze_category_channel":         strings.TrimSpace(c.Category.Channel.String()),
			"reamaze_last_customer_message_at": strings.TrimSpace(c.LastCustomerMessage.CreatedAt),
			"reamaze_last_staff_message_at":    strings.TrimSpace(c.LastStaffMessage.CreatedAt),
		},
	}
	if c.Assignee != nil {
		out.Assignee = strings.TrimSpace(firstString(c.Assignee.Name, c.Assignee.Email))
		out.Properties["reamaze_assignee_email"] = strings.TrimSpace(c.Assignee.Email)
	}
	if t := parseZendeskTime(firstString(c.UpdatedAt, c.CreatedAt)); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func fetchReamazeConversationMessages(ctx context.Context, client *http.Client, baseURL string, creds ReamazeCredentials, userAgent, slug string) ([]reamazeMessage, error) {
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return nil, nil
	}
	messages := []reamazeMessage{}
	for page := 1; ; page++ {
		query := url.Values{}
		query.Set("page", strconv.Itoa(page))
		query.Set("include", "original_body")

		var out reamazeMessagesResponse
		path := "/api/v1/conversations/" + url.PathEscape(slug) + "/messages"
		if err := reamazeDoJSON(ctx, client, baseURL, creds, userAgent, path, query, &out); err != nil {
			var restErr ReamazeRESTError
			if errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound {
				return messages, nil
			}
			return nil, err
		}
		messages = append(messages, out.Messages...)
		if out.PageCount <= page || len(out.Messages) == 0 {
			break
		}
	}
	return messages, nil
}

func mapReamazeConversationMessages(messages []reamazeMessage, ticket TicketInput) []MessageInput {
	out := make([]MessageInput, 0, len(messages))
	for idx, message := range messages {
		if mapped, ok := mapReamazeMessage(message, ticket, idx); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapReamazeMessage(message reamazeMessage, ticket TicketInput, index int) (MessageInput, bool) {
	bodyText := strings.TrimSpace(message.Body)
	bodyHTML := strings.TrimSpace(message.OriginalBody)
	if bodyText == "" && bodyHTML != "" {
		bodyText = intercomPartBodyText(bodyHTML)
	}
	if bodyHTML == "" {
		bodyHTML = bodyText
	}
	if bodyText == "" && bodyHTML == "" {
		return MessageInput{}, false
	}
	conversationID := strings.TrimSpace(firstString(message.Conversation.Slug, ticket.ConversationID))
	originID := strings.TrimSpace(message.OriginID)
	sourceID := "reamaze://message/" + firstString(originID, conversationID+"/"+strconv.Itoa(index+1))
	direction, senderType := reamazeMessageDirection(message, ticket)
	out := MessageInput{
		SourceID:       sourceID,
		ConversationID: conversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        firstString(strings.TrimSpace(message.Conversation.Subject), ticket.Subject),
		Direction:      direction,
		SenderType:     senderType,
		Sender:         strings.TrimSpace(firstString(message.User.Name, message.User.Email, ticket.RequesterName)),
		BodyText:       bodyText,
		BodyHTML:       bodyHTML,
		Properties: map[string]any{
			"reamaze_conversation_slug": conversationID,
			"reamaze_origin_id":         originID,
			"reamaze_origin":            message.Origin,
			"reamaze_visibility":        message.Visibility,
			"reamaze_sender_email":      strings.TrimSpace(message.User.Email),
		},
	}
	if t := parseZendeskTime(message.CreatedAt); t != nil {
		out.OccurredAt = t
	}
	return out, true
}

func reamazeMessageDirection(message reamazeMessage, ticket TicketInput) (string, string) {
	if message.Visibility == 1 {
		return "internal", "agent"
	}
	senderEmail := strings.ToLower(strings.TrimSpace(message.User.Email))
	if senderEmail != "" && senderEmail == strings.ToLower(strings.TrimSpace(ticket.Email)) {
		return "inbound", "customer"
	}
	if message.Origin == 16 {
		return "outbound", "agent"
	}
	return "outbound", "agent"
}

func reamazeStatusName(status int) string {
	switch status {
	case 0:
		return "open"
	case 1:
		return "responded"
	case 2:
		return "done"
	case 3:
		return "spam"
	case 4:
		return "archived"
	case 5:
		return "on_hold"
	case 6:
		return "auto_done"
	case 7:
		return "ai_agent_assigned"
	case 8:
		return "ai_agent_done"
	case 9:
		return "spam_ai"
	default:
		return ""
	}
}

func reamazeBaseURL(override string, creds ReamazeCredentials) (string, error) {
	if v := strings.TrimRight(strings.TrimSpace(override), "/"); v != "" {
		return v, nil
	}
	if v := strings.TrimRight(strings.TrimSpace(creds.APIBaseURL), "/"); v != "" {
		return v, nil
	}
	if brand := strings.TrimSpace(creds.Brand); brand != "" {
		return "https://" + brand + ".reamaze.io", nil
	}
	return "", fmt.Errorf("re:amaze brand or api_base_url is required")
}

func reamazeDoJSON(ctx context.Context, client *http.Client, baseURL string, creds ReamazeCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse re:amaze API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	basic := base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(creds.Email) + ":" + strings.TrimSpace(creds.APIToken)))
	req.Header.Set("Authorization", "Basic "+basic)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, reamazeDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, reamazeResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return ReamazeRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode re:amaze response %s: %w", path, err)
	}
	return nil
}

type ReamazeRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e ReamazeRESTError) Error() string {
	path := strings.TrimSpace(e.Path)
	if e.RetryAfter > 0 {
		return fmt.Sprintf("re:amaze REST %s failed %d; retry after %s: %s", path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("re:amaze REST %s failed %d: %s", path, e.StatusCode, e.Snippet)
}

func reamazePageCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == reamazeCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, reamazeCursorPrefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}
