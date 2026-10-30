// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"bytes"
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

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	hubSpotSyncModelContactsREST = "hubspot_crm_contacts_list_memberships_deal_events_rest"
	hubSpotCursorPrefix          = "hubspot:"
	hubSpotCursorComplete        = "hubspot:complete"
	hubSpotDefaultAPIBaseURL     = "https://api.hubapi.com"
	hubSpotDefaultAPIVersion     = "2026-03"
	hubSpotDefaultPageSize       = 100
	hubSpotMaxPageSize           = 100
	hubSpotResponseMaxBytes      = 8 << 20
	hubSpotDefaultUserAgent      = "Moosewave HubSpot Integration"
)

type HubSpotCredentials struct {
	AccessToken    string
	RefreshToken   string
	ClientID       string
	ClientSecret   string
	APIBaseURL     string
	OAuthBaseURL   string
	APIVersion     string
	UserAgent      string
	Scope          string
	PortalID       string
	TokenExpiresAt *time.Time
}

type HubSpotOAuthRevocationSummary struct {
	Revoked   bool   `json:"revoked"`
	Skipped   bool   `json:"skipped,omitempty"`
	Reason    string `json:"reason,omitempty"`
	TokenType string `json:"token_type,omitempty"`
	RevokedAt string `json:"revoked_at,omitempty"`
}

type HubSpotCredentialResolver interface {
	ResolveHubSpot(context.Context, string, Integration) (HubSpotCredentials, error)
}

type HubSpotBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type HubSpotRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials HubSpotCredentialResolver
	APIBaseURL  string
	APIVersion  string
	UserAgent   string
	PageSize    int
}

type HubSpotRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

const hubSpotStoredCredentialPrefix = "crm:hubspot:"

// HubSpotCredentialStore persists encrypted managed OAuth credential envelopes
// (reuses the provider-agnostic crm_credential_secrets table).
type HubSpotCredentialStore interface {
	GetHubSpotCredentialSecret(context.Context, string, string) (string, error)
	PutHubSpotCredentialSecret(context.Context, string, string, HubSpotCredentials) error
}

type HubSpotCredentialDeleter interface {
	DeleteHubSpotCredentialSecret(context.Context, string, string) error
}

type HubSpotSecretsCredentialResolver struct {
	Secrets     HubSpotRuntimeSecretResolver
	Store       HubSpotCredentialStore
	OAuthClient HubSpotOAuthClient
	RefreshSkew time.Duration
	Now         func() time.Time
}

func NewHubSpotSecretsCredentialResolver(secrets HubSpotRuntimeSecretResolver) *HubSpotSecretsCredentialResolver {
	return &HubSpotSecretsCredentialResolver{Secrets: secrets}
}

func hubSpotIsStoredCredentialRef(ref string) bool {
	return strings.HasPrefix(strings.TrimSpace(ref), hubSpotStoredCredentialPrefix)
}

func (r *HubSpotSecretsCredentialResolver) ResolveHubSpot(ctx context.Context, tenantID string, integration Integration) (HubSpotCredentials, error) {
	if r == nil || (r.Secrets == nil && r.Store == nil) {
		return HubSpotCredentials{}, fmt.Errorf("hubspot credential resolver is not configured")
	}
	ref := hubSpotCredentialRef(integration)
	if ref == "" {
		return HubSpotCredentials{}, fmt.Errorf("hubspot credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, tenantID, ref)
	if err != nil {
		return HubSpotCredentials{}, err
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = settingString(integration.Settings, "api_base_url")
	}
	if creds.APIVersion == "" {
		creds.APIVersion = settingString(integration.Settings, "api_version")
	}
	if creds.OAuthBaseURL == "" {
		creds.OAuthBaseURL = settingString(integration.Settings, "oauth_base_url")
	}
	if creds.UserAgent == "" {
		creds.UserAgent = settingString(integration.Settings, "user_agent")
	}
	return r.refreshCredentialIfNeeded(ctx, tenantID, ref, creds)
}

func (r *HubSpotSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, tenantID, ref string) (HubSpotCredentials, error) {
	if r.Store != nil && hubSpotIsStoredCredentialRef(ref) {
		raw, err := r.Store.GetHubSpotCredentialSecret(ctx, tenantID, ref)
		if err == nil {
			return parseHubSpotCredentialSecret(raw)
		}
		if !errors.Is(err, ErrNotFound) {
			return HubSpotCredentials{}, fmt.Errorf("resolve stored hubspot credentials %q: %w", ref, err)
		}
	}
	if r.Secrets == nil {
		return HubSpotCredentials{}, fmt.Errorf("hubspot credential secret resolver is not configured")
	}
	var payload hubSpotCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return HubSpotCredentials{}, fmt.Errorf("resolve hubspot credentials %q: %w", ref, err)
		}
		return parseHubSpotCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return HubSpotCredentials{}, fmt.Errorf("resolve hubspot credentials %q: %w", ref, err)
	}
	return parseHubSpotCredentialSecret(raw)
}

func (r *HubSpotSecretsCredentialResolver) refreshCredentialIfNeeded(ctx context.Context, tenantID, ref string, creds HubSpotCredentials) (HubSpotCredentials, error) {
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
		return HubSpotCredentials{}, fmt.Errorf("refresh hubspot OAuth token: %w", err)
	}
	creds.AccessToken = token.AccessToken
	if strings.TrimSpace(token.RefreshToken) != "" {
		creds.RefreshToken = token.RefreshToken
	}
	if strings.TrimSpace(token.Scope) != "" {
		creds.Scope = token.Scope
	}
	expiresAt := token.ExpiresAt.UTC()
	creds.TokenExpiresAt = &expiresAt
	if r.Store != nil && hubSpotIsStoredCredentialRef(ref) {
		if err := r.Store.PutHubSpotCredentialSecret(ctx, tenantID, ref, creds); err != nil {
			return HubSpotCredentials{}, fmt.Errorf("persist refreshed hubspot OAuth token: %w", err)
		}
	}
	return creds, nil
}

type hubSpotCredentialPayload struct {
	AccessToken  string `json:"access_token"`
	PrivateApp   string `json:"private_app_token"`
	Token        string `json:"token"`
	BearerToken  string `json:"bearer_token"`
	APIKey       string `json:"api_key"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ClientID     string `json:"client_id,omitempty"`
	ClientSecret string `json:"client_secret,omitempty"`
	APIBaseURL   string `json:"api_base_url,omitempty"`
	OAuthBaseURL string `json:"oauth_base_url,omitempty"`
	APIVersion   string `json:"api_version,omitempty"`
	UserAgent    string `json:"user_agent,omitempty"`
	Scope        string `json:"scope,omitempty"`
	PortalID     string `json:"portal_id,omitempty"`
	ExpiresAt    string `json:"expires_at,omitempty"`
}

func (p hubSpotCredentialPayload) credentials() (HubSpotCredentials, error) {
	token := normalizeHubSpotBearerToken(firstString(p.AccessToken, p.PrivateApp, p.Token, p.BearerToken, p.APIKey))
	if token == "" {
		return HubSpotCredentials{}, fmt.Errorf("hubspot access_token or private_app_token is required")
	}
	creds := HubSpotCredentials{
		AccessToken:  token,
		RefreshToken: strings.TrimSpace(p.RefreshToken),
		ClientID:     strings.TrimSpace(p.ClientID),
		ClientSecret: strings.TrimSpace(p.ClientSecret),
		APIBaseURL:   strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		OAuthBaseURL: strings.TrimRight(strings.TrimSpace(p.OAuthBaseURL), "/"),
		APIVersion:   strings.TrimSpace(p.APIVersion),
		UserAgent:    strings.TrimSpace(p.UserAgent),
		Scope:        strings.TrimSpace(p.Scope),
		PortalID:     strings.TrimSpace(p.PortalID),
	}
	if expires := strings.TrimSpace(p.ExpiresAt); expires != "" {
		if at, err := time.Parse(time.RFC3339, expires); err == nil {
			utc := at.UTC()
			creds.TokenExpiresAt = &utc
		}
	}
	return creds, nil
}

// hubSpotStoredCredentialJSON serializes managed OAuth credentials for the
// encrypted crm_credential_secrets envelope.
func hubSpotStoredCredentialJSON(creds HubSpotCredentials) string {
	payload := hubSpotCredentialPayload{
		AccessToken:  strings.TrimSpace(creds.AccessToken),
		RefreshToken: strings.TrimSpace(creds.RefreshToken),
		ClientID:     strings.TrimSpace(creds.ClientID),
		ClientSecret: strings.TrimSpace(creds.ClientSecret),
		APIBaseURL:   strings.TrimRight(strings.TrimSpace(creds.APIBaseURL), "/"),
		OAuthBaseURL: strings.TrimRight(strings.TrimSpace(creds.OAuthBaseURL), "/"),
		APIVersion:   strings.TrimSpace(creds.APIVersion),
		UserAgent:    strings.TrimSpace(creds.UserAgent),
		Scope:        strings.TrimSpace(creds.Scope),
		PortalID:     strings.TrimSpace(creds.PortalID),
	}
	if creds.TokenExpiresAt != nil {
		payload.ExpiresAt = creds.TokenExpiresAt.UTC().Format(time.RFC3339)
	}
	raw, _ := json.Marshal(payload)
	return string(raw)
}

func parseHubSpotCredentialSecret(raw string) (HubSpotCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return HubSpotCredentials{}, fmt.Errorf("hubspot credentials are empty")
	}
	var payload hubSpotCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return HubSpotCredentials{}, fmt.Errorf("parse hubspot credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parseHubSpotKeyValueSecret(raw)
		return payload.credentials()
	}
	return hubSpotCredentialPayload{AccessToken: raw}.credentials()
}

func parseHubSpotKeyValueSecret(raw string) hubSpotCredentialPayload {
	var payload hubSpotCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token", "private_app_token", "token", "bearer_token", "api_key":
			payload.AccessToken = value
		case "refresh_token":
			payload.RefreshToken = value
		case "client_id":
			payload.ClientID = value
		case "client_secret":
			payload.ClientSecret = value
		case "api_base_url", "base_url":
			payload.APIBaseURL = value
		case "oauth_base_url":
			payload.OAuthBaseURL = value
		case "api_version":
			payload.APIVersion = value
		case "user_agent":
			payload.UserAgent = value
		case "scope":
			payload.Scope = value
		case "portal_id", "hub_id":
			payload.PortalID = value
		case "expires_at":
			payload.ExpiresAt = value
		}
	}
	return payload
}

func (b HubSpotRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderHubSpot {
		return SyncRequest{}, fmt.Errorf("hubspot backfill requires a HubSpot integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("hubspot credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveHubSpot(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("hubspot access token is required")
	}
	state, err := decodeHubSpotCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "complete" {
		return SyncRequest{RunMode: "backfill", Cursor: hubSpotCursorComplete}, nil
	}
	if state.Object == "" {
		state.Object = "contacts"
	}
	client := crmEgressClient(b.HTTPClient, ProviderHubSpot, 15*time.Second)
	switch state.Object {
	case "contacts":
		return b.backfillContactsPage(ctx, client, integration, creds, state)
	case "list_memberships":
		return b.backfillListMembershipsPage(ctx, client, integration, creds, state)
	case "deals":
		return b.backfillDealsPage(ctx, client, integration, creds, state)
	default:
		return SyncRequest{}, fmt.Errorf("unsupported hubspot backfill object %q", state.Object)
	}
}

func (b HubSpotRESTBackfiller) backfillContactsPage(ctx context.Context, client *http.Client, integration Integration, creds HubSpotCredentials, state hubSpotCursorState) (SyncRequest, error) {
	objects, nextAfter, err := b.fetchContactsPage(ctx, client, integration, creds, state.After)
	if err != nil {
		return SyncRequest{}, err
	}
	contacts := make([]ContactInput, 0, len(objects))
	for _, object := range objects {
		if contact, ok := mapHubSpotContactWithListIDs(object, integration, nil); ok {
			contacts = append(contacts, contact)
		}
	}
	var nextCursor string
	if nextAfter != "" {
		nextCursor = encodeHubSpotCursor(hubSpotCursorState{Object: "contacts", After: nextAfter})
	} else {
		nextCursor = hubSpotNextCursorAfterContacts(integration)
	}
	return normalizeSyncRequest(SyncRequest{
		RunMode:  "backfill",
		Contacts: contacts,
		Cursor:   nextCursor,
	}), nil
}

func (b HubSpotRESTBackfiller) backfillListMembershipsPage(ctx context.Context, client *http.Client, integration Integration, creds HubSpotCredentials, state hubSpotCursorState) (SyncRequest, error) {
	listID := strings.TrimSpace(state.ListID)
	if listID == "" {
		ids := hubSpotMembershipListIDs(integration)
		if len(ids) == 0 {
			return SyncRequest{RunMode: "backfill", Cursor: hubSpotCursorComplete}, nil
		}
		listID = ids[0]
	}
	contactIDs, nextAfter, err := b.fetchListMembershipsPage(ctx, client, integration, creds, listID, state.After)
	if err != nil {
		return SyncRequest{}, err
	}
	objects, err := b.fetchContactsBatchByIDs(ctx, client, integration, creds, contactIDs)
	if err != nil {
		return SyncRequest{}, err
	}
	contacts := make([]ContactInput, 0, len(objects))
	for _, object := range objects {
		if contact, ok := mapHubSpotContactWithListIDs(object, integration, []string{listID}); ok {
			contacts = append(contacts, contact)
		}
	}
	var nextCursor string
	if nextAfter != "" {
		nextCursor = encodeHubSpotCursor(hubSpotCursorState{Object: "list_memberships", ListID: listID, After: nextAfter})
	} else {
		nextCursor = hubSpotNextCursorAfterListMembership(integration, listID)
	}
	req := normalizeSyncRequest(SyncRequest{
		RunMode:  "backfill",
		Contacts: contacts,
		Cursor:   nextCursor,
	})
	req.nativeListMembershipScans = hubSpotNativeListMembershipScans(integration, listID, state.After == "", nextAfter == "")
	req.nativeListMembershipManaged = len(req.nativeListMembershipScans) > 0
	return req, nil
}

func (b HubSpotRESTBackfiller) backfillDealsPage(ctx context.Context, client *http.Client, integration Integration, creds HubSpotCredentials, state hubSpotCursorState) (SyncRequest, error) {
	objects, nextAfter, err := b.fetchDealsPage(ctx, client, integration, creds, state.After)
	if err != nil {
		return SyncRequest{}, err
	}
	contactIDs, companyIDs := hubSpotDealAssociationIDs(objects)
	contacts, err := b.fetchContactsBatchByIDs(ctx, client, integration, creds, contactIDs)
	if err != nil {
		return SyncRequest{}, err
	}
	companies, err := b.fetchCompaniesBatchByIDs(ctx, client, integration, creds, companyIDs)
	if err != nil {
		return SyncRequest{}, err
	}
	contactByID := map[string]hubSpotObject{}
	for _, contact := range contacts {
		contactByID[contact.ID] = contact
	}
	companyByID := map[string]hubSpotObject{}
	for _, company := range companies {
		companyByID[company.ID] = company
	}
	events := []EventInput{}
	for _, object := range objects {
		events = append(events, mapHubSpotDealEvents(object, contactByID, companyByID, integration)...)
	}
	nextCursor := hubSpotCursorComplete
	if nextAfter != "" {
		nextCursor = encodeHubSpotCursor(hubSpotCursorState{Object: "deals", After: nextAfter})
	}
	return normalizeSyncRequest(SyncRequest{
		RunMode: "backfill",
		Events:  events,
		Cursor:  nextCursor,
	}), nil
}

func (b HubSpotRESTBackfiller) fetchContactsPage(ctx context.Context, client *http.Client, integration Integration, creds HubSpotCredentials, after string) ([]hubSpotObject, string, error) {
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), hubSpotDefaultAPIBaseURL)
	apiVersion := firstString(strings.TrimSpace(b.APIVersion), strings.TrimSpace(creds.APIVersion), settingString(integration.Settings, "api_version"), hubSpotDefaultAPIVersion)
	pageSize := hubSpotPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("limit", strconv.Itoa(pageSize))
	query.Set("archived", "false")
	query.Set("properties", strings.Join(hubSpotContactProperties(integration), ","))
	if after != "" {
		query.Set("after", after)
	}
	var out hubSpotObjectListResponse
	path := hubSpotCRMObjectListPath(apiVersion, "contacts")
	if err := hubSpotDoJSON(ctx, client, baseURL, creds, b.UserAgent, http.MethodGet, path, query, &out); err != nil {
		return nil, "", err
	}
	return out.Results, strings.TrimSpace(out.Paging.Next.After), nil
}

func (b HubSpotRESTBackfiller) fetchDealsPage(ctx context.Context, client *http.Client, integration Integration, creds HubSpotCredentials, after string) ([]hubSpotObject, string, error) {
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), hubSpotDefaultAPIBaseURL)
	apiVersion := firstString(strings.TrimSpace(b.APIVersion), strings.TrimSpace(creds.APIVersion), settingString(integration.Settings, "api_version"), hubSpotDefaultAPIVersion)
	pageSize := hubSpotPageSize(firstString(settingString(integration.Settings, "deal_page_size"), settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("limit", strconv.Itoa(pageSize))
	query.Set("archived", "false")
	query.Set("properties", strings.Join(hubSpotDealProperties(integration), ","))
	query.Set("associations", "contacts,companies")
	if after != "" {
		query.Set("after", after)
	}
	var out hubSpotObjectListResponse
	path := hubSpotCRMObjectListPath(apiVersion, "deals")
	if err := hubSpotDoJSON(ctx, client, baseURL, creds, b.UserAgent, http.MethodGet, path, query, &out); err != nil {
		return nil, "", err
	}
	return out.Results, strings.TrimSpace(out.Paging.Next.After), nil
}

func (b HubSpotRESTBackfiller) fetchListMembershipsPage(ctx context.Context, client *http.Client, integration Integration, creds HubSpotCredentials, listID, after string) ([]string, string, error) {
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), hubSpotDefaultAPIBaseURL)
	pageSize := hubSpotPageSize(firstString(settingString(integration.Settings, "membership_page_size"), settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("limit", strconv.Itoa(pageSize))
	if after != "" {
		query.Set("after", after)
	}
	var out hubSpotListMembershipResponse
	path := "/crm/v3/lists/" + url.PathEscape(strings.TrimSpace(listID)) + "/memberships"
	if err := hubSpotDoJSON(ctx, client, baseURL, creds, b.UserAgent, http.MethodGet, path, query, &out); err != nil {
		return nil, "", err
	}
	ids := make([]string, 0, len(out.Results))
	for _, result := range out.Results {
		if id := hubSpotMembershipRecordID(result); id != "" {
			ids = append(ids, id)
		}
	}
	return uniqueCRMStrings(ids), strings.TrimSpace(out.Paging.Next.After), nil
}

func (b HubSpotRESTBackfiller) fetchContactsBatchByIDs(ctx context.Context, client *http.Client, integration Integration, creds HubSpotCredentials, ids []string) ([]hubSpotObject, error) {
	ids = uniqueCRMStrings(ids)
	if len(ids) == 0 {
		return nil, nil
	}
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), hubSpotDefaultAPIBaseURL)
	inputs := make([]map[string]string, 0, len(ids))
	for _, id := range ids {
		inputs = append(inputs, map[string]string{"id": id})
	}
	body := map[string]any{
		"properties": hubSpotContactProperties(integration),
		"inputs":     inputs,
	}
	var out hubSpotObjectListResponse
	if err := hubSpotDoJSONBody(ctx, client, baseURL, creds, b.UserAgent, http.MethodPost, "/crm/v3/objects/contacts/batch/read", nil, body, &out); err != nil {
		return nil, err
	}
	return out.Results, nil
}

func (b HubSpotRESTBackfiller) fetchCompaniesBatchByIDs(ctx context.Context, client *http.Client, integration Integration, creds HubSpotCredentials, ids []string) ([]hubSpotObject, error) {
	ids = uniqueCRMStrings(ids)
	if len(ids) == 0 {
		return nil, nil
	}
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), hubSpotDefaultAPIBaseURL)
	inputs := make([]map[string]string, 0, len(ids))
	for _, id := range ids {
		inputs = append(inputs, map[string]string{"id": id})
	}
	body := map[string]any{
		"properties": hubSpotCompanyProperties(integration),
		"inputs":     inputs,
	}
	var out hubSpotObjectListResponse
	if err := hubSpotDoJSONBody(ctx, client, baseURL, creds, b.UserAgent, http.MethodPost, "/crm/v3/objects/companies/batch/read", nil, body, &out); err != nil {
		return nil, err
	}
	return out.Results, nil
}

// FetchContactByID retrieves a single contact (used by the webhook runtime,
// which receives only an objectId). A provider 404 yields (_, false, nil).
func (b HubSpotRESTBackfiller) FetchContactByID(ctx context.Context, tenantID string, integration Integration, objectID string) (ContactInput, bool, error) {
	objectID = strings.TrimSpace(objectID)
	if objectID == "" {
		return ContactInput{}, false, fmt.Errorf("hubspot contact id is required")
	}
	if b.Credentials == nil {
		return ContactInput{}, false, fmt.Errorf("hubspot credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveHubSpot(ctx, tenantID, integration)
	if err != nil {
		return ContactInput{}, false, err
	}
	client := crmEgressClient(b.HTTPClient, ProviderHubSpot, 15*time.Second)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), hubSpotDefaultAPIBaseURL)
	apiVersion := firstString(strings.TrimSpace(b.APIVersion), strings.TrimSpace(creds.APIVersion), settingString(integration.Settings, "api_version"), hubSpotDefaultAPIVersion)
	query := url.Values{}
	query.Set("archived", "false")
	query.Set("properties", strings.Join(hubSpotContactProperties(integration), ","))
	var obj hubSpotObject
	path := hubSpotCRMObjectPath(apiVersion, "contacts", objectID)
	if err := hubSpotDoJSON(ctx, client, baseURL, creds, b.UserAgent, http.MethodGet, path, query, &obj); err != nil {
		var rate HubSpotRateLimitError
		if errors.As(err, &rate) && rate.StatusCode == http.StatusNotFound {
			return ContactInput{}, false, nil
		}
		return ContactInput{}, false, err
	}
	contact, ok := mapHubSpotContact(obj, integration)
	return contact, ok, nil
}

type hubSpotCursorState struct {
	Object string `json:"object"`
	After  string `json:"after,omitempty"`
	ListID string `json:"list_id,omitempty"`
}

func decodeHubSpotCursor(cursor string) (hubSpotCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return hubSpotCursorState{Object: "contacts"}, nil
	}
	if cursor == hubSpotCursorComplete {
		return hubSpotCursorState{Object: "complete"}, nil
	}
	if !strings.HasPrefix(cursor, hubSpotCursorPrefix) {
		return hubSpotCursorState{Object: "contacts", After: cursor}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, hubSpotCursorPrefix))
	if err != nil {
		return hubSpotCursorState{}, fmt.Errorf("decode HubSpot cursor: %w", err)
	}
	var state hubSpotCursorState
	if err := json.Unmarshal(raw, &state); err != nil {
		return hubSpotCursorState{}, fmt.Errorf("parse HubSpot cursor: %w", err)
	}
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	state.After = strings.TrimSpace(state.After)
	state.ListID = strings.TrimSpace(state.ListID)
	if state.Object == "" {
		state.Object = "contacts"
	}
	if !validHubSpotCursorObject(state.Object) {
		return hubSpotCursorState{}, fmt.Errorf("unsupported hubspot cursor object %q", state.Object)
	}
	return state, nil
}

func validHubSpotCursorObject(object string) bool {
	return object == "contacts" || object == "list_memberships" || object == "deals" || object == "complete"
}

func encodeHubSpotCursor(state hubSpotCursorState) string {
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	if state.Object == "" {
		state.Object = "contacts"
	}
	state.After = strings.TrimSpace(state.After)
	state.ListID = strings.TrimSpace(state.ListID)
	raw, _ := json.Marshal(state)
	return hubSpotCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type hubSpotObjectListResponse struct {
	Results []hubSpotObject `json:"results"`
	Paging  struct {
		Next struct {
			After string `json:"after"`
		} `json:"next"`
	} `json:"paging"`
}

type hubSpotObject struct {
	ID           string                         `json:"id"`
	CreatedAt    string                         `json:"createdAt"`
	UpdatedAt    string                         `json:"updatedAt"`
	Archived     bool                           `json:"archived"`
	Props        map[string]any                 `json:"properties"`
	Associations map[string]hubSpotAssociations `json:"associations,omitempty"`
}

type hubSpotAssociations struct {
	Results []hubSpotAssociationRef `json:"results"`
}

type hubSpotAssociationRef struct {
	ID   string `json:"id"`
	Type string `json:"type,omitempty"`
}

func mapHubSpotContact(object hubSpotObject, integration Integration) (ContactInput, bool) {
	return mapHubSpotContactWithListIDs(object, integration, nil)
}

func mapHubSpotContactWithListIDs(object hubSpotObject, integration Integration, provenListIDs []string) (ContactInput, bool) {
	props := object.Props
	email := strings.ToLower(strings.TrimSpace(hubSpotPropertyString(props, "email")))
	if email == "" {
		return ContactInput{}, false
	}
	objectID := firstString(object.ID, hubSpotPropertyString(props, "hs_object_id"))
	if objectID == "" {
		return ContactInput{}, false
	}
	updated := firstParsedHubSpotTime(object.UpdatedAt, hubSpotPropertyString(props, "hs_lastmodifieddate"), hubSpotPropertyString(props, "lastmodifieddate"))
	out := ContactInput{
		// Keep native CRM sync and one-time migration in the same stable source
		// identity namespace. The profile sink also claims this exact value as
		// external_id so primary-email changes update one subscriber in place.
		SourceID:       "hubspot://contact/" + objectID,
		Email:          email,
		FirstName:      hubSpotPropertyString(props, "firstname"),
		LastName:       hubSpotPropertyString(props, "lastname"),
		FullName:       hubSpotPropertyString(props, "name"),
		Phone:          hubSpotPropertyString(props, "phone"),
		Company:        firstString(hubSpotPropertyString(props, "company"), hubSpotPropertyString(props, "companyname")),
		LifecycleStage: hubSpotPropertyString(props, "lifecyclestage"),
		ListIDs:        hubSpotContactListIDs(integration, provenListIDs),
		Tags:           hubSpotDefaultTags(integration),
		Properties: map[string]any{
			"hubspot_object_id": object.ID,
			"hubspot_archived":  object.Archived,
			"hubspot_raw":       props,
		},
	}
	if len(provenListIDs) > 0 {
		provenListIDs = uniqueCRMStrings(provenListIDs)
		out.Properties["hubspot_proven_list_ids"] = provenListIDs
		out.Properties["crm_provider_list_ids"] = provenListIDs
		out.Properties["crm_provider_segment_type"] = "hubspot_list"
		out.Properties["crm_provider_segment_ids"] = provenListIDs
		out.Properties["crm_provider_segment_removed"] = false
		if len(provenListIDs) == 1 {
			out.Properties["crm_provider_list_id"] = provenListIDs[0]
			out.Properties["crm_provider_segment_id"] = provenListIDs[0]
		}
		out.Properties["hubspot_list_membership_report"] = hubSpotListMembershipReport(object, provenListIDs)
	}
	if updated != nil {
		out.UpdatedAt = updated
	}
	if out.FullName == "" {
		out.FullName = strings.TrimSpace(strings.TrimSpace(out.FirstName + " " + out.LastName))
	}
	return out, true
}

func hubSpotContactObjectID(sourceID string) string {
	sourceID = strings.TrimSpace(sourceID)
	for _, prefix := range []string{"hubspot://contact/", "hubspot:contact:"} {
		if strings.HasPrefix(sourceID, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(sourceID, prefix))
		}
	}
	return sourceID
}

func hubSpotListMembershipReport(object hubSpotObject, provenListIDs []string) []map[string]any {
	contactID := firstString(object.ID, hubSpotPropertyString(object.Props, "hs_object_id"))
	out := make([]map[string]any, 0, len(provenListIDs))
	for _, listID := range uniqueCRMStrings(provenListIDs) {
		out = append(out, map[string]any{
			"provider":        ProviderHubSpot,
			"provider_object": "ListMembership",
			"segment_type":    "List",
			"segment_id":      listID,
			"contact_id":      contactID,
			"removed":         false,
		})
	}
	return out
}

type hubSpotListMembershipResponse struct {
	Results []map[string]any `json:"results"`
	Paging  struct {
		Next struct {
			After string `json:"after"`
		} `json:"next"`
	} `json:"paging"`
}

func hubSpotMembershipRecordID(result map[string]any) string {
	for _, key := range []string{"recordId", "record_id", "contactId", "contact_id", "id"} {
		if value, ok := result[key]; ok {
			id := strings.TrimSpace(fmt.Sprint(value))
			if id != "" && id != "<nil>" {
				return id
			}
		}
	}
	return ""
}

func mapHubSpotDealEvents(object hubSpotObject, contactByID, companyByID map[string]hubSpotObject, integration Integration) []EventInput {
	contactIDs := hubSpotAssociationIDs(object, "contacts")
	companyIDs := hubSpotAssociationIDs(object, "companies")
	companies := make([]map[string]any, 0, len(companyIDs))
	for _, companyID := range companyIDs {
		if company, ok := companyByID[companyID]; ok {
			companies = append(companies, hubSpotCompanySummary(company))
		}
	}
	events := make([]EventInput, 0, len(contactIDs))
	for _, contactID := range contactIDs {
		contact, ok := contactByID[contactID]
		if !ok {
			continue
		}
		email := strings.ToLower(strings.TrimSpace(hubSpotPropertyString(contact.Props, "email")))
		if email == "" {
			continue
		}
		event, ok := mapHubSpotDealEventForContact(object, contact, companies, integration)
		if ok {
			events = append(events, event)
		}
	}
	return events
}

func mapHubSpotDealEventForContact(deal hubSpotObject, contact hubSpotObject, companies []map[string]any, integration Integration) (EventInput, bool) {
	email := strings.ToLower(strings.TrimSpace(hubSpotPropertyString(contact.Props, "email")))
	dealID := firstString(deal.ID, hubSpotPropertyString(deal.Props, "hs_object_id"))
	contactID := firstString(contact.ID, hubSpotPropertyString(contact.Props, "hs_object_id"))
	if email == "" || dealID == "" {
		return EventInput{}, false
	}
	occurred := firstParsedHubSpotTime(deal.UpdatedAt, hubSpotPropertyString(deal.Props, "hs_lastmodifieddate"), hubSpotPropertyString(deal.Props, "lastmodifieddate"), hubSpotPropertyString(deal.Props, "closedate"), deal.CreatedAt)
	props := map[string]any{
		"hubspot_object":     "deal",
		"hubspot_deal_id":    dealID,
		"hubspot_contact_id": contactID,
		"hubspot_deal_name":  hubSpotPropertyString(deal.Props, "dealname"),
		"hubspot_pipeline":   hubSpotPropertyString(deal.Props, "pipeline"),
		"hubspot_deal_stage": hubSpotPropertyString(deal.Props, "dealstage"),
		"hubspot_amount":     hubSpotPropertyString(deal.Props, "amount"),
		"hubspot_close_date": hubSpotPropertyString(deal.Props, "closedate"),
		"hubspot_companies":  companies,
		"hubspot_raw":        deal.Props,
	}
	if configured := hubSpotListIDs(integration); len(configured) > 0 {
		props["crm_list_ids"] = configured
	}
	return EventInput{
		SourceID:   "hubspot://deal/" + dealID + "/contact/" + contactID,
		Email:      email,
		EventName:  "crm.deal.updated",
		Properties: props,
		OccurredAt: occurred,
	}, true
}

func hubSpotCompanySummary(company hubSpotObject) map[string]any {
	return map[string]any{
		"id":     company.ID,
		"name":   firstString(hubSpotPropertyString(company.Props, "name"), hubSpotPropertyString(company.Props, "company")),
		"domain": hubSpotPropertyString(company.Props, "domain"),
	}
}

func hubSpotDealAssociationIDs(objects []hubSpotObject) ([]string, []string) {
	contactIDs := []string{}
	companyIDs := []string{}
	for _, object := range objects {
		contactIDs = append(contactIDs, hubSpotAssociationIDs(object, "contacts")...)
		companyIDs = append(companyIDs, hubSpotAssociationIDs(object, "companies")...)
	}
	return uniqueCRMStrings(contactIDs), uniqueCRMStrings(companyIDs)
}

func hubSpotAssociationIDs(object hubSpotObject, key string) []string {
	assoc, ok := object.Associations[key]
	if !ok {
		return nil
	}
	ids := make([]string, 0, len(assoc.Results))
	for _, ref := range assoc.Results {
		if id := strings.TrimSpace(ref.ID); id != "" {
			ids = append(ids, id)
		}
	}
	return uniqueCRMStrings(ids)
}

func hubSpotDoJSON(ctx context.Context, client *http.Client, baseURL string, creds HubSpotCredentials, userAgent, method, path string, query url.Values, out any) error {
	return hubSpotDoJSONBody(ctx, client, baseURL, creds, userAgent, method, path, query, nil, out)
}

func hubSpotDoJSONBody(ctx context.Context, client *http.Client, baseURL string, creds HubSpotCredentials, userAgent, method, path string, query url.Values, body any, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse hubspot API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	if query != nil {
		u.RawQuery = query.Encode()
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode hubspot request %s: %w", path, err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, hubSpotDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, hubSpotResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return HubSpotRateLimitError{
			Path:       path,
			StatusCode: resp.StatusCode,
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    truncateHubSpotString(string(responseBody), 500),
		}
	}
	if out == nil {
		return nil
	}
	if len(responseBody) == 0 {
		return nil
	}
	if err := json.Unmarshal(responseBody, out); err != nil {
		return fmt.Errorf("decode hubspot response %s: %w", path, err)
	}
	return nil
}

type HubSpotRateLimitError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e HubSpotRateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("hubspot REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("hubspot REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func hubSpotCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func normalizeHubSpotBearerToken(token string) string {
	token = strings.TrimSpace(token)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func hubSpotCRMObjectListPath(apiVersion, object string) string {
	apiVersion = strings.TrimSpace(apiVersion)
	object = strings.Trim(strings.TrimSpace(object), "/")
	switch strings.ToLower(apiVersion) {
	case "", "2026-03":
		return "/crm/objects/2026-03/" + object
	case "v3", "legacy", "legacy-v3":
		return "/crm/v3/objects/" + object
	default:
		return "/crm/objects/" + apiVersion + "/" + object
	}
}

func hubSpotCRMObjectPath(apiVersion, object, id string) string {
	return hubSpotCRMObjectListPath(apiVersion, object) + "/" + url.PathEscape(strings.TrimSpace(id))
}

func hubSpotPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return hubSpotDefaultPageSize
	}
	if n > hubSpotMaxPageSize {
		return hubSpotMaxPageSize
	}
	return n
}

func hubSpotContactProperties(integration Integration) []string {
	defaults := []string{"email", "firstname", "lastname", "phone", "company", "lifecyclestage", "createdate", "lastmodifieddate", "hs_lastmodifieddate", "hs_object_id"}
	configured := hubSpotStringListSetting(integration.Settings, "properties")
	if len(configured) == 0 {
		return defaults
	}
	return uniqueCRMStrings(append(defaults, configured...))
}

func hubSpotDealProperties(integration Integration) []string {
	defaults := []string{"dealname", "dealstage", "pipeline", "amount", "closedate", "createdate", "lastmodifieddate", "hs_lastmodifieddate", "hs_object_id"}
	configured := hubSpotStringListSetting(integration.Settings, "deal_properties")
	if len(configured) == 0 {
		return defaults
	}
	return uniqueCRMStrings(append(defaults, configured...))
}

func hubSpotCompanyProperties(integration Integration) []string {
	defaults := []string{"name", "domain", "createdate", "lastmodifieddate", "hs_object_id"}
	configured := hubSpotStringListSetting(integration.Settings, "company_properties")
	if len(configured) == 0 {
		return defaults
	}
	return uniqueCRMStrings(append(defaults, configured...))
}

func hubSpotListIDs(integration Integration) []string {
	return uniqueCRMStrings(append(
		hubSpotStringListSetting(integration.Settings, "list_ids"),
		firstString(settingString(integration.Settings, "list_id"), settingString(integration.Settings, "default_list_id")),
	))
}

func hubSpotContactListIDs(integration Integration, provenListIDs []string) []string {
	if len(provenListIDs) > 0 {
		return uniqueCRMStrings(provenListIDs)
	}
	return hubSpotListIDs(integration)
}

func hubSpotSyncListMemberships(integration Integration) bool {
	value := strings.ToLower(strings.TrimSpace(settingString(integration.Settings, "sync_list_memberships")))
	return value == "true" || value == "1" || value == "yes"
}

func hubSpotSyncDeals(integration Integration) bool {
	value := strings.ToLower(strings.TrimSpace(settingString(integration.Settings, "sync_deals")))
	return value == "true" || value == "1" || value == "yes"
}

func hubSpotMembershipListIDs(integration Integration) []string {
	if !hubSpotSyncListMemberships(integration) {
		return nil
	}
	ids := []string{}
	ids = append(ids, hubSpotStringListSetting(integration.Settings, "membership_list_ids")...)
	ids = append(ids, hubSpotStringListSetting(integration.Settings, "hubspot_list_ids")...)
	ids = append(ids, hubSpotStringListSetting(integration.Settings, "list_ids")...)
	ids = append(ids, firstString(settingString(integration.Settings, "list_id"), settingString(integration.Settings, "default_list_id")))
	return uniqueCRMStrings(ids)
}

func hubSpotNextCursorAfterContacts(integration Integration) string {
	if cursor := hubSpotNextMembershipCursor(integration, ""); cursor != hubSpotCursorComplete {
		return cursor
	}
	if hubSpotSyncDeals(integration) {
		return encodeHubSpotCursor(hubSpotCursorState{Object: "deals"})
	}
	return hubSpotCursorComplete
}

func hubSpotNextCursorAfterListMembership(integration Integration, currentListID string) string {
	if cursor := hubSpotNextMembershipCursor(integration, currentListID); cursor != hubSpotCursorComplete {
		return cursor
	}
	if hubSpotSyncDeals(integration) {
		return encodeHubSpotCursor(hubSpotCursorState{Object: "deals"})
	}
	return hubSpotCursorComplete
}

func hubSpotNextMembershipCursor(integration Integration, currentListID string) string {
	ids := hubSpotMembershipListIDs(integration)
	if len(ids) == 0 {
		return hubSpotCursorComplete
	}
	next := 0
	currentListID = strings.TrimSpace(currentListID)
	if currentListID != "" {
		next = len(ids)
		for i, id := range ids {
			if id == currentListID {
				next = i + 1
				break
			}
		}
	}
	if next >= len(ids) {
		return hubSpotCursorComplete
	}
	return encodeHubSpotCursor(hubSpotCursorState{Object: "list_memberships", ListID: ids[next]})
}

func hubSpotNativeListMembershipScans(integration Integration, providerListID string, start, complete bool) []CRMNativeListMembershipScan {
	providerListID = strings.TrimSpace(providerListID)
	if providerListID == "" {
		return nil
	}
	mapping := crmProviderListMembershipMap(integration.Settings, "list_membership_map", "hubspot_list_membership_map")
	nativeListID := strings.TrimSpace(mapping[providerListID])
	if nativeListID == "" {
		return nil
	}
	return []CRMNativeListMembershipScan{{
		Provider:            ProviderHubSpot,
		ProviderSegmentType: "hubspot_list",
		ProviderListID:      providerListID,
		NativeListID:        nativeListID,
		Start:               start,
		Complete:            complete,
	}}
}

func hubSpotDefaultTags(integration Integration) []string {
	tags := append([]string{"hubspot"}, hubSpotStringListSetting(integration.Settings, "default_tags")...)
	return uniqueCRMStrings(tags)
}

func hubSpotStringListSetting(settings map[string]any, key string) []string {
	v, ok := settings[strings.ToLower(strings.TrimSpace(key))]
	if !ok || v == nil {
		return nil
	}
	switch typed := v.(type) {
	case []string:
		return uniqueCRMStrings(typed)
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			out = append(out, strings.TrimSpace(fmt.Sprint(item)))
		}
		return uniqueCRMStrings(out)
	case string:
		parts := strings.FieldsFunc(typed, func(r rune) bool {
			return r == ',' || r == '\n' || r == ';'
		})
		return uniqueCRMStrings(parts)
	default:
		return uniqueCRMStrings([]string{fmt.Sprint(typed)})
	}
}

func hubSpotPropertyString(props map[string]any, key string) string {
	if props == nil {
		return ""
	}
	v, ok := props[key]
	if !ok || v == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(v))
}

func firstParsedHubSpotTime(values ...string) *time.Time {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z", "2006-01-02T15:04:05.000-0700", "2006-01-02 15:04:05", "2006-01-02"} {
			if parsed, err := time.Parse(layout, value); err == nil {
				utc := parsed.UTC()
				return &utc
			}
		}
		if millis, err := strconv.ParseInt(value, 10, 64); err == nil && millis > 0 {
			utc := time.UnixMilli(millis).UTC()
			return &utc
		}
	}
	return nil
}

func parseRetryAfter(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil {
		delay := time.Until(at)
		if delay > 0 {
			return delay
		}
	}
	return 0
}

func truncateHubSpotString(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit]
}

func uniqueCRMStrings(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, value)
	}
	return out
}
