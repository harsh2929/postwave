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
	highLevelSyncModelContactsREST = "highlevel_contacts_rest_scheduled_retry_backfill"
	highLevelCursorPrefix          = "highlevel:"
	highLevelCursorComplete        = "highlevel:complete"
	highLevelDefaultAPIBaseURL     = "https://services.leadconnectorhq.com"
	highLevelAPIVersion            = "2021-07-28"
	highLevelDefaultPageSize       = 100
	highLevelMaxPageSize           = 100
	highLevelResponseMaxBytes      = 8 << 20
	highLevelDefaultUserAgent      = "Moosewave HighLevel Integration"
)

type HighLevelCredentials struct {
	AccessToken    string
	RefreshToken   string
	ClientID       string
	ClientSecret   string
	LocationID     string
	APIBaseURL     string
	UserAgent      string
	Scope          string
	TokenExpiresAt *time.Time
}

type HighLevelCredentialResolver interface {
	ResolveHighLevel(context.Context, string, Integration) (HighLevelCredentials, error)
}

type HighLevelBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type HighLevelRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials HighLevelCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type HighLevelRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type HighLevelSecretsCredentialResolver struct {
	Secrets     HighLevelRuntimeSecretResolver
	Store       HighLevelCredentialStore
	OAuthClient HighLevelOAuthClient
	RefreshSkew time.Duration
	Now         func() time.Time
}

func NewHighLevelSecretsCredentialResolver(secrets HighLevelRuntimeSecretResolver) *HighLevelSecretsCredentialResolver {
	return &HighLevelSecretsCredentialResolver{Secrets: secrets}
}

func (r *HighLevelSecretsCredentialResolver) ResolveHighLevel(ctx context.Context, tenantID string, integration Integration) (HighLevelCredentials, error) {
	if r == nil || (r.Secrets == nil && r.Store == nil) {
		return HighLevelCredentials{}, fmt.Errorf("highLevel credential resolver is not configured")
	}
	ref := highLevelCredentialRef(integration)
	if ref == "" {
		return HighLevelCredentials{}, fmt.Errorf("highLevel credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, tenantID, ref)
	if err != nil {
		return HighLevelCredentials{}, err
	}
	if creds.APIBaseURL == "" {
		creds.APIBaseURL = settingString(integration.Settings, "api_base_url")
	}
	if creds.UserAgent == "" {
		creds.UserAgent = settingString(integration.Settings, "user_agent")
	}
	return r.refreshCredentialIfNeeded(ctx, tenantID, ref, creds)
}

func (r *HighLevelSecretsCredentialResolver) refreshCredentialIfNeeded(ctx context.Context, tenantID, ref string, creds HighLevelCredentials) (HighLevelCredentials, error) {
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
		return HighLevelCredentials{}, fmt.Errorf("refresh highLevel OAuth token: %w", err)
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
	if r.Store != nil && highLevelIsStoredCredentialRef(ref) {
		if err := r.Store.PutHighLevelCredentialSecret(ctx, tenantID, ref, creds); err != nil {
			return HighLevelCredentials{}, fmt.Errorf("persist refreshed highLevel OAuth token: %w", err)
		}
	}
	return creds, nil
}

func (r *HighLevelSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, tenantID, ref string) (HighLevelCredentials, error) {
	if r.Store != nil && highLevelIsStoredCredentialRef(ref) {
		raw, err := r.Store.GetHighLevelCredentialSecret(ctx, tenantID, ref)
		if err == nil {
			return parseHighLevelCredentialSecret(raw)
		}
		if !errors.Is(err, ErrNotFound) {
			return HighLevelCredentials{}, fmt.Errorf("resolve stored highLevel credentials %q: %w", ref, err)
		}
	}
	if r.Secrets == nil {
		return HighLevelCredentials{}, fmt.Errorf("highLevel credential secret resolver is not configured")
	}
	var payload highLevelCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return HighLevelCredentials{}, fmt.Errorf("resolve highLevel credentials %q: %w", ref, err)
		}
		return parseHighLevelCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return HighLevelCredentials{}, fmt.Errorf("resolve highLevel credentials %q: %w", ref, err)
	}
	return parseHighLevelCredentialSecret(raw)
}

type highLevelCredentialPayload struct {
	AccessToken       string `json:"access_token"`
	Token             string `json:"token"`
	BearerToken       string `json:"bearer_token"`
	APIKey            string `json:"api_key"`
	PersonalAccessKey string `json:"personal_access_token"`
	ServiceAccountKey string `json:"service_account_key"`
	RefreshToken      string `json:"refresh_token,omitempty"`
	ClientID          string `json:"client_id,omitempty"`
	ClientSecret      string `json:"client_secret,omitempty"`
	LocationID        string `json:"location_id,omitempty"`
	APIBaseURL        string `json:"api_base_url"`
	BaseURL           string `json:"base_url"`
	UserAgent         string `json:"user_agent"`
	Scope             string `json:"scope,omitempty"`
	ExpiresAt         string `json:"expires_at,omitempty"`
}

func (p highLevelCredentialPayload) credentials() (HighLevelCredentials, error) {
	token := normalizeHighLevelBearerToken(firstString(p.AccessToken, p.Token, p.BearerToken, p.APIKey, p.PersonalAccessKey, p.ServiceAccountKey))
	if token == "" {
		return HighLevelCredentials{}, fmt.Errorf("highLevel access_token, personal_access_token, or service_account_key is required")
	}
	creds := HighLevelCredentials{
		AccessToken:  token,
		RefreshToken: strings.TrimSpace(p.RefreshToken),
		ClientID:     strings.TrimSpace(p.ClientID),
		ClientSecret: strings.TrimSpace(p.ClientSecret),
		LocationID:   strings.TrimSpace(p.LocationID),
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

func highLevelStoredCredentialJSON(creds HighLevelCredentials) string {
	payload := highLevelCredentialPayload{
		AccessToken:  strings.TrimSpace(creds.AccessToken),
		RefreshToken: strings.TrimSpace(creds.RefreshToken),
		ClientID:     strings.TrimSpace(creds.ClientID),
		ClientSecret: strings.TrimSpace(creds.ClientSecret),
		LocationID:   strings.TrimSpace(creds.LocationID),
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

func parseHighLevelCredentialSecret(raw string) (HighLevelCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return HighLevelCredentials{}, fmt.Errorf("highLevel credentials are empty")
	}
	var payload highLevelCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return HighLevelCredentials{}, fmt.Errorf("parse highLevel credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		payload = parseHighLevelKeyValueSecret(raw)
		return payload.credentials()
	}
	return highLevelCredentialPayload{AccessToken: raw}.credentials()
}

func parseHighLevelKeyValueSecret(raw string) highLevelCredentialPayload {
	var payload highLevelCredentialPayload
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

func (b HighLevelRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderHighLevel {
		return SyncRequest{}, fmt.Errorf("highLevel backfill requires a HighLevel integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("highLevel credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveHighLevel(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("highLevel access token is required")
	}
	baseURL, err := highLevelAPIBaseURL(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url")))
	if err != nil {
		return SyncRequest{}, err
	}
	state, err := decodeHighLevelCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Object == "complete" {
		return SyncRequest{RunMode: "backfill", Cursor: highLevelCursorComplete}, nil
	}
	if state.Object == "" {
		state.Object = highLevelInitialObject(integration)
	}
	client := crmEgressClient(b.HTTPClient, ProviderHighLevel, 20*time.Second)
	pageSize := highLevelPageSize(firstString(settingString(integration.Settings, "page_size"), settingString(integration.Settings, "limit"), strconv.Itoa(b.PageSize)))
	runtime := highLevelRuntime{
		ctx:         ctx,
		client:      client,
		baseURL:     baseURL,
		creds:       creds,
		userAgent:   b.UserAgent,
		integration: integration,
		pageSize:    pageSize,
	}
	switch state.Object {
	case "contacts":
		records, nextState, err := b.fetchContactsPage(ctx, client, baseURL, integration, creds, state)
		if err != nil {
			return SyncRequest{}, err
		}
		contacts := make([]ContactInput, 0, len(records))
		for _, record := range records {
			if contact, ok := mapHighLevelContact(state.Object, record, integration); ok {
				contacts = append(contacts, contact)
			}
		}
		return normalizeSyncRequest(SyncRequest{
			RunMode:  "backfill",
			Contacts: contacts,
			Cursor:   highLevelCursorString(highLevelAdvanceCursor(state.Object, nextState, integration)),
		}), nil
	case "opportunities":
		return runtime.backfillOpportunitiesPage(state)
	case "calendars":
		return runtime.backfillCalendarsPage(state)
	case "appointments":
		return runtime.backfillAppointmentsPage(state)
	case "conversations":
		return runtime.backfillConversationsPage(state)
	default:
		return SyncRequest{}, fmt.Errorf("unsupported highLevel backfill object %q", state.Object)
	}
}

func (b HighLevelRESTBackfiller) fetchContactsPage(ctx context.Context, client *http.Client, baseURL string, integration Integration, creds HighLevelCredentials, state highLevelCursorState) ([]map[string]any, highLevelCursorState, error) {
	if state.Object != "contacts" {
		return nil, highLevelCursorState{}, fmt.Errorf("unsupported highLevel backfill object %q", state.Object)
	}
	locationID := highLevelLocationID(creds, integration)
	if locationID == "" {
		return nil, highLevelCursorState{}, fmt.Errorf("highLevel location_id is required")
	}
	query := url.Values{}
	query.Set("locationId", locationID)
	query.Set("limit", strconv.Itoa(highLevelPageSize(firstString(settingString(integration.Settings, "page_size"), settingString(integration.Settings, "limit"), strconv.Itoa(b.PageSize)))))
	if state.StartAfterID != "" {
		query.Set("startAfterId", state.StartAfterID)
	}
	if state.StartAfter != "" {
		query.Set("startAfter", state.StartAfter)
	}
	var out highLevelContactsResponse
	if err := highLevelDoJSON(ctx, client, baseURL, creds, b.UserAgent, http.MethodGet, "/contacts/", query, &out); err != nil {
		return nil, highLevelCursorState{}, err
	}
	next := highLevelNextCursor(state, out)
	return out.Contacts, next, nil
}

type highLevelRuntime struct {
	ctx         context.Context
	client      *http.Client
	baseURL     string
	creds       HighLevelCredentials
	userAgent   string
	integration Integration
	pageSize    int
}

func (rt highLevelRuntime) backfillOpportunitiesPage(state highLevelCursorState) (SyncRequest, error) {
	records, next, err := rt.fetchRecordsPage(state, "/opportunities/search", []string{"opportunities", "data", "items"}, func(query url.Values) {
		locationID := highLevelLocationID(rt.creds, rt.integration)
		query.Set("locationId", locationID)
		query.Set("location_id", locationID)
		query.Set("status", firstString(settingString(rt.integration.Settings, "opportunity_status"), "all"))
		if pipelineID := strings.TrimSpace(settingString(rt.integration.Settings, "pipeline_id")); pipelineID != "" {
			query.Set("pipelineId", pipelineID)
			query.Set("pipeline_id", pipelineID)
		}
	})
	if err != nil {
		return SyncRequest{}, err
	}
	events := make([]EventInput, 0, len(records))
	for _, record := range records {
		contact, ok, err := rt.resolveRecordContact(record)
		if err != nil {
			return SyncRequest{}, err
		}
		if !ok {
			continue
		}
		if event, ok := mapHighLevelOpportunityEvent(record, contact, rt.integration); ok {
			events = append(events, event)
		}
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Events: events, Cursor: highLevelCursorString(next)}), nil
}

func (rt highLevelRuntime) backfillCalendarsPage(state highLevelCursorState) (SyncRequest, error) {
	records, next, err := rt.fetchRecordsPage(state, "/calendars/", []string{"calendars", "data", "items"}, func(query url.Values) {
		query.Set("locationId", highLevelLocationID(rt.creds, rt.integration))
	})
	if err != nil {
		return SyncRequest{}, err
	}
	_ = records
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Cursor: highLevelCursorString(next)}), nil
}

func (rt highLevelRuntime) backfillAppointmentsPage(state highLevelCursorState) (SyncRequest, error) {
	records, next, err := rt.fetchRecordsPage(state, "/calendars/events", []string{"events", "appointments", "calendarEvents", "data", "items"}, func(query url.Values) {
		query.Set("locationId", highLevelLocationID(rt.creds, rt.integration))
		if calendarID := strings.TrimSpace(settingString(rt.integration.Settings, "calendar_id")); calendarID != "" {
			query.Set("calendarId", calendarID)
		}
		start, end := highLevelCalendarWindow(rt.integration)
		query.Set("startTime", start)
		query.Set("endTime", end)
	})
	if err != nil {
		return SyncRequest{}, err
	}
	events := make([]EventInput, 0, len(records))
	for _, record := range records {
		contact, ok, err := rt.resolveRecordContact(record)
		if err != nil {
			return SyncRequest{}, err
		}
		if !ok {
			continue
		}
		if event, ok := mapHighLevelAppointmentEvent(record, contact, rt.integration); ok {
			events = append(events, event)
		}
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Events: events, Cursor: highLevelCursorString(next)}), nil
}

func (rt highLevelRuntime) backfillConversationsPage(state highLevelCursorState) (SyncRequest, error) {
	records, next, err := rt.fetchRecordsPage(state, "/conversations/search", []string{"conversations", "data", "items"}, func(query url.Values) {
		query.Set("locationId", highLevelLocationID(rt.creds, rt.integration))
	})
	if err != nil {
		return SyncRequest{}, err
	}
	events := make([]EventInput, 0, len(records))
	for _, record := range records {
		contact, ok, err := rt.resolveRecordContact(record)
		if err != nil {
			return SyncRequest{}, err
		}
		if !ok {
			continue
		}
		if event, ok := mapHighLevelConversationEvent(record, contact, rt.integration); ok {
			events = append(events, event)
		}
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "backfill", Events: events, Cursor: highLevelCursorString(next)}), nil
}

func (rt highLevelRuntime) fetchRecordsPage(state highLevelCursorState, path string, keys []string, configure func(url.Values)) ([]map[string]any, highLevelCursorState, error) {
	locationID := highLevelLocationID(rt.creds, rt.integration)
	if locationID == "" {
		return nil, highLevelCursorState{}, fmt.Errorf("highLevel location_id is required")
	}
	query := url.Values{}
	query.Set("limit", strconv.Itoa(rt.pageSize))
	if state.StartAfterID != "" {
		query.Set("startAfterId", state.StartAfterID)
	}
	if state.StartAfter != "" {
		query.Set("startAfter", state.StartAfter)
	}
	if state.Page > 0 {
		query.Set("page", strconv.Itoa(state.Page))
	}
	if configure != nil {
		configure(query)
	}
	var raw map[string]any
	if err := highLevelDoJSON(rt.ctx, rt.client, rt.baseURL, rt.creds, rt.userAgent, http.MethodGet, path, query, &raw); err != nil {
		return nil, highLevelCursorState{}, err
	}
	records := highLevelRecordsFromResponse(raw, keys...)
	next := highLevelNextListCursor(state, raw, len(records), rt.pageSize, rt.integration)
	return records, next, nil
}

func (rt highLevelRuntime) resolveRecordContact(record map[string]any) (ContactInput, bool, error) {
	for _, key := range []string{"contact", "contactDetails", "contactInfo"} {
		if nested := highLevelMapValue(record[key]); len(nested) > 0 {
			if contact, ok := mapHighLevelContact("contact", nested, rt.integration); ok {
				return contact, true, nil
			}
		}
	}
	if contact, ok := mapHighLevelContact("contact", record, rt.integration); ok {
		return contact, true, nil
	}
	contactID := firstString(
		highLevelString(record, "contactId"),
		highLevelString(record, "contact_id"),
		highLevelNestedString(record["contact"], "id"),
	)
	if contactID == "" {
		return ContactInput{}, false, nil
	}
	contact, err := rt.fetchContact(contactID)
	if err != nil {
		return ContactInput{}, false, err
	}
	mapped, ok := mapHighLevelContact("contact", contact, rt.integration)
	return mapped, ok, nil
}

func (rt highLevelRuntime) fetchContact(contactID string) (map[string]any, error) {
	var raw map[string]any
	if err := highLevelDoJSON(rt.ctx, rt.client, rt.baseURL, rt.creds, rt.userAgent, http.MethodGet, "/contacts/"+url.PathEscape(strings.TrimSpace(contactID)), nil, &raw); err != nil {
		return nil, err
	}
	if contact := highLevelMapValue(raw["contact"]); len(contact) > 0 {
		return contact, nil
	}
	return raw, nil
}

type highLevelCursorState struct {
	Object       string `json:"object"`
	StartAfterID string `json:"start_after_id,omitempty"`
	StartAfter   string `json:"start_after,omitempty"`
	Page         int    `json:"page,omitempty"`
}

func decodeHighLevelCursor(cursor string) (highLevelCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return highLevelCursorState{}, nil
	}
	if cursor == highLevelCursorComplete {
		return highLevelCursorState{Object: "complete"}, nil
	}
	if cursor == "contacts" {
		return highLevelCursorState{Object: cursor}, nil
	}
	if !strings.HasPrefix(cursor, highLevelCursorPrefix) {
		return highLevelCursorState{Object: "contacts", StartAfterID: cursor}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, highLevelCursorPrefix))
	if err != nil {
		return highLevelCursorState{}, fmt.Errorf("decode HighLevel cursor: %w", err)
	}
	var state highLevelCursorState
	if err := json.Unmarshal(raw, &state); err != nil {
		return highLevelCursorState{}, fmt.Errorf("parse HighLevel cursor: %w", err)
	}
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	state.StartAfterID = strings.TrimSpace(state.StartAfterID)
	state.StartAfter = strings.TrimSpace(state.StartAfter)
	if state.Object == "" {
		state.Object = "contacts"
	}
	if !highLevelCursorObjectAllowed(state.Object) {
		return highLevelCursorState{}, fmt.Errorf("unsupported highLevel cursor object %q", state.Object)
	}
	if state.Page < 0 {
		state.Page = 0
	}
	return state, nil
}

func encodeHighLevelCursor(state highLevelCursorState) string {
	state.Object = strings.ToLower(strings.TrimSpace(state.Object))
	if state.Object == "" {
		state.Object = "contacts"
	}
	state.StartAfterID = strings.TrimSpace(state.StartAfterID)
	state.StartAfter = strings.TrimSpace(state.StartAfter)
	if state.Page < 0 {
		state.Page = 0
	}
	raw, _ := json.Marshal(state)
	return highLevelCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func highLevelCursorObjectAllowed(object string) bool {
	switch strings.ToLower(strings.TrimSpace(object)) {
	case "contacts", "opportunities", "calendars", "appointments", "conversations", "complete":
		return true
	default:
		return false
	}
}

func highLevelCursorString(state highLevelCursorState) string {
	if state.Object == "" || state.Object == "complete" {
		return highLevelCursorComplete
	}
	return encodeHighLevelCursor(state)
}

func highLevelAdvanceCursor(current string, next highLevelCursorState, integration Integration) highLevelCursorState {
	if next.Object != "" && next.Object != "complete" {
		return next
	}
	seen := false
	for _, object := range []string{"contacts", "opportunities", "calendars", "appointments", "conversations"} {
		if object == current {
			seen = true
			continue
		}
		if !seen || !highLevelObjectEnabled(integration, object) {
			continue
		}
		return highLevelCursorState{Object: object, Page: 1}
	}
	return highLevelCursorState{Object: "complete"}
}

func highLevelObjectEnabled(integration Integration, object string) bool {
	switch object {
	case "contacts":
		return true
	case "opportunities":
		return highLevelSettingTrue(integration.Settings, "sync_opportunities")
	case "calendars":
		return highLevelSettingTrue(integration.Settings, "sync_calendars")
	case "appointments":
		return highLevelSettingTrue(integration.Settings, "sync_appointments")
	case "conversations":
		return highLevelSettingTrue(integration.Settings, "sync_conversations")
	default:
		return false
	}
}

func highLevelSettingTrue(settings map[string]any, key string) bool {
	value, ok := settings[key]
	if !ok || value == nil {
		return false
	}
	switch v := value.(type) {
	case bool:
		return v
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "true", "1", "yes", "on", "enabled":
			return true
		default:
			return false
		}
	case json.Number:
		n, _ := v.Int64()
		return n != 0
	case int:
		return v != 0
	case int64:
		return v != 0
	case float64:
		return v != 0
	default:
		return true
	}
}

func highLevelRecordsFromResponse(raw map[string]any, keys ...string) []map[string]any {
	for _, key := range keys {
		if records := highLevelMapSlice(raw[key]); len(records) > 0 {
			return records
		}
		if nested := highLevelMapValue(raw[key]); len(nested) > 0 {
			if records := highLevelMapSlice(nested["records"]); len(records) > 0 {
				return records
			}
			if records := highLevelMapSlice(nested["items"]); len(records) > 0 {
				return records
			}
		}
	}
	if records := highLevelMapSlice(raw["results"]); len(records) > 0 {
		return records
	}
	return nil
}

func highLevelNextListCursor(current highLevelCursorState, raw map[string]any, count, pageSize int, integration Integration) highLevelCursorState {
	current.Object = strings.ToLower(strings.TrimSpace(current.Object))
	meta := highLevelMapValue(raw["meta"])
	startAfterID := firstString(highLevelString(meta, "startAfterId"), highLevelString(raw, "startAfterId"))
	startAfter := firstString(highLevelString(meta, "startAfter"), highLevelString(raw, "startAfter"))
	if startAfterID != "" {
		return highLevelCursorState{Object: current.Object, StartAfterID: startAfterID, StartAfter: startAfter}
	}
	nextPage := highLevelInt(firstString(highLevelString(meta, "nextPage"), highLevelString(raw, "nextPage")))
	if nextPage > 0 {
		return highLevelCursorState{Object: current.Object, Page: nextPage}
	}
	page := current.Page
	if page <= 0 {
		page = 1
	}
	if count >= pageSize && pageSize > 0 {
		return highLevelCursorState{Object: current.Object, Page: page + 1}
	}
	return highLevelAdvanceCursor(current.Object, highLevelCursorState{Object: "complete"}, integration)
}

func highLevelCalendarWindow(integration Integration) (string, string) {
	if start := firstString(settingString(integration.Settings, "calendar_start_time"), settingString(integration.Settings, "start_time")); start != "" {
		end := firstString(settingString(integration.Settings, "calendar_end_time"), settingString(integration.Settings, "end_time"))
		if end == "" {
			end = time.Now().UTC().AddDate(1, 0, 0).Format(time.RFC3339)
		}
		return start, end
	}
	now := time.Now().UTC()
	return now.AddDate(0, -1, 0).Format(time.RFC3339), now.AddDate(1, 0, 0).Format(time.RFC3339)
}

type highLevelContactsResponse struct {
	Contacts []map[string]any `json:"contacts"`
	Meta     struct {
		StartAfterID string      `json:"startAfterId"`
		StartAfter   json.Number `json:"startAfter"`
		NextPageURL  string      `json:"nextPageUrl"`
	} `json:"meta"`
}

type HighLevelRESTError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e HighLevelRESTError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("highLevel REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("highLevel REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func highLevelDoJSON(ctx context.Context, client *http.Client, baseURL string, creds HighLevelCredentials, userAgent, method, path string, query url.Values, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse highLevel API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(creds.AccessToken))
	req.Header.Set("Version", highLevelAPIVersion)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, highLevelDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, highLevelResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return HighLevelRESTError{
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
		return fmt.Errorf("decode highLevel response %s: %w", path, err)
	}
	return nil
}

func mapHighLevelContact(object string, record map[string]any, integration Integration) (ContactInput, bool) {
	email := strings.ToLower(strings.TrimSpace(highLevelString(record, "email")))
	if email == "" {
		return ContactInput{}, false
	}
	id := firstString(highLevelString(record, "id"), email)
	updated := firstParsedHubSpotTime(highLevelString(record, "dateUpdated"), highLevelString(record, "dateAdded"))
	props := map[string]any{
		"highlevel_object":      object,
		"highlevel_id":          id,
		"highlevel_location_id": highLevelString(record, "locationId"),
		"highlevel_raw":         record,
	}
	first := firstString(highLevelString(record, "firstName"), highLevelString(record, "firstNameLowerCase"))
	last := firstString(highLevelString(record, "lastName"), highLevelString(record, "lastNameLowerCase"))
	full := firstString(highLevelString(record, "contactName"), highLevelString(record, "fullNameLowerCase"), strings.TrimSpace(first+" "+last))
	out := ContactInput{
		SourceID:       "highlevel://contact/" + id,
		Email:          email,
		FirstName:      first,
		LastName:       last,
		FullName:       strings.TrimSpace(full),
		Phone:          highLevelString(record, "phone"),
		Company:        firstString(highLevelString(record, "companyName"), highLevelString(record, "company")),
		LifecycleStage: firstString(highLevelString(record, "type"), highLevelString(record, "source")),
		ListIDs:        highLevelListIDs(integration),
		Tags:           highLevelMergeTags(integration, record),
		Properties:     props,
	}
	if updated != nil {
		out.UpdatedAt = updated
	}
	return out, true
}

func mapHighLevelOpportunityEvent(record map[string]any, contact ContactInput, integration Integration) (EventInput, bool) {
	email := strings.ToLower(strings.TrimSpace(contact.Email))
	id := highLevelRecordString(record, "id", "opportunityId", "opportunity_id")
	if email == "" || id == "" {
		return EventInput{}, false
	}
	status := strings.ToLower(highLevelRecordString(record, "status"))
	props := highLevelEventProperties("opportunity", record, integration)
	props["highlevel_opportunity_id"] = id
	props["highlevel_contact_id"] = highLevelContactReference(contact)
	props["highlevel_opportunity_name"] = highLevelRecordString(record, "name", "title")
	props["highlevel_status"] = status
	props["highlevel_monetary_value"] = highLevelRecordString(record, "monetaryValue", "monetary_value", "value")
	props["highlevel_pipeline_id"] = highLevelRecordString(record, "pipelineId", "pipeline_id")
	props["highlevel_pipeline_stage_id"] = highLevelRecordString(record, "pipelineStageId", "pipeline_stage_id")
	return EventInput{
		SourceID:   "highlevel://opportunity/" + id + "/contact/" + highLevelContactReference(contact),
		Email:      email,
		Phone:      contact.Phone,
		EventName:  highLevelOpportunityEventName(status),
		Properties: props,
		OccurredAt: highLevelRecordTime(record, "updatedAt", "dateUpdated", "lastStatusChangeAt", "lastStageChangeAt", "createdAt", "dateAdded"),
	}, true
}

func mapHighLevelAppointmentEvent(record map[string]any, contact ContactInput, integration Integration) (EventInput, bool) {
	email := strings.ToLower(strings.TrimSpace(contact.Email))
	id := highLevelRecordString(record, "id", "eventId", "appointmentId", "appointment_id")
	if email == "" || id == "" {
		return EventInput{}, false
	}
	props := highLevelEventProperties("appointment", record, integration)
	props["highlevel_appointment_id"] = id
	props["highlevel_contact_id"] = highLevelContactReference(contact)
	props["highlevel_calendar_id"] = highLevelRecordString(record, "calendarId", "calendar_id")
	props["highlevel_title"] = highLevelRecordString(record, "title", "name")
	props["highlevel_status"] = highLevelRecordString(record, "status", "appointmentStatus")
	return EventInput{
		SourceID:   "highlevel://appointment/" + id + "/contact/" + highLevelContactReference(contact),
		Email:      email,
		Phone:      contact.Phone,
		EventName:  "crm.appointment.updated",
		Properties: props,
		OccurredAt: highLevelRecordTime(record, "startTime", "start", "startAt", "updatedAt", "dateUpdated", "createdAt", "dateAdded"),
	}, true
}

func mapHighLevelConversationEvent(record map[string]any, contact ContactInput, integration Integration) (EventInput, bool) {
	email := strings.ToLower(strings.TrimSpace(contact.Email))
	id := highLevelRecordString(record, "id", "conversationId", "conversation_id")
	if email == "" || id == "" {
		return EventInput{}, false
	}
	props := highLevelEventProperties("conversation", record, integration)
	props["highlevel_conversation_id"] = id
	props["highlevel_contact_id"] = highLevelContactReference(contact)
	props["highlevel_channel"] = highLevelRecordString(record, "channel", "type")
	props["highlevel_unread_count"] = highLevelRecordString(record, "unreadCount", "unread_count")
	return EventInput{
		SourceID:   "highlevel://conversation/" + id + "/contact/" + highLevelContactReference(contact),
		Email:      email,
		Phone:      contact.Phone,
		EventName:  "crm.conversation.updated",
		Properties: props,
		OccurredAt: highLevelRecordTime(record, "lastMessageDate", "lastMessageAt", "updatedAt", "dateUpdated", "createdAt", "dateAdded"),
	}, true
}

func highLevelEventProperties(object string, record map[string]any, integration Integration) map[string]any {
	props := map[string]any{
		"highlevel_object": object,
		"highlevel_raw":    record,
	}
	if configured := highLevelListIDs(integration); len(configured) > 0 {
		props["crm_list_ids"] = configured
	}
	return props
}

func highLevelOpportunityEventName(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "won":
		return "crm.deal.won"
	case "lost", "abandoned":
		return "crm.deal.lost"
	default:
		return "crm.deal.updated"
	}
}

func highLevelContactReference(contact ContactInput) string {
	source := strings.TrimSpace(contact.SourceID)
	if strings.HasPrefix(source, "highlevel://contact/") {
		source = strings.TrimPrefix(source, "highlevel://contact/")
	}
	return firstString(source, strings.ToLower(strings.TrimSpace(contact.Email)), strings.TrimSpace(contact.Phone))
}

func highLevelNextCursor(current highLevelCursorState, resp highLevelContactsResponse) highLevelCursorState {
	current.Object = "contacts"
	startAfterID := strings.TrimSpace(resp.Meta.StartAfterID)
	startAfter := strings.TrimSpace(resp.Meta.StartAfter.String())
	if len(resp.Contacts) == 0 || startAfterID == "" {
		return highLevelCursorState{Object: "complete"}
	}
	return highLevelCursorState{Object: "contacts", StartAfterID: startAfterID, StartAfter: startAfter}
}

// highLevelLocationID resolves the GHL sub-account (location) the install is
// scoped to — captured from the OAuth token response into the credential, or
// configured on the integration.
func highLevelLocationID(creds HighLevelCredentials, integration Integration) string {
	return strings.TrimSpace(firstString(
		creds.LocationID,
		settingString(integration.Settings, "location_id"),
		settingString(integration.Settings, "locationId"),
	))
}

// highLevelMergeTags merges Moosewave's default tags with the contact's own GHL
// tags (a string array).
func highLevelMergeTags(integration Integration, record map[string]any) []string {
	tags := append([]string{"highlevel", "highlevel-contact"}, hubSpotStringListSetting(integration.Settings, "default_tags")...)
	if raw, ok := record["tags"].([]any); ok {
		for _, t := range raw {
			if s, ok := t.(string); ok && strings.TrimSpace(s) != "" {
				tags = append(tags, strings.TrimSpace(s))
			}
		}
	}
	return uniqueCRMStrings(tags)
}

func highLevelCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func normalizeHighLevelBearerToken(token string) string {
	token = strings.TrimSpace(token)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func highLevelAPIBaseURL(raw string) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		raw = highLevelDefaultAPIBaseURL
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("parse highLevel API base URL: %w", err)
	}
	if u.Scheme == "" {
		u.Scheme = "https"
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", fmt.Errorf("highLevel API base URL must be http or https")
	}
	if u.Host == "" {
		return "", fmt.Errorf("highLevel API base URL host is required")
	}
	u.RawQuery = ""
	u.Fragment = ""
	u.Path = strings.TrimRight(u.Path, "/")
	return strings.TrimRight(u.String(), "/"), nil
}

func highLevelInitialObject(_ Integration) string {
	return "contacts"
}

func highLevelPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return highLevelDefaultPageSize
	}
	if n > highLevelMaxPageSize {
		return highLevelMaxPageSize
	}
	return n
}

func highLevelContactFields(integration Integration) []string {
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

func highLevelListIDs(integration Integration) []string {
	return uniqueCRMStrings(append(
		hubSpotStringListSetting(integration.Settings, "list_ids"),
		settingString(integration.Settings, "list_id"),
		settingString(integration.Settings, "default_list_id"),
	))
}

func highLevelDefaultTags(integration Integration, tagID string) []string {
	tags := append([]string{"highLevel", "highLevel-contact"}, hubSpotStringListSetting(integration.Settings, "default_tags")...)
	if tagID = strings.TrimSpace(tagID); tagID != "" {
		tags = append(tags, "highLevel-tag-"+tagID)
	}
	return uniqueCRMStrings(tags)
}

func highLevelString(record map[string]any, key string) string {
	if record == nil {
		return ""
	}
	return highLevelAnyString(record[key])
}

func highLevelRecordString(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if out := highLevelString(record, key); out != "" {
			return out
		}
	}
	return ""
}

func highLevelNestedString(value any, key string) string {
	if typed, ok := value.(map[string]any); ok {
		return highLevelString(typed, key)
	}
	return ""
}

func highLevelFirstNestedString(value any, key string) string {
	values, ok := value.([]any)
	if !ok {
		return ""
	}
	for _, item := range values {
		if typed, ok := item.(map[string]any); ok {
			if out := highLevelString(typed, key); out != "" {
				return out
			}
		}
	}
	return ""
}

func highLevelMapValue(value any) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		return typed
	case map[string]string:
		out := make(map[string]any, len(typed))
		for key, value := range typed {
			out[key] = value
		}
		return out
	default:
		return nil
	}
}

func highLevelMapSlice(value any) []map[string]any {
	switch typed := value.(type) {
	case []map[string]any:
		return typed
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if mapped := highLevelMapValue(item); len(mapped) > 0 {
				out = append(out, mapped)
			}
		}
		return out
	default:
		return nil
	}
}

func highLevelInt(value string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(value))
	return n
}

func highLevelRecordTime(record map[string]any, keys ...string) *time.Time {
	for _, key := range keys {
		if parsed, ok := highLevelParseTime(record[key]); ok {
			return &parsed
		}
	}
	return nil
}

func highLevelParseTime(value any) (time.Time, bool) {
	switch typed := value.(type) {
	case nil:
		return time.Time{}, false
	case time.Time:
		return typed.UTC(), true
	case json.Number:
		if n, err := typed.Int64(); err == nil && n > 0 {
			return highLevelUnixishTime(n), true
		}
	case int:
		if typed > 0 {
			return highLevelUnixishTime(int64(typed)), true
		}
	case int64:
		if typed > 0 {
			return highLevelUnixishTime(typed), true
		}
	case float64:
		if typed > 0 {
			return highLevelUnixishTime(int64(typed)), true
		}
	case string:
		raw := strings.TrimSpace(typed)
		if raw == "" {
			return time.Time{}, false
		}
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
			return highLevelUnixishTime(n), true
		}
		if parsed := firstParsedHubSpotTime(raw); parsed != nil {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

func highLevelUnixishTime(value int64) time.Time {
	if value > 1_000_000_000_000 {
		return time.UnixMilli(value).UTC()
	}
	return time.Unix(value, 0).UTC()
}

func highLevelAnyString(value any) string {
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
