// SPDX-License-Identifier: AGPL-3.0-only
//
// front.go — native Front provider runtime.
//
// Front is a high-demand shared-inbox helpdesk. Bearer API token, GET
// /conversations with token pagination (the response carries a full
// _pagination.next URL, requested directly on the next page). The conversation
// recipient.handle is the contact email. Maps to canonical TicketInput via the
// support providerPull.
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
	frontDefaultAPIBaseURL = "https://api2.frontapp.com"
	frontDefaultUserAgent  = "Moosewave Front Integration"
	frontResponseMaxBytes  = 16 << 20
	frontDefaultPageSize   = 100
	frontMaxPageSize       = 100
	frontCursorPrefix      = "front:"
	frontCursorComplete    = "front:complete"
)

type FrontCredentials struct {
	APIToken   string
	APIBaseURL string
	UserAgent  string
}

type FrontCredentialResolver interface {
	ResolveFront(ctx context.Context, tenantID string, integration Integration) (FrontCredentials, error)
}

type frontCredentialPayload struct {
	APIToken    string `json:"api_token"`
	Token       string `json:"token"`
	AccessToken string `json:"access_token"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p frontCredentialPayload) credentials() (FrontCredentials, error) {
	token := strings.TrimSpace(firstString(p.APIToken, p.Token, p.AccessToken))
	if token == "" {
		return FrontCredentials{}, fmt.Errorf("front api_token is required")
	}
	return FrontCredentials{APIToken: token, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type FrontSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r FrontSecretsCredentialResolver) ResolveFront(ctx context.Context, _ string, integration Integration) (FrontCredentials, error) {
	if r.Secrets == nil {
		return FrontCredentials{}, fmt.Errorf("front credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return FrontCredentials{}, fmt.Errorf("front credentials_ref is required")
	}
	var payload frontCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withFrontBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return FrontCredentials{}, fmt.Errorf("resolve front credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withFrontBaseURL(creds, integration), nil
			}
		}
	}
	// A bare string is treated as the API token.
	creds, err := frontCredentialPayload{APIToken: raw}.credentials()
	if err != nil {
		return FrontCredentials{}, err
	}
	return withFrontBaseURL(creds, integration), nil
}

func withFrontBaseURL(creds FrontCredentials, integration Integration) FrontCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type FrontBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type FrontConversationRefresher interface {
	RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error)
}

type FrontRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials FrontCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type frontConversation struct {
	ID        string `json:"id"`
	Subject   string `json:"subject"`
	Status    string `json:"status"`
	Recipient struct {
		Handle string `json:"handle"`
		Role   string `json:"role"`
	} `json:"recipient"`
	Tags []struct {
		Name string `json:"name"`
	} `json:"tags"`
	CreatedAt json.Number `json:"created_at"`
}

type frontConversationsResponse struct {
	Results    []frontConversation `json:"_results"`
	Pagination struct {
		Next string `json:"next"`
	} `json:"_pagination"`
}

func (b FrontRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderFront {
		return SyncRequest{}, fmt.Errorf("front backfill requires a Front integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("front credential resolver is not configured")
	}
	cursor = strings.TrimSpace(cursor)
	if cursor == frontCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: frontCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveFront(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderFront, 30*time.Second)
	// A cursor carries the full next-page URL Front returned; otherwise build the
	// first page URL from the host.
	var requestURL string
	if strings.HasPrefix(cursor, frontCursorPrefix) {
		requestURL = strings.TrimPrefix(cursor, frontCursorPrefix)
	} else {
		baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), frontDefaultAPIBaseURL)
		path := "/conversations"
		if inboxID := strings.TrimSpace(settingString(integration.Settings, "inbox_id")); inboxID != "" {
			path = "/inboxes/" + url.PathEscape(inboxID) + "/conversations"
		}
		q := url.Values{}
		q.Set("limit", strconv.Itoa(frontPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
		q.Set("sort_by", "date")
		q.Set("sort_order", "desc")
		requestURL = strings.TrimRight(baseURL, "/") + path + "?" + q.Encode()
	}

	var out frontConversationsResponse
	if err := frontDoJSON(ctx, client, requestURL, creds, b.UserAgent, &out); err != nil {
		return SyncRequest{}, err
	}
	tickets := make([]TicketInput, 0, len(out.Results))
	for _, c := range out.Results {
		if mapped, ok := mapFrontConversation(c); ok {
			tickets = append(tickets, mapped)
		}
	}
	nextCursor := frontCursorComplete
	if strings.TrimSpace(out.Pagination.Next) != "" && len(out.Results) > 0 {
		nextCursor = frontCursorPrefix + strings.TrimSpace(out.Pagination.Next)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Cursor: nextCursor}, nil
}

func (b FrontRESTBackfiller) RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error) {
	if integration.Provider != ProviderFront {
		return SyncRequest{}, fmt.Errorf("front refresh requires a Front integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("front credential resolver is not configured")
	}
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return SyncRequest{}, fmt.Errorf("front conversation_id is required")
	}
	creds, err := b.Credentials.ResolveFront(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderFront, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), frontDefaultAPIBaseURL)
	requestURL := strings.TrimRight(baseURL, "/") + "/conversations/" + url.PathEscape(conversationID)

	var out frontConversation
	if err := frontDoJSON(ctx, client, requestURL, creds, b.UserAgent, &out); err != nil {
		return SyncRequest{}, err
	}
	if mapped, ok := mapFrontConversation(out); ok {
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{mapped}, Cursor: "front-webhook-" + conversationID}), nil
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Cursor: "front-webhook-" + conversationID}), nil
}

func mapFrontConversation(c frontConversation) (TicketInput, bool) {
	handle := strings.ToLower(strings.TrimSpace(c.Recipient.Handle))
	if handle == "" || !strings.Contains(handle, "@") {
		// Non-email conversations (SMS/social) have no email identity to land.
		return TicketInput{}, false
	}
	id := strings.TrimSpace(c.ID)
	tags := make([]string, 0, len(c.Tags))
	for _, t := range c.Tags {
		if v := strings.TrimSpace(t.Name); v != "" {
			tags = append(tags, v)
		}
	}
	out := TicketInput{
		SourceID:       "front://conversation/" + id,
		ConversationID: id,
		Email:          handle,
		Subject:        strings.TrimSpace(c.Subject),
		Status:         strings.TrimSpace(c.Status),
		Tags:           tags,
		Properties:     map[string]any{"front_conversation_id": id},
	}
	if t := frontEpoch(c.CreatedAt); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func frontDoJSON(ctx context.Context, client *http.Client, fullURL string, creds FrontCredentials, userAgent string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.APIToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, frontDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, frontResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return FrontRESTError{StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode front response: %w", err)
	}
	return nil
}

type FrontRESTError struct {
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e FrontRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("front REST failed %d; retry after %s: %s", e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("front REST failed %d: %s", e.StatusCode, e.Snippet)
}

func frontPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return frontDefaultPageSize
	}
	if n > frontMaxPageSize {
		return frontMaxPageSize
	}
	return n
}

func frontEpoch(value json.Number) *time.Time {
	raw := strings.TrimSpace(value.String())
	if raw == "" {
		return nil
	}
	secs, err := strconv.ParseFloat(raw, 64)
	if err != nil || secs <= 0 {
		return nil
	}
	t := time.Unix(int64(secs), 0).UTC()
	return &t
}
