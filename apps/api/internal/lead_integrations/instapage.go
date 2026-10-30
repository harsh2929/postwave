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
	instapageCursorPrefix      = "instapage:"
	instapageCursorComplete    = "instapage:complete"
	instapageDefaultAPIBaseURL = "https://api.instapage.com"
	instapageResponseMaxBytes  = 8 << 20
	instapageDefaultUserAgent  = "Moosewave Instapage Integration"
)

type InstapageCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type InstapageCredentialResolver interface {
	ResolveInstapage(context.Context, string, Integration) (InstapageCredentials, error)
}

type InstapageBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type InstapageRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials InstapageCredentialResolver
	APIBaseURL  string
	UserAgent   string
	Now         func() time.Time
}

type InstapageRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type InstapageSecretsCredentialResolver struct {
	Secrets InstapageRuntimeSecretResolver
}

func NewInstapageSecretsCredentialResolver(secrets InstapageRuntimeSecretResolver) *InstapageSecretsCredentialResolver {
	return &InstapageSecretsCredentialResolver{Secrets: secrets}
}

func (r *InstapageSecretsCredentialResolver) ResolveInstapage(ctx context.Context, _ string, integration Integration) (InstapageCredentials, error) {
	if r == nil || r.Secrets == nil {
		return InstapageCredentials{}, fmt.Errorf("instapage credential resolver is not configured")
	}
	ref := instapageCredentialRef(integration)
	if ref == "" {
		return InstapageCredentials{}, fmt.Errorf("instapage credentials_ref is required")
	}
	var payload instapageCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return InstapageCredentials{}, fmt.Errorf("resolve instapage credentials %q: %w", ref, err)
		}
		return parseInstapageCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return InstapageCredentials{}, fmt.Errorf("resolve instapage credentials %q: %w", ref, err)
	}
	return parseInstapageCredentialSecret(raw)
}

type instapageCredentialPayload struct {
	AccessToken string `json:"access_token"`
	Token       string `json:"token"`
	BearerToken string `json:"bearer_token"`
	APIKey      string `json:"api_key"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p instapageCredentialPayload) credentials() (InstapageCredentials, error) {
	token := normalizeInstapageBearerToken(firstString(p.AccessToken, p.Token, p.BearerToken, p.APIKey))
	if token == "" {
		return InstapageCredentials{}, fmt.Errorf("instapage access_token or api_key is required")
	}
	return InstapageCredentials{
		AccessToken: token,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseInstapageCredentialSecret(raw string) (InstapageCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return InstapageCredentials{}, fmt.Errorf("instapage credentials are empty")
	}
	var payload instapageCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return InstapageCredentials{}, fmt.Errorf("parse instapage credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseInstapageKeyValueSecret(raw).credentials()
	}
	return instapageCredentialPayload{AccessToken: raw}.credentials()
}

func parseInstapageKeyValueSecret(raw string) instapageCredentialPayload {
	var payload instapageCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "access_token":
			payload.AccessToken = value
		case "token":
			payload.Token = value
		case "bearer_token":
			payload.BearerToken = value
		case "api_key":
			payload.APIKey = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func normalizeInstapageBearerToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func instapageCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b InstapageRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderInstapage {
		return SyncRequest{}, fmt.Errorf("instapage backfill requires an Instapage integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("instapage credential resolver is not configured")
	}
	workspaceID := strings.TrimSpace(settingString(integration.Settings, "workspace_id"))
	if workspaceID == "" {
		return SyncRequest{}, fmt.Errorf("instapage workspace_id is required")
	}
	pageIDs := instapagePageIDs(integration.Settings)
	if len(pageIDs) == 0 {
		return SyncRequest{}, fmt.Errorf("instapage page_id is required")
	}
	creds, err := b.Credentials.ResolveInstapage(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("instapage access_token is required")
	}
	state, err := decodeInstapageCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: instapageCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderInstapage, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), instapageDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), instapageDefaultUserAgent)
	since := firstNonZero64(state.Since, instapageUnixSetting(integration.Settings, "from"), instapageUnixSetting(integration.Settings, "start"), instapageUnixSetting(integration.Settings, "start_time"), instapageUnixSetting(integration.Settings, "created_from"))
	to := firstNonZero64(instapageUnixSetting(integration.Settings, "to"), instapageUnixSetting(integration.Settings, "end"), instapageUnixSetting(integration.Settings, "end_time"), instapageUnixSetting(integration.Settings, "created_to"))
	pageOut, err := fetchInstapageSubmissions(ctx, client, baseURL, creds.AccessToken, userAgent, workspaceID, pageIDs, state.NextPageToken, since, to, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(pageOut.Submissions))}
	latest := since
	for _, item := range pageOut.Submissions {
		submission := mapInstapageSubmission(item, integration, workspaceID, pageIDs[0])
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
		if submitted := instapageSubmittedUnix(item.CreatedAt); submitted > latest {
			latest = submitted
		}
	}
	if pageOut.NextPageToken != "" {
		req.Cursor = encodeInstapageCursor(instapageCursorState{NextPageToken: pageOut.NextPageToken, Since: since})
	} else if latest > 0 {
		req.Cursor = encodeInstapageCursor(instapageCursorState{Since: latest})
	} else if state.Since > 0 {
		req.Cursor = encodeInstapageCursor(instapageCursorState{Since: state.Since})
	} else {
		req.Cursor = encodeInstapageCursor(instapageCursorState{Since: instapageNow(b.Now).Unix()})
	}
	return req, nil
}

type instapageCursorState struct {
	NextPageToken string `json:"next_page_token,omitempty"`
	Since         int64  `json:"since,omitempty"`
	Complete      bool   `json:"complete,omitempty"`
}

func decodeInstapageCursor(cursor string) (instapageCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return instapageCursorState{}, nil
	}
	if cursor == instapageCursorComplete {
		return instapageCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, instapageCursorPrefix) {
		return instapageCursorState{}, fmt.Errorf("invalid Instapage cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, instapageCursorPrefix))
	if raw == "" {
		return instapageCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return instapageCursorState{}, fmt.Errorf("invalid Instapage cursor")
	}
	var out instapageCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return instapageCursorState{}, fmt.Errorf("invalid Instapage cursor")
	}
	out.NextPageToken = strings.TrimSpace(out.NextPageToken)
	if out.Since < 0 {
		out.Since = 0
	}
	return out, nil
}

func encodeInstapageCursor(state instapageCursorState) string {
	if state.Complete {
		return instapageCursorComplete
	}
	state.NextPageToken = strings.TrimSpace(state.NextPageToken)
	if state.Since < 0 {
		state.Since = 0
	}
	raw, _ := json.Marshal(state)
	return instapageCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type instapageSubmissionsResponse struct {
	Submissions   []instapageSubmission
	NextPageToken string
	Raw           map[string]any
}

func (r *instapageSubmissionsResponse) UnmarshalJSON(raw []byte) error {
	var payload map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&payload); err != nil {
		return err
	}
	r.Raw = nonNilMap(payload)
	r.NextPageToken = instapageFindString(payload, "nextPageToken", "next_page_token", "next")
	if r.NextPageToken == "" {
		if meta, ok := instapageMap(payload["meta"]); ok {
			r.NextPageToken = instapageFindString(meta, "nextPageToken", "next_page_token", "next")
		}
	}
	if r.NextPageToken == "" {
		if pagination, ok := instapageMap(payload["pagination"]); ok {
			r.NextPageToken = instapageFindString(pagination, "nextPageToken", "next_page_token", "next")
		}
	}
	if dataMap, ok := instapageMap(payload["data"]); ok {
		if r.NextPageToken == "" {
			r.NextPageToken = instapageFindString(dataMap, "nextPageToken", "next_page_token", "next")
		}
		if items, ok := instapageSlice(dataMap["submissions"]); ok {
			r.Submissions = decodeInstapageSubmissions(items)
		}
	}
	if len(r.Submissions) == 0 {
		if items, ok := instapageSlice(payload["submissions"]); ok {
			r.Submissions = decodeInstapageSubmissions(items)
		}
	}
	if len(r.Submissions) == 0 {
		if items, ok := instapageSlice(payload["data"]); ok {
			r.Submissions = decodeInstapageSubmissions(items)
		}
	}
	return nil
}

type instapageSubmission struct {
	ID        string
	PageID    string
	CreatedAt string
	Fields    map[string]any
	Raw       map[string]any
}

func (s *instapageSubmission) UnmarshalJSON(raw []byte) error {
	var payload map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&payload); err != nil {
		return err
	}
	s.Raw = nonNilMap(payload)
	s.ID = instapageFindString(payload, "id", "submission_id", "submissionId", "uuid")
	s.PageID = instapageFindString(payload, "page_id", "pageId", "landing_page_id", "landingPageId", "pageID")
	s.CreatedAt = instapageFindString(payload, "created_at", "createdAt", "submitted_at", "submittedAt", "timestamp", "created")
	s.Fields = instapageSubmissionFields(payload)
	return nil
}

func fetchInstapageSubmissions(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, workspaceID string, pageIDs []string, nextPageToken string, since, to int64, integration Integration) (instapageSubmissionsResponse, error) {
	body := map[string]any{
		"pages": pageIDs,
	}
	if nextPageToken = strings.TrimSpace(nextPageToken); nextPageToken != "" {
		body["nextPageToken"] = nextPageToken
	}
	if since > 0 || to > 0 {
		window := map[string]any{}
		if since > 0 {
			window["start"] = since
		}
		if to > 0 {
			window["end"] = to
		}
		key := strings.TrimSpace(settingString(integration.Settings, "timeframe_key"))
		if key == "" {
			key = "timeframe"
		}
		body[key] = window
	}
	raw, err := instapageDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodPost, "/v1/workspaces/"+url.PathEscape(workspaceID)+"/submissions", body)
	if err != nil {
		return instapageSubmissionsResponse{}, err
	}
	var out instapageSubmissionsResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return instapageSubmissionsResponse{}, fmt.Errorf("decode instapage submissions: %w", err)
	}
	return out, nil
}

func instapageDoRaw(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, method, pathValue string, body any) ([]byte, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + pathValue)
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, instapageDefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, instapageResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, InstapageProviderError{Path: pathValue, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: instapageResponseSnippet(raw)}
	}
	return raw, nil
}

type InstapageProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e InstapageProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("instapage REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("instapage REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapInstapageSubmission(item instapageSubmission, integration Integration, workspaceID, fallbackPageID string) SubmissionInput {
	pageID := firstString(item.PageID, fallbackPageID, settingString(integration.Settings, "page_id"))
	fields := map[string]any{
		"instapage_submission_id": item.ID,
		"instapage_workspace_id":  workspaceID,
		"instapage_page_id":       pageID,
		"instapage_created_at":    item.CreatedAt,
		"instapage_provider_raw":  item.Raw,
	}
	identity := typeformIdentity{}
	for key, value := range item.Fields {
		normalizedKey := normalizeTypeformIdentityKey(key)
		normalizedValue := instapageNormalizeValue(value)
		fields["instapage_field."+normalizedKey] = normalizedValue
		applyInstapageIdentity(&identity, integration, key, normalizedValue)
	}
	submittedAt := instapageSubmittedAt(item.CreatedAt)
	return SubmissionInput{
		SourceID:    instapageSourceID(workspaceID, pageID, item.ID, item.Raw),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      firstString(settingString(integration.Settings, "form_id"), pageID),
		FormName:    firstString(settingString(integration.Settings, "form_name"), settingString(integration.Settings, "page_name")),
		EventName:   "lead.submitted",
		Tags:        instapageTags(integration, pageID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func applyInstapageIdentity(identity *typeformIdentity, integration Integration, key string, value any) {
	if identity == nil {
		return
	}
	text := strings.TrimSpace(instapageValueText(value))
	if text == "" || text == "<nil>" {
		return
	}
	if instapageIdentitySettingMatches(integration, key, "email") && identity.Email == "" {
		identity.Email = text
	}
	if instapageIdentitySettingMatches(integration, key, "first_name") && identity.FirstName == "" {
		identity.FirstName = text
	}
	if instapageIdentitySettingMatches(integration, key, "last_name") && identity.LastName == "" {
		identity.LastName = text
	}
	if instapageIdentitySettingMatches(integration, key, "full_name") && identity.FullName == "" {
		identity.FullName = text
	}
	if instapageIdentitySettingMatches(integration, key, "phone") && identity.Phone == "" {
		identity.Phone = text
	}
	if instapageIdentitySettingMatches(integration, key, "company") && identity.Company == "" {
		identity.Company = text
	}
	applyFilloutStructuredIdentity(identity, value)
	identity.apply(key, text)
}

func instapageIdentitySettingMatches(integration Integration, fieldKey, prefix string) bool {
	candidates := []string{
		settingString(integration.Settings, prefix+"_field_id"),
		settingString(integration.Settings, prefix+"_field"),
		settingString(integration.Settings, prefix+"_field_name"),
	}
	key := strings.ToLower(strings.TrimSpace(fieldKey))
	normalizedKey := normalizeTypeformIdentityKey(key)
	for _, candidate := range candidates {
		candidate = strings.ToLower(strings.TrimSpace(candidate))
		if candidate == "" {
			continue
		}
		if candidate == key || normalizeTypeformIdentityKey(candidate) == normalizedKey {
			return true
		}
	}
	return false
}

func instapageSubmissionFields(payload map[string]any) map[string]any {
	for _, key := range []string{"fields", "form_data", "formData", "answers", "values"} {
		if fields := instapageFieldsMap(payload[key]); len(fields) > 0 {
			return fields
		}
	}
	out := map[string]any{}
	for key, value := range payload {
		switch key {
		case "id", "submission_id", "submissionId", "uuid", "page_id", "pageId", "landing_page_id", "landingPageId", "pageID", "created_at", "createdAt", "submitted_at", "submittedAt", "timestamp", "created":
			continue
		default:
			out[key] = value
		}
	}
	return out
}

func instapageFieldsMap(value any) map[string]any {
	if fields, ok := instapageMap(value); ok {
		out := map[string]any{}
		for key, item := range fields {
			out[key] = instapageNormalizeValue(item)
		}
		return out
	}
	items, ok := instapageSlice(value)
	if !ok {
		return nil
	}
	out := map[string]any{}
	for i, item := range items {
		field, ok := instapageMap(item)
		if !ok {
			out["field_"+strconv.Itoa(i+1)] = instapageNormalizeValue(item)
			continue
		}
		key := instapageFindString(field, "key", "name", "label", "id", "field_id", "fieldId")
		if key == "" {
			key = "field_" + strconv.Itoa(i+1)
		}
		out[key] = instapageNormalizeValue(firstInstapageAny(field, "value", "answer", "text", "data"))
	}
	return out
}

func instapageNormalizeValue(value any) any {
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
			out = append(out, instapageNormalizeValue(item))
		}
		if len(out) == 1 {
			return out[0]
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = instapageNormalizeValue(item)
		}
		return out
	default:
		return typed
	}
}

func instapageValueText(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			text := strings.TrimSpace(instapageValueText(item))
			if text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, ", ")
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func decodeInstapageSubmissions(items []any) []instapageSubmission {
	out := make([]instapageSubmission, 0, len(items))
	for _, item := range items {
		raw, err := json.Marshal(item)
		if err != nil {
			continue
		}
		var submission instapageSubmission
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		if err := dec.Decode(&submission); err == nil {
			out = append(out, submission)
		}
	}
	return out
}

func instapageMap(value any) (map[string]any, bool) {
	typed, ok := value.(map[string]any)
	return typed, ok
}

func instapageSlice(value any) ([]any, bool) {
	typed, ok := value.([]any)
	return typed, ok
}

func instapageFindString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		text := strings.TrimSpace(instapageValueText(values[key]))
		if text != "" && text != "<nil>" {
			return text
		}
	}
	return ""
}

func firstInstapageAny(values map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := values[key]; ok && value != nil {
			return value
		}
	}
	return nil
}

func instapagePageIDs(settings map[string]any) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, raw := range []string{settingString(settings, "page_id"), settingString(settings, "page_ids")} {
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if part == "" || seen[strings.ToLower(part)] {
				continue
			}
			seen[strings.ToLower(part)] = true
			out = append(out, part)
		}
	}
	return out
}

func instapageUnixSetting(settings map[string]any, key string) int64 {
	if settings == nil {
		return 0
	}
	return instapageUnixValue(settings[key])
}

func instapageUnixValue(value any) int64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case int:
		return int64(typed)
	case int64:
		return typed
	case float64:
		return int64(typed)
	case json.Number:
		if i, err := typed.Int64(); err == nil {
			return normalizeInstapageUnix(i)
		}
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0
		}
		if i, err := strconv.ParseInt(text, 10, 64); err == nil {
			return normalizeInstapageUnix(i)
		}
		if parsed := parseFilloutTime(text); parsed != nil {
			return parsed.UTC().Unix()
		}
	}
	return 0
}

func instapageSubmittedUnix(raw string) int64 {
	return instapageUnixValue(raw)
}

func instapageSubmittedAt(raw string) *time.Time {
	seconds := instapageSubmittedUnix(raw)
	if seconds <= 0 {
		return nil
	}
	t := time.Unix(seconds, 0).UTC()
	return &t
}

func normalizeInstapageUnix(value int64) int64 {
	if value > 9999999999 {
		return value / 1000
	}
	return value
}

func firstNonZero64(values ...int64) int64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func instapageSourceID(workspaceID, pageID, submissionID string, raw map[string]any) string {
	workspaceID = strings.TrimSpace(workspaceID)
	pageID = strings.TrimSpace(pageID)
	submissionID = strings.TrimSpace(submissionID)
	if workspaceID == "" {
		return ""
	}
	if submissionID == "" || submissionID == "<nil>" {
		encoded, _ := json.Marshal(raw)
		sum := sha256.Sum256(encoded)
		submissionID = "raw_" + hex.EncodeToString(sum[:8])
	}
	if pageID == "" {
		pageID = "unknown_page"
	}
	return "instapage://submission/" + workspaceID + "/" + pageID + "/" + submissionID
}

func instapageTags(integration Integration, pageID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"instapage", "instapage:" + pageID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func instapageNow(now func() time.Time) time.Time {
	if now != nil {
		return now().UTC()
	}
	return time.Now().UTC()
}

func instapageResponseSnippet(raw []byte) string {
	snippet := strings.TrimSpace(string(raw))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	return snippet
}
