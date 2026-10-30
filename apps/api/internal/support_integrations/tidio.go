// SPDX-License-Identifier: AGPL-3.0-only
//
// tidio.go — native Tidio provider runtime.
//
// Tidio exposes OpenAPI with client-id/client-secret headers. We use tickets as
// the primary support object, then walk contacts/messages as a secondary
// conversation source once ticket pages complete.
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
	"strings"
	"time"
)

const (
	tidioDefaultAPIBaseURL     = "https://api.tidio.com"
	tidioDefaultUserAgent      = "Moosewave Tidio Integration"
	tidioResponseMaxBytes      = 16 << 20
	tidioTicketsCursorPrefix   = "tidio:tickets:"
	tidioContactsCursorPrefix  = "tidio:contacts:"
	tidioCursorComplete        = "tidio:complete"
	tidioContactConversationID = "contact:"
)

type TidioCredentials struct {
	ClientID     string
	ClientSecret string
	APIBaseURL   string
	UserAgent    string
}

type TidioCredentialResolver interface {
	ResolveTidio(ctx context.Context, tenantID string, integration Integration) (TidioCredentials, error)
}

type tidioCredentialPayload struct {
	ClientID             string `json:"client_id"`
	ClientSecret         string `json:"client_secret"`
	OpenAPIClientID      string `json:"openapi_client_id"`
	OpenAPIClientSecret  string `json:"openapi_client_secret"`
	TidioOpenAPIClientID string `json:"tidio_openapi_client_id"`
	TidioOpenAPISecret   string `json:"tidio_openapi_client_secret"`
	XTidioClientID       string `json:"x_tidio_openapi_client_id"`
	XTidioClientSecret   string `json:"x_tidio_openapi_client_secret"`
	APIBaseURL           string `json:"api_base_url"`
	UserAgent            string `json:"user_agent"`
}

func (p tidioCredentialPayload) credentials() (TidioCredentials, error) {
	clientID := strings.TrimSpace(firstString(p.ClientID, p.OpenAPIClientID, p.TidioOpenAPIClientID, p.XTidioClientID))
	clientSecret := strings.TrimSpace(firstString(p.ClientSecret, p.OpenAPIClientSecret, p.TidioOpenAPISecret, p.XTidioClientSecret))
	if clientID == "" || clientSecret == "" {
		return TidioCredentials{}, fmt.Errorf("tidio client_id and client_secret are required")
	}
	return TidioCredentials{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		APIBaseURL:   strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:    strings.TrimSpace(p.UserAgent),
	}, nil
}

type TidioSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r TidioSecretsCredentialResolver) ResolveTidio(ctx context.Context, _ string, integration Integration) (TidioCredentials, error) {
	if r.Secrets == nil {
		return TidioCredentials{}, fmt.Errorf("tidio credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return TidioCredentials{}, fmt.Errorf("tidio credentials_ref is required")
	}
	var payload tidioCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withTidioSettings(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return TidioCredentials{}, fmt.Errorf("resolve tidio credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withTidioSettings(creds, integration), nil
			}
		}
	}
	if clientID, clientSecret, ok := strings.Cut(raw, ":"); ok {
		creds, err := tidioCredentialPayload{ClientID: clientID, ClientSecret: clientSecret}.credentials()
		if err != nil {
			return TidioCredentials{}, err
		}
		return withTidioSettings(creds, integration), nil
	}
	return TidioCredentials{}, fmt.Errorf("tidio requires a JSON {client_id, client_secret} secret")
}

func withTidioSettings(creds TidioCredentials, integration Integration) TidioCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type TidioBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type TidioConversationRefresher interface {
	RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketID string) (SyncRequest, error)
	RefreshContactConversation(ctx context.Context, tenantID string, integration Integration, contactID string) (SyncRequest, error)
}

type TidioRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials TidioCredentialResolver
	APIBaseURL  string
	UserAgent   string
}

type tidioMeta struct {
	Cursor *string `json:"cursor"`
	Limit  int     `json:"limit"`
}

type tidioContactsResponse struct {
	Contacts        []tidioContact `json:"contacts"`
	Resources       []tidioContact `json:"resources"`
	Meta            tidioMeta      `json:"meta"`
	ConversationURL string         `json:"conversation_url"`
}

type tidioContact struct {
	ID         string         `json:"id"`
	DistinctID string         `json:"distinct_id"`
	FirstName  string         `json:"first_name"`
	LastName   string         `json:"last_name"`
	Email      string         `json:"email"`
	Phone      string         `json:"phone"`
	Language   string         `json:"language"`
	Country    string         `json:"country"`
	City       string         `json:"city"`
	Properties map[string]any `json:"properties"`
}

type tidioContactMessagesResponse struct {
	Messages        []tidioContactMessage `json:"messages"`
	Resources       []tidioContactMessage `json:"resources"`
	ConversationURL string                `json:"conversation_url"`
	Meta            tidioMeta             `json:"meta"`
}

type tidioContactMessage struct {
	ID         string `json:"id"`
	AuthorType string `json:"author_type"`
	AuthorID   string `json:"author_id"`
	Message    string `json:"message"`
	CreatedAt  string `json:"created_at"`
}

type tidioTicketsResponse struct {
	Tickets   []tidioTicket `json:"tickets"`
	Resources []tidioTicket `json:"resources"`
	Meta      tidioMeta     `json:"meta"`
}

type tidioTicket struct {
	ID                   string               `json:"id"`
	Link                 string               `json:"link"`
	Subject              string               `json:"subject"`
	ContactID            string               `json:"contact_id"`
	ContactEmail         string               `json:"contact_email"`
	Priority             string               `json:"priority"`
	Status               string               `json:"status"`
	AssignedOperatorID   string               `json:"assigned_operator_id"`
	AssignedDepartmentID string               `json:"assigned_department_id"`
	CustomChannelID      string               `json:"custom_channel_id"`
	Messages             []tidioTicketMessage `json:"messages"`
	CreatedAt            string               `json:"created_at"`
	UpdatedAt            string               `json:"updated_at"`
}

type tidioTicketMessage struct {
	MessageID  string `json:"message_id"`
	ID         string `json:"id"`
	CreatedAt  string `json:"created_at"`
	AuthorType string `json:"author_type"`
	AuthorID   string `json:"author_id"`
	SenderType string `json:"sender_type"`
	Message    string `json:"message"`
	Body       string `json:"body"`
	Text       string `json:"text"`
	Content    string `json:"content"`
	Internal   bool   `json:"internal"`
}

func (b TidioRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderTidio {
		return SyncRequest{}, fmt.Errorf("tidio backfill requires a Tidio integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("tidio credential resolver is not configured")
	}
	stage, providerCursor, done := tidioBackfillCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: tidioCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveTidio(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderTidio, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), tidioDefaultAPIBaseURL)
	if stage == "" {
		stage = "tickets"
	}

	switch stage {
	case "tickets":
		req, nextCursor, done, err := b.backfillTidioTicketsPage(ctx, client, baseURL, creds, integration, providerCursor)
		if err != nil {
			return SyncRequest{}, err
		}
		if !done {
			req.Cursor = tidioEncodeCursor("tickets", nextCursor)
			return req, nil
		}
		contactsReq, contactsCursor, contactsDone, err := b.backfillTidioContactsPage(ctx, client, baseURL, creds, integration, "")
		if err != nil {
			return SyncRequest{}, err
		}
		req.Tickets = append(req.Tickets, contactsReq.Tickets...)
		req.Messages = append(req.Messages, contactsReq.Messages...)
		if contactsDone {
			req.Cursor = tidioCursorComplete
		} else {
			req.Cursor = tidioEncodeCursor("contacts", contactsCursor)
		}
		req.RunMode = "backfill"
		return normalizeSyncRequest(req), nil
	case "contacts":
		req, nextCursor, done, err := b.backfillTidioContactsPage(ctx, client, baseURL, creds, integration, providerCursor)
		if err != nil {
			return SyncRequest{}, err
		}
		if done {
			req.Cursor = tidioCursorComplete
		} else {
			req.Cursor = tidioEncodeCursor("contacts", nextCursor)
		}
		req.RunMode = "backfill"
		return normalizeSyncRequest(req), nil
	default:
		return SyncRequest{}, fmt.Errorf("tidio cursor has unknown stage %q", stage)
	}
}

func (b TidioRESTBackfiller) RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketID string) (SyncRequest, error) {
	if integration.Provider != ProviderTidio {
		return SyncRequest{}, fmt.Errorf("tidio refresh requires a Tidio integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("tidio credential resolver is not configured")
	}
	ticketID = strings.TrimSpace(ticketID)
	if ticketID == "" {
		return SyncRequest{}, nil
	}
	creds, err := b.Credentials.ResolveTidio(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderTidio, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), tidioDefaultAPIBaseURL)
	ticket, err := b.fetchTidioTicketDetail(ctx, client, baseURL, creds, ticketID)
	if err != nil {
		return SyncRequest{}, err
	}
	if !tidioTicketAllowed(integration, ticket) {
		return SyncRequest{RunMode: "webhook"}, nil
	}
	mapped, ok := mapTidioTicket(ticket)
	if !ok {
		return SyncRequest{RunMode: "webhook"}, nil
	}
	return SyncRequest{
		RunMode:  "webhook",
		Tickets:  []TicketInput{mapped},
		Messages: mapTidioTicketMessages(ticket, mapped),
		Cursor:   "tidio-webhook-ticket-" + ticketID,
	}, nil
}

func (b TidioRESTBackfiller) RefreshContactConversation(ctx context.Context, tenantID string, integration Integration, contactID string) (SyncRequest, error) {
	if integration.Provider != ProviderTidio {
		return SyncRequest{}, fmt.Errorf("tidio refresh requires a Tidio integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("tidio credential resolver is not configured")
	}
	contactID = strings.TrimSpace(contactID)
	if contactID == "" {
		return SyncRequest{}, nil
	}
	creds, err := b.Credentials.ResolveTidio(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderTidio, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), tidioDefaultAPIBaseURL)
	contact, err := b.fetchTidioContact(ctx, client, baseURL, creds, contactID)
	if err != nil {
		return SyncRequest{}, err
	}
	messages, conversationURL, err := b.fetchTidioContactMessages(ctx, client, baseURL, creds, contactID)
	if err != nil {
		return SyncRequest{}, err
	}
	ticket, ok := mapTidioContactConversation(contact, conversationURL)
	if !ok {
		return SyncRequest{RunMode: "webhook"}, nil
	}
	return SyncRequest{
		RunMode:  "webhook",
		Tickets:  []TicketInput{ticket},
		Messages: mapTidioContactMessages(messages, ticket),
		Cursor:   "tidio-webhook-contact-" + contactID,
	}, nil
}

func (b TidioRESTBackfiller) backfillTidioTicketsPage(ctx context.Context, client *http.Client, baseURL string, creds TidioCredentials, integration Integration, cursor string) (SyncRequest, string, bool, error) {
	query := url.Values{}
	if strings.TrimSpace(cursor) != "" {
		query.Set("cursor", strings.TrimSpace(cursor))
	}
	var out tidioTicketsResponse
	if err := tidioDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/tickets", query, &out); err != nil {
		return SyncRequest{}, "", false, err
	}
	tickets := firstNonEmptyTidioTickets(out.Tickets, out.Resources)
	mappedTickets := make([]TicketInput, 0, len(tickets))
	messages := []MessageInput{}
	for _, ticket := range tickets {
		if !tidioTicketAllowed(integration, ticket) {
			continue
		}
		detail := ticket
		if id := strings.TrimSpace(ticket.ID); id != "" {
			fetched, err := b.fetchTidioTicketDetail(ctx, client, baseURL, creds, id)
			if err != nil {
				var restErr TidioRESTError
				if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusNotFound {
					return SyncRequest{}, "", false, err
				}
			} else {
				detail = mergeTidioTicket(ticket, fetched)
			}
		}
		mapped, ok := mapTidioTicket(detail)
		if !ok {
			continue
		}
		mappedTickets = append(mappedTickets, mapped)
		messages = append(messages, mapTidioTicketMessages(detail, mapped)...)
	}
	nextCursor := tidioMetaCursor(out.Meta)
	return SyncRequest{RunMode: "backfill", Tickets: mappedTickets, Messages: messages}, nextCursor, nextCursor == "", nil
}

func (b TidioRESTBackfiller) backfillTidioContactsPage(ctx context.Context, client *http.Client, baseURL string, creds TidioCredentials, _ Integration, cursor string) (SyncRequest, string, bool, error) {
	query := url.Values{}
	if strings.TrimSpace(cursor) != "" {
		query.Set("cursor", strings.TrimSpace(cursor))
	}
	var out tidioContactsResponse
	if err := tidioDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/contacts", query, &out); err != nil {
		return SyncRequest{}, "", false, err
	}
	contacts := firstNonEmptyTidioContacts(out.Contacts, out.Resources)
	tickets := make([]TicketInput, 0, len(contacts))
	messages := []MessageInput{}
	for _, contact := range contacts {
		ticket, ok := mapTidioContactConversation(contact, "")
		if !ok {
			continue
		}
		thread, conversationURL, err := b.fetchTidioContactMessages(ctx, client, baseURL, creds, contact.ID)
		if err != nil {
			var restErr TidioRESTError
			if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusNotFound {
				return SyncRequest{}, "", false, err
			}
		}
		if conversationURL != "" {
			ticket.Properties["tidio_conversation_url"] = conversationURL
		}
		tickets = append(tickets, ticket)
		messages = append(messages, mapTidioContactMessages(thread, ticket)...)
	}
	nextCursor := tidioMetaCursor(out.Meta)
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages}, nextCursor, nextCursor == "", nil
}

func (b TidioRESTBackfiller) fetchTidioTicketDetail(ctx context.Context, client *http.Client, baseURL string, creds TidioCredentials, ticketID string) (tidioTicket, error) {
	var out tidioTicket
	path := "/tickets/" + url.PathEscape(strings.TrimSpace(ticketID))
	if err := tidioDoJSON(ctx, client, baseURL, creds, b.UserAgent, path, nil, &out); err != nil {
		return tidioTicket{}, err
	}
	return out, nil
}

func (b TidioRESTBackfiller) fetchTidioContact(ctx context.Context, client *http.Client, baseURL string, creds TidioCredentials, contactID string) (tidioContact, error) {
	var out tidioContact
	path := "/contacts/" + url.PathEscape(strings.TrimSpace(contactID))
	if err := tidioDoJSON(ctx, client, baseURL, creds, b.UserAgent, path, nil, &out); err != nil {
		return tidioContact{}, err
	}
	return out, nil
}

func (b TidioRESTBackfiller) fetchTidioContactMessages(ctx context.Context, client *http.Client, baseURL string, creds TidioCredentials, contactID string) ([]tidioContactMessage, string, error) {
	contactID = strings.TrimSpace(contactID)
	if contactID == "" {
		return nil, "", nil
	}
	messages := []tidioContactMessage{}
	conversationURL := ""
	cursor := ""
	for {
		query := url.Values{}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		var out tidioContactMessagesResponse
		path := "/contacts/" + url.PathEscape(contactID) + "/messages"
		if err := tidioDoJSON(ctx, client, baseURL, creds, b.UserAgent, path, query, &out); err != nil {
			return nil, "", err
		}
		messages = append(messages, firstNonEmptyTidioContactMessages(out.Messages, out.Resources)...)
		if conversationURL == "" {
			conversationURL = strings.TrimSpace(out.ConversationURL)
		}
		cursor = tidioMetaCursor(out.Meta)
		if cursor == "" {
			break
		}
	}
	return messages, conversationURL, nil
}

func mapTidioTicket(ticket tidioTicket) (TicketInput, bool) {
	email := strings.ToLower(strings.TrimSpace(ticket.ContactEmail))
	if email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(ticket.ID)
	if id == "" {
		return TicketInput{}, false
	}
	out := TicketInput{
		SourceID:       "tidio://ticket/" + id,
		ConversationID: id,
		Email:          email,
		Subject:        strings.TrimSpace(ticket.Subject),
		Status:         strings.TrimSpace(ticket.Status),
		Priority:       strings.TrimSpace(ticket.Priority),
		Assignee:       strings.TrimSpace(ticket.AssignedOperatorID),
		Properties: map[string]any{
			"tidio_ticket_id":              id,
			"tidio_contact_id":             strings.TrimSpace(ticket.ContactID),
			"tidio_ticket_link":            strings.TrimSpace(ticket.Link),
			"tidio_assigned_operator_id":   strings.TrimSpace(ticket.AssignedOperatorID),
			"tidio_assigned_department_id": strings.TrimSpace(ticket.AssignedDepartmentID),
			"tidio_custom_channel_id":      strings.TrimSpace(ticket.CustomChannelID),
		},
	}
	if t := parseZendeskTime(firstString(ticket.UpdatedAt, ticket.CreatedAt)); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func mapTidioTicketMessages(ticket tidioTicket, supportTicket TicketInput) []MessageInput {
	if len(ticket.Messages) == 0 {
		return nil
	}
	out := make([]MessageInput, 0, len(ticket.Messages))
	for idx, msg := range ticket.Messages {
		if mapped, ok := mapTidioTicketMessage(ticket, supportTicket, msg, idx); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapTidioTicketMessage(ticket tidioTicket, supportTicket TicketInput, msg tidioTicketMessage, idx int) (MessageInput, bool) {
	body := strings.TrimSpace(firstString(msg.Message, msg.Body, msg.Text, msg.Content))
	if body == "" {
		return MessageInput{}, false
	}
	ticketID := strings.TrimSpace(firstString(ticket.ID, supportTicket.ConversationID))
	if ticketID == "" {
		return MessageInput{}, false
	}
	messageID := strings.TrimSpace(firstString(msg.MessageID, msg.ID, fmt.Sprintf("%d", idx+1)))
	direction, senderType := tidioMessageDirection(firstString(msg.AuthorType, msg.SenderType), msg.Internal)
	out := MessageInput{
		SourceID:       "tidio://ticket/" + ticketID + "/message/" + messageID,
		ConversationID: ticketID,
		Email:          supportTicket.Email,
		RequesterName:  supportTicket.RequesterName,
		Subject:        supportTicket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender:         strings.TrimSpace(firstString(msg.AuthorID, msg.AuthorType, msg.SenderType)),
		BodyText:       body,
		Properties: map[string]any{
			"tidio_ticket_id":   ticketID,
			"tidio_message_id":  messageID,
			"tidio_author_id":   strings.TrimSpace(msg.AuthorID),
			"tidio_author_type": strings.TrimSpace(firstString(msg.AuthorType, msg.SenderType)),
			"tidio_internal":    msg.Internal,
		},
	}
	if t := parseZendeskTime(msg.CreatedAt); t != nil {
		out.OccurredAt = t
	}
	return out, true
}

func mapTidioContactConversation(contact tidioContact, conversationURL string) (TicketInput, bool) {
	email := strings.ToLower(strings.TrimSpace(contact.Email))
	if email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(contact.ID)
	if id == "" {
		return TicketInput{}, false
	}
	name := strings.TrimSpace(strings.Join(cleanStrings([]string{contact.FirstName, contact.LastName}), " "))
	out := TicketInput{
		SourceID:       "tidio://contact/" + id + "/conversation",
		ConversationID: tidioContactConversationID + id,
		Email:          email,
		RequesterName:  name,
		Subject:        "Tidio conversation",
		Properties: map[string]any{
			"tidio_contact_id":         id,
			"tidio_distinct_id":        strings.TrimSpace(contact.DistinctID),
			"tidio_phone":              strings.TrimSpace(contact.Phone),
			"tidio_language":           strings.TrimSpace(contact.Language),
			"tidio_country":            strings.TrimSpace(contact.Country),
			"tidio_city":               strings.TrimSpace(contact.City),
			"tidio_contact_properties": contact.Properties,
		},
	}
	if conversationURL = strings.TrimSpace(conversationURL); conversationURL != "" {
		out.Properties["tidio_conversation_url"] = conversationURL
	}
	return out, true
}

func mapTidioContactMessages(messages []tidioContactMessage, ticket TicketInput) []MessageInput {
	if len(messages) == 0 {
		return nil
	}
	out := make([]MessageInput, 0, len(messages))
	for idx, msg := range messages {
		if mapped, ok := mapTidioContactMessage(msg, ticket, idx); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapTidioContactMessage(msg tidioContactMessage, ticket TicketInput, idx int) (MessageInput, bool) {
	body := strings.TrimSpace(msg.Message)
	if body == "" {
		return MessageInput{}, false
	}
	conversationID := strings.TrimSpace(ticket.ConversationID)
	if conversationID == "" {
		return MessageInput{}, false
	}
	messageID := strings.TrimSpace(firstString(msg.ID, fmt.Sprintf("%d", idx+1)))
	direction, senderType := tidioMessageDirection(msg.AuthorType, false)
	out := MessageInput{
		SourceID:       "tidio://contact/" + strings.TrimPrefix(conversationID, tidioContactConversationID) + "/message/" + messageID,
		ConversationID: conversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender:         strings.TrimSpace(firstString(msg.AuthorID, msg.AuthorType)),
		BodyText:       body,
		Properties: map[string]any{
			"tidio_contact_id":  strings.TrimPrefix(conversationID, tidioContactConversationID),
			"tidio_message_id":  messageID,
			"tidio_author_id":   strings.TrimSpace(msg.AuthorID),
			"tidio_author_type": strings.TrimSpace(msg.AuthorType),
		},
	}
	if t := parseZendeskTime(msg.CreatedAt); t != nil {
		out.OccurredAt = t
	}
	return out, true
}

func tidioMessageDirection(authorType string, internal bool) (string, string) {
	if internal {
		return "internal", "agent"
	}
	switch strings.ToLower(strings.TrimSpace(authorType)) {
	case "contact", "visitor", "customer":
		return "inbound", "customer"
	case "operator", "agent", "admin":
		return "outbound", "agent"
	case "bot", "lyro":
		return "outbound", "bot"
	default:
		return "", ""
	}
}

func tidioTicketAllowed(integration Integration, ticket tidioTicket) bool {
	channelID := strings.TrimSpace(settingString(integration.Settings, "channel_id"))
	if channelID == "" {
		return true
	}
	return strings.TrimSpace(ticket.CustomChannelID) == channelID
}

func mergeTidioTicket(base, detail tidioTicket) tidioTicket {
	if detail.ID == "" {
		detail.ID = base.ID
	}
	if detail.Link == "" {
		detail.Link = base.Link
	}
	if detail.Subject == "" {
		detail.Subject = base.Subject
	}
	if detail.ContactID == "" {
		detail.ContactID = base.ContactID
	}
	if detail.ContactEmail == "" {
		detail.ContactEmail = base.ContactEmail
	}
	if detail.Priority == "" {
		detail.Priority = base.Priority
	}
	if detail.Status == "" {
		detail.Status = base.Status
	}
	if detail.AssignedOperatorID == "" {
		detail.AssignedOperatorID = base.AssignedOperatorID
	}
	if detail.AssignedDepartmentID == "" {
		detail.AssignedDepartmentID = base.AssignedDepartmentID
	}
	if detail.CustomChannelID == "" {
		detail.CustomChannelID = base.CustomChannelID
	}
	if detail.CreatedAt == "" {
		detail.CreatedAt = base.CreatedAt
	}
	if detail.UpdatedAt == "" {
		detail.UpdatedAt = base.UpdatedAt
	}
	return detail
}

type TidioRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e TidioRESTError) Error() string {
	return fmt.Sprintf("tidio REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func tidioDoJSON(ctx context.Context, client *http.Client, baseURL string, creds TidioCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse tidio API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	if query != nil {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Tidio-Openapi-Client-Id", strings.TrimSpace(creds.ClientID))
	req.Header.Set("X-Tidio-Openapi-Client-Secret", strings.TrimSpace(creds.ClientSecret))
	req.Header.Set("Accept", "application/json; version=1")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, tidioDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, tidioResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return TidioRESTError{
			Path:       path,
			StatusCode: resp.StatusCode,
			RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    zendeskTruncate(string(body), 500),
		}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode tidio response %s: %w", path, err)
	}
	return nil
}

func tidioMetaCursor(meta tidioMeta) string {
	if meta.Cursor == nil {
		return ""
	}
	return strings.TrimSpace(*meta.Cursor)
}

func tidioBackfillCursor(cursor string) (stage, providerCursor string, done bool) {
	cursor = strings.TrimSpace(cursor)
	switch {
	case cursor == "", cursor == "tidio":
		return "tickets", "", false
	case cursor == tidioCursorComplete:
		return "", "", true
	case strings.HasPrefix(cursor, tidioTicketsCursorPrefix):
		return "tickets", tidioDecodeCursorValue(strings.TrimPrefix(cursor, tidioTicketsCursorPrefix)), false
	case strings.HasPrefix(cursor, tidioContactsCursorPrefix):
		return "contacts", tidioDecodeCursorValue(strings.TrimPrefix(cursor, tidioContactsCursorPrefix)), false
	default:
		return "tickets", cursor, false
	}
}

func tidioEncodeCursor(stage, providerCursor string) string {
	switch strings.ToLower(strings.TrimSpace(stage)) {
	case "contacts":
		return tidioContactsCursorPrefix + tidioEncodeCursorValue(providerCursor)
	default:
		return tidioTicketsCursorPrefix + tidioEncodeCursorValue(providerCursor)
	}
}

func tidioEncodeCursorValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString([]byte(value))
}

func tidioDecodeCursorValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return value
	}
	return string(decoded)
}

func decodeTidioCursor(cursor string) string {
	stage, providerCursor, done := tidioBackfillCursor(cursor)
	if done {
		return tidioCursorComplete
	}
	if providerCursor == "" {
		return stage
	}
	return stage + ":" + providerCursor
}

func firstNonEmptyTidioTickets(primary, fallback []tidioTicket) []tidioTicket {
	if len(primary) > 0 {
		return primary
	}
	return fallback
}

func firstNonEmptyTidioContacts(primary, fallback []tidioContact) []tidioContact {
	if len(primary) > 0 {
		return primary
	}
	return fallback
}

func firstNonEmptyTidioContactMessages(primary, fallback []tidioContactMessage) []tidioContactMessage {
	if len(primary) > 0 {
		return primary
	}
	return fallback
}
