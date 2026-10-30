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
	keapSyncModelContactsREST = "keap_rest_v2_contacts"
	keapCursorPrefix          = "keap:"
	keapCursorComplete        = "keap:complete"
	keapDefaultAPIBaseURL     = "https://api.infusionsoft.com/crm"
	keapDefaultPageSize       = 1000
	keapMaxPageSize           = 1000
	keapResponseMaxBytes      = 8 << 20
	keapDefaultUserAgent      = "Moosewave Keap Integration"
)

type KeapCredentials struct {
	AccessToken    string
	RefreshToken   string
	ClientID       string
	ClientSecret   string
	APIBaseURL     string
	UserAgent      string
	Scope          string
	TokenExpiresAt *time.Time
}

type KeapCredentialResolver interface {
	ResolveKeap(context.Context, string, Integration) (KeapCredentials, error)
}

type KeapBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type KeapRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials KeapCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type KeapRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type KeapSecretsCredentialResolver struct {
	Secrets     KeapRuntimeSecretResolver
	Store       KeapCredentialStore
	OAuthClient KeapOAuthClient
	RefreshSkew time.Duration
	Now         func() time.Time
}

func NewKeapSecretsCredentialResolver(secrets KeapRuntimeSecretResolver) *KeapSecretsCredentialResolver {
	return &KeapSecretsCredentialResolver{Secrets: secrets}
}

func (r *KeapSecretsCredentialResolver) ResolveKeap(ctx context.Context, tenantID string, integration Integration) (KeapCredentials, error) {
	if r == nil || (r.Secrets == nil && r.Store == nil) {
		return KeapCredentials{}, fmt.Errorf("keap credential resolver is not configured")
	}
	ref := keapCredentialRef(integration)
	if ref == "" {
		return KeapCredentials{}, fmt.Errorf("keap credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, tenantID, ref)
	if err != nil {
		return KeapCredentials{}, err
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = settingString(integration.Settings, "api_base_url")
	}
	if creds.UserAgent == "" {
		creds.UserAgent = settingString(integration.Settings, "user_agent")
	}
	return r.refreshCredentialIfNeeded(ctx, tenantID, ref, creds)
}

func (r *KeapSecretsCredentialResolver) refreshCredentialIfNeeded(ctx context.Context, tenantID, ref string, creds KeapCredentials) (KeapCredentials, error) {
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
		return KeapCredentials{}, fmt.Errorf("refresh keap OAuth token: %w", err)
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
	if r.Store != nil && keapIsStoredCredentialRef(ref) {
		if err := r.Store.PutKeapCredentialSecret(ctx, tenantID, ref, creds); err != nil {
			return KeapCredentials{}, fmt.Errorf("persist refreshed keap OAuth token: %w", err)
		}
	}
	return creds, nil
}

func (r *KeapSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, tenantID, ref string) (KeapCredentials, error) {
	if r.Store != nil && keapIsStoredCredentialRef(ref) {
		raw, err := r.Store.GetKeapCredentialSecret(ctx, tenantID, ref)
		if err == nil {
			return parseKeapCredentialSecret(raw)
		}
		if !errors.Is(err, ErrNotFound) {
			return KeapCredentials{}, fmt.Errorf("resolve stored keap credentials %q: %w", ref, err)
		}
	}
	if r.Secrets == nil {
		return KeapCredentials{}, fmt.Errorf("keap credential secret resolver is not configured")
	}
	var payload keapCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return KeapCredentials{}, fmt.Errorf("resolve keap credentials %q: %w", ref, err)
		}
		return parseKeapCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return KeapCredentials{}, fmt.Errorf("resolve keap credentials %q: %w", ref, err)
	}
	return parseKeapCredentialSecret(raw)
}

type keapCredentialPayload struct {
	AccessToken       string `json:"access_token"`
	Token             string `json:"token"`
	BearerToken       string `json:"bearer_token"`
	APIKey            string `json:"api_key"`
	PersonalAccessKey string `json:"personal_access_token"`
	ServiceAccountKey string `json:"service_account_key"`
	RefreshToken      string `json:"refresh_token,omitempty"`
	ClientID          string `json:"client_id,omitempty"`
	ClientSecret      string `json:"client_secret,omitempty"`
	APIBaseURL        string `json:"api_base_url"`
	BaseURL           string `json:"base_url"`
	UserAgent         string `json:"user_agent"`
	Scope             string `json:"scope,omitempty"`
	ExpiresAt         string `json:"expires_at,omitempty"`
}

func (p keapCredentialPayload) credentials() (KeapCredentials, error) {
	token := normalizeKeapBearerToken(firstString(p.AccessToken, p.Token, p.BearerToken, p.APIKey, p.PersonalAccessKey, p.ServiceAccountKey))
	if token == "" {
		return KeapCredentials{}, fmt.Errorf("keap access_token, personal_access_token, or service_account_key is required")
	}
	creds := KeapCredentials{
		AccessToken:  token,
		RefreshToken: strings.TrimSpace(p.RefreshToken),
		ClientID:     strings.TrimSpace(p.ClientID),
		ClientSecret: strings.TrimSpace(p.ClientSecret),
		APIBaseURL:   strings.TrimRight(firstString(p.APIBaseURL, p.BaseURL), "/"),
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

func keapStoredCredentialJSON(creds KeapCredentials) string {
	payload := keapCredentialPayload{
		AccessToken:  strings.TrimSpace(creds.AccessToken),
		RefreshToken: strings.TrimSpace(creds.RefreshToken),
		ClientID:     strings.TrimSpace(creds.ClientID),
		ClientSecret: strings.TrimSpace(creds.ClientSecret),
		APIBaseURL:   strings.TrimRight(strings.TrimSpace(creds.APIBaseURL), "/"),
		UserAgent:    strings.TrimSpace(creds.UserAgent),
		Scope:        strings.TrimSpace(creds.Scope),
	}
	if creds.TokenExpiresAt != nil {
		payload.ExpiresAt = creds.TokenExpiresAt.UTC().Format(time.RFC3339)
	}
	raw, _ := json.Marshal(payload)
	return string(raw)
}

func parseKeapCredentialSecret(raw string) (KeapCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return KeapCredentials{}, fmt.Errorf("keap credentials are empty")
	}
	var payload keapCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return KeapCredentials{}, fmt.Errorf("parse keap credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parseKeapKeyValueSecret(raw)
		return payload.credentials()
	}
	return keapCredentialPayload{AccessToken: raw}.credentials()
}

func parseKeapKeyValueSecret(raw string) keapCredentialPayload {
	var payload keapCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token", "token", "bearer_token":
			payload.AccessToken = value
		case "api_key", "personal_access_token", "pat":
			payload.APIKey = value
		case "service_account_key", "sak":
			payload.ServiceAccountKey = value
		case "api_base_url", "base_url":
			payload.APIBaseURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func (b KeapRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderKeap {
		return SyncRequest{}, fmt.Errorf("keap backfill requires a Keap integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("keap credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveKeap(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("keap access token is required")
	}
	baseURL, err := keapAPIBaseURL(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url")))
	if err != nil {
		return SyncRequest{}, err
	}
	state, err := decodeKeapCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "complete" {
		return SyncRequest{RunMode: "backfill", Cursor: keapCursorComplete}, nil
	}
	if state.Object == "" {
		state.Object = keapInitialObject(integration)
	}
	client := crmEgressClient(b.HTTPClient, ProviderKeap, 20*time.Second)
	records, nextState, err := b.fetchContactsPage(ctx, client, baseURL, integration, creds, state)
	if err != nil {
		return SyncRequest{}, err
	}
	contacts := make([]ContactInput, 0, len(records))
	for _, record := range records {
		if contact, ok := mapKeapContact(state.Object, record, integration); ok {
			contacts = append(contacts, contact)
		}
	}
	nextCursor := keapCursorComplete
	if nextState.Object != "" && nextState.Object != "complete" {
		nextCursor = encodeKeapCursor(nextState)
	}
	return normalizeSyncRequest(SyncRequest{
		RunMode:  "backfill",
		Contacts: contacts,
		Cursor:   nextCursor,
	}), nil
}

func (b KeapRESTBackfiller) fetchContactsPage(ctx context.Context, client *http.Client, baseURL string, integration Integration, creds KeapCredentials, state keapCursorState) ([]map[string]any, keapCursorState, error) {
	path := "/rest/v2/contacts"
	if state.Object == "tagged_contacts" {
		tagID := strings.TrimSpace(firstString(state.TagID, settingString(integration.Settings, "tag_id")))
		if tagID == "" {
			return nil, keapCursorState{}, fmt.Errorf("keap tag_id is required for tagged contact pulls")
		}
		path = "/rest/v2/tags/" + url.PathEscape(tagID) + "/contacts"
	} else if state.Object != "contacts" {
		return nil, keapCursorState{}, fmt.Errorf("unsupported keap backfill object %q", state.Object)
	}
	query := url.Values{}
	query.Set("page_size", strconv.Itoa(keapPageSize(firstString(settingString(integration.Settings, "page_size"), settingString(integration.Settings, "limit"), strconv.Itoa(b.PageSize)))))
	if state.PageToken != "" {
		query.Set("page_token", state.PageToken)
	}
	if filter := strings.TrimSpace(settingString(integration.Settings, "filter")); filter != "" {
		query.Set("filter", filter)
	}
	if orderBy := strings.TrimSpace(settingString(integration.Settings, "order_by")); orderBy != "" {
		query.Set("order_by", orderBy)
	} else if state.Object == "contacts" {
		query.Set("order_by", "update_time asc")
	}
	if state.Object == "contacts" {
		query.Set("fields", strings.Join(keapContactFields(integration), ","))
	}
	var out keapContactsResponse
	if err := keapDoJSON(ctx, client, baseURL, creds, b.UserAgent, http.MethodGet, path, query, &out); err != nil {
		return nil, keapCursorState{}, err
	}
	next := keapNextCursor(state, out.NextPageToken)
	return out.Contacts, next, nil
}

type keapCursorState struct {
	Object    string `json:"object"`
	PageToken string `json:"page_token,omitempty"`
	TagID     string `json:"tag_id,omitempty"`
}

func decodeKeapCursor(cursor string) (keapCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return keapCursorState{}, nil
	}
	if cursor == keapCursorComplete {
		return keapCursorState{Object: "complete"}, nil
	}
	if cursor == "contacts" || cursor == "tagged_contacts" {
		return keapCursorState{Object: cursor}, nil
	}
	if !strings.HasPrefix(cursor, keapCursorPrefix) {
		return keapCursorState{Object: "contacts", PageToken: cursor}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, keapCursorPrefix))
	if err != nil {
		return keapCursorState{}, fmt.Errorf("decode Keap cursor: %w", err)
	}
	var state keapCursorState
	if err := json.Unmarshal(raw, &state); err != nil {
		return keapCursorState{}, fmt.Errorf("parse Keap cursor: %w", err)
	}
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	state.PageToken = strings.TrimSpace(state.PageToken)
	state.TagID = strings.TrimSpace(state.TagID)
	if state.Object == "" {
		state.Object = "contacts"
	}
	if state.Object != "contacts" && state.Object != "tagged_contacts" && state.Object != "complete" {
		return keapCursorState{}, fmt.Errorf("unsupported keap cursor object %q", state.Object)
	}
	return state, nil
}

func encodeKeapCursor(state keapCursorState) string {
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	if state.Object == "" {
		state.Object = "contacts"
	}
	state.PageToken = strings.TrimSpace(state.PageToken)
	state.TagID = strings.TrimSpace(state.TagID)
	raw, _ := json.Marshal(state)
	return keapCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type keapContactsResponse struct {
	Contacts      []map[string]any `json:"contacts"`
	NextPageToken string           `json:"next_page_token"`
}

type KeapRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e KeapRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("keap REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("keap REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func keapDoJSON(ctx context.Context, client *http.Client, baseURL string, creds KeapCredentials, userAgent, method, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse keap API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, keapDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, keapResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return KeapRESTError{
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
		return fmt.Errorf("decode keap response %s: %w", path, err)
	}
	return nil
}

func mapKeapContact(object string, record map[string]any, integration Integration) (ContactInput, bool) {
	email := strings.ToLower(strings.TrimSpace(firstString(
		keapString(record, "email"),
		keapFirstNestedString(record["email_addresses"], "email"),
	)))
	if email == "" {
		return ContactInput{}, false
	}
	id := firstString(keapString(record, "id"), email)
	tagID := ""
	if object == "tagged_contacts" {
		tagID = settingString(integration.Settings, "tag_id")
	}
	updated := firstParsedHubSpotTime(keapString(record, "update_time"), keapString(record, "applied_time"), keapString(record, "create_time"))
	company := firstString(keapNestedString(record["company"], "company_name"), keapString(record, "company"))
	props := map[string]any{
		"keap_object": object,
		"keap_id":     id,
		"keap_raw":    record,
	}
	if tagID != "" {
		props["keap_tag_id"] = tagID
	}
	if ownerID := keapString(record, "owner_id"); ownerID != "" {
		props["keap_owner_id"] = ownerID
	}
	if leadSourceID := keapString(record, "leadsource_id"); leadSourceID != "" {
		props["keap_leadsource_id"] = leadSourceID
	}
	out := ContactInput{
		SourceID:       "keap://contact/" + id,
		Email:          email,
		FirstName:      keapString(record, "given_name"),
		LastName:       keapString(record, "family_name"),
		FullName:       strings.TrimSpace(strings.TrimSpace(keapString(record, "given_name") + " " + keapString(record, "family_name"))),
		Phone:          firstString(keapFirstNestedString(record["phone_numbers"], "number_e164"), keapFirstNestedString(record["phone_numbers"], "number")),
		Company:        company,
		LifecycleStage: firstString(keapString(record, "contact_type"), keapString(record, "source_type"), keapString(record, "job_title"), keapString(record, "score_value")),
		ListIDs:        keapListIDs(integration),
		Tags:           keapDefaultTags(integration, tagID),
		Properties:     props,
	}
	if updated != nil {
		out.UpdatedAt = updated
	}
	return out, true
}

func keapNextCursor(current keapCursorState, pageToken string) keapCursorState {
	current.Object = strings.ToLower(strings.TrimSpace(current.Object))
	if current.Object == "" {
		current.Object = "contacts"
	}
	if pageToken = strings.TrimSpace(pageToken); pageToken != "" {
		return keapCursorState{Object: current.Object, PageToken: pageToken, TagID: current.TagID}
	}
	return keapCursorState{Object: "complete"}
}

func keapCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func normalizeKeapBearerToken(token string) string {
	token = strings.TrimSpace(token)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func keapAPIBaseURL(raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		raw = keapDefaultAPIBaseURL
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("parse keap API base URL: %w", err)
	}
	if u.Scheme == "" {
		u.Scheme = "https"
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", fmt.Errorf("keap API base URL must be http or https")
	}
	if u.Host == "" {
		return "", fmt.Errorf("keap API base URL host is required")
	}
	u.RawQuery = ""
	u.Fragment = ""
	u.Path = strings.TrimRight(u.Path, "/")
	return strings.TrimRight(u.String(), "/"), nil
}

func keapInitialObject(integration Integration) string {
	if strings.TrimSpace(settingString(integration.Settings, "tag_id")) != "" {
		return "tagged_contacts"
	}
	return "contacts"
}

func keapPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return keapDefaultPageSize
	}
	if n > keapMaxPageSize {
		return keapMaxPageSize
	}
	return n
}

func keapContactFields(integration Integration) []string {
	defaults := []string{
		"id",
		"given_name",
		"family_name",
		"email_addresses",
		"phone_numbers",
		"company",
		"job_title",
		"contact_type",
		"tag_ids",
		"update_time",
		"create_time",
		"leadsource_id",
		"owner_id",
		"source_type",
		"website",
		"score_value",
	}
	configured := append(hubSpotStringListSetting(integration.Settings, "contacts_fields"), hubSpotStringListSetting(integration.Settings, "fields")...)
	return uniqueCRMStrings(append(defaults, configured...))
}

func keapListIDs(integration Integration) []string {
	return uniqueCRMStrings(append(
		hubSpotStringListSetting(integration.Settings, "list_ids"),
		settingString(integration.Settings, "list_id"),
		settingString(integration.Settings, "default_list_id"),
	))
}

func keapDefaultTags(integration Integration, tagID string) []string {
	tags := append([]string{"keap", "keap-contact"}, hubSpotStringListSetting(integration.Settings, "default_tags")...)
	if tagID = strings.TrimSpace(tagID); tagID != "" {
		tags = append(tags, "keap-tag-"+tagID)
	}
	return uniqueCRMStrings(tags)
}

func keapString(record map[string]any, key string) string {
	if record == nil {
		return ""
	}
	return keapAnyString(record[key])
}

func keapNestedString(value any, key string) string {
	if typed, ok := value.(map[string]any); ok {
		return keapString(typed, key)
	}
	return ""
}

func keapFirstNestedString(value any, key string) string {
	values, ok := value.([]any)
	if !ok {
		return ""
	}
	for _, item := range values {
		if typed, ok := item.(map[string]any); ok {
			if out := keapString(typed, key); out != "" {
				return out
			}
		}
	}
	return ""
}

func keapAnyString(value any) string {
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
