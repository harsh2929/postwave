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
	paperformCursorPrefix      = "paperform:"
	paperformCursorComplete    = "paperform:complete"
	paperformDefaultAPIBaseURL = "https://api.paperform.co/v1"
	paperformResponseMaxBytes  = 8 << 20
	paperformDefaultPageSize   = 100
	paperformMaxPageSize       = 100
	paperformDefaultUserAgent  = "Moosewave Paperform Integration"
)

type PaperformCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type PaperformCredentialResolver interface {
	ResolvePaperform(context.Context, string, Integration) (PaperformCredentials, error)
}

type PaperformBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type PaperformRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials PaperformCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type PaperformRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type PaperformSecretsCredentialResolver struct {
	Secrets PaperformRuntimeSecretResolver
}

func NewPaperformSecretsCredentialResolver(secrets PaperformRuntimeSecretResolver) *PaperformSecretsCredentialResolver {
	return &PaperformSecretsCredentialResolver{Secrets: secrets}
}

func (r *PaperformSecretsCredentialResolver) ResolvePaperform(ctx context.Context, _ string, integration Integration) (PaperformCredentials, error) {
	if r == nil || r.Secrets == nil {
		return PaperformCredentials{}, fmt.Errorf("paperform credential resolver is not configured")
	}
	ref := paperformCredentialRef(integration)
	if ref == "" {
		return PaperformCredentials{}, fmt.Errorf("paperform credentials_ref is required")
	}
	var payload paperformCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return PaperformCredentials{}, fmt.Errorf("resolve paperform credentials %q: %w", ref, err)
		}
		return parsePaperformCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return PaperformCredentials{}, fmt.Errorf("resolve paperform credentials %q: %w", ref, err)
	}
	return parsePaperformCredentialSecret(raw)
}

type paperformCredentialPayload struct {
	AccessToken string `json:"access_token"`
	APIKey      string `json:"api_key"`
	Token       string `json:"token"`
	BearerToken string `json:"bearer_token"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p paperformCredentialPayload) credentials() (PaperformCredentials, error) {
	token := normalizePaperformBearerToken(firstString(p.AccessToken, p.APIKey, p.Token, p.BearerToken))
	if token == "" {
		return PaperformCredentials{}, fmt.Errorf("paperform api_key or access_token is required")
	}
	return PaperformCredentials{
		AccessToken: token,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

func parsePaperformCredentialSecret(raw string) (PaperformCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return PaperformCredentials{}, fmt.Errorf("paperform credentials are empty")
	}
	var payload paperformCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return PaperformCredentials{}, fmt.Errorf("parse paperform credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parsePaperformKeyValueSecret(raw).credentials()
	}
	return paperformCredentialPayload{AccessToken: raw}.credentials()
}

func parsePaperformKeyValueSecret(raw string) paperformCredentialPayload {
	var payload paperformCredentialPayload
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

func normalizePaperformBearerToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func paperformCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b PaperformRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderPaperform {
		return SyncRequest{}, fmt.Errorf("paperform backfill requires a Paperform integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("paperform credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("paperform form_id is required")
	}
	creds, err := b.Credentials.ResolvePaperform(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("paperform access token is required")
	}
	state, err := decodePaperformCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: paperformCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderPaperform, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), paperformDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), paperformDefaultUserAgent)
	pageSize := paperformPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	skip := state.Skip
	if skip < 0 {
		skip = 0
	}
	pageOut, err := fetchPaperformSubmissions(ctx, client, baseURL, creds.AccessToken, userAgent, formID, skip, pageSize, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	items := pageOut.Results.Submissions
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(items))}
	for _, item := range items {
		submission := mapPaperformSubmission(item, integration, formID)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	if !pageOut.HasMore || len(items) == 0 {
		req.Cursor = paperformCursorComplete
	} else {
		nextSkip := pageOut.Skip + len(items)
		if pageOut.Limit > 0 && len(items) >= pageOut.Limit {
			nextSkip = pageOut.Skip + pageOut.Limit
		}
		req.Cursor = encodePaperformCursor(paperformCursorState{Skip: nextSkip})
	}
	return req, nil
}

type paperformCursorState struct {
	Skip     int  `json:"skip,omitempty"`
	Complete bool `json:"complete,omitempty"`
}

func decodePaperformCursor(cursor string) (paperformCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return paperformCursorState{Skip: 0}, nil
	}
	if cursor == paperformCursorComplete {
		return paperformCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, paperformCursorPrefix) {
		return paperformCursorState{}, fmt.Errorf("invalid Paperform cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, paperformCursorPrefix))
	if raw == "" {
		return paperformCursorState{Skip: 0}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return paperformCursorState{}, fmt.Errorf("invalid Paperform cursor")
	}
	var out paperformCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return paperformCursorState{}, fmt.Errorf("invalid Paperform cursor")
	}
	if out.Skip < 0 {
		out.Skip = 0
	}
	return out, nil
}

func encodePaperformCursor(state paperformCursorState) string {
	if state.Complete {
		return paperformCursorComplete
	}
	if state.Skip < 0 {
		state.Skip = 0
	}
	raw, _ := json.Marshal(state)
	return paperformCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type paperformSubmissionsResponse struct {
	Status  string           `json:"status"`
	Results paperformResults `json:"results"`
	Total   int              `json:"total"`
	HasMore bool             `json:"has_more"`
	Limit   int              `json:"limit"`
	Skip    int              `json:"skip"`
	Raw     map[string]any   `json:"-"`
}

type paperformResults struct {
	Submissions []paperformSubmission `json:"submissions"`
}

type paperformSubmission struct {
	ID              string         `json:"id"`
	FormID          string         `json:"form_id"`
	Data            map[string]any `json:"data"`
	Device          map[string]any `json:"device"`
	Charge          map[string]any `json:"charge"`
	PDFs            map[string]any `json:"pdfs"`
	CreatedAt       string         `json:"created_at"`
	AccountTimezone string         `json:"account_timezone"`
	CreatedAtUTC    string         `json:"created_at_utc"`
	Raw             map[string]any `json:"-"`
}

func (r *paperformSubmissionsResponse) UnmarshalJSON(raw []byte) error {
	type alias paperformSubmissionsResponse
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*r = paperformSubmissionsResponse(out)
	r.Raw = nonNilMap(rawMap)
	return nil
}

func (s *paperformSubmission) UnmarshalJSON(raw []byte) error {
	type alias paperformSubmission
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*s = paperformSubmission(out)
	s.Raw = nonNilMap(rawMap)
	s.Data = nonNilMap(s.Data)
	return nil
}

func fetchPaperformSubmissions(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, formID string, skip, limit int, integration Integration) (paperformSubmissionsResponse, error) {
	query := url.Values{}
	query.Set("limit", strconv.Itoa(paperformPageSize(limit)))
	query.Set("skip", strconv.Itoa(skip))
	query.Set("sort", firstString(settingString(integration.Settings, "sort"), "ASC"))
	for _, key := range []string{"after_id", "before_id", "after_date", "before_date"} {
		if value := settingString(integration.Settings, key); value != "" {
			query.Set(key, value)
		}
	}
	raw, err := paperformDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, "/forms/"+url.PathEscape(formID)+"/submissions", query, nil)
	if err != nil {
		return paperformSubmissionsResponse{}, err
	}
	var out paperformSubmissionsResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return paperformSubmissionsResponse{}, fmt.Errorf("decode paperform submissions response: %w", err)
	}
	return out, nil
}

func paperformDoRaw(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, method, path string, query url.Values, body io.Reader) ([]byte, error) {
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
	req.Header.Set("User-Agent", firstString(userAgent, paperformDefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, paperformResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, PaperformProviderError{Path: path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: paperformResponseSnippet(raw)}
	}
	return raw, nil
}

type PaperformProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e PaperformProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("paperform REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("paperform REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapPaperformSubmission(item paperformSubmission, integration Integration, fallbackFormID string) SubmissionInput {
	formID := firstString(item.FormID, fallbackFormID, settingString(integration.Settings, "form_id"))
	fields := map[string]any{
		"paperform_submission_id":    item.ID,
		"paperform_form_id":          formID,
		"paperform_created_at":       item.CreatedAt,
		"paperform_created_at_utc":   item.CreatedAtUTC,
		"paperform_account_timezone": item.AccountTimezone,
		"paperform_device":           nonNilMap(item.Device),
		"paperform_charge":           nonNilMap(item.Charge),
		"paperform_pdfs":             nonNilMap(item.PDFs),
		"paperform_provider_raw":     item.Raw,
	}
	identity := typeformIdentity{}
	for key, value := range item.Data {
		if strings.TrimSpace(key) == "" {
			continue
		}
		normalizedValue := normalizePaperformValue(value)
		normalizedKey := normalizeTypeformIdentityKey(key)
		fields["paperform_field."+normalizedKey] = normalizedValue
		applyPaperformIdentity(&identity, key, normalizedValue)
	}
	submittedAt := parseFilloutTime(firstString(item.CreatedAtUTC, item.CreatedAt))
	return SubmissionInput{
		SourceID:    paperformSourceID(formID, item.ID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    settingString(integration.Settings, "form_name"),
		EventName:   "lead.submitted",
		Tags:        paperformTags(integration, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func applyPaperformIdentity(identity *typeformIdentity, key string, value any) {
	if identity == nil {
		return
	}
	applyFilloutStructuredIdentity(identity, value)
	text := strings.TrimSpace(fmt.Sprint(value))
	normalized := normalizeTypeformIdentityKey(key)
	if strings.Contains(normalized, "email") && identity.Email == "" {
		identity.Email = text
	}
	if strings.Contains(normalized, "phone") && identity.Phone == "" {
		identity.Phone = text
	}
	identity.apply(key, text)
}

func normalizePaperformValue(value any) any {
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
			out = append(out, normalizePaperformValue(item))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = normalizePaperformValue(item)
		}
		return out
	default:
		return typed
	}
}

func paperformPageSize(size int) int {
	if size <= 0 {
		return paperformDefaultPageSize
	}
	if size > paperformMaxPageSize {
		return paperformMaxPageSize
	}
	return size
}

func paperformSourceID(formID, id string) string {
	formID = strings.TrimSpace(formID)
	id = strings.TrimSpace(id)
	if formID == "" || id == "" || id == "<nil>" {
		return ""
	}
	return "paperform://submission/" + formID + "/" + id
}

func paperformTags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"paperform", "paperform:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func paperformResponseSnippet(raw []byte) string {
	snippet := strings.TrimSpace(string(raw))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	return snippet
}
