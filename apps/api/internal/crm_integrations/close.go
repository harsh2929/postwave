// SPDX-License-Identifier: AGPL-3.0-only
//
// close.go — native Close CRM provider runtime.
//
// Close authenticates with a static API key (HTTP Basic, key as username), so
// unlike the OAuth Wave-2 providers this is a static-token REST puller: a
// credential resolver over the secret vault + a REST puller over the Contacts
// API (_skip/_limit offset pagination + has_more) dispatched via
// providerManagedSyncRequest. No OAuth/refresh/worker — the API key is durable.
package crm_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const (
	closeDefaultAPIBaseURL = "https://api.close.com"
	closeDefaultUserAgent  = "Moosewave Close Integration"
	closeResponseMaxBytes  = 8 << 20
	closeDefaultPageSize   = 100
	closeMaxPageSize       = 100
	closeCursorPrefix      = "close:"
	closeCursorComplete    = "close:complete"
)

// CRMStaticSecretResolver is the trusted secrets backend for static-token CRMs
// (Close / Copper / Freshsales).
type CRMStaticSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type CloseCredentials struct {
	APIKey              string
	APIBaseURL          string
	UserAgent           string
	WebhookSignatureKey string
}

type CloseCredentialResolver interface {
	ResolveClose(context.Context, string, Integration) (CloseCredentials, error)
}

type closeCredentialPayload struct {
	APIKey                 string `json:"api_key"`
	Token                  string `json:"token"`
	APIBaseURL             string `json:"api_base_url"`
	UserAgent              string `json:"user_agent"`
	WebhookSignatureKey    string `json:"webhook_signature_key"`
	SignatureKey           string `json:"signature_key"`
	CloseWebhookSigningKey string `json:"close_webhook_signature_key"`
}

func (p closeCredentialPayload) credentials() (CloseCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return CloseCredentials{}, fmt.Errorf("close api_key is required")
	}
	return CloseCredentials{
		APIKey:              key,
		APIBaseURL:          strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:           strings.TrimSpace(p.UserAgent),
		WebhookSignatureKey: strings.TrimSpace(firstString(p.WebhookSignatureKey, p.SignatureKey, p.CloseWebhookSigningKey)),
	}, nil
}

type CloseSecretsCredentialResolver struct {
	Secrets CRMStaticSecretResolver
}

func NewCloseSecretsCredentialResolver(secrets CRMStaticSecretResolver) *CloseSecretsCredentialResolver {
	return &CloseSecretsCredentialResolver{Secrets: secrets}
}

func (r *CloseSecretsCredentialResolver) ResolveClose(ctx context.Context, _ string, integration Integration) (CloseCredentials, error) {
	if r == nil || r.Secrets == nil {
		return CloseCredentials{}, fmt.Errorf("close credential resolver is not configured")
	}
	ref := crmStaticCredentialRef(integration)
	if ref == "" {
		return CloseCredentials{}, fmt.Errorf("close credentials_ref is required")
	}
	var payload closeCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return withCloseBaseURL(creds, integration), nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return CloseCredentials{}, fmt.Errorf("resolve close credentials %q: %w", ref, err)
	}
	creds, err := parseCloseCredentialSecret(raw)
	if err != nil {
		return CloseCredentials{}, err
	}
	return withCloseBaseURL(creds, integration), nil
}

func withCloseBaseURL(creds CloseCredentials, integration Integration) CloseCredentials {
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "api_base_url")), "/")
	}
	return creds
}

func parseCloseCredentialSecret(raw string) (CloseCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return CloseCredentials{}, fmt.Errorf("close credentials are empty")
	}
	if strings.HasPrefix(raw, "{") {
		var p closeCredentialPayload
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			return CloseCredentials{}, fmt.Errorf("parse close credential JSON: %w", err)
		}
		return p.credentials()
	}
	return closeCredentialPayload{APIKey: raw}.credentials()
}

type CloseBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type CloseRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials CloseCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type closeContact struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Title  string `json:"title"`
	LeadID string `json:"lead_id"`
	Emails []struct {
		Email string `json:"email"`
	} `json:"emails"`
	Phones []struct {
		Phone string `json:"phone"`
	} `json:"phones"`
	DateUpdated string `json:"date_updated"`
}

type closeContactsResponse struct {
	Data    []closeContact `json:"data"`
	HasMore bool           `json:"has_more"`
}

func (b CloseRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderClose {
		return SyncRequest{}, fmt.Errorf("close backfill requires a Close integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("close credential resolver is not configured")
	}
	skip, done := crmOffsetCursor(cursor, closeCursorPrefix, closeCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: closeCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveClose(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := crmHTTPClient(b.HTTPClient, ProviderClose)
	limit := crmPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)), closeDefaultPageSize, closeMaxPageSize)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(settingString(integration.Settings, "api_base_url"), "/"), strings.TrimRight(creds.APIBaseURL, "/"), closeDefaultAPIBaseURL)
	query := url.Values{}
	query.Set("_skip", strconv.Itoa(skip))
	query.Set("_limit", strconv.Itoa(limit))

	var out closeContactsResponse
	headers := map[string]string{"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte(creds.APIKey+":"))}
	if err := crmStaticDoJSON(ctx, client, http.MethodGet, baseURL, "/api/v1/contact/", query, headers, nil, firstString(b.UserAgent, creds.UserAgent, closeDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	contacts := make([]ContactInput, 0, len(out.Data))
	for _, c := range out.Data {
		if mapped, ok := mapCloseContact(c, integration); ok {
			contacts = append(contacts, mapped)
		}
	}
	nextCursor := closeCursorComplete
	if out.HasMore && len(out.Data) > 0 {
		nextCursor = closeCursorPrefix + strconv.Itoa(skip+limit)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Contacts: contacts, Cursor: nextCursor}), nil
}

func mapCloseContact(c closeContact, integration Integration) (ContactInput, bool) {
	email := ""
	for _, e := range c.Emails {
		if v := strings.ToLower(strings.TrimSpace(e.Email)); v != "" {
			email = v
			break
		}
	}
	if email == "" {
		return ContactInput{}, false
	}
	phone := ""
	for _, p := range c.Phones {
		if v := strings.TrimSpace(p.Phone); v != "" {
			phone = v
			break
		}
	}
	id := firstString(strings.TrimSpace(c.ID), email)
	out := ContactInput{
		SourceID:       "close://contact/" + id,
		Email:          email,
		FullName:       strings.TrimSpace(c.Name),
		Phone:          phone,
		LifecycleStage: strings.TrimSpace(c.Title),
		ListIDs:        crmListIDs(integration),
		Tags:           crmDefaultTags(integration, "close"),
		Properties:     map[string]any{"close_id": id, "close_lead_id": strings.TrimSpace(c.LeadID), "close_raw": c},
	}
	if t := firstParsedHubSpotTime(c.DateUpdated); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}
