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
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	formidableFormsCursorPrefix     = "formidable_forms:"
	formidableFormsResponseMaxBytes = 8 << 20
	formidableFormsDefaultPageSize  = 100
	formidableFormsMaxPageSize      = 200
	formidableFormsDefaultUserAgent = "Moosewave Formidable Forms Integration"
)

type FormidableFormsCredentials struct {
	Username  string
	Password  string
	APIKey    string
	SiteURL   string
	UserAgent string
}

type FormidableFormsCredentialResolver interface {
	ResolveFormidableForms(context.Context, string, Integration) (FormidableFormsCredentials, error)
}

type FormidableFormsBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type FormidableFormsRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials FormidableFormsCredentialResolver
	SiteURL     string
	UserAgent   string
	PageSize    int
}

type FormidableFormsRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type FormidableFormsSecretsCredentialResolver struct {
	Secrets FormidableFormsRuntimeSecretResolver
}

func NewFormidableFormsSecretsCredentialResolver(secrets FormidableFormsRuntimeSecretResolver) *FormidableFormsSecretsCredentialResolver {
	return &FormidableFormsSecretsCredentialResolver{Secrets: secrets}
}

func (r *FormidableFormsSecretsCredentialResolver) ResolveFormidableForms(ctx context.Context, _ string, integration Integration) (FormidableFormsCredentials, error) {
	if r == nil || r.Secrets == nil {
		return FormidableFormsCredentials{}, fmt.Errorf("Formidable Forms credential resolver is not configured")
	}
	ref := formidableFormsCredentialRef(integration)
	if ref == "" {
		return FormidableFormsCredentials{}, fmt.Errorf("Formidable Forms credentials_ref is required")
	}
	var payload formidableFormsCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return FormidableFormsCredentials{}, fmt.Errorf("resolve Formidable Forms credentials %q: %w", ref, err)
		}
		return parseFormidableFormsCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return FormidableFormsCredentials{}, fmt.Errorf("resolve Formidable Forms credentials %q: %w", ref, err)
	}
	return parseFormidableFormsCredentialSecret(raw)
}

type formidableFormsCredentialPayload struct {
	Username            string `json:"username"`
	Password            string `json:"password"`
	ApplicationPassword string `json:"application_password"`
	AppPassword         string `json:"app_password"`
	APIKey              string `json:"api_key"`
	Key                 string `json:"key"`
	SiteURL             string `json:"site_url"`
	UserAgent           string `json:"user_agent"`
}

func (p formidableFormsCredentialPayload) credentials() (FormidableFormsCredentials, error) {
	username := strings.TrimSpace(p.Username)
	password := strings.TrimSpace(firstString(p.ApplicationPassword, p.AppPassword, p.Password))
	apiKey := strings.TrimSpace(firstString(p.APIKey, p.Key))
	if (username == "" || password == "") && apiKey == "" {
		return FormidableFormsCredentials{}, fmt.Errorf("Formidable Forms username/application_password or api_key is required")
	}
	return FormidableFormsCredentials{
		Username:  username,
		Password:  password,
		APIKey:    apiKey,
		SiteURL:   strings.TrimRight(strings.TrimSpace(p.SiteURL), "/"),
		UserAgent: strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseFormidableFormsCredentialSecret(raw string) (FormidableFormsCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return FormidableFormsCredentials{}, fmt.Errorf("Formidable Forms credentials are empty")
	}
	var payload formidableFormsCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return FormidableFormsCredentials{}, fmt.Errorf("parse Formidable Forms credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseFormidableFormsKeyValueSecret(raw).credentials()
	}
	return FormidableFormsCredentials{}, fmt.Errorf("Formidable Forms credentials must include username/application_password or api_key")
}

func parseFormidableFormsKeyValueSecret(raw string) formidableFormsCredentialPayload {
	var payload formidableFormsCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "username":
			payload.Username = value
		case "password":
			payload.Password = value
		case "application_password":
			payload.ApplicationPassword = value
		case "app_password":
			payload.AppPassword = value
		case "api_key":
			payload.APIKey = value
		case "key":
			payload.Key = value
		case "site_url":
			payload.SiteURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func formidableFormsCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b FormidableFormsRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderFormidableForms {
		return SyncRequest{}, fmt.Errorf("Formidable Forms backfill requires a Formidable Forms integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("Formidable Forms credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("Formidable Forms form_id is required")
	}
	creds, err := b.Credentials.ResolveFormidableForms(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	state, err := decodeFormidableFormsCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	client := leadEgressClient(b.HTTPClient, ProviderFormidableForms, 30*time.Second)
	siteURL := strings.TrimRight(firstString(b.SiteURL, creds.SiteURL, settingString(integration.Settings, "site_url")), "/")
	if siteURL == "" {
		return SyncRequest{}, fmt.Errorf("Formidable Forms site_url is required")
	}
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), formidableFormsDefaultUserAgent)
	namespace := formidableFormsNamespace(integration)
	pageSize := formidableFormsPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	page := state.Page
	if page <= 0 {
		page = 1
	}
	form, err := fetchFormidableFormsForm(ctx, client, siteURL, creds, userAgent, namespace, formID)
	if err != nil {
		return SyncRequest{}, err
	}
	fields, err := fetchFormidableFormsFields(ctx, client, siteURL, creds, userAgent, namespace, formID)
	if err != nil {
		return SyncRequest{}, err
	}
	pageOut, err := fetchFormidableFormsEntries(ctx, client, siteURL, creds, userAgent, namespace, formID, page, pageSize, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(pageOut.Entries))}
	for _, item := range pageOut.Entries {
		submission := mapFormidableFormsEntry(item, form, fields, integration, siteURL, formID)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	nextPage := page
	if len(pageOut.Entries) > 0 {
		nextPage = page + 1
	}
	req.Cursor = encodeFormidableFormsCursor(formidableFormsCursorState{
		Page:       nextPage,
		TotalPages: pageOut.TotalPages,
		TotalCount: pageOut.Total,
	})
	return req, nil
}

type formidableFormsCursorState struct {
	Page       int `json:"page,omitempty"`
	TotalPages int `json:"total_pages,omitempty"`
	TotalCount int `json:"total_count,omitempty"`
}

func decodeFormidableFormsCursor(cursor string) (formidableFormsCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return formidableFormsCursorState{}, nil
	}
	if !strings.HasPrefix(cursor, formidableFormsCursorPrefix) {
		return formidableFormsCursorState{}, fmt.Errorf("invalid Formidable Forms cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, formidableFormsCursorPrefix))
	if raw == "" {
		return formidableFormsCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return formidableFormsCursorState{}, fmt.Errorf("invalid Formidable Forms cursor")
	}
	var out formidableFormsCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return formidableFormsCursorState{}, fmt.Errorf("invalid Formidable Forms cursor")
	}
	if out.Page < 0 {
		out.Page = 0
	}
	if out.TotalPages < 0 {
		out.TotalPages = 0
	}
	if out.TotalCount < 0 {
		out.TotalCount = 0
	}
	return out, nil
}

func encodeFormidableFormsCursor(state formidableFormsCursorState) string {
	if state.Page < 0 {
		state.Page = 0
	}
	if state.TotalPages < 0 {
		state.TotalPages = 0
	}
	if state.TotalCount < 0 {
		state.TotalCount = 0
	}
	raw, _ := json.Marshal(state)
	return formidableFormsCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type formidableFormsForm struct {
	ID    string
	Key   string
	Name  string
	Raw   map[string]any
	Links map[string]any
}

type formidableFormsField struct {
	ID   string
	Key  string
	Name string
	Type string
	Raw  map[string]any
}

type formidableFormsEntriesResponse struct {
	Entries    []formidableFormsEntry
	Total      int
	TotalPages int
	Page       int
	PageSize   int
}

type formidableFormsEntry struct {
	ID        string
	Key       string
	FormID    string
	CreatedAt string
	UpdatedAt string
	IPAddress string
	UserID    string
	Values    []formidableFormsEntryValue
	Raw       map[string]any
}

type formidableFormsEntryValue struct {
	ID    string
	Key   string
	Name  string
	Value any
	Raw   map[string]any
}

func (f *formidableFormsForm) UnmarshalJSON(raw []byte) error {
	var payload map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&payload); err != nil {
		return err
	}
	f.Raw = nonNilMap(payload)
	f.ID = formidableFormsFindString(payload, "id", "form_id")
	f.Key = formidableFormsFindString(payload, "form_key", "key")
	f.Name = formidableFormsFindString(payload, "name", "title")
	if links, ok := payload["_links"].(map[string]any); ok {
		f.Links = nonNilMap(links)
	}
	return nil
}

func (e *formidableFormsEntry) UnmarshalJSON(raw []byte) error {
	var payload map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&payload); err != nil {
		return err
	}
	e.Raw = nonNilMap(payload)
	e.ID = formidableFormsFindString(payload, "id", "entry_id", "item_id")
	e.Key = formidableFormsFindString(payload, "item_key", "entry_key", "key")
	e.FormID = formidableFormsFindString(payload, "form_id")
	e.CreatedAt = formidableFormsFindString(payload, "created_at", "created", "date_created")
	e.UpdatedAt = formidableFormsFindString(payload, "updated_at", "modified", "date_updated")
	e.IPAddress = formidableFormsFindString(payload, "ip", "ip_address")
	e.UserID = formidableFormsFindString(payload, "user_id")
	e.Values = formidableFormsEntryValues(payload)
	return nil
}

func fetchFormidableFormsForm(ctx context.Context, client *http.Client, siteURL string, creds FormidableFormsCredentials, userAgent, namespace, formID string) (formidableFormsForm, error) {
	raw, _, err := formidableFormsDoRaw(ctx, client, siteURL, creds, userAgent, http.MethodGet, formidableFormsRESTPath(namespace, "forms", formID), nil)
	if err != nil {
		return formidableFormsForm{}, err
	}
	var form formidableFormsForm
	if err := decodeFormidableFormsResponse(raw, &form); err != nil {
		return formidableFormsForm{}, fmt.Errorf("decode Formidable Forms form: %w", err)
	}
	return form, nil
}

func fetchFormidableFormsFields(ctx context.Context, client *http.Client, siteURL string, creds FormidableFormsCredentials, userAgent, namespace, formID string) (map[string]formidableFormsField, error) {
	raw, _, err := formidableFormsDoRaw(ctx, client, siteURL, creds, userAgent, http.MethodGet, formidableFormsRESTPath(namespace, "forms", formID, "fields"), nil)
	if err != nil {
		return nil, err
	}
	fields := map[string]formidableFormsField{}
	if err := decodeFormidableFormsFields(raw, fields); err != nil {
		return nil, fmt.Errorf("decode Formidable Forms fields: %w", err)
	}
	return fields, nil
}

func fetchFormidableFormsEntries(ctx context.Context, client *http.Client, siteURL string, creds FormidableFormsCredentials, userAgent, namespace, formID string, page, pageSize int, integration Integration) (formidableFormsEntriesResponse, error) {
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("page_size", strconv.Itoa(formidableFormsPageSize(pageSize)))
	query.Set("order", firstString(settingString(integration.Settings, "order"), settingString(integration.Settings, "sort_direction"), "ASC"))
	query.Set("order_by", firstString(settingString(integration.Settings, "order_by"), settingString(integration.Settings, "sort_key"), "id"))
	if search := strings.TrimSpace(settingString(integration.Settings, "search")); search != "" {
		query.Set("search", search)
	}
	raw, headers, err := formidableFormsDoRaw(ctx, client, siteURL, creds, userAgent, http.MethodGet, formidableFormsRESTPath(namespace, "forms", formID, "entries"), query)
	if err != nil {
		return formidableFormsEntriesResponse{}, err
	}
	var entries []formidableFormsEntry
	if err := decodeFormidableFormsResponse(raw, &entries); err != nil {
		return formidableFormsEntriesResponse{}, fmt.Errorf("decode Formidable Forms entries: %w", err)
	}
	total := formidableFormsHeaderInt(headers, "X-WP-Total")
	totalPages := formidableFormsHeaderInt(headers, "X-WP-TotalPages")
	if total < len(entries) {
		total = len(entries)
	}
	return formidableFormsEntriesResponse{
		Entries:    entries,
		Total:      total,
		TotalPages: totalPages,
		Page:       page,
		PageSize:   formidableFormsPageSize(pageSize),
	}, nil
}

func formidableFormsDoRaw(ctx context.Context, client *http.Client, siteURL string, creds FormidableFormsCredentials, userAgent, method, pathValue string, query url.Values) ([]byte, http.Header, error) {
	u, err := url.Parse(strings.TrimRight(siteURL, "/") + pathValue)
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
	username, password := creds.authPair()
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(username+":"+password)))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, formidableFormsDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, formidableFormsResponseMaxBytes)
	if err != nil {
		return nil, nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, resp.Header, FormidableFormsProviderError{Path: pathValue, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: formidableFormsResponseSnippet(raw)}
	}
	return raw, resp.Header, nil
}

func (c FormidableFormsCredentials) authPair() (string, string) {
	if strings.TrimSpace(c.APIKey) != "" {
		return strings.TrimSpace(c.APIKey), firstString(strings.TrimSpace(c.Password), "x")
	}
	return strings.TrimSpace(c.Username), strings.TrimSpace(c.Password)
}

func decodeFormidableFormsResponse(raw []byte, out any) error {
	var wrapper map[string]json.RawMessage
	if err := json.Unmarshal(raw, &wrapper); err == nil {
		if data, ok := wrapper["data"]; ok && len(wrapper) == 1 {
			raw = data
		} else if result, ok := wrapper["result"]; ok && len(wrapper) == 1 {
			raw = result
		}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil && err != io.EOF {
		return err
	}
	return nil
}

func decodeFormidableFormsFields(raw []byte, out map[string]formidableFormsField) error {
	var payload any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&payload); err != nil && err != io.EOF {
		return err
	}
	switch typed := payload.(type) {
	case []any:
		for _, rawField := range typed {
			addFormidableFormsField(out, rawField, "")
		}
	case map[string]any:
		for key, rawField := range typed {
			addFormidableFormsField(out, rawField, key)
		}
	}
	return nil
}

func addFormidableFormsField(out map[string]formidableFormsField, raw any, fallbackKey string) {
	field := parseFormidableFormsField(raw)
	if field.Key == "" {
		field.Key = strings.TrimSpace(fallbackKey)
	}
	for _, key := range []string{field.ID, field.Key, normalizeTypeformIdentityKey(field.Name)} {
		key = strings.TrimSpace(key)
		if key != "" {
			out[key] = field
		}
	}
}

func parseFormidableFormsField(value any) formidableFormsField {
	raw, ok := value.(map[string]any)
	if !ok {
		return formidableFormsField{}
	}
	return formidableFormsField{
		ID:   formidableFormsFindString(raw, "id"),
		Key:  formidableFormsFindString(raw, "field_key", "key"),
		Name: formidableFormsFindString(raw, "name", "label"),
		Type: formidableFormsFindString(raw, "type", "data_type"),
		Raw:  nonNilMap(raw),
	}
}

type FormidableFormsProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e FormidableFormsProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("Formidable Forms REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("Formidable Forms REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapFormidableFormsEntry(item formidableFormsEntry, form formidableFormsForm, fieldsByKey map[string]formidableFormsField, integration Integration, siteURL, fallbackFormID string) SubmissionInput {
	formID := firstString(item.FormID, form.ID, fallbackFormID, settingString(integration.Settings, "form_id"))
	formName := firstString(settingString(integration.Settings, "form_name"), form.Name)
	fields := map[string]any{
		"formidable_forms_entry_id":     item.ID,
		"formidable_forms_entry_key":    item.Key,
		"formidable_forms_form_id":      formID,
		"formidable_forms_form_key":     form.Key,
		"formidable_forms_site_url":     strings.TrimRight(siteURL, "/"),
		"formidable_forms_created_at":   item.CreatedAt,
		"formidable_forms_updated_at":   item.UpdatedAt,
		"formidable_forms_ip_address":   item.IPAddress,
		"formidable_forms_user_id":      item.UserID,
		"formidable_forms_provider_raw": item.Raw,
	}
	if formName != "" {
		fields["formidable_forms_form_name"] = formName
	}
	identity := typeformIdentity{}
	for _, value := range item.Values {
		field := formidableFormsFieldForValue(fieldsByKey, value)
		label := firstString(value.Name, field.Name, value.Key, value.ID)
		normalizedKey := normalizeTypeformIdentityKey(label)
		normalizedValue := formidableFormsNormalizeValue(value.Value)
		fields["formidable_forms_field."+normalizedKey] = normalizedValue
		fields["formidable_forms_field_id."+normalizedKey] = firstString(value.ID, field.ID)
		fields["formidable_forms_field_key."+normalizedKey] = firstString(value.Key, field.Key)
		fields["formidable_forms_field_type."+normalizedKey] = field.Type
		applyFormidableFormsIdentity(&identity, integration, value.ID, value.Key, label, normalizedValue)
	}
	submittedAt := formidableFormsSubmittedAt(item.CreatedAt)
	return SubmissionInput{
		SourceID:    formidableFormsSourceID(siteURL, formID, item.ID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    formName,
		EventName:   "lead.submitted",
		Tags:        formidableFormsTags(integration, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func formidableFormsFieldForValue(fieldsByKey map[string]formidableFormsField, value formidableFormsEntryValue) formidableFormsField {
	for _, key := range []string{value.ID, value.Key, normalizeTypeformIdentityKey(value.Name)} {
		if field, ok := fieldsByKey[strings.TrimSpace(key)]; ok {
			return field
		}
	}
	return formidableFormsField{}
}

func applyFormidableFormsIdentity(identity *typeformIdentity, integration Integration, fieldID, fieldKey, label string, value any) {
	if identity == nil {
		return
	}
	text := strings.TrimSpace(formidableFormsValueText(value))
	if text == "" || text == "<nil>" {
		return
	}
	switch {
	case formidableFormsIdentitySettingMatches(integration, fieldID, fieldKey, label, "email"):
		if identity.Email == "" {
			identity.Email = text
		}
	case formidableFormsIdentitySettingMatches(integration, fieldID, fieldKey, label, "first_name"):
		if identity.FirstName == "" {
			identity.FirstName = text
		}
	case formidableFormsIdentitySettingMatches(integration, fieldID, fieldKey, label, "last_name"):
		if identity.LastName == "" {
			identity.LastName = text
		}
	case formidableFormsIdentitySettingMatches(integration, fieldID, fieldKey, label, "full_name"):
		if identity.FullName == "" {
			identity.FullName = text
		}
	case formidableFormsIdentitySettingMatches(integration, fieldID, fieldKey, label, "phone"):
		if identity.Phone == "" {
			identity.Phone = text
		}
	case formidableFormsIdentitySettingMatches(integration, fieldID, fieldKey, label, "company"):
		if identity.Company == "" {
			identity.Company = text
		}
	}
	applyFilloutStructuredIdentity(identity, value)
	identity.apply(firstString(label, fieldKey, fieldID), text)
	if fieldKey != "" {
		identity.apply(fieldKey, text)
	}
	if fieldID != "" {
		identity.apply(fieldID, text)
	}
}

func formidableFormsIdentitySettingMatches(integration Integration, fieldID, fieldKey, label, prefix string) bool {
	candidates := []string{
		settingString(integration.Settings, prefix+"_field_id"),
		settingString(integration.Settings, prefix+"_field_key"),
		settingString(integration.Settings, prefix+"_field"),
		settingString(integration.Settings, prefix+"_field_name"),
	}
	values := []string{
		strings.ToLower(strings.TrimSpace(fieldID)),
		strings.ToLower(strings.TrimSpace(fieldKey)),
		strings.ToLower(strings.TrimSpace(label)),
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

func formidableFormsEntryValues(payload map[string]any) []formidableFormsEntryValue {
	for _, key := range []string{"metas", "meta", "item_meta", "values", "fields"} {
		if values := formidableFormsEntryValuesFrom(payload[key]); len(values) > 0 {
			return values
		}
	}
	return nil
}

func formidableFormsEntryValuesFrom(value any) []formidableFormsEntryValue {
	out := []formidableFormsEntryValue{}
	switch typed := value.(type) {
	case []any:
		for _, raw := range typed {
			if parsed := parseFormidableFormsEntryValue(raw, ""); parsed.ID != "" || parsed.Key != "" || parsed.Name != "" {
				out = append(out, parsed)
			}
		}
	case map[string]any:
		for key, raw := range typed {
			if parsed := parseFormidableFormsEntryValue(raw, key); parsed.ID != "" || parsed.Key != "" || parsed.Name != "" {
				out = append(out, parsed)
			}
		}
	}
	return out
}

func parseFormidableFormsEntryValue(value any, fallbackKey string) formidableFormsEntryValue {
	raw, ok := value.(map[string]any)
	if !ok {
		return formidableFormsEntryValue{
			Key:   strings.TrimSpace(fallbackKey),
			Value: formidableFormsNormalizeValue(value),
		}
	}
	return formidableFormsEntryValue{
		ID:    formidableFormsFindString(raw, "id", "field_id"),
		Key:   firstString(formidableFormsFindString(raw, "field_key", "key"), strings.TrimSpace(fallbackKey)),
		Name:  formidableFormsFindString(raw, "name", "label"),
		Value: formidableFormsNormalizeValue(formidableFormsFirstNonNil(raw["value"], raw["raw_value"], raw["val"])),
		Raw:   nonNilMap(raw),
	}
}

func formidableFormsNamespace(integration Integration) string {
	namespace := strings.Trim(strings.TrimSpace(settingString(integration.Settings, "plugin_namespace")), "/")
	if namespace == "" {
		namespace = "frm/v2"
	}
	return namespace
}

func formidableFormsRESTPath(namespace string, parts ...string) string {
	clean := []string{"wp-json", strings.Trim(strings.TrimSpace(namespace), "/")}
	for _, part := range parts {
		part = strings.Trim(strings.TrimSpace(part), "/")
		if part != "" {
			clean = append(clean, url.PathEscape(part))
		}
	}
	return "/" + strings.Join(clean, "/")
}

func formidableFormsFirstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func formidableFormsNormalizeValue(value any) any {
	return wpformsNormalizeValue(value)
}

func formidableFormsValueText(value any) string {
	return wpformsValueText(value)
}

func formidableFormsFindString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		text := strings.TrimSpace(formidableFormsValueText(values[key]))
		if text != "" && text != "<nil>" {
			return text
		}
	}
	return ""
}

func formidableFormsSubmittedAt(raw string) *time.Time {
	return wpformsSubmittedAt(raw)
}

func formidableFormsPageSize(size int) int {
	if size <= 0 {
		return formidableFormsDefaultPageSize
	}
	if size > formidableFormsMaxPageSize {
		return formidableFormsMaxPageSize
	}
	return size
}

func formidableFormsHeaderInt(headers http.Header, key string) int {
	value := strings.TrimSpace(headers.Get(key))
	if value == "" {
		return 0
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

func formidableFormsSourceID(siteURL, formID, entryID string) string {
	entryID = strings.TrimSpace(entryID)
	if entryID == "" {
		return ""
	}
	host := "wordpress-site"
	if parsed, err := url.Parse(strings.TrimSpace(siteURL)); err == nil && parsed.Host != "" {
		host = parsed.Host
	}
	return "formidable-forms://entry/" + host + "/" + formID + "/" + entryID
}

func formidableFormsTags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"formidable-forms", "formidable-forms:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func formidableFormsResponseSnippet(raw []byte) string {
	return truncateTypeformString(strings.TrimSpace(string(raw)), 500)
}
