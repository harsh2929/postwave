// SPDX-License-Identifier: AGPL-3.0-only
//
// salesforce_service_cloud.go — native Salesforce Service Cloud provider runtime.
//
// Salesforce Service Cloud Cases and CaseComments via SOQL. Token-supplied Bearer
// auth + instance_url, GET /services/data/v59.0/query?q=... selecting
// Contact.Email inline (relationship query — no separate sideload). Paginates
// via nextRecordsUrl. Maps to canonical TicketInput/MessageInput via the
// support providerPull.
// (Consumes a supplied access token; managed Salesforce OAuth refresh already
// exists in crm_integrations and is the shared-credential follow-on.)
package support_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	salesforceServiceDefaultAPIVersion = "v59.0"
	salesforceServiceDefaultUserAgent  = "Moosewave Salesforce Service Cloud Integration"
	salesforceServiceDefaultTokenTTL   = 2 * time.Hour
	salesforceServiceResponseMaxBytes  = 16 << 20
	salesforceServiceCursorPrefix      = "salesforce-service-cloud:"
	salesforceServiceCursorComplete    = "salesforce-service-cloud:complete"
	salesforceServiceOAuthTokenPath    = "/services/oauth2/token"
	salesforceServiceDefaultLoginURL   = "https://login.salesforce.com"
	salesforceServiceStoredCredPrefix  = "crm:salesforce:"
)

type SalesforceServiceCloudCredentials struct {
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

type SalesforceServiceCloudCredentialResolver interface {
	ResolveSalesforceServiceCloud(ctx context.Context, tenantID string, integration Integration) (SalesforceServiceCloudCredentials, error)
}

type SalesforceServiceCloudCredentialAuthFailureRefresher interface {
	RefreshSalesforceServiceCloudAfterAuthFailure(ctx context.Context, tenantID string, integration Integration, creds SalesforceServiceCloudCredentials) (SalesforceServiceCloudCredentials, error)
}

type SalesforceServiceCloudCredentialStore interface {
	GetSalesforceServiceCloudCredentialSecret(ctx context.Context, tenantID, ref string) (string, error)
	PutSalesforceServiceCloudCredentialSecret(ctx context.Context, tenantID, ref string, creds SalesforceServiceCloudCredentials) error
}

type salesforceServiceCredentialPayload struct {
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

func (p salesforceServiceCredentialPayload) credentials() (SalesforceServiceCloudCredentials, error) {
	token := strings.TrimSpace(firstString(p.AccessToken, p.Token, p.BearerToken))
	if token == "" {
		return SalesforceServiceCloudCredentials{}, fmt.Errorf("salesforce service cloud access_token is required")
	}
	creds := SalesforceServiceCloudCredentials{
		AccessToken:  token,
		RefreshToken: strings.TrimSpace(p.RefreshToken),
		ClientID:     strings.TrimSpace(p.ClientID),
		ClientSecret: strings.TrimSpace(p.ClientSecret),
		InstanceURL:  strings.TrimRight(strings.TrimSpace(firstString(p.InstanceURL, p.APIBaseURL)), "/"),
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

type SalesforceServiceCloudSecretsCredentialResolver struct {
	Secrets     SupportRuntimeSecretResolver
	Store       SalesforceServiceCloudCredentialStore
	OAuthClient SalesforceServiceCloudOAuthClient
	RefreshSkew time.Duration
	Now         func() time.Time
}

func (r SalesforceServiceCloudSecretsCredentialResolver) ResolveSalesforceServiceCloud(ctx context.Context, tenantID string, integration Integration) (SalesforceServiceCloudCredentials, error) {
	if r.Secrets == nil && r.Store == nil {
		return SalesforceServiceCloudCredentials{}, fmt.Errorf("salesforce service cloud credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return SalesforceServiceCloudCredentials{}, fmt.Errorf("salesforce service cloud credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, tenantID, ref)
	if err != nil {
		return SalesforceServiceCloudCredentials{}, err
	}
	creds = withSalesforceServiceDefaults(creds, integration)
	return r.refreshCredentialIfNeeded(ctx, tenantID, ref, creds)
}

func (r SalesforceServiceCloudSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, tenantID, ref string) (SalesforceServiceCloudCredentials, error) {
	if r.Store != nil && salesforceServiceIsStoredCredentialRef(ref) {
		raw, err := r.Store.GetSalesforceServiceCloudCredentialSecret(ctx, tenantID, ref)
		if err == nil {
			return parseSalesforceServiceCredentialSecret(raw)
		}
		if !errors.Is(err, ErrNotFound) {
			return SalesforceServiceCloudCredentials{}, fmt.Errorf("resolve stored salesforce service cloud credentials %q: %w", ref, err)
		}
	}
	if r.Secrets == nil {
		return SalesforceServiceCloudCredentials{}, fmt.Errorf("salesforce service cloud credential secret resolver is not configured")
	}
	var payload salesforceServiceCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return SalesforceServiceCloudCredentials{}, fmt.Errorf("resolve salesforce service cloud credentials %q: %w", ref, err)
	}
	return parseSalesforceServiceCredentialSecret(raw)
}

func (r SalesforceServiceCloudSecretsCredentialResolver) refreshCredentialIfNeeded(ctx context.Context, tenantID, ref string, creds SalesforceServiceCloudCredentials) (SalesforceServiceCloudCredentials, error) {
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
	token, err := r.oauthClient().RefreshAccessToken(ctx, creds)
	if err != nil {
		return SalesforceServiceCloudCredentials{}, fmt.Errorf("refresh salesforce service cloud OAuth token: %w", err)
	}
	creds = applySalesforceServiceOAuthToken(creds, token)
	if r.Store != nil && salesforceServiceIsStoredCredentialRef(ref) {
		if err := r.Store.PutSalesforceServiceCloudCredentialSecret(ctx, tenantID, ref, creds); err != nil {
			return SalesforceServiceCloudCredentials{}, fmt.Errorf("persist refreshed salesforce service cloud OAuth token: %w", err)
		}
	}
	return creds, nil
}

func (r SalesforceServiceCloudSecretsCredentialResolver) RefreshSalesforceServiceCloudAfterAuthFailure(ctx context.Context, tenantID string, integration Integration, creds SalesforceServiceCloudCredentials) (SalesforceServiceCloudCredentials, error) {
	if strings.TrimSpace(creds.RefreshToken) == "" || strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return SalesforceServiceCloudCredentials{}, fmt.Errorf("salesforce service cloud refresh_token, client_id, and client_secret are required for reactive OAuth refresh")
	}
	token, err := r.oauthClient().RefreshAccessToken(ctx, creds)
	if err != nil {
		return SalesforceServiceCloudCredentials{}, fmt.Errorf("refresh salesforce service cloud OAuth token after auth failure: %w", err)
	}
	creds = applySalesforceServiceOAuthToken(creds, token)
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if r.Store != nil && salesforceServiceIsStoredCredentialRef(ref) {
		if err := r.Store.PutSalesforceServiceCloudCredentialSecret(ctx, tenantID, ref, creds); err != nil {
			return SalesforceServiceCloudCredentials{}, fmt.Errorf("persist reactively refreshed salesforce service cloud OAuth token: %w", err)
		}
	}
	return creds, nil
}

func (r SalesforceServiceCloudSecretsCredentialResolver) oauthClient() SalesforceServiceCloudOAuthClient {
	client := r.OAuthClient
	if client.Now == nil && r.Now != nil {
		client.Now = r.Now
	}
	return client
}

func withSalesforceServiceDefaults(creds SalesforceServiceCloudCredentials, integration Integration) SalesforceServiceCloudCredentials {
	if creds.InstanceURL == "" {
		creds.InstanceURL = strings.TrimRight(strings.TrimSpace(firstString(settingString(integration.Settings, "instance_url"), settingString(integration.Settings, "api_base_url"))), "/")
	}
	if creds.LoginURL == "" {
		creds.LoginURL = strings.TrimRight(strings.TrimSpace(settingString(integration.Settings, "login_url")), "/")
	}
	if creds.APIVersion == "" {
		creds.APIVersion = strings.TrimSpace(settingString(integration.Settings, "api_version"))
	}
	if creds.UserAgent == "" {
		creds.UserAgent = strings.TrimSpace(settingString(integration.Settings, "user_agent"))
	}
	return creds
}

func parseSalesforceServiceCredentialSecret(raw string) (SalesforceServiceCloudCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return SalesforceServiceCloudCredentials{}, fmt.Errorf("salesforce service cloud credentials are empty")
	}
	var payload salesforceServiceCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return SalesforceServiceCloudCredentials{}, fmt.Errorf("parse salesforce service cloud credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parseSalesforceServiceKeyValueSecret(raw)
		return payload.credentials()
	}
	return salesforceServiceCredentialPayload{AccessToken: raw}.credentials()
}

func parseSalesforceServiceKeyValueSecret(raw string) salesforceServiceCredentialPayload {
	var payload salesforceServiceCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(parts[0]))
		value := strings.TrimSpace(parts[1])
		switch key {
		case "access_token":
			payload.AccessToken = value
		case "token":
			payload.Token = value
		case "bearer_token":
			payload.BearerToken = value
		case "refresh_token":
			payload.RefreshToken = value
		case "client_id":
			payload.ClientID = value
		case "client_secret":
			payload.ClientSecret = value
		case "instance_url":
			payload.InstanceURL = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "login_url":
			payload.LoginURL = value
		case "identity_url":
			payload.IdentityURL = value
		case "api_version":
			payload.APIVersion = value
		case "user_agent":
			payload.UserAgent = value
		case "scope":
			payload.Scope = value
		case "expires_at":
			payload.ExpiresAt = value
		}
	}
	return payload
}

func salesforceServiceStoredCredentialJSON(creds SalesforceServiceCloudCredentials) string {
	payload := salesforceServiceCredentialPayload{
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

func salesforceServiceIsStoredCredentialRef(ref string) bool {
	return strings.HasPrefix(strings.TrimSpace(ref), salesforceServiceStoredCredPrefix)
}

type SalesforceServiceCloudOAuthToken struct {
	AccessToken  string
	RefreshToken string
	InstanceURL  string
	IdentityURL  string
	TokenType    string
	Scope        string
	ExpiresAt    time.Time
}

type SalesforceServiceCloudOAuthClient struct {
	HTTPClient *http.Client
	LoginURL   string
	UserAgent  string
	Now        func() time.Time
	TokenTTL   time.Duration
}

func (c SalesforceServiceCloudOAuthClient) RefreshAccessToken(ctx context.Context, creds SalesforceServiceCloudCredentials) (SalesforceServiceCloudOAuthToken, error) {
	if strings.TrimSpace(creds.RefreshToken) == "" {
		return SalesforceServiceCloudOAuthToken{}, fmt.Errorf("salesforce service cloud OAuth refresh_token is required")
	}
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" {
		return SalesforceServiceCloudOAuthToken{}, fmt.Errorf("salesforce service cloud OAuth client_id and client_secret are required")
	}
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", strings.TrimSpace(creds.RefreshToken))
	form.Set("client_id", strings.TrimSpace(creds.ClientID))
	form.Set("client_secret", strings.TrimSpace(creds.ClientSecret))
	baseURL := strings.TrimRight(firstString(c.LoginURL, creds.LoginURL, salesforceServiceDefaultLoginURL), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+salesforceServiceOAuthTokenPath, strings.NewReader(form.Encode()))
	if err != nil {
		return SalesforceServiceCloudOAuthToken{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(c.UserAgent, creds.UserAgent, salesforceServiceDefaultUserAgent))
	client := supportEgressClient(c.HTTPClient, ProviderSalesforceServiceCloud, 20*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return SalesforceServiceCloudOAuthToken{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, salesforceServiceResponseMaxBytes))
	if err != nil {
		return SalesforceServiceCloudOAuthToken{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return SalesforceServiceCloudOAuthToken{}, fmt.Errorf("salesforce service cloud OAuth token request failed %d: %s", resp.StatusCode, zendeskTruncate(string(body), 500))
	}
	var raw struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		InstanceURL  string `json:"instance_url"`
		ID           string `json:"id"`
		TokenType    string `json:"token_type"`
		Scope        string `json:"scope"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return SalesforceServiceCloudOAuthToken{}, fmt.Errorf("decode salesforce service cloud OAuth token response: %w", err)
	}
	if strings.TrimSpace(raw.AccessToken) == "" {
		return SalesforceServiceCloudOAuthToken{}, fmt.Errorf("salesforce service cloud OAuth token response missing access_token")
	}
	ttl := c.TokenTTL
	if ttl <= 0 {
		ttl = salesforceServiceDefaultTokenTTL
	}
	return SalesforceServiceCloudOAuthToken{
		AccessToken:  strings.TrimSpace(raw.AccessToken),
		RefreshToken: strings.TrimSpace(raw.RefreshToken),
		InstanceURL:  strings.TrimRight(strings.TrimSpace(raw.InstanceURL), "/"),
		IdentityURL:  strings.TrimSpace(raw.ID),
		TokenType:    firstString(raw.TokenType, "Bearer"),
		Scope:        strings.TrimSpace(raw.Scope),
		ExpiresAt:    c.now().Add(ttl),
	}, nil
}

func (c SalesforceServiceCloudOAuthClient) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

func applySalesforceServiceOAuthToken(creds SalesforceServiceCloudCredentials, token SalesforceServiceCloudOAuthToken) SalesforceServiceCloudCredentials {
	creds.AccessToken = strings.TrimSpace(token.AccessToken)
	if strings.TrimSpace(token.RefreshToken) != "" {
		creds.RefreshToken = strings.TrimSpace(token.RefreshToken)
	}
	if strings.TrimSpace(token.InstanceURL) != "" {
		creds.InstanceURL = strings.TrimRight(strings.TrimSpace(token.InstanceURL), "/")
	}
	if strings.TrimSpace(token.IdentityURL) != "" {
		creds.IdentityURL = strings.TrimSpace(token.IdentityURL)
	}
	if strings.TrimSpace(token.Scope) != "" {
		creds.Scope = strings.TrimSpace(token.Scope)
	}
	expiresAt := token.ExpiresAt.UTC()
	creds.TokenExpiresAt = &expiresAt
	return creds
}

type SalesforceServiceCloudBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type SalesforceServiceCloudCaseRefresher interface {
	RefreshCase(ctx context.Context, tenantID string, integration Integration, caseID string) (SyncRequest, error)
}

type SalesforceServiceCloudRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials SalesforceServiceCloudCredentialResolver
	APIVersion  string
	UserAgent   string
}

type salesforceCase struct {
	ID           string `json:"Id"`
	CaseNumber   string `json:"CaseNumber"`
	Subject      string `json:"Subject"`
	Status       string `json:"Status"`
	Priority     string `json:"Priority"`
	OwnerID      string `json:"OwnerId"`
	RecordTypeID string `json:"RecordTypeId"`
	Modified     string `json:"LastModifiedDate"`
	Owner        struct {
		Name string `json:"Name"`
	} `json:"Owner"`
	Contact struct {
		Email string `json:"Email"`
		Name  string `json:"Name"`
	} `json:"Contact"`
}

type salesforceCaseComment struct {
	ID          string `json:"Id"`
	ParentID    string `json:"ParentId"`
	CommentBody string `json:"CommentBody"`
	IsPublished bool   `json:"IsPublished"`
	CreatedDate string `json:"CreatedDate"`
	CreatedBy   struct {
		Email string `json:"Email"`
		Name  string `json:"Name"`
	} `json:"CreatedBy"`
}

type salesforceQueryResponse struct {
	Records        []salesforceCase `json:"records"`
	Done           bool             `json:"done"`
	NextRecordsURL string           `json:"nextRecordsUrl"`
}

type salesforceCaseCommentQueryResponse struct {
	Records []salesforceCaseComment `json:"records"`
}

type salesforceCaseMessageContext struct {
	ID             string
	SourceID       string
	ConversationID string
	Email          string
	RequesterName  string
	Subject        string
}

func (b SalesforceServiceCloudRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderSalesforceServiceCloud {
		return SyncRequest{}, fmt.Errorf("salesforce service cloud backfill requires a Salesforce Service Cloud integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("salesforce service cloud credential resolver is not configured")
	}
	cursor = strings.TrimSpace(cursor)
	if cursor == salesforceServiceCursorComplete {
		return SyncRequest{RunMode: "backfill", Cursor: salesforceServiceCursorComplete}, nil
	}
	creds, err := b.salesforceServiceCredentials(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderSalesforceServiceCloud, 30*time.Second)
	version := firstString(b.APIVersion, creds.APIVersion, salesforceServiceDefaultAPIVersion)
	var requestURL string
	if strings.HasPrefix(cursor, salesforceServiceCursorPrefix) {
		// nextRecordsUrl is a relative path off the instance.
		requestURL = strings.TrimRight(creds.InstanceURL, "/") + strings.TrimPrefix(cursor, salesforceServiceCursorPrefix)
	} else {
		soql := salesforceServiceCaseSOQL(integration)
		q := url.Values{}
		q.Set("q", soql)
		requestURL = strings.TrimRight(creds.InstanceURL, "/") + "/services/data/" + version + "/query?" + q.Encode()
	}

	var out salesforceQueryResponse
	if err := salesforceServiceDoJSON(ctx, client, requestURL, creds, b.UserAgent, &out); err != nil {
		if salesforceServiceShouldRefreshAfterAuthFailure(err) {
			if refresher, ok := b.Credentials.(SalesforceServiceCloudCredentialAuthFailureRefresher); ok {
				refreshed, refreshErr := refresher.RefreshSalesforceServiceCloudAfterAuthFailure(ctx, tenantID, integration, creds)
				if refreshErr != nil {
					return SyncRequest{}, refreshErr
				}
				creds = withSalesforceServiceDefaults(refreshed, integration)
				if creds.InstanceURL == "" {
					return SyncRequest{}, fmt.Errorf("salesforce service cloud instance_url is required")
				}
				if strings.HasPrefix(cursor, salesforceServiceCursorPrefix) {
					requestURL = strings.TrimRight(creds.InstanceURL, "/") + strings.TrimPrefix(cursor, salesforceServiceCursorPrefix)
				} else {
					q := url.Values{}
					q.Set("q", salesforceServiceCaseSOQL(integration))
					requestURL = strings.TrimRight(creds.InstanceURL, "/") + "/services/data/" + version + "/query?" + q.Encode()
				}
				err = salesforceServiceDoJSON(ctx, client, requestURL, creds, b.UserAgent, &out)
			}
		}
		if err != nil {
			return SyncRequest{}, err
		}
	}
	tickets := make([]TicketInput, 0, len(out.Records))
	caseIDs := make([]string, 0, len(out.Records))
	caseContexts := make(map[string]salesforceCaseMessageContext, len(out.Records))
	for _, c := range out.Records {
		if mapped, ok := mapSalesforceCase(c); ok {
			tickets = append(tickets, mapped)
			caseID := strings.TrimSpace(c.ID)
			if caseID != "" {
				caseIDs = append(caseIDs, caseID)
				caseContexts[caseID] = salesforceCaseMessageContext{
					ID:             caseID,
					SourceID:       mapped.SourceID,
					ConversationID: mapped.ConversationID,
					Email:          mapped.Email,
					RequesterName:  mapped.RequesterName,
					Subject:        mapped.Subject,
				}
			}
		}
	}
	messages, err := b.fetchCaseComments(ctx, client, creds, version, caseIDs, caseContexts)
	if err != nil {
		if salesforceServiceShouldRefreshAfterAuthFailure(err) {
			if refresher, ok := b.Credentials.(SalesforceServiceCloudCredentialAuthFailureRefresher); ok {
				refreshed, refreshErr := refresher.RefreshSalesforceServiceCloudAfterAuthFailure(ctx, tenantID, integration, creds)
				if refreshErr != nil {
					return SyncRequest{}, refreshErr
				}
				creds = withSalesforceServiceDefaults(refreshed, integration)
				messages, err = b.fetchCaseComments(ctx, client, creds, version, caseIDs, caseContexts)
			}
		}
		if err != nil {
			return SyncRequest{}, err
		}
	}
	nextCursor := salesforceServiceCursorComplete
	if !out.Done && strings.TrimSpace(out.NextRecordsURL) != "" {
		nextCursor = salesforceServiceCursorPrefix + strings.TrimSpace(out.NextRecordsURL)
	}
	return SyncRequest{RunMode: "backfill", Tickets: tickets, Messages: messages, Cursor: nextCursor}, nil
}

func (b SalesforceServiceCloudRESTBackfiller) RefreshCase(ctx context.Context, tenantID string, integration Integration, caseID string) (SyncRequest, error) {
	if integration.Provider != ProviderSalesforceServiceCloud {
		return SyncRequest{}, fmt.Errorf("salesforce service cloud case refresh requires a Salesforce Service Cloud integration")
	}
	caseID = strings.TrimSpace(caseID)
	if caseID == "" {
		return SyncRequest{}, fmt.Errorf("salesforce service cloud case id is required")
	}
	creds, err := b.salesforceServiceCredentials(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := supportEgressClient(b.HTTPClient, ProviderSalesforceServiceCloud, 30*time.Second)
	version := firstString(b.APIVersion, creds.APIVersion, salesforceServiceDefaultAPIVersion)
	req, err := b.refreshCaseWithCredentials(ctx, client, creds, version, integration, caseID)
	if err != nil {
		if salesforceServiceShouldRefreshAfterAuthFailure(err) {
			if refresher, ok := b.Credentials.(SalesforceServiceCloudCredentialAuthFailureRefresher); ok {
				refreshed, refreshErr := refresher.RefreshSalesforceServiceCloudAfterAuthFailure(ctx, tenantID, integration, creds)
				if refreshErr != nil {
					return SyncRequest{}, refreshErr
				}
				creds = withSalesforceServiceDefaults(refreshed, integration)
				req, err = b.refreshCaseWithCredentials(ctx, client, creds, version, integration, caseID)
			}
		}
		if err != nil {
			return SyncRequest{}, err
		}
	}
	req.RunMode = "webhook"
	req.Cursor = "salesforce-service-cloud-cdc-" + caseID
	return normalizeSyncRequest(req), nil
}

func (b SalesforceServiceCloudRESTBackfiller) salesforceServiceCredentials(ctx context.Context, tenantID string, integration Integration) (SalesforceServiceCloudCredentials, error) {
	if b.Credentials == nil {
		return SalesforceServiceCloudCredentials{}, fmt.Errorf("salesforce service cloud credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveSalesforceServiceCloud(ctx, tenantID, integration)
	if err != nil {
		return SalesforceServiceCloudCredentials{}, err
	}
	if creds.InstanceURL == "" {
		return SalesforceServiceCloudCredentials{}, fmt.Errorf("salesforce service cloud instance_url is required")
	}
	return creds, nil
}

func (b SalesforceServiceCloudRESTBackfiller) refreshCaseWithCredentials(ctx context.Context, client *http.Client, creds SalesforceServiceCloudCredentials, version string, integration Integration, caseID string) (SyncRequest, error) {
	q := url.Values{}
	q.Set("q", salesforceServiceCaseByIDSOQL(integration, caseID))
	requestURL := strings.TrimRight(creds.InstanceURL, "/") + "/services/data/" + version + "/query?" + q.Encode()
	var out salesforceQueryResponse
	if err := salesforceServiceDoJSON(ctx, client, requestURL, creds, b.UserAgent, &out); err != nil {
		return SyncRequest{}, err
	}
	if len(out.Records) == 0 {
		return SyncRequest{}, SalesforceServiceCloudRESTError{StatusCode: http.StatusNotFound, ErrorCode: "CASE_NOT_FOUND", Snippet: "salesforce service cloud case not found"}
	}
	tickets := make([]TicketInput, 0, len(out.Records))
	caseIDs := make([]string, 0, len(out.Records))
	caseContexts := make(map[string]salesforceCaseMessageContext, len(out.Records))
	for _, c := range out.Records {
		mapped, ok := mapSalesforceCase(c)
		if !ok {
			continue
		}
		tickets = append(tickets, mapped)
		caseID := strings.TrimSpace(c.ID)
		if caseID != "" {
			caseIDs = append(caseIDs, caseID)
			caseContexts[caseID] = salesforceCaseMessageContext{
				ID:             caseID,
				SourceID:       mapped.SourceID,
				ConversationID: mapped.ConversationID,
				Email:          mapped.Email,
				RequesterName:  mapped.RequesterName,
				Subject:        mapped.Subject,
			}
		}
	}
	messages, err := b.fetchCaseComments(ctx, client, creds, version, caseIDs, caseContexts)
	if err != nil {
		return SyncRequest{}, err
	}
	return SyncRequest{RunMode: "webhook", Tickets: tickets, Messages: messages, Cursor: "salesforce-service-cloud-cdc-" + caseID}, nil
}

func salesforceServiceCaseSOQL(integration Integration) string {
	soql := salesforceServiceCaseSelectSOQL()
	clauses := salesforceServiceCaseFilterClauses(integration)
	if len(clauses) > 0 {
		soql += " WHERE " + strings.Join(clauses, " AND ")
	}
	return soql + " ORDER BY LastModifiedDate DESC"
}

func salesforceServiceCaseByIDSOQL(integration Integration, caseID string) string {
	clauses := append([]string{"Id = " + salesforceSOQLLiteral(caseID)}, salesforceServiceCaseFilterClauses(integration)...)
	return salesforceServiceCaseSelectSOQL() + " WHERE " + strings.Join(clauses, " AND ")
}

func salesforceServiceCaseSelectSOQL() string {
	return "SELECT Id, CaseNumber, Subject, Status, Priority, OwnerId, Owner.Name, RecordTypeId, LastModifiedDate, Contact.Email, Contact.Name FROM Case"
}

func salesforceServiceCaseFilterClauses(integration Integration) []string {
	clauses := []string{}
	if recordTypeID := strings.TrimSpace(settingString(integration.Settings, "case_record_type_id")); recordTypeID != "" {
		clauses = append(clauses, "RecordTypeId = "+salesforceSOQLLiteral(recordTypeID))
	}
	if ownerID := strings.TrimSpace(firstString(
		settingString(integration.Settings, "case_queue_id"),
		settingString(integration.Settings, "queue_id"),
		settingString(integration.Settings, "case_owner_id"),
		settingString(integration.Settings, "owner_id"),
	)); ownerID != "" {
		clauses = append(clauses, "OwnerId = "+salesforceSOQLLiteral(ownerID))
	}
	if len(clauses) > 0 {
		return clauses
	}
	return nil
}

func mapSalesforceCase(c salesforceCase) (TicketInput, bool) {
	email := strings.ToLower(strings.TrimSpace(c.Contact.Email))
	if email == "" {
		return TicketInput{}, false
	}
	id := strings.TrimSpace(c.ID)
	out := TicketInput{
		SourceID:       "salesforce-service-cloud://case/" + id,
		ConversationID: id,
		Email:          email,
		RequesterName:  strings.TrimSpace(c.Contact.Name),
		Subject:        strings.TrimSpace(c.Subject),
		Status:         strings.TrimSpace(c.Status),
		Priority:       strings.TrimSpace(c.Priority),
		Assignee:       strings.TrimSpace(c.Owner.Name),
		Properties: map[string]any{
			"salesforce_case_id":        id,
			"salesforce_case_number":    strings.TrimSpace(c.CaseNumber),
			"salesforce_owner_id":       strings.TrimSpace(c.OwnerID),
			"salesforce_owner_name":     strings.TrimSpace(c.Owner.Name),
			"salesforce_owner_type":     salesforceServiceOwnerType(c.OwnerID),
			"salesforce_record_type_id": strings.TrimSpace(c.RecordTypeID),
		},
	}
	if t := parseZendeskTime(c.Modified); t != nil {
		out.UpdatedAt = t
	}
	return out, true
}

func salesforceServiceOwnerType(ownerID string) string {
	ownerID = strings.TrimSpace(ownerID)
	switch {
	case strings.HasPrefix(ownerID, "00G"):
		return "queue"
	case strings.HasPrefix(ownerID, "005"):
		return "user"
	default:
		return ""
	}
}

func (b SalesforceServiceCloudRESTBackfiller) fetchCaseComments(ctx context.Context, client *http.Client, creds SalesforceServiceCloudCredentials, version string, caseIDs []string, caseContexts map[string]salesforceCaseMessageContext) ([]MessageInput, error) {
	if len(caseIDs) == 0 {
		return nil, nil
	}
	soqlIDs := make([]string, 0, len(caseIDs))
	seen := map[string]bool{}
	for _, id := range caseIDs {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		soqlIDs = append(soqlIDs, salesforceSOQLLiteral(id))
	}
	if len(soqlIDs) == 0 {
		return nil, nil
	}
	soql := "SELECT Id, ParentId, CommentBody, IsPublished, CreatedDate, CreatedBy.Name, CreatedBy.Email FROM CaseComment WHERE ParentId IN (" + strings.Join(soqlIDs, ",") + ") ORDER BY CreatedDate ASC"
	q := url.Values{}
	q.Set("q", soql)
	requestURL := strings.TrimRight(creds.InstanceURL, "/") + "/services/data/" + version + "/query?" + q.Encode()
	var out salesforceCaseCommentQueryResponse
	if err := salesforceServiceDoJSON(ctx, client, requestURL, creds, b.UserAgent, &out); err != nil {
		return nil, err
	}
	messages := make([]MessageInput, 0, len(out.Records))
	for _, comment := range out.Records {
		if mapped, ok := mapSalesforceCaseComment(comment, caseContexts); ok {
			messages = append(messages, mapped)
		}
	}
	return messages, nil
}

func mapSalesforceCaseComment(comment salesforceCaseComment, caseContexts map[string]salesforceCaseMessageContext) (MessageInput, bool) {
	parentID := strings.TrimSpace(comment.ParentID)
	ctx, ok := caseContexts[parentID]
	if !ok || strings.TrimSpace(ctx.Email) == "" {
		return MessageInput{}, false
	}
	commentID := strings.TrimSpace(comment.ID)
	body := strings.TrimSpace(comment.CommentBody)
	if commentID == "" || body == "" {
		return MessageInput{}, false
	}
	authorEmail := strings.ToLower(strings.TrimSpace(comment.CreatedBy.Email))
	direction := "outbound"
	senderType := "agent"
	if authorEmail != "" && strings.EqualFold(authorEmail, ctx.Email) {
		direction = "inbound"
		senderType = "customer"
	}
	out := MessageInput{
		SourceID:       "salesforce-service-cloud://case-comment/" + commentID,
		ConversationID: ctx.ConversationID,
		Email:          ctx.Email,
		RequesterName:  ctx.RequesterName,
		Subject:        ctx.Subject,
		Direction:      direction,
		SenderType:     senderType,
		Sender:         strings.TrimSpace(firstString(comment.CreatedBy.Name, comment.CreatedBy.Email)),
		BodyText:       body,
		Properties: map[string]any{
			"salesforce_case_id":                 parentID,
			"salesforce_case_source_id":          ctx.SourceID,
			"salesforce_case_comment_id":         commentID,
			"salesforce_case_comment_published":  comment.IsPublished,
			"salesforce_case_comment_created_by": strings.TrimSpace(firstString(comment.CreatedBy.Email, comment.CreatedBy.Name)),
		},
	}
	if t := parseZendeskTime(comment.CreatedDate); t != nil {
		out.OccurredAt = t
	}
	return out, true
}

func salesforceSOQLLiteral(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), `\`, `\\`)
	value = strings.ReplaceAll(value, `'`, `\'`)
	return "'" + value + "'"
}

func salesforceServiceDoJSON(ctx context.Context, client *http.Client, fullURL string, creds SalesforceServiceCloudCredentials, userAgent string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, salesforceServiceDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, salesforceServiceResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return SalesforceServiceCloudRESTError{StatusCode: resp.StatusCode, RetryAfter: parseZendeskRetryAfter(resp.Header.Get("Retry-After")), ErrorCode: salesforceServiceRESTErrorCode(body), Snippet: zendeskTruncate(string(body), 500)}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode salesforce service cloud response: %w", err)
	}
	return nil
}

type SalesforceServiceCloudRESTError struct {
	StatusCode int
	RetryAfter time.Duration
	ErrorCode  string
	Snippet    string
}

func (e SalesforceServiceCloudRESTError) Error() string {
	code := ""
	if strings.TrimSpace(e.ErrorCode) != "" {
		code = " " + strings.TrimSpace(e.ErrorCode)
	}
	if e.RetryAfter > 0 {
		return fmt.Sprintf("salesforce service cloud REST failed %d%s; retry after %s: %s", e.StatusCode, code, e.RetryAfter, e.Snippet)
	}
	return fmt.Sprintf("salesforce service cloud REST failed %d%s: %s", e.StatusCode, code, e.Snippet)
}

func salesforceServiceShouldRefreshAfterAuthFailure(err error) bool {
	var restErr SalesforceServiceCloudRESTError
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

func salesforceServiceRESTErrorCode(body []byte) string {
	var list []struct {
		ErrorCode string `json:"errorCode"`
	}
	if err := json.Unmarshal(body, &list); err == nil && len(list) > 0 {
		return strings.TrimSpace(list[0].ErrorCode)
	}
	var single struct {
		ErrorCode string `json:"errorCode"`
	}
	if err := json.Unmarshal(body, &single); err == nil {
		return strings.TrimSpace(single.ErrorCode)
	}
	return ""
}
