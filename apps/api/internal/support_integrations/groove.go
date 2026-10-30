// SPDX-License-Identifier: AGPL-3.0-only
//
// groove.go — native Groove provider runtime.
//
// Groove v1 REST is legacy but still documents ticket, customer, message, and
// webhook endpoints. The native partial runtime pulls paged tickets, hydrates
// each ticket's paged message thread, and uses route-token webhooks for sparse
// ticket refresh because Groove does not document webhook signatures.
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
	grooveDefaultAPIBaseURL   = "https://api.groovehq.com/v1"
	grooveDefaultUserAgent    = "Moosewave Groove Integration"
	grooveResponseMaxBytes    = 16 << 20
	grooveCursorPrefix        = "groove:"
	grooveCursorComplete      = "groove:complete"
	grooveDefaultPageSize     = 25
	grooveMaxPageSize         = 50
	grooveMaxMessagePageLoops = 100
)

type GrooveCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type GrooveCredentialResolver interface {
	ResolveGroove(ctx context.Context, tenantID string, integration Integration) (GrooveCredentials, error)
}

type grooveCredentialPayload struct {
	AccessToken string `json:"access_token"`
	BearerToken string `json:"bearer_token"`
	Token       string `json:"token"`
	APIKey      string `json:"api_key"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p grooveCredentialPayload) credentials() (GrooveCredentials, error) {
	token := strings.TrimSpace(firstString(p.AccessToken, p.BearerToken, p.Token, p.APIKey))
	if token == "" {
		return GrooveCredentials{}, fmt.Errorf("groove access_token is required")
	}
	return GrooveCredentials{
		AccessToken: token,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

type GrooveSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r GrooveSecretsCredentialResolver) ResolveGroove(ctx context.Context, _ string, integration Integration) (GrooveCredentials, error) {
	if r.Secrets == nil {
		return GrooveCredentials{}, fmt.Errorf("groove credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return GrooveCredentials{}, fmt.Errorf("groove credentials_ref is required")
	}
	var payload grooveCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withGrooveSettings(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return GrooveCredentials{}, fmt.Errorf("resolve groove credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withGrooveSettings(creds, integration), nil
			}
		}
	}
	creds, err := (grooveCredentialPayload{AccessToken: strings.TrimPrefix(raw, "Bearer ")}).credentials()
	if err != nil {
		return GrooveCredentials{}, err
	}
	return withGrooveSettings(creds, integration), nil
}

func withGrooveSettings(creds GrooveCredentials, integration Integration) GrooveCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type GrooveBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type GrooveTicketRefresher interface {
	RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketNumber string) (SyncRequest, error)
}

type GrooveRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials GrooveCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type grooveTicketsResponse struct {
	Tickets []grooveTicket `json:"tickets"`
	Meta    grooveMeta     `json:"meta"`
}

type grooveTicketResponse struct {
	Ticket grooveTicket `json:"ticket"`
}

type grooveMessagesResponse struct {
	Messages []grooveMessage `json:"messages"`
	Meta     grooveMeta      `json:"meta"`
}

type grooveMeta struct {
	Pagination groovePagination `json:"pagination"`
}

type groovePagination struct {
	CurrentPage int    `json:"current_page"`
	TotalPages  int    `json:"total_pages"`
	TotalCount  int    `json:"total_count"`
	NextPage    string `json:"next_page"`
}

type grooveTicket struct {
	Number        int            `json:"number"`
	NumberString  string         `json:"number_string"`
	Title         string         `json:"title"`
	Summary       string         `json:"summary"`
	State         string         `json:"state"`
	Priority      string         `json:"priority"`
	Assignee      string         `json:"assignee"`
	AssignedGroup string         `json:"assigned_group"`
	ClosedBy      string         `json:"closed_by"`
	Tags          []string       `json:"tags"`
	CreatedAt     string         `json:"created_at"`
	UpdatedAt     string         `json:"updated_at"`
	Href          string         `json:"href"`
	Links         grooveLinks    `json:"links"`
	Raw           map[string]any `json:"-"`
}

type grooveMessage struct {
	ID            string      `json:"id"`
	Href          string      `json:"href"`
	CreatedAt     string      `json:"created_at"`
	UpdatedAt     string      `json:"updated_at"`
	Note          bool        `json:"note"`
	Body          string      `json:"body"`
	PlainTextBody string      `json:"plain_text_body"`
	Links         grooveLinks `json:"links"`
}

type grooveLinks struct {
	Customer   grooveHref `json:"customer"`
	Messages   grooveHref `json:"messages"`
	Author     grooveHref `json:"author"`
	Recipient  grooveHref `json:"recipient"`
	Ticket     grooveHref `json:"ticket"`
	Assignee   grooveHref `json:"assignee"`
	State      grooveHref `json:"state"`
	Mailbox    grooveHref `json:"mailbox"`
	Attachment grooveHref `json:"attachments"`
}

type grooveHref struct {
	Href string `json:"href"`
}

func (b GrooveRESTBackfiller) client() *http.Client {
	return supportEgressClient(b.HTTPClient, ProviderGroove, 30*time.Second)
}

func (b GrooveRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderGroove {
		return SyncRequest{}, fmt.Errorf("groove backfill requires a Groove integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("groove credential resolver is not configured")
	}
	page, done := groovePageCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: grooveCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveGroove(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), grooveDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("per_page", strconv.Itoa(groovePageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
	for _, key := range []string{"state", "customer", "folder"} {
		if value := strings.TrimSpace(settingString(integration.Settings, key)); value != "" {
			query.Set(key, value)
		}
	}
	if folderID := strings.TrimSpace(settingString(integration.Settings, "folder_id")); folderID != "" && query.Get("folder") == "" {
		query.Set("folder", folderID)
	}
	var out grooveTicketsResponse
	if err := grooveDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/tickets", query, &out); err != nil {
		return SyncRequest{}, err
	}
	tickets := make([]TicketInput, 0, len(out.Tickets))
	messages := []MessageInput{}
	for _, ticket := range out.Tickets {
		mapped, ok := mapGrooveTicket(ticket)
		if !ok {
			continue
		}
		if mapped.Properties == nil {
			mapped.Properties = map[string]any{}
		}
		mapped.Properties["message_page_size"] = firstString(settingString(integration.Settings, "message_page_size"), strconv.Itoa(grooveDefaultPageSize))
		tickets = append(tickets, mapped)
		thread, err := b.fetchGrooveMessages(ctx, client, baseURL, creds, mapped.ConversationID, mapped)
		if err != nil {
			return SyncRequest{}, err
		}
		messages = append(messages, thread...)
	}
	nextCursor := grooveCursorComplete
	if grooveHasNextPage(out.Meta.Pagination) {
		nextCursor = grooveCursorPrefix + strconv.Itoa(page+1)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: nextCursor}), nil
}

func (b GrooveRESTBackfiller) RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketNumber string) (SyncRequest, error) {
	if integration.Provider != ProviderGroove {
		return SyncRequest{}, fmt.Errorf("groove refresh requires a Groove integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("groove credential resolver is not configured")
	}
	ticketNumber = strings.TrimSpace(ticketNumber)
	if ticketNumber == "" {
		return SyncRequest{}, nil
	}
	creds, err := b.Credentials.ResolveGroove(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := b.client()
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), grooveDefaultAPIBaseURL)
	var out grooveTicketResponse
	if err := grooveDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/tickets/"+url.PathEscape(ticketNumber), nil, &out); err != nil {
		return SyncRequest{}, err
	}
	mapped, ok := mapGrooveTicket(out.Ticket)
	if !ok {
		return SyncRequest{RunMode: "webhook", Cursor: "groove-ticket-" + ticketNumber}, nil
	}
	if mapped.Properties == nil {
		mapped.Properties = map[string]any{}
	}
	mapped.Properties["message_page_size"] = firstString(settingString(integration.Settings, "message_page_size"), strconv.Itoa(grooveDefaultPageSize))
	messages, err := b.fetchGrooveMessages(ctx, client, baseURL, creds, mapped.ConversationID, mapped)
	if err != nil {
		return SyncRequest{}, err
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{mapped}, Messages: messages, Cursor: "groove-ticket-" + ticketNumber}), nil
}

func (b GrooveRESTBackfiller) fetchGrooveMessages(ctx context.Context, client *http.Client, baseURL string, creds GrooveCredentials, ticketNumber string, ticket TicketInput) ([]MessageInput, error) {
	page := 1
	out := []MessageInput{}
	for loops := 0; loops < grooveMaxMessagePageLoops; loops++ {
		query := url.Values{}
		query.Set("page", strconv.Itoa(page))
		query.Set("per_page", strconv.Itoa(groovePageSize(settingString(ticket.Properties, "message_page_size"))))
		var resp grooveMessagesResponse
		if err := grooveDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/tickets/"+url.PathEscape(ticketNumber)+"/messages", query, &resp); err != nil {
			return nil, err
		}
		out = append(out, mapGrooveMessages(resp.Messages, ticket)...)
		if !grooveHasNextPage(resp.Meta.Pagination) {
			return out, nil
		}
		page++
	}
	return out, nil
}

func mapGrooveTicket(ticket grooveTicket) (TicketInput, bool) {
	number := grooveTicketNumber(ticket)
	email := grooveEmailFromHref(ticket.Links.Customer.Href)
	if number == "" || email == "" {
		return TicketInput{}, false
	}
	updatedAt := firstTime(parseZendeskTime(ticket.UpdatedAt), parseZendeskTime(ticket.CreatedAt))
	out := TicketInput{
		SourceID:       "groove://ticket/" + number,
		ConversationID: number,
		Email:          email,
		Subject:        firstString(ticket.Title, ticket.Summary, "Groove ticket "+number),
		Status:         firstString(ticket.State, "open"),
		Priority:       ticket.Priority,
		Assignee:       firstString(ticket.Assignee, grooveEmailFromHref(ticket.Links.Assignee.Href)),
		Tags:           ticket.Tags,
		Properties: map[string]any{
			"groove_ticket_number":  number,
			"groove_ticket_href":    ticket.Href,
			"groove_mailbox_id":     grooveIDFromHref(ticket.Links.Mailbox.Href),
			"groove_assigned_group": ticket.AssignedGroup,
		},
		UpdatedAt: updatedAt,
	}
	return out, true
}

func mapGrooveMessages(messages []grooveMessage, ticket TicketInput) []MessageInput {
	out := []MessageInput{}
	for i, message := range messages {
		if mapped, ok := mapGrooveMessage(message, ticket, i); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapGrooveMessage(message grooveMessage, ticket TicketInput, index int) (MessageInput, bool) {
	body := firstString(message.PlainTextBody, message.Body)
	id := firstString(grooveIDFromHref(message.Href), message.ID, strconv.Itoa(index))
	if body == "" && id == "" {
		return MessageInput{}, false
	}
	direction, senderType := grooveMessageDirection(message, ticket.Email)
	return MessageInput{
		SourceID:       "groove://ticket/" + ticket.ConversationID + "/message/" + id,
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender:         firstString(grooveEmailFromHref(message.Links.Author.Href), grooveEmailFromHref(message.Links.Recipient.Href)),
		BodyText:       body,
		BodyHTML:       message.Body,
		Properties: map[string]any{
			"groove_message_id":   id,
			"groove_message_href": message.Href,
			"groove_note":         message.Note,
		},
		OccurredAt: firstTime(parseZendeskTime(message.CreatedAt), parseZendeskTime(message.UpdatedAt)),
	}, true
}

func grooveMessageDirection(message grooveMessage, ticketEmail string) (string, string) {
	if message.Note {
		return "internal", "agent"
	}
	author := strings.ToLower(grooveEmailFromHref(message.Links.Author.Href))
	if author != "" && strings.EqualFold(author, ticketEmail) {
		return "inbound", "customer"
	}
	if strings.Contains(strings.ToLower(message.Links.Author.Href), "/customers/") {
		return "inbound", "customer"
	}
	return "outbound", "agent"
}

func grooveDoJSON(ctx context.Context, client *http.Client, baseURL string, creds GrooveCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := grooveBuildURL(baseURL, path, query)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, grooveDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, grooveResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return GrooveRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out != nil && len(body) > 0 {
		if err := json.Unmarshal(body, out); err != nil {
			return fmt.Errorf("decode groove response %s: %w", path, err)
		}
	}
	return nil
}

type GrooveRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e GrooveRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("groove REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("groove REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func grooveBuildURL(baseURL, path string, query url.Values) (*url.URL, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/"))
	if err != nil {
		return nil, fmt.Errorf("parse groove API base URL: %w", err)
	}
	rel, err := url.Parse(path)
	if err != nil {
		return nil, fmt.Errorf("parse groove request path: %w", err)
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

func groovePageCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == grooveCursorComplete {
		return 0, true
	}
	cursor = strings.TrimPrefix(cursor, grooveCursorPrefix)
	if cursor == "" {
		return 1, false
	}
	page, err := strconv.Atoi(cursor)
	if err != nil || page <= 0 {
		return 1, false
	}
	return page, false
}

func decodeGrooveCursor(cursor string) string {
	if _, done := groovePageCursor(cursor); done {
		return grooveCursorComplete
	}
	return strings.TrimPrefix(strings.TrimSpace(cursor), grooveCursorPrefix)
}

func groovePageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return grooveDefaultPageSize
	}
	if n > grooveMaxPageSize {
		return grooveMaxPageSize
	}
	return n
}

func grooveHasNextPage(p groovePagination) bool {
	return strings.TrimSpace(p.NextPage) != "" || (p.TotalPages > 0 && p.CurrentPage > 0 && p.CurrentPage < p.TotalPages)
}

func grooveTicketNumber(ticket grooveTicket) string {
	if ticket.NumberString != "" {
		return strings.TrimSpace(ticket.NumberString)
	}
	if ticket.Number > 0 {
		return strconv.Itoa(ticket.Number)
	}
	return grooveIDFromHref(ticket.Href)
}

func grooveEmailFromHref(href string) string {
	id := grooveIDFromHref(href)
	if strings.Contains(id, "@") {
		if decoded, err := url.PathUnescape(id); err == nil {
			return strings.ToLower(strings.TrimSpace(decoded))
		}
		return strings.ToLower(strings.TrimSpace(id))
	}
	return ""
}

func grooveIDFromHref(href string) string {
	href = strings.TrimSpace(href)
	if href == "" {
		return ""
	}
	if u, err := url.Parse(href); err == nil && u.Path != "" {
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) > 0 {
			id, _ := url.PathUnescape(parts[len(parts)-1])
			return strings.TrimSpace(id)
		}
	}
	parts := strings.Split(strings.Trim(href, "/"), "/")
	if len(parts) == 0 {
		return ""
	}
	id, _ := url.PathUnescape(parts[len(parts)-1])
	return strings.TrimSpace(id)
}
