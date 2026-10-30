// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
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
	formBuilder123CursorPrefix      = "123formbuilder:"
	formBuilder123DefaultAPIBaseURL = "https://api.123formbuilder.com/v2"
	formBuilder123ResponseMaxBytes  = 8 << 20
	formBuilder123DefaultPageSize   = 100
	formBuilder123MaxPageSize       = 1000
	formBuilder123DefaultUserAgent  = "Moosewave 123FormBuilder Integration"
)

type FormBuilder123Credentials struct {
	JWT        string
	Username   string
	Email      string
	Password   string
	Passhash   string
	APIBaseURL string
	UserAgent  string
}

type FormBuilder123CredentialResolver interface {
	ResolveFormBuilder123(context.Context, string, Integration) (FormBuilder123Credentials, error)
}

type FormBuilder123Backfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type FormBuilder123RESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials FormBuilder123CredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type FormBuilder123RuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type FormBuilder123SecretsCredentialResolver struct {
	Secrets FormBuilder123RuntimeSecretResolver
}

func NewFormBuilder123SecretsCredentialResolver(secrets FormBuilder123RuntimeSecretResolver) *FormBuilder123SecretsCredentialResolver {
	return &FormBuilder123SecretsCredentialResolver{Secrets: secrets}
}

func (r *FormBuilder123SecretsCredentialResolver) ResolveFormBuilder123(ctx context.Context, _ string, integration Integration) (FormBuilder123Credentials, error) {
	if r == nil || r.Secrets == nil {
		return FormBuilder123Credentials{}, fmt.Errorf("123FormBuilder credential resolver is not configured")
	}
	ref := formBuilder123CredentialRef(integration)
	if ref == "" {
		return FormBuilder123Credentials{}, fmt.Errorf("123FormBuilder credentials_ref is required")
	}
	var payload formBuilder123CredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return FormBuilder123Credentials{}, fmt.Errorf("resolve 123FormBuilder credentials %q: %w", ref, err)
		}
		return parseFormBuilder123CredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return FormBuilder123Credentials{}, fmt.Errorf("resolve 123FormBuilder credentials %q: %w", ref, err)
	}
	return parseFormBuilder123CredentialSecret(raw)
}

type formBuilder123CredentialPayload struct {
	JWT         string `json:"jwt"`
	Token       string `json:"token"`
	AccessToken string `json:"access_token"`
	APIKey      string `json:"api_key"`
	Username    string `json:"username"`
	Email       string `json:"email"`
	Password    string `json:"password"`
	Passhash    string `json:"passhash"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p formBuilder123CredentialPayload) credentials() (FormBuilder123Credentials, error) {
	jwt := strings.TrimSpace(firstString(p.JWT, p.Token, p.AccessToken, p.APIKey))
	creds := FormBuilder123Credentials{
		JWT:        jwt,
		Username:   strings.TrimSpace(p.Username),
		Email:      strings.TrimSpace(p.Email),
		Password:   strings.TrimSpace(p.Password),
		Passhash:   strings.TrimSpace(p.Passhash),
		APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:  strings.TrimSpace(p.UserAgent),
	}
	if creds.JWT == "" && firstString(creds.Username, creds.Email) == "" {
		return FormBuilder123Credentials{}, fmt.Errorf("123FormBuilder jwt or username/email is required")
	}
	if creds.JWT == "" && firstString(creds.Password, creds.Passhash) == "" {
		return FormBuilder123Credentials{}, fmt.Errorf("123FormBuilder password or passhash is required when jwt is not supplied")
	}
	return creds, nil
}

func parseFormBuilder123CredentialSecret(raw string) (FormBuilder123Credentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return FormBuilder123Credentials{}, fmt.Errorf("123FormBuilder credentials are empty")
	}
	var payload formBuilder123CredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return FormBuilder123Credentials{}, fmt.Errorf("parse 123FormBuilder credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseFormBuilder123KeyValueSecret(raw).credentials()
	}
	return formBuilder123CredentialPayload{JWT: raw}.credentials()
}

func parseFormBuilder123KeyValueSecret(raw string) formBuilder123CredentialPayload {
	var payload formBuilder123CredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "jwt":
			payload.JWT = value
		case "token":
			payload.Token = value
		case "access_token":
			payload.AccessToken = value
		case "api_key":
			payload.APIKey = value
		case "username":
			payload.Username = value
		case "email":
			payload.Email = value
		case "password":
			payload.Password = value
		case "passhash":
			payload.Passhash = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func formBuilder123CredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b FormBuilder123RESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != Provider123FormBuilder {
		return SyncRequest{}, fmt.Errorf("123FormBuilder backfill requires a 123FormBuilder integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("123FormBuilder credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("123FormBuilder form_id is required")
	}
	creds, err := b.Credentials.ResolveFormBuilder123(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	state, err := decodeFormBuilder123Cursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.FormID != "" && state.FormID != formID {
		state = formBuilder123CursorState{}
	}
	if state.LastID == "" {
		state.LastID = strings.TrimSpace(settingString(integration.Settings, "start_submission_id"))
	}
	client := leadEgressClient(b.HTTPClient, Provider123FormBuilder, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), formBuilder123DefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), formBuilder123DefaultUserAgent)
	jwt, err := formBuilder123JWT(ctx, client, baseURL, creds, userAgent)
	if err != nil {
		return SyncRequest{}, err
	}
	pageSize := formBuilder123PageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	pageOut, err := fetchFormBuilder123Submissions(ctx, client, baseURL, jwt, userAgent, formID, state, pageSize, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(pageOut.Submissions))}
	baseState := state
	highWaterID := firstString(state.HighWaterID, state.LastID)
	highWaterSubmittedAt := firstString(state.HighWaterSubmittedAt, state.LastSubmittedAt)
	for _, item := range pageOut.Submissions {
		submissionID := formBuilder123SubmissionID(item)
		submittedAt := formBuilder123SubmissionTime(item)
		if !formBuilder123SubmissionAfterCursor(submittedAt, submissionID, baseState) {
			continue
		}
		submission := mapFormBuilder123Submission(item, integration, formID)
		if submission.SourceID == "" {
			continue
		}
		req.Submissions = append(req.Submissions, submission)
		if formBuilder123SubmissionAfterCursor(submittedAt, submissionID, formBuilder123CursorState{LastID: highWaterID, LastSubmittedAt: highWaterSubmittedAt}) {
			highWaterID = submissionID
			highWaterSubmittedAt = submittedAt
		}
	}
	currentPage := pageOut.CurrentPage
	if currentPage <= 0 {
		currentPage = state.Page
	}
	if currentPage <= 0 {
		currentPage = 1
	}
	if pageOut.HasMore {
		req.Cursor = encodeFormBuilder123Cursor(formBuilder123CursorState{
			FormID:               formID,
			Page:                 currentPage + 1,
			LastID:               state.LastID,
			LastSubmittedAt:      state.LastSubmittedAt,
			HighWaterID:          highWaterID,
			HighWaterSubmittedAt: highWaterSubmittedAt,
			Total:                pageOut.Total,
			TotalPages:           pageOut.TotalPages,
		})
	} else {
		req.Cursor = encodeFormBuilder123Cursor(formBuilder123CursorState{
			FormID:          formID,
			LastID:          highWaterID,
			LastSubmittedAt: highWaterSubmittedAt,
			Total:           pageOut.Total,
			TotalPages:      pageOut.TotalPages,
		})
	}
	return req, nil
}

type formBuilder123CursorState struct {
	FormID               string `json:"form_id,omitempty"`
	Page                 int    `json:"page,omitempty"`
	LastID               string `json:"last_id,omitempty"`
	LastSubmittedAt      string `json:"last_submitted_at,omitempty"`
	HighWaterID          string `json:"high_water_id,omitempty"`
	HighWaterSubmittedAt string `json:"high_water_submitted_at,omitempty"`
	Total                int    `json:"total,omitempty"`
	TotalPages           int    `json:"total_pages,omitempty"`
}

func decodeFormBuilder123Cursor(cursor string) (formBuilder123CursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return formBuilder123CursorState{}, nil
	}
	if !strings.HasPrefix(cursor, formBuilder123CursorPrefix) {
		return formBuilder123CursorState{}, fmt.Errorf("invalid 123FormBuilder cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, formBuilder123CursorPrefix))
	if raw == "" {
		return formBuilder123CursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return formBuilder123CursorState{}, fmt.Errorf("invalid 123FormBuilder cursor")
	}
	var out formBuilder123CursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return formBuilder123CursorState{}, fmt.Errorf("invalid 123FormBuilder cursor")
	}
	out.FormID = strings.TrimSpace(out.FormID)
	out.LastID = strings.TrimSpace(out.LastID)
	out.LastSubmittedAt = strings.TrimSpace(out.LastSubmittedAt)
	out.HighWaterID = strings.TrimSpace(out.HighWaterID)
	out.HighWaterSubmittedAt = strings.TrimSpace(out.HighWaterSubmittedAt)
	if out.Page < 0 {
		out.Page = 0
	}
	if out.Total < 0 {
		out.Total = 0
	}
	if out.TotalPages < 0 {
		out.TotalPages = 0
	}
	return out, nil
}

func encodeFormBuilder123Cursor(state formBuilder123CursorState) string {
	state.FormID = strings.TrimSpace(state.FormID)
	state.LastID = strings.TrimSpace(state.LastID)
	state.LastSubmittedAt = strings.TrimSpace(state.LastSubmittedAt)
	state.HighWaterID = strings.TrimSpace(state.HighWaterID)
	state.HighWaterSubmittedAt = strings.TrimSpace(state.HighWaterSubmittedAt)
	if state.Page < 0 {
		state.Page = 0
	}
	if state.Total < 0 {
		state.Total = 0
	}
	if state.TotalPages < 0 {
		state.TotalPages = 0
	}
	raw, _ := json.Marshal(state)
	return formBuilder123CursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type formBuilder123SubmissionsResponse struct {
	Submissions []formBuilder123Submission
	CurrentPage int
	TotalPages  int
	Total       int
	Count       int
	HasMore     bool
	Raw         map[string]any
}

type formBuilder123Submission struct {
	Raw map[string]any
}

func formBuilder123JWT(ctx context.Context, client *http.Client, baseURL string, creds FormBuilder123Credentials, userAgent string) (string, error) {
	if jwt := strings.TrimSpace(creds.JWT); jwt != "" {
		return jwt, nil
	}
	query := url.Values{}
	if creds.Username != "" {
		query.Set("username", creds.Username)
	}
	if creds.Email != "" {
		query.Set("email", creds.Email)
	}
	if creds.Password != "" {
		query.Set("password", creds.Password)
	}
	if creds.Passhash != "" {
		query.Set("passhash", creds.Passhash)
	}
	raw, err := formBuilder123DoRaw(ctx, client, baseURL, "", userAgent, http.MethodPost, "/token", query, nil)
	if err != nil {
		return "", err
	}
	var payload map[string]any
	if err := decodeFormBuilder123JSON(raw, &payload); err != nil {
		return "", fmt.Errorf("decode 123FormBuilder token response: %w", err)
	}
	token := formBuilder123MapString(payload, "token", "result", "JWT", "jwt")
	if token == "" {
		return "", fmt.Errorf("123FormBuilder token response did not include token")
	}
	return token, nil
}

func fetchFormBuilder123Submissions(ctx context.Context, client *http.Client, baseURL, jwt, userAgent, formID string, state formBuilder123CursorState, pageSize int, integration Integration) (formBuilder123SubmissionsResponse, error) {
	page := state.Page
	if page <= 0 {
		page = 1
	}
	query := url.Values{}
	query.Set("per_page", strconv.Itoa(formBuilder123PageSize(pageSize)))
	query.Set("page", strconv.Itoa(page))
	if state.LastID != "" {
		query.Set("start_submission_id", state.LastID)
	}
	if startDate := firstString(settingString(integration.Settings, "start_date"), settingString(integration.Settings, "submitted_after")); startDate != "" {
		query.Set("start_date", startDate)
	} else if state.LastSubmittedAt != "" && state.LastID == "" {
		query.Set("start_date", state.LastSubmittedAt)
	}
	if includeRecipients := settingString(integration.Settings, "include_recipients"); includeRecipients != "" {
		query.Set("include_recipients", includeRecipients)
	}
	path := "/forms/" + url.PathEscape(formID) + "/submissions"
	raw, err := formBuilder123DoRaw(ctx, client, baseURL, jwt, userAgent, http.MethodGet, path, query, nil)
	if err != nil {
		return formBuilder123SubmissionsResponse{}, err
	}
	out, err := decodeFormBuilder123Submissions(raw)
	if err != nil {
		return formBuilder123SubmissionsResponse{}, err
	}
	if out.CurrentPage <= 0 {
		out.CurrentPage = page
	}
	if out.TotalPages > 0 {
		out.HasMore = out.CurrentPage < out.TotalPages
	} else if len(out.Submissions) >= formBuilder123PageSize(pageSize) {
		out.HasMore = true
	}
	return out, nil
}

func decodeFormBuilder123Submissions(raw []byte) (formBuilder123SubmissionsResponse, error) {
	var root any
	if err := decodeFormBuilder123JSON(raw, &root); err != nil {
		return formBuilder123SubmissionsResponse{}, fmt.Errorf("decode 123FormBuilder submissions response: %w", err)
	}
	out := formBuilder123SubmissionsResponse{}
	if rawMap, ok := root.(map[string]any); ok {
		out.Raw = nonNilMap(rawMap)
		out.Submissions = formBuilder123SubmissionSlice(firstNonNilAny(rawMap["data"], rawMap["submissions"], rawMap["items"], rawMap["results"]))
		if meta, ok := rawMap["meta"].(map[string]any); ok {
			if pagination, ok := meta["pagination"].(map[string]any); ok {
				out.Total = formBuilder123Int(pagination["total"])
				out.Count = formBuilder123Int(pagination["count"])
				out.CurrentPage = formBuilder123Int(pagination["current_page"])
				out.TotalPages = formBuilder123Int(pagination["total_pages"])
				if links, ok := pagination["links"].(map[string]any); ok && formBuilder123MapString(links, "next") != "" {
					out.HasMore = true
				}
			}
		}
	} else {
		out.Submissions = formBuilder123SubmissionSlice(root)
	}
	return out, nil
}

func formBuilder123DoRaw(ctx context.Context, client *http.Client, baseURL, jwt, userAgent, method, path string, query url.Values, body io.Reader) ([]byte, error) {
	target := strings.TrimRight(baseURL, "/") + path
	u, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	for key, values := range query {
		for _, value := range values {
			q.Add(key, value)
		}
	}
	if strings.TrimSpace(jwt) != "" {
		q.Set("JWT", strings.TrimSpace(jwt))
	}
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, formBuilder123DefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, formBuilder123ResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, FormBuilder123ProviderError{Path: path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: formBuilder123ResponseSnippet(raw)}
	}
	return raw, nil
}

type FormBuilder123ProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e FormBuilder123ProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("123FormBuilder API %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("123FormBuilder API %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapFormBuilder123Submission(item formBuilder123Submission, integration Integration, fallbackFormID string) SubmissionInput {
	formID := firstString(formBuilder123MapString(item.Raw, "form_id", "formId"), fallbackFormID, settingString(integration.Settings, "form_id"))
	submissionID := formBuilder123SubmissionID(item)
	if submissionID == "" {
		submissionID = formBuilder123SubmissionHash(item.Raw)
	}
	content := formBuilder123ContentValues(item.Raw["content"])
	fields := map[string]any{
		"formbuilder123_submission_id": submissionID,
		"formbuilder123_form_id":       formID,
		"formbuilder123_entry_id":      formBuilder123MapString(item.Raw, "entry_id", "entryId"),
		"formbuilder123_account_id":    settingString(integration.Settings, "account_id"),
		"formbuilder123_country":       formBuilder123MapString(item.Raw, "country"),
		"formbuilder123_deleted":       normalizeLeadpagesValue(item.Raw["deleted"]),
		"formbuilder123_status":        normalizeLeadpagesValue(item.Raw["status"]),
		"formbuilder123_payed":         normalizeLeadpagesValue(item.Raw["payed"]),
		"formbuilder123_approved":      normalizeLeadpagesValue(item.Raw["approved"]),
		"formbuilder123_date":          formBuilder123SubmissionTime(item),
		"formbuilder123_recipients":    normalizeLeadpagesValue(item.Raw["recipients"]),
		"formbuilder123_provider_raw":  item.Raw,
		"formbuilder123_content":       content,
	}
	identity := typeformIdentity{}
	keys := make([]string, 0, len(content))
	for key := range content {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := content[key]
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		fields["formbuilder123_field."+normalizedKey] = value
		applyFormBuilder123Identity(&identity, integration, key, value)
	}
	for _, key := range []string{"email", "first_name", "firstName", "last_name", "lastName", "full_name", "fullName", "name", "phone", "company"} {
		if value := formBuilder123MapString(item.Raw, key); value != "" {
			applyFormBuilder123Identity(&identity, integration, key, value)
		}
	}
	return SubmissionInput{
		SourceID:    formBuilder123SourceID(formID, submissionID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    firstString(settingString(integration.Settings, "form_name"), formBuilder123MapString(item.Raw, "form_name", "formName")),
		EventName:   "lead.submitted",
		Tags:        formBuilder123Tags(integration, formID),
		Fields:      fields,
		SubmittedAt: parseFilloutTime(formBuilder123SubmissionTime(item)),
	}
}

func applyFormBuilder123Identity(identity *typeformIdentity, integration Integration, key string, value any) {
	if identity == nil {
		return
	}
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "" || text == "<nil>" {
		return
	}
	normalized := normalizeTypeformIdentityKey(key)
	for _, candidate := range []struct {
		setting string
		apply   func()
	}{
		{"email_field_key", func() { identity.Email = text }},
		{"email_field", func() { identity.Email = text }},
		{"email_field_name", func() { identity.Email = text }},
		{"first_name_field_key", func() { identity.FirstName = text }},
		{"first_name_field", func() { identity.FirstName = text }},
		{"first_name_field_name", func() { identity.FirstName = text }},
		{"last_name_field_key", func() { identity.LastName = text }},
		{"last_name_field", func() { identity.LastName = text }},
		{"last_name_field_name", func() { identity.LastName = text }},
		{"full_name_field_key", func() { identity.FullName = text }},
		{"full_name_field", func() { identity.FullName = text }},
		{"full_name_field_name", func() { identity.FullName = text }},
		{"phone_field_key", func() { identity.Phone = text }},
		{"phone_field", func() { identity.Phone = text }},
		{"phone_field_name", func() { identity.Phone = text }},
		{"company_field_key", func() { identity.Company = text }},
		{"company_field", func() { identity.Company = text }},
		{"company_field_name", func() { identity.Company = text }},
	} {
		if setting := normalizeTypeformIdentityKey(settingString(integration.Settings, candidate.setting)); setting != "" && setting == normalized {
			candidate.apply()
		}
	}
	identity.apply(key, text)
}

func formBuilder123SubmissionAfterCursor(submittedAt, id string, state formBuilder123CursorState) bool {
	lastID := strings.TrimSpace(state.LastID)
	if lastID != "" {
		return formBuilder123IDGreater(id, lastID)
	}
	if strings.TrimSpace(state.LastSubmittedAt) == "" {
		return true
	}
	if leadpagesTimeAfter(submittedAt, state.LastSubmittedAt) {
		return true
	}
	return strings.TrimSpace(submittedAt) == strings.TrimSpace(state.LastSubmittedAt) && strings.TrimSpace(id) > strings.TrimSpace(lastID)
}

func formBuilder123IDGreater(id, last string) bool {
	id = strings.TrimSpace(id)
	last = strings.TrimSpace(last)
	if id == "" || last == "" {
		return id != ""
	}
	if left, err := strconv.ParseInt(id, 10, 64); err == nil {
		if right, err := strconv.ParseInt(last, 10, 64); err == nil {
			return left > right
		}
	}
	return id > last
}

func formBuilder123SubmissionID(item formBuilder123Submission) string {
	return firstString(formBuilder123MapString(item.Raw, "id", "submission_id", "submissionId"), formBuilder123MapString(item.Raw, "entry_id", "entryId"))
}

func formBuilder123SubmissionTime(item formBuilder123Submission) string {
	return firstString(formBuilder123MapString(item.Raw, "date", "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp"))
}

func formBuilder123ContentValues(raw any) map[string]any {
	out := map[string]any{}
	switch typed := raw.(type) {
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return out
		}
		var decoded any
		dec := json.NewDecoder(strings.NewReader(text))
		dec.UseNumber()
		if err := dec.Decode(&decoded); err != nil {
			out["content"] = text
			return out
		}
		return formBuilder123ContentValues(decoded)
	case map[string]any:
		for key, value := range typed {
			out[key] = normalizeLeadpagesValue(value)
		}
	case []any:
		for i, item := range typed {
			if m, ok := item.(map[string]any); ok {
				label := firstString(formBuilder123MapString(m, "label", "name", "field", "key", "title"), strconv.Itoa(i))
				value := firstNonNilAny(m["value"], m["answer"], m["text"], m["content"])
				out[label] = normalizeLeadpagesValue(value)
			} else {
				out[strconv.Itoa(i)] = normalizeLeadpagesValue(item)
			}
		}
	default:
		if raw != nil {
			out["content"] = normalizeLeadpagesValue(raw)
		}
	}
	return out
}

func formBuilder123SubmissionSlice(raw any) []formBuilder123Submission {
	switch typed := raw.(type) {
	case []any:
		out := make([]formBuilder123Submission, 0, len(typed))
		for _, item := range typed {
			if m, ok := item.(map[string]any); ok {
				out = append(out, formBuilder123Submission{Raw: nonNilMap(m)})
			}
		}
		return out
	case map[string]any:
		if nested := firstNonNilAny(typed["data"], typed["submissions"], typed["items"], typed["results"]); nested != nil {
			return formBuilder123SubmissionSlice(nested)
		}
		return []formBuilder123Submission{{Raw: nonNilMap(typed)}}
	default:
		return nil
	}
}

func formBuilder123MapString(raw map[string]any, keys ...string) string {
	for _, key := range keys {
		value, ok := raw[key]
		if !ok {
			continue
		}
		switch typed := normalizeLeadpagesValue(value).(type) {
		case string:
			if strings.TrimSpace(typed) != "" {
				return strings.TrimSpace(typed)
			}
		case fmt.Stringer:
			if strings.TrimSpace(typed.String()) != "" {
				return strings.TrimSpace(typed.String())
			}
		default:
			text := strings.TrimSpace(fmt.Sprint(typed))
			if text != "" && text != "<nil>" {
				return text
			}
		}
	}
	return ""
}

func formBuilder123Int(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case json.Number:
		if i, err := typed.Int64(); err == nil {
			return int(i)
		}
	case string:
		if i, err := strconv.Atoi(strings.TrimSpace(typed)); err == nil {
			return i
		}
	}
	return 0
}

func formBuilder123PageSize(size int) int {
	if size <= 0 {
		return formBuilder123DefaultPageSize
	}
	if size > formBuilder123MaxPageSize {
		return formBuilder123MaxPageSize
	}
	return size
}

func formBuilder123SourceID(formID, id string) string {
	formID = strings.TrimSpace(formID)
	id = strings.TrimSpace(id)
	if formID == "" || id == "" || id == "<nil>" {
		return ""
	}
	return "123formbuilder://submission/" + formID + "/" + id
}

func formBuilder123SubmissionHash(raw map[string]any) string {
	encoded, _ := json.Marshal(raw)
	sum := sha256.Sum256(encoded)
	return "sha256-" + hex.EncodeToString(sum[:8])
}

func formBuilder123Tags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"123formbuilder", "123formbuilder:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func decodeFormBuilder123JSON(raw []byte, out any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil && err != io.EOF {
		return err
	}
	return nil
}

func formBuilder123ResponseSnippet(raw []byte) string {
	snippet := strings.TrimSpace(string(raw))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	return snippet
}
