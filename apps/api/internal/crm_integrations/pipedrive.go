// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
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

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	pipedriveSyncModelPersonsDealsOrgsActivitiesREST = "pipedrive_crm_persons_deals_organizations_activities_v2_rest"
	pipedriveCursorPrefix                            = "pipedrive:"
	pipedriveCursorComplete                          = "pipedrive:complete"
	pipedriveDefaultLimit                            = 100
	pipedriveMaxLimit                                = 500
	pipedriveResponseMaxBytes                        = 8 << 20
	pipedriveDefaultUserAgent                        = "Moosewave Pipedrive Integration"
	pipedriveDefaultOAuthBaseURL                     = "https://oauth.pipedrive.com"
	pipedriveWebhookMaxBodyBytes                     = 1 << 20
	pipedriveStoredCredentialRefPrefix               = "crm:pipedrive:"
)

type PipedriveCredentials struct {
	APIToken        string
	AccessToken     string
	RefreshToken    string
	ClientID        string
	ClientSecret    string
	APIBaseURL      string
	OAuthBaseURL    string
	UserAgent       string
	Scope           string
	TokenExpiresAt  *time.Time
	WebhookUsername string
	WebhookPassword string
}

type PipedriveCredentialResolver interface {
	ResolvePipedrive(context.Context, string, Integration) (PipedriveCredentials, error)
}

type PipedriveBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type PipedriveRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials PipedriveCredentialResolver
	APIBaseURL  string
	UserAgent   string
	Limit       int
}

type PipedriveWebhookRegistrar interface {
	ReconcileWebhooks(ctx context.Context, integration Integration, appBaseURL string) (PipedriveWebhookReconcileSummary, error)
	CleanupWebhooks(ctx context.Context, integration Integration, appBaseURL string) (PipedriveWebhookCleanupSummary, error)
}

type PipedriveWebhookRegistration struct {
	ID          string `json:"id,omitempty"`
	EventAction string `json:"event_action"`
	EventObject string `json:"event_object"`
	Endpoint    string `json:"endpoint,omitempty"`
	Version     string `json:"version,omitempty"`
	Created     bool   `json:"created,omitempty"`
	Reused      bool   `json:"reused,omitempty"`
	Deleted     bool   `json:"deleted,omitempty"`
}

type PipedriveWebhookReconcileSummary struct {
	Endpoint      string                         `json:"endpoint"`
	RegisteredAt  time.Time                      `json:"registered_at"`
	Subscriptions []PipedriveWebhookRegistration `json:"subscriptions"`
}

type PipedriveWebhookCleanupSummary struct {
	Endpoint      string                         `json:"endpoint"`
	CleanedUpAt   time.Time                      `json:"cleaned_up_at"`
	Subscriptions []PipedriveWebhookRegistration `json:"subscriptions"`
}

type PipedriveRESTWebhookRegistrar struct {
	HTTPClient  *http.Client
	Credentials PipedriveCredentialResolver
	APIBaseURL  string
	UserAgent   string
	Now         func() time.Time
	Topics      []string
}

type PipedriveOAuthClient struct {
	HTTPClient   *http.Client
	OAuthBaseURL string
	UserAgent    string
	Now          func() time.Time
}

type PipedriveOAuthToken struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	TokenType    string    `json:"token_type"`
	ExpiresIn    int       `json:"expires_in"`
	ExpiresAt    time.Time `json:"expires_at"`
	Scope        string    `json:"scope,omitempty"`
	APIBaseURL   string    `json:"api_domain,omitempty"`
}

type PipedriveCurrentUser struct {
	ID              string         `json:"id,omitempty"`
	Name            string         `json:"name,omitempty"`
	Email           string         `json:"email,omitempty"`
	Locale          string         `json:"locale,omitempty"`
	CompanyID       string         `json:"company_id,omitempty"`
	CompanyName     string         `json:"company_name,omitempty"`
	CompanyDomain   string         `json:"company_domain,omitempty"`
	CompanyCountry  string         `json:"company_country,omitempty"`
	CompanyIndustry string         `json:"company_industry,omitempty"`
	Raw             map[string]any `json:"raw,omitempty"`
}

type PipedriveOAuthRevocationSummary struct {
	Revoked   bool   `json:"revoked"`
	Skipped   bool   `json:"skipped,omitempty"`
	Reason    string `json:"reason,omitempty"`
	TokenType string `json:"token_type,omitempty"`
	RevokedAt string `json:"revoked_at,omitempty"`
}

type PipedriveRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type PipedriveCredentialStore interface {
	GetPipedriveCredentialSecret(context.Context, string, string) (string, error)
	PutPipedriveCredentialSecret(context.Context, string, string, PipedriveCredentials) error
}

type PipedriveCredentialDeleter interface {
	DeletePipedriveCredentialSecret(context.Context, string, string) error
}

type PipedriveSecretsCredentialResolver struct {
	Secrets     PipedriveRuntimeSecretResolver
	Store       PipedriveCredentialStore
	OAuthClient PipedriveOAuthClient
	RefreshSkew time.Duration
	Now         func() time.Time
}

func NewPipedriveSecretsCredentialResolver(secrets PipedriveRuntimeSecretResolver) *PipedriveSecretsCredentialResolver {
	return &PipedriveSecretsCredentialResolver{Secrets: secrets}
}

func (r *PipedriveSecretsCredentialResolver) ResolvePipedrive(ctx context.Context, tenantID string, integration Integration) (PipedriveCredentials, error) {
	if r == nil || (r.Secrets == nil && r.Store == nil) {
		return PipedriveCredentials{}, fmt.Errorf("pipedrive credential resolver is not configured")
	}
	ref := pipedriveCredentialRef(integration)
	if ref == "" {
		return PipedriveCredentials{}, fmt.Errorf("pipedrive credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, tenantID, ref)
	if err != nil {
		return PipedriveCredentials{}, err
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = settingString(integration.Settings, "api_base_url")
	}
	if creds.OAuthBaseURL == "" {
		creds.OAuthBaseURL = settingString(integration.Settings, "oauth_base_url")
	}
	if creds.UserAgent == "" {
		creds.UserAgent = settingString(integration.Settings, "user_agent")
	}
	return r.refreshCredentialIfNeeded(ctx, tenantID, ref, creds)
}

func (r *PipedriveSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, tenantID, ref string) (PipedriveCredentials, error) {
	if r.Store != nil && pipedriveIsStoredCredentialRef(ref) {
		raw, err := r.Store.GetPipedriveCredentialSecret(ctx, tenantID, ref)
		if err == nil {
			return parsePipedriveCredentialSecret(raw)
		}
		if !errors.Is(err, ErrNotFound) {
			return PipedriveCredentials{}, fmt.Errorf("resolve stored pipedrive credentials %q: %w", ref, err)
		}
	}
	if r.Secrets == nil {
		return PipedriveCredentials{}, fmt.Errorf("pipedrive credential secret resolver is not configured")
	}
	var payload pipedriveCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return PipedriveCredentials{}, fmt.Errorf("resolve pipedrive credentials %q: %w", ref, err)
		}
		return parsePipedriveCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return PipedriveCredentials{}, fmt.Errorf("resolve pipedrive credentials %q: %w", ref, err)
	}
	return parsePipedriveCredentialSecret(raw)
}

func (r *PipedriveSecretsCredentialResolver) refreshCredentialIfNeeded(ctx context.Context, tenantID, ref string, creds PipedriveCredentials) (PipedriveCredentials, error) {
	if strings.TrimSpace(creds.RefreshToken) == "" || strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" || creds.TokenExpiresAt == nil {
		return creds, nil
	}
	now := time.Now().UTC()
	if r.Now != nil {
		now = r.Now().UTC()
	}
	skew := r.RefreshSkew
	if skew <= 0 {
		skew = 5 * time.Minute
	}
	if now.Before(creds.TokenExpiresAt.Add(-skew)) {
		return creds, nil
	}
	client := r.OAuthClient
	if client.Now == nil && r.Now != nil {
		client.Now = r.Now
	}
	token, err := client.RefreshAccessToken(ctx, creds)
	if err != nil {
		return PipedriveCredentials{}, fmt.Errorf("refresh pipedrive OAuth token: %w", err)
	}
	creds.AccessToken = token.AccessToken
	if strings.TrimSpace(token.RefreshToken) != "" {
		creds.RefreshToken = token.RefreshToken
	}
	if strings.TrimSpace(token.Scope) != "" {
		creds.Scope = token.Scope
	}
	if strings.TrimSpace(token.APIBaseURL) != "" {
		creds.APIBaseURL = token.APIBaseURL
	}
	expiresAt := token.ExpiresAt.UTC()
	creds.TokenExpiresAt = &expiresAt
	if r.Store != nil && pipedriveIsStoredCredentialRef(ref) {
		if err := r.Store.PutPipedriveCredentialSecret(ctx, tenantID, ref, creds); err != nil {
			return PipedriveCredentials{}, fmt.Errorf("persist refreshed pipedrive OAuth token: %w", err)
		}
	}
	return creds, nil
}

type pipedriveCredentialPayload struct {
	APIToken        string `json:"api_token"`
	APIKey          string `json:"api_key"`
	Token           string `json:"token"`
	AccessToken     string `json:"access_token"`
	BearerToken     string `json:"bearer_token"`
	RefreshToken    string `json:"refresh_token"`
	ClientID        string `json:"client_id"`
	ClientSecret    string `json:"client_secret"`
	APIBaseURL      string `json:"api_base_url"`
	APIDomain       string `json:"api_domain"`
	BaseURL         string `json:"base_url"`
	OAuthBaseURL    string `json:"oauth_base_url"`
	TokenURL        string `json:"token_url"`
	Scope           string `json:"scope"`
	ExpiresAt       string `json:"expires_at"`
	ExpiresIn       int    `json:"expires_in"`
	UserAgent       string `json:"user_agent"`
	WebhookUsername string `json:"webhook_username"`
	WebhookUser     string `json:"webhook_user"`
	WebhookAuthUser string `json:"webhook_auth_user"`
	WebhookPassword string `json:"webhook_password"`
	WebhookSecret   string `json:"webhook_secret"`
}

func (p pipedriveCredentialPayload) credentials() (PipedriveCredentials, error) {
	apiToken := strings.TrimSpace(firstString(p.APIToken, p.APIKey, p.Token))
	accessToken := normalizePipedriveBearerToken(firstString(p.AccessToken, p.BearerToken))
	refreshToken := strings.TrimSpace(p.RefreshToken)
	if apiToken == "" && accessToken == "" && refreshToken == "" {
		return PipedriveCredentials{}, fmt.Errorf("pipedrive api_token, access_token, or refresh_token is required")
	}
	expiresAt := parsePipedriveCredentialExpiry(p.ExpiresAt, p.ExpiresIn)
	return PipedriveCredentials{
		APIToken:        apiToken,
		AccessToken:     accessToken,
		RefreshToken:    refreshToken,
		ClientID:        strings.TrimSpace(p.ClientID),
		ClientSecret:    strings.TrimSpace(p.ClientSecret),
		APIBaseURL:      strings.TrimRight(firstString(p.APIBaseURL, p.APIDomain, p.BaseURL), "/"),
		OAuthBaseURL:    strings.TrimRight(firstString(p.OAuthBaseURL, p.TokenURL), "/"),
		UserAgent:       strings.TrimSpace(p.UserAgent),
		Scope:           strings.TrimSpace(p.Scope),
		TokenExpiresAt:  expiresAt,
		WebhookUsername: strings.TrimSpace(firstString(p.WebhookUsername, p.WebhookUser, p.WebhookAuthUser)),
		WebhookPassword: strings.TrimSpace(firstString(p.WebhookPassword, p.WebhookSecret)),
	}, nil
}

func parsePipedriveCredentialSecret(raw string) (PipedriveCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return PipedriveCredentials{}, fmt.Errorf("pipedrive credentials are empty")
	}
	var payload pipedriveCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return PipedriveCredentials{}, fmt.Errorf("parse pipedrive credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parsePipedriveKeyValueSecret(raw)
		return payload.credentials()
	}
	return pipedriveCredentialPayload{APIToken: raw}.credentials()
}

func pipedriveCredentialPayloadFromCredentials(creds PipedriveCredentials) pipedriveCredentialPayload {
	payload := pipedriveCredentialPayload{
		APIToken:        strings.TrimSpace(creds.APIToken),
		AccessToken:     strings.TrimSpace(creds.AccessToken),
		RefreshToken:    strings.TrimSpace(creds.RefreshToken),
		ClientID:        strings.TrimSpace(creds.ClientID),
		ClientSecret:    strings.TrimSpace(creds.ClientSecret),
		APIBaseURL:      strings.TrimRight(strings.TrimSpace(creds.APIBaseURL), "/"),
		OAuthBaseURL:    strings.TrimRight(strings.TrimSpace(creds.OAuthBaseURL), "/"),
		Scope:           strings.TrimSpace(creds.Scope),
		UserAgent:       strings.TrimSpace(creds.UserAgent),
		WebhookUsername: strings.TrimSpace(creds.WebhookUsername),
		WebhookPassword: strings.TrimSpace(creds.WebhookPassword),
	}
	if creds.TokenExpiresAt != nil {
		payload.ExpiresAt = creds.TokenExpiresAt.UTC().Format(time.RFC3339)
	}
	return payload
}

func pipedriveCredentialsJSON(creds PipedriveCredentials) ([]byte, error) {
	return json.Marshal(pipedriveCredentialPayloadFromCredentials(creds))
}

func parsePipedriveKeyValueSecret(raw string) pipedriveCredentialPayload {
	var payload pipedriveCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "api_token", "api_key", "token":
			payload.APIToken = value
		case "access_token", "bearer_token":
			payload.AccessToken = value
		case "refresh_token":
			payload.RefreshToken = value
		case "client_id":
			payload.ClientID = value
		case "client_secret":
			payload.ClientSecret = value
		case "api_base_url", "base_url":
			payload.APIBaseURL = value
		case "api_domain":
			payload.APIDomain = value
		case "oauth_base_url", "token_url":
			payload.OAuthBaseURL = value
		case "scope":
			payload.Scope = value
		case "expires_at":
			payload.ExpiresAt = value
		case "user_agent":
			payload.UserAgent = value
		case "webhook_username", "webhook_user", "webhook_auth_user":
			payload.WebhookUsername = value
		case "webhook_password", "webhook_secret":
			payload.WebhookPassword = value
		}
	}
	return payload
}

func (b PipedriveRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderPipedrive {
		return SyncRequest{}, fmt.Errorf("pipedrive backfill requires a Pipedrive integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("pipedrive credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolvePipedrive(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.APIToken) == "" && strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("pipedrive api token or access token is required")
	}
	state, err := decodePipedriveCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "complete" {
		return SyncRequest{RunMode: "backfill", Cursor: pipedriveCursorComplete}, nil
	}
	if state.Object == "" {
		state.Object = "persons"
	}
	client := crmEgressClient(b.HTTPClient, ProviderPipedrive, 20*time.Second)
	switch state.Object {
	case "persons":
		objects, nextCursor, err := b.fetchPersonsPage(ctx, client, integration, creds, state.Cursor)
		if err != nil {
			return SyncRequest{}, err
		}
		contacts := make([]ContactInput, 0, len(objects))
		for _, object := range objects {
			if contact, ok := mapPipedrivePerson(object, integration); ok {
				contacts = append(contacts, contact)
			}
		}
		outCursor := pipedriveCursorComplete
		if nextCursor != "" {
			outCursor = encodePipedriveCursor(pipedriveCursorState{Object: "persons", Cursor: nextCursor})
		} else if nextObject := pipedriveNextBackfillObject(integration, "persons"); nextObject != "" {
			outCursor = encodePipedriveCursor(pipedriveCursorState{Object: nextObject})
		}
		return normalizeSyncRequest(SyncRequest{
			RunMode:  "backfill",
			Contacts: contacts,
			Cursor:   outCursor,
		}), nil
	case "deals":
		objects, nextCursor, err := b.fetchDealsPage(ctx, client, integration, creds, state.Cursor)
		if err != nil {
			return SyncRequest{}, err
		}
		events := make([]EventInput, 0, len(objects))
		for _, object := range objects {
			if event, ok := mapPipedriveDealEvent(object, integration, ""); ok {
				events = append(events, event)
			}
		}
		outCursor := pipedriveCursorComplete
		if nextCursor != "" {
			outCursor = encodePipedriveCursor(pipedriveCursorState{Object: "deals", Cursor: nextCursor})
		} else if nextObject := pipedriveNextBackfillObject(integration, "deals"); nextObject != "" {
			outCursor = encodePipedriveCursor(pipedriveCursorState{Object: nextObject})
		}
		return normalizeSyncRequest(SyncRequest{
			RunMode: "backfill",
			Events:  events,
			Cursor:  outCursor,
		}), nil
	case "organizations":
		objects, nextCursor, err := b.fetchOrganizationsPage(ctx, client, integration, creds, state.Cursor)
		if err != nil {
			return SyncRequest{}, err
		}
		contacts := make([]ContactInput, 0, len(objects))
		for _, object := range objects {
			if contact, ok := mapPipedriveOrganizationContact(object, integration, ""); ok {
				contacts = append(contacts, contact)
			}
		}
		outCursor := pipedriveCursorComplete
		if nextCursor != "" {
			outCursor = encodePipedriveCursor(pipedriveCursorState{Object: "organizations", Cursor: nextCursor})
		} else if nextObject := pipedriveNextBackfillObject(integration, "organizations"); nextObject != "" {
			outCursor = encodePipedriveCursor(pipedriveCursorState{Object: nextObject})
		}
		return normalizeSyncRequest(SyncRequest{
			RunMode:  "backfill",
			Contacts: contacts,
			Cursor:   outCursor,
		}), nil
	case "activities":
		objects, nextCursor, err := b.fetchActivitiesPage(ctx, client, integration, creds, state.Cursor)
		if err != nil {
			return SyncRequest{}, err
		}
		events := make([]EventInput, 0, len(objects))
		for _, object := range objects {
			if event, ok := mapPipedriveActivityEvent(object, integration, ""); ok {
				events = append(events, event)
			}
		}
		outCursor := pipedriveCursorComplete
		if nextCursor != "" {
			outCursor = encodePipedriveCursor(pipedriveCursorState{Object: "activities", Cursor: nextCursor})
		}
		return normalizeSyncRequest(SyncRequest{
			RunMode: "backfill",
			Events:  events,
			Cursor:  outCursor,
		}), nil
	default:
		return SyncRequest{}, fmt.Errorf("unsupported pipedrive backfill object %q", state.Object)
	}
}

func (b PipedriveRESTBackfiller) fetchPersonsPage(ctx context.Context, client *http.Client, integration Integration, creds PipedriveCredentials, cursor string) ([]map[string]any, string, error) {
	baseURL, err := pipedriveAPIBaseURL(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url")), settingString(integration.Settings, "company_domain"))
	if err != nil {
		return nil, "", err
	}
	query := url.Values{}
	query.Set("limit", strconv.Itoa(pipedriveLimit(firstString(settingString(integration.Settings, "limit"), settingString(integration.Settings, "page_size"), strconv.Itoa(b.Limit)))))
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	var out pipedrivePersonsResponse
	if err := pipedriveDoJSON(ctx, client, baseURL, creds, b.UserAgent, http.MethodGet, "/api/v2/persons", query, &out); err != nil {
		return nil, "", err
	}
	return out.Data, out.nextCursor(), nil
}

func (b PipedriveRESTBackfiller) fetchDealsPage(ctx context.Context, client *http.Client, integration Integration, creds PipedriveCredentials, cursor string) ([]map[string]any, string, error) {
	baseURL, err := pipedriveAPIBaseURL(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url")), settingString(integration.Settings, "company_domain"))
	if err != nil {
		return nil, "", err
	}
	query := url.Values{}
	query.Set("limit", strconv.Itoa(pipedriveLimit(firstString(settingString(integration.Settings, "deal_limit"), settingString(integration.Settings, "limit"), settingString(integration.Settings, "page_size"), strconv.Itoa(b.Limit)))))
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	if filterID := strings.TrimSpace(firstString(settingString(integration.Settings, "deal_filter_id"), settingString(integration.Settings, "filter_id"))); filterID != "" {
		query.Set("filter_id", filterID)
	}
	if pipelineID := strings.TrimSpace(settingString(integration.Settings, "pipeline_id")); pipelineID != "" {
		query.Set("pipeline_id", pipelineID)
	}
	if status := strings.TrimSpace(firstString(settingString(integration.Settings, "deal_status"), settingString(integration.Settings, "status"))); status != "" {
		query.Set("status", status)
	}
	if updatedSince := strings.TrimSpace(firstString(settingString(integration.Settings, "deal_updated_since"), settingString(integration.Settings, "updated_since"))); updatedSince != "" {
		query.Set("updated_since", updatedSince)
	}
	query.Set("sort_by", "update_time")
	query.Set("sort_direction", "asc")
	query.Set("include_fields", "next_activity_id,last_activity_id,activities_count,participants_count,products_count")
	var out pipedriveDealsResponse
	if err := pipedriveDoJSON(ctx, client, baseURL, creds, b.UserAgent, http.MethodGet, "/api/v2/deals", query, &out); err != nil {
		return nil, "", err
	}
	return out.Data, out.nextCursor(), nil
}

func (b PipedriveRESTBackfiller) fetchOrganizationsPage(ctx context.Context, client *http.Client, integration Integration, creds PipedriveCredentials, cursor string) ([]map[string]any, string, error) {
	baseURL, err := pipedriveAPIBaseURL(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url")), settingString(integration.Settings, "company_domain"))
	if err != nil {
		return nil, "", err
	}
	query := url.Values{}
	query.Set("limit", strconv.Itoa(pipedriveLimit(firstString(settingString(integration.Settings, "organization_limit"), settingString(integration.Settings, "limit"), settingString(integration.Settings, "page_size"), strconv.Itoa(b.Limit)))))
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	if filterID := strings.TrimSpace(firstString(settingString(integration.Settings, "organization_filter_id"), settingString(integration.Settings, "filter_id"))); filterID != "" {
		query.Set("filter_id", filterID)
	}
	if ownerID := strings.TrimSpace(settingString(integration.Settings, "organization_owner_id")); ownerID != "" {
		query.Set("owner_id", ownerID)
	}
	if updatedSince := strings.TrimSpace(firstString(settingString(integration.Settings, "organization_updated_since"), settingString(integration.Settings, "updated_since"))); updatedSince != "" {
		query.Set("updated_since", updatedSince)
	}
	query.Set("sort_by", "update_time")
	query.Set("sort_direction", "asc")
	query.Set("include_fields", "people_count,open_deals_count,closed_deals_count,won_deals_count,lost_deals_count,related_open_deals_count,related_closed_deals_count,related_won_deals_count,related_lost_deals_count")
	query.Set("include_labels", "true")
	var out pipedriveOrganizationsResponse
	if err := pipedriveDoJSON(ctx, client, baseURL, creds, b.UserAgent, http.MethodGet, "/api/v2/organizations", query, &out); err != nil {
		return nil, "", err
	}
	return out.Data, out.nextCursor(), nil
}

func (b PipedriveRESTBackfiller) fetchActivitiesPage(ctx context.Context, client *http.Client, integration Integration, creds PipedriveCredentials, cursor string) ([]map[string]any, string, error) {
	baseURL, err := pipedriveAPIBaseURL(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url")), settingString(integration.Settings, "company_domain"))
	if err != nil {
		return nil, "", err
	}
	query := url.Values{}
	query.Set("limit", strconv.Itoa(pipedriveLimit(firstString(settingString(integration.Settings, "activity_limit"), settingString(integration.Settings, "limit"), settingString(integration.Settings, "page_size"), strconv.Itoa(b.Limit)))))
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	if filterID := strings.TrimSpace(firstString(settingString(integration.Settings, "activity_filter_id"), settingString(integration.Settings, "filter_id"))); filterID != "" {
		query.Set("filter_id", filterID)
	}
	if ownerID := strings.TrimSpace(settingString(integration.Settings, "activity_owner_id")); ownerID != "" {
		query.Set("owner_id", ownerID)
	}
	if done := strings.TrimSpace(settingString(integration.Settings, "activity_done")); done != "" {
		query.Set("done", done)
	}
	if updatedSince := strings.TrimSpace(firstString(settingString(integration.Settings, "activity_updated_since"), settingString(integration.Settings, "updated_since"))); updatedSince != "" {
		query.Set("updated_since", updatedSince)
	}
	query.Set("sort_by", "update_time")
	query.Set("sort_direction", "asc")
	query.Set("include_fields", "attendees")
	var out pipedriveActivitiesResponse
	if err := pipedriveDoJSON(ctx, client, baseURL, creds, b.UserAgent, http.MethodGet, "/api/v2/activities", query, &out); err != nil {
		return nil, "", err
	}
	return out.Data, out.nextCursor(), nil
}

type pipedriveCursorState struct {
	Object string `json:"object"`
	Cursor string `json:"cursor,omitempty"`
}

func decodePipedriveCursor(cursor string) (pipedriveCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return pipedriveCursorState{Object: "persons"}, nil
	}
	if cursor == pipedriveCursorComplete {
		return pipedriveCursorState{Object: "complete"}, nil
	}
	if !strings.HasPrefix(cursor, pipedriveCursorPrefix) {
		return pipedriveCursorState{Object: "persons", Cursor: cursor}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, pipedriveCursorPrefix))
	if err != nil {
		return pipedriveCursorState{}, fmt.Errorf("decode Pipedrive cursor: %w", err)
	}
	var state pipedriveCursorState
	if err := json.Unmarshal(raw, &state); err != nil {
		return pipedriveCursorState{}, fmt.Errorf("parse Pipedrive cursor: %w", err)
	}
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Object == "" {
		state.Object = "persons"
	}
	if state.Object != "persons" && state.Object != "deals" && state.Object != "organizations" && state.Object != "activities" && state.Object != "complete" {
		return pipedriveCursorState{}, fmt.Errorf("unsupported pipedrive cursor object %q", state.Object)
	}
	return state, nil
}

func encodePipedriveCursor(state pipedriveCursorState) string {
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	if state.Object == "" {
		state.Object = "persons"
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	raw, _ := json.Marshal(state)
	return pipedriveCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type pipedrivePersonsResponse struct {
	Success        bool                    `json:"success"`
	Data           []map[string]any        `json:"data"`
	AdditionalData pipedriveAdditionalData `json:"additional_data"`
}

type pipedriveAdditionalData struct {
	NextCursor string `json:"next_cursor"`
	Pagination struct {
		MoreItems  bool   `json:"more_items_in_collection"`
		NextCursor string `json:"next_cursor"`
	} `json:"pagination"`
}

func (r pipedrivePersonsResponse) nextCursor() string {
	return strings.TrimSpace(firstString(r.AdditionalData.NextCursor, r.AdditionalData.Pagination.NextCursor))
}

type pipedriveDealsResponse struct {
	Success        bool                    `json:"success"`
	Data           []map[string]any        `json:"data"`
	AdditionalData pipedriveAdditionalData `json:"additional_data"`
}

func (r pipedriveDealsResponse) nextCursor() string {
	return strings.TrimSpace(firstString(r.AdditionalData.NextCursor, r.AdditionalData.Pagination.NextCursor))
}

type pipedriveOrganizationsResponse struct {
	Success        bool                    `json:"success"`
	Data           []map[string]any        `json:"data"`
	AdditionalData pipedriveAdditionalData `json:"additional_data"`
}

func (r pipedriveOrganizationsResponse) nextCursor() string {
	return strings.TrimSpace(firstString(r.AdditionalData.NextCursor, r.AdditionalData.Pagination.NextCursor))
}

type pipedriveActivitiesResponse struct {
	Success        bool                    `json:"success"`
	Data           []map[string]any        `json:"data"`
	AdditionalData pipedriveAdditionalData `json:"additional_data"`
}

func (r pipedriveActivitiesResponse) nextCursor() string {
	return strings.TrimSpace(firstString(r.AdditionalData.NextCursor, r.AdditionalData.Pagination.NextCursor))
}

type PipedriveRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e PipedriveRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("pipedrive REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("pipedrive REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func pipedriveDoJSON(ctx context.Context, client *http.Client, baseURL string, creds PipedriveCredentials, userAgent, method, path string, query url.Values, out any) error {
	return pipedriveDoJSONBody(ctx, client, baseURL, creds, userAgent, method, path, query, nil, out)
}

func pipedriveDoJSONBody(ctx context.Context, client *http.Client, baseURL string, creds PipedriveCredentials, userAgent, method, path string, query url.Values, body any, out any) error {
	if query == nil {
		query = url.Values{}
	}
	if strings.TrimSpace(creds.AccessToken) == "" && strings.TrimSpace(creds.APIToken) != "" {
		query.Set("api_token", strings.TrimSpace(creds.APIToken))
	}
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse pipedrive API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	var bodyReader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bodyReader)
	if err != nil {
		return err
	}
	if token := strings.TrimSpace(creds.AccessToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, pipedriveDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, pipedriveResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return PipedriveRESTError{
			Path:       path,
			StatusCode: resp.StatusCode,
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    truncateHubSpotString(string(responseBody), 500),
		}
	}
	if out == nil || len(responseBody) == 0 {
		return nil
	}
	if err := json.Unmarshal(responseBody, out); err != nil {
		return fmt.Errorf("decode pipedrive response %s: %w", path, err)
	}
	return nil
}

func (c PipedriveOAuthClient) ExchangeAuthorizationCode(ctx context.Context, creds PipedriveCredentials, code, redirectURI string) (PipedriveOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", strings.TrimSpace(code))
	form.Set("redirect_uri", strings.TrimSpace(redirectURI))
	return c.doToken(ctx, creds, form)
}

func (c PipedriveOAuthClient) RefreshAccessToken(ctx context.Context, creds PipedriveCredentials) (PipedriveOAuthToken, error) {
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", strings.TrimSpace(creds.RefreshToken))
	return c.doToken(ctx, creds, form)
}

func (c PipedriveOAuthClient) RevokeRefreshToken(ctx context.Context, creds PipedriveCredentials) error {
	return c.revokeToken(ctx, creds, creds.RefreshToken, "refresh_token")
}

func (c PipedriveOAuthClient) RevokeAccessToken(ctx context.Context, creds PipedriveCredentials) error {
	return c.revokeToken(ctx, creds, creds.AccessToken, "access_token")
}

func (c PipedriveOAuthClient) CurrentUser(ctx context.Context, creds PipedriveCredentials) (PipedriveCurrentUser, error) {
	if strings.TrimSpace(creds.AccessToken) == "" {
		return PipedriveCurrentUser{}, fmt.Errorf("pipedrive OAuth access_token is required")
	}
	if strings.TrimSpace(creds.APIBaseURL) == "" {
		return PipedriveCurrentUser{}, fmt.Errorf("pipedrive api_domain is required")
	}
	client := crmEgressClient(c.HTTPClient, ProviderPipedrive, 15*time.Second)
	baseURL, err := pipedriveAPIBaseURL(creds.APIBaseURL, "")
	if err != nil {
		return PipedriveCurrentUser{}, err
	}
	var raw struct {
		Success bool           `json:"success"`
		Data    map[string]any `json:"data"`
	}
	if err := pipedriveDoJSON(ctx, client, baseURL, creds, firstString(c.UserAgent, creds.UserAgent), http.MethodGet, "/api/v1/users/me", nil, &raw); err != nil {
		return PipedriveCurrentUser{}, err
	}
	if raw.Data == nil {
		return PipedriveCurrentUser{}, fmt.Errorf("pipedrive /users/me response missing data")
	}
	out := PipedriveCurrentUser{
		ID:              pipedriveIDString(raw.Data["id"]),
		Name:            pipedriveString(raw.Data, "name"),
		Email:           strings.ToLower(strings.TrimSpace(pipedriveString(raw.Data, "email"))),
		Locale:          pipedriveString(raw.Data, "locale"),
		CompanyID:       pipedriveIDString(raw.Data["company_id"]),
		CompanyName:     pipedriveString(raw.Data, "company_name"),
		CompanyDomain:   pipedriveString(raw.Data, "company_domain"),
		CompanyCountry:  pipedriveString(raw.Data, "company_country"),
		CompanyIndustry: pipedriveString(raw.Data, "company_industry"),
		Raw:             raw.Data,
	}
	if out.ID == "" || out.CompanyID == "" {
		return PipedriveCurrentUser{}, fmt.Errorf("pipedrive /users/me response missing user_id or company_id")
	}
	return out, nil
}

func (c PipedriveOAuthClient) doToken(ctx context.Context, creds PipedriveCredentials, form url.Values) (PipedriveOAuthToken, error) {
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return PipedriveOAuthToken{}, fmt.Errorf("pipedrive OAuth client_id and client_secret are required")
	}
	if strings.TrimSpace(form.Get("grant_type")) == "authorization_code" && strings.TrimSpace(form.Get("code")) == "" {
		return PipedriveOAuthToken{}, fmt.Errorf("pipedrive OAuth authorization code is required")
	}
	if strings.TrimSpace(form.Get("grant_type")) == "refresh_token" && strings.TrimSpace(form.Get("refresh_token")) == "" {
		return PipedriveOAuthToken{}, fmt.Errorf("pipedrive OAuth refresh_token is required")
	}
	client := crmEgressClient(c.HTTPClient, ProviderPipedrive, 15*time.Second)
	baseURL := strings.TrimRight(firstString(c.OAuthBaseURL, creds.OAuthBaseURL, pipedriveDefaultOAuthBaseURL), "/")
	rawURL := baseURL + "/oauth/token"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, strings.NewReader(form.Encode()))
	if err != nil {
		return PipedriveOAuthToken{}, err
	}
	basic := base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(creds.ClientID) + ":" + strings.TrimSpace(creds.ClientSecret)))
	req.Header.Set("Authorization", "Basic "+basic)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, pipedriveDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return PipedriveOAuthToken{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, pipedriveResponseMaxBytes))
	if err != nil {
		return PipedriveOAuthToken{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return PipedriveOAuthToken{}, PipedriveRESTError{
			Path:       "/oauth/token",
			StatusCode: resp.StatusCode,
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    truncateHubSpotString(string(body), 500),
		}
	}
	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int    `json:"expires_in"`
		Scope        string `json:"scope"`
		APIDomain    string `json:"api_domain"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return PipedriveOAuthToken{}, fmt.Errorf("decode pipedrive OAuth token response: %w", err)
	}
	if strings.TrimSpace(raw.AccessToken) == "" {
		return PipedriveOAuthToken{}, fmt.Errorf("pipedrive OAuth token response missing access_token")
	}
	now := time.Now().UTC()
	if c.Now != nil {
		now = c.Now().UTC()
	}
	expiresAt := now
	if raw.ExpiresIn > 0 {
		expiresAt = now.Add(time.Duration(raw.ExpiresIn) * time.Second)
	}
	return PipedriveOAuthToken{
		AccessToken:  strings.TrimSpace(raw.AccessToken),
		RefreshToken: strings.TrimSpace(raw.RefreshToken),
		TokenType:    firstString(raw.TokenType, "Bearer"),
		ExpiresIn:    raw.ExpiresIn,
		ExpiresAt:    expiresAt,
		Scope:        strings.TrimSpace(raw.Scope),
		APIBaseURL:   strings.TrimRight(strings.TrimSpace(raw.APIDomain), "/"),
	}, nil
}

func (c PipedriveOAuthClient) revokeToken(ctx context.Context, creds PipedriveCredentials, token, tokenTypeHint string) error {
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return fmt.Errorf("pipedrive OAuth client_id and client_secret are required")
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return fmt.Errorf("pipedrive OAuth token is required")
	}
	form := url.Values{}
	form.Set("token", token)
	if tokenTypeHint = strings.TrimSpace(tokenTypeHint); tokenTypeHint != "" {
		form.Set("token_type_hint", tokenTypeHint)
	}
	client := crmEgressClient(c.HTTPClient, ProviderPipedrive, 15*time.Second)
	baseURL := strings.TrimRight(firstString(c.OAuthBaseURL, creds.OAuthBaseURL, pipedriveDefaultOAuthBaseURL), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/oauth/revoke", strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	basic := base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(creds.ClientID) + ":" + strings.TrimSpace(creds.ClientSecret)))
	req.Header.Set("Authorization", "Basic "+basic)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, pipedriveDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, pipedriveResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return PipedriveRESTError{
			Path:       "/oauth/revoke",
			StatusCode: resp.StatusCode,
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    truncateHubSpotString(string(body), 500),
		}
	}
	return nil
}

func (r PipedriveRESTWebhookRegistrar) ReconcileWebhooks(ctx context.Context, integration Integration, appBaseURL string) (PipedriveWebhookReconcileSummary, error) {
	if integration.Provider != ProviderPipedrive {
		return PipedriveWebhookReconcileSummary{}, fmt.Errorf("pipedrive webhook registration requires a Pipedrive integration")
	}
	endpoint := pipedriveWebhookEndpoint(appBaseURL)
	if endpoint == "" {
		return PipedriveWebhookReconcileSummary{}, fmt.Errorf("public base URL is required for Pipedrive webhook registration")
	}
	client, baseURL, creds, err := r.client(ctx, integration)
	if err != nil {
		return PipedriveWebhookReconcileSummary{}, err
	}
	if strings.TrimSpace(creds.WebhookUsername) == "" || strings.TrimSpace(creds.WebhookPassword) == "" {
		return PipedriveWebhookReconcileSummary{}, fmt.Errorf("pipedrive webhook Basic Auth username and password are required in the credential secret")
	}
	existing, err := r.listWebhooks(ctx, client, baseURL, creds)
	if err != nil {
		return PipedriveWebhookReconcileSummary{}, err
	}
	summary := PipedriveWebhookReconcileSummary{
		Endpoint:      endpoint,
		RegisteredAt:  r.now(),
		Subscriptions: []PipedriveWebhookRegistration{},
	}
	for _, topic := range pipedriveWebhookTopics(integration, r.Topics) {
		action, object, ok := splitPipedriveWebhookTopic(topic)
		if !ok {
			continue
		}
		if sub, ok := findPipedriveWebhook(existing, endpoint, action, object); ok {
			summary.Subscriptions = append(summary.Subscriptions, PipedriveWebhookRegistration{
				ID:          sub.ID,
				EventAction: sub.EventAction,
				EventObject: sub.EventObject,
				Endpoint:    sub.Endpoint,
				Version:     sub.Version,
				Reused:      true,
			})
			continue
		}
		created, err := r.createWebhook(ctx, client, baseURL, creds, endpoint, action, object)
		if err != nil {
			return PipedriveWebhookReconcileSummary{}, err
		}
		created.Created = true
		summary.Subscriptions = append(summary.Subscriptions, created)
	}
	return summary, nil
}

func (r PipedriveRESTWebhookRegistrar) CleanupWebhooks(ctx context.Context, integration Integration, appBaseURL string) (PipedriveWebhookCleanupSummary, error) {
	if integration.Provider != ProviderPipedrive {
		return PipedriveWebhookCleanupSummary{}, fmt.Errorf("pipedrive webhook cleanup requires a Pipedrive integration")
	}
	endpoint := firstString(settingString(integration.Settings, "pipedrive_webhook_endpoint"), pipedriveWebhookEndpoint(appBaseURL))
	if endpoint == "" {
		return PipedriveWebhookCleanupSummary{}, fmt.Errorf("public base URL is required for Pipedrive webhook cleanup")
	}
	client, baseURL, creds, err := r.client(ctx, integration)
	if err != nil {
		return PipedriveWebhookCleanupSummary{}, err
	}
	existing, err := r.listWebhooks(ctx, client, baseURL, creds)
	if err != nil {
		return PipedriveWebhookCleanupSummary{}, err
	}
	topics := map[string]struct{}{}
	for _, topic := range pipedriveWebhookTopics(integration, r.Topics) {
		if action, object, ok := splitPipedriveWebhookTopic(topic); ok {
			topics[action+"."+object] = struct{}{}
		}
	}
	storedIDs := map[string]struct{}{}
	for _, id := range crmPipedriveWebhookIDs(integration.Settings) {
		if id = strings.TrimSpace(id); id != "" {
			storedIDs[id] = struct{}{}
		}
	}
	summary := PipedriveWebhookCleanupSummary{
		Endpoint:      endpoint,
		CleanedUpAt:   r.now(),
		Subscriptions: []PipedriveWebhookRegistration{},
	}
	for _, sub := range existing {
		_, storedID := storedIDs[strings.TrimSpace(sub.ID)]
		_, currentTopic := topics[sub.EventAction+"."+sub.EventObject]
		if !storedID && (strings.TrimSpace(sub.Endpoint) != endpoint || !currentTopic) {
			continue
		}
		if err := r.deleteWebhook(ctx, client, baseURL, creds, sub.ID); err != nil {
			return PipedriveWebhookCleanupSummary{}, err
		}
		summary.Subscriptions = append(summary.Subscriptions, PipedriveWebhookRegistration{
			ID:          sub.ID,
			EventAction: sub.EventAction,
			EventObject: sub.EventObject,
			Endpoint:    sub.Endpoint,
			Version:     sub.Version,
			Deleted:     true,
		})
	}
	return summary, nil
}

type pipedriveWebhookSubscription struct {
	ID          string
	EventAction string
	EventObject string
	Endpoint    string
	Version     string
}

func (r PipedriveRESTWebhookRegistrar) client(ctx context.Context, integration Integration) (*http.Client, string, PipedriveCredentials, error) {
	if r.Credentials == nil {
		return nil, "", PipedriveCredentials{}, fmt.Errorf("pipedrive credential resolver is not configured")
	}
	creds, err := r.Credentials.ResolvePipedrive(ctx, integration.TenantID, integration)
	if err != nil {
		return nil, "", PipedriveCredentials{}, err
	}
	baseURL, err := pipedriveAPIBaseURL(firstString(r.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url")), settingString(integration.Settings, "company_domain"))
	if err != nil {
		return nil, "", PipedriveCredentials{}, err
	}
	client := crmEgressClient(r.HTTPClient, ProviderPipedrive, 20*time.Second)
	return client, baseURL, creds, nil
}

func (r PipedriveRESTWebhookRegistrar) listWebhooks(ctx context.Context, client *http.Client, baseURL string, creds PipedriveCredentials) ([]pipedriveWebhookSubscription, error) {
	var raw struct {
		Success bool             `json:"success"`
		Status  string           `json:"status"`
		Data    []map[string]any `json:"data"`
	}
	if err := pipedriveDoJSON(ctx, client, baseURL, creds, r.UserAgent, http.MethodGet, "/api/v1/webhooks", nil, &raw); err != nil {
		return nil, err
	}
	out := make([]pipedriveWebhookSubscription, 0, len(raw.Data))
	for _, item := range raw.Data {
		out = append(out, pipedriveWebhookSubscription{
			ID:          pipedriveIDString(item["id"]),
			EventAction: normalizePipedriveWebhookAction(pipedriveString(item, "event_action")),
			EventObject: normalizePipedriveWebhookObject(pipedriveString(item, "event_object")),
			Endpoint:    strings.TrimSpace(firstString(pipedriveString(item, "subscription_url"), pipedriveString(item, "url"))),
			Version:     strings.TrimSpace(pipedriveString(item, "version")),
		})
	}
	return out, nil
}

func (r PipedriveRESTWebhookRegistrar) createWebhook(ctx context.Context, client *http.Client, baseURL string, creds PipedriveCredentials, endpoint, action, object string) (PipedriveWebhookRegistration, error) {
	body := map[string]any{
		"subscription_url":   endpoint,
		"event_action":       action,
		"event_object":       object,
		"name":               "Moosewave " + action + "." + object,
		"version":            "2.0",
		"http_auth_user":     creds.WebhookUsername,
		"http_auth_password": creds.WebhookPassword,
	}
	var raw struct {
		Success bool           `json:"success"`
		Status  string         `json:"status"`
		Data    map[string]any `json:"data"`
	}
	if err := pipedriveDoJSONBody(ctx, client, baseURL, creds, r.UserAgent, http.MethodPost, "/api/v1/webhooks", nil, body, &raw); err != nil {
		return PipedriveWebhookRegistration{}, err
	}
	data := raw.Data
	return PipedriveWebhookRegistration{
		ID:          pipedriveIDString(data["id"]),
		EventAction: action,
		EventObject: object,
		Endpoint:    endpoint,
		Version:     firstString(pipedriveString(data, "version"), "2.0"),
	}, nil
}

func (r PipedriveRESTWebhookRegistrar) deleteWebhook(ctx context.Context, client *http.Client, baseURL string, creds PipedriveCredentials, id string) error {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	return pipedriveDoJSON(ctx, client, baseURL, creds, r.UserAgent, http.MethodDelete, "/api/v1/webhooks/"+url.PathEscape(id), nil, nil)
}

func (r PipedriveRESTWebhookRegistrar) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func mapPipedrivePerson(person map[string]any, integration Integration) (ContactInput, bool) {
	email := strings.ToLower(strings.TrimSpace(firstString(
		pipedrivePrimaryValue(person["emails"]),
		pipedrivePrimaryValue(person["email"]),
		pipedriveString(person, "primary_email"),
	)))
	if email == "" {
		return ContactInput{}, false
	}
	id := pipedriveIDString(person["id"])
	if id == "" {
		id = email
	}
	updated := firstParsedHubSpotTime(
		pipedriveString(person, "update_time"),
		pipedriveString(person, "updated_at"),
		pipedriveString(person, "add_time"),
		pipedriveString(person, "created_at"),
	)
	company := firstString(
		pipedriveString(person, "org_name"),
		pipedriveNestedString(person["org_id"], "name"),
		pipedriveNestedString(person["organization"], "name"),
	)
	marketingStatus := pipedriveString(person, "marketing_status")
	props := map[string]any{
		"pipedrive_person_id": id,
		"pipedrive_raw":       person,
	}
	for _, key := range []string{"owner_id", "label", "label_ids", "marketing_status", "visible_to", "last_activity_date", "next_activity_date"} {
		if value, ok := person[key]; ok && value != nil {
			props["pipedrive_"+key] = value
		}
	}
	out := ContactInput{
		SourceID:       "pipedrive://person/" + id,
		Email:          email,
		FirstName:      pipedriveString(person, "first_name"),
		LastName:       pipedriveString(person, "last_name"),
		FullName:       pipedriveString(person, "name"),
		Phone:          firstString(pipedrivePrimaryValue(person["phones"]), pipedrivePrimaryValue(person["phone"])),
		Company:        company,
		LifecycleStage: marketingStatus,
		ListIDs:        pipedriveListIDs(integration),
		Tags:           pipedriveDefaultTags(integration),
		Properties:     props,
	}
	if updated != nil {
		out.UpdatedAt = updated
	}
	if out.FullName == "" {
		out.FullName = strings.TrimSpace(strings.TrimSpace(out.FirstName + " " + out.LastName))
	}
	return out, true
}

func mapPipedriveDealEvent(deal map[string]any, integration Integration, action string) (EventInput, bool) {
	email := strings.ToLower(strings.TrimSpace(pipedriveDealEmail(deal)))
	if email == "" {
		return EventInput{}, false
	}
	id := pipedriveIDString(deal["id"])
	if id == "" {
		id = pipedriveIDString(deal["deal_id"])
	}
	if id == "" {
		return EventInput{}, false
	}
	status := strings.ToLower(strings.TrimSpace(pipedriveString(deal, "status")))
	eventName := pipedriveDealEventName(action, status)
	occurred := firstParsedHubSpotTime(
		pipedriveString(deal, "update_time"),
		pipedriveString(deal, "updated_at"),
		pipedriveString(deal, "won_time"),
		pipedriveString(deal, "lost_time"),
		pipedriveString(deal, "close_time"),
		pipedriveString(deal, "add_time"),
		pipedriveString(deal, "created_at"),
	)
	props := map[string]any{
		"pipedrive_deal_id": id,
		"pipedrive_status":  status,
		"pipedrive_raw":     deal,
	}
	for _, key := range []string{
		"title", "value", "currency", "pipeline_id", "stage_id", "person_id", "org_id",
		"owner_id", "label", "label_ids", "probability", "expected_close_date",
		"next_activity_id", "last_activity_id", "activities_count", "participants_count", "products_count",
	} {
		if value, ok := deal[key]; ok && value != nil {
			props["pipedrive_"+key] = value
		}
	}
	if company := firstString(pipedriveNestedString(deal["org_id"], "name"), pipedriveNestedString(deal["organization"], "name"), pipedriveString(deal, "org_name")); company != "" {
		props["company"] = company
	}
	return EventInput{
		SourceID:   "pipedrive://deal/" + id,
		Email:      email,
		EventName:  eventName,
		Properties: props,
		OccurredAt: occurred,
	}, true
}

func mapPipedriveOrganizationContact(organization map[string]any, integration Integration, action string) (ContactInput, bool) {
	email := strings.ToLower(strings.TrimSpace(pipedriveOrganizationEmail(organization)))
	if email == "" {
		return ContactInput{}, false
	}
	id := pipedriveIDString(organization["id"])
	if id == "" {
		id = pipedriveIDString(organization["org_id"])
	}
	if id == "" {
		id = email
	}
	personID := pipedriveOrganizationPersonID(organization)
	name := firstString(pipedriveString(organization, "name"), pipedriveString(organization, "org_name"), pipedriveNestedString(organization["org_id"], "name"))
	updated := firstParsedHubSpotTime(
		pipedriveString(organization, "update_time"),
		pipedriveString(organization, "updated_at"),
		pipedriveString(organization, "add_time"),
		pipedriveString(organization, "created_at"),
	)
	props := map[string]any{
		"pipedrive_organization_id":   id,
		"pipedrive_organization_name": name,
		"pipedrive_raw":               organization,
	}
	if action = strings.TrimSpace(action); action != "" {
		props["pipedrive_action"] = action
	}
	for _, key := range []string{
		"address", "owner_id", "label", "label_ids", "people_count",
		"open_deals_count", "closed_deals_count", "won_deals_count", "lost_deals_count",
		"related_open_deals_count", "related_closed_deals_count", "related_won_deals_count", "related_lost_deals_count",
	} {
		if value, ok := organization[key]; ok && value != nil {
			props["pipedrive_organization_"+key] = value
		}
	}
	if personID != "" {
		props["pipedrive_person_id"] = personID
	}
	sourceID := "pipedrive://organization/" + id + "/contact/" + email
	if personID != "" {
		sourceID = "pipedrive://person/" + personID
	}
	tags := append(pipedriveDefaultTags(integration), "pipedrive-organization")
	out := ContactInput{
		SourceID:   sourceID,
		Email:      email,
		FirstName:  firstString(pipedriveNestedString(organization["person_id"], "first_name"), pipedriveNestedString(organization["person"], "first_name")),
		LastName:   firstString(pipedriveNestedString(organization["person_id"], "last_name"), pipedriveNestedString(organization["person"], "last_name")),
		FullName:   firstString(pipedriveNestedString(organization["person_id"], "name"), pipedriveNestedString(organization["person"], "name")),
		Company:    name,
		ListIDs:    pipedriveListIDs(integration),
		Tags:       uniqueCRMStrings(tags),
		Properties: props,
		UpdatedAt:  updated,
	}
	if out.FullName == "" {
		out.FullName = strings.TrimSpace(strings.TrimSpace(out.FirstName + " " + out.LastName))
	}
	return out, true
}

func mapPipedriveActivityEvent(activity map[string]any, integration Integration, action string) (EventInput, bool) {
	email := strings.ToLower(strings.TrimSpace(pipedriveActivityEmail(activity)))
	if email == "" {
		return EventInput{}, false
	}
	id := pipedriveIDString(activity["id"])
	if id == "" {
		id = pipedriveIDString(activity["activity_id"])
	}
	if id == "" {
		return EventInput{}, false
	}
	eventName := pipedriveActivityEventName(action, pipedriveBool(activity["done"]))
	occurred := firstParsedHubSpotTime(
		pipedriveString(activity, "marked_as_done_time"),
		pipedriveString(activity, "update_time"),
		pipedriveString(activity, "updated_at"),
		pipedriveActivityDueDateTime(activity),
		pipedriveString(activity, "due_date"),
		pipedriveString(activity, "add_time"),
		pipedriveString(activity, "created_at"),
	)
	props := map[string]any{
		"pipedrive_activity_id": id,
		"pipedrive_raw":         activity,
	}
	for _, key := range []string{
		"subject", "type", "done", "deal_id", "lead_id", "person_id", "org_id", "owner_id",
		"due_date", "due_time", "duration", "busy", "location", "note", "public_description",
		"priority", "attendees", "participants",
	} {
		if value, ok := activity[key]; ok && value != nil {
			props["pipedrive_"+key] = value
		}
	}
	if action = strings.TrimSpace(action); action != "" {
		props["pipedrive_action"] = action
	}
	if company := firstString(pipedriveNestedString(activity["org_id"], "name"), pipedriveNestedString(activity["organization"], "name"), pipedriveString(activity, "org_name")); company != "" {
		props["company"] = company
	}
	return EventInput{
		SourceID:   "pipedrive://activity/" + id,
		Email:      email,
		EventName:  eventName,
		Properties: props,
		OccurredAt: occurred,
	}, true
}

func pipedriveDealEventName(action, status string) string {
	action = strings.ToLower(strings.TrimSpace(action))
	status = strings.ToLower(strings.TrimSpace(status))
	switch action {
	case "added", "add", "create", "created":
		return "crm.deal.created"
	case "deleted", "delete":
		return "crm.deal.deleted"
	case "merged":
		return "crm.deal.merged"
	}
	switch status {
	case "won":
		return "crm.deal.won"
	case "lost":
		return "crm.deal.lost"
	case "open":
		return "crm.deal.open"
	case "deleted":
		return "crm.deal.deleted"
	default:
		return "crm.deal.updated"
	}
}

func pipedriveActivityEventName(action string, done bool) string {
	action = strings.ToLower(strings.TrimSpace(action))
	switch action {
	case "added", "add", "create", "created":
		return "crm.activity.created"
	case "deleted", "delete":
		return "crm.activity.deleted"
	}
	if done {
		return "crm.activity.completed"
	}
	return "crm.activity.updated"
}

func pipedriveDealEmail(deal map[string]any) string {
	return firstString(
		pipedriveString(deal, "primary_email"),
		pipedrivePrimaryValue(deal["emails"]),
		pipedrivePrimaryValue(deal["email"]),
		pipedrivePrimaryValue(deal["person_email"]),
		pipedriveNestedString(deal["person_id"], "primary_email"),
		pipedrivePrimaryValue(pipedriveNestedAny(deal["person_id"], "emails")),
		pipedrivePrimaryValue(pipedriveNestedAny(deal["person_id"], "email")),
		pipedriveNestedString(deal["person"], "primary_email"),
		pipedrivePrimaryValue(pipedriveNestedAny(deal["person"], "emails")),
		pipedrivePrimaryValue(pipedriveNestedAny(deal["person"], "email")),
	)
}

func pipedriveOrganizationEmail(organization map[string]any) string {
	return firstString(
		pipedriveEmailValue(organization["primary_email"]),
		pipedriveEmailValue(organization["emails"]),
		pipedriveEmailValue(organization["email"]),
		pipedriveEmailValue(organization["person_email"]),
		pipedriveEmailValue(pipedriveNestedAny(organization["person_id"], "primary_email")),
		pipedriveEmailValue(pipedriveNestedAny(organization["person_id"], "emails")),
		pipedriveEmailValue(pipedriveNestedAny(organization["person_id"], "email")),
		pipedriveEmailValue(pipedriveNestedAny(organization["person"], "primary_email")),
		pipedriveEmailValue(pipedriveNestedAny(organization["person"], "emails")),
		pipedriveEmailValue(pipedriveNestedAny(organization["person"], "email")),
	)
}

func pipedriveOrganizationPersonID(organization map[string]any) string {
	rawPersonID := ""
	if _, ok := organization["person_id"].(map[string]any); !ok {
		rawPersonID = pipedriveIDString(organization["person_id"])
	}
	return firstString(
		pipedriveNestedString(organization["person_id"], "id"),
		pipedriveNestedString(organization["person"], "id"),
		rawPersonID,
	)
}

func pipedriveActivityEmail(activity map[string]any) string {
	return firstString(
		pipedriveEmailValue(activity["primary_email"]),
		pipedriveEmailValue(activity["person_email"]),
		pipedriveEmailValue(activity["emails"]),
		pipedriveEmailValue(activity["email"]),
		pipedriveEmailValue(activity["attendees"]),
		pipedriveEmailValue(activity["participants"]),
		pipedriveEmailValue(pipedriveNestedAny(activity["person_id"], "primary_email")),
		pipedriveEmailValue(pipedriveNestedAny(activity["person_id"], "emails")),
		pipedriveEmailValue(pipedriveNestedAny(activity["person_id"], "email")),
		pipedriveEmailValue(pipedriveNestedAny(activity["person"], "primary_email")),
		pipedriveEmailValue(pipedriveNestedAny(activity["person"], "emails")),
		pipedriveEmailValue(pipedriveNestedAny(activity["person"], "email")),
	)
}

func pipedriveActivityDueDateTime(activity map[string]any) string {
	date := strings.TrimSpace(pipedriveString(activity, "due_date"))
	clock := strings.TrimSpace(pipedriveString(activity, "due_time"))
	if date == "" || clock == "" {
		return ""
	}
	if len(clock) == len("15:04") {
		clock += ":00"
	}
	return date + " " + clock
}

func pipedriveNestedAny(value any, key string) any {
	if typed, ok := value.(map[string]any); ok {
		return typed[key]
	}
	return nil
}

func pipedriveCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func pipedriveIsStoredCredentialRef(ref string) bool {
	return strings.HasPrefix(strings.TrimSpace(ref), pipedriveStoredCredentialRefPrefix)
}

func normalizePipedriveBearerToken(token string) string {
	token = strings.TrimSpace(token)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func pipedriveAPIBaseURL(baseOverride, companyDomain string) (string, error) {
	raw := strings.TrimRight(strings.TrimSpace(baseOverride), "/")
	if raw == "" {
		domain := strings.TrimSpace(companyDomain)
		if domain == "" {
			return "", fmt.Errorf("pipedrive company_domain or api_base_url is required")
		}
		domain = strings.TrimPrefix(strings.TrimPrefix(domain, "https://"), "http://")
		domain = strings.TrimRight(domain, "/")
		if !strings.Contains(domain, ".") {
			domain += ".pipedrive.com"
		}
		raw = "https://" + domain
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("parse pipedrive API base URL: %w", err)
	}
	if u.Scheme == "" {
		u.Scheme = "https"
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", fmt.Errorf("pipedrive API base URL must be http or https")
	}
	if u.Host == "" {
		return "", fmt.Errorf("pipedrive API base URL host is required")
	}
	u.RawQuery = ""
	u.Fragment = ""
	u.Path = strings.TrimRight(u.Path, "/")
	return strings.TrimRight(u.String(), "/"), nil
}

func pipedriveLimit(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return pipedriveDefaultLimit
	}
	if n > pipedriveMaxLimit {
		return pipedriveMaxLimit
	}
	return n
}

func pipedriveListIDs(integration Integration) []string {
	return uniqueCRMStrings(append(
		hubSpotStringListSetting(integration.Settings, "list_ids"),
		firstString(settingString(integration.Settings, "default_list_id")),
	))
}

func pipedriveDefaultTags(integration Integration) []string {
	tags := append([]string{"pipedrive", "pipedrive-person"}, hubSpotStringListSetting(integration.Settings, "default_tags")...)
	return uniqueCRMStrings(tags)
}

func pipedriveSyncDeals(integration Integration) bool {
	raw := strings.ToLower(strings.TrimSpace(settingString(integration.Settings, "sync_deals")))
	return raw != "false" && raw != "0" && raw != "no"
}

func pipedriveSyncOrganizations(integration Integration) bool {
	raw := strings.ToLower(strings.TrimSpace(settingString(integration.Settings, "sync_organizations")))
	return raw != "false" && raw != "0" && raw != "no"
}

func pipedriveSyncActivities(integration Integration) bool {
	raw := strings.ToLower(strings.TrimSpace(settingString(integration.Settings, "sync_activities")))
	return raw != "false" && raw != "0" && raw != "no"
}

func pipedriveNextBackfillObject(integration Integration, current string) string {
	chain := []string{"persons"}
	if pipedriveSyncDeals(integration) {
		chain = append(chain, "deals")
	}
	if pipedriveSyncOrganizations(integration) {
		chain = append(chain, "organizations")
	}
	if pipedriveSyncActivities(integration) {
		chain = append(chain, "activities")
	}
	current = strings.ToLower(strings.TrimSpace(current))
	for i, object := range chain {
		if object == current && i+1 < len(chain) {
			return chain[i+1]
		}
	}
	return ""
}

func parsePipedriveCredentialExpiry(raw string, expiresIn int) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw != "" {
		for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05"} {
			if parsed, err := time.Parse(layout, raw); err == nil {
				out := parsed.UTC()
				return &out
			}
		}
	}
	if expiresIn > 0 {
		out := time.Now().UTC().Add(time.Duration(expiresIn) * time.Second)
		return &out
	}
	return nil
}

func pipedriveWebhookEndpoint(appBaseURL string) string {
	appBaseURL = strings.TrimRight(strings.TrimSpace(appBaseURL), "/")
	if appBaseURL == "" {
		return ""
	}
	return appBaseURL + "/api/public/crm-integrations/pipedrive/webhooks"
}

func pipedriveWebhookTopics(integration Integration, override []string) []string {
	values := append([]string(nil), override...)
	if len(values) == 0 {
		values = append(values, hubSpotStringListSetting(integration.Settings, "webhook_events")...)
	}
	if len(values) == 0 {
		values = []string{
			"create.person",
			"change.person",
			"delete.person",
			"create.deal",
			"change.deal",
			"delete.deal",
			"create.organization",
			"change.organization",
			"delete.organization",
			"create.activity",
			"change.activity",
			"delete.activity",
		}
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		action, object, ok := splitPipedriveWebhookTopic(value)
		if ok {
			out = append(out, action+"."+object)
		}
	}
	return uniqueCRMStrings(out)
}

func splitPipedriveWebhookTopic(topic string) (string, string, bool) {
	parts := strings.SplitN(strings.ToLower(strings.TrimSpace(topic)), ".", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	action := normalizePipedriveWebhookAction(parts[0])
	object := normalizePipedriveWebhookObject(parts[1])
	if action == "" || object == "" {
		return "", "", false
	}
	return action, object, true
}

func normalizePipedriveWebhookAction(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "create", "created", "add", "added":
		return "create"
	case "change", "changed", "update", "updated":
		return "change"
	case "delete", "deleted", "remove", "removed":
		return "delete"
	case "*":
		return "*"
	default:
		return ""
	}
}

func normalizePipedriveWebhookObject(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "person", "persons":
		return "person"
	case "deal", "deals":
		return "deal"
	case "organization", "organizations", "org":
		return "organization"
	case "activity", "activities":
		return "activity"
	case "lead", "note", "pipeline", "product", "stage", "user", "*":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return ""
	}
}

func findPipedriveWebhook(existing []pipedriveWebhookSubscription, endpoint, action, object string) (pipedriveWebhookSubscription, bool) {
	for _, sub := range existing {
		if strings.TrimSpace(sub.Endpoint) == endpoint && sub.EventAction == action && sub.EventObject == object {
			return sub, true
		}
	}
	return pipedriveWebhookSubscription{}, false
}

type pipedriveWebhookPayload struct {
	Event    string         `json:"event"`
	Retry    int            `json:"retry"`
	Current  map[string]any `json:"current"`
	Previous map[string]any `json:"previous"`
	Raw      map[string]any `json:"-"`
	Meta     struct {
		Action         string      `json:"action"`
		Object         string      `json:"object"`
		ID             any         `json:"id"`
		CompanyID      any         `json:"company_id"`
		UserID         any         `json:"user_id"`
		Host           string      `json:"host"`
		Timestamp      json.Number `json:"timestamp"`
		TimestampMicro json.Number `json:"timestamp_micro"`
		WebhookID      any         `json:"webhook_id"`
	} `json:"meta"`
}

func decodePipedriveWebhookPayload(body []byte) (pipedriveWebhookPayload, error) {
	var out pipedriveWebhookPayload
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return pipedriveWebhookPayload{}, fmt.Errorf("decode pipedrive webhook body: %w", err)
	}
	_ = json.Unmarshal(body, &out.Raw)
	return out, nil
}

func pipedriveWebhookSubscriptionID(payload pipedriveWebhookPayload) string {
	return pipedriveIDString(payload.Meta.WebhookID)
}

func pipedriveWebhookDeliveryID(payload pipedriveWebhookPayload, body []byte) string {
	sum := sha256.Sum256(body)
	base := base64.RawURLEncoding.EncodeToString(sum[:])
	subscriptionID := pipedriveWebhookSubscriptionID(payload)
	if subscriptionID == "" {
		return "pipedrive_local_" + base
	}
	return "pipedrive:" + subscriptionID + ":" + base
}

func pipedriveWebhookTopic(payload pipedriveWebhookPayload) string {
	action := strings.ToLower(strings.TrimSpace(firstString(payload.Meta.Action, strings.TrimSuffix(payload.Event, "."+payload.Meta.Object))))
	object := strings.ToLower(strings.TrimSpace(payload.Meta.Object))
	if action == "" || object == "" {
		eventParts := strings.SplitN(strings.ToLower(strings.TrimSpace(payload.Event)), ".", 2)
		if len(eventParts) == 2 {
			action = eventParts[0]
			object = eventParts[1]
		}
	}
	return firstString(action, "unknown") + "." + firstString(object, "unknown")
}

func validatePipedriveWebhookRouteIdentity(payload pipedriveWebhookPayload, integration Integration) error {
	payloadCompanyID := pipedriveIDString(payload.Meta.CompanyID)
	if want := strings.TrimSpace(firstString(settingString(integration.Settings, "pipedrive_company_id"), settingString(integration.Settings, "company_id"))); payloadCompanyID != "" && want != "" && payloadCompanyID != want {
		return fmt.Errorf("pipedrive webhook company_id mismatch")
	}
	payloadUserID := pipedriveIDString(payload.Meta.UserID)
	if want := strings.TrimSpace(firstString(settingString(integration.Settings, "pipedrive_user_id"), settingString(integration.Settings, "user_id"))); payloadUserID != "" && want != "" && payloadUserID != want {
		return fmt.Errorf("pipedrive webhook user_id mismatch")
	}
	payloadHost := normalizePipedriveWebhookHost(payload.Meta.Host)
	wantHost := normalizePipedriveWebhookHost(firstString(
		settingString(integration.Settings, "pipedrive_company_domain"),
		settingString(integration.Settings, "company_domain"),
		settingString(integration.Settings, "api_base_url"),
	))
	if payloadHost != "" && wantHost != "" && payloadHost != wantHost {
		return fmt.Errorf("pipedrive webhook host mismatch")
	}
	return nil
}

func normalizePipedriveWebhookHost(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "https://")
	value = strings.TrimPrefix(value, "http://")
	if idx := strings.Index(value, "/"); idx >= 0 {
		value = value[:idx]
	}
	value = strings.TrimSuffix(value, ".pipedrive.com")
	value = strings.TrimSpace(value)
	return value
}

func mapPipedriveWebhookSyncRequest(payload pipedriveWebhookPayload, integration Integration, deliveryID string) (SyncRequest, bool) {
	object := strings.ToLower(strings.TrimSpace(payload.Meta.Object))
	action := strings.ToLower(strings.TrimSpace(payload.Meta.Action))
	current := payload.Current
	if len(current) == 0 {
		current = payload.Previous
	}
	if len(current) == 0 {
		return SyncRequest{}, false
	}
	switch object {
	case "person", "persons":
		if action == "deleted" || action == "delete" {
			if event, ok := mapPipedrivePersonDeleteEvent(current, payload); ok {
				return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Events: []EventInput{event}, Cursor: deliveryID}), true
			}
			return SyncRequest{}, false
		}
		contact, ok := mapPipedrivePerson(current, integration)
		if !ok {
			return SyncRequest{}, false
		}
		contact.Properties["pipedrive_webhook_event"] = payload.Event
		contact.Properties["pipedrive_webhook_meta"] = payload.Meta
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Contacts: []ContactInput{contact}, Cursor: deliveryID}), true
	case "deal", "deals":
		event, ok := mapPipedriveDealEvent(current, integration, action)
		if !ok {
			return SyncRequest{}, false
		}
		event.Properties["pipedrive_webhook_event"] = payload.Event
		event.Properties["pipedrive_webhook_meta"] = payload.Meta
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Events: []EventInput{event}, Cursor: deliveryID}), true
	case "organization", "organizations", "org":
		if action == "deleted" || action == "delete" {
			if event, ok := mapPipedriveOrganizationDeleteEvent(current, payload); ok {
				return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Events: []EventInput{event}, Cursor: deliveryID}), true
			}
			return SyncRequest{}, false
		}
		contact, ok := mapPipedriveOrganizationContact(current, integration, action)
		if !ok {
			return SyncRequest{}, false
		}
		contact.Properties["pipedrive_webhook_event"] = payload.Event
		contact.Properties["pipedrive_webhook_meta"] = payload.Meta
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Contacts: []ContactInput{contact}, Cursor: deliveryID}), true
	case "activity", "activities":
		event, ok := mapPipedriveActivityEvent(current, integration, action)
		if !ok {
			return SyncRequest{}, false
		}
		event.Properties["pipedrive_webhook_event"] = payload.Event
		event.Properties["pipedrive_webhook_meta"] = payload.Meta
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Events: []EventInput{event}, Cursor: deliveryID}), true
	default:
		return SyncRequest{}, false
	}
}

func mapPipedrivePersonDeleteEvent(person map[string]any, payload pipedriveWebhookPayload) (EventInput, bool) {
	email := strings.ToLower(strings.TrimSpace(firstString(
		pipedrivePrimaryValue(person["emails"]),
		pipedrivePrimaryValue(person["email"]),
		pipedriveString(person, "primary_email"),
	)))
	if email == "" {
		return EventInput{}, false
	}
	id := pipedriveIDString(person["id"])
	if id == "" {
		id = email
	}
	occurred := firstParsedHubSpotTime(pipedriveString(person, "update_time"), pipedriveString(person, "updated_at"))
	return EventInput{
		SourceID:  "pipedrive://person/" + id,
		Email:     email,
		EventName: "crm.person.deleted",
		Properties: map[string]any{
			"pipedrive_person_id":     id,
			"pipedrive_webhook_event": payload.Event,
			"pipedrive_webhook_meta":  payload.Meta,
			"pipedrive_raw":           person,
		},
		OccurredAt: occurred,
	}, true
}

func mapPipedriveOrganizationDeleteEvent(organization map[string]any, payload pipedriveWebhookPayload) (EventInput, bool) {
	email := strings.ToLower(strings.TrimSpace(pipedriveOrganizationEmail(organization)))
	if email == "" {
		return EventInput{}, false
	}
	id := pipedriveIDString(organization["id"])
	if id == "" {
		id = pipedriveIDString(organization["org_id"])
	}
	if id == "" {
		id = email
	}
	occurred := firstParsedHubSpotTime(pipedriveString(organization, "update_time"), pipedriveString(organization, "updated_at"))
	return EventInput{
		SourceID:  "pipedrive://organization/" + id,
		Email:     email,
		EventName: "crm.organization.deleted",
		Properties: map[string]any{
			"pipedrive_organization_id": id,
			"pipedrive_webhook_event":   payload.Event,
			"pipedrive_webhook_meta":    payload.Meta,
			"pipedrive_raw":             organization,
		},
		OccurredAt: occurred,
	}, true
}

func verifyPipedriveWebhookBasicAuth(creds PipedriveCredentials, r *http.Request) error {
	wantUser := strings.TrimSpace(creds.WebhookUsername)
	wantPass := strings.TrimSpace(creds.WebhookPassword)
	if wantUser == "" || wantPass == "" {
		return fmt.Errorf("pipedrive webhook Basic Auth is not configured")
	}
	gotUser, gotPass, ok := r.BasicAuth()
	if !ok {
		return fmt.Errorf("pipedrive webhook Basic Auth is required")
	}
	if subtle.ConstantTimeCompare([]byte(gotUser), []byte(wantUser)) != 1 ||
		subtle.ConstantTimeCompare([]byte(gotPass), []byte(wantPass)) != 1 {
		return fmt.Errorf("pipedrive webhook Basic Auth is invalid")
	}
	return nil
}

func pipedriveString(record map[string]any, key string) string {
	if record == nil {
		return ""
	}
	return pipedriveAnyString(record[key])
}

func pipedriveNestedString(value any, key string) string {
	if typed, ok := value.(map[string]any); ok {
		return pipedriveString(typed, key)
	}
	return ""
}

func pipedriveIDString(value any) string {
	return pipedriveAnyString(value)
}

func pipedriveAnyString(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case float64:
		return strings.TrimSpace(strconv.FormatFloat(typed, 'f', -1, 64))
	case float32:
		return strings.TrimSpace(strconv.FormatFloat(float64(typed), 'f', -1, 32))
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func pipedrivePrimaryValue(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []any:
		return pipedrivePrimaryValueFromSlice(typed)
	case []map[string]any:
		items := make([]any, 0, len(typed))
		for _, item := range typed {
			items = append(items, item)
		}
		return pipedrivePrimaryValueFromSlice(items)
	case map[string]any:
		return firstString(pipedriveAnyString(typed["value"]), pipedriveAnyString(typed["email"]), pipedriveAnyString(typed["phone"]), pipedriveAnyString(typed["label"]), pipedriveAnyString(typed["name"]))
	default:
		return pipedriveAnyString(value)
	}
}

func pipedriveEmailValue(value any) string {
	switch typed := value.(type) {
	case string:
		return pipedriveCleanEmail(typed)
	case []any:
		return pipedriveEmailValueFromSlice(typed)
	case []map[string]any:
		items := make([]any, 0, len(typed))
		for _, item := range typed {
			items = append(items, item)
		}
		return pipedriveEmailValueFromSlice(items)
	case map[string]any:
		return firstString(
			pipedriveCleanEmail(pipedriveAnyString(typed["email"])),
			pipedriveCleanEmail(pipedriveAnyString(typed["value"])),
			pipedriveCleanEmail(pipedriveAnyString(typed["primary_email"])),
		)
	default:
		return pipedriveCleanEmail(pipedriveAnyString(value))
	}
}

func pipedriveEmailValueFromSlice(items []any) string {
	first := ""
	for _, item := range items {
		value := pipedriveEmailValue(item)
		if value == "" {
			continue
		}
		if first == "" {
			first = value
		}
		if typed, ok := item.(map[string]any); ok && pipedriveBool(typed["primary"]) {
			return value
		}
	}
	return first
}

func pipedriveCleanEmail(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" || !strings.Contains(value, "@") {
		return ""
	}
	return value
}

func pipedrivePrimaryValueFromSlice(items []any) string {
	first := ""
	for _, item := range items {
		value := pipedrivePrimaryValue(item)
		if value == "" {
			continue
		}
		if first == "" {
			first = value
		}
		if typed, ok := item.(map[string]any); ok && pipedriveBool(typed["primary"]) {
			return value
		}
	}
	return first
}

func pipedriveBool(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	default:
		return false
	}
}
