// SPDX-License-Identifier: AGPL-3.0-only
//
// zohodesk.go — native Zoho Desk provider runtime.
//
// Zoho Desk support tickets. Token-supplied auth (Authorization: Zoho-oauthtoken
// <access_token>) + orgId header, GET /api/v1/tickets?include=contacts with
// from/limit offset paging. The contact email is read from the ticket's email
// field or the side-loaded contact. Maps to canonical TicketInput via the
// support providerPull. (Managed Zoho OAuth refresh is the documented follow-on,
// mirroring crm_integrations Zoho; this puller consumes a supplied token.)
package support_integrations

import (
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
	zohoDeskDefaultAPIBaseURL = "https://desk.zoho.com"
	zohoDeskDefaultUserAgent  = "Moosewave Zoho Desk Integration"
	zohoDeskResponseMaxBytes  = 16 << 20
	zohoDeskDefaultPageSize   = 100
	zohoDeskMaxPageSize       = 100
	zohoDeskThreadPageSize    = 100
	zohoDeskCursorPrefix      = "zoho-desk:"
	zohoDeskCursorComplete    = "zoho-desk:complete"
)

type ZohoDeskCredentials struct {
	AccessToken string
	OrgID       string
	APIBaseURL  string
	UserAgent   string
}

type ZohoDeskCredentialResolver interface {
	ResolveZohoDesk(ctx context.Context, tenantID string, integration Integration) (ZohoDeskCredentials, error)
}

type zohoDeskCredentialPayload struct {
	AccessToken  string `json:"access_token"`
	Token        string `json:"token"`
	OrgID        string `json:"org_id"`
	OrgIDAlt     string `json:"orgId"`
	Organization string `json:"organization_id"`
	APIBaseURL   string `json:"api_base_url"`
	UserAgent    string `json:"user_agent"`
}

func (p zohoDeskCredentialPayload) credentials() (ZohoDeskCredentials, error) {
	token := strings.TrimSpace(firstString(p.AccessToken, p.Token))
	if token == "" {
		return ZohoDeskCredentials{}, fmt.Errorf("zoho desk access_token is required")
	}
	return ZohoDeskCredentials{AccessToken: token, OrgID: strings.TrimSpace(firstString(p.OrgID, p.OrgIDAlt, p.Organization)), APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type ZohoDeskSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r ZohoDeskSecretsCredentialResolver) ResolveZohoDesk(ctx context.Context, _ string, integration Integration) (ZohoDeskCredentials, error) {
	if r.Secrets == nil {
		return ZohoDeskCredentials{}, fmt.Errorf("zoho desk credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return ZohoDeskCredentials{}, fmt.Errorf("zoho desk credentials_ref is required")
	}
	var payload zohoDeskCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withZohoDeskDefaults(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return ZohoDeskCredentials{}, fmt.Errorf("resolve zoho desk credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withZohoDeskDefaults(creds, integration), nil
			}
		}
	}
	creds, err := zohoDeskCredentialPayload{AccessToken: raw}.credentials()
	if err != nil {
		return ZohoDeskCredentials{}, err
	}
	return withZohoDeskDefaults(creds, integration), nil
}

func withZohoDeskDefaults(creds ZohoDeskCredentials, integration Integration) ZohoDeskCredentials {
	if creds.OrgID == "" {
		creds.OrgID = strings.TrimSpace(firstString(
			settingString(integration.Settings, "org_id"),
			settingString(integration.Settings, "orgId"),
			settingString(integration.Settings, "organization_id"),
		))
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type ZohoDeskBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type ZohoDeskTicketRefresher interface {
	RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketID string) (SyncRequest, error)
}

type ZohoDeskRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials ZohoDeskCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type zohoDeskTicket struct {
	ID           string `json:"id"`
	Subject      string `json:"subject"`
	Status       string `json:"status"`
	Priority     string `json:"priority"`
	Channel      string `json:"channel"`
	DepartmentID string `json:"departmentId"`
	ThreadCount  string `json:"threadCount"`
	Email        string `json:"email"`
	ModifiedTime string `json:"modifiedTime"`
	Contact      struct {
		Email     string `json:"email"`
		FirstName string `json:"firstName"`
		LastName  string `json:"lastName"`
	} `json:"contact"`
}

type zohoDeskTicketsResponse struct {
	Data []zohoDeskTicket `json:"data"`
}

type zohoDeskThreadAuthor struct {
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Email     string `json:"email"`
}

type zohoDeskThread struct {
	ID                  string               `json:"id"`
	Summary             string               `json:"summary"`
	Content             string               `json:"content"`
	PlainText           string               `json:"plainText"`
	ContentType         string               `json:"contentType"`
	Direction           string               `json:"direction"`
	Visibility          string               `json:"visibility"`
	Channel             string               `json:"channel"`
	Status              string               `json:"status"`
	CreatedTime         string               `json:"createdTime"`
	FromEmailAddress    string               `json:"fromEmailAddress"`
	To                  string               `json:"to"`
	CC                  string               `json:"cc"`
	BCC                 string               `json:"bcc"`
	ReplyTo             string               `json:"replyTo"`
	ResponderID         string               `json:"responderId"`
	IsDescriptionThread bool                 `json:"isDescriptionThread"`
	IsForward           bool                 `json:"isForward"`
	HasAttach           bool                 `json:"hasAttach"`
	AttachmentCount     string               `json:"attachmentCount"`
	Author              zohoDeskThreadAuthor `json:"author"`
	Source              map[string]any       `json:"source"`
	ChannelRelatedInfo  map[string]any       `json:"channelRelatedInfo"`
}

type zohoDeskThreadsResponse struct {
	Data []zohoDeskThread `json:"data"`
}

func (b ZohoDeskRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderZohoDesk {
		return SyncRequest{}, fmt.Errorf("zoho desk backfill requires a Zoho Desk integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("zoho desk credential resolver is not configured")
	}
	from, done := zohoDeskCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: zohoDeskCursorComplete}, nil
	}
	creds, err := b.zohoDeskCredentials(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderZohoDesk, 30*time.Second)
	limit := zohoDeskPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), zohoDeskDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("from", strconv.Itoa(from))
	query.Set("limit", strconv.Itoa(limit))
	query.Set("include", "contacts")
	query.Set("sortBy", "-modifiedTime")
	if departmentID := strings.TrimSpace(settingString(integration.Settings, "department_id")); departmentID != "" {
		query.Set("departmentId", departmentID)
	}

	var out zohoDeskTicketsResponse
	if err := zohoDeskDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v1/tickets", query, &out); err != nil {
		return SyncRequest{}, err
	}
	tickets := make([]TicketInput, 0, len(out.Data))
	messages := []MessageInput{}
	departmentID := strings.TrimSpace(settingString(integration.Settings, "department_id"))
	for _, tk := range out.Data {
		if !zohoDeskTicketMatchesDepartment(tk, departmentID) {
			continue
		}
		if mapped, ok := mapZohoDeskTicket(tk); ok {
			tickets = append(tickets, mapped)
			threads, err := fetchZohoDeskTicketThreads(ctx, client, baseURL, creds, b.UserAgent, mapped.ConversationID)
			if err != nil {
				return SyncRequest{}, err
			}
			messages = append(messages, mapZohoDeskTicketThreads(threads, mapped)...)
		}
	}
	nextCursor := zohoDeskCursorComplete
	if len(out.Data) >= limit {
		nextCursor = zohoDeskCursorPrefix + strconv.Itoa(from+limit)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: nextCursor}, nil
}

func (b ZohoDeskRESTBackfiller) RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketID string) (SyncRequest, error) {
	if integration.Provider != ProviderZohoDesk {
		return SyncRequest{}, fmt.Errorf("zoho desk ticket refresh requires a Zoho Desk integration")
	}
	ticketID = strings.TrimSpace(ticketID)
	if ticketID == "" {
		return SyncRequest{}, fmt.Errorf("zoho desk ticket id is required")
	}
	creds, err := b.zohoDeskCredentials(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderZohoDesk, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), zohoDeskDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("include", "contacts")
	var ticket zohoDeskTicket
	if err := zohoDeskDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v1/tickets/"+url.PathEscape(ticketID), query, &ticket); err != nil {
		return SyncRequest{}, err
	}
	if !zohoDeskTicketMatchesDepartment(ticket, strings.TrimSpace(settingString(integration.Settings, "department_id"))) {
		return SyncRequest{RunMode: "webhook", Cursor: "zoho-desk-webhook-" + ticketID}, nil
	}
	mapped, ok := mapZohoDeskTicket(ticket)
	if !ok {
		return SyncRequest{RunMode: "webhook", Cursor: "zoho-desk-webhook-" + ticketID}, nil
	}
	threads, err := fetchZohoDeskTicketThreads(ctx, client, baseURL, creds, b.UserAgent, mapped.ConversationID)
	if err != nil {
		return SyncRequest{}, err
	}
	return normalizeSyncRequest(SyncRequest{
		RunMode:  "webhook",
		Tickets:  []TicketInput{mapped},
		Messages: mapZohoDeskTicketThreads(threads, mapped),
		Cursor:   "zoho-desk-webhook-" + ticketID,
	}), nil
}

func (b ZohoDeskRESTBackfiller) zohoDeskCredentials(ctx context.Context, tenantID string, integration Integration) (ZohoDeskCredentials, error) {
	if b.Credentials == nil {
		return ZohoDeskCredentials{}, fmt.Errorf("zoho desk credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveZohoDesk(ctx, tenantID, integration)
	if err != nil {
		return ZohoDeskCredentials{}, err
	}
	if creds.OrgID == "" {
		return ZohoDeskCredentials{}, fmt.Errorf("zoho desk org_id is required")
	}
	return creds, nil
}

func mapZohoDeskTicket(tk zohoDeskTicket) (TicketInput, bool) {
	email := strings.ToLower(strings.TrimSpace(firstString(tk.Email, tk.Contact.Email)))
	if email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(tk.ID)
	name := strings.TrimSpace(strings.TrimSpace(tk.Contact.FirstName + " " + tk.Contact.LastName))
	out := TicketInput{
		SourceID:       "zoho-desk://ticket/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  name,
		Subject:        strings.TrimSpace(tk.Subject),
		Status:         strings.TrimSpace(tk.Status),
		Priority:       strings.TrimSpace(tk.Priority),
		Properties: map[string]any{
			"zoho_desk_ticket_id":     id,
			"zoho_desk_channel":       strings.TrimSpace(tk.Channel),
			"zoho_desk_department_id": strings.TrimSpace(tk.DepartmentID),
			"zoho_desk_thread_count":  strings.TrimSpace(tk.ThreadCount),
		},
	}
	if t := parseZendeskTime(tk.ModifiedTime); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func zohoDeskTicketMatchesDepartment(tk zohoDeskTicket, departmentID string) bool {
	departmentID = strings.TrimSpace(departmentID)
	if departmentID == "" {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(tk.DepartmentID), departmentID)
}

func fetchZohoDeskTicketThreads(ctx context.Context, client *http.Client, baseURL string, creds ZohoDeskCredentials, userAgent, ticketID string) ([]zohoDeskThread, error) {
	ticketID = strings.TrimSpace(ticketID)
	if ticketID == "" {
		return nil, nil
	}
	threads := []zohoDeskThread{}
	for from := 0; ; from += zohoDeskThreadPageSize {
		query := url.Values{}
		query.Set("from", strconv.Itoa(from))
		query.Set("limit", strconv.Itoa(zohoDeskThreadPageSize))
		query.Set("sortBy", "sendDateTime")

		var out zohoDeskThreadsResponse
		path := "/api/v1/tickets/" + url.PathEscape(ticketID) + "/threads"
		if err := zohoDeskDoJSON(ctx, client, baseURL, creds, userAgent, path, query, &out); err != nil {
			var restErr ZohoDeskRESTError
			if errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound {
				return threads, nil
			}
			return nil, err
		}
		for _, summary := range out.Data {
			full := summary
			if id := strings.TrimSpace(summary.ID); id != "" {
				detail, err := fetchZohoDeskThread(ctx, client, baseURL, creds, userAgent, ticketID, id)
				if err != nil {
					var restErr ZohoDeskRESTError
					if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusNotFound {
						return nil, err
					}
				} else {
					full = mergeZohoDeskThread(summary, detail)
				}
			}
			threads = append(threads, full)
		}
		if len(out.Data) < zohoDeskThreadPageSize {
			break
		}
	}
	return threads, nil
}

func fetchZohoDeskThread(ctx context.Context, client *http.Client, baseURL string, creds ZohoDeskCredentials, userAgent, ticketID, threadID string) (zohoDeskThread, error) {
	query := url.Values{}
	query.Set("include", "plainText")
	path := "/api/v1/tickets/" + url.PathEscape(strings.TrimSpace(ticketID)) + "/threads/" + url.PathEscape(strings.TrimSpace(threadID))
	var out zohoDeskThread
	if err := zohoDeskDoJSON(ctx, client, baseURL, creds, userAgent, path, query, &out); err != nil {
		return zohoDeskThread{}, err
	}
	return out, nil
}

func mergeZohoDeskThread(summary, detail zohoDeskThread) zohoDeskThread {
	if strings.TrimSpace(detail.ID) == "" {
		detail.ID = summary.ID
	}
	if strings.TrimSpace(detail.Summary) == "" {
		detail.Summary = summary.Summary
	}
	if strings.TrimSpace(detail.Direction) == "" {
		detail.Direction = summary.Direction
	}
	if strings.TrimSpace(detail.Visibility) == "" {
		detail.Visibility = summary.Visibility
	}
	if strings.TrimSpace(detail.Channel) == "" {
		detail.Channel = summary.Channel
	}
	if strings.TrimSpace(detail.Status) == "" {
		detail.Status = summary.Status
	}
	if strings.TrimSpace(detail.CreatedTime) == "" {
		detail.CreatedTime = summary.CreatedTime
	}
	if strings.TrimSpace(detail.FromEmailAddress) == "" {
		detail.FromEmailAddress = summary.FromEmailAddress
	}
	if strings.TrimSpace(detail.ContentType) == "" {
		detail.ContentType = summary.ContentType
	}
	if strings.TrimSpace(detail.Author.Email) == "" && strings.TrimSpace(detail.Author.Name) == "" {
		detail.Author = summary.Author
	}
	if detail.Source == nil {
		detail.Source = summary.Source
	}
	if detail.ChannelRelatedInfo == nil {
		detail.ChannelRelatedInfo = summary.ChannelRelatedInfo
	}
	if !detail.IsDescriptionThread {
		detail.IsDescriptionThread = summary.IsDescriptionThread
	}
	if !detail.IsForward {
		detail.IsForward = summary.IsForward
	}
	if !detail.HasAttach {
		detail.HasAttach = summary.HasAttach
	}
	if strings.TrimSpace(detail.AttachmentCount) == "" {
		detail.AttachmentCount = summary.AttachmentCount
	}
	if strings.TrimSpace(detail.ResponderID) == "" {
		detail.ResponderID = summary.ResponderID
	}
	return detail
}

func mapZohoDeskTicketThreads(threads []zohoDeskThread, ticket TicketInput) []MessageInput {
	out := make([]MessageInput, 0, len(threads))
	for _, thread := range threads {
		if mapped, ok := mapZohoDeskThread(thread, ticket); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapZohoDeskThread(thread zohoDeskThread, ticket TicketInput) (MessageInput, bool) {
	bodyText := strings.TrimSpace(firstString(thread.PlainText, thread.Summary, intercomPartBodyText(thread.Content)))
	bodyHTML := strings.TrimSpace(thread.Content)
	if bodyHTML == "" {
		bodyHTML = bodyText
	}
	if bodyText == "" && bodyHTML == "" {
		return MessageInput{}, false
	}
	threadID := strings.TrimSpace(thread.ID)
	direction, senderType := zohoDeskThreadDirection(thread)
	out := MessageInput{
		SourceID:       "zoho-desk://thread/" + firstString(threadID, ticket.ConversationID+"/"+strings.TrimSpace(thread.CreatedTime)),
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender: strings.TrimSpace(firstString(
			thread.Author.Name,
			strings.TrimSpace(thread.Author.FirstName+" "+thread.Author.LastName),
			thread.Author.Email,
			thread.FromEmailAddress,
			ticket.RequesterName,
		)),
		BodyText: bodyText,
		BodyHTML: bodyHTML,
		Properties: map[string]any{
			"zoho_desk_ticket_id":               ticket.ConversationID,
			"zoho_desk_thread_id":               threadID,
			"zoho_desk_thread_status":           strings.TrimSpace(thread.Status),
			"zoho_desk_thread_direction":        strings.TrimSpace(thread.Direction),
			"zoho_desk_thread_visibility":       strings.TrimSpace(thread.Visibility),
			"zoho_desk_thread_channel":          strings.TrimSpace(thread.Channel),
			"zoho_desk_thread_content_type":     strings.TrimSpace(thread.ContentType),
			"zoho_desk_thread_author_type":      strings.TrimSpace(thread.Author.Type),
			"zoho_desk_thread_author_email":     strings.TrimSpace(thread.Author.Email),
			"zoho_desk_thread_from_email":       strings.TrimSpace(thread.FromEmailAddress),
			"zoho_desk_thread_attachment_count": strings.TrimSpace(thread.AttachmentCount),
			"zoho_desk_thread_is_description":   thread.IsDescriptionThread,
			"zoho_desk_thread_is_forward":       thread.IsForward,
			"zoho_desk_thread_has_attach":       thread.HasAttach,
			"zoho_desk_thread_responder_id":     strings.TrimSpace(thread.ResponderID),
		},
	}
	if t := parseZendeskTime(thread.CreatedTime); t != nil {
		out.OccurredAt = t
	}
	return out, true
}

func zohoDeskThreadDirection(thread zohoDeskThread) (string, string) {
	if visibility := strings.ToLower(strings.TrimSpace(thread.Visibility)); visibility != "" && visibility != "public" {
		return "internal", "agent"
	}
	switch strings.ToLower(strings.TrimSpace(thread.Direction)) {
	case "in", "inbound":
		return "inbound", "customer"
	case "out", "outbound":
		return "outbound", "agent"
	}
	switch strings.ToUpper(strings.TrimSpace(thread.Author.Type)) {
	case "END_USER", "CONTACT", "CUSTOMER":
		return "inbound", "customer"
	case "AGENT", "SUPPORT_REPRESENTATIVE":
		return "outbound", "agent"
	default:
		return "", ""
	}
}

func zohoDeskDoJSON(ctx context.Context, client *http.Client, baseURL string, creds ZohoDeskCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse zoho desk API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Zoho-oauthtoken "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("orgId", strings.TrimSpace(creds.OrgID))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, zohoDeskDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, zohoDeskResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode == http.StatusNoContent {
		return nil
	}
	if resp.StatusCode >= 300 {
		return ZohoDeskRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode zoho desk response %s: %w", path, err)
	}
	return nil
}

type ZohoDeskRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e ZohoDeskRESTError) Error() string {
	path := strings.TrimSpace(e.Path)
	if e.RetryAfter > 0 {
		return fmt.Sprintf("zoho desk REST %s failed %d; retry after %s: %s", path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("zoho desk REST %s failed %d: %s", path, e.StatusCode, e.Snippet)
}

func zohoDeskCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == zohoDeskCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, zohoDeskCursorPrefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}

func zohoDeskPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return zohoDeskDefaultPageSize
	}
	if n > zohoDeskMaxPageSize {
		return zohoDeskMaxPageSize
	}
	return n
}
