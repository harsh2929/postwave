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
	featheryCursorPrefix      = "feathery:"
	featheryCursorComplete    = "feathery:complete"
	featheryDefaultAPIBaseURL = "https://api.feathery.io"
	featheryResponseMaxBytes  = 8 << 20
	featheryDefaultPageSize   = 500
	featheryMaxPageSize       = 1000
	featheryDefaultUserAgent  = "Moosewave Feathery Integration"
)

type FeatheryCredentials struct {
	APIKey     string
	APIBaseURL string
	UserAgent  string
}

type FeatheryCredentialResolver interface {
	ResolveFeathery(context.Context, string, Integration) (FeatheryCredentials, error)
}

type FeatheryBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type FeatheryRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials FeatheryCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
	Now         func() time.Time
}

type FeatheryRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type FeatherySecretsCredentialResolver struct {
	Secrets FeatheryRuntimeSecretResolver
}

func NewFeatherySecretsCredentialResolver(secrets FeatheryRuntimeSecretResolver) *FeatherySecretsCredentialResolver {
	return &FeatherySecretsCredentialResolver{Secrets: secrets}
}

func (r *FeatherySecretsCredentialResolver) ResolveFeathery(ctx context.Context, _ string, integration Integration) (FeatheryCredentials, error) {
	if r == nil || r.Secrets == nil {
		return FeatheryCredentials{}, fmt.Errorf("feathery credential resolver is not configured")
	}
	ref := featheryCredentialRef(integration)
	if ref == "" {
		return FeatheryCredentials{}, fmt.Errorf("feathery credentials_ref is required")
	}
	var payload featheryCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return FeatheryCredentials{}, fmt.Errorf("resolve feathery credentials %q: %w", ref, err)
		}
		return parseFeatheryCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return FeatheryCredentials{}, fmt.Errorf("resolve feathery credentials %q: %w", ref, err)
	}
	return parseFeatheryCredentialSecret(raw)
}

type featheryCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p featheryCredentialPayload) credentials() (FeatheryCredentials, error) {
	token := normalizeFeatheryToken(firstString(p.APIKey, p.Token))
	if token == "" {
		return FeatheryCredentials{}, fmt.Errorf("feathery api_key is required")
	}
	return FeatheryCredentials{
		APIKey:     token,
		APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:  strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseFeatheryCredentialSecret(raw string) (FeatheryCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return FeatheryCredentials{}, fmt.Errorf("feathery credentials are empty")
	}
	var payload featheryCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return FeatheryCredentials{}, fmt.Errorf("parse feathery credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseFeatheryKeyValueSecret(raw).credentials()
	}
	return featheryCredentialPayload{APIKey: raw}.credentials()
}

func parseFeatheryKeyValueSecret(raw string) featheryCredentialPayload {
	var payload featheryCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "api_key":
			payload.APIKey = value
		case "token":
			payload.Token = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func normalizeFeatheryToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "Token ")
	token = strings.TrimPrefix(token, "token ")
	return strings.TrimSpace(token)
}

func featheryCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b FeatheryRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderFeathery {
		return SyncRequest{}, fmt.Errorf("feathery backfill requires a Feathery integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("feathery credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("feathery form_id is required")
	}
	creds, err := b.Credentials.ResolveFeathery(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.APIKey) == "" {
		return SyncRequest{}, fmt.Errorf("feathery api key is required")
	}
	state, err := decodeFeatheryCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: featheryCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderFeathery, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), featheryDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), featheryDefaultUserAgent)
	pageSize := featheryPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	since := firstString(state.Since, settingString(integration.Settings, "start_time"), settingString(integration.Settings, "after_time"))
	pageOut, err := fetchFeatherySubmissions(ctx, client, baseURL, creds.APIKey, userAgent, formID, state.NextURL, since, pageSize, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	items := pageOut.Results
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(items))}
	latest := state.Since
	for _, item := range items {
		submission := mapFeatherySubmission(item, integration, formID)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
		latest = laterFeatheryTimestamp(latest, firstString(item.LastSubmitted, item.SubmissionStart))
	}
	if strings.TrimSpace(pageOut.Next) != "" {
		req.Cursor = encodeFeatheryCursor(featheryCursorState{NextURL: pageOut.Next, Since: firstString(state.Since, since)})
	} else if strings.TrimSpace(latest) != "" {
		req.Cursor = encodeFeatheryCursor(featheryCursorState{Since: latest})
	} else if strings.TrimSpace(state.Since) != "" {
		req.Cursor = encodeFeatheryCursor(featheryCursorState{Since: state.Since})
	} else {
		req.Cursor = encodeFeatheryCursor(featheryCursorState{Since: featheryNow(b.Now).Format(time.RFC3339Nano)})
	}
	return req, nil
}

type featheryCursorState struct {
	NextURL  string `json:"next_url,omitempty"`
	Since    string `json:"since,omitempty"`
	Complete bool   `json:"complete,omitempty"`
}

func decodeFeatheryCursor(cursor string) (featheryCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return featheryCursorState{}, nil
	}
	if cursor == featheryCursorComplete {
		return featheryCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, featheryCursorPrefix) {
		return featheryCursorState{}, fmt.Errorf("invalid Feathery cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, featheryCursorPrefix))
	if raw == "" {
		return featheryCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return featheryCursorState{}, fmt.Errorf("invalid Feathery cursor")
	}
	var out featheryCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return featheryCursorState{}, fmt.Errorf("invalid Feathery cursor")
	}
	out.NextURL = strings.TrimSpace(out.NextURL)
	out.Since = strings.TrimSpace(out.Since)
	return out, nil
}

func encodeFeatheryCursor(state featheryCursorState) string {
	if state.Complete {
		return featheryCursorComplete
	}
	state.NextURL = strings.TrimSpace(state.NextURL)
	state.Since = strings.TrimSpace(state.Since)
	raw, _ := json.Marshal(state)
	return featheryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type featherySubmissionsResponse struct {
	Count       int                  `json:"count"`
	Next        string               `json:"next"`
	Previous    string               `json:"previous"`
	TotalPages  int                  `json:"total_pages"`
	CurrentPage int                  `json:"current_page"`
	Results     []featherySubmission `json:"results"`
	Raw         map[string]any       `json:"-"`
}

type featherySubmission struct {
	UserID          string               `json:"user_id"`
	SubmissionStart string               `json:"submission_start"`
	LastSubmitted   string               `json:"last_submitted"`
	Values          []featheryFieldValue `json:"values"`
	Raw             map[string]any       `json:"-"`
}

type featheryFieldValue struct {
	ID          string         `json:"id"`
	Type        string         `json:"type"`
	CreatedAt   string         `json:"created_at"`
	UpdatedAt   string         `json:"updated_at"`
	Value       any            `json:"value"`
	Hidden      bool           `json:"hidden"`
	DisplayText string         `json:"display_text"`
	InternalID  string         `json:"internal_id"`
	Raw         map[string]any `json:"-"`
}

func (r *featherySubmissionsResponse) UnmarshalJSON(raw []byte) error {
	type alias featherySubmissionsResponse
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*r = featherySubmissionsResponse(out)
	r.Raw = nonNilMap(rawMap)
	return nil
}

func (s *featherySubmission) UnmarshalJSON(raw []byte) error {
	type alias featherySubmission
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*s = featherySubmission(out)
	s.Raw = nonNilMap(rawMap)
	return nil
}

func (v *featheryFieldValue) UnmarshalJSON(raw []byte) error {
	var rawMap map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&rawMap); err != nil {
		return err
	}
	v.ID = featheryStringValue(rawMap["id"])
	v.Type = featheryStringValue(rawMap["type"])
	v.CreatedAt = featheryStringValue(rawMap["created_at"])
	v.UpdatedAt = featheryStringValue(rawMap["updated_at"])
	v.Value = normalizeFeatheryValue(rawMap["value"])
	v.Hidden = strings.EqualFold(featheryStringValue(rawMap["hidden"]), "true")
	v.DisplayText = featheryStringValue(rawMap["display_text"])
	v.InternalID = featheryStringValue(rawMap["internal_id"])
	v.Raw = nonNilMap(rawMap)
	return nil
}

func fetchFeatherySubmissions(ctx context.Context, client *http.Client, baseURL, apiKey, userAgent, formID, nextURL, since string, pageSize int, integration Integration) (featherySubmissionsResponse, error) {
	path := "/api/form/submission/"
	query := url.Values{}
	if strings.TrimSpace(nextURL) == "" {
		query.Set("form_id", formID)
		query.Set("page_size", strconv.Itoa(featheryPageSize(pageSize)))
		if strings.TrimSpace(since) != "" {
			query.Set("start_time", strings.TrimSpace(since))
		}
		for _, key := range []string{"user_id", "end_time", "created_after", "created_before", "completed", "field_search", "fuzzy_search", "fields", "no_field_values", "sort", "use_cache"} {
			if value := settingString(integration.Settings, key); value != "" {
				query.Set(key, value)
			}
		}
	}
	raw, err := featheryDoRaw(ctx, client, baseURL, apiKey, userAgent, http.MethodGet, path, query, nextURL, nil)
	if err != nil {
		return featherySubmissionsResponse{}, err
	}
	var out featherySubmissionsResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return featherySubmissionsResponse{}, fmt.Errorf("decode feathery submissions response: %w", err)
	}
	return out, nil
}

func featheryDoRaw(ctx context.Context, client *http.Client, baseURL, apiKey, userAgent, method, path string, query url.Values, absoluteURL string, body io.Reader) ([]byte, error) {
	target := strings.TrimSpace(absoluteURL)
	if target == "" {
		target = strings.TrimRight(baseURL, "/") + path
	}
	u, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	if query != nil && len(query) > 0 {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Token "+strings.TrimSpace(apiKey))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, featheryDefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, featheryResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, FeatheryProviderError{Path: path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: featheryResponseSnippet(raw)}
	}
	return raw, nil
}

type FeatheryProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e FeatheryProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("feathery REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("feathery REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapFeatherySubmission(item featherySubmission, integration Integration, formID string) SubmissionInput {
	fields := map[string]any{
		"feathery_user_id":          item.UserID,
		"feathery_form_id":          formID,
		"feathery_submission_start": item.SubmissionStart,
		"feathery_last_submitted":   item.LastSubmitted,
		"feathery_provider_raw":     item.Raw,
	}
	identity := typeformIdentity{}
	for _, field := range item.Values {
		key := firstString(field.DisplayText, field.ID, field.InternalID)
		if strings.TrimSpace(key) == "" {
			continue
		}
		value := normalizeFeatheryValue(field.Value)
		normalizedKey := normalizeTypeformIdentityKey(key)
		fields["feathery_field."+normalizedKey] = value
		fields["feathery_field_id."+normalizedKey] = field.ID
		fields["feathery_field_type."+normalizedKey] = field.Type
		fields["feathery_field_hidden."+normalizedKey] = field.Hidden
		fields["feathery_field_internal_id."+normalizedKey] = field.InternalID
		applyFeatheryIdentity(&identity, field, value, integration)
	}
	submittedAt := parseFilloutTime(firstString(item.LastSubmitted, item.SubmissionStart))
	return SubmissionInput{
		SourceID:    featherySourceID(formID, item.UserID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    settingString(integration.Settings, "form_name"),
		EventName:   "lead.submitted",
		Tags:        featheryTags(integration, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func applyFeatheryIdentity(identity *typeformIdentity, field featheryFieldValue, value any, integration Integration) {
	if identity == nil {
		return
	}
	applyFilloutStructuredIdentity(identity, value)
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "" || text == "<nil>" {
		return
	}
	id := strings.TrimSpace(field.ID)
	switch {
	case settingMatchesFeatheryField(integration, id, "email_field_id"):
		identity.Email = text
	case settingMatchesFeatheryField(integration, id, "first_name_field_id"):
		identity.FirstName = text
	case settingMatchesFeatheryField(integration, id, "last_name_field_id"):
		identity.LastName = text
	case settingMatchesFeatheryField(integration, id, "full_name_field_id"):
		identity.FullName = text
	case settingMatchesFeatheryField(integration, id, "phone_field_id"):
		identity.Phone = text
	case settingMatchesFeatheryField(integration, id, "company_field_id"):
		identity.Company = text
	default:
		key := normalizeTypeformIdentityKey(firstString(field.DisplayText, field.ID, field.InternalID))
		if identity.Email == "" && (strings.Contains(key, "email") || strings.Contains(strings.ToLower(field.Type), "email") || strings.Contains(text, "@")) {
			identity.Email = text
		}
		identity.apply(firstString(field.DisplayText, field.ID), text)
	}
}

func settingMatchesFeatheryField(integration Integration, id, key string) bool {
	for _, part := range strings.Split(settingString(integration.Settings, key), ",") {
		if strings.TrimSpace(part) == id {
			return true
		}
	}
	return false
}

func normalizeFeatheryValue(value any) any {
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
			out = append(out, normalizeFeatheryValue(item))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = normalizeFeatheryValue(item)
		}
		return out
	default:
		return typed
	}
}

func featheryPageSize(size int) int {
	if size <= 0 {
		return featheryDefaultPageSize
	}
	if size > featheryMaxPageSize {
		return featheryMaxPageSize
	}
	return size
}

func featheryStringValue(value any) string {
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

func featheryNow(now func() time.Time) time.Time {
	if now != nil {
		return now().UTC()
	}
	return time.Now().UTC()
}

func laterFeatheryTimestamp(current, candidate string) string {
	current = strings.TrimSpace(current)
	candidate = strings.TrimSpace(candidate)
	if current == "" {
		return candidate
	}
	if candidate == "" {
		return current
	}
	currentAt, currentErr := time.Parse(time.RFC3339Nano, current)
	candidateAt, candidateErr := time.Parse(time.RFC3339Nano, candidate)
	if currentErr != nil || candidateErr != nil {
		if candidate > current {
			return candidate
		}
		return current
	}
	if candidateAt.After(currentAt) {
		return candidate
	}
	return current
}

func featherySourceID(formID, userID string) string {
	formID = strings.TrimSpace(formID)
	userID = strings.TrimSpace(userID)
	if formID == "" || userID == "" || userID == "<nil>" {
		return ""
	}
	return "feathery://submission/" + formID + "/" + userID
}

func featheryTags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"feathery", "feathery:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func featheryResponseSnippet(raw []byte) string {
	snippet := strings.TrimSpace(string(raw))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	return snippet
}
