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
	formstackCursorPrefix      = "formstack:"
	formstackCursorComplete    = "formstack:complete"
	formstackDefaultAPIBaseURL = "https://www.formstack.com/api/v2025"
	formstackResponseMaxBytes  = 8 << 20
	formstackDefaultPageSize   = 100
	formstackMaxPageSize       = 100
	formstackDefaultUserAgent  = "Moosewave Formstack Integration"
)

type FormstackCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type FormstackCredentialResolver interface {
	ResolveFormstack(context.Context, string, Integration) (FormstackCredentials, error)
}

type FormstackBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type FormstackRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials FormstackCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type FormstackRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type FormstackSecretsCredentialResolver struct {
	Secrets FormstackRuntimeSecretResolver
}

func NewFormstackSecretsCredentialResolver(secrets FormstackRuntimeSecretResolver) *FormstackSecretsCredentialResolver {
	return &FormstackSecretsCredentialResolver{Secrets: secrets}
}

func (r *FormstackSecretsCredentialResolver) ResolveFormstack(ctx context.Context, _ string, integration Integration) (FormstackCredentials, error) {
	if r == nil || r.Secrets == nil {
		return FormstackCredentials{}, fmt.Errorf("formstack credential resolver is not configured")
	}
	ref := formstackCredentialRef(integration)
	if ref == "" {
		return FormstackCredentials{}, fmt.Errorf("formstack credentials_ref is required")
	}
	var payload formstackCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return FormstackCredentials{}, fmt.Errorf("resolve formstack credentials %q: %w", ref, err)
		}
		return parseFormstackCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return FormstackCredentials{}, fmt.Errorf("resolve formstack credentials %q: %w", ref, err)
	}
	return parseFormstackCredentialSecret(raw)
}

type formstackCredentialPayload struct {
	AccessToken         string `json:"access_token"`
	PersonalAccessToken string `json:"personal_access_token"`
	APIKey              string `json:"api_key"`
	Token               string `json:"token"`
	BearerToken         string `json:"bearer_token"`
	APIBaseURL          string `json:"api_base_url"`
	UserAgent           string `json:"user_agent"`
}

func (p formstackCredentialPayload) credentials() (FormstackCredentials, error) {
	token := normalizeFormstackBearerToken(firstString(p.AccessToken, p.PersonalAccessToken, p.APIKey, p.Token, p.BearerToken))
	if token == "" {
		return FormstackCredentials{}, fmt.Errorf("formstack personal_access_token or access_token is required")
	}
	return FormstackCredentials{
		AccessToken: token,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseFormstackCredentialSecret(raw string) (FormstackCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return FormstackCredentials{}, fmt.Errorf("formstack credentials are empty")
	}
	var payload formstackCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return FormstackCredentials{}, fmt.Errorf("parse formstack credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseFormstackKeyValueSecret(raw).credentials()
	}
	return formstackCredentialPayload{AccessToken: raw}.credentials()
}

func parseFormstackKeyValueSecret(raw string) formstackCredentialPayload {
	var payload formstackCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token":
			payload.AccessToken = value
		case "personal_access_token", "pat":
			payload.PersonalAccessToken = value
		case "api_key":
			payload.APIKey = value
		case "token":
			payload.Token = value
		case "bearer_token":
			payload.BearerToken = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func normalizeFormstackBearerToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func formstackCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b FormstackRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderFormstack {
		return SyncRequest{}, fmt.Errorf("formstack backfill requires a Formstack integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("formstack credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("formstack form_id is required")
	}
	creds, err := b.Credentials.ResolveFormstack(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("formstack access token is required")
	}
	state, err := decodeFormstackCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: formstackCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderFormstack, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), formstackDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), formstackDefaultUserAgent)
	pageSize := formstackPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	page := state.Page
	if page <= 0 {
		page = 1
	}
	pageOut, err := fetchFormstackSubmissions(ctx, client, baseURL, creds.AccessToken, userAgent, formID, page, pageSize, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	items := pageOut.Submissions
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(items))}
	for _, item := range items {
		submission := mapFormstackSubmission(item, integration, formID)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	currentPage := pageOut.Page.PageNumber
	if currentPage <= 0 {
		currentPage = page
	}
	if pageOut.Page.TotalPages <= 0 || currentPage >= pageOut.Page.TotalPages || len(items) == 0 {
		req.Cursor = formstackCursorComplete
	} else {
		req.Cursor = encodeFormstackCursor(formstackCursorState{Page: currentPage + 1})
	}
	return req, nil
}

type formstackCursorState struct {
	Page     int  `json:"page,omitempty"`
	Complete bool `json:"complete,omitempty"`
}

func decodeFormstackCursor(cursor string) (formstackCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return formstackCursorState{Page: 1}, nil
	}
	if cursor == formstackCursorComplete {
		return formstackCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, formstackCursorPrefix) {
		return formstackCursorState{}, fmt.Errorf("invalid Formstack cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, formstackCursorPrefix))
	if raw == "" {
		return formstackCursorState{Page: 1}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return formstackCursorState{}, fmt.Errorf("invalid Formstack cursor")
	}
	var out formstackCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return formstackCursorState{}, fmt.Errorf("invalid Formstack cursor")
	}
	if out.Page <= 0 {
		out.Page = 1
	}
	return out, nil
}

func encodeFormstackCursor(state formstackCursorState) string {
	if state.Complete {
		return formstackCursorComplete
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	raw, _ := json.Marshal(state)
	return formstackCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type formstackSubmissionsResponse struct {
	Page        formstackPagination   `json:"page"`
	Submissions []formstackSubmission `json:"submissions"`
	Raw         map[string]any        `json:"-"`
}

type formstackPagination struct {
	Size          int `json:"size"`
	PageNumber    int `json:"pageNumber"`
	PageSize      int `json:"pageSize"`
	TotalElements int `json:"totalElements"`
	TotalPages    int `json:"totalPages"`
}

type formstackSubmission struct {
	ID         string               `json:"id"`
	FormID     string               `json:"formId"`
	Timestamp  string               `json:"timestamp"`
	PrettyName string               `json:"prettyName"`
	Data       []formstackFieldData `json:"data"`
	Raw        map[string]any       `json:"-"`
}

type formstackFieldData struct {
	Field           string `json:"field"`
	Label           string `json:"label"`
	Type            string `json:"type"`
	InternalLabel   string `json:"internal_label"`
	InternalLabelV2 string `json:"internalLabel"`
	Value           any    `json:"value"`
	FlatValue       string `json:"flat_value"`
	DisplayValue    string `json:"displayValue"`
	ParsedValue     any    `json:"parsedValue"`
}

func (r *formstackSubmissionsResponse) UnmarshalJSON(raw []byte) error {
	type alias formstackSubmissionsResponse
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*r = formstackSubmissionsResponse(out)
	r.Raw = nonNilMap(rawMap)
	return nil
}

func (s *formstackSubmission) UnmarshalJSON(raw []byte) error {
	var rawMap map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&rawMap); err != nil {
		return err
	}
	s.ID = formstackStringValue(rawMap["id"])
	s.FormID = formstackStringValue(rawMap["formId"])
	s.Timestamp = formstackStringValue(rawMap["timestamp"])
	s.PrettyName = formstackStringValue(rawMap["prettyName"])
	s.Data = parseFormstackSubmissionData(rawMap["data"])
	s.Raw = nonNilMap(rawMap)
	return nil
}

func parseFormstackSubmissionData(value any) []formstackFieldData {
	switch typed := value.(type) {
	case nil:
		return nil
	case []any:
		out := make([]formstackFieldData, 0, len(typed))
		for _, item := range typed {
			if m, ok := item.(map[string]any); ok {
				out = append(out, formstackFieldFromMap(m))
			}
		}
		return out
	case map[string]any:
		out := make([]formstackFieldData, 0, len(typed))
		for key, item := range typed {
			if m, ok := item.(map[string]any); ok {
				field := formstackFieldFromMap(m)
				if field.Field == "" {
					field.Field = key
				}
				out = append(out, field)
			}
		}
		return out
	default:
		return nil
	}
}

func formstackFieldFromMap(m map[string]any) formstackFieldData {
	field := formstackFieldData{
		Field:           mapString(m, "field"),
		Label:           mapString(m, "label"),
		Type:            mapString(m, "type"),
		InternalLabel:   mapString(m, "internal_label"),
		InternalLabelV2: mapString(m, "internalLabel"),
		Value:           m["value"],
		FlatValue:       mapString(m, "flat_value"),
		DisplayValue:    mapString(m, "displayValue"),
		ParsedValue:     m["parsedValue"],
	}
	return field
}

func fetchFormstackSubmissions(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, formID string, page, limit int, integration Integration) (formstackSubmissionsResponse, error) {
	query := url.Values{}
	query.Set("pageNumber", strconv.Itoa(page))
	query.Set("pageSize", strconv.Itoa(formstackPageSize(limit)))
	query.Set("order", firstString(settingString(integration.Settings, "order"), "ASC"))
	query.Set("data", firstString(settingString(integration.Settings, "data"), "true"))
	query.Set("expandData", firstString(settingString(integration.Settings, "expand_data"), settingString(integration.Settings, "expandData"), "true"))
	query.Set("prettyName", firstString(settingString(integration.Settings, "pretty_name"), settingString(integration.Settings, "prettyName"), "true"))
	query.Set("dataFormat", firstString(settingString(integration.Settings, "data_format"), settingString(integration.Settings, "dataFormat"), "legacy"))
	for _, key := range []string{"keyword", "minTime", "maxTime"} {
		if value := firstString(settingString(integration.Settings, key), settingString(integration.Settings, strings.ToLower(key))); value != "" {
			query.Set(key, value)
		}
	}
	raw, err := formstackDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, "/forms/"+url.PathEscape(formID)+"/submissions", query, nil)
	if err != nil {
		return formstackSubmissionsResponse{}, err
	}
	var out formstackSubmissionsResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return formstackSubmissionsResponse{}, fmt.Errorf("decode formstack submissions response: %w", err)
	}
	return out, nil
}

func formstackDoRaw(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, method, path string, query url.Values, body io.Reader) ([]byte, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + path)
	if err != nil {
		return nil, err
	}
	if query != nil {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, formstackDefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, formstackResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, FormstackProviderError{Path: path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: formstackResponseSnippet(raw)}
	}
	return raw, nil
}

type FormstackProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e FormstackProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("formstack REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("formstack REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapFormstackSubmission(item formstackSubmission, integration Integration, fallbackFormID string) SubmissionInput {
	formID := firstString(item.FormID, fallbackFormID, settingString(integration.Settings, "form_id"))
	fields := map[string]any{
		"formstack_submission_id": item.ID,
		"formstack_form_id":       formID,
		"formstack_timestamp":     item.Timestamp,
		"formstack_pretty_name":   item.PrettyName,
		"formstack_provider_raw":  item.Raw,
	}
	identity := typeformIdentity{}
	for _, field := range item.Data {
		key := firstString(field.InternalLabel, field.InternalLabelV2, field.Label, field.Field)
		if strings.TrimSpace(key) == "" {
			continue
		}
		value := normalizeFormstackValue(firstAny(field.FlatValue, field.DisplayValue, field.Value, field.ParsedValue))
		normalizedKey := normalizeTypeformIdentityKey(key)
		fields["formstack_field."+normalizedKey] = value
		fields["formstack_field_id."+normalizedKey] = field.Field
		fields["formstack_field_type."+normalizedKey] = field.Type
		applyFormstackIdentity(&identity, field, value)
	}
	submittedAt := parseFilloutTime(item.Timestamp)
	return SubmissionInput{
		SourceID:    formstackSourceID(formID, item.ID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(firstString(identity.FullName, item.PrettyName)),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    settingString(integration.Settings, "form_name"),
		EventName:   "lead.submitted",
		Tags:        formstackTags(integration, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func applyFormstackIdentity(identity *typeformIdentity, field formstackFieldData, value any) {
	if identity == nil {
		return
	}
	applyFilloutStructuredIdentity(identity, value)
	text := strings.TrimSpace(fmt.Sprint(value))
	fieldType := strings.ToLower(field.Type)
	key := normalizeTypeformIdentityKey(firstString(field.InternalLabel, field.InternalLabelV2, field.Label, field.Field))
	if (strings.Contains(fieldType, "email") || strings.Contains(key, "email")) && identity.Email == "" {
		identity.Email = text
	}
	if (strings.Contains(fieldType, "phone") || strings.Contains(key, "phone")) && identity.Phone == "" {
		identity.Phone = text
	}
	identity.apply(firstString(field.Label, field.InternalLabel, field.InternalLabelV2, field.Field), text)
}

func normalizeFormstackValue(value any) any {
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
			out = append(out, normalizeFormstackValue(item))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = normalizeFormstackValue(item)
		}
		return out
	default:
		return typed
	}
}

func formstackPageSize(size int) int {
	if size <= 0 {
		return formstackDefaultPageSize
	}
	if size > formstackMaxPageSize {
		return formstackMaxPageSize
	}
	return size
}

func formstackStringValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func formstackSourceID(formID, id string) string {
	formID = strings.TrimSpace(formID)
	id = strings.TrimSpace(id)
	if formID == "" || id == "" || id == "<nil>" {
		return ""
	}
	return "formstack://submission/" + formID + "/" + id
}

func formstackTags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"formstack", "formstack:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func formstackResponseSnippet(raw []byte) string {
	snippet := strings.TrimSpace(string(raw))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	return snippet
}
