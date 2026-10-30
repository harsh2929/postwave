// SPDX-License-Identifier: AGPL-3.0-only
//
// hubspot_service_hub.go — native HubSpot Service Hub provider runtime.
//
// HubSpot Service Hub tickets via the CRM v3 API. Token-supplied Bearer auth,
// GET /crm/v3/objects/tickets?associations=contacts (limit + opaque `after`
// cursor). Tickets carry the contact only as an association, so the email is
// resolved via a per-page sideload cache from /crm/v3/objects/contacts/{id}.
// Maps to canonical TicketInput via the support providerPull. (Consumes a
// supplied token; managed HubSpot OAuth refresh already exists in
// crm_integrations and is the follow-on for shared credential management.)
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
	hubSpotServiceDefaultAPIBaseURL = "https://api.hubapi.com"
	hubSpotServiceDefaultUserAgent  = "Moosewave HubSpot Service Hub Integration"
	hubSpotServiceResponseMaxBytes  = 16 << 20
	hubSpotServiceDefaultPageSize   = 100
	hubSpotServiceMaxPageSize       = 100
	hubSpotServiceCursorPrefix      = "hubspot-service-hub:"
	hubSpotServiceCursorComplete    = "hubspot-service-hub:complete"
)

type HubSpotServiceHubCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type HubSpotServiceHubCredentialResolver interface {
	ResolveHubSpotServiceHub(ctx context.Context, tenantID string, integration Integration) (HubSpotServiceHubCredentials, error)
}

type hubSpotServiceCredentialPayload struct {
	AccessToken string `json:"access_token"`
	Token       string `json:"token"`
	APIKey      string `json:"api_key"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p hubSpotServiceCredentialPayload) credentials() (HubSpotServiceHubCredentials, error) {
	token := strings.TrimSpace(firstString(p.AccessToken, p.Token, p.APIKey))
	if token == "" {
		return HubSpotServiceHubCredentials{}, fmt.Errorf("hubspot service hub access_token is required")
	}
	return HubSpotServiceHubCredentials{AccessToken: token, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type HubSpotServiceHubSecretsCredentialResolver struct {
	Secrets SupportRuntimeSecretResolver
}

func (r HubSpotServiceHubSecretsCredentialResolver) ResolveHubSpotServiceHub(ctx context.Context, _ string, integration Integration) (HubSpotServiceHubCredentials, error) {
	if r.Secrets == nil {
		return HubSpotServiceHubCredentials{}, fmt.Errorf("hubspot service hub credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return HubSpotServiceHubCredentials{}, fmt.Errorf("hubspot service hub credentials_ref is required")
	}
	var payload hubSpotServiceCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withHubSpotServiceBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return HubSpotServiceHubCredentials{}, fmt.Errorf("resolve hubspot service hub credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return withHubSpotServiceBaseURL(creds, integration), nil
			}
		}
	}
	creds, err := hubSpotServiceCredentialPayload{AccessToken: raw}.credentials()
	if err != nil {
		return HubSpotServiceHubCredentials{}, err
	}
	return withHubSpotServiceBaseURL(creds, integration), nil
}

func withHubSpotServiceBaseURL(creds HubSpotServiceHubCredentials, integration Integration) HubSpotServiceHubCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

type HubSpotServiceHubBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type HubSpotServiceHubTicketRefresher interface {
	RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketID string) (SyncRequest, error)
}

type HubSpotServiceHubRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials HubSpotServiceHubCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type hubSpotServiceTicket struct {
	ID         string `json:"id"`
	Properties struct {
		Subject         string `json:"subject"`
		PipelineID      string `json:"hs_pipeline"`
		PipelineStage   string `json:"hs_pipeline_stage"`
		LastModified    string `json:"hs_lastmodifieddate"`
		PipelinePriorit string `json:"hs_ticket_priority"`
	} `json:"properties"`
	Associations struct {
		Contacts struct {
			Results []struct {
				ID string `json:"id"`
			} `json:"results"`
		} `json:"contacts"`
	} `json:"associations"`
}

type hubSpotServiceTicketsResponse struct {
	Results []hubSpotServiceTicket `json:"results"`
	Paging  struct {
		Next struct {
			After string `json:"after"`
		} `json:"next"`
	} `json:"paging"`
}

type hubSpotServiceContactResponse struct {
	Properties struct {
		Email     string `json:"email"`
		FirstName string `json:"firstname"`
		LastName  string `json:"lastname"`
	} `json:"properties"`
}

func (b HubSpotServiceHubRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderHubSpotServiceHub {
		return SyncRequest{}, fmt.Errorf("hubspot service hub backfill requires a HubSpot Service Hub integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("hubspot service hub credential resolver is not configured")
	}
	cursor = strings.TrimSpace(cursor)
	if cursor == hubSpotServiceCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: hubSpotServiceCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveHubSpotServiceHub(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderHubSpotServiceHub, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), hubSpotServiceDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("limit", strconv.Itoa(hubSpotServicePageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
	query.Set("properties", hubSpotServiceTicketProperties())
	query.Set("associations", "contacts")
	if strings.HasPrefix(cursor, hubSpotServiceCursorPrefix) {
		query.Set("after", strings.TrimPrefix(cursor, hubSpotServiceCursorPrefix))
	}

	var out hubSpotServiceTicketsResponse
	if err := hubSpotServiceDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/crm/v3/objects/tickets", query, &out); err != nil {
		return SyncRequest{}, err
	}
	emails := map[string]hubSpotServiceContact{}
	tickets := make([]TicketInput, 0, len(out.Results))
	pipelineID := strings.TrimSpace(settingString(integration.Settings, "pipeline_id"))
	for _, tk := range out.Results {
		if !hubSpotServiceTicketMatchesPipeline(tk, pipelineID) {
			continue
		}
		contactID := ""
		if len(tk.Associations.Contacts.Results) > 0 {
			contactID = strings.TrimSpace(tk.Associations.Contacts.Results[0].ID)
		}
		contact, ok := emails[contactID]
		if !ok && contactID != "" {
			contact = b.fetchContact(ctx, client, baseURL, creds, contactID)
			emails[contactID] = contact
		}
		if mapped, ok := mapHubSpotServiceTicket(tk, contact); ok {
			tickets = append(tickets, mapped)
		}
	}
	nextCursor := hubSpotServiceCursorComplete
	if strings.TrimSpace(out.Paging.Next.After) != "" {
		nextCursor = hubSpotServiceCursorPrefix + strings.TrimSpace(out.Paging.Next.After)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Cursor: nextCursor}, nil
}

func (b HubSpotServiceHubRESTBackfiller) RefreshTicket(ctx context.Context, tenantID string, integration Integration, ticketID string) (SyncRequest, error) {
	if integration.Provider != ProviderHubSpotServiceHub {
		return SyncRequest{}, fmt.Errorf("hubspot service hub refresh requires a HubSpot Service Hub integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("hubspot service hub credential resolver is not configured")
	}
	ticketID = strings.TrimSpace(ticketID)
	if ticketID == "" {
		return SyncRequest{}, fmt.Errorf("hubspot service hub ticket_id is required")
	}
	creds, err := b.Credentials.ResolveHubSpotServiceHub(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderHubSpotServiceHub, 30*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), hubSpotServiceDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("properties", hubSpotServiceTicketProperties())
	query.Set("associations", "contacts")
	var tk hubSpotServiceTicket
	if err := hubSpotServiceDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/crm/v3/objects/tickets/"+url.PathEscape(ticketID), query, &tk); err != nil {
		return SyncRequest{}, err
	}
	contactID := ""
	if len(tk.Associations.Contacts.Results) > 0 {
		contactID = strings.TrimSpace(tk.Associations.Contacts.Results[0].ID)
	}
	contact, err := b.fetchContactStrict(ctx, client, baseURL, creds, contactID)
	if err != nil {
		return SyncRequest{}, err
	}
	if !hubSpotServiceTicketMatchesPipeline(tk, strings.TrimSpace(settingString(integration.Settings, "pipeline_id"))) {
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Cursor: "hubspot-service-hub-webhook-" + ticketID}), nil
	}
	if mapped, ok := mapHubSpotServiceTicket(tk, contact); ok {
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{mapped}, Cursor: "hubspot-service-hub-webhook-" + ticketID}), nil
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Cursor: "hubspot-service-hub-webhook-" + ticketID}), nil
}

type hubSpotServiceContact struct {
	Email string
	Name  string
}

func (b HubSpotServiceHubRESTBackfiller) fetchContact(ctx context.Context, client *http.Client, baseURL string, creds HubSpotServiceHubCredentials, id string) hubSpotServiceContact {
	q := url.Values{}
	q.Set("properties", "email,firstname,lastname")
	var out hubSpotServiceContactResponse
	if err := hubSpotServiceDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/crm/v3/objects/contacts/"+url.PathEscape(id), q, &out); err != nil {
		return hubSpotServiceContact{}
	}
	return hubSpotServiceContact{
		Email: strings.ToLower(strings.TrimSpace(out.Properties.Email)),
		Name:  strings.TrimSpace(strings.TrimSpace(out.Properties.FirstName + " " + out.Properties.LastName)),
	}
}

func (b HubSpotServiceHubRESTBackfiller) fetchContactStrict(ctx context.Context, client *http.Client, baseURL string, creds HubSpotServiceHubCredentials, id string) (hubSpotServiceContact, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return hubSpotServiceContact{}, nil
	}
	q := url.Values{}
	q.Set("properties", "email,firstname,lastname")
	var out hubSpotServiceContactResponse
	if err := hubSpotServiceDoJSON(ctx, client, baseURL, creds, b.UserAgent, "/crm/v3/objects/contacts/"+url.PathEscape(id), q, &out); err != nil {
		return hubSpotServiceContact{}, err
	}
	return hubSpotServiceContact{
		Email: strings.ToLower(strings.TrimSpace(out.Properties.Email)),
		Name:  strings.TrimSpace(strings.TrimSpace(out.Properties.FirstName + " " + out.Properties.LastName)),
	}, nil
}

func mapHubSpotServiceTicket(tk hubSpotServiceTicket, contact hubSpotServiceContact) (TicketInput, bool) {
	if contact.Email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(tk.ID)
	out := TicketInput{
		SourceID:       "hubspot-service-hub://ticket/" + id,
		ConversationID: id,
		Email:          contact.Email,
		RequesterName:  contact.Name,
		Subject:        strings.TrimSpace(tk.Properties.Subject),
		Status:         strings.TrimSpace(tk.Properties.PipelineStage),
		Priority:       strings.TrimSpace(tk.Properties.PipelinePriorit),
		Properties: map[string]any{
			"hubspot_ticket_id":   id,
			"hubspot_pipeline_id": strings.TrimSpace(tk.Properties.PipelineID),
		},
	}
	if t := parseZendeskTime(tk.Properties.LastModified); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func hubSpotServiceTicketProperties() string {
	return "subject,hs_pipeline,hs_pipeline_stage,hs_ticket_priority,hs_lastmodifieddate"
}

func hubSpotServiceTicketMatchesPipeline(tk hubSpotServiceTicket, pipelineID string) bool {
	pipelineID = strings.TrimSpace(pipelineID)
	if pipelineID == "" {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(tk.Properties.PipelineID), pipelineID)
}

func hubSpotServiceDoJSON(ctx context.Context, client *http.Client, baseURL string, creds HubSpotServiceHubCredentials, userAgent, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse hubspot service hub API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	if query != nil {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, hubSpotServiceDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, hubSpotServiceResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return HubSpotServiceHubRESTError{Path: path, StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode hubspot service hub response %s: %w", path, err)
	}
	return nil
}

type HubSpotServiceHubRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e HubSpotServiceHubRESTError) Error() string {
	if e.Path == "" {
		if e.RetryAfter > 0 {
			return fmt.Sprintf("hubspot service hub REST failed %d; retry after %s: %s", e.StatusCode, e.RetryAfter, e.Snippet)
		}
		return fmt.Sprintf("hubspot service hub REST failed %d: %s", e.StatusCode, e.Snippet)
	}
	if e.RetryAfter > 0 {
		return fmt.Sprintf("hubspot service hub REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("hubspot service hub REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func hubSpotServicePageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return hubSpotServiceDefaultPageSize
	}
	if n > hubSpotServiceMaxPageSize {
		return hubSpotServiceMaxPageSize
	}
	return n
}
