// SPDX-License-Identifier: AGPL-3.0-only
//
// intercom.go — native Intercom support connector (mirrors zendesk.go).
//
// Intercom is the #2 support platform; conversations enrich profiles and drive
// retention/NPS flows. REST puller over the Conversations API (Bearer access
// token, starting_after cursor); maps each conversation's source author or
// contact identity to a canonical ticket. Dispatched from Deps.providerPull.
package support_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	intercomDefaultAPIBaseURL = "https://api.intercom.io"
	intercomDefaultUserAgent  = "Moosewave Intercom Integration"
	intercomResponseMaxBytes  = 16 << 20
	intercomDefaultPageSize   = 50
	intercomMaxPageSize       = 150
	intercomCursorPrefix      = "intercom:"
	intercomCursorComplete    = "intercom:complete"
)

var intercomHTMLTagRE = regexp.MustCompile(`<[^>]*>`)

type IntercomCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type IntercomCredentialResolver interface {
	ResolveIntercom(ctx context.Context, tenantID string, integration Integration) (IntercomCredentials, error)
}

type IntercomBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type IntercomConversationRefresher interface {
	RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error)
}

type intercomCredentialPayload struct {
	AccessToken string `json:"access_token"`
	Token       string `json:"token"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p intercomCredentialPayload) credentials() (IntercomCredentials, error) {
	token := strings.TrimSpace(firstString(p.AccessToken, p.Token))
	if token == "" {
		return IntercomCredentials{}, fmt.Errorf("intercom access_token is required")
	}
	return IntercomCredentials{
		AccessToken: token,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

type IntercomSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r IntercomSecretsCredentialResolver) ResolveIntercom(ctx context.Context, _ string, integration Integration) (IntercomCredentials, error) {
	if r.Secrets == nil {
		return IntercomCredentials{}, fmt.Errorf("intercom credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return IntercomCredentials{}, fmt.Errorf("intercom credentials_ref is required")
	}
	var payload intercomCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withIntercomRuntimeSettings(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return IntercomCredentials{}, fmt.Errorf("resolve intercom credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withIntercomRuntimeSettings(creds, integration), nil
			}
		}
	}
	creds, err := intercomCredentialPayload{AccessToken: raw}.credentials()
	if err != nil {
		return IntercomCredentials{}, err
	}
	return withIntercomRuntimeSettings(creds, integration), nil
}

func withIntercomRuntimeSettings(creds IntercomCredentials, integration Integration) IntercomCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(settingString(integration.Settings, "api_base_url"), "/")
	}
	return creds
}

type IntercomRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials IntercomCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type intercomConversationContact struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Email      string `json:"email"`
	Name       string `json:"name"`
	ExternalID string `json:"external_id"`
	Phone      string `json:"phone"`
}

type intercomContactLookupResult struct {
	Contact intercomConversationContact
	OK      bool
}

type intercomConversation struct {
	ID              string `json:"id"`
	State           string `json:"state"`
	Priority        string `json:"priority"`
	Title           string `json:"title"`
	CreatedAt       int64  `json:"created_at"`
	UpdatedAt       int64  `json:"updated_at"`
	AdminAssigneeID string `json:"admin_assignee_id"`
	TeamAssigneeID  string `json:"team_assignee_id"`
	Source          struct {
		Subject string `json:"subject"`
		Author  struct {
			Type  string `json:"type"`
			ID    string `json:"id"`
			Email string `json:"email"`
			Name  string `json:"name"`
		} `json:"author"`
		Body string `json:"body"`
	} `json:"source"`
	Contacts struct {
		Type     string                        `json:"type"`
		Contacts []intercomConversationContact `json:"contacts"`
	} `json:"contacts"`
	ConversationParts struct {
		Type              string                     `json:"type"`
		TotalCount        int                        `json:"total_count"`
		ConversationParts []intercomConversationPart `json:"conversation_parts"`
	} `json:"conversation_parts"`
}

type intercomConversationPart struct {
	ID         string `json:"id"`
	PartType   string `json:"part_type"`
	Body       string `json:"body"`
	CreatedAt  int64  `json:"created_at"`
	UpdatedAt  int64  `json:"updated_at"`
	NotifiedAt int64  `json:"notified_at"`
	Author     struct {
		Type  string `json:"type"`
		ID    string `json:"id"`
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"author"`
}

type intercomConversationsResponse struct {
	Conversations []intercomConversation `json:"conversations"`
	Pages         struct {
		Next struct {
			StartingAfter string `json:"starting_after"`
		} `json:"next"`
	} `json:"pages"`
}

func (b IntercomRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderIntercom {
		return SyncRequest{}, fmt.Errorf("intercom backfill requires an Intercom integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("intercom credential resolver is not configured")
	}
	state := decodeIntercomCursor(cursor)
	if state == intercomCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: intercomCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveIntercom(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderIntercom, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), intercomDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("per_page", strconv.Itoa(intercomPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
	if state != "" {
		query.Set("starting_after", state)
	}

	var out intercomConversationsResponse
	if err := intercomDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/conversations", query, &out); err != nil {
		return SyncRequest{}, err
	}
	tickets := make([]TicketInput, 0, len(out.Conversations))
	messages := []MessageInput{}
	contactCache := make(map[string]intercomContactLookupResult)
	for _, c := range out.Conversations {
		c, err = fetchIntercomConversationDetail(ctx, client, baseURL, creds, b.UserAgent, c)
		if err != nil {
			return SyncRequest{}, err
		}
		tk, ok, err := mapIntercomConversationWithContact(ctx, client, baseURL, creds, b.UserAgent, c, contactCache)
		if err != nil {
			return SyncRequest{}, err
		}
		if ok {
			tickets = append(tickets, tk)
			messages = append(messages, mapIntercomConversationMessages(c, tk)...)
		}
	}
	nextCursor := intercomCursorComplete
	if strings.TrimSpace(out.Pages.Next.StartingAfter) != "" {
		nextCursor = intercomCursorPrefix + strings.TrimSpace(out.Pages.Next.StartingAfter)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: nextCursor}, nil
}

func (b IntercomRESTBackfiller) RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error) {
	if integration.Provider != ProviderIntercom {
		return SyncRequest{}, fmt.Errorf("intercom refresh requires an Intercom integration")
	}
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return SyncRequest{}, fmt.Errorf("intercom conversation id is required")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("intercom credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveIntercom(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderIntercom, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), intercomDefaultAPIBaseURL)
	var c intercomConversation
	if err := intercomDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/conversations/"+url.PathEscape(conversationID), url.Values{}, &c); err != nil {
		return SyncRequest{}, err
	}
	ticket, ok, err := mapIntercomConversationWithContact(ctx, client, baseURL, creds, b.UserAgent, c, make(map[string]intercomContactLookupResult))
	if err != nil {
		return SyncRequest{}, err
	}
	cursor := "intercom-webhook-" + conversationID
	if !ok {
		return SyncRequest{RunMode: "webhook", Cursor: cursor}, nil
	}
	return normalizeSyncRequest(SyncRequest{
		RunMode:  "webhook",
		Tickets:  []TicketInput{ticket},
		Messages: mapIntercomConversationMessages(c, ticket),
		Cursor:   cursor,
	}), nil
}

func mapIntercomConversationWithContact(ctx context.Context, client *http.Client, baseURL string, creds IntercomCredentials, userAgent string, c intercomConversation, contactCache map[string]intercomContactLookupResult) (TicketInput, bool, error) {
	contact := intercomConversationPrimaryContact(c)
	if intercomConversationNeedsContactLookup(c, contact) {
		fetched, ok, err := fetchIntercomContact(ctx, client, baseURL, creds, userAgent, contact.ID, contactCache)
		if err != nil {
			return TicketInput{}, false, err
		}
		if ok {
			contact = mergeIntercomConversationContact(contact, fetched)
		}
	}
	ticket, ok := mapIntercomConversation(c, contact)
	return ticket, ok, nil
}

func mapIntercomConversation(c intercomConversation, contact intercomConversationContact) (TicketInput, bool) {
	email := strings.ToLower(strings.TrimSpace(firstString(contact.Email, intercomConversationSourceAuthorEmail(c))))
	if email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(c.ID)
	authorID := strings.TrimSpace(c.Source.Author.ID)
	authorType := strings.TrimSpace(firstString(c.Source.Author.Type, contact.Type))
	out := TicketInput{
		SourceID:       "intercom://conversation/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  strings.TrimSpace(firstString(contact.Name, intercomConversationSourceAuthorName(c))),
		Subject:        strings.TrimSpace(firstString(c.Title, c.Source.Subject)),
		Status:         strings.TrimSpace(c.State),
		Priority:       strings.TrimSpace(c.Priority),
		Properties:     map[string]any{"intercom_conversation_id": id, "intercom_author_type": authorType},
	}
	if authorID != "" {
		out.Properties["intercom_author_id"] = authorID
	}
	if contactID := strings.TrimSpace(contact.ID); contactID != "" {
		out.Properties["intercom_contact_id"] = contactID
	}
	if contactType := strings.TrimSpace(contact.Type); contactType != "" {
		out.Properties["intercom_contact_type"] = contactType
	}
	if externalID := strings.TrimSpace(contact.ExternalID); externalID != "" {
		out.Properties["intercom_contact_external_id"] = externalID
	}
	if phone := strings.TrimSpace(contact.Phone); phone != "" {
		out.Properties["intercom_contact_phone"] = phone
	}
	if adminAssigneeID := strings.TrimSpace(c.AdminAssigneeID); adminAssigneeID != "" {
		out.Properties["intercom_admin_assignee_id"] = adminAssigneeID
	}
	if teamAssigneeID := strings.TrimSpace(c.TeamAssigneeID); teamAssigneeID != "" {
		out.Properties["intercom_team_assignee_id"] = teamAssigneeID
	}
	if c.ConversationParts.TotalCount > 0 {
		out.Properties["intercom_conversation_parts_total_count"] = c.ConversationParts.TotalCount
	}
	if c.ConversationParts.TotalCount >= 500 {
		out.Properties["intercom_conversation_parts_provider_limit"] = "intercom_returns_most_recent_500_parts"
	}
	if c.UpdatedAt > 0 {
		t := time.Unix(c.UpdatedAt, 0).UTC()
		out.UpdatedAt = &t
	}
	return out, true
}

func mapIntercomConversationMessages(c intercomConversation, ticket TicketInput) []MessageInput {
	parts := c.ConversationParts.ConversationParts
	messages := make([]MessageInput, 0, len(parts)+1)
	if message, ok := mapIntercomConversationSourceMessage(c, ticket); ok {
		messages = append(messages, message)
	}
	for idx, part := range parts {
		if message, ok := mapIntercomConversationPart(c, part, ticket, idx); ok {
			messages = append(messages, message)
		}
	}
	return messages
}

func mapIntercomConversationSourceMessage(c intercomConversation, ticket TicketInput) (MessageInput, bool) {
	bodyHTML := strings.TrimSpace(c.Source.Body)
	bodyText := intercomPartBodyText(bodyHTML)
	if bodyHTML == "" && bodyText == "" {
		return MessageInput{}, false
	}
	direction, senderType := intercomSourceAuthorDirection(c)
	out := MessageInput{
		SourceID:       "intercom://conversation/" + strings.TrimSpace(c.ID) + "/source",
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender: strings.TrimSpace(firstString(
			c.Source.Author.Name,
			c.Source.Author.Email,
			ticket.RequesterName,
		)),
		BodyText: bodyText,
		BodyHTML: bodyHTML,
		Properties: map[string]any{
			"intercom_conversation_id":  strings.TrimSpace(c.ID),
			"intercom_message_kind":     "source",
			"intercom_author_id":        strings.TrimSpace(c.Source.Author.ID),
			"intercom_author_type":      strings.TrimSpace(c.Source.Author.Type),
			"intercom_source_author_id": strings.TrimSpace(c.Source.Author.ID),
		},
		OccurredAt: intercomUnixTime(firstPositiveInt64(c.CreatedAt, c.UpdatedAt)),
	}
	return out, true
}

func mapIntercomConversationPart(c intercomConversation, part intercomConversationPart, ticket TicketInput, index int) (MessageInput, bool) {
	bodyHTML := strings.TrimSpace(part.Body)
	bodyText := intercomPartBodyText(bodyHTML)
	if bodyHTML == "" && bodyText == "" {
		return MessageInput{}, false
	}
	partID := strings.TrimSpace(part.ID)
	sourceID := "intercom://conversation_part/" + firstString(partID, strings.TrimSpace(c.ID)+"/"+strconv.Itoa(index+1))
	direction, senderType := intercomConversationPartDirection(part)
	out := MessageInput{
		SourceID:       sourceID,
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender: strings.TrimSpace(firstString(
			part.Author.Name,
			part.Author.Email,
			ticket.RequesterName,
		)),
		BodyText: bodyText,
		BodyHTML: bodyHTML,
		Properties: map[string]any{
			"intercom_conversation_id":      strings.TrimSpace(c.ID),
			"intercom_conversation_part_id": partID,
			"intercom_part_type":            strings.TrimSpace(part.PartType),
			"intercom_author_id":            strings.TrimSpace(part.Author.ID),
			"intercom_author_type":          strings.TrimSpace(part.Author.Type),
			"provider_raw":                  intercomConversationPartRaw(part),
		},
		OccurredAt: intercomUnixTime(part.CreatedAt),
	}
	if part.UpdatedAt > 0 {
		out.Properties["intercom_part_updated_at"] = part.UpdatedAt
	}
	if part.NotifiedAt > 0 {
		out.Properties["intercom_part_notified_at"] = part.NotifiedAt
	}
	return out, true
}

func intercomSourceAuthorDirection(c intercomConversation) (string, string) {
	authorType := strings.ToLower(strings.TrimSpace(c.Source.Author.Type))
	if intercomAuthorTypeIsStaff(authorType) {
		if authorType == "bot" || authorType == "app" || authorType == "operator" {
			return "outbound", "system"
		}
		return "outbound", "agent"
	}
	return "inbound", "customer"
}

func intercomConversationPartDirection(part intercomConversationPart) (string, string) {
	partType := strings.ToLower(strings.TrimSpace(part.PartType))
	authorType := strings.ToLower(strings.TrimSpace(part.Author.Type))
	if partType == "note" {
		return "internal", "agent"
	}
	if intercomAuthorTypeIsStaff(authorType) {
		if authorType == "bot" || authorType == "app" || authorType == "operator" {
			return "outbound", "system"
		}
		return "outbound", "agent"
	}
	return "inbound", "customer"
}

func intercomConversationSourceAuthorEmail(c intercomConversation) string {
	if intercomConversationSourceAuthorIsStaff(c) {
		return ""
	}
	return strings.TrimSpace(c.Source.Author.Email)
}

func intercomConversationSourceAuthorName(c intercomConversation) string {
	if intercomConversationSourceAuthorIsStaff(c) {
		return ""
	}
	return strings.TrimSpace(c.Source.Author.Name)
}

func intercomConversationSourceAuthorIsStaff(c intercomConversation) bool {
	return intercomAuthorTypeIsStaff(c.Source.Author.Type)
}

func intercomAuthorTypeIsStaff(authorType string) bool {
	switch strings.ToLower(strings.TrimSpace(authorType)) {
	case "admin", "agent", "app", "bot", "operator", "team", "teammate":
		return true
	default:
		return false
	}
}

func firstPositiveInt64(values ...int64) int64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func intercomPartBodyText(body string) string {
	body = strings.TrimSpace(body)
	if body == "" {
		return ""
	}
	stripped := intercomHTMLTagRE.ReplaceAllString(body, " ")
	return strings.TrimSpace(strings.Join(strings.Fields(html.UnescapeString(stripped)), " "))
}

func intercomUnixTime(value int64) *time.Time {
	if value <= 0 {
		return nil
	}
	t := time.Unix(value, 0).UTC()
	return &t
}

func intercomConversationPartRaw(part intercomConversationPart) map[string]any {
	raw, err := json.Marshal(part)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{}
	}
	return nonNilMap(out)
}

func intercomConversationNeedsContactLookup(c intercomConversation, contact intercomConversationContact) bool {
	return strings.TrimSpace(contact.ID) != "" && strings.TrimSpace(contact.Email) == "" && intercomConversationSourceAuthorEmail(c) == ""
}

func intercomConversationPrimaryContact(c intercomConversation) intercomConversationContact {
	for _, contact := range c.Contacts.Contacts {
		if strings.TrimSpace(contact.Email) != "" {
			return contact
		}
	}
	for _, contact := range c.Contacts.Contacts {
		if strings.TrimSpace(contact.ID) != "" || strings.TrimSpace(contact.Name) != "" {
			return contact
		}
	}
	return intercomConversationContact{}
}

func mergeIntercomConversationContact(base, enriched intercomConversationContact) intercomConversationContact {
	return intercomConversationContact{
		ID:         strings.TrimSpace(firstString(enriched.ID, base.ID)),
		Type:       strings.TrimSpace(firstString(enriched.Type, base.Type)),
		Email:      strings.TrimSpace(firstString(enriched.Email, base.Email)),
		Name:       strings.TrimSpace(firstString(enriched.Name, base.Name)),
		ExternalID: strings.TrimSpace(firstString(enriched.ExternalID, base.ExternalID)),
		Phone:      strings.TrimSpace(firstString(enriched.Phone, base.Phone)),
	}
}

func fetchIntercomContact(ctx context.Context, client *http.Client, baseURL string, creds IntercomCredentials, userAgent, contactID string, cache map[string]intercomContactLookupResult) (intercomConversationContact, bool, error) {
	contactID = strings.TrimSpace(contactID)
	if contactID == "" {
		return intercomConversationContact{}, false, nil
	}
	if cached, ok := cache[contactID]; ok {
		return cached.Contact, cached.OK, nil
	}
	var out intercomConversationContact
	err := intercomDoJSON(ctx, client, baseURL, creds, userAgent, "/contacts/"+url.PathEscape(contactID), url.Values{}, &out)
	if err != nil {
		var providerErr IntercomRESTError
		if errors.As(err, &providerErr) && (providerErr.StatusCode == http.StatusUnauthorized || providerErr.StatusCode == http.StatusForbidden || providerErr.StatusCode == http.StatusNotFound) {
			cache[contactID] = intercomContactLookupResult{}
			return intercomConversationContact{}, false, nil
		}
		return intercomConversationContact{}, false, err
	}
	out = mergeIntercomConversationContact(intercomConversationContact{ID: contactID}, out)
	ok := strings.TrimSpace(out.Email) != "" || strings.TrimSpace(out.Name) != "" || strings.TrimSpace(out.ExternalID) != "" || strings.TrimSpace(out.Phone) != ""
	cache[contactID] = intercomContactLookupResult{Contact: out, OK: ok}
	return out, ok, nil
}

func fetchIntercomConversationDetail(ctx context.Context, client *http.Client, baseURL string, creds IntercomCredentials, userAgent string, base intercomConversation) (intercomConversation, error) {
	conversationID := strings.TrimSpace(base.ID)
	if conversationID == "" {
		return base, nil
	}
	var detail intercomConversation
	if err := intercomDoJSON(ctx, client, baseURL, creds, userAgent, "/conversations/"+url.PathEscape(conversationID), url.Values{}, &detail); err != nil {
		return intercomConversation{}, err
	}
	return mergeIntercomConversationDetail(base, detail), nil
}

func mergeIntercomConversationDetail(base, detail intercomConversation) intercomConversation {
	if strings.TrimSpace(detail.ID) == "" {
		return base
	}
	if strings.TrimSpace(detail.State) == "" {
		detail.State = base.State
	}
	if strings.TrimSpace(detail.Priority) == "" {
		detail.Priority = base.Priority
	}
	if strings.TrimSpace(detail.Title) == "" {
		detail.Title = base.Title
	}
	if detail.CreatedAt == 0 {
		detail.CreatedAt = base.CreatedAt
	}
	if detail.UpdatedAt == 0 {
		detail.UpdatedAt = base.UpdatedAt
	}
	if strings.TrimSpace(detail.AdminAssigneeID) == "" {
		detail.AdminAssigneeID = base.AdminAssigneeID
	}
	if strings.TrimSpace(detail.TeamAssigneeID) == "" {
		detail.TeamAssigneeID = base.TeamAssigneeID
	}
	if strings.TrimSpace(detail.Source.Body) == "" &&
		strings.TrimSpace(detail.Source.Subject) == "" &&
		strings.TrimSpace(detail.Source.Author.ID) == "" &&
		strings.TrimSpace(detail.Source.Author.Email) == "" {
		detail.Source = base.Source
	}
	if len(detail.Contacts.Contacts) == 0 {
		detail.Contacts = base.Contacts
	}
	if len(detail.ConversationParts.ConversationParts) == 0 && detail.ConversationParts.TotalCount == 0 {
		detail.ConversationParts = base.ConversationParts
	}
	return detail
}

func intercomDoJSON(ctx context.Context, client *http.Client, baseURL string, creds IntercomCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse intercom API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Intercom-Version", "2.11")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, intercomDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, intercomResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return IntercomRESTError{StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode intercom response %s: %w", path, err)
	}
	return nil
}

type IntercomRESTError struct {
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e IntercomRESTError) Error() string {
	if e.Snippet == "" {
		return fmt.Sprintf("intercom REST failed %d", e.StatusCode)
	}
	return fmt.Sprintf("intercom REST failed %d: %s", e.StatusCode, e.Snippet)
}

func decodeIntercomCursor(cursor string) string {
	cursor = strings.TrimSpace(cursor)
	if cursor == intercomCursorComplete {
		return cursor
	}
	return strings.TrimSpace(strings.TrimPrefix(cursor, intercomCursorPrefix))
}

func intercomPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return intercomDefaultPageSize
	}
	if n > intercomMaxPageSize {
		return intercomMaxPageSize
	}
	return n
}
