// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

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

	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	salesforceSyncModelSOQL    = "salesforce_crm_soql_contacts_leads_campaign_members_tasks"
	salesforceCursorPrefix     = "salesforce:"
	salesforceCursorComplete   = "salesforce:complete"
	salesforceDefaultAPIVer    = "67.0"
	salesforceDefaultBatchSize = 200
	salesforceMaxBatchSize     = 2000
	salesforceResponseMaxBytes = 8 << 20
	salesforceDefaultUserAgent = "Moosewave Salesforce Integration"
)

type SalesforceCredentials struct {
	AccessToken    string
	RefreshToken   string
	ClientID       string
	ClientSecret   string
	InstanceURL    string
	LoginURL       string
	IdentityURL    string
	APIVersion     string
	UserAgent      string
	Scope          string
	TokenExpiresAt *time.Time
}

type SalesforceCredentialResolver interface {
	ResolveSalesforce(context.Context, string, Integration) (SalesforceCredentials, error)
}

type SalesforceCredentialAuthFailureRefresher interface {
	RefreshSalesforceAfterAuthFailure(context.Context, string, Integration, SalesforceCredentials) (SalesforceCredentials, error)
}

type SalesforceBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type SalesforceRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials SalesforceCredentialResolver
	APIVersion  string
	UserAgent   string
	BatchSize   int
}

type SalesforceRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type SalesforceSecretsCredentialResolver struct {
	Secrets     SalesforceRuntimeSecretResolver
	Store       SalesforceCredentialStore
	OAuthClient SalesforceOAuthClient
	RefreshSkew time.Duration
	Now         func() time.Time
}

func NewSalesforceSecretsCredentialResolver(secrets SalesforceRuntimeSecretResolver) *SalesforceSecretsCredentialResolver {
	return &SalesforceSecretsCredentialResolver{Secrets: secrets}
}

func (r *SalesforceSecretsCredentialResolver) ResolveSalesforce(ctx context.Context, tenantID string, integration Integration) (SalesforceCredentials, error) {
	if r == nil || (r.Secrets == nil && r.Store == nil) {
		return SalesforceCredentials{}, fmt.Errorf("salesforce credential resolver is not configured")
	}
	ref := salesforceCredentialRef(integration)
	if ref == "" {
		return SalesforceCredentials{}, fmt.Errorf("salesforce credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, tenantID, ref)
	if err != nil {
		return SalesforceCredentials{}, err
	}
	if creds.InstanceURL == "" {
		creds.InstanceURL = settingString(integration.Settings, "instance_url")
	}
	if creds.APIVersion == "" {
		creds.APIVersion = settingString(integration.Settings, "api_version")
	}
	if creds.LoginURL == "" {
		creds.LoginURL = settingString(integration.Settings, "login_url")
	}
	if creds.UserAgent == "" {
		creds.UserAgent = settingString(integration.Settings, "user_agent")
	}
	return r.refreshCredentialIfNeeded(ctx, tenantID, ref, creds)
}

func (r *SalesforceSecretsCredentialResolver) refreshCredentialIfNeeded(ctx context.Context, tenantID, ref string, creds SalesforceCredentials) (SalesforceCredentials, error) {
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
		return SalesforceCredentials{}, fmt.Errorf("refresh salesforce OAuth token: %w", err)
	}
	creds.AccessToken = token.AccessToken
	if strings.TrimSpace(token.RefreshToken) != "" {
		creds.RefreshToken = token.RefreshToken
	}
	if strings.TrimSpace(token.InstanceURL) != "" {
		creds.InstanceURL = token.InstanceURL
	}
	if strings.TrimSpace(token.Scope) != "" {
		creds.Scope = token.Scope
	}
	expiresAt := token.ExpiresAt.UTC()
	creds.TokenExpiresAt = &expiresAt
	if r.Store != nil && salesforceIsStoredCredentialRef(ref) {
		if err := r.Store.PutSalesforceCredentialSecret(ctx, tenantID, ref, creds); err != nil {
			return SalesforceCredentials{}, fmt.Errorf("persist refreshed salesforce OAuth token: %w", err)
		}
	}
	return creds, nil
}

func (r *SalesforceSecretsCredentialResolver) RefreshSalesforceAfterAuthFailure(ctx context.Context, tenantID string, integration Integration, creds SalesforceCredentials) (SalesforceCredentials, error) {
	if r == nil {
		return SalesforceCredentials{}, fmt.Errorf("salesforce credential resolver is not configured")
	}
	if strings.TrimSpace(creds.RefreshToken) == "" || strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return SalesforceCredentials{}, fmt.Errorf("salesforce refresh_token, client_id, and client_secret are required for reactive OAuth refresh")
	}
	client := r.OAuthClient
	if client.Now == nil && r.Now != nil {
		client.Now = r.Now
	}
	token, err := client.RefreshAccessToken(ctx, creds)
	if err != nil {
		return SalesforceCredentials{}, fmt.Errorf("refresh salesforce OAuth token after auth failure: %w", err)
	}
	if strings.TrimSpace(token.AccessToken) == "" {
		return SalesforceCredentials{}, fmt.Errorf("salesforce OAuth refresh returned empty access_token")
	}
	creds.AccessToken = token.AccessToken
	if strings.TrimSpace(token.RefreshToken) != "" {
		creds.RefreshToken = token.RefreshToken
	}
	if strings.TrimSpace(token.InstanceURL) != "" {
		creds.InstanceURL = token.InstanceURL
	}
	if strings.TrimSpace(token.Scope) != "" {
		creds.Scope = token.Scope
	}
	if strings.TrimSpace(token.IdentityURL) != "" {
		creds.IdentityURL = token.IdentityURL
	}
	expiresAt := token.ExpiresAt.UTC()
	creds.TokenExpiresAt = &expiresAt
	ref := salesforceCredentialRef(integration)
	if r.Store != nil && salesforceIsStoredCredentialRef(ref) {
		if err := r.Store.PutSalesforceCredentialSecret(ctx, tenantID, ref, creds); err != nil {
			return SalesforceCredentials{}, fmt.Errorf("persist reactively refreshed salesforce OAuth token: %w", err)
		}
	}
	return creds, nil
}

func (r *SalesforceSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, tenantID, ref string) (SalesforceCredentials, error) {
	if r.Store != nil && salesforceIsStoredCredentialRef(ref) {
		raw, err := r.Store.GetSalesforceCredentialSecret(ctx, tenantID, ref)
		if err == nil {
			return parseSalesforceCredentialSecret(raw)
		}
		if !errors.Is(err, ErrNotFound) {
			return SalesforceCredentials{}, fmt.Errorf("resolve stored salesforce credentials %q: %w", ref, err)
		}
	}
	if r.Secrets == nil {
		return SalesforceCredentials{}, fmt.Errorf("salesforce credential secret resolver is not configured")
	}
	var payload salesforceCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return SalesforceCredentials{}, fmt.Errorf("resolve salesforce credentials %q: %w", ref, err)
		}
		return parseSalesforceCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return SalesforceCredentials{}, fmt.Errorf("resolve salesforce credentials %q: %w", ref, err)
	}
	return parseSalesforceCredentialSecret(raw)
}

type salesforceCredentialPayload struct {
	AccessToken  string `json:"access_token"`
	Token        string `json:"token"`
	BearerToken  string `json:"bearer_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ClientID     string `json:"client_id,omitempty"`
	ClientSecret string `json:"client_secret,omitempty"`
	InstanceURL  string `json:"instance_url"`
	LoginURL     string `json:"login_url,omitempty"`
	IdentityURL  string `json:"identity_url,omitempty"`
	APIBaseURL   string `json:"api_base_url"`
	APIVersion   string `json:"api_version"`
	UserAgent    string `json:"user_agent"`
	Scope        string `json:"scope,omitempty"`
	ExpiresAt    string `json:"expires_at,omitempty"`
}

func (p salesforceCredentialPayload) credentials() (SalesforceCredentials, error) {
	token := normalizeSalesforceBearerToken(firstString(p.AccessToken, p.Token, p.BearerToken))
	if token == "" {
		return SalesforceCredentials{}, fmt.Errorf("salesforce access_token is required")
	}
	creds := SalesforceCredentials{
		AccessToken:  token,
		RefreshToken: strings.TrimSpace(p.RefreshToken),
		ClientID:     strings.TrimSpace(p.ClientID),
		ClientSecret: strings.TrimSpace(p.ClientSecret),
		InstanceURL:  strings.TrimRight(firstString(p.InstanceURL, p.APIBaseURL), "/"),
		LoginURL:     strings.TrimRight(strings.TrimSpace(p.LoginURL), "/"),
		IdentityURL:  strings.TrimSpace(p.IdentityURL),
		APIVersion:   strings.TrimSpace(p.APIVersion),
		UserAgent:    strings.TrimSpace(p.UserAgent),
		Scope:        strings.TrimSpace(p.Scope),
	}
	if expires := strings.TrimSpace(p.ExpiresAt); expires != "" {
		if at, err := time.Parse(time.RFC3339, expires); err == nil {
			utc := at.UTC()
			creds.TokenExpiresAt = &utc
		}
	}
	return creds, nil
}

// salesforceStoredCredentialJSON serializes managed OAuth credentials for the
// encrypted crm_credential_secrets envelope.
func salesforceStoredCredentialJSON(creds SalesforceCredentials) string {
	payload := salesforceCredentialPayload{
		AccessToken:  strings.TrimSpace(creds.AccessToken),
		RefreshToken: strings.TrimSpace(creds.RefreshToken),
		ClientID:     strings.TrimSpace(creds.ClientID),
		ClientSecret: strings.TrimSpace(creds.ClientSecret),
		InstanceURL:  strings.TrimRight(strings.TrimSpace(creds.InstanceURL), "/"),
		LoginURL:     strings.TrimRight(strings.TrimSpace(creds.LoginURL), "/"),
		IdentityURL:  strings.TrimSpace(creds.IdentityURL),
		APIVersion:   strings.TrimSpace(creds.APIVersion),
		UserAgent:    strings.TrimSpace(creds.UserAgent),
		Scope:        strings.TrimSpace(creds.Scope),
	}
	if creds.TokenExpiresAt != nil {
		payload.ExpiresAt = creds.TokenExpiresAt.UTC().Format(time.RFC3339)
	}
	raw, _ := json.Marshal(payload)
	return string(raw)
}

func parseSalesforceCredentialSecret(raw string) (SalesforceCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return SalesforceCredentials{}, fmt.Errorf("salesforce credentials are empty")
	}
	var payload salesforceCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return SalesforceCredentials{}, fmt.Errorf("parse salesforce credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parseSalesforceKeyValueSecret(raw)
		return payload.credentials()
	}
	return salesforceCredentialPayload{AccessToken: raw}.credentials()
}

func parseSalesforceKeyValueSecret(raw string) salesforceCredentialPayload {
	var payload salesforceCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token", "token", "bearer_token":
			payload.AccessToken = value
		case "refresh_token":
			payload.RefreshToken = value
		case "client_id":
			payload.ClientID = value
		case "client_secret":
			payload.ClientSecret = value
		case "instance_url", "api_base_url", "base_url":
			payload.InstanceURL = value
		case "login_url":
			payload.LoginURL = value
		case "identity_url", "id_url":
			payload.IdentityURL = value
		case "api_version":
			payload.APIVersion = value
		case "user_agent":
			payload.UserAgent = value
		case "scope":
			payload.Scope = value
		case "expires_at", "token_expires_at":
			payload.ExpiresAt = value
		}
	}
	return payload
}

func (b SalesforceRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderSalesforce {
		return SyncRequest{}, fmt.Errorf("salesforce backfill requires a Salesforce integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("salesforce credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveSalesforce(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("salesforce access token is required")
	}
	instanceURL, err := salesforceInstanceURL(creds.InstanceURL)
	if err != nil {
		return SyncRequest{}, err
	}
	state, err := decodeSalesforceCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "complete" {
		return SyncRequest{RunMode: "backfill", Cursor: salesforceCursorComplete}, nil
	}
	if state.Object == "" {
		state.Object = "contacts"
	}
	client := crmEgressClient(b.HTTPClient, ProviderSalesforce, 20*time.Second)
	records, nextURL, err := b.fetchSOQLPage(ctx, client, instanceURL, integration, creds, state)
	if err != nil && salesforceShouldRefreshAfterAuthFailure(err) {
		if refresher, ok := b.Credentials.(SalesforceCredentialAuthFailureRefresher); ok {
			refreshed, refreshErr := refresher.RefreshSalesforceAfterAuthFailure(ctx, tenantID, integration, creds)
			if refreshErr != nil {
				return SyncRequest{}, refreshErr
			}
			creds = refreshed
			instanceURL, err = salesforceInstanceURL(creds.InstanceURL)
			if err != nil {
				return SyncRequest{}, err
			}
			records, nextURL, err = b.fetchSOQLPage(ctx, client, instanceURL, integration, creds, state)
		}
	}
	if err != nil {
		return SyncRequest{}, err
	}
	contacts := []ContactInput{}
	events := []EventInput{}
	switch state.Object {
	case "contacts", "leads":
		contacts = make([]ContactInput, 0, len(records))
		for _, record := range records {
			if contact, ok := mapSalesforceRecord(state.Object, record, integration); ok {
				contacts = append(contacts, contact)
			}
		}
	case "campaign_members":
		events = make([]EventInput, 0, len(records))
		for _, record := range records {
			if event, ok := mapSalesforceCampaignMemberEvent(record, integration); ok {
				events = append(events, event)
			}
		}
	case "tasks":
		events = make([]EventInput, 0, len(records))
		for _, record := range records {
			if event, ok := mapSalesforceTaskEvent(record, integration); ok {
				events = append(events, event)
			}
		}
	default:
		return SyncRequest{}, fmt.Errorf("unsupported salesforce cursor object %q", state.Object)
	}
	nextCursor := salesforceCursorComplete
	if nextURL != "" {
		nextCursor = encodeSalesforceCursor(salesforceCursorState{Object: state.Object, NextRecordsURL: nextURL})
	} else if nextObject := salesforceNextCursorObject(state.Object, integration); nextObject != "" {
		nextCursor = encodeSalesforceCursor(salesforceCursorState{Object: nextObject})
	}
	req := normalizeSyncRequest(SyncRequest{
		RunMode:  "backfill",
		Contacts: contacts,
		Events:   events,
		Cursor:   nextCursor,
	})
	if state.Object == "campaign_members" {
		req.nativeListMembershipScans = salesforceNativeCampaignMembershipScans(integration, state, nextURL == "")
		req.nativeListMembershipManaged = len(req.nativeListMembershipScans) > 0
	}
	return req, nil
}

func (b SalesforceRESTBackfiller) fetchSOQLPage(ctx context.Context, client *http.Client, instanceURL string, integration Integration, creds SalesforceCredentials, state salesforceCursorState) ([]map[string]any, string, error) {
	apiVersion := salesforceAPIVersion(firstString(b.APIVersion, creds.APIVersion, settingString(integration.Settings, "api_version")))
	queryPath := strings.TrimSpace(state.NextRecordsURL)
	query := url.Values{}
	if queryPath == "" {
		queryPath = "/services/data/v" + apiVersion + "/query"
		query.Set("q", salesforceSOQLFor(state.Object, integration))
	}
	reqURL, err := salesforceRequestURL(instanceURL, queryPath, query)
	if err != nil {
		return nil, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(b.UserAgent, creds.UserAgent, salesforceDefaultUserAgent))
	req.Header.Set("Sforce-Query-Options", "batchSize="+strconv.Itoa(salesforceBatchSize(firstString(settingString(integration.Settings, "batch_size"), strconv.Itoa(b.BatchSize)))))
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, salesforceResponseMaxBytes))
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode >= 300 {
		errorCode := salesforceRESTErrorCode(body)
		return nil, "", SalesforceRESTError{
			Path:       queryPath,
			StatusCode: resp.StatusCode,
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
			ErrorCode:  errorCode,
			Snippet:    truncateHubSpotString(string(body), 500),
		}
	}
	var out salesforceQueryResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, "", fmt.Errorf("decode salesforce query response: %w", err)
	}
	return out.Records, strings.TrimSpace(out.NextRecordsURL), nil
}

type salesforceCursorState struct {
	Object         string `json:"object"`
	NextRecordsURL string `json:"next_records_url,omitempty"`
}

func decodeSalesforceCursor(cursor string) (salesforceCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return salesforceCursorState{Object: "contacts"}, nil
	}
	if cursor == salesforceCursorComplete {
		return salesforceCursorState{Object: "complete"}, nil
	}
	if strings.HasPrefix(cursor, "/services/data/") {
		return salesforceCursorState{Object: "contacts", NextRecordsURL: cursor}, nil
	}
	if !strings.HasPrefix(cursor, salesforceCursorPrefix) {
		state := salesforceCursorState{Object: strings.ToLower(cursor)}
		if !validSalesforceCursorObject(state.Object) {
			return salesforceCursorState{}, fmt.Errorf("unsupported salesforce cursor object %q", state.Object)
		}
		return state, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, salesforceCursorPrefix))
	if err != nil {
		return salesforceCursorState{}, fmt.Errorf("decode Salesforce cursor: %w", err)
	}
	var state salesforceCursorState
	if err := json.Unmarshal(raw, &state); err != nil {
		return salesforceCursorState{}, fmt.Errorf("parse Salesforce cursor: %w", err)
	}
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	state.NextRecordsURL = strings.TrimSpace(state.NextRecordsURL)
	if state.Object == "" {
		state.Object = "contacts"
	}
	if !validSalesforceCursorObject(state.Object) {
		return salesforceCursorState{}, fmt.Errorf("unsupported salesforce cursor object %q", state.Object)
	}
	return state, nil
}

func validSalesforceCursorObject(object string) bool {
	return object == "contacts" || object == "leads" || object == "campaign_members" || object == "tasks" || object == "complete"
}

func encodeSalesforceCursor(state salesforceCursorState) string {
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	if state.Object == "" {
		state.Object = "contacts"
	}
	state.NextRecordsURL = strings.TrimSpace(state.NextRecordsURL)
	raw, _ := json.Marshal(state)
	return salesforceCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type salesforceQueryResponse struct {
	TotalSize      int              `json:"totalSize"`
	Done           bool             `json:"done"`
	NextRecordsURL string           `json:"nextRecordsUrl"`
	Records        []map[string]any `json:"records"`
}

type SalesforceRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	ErrorCode  string
	Snippet    string
}

func (e SalesforceRESTError) Error() string {
	code := ""
	if strings.TrimSpace(e.ErrorCode) != "" {
		code = " " + strings.TrimSpace(e.ErrorCode)
	}
	if e.RetryAfter > 0 {
		return fmt.Sprintf("salesforce REST %s failed %d%s; retry after %s: %s", e.Path, e.StatusCode, code, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("salesforce REST %s failed %d%s: %s", e.Path, e.StatusCode, code, e.Snippet)
}

func salesforceShouldRefreshAfterAuthFailure(err error) bool {
	var restErr SalesforceRESTError
	if !errors.As(err, &restErr) {
		return false
	}
	if restErr.StatusCode == http.StatusUnauthorized {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(restErr.ErrorCode), "INVALID_SESSION_ID") {
		return true
	}
	return strings.Contains(strings.ToUpper(restErr.Snippet), "INVALID_SESSION_ID")
}

func salesforceRESTErrorCode(body []byte) string {
	var list []struct {
		ErrorCode string `json:"errorCode"`
	}
	if err := json.Unmarshal(body, &list); err == nil {
		for _, item := range list {
			if code := strings.TrimSpace(item.ErrorCode); code != "" {
				return code
			}
		}
	}
	var obj struct {
		ErrorCode string `json:"errorCode"`
	}
	if err := json.Unmarshal(body, &obj); err == nil {
		return strings.TrimSpace(obj.ErrorCode)
	}
	return ""
}

func mapSalesforceRecord(object string, record map[string]any, integration Integration) (ContactInput, bool) {
	email := strings.ToLower(strings.TrimSpace(salesforceString(record, "Email")))
	if email == "" {
		return ContactInput{}, false
	}
	id := salesforceString(record, "Id")
	kind := "contact"
	if object == "leads" {
		kind = "lead"
	}
	updated := firstParsedHubSpotTime(salesforceString(record, "LastModifiedDate"), salesforceString(record, "CreatedDate"))
	company := salesforceString(record, "Company")
	if company == "" {
		company = salesforceNestedString(record, "Account", "Name")
	}
	phone := firstString(salesforceString(record, "Phone"), salesforceString(record, "MobilePhone"))
	props := map[string]any{
		"salesforce_object": kind,
		"salesforce_id":     id,
		"salesforce_raw":    record,
	}
	if object == "leads" {
		props["salesforce_lead_status"] = salesforceString(record, "Status")
		props["salesforce_is_converted"] = salesforceBool(record, "IsConverted")
		props["salesforce_converted_contact_id"] = salesforceString(record, "ConvertedContactId")
	}
	out := ContactInput{
		SourceID:       "salesforce://" + kind + "/" + id,
		Email:          email,
		FirstName:      salesforceString(record, "FirstName"),
		LastName:       salesforceString(record, "LastName"),
		FullName:       salesforceString(record, "Name"),
		Phone:          phone,
		Company:        company,
		LifecycleStage: firstString(salesforceString(record, "Status"), salesforceString(record, "Title")),
		ListIDs:        salesforceListIDs(integration),
		Tags:           salesforceDefaultTags(integration, kind),
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

func mapSalesforceCampaignMemberEvent(record map[string]any, integration Integration) (EventInput, bool) {
	email := strings.ToLower(strings.TrimSpace(firstString(
		salesforceNestedString(record, "Contact", "Email"),
		salesforceNestedString(record, "Lead", "Email"),
	)))
	if email == "" {
		return EventInput{}, false
	}
	id := salesforceString(record, "Id")
	if id == "" {
		return EventInput{}, false
	}
	campaignID := salesforceString(record, "CampaignId")
	campaignName := salesforceNestedString(record, "Campaign", "Name")
	memberStatus := salesforceString(record, "Status")
	isDeleted := salesforceBool(record, "IsDeleted")
	removed := isDeleted || salesforceCampaignMemberRemovalStatus(memberStatus)
	occurred := firstParsedHubSpotTime(salesforceString(record, "LastModifiedDate"), salesforceString(record, "CreatedDate"))
	props := map[string]any{
		"salesforce_object":                 "campaign_member",
		"salesforce_campaign_member_id":     id,
		"salesforce_campaign_id":            campaignID,
		"salesforce_campaign_name":          campaignName,
		"salesforce_campaign_member_status": memberStatus,
		"salesforce_has_responded":          salesforceBool(record, "HasResponded"),
		"salesforce_is_deleted":             isDeleted,
		"salesforce_contact_id":             salesforceString(record, "ContactId"),
		"salesforce_lead_id":                salesforceString(record, "LeadId"),
		"crm_provider_segment_type":         "salesforce_campaign",
		"crm_provider_segment_id":           campaignID,
		"crm_provider_segment_name":         campaignName,
		"crm_provider_segment_member_id":    id,
		"crm_provider_segment_status":       memberStatus,
		"crm_provider_segment_removed":      removed,
		"salesforce_raw":                    record,
	}
	props["salesforce_campaign_member_report"] = salesforceCampaignMemberReport(record, campaignID, campaignName, id, memberStatus, removed)
	eventName := "crm.campaign_member.updated"
	if removed {
		eventName = "crm.campaign_member.removed"
		props["salesforce_campaign_member_removed"] = true
		props["crm_provider_list_removed"] = true
	}
	if configured := salesforceListIDs(integration); len(configured) > 0 {
		props["crm_list_ids"] = configured
	}
	if campaignID != "" {
		props["crm_provider_list_id"] = campaignID
	}
	return EventInput{
		SourceID:   "salesforce://campaign-member/" + id,
		Email:      email,
		EventName:  eventName,
		Properties: props,
		OccurredAt: occurred,
	}, true
}

func salesforceCampaignMemberReport(record map[string]any, campaignID, campaignName, memberID, memberStatus string, removed bool) map[string]any {
	return map[string]any{
		"provider":          ProviderSalesforce,
		"provider_object":   "CampaignMember",
		"segment_type":      "Campaign",
		"segment_id":        campaignID,
		"segment_name":      campaignName,
		"membership_id":     memberID,
		"membership_status": memberStatus,
		"removed":           removed,
		"is_deleted":        salesforceBool(record, "IsDeleted"),
		"has_responded":     salesforceBool(record, "HasResponded"),
		"contact_id":        salesforceString(record, "ContactId"),
		"lead_id":           salesforceString(record, "LeadId"),
		"created_at":        salesforceString(record, "CreatedDate"),
		"last_modified_at":  salesforceString(record, "LastModifiedDate"),
	}
}

func mapSalesforceTaskEvent(record map[string]any, integration Integration) (EventInput, bool) {
	email := strings.ToLower(strings.TrimSpace(salesforceNestedString(record, "Who", "Email")))
	if email == "" {
		return EventInput{}, false
	}
	id := salesforceString(record, "Id")
	if id == "" {
		return EventInput{}, false
	}
	occurred := firstParsedHubSpotTime(
		salesforceString(record, "CompletedDateTime"),
		salesforceString(record, "LastModifiedDate"),
		salesforceString(record, "ActivityDate"),
		salesforceString(record, "CreatedDate"),
	)
	props := map[string]any{
		"salesforce_object":              "task",
		"salesforce_task_id":             id,
		"salesforce_who_id":              salesforceString(record, "WhoId"),
		"salesforce_who_name":            salesforceNestedString(record, "Who", "Name"),
		"salesforce_subject":             salesforceString(record, "Subject"),
		"salesforce_status":              salesforceString(record, "Status"),
		"salesforce_priority":            salesforceString(record, "Priority"),
		"salesforce_type":                salesforceString(record, "Type"),
		"salesforce_task_subtype":        salesforceString(record, "TaskSubtype"),
		"salesforce_activity_date":       salesforceString(record, "ActivityDate"),
		"salesforce_completed_date_time": salesforceString(record, "CompletedDateTime"),
		"salesforce_owner_id":            salesforceString(record, "OwnerId"),
		"salesforce_description":         salesforceString(record, "Description"),
		"salesforce_raw":                 record,
	}
	if configured := salesforceListIDs(integration); len(configured) > 0 {
		props["crm_list_ids"] = configured
	}
	return EventInput{
		SourceID:   "salesforce://task/" + id,
		Email:      email,
		EventName:  "crm.task.updated",
		Properties: props,
		OccurredAt: occurred,
	}, true
}

func salesforceSOQLFor(object string, integration Integration) string {
	switch object {
	case "campaign_members":
		fields := uniqueCRMStrings(append([]string{"Id", "CampaignId", "Campaign.Name", "ContactId", "Contact.Email", "LeadId", "Lead.Email", "Status", "HasResponded", "IsDeleted", "CreatedDate", "LastModifiedDate"}, salesforceStringListSetting(integration.Settings, "campaign_member_fields")...))
		return "SELECT " + strings.Join(fields, ", ") + " FROM CampaignMember WHERE (ContactId != null OR LeadId != null) ORDER BY LastModifiedDate ASC, Id ASC"
	case "tasks":
		fields := uniqueCRMStrings(append([]string{"Id", "WhoId", "Subject", "Status", "Priority", "Type", "TaskSubtype", "ActivityDate", "CompletedDateTime", "CreatedDate", "LastModifiedDate", "OwnerId", "Description", "TYPEOF Who WHEN Contact THEN Id, Email, Name WHEN Lead THEN Id, Email, Name ELSE Id, Name END"}, salesforceStringListSetting(integration.Settings, "task_fields")...))
		return "SELECT " + strings.Join(fields, ", ") + " FROM Task WHERE WhoId != null ORDER BY LastModifiedDate ASC, Id ASC"
	case "leads":
		fields := uniqueCRMStrings(append([]string{"Id", "Email", "FirstName", "LastName", "Name", "Phone", "MobilePhone", "Company", "Status", "LastModifiedDate", "CreatedDate", "IsConverted", "ConvertedContactId"}, salesforceStringListSetting(integration.Settings, "lead_fields")...))
		return "SELECT " + strings.Join(fields, ", ") + " FROM Lead WHERE Email != null ORDER BY LastModifiedDate ASC, Id ASC"
	default:
		fields := uniqueCRMStrings(append([]string{"Id", "Email", "FirstName", "LastName", "Name", "Phone", "MobilePhone", "Account.Name", "Title", "LastModifiedDate", "CreatedDate"}, salesforceStringListSetting(integration.Settings, "contact_fields")...))
		return "SELECT " + strings.Join(fields, ", ") + " FROM Contact WHERE Email != null ORDER BY LastModifiedDate ASC, Id ASC"
	}
}

func salesforceInstanceURL(raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		return "", fmt.Errorf("salesforce instance_url is required")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("parse salesforce instance_url: %w", err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", fmt.Errorf("salesforce instance_url must be http or https")
	}
	if u.Host == "" {
		return "", fmt.Errorf("salesforce instance_url host is required")
	}
	u.RawQuery = ""
	u.Fragment = ""
	u.Path = strings.TrimRight(u.Path, "/")
	return strings.TrimRight(u.String(), "/"), nil
}

func salesforceRequestURL(instanceURL, path string, query url.Values) (string, error) {
	base, err := url.Parse(strings.TrimRight(instanceURL, "/"))
	if err != nil {
		return "", err
	}
	ref, err := url.Parse(path)
	if err != nil {
		return "", err
	}
	if ref.IsAbs() {
		if ref.Host != base.Host {
			return "", fmt.Errorf("salesforce nextRecordsUrl host mismatch")
		}
		if query != nil && len(query) > 0 {
			ref.RawQuery = query.Encode()
		}
		return ref.String(), nil
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	base.Path = strings.TrimRight(base.Path, "/") + path
	if query != nil && len(query) > 0 {
		base.RawQuery = query.Encode()
	}
	return base.String(), nil
}

func salesforceAPIVersion(raw string) string {
	raw = strings.TrimSpace(strings.TrimPrefix(strings.ToLower(raw), "v"))
	if raw == "" {
		return salesforceDefaultAPIVer
	}
	return raw
}

func salesforceBatchSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return salesforceDefaultBatchSize
	}
	if n > salesforceMaxBatchSize {
		return salesforceMaxBatchSize
	}
	return n
}

func salesforceCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func normalizeSalesforceBearerToken(token string) string {
	token = strings.TrimSpace(token)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func salesforceSyncLeads(integration Integration) bool {
	value := strings.ToLower(strings.TrimSpace(settingString(integration.Settings, "sync_leads")))
	return value != "false" && value != "0" && value != "no"
}

func salesforceSyncCampaignMembers(integration Integration) bool {
	value := strings.ToLower(strings.TrimSpace(settingString(integration.Settings, "sync_campaign_members")))
	return value != "false" && value != "0" && value != "no"
}

func salesforceSyncTasks(integration Integration) bool {
	value := strings.ToLower(strings.TrimSpace(settingString(integration.Settings, "sync_tasks")))
	return value != "false" && value != "0" && value != "no"
}

func salesforceNextCursorObject(current string, integration Integration) string {
	switch current {
	case "contacts":
		if salesforceSyncLeads(integration) {
			return "leads"
		}
		if salesforceSyncCampaignMembers(integration) {
			return "campaign_members"
		}
		if salesforceSyncTasks(integration) {
			return "tasks"
		}
	case "leads":
		if salesforceSyncCampaignMembers(integration) {
			return "campaign_members"
		}
		if salesforceSyncTasks(integration) {
			return "tasks"
		}
	case "campaign_members":
		if salesforceSyncTasks(integration) {
			return "tasks"
		}
	}
	return ""
}

func salesforceNativeCampaignMembershipScans(integration Integration, state salesforceCursorState, complete bool) []CRMNativeListMembershipScan {
	mapping := crmProviderListMembershipMap(
		integration.Settings,
		"campaign_membership_map",
		"salesforce_campaign_membership_map",
		"list_membership_map",
		"salesforce_list_membership_map",
	)
	if len(mapping) == 0 {
		return nil
	}
	start := strings.TrimSpace(state.NextRecordsURL) == ""
	out := make([]CRMNativeListMembershipScan, 0, len(mapping))
	for providerListID, nativeListID := range mapping {
		providerListID = strings.TrimSpace(providerListID)
		nativeListID = strings.TrimSpace(nativeListID)
		if providerListID == "" || nativeListID == "" {
			continue
		}
		out = append(out, CRMNativeListMembershipScan{
			Provider:            ProviderSalesforce,
			ProviderSegmentType: "salesforce_campaign",
			ProviderListID:      providerListID,
			NativeListID:        nativeListID,
			Start:               start,
			Complete:            complete,
		})
	}
	return out
}

func salesforceListIDs(integration Integration) []string {
	return uniqueCRMStrings(append(
		salesforceStringListSetting(integration.Settings, "list_ids"),
		firstString(settingString(integration.Settings, "campaign_id"), settingString(integration.Settings, "default_campaign_id")),
	))
}

func salesforceDefaultTags(integration Integration, kind string) []string {
	tags := append([]string{"salesforce", "salesforce-" + kind}, salesforceStringListSetting(integration.Settings, "default_tags")...)
	return uniqueCRMStrings(tags)
}

func salesforceStringListSetting(settings map[string]any, key string) []string {
	return hubSpotStringListSetting(settings, key)
}

func salesforceString(record map[string]any, key string) string {
	if record == nil {
		return ""
	}
	v, ok := record[key]
	if !ok || v == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(v))
}

func salesforceNestedString(record map[string]any, parent, key string) string {
	v, ok := record[parent]
	if !ok || v == nil {
		return ""
	}
	if typed, ok := v.(map[string]any); ok {
		return salesforceString(typed, key)
	}
	return ""
}

func salesforceBool(record map[string]any, key string) bool {
	v, ok := record[key]
	if !ok || v == nil {
		return false
	}
	switch typed := v.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	default:
		return false
	}
}

func salesforceCampaignMemberRemovalStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "removed", "deleted":
		return true
	default:
		return false
	}
}
