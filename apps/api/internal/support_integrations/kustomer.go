// SPDX-License-Identifier: AGPL-3.0-only
//
// kustomer.go — native Kustomer provider runtime.
//
// Kustomer is a JSON:API customer-service platform. API key (long-lived JWT)
// Bearer auth. Conversations list at /v1/conversations carry the contact only
// as a relationship (relationships.customer.data.id), so the contact email is
// resolved with a per-page sideload cache: each unique customer id is fetched
// once from /v1/customers/{id} (attributes.emails). Maps to canonical
// TicketInput via the support providerPull.
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
	kustomerDefaultAPIBaseURL = "https://api.kustomerapp.com"
	kustomerDefaultUserAgent  = "Moosewave Kustomer Integration"
	kustomerResponseMaxBytes  = 16 << 20
	kustomerDefaultPageSize   = 100
	kustomerMaxPageSize       = 100
	kustomerCursorPrefix      = "kustomer:"
	kustomerCursorComplete    = "kustomer:complete"
)

type KustomerCredentials struct {
	APIKey     string
	APIBaseURL string
	UserAgent  string
}

type KustomerCredentialResolver interface {
	ResolveKustomer(ctx context.Context, tenantID string, integration Integration) (KustomerCredentials, error)
}

type kustomerCredentialPayload struct {
	APIKey      string `json:"api_key"`
	Token       string `json:"token"`
	AccessToken string `json:"access_token"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p kustomerCredentialPayload) credentials() (KustomerCredentials, error) {
	token := strings.TrimSpace(firstString(p.APIKey, p.Token, p.AccessToken))
	if token == "" {
		return KustomerCredentials{}, fmt.Errorf("kustomer api_key is required")
	}
	return KustomerCredentials{APIKey: token, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type KustomerSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r KustomerSecretsCredentialResolver) ResolveKustomer(ctx context.Context, _ string, integration Integration) (KustomerCredentials, error) {
	if r.Secrets == nil {
		return KustomerCredentials{}, fmt.Errorf("kustomer credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return KustomerCredentials{}, fmt.Errorf("kustomer credentials_ref is required")
	}
	var payload kustomerCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withKustomerBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return KustomerCredentials{}, fmt.Errorf("resolve kustomer credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withKustomerBaseURL(creds, integration), nil
			}
		}
	}
	creds, err := kustomerCredentialPayload{APIKey: raw}.credentials()
	if err != nil {
		return KustomerCredentials{}, err
	}
	return withKustomerBaseURL(creds, integration), nil
}

func withKustomerBaseURL(creds KustomerCredentials, integration Integration) KustomerCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type KustomerBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type KustomerConversationRefresher interface {
	RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error)
}

type KustomerRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials KustomerCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type kustomerConversation struct {
	ID         string `json:"id"`
	Attributes struct {
		Name      string `json:"name"`
		Status    string `json:"status"`
		UpdatedAt string `json:"updatedAt"`
	} `json:"attributes"`
	Relationships struct {
		Customer struct {
			Data struct {
				ID string `json:"id"`
			} `json:"data"`
		} `json:"customer"`
	} `json:"relationships"`
}

type kustomerConversationsResponse struct {
	Data []kustomerConversation `json:"data"`
	Meta struct {
		Page      int `json:"page"`
		PageCount int `json:"pageCount"`
	} `json:"meta"`
}

type kustomerCustomerResponse struct {
	Data struct {
		Attributes struct {
			Name   string `json:"name"`
			Emails []struct {
				Email string `json:"email"`
			} `json:"emails"`
		} `json:"attributes"`
	} `json:"data"`
}

func (b KustomerRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderKustomer {
		return SyncRequest{}, fmt.Errorf("kustomer backfill requires a Kustomer integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("kustomer credential resolver is not configured")
	}
	page, done := kustomerPageCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: kustomerCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveKustomer(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderKustomer, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), kustomerDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("page[number]", strconv.Itoa(page))
	query.Set("page[size]", strconv.Itoa(kustomerPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
	query.Set("sort", "-updatedAt")

	var out kustomerConversationsResponse
	if err := kustomerDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/v1/conversations", query, &out); err != nil {
		return SyncRequest{}, err
	}
	// Resolve customer emails with a per-page cache (one fetch per unique id).
	emails := map[string]kustomerContact{}
	tickets := make([]TicketInput, 0, len(out.Data))
	for _, conv := range out.Data {
		custID := strings.TrimSpace(conv.Relationships.Customer.Data.ID)
		contact, ok := emails[custID]
		if !ok && custID != "" {
			contact = b.fetchCustomer(ctx, client, baseURL, creds, custID)
			emails[custID] = contact
		}
		if mapped, ok := mapKustomerConversation(conv, contact); ok {
			tickets = append(tickets, mapped)
		}
	}
	nextCursor := kustomerCursorComplete
	if out.Meta.PageCount > page && len(out.Data) > 0 {
		nextCursor = kustomerCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Cursor: nextCursor}, nil
}

func (b KustomerRESTBackfiller) RefreshConversation(ctx context.Context, tenantID string, integration Integration, conversationID string) (SyncRequest, error) {
	if integration.Provider != ProviderKustomer {
		return SyncRequest{}, fmt.Errorf("kustomer refresh requires a Kustomer integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("kustomer credential resolver is not configured")
	}
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return SyncRequest{}, fmt.Errorf("kustomer conversation_id is required")
	}
	creds, err := b.Credentials.ResolveKustomer(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderKustomer, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), kustomerDefaultAPIBaseURL)
	var convOut struct {
		Data kustomerConversation `json:"data"`
	}
	if err := kustomerDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/v1/conversations/"+url.PathEscape(conversationID), nil, &convOut); err != nil {
		return SyncRequest{}, err
	}
	custID := strings.TrimSpace(convOut.Data.Relationships.Customer.Data.ID)
	contact, err := b.fetchCustomerStrict(ctx, client, baseURL, creds, custID)
	if err != nil {
		return SyncRequest{}, err
	}
	if mapped, ok := mapKustomerConversation(convOut.Data, contact); ok {
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{mapped}, Cursor: "kustomer-webhook-" + conversationID}), nil
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Cursor: "kustomer-webhook-" + conversationID}), nil
}

type kustomerContact struct {
	Email string
	Name  string
}

func (b KustomerRESTBackfiller) fetchCustomer(ctx context.Context, client *http.Client, baseURL string, creds KustomerCredentials, id string) kustomerContact {
	var out kustomerCustomerResponse
	if err := kustomerDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/v1/customers/"+url.PathEscape(id), nil, &out); err != nil {
		return kustomerContact{}
	}
	email := ""
	for _, e := range out.Data.Attributes.Emails {
		if v := strings.ToLower(strings.TrimSpace(e.Email)); v != "" {
			email = v
			break
		}
	}
	return kustomerContact{Email: email, Name: strings.TrimSpace(out.Data.Attributes.Name)}
}

func (b KustomerRESTBackfiller) fetchCustomerStrict(ctx context.Context, client *http.Client, baseURL string, creds KustomerCredentials, id string) (kustomerContact, error) {
	if strings.TrimSpace(id) == "" {
		return kustomerContact{}, nil
	}
	var out kustomerCustomerResponse
	if err := kustomerDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/v1/customers/"+url.PathEscape(id), nil, &out); err != nil {
		return kustomerContact{}, err
	}
	email := ""
	for _, e := range out.Data.Attributes.Emails {
		if v := strings.ToLower(strings.TrimSpace(e.Email)); v != "" {
			email = v
			break
		}
	}
	return kustomerContact{Email: email, Name: strings.TrimSpace(out.Data.Attributes.Name)}, nil
}

func mapKustomerConversation(conv kustomerConversation, contact kustomerContact) (TicketInput, bool) {
	if contact.Email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(conv.ID)
	out := TicketInput{
		SourceID:       "kustomer://conversation/" + id,
		ConversationID: id,
		Email:          contact.Email,
		RequesterName:  contact.Name,
		Subject:        strings.TrimSpace(conv.Attributes.Name),
		Status:         strings.TrimSpace(conv.Attributes.Status),
		Properties:     map[string]any{"kustomer_conversation_id": id},
	}
	if t := parseZendeskTime(conv.Attributes.UpdatedAt); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func kustomerDoJSON(ctx context.Context, client *http.Client, baseURL string, creds KustomerCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse kustomer API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	if query != nil {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.APIKey))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, kustomerDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, kustomerResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return KustomerRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode kustomer response %s: %w", path, err)
	}
	return nil
}

type KustomerRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e KustomerRESTError) Error() string {
	if e.Path == "" {
		if e.RetryAfter > 0 {
			return fmt.Sprintf("kustomer REST failed %d; retry after %s: %s", e.StatusCode, e.RetryAfter, e.Snippet)
		}
		return fmt.Sprintf("kustomer REST failed %d: %s", e.StatusCode, e.Snippet)
	}
	if e.RetryAfter > 0 {
		return fmt.Sprintf("kustomer REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("kustomer REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func kustomerPageCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == kustomerCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, kustomerCursorPrefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}

func kustomerPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return kustomerDefaultPageSize
	}
	if n > kustomerMaxPageSize {
		return kustomerMaxPageSize
	}
	return n
}
