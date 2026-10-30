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
	wpformsCursorPrefix     = "wpforms:"
	wpformsResponseMaxBytes = 8 << 20
	wpformsDefaultPageSize  = 100
	wpformsMaxPageSize      = 100
	wpformsDefaultUserAgent = "Moosewave WPForms Integration"
)

type WPFormsCredentials struct {
	Username  string
	Password  string
	SiteURL   string
	UserAgent string
}

type WPFormsCredentialResolver interface {
	ResolveWPForms(context.Context, string, Integration) (WPFormsCredentials, error)
}

type WPFormsBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type WPFormsRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials WPFormsCredentialResolver
	SiteURL     string
	UserAgent   string
	PageSize    int
}

type WPFormsRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type WPFormsSecretsCredentialResolver struct {
	Secrets WPFormsRuntimeSecretResolver
}

func NewWPFormsSecretsCredentialResolver(secrets WPFormsRuntimeSecretResolver) *WPFormsSecretsCredentialResolver {
	return &WPFormsSecretsCredentialResolver{Secrets: secrets}
}

func (r *WPFormsSecretsCredentialResolver) ResolveWPForms(ctx context.Context, _ string, integration Integration) (WPFormsCredentials, error) {
	if r == nil || r.Secrets == nil {
		return WPFormsCredentials{}, fmt.Errorf("WPForms credential resolver is not configured")
	}
	ref := wpformsCredentialRef(integration)
	if ref == "" {
		return WPFormsCredentials{}, fmt.Errorf("WPForms credentials_ref is required")
	}
	var payload wpformsCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return WPFormsCredentials{}, fmt.Errorf("resolve WPForms credentials %q: %w", ref, err)
		}
		return parseWPFormsCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return WPFormsCredentials{}, fmt.Errorf("resolve WPForms credentials %q: %w", ref, err)
	}
	return parseWPFormsCredentialSecret(raw)
}

type wpformsCredentialPayload struct {
	Username            string `json:"username"`
	Password            string `json:"password"`
	ApplicationPassword string `json:"application_password"`
	AppPassword         string `json:"app_password"`
	SiteURL             string `json:"site_url"`
	UserAgent           string `json:"user_agent"`
}

func (p wpformsCredentialPayload) credentials() (WPFormsCredentials, error) {
	username := strings.TrimSpace(p.Username)
	password := strings.TrimSpace(firstString(p.ApplicationPassword, p.AppPassword, p.Password))
	if username == "" || password == "" {
		return WPFormsCredentials{}, fmt.Errorf("WPForms username/application_password is required")
	}
	return WPFormsCredentials{
		Username:  username,
		Password:  password,
		SiteURL:   strings.TrimRight(strings.TrimSpace(p.SiteURL), "/"),
		UserAgent: strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseWPFormsCredentialSecret(raw string) (WPFormsCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return WPFormsCredentials{}, fmt.Errorf("WPForms credentials are empty")
	}
	var payload wpformsCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return WPFormsCredentials{}, fmt.Errorf("parse WPForms credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseWPFormsKeyValueSecret(raw).credentials()
	}
	return WPFormsCredentials{}, fmt.Errorf("WPForms credentials must include username/application_password")
}

func parseWPFormsKeyValueSecret(raw string) wpformsCredentialPayload {
	var payload wpformsCredentialPayload
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
		case "site_url":
			payload.SiteURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func wpformsCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b WPFormsRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderWPForms {
		return SyncRequest{}, fmt.Errorf("WPForms backfill requires a WPForms integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("WPForms credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("WPForms form_id is required")
	}
	creds, err := b.Credentials.ResolveWPForms(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	state, err := decodeWPFormsCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	client := leadEgressClient(b.HTTPClient, ProviderWPForms, 30*time.Second)
	siteURL := strings.TrimRight(firstString(b.SiteURL, creds.SiteURL, settingString(integration.Settings, "site_url")), "/")
	if siteURL == "" {
		return SyncRequest{}, fmt.Errorf("WPForms site_url is required")
	}
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), wpformsDefaultUserAgent)
	pageSize := wpformsPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	page := state.Page
	if page <= 0 {
		page = 1
	}
	form, err := fetchWPFormsForm(ctx, client, siteURL, creds, userAgent, formID)
	if err != nil {
		return SyncRequest{}, err
	}
	pageOut, err := fetchWPFormsEntries(ctx, client, siteURL, creds, userAgent, formID, page, pageSize, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(pageOut.Entries))}
	for _, item := range pageOut.Entries {
		submission := mapWPFormsEntry(item, form, integration, siteURL, formID)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	nextPage := page
	if len(pageOut.Entries) > 0 {
		nextPage = page + 1
	}
	req.Cursor = encodeWPFormsCursor(wpformsCursorState{
		Page:       nextPage,
		TotalPages: pageOut.TotalPages,
		TotalCount: pageOut.Total,
	})
	return req, nil
}

type wpformsCursorState struct {
	Page       int `json:"page,omitempty"`
	TotalPages int `json:"total_pages,omitempty"`
	TotalCount int `json:"total_count,omitempty"`
}

func decodeWPFormsCursor(cursor string) (wpformsCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return wpformsCursorState{}, nil
	}
	if !strings.HasPrefix(cursor, wpformsCursorPrefix) {
		return wpformsCursorState{}, fmt.Errorf("invalid WPForms cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, wpformsCursorPrefix))
	if raw == "" {
		return wpformsCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return wpformsCursorState{}, fmt.Errorf("invalid WPForms cursor")
	}
	var out wpformsCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return wpformsCursorState{}, fmt.Errorf("invalid WPForms cursor")
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

func encodeWPFormsCursor(state wpformsCursorState) string {
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
	return wpformsCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type wpformsForm struct {
	ID     string
	Title  string
	Fields map[string]wpformsFormField
	Raw    map[string]any
}

type wpformsFormField struct {
	ID    string
	Type  string
	Label string
	Raw   map[string]any
}

type wpformsEntriesResponse struct {
	Entries    []wpformsEntry `json:"entries"`
	Total      int            `json:"total"`
	TotalPages int            `json:"total_pages"`
	Page       int            `json:"page"`
	Limit      int            `json:"limit"`
	FormID     any            `json:"form_id"`
}

type wpformsEntry struct {
	ID        string
	FormID    string
	Date      string
	Modified  string
	Status    string
	Viewed    bool
	Starred   bool
	IPAddress string
	Fields    []wpformsEntryField
	Raw       map[string]any
}

type wpformsEntryField struct {
	ID    string
	Name  string
	Type  string
	Value any
	Raw   map[string]any
}

func (e *wpformsEntry) UnmarshalJSON(raw []byte) error {
	var payload map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&payload); err != nil {
		return err
	}
	e.Raw = nonNilMap(payload)
	e.ID = wpformsFindString(payload, "id", "entry_id")
	e.FormID = wpformsFindString(payload, "form_id")
	e.Date = wpformsFindString(payload, "date", "date_created", "created")
	e.Modified = wpformsFindString(payload, "modified", "date_modified", "date_updated")
	e.Status = wpformsFindString(payload, "status")
	e.Viewed = wpformsBool(payload["viewed"])
	e.Starred = wpformsBool(payload["starred"])
	e.IPAddress = wpformsFindString(payload, "ip_address", "ip")
	e.Fields = wpformsEntryFields(payload["fields"])
	return nil
}

func fetchWPFormsForm(ctx context.Context, client *http.Client, siteURL string, creds WPFormsCredentials, userAgent, formID string) (wpformsForm, error) {
	query := url.Values{}
	wpformsSetInput(query, "form_id", formID)
	wpformsSetInput(query, "include_fields", "true")
	raw, err := wpformsDoAbilityRaw(ctx, client, siteURL, creds, userAgent, "wpforms/get-form", query)
	if err != nil {
		return wpformsForm{}, err
	}
	var form wpformsForm
	if err := decodeWPFormsAbilityResponse(raw, &form); err != nil {
		return wpformsForm{}, fmt.Errorf("decode WPForms form: %w", err)
	}
	return form, nil
}

func (f *wpformsForm) UnmarshalJSON(raw []byte) error {
	var payload map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&payload); err != nil {
		return err
	}
	f.Raw = nonNilMap(payload)
	f.ID = wpformsFindString(payload, "id", "form_id")
	f.Title = wpformsFindString(payload, "title", "name")
	f.Fields = wpformsFormFields(payload["fields"])
	return nil
}

func fetchWPFormsEntries(ctx context.Context, client *http.Client, siteURL string, creds WPFormsCredentials, userAgent, formID string, page, pageSize int, integration Integration) (wpformsEntriesResponse, error) {
	query := url.Values{}
	wpformsSetInput(query, "form_id", formID)
	wpformsSetInput(query, "include_fields", "true")
	wpformsSetInput(query, "limit", strconv.Itoa(wpformsPageSize(pageSize)))
	wpformsSetInput(query, "page", strconv.Itoa(page))
	wpformsSetInput(query, "orderby", firstString(settingString(integration.Settings, "orderby"), settingString(integration.Settings, "sort_key"), "entry_id"))
	wpformsSetInput(query, "order", firstString(settingString(integration.Settings, "order"), settingString(integration.Settings, "sort_direction"), "ASC"))
	for _, key := range []string{"search", "field_id", "field_value", "date_from", "date_to", "status", "type"} {
		if value := strings.TrimSpace(settingString(integration.Settings, key)); value != "" {
			wpformsSetInput(query, key, value)
		}
	}
	raw, err := wpformsDoAbilityRaw(ctx, client, siteURL, creds, userAgent, "wpforms/search-entries", query)
	if err != nil {
		return wpformsEntriesResponse{}, err
	}
	var out wpformsEntriesResponse
	if err := decodeWPFormsAbilityResponse(raw, &out); err != nil {
		return wpformsEntriesResponse{}, fmt.Errorf("decode WPForms entries: %w", err)
	}
	if out.Total < len(out.Entries) {
		out.Total = len(out.Entries)
	}
	if out.TotalPages < 0 {
		out.TotalPages = 0
	}
	return out, nil
}

func wpformsDoAbilityRaw(ctx context.Context, client *http.Client, siteURL string, creds WPFormsCredentials, userAgent, ability string, query url.Values) ([]byte, error) {
	return wpformsDoRaw(ctx, client, siteURL, creds, userAgent, http.MethodGet, "/wp-json/wp-abilities/v1/abilities/"+ability+"/run", query)
}

func wpformsDoRaw(ctx context.Context, client *http.Client, siteURL string, creds WPFormsCredentials, userAgent, method, pathValue string, query url.Values) ([]byte, error) {
	u, err := url.Parse(strings.TrimRight(siteURL, "/") + pathValue)
	if err != nil {
		return nil, err
	}
	if query != nil && len(query) > 0 {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(creds.Username)+":"+strings.TrimSpace(creds.Password))))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, wpformsDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, wpformsResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, WPFormsProviderError{Path: pathValue, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: wpformsResponseSnippet(raw)}
	}
	return raw, nil
}

func decodeWPFormsAbilityResponse(raw []byte, out any) error {
	var wrapper map[string]json.RawMessage
	if err := json.Unmarshal(raw, &wrapper); err == nil {
		if result, ok := wrapper["result"]; ok {
			raw = result
		} else if data, ok := wrapper["data"]; ok && len(wrapper) == 1 {
			raw = data
		}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil && err != io.EOF {
		return err
	}
	return nil
}

type WPFormsProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e WPFormsProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("WPForms REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("WPForms REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapWPFormsEntry(item wpformsEntry, form wpformsForm, integration Integration, siteURL, fallbackFormID string) SubmissionInput {
	formID := firstString(item.FormID, form.ID, fallbackFormID, settingString(integration.Settings, "form_id"))
	formName := firstString(settingString(integration.Settings, "form_name"), form.Title)
	fields := map[string]any{
		"wpforms_entry_id":     item.ID,
		"wpforms_form_id":      formID,
		"wpforms_site_url":     strings.TrimRight(siteURL, "/"),
		"wpforms_date":         item.Date,
		"wpforms_modified":     item.Modified,
		"wpforms_status":       item.Status,
		"wpforms_viewed":       item.Viewed,
		"wpforms_starred":      item.Starred,
		"wpforms_ip_address":   item.IPAddress,
		"wpforms_provider_raw": item.Raw,
	}
	if formName != "" {
		fields["wpforms_form_name"] = formName
	}
	identity := typeformIdentity{}
	for _, field := range item.Fields {
		label := firstString(field.Name, form.Fields[field.ID].Label, field.ID)
		normalizedKey := normalizeTypeformIdentityKey(label)
		normalizedValue := wpformsNormalizeValue(field.Value)
		fields["wpforms_field."+normalizedKey] = normalizedValue
		fields["wpforms_field_id."+normalizedKey] = field.ID
		fields["wpforms_field_type."+normalizedKey] = firstString(field.Type, form.Fields[field.ID].Type)
		applyWPFormsIdentity(&identity, integration, field.ID, label, normalizedValue)
	}
	submittedAt := wpformsSubmittedAt(item.Date)
	return SubmissionInput{
		SourceID:    wpformsSourceID(siteURL, formID, item.ID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    formName,
		EventName:   "lead.submitted",
		Tags:        wpformsTags(integration, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func applyWPFormsIdentity(identity *typeformIdentity, integration Integration, fieldID, label string, value any) {
	if identity == nil {
		return
	}
	text := strings.TrimSpace(wpformsValueText(value))
	if text == "" || text == "<nil>" {
		return
	}
	switch {
	case wpformsIdentitySettingMatches(integration, fieldID, label, "email"):
		if identity.Email == "" {
			identity.Email = text
		}
	case wpformsIdentitySettingMatches(integration, fieldID, label, "first_name"):
		if identity.FirstName == "" {
			identity.FirstName = text
		}
	case wpformsIdentitySettingMatches(integration, fieldID, label, "last_name"):
		if identity.LastName == "" {
			identity.LastName = text
		}
	case wpformsIdentitySettingMatches(integration, fieldID, label, "full_name"):
		if identity.FullName == "" {
			identity.FullName = text
		}
	case wpformsIdentitySettingMatches(integration, fieldID, label, "phone"):
		if identity.Phone == "" {
			identity.Phone = text
		}
	case wpformsIdentitySettingMatches(integration, fieldID, label, "company"):
		if identity.Company == "" {
			identity.Company = text
		}
	}
	applyFilloutStructuredIdentity(identity, value)
	identity.apply(firstString(label, fieldID), text)
	if label != fieldID {
		identity.apply(fieldID, text)
	}
}

func wpformsIdentitySettingMatches(integration Integration, fieldID, label, prefix string) bool {
	candidates := []string{
		settingString(integration.Settings, prefix+"_field_id"),
		settingString(integration.Settings, prefix+"_field"),
		settingString(integration.Settings, prefix+"_field_name"),
	}
	fieldID = strings.ToLower(strings.TrimSpace(fieldID))
	label = strings.ToLower(strings.TrimSpace(label))
	normalizedLabel := normalizeTypeformIdentityKey(label)
	for _, candidate := range candidates {
		candidate = strings.ToLower(strings.TrimSpace(candidate))
		if candidate == "" {
			continue
		}
		if candidate == fieldID || candidate == label || normalizeTypeformIdentityKey(candidate) == normalizedLabel {
			return true
		}
	}
	return false
}

func wpformsSetInput(query url.Values, key, value string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return
	}
	query.Set("input["+key+"]", value)
}

func wpformsFormFields(value any) map[string]wpformsFormField {
	out := map[string]wpformsFormField{}
	switch typed := value.(type) {
	case []any:
		for _, raw := range typed {
			if field := wpformsParseFormField(raw); field.ID != "" {
				out[field.ID] = field
			}
		}
	case map[string]any:
		for key, raw := range typed {
			field := wpformsParseFormField(raw)
			if field.ID == "" {
				field.ID = strings.TrimSpace(key)
			}
			if field.ID != "" {
				out[field.ID] = field
			}
		}
	}
	return out
}

func wpformsParseFormField(value any) wpformsFormField {
	raw, ok := value.(map[string]any)
	if !ok {
		return wpformsFormField{}
	}
	return wpformsFormField{
		ID:    wpformsFindString(raw, "id"),
		Type:  wpformsFindString(raw, "type"),
		Label: wpformsFindString(raw, "label", "name"),
		Raw:   nonNilMap(raw),
	}
}

func wpformsEntryFields(value any) []wpformsEntryField {
	out := []wpformsEntryField{}
	switch typed := value.(type) {
	case []any:
		for _, raw := range typed {
			if field := wpformsParseEntryField(raw); field.ID != "" || field.Name != "" {
				out = append(out, field)
			}
		}
	case map[string]any:
		for key, raw := range typed {
			field := wpformsParseEntryField(raw)
			if field.ID == "" {
				field.ID = strings.TrimSpace(key)
			}
			if field.ID != "" || field.Name != "" {
				out = append(out, field)
			}
		}
	}
	return out
}

func wpformsParseEntryField(value any) wpformsEntryField {
	raw, ok := value.(map[string]any)
	if !ok {
		return wpformsEntryField{Value: wpformsNormalizeValue(value)}
	}
	return wpformsEntryField{
		ID:    wpformsFindString(raw, "id", "field_id"),
		Name:  wpformsFindString(raw, "name", "label"),
		Type:  wpformsFindString(raw, "type"),
		Value: wpformsNormalizeValue(wpformsFirstNonNil(raw["value"], raw["raw_value"])),
		Raw:   nonNilMap(raw),
	}
}

func wpformsFirstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func wpformsNormalizeValue(value any) any {
	switch typed := value.(type) {
	case json.Number:
		if i, err := typed.Int64(); err == nil {
			return i
		}
		if f, err := typed.Float64(); err == nil {
			return f
		}
		return typed.String()
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, wpformsNormalizeValue(item))
		}
		if len(out) == 1 {
			return out[0]
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = wpformsNormalizeValue(item)
		}
		return out
	default:
		return typed
	}
}

func wpformsValueText(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			text := strings.TrimSpace(wpformsValueText(item))
			if text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, ", ")
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func wpformsFindString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		text := strings.TrimSpace(wpformsValueText(values[key]))
		if text != "" && text != "<nil>" {
			return text
		}
	}
	return ""
}

func wpformsBool(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true") || strings.TrimSpace(typed) == "1"
	case json.Number:
		return typed.String() == "1"
	default:
		return false
	}
}

func wpformsSubmittedAt(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05", "2006-01-02 15:04:05.000000"} {
		if parsed, err := time.Parse(layout, raw); err == nil {
			t := parsed.UTC()
			return &t
		}
	}
	return parseFilloutTime(raw)
}

func wpformsPageSize(size int) int {
	if size <= 0 {
		return wpformsDefaultPageSize
	}
	if size > wpformsMaxPageSize {
		return wpformsMaxPageSize
	}
	return size
}

func wpformsSourceID(siteURL, formID, entryID string) string {
	entryID = strings.TrimSpace(entryID)
	if entryID == "" {
		return ""
	}
	host := "wordpress-site"
	if parsed, err := url.Parse(strings.TrimSpace(siteURL)); err == nil && parsed.Host != "" {
		host = parsed.Host
	}
	return "wpforms://entry/" + host + "/" + formID + "/" + entryID
}

func wpformsTags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"wpforms", "wpforms:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func wpformsResponseSnippet(raw []byte) string {
	return truncateTypeformString(strings.TrimSpace(string(raw)), 500)
}
