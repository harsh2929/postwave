// SPDX-License-Identifier: AGPL-3.0-only
//
// drift.go — native Drift provider runtime.
//
// Drift is a conversational-marketing/support platform. Bearer OAuth token,
// GET /conversations/list (limit + opaque `next` cursor). Conversations carry
// the contact only as contactId, so the email is resolved via a per-page
// sideload cache: each unique contactId is fetched once from /contacts/{id}
// (attributes.email). Maps to canonical TicketInput via the support providerPull.
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
	driftDefaultAPIBaseURL = "https://driftapi.com"
	driftDefaultUserAgent  = "Moosewave Drift Integration"
	driftResponseMaxBytes  = 16 << 20
	driftDefaultPageSize   = 50
	driftMaxPageSize       = 50
	driftCursorPrefix      = "drift:"
	driftCursorComplete    = "drift:complete"
)

type DriftCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type DriftCredentialResolver interface {
	ResolveDrift(ctx context.Context, tenantID string, integration Integration) (DriftCredentials, error)
}

type driftCredentialPayload struct {
	AccessToken string `json:"access_token"`
	Token       string `json:"token"`
	APIKey      string `json:"api_key"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p driftCredentialPayload) credentials() (DriftCredentials, error) {
	token := strings.TrimSpace(firstString(p.AccessToken, p.Token, p.APIKey))
	if token == "" {
		return DriftCredentials{}, fmt.Errorf("drift access_token is required")
	}
	return DriftCredentials{AccessToken: token, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type DriftSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r DriftSecretsCredentialResolver) ResolveDrift(ctx context.Context, _ string, integration Integration) (DriftCredentials, error) {
	if r.Secrets == nil {
		return DriftCredentials{}, fmt.Errorf("drift credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return DriftCredentials{}, fmt.Errorf("drift credentials_ref is required")
	}
	var payload driftCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withDriftBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return DriftCredentials{}, fmt.Errorf("resolve drift credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withDriftBaseURL(creds, integration), nil
			}
		}
	}
	creds, err := driftCredentialPayload{AccessToken: raw}.credentials()
	if err != nil {
		return DriftCredentials{}, err
	}
	return withDriftBaseURL(creds, integration), nil
}

func withDriftBaseURL(creds DriftCredentials, integration Integration) DriftCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type DriftBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type DriftConversationRefresher interface {
	RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error)
}

type DriftRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials DriftCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type driftConversation struct {
	ID        json.Number `json:"id"`
	Status    string      `json:"status"`
	ContactID json.Number `json:"contactId"`
	UpdatedAt int64       `json:"updatedAt"`
}

type driftConversationResponse struct {
	Data driftConversation `json:"data"`
}

type driftConversationsResponse struct {
	Data []driftConversation `json:"data"`
	// Current Drift returns a top-level links.next full URL (page_token paging);
	// the legacy shape used pagination.more + a next token. Support both.
	Links struct {
		Next string `json:"next"`
	} `json:"links"`
	Pagination struct {
		More bool   `json:"more"`
		Next string `json:"next"`
	} `json:"pagination"`
}

type driftContactResponse struct {
	Data struct {
		Attributes struct {
			Email     string `json:"email"`
			Name      string `json:"name"`
			FirstName string `json:"first_name"`
			LastName  string `json:"last_name"`
		} `json:"attributes"`
	} `json:"data"`
}

func (b DriftRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderDrift {
		return SyncRequest{}, fmt.Errorf("drift backfill requires a Drift integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("drift credential resolver is not configured")
	}
	cursor = strings.TrimSpace(cursor)
	if cursor == driftCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: driftCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveDrift(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderDrift, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), driftDefaultAPIBaseURL)
	cursorBody := strings.TrimPrefix(cursor, driftCursorPrefix)

	var out driftConversationsResponse
	if strings.HasPrefix(cursor, driftCursorPrefix) && (strings.HasPrefix(cursorBody, "http://") || strings.HasPrefix(cursorBody, "https://")) {
		// Follow Drift's links.next full URL directly (limit + token are retained).
		if err := driftGetJSON(ctx, client, cursorBody, creds, b.UserAgent, "/conversations/list", &out); err != nil {
			return SyncRequest{}, err
		}
	} else {
		query := url.Values{}
		query.Set("limit", strconv.Itoa(driftPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
		if strings.HasPrefix(cursor, driftCursorPrefix) {
			query.Set("next", cursorBody) // legacy pagination token
		}
		if err := driftDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/conversations/list", query, &out); err != nil {
			return SyncRequest{}, err
		}
	}
	emails := map[string]driftContact{}
	tickets := make([]TicketInput, 0, len(out.Data))
	for _, conv := range out.Data {
		contactID := strings.TrimSpace(conv.ContactID.String())
		contact, ok := emails[contactID]
		if !ok && contactID != "" {
			contact = b.fetchContact(ctx, client, baseURL, creds, contactID)
			emails[contactID] = contact
		}
		if mapped, ok := mapDriftConversation(conv, contact); ok {
			tickets = append(tickets, mapped)
		}
	}
	nextCursor := driftCursorComplete
	if n := strings.TrimSpace(out.Links.Next); n != "" {
		nextCursor = driftCursorPrefix + n
	} else if out.Pagination.More && strings.TrimSpace(out.Pagination.Next) != "" {
		nextCursor = driftCursorPrefix + strings.TrimSpace(out.Pagination.Next)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Cursor: nextCursor}, nil
}

func (b DriftRESTBackfiller) RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error) {
	if integration.Provider != ProviderDrift {
		return SyncRequest{}, fmt.Errorf("drift refresh requires a Drift integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("drift credential resolver is not configured")
	}
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return SyncRequest{}, fmt.Errorf("drift conversation_id is required")
	}
	creds, err := b.Credentials.ResolveDrift(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderDrift, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), driftDefaultAPIBaseURL)
	var out driftConversationResponse
	if err := driftDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/conversations/"+url.PathEscape(conversationID), nil, &out); err != nil {
		return SyncRequest{}, err
	}
	contactID := strings.TrimSpace(out.Data.ContactID.String())
	contact, err := b.fetchContactStrict(ctx, client, baseURL, creds, contactID)
	if err != nil {
		return SyncRequest{}, err
	}
	if mapped, ok := mapDriftConversation(out.Data, contact); ok {
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{mapped}, Cursor: "drift-webhook-" + conversationID}), nil
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Cursor: "drift-webhook-" + conversationID}), nil
}

type driftContact struct {
	Email string
	Name  string
}

func (b DriftRESTBackfiller) fetchContact(ctx context.Context, client *http.Client, baseURL string, creds DriftCredentials, id string) driftContact {
	var out driftContactResponse
	if err := driftDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/contacts/"+url.PathEscape(id), nil, &out); err != nil {
		return driftContact{}
	}
	name := strings.TrimSpace(out.Data.Attributes.Name)
	if name == "" {
		name = strings.TrimSpace(out.Data.Attributes.FirstName + " " + out.Data.Attributes.LastName)
	}
	return driftContact{Email: strings.ToLower(strings.TrimSpace(out.Data.Attributes.Email)), Name: name}
}

func (b DriftRESTBackfiller) fetchContactStrict(ctx context.Context, client *http.Client, baseURL string, creds DriftCredentials, id string) (driftContact, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return driftContact{}, nil
	}
	var out driftContactResponse
	if err := driftDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/contacts/"+url.PathEscape(id), nil, &out); err != nil {
		return driftContact{}, err
	}
	name := strings.TrimSpace(out.Data.Attributes.Name)
	if name == "" {
		name = strings.TrimSpace(out.Data.Attributes.FirstName + " " + out.Data.Attributes.LastName)
	}
	return driftContact{Email: strings.ToLower(strings.TrimSpace(out.Data.Attributes.Email)), Name: name}, nil
}

func mapDriftConversation(conv driftConversation, contact driftContact) (TicketInput, bool) {
	if contact.Email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(conv.ID.String())
	out := TicketInput{
		SourceID:       "drift://conversation/" + id,
		ConversationID: id,
		Email:          contact.Email,
		RequesterName:  contact.Name,
		Status:         strings.TrimSpace(conv.Status),
		Properties:     map[string]any{"drift_conversation_id": id},
	}
	if conv.UpdatedAt > 0 {
		// Drift timestamps are epoch milliseconds.
		t := time.Unix(conv.UpdatedAt/1000, 0).UTC()
		out.UpdatedAt = &t
	}
	return out, true
}

type DriftRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e DriftRESTError) Error() string {
	if e.Path == "" {
		e.Path = "request"
	}
	if e.RetryAfter > 0 {
		return fmt.Sprintf("drift REST %s failed %d retry_after=%s: %s", e.Path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("drift REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func driftDoJSON(ctx context.Context, client *http.Client, baseURL string, creds DriftCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse drift API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	if query != nil {
		u.RawQuery = query.Encode()
	}
	return driftGetJSON(ctx, client, u.String(), creds, userAgent, path, out)
}

// driftGetJSON fetches an absolute Drift URL (used to follow links.next directly).
func driftGetJSON(ctx context.Context, client *http.Client, fullURL string, creds DriftCredentials, userAgent, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, driftDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, driftResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return DriftRESTError{
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
		return fmt.Errorf("decode drift response %s: %w", path, err)
	}
	return nil
}

func driftPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return driftDefaultPageSize
	}
	if n > driftMaxPageSize {
		return driftMaxPageSize
	}
	return n
}
