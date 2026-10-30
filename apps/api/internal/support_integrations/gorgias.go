// SPDX-License-Identifier: AGPL-3.0-only
//
// gorgias.go — native Gorgias provider runtime.
//
// Gorgias is the dominant Shopify/DTC helpdesk; its tickets enrich subscriber
// profiles and trigger retention messaging. This mirrors the Zendesk puller:
// a credential resolver (email + API key, HTTP Basic) + a REST puller over the
// Tickets API (cursor pagination, embedded customer email — no side-load) +
// canonical TicketInput mapping.
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
	"strconv"
	"strings"
	"time"
)

const (
	gorgiasDefaultUserAgent = "Moosewave Gorgias Integration"
	gorgiasResponseMaxBytes = 16 << 20
	gorgiasDefaultPageSize  = 100
	gorgiasMaxPageSize      = 100
	gorgiasCursorPrefix     = "gorgias:"
	gorgiasCursorComplete   = "gorgias:complete"
)

type GorgiasCredentials struct {
	Email      string
	APIKey     string
	Domain     string
	APIBaseURL string
	UserAgent  string
}

type GorgiasCredentialResolver interface {
	ResolveGorgias(ctx context.Context, tenantID string, integration Integration) (GorgiasCredentials, error)
}

type gorgiasCredentialPayload struct {
	Email      string `json:"email"`
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	Domain     string `json:"domain"`
	Subdomain  string `json:"subdomain"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p gorgiasCredentialPayload) credentials() (GorgiasCredentials, error) {
	creds := GorgiasCredentials{
		Email:      strings.TrimSpace(p.Email),
		APIKey:     strings.TrimSpace(firstString(p.APIKey, p.Token)),
		Domain:     strings.TrimSpace(firstString(p.Domain, p.Subdomain)),
		APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:  strings.TrimSpace(p.UserAgent),
	}
	if creds.Email == "" || creds.APIKey == "" {
		return GorgiasCredentials{}, fmt.Errorf("gorgias requires an email + api_key pair")
	}
	return creds, nil
}

type GorgiasSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r GorgiasSecretsCredentialResolver) ResolveGorgias(ctx context.Context, _ string, integration Integration) (GorgiasCredentials, error) {
	if r.Secrets == nil {
		return GorgiasCredentials{}, fmt.Errorf("gorgias credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return GorgiasCredentials{}, fmt.Errorf("gorgias credentials_ref is required")
	}
	var payload gorgiasCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return r.withDomain(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return GorgiasCredentials{}, fmt.Errorf("resolve gorgias credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return r.withDomain(creds, integration), nil
			}
		}
	}
	return GorgiasCredentials{}, fmt.Errorf("gorgias requires a JSON {email, api_key} secret")
}

func (r GorgiasSecretsCredentialResolver) withDomain(creds GorgiasCredentials, integration Integration) GorgiasCredentials {
	if creds.Domain == "" {
		creds.Domain = settingString(integration.Settings, "domain")
	}
	if creds.Domain == "" {
		creds.Domain = settingString(integration.Settings, "subdomain")
	}
	if creds.Domain == "" {
		creds.Domain = settingString(integration.Settings, "account_domain")
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = settingString(integration.Settings, "api_base_url")
	}
	return creds
}

type GorgiasBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type GorgiasTicketRefresher interface {
	RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketID string) (SyncRequest, error)
}

type GorgiasHTTPIntegrationCleaner interface {
	DeleteGorgiasHTTPIntegration(ctx context.Context, tenantID string, integration Integration, integrationID string) (GorgiasHTTPIntegrationCleanupResult, error)
}

type GorgiasHTTPIntegrationCleanupResult struct {
	IntegrationID      string `json:"integration_id"`
	Status             string `json:"status"`
	ProviderStatusCode int    `json:"provider_status_code,omitempty"`
}

type GorgiasRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials GorgiasCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type gorgiasTicket struct {
	ID       json.Number `json:"id"`
	Subject  string      `json:"subject"`
	Status   string      `json:"status"`
	Priority string      `json:"priority"`
	Tags     []struct {
		Name string `json:"name"`
	} `json:"tags"`
	Customer struct {
		ID    json.Number `json:"id"`
		Email string      `json:"email"`
		Name  string      `json:"name"`
	} `json:"customer"`
	UpdatedDatetime string `json:"updated_datetime"`
	Raw             map[string]any
}

func (t *gorgiasTicket) UnmarshalJSON(body []byte) error {
	type alias gorgiasTicket
	var decoded alias
	if err := json.Unmarshal(body, &decoded); err != nil {
		return err
	}
	*t = gorgiasTicket(decoded)
	_ = json.Unmarshal(body, &t.Raw)
	return nil
}

type gorgiasTicketsResponse struct {
	Data []gorgiasTicket `json:"data"`
	Meta struct {
		NextCursor string `json:"next_cursor"`
	} `json:"meta"`
}

type gorgiasTicketResponse struct {
	Ticket gorgiasTicket
}

func (r *gorgiasTicketResponse) UnmarshalJSON(body []byte) error {
	var wrapped struct {
		Data gorgiasTicket `json:"data"`
	}
	if err := json.Unmarshal(body, &wrapped); err == nil && strings.TrimSpace(wrapped.Data.ID.String()) != "" {
		r.Ticket = wrapped.Data
		return nil
	}
	var direct gorgiasTicket
	if err := json.Unmarshal(body, &direct); err != nil {
		return err
	}
	r.Ticket = direct
	return nil
}

func (b GorgiasRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderGorgias {
		return SyncRequest{}, fmt.Errorf("gorgias backfill requires a Gorgias integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("gorgias credential resolver is not configured")
	}
	state := decodeGorgiasCursor(cursor)
	if state == gorgiasCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: gorgiasCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveGorgias(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderGorgias, 30*time.Second)
	baseURL := gorgiasBaseURL(b.APIBaseURL, creds)
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("gorgias domain or api_base_url is required")
	}
	query := url.Values{}
	query.Set("limit", strconv.Itoa(gorgiasPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
	query.Set("order_by", "updated_datetime:desc")
	if state != "" {
		query.Set("cursor", state)
	}

	var out gorgiasTicketsResponse
	if err := gorgiasDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/tickets", query, &out); err != nil {
		return SyncRequest{}, err
	}
	tickets := make([]TicketInput, 0, len(out.Data))
	for _, tk := range out.Data {
		if mapped, ok := mapGorgiasTicket(tk); ok {
			tickets = append(tickets, mapped)
		}
	}
	nextCursor := gorgiasCursorComplete
	if strings.TrimSpace(out.Meta.NextCursor) != "" {
		nextCursor = gorgiasCursorPrefix + strings.TrimSpace(out.Meta.NextCursor)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Cursor: nextCursor}, nil
}

func (b GorgiasRESTBackfiller) RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketID string) (SyncRequest, error) {
	if integration.Provider != ProviderGorgias {
		return SyncRequest{}, fmt.Errorf("gorgias ticket refresh requires a Gorgias integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("gorgias credential resolver is not configured")
	}
	ticketID = strings.TrimSpace(ticketID)
	if ticketID == "" {
		return SyncRequest{}, fmt.Errorf("gorgias ticket id is required")
	}
	creds, err := b.Credentials.ResolveGorgias(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderGorgias, 30*time.Second)
	baseURL := gorgiasBaseURL(b.APIBaseURL, creds)
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("gorgias domain or api_base_url is required")
	}
	var out gorgiasTicketResponse
	path := "/api/tickets/" + url.PathEscape(ticketID)
	if err := gorgiasDoJSON(ctx, client, baseURL, creds, b.UserAgent, path, nil, &out); err != nil {
		return SyncRequest{}, err
	}
	if mapped, ok := mapGorgiasTicket(out.Ticket); ok {
		return SyncRequest{RunMode: "webhook", Tickets: []TicketInput{mapped}, Cursor: "gorgias-refresh-" + ticketID}, nil
	}
	return SyncRequest{RunMode: "webhook", Cursor: "gorgias-refresh-" + ticketID}, nil
}

func (b GorgiasRESTBackfiller) DeleteGorgiasHTTPIntegration(ctx context.Context, tenantID string, integration Integration, integrationID string) (GorgiasHTTPIntegrationCleanupResult, error) {
	if integration.Provider != ProviderGorgias {
		return GorgiasHTTPIntegrationCleanupResult{}, fmt.Errorf("gorgias HTTP integration cleanup requires a Gorgias integration")
	}
	if b.Credentials == nil {
		return GorgiasHTTPIntegrationCleanupResult{}, fmt.Errorf("gorgias credential resolver is not configured")
	}
	integrationID = strings.TrimSpace(integrationID)
	if integrationID == "" {
		return GorgiasHTTPIntegrationCleanupResult{}, fmt.Errorf("gorgias HTTP integration id is required")
	}
	creds, err := b.Credentials.ResolveGorgias(ctx, tenantID, integration)
	if err != nil {
		return GorgiasHTTPIntegrationCleanupResult{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderGorgias, 30*time.Second)
	baseURL := gorgiasBaseURL(b.APIBaseURL, creds)
	if baseURL == "" {
		return GorgiasHTTPIntegrationCleanupResult{}, fmt.Errorf("gorgias domain or api_base_url is required")
	}
	path := "/api/integrations/" + url.PathEscape(integrationID)
	if err := gorgiasDo(ctx, client, http.MethodDelete, baseURL, creds, b.UserAgent, path, nil, nil); err != nil {
		var restErr GorgiasRESTError
		if errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound {
			return GorgiasHTTPIntegrationCleanupResult{IntegrationID: integrationID, Status: "already_absent", ProviderStatusCode: http.StatusNotFound}, nil
		}
		return GorgiasHTTPIntegrationCleanupResult{}, err
	}
	return GorgiasHTTPIntegrationCleanupResult{IntegrationID: integrationID, Status: "deleted", ProviderStatusCode: http.StatusNoContent}, nil
}

func mapGorgiasTicket(tk gorgiasTicket) (TicketInput, bool) {
	email := strings.ToLower(strings.TrimSpace(tk.Customer.Email))
	if email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(tk.ID.String())
	tags := make([]string, 0, len(tk.Tags))
	for _, t := range tk.Tags {
		if name := strings.TrimSpace(t.Name); name != "" {
			tags = append(tags, name)
		}
	}
	out := TicketInput{
		SourceID:       "gorgias://ticket/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  strings.TrimSpace(tk.Customer.Name),
		Subject:        strings.TrimSpace(tk.Subject),
		Status:         strings.TrimSpace(tk.Status),
		Priority:       strings.TrimSpace(tk.Priority),
		Tags:           tags,
		Properties:     map[string]any{"gorgias_ticket_id": id},
	}
	out.Properties = mergeGorgiasCommerceEvidence(out.Properties, tk.Raw)
	if t := parseGorgiasTime(tk.UpdatedDatetime); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func gorgiasBaseURL(override string, creds GorgiasCredentials) string {
	if v := strings.TrimRight(strings.TrimSpace(override), "/"); v != "" {
		return v
	}
	if v := strings.TrimRight(strings.TrimSpace(creds.APIBaseURL), "/"); v != "" {
		return v
	}
	if d := strings.TrimSpace(creds.Domain); d != "" {
		d = strings.TrimPrefix(strings.TrimPrefix(strings.TrimRight(d, "/"), "https://"), "http://")
		if strings.Contains(d, ".") {
			return "https://" + d
		}
		return "https://" + d + ".gorgias.com"
	}
	return ""
}

func gorgiasDoJSON(ctx context.Context, client *http.Client, baseURL string, creds GorgiasCredentials, userAgent, path string, query url.Values, out any) error {
	return gorgiasDo(ctx, client, http.MethodGet, baseURL, creds, userAgent, path, query, out)
}

func gorgiasDo(ctx context.Context, client *http.Client, method, baseURL string, creds GorgiasCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse gorgias API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return err
	}
	basic := base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(creds.Email) + ":" + strings.TrimSpace(creds.APIKey)))
	req.Header.Set("Authorization", "Basic "+basic)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, gorgiasDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, gorgiasResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return GorgiasRESTError{StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode gorgias response %s: %w", path, err)
	}
	return nil
}

type GorgiasRESTError struct {
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e GorgiasRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("gorgias REST failed %d; retry after %s: %s", e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("gorgias REST failed %d: %s", e.StatusCode, e.Snippet)
}

func decodeGorgiasCursor(cursor string) string {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return ""
	}
	if cursor == gorgiasCursorComplete {
		return gorgiasCursorComplete
	}
	return strings.TrimPrefix(cursor, gorgiasCursorPrefix)
}

func gorgiasPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return gorgiasDefaultPageSize
	}
	if n > gorgiasMaxPageSize {
		return gorgiasMaxPageSize
	}
	return n
}

func parseGorgiasTime(value string) *time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05Z", "2006-01-02T15:04:05"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			utc := parsed.UTC()
			return &utc
		}
	}
	return nil
}
