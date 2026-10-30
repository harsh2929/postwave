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
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	leadpagesCursorPrefix      = "leadpages:"
	leadpagesDefaultAPIBaseURL = "https://api.leadpages.net"
	leadpagesResponseMaxBytes  = 8 << 20
	leadpagesDefaultPageSize   = 100
	leadpagesMaxPageSize       = 250
	leadpagesDefaultUserAgent  = "Moosewave Leadpages Integration"
)

type LeadpagesCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type LeadpagesCredentialResolver interface {
	ResolveLeadpages(context.Context, string, Integration) (LeadpagesCredentials, error)
}

type LeadpagesBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type LeadpagesRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials LeadpagesCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type LeadpagesRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type LeadpagesSecretsCredentialResolver struct {
	Secrets LeadpagesRuntimeSecretResolver
}

func NewLeadpagesSecretsCredentialResolver(secrets LeadpagesRuntimeSecretResolver) *LeadpagesSecretsCredentialResolver {
	return &LeadpagesSecretsCredentialResolver{Secrets: secrets}
}

func (r *LeadpagesSecretsCredentialResolver) ResolveLeadpages(ctx context.Context, _ string, integration Integration) (LeadpagesCredentials, error) {
	if r == nil || r.Secrets == nil {
		return LeadpagesCredentials{}, fmt.Errorf("leadpages credential resolver is not configured")
	}
	ref := leadpagesCredentialRef(integration)
	if ref == "" {
		return LeadpagesCredentials{}, fmt.Errorf("leadpages credentials_ref is required")
	}
	var payload leadpagesCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return LeadpagesCredentials{}, fmt.Errorf("resolve leadpages credentials %q: %w", ref, err)
		}
		return parseLeadpagesCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return LeadpagesCredentials{}, fmt.Errorf("resolve leadpages credentials %q: %w", ref, err)
	}
	return parseLeadpagesCredentialSecret(raw)
}

type leadpagesCredentialPayload struct {
	AccessToken string `json:"access_token"`
	APIKey      string `json:"api_key"`
	Token       string `json:"token"`
	BearerToken string `json:"bearer_token"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p leadpagesCredentialPayload) credentials() (LeadpagesCredentials, error) {
	token := normalizeLeadpagesBearerToken(firstString(p.AccessToken, p.APIKey, p.Token, p.BearerToken))
	if token == "" {
		return LeadpagesCredentials{}, fmt.Errorf("leadpages access_token or api_key is required")
	}
	return LeadpagesCredentials{
		AccessToken: token,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseLeadpagesCredentialSecret(raw string) (LeadpagesCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return LeadpagesCredentials{}, fmt.Errorf("leadpages credentials are empty")
	}
	var payload leadpagesCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return LeadpagesCredentials{}, fmt.Errorf("parse leadpages credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseLeadpagesKeyValueSecret(raw).credentials()
	}
	return leadpagesCredentialPayload{AccessToken: raw}.credentials()
}

func parseLeadpagesKeyValueSecret(raw string) leadpagesCredentialPayload {
	var payload leadpagesCredentialPayload
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
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func normalizeLeadpagesBearerToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func leadpagesCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b LeadpagesRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderLeadpages {
		return SyncRequest{}, fmt.Errorf("leadpages backfill requires a Leadpages integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("leadpages credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("leadpages form_id is required")
	}
	creds, err := b.Credentials.ResolveLeadpages(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("leadpages access token is required")
	}
	state, err := decodeLeadpagesCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	client := leadEgressClient(b.HTTPClient, ProviderLeadpages, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), leadpagesDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), leadpagesDefaultUserAgent)
	pageSize := leadpagesPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	pageOut, err := fetchLeadpagesSubmissions(ctx, client, baseURL, creds.AccessToken, userAgent, formID, state, pageSize, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(pageOut.Submissions))}
	latestAt := state.LastSubmittedAt
	latestID := state.LastID
	for _, item := range pageOut.Submissions {
		submittedAt := leadpagesSubmissionTime(item)
		submissionID := leadpagesSubmissionID(item)
		if !leadpagesSubmissionAfterCursor(submittedAt, submissionID, state) {
			continue
		}
		submission := mapLeadpagesSubmission(item, integration, formID)
		if submission.SourceID == "" {
			continue
		}
		req.Submissions = append(req.Submissions, submission)
		if leadpagesTimeAfter(submittedAt, latestAt) || (submittedAt != "" && submittedAt == latestAt && submissionID > latestID) {
			latestAt = submittedAt
			latestID = submissionID
		}
	}
	next := leadpagesCursorState{
		NextCursor:      firstString(pageOut.NextCursor, pageOut.NextPageToken),
		NextURL:         pageOut.NextURL,
		Page:            pageOut.NextPage,
		LastSubmittedAt: latestAt,
		LastID:          latestID,
	}
	if pageOut.HasMore && next.NextCursor == "" && next.NextURL == "" && next.Page <= 0 {
		next.Page = 2
		if state.Page > 0 {
			next.Page = state.Page + 1
		}
	}
	if next.NextCursor == "" && next.NextURL == "" && next.Page <= 0 {
		next.LastSubmittedAt = latestAt
		next.LastID = latestID
	}
	req.Cursor = encodeLeadpagesCursor(next)
	return req, nil
}

type leadpagesCursorState struct {
	NextCursor      string `json:"next_cursor,omitempty"`
	NextPageToken   string `json:"next_page_token,omitempty"`
	NextURL         string `json:"next_url,omitempty"`
	Page            int    `json:"page,omitempty"`
	LastSubmittedAt string `json:"last_submitted_at,omitempty"`
	LastID          string `json:"last_id,omitempty"`
}

func decodeLeadpagesCursor(cursor string) (leadpagesCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return leadpagesCursorState{}, nil
	}
	if !strings.HasPrefix(cursor, leadpagesCursorPrefix) {
		return leadpagesCursorState{}, fmt.Errorf("invalid Leadpages cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, leadpagesCursorPrefix))
	if raw == "" {
		return leadpagesCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return leadpagesCursorState{}, fmt.Errorf("invalid Leadpages cursor")
	}
	var out leadpagesCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return leadpagesCursorState{}, fmt.Errorf("invalid Leadpages cursor")
	}
	out.NextCursor = firstString(out.NextCursor, out.NextPageToken)
	if out.Page < 0 {
		out.Page = 0
	}
	return out, nil
}

func encodeLeadpagesCursor(state leadpagesCursorState) string {
	state.NextCursor = strings.TrimSpace(firstString(state.NextCursor, state.NextPageToken))
	state.NextPageToken = ""
	state.NextURL = strings.TrimSpace(state.NextURL)
	state.LastSubmittedAt = strings.TrimSpace(state.LastSubmittedAt)
	state.LastID = strings.TrimSpace(state.LastID)
	if state.Page < 0 {
		state.Page = 0
	}
	raw, _ := json.Marshal(state)
	return leadpagesCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type leadpagesSubmissionsResponse struct {
	Submissions   []leadpagesSubmission
	NextCursor    string
	NextPageToken string
	NextURL       string
	NextPage      int
	HasMore       bool
	Raw           map[string]any
}

type leadpagesSubmission struct {
	Raw map[string]any
}

func fetchLeadpagesSubmissions(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, formID string, state leadpagesCursorState, limit int, integration Integration) (leadpagesSubmissionsResponse, error) {
	if strings.TrimSpace(state.NextURL) != "" {
		nextURL := strings.TrimSpace(state.NextURL)
		if strings.HasPrefix(nextURL, "/") {
			nextURL = strings.TrimRight(baseURL, "/") + nextURL
		}
		raw, err := leadpagesDoRaw(ctx, client, "", accessToken, userAgent, http.MethodGet, nextURL, nil, nil)
		if err != nil {
			return leadpagesSubmissionsResponse{}, err
		}
		return decodeLeadpagesSubmissions(raw)
	}
	query := url.Values{}
	if limit > 0 {
		query.Set("limit", strconv.Itoa(leadpagesPageSize(limit)))
	}
	if state.NextCursor != "" {
		query.Set("cursor", state.NextCursor)
	}
	if state.Page > 0 {
		query.Set("page", strconv.Itoa(state.Page))
	}
	for _, key := range []string{"from", "to", "created_from", "created_to", "submitted_after", "submitted_before"} {
		if value := settingString(integration.Settings, key); value != "" {
			query.Set(key, value)
		}
	}
	path := "/api/forms/" + url.PathEscape(formID) + "/submissions"
	raw, err := leadpagesDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, path, query, nil)
	if err != nil {
		return leadpagesSubmissionsResponse{}, err
	}
	return decodeLeadpagesSubmissions(raw)
}

func decodeLeadpagesSubmissions(raw []byte) (leadpagesSubmissionsResponse, error) {
	var root any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&root); err != nil && err != io.EOF {
		return leadpagesSubmissionsResponse{}, fmt.Errorf("decode leadpages submissions response: %w", err)
	}
	out := leadpagesSubmissionsResponse{}
	if rawMap, ok := root.(map[string]any); ok {
		out.Raw = nonNilMap(rawMap)
		out.Submissions = leadpagesSubmissionSlice(firstNonNilAny(
			rawMap["submissions"],
			rawMap["leads"],
			rawMap["items"],
			rawMap["results"],
			rawMap["data"],
		))
		if data, ok := rawMap["data"].(map[string]any); ok && len(out.Submissions) == 0 {
			out.Submissions = leadpagesSubmissionSlice(firstNonNilAny(data["submissions"], data["leads"], data["items"], data["results"]))
		}
		out.NextCursor = leadpagesNestedString(rawMap, "next_cursor", "nextCursor", "cursor")
		out.NextPageToken = leadpagesNestedString(rawMap, "next_page_token", "nextPageToken")
		out.NextURL = leadpagesNestedString(rawMap, "next", "next_url", "nextUrl")
		out.HasMore = leadpagesNestedBool(rawMap, "has_more", "hasMore")
		out.NextPage = leadpagesNestedInt(rawMap, "next_page", "nextPage")
		for _, key := range []string{"meta", "metadata", "pagination", "page"} {
			if nested, ok := rawMap[key].(map[string]any); ok {
				out.NextCursor = firstString(out.NextCursor, leadpagesNestedString(nested, "next_cursor", "nextCursor", "cursor"))
				out.NextPageToken = firstString(out.NextPageToken, leadpagesNestedString(nested, "next_page_token", "nextPageToken"))
				out.NextURL = firstString(out.NextURL, leadpagesNestedString(nested, "next", "next_url", "nextUrl"))
				out.HasMore = out.HasMore || leadpagesNestedBool(nested, "has_more", "hasMore")
				out.NextPage = firstNonZero(out.NextPage, leadpagesNestedInt(nested, "next_page", "nextPage"))
			}
		}
	} else {
		out.Submissions = leadpagesSubmissionSlice(root)
	}
	return out, nil
}

func leadpagesDoRaw(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, method, path string, query url.Values, body io.Reader) ([]byte, error) {
	target := path
	if strings.TrimSpace(baseURL) != "" {
		target = strings.TrimRight(baseURL, "/") + path
	}
	u, err := url.Parse(target)
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
	req.Header.Set("User-Agent", firstString(userAgent, leadpagesDefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, leadpagesResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, LeadpagesProviderError{Path: path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: leadpagesResponseSnippet(raw)}
	}
	return raw, nil
}

type LeadpagesProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e LeadpagesProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("leadpages REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("leadpages REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapLeadpagesSubmission(item leadpagesSubmission, integration Integration, fallbackFormID string) SubmissionInput {
	formID := firstString(leadpagesMapString(item.Raw, "form_id", "formId"), fallbackFormID, settingString(integration.Settings, "form_id"))
	pageID := firstString(leadpagesMapString(item.Raw, "page_id", "pageId"), settingString(integration.Settings, "page_id"))
	submissionID := leadpagesSubmissionID(item)
	if submissionID == "" {
		submissionID = leadpagesSubmissionHash(item.Raw)
	}
	fieldValues := leadpagesFieldValues(item.Raw)
	fields := map[string]any{
		"leadpages_submission_id":   submissionID,
		"leadpages_form_id":         formID,
		"leadpages_page_id":         pageID,
		"leadpages_account_id":      settingString(integration.Settings, "account_id"),
		"leadpages_submitted_at":    leadpagesSubmissionTime(item),
		"leadpages_provider_raw":    item.Raw,
		"leadpages_provider_fields": fieldValues,
	}
	identity := typeformIdentity{}
	for key, value := range fieldValues {
		if strings.TrimSpace(key) == "" {
			continue
		}
		normalized := normalizeLeadpagesValue(value)
		fields["leadpages_field."+normalizeTypeformIdentityKey(key)] = normalized
		applyLeadpagesIdentity(&identity, integration, key, normalized)
	}
	for _, key := range []string{"email", "first_name", "firstName", "last_name", "lastName", "full_name", "fullName", "name", "phone", "company"} {
		if value := leadpagesMapString(item.Raw, key); value != "" {
			applyLeadpagesIdentity(&identity, integration, key, value)
		}
	}
	return SubmissionInput{
		SourceID:    leadpagesSourceID(formID, submissionID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    firstString(settingString(integration.Settings, "form_name"), leadpagesMapString(item.Raw, "form_name", "formName")),
		EventName:   "lead.submitted",
		Tags:        leadpagesTags(integration, formID, pageID),
		Fields:      fields,
		SubmittedAt: parseFilloutTime(leadpagesSubmissionTime(item)),
	}
}

func applyLeadpagesIdentity(identity *typeformIdentity, integration Integration, key string, value any) {
	if identity == nil {
		return
	}
	text := strings.TrimSpace(fmt.Sprint(value))
	normalized := normalizeTypeformIdentityKey(key)
	for _, candidate := range []struct {
		setting string
		apply   func()
	}{
		{"email_field_key", func() { identity.Email = text }},
		{"first_name_field_key", func() { identity.FirstName = text }},
		{"last_name_field_key", func() { identity.LastName = text }},
		{"full_name_field_key", func() { identity.FullName = text }},
		{"phone_field_key", func() { identity.Phone = text }},
		{"company_field_key", func() { identity.Company = text }},
	} {
		if setting := normalizeTypeformIdentityKey(settingString(integration.Settings, candidate.setting)); setting != "" && setting == normalized {
			candidate.apply()
		}
	}
	if strings.Contains(normalized, "email") && identity.Email == "" {
		identity.Email = text
	}
	if strings.Contains(normalized, "phone") && identity.Phone == "" {
		identity.Phone = text
	}
	identity.apply(key, text)
}

func leadpagesSubmissionAfterCursor(submittedAt, id string, state leadpagesCursorState) bool {
	if strings.TrimSpace(state.LastSubmittedAt) == "" {
		return true
	}
	if leadpagesTimeAfter(submittedAt, state.LastSubmittedAt) {
		return true
	}
	return strings.TrimSpace(submittedAt) == strings.TrimSpace(state.LastSubmittedAt) && strings.TrimSpace(id) > strings.TrimSpace(state.LastID)
}

func leadpagesTimeAfter(a, b string) bool {
	at := parseFilloutTime(a)
	bt := parseFilloutTime(b)
	if at != nil && bt != nil {
		return at.After(*bt)
	}
	return strings.TrimSpace(a) > strings.TrimSpace(b)
}

func leadpagesSubmissionID(item leadpagesSubmission) string {
	return firstString(leadpagesMapString(item.Raw, "id", "submission_id", "submissionId", "lead_id", "leadId", "uuid"), leadpagesSubmissionHash(item.Raw))
}

func leadpagesSubmissionTime(item leadpagesSubmission) string {
	return firstString(
		leadpagesMapString(item.Raw, "submitted_at", "submittedAt", "created_at", "createdAt", "created", "timestamp"),
	)
}

func leadpagesFieldValues(raw map[string]any) map[string]any {
	out := map[string]any{}
	for _, key := range []string{"fields", "field_values", "fieldValues", "data", "answers", "values", "custom_fields", "customFields"} {
		if nested, ok := raw[key].(map[string]any); ok {
			for field, value := range nested {
				out[field] = normalizeLeadpagesValue(value)
			}
		}
	}
	return out
}

func leadpagesSubmissionSlice(raw any) []leadpagesSubmission {
	switch typed := raw.(type) {
	case []any:
		out := make([]leadpagesSubmission, 0, len(typed))
		for _, item := range typed {
			if m, ok := item.(map[string]any); ok {
				out = append(out, leadpagesSubmission{Raw: nonNilMap(m)})
			}
		}
		return out
	case map[string]any:
		if nested := firstNonNilAny(typed["submissions"], typed["leads"], typed["items"], typed["results"]); nested != nil {
			return leadpagesSubmissionSlice(nested)
		}
		return []leadpagesSubmission{{Raw: nonNilMap(typed)}}
	default:
		return nil
	}
}

func firstNonNilAny(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func leadpagesNestedString(raw map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := leadpagesMapString(raw, key); value != "" {
			return value
		}
	}
	return ""
}

func leadpagesNestedBool(raw map[string]any, keys ...string) bool {
	for _, key := range keys {
		switch value := raw[key].(type) {
		case bool:
			if value {
				return true
			}
		case string:
			parsed, _ := strconv.ParseBool(strings.TrimSpace(value))
			if parsed {
				return true
			}
		}
	}
	return false
}

func leadpagesNestedInt(raw map[string]any, keys ...string) int {
	for _, key := range keys {
		switch value := raw[key].(type) {
		case int:
			return value
		case float64:
			return int(value)
		case json.Number:
			if i, err := value.Int64(); err == nil {
				return int(i)
			}
		case string:
			if i, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
				return i
			}
		}
	}
	return 0
}

func leadpagesMapString(raw map[string]any, keys ...string) string {
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

func normalizeLeadpagesValue(value any) any {
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
			out = append(out, normalizeLeadpagesValue(item))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = normalizeLeadpagesValue(item)
		}
		return out
	default:
		return typed
	}
}

func leadpagesPageSize(size int) int {
	if size <= 0 {
		return leadpagesDefaultPageSize
	}
	if size > leadpagesMaxPageSize {
		return leadpagesMaxPageSize
	}
	return size
}

func leadpagesSourceID(formID, id string) string {
	formID = strings.TrimSpace(formID)
	id = strings.TrimSpace(id)
	if formID == "" || id == "" || id == "<nil>" {
		return ""
	}
	return "leadpages://submission/" + formID + "/" + id
}

func leadpagesSubmissionHash(raw map[string]any) string {
	encoded, _ := json.Marshal(raw)
	sum := sha256.Sum256(encoded)
	return "sha256-" + hex.EncodeToString(sum[:8])
}

func leadpagesTags(integration Integration, formID, pageID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"leadpages", "leadpages:" + formID, "leadpages:page:" + pageID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func leadpagesResponseSnippet(raw []byte) string {
	snippet := strings.TrimSpace(string(raw))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	return snippet
}
