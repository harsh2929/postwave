// SPDX-License-Identifier: AGPL-3.0-only
//
// helpscout.go — native Help Scout provider runtime.
//
// Help Scout is a very-high-demand DTC helpdesk. Mailbox API 2.0 authenticates
// via OAuth2 client-credentials (exchange client_id/secret for a bearer token),
// then conversations and threads are pulled with HAL pagination. Maps to
// canonical TicketInput and MessageInput rows dispatched via providerPull.
package support_integrations

import (
	"bytes"
	"context"
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
	helpScoutDefaultAPIBaseURL = "https://api.helpscout.net"
	helpScoutDefaultUserAgent  = "Moosewave Help Scout Integration"
	helpScoutResponseMaxBytes  = 16 << 20
	helpScoutCursorPrefix      = "help-scout:"
	helpScoutCursorComplete    = "help-scout:complete"
)

type HelpScoutCredentials struct {
	ClientID     string
	ClientSecret string
	APIBaseURL   string
	UserAgent    string
}

type HelpScoutCredentialResolver interface {
	ResolveHelpScout(ctx context.Context, tenantID string, integration Integration) (HelpScoutCredentials, error)
}

type helpScoutCredentialPayload struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	APIBaseURL   string `json:"api_base_url"`
	UserAgent    string `json:"user_agent"`
}

func (p helpScoutCredentialPayload) credentials() (HelpScoutCredentials, error) {
	id := strings.TrimSpace(p.ClientID)
	secret := strings.TrimSpace(p.ClientSecret)
	if id == "" || secret == "" {
		return HelpScoutCredentials{}, fmt.Errorf("help scout client_id and client_secret are required")
	}
	return HelpScoutCredentials{ClientID: id, ClientSecret: secret, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type HelpScoutSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r HelpScoutSecretsCredentialResolver) ResolveHelpScout(ctx context.Context, _ string, integration Integration) (HelpScoutCredentials, error) {
	if r.Secrets == nil {
		return HelpScoutCredentials{}, fmt.Errorf("help scout credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return HelpScoutCredentials{}, fmt.Errorf("help scout credentials_ref is required")
	}
	var payload helpScoutCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withHelpScoutBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return HelpScoutCredentials{}, fmt.Errorf("resolve help scout credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withHelpScoutBaseURL(creds, integration), nil
			}
		}
	}
	return HelpScoutCredentials{}, fmt.Errorf("help scout requires a JSON {client_id, client_secret} secret")
}

func withHelpScoutBaseURL(creds HelpScoutCredentials, integration Integration) HelpScoutCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type HelpScoutBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type HelpScoutConversationRefresher interface {
	RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error)
}

type HelpScoutRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials HelpScoutCredentialResolver
	APIBaseURL  string
	UserAgent   string
}

type helpScoutConversation struct {
	ID              json.Number `json:"id"`
	Number          json.Number `json:"number"`
	MailboxID       json.Number `json:"mailboxId"`
	Subject         string      `json:"subject"`
	Status          string      `json:"status"`
	Preview         string      `json:"preview"`
	CreatedAt       string      `json:"createdAt"`
	ClosedAt        string      `json:"closedAt"`
	PrimaryCustomer struct {
		ID    json.Number `json:"id"`
		Email string      `json:"email"`
		First string      `json:"first"`
		Last  string      `json:"last"`
	} `json:"primaryCustomer"`
	Tags []struct {
		Tag string `json:"tag"`
	} `json:"tags"`
	UserUpdatedAt string `json:"userUpdatedAt"`
	Embedded      struct {
		Threads []helpScoutThread `json:"threads"`
	} `json:"_embedded"`
}

type helpScoutPerson struct {
	ID    json.Number `json:"id"`
	Type  string      `json:"type"`
	Email string      `json:"email"`
	First string      `json:"first"`
	Last  string      `json:"last"`
}

type helpScoutThread struct {
	ID     json.Number `json:"id"`
	Type   string      `json:"type"`
	Status string      `json:"status"`
	State  string      `json:"state"`
	Action struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"action"`
	Body   string `json:"body"`
	Source struct {
		Type string `json:"type"`
		Via  string `json:"via"`
	} `json:"source"`
	Customer   helpScoutPerson `json:"customer"`
	CreatedBy  helpScoutPerson `json:"createdBy"`
	AssignedTo helpScoutPerson `json:"assignedTo"`
	CreatedAt  string          `json:"createdAt"`
	OpenedAt   string          `json:"openedAt"`
	Rating     struct {
		CustomerID json.Number `json:"customerId"`
		Rating     string      `json:"rating"`
		Comments   string      `json:"comments"`
	} `json:"rating"`
}

type helpScoutConversationsResponse struct {
	Embedded struct {
		Conversations []helpScoutConversation `json:"conversations"`
	} `json:"_embedded"`
	Page struct {
		Number     int `json:"number"`
		TotalPages int `json:"totalPages"`
	} `json:"page"`
}

type helpScoutThreadsResponse struct {
	Embedded struct {
		Threads []helpScoutThread `json:"threads"`
	} `json:"_embedded"`
	Page struct {
		Number     int `json:"number"`
		TotalPages int `json:"totalPages"`
	} `json:"page"`
}

func (b HelpScoutRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderHelpScout {
		return SyncRequest{}, fmt.Errorf("help scout backfill requires a Help Scout integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("help scout credential resolver is not configured")
	}
	page, done := helpScoutPageCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: helpScoutCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveHelpScout(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderHelpScout, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), helpScoutDefaultAPIBaseURL)
	token, err := helpScoutAccessToken(ctx, client, baseURL, creds, b.UserAgent)
	if err != nil {
		return SyncRequest{}, err
	}
	query := url.Values{}
	query.Set("status", firstString(settingString(integration.Settings, "status"), "all"))
	query.Set("page", strconv.Itoa(page))
	query.Set("sortField", "modifiedAt")
	query.Set("sortOrder", "desc")
	query.Set("embed", "threads")
	if mailbox := strings.TrimSpace(settingString(integration.Settings, "mailbox_id")); mailbox != "" {
		query.Set("mailbox", mailbox)
	}

	var out helpScoutConversationsResponse
	if err := helpScoutDoJSON(ctx, client, baseURL, token, b.UserAgent, creds.UserAgent, "/v2/conversations", query, &out); err != nil {
		return SyncRequest{}, err
	}
	tickets := make([]TicketInput, 0, len(out.Embedded.Conversations))
	messages := []MessageInput{}
	for _, c := range out.Embedded.Conversations {
		ticket, threadMessages, ok, err := mapHelpScoutConversationWithThreads(ctx, client, baseURL, token, b.UserAgent, creds.UserAgent, c)
		if err != nil {
			return SyncRequest{}, err
		}
		if !ok {
			continue
		}
		tickets = append(tickets, ticket)
		messages = append(messages, threadMessages...)
	}
	nextCursor := helpScoutCursorComplete
	if out.Page.TotalPages > page && len(out.Embedded.Conversations) > 0 {
		nextCursor = helpScoutCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: nextCursor}, nil
}

func (b HelpScoutRESTBackfiller) RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error) {
	if integration.Provider != ProviderHelpScout {
		return SyncRequest{}, fmt.Errorf("help scout refresh requires a Help Scout integration")
	}
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return SyncRequest{}, fmt.Errorf("help scout conversation id is required")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("help scout credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveHelpScout(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderHelpScout, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), helpScoutDefaultAPIBaseURL)
	token, err := helpScoutAccessToken(ctx, client, baseURL, creds, b.UserAgent)
	if err != nil {
		return SyncRequest{}, err
	}
	query := url.Values{}
	query.Set("embed", "threads")
	var c helpScoutConversation
	if err := helpScoutDoJSON(ctx, client, baseURL, token, b.UserAgent, creds.UserAgent, "/v2/conversations/"+url.PathEscape(conversationID), query, &c); err != nil {
		return SyncRequest{}, err
	}
	ticket, messages, ok, err := mapHelpScoutConversationWithThreads(ctx, client, baseURL, token, b.UserAgent, creds.UserAgent, c)
	if err != nil {
		return SyncRequest{}, err
	}
	cursor := "help-scout-webhook-" + conversationID
	if !ok {
		return SyncRequest{RunMode: "webhook", Cursor: cursor}, nil
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: cursor}), nil
}

func mapHelpScoutConversationWithThreads(ctx context.Context, client *http.Client, baseURL, token, userAgent, credUserAgent string, c helpScoutConversation) (TicketInput, []MessageInput, bool, error) {
	threads := c.Embedded.Threads
	if len(threads) == 0 {
		var err error
		threads, err = fetchHelpScoutThreads(ctx, client, baseURL, token, userAgent, credUserAgent, helpScoutConversationID(c))
		if err != nil {
			return TicketInput{}, nil, false, err
		}
	}
	ticket, ok := mapHelpScoutConversation(c, helpScoutThreadCustomerIdentity(threads))
	if !ok {
		return TicketInput{}, nil, false, nil
	}
	messages := make([]MessageInput, 0, len(threads))
	for _, thread := range threads {
		if message, ok := mapHelpScoutThread(thread, ticket); ok {
			messages = append(messages, message)
		}
	}
	return ticket, messages, true, nil
}

func mapHelpScoutConversation(c helpScoutConversation, fallback helpScoutPerson) (TicketInput, bool) {
	email := strings.ToLower(strings.TrimSpace(firstString(c.PrimaryCustomer.Email, fallback.Email)))
	if email == "" {
		return TicketInput{}, false
	}
	id := helpScoutConversationID(c)
	tags := make([]string, 0, len(c.Tags))
	for _, t := range c.Tags {
		if v := strings.TrimSpace(t.Tag); v != "" {
			tags = append(tags, v)
		}
	}
	out := TicketInput{
		SourceID:       "help-scout://conversation/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  strings.TrimSpace(firstString(helpScoutName(c.PrimaryCustomer.First, c.PrimaryCustomer.Last), helpScoutPersonName(fallback))),
		Subject:        strings.TrimSpace(c.Subject),
		Status:         strings.TrimSpace(c.Status),
		Tags:           tags,
		Properties:     map[string]any{"help_scout_conversation_id": id},
	}
	if customerID := strings.TrimSpace(firstString(c.PrimaryCustomer.ID.String(), fallback.ID.String())); customerID != "" {
		out.Properties["help_scout_customer_id"] = customerID
	}
	if number := strings.TrimSpace(c.Number.String()); number != "" {
		out.Properties["help_scout_conversation_number"] = number
	}
	if mailboxID := strings.TrimSpace(c.MailboxID.String()); mailboxID != "" {
		out.Properties["help_scout_mailbox_id"] = mailboxID
	}
	if preview := strings.TrimSpace(c.Preview); preview != "" {
		out.Properties["help_scout_preview"] = preview
	}
	if createdAt := strings.TrimSpace(c.CreatedAt); createdAt != "" {
		out.Properties["help_scout_created_at"] = createdAt
	}
	if closedAt := strings.TrimSpace(c.ClosedAt); closedAt != "" {
		out.Properties["help_scout_closed_at"] = closedAt
	}
	if t := parseZendeskTime(c.UserUpdatedAt); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func fetchHelpScoutThreads(ctx context.Context, client *http.Client, baseURL, token, userAgent, credUserAgent, conversationID string) ([]helpScoutThread, error) {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return nil, nil
	}
	threads := []helpScoutThread{}
	for page := 1; ; page++ {
		query := url.Values{}
		query.Set("page", strconv.Itoa(page))
		var out helpScoutThreadsResponse
		path := "/v2/conversations/" + url.PathEscape(conversationID) + "/threads"
		if err := helpScoutDoJSON(ctx, client, baseURL, token, userAgent, credUserAgent, path, query, &out); err != nil {
			var providerErr HelpScoutRESTError
			if errors.As(err, &providerErr) && providerErr.StatusCode == http.StatusNotFound {
				return threads, nil
			}
			return nil, err
		}
		threads = append(threads, out.Embedded.Threads...)
		if out.Page.TotalPages <= page || len(out.Embedded.Threads) == 0 {
			break
		}
	}
	return threads, nil
}

func mapHelpScoutThread(thread helpScoutThread, ticket TicketInput) (MessageInput, bool) {
	body := strings.TrimSpace(firstString(thread.Body, thread.Action.Text))
	threadID := strings.TrimSpace(thread.ID.String())
	if body == "" && threadID == "" {
		return MessageInput{}, false
	}
	sourceID := "help-scout://thread/" + firstString(threadID, ticket.ConversationID+"-"+strings.TrimSpace(thread.CreatedAt)+"-"+strings.TrimSpace(thread.Type))
	direction, senderType := helpScoutThreadDirection(thread)
	return MessageInput{
		SourceID:       sourceID,
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender: strings.TrimSpace(firstString(
			helpScoutPersonName(thread.CreatedBy),
			helpScoutPersonName(thread.Customer),
			ticket.RequesterName,
		)),
		BodyText: body,
		BodyHTML: body,
		Properties: map[string]any{
			"help_scout_conversation_id": ticket.ConversationID,
			"help_scout_thread_id":       threadID,
			"help_scout_thread_type":     strings.TrimSpace(thread.Type),
			"help_scout_thread_status":   strings.TrimSpace(thread.Status),
			"help_scout_thread_state":    strings.TrimSpace(thread.State),
			"help_scout_source_type":     strings.TrimSpace(thread.Source.Type),
			"help_scout_source_via":      strings.TrimSpace(thread.Source.Via),
			"help_scout_created_by_type": strings.TrimSpace(thread.CreatedBy.Type),
			"help_scout_created_by_id":   strings.TrimSpace(thread.CreatedBy.ID.String()),
			"help_scout_customer_id":     strings.TrimSpace(thread.Customer.ID.String()),
			"help_scout_assigned_to_id":  strings.TrimSpace(thread.AssignedTo.ID.String()),
			"help_scout_rating":          strings.TrimSpace(thread.Rating.Rating),
		},
		OccurredAt: parseZendeskTime(thread.CreatedAt),
	}, true
}

func helpScoutThreadDirection(thread helpScoutThread) (string, string) {
	threadType := strings.ToLower(strings.TrimSpace(thread.Type))
	via := strings.ToLower(strings.TrimSpace(thread.Source.Via))
	createdByType := strings.ToLower(strings.TrimSpace(thread.CreatedBy.Type))
	if threadType == "note" {
		return "internal", "agent"
	}
	if via == "user" || createdByType == "user" || createdByType == "system_user" || threadType == "message" {
		if createdByType == "system_user" {
			return "outbound", "system"
		}
		return "outbound", "agent"
	}
	return "inbound", "customer"
}

func helpScoutThreadCustomerIdentity(threads []helpScoutThread) helpScoutPerson {
	for _, thread := range threads {
		if strings.TrimSpace(thread.Customer.Email) != "" {
			return thread.Customer
		}
	}
	for _, thread := range threads {
		if strings.EqualFold(strings.TrimSpace(thread.CreatedBy.Type), "customer") && strings.TrimSpace(thread.CreatedBy.Email) != "" {
			return thread.CreatedBy
		}
	}
	return helpScoutPerson{}
}

func helpScoutConversationID(c helpScoutConversation) string {
	return strings.TrimSpace(c.ID.String())
}

func helpScoutPersonName(person helpScoutPerson) string {
	return helpScoutName(person.First, person.Last)
}

func helpScoutName(first, last string) string {
	return strings.TrimSpace(strings.TrimSpace(first) + " " + strings.TrimSpace(last))
}

func helpScoutAccessToken(ctx context.Context, client *http.Client, baseURL string, creds HelpScoutCredentials, userAgent string) (string, error) {
	payload, _ := json.Marshal(map[string]string{"grant_type": "client_credentials", "client_id": creds.ClientID, "client_secret": creds.ClientSecret})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/v2/oauth2/token", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, helpScoutDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, helpScoutResponseMaxBytes))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", HelpScoutRESTError{StatusCode: resp.StatusCode, RetryAfter: parseHelpScoutRetryAfter(resp.Header), Snippet: zendeskTruncate(string(body), 300)}
	}
	var raw struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return "", fmt.Errorf("decode help scout token: %w", err)
	}
	if strings.TrimSpace(raw.AccessToken) == "" {
		return "", fmt.Errorf("help scout token response missing access_token")
	}
	return strings.TrimSpace(raw.AccessToken), nil
}

func helpScoutDoJSON(ctx context.Context, client *http.Client, baseURL, token, userAgent, credUserAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse help scout API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, credUserAgent, helpScoutDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, helpScoutResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return HelpScoutRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseHelpScoutRetryAfter(resp.Header), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode help scout response %s: %w", path, err)
	}
	return nil
}

type HelpScoutRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e HelpScoutRESTError) Error() string {
	if e.Path == "" {
		if e.Snippet == "" {
			return fmt.Sprintf("help scout REST failed %d", e.StatusCode)
		}
		return fmt.Sprintf("help scout REST failed %d: %s", e.StatusCode, e.Snippet)
	}
	if e.Snippet == "" {
		return fmt.Sprintf("help scout REST %s failed %d", e.Path, e.StatusCode)
	}
	return fmt.Sprintf("help scout REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func parseHelpScoutRetryAfter(header http.Header) time.Duration {
	if header == nil {
		return 0
	}
	if retry := parseZendeskRetryAfter(header.Get("X-RateLimit-Retry-After")); retry > 0 {
		return retry
	}
	return parseZendeskRetryAfter(header.Get("Retry-After"))
}

func helpScoutPageCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == helpScoutCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, helpScoutCursorPrefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}

func decodeHelpScoutCursor(cursor string) string {
	page, done := helpScoutPageCursor(cursor)
	if done {
		return helpScoutCursorComplete
	}
	if page <= 1 {
		return ""
	}
	return strconv.Itoa(page)
}
