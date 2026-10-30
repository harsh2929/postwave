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
	dynamics365SyncModelDataverseREST = "dynamics365_dataverse_contacts_leads_rest"
	dynamics365CursorPrefix           = "dynamics365:"
	dynamics365CursorComplete         = "dynamics365:complete"
	dynamics365DefaultAPIVersion      = "v9.2"
	dynamics365DefaultPageSize        = 5000
	dynamics365MaxPageSize            = 5000
	dynamics365ResponseMaxBytes       = 8 << 20
	dynamics365DefaultUserAgent       = "Moosewave Dynamics 365 Integration"
)

type Dynamics365Credentials struct {
	AccessToken    string
	RefreshToken   string
	ClientID       string
	ClientSecret   string
	TenantID       string
	EnvironmentURL string
	APIVersion     string
	UserAgent      string
	Scope          string
	TokenExpiresAt *time.Time
}

type Dynamics365CredentialResolver interface {
	ResolveDynamics365(context.Context, string, Integration) (Dynamics365Credentials, error)
}

type Dynamics365Backfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type Dynamics365RESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials Dynamics365CredentialResolver
	APIVersion  string
	UserAgent   string
	PageSize    int
}

type Dynamics365RuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type Dynamics365SecretsCredentialResolver struct {
	Secrets     Dynamics365RuntimeSecretResolver
	Store       Dynamics365CredentialStore
	OAuthClient Dynamics365OAuthClient
	RefreshSkew time.Duration
	Now         func() time.Time
}

func NewDynamics365SecretsCredentialResolver(secrets Dynamics365RuntimeSecretResolver) *Dynamics365SecretsCredentialResolver {
	return &Dynamics365SecretsCredentialResolver{Secrets: secrets}
}

func (r *Dynamics365SecretsCredentialResolver) ResolveDynamics365(ctx context.Context, tenantID string, integration Integration) (Dynamics365Credentials, error) {
	if r == nil || (r.Secrets == nil && r.Store == nil) {
		return Dynamics365Credentials{}, fmt.Errorf("dynamics 365 credential resolver is not configured")
	}
	ref := dynamics365CredentialRef(integration)
	if ref == "" {
		return Dynamics365Credentials{}, fmt.Errorf("dynamics 365 credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, tenantID, ref)
	if err != nil {
		return Dynamics365Credentials{}, err
	}
	if creds.EnvironmentURL == "" {
		creds.EnvironmentURL = firstString(settingString(integration.Settings, "environment_url"), settingString(integration.Settings, "api_base_url"))
	}
	if creds.APIVersion == "" {
		creds.APIVersion = settingString(integration.Settings, "api_version")
	}
	if creds.TenantID == "" {
		creds.TenantID = settingString(integration.Settings, "tenant_id")
	}
	if creds.UserAgent == "" {
		creds.UserAgent = settingString(integration.Settings, "user_agent")
	}
	return r.refreshCredentialIfNeeded(ctx, tenantID, ref, creds)
}

func (r *Dynamics365SecretsCredentialResolver) refreshCredentialIfNeeded(ctx context.Context, tenantID, ref string, creds Dynamics365Credentials) (Dynamics365Credentials, error) {
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
		return Dynamics365Credentials{}, fmt.Errorf("refresh dynamics 365 OAuth token: %w", err)
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
	if r.Store != nil && dynamics365IsStoredCredentialRef(ref) {
		if err := r.Store.PutDynamics365CredentialSecret(ctx, tenantID, ref, creds); err != nil {
			return Dynamics365Credentials{}, fmt.Errorf("persist refreshed dynamics 365 OAuth token: %w", err)
		}
	}
	return creds, nil
}

func (r *Dynamics365SecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, tenantID, ref string) (Dynamics365Credentials, error) {
	if r.Store != nil && dynamics365IsStoredCredentialRef(ref) {
		raw, err := r.Store.GetDynamics365CredentialSecret(ctx, tenantID, ref)
		if err == nil {
			return parseDynamics365CredentialSecret(raw)
		}
		if !errors.Is(err, ErrNotFound) {
			return Dynamics365Credentials{}, fmt.Errorf("resolve stored dynamics 365 credentials %q: %w", ref, err)
		}
	}
	if r.Secrets == nil {
		return Dynamics365Credentials{}, fmt.Errorf("dynamics 365 credential secret resolver is not configured")
	}
	var payload dynamics365CredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return Dynamics365Credentials{}, fmt.Errorf("resolve dynamics 365 credentials %q: %w", ref, err)
		}
		return parseDynamics365CredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return Dynamics365Credentials{}, fmt.Errorf("resolve dynamics 365 credentials %q: %w", ref, err)
	}
	return parseDynamics365CredentialSecret(raw)
}

type dynamics365CredentialPayload struct {
	AccessToken    string `json:"access_token"`
	Token          string `json:"token"`
	BearerToken    string `json:"bearer_token"`
	RefreshToken   string `json:"refresh_token,omitempty"`
	ClientID       string `json:"client_id,omitempty"`
	ClientSecret   string `json:"client_secret,omitempty"`
	TenantID       string `json:"tenant_id,omitempty"`
	EnvironmentURL string `json:"environment_url"`
	Resource       string `json:"resource"`
	APIBaseURL     string `json:"api_base_url"`
	BaseURL        string `json:"base_url"`
	APIVersion     string `json:"api_version"`
	UserAgent      string `json:"user_agent"`
	Scope          string `json:"scope,omitempty"`
	ExpiresAt      string `json:"expires_at,omitempty"`
}

func (p dynamics365CredentialPayload) credentials() (Dynamics365Credentials, error) {
	token := normalizeDynamics365BearerToken(firstString(p.AccessToken, p.Token, p.BearerToken))
	if token == "" {
		return Dynamics365Credentials{}, fmt.Errorf("dynamics 365 access_token is required")
	}
	creds := Dynamics365Credentials{
		AccessToken:    token,
		RefreshToken:   strings.TrimSpace(p.RefreshToken),
		ClientID:       strings.TrimSpace(p.ClientID),
		ClientSecret:   strings.TrimSpace(p.ClientSecret),
		TenantID:       strings.TrimSpace(p.TenantID),
		EnvironmentURL: strings.TrimRight(firstString(p.EnvironmentURL, p.Resource, p.APIBaseURL, p.BaseURL), "/"),
		APIVersion:     strings.TrimSpace(p.APIVersion),
		UserAgent:      strings.TrimSpace(p.UserAgent),
		Scope:          strings.TrimSpace(p.Scope),
	}
	if expires := strings.TrimSpace(p.ExpiresAt); expires != "" {
		if at, err := time.Parse(time.RFC3339, expires); err == nil {
			utc := at.UTC()
			creds.TokenExpiresAt = &utc
		}
	}
	return creds, nil
}

func dynamics365StoredCredentialJSON(creds Dynamics365Credentials) string {
	payload := dynamics365CredentialPayload{
		AccessToken:    strings.TrimSpace(creds.AccessToken),
		RefreshToken:   strings.TrimSpace(creds.RefreshToken),
		ClientID:       strings.TrimSpace(creds.ClientID),
		ClientSecret:   strings.TrimSpace(creds.ClientSecret),
		TenantID:       strings.TrimSpace(creds.TenantID),
		EnvironmentURL: strings.TrimRight(strings.TrimSpace(creds.EnvironmentURL), "/"),
		APIVersion:     strings.TrimSpace(creds.APIVersion),
		UserAgent:      strings.TrimSpace(creds.UserAgent),
		Scope:          strings.TrimSpace(creds.Scope),
	}
	if creds.TokenExpiresAt != nil {
		payload.ExpiresAt = creds.TokenExpiresAt.UTC().Format(time.RFC3339)
	}
	raw, _ := json.Marshal(payload)
	return string(raw)
}

func parseDynamics365CredentialSecret(raw string) (Dynamics365Credentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Dynamics365Credentials{}, fmt.Errorf("dynamics 365 credentials are empty")
	}
	var payload dynamics365CredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return Dynamics365Credentials{}, fmt.Errorf("parse dynamics 365 credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parseDynamics365KeyValueSecret(raw)
		return payload.credentials()
	}
	return dynamics365CredentialPayload{AccessToken: raw}.credentials()
}

func parseDynamics365KeyValueSecret(raw string) dynamics365CredentialPayload {
	var payload dynamics365CredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token", "token", "bearer_token":
			payload.AccessToken = value
		case "environment_url", "resource", "api_base_url", "base_url":
			payload.EnvironmentURL = value
		case "api_version":
			payload.APIVersion = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func (b Dynamics365RESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderDynamics365 {
		return SyncRequest{}, fmt.Errorf("dynamics 365 backfill requires a Microsoft Dynamics 365 integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("dynamics 365 credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveDynamics365(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("dynamics 365 access token is required")
	}
	environmentURL, err := dynamics365EnvironmentURL(firstString(creds.EnvironmentURL, settingString(integration.Settings, "environment_url"), settingString(integration.Settings, "api_base_url")))
	if err != nil {
		return SyncRequest{}, err
	}
	state, err := decodeDynamics365Cursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "complete" {
		return SyncRequest{RunMode: "backfill", Cursor: dynamics365CursorComplete}, nil
	}
	if state.Object == "" {
		state.Object = "contacts"
	}
	client := crmEgressClient(b.HTTPClient, ProviderDynamics365, 20*time.Second)
	records, nextState, err := b.fetchRecordsPage(ctx, client, environmentURL, integration, creds, state)
	if err != nil {
		return SyncRequest{}, err
	}
	contacts := make([]ContactInput, 0, len(records))
	for _, record := range records {
		if contact, ok := mapDynamics365Record(state.Object, record, integration); ok {
			contacts = append(contacts, contact)
		}
	}
	nextCursor := dynamics365CursorComplete
	if nextState.Object != "" && nextState.Object != "complete" {
		nextCursor = encodeDynamics365Cursor(nextState)
	}
	return normalizeSyncRequest(SyncRequest{
		RunMode:  "backfill",
		Contacts: contacts,
		Cursor:   nextCursor,
	}), nil
}

func (b Dynamics365RESTBackfiller) fetchRecordsPage(ctx context.Context, client *http.Client, environmentURL string, integration Integration, creds Dynamics365Credentials, state dynamics365CursorState) ([]map[string]any, dynamics365CursorState, error) {
	objectPath := dynamics365EntitySet(state.Object)
	if objectPath == "" {
		return nil, dynamics365CursorState{}, fmt.Errorf("unsupported dynamics 365 backfill object %q", state.Object)
	}
	apiVersion := dynamics365APIVersion(firstString(b.APIVersion, creds.APIVersion, settingString(integration.Settings, "api_version")))
	query := url.Values{}
	pathOrURL := strings.TrimSpace(state.NextLink)
	if pathOrURL == "" {
		pathOrURL = "/api/data/" + apiVersion + "/" + objectPath
		query.Set("$select", strings.Join(dynamics365Fields(integration, state.Object), ","))
		query.Set("$orderby", dynamics365OrderBy(state.Object))
	}
	reqURL, err := dynamics365RequestURL(environmentURL, pathOrURL, query)
	if err != nil {
		return nil, dynamics365CursorState{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, dynamics365CursorState{}, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("OData-MaxVersion", "4.0")
	req.Header.Set("OData-Version", "4.0")
	req.Header.Set("Prefer", `odata.include-annotations="OData.Community.Display.V1.FormattedValue", odata.maxpagesize=`+strconv.Itoa(dynamics365PageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))))
	req.Header.Set("User-Agent", firstString(b.UserAgent, creds.UserAgent, dynamics365DefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return nil, dynamics365CursorState{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, dynamics365ResponseMaxBytes))
	if err != nil {
		return nil, dynamics365CursorState{}, err
	}
	if resp.StatusCode >= 300 {
		return nil, dynamics365CursorState{}, Dynamics365RESTError{
			Path:       pathOrURL,
			StatusCode: resp.StatusCode,
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    truncateHubSpotString(string(body), 500),
		}
	}
	var out dynamics365RecordsResponse
	if len(body) > 0 {
		if err := json.Unmarshal(body, &out); err != nil {
			return nil, dynamics365CursorState{}, fmt.Errorf("decode dynamics 365 response %s: %w", pathOrURL, err)
		}
	}
	next := dynamics365NextCursor(state, out.NextLink, integration)
	return out.Value, next, nil
}

type dynamics365CursorState struct {
	Object   string `json:"object"`
	NextLink string `json:"next_link,omitempty"`
}

func decodeDynamics365Cursor(cursor string) (dynamics365CursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return dynamics365CursorState{Object: "contacts"}, nil
	}
	if cursor == dynamics365CursorComplete {
		return dynamics365CursorState{Object: "complete"}, nil
	}
	if cursor == "contacts" || cursor == "leads" {
		return dynamics365CursorState{Object: cursor}, nil
	}
	if strings.HasPrefix(cursor, "http://") || strings.HasPrefix(cursor, "https://") {
		return dynamics365CursorState{Object: "contacts", NextLink: cursor}, nil
	}
	if strings.HasPrefix(cursor, "/api/data/") {
		return dynamics365CursorState{Object: "contacts", NextLink: cursor}, nil
	}
	if !strings.HasPrefix(cursor, dynamics365CursorPrefix) {
		return dynamics365CursorState{Object: "contacts", NextLink: cursor}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, dynamics365CursorPrefix))
	if err != nil {
		return dynamics365CursorState{}, fmt.Errorf("decode Dynamics 365 cursor: %w", err)
	}
	var state dynamics365CursorState
	if err := json.Unmarshal(raw, &state); err != nil {
		return dynamics365CursorState{}, fmt.Errorf("parse Dynamics 365 cursor: %w", err)
	}
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	state.NextLink = strings.TrimSpace(state.NextLink)
	if state.Object == "" {
		state.Object = "contacts"
	}
	if state.Object != "contacts" && state.Object != "leads" && state.Object != "complete" {
		return dynamics365CursorState{}, fmt.Errorf("unsupported dynamics 365 cursor object %q", state.Object)
	}
	return state, nil
}

func encodeDynamics365Cursor(state dynamics365CursorState) string {
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	if state.Object == "" {
		state.Object = "contacts"
	}
	state.NextLink = strings.TrimSpace(state.NextLink)
	raw, _ := json.Marshal(state)
	return dynamics365CursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type dynamics365RecordsResponse struct {
	Value    []map[string]any `json:"value"`
	NextLink string           `json:"@odata.nextLink"`
}

type Dynamics365RESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e Dynamics365RESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("dynamics 365 REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("dynamics 365 REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapDynamics365Record(object string, record map[string]any, integration Integration) (ContactInput, bool) {
	email := strings.ToLower(strings.TrimSpace(firstString(
		dynamics365String(record, "emailaddress1"),
		dynamics365String(record, "emailaddress2"),
	)))
	if email == "" {
		return ContactInput{}, false
	}
	kind := "contact"
	id := firstString(dynamics365String(record, "contactid"), email)
	if object == "leads" {
		kind = "lead"
		id = firstString(dynamics365String(record, "leadid"), email)
	}
	updated := firstParsedHubSpotTime(dynamics365String(record, "modifiedon"), dynamics365String(record, "createdon"))
	company := firstString(
		dynamics365String(record, "companyname"),
		dynamics365String(record, "_parentcustomerid_value@OData.Community.Display.V1.FormattedValue"),
		dynamics365NestedString(record["parentcustomerid_account"], "name"),
	)
	phone := firstString(dynamics365String(record, "telephone1"), dynamics365String(record, "mobilephone"), dynamics365String(record, "telephone2"))
	props := map[string]any{
		"dynamics365_object": object,
		"dynamics365_id":     id,
		"dynamics365_raw":    record,
	}
	if owner := dynamics365String(record, "_ownerid_value@OData.Community.Display.V1.FormattedValue"); owner != "" {
		props["dynamics365_owner_name"] = owner
	}
	if parentID := dynamics365String(record, "_parentcustomerid_value"); parentID != "" {
		props["dynamics365_parent_customer_id"] = parentID
	}
	out := ContactInput{
		SourceID:       "dynamics365://" + kind + "/" + id,
		Email:          email,
		FirstName:      dynamics365String(record, "firstname"),
		LastName:       dynamics365String(record, "lastname"),
		FullName:       firstString(dynamics365String(record, "fullname"), dynamics365String(record, "subject")),
		Phone:          phone,
		Company:        company,
		LifecycleStage: firstString(dynamics365String(record, "statuscode@OData.Community.Display.V1.FormattedValue"), dynamics365String(record, "leadsourcecode@OData.Community.Display.V1.FormattedValue"), dynamics365String(record, "jobtitle")),
		ListIDs:        dynamics365ListIDs(integration),
		Tags:           dynamics365DefaultTags(integration, kind),
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

func dynamics365NextCursor(current dynamics365CursorState, nextLink string, integration Integration) dynamics365CursorState {
	current.Object = strings.ToLower(strings.TrimSpace(current.Object))
	if current.Object == "" {
		current.Object = "contacts"
	}
	if nextLink = strings.TrimSpace(nextLink); nextLink != "" {
		return dynamics365CursorState{Object: current.Object, NextLink: nextLink}
	}
	if current.Object == "contacts" && dynamics365SyncLeads(integration) {
		return dynamics365CursorState{Object: "leads"}
	}
	return dynamics365CursorState{Object: "complete"}
}

func dynamics365CredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func normalizeDynamics365BearerToken(token string) string {
	token = strings.TrimSpace(token)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func dynamics365EnvironmentURL(raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		return "", fmt.Errorf("dynamics 365 environment_url is required")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("parse dynamics 365 environment URL: %w", err)
	}
	if u.Scheme == "" {
		u.Scheme = "https"
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", fmt.Errorf("dynamics 365 environment URL must be http or https")
	}
	if u.Host == "" {
		return "", fmt.Errorf("dynamics 365 environment URL host is required")
	}
	u.Path = ""
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimRight(u.String(), "/"), nil
}

func dynamics365RequestURL(environmentURL, pathOrURL string, query url.Values) (string, error) {
	env, err := url.Parse(strings.TrimRight(environmentURL, "/"))
	if err != nil {
		return "", fmt.Errorf("parse dynamics 365 environment URL: %w", err)
	}
	parsed, err := url.Parse(strings.TrimSpace(pathOrURL))
	if err != nil {
		return "", fmt.Errorf("parse dynamics 365 request URL: %w", err)
	}
	if parsed.IsAbs() {
		if !strings.EqualFold(parsed.Host, env.Host) {
			return "", fmt.Errorf("dynamics 365 nextLink host %q does not match environment host %q", parsed.Host, env.Host)
		}
		if query.Encode() != "" {
			parsed.RawQuery = query.Encode()
		}
		return parsed.String(), nil
	}
	if parsed.Path == "" {
		return "", fmt.Errorf("dynamics 365 request path is required")
	}
	env.Path = strings.TrimRight(env.Path, "/") + parsed.Path
	if query.Encode() != "" {
		env.RawQuery = query.Encode()
	} else {
		env.RawQuery = parsed.RawQuery
	}
	return env.String(), nil
}

func dynamics365APIVersion(raw string) string {
	raw = strings.Trim(strings.ToLower(strings.TrimSpace(raw)), "/")
	if raw == "" {
		return dynamics365DefaultAPIVersion
	}
	if !strings.HasPrefix(raw, "v") {
		raw = "v" + raw
	}
	return raw
}

func dynamics365EntitySet(object string) string {
	switch strings.ToLower(strings.TrimSpace(object)) {
	case "contacts":
		return "contacts"
	case "leads":
		return "leads"
	default:
		return ""
	}
}

func dynamics365OrderBy(object string) string {
	switch strings.ToLower(strings.TrimSpace(object)) {
	case "leads":
		return "modifiedon asc,leadid asc"
	default:
		return "modifiedon asc,contactid asc"
	}
}

func dynamics365PageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return dynamics365DefaultPageSize
	}
	if n > dynamics365MaxPageSize {
		return dynamics365MaxPageSize
	}
	return n
}

func dynamics365Fields(integration Integration, object string) []string {
	defaults := []string{
		"emailaddress1",
		"emailaddress2",
		"firstname",
		"lastname",
		"fullname",
		"telephone1",
		"mobilephone",
		"modifiedon",
		"createdon",
		"_ownerid_value",
	}
	key := "contacts_fields"
	if strings.EqualFold(strings.TrimSpace(object), "leads") {
		key = "leads_fields"
		defaults = append([]string{
			"leadid",
			"companyname",
			"subject",
			"leadsourcecode",
			"statuscode",
		}, defaults...)
	} else {
		defaults = append([]string{
			"contactid",
			"jobtitle",
			"_parentcustomerid_value",
		}, defaults...)
	}
	configured := append(hubSpotStringListSetting(integration.Settings, key), hubSpotStringListSetting(integration.Settings, "fields")...)
	return uniqueCRMStrings(append(defaults, configured...))
}

func dynamics365SyncLeads(integration Integration) bool {
	value := strings.ToLower(strings.TrimSpace(settingString(integration.Settings, "sync_leads")))
	return value != "false" && value != "0" && value != "no"
}

func dynamics365ListIDs(integration Integration) []string {
	return uniqueCRMStrings(append(
		hubSpotStringListSetting(integration.Settings, "list_ids"),
		settingString(integration.Settings, "list_id"),
		settingString(integration.Settings, "default_list_id"),
		settingString(integration.Settings, "marketing_list_id"),
	))
}

func dynamics365DefaultTags(integration Integration, kind string) []string {
	tags := append([]string{"dynamics365", "dynamics365-" + kind}, hubSpotStringListSetting(integration.Settings, "default_tags")...)
	return uniqueCRMStrings(tags)
}

func dynamics365String(record map[string]any, key string) string {
	if record == nil {
		return ""
	}
	return dynamics365AnyString(record[key])
}

func dynamics365NestedString(value any, key string) string {
	if typed, ok := value.(map[string]any); ok {
		return dynamics365String(typed, key)
	}
	return ""
}

func dynamics365AnyString(value any) string {
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
