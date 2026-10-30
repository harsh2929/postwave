// SPDX-License-Identifier: AGPL-3.0-only
//
// freshdesk.go — native Freshdesk provider runtime.
//
// Freshdesk is a common SMB helpdesk; tickets enrich subscriber profiles and
// trigger retention messaging. Mirrors the Zendesk puller: a credential
// resolver (API key, HTTP Basic with a dummy password) + a REST puller over the
// Tickets API (page-number pagination, requester embedding, optional local
// product filtering) + canonical TicketInput mapping.
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
	freshdeskDefaultUserAgent = "Moosewave Freshdesk Integration"
	freshdeskResponseMaxBytes = 16 << 20
	freshdeskDefaultPageSize  = 100
	freshdeskMaxPageSize      = 100
	freshdeskCursorPrefix     = "freshdesk:"
	freshdeskCursorComplete   = "freshdesk:complete"
)

type FreshdeskCredentials struct {
	APIKey     string
	Domain     string
	APIBaseURL string
	UserAgent  string
}

type FreshdeskCredentialResolver interface {
	ResolveFreshdesk(ctx context.Context, tenantID string, integration Integration) (FreshdeskCredentials, error)
}

type freshdeskCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	Account    string `json:"account_domain"`
	Domain     string `json:"domain"`
	Subdomain  string `json:"subdomain"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p freshdeskCredentialPayload) credentials() (FreshdeskCredentials, error) {
	creds := FreshdeskCredentials{
		APIKey:     strings.TrimSpace(firstString(p.APIKey, p.Token)),
		Domain:     normalizeFreshdeskDomain(firstString(p.Account, p.Domain, p.Subdomain)),
		APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:  strings.TrimSpace(p.UserAgent),
	}
	if creds.APIKey == "" {
		return FreshdeskCredentials{}, fmt.Errorf("freshdesk requires an api_key")
	}
	return creds, nil
}

type FreshdeskSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r FreshdeskSecretsCredentialResolver) ResolveFreshdesk(ctx context.Context, _ string, integration Integration) (FreshdeskCredentials, error) {
	if r.Secrets == nil {
		return FreshdeskCredentials{}, fmt.Errorf("freshdesk credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return FreshdeskCredentials{}, fmt.Errorf("freshdesk credentials_ref is required")
	}
	var payload freshdeskCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return r.withDomain(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return FreshdeskCredentials{}, fmt.Errorf("resolve freshdesk credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return r.withDomain(creds, integration), nil
			}
		}
	}
	// A bare string is treated as the API key.
	creds, err := freshdeskCredentialPayload{APIKey: raw}.credentials()
	if err != nil {
		return FreshdeskCredentials{}, err
	}
	return r.withDomain(creds, integration), nil
}

func (r FreshdeskSecretsCredentialResolver) withDomain(creds FreshdeskCredentials, integration Integration) FreshdeskCredentials {
	if creds.Domain == "" {
		creds.Domain = firstString(
			settingString(integration.Settings, "account_domain"),
			settingString(integration.Settings, "domain"),
			settingString(integration.Settings, "subdomain"),
		)
	}
	creds.Domain = normalizeFreshdeskDomain(creds.Domain)
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type FreshdeskBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type FreshdeskTicketRefresher interface {
	RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketID string) (SyncRequest, error)
}

type FreshdeskRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials FreshdeskCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type freshdeskRequester struct {
	ID        json.Number `json:"id"`
	Name      string      `json:"name"`
	Email     string      `json:"email"`
	Mobile    string      `json:"mobile"`
	Phone     string      `json:"phone"`
	CompanyID json.Number `json:"company_id"`
}

type freshdeskTicket struct {
	ID          json.Number        `json:"id"`
	Subject     string             `json:"subject"`
	Status      int                `json:"status"`
	Priority    int                `json:"priority"`
	Tags        []string           `json:"tags"`
	Email       string             `json:"email"`
	RequesterID json.Number        `json:"requester_id"`
	ProductID   json.Number        `json:"product_id"`
	CompanyID   json.Number        `json:"company_id"`
	UpdatedAt   string             `json:"updated_at"`
	Requester   freshdeskRequester `json:"requester"`
}

func (b FreshdeskRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderFreshdesk {
		return SyncRequest{}, fmt.Errorf("freshdesk backfill requires a Freshdesk integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("freshdesk credential resolver is not configured")
	}
	page, done := freshdeskPageCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: freshdeskCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveFreshdesk(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderFreshdesk, 30*time.Second)
	baseURL := freshdeskBaseURL(b.APIBaseURL, creds)
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("freshdesk domain or api_base_url is required")
	}
	perPage := freshdeskPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("per_page", strconv.Itoa(perPage))
	query.Set("page", strconv.Itoa(page))
	query.Set("order_by", "updated_at")
	query.Set("order_type", "desc")
	query.Set("include", "requester")
	productFilter := freshdeskProductIDFilter(integration.Settings)

	var tickets []freshdeskTicket
	if err := freshdeskDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v2/tickets", query, &tickets); err != nil {
		return SyncRequest{}, err
	}
	out := make([]TicketInput, 0, len(tickets))
	for _, tk := range tickets {
		if !freshdeskTicketMatchesProduct(tk, productFilter) {
			continue
		}
		if mapped, ok := mapFreshdeskTicket(tk); ok {
			out = append(out, mapped)
		}
	}
	nextCursor := freshdeskCursorComplete
	if len(tickets) >= perPage {
		nextCursor = freshdeskCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Tickets: out, Cursor: nextCursor}, nil
}

func (b FreshdeskRESTBackfiller) RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketID string) (SyncRequest, error) {
	if integration.Provider != ProviderFreshdesk {
		return SyncRequest{}, fmt.Errorf("freshdesk refresh requires a Freshdesk integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("freshdesk credential resolver is not configured")
	}
	ticketID = strings.TrimSpace(ticketID)
	if ticketID == "" {
		return SyncRequest{}, fmt.Errorf("freshdesk ticket id is required")
	}
	creds, err := b.Credentials.ResolveFreshdesk(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderFreshdesk, 30*time.Second)
	baseURL := freshdeskBaseURL(b.APIBaseURL, creds)
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("freshdesk domain or api_base_url is required")
	}
	query := url.Values{}
	query.Set("include", "requester")
	var ticket freshdeskTicket
	if err := freshdeskDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/api/v2/tickets/"+url.PathEscape(ticketID), query, &ticket); err != nil {
		return SyncRequest{}, err
	}
	cursor := "freshdesk-webhook-" + ticketID
	if !freshdeskTicketMatchesProduct(ticket, freshdeskProductIDFilter(integration.Settings)) {
		return SyncRequest{RunMode: "webhook", Cursor: cursor}, nil
	}
	mapped, ok := mapFreshdeskTicket(ticket)
	if !ok {
		return SyncRequest{RunMode: "webhook", Cursor: cursor}, nil
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{mapped}, Cursor: cursor}), nil
}

func freshdeskProductIDFilter(settings map[string]any) string {
	return strings.TrimSpace(settingString(settings, "product_id"))
}

func freshdeskTicketMatchesProduct(tk freshdeskTicket, productID string) bool {
	productID = strings.TrimSpace(productID)
	if productID == "" {
		return true
	}
	return strings.TrimSpace(tk.ProductID.String()) == productID
}

func mapFreshdeskTicket(tk freshdeskTicket) (TicketInput, bool) {
	email := strings.ToLower(strings.TrimSpace(firstString(tk.Email, tk.Requester.Email)))
	if email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(tk.ID.String())
	requesterID := strings.TrimSpace(firstString(tk.RequesterID.String(), tk.Requester.ID.String()))
	out := TicketInput{
		SourceID:       "freshdesk://ticket/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  strings.TrimSpace(tk.Requester.Name),
		Subject:        strings.TrimSpace(tk.Subject),
		Status:         freshdeskStatusLabel(tk.Status),
		Priority:       freshdeskPriorityLabel(tk.Priority),
		Tags:           tk.Tags,
		Properties: map[string]any{
			"freshdesk_ticket_id":    id,
			"freshdesk_requester_id": requesterID,
		},
	}
	if productID := strings.TrimSpace(tk.ProductID.String()); productID != "" {
		out.Properties["freshdesk_product_id"] = productID
	}
	if companyID := strings.TrimSpace(firstString(tk.CompanyID.String(), tk.Requester.CompanyID.String())); companyID != "" {
		out.Properties["freshdesk_company_id"] = companyID
	}
	if mobile := strings.TrimSpace(tk.Requester.Mobile); mobile != "" {
		out.Properties["freshdesk_requester_mobile"] = mobile
	}
	if phone := strings.TrimSpace(tk.Requester.Phone); phone != "" {
		out.Properties["freshdesk_requester_phone"] = phone
	}
	if t := parseFreshdeskTime(tk.UpdatedAt); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

// freshdeskStatusLabel maps Freshdesk's numeric ticket status to a canonical
// label (2=open, 3=pending, 4=resolved, 5=closed; custom statuses pass through
// as their number).
func freshdeskStatusLabel(status int) string {
	switch status {
	case 2:
		return "open"
	case 3:
		return "pending"
	case 4:
		return "resolved"
	case 5:
		return "closed"
	default:
		return strconv.Itoa(status)
	}
}

func freshdeskPriorityLabel(priority int) string {
	switch priority {
	case 1:
		return "low"
	case 2:
		return "medium"
	case 3:
		return "high"
	case 4:
		return "urgent"
	default:
		return strconv.Itoa(priority)
	}
}

func freshdeskBaseURL(override string, creds FreshdeskCredentials) string {
	if v := strings.TrimRight(strings.TrimSpace(override), "/"); v != "" {
		return v
	}
	if v := strings.TrimRight(strings.TrimSpace(creds.APIBaseURL), "/"); v != "" {
		return v
	}
	if d := normalizeFreshdeskDomain(creds.Domain); d != "" {
		return "https://" + d + ".freshdesk.com"
	}
	return ""
}

func normalizeFreshdeskDomain(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "https://")
	value = strings.TrimPrefix(value, "http://")
	if slash := strings.Index(value, "/"); slash >= 0 {
		value = value[:slash]
	}
	value = strings.TrimSuffix(strings.TrimSpace(value), ".")
	value = strings.TrimSuffix(value, ".freshdesk.com")
	return strings.TrimSpace(value)
}

func freshdeskDoJSON(ctx context.Context, client *http.Client, baseURL string, creds FreshdeskCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse freshdesk API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	// Freshdesk uses HTTP Basic with the API key as the username and any value
	// (conventionally "X") as the password.
	basic := base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(creds.APIKey) + ":X"))
	req.Header.Set("Authorization", "Basic "+basic)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, freshdeskDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, freshdeskResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return FreshdeskRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode freshdesk response %s: %w", path, err)
	}
	return nil
}

type FreshdeskRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e FreshdeskRESTError) Error() string {
	if e.Path == "" {
		if e.RetryAfter > 0 {
			return fmt.Sprintf("freshdesk REST failed %d; retry after %s: %s", e.StatusCode, e.RetryAfter, e.Snippet)
		}
		return fmt.Sprintf("freshdesk REST failed %d: %s", e.StatusCode, e.Snippet)
	}
	if e.RetryAfter > 0 {
		return fmt.Sprintf("freshdesk REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("freshdesk REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func freshdeskPageCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == freshdeskCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, freshdeskCursorPrefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}

func decodeFreshdeskCursor(cursor string) string {
	page, done := freshdeskPageCursor(cursor)
	if done {
		return freshdeskCursorComplete
	}
	if page <= 1 {
		return ""
	}
	return strconv.Itoa(page)
}

func freshdeskPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return freshdeskDefaultPageSize
	}
	if n > freshdeskMaxPageSize {
		return freshdeskMaxPageSize
	}
	return n
}

func parseFreshdeskTime(value string) *time.Time {
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
