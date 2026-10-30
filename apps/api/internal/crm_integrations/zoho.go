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
	zohoSyncModelRecordsREST = "zoho_crm_v8_contacts_leads_rest"
	zohoCursorPrefix         = "zoho:"
	zohoCursorComplete       = "zoho:complete"
	zohoDefaultAPIVersion    = "v8"
	zohoDefaultPerPage       = 200
	zohoMaxPerPage           = 200
	zohoResponseMaxBytes     = 8 << 20
	zohoDefaultUserAgent     = "Moosewave Zoho CRM Integration"
)

type ZohoCredentials struct {
	AccessToken    string
	RefreshToken   string
	ClientID       string
	ClientSecret   string
	APIBaseURL     string
	AccountsURL    string
	DataCenter     string
	UserAgent      string
	Scope          string
	TokenExpiresAt *time.Time
}

type ZohoCredentialResolver interface {
	ResolveZoho(context.Context, string, Integration) (ZohoCredentials, error)
}

type ZohoBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type ZohoRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials ZohoCredentialResolver
	APIBaseURL  string
	APIVersion  string
	UserAgent   string
	PerPage     int
}

type ZohoRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type ZohoSecretsCredentialResolver struct {
	Secrets     ZohoRuntimeSecretResolver
	Store       ZohoCredentialStore
	OAuthClient ZohoOAuthClient
	RefreshSkew time.Duration
	Now         func() time.Time
}

func NewZohoSecretsCredentialResolver(secrets ZohoRuntimeSecretResolver) *ZohoSecretsCredentialResolver {
	return &ZohoSecretsCredentialResolver{Secrets: secrets}
}

func (r *ZohoSecretsCredentialResolver) ResolveZoho(ctx context.Context, tenantID string, integration Integration) (ZohoCredentials, error) {
	if r == nil || (r.Secrets == nil && r.Store == nil) {
		return ZohoCredentials{}, fmt.Errorf("zoho credential resolver is not configured")
	}
	ref := zohoCredentialRef(integration)
	if ref == "" {
		return ZohoCredentials{}, fmt.Errorf("zoho credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, tenantID, ref)
	if err != nil {
		return ZohoCredentials{}, err
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = settingString(integration.Settings, "api_base_url")
	}
	if creds.DataCenter == "" {
		creds.DataCenter = settingString(integration.Settings, "data_center")
	}
	if creds.AccountsURL == "" {
		creds.AccountsURL = settingString(integration.Settings, "accounts_url")
	}
	if creds.UserAgent == "" {
		creds.UserAgent = settingString(integration.Settings, "user_agent")
	}
	return r.refreshCredentialIfNeeded(ctx, tenantID, ref, creds)
}

func (r *ZohoSecretsCredentialResolver) refreshCredentialIfNeeded(ctx context.Context, tenantID, ref string, creds ZohoCredentials) (ZohoCredentials, error) {
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
		return ZohoCredentials{}, fmt.Errorf("refresh zoho OAuth token: %w", err)
	}
	creds.AccessToken = token.AccessToken
	if strings.TrimSpace(token.RefreshToken) != "" {
		creds.RefreshToken = token.RefreshToken
	}
	if strings.TrimSpace(token.APIBaseURL) != "" {
		creds.APIBaseURL = token.APIBaseURL
	}
	if strings.TrimSpace(token.Scope) != "" {
		creds.Scope = token.Scope
	}
	expiresAt := token.ExpiresAt.UTC()
	creds.TokenExpiresAt = &expiresAt
	if r.Store != nil && zohoIsStoredCredentialRef(ref) {
		if err := r.Store.PutZohoCredentialSecret(ctx, tenantID, ref, creds); err != nil {
			return ZohoCredentials{}, fmt.Errorf("persist refreshed zoho OAuth token: %w", err)
		}
	}
	return creds, nil
}

func (r *ZohoSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, tenantID, ref string) (ZohoCredentials, error) {
	if r.Store != nil && zohoIsStoredCredentialRef(ref) {
		raw, err := r.Store.GetZohoCredentialSecret(ctx, tenantID, ref)
		if err == nil {
			return parseZohoCredentialSecret(raw)
		}
		if !errors.Is(err, ErrNotFound) {
			return ZohoCredentials{}, fmt.Errorf("resolve stored zoho credentials %q: %w", ref, err)
		}
	}
	if r.Secrets == nil {
		return ZohoCredentials{}, fmt.Errorf("zoho credential secret resolver is not configured")
	}
	var payload zohoCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return ZohoCredentials{}, fmt.Errorf("resolve zoho credentials %q: %w", ref, err)
		}
		return parseZohoCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return ZohoCredentials{}, fmt.Errorf("resolve zoho credentials %q: %w", ref, err)
	}
	return parseZohoCredentialSecret(raw)
}

type zohoCredentialPayload struct {
	AccessToken  string `json:"access_token"`
	Token        string `json:"token"`
	BearerToken  string `json:"bearer_token"`
	OAuthToken   string `json:"zoho_oauthtoken"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ClientID     string `json:"client_id,omitempty"`
	ClientSecret string `json:"client_secret,omitempty"`
	APIBaseURL   string `json:"api_base_url"`
	APIDomain    string `json:"api_domain"`
	BaseURL      string `json:"base_url"`
	AccountsURL  string `json:"accounts_url,omitempty"`
	DataCenter   string `json:"data_center"`
	UserAgent    string `json:"user_agent"`
	Scope        string `json:"scope,omitempty"`
	ExpiresAt    string `json:"expires_at,omitempty"`
}

func (p zohoCredentialPayload) credentials() (ZohoCredentials, error) {
	token := normalizeZohoAccessToken(firstString(p.AccessToken, p.Token, p.BearerToken, p.OAuthToken))
	if token == "" {
		return ZohoCredentials{}, fmt.Errorf("zoho access_token is required")
	}
	creds := ZohoCredentials{
		AccessToken:  token,
		RefreshToken: strings.TrimSpace(p.RefreshToken),
		ClientID:     strings.TrimSpace(p.ClientID),
		ClientSecret: strings.TrimSpace(p.ClientSecret),
		APIBaseURL:   strings.TrimRight(firstString(p.APIBaseURL, p.APIDomain, p.BaseURL), "/"),
		AccountsURL:  strings.TrimRight(strings.TrimSpace(p.AccountsURL), "/"),
		DataCenter:   strings.TrimSpace(p.DataCenter),
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

// zohoStoredCredentialJSON serializes managed OAuth credentials for the
// encrypted crm_credential_secrets envelope.
func zohoStoredCredentialJSON(creds ZohoCredentials) string {
	payload := zohoCredentialPayload{
		AccessToken:  strings.TrimSpace(creds.AccessToken),
		RefreshToken: strings.TrimSpace(creds.RefreshToken),
		ClientID:     strings.TrimSpace(creds.ClientID),
		ClientSecret: strings.TrimSpace(creds.ClientSecret),
		APIBaseURL:   strings.TrimRight(strings.TrimSpace(creds.APIBaseURL), "/"),
		AccountsURL:  strings.TrimRight(strings.TrimSpace(creds.AccountsURL), "/"),
		DataCenter:   strings.TrimSpace(creds.DataCenter),
		UserAgent:    strings.TrimSpace(creds.UserAgent),
		Scope:        strings.TrimSpace(creds.Scope),
	}
	if creds.TokenExpiresAt != nil {
		payload.ExpiresAt = creds.TokenExpiresAt.UTC().Format(time.RFC3339)
	}
	raw, _ := json.Marshal(payload)
	return string(raw)
}

func parseZohoCredentialSecret(raw string) (ZohoCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ZohoCredentials{}, fmt.Errorf("zoho credentials are empty")
	}
	var payload zohoCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return ZohoCredentials{}, fmt.Errorf("parse zoho credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parseZohoKeyValueSecret(raw)
		return payload.credentials()
	}
	return zohoCredentialPayload{AccessToken: raw}.credentials()
}

func parseZohoKeyValueSecret(raw string) zohoCredentialPayload {
	var payload zohoCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token", "token", "bearer_token", "zoho_oauthtoken":
			payload.AccessToken = value
		case "api_base_url", "api_domain", "base_url":
			payload.APIBaseURL = value
		case "data_center", "dc":
			payload.DataCenter = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func (b ZohoRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderZohoCRM {
		return SyncRequest{}, fmt.Errorf("zoho backfill requires a Zoho CRM integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("zoho credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveZoho(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("zoho access token is required")
	}
	state, err := decodeZohoCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "complete" {
		return SyncRequest{RunMode: "backfill", Cursor: zohoCursorComplete}, nil
	}
	if state.Object == "" {
		state.Object = "contacts"
	}
	client := crmEgressClient(b.HTTPClient, ProviderZohoCRM, 20*time.Second)
	records, nextState, err := b.fetchRecordsPage(ctx, client, integration, creds, state)
	if err != nil {
		return SyncRequest{}, err
	}
	contacts := make([]ContactInput, 0, len(records))
	for _, record := range records {
		if contact, ok := mapZohoRecord(state.Object, record, integration); ok {
			contacts = append(contacts, contact)
		}
	}
	nextCursor := zohoCursorComplete
	if nextState.Object != "" && nextState.Object != "complete" {
		nextCursor = encodeZohoCursor(nextState)
	}
	return normalizeSyncRequest(SyncRequest{
		RunMode:  "backfill",
		Contacts: contacts,
		Cursor:   nextCursor,
	}), nil
}

func (b ZohoRESTBackfiller) fetchRecordsPage(ctx context.Context, client *http.Client, integration Integration, creds ZohoCredentials, state zohoCursorState) ([]map[string]any, zohoCursorState, error) {
	baseURL, err := zohoAPIBaseURL(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url")), firstString(creds.DataCenter, settingString(integration.Settings, "data_center")))
	if err != nil {
		return nil, zohoCursorState{}, err
	}
	module := zohoModuleName(state.Object)
	if module == "" {
		return nil, zohoCursorState{}, fmt.Errorf("unsupported zoho backfill object %q", state.Object)
	}
	query := url.Values{}
	query.Set("per_page", strconv.Itoa(zohoPerPage(firstString(settingString(integration.Settings, "per_page"), settingString(integration.Settings, "page_size"), strconv.Itoa(b.PerPage)))))
	if state.PageToken != "" {
		query.Set("page_token", state.PageToken)
	} else {
		query.Set("page", strconv.Itoa(maxZohoPage(state.Page)))
	}
	if fields := strings.Join(zohoFields(integration, state.Object), ","); fields != "" {
		query.Set("fields", fields)
	}
	if cvid := firstString(settingString(integration.Settings, "cvid"), settingString(integration.Settings, "list_view_id")); cvid != "" && state.PageToken == "" {
		query.Set("cvid", cvid)
	}
	if state.Object == "leads" {
		if converted := strings.TrimSpace(settingString(integration.Settings, "converted")); converted != "" {
			query.Set("converted", converted)
		}
	}
	var out zohoRecordsResponse
	apiVersion := zohoAPIVersion(firstString(b.APIVersion, settingString(integration.Settings, "api_version")))
	if err := zohoDoJSON(ctx, client, baseURL, creds, b.UserAgent, http.MethodGet, "/crm/"+apiVersion+"/"+module, query, &out); err != nil {
		return nil, zohoCursorState{}, err
	}
	next := zohoNextCursor(state, out.Info, integration)
	return out.Data, next, nil
}

type zohoCursorState struct {
	Object    string `json:"object"`
	Page      int    `json:"page,omitempty"`
	PageToken string `json:"page_token,omitempty"`
}

func decodeZohoCursor(cursor string) (zohoCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return zohoCursorState{Object: "contacts", Page: 1}, nil
	}
	if cursor == zohoCursorComplete {
		return zohoCursorState{Object: "complete"}, nil
	}
	if cursor == "contacts" || cursor == "leads" {
		return zohoCursorState{Object: cursor, Page: 1}, nil
	}
	if !strings.HasPrefix(cursor, zohoCursorPrefix) {
		return zohoCursorState{Object: "contacts", Page: 1, PageToken: cursor}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, zohoCursorPrefix))
	if err != nil {
		return zohoCursorState{}, fmt.Errorf("decode Zoho cursor: %w", err)
	}
	var state zohoCursorState
	if err := json.Unmarshal(raw, &state); err != nil {
		return zohoCursorState{}, fmt.Errorf("parse Zoho cursor: %w", err)
	}
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	state.PageToken = strings.TrimSpace(state.PageToken)
	if state.Object == "" {
		state.Object = "contacts"
	}
	if state.Object != "contacts" && state.Object != "leads" && state.Object != "complete" {
		return zohoCursorState{}, fmt.Errorf("unsupported zoho cursor object %q", state.Object)
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	return state, nil
}

func encodeZohoCursor(state zohoCursorState) string {
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	if state.Object == "" {
		state.Object = "contacts"
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	state.PageToken = strings.TrimSpace(state.PageToken)
	raw, _ := json.Marshal(state)
	return zohoCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type zohoRecordsResponse struct {
	Data []map[string]any `json:"data"`
	Info zohoInfo         `json:"info"`
}

type zohoInfo struct {
	PerPage           int    `json:"per_page"`
	Count             int    `json:"count"`
	Page              int    `json:"page"`
	MoreRecords       bool   `json:"more_records"`
	NextPageToken     string `json:"next_page_token"`
	PreviousPageToken string `json:"previous_page_token"`
}

type ZohoRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e ZohoRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("zoho REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("zoho REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func zohoDoJSON(ctx context.Context, client *http.Client, baseURL string, creds ZohoCredentials, userAgent, method, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse zoho API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Zoho-oauthtoken "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, zohoDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, zohoResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return ZohoRESTError{
			Path:       path,
			StatusCode: resp.StatusCode,
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    truncateHubSpotString(string(body), 500),
		}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode zoho response %s: %w", path, err)
	}
	return nil
}

func mapZohoRecord(object string, record map[string]any, integration Integration) (ContactInput, bool) {
	email := strings.ToLower(strings.TrimSpace(firstString(
		zohoString(record, "Email"),
		zohoString(record, "Secondary_Email"),
	)))
	if email == "" {
		return ContactInput{}, false
	}
	kind := "contact"
	if object == "leads" {
		kind = "lead"
	}
	id := firstString(zohoString(record, "id"), email)
	updated := firstParsedHubSpotTime(zohoString(record, "Modified_Time"), zohoString(record, "Created_Time"))
	company := firstString(
		zohoNestedString(record["Account_Name"], "name"),
		zohoString(record, "Account_Name"),
		zohoString(record, "Company"),
	)
	phone := firstString(zohoString(record, "Phone"), zohoString(record, "Mobile"), zohoString(record, "Home_Phone"), zohoString(record, "Other_Phone"))
	props := map[string]any{
		"zoho_module": object,
		"zoho_id":     id,
		"zoho_raw":    record,
	}
	if owner := zohoNestedString(record["Owner"], "name"); owner != "" {
		props["zoho_owner_name"] = owner
	}
	if accountID := zohoNestedString(record["Account_Name"], "id"); accountID != "" {
		props["zoho_account_id"] = accountID
	}
	out := ContactInput{
		SourceID:       "zoho://" + kind + "/" + id,
		Email:          email,
		FirstName:      zohoString(record, "First_Name"),
		LastName:       zohoString(record, "Last_Name"),
		FullName:       firstString(zohoString(record, "Full_Name"), zohoString(record, "Name")),
		Phone:          phone,
		Company:        company,
		LifecycleStage: firstString(zohoString(record, "Lead_Status"), zohoString(record, "Contact_Status"), zohoString(record, "Lead_Source")),
		ListIDs:        zohoListIDs(integration),
		Tags:           zohoDefaultTags(integration, kind),
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

func zohoNextCursor(current zohoCursorState, info zohoInfo, integration Integration) zohoCursorState {
	current.Object = strings.ToLower(strings.TrimSpace(current.Object))
	if current.Object == "" {
		current.Object = "contacts"
	}
	if info.MoreRecords {
		if token := strings.TrimSpace(info.NextPageToken); token != "" {
			return zohoCursorState{Object: current.Object, Page: 1, PageToken: token}
		}
		return zohoCursorState{Object: current.Object, Page: maxZohoPage(current.Page) + 1}
	}
	if current.Object == "contacts" && zohoSyncLeads(integration) {
		return zohoCursorState{Object: "leads", Page: 1}
	}
	return zohoCursorState{Object: "complete"}
}

func zohoCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func normalizeZohoAccessToken(token string) string {
	token = strings.TrimSpace(token)
	for _, prefix := range []string{"Zoho-oauthtoken ", "zoho-oauthtoken ", "Bearer ", "bearer "} {
		token = strings.TrimPrefix(token, prefix)
	}
	return strings.TrimSpace(token)
}

func zohoAPIBaseURL(baseOverride, dataCenter string) (string, error) {
	raw := strings.TrimRight(strings.TrimSpace(baseOverride), "/")
	if raw == "" {
		raw = zohoAPIBaseURLForDC(dataCenter)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("parse zoho API base URL: %w", err)
	}
	if u.Scheme == "" {
		u.Scheme = "https"
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", fmt.Errorf("zoho API base URL must be http or https")
	}
	if u.Host == "" {
		return "", fmt.Errorf("zoho API base URL host is required")
	}
	u.RawQuery = ""
	u.Fragment = ""
	u.Path = strings.TrimRight(u.Path, "/")
	return strings.TrimRight(u.String(), "/"), nil
}

func zohoAPIBaseURLForDC(dataCenter string) string {
	switch strings.ToLower(strings.TrimSpace(dataCenter)) {
	case "eu":
		return "https://www.zohoapis.eu"
	case "in":
		return "https://www.zohoapis.in"
	case "au", "com.au":
		return "https://www.zohoapis.com.au"
	case "jp":
		return "https://www.zohoapis.jp"
	case "cn", "com.cn":
		return "https://www.zohoapis.com.cn"
	case "ca":
		return "https://www.zohoapis.ca"
	default:
		return "https://www.zohoapis.com"
	}
}

func zohoAPIVersion(raw string) string {
	raw = strings.Trim(strings.ToLower(strings.TrimSpace(raw)), "/")
	if raw == "" {
		return zohoDefaultAPIVersion
	}
	if !strings.HasPrefix(raw, "v") {
		raw = "v" + raw
	}
	return raw
}

func zohoModuleName(object string) string {
	switch strings.ToLower(strings.TrimSpace(object)) {
	case "contacts":
		return "Contacts"
	case "leads":
		return "Leads"
	default:
		return ""
	}
}

func zohoPerPage(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return zohoDefaultPerPage
	}
	if n > zohoMaxPerPage {
		return zohoMaxPerPage
	}
	return n
}

func maxZohoPage(page int) int {
	if page <= 0 {
		return 1
	}
	return page
}

func zohoFields(integration Integration, object string) []string {
	configured := hubSpotStringListSetting(integration.Settings, strings.TrimSpace(object)+"_fields")
	if len(configured) == 0 {
		configured = hubSpotStringListSetting(integration.Settings, "fields")
	}
	return uniqueCRMStrings(configured)
}

func zohoSyncLeads(integration Integration) bool {
	value := strings.ToLower(strings.TrimSpace(settingString(integration.Settings, "sync_leads")))
	return value != "false" && value != "0" && value != "no"
}

func zohoListIDs(integration Integration) []string {
	return uniqueCRMStrings(append(
		hubSpotStringListSetting(integration.Settings, "list_ids"),
		settingString(integration.Settings, "list_id"),
		settingString(integration.Settings, "default_list_id"),
		settingString(integration.Settings, "cvid"),
		settingString(integration.Settings, "list_view_id"),
	))
}

func zohoDefaultTags(integration Integration, kind string) []string {
	tags := append([]string{"zoho-crm", "zoho-" + kind}, hubSpotStringListSetting(integration.Settings, "default_tags")...)
	return uniqueCRMStrings(tags)
}

func zohoString(record map[string]any, key string) string {
	if record == nil {
		return ""
	}
	return zohoAnyString(record[key])
}

func zohoNestedString(value any, key string) string {
	if typed, ok := value.(map[string]any); ok {
		return zohoString(typed, key)
	}
	return ""
}

func zohoAnyString(value any) string {
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
