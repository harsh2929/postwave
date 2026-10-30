// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

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
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	cognitoFormsCursorPrefix       = "cognito_forms:"
	cognitoFormsDefaultAPIBaseURL  = "https://www.cognitoforms.com/api"
	cognitoFormsDefaultODataURL    = "https://www.cognitoforms.com/api/odata"
	cognitoFormsResponseMaxBytes   = 8 << 20
	cognitoFormsDefaultPageSize    = 25
	cognitoFormsMaxPageSize        = 50
	cognitoFormsDefaultUserAgent   = "Moosewave Cognito Forms Integration"
	cognitoFormsDefaultViewIDLabel = "view"
)

type CognitoFormsCredentials struct {
	AccessToken  string
	APIBaseURL   string
	ODataBaseURL string
	UserAgent    string
}

type CognitoFormsCredentialResolver interface {
	ResolveCognitoForms(context.Context, string, Integration) (CognitoFormsCredentials, error)
}

type CognitoFormsBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type CognitoFormsRESTBackfiller struct {
	HTTPClient   *http.Client
	Credentials  CognitoFormsCredentialResolver
	APIBaseURL   string
	ODataBaseURL string
	UserAgent    string
	PageSize     int
}

type CognitoFormsRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type CognitoFormsSecretsCredentialResolver struct {
	Secrets CognitoFormsRuntimeSecretResolver
}

func NewCognitoFormsSecretsCredentialResolver(secrets CognitoFormsRuntimeSecretResolver) *CognitoFormsSecretsCredentialResolver {
	return &CognitoFormsSecretsCredentialResolver{Secrets: secrets}
}

func (r *CognitoFormsSecretsCredentialResolver) ResolveCognitoForms(ctx context.Context, _ string, integration Integration) (CognitoFormsCredentials, error) {
	if r == nil || r.Secrets == nil {
		return CognitoFormsCredentials{}, fmt.Errorf("Cognito Forms credential resolver is not configured")
	}
	ref := cognitoFormsCredentialRef(integration)
	if ref == "" {
		return CognitoFormsCredentials{}, fmt.Errorf("Cognito Forms credentials_ref is required")
	}
	var payload cognitoFormsCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return CognitoFormsCredentials{}, fmt.Errorf("resolve Cognito Forms credentials %q: %w", ref, err)
		}
		return parseCognitoFormsCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return CognitoFormsCredentials{}, fmt.Errorf("resolve Cognito Forms credentials %q: %w", ref, err)
	}
	return parseCognitoFormsCredentialSecret(raw)
}

type cognitoFormsCredentialPayload struct {
	AccessToken  string `json:"access_token"`
	APIKey       string `json:"api_key"`
	Token        string `json:"token"`
	BearerToken  string `json:"bearer_token"`
	APIBaseURL   string `json:"api_base_url"`
	ODataBaseURL string `json:"odata_base_url"`
	UserAgent    string `json:"user_agent"`
}

func (p cognitoFormsCredentialPayload) credentials() (CognitoFormsCredentials, error) {
	token := normalizeCognitoFormsBearerToken(firstString(p.AccessToken, p.APIKey, p.Token, p.BearerToken))
	if token == "" {
		return CognitoFormsCredentials{}, fmt.Errorf("Cognito Forms access_token or api_key is required")
	}
	return CognitoFormsCredentials{
		AccessToken:  token,
		APIBaseURL:   strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		ODataBaseURL: strings.TrimRight(strings.TrimSpace(p.ODataBaseURL), "/"),
		UserAgent:    strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseCognitoFormsCredentialSecret(raw string) (CognitoFormsCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return CognitoFormsCredentials{}, fmt.Errorf("Cognito Forms credentials are empty")
	}
	var payload cognitoFormsCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return CognitoFormsCredentials{}, fmt.Errorf("parse Cognito Forms credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseCognitoFormsKeyValueSecret(raw).credentials()
	}
	return cognitoFormsCredentialPayload{AccessToken: raw}.credentials()
}

func parseCognitoFormsKeyValueSecret(raw string) cognitoFormsCredentialPayload {
	var payload cognitoFormsCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token":
			payload.AccessToken = value
		case "api_key":
			payload.APIKey = value
		case "token":
			payload.Token = value
		case "bearer_token":
			payload.BearerToken = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "odata_base_url":
			payload.ODataBaseURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func normalizeCognitoFormsBearerToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func cognitoFormsCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b CognitoFormsRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderCognitoForms {
		return SyncRequest{}, fmt.Errorf("Cognito Forms backfill requires a Cognito Forms integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("Cognito Forms credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("Cognito Forms form_id is required")
	}
	viewID := strings.TrimSpace(firstString(settingString(integration.Settings, "view_id"), settingString(integration.Settings, "entry_view_id")))
	if viewID == "" {
		return SyncRequest{}, fmt.Errorf("Cognito Forms view_id is required")
	}
	creds, err := b.Credentials.ResolveCognitoForms(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("Cognito Forms access token is required")
	}
	state, err := decodeCognitoFormsCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.FormID != "" && state.FormID != formID {
		state = cognitoFormsCursorState{}
	}
	if state.ViewID != "" && state.ViewID != viewID {
		state = cognitoFormsCursorState{}
	}
	client := leadEgressClient(b.HTTPClient, ProviderCognitoForms, 30*time.Second)
	apiBaseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), cognitoFormsDefaultAPIBaseURL), "/")
	odataBaseURL := strings.TrimRight(firstString(b.ODataBaseURL, creds.ODataBaseURL, settingString(integration.Settings, "odata_base_url"), cognitoFormsODataBaseFromAPI(apiBaseURL), cognitoFormsDefaultODataURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), cognitoFormsDefaultUserAgent)
	pageSize := cognitoFormsPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	form, err := fetchCognitoFormsForm(ctx, client, odataBaseURL, creds.AccessToken, userAgent, formID)
	if err != nil {
		return SyncRequest{}, err
	}
	fields, err := fetchCognitoFormsSchemaFields(ctx, client, apiBaseURL, creds.AccessToken, userAgent, formID)
	if err != nil {
		return SyncRequest{}, err
	}
	ids, totalCount, err := fetchCognitoFormsEntryIDs(ctx, client, odataBaseURL, creds.AccessToken, userAgent, formID, viewID)
	if err != nil {
		return SyncRequest{}, err
	}
	pending := cognitoFormsIDsAfter(ids, state.LastID)
	if len(pending) > pageSize {
		pending = pending[:pageSize]
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(pending))}
	lastID := state.LastID
	for _, id := range pending {
		entry, err := fetchCognitoFormsEntry(ctx, client, apiBaseURL, creds.AccessToken, userAgent, formID, id.Raw)
		if err != nil {
			return SyncRequest{}, err
		}
		submission := mapCognitoFormsEntry(entry, form, fields, integration, formID, viewID, apiBaseURL)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
		lastID = id.Raw
	}
	req.Cursor = encodeCognitoFormsCursor(cognitoFormsCursorState{
		FormID:     formID,
		ViewID:     viewID,
		LastID:     lastID,
		TotalCount: firstNonZero(totalCount, len(ids)),
	})
	return req, nil
}

type cognitoFormsCursorState struct {
	FormID     string `json:"form_id,omitempty"`
	ViewID     string `json:"view_id,omitempty"`
	LastID     string `json:"last_id,omitempty"`
	TotalCount int    `json:"total_count,omitempty"`
}

func decodeCognitoFormsCursor(cursor string) (cognitoFormsCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return cognitoFormsCursorState{}, nil
	}
	if !strings.HasPrefix(cursor, cognitoFormsCursorPrefix) {
		return cognitoFormsCursorState{}, fmt.Errorf("invalid Cognito Forms cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, cognitoFormsCursorPrefix))
	if raw == "" {
		return cognitoFormsCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return cognitoFormsCursorState{}, fmt.Errorf("invalid Cognito Forms cursor")
	}
	var out cognitoFormsCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return cognitoFormsCursorState{}, fmt.Errorf("invalid Cognito Forms cursor")
	}
	out.FormID = strings.TrimSpace(out.FormID)
	out.ViewID = strings.TrimSpace(out.ViewID)
	out.LastID = strings.TrimSpace(out.LastID)
	if out.TotalCount < 0 {
		out.TotalCount = 0
	}
	return out, nil
}

func encodeCognitoFormsCursor(state cognitoFormsCursorState) string {
	state.FormID = strings.TrimSpace(state.FormID)
	state.ViewID = strings.TrimSpace(state.ViewID)
	state.LastID = strings.TrimSpace(state.LastID)
	if state.TotalCount < 0 {
		state.TotalCount = 0
	}
	raw, _ := json.Marshal(state)
	return cognitoFormsCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type cognitoFormsForm struct {
	ID           string
	Name         string
	InternalName string
	Raw          map[string]any
}

type cognitoFormsField struct {
	Key  string
	Name string
	Type string
	Raw  map[string]any
}

type cognitoFormsEntryID struct {
	Raw     string
	Numeric int64
	IsInt   bool
}

type cognitoFormsEntry struct {
	ID            string
	Entry         map[string]any
	Values        map[string]any
	DateCreated   string
	DateSubmitted string
	DateUpdated   string
	Timestamp     string
	Status        string
	Number        string
	UserEmail     string
	UserName      string
	Raw           map[string]any
}

func fetchCognitoFormsForm(ctx context.Context, client *http.Client, odataBaseURL, token, userAgent, formID string) (cognitoFormsForm, error) {
	raw, _, err := cognitoFormsDoRaw(ctx, client, odataBaseURL, token, userAgent, http.MethodGet, cognitoFormsODataFormPath(formID), nil)
	if err != nil {
		return cognitoFormsForm{}, err
	}
	var payload map[string]any
	if err := decodeCognitoFormsJSON(raw, &payload); err != nil {
		return cognitoFormsForm{}, fmt.Errorf("decode Cognito Forms form: %w", err)
	}
	return cognitoFormsForm{
		ID:           cognitoFormsFindString(payload, "Id", "id"),
		Name:         cognitoFormsFindString(payload, "Name", "name"),
		InternalName: cognitoFormsFindString(payload, "InternalName", "internalName", "internal_name"),
		Raw:          nonNilMap(payload),
	}, nil
}

func fetchCognitoFormsSchemaFields(ctx context.Context, client *http.Client, apiBaseURL, token, userAgent, formID string) (map[string]cognitoFormsField, error) {
	query := url.Values{}
	query.Set("input", "false")
	query.Set("includeLinks", "false")
	raw, _, err := cognitoFormsDoRaw(ctx, client, apiBaseURL, token, userAgent, http.MethodGet, cognitoFormsRESTPath("forms", formID, "schema"), query)
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := decodeCognitoFormsJSON(raw, &payload); err != nil {
		return nil, fmt.Errorf("decode Cognito Forms schema: %w", err)
	}
	fields := map[string]cognitoFormsField{}
	cognitoFormsCollectSchemaFields(fields, payload)
	return fields, nil
}

func fetchCognitoFormsEntryIDs(ctx context.Context, client *http.Client, odataBaseURL, token, userAgent, formID, viewID string) ([]cognitoFormsEntryID, int, error) {
	query := url.Values{}
	query.Set("$select", "Id")
	query.Set("$count", "true")
	raw, _, err := cognitoFormsDoRaw(ctx, client, odataBaseURL, token, userAgent, http.MethodGet, cognitoFormsODataEntriesPath(formID, viewID), query)
	if err != nil {
		return nil, 0, err
	}
	var payload map[string]any
	if err := decodeCognitoFormsJSON(raw, &payload); err != nil {
		return nil, 0, fmt.Errorf("decode Cognito Forms entry ids: %w", err)
	}
	ids := []cognitoFormsEntryID{}
	if values, ok := payload["value"].([]any); ok {
		for _, value := range values {
			if item, ok := value.(map[string]any); ok {
				if id := parseCognitoFormsEntryID(item["Id"]); id.Raw != "" {
					ids = append(ids, id)
				}
			}
		}
	}
	ids = dedupeCognitoFormsEntryIDs(ids)
	sort.SliceStable(ids, func(i, j int) bool {
		if ids[i].IsInt && ids[j].IsInt {
			return ids[i].Numeric < ids[j].Numeric
		}
		return ids[i].Raw < ids[j].Raw
	})
	return ids, cognitoFormsInt(payload["@odata.count"]), nil
}

func fetchCognitoFormsEntry(ctx context.Context, client *http.Client, apiBaseURL, token, userAgent, formID, entryID string) (cognitoFormsEntry, error) {
	raw, _, err := cognitoFormsDoRaw(ctx, client, apiBaseURL, token, userAgent, http.MethodGet, cognitoFormsRESTPath("forms", formID, "entries", entryID), nil)
	if err != nil {
		return cognitoFormsEntry{}, err
	}
	var payload map[string]any
	if err := decodeCognitoFormsJSON(raw, &payload); err != nil {
		return cognitoFormsEntry{}, fmt.Errorf("decode Cognito Forms entry: %w", err)
	}
	return parseCognitoFormsEntry(payload), nil
}

func parseCognitoFormsEntry(payload map[string]any) cognitoFormsEntry {
	entryMeta, _ := payload["Entry"].(map[string]any)
	out := cognitoFormsEntry{
		ID:     cognitoFormsFindString(payload, "Id", "id"),
		Entry:  nonNilMap(entryMeta),
		Values: map[string]any{},
		Raw:    nonNilMap(payload),
	}
	out.DateCreated = cognitoFormsFindString(entryMeta, "DateCreated", "date_created")
	out.DateSubmitted = cognitoFormsFindString(entryMeta, "DateSubmitted", "date_submitted")
	out.DateUpdated = cognitoFormsFindString(entryMeta, "DateUpdated", "date_updated")
	out.Timestamp = cognitoFormsFindString(entryMeta, "Timestamp", "timestamp")
	out.Status = cognitoFormsFindString(entryMeta, "Status", "status")
	out.Number = cognitoFormsFindString(entryMeta, "Number", "number")
	if user, ok := entryMeta["User"].(map[string]any); ok {
		out.UserEmail = cognitoFormsFindString(user, "Email", "email")
		out.UserName = cognitoFormsFindString(user, "Name", "name")
	}
	for key, value := range payload {
		if cognitoFormsReservedEntryKey(key) {
			continue
		}
		out.Values[key] = cognitoFormsNormalizeValue(value)
	}
	return out
}

func cognitoFormsDoRaw(ctx context.Context, client *http.Client, baseURL, token, userAgent, method, pathValue string, query url.Values) ([]byte, http.Header, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + pathValue)
	if err != nil {
		return nil, nil, err
	}
	if query != nil && len(query) > 0 {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, cognitoFormsDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, cognitoFormsResponseMaxBytes)
	if err != nil {
		return nil, nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, resp.Header, CognitoFormsProviderError{Path: pathValue, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: cognitoFormsResponseSnippet(raw)}
	}
	return raw, resp.Header, nil
}

type CognitoFormsProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e CognitoFormsProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("Cognito Forms API %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("Cognito Forms API %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapCognitoFormsEntry(item cognitoFormsEntry, form cognitoFormsForm, fieldsByKey map[string]cognitoFormsField, integration Integration, formID, viewID, apiBaseURL string) SubmissionInput {
	entryID := firstString(item.ID, settingString(integration.Settings, "entry_id"))
	formName := firstString(settingString(integration.Settings, "form_name"), form.Name, form.InternalName)
	fields := map[string]any{
		"cognito_forms_entry_id":       entryID,
		"cognito_forms_form_id":        formID,
		"cognito_forms_view_id":        viewID,
		"cognito_forms_api_base_url":   strings.TrimRight(apiBaseURL, "/"),
		"cognito_forms_date_created":   item.DateCreated,
		"cognito_forms_date_submitted": item.DateSubmitted,
		"cognito_forms_date_updated":   item.DateUpdated,
		"cognito_forms_timestamp":      item.Timestamp,
		"cognito_forms_status":         item.Status,
		"cognito_forms_number":         item.Number,
		"cognito_forms_user_email":     item.UserEmail,
		"cognito_forms_user_name":      item.UserName,
		"cognito_forms_entry_metadata": item.Entry,
		"cognito_forms_provider_raw":   item.Raw,
	}
	if formName != "" {
		fields["cognito_forms_form_name"] = formName
	}
	if form.InternalName != "" {
		fields["cognito_forms_internal_form_name"] = form.InternalName
	}
	identity := typeformIdentity{}
	keys := make([]string, 0, len(item.Values))
	for key := range item.Values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := item.Values[key]
		field := cognitoFormsFieldForKey(fieldsByKey, key)
		label := firstString(field.Name, key)
		normalizedKey := normalizeTypeformIdentityKey(label)
		if normalizedKey == "" {
			normalizedKey = normalizeTypeformIdentityKey(key)
		}
		fields["cognito_forms_field."+normalizedKey] = value
		fields["cognito_forms_field_key."+normalizedKey] = key
		if field.Type != "" {
			fields["cognito_forms_field_type."+normalizedKey] = field.Type
		}
		applyCognitoFormsIdentity(&identity, integration, key, label, value)
	}
	if identity.Email == "" && item.UserEmail != "" {
		identity.Email = item.UserEmail
	}
	if identity.FullName == "" && item.UserName != "" {
		identity.FullName = item.UserName
	}
	submittedAt := cognitoFormsSubmittedAt(firstString(item.DateSubmitted, item.Timestamp, item.DateCreated, item.DateUpdated))
	return SubmissionInput{
		SourceID:    cognitoFormsSourceID(formID, viewID, entryID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    formName,
		EventName:   "lead.submitted",
		Tags:        cognitoFormsTags(integration, formID, viewID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func cognitoFormsFieldForKey(fieldsByKey map[string]cognitoFormsField, key string) cognitoFormsField {
	for _, candidate := range []string{key, normalizeTypeformIdentityKey(key)} {
		if field, ok := fieldsByKey[strings.TrimSpace(candidate)]; ok {
			return field
		}
	}
	return cognitoFormsField{}
}

func applyCognitoFormsIdentity(identity *typeformIdentity, integration Integration, fieldKey, label string, value any) {
	if identity == nil {
		return
	}
	text := strings.TrimSpace(cognitoFormsValueText(value))
	if text == "" || text == "<nil>" {
		return
	}
	switch {
	case cognitoFormsIdentitySettingMatches(integration, fieldKey, label, "email"):
		if identity.Email == "" {
			identity.Email = text
		}
	case cognitoFormsIdentitySettingMatches(integration, fieldKey, label, "first_name"):
		if identity.FirstName == "" {
			identity.FirstName = text
		}
	case cognitoFormsIdentitySettingMatches(integration, fieldKey, label, "last_name"):
		if identity.LastName == "" {
			identity.LastName = text
		}
	case cognitoFormsIdentitySettingMatches(integration, fieldKey, label, "full_name"):
		if identity.FullName == "" {
			identity.FullName = text
		}
	case cognitoFormsIdentitySettingMatches(integration, fieldKey, label, "phone"):
		if identity.Phone == "" {
			identity.Phone = text
		}
	case cognitoFormsIdentitySettingMatches(integration, fieldKey, label, "company"):
		if identity.Company == "" {
			identity.Company = text
		}
	}
	applyFilloutStructuredIdentity(identity, value)
	identity.apply(firstString(label, fieldKey), text)
	if fieldKey != "" {
		identity.apply(fieldKey, text)
	}
}

func cognitoFormsIdentitySettingMatches(integration Integration, fieldKey, label, prefix string) bool {
	candidates := []string{
		settingString(integration.Settings, prefix+"_field_key"),
		settingString(integration.Settings, prefix+"_field"),
		settingString(integration.Settings, prefix+"_field_name"),
	}
	values := []string{
		strings.ToLower(strings.TrimSpace(fieldKey)),
		strings.ToLower(strings.TrimSpace(label)),
		normalizeTypeformIdentityKey(fieldKey),
		normalizeTypeformIdentityKey(label),
	}
	for _, candidate := range candidates {
		candidate = strings.ToLower(strings.TrimSpace(candidate))
		if candidate == "" {
			continue
		}
		normalizedCandidate := normalizeTypeformIdentityKey(candidate)
		for _, value := range values {
			if candidate == value || normalizedCandidate == value {
				return true
			}
		}
	}
	return false
}

func cognitoFormsCollectSchemaFields(out map[string]cognitoFormsField, schema map[string]any) {
	props, ok := schema["properties"].(map[string]any)
	if !ok {
		return
	}
	for key, value := range props {
		if cognitoFormsReservedEntryKey(key) {
			continue
		}
		raw, ok := value.(map[string]any)
		if !ok {
			continue
		}
		field := cognitoFormsField{
			Key:  strings.TrimSpace(key),
			Name: firstString(cognitoFormsFindString(raw, "title", "description", "label"), strings.TrimSpace(key)),
			Type: cognitoFormsFindString(raw, "type", "format"),
			Raw:  nonNilMap(raw),
		}
		for _, candidate := range []string{field.Key, normalizeTypeformIdentityKey(field.Key), normalizeTypeformIdentityKey(field.Name)} {
			if candidate != "" {
				out[candidate] = field
			}
		}
	}
}

func cognitoFormsIDsAfter(ids []cognitoFormsEntryID, lastID string) []cognitoFormsEntryID {
	lastID = strings.TrimSpace(lastID)
	if lastID == "" {
		return append([]cognitoFormsEntryID(nil), ids...)
	}
	last := parseCognitoFormsEntryID(lastID)
	out := []cognitoFormsEntryID{}
	for _, id := range ids {
		if cognitoFormsEntryIDGreater(id, last) {
			out = append(out, id)
		}
	}
	return out
}

func cognitoFormsEntryIDGreater(id, last cognitoFormsEntryID) bool {
	if id.Raw == "" || last.Raw == "" {
		return id.Raw != ""
	}
	if id.IsInt && last.IsInt {
		return id.Numeric > last.Numeric
	}
	return id.Raw > last.Raw
}

func parseCognitoFormsEntryID(value any) cognitoFormsEntryID {
	raw := strings.TrimSpace(cognitoFormsValueText(value))
	if raw == "" || raw == "<nil>" {
		return cognitoFormsEntryID{}
	}
	if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return cognitoFormsEntryID{Raw: raw, Numeric: parsed, IsInt: true}
	}
	return cognitoFormsEntryID{Raw: raw}
}

func dedupeCognitoFormsEntryIDs(ids []cognitoFormsEntryID) []cognitoFormsEntryID {
	seen := map[string]bool{}
	out := make([]cognitoFormsEntryID, 0, len(ids))
	for _, id := range ids {
		if id.Raw == "" || seen[id.Raw] {
			continue
		}
		seen[id.Raw] = true
		out = append(out, id)
	}
	return out
}

func cognitoFormsReservedEntryKey(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "", "id", "entry", "@odata.id", "@odata.context", "@odata.etag":
		return true
	default:
		return strings.HasPrefix(strings.TrimSpace(key), "@odata.")
	}
}

func cognitoFormsRESTPath(parts ...string) string {
	clean := []string{}
	for _, part := range parts {
		part = strings.Trim(strings.TrimSpace(part), "/")
		if part != "" {
			clean = append(clean, url.PathEscape(part))
		}
	}
	return "/" + strings.Join(clean, "/")
}

func cognitoFormsODataFormPath(formID string) string {
	return "/Forms(" + url.PathEscape(strings.TrimSpace(formID)) + ")"
}

func cognitoFormsODataEntriesPath(formID, viewID string) string {
	return "/Forms(" + url.PathEscape(strings.TrimSpace(formID)) + ")/Views(" + url.PathEscape(strings.TrimSpace(viewID)) + ")/Entries"
}

func cognitoFormsODataBaseFromAPI(apiBaseURL string) string {
	apiBaseURL = strings.TrimRight(strings.TrimSpace(apiBaseURL), "/")
	if apiBaseURL == "" {
		return ""
	}
	if strings.HasSuffix(apiBaseURL, "/odata") {
		return apiBaseURL
	}
	return apiBaseURL + "/odata"
}

func decodeCognitoFormsJSON(raw []byte, out any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil && err != io.EOF {
		return err
	}
	return nil
}

func cognitoFormsNormalizeValue(value any) any {
	return wpformsNormalizeValue(value)
}

func cognitoFormsValueText(value any) string {
	return wpformsValueText(value)
}

func cognitoFormsFindString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		text := strings.TrimSpace(cognitoFormsValueText(values[key]))
		if text != "" && text != "<nil>" {
			return text
		}
	}
	return ""
}

func cognitoFormsSubmittedAt(raw string) *time.Time {
	return wpformsSubmittedAt(raw)
}

func cognitoFormsPageSize(size int) int {
	if size <= 0 {
		return cognitoFormsDefaultPageSize
	}
	if size > cognitoFormsMaxPageSize {
		return cognitoFormsMaxPageSize
	}
	return size
}

func cognitoFormsInt(value any) int {
	switch typed := value.(type) {
	case json.Number:
		parsed, _ := typed.Int64()
		if parsed > 0 {
			return int(parsed)
		}
	case float64:
		if typed > 0 {
			return int(typed)
		}
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(typed))
		if parsed > 0 {
			return parsed
		}
	}
	return 0
}

func cognitoFormsSourceID(formID, viewID, entryID string) string {
	entryID = strings.TrimSpace(entryID)
	if entryID == "" {
		return ""
	}
	return "cognito-forms://entry/" + strings.TrimSpace(formID) + "/" + firstString(strings.TrimSpace(viewID), cognitoFormsDefaultViewIDLabel) + "/" + entryID
}

func cognitoFormsTags(integration Integration, formID, viewID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"cognito-forms", "cognito-forms:" + formID, "cognito-forms:view:" + viewID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func cognitoFormsResponseSnippet(raw []byte) string {
	return truncateTypeformString(strings.TrimSpace(string(raw)), 500)
}
