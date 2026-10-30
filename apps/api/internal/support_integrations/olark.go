// SPDX-License-Identifier: AGPL-3.0-only
//
// olark.go — native Olark provider runtime.
//
// Olark live-chat transcripts. Bearer access token, GET /api/v1/transcripts
// with offset/limit paging; the visitor email is on visitor.emailAddress. Maps
// to canonical TicketInput via the support providerPull. (Token-supplied;
// managed OAuth refresh is the documented follow-on.)
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
	olarkDefaultAPIBaseURL = "https://api.olark.com"
	olarkDefaultUserAgent  = "Moosewave Olark Integration"
	olarkResponseMaxBytes  = 16 << 20
	olarkDefaultPageSize   = 100
	olarkMaxPageSize       = 100
	olarkCursorPrefix      = "olark:"
	olarkCursorComplete    = "olark:complete"
)

type OlarkCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type OlarkCredentialResolver interface {
	ResolveOlark(ctx context.Context, tenantID string, integration Integration) (OlarkCredentials, error)
}

type olarkCredentialPayload struct {
	AccessToken string `json:"access_token"`
	Token       string `json:"token"`
	APIKey      string `json:"api_key"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p olarkCredentialPayload) credentials() (OlarkCredentials, error) {
	token := strings.TrimSpace(firstString(p.AccessToken, p.Token, p.APIKey))
	if token == "" {
		return OlarkCredentials{}, fmt.Errorf("olark access_token is required")
	}
	return OlarkCredentials{AccessToken: token, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type OlarkSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r OlarkSecretsCredentialResolver) ResolveOlark(ctx context.Context, _ string, integration Integration) (OlarkCredentials, error) {
	if r.Secrets == nil {
		return OlarkCredentials{}, fmt.Errorf("olark credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return OlarkCredentials{}, fmt.Errorf("olark credentials_ref is required")
	}
	var payload olarkCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withOlarkBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return OlarkCredentials{}, fmt.Errorf("resolve olark credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withOlarkBaseURL(creds, integration), nil
			}
		}
	}
	creds, err := olarkCredentialPayload{AccessToken: raw}.credentials()
	if err != nil {
		return OlarkCredentials{}, err
	}
	return withOlarkBaseURL(creds, integration), nil
}

func withOlarkBaseURL(creds OlarkCredentials, integration Integration) OlarkCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type OlarkBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type OlarkRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials OlarkCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type olarkTranscript struct {
	ID      string   `json:"id"`
	Kind    string   `json:"kind"`
	Topic   string   `json:"topic"`
	Tags    []string `json:"tags"`
	Visitor struct {
		EmailAddress string `json:"emailAddress"`
		FullName     string `json:"fullName"`
		PhoneNumber  string `json:"phoneNumber"`
	} `json:"visitor"`
	Items     []olarkTranscriptItem `json:"items"`
	Timestamp string                `json:"timestamp"`
}

type olarkTranscriptItem struct {
	Kind      string `json:"kind"`
	Body      string `json:"body"`
	Nickname  string `json:"nickname"`
	Timestamp string `json:"timestamp"`
}

type olarkTranscriptsResponse struct {
	Results []olarkTranscript `json:"results"`
	Next    string            `json:"next"`
}

func (b OlarkRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderOlark {
		return SyncRequest{}, fmt.Errorf("olark backfill requires an Olark integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("olark credential resolver is not configured")
	}
	offset, done := olarkCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: olarkCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveOlark(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderOlark, 30*time.Second)
	limit := olarkPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), olarkDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("limit", strconv.Itoa(limit))
	query.Set("offset", strconv.Itoa(offset))

	var out olarkTranscriptsResponse
	if err := olarkDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v1/transcripts", query, &out); err != nil {
		return SyncRequest{}, err
	}
	tickets := make([]TicketInput, 0, len(out.Results))
	messages := []MessageInput{}
	for _, tr := range out.Results {
		if mapped, ok := mapOlarkTranscript(tr); ok {
			tickets = append(tickets, mapped)
			messages = append(messages, mapOlarkTranscriptMessages(tr, mapped)...)
		}
	}
	// Advance whenever the API reports another page (Next non-empty), regardless
	// of whether this page was full — a partial-but-not-final page still has more.
	// Offset advances by the rows actually returned so partial pages stay aligned.
	nextCursor := olarkCursorComplete
	if strings.TrimSpace(out.Next) != "" {
		nextCursor = olarkCursorPrefix + strconv.Itoa(offset+len(out.Results))
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: nextCursor}, nil
}

func mapOlarkTranscript(tr olarkTranscript) (TicketInput, bool) {
	email := strings.ToLower(strings.TrimSpace(tr.Visitor.EmailAddress))
	if email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(tr.ID)
	out := TicketInput{
		SourceID:       "olark://transcript/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  strings.TrimSpace(tr.Visitor.FullName),
		Subject:        strings.TrimSpace(tr.Topic),
		Tags:           tr.Tags,
		Properties:     map[string]any{"olark_transcript_id": id},
	}
	if kind := strings.TrimSpace(tr.Kind); kind != "" {
		out.Properties["olark_transcript_kind"] = kind
	}
	if phone := strings.TrimSpace(tr.Visitor.PhoneNumber); phone != "" {
		out.Properties["olark_visitor_phone"] = phone
	}
	if t := parseZendeskTime(tr.Timestamp); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func mapOlarkTranscriptMessages(tr olarkTranscript, ticket TicketInput) []MessageInput {
	if len(tr.Items) == 0 {
		return nil
	}
	out := make([]MessageInput, 0, len(tr.Items))
	for idx, item := range tr.Items {
		if mapped, ok := mapOlarkTranscriptItem(tr, ticket, item, idx); ok {
			out = append(out, mapped)
		}
	}
	return out
}

func mapOlarkTranscriptItem(tr olarkTranscript, ticket TicketInput, item olarkTranscriptItem, idx int) (MessageInput, bool) {
	body := strings.TrimSpace(item.Body)
	if body == "" {
		return MessageInput{}, false
	}
	transcriptID := strings.TrimSpace(firstString(ticket.ConversationID, tr.ID))
	if transcriptID == "" {
		return MessageInput{}, false
	}
	direction, senderType := olarkTranscriptItemDirection(item)
	out := MessageInput{
		SourceID:       fmt.Sprintf("olark://transcript/%s/message/%d", transcriptID, idx+1),
		ConversationID: transcriptID,
		Email:          ticket.Email,
		Subject:        ticket.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender:         strings.TrimSpace(firstString(item.Nickname, ticket.RequesterName)),
		BodyText:       body,
		Properties: map[string]any{
			"olark_transcript_id": transcriptID,
			"olark_item_index":    idx,
			"olark_item_kind":     strings.TrimSpace(item.Kind),
		},
	}
	if t := parseZendeskTime(item.Timestamp); t != nil {
		out.OccurredAt = t
	}
	return out, true
}

func olarkTranscriptItemDirection(item olarkTranscriptItem) (string, string) {
	switch strings.ToLower(strings.TrimSpace(item.Kind)) {
	case "messagetovisitor":
		return "outbound", "agent"
	case "messagetooperator", "offlinemessage":
		return "inbound", "customer"
	default:
		return "", ""
	}
}

type OlarkRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e OlarkRESTError) Error() string {
	return fmt.Sprintf("olark REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func olarkDoJSON(ctx context.Context, client *http.Client, baseURL string, creds OlarkCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse olark API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, olarkDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, olarkResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return OlarkRESTError{
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
		return fmt.Errorf("decode olark response %s: %w", path, err)
	}
	return nil
}

func olarkCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == olarkCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, olarkCursorPrefix))
	if err != nil || n < 0 {
		return 0, false
	}
	return n, false
}

func olarkPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return olarkDefaultPageSize
	}
	if n > olarkMaxPageSize {
		return olarkMaxPageSize
	}
	return n
}
