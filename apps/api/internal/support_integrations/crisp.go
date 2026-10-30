// SPDX-License-Identifier: AGPL-3.0-only
//
// crisp.go — native Crisp provider runtime.
//
// Crisp is a popular SMB live-chat helpdesk. Plugin-token HTTP Basic
// (identifier:key) + X-Crisp-Tier header, scoped to a website_id. Conversations
// list at /v1/website/{website_id}/conversations/{page} (page is a path
// segment) and carry the contact email on meta.email. Maps to canonical
// TicketInput via the support providerPull.
package support_integrations

import (
	"context"
	"encoding/base64"
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
	crispDefaultAPIBaseURL = "https://api.crisp.chat"
	crispDefaultUserAgent  = "Moosewave Crisp Integration"
	crispResponseMaxBytes  = 16 << 20
	crispDefaultPageSize   = 50
	crispMaxPageSize       = 50
	crispCursorPrefix      = "crisp:"
	crispCursorComplete    = "crisp:complete"
)

type CrispCredentials struct {
	Identifier string
	Key        string
	WebsiteID  string
	Tier       string
	APIBaseURL string
	UserAgent  string
}

type CrispCredentialResolver interface {
	ResolveCrisp(ctx context.Context, tenantID string, integration Integration) (CrispCredentials, error)
}

type crispCredentialPayload struct {
	Identifier string `json:"identifier"`
	Key        string `json:"key"`
	Token      string `json:"token"`
	WebsiteID  string `json:"website_id"`
	Tier       string `json:"tier"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p crispCredentialPayload) credentials() (CrispCredentials, error) {
	id := strings.TrimSpace(p.Identifier)
	key := strings.TrimSpace(firstString(p.Key, p.Token))
	if id == "" || key == "" {
		return CrispCredentials{}, fmt.Errorf("crisp identifier and key are required")
	}
	return CrispCredentials{Identifier: id, Key: key, WebsiteID: strings.TrimSpace(p.WebsiteID), Tier: strings.TrimSpace(p.Tier), APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type CrispSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r CrispSecretsCredentialResolver) ResolveCrisp(ctx context.Context, _ string, integration Integration) (CrispCredentials, error) {
	if r.Secrets == nil {
		return CrispCredentials{}, fmt.Errorf("crisp credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return CrispCredentials{}, fmt.Errorf("crisp credentials_ref is required")
	}
	var payload crispCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withCrispDefaults(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return CrispCredentials{}, fmt.Errorf("resolve crisp credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withCrispDefaults(creds, integration), nil
			}
		}
	}
	return CrispCredentials{}, fmt.Errorf("crisp requires a JSON {identifier, key} secret")
}

func withCrispDefaults(creds CrispCredentials, integration Integration) CrispCredentials {
	if creds.WebsiteID == "" {
		creds.WebsiteID = strings.TrimSpace(settingString(integration.Settings, "website_id"))
	}
	if creds.Tier == "" {
		creds.Tier = strings.TrimSpace(settingString(integration.Settings, "tier"))
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type CrispBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type CrispConversationRefresher interface {
	RefreshConversation(ctx context.Context, tenantID string, integration Integration, sessionID string) (SyncRequest, error)
}

type CrispRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials CrispCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type crispConversation struct {
	SessionID string `json:"session_id"`
	State     string `json:"state"`
	UpdatedAt int64  `json:"updated_at"`
	Meta      struct {
		Email    string   `json:"email"`
		Nickname string   `json:"nickname"`
		Subject  string   `json:"subject"`
		Segments []string `json:"segments"`
	} `json:"meta"`
}

type crispConversationsResponse struct {
	Error bool                `json:"error"`
	Data  []crispConversation `json:"data"`
}

type crispConversationMetaResponse struct {
	Error bool `json:"error"`
	Data  struct {
		Email    string   `json:"email"`
		Nickname string   `json:"nickname"`
		Subject  string   `json:"subject"`
		Segments []string `json:"segments"`
	} `json:"data"`
}

func (b CrispRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderCrisp {
		return SyncRequest{}, fmt.Errorf("crisp backfill requires a Crisp integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("crisp credential resolver is not configured")
	}
	page, done := crispPageCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: crispCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveCrisp(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if creds.WebsiteID == "" {
		return SyncRequest{}, fmt.Errorf("crisp website_id is required")
	}
	client := supportEgressClient(b.HTTPClient, ProviderCrisp, 30*time.Second)
	perPage := crispPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), crispDefaultAPIBaseURL)
	path := "/v1/website/" + url.PathEscape(creds.WebsiteID) + "/conversations/" + strconv.Itoa(page)
	query := url.Values{}
	query.Set("per_page", strconv.Itoa(perPage))

	var out crispConversationsResponse
	if err := crispDoJSON(ctx, client, baseURL, creds, b.UserAgent, path, query, &out); err != nil {
		return SyncRequest{}, err
	}
	tickets := make([]TicketInput, 0, len(out.Data))
	for _, c := range out.Data {
		if mapped, ok := mapCrispConversation(c); ok {
			tickets = append(tickets, mapped)
		}
	}
	nextCursor := crispCursorComplete
	if len(out.Data) >= perPage {
		nextCursor = crispCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Cursor: nextCursor}, nil
}

func (b CrispRESTBackfiller) RefreshConversation(ctx context.Context, tenantID string, integration Integration, sessionID string) (SyncRequest, error) {
	if integration.Provider != ProviderCrisp {
		return SyncRequest{}, fmt.Errorf("crisp refresh requires a Crisp integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("crisp credential resolver is not configured")
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return SyncRequest{}, fmt.Errorf("crisp session_id is required")
	}
	creds, err := b.Credentials.ResolveCrisp(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if creds.WebsiteID == "" {
		return SyncRequest{}, fmt.Errorf("crisp website_id is required")
	}
	client := supportEgressClient(b.HTTPClient, ProviderCrisp, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), crispDefaultAPIBaseURL)
	path := "/v1/website/" + url.PathEscape(creds.WebsiteID) + "/conversation/" + url.PathEscape(sessionID) + "/meta"

	var out crispConversationMetaResponse
	if err := crispDoJSON(ctx, client, baseURL, creds, b.UserAgent, path, nil, &out); err != nil {
		return SyncRequest{}, err
	}
	meta := out.Data
	email := strings.ToLower(strings.TrimSpace(meta.Email))
	if email == "" {
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Cursor: "crisp-webhook-" + sessionID}), nil
	}
	ticket := TicketInput{
		SourceID:       "crisp://conversation/" + sessionID,
		ConversationID: sessionID,
		Email:          email,
		RequesterName:  strings.TrimSpace(meta.Nickname),
		Subject:        strings.TrimSpace(meta.Subject),
		Tags:           meta.Segments,
		Properties:     map[string]any{"crisp_session_id": sessionID},
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Cursor: "crisp-webhook-" + sessionID}), nil
}

func mapCrispConversation(c crispConversation) (TicketInput, bool) {
	email := strings.ToLower(strings.TrimSpace(c.Meta.Email))
	if email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(c.SessionID)
	out := TicketInput{
		SourceID:       "crisp://conversation/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  strings.TrimSpace(c.Meta.Nickname),
		Subject:        strings.TrimSpace(c.Meta.Subject),
		Status:         strings.TrimSpace(c.State),
		Tags:           c.Meta.Segments,
		Properties:     map[string]any{"crisp_session_id": id},
	}
	if c.UpdatedAt > 0 {
		// Crisp timestamps are epoch milliseconds.
		t := time.Unix(c.UpdatedAt/1000, 0).UTC()
		out.UpdatedAt = &t
	}
	return out, true
}

func crispDoJSON(ctx context.Context, client *http.Client, baseURL string, creds CrispCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse crisp API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(creds.Identifier)+":"+strings.TrimSpace(creds.Key))))
	req.Header.Set("X-Crisp-Tier", firstString(creds.Tier, "plugin"))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, crispDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, crispResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return CrispRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode crisp response %s: %w", path, err)
	}
	return nil
}

type CrispRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e CrispRESTError) Error() string {
	if e.Path == "" {
		if e.RetryAfter > 0 {
			return fmt.Sprintf("crisp REST failed %d; retry after %s: %s", e.StatusCode, e.RetryAfter, e.Snippet)
		}
		return fmt.Sprintf("crisp REST failed %d: %s", e.StatusCode, e.Snippet)
	}
	if e.RetryAfter > 0 {
		return fmt.Sprintf("crisp REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("crisp REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func crispPageCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == crispCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, crispCursorPrefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}

func crispPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return crispDefaultPageSize
	}
	if n > crispMaxPageSize {
		return crispMaxPageSize
	}
	return n
}
