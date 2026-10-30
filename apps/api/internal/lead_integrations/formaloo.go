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
	formalooCursorPrefix      = "formaloo:"
	formalooDefaultAPIBaseURL = "https://api.formaloo.me"
	formalooResponseMaxBytes  = 8 << 20
	formalooDefaultPageSize   = 100
	formalooMaxPageSize       = 1000
	formalooDefaultUserAgent  = "Moosewave Formaloo Integration"
)

type FormalooCredentials struct {
	APIKey             string
	APISecret          string
	AuthorizationToken string
	APIBaseURL         string
	WorkspaceID        string
	UserAgent          string
}

type FormalooCredentialResolver interface {
	ResolveFormaloo(context.Context, string, Integration) (FormalooCredentials, error)
}

type FormalooBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type FormalooRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials FormalooCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type FormalooRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type FormalooSecretsCredentialResolver struct {
	Secrets FormalooRuntimeSecretResolver
}

func NewFormalooSecretsCredentialResolver(secrets FormalooRuntimeSecretResolver) *FormalooSecretsCredentialResolver {
	return &FormalooSecretsCredentialResolver{Secrets: secrets}
}

func (r *FormalooSecretsCredentialResolver) ResolveFormaloo(ctx context.Context, _ string, integration Integration) (FormalooCredentials, error) {
	if r == nil || r.Secrets == nil {
		return FormalooCredentials{}, fmt.Errorf("Formaloo credential resolver is not configured")
	}
	ref := formalooCredentialRef(integration)
	if ref == "" {
		return FormalooCredentials{}, fmt.Errorf("Formaloo credentials_ref is required")
	}
	var payload formalooCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return FormalooCredentials{}, fmt.Errorf("resolve Formaloo credentials %q: %w", ref, err)
		}
		return parseFormalooCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return FormalooCredentials{}, fmt.Errorf("resolve Formaloo credentials %q: %w", ref, err)
	}
	return parseFormalooCredentialSecret(raw)
}

type formalooCredentialPayload struct {
	APIKey             string `json:"api_key"`
	XAPIKey            string `json:"x_api_key"`
	APISecret          string `json:"api_secret"`
	Secret             string `json:"secret"`
	AuthorizationToken string `json:"authorization_token"`
	AccessToken        string `json:"access_token"`
	JWT                string `json:"jwt"`
	Token              string `json:"token"`
	APIBaseURL         string `json:"api_base_url"`
	WorkspaceID        string `json:"workspace_id"`
	UserAgent          string `json:"user_agent"`
}

func (p formalooCredentialPayload) credentials() (FormalooCredentials, error) {
	creds := FormalooCredentials{
		APIKey:             strings.TrimSpace(firstString(p.APIKey, p.XAPIKey)),
		APISecret:          strings.TrimSpace(firstString(p.APISecret, p.Secret)),
		AuthorizationToken: normalizeFormalooJWT(firstString(p.AuthorizationToken, p.AccessToken, p.JWT, p.Token)),
		APIBaseURL:         strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		WorkspaceID:        strings.TrimSpace(p.WorkspaceID),
		UserAgent:          strings.TrimSpace(p.UserAgent),
	}
	if creds.APIKey == "" {
		return FormalooCredentials{}, fmt.Errorf("Formaloo api_key is required")
	}
	if creds.AuthorizationToken == "" && creds.APISecret == "" {
		return FormalooCredentials{}, fmt.Errorf("Formaloo api_secret or authorization_token is required")
	}
	return creds, nil
}

func parseFormalooCredentialSecret(raw string) (FormalooCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return FormalooCredentials{}, fmt.Errorf("Formaloo credentials are empty")
	}
	var payload formalooCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return FormalooCredentials{}, fmt.Errorf("parse Formaloo credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseFormalooKeyValueSecret(raw).credentials()
	}
	return FormalooCredentials{}, fmt.Errorf("Formaloo credentials must be JSON or key=value with api_key plus api_secret or authorization_token")
}

func parseFormalooKeyValueSecret(raw string) formalooCredentialPayload {
	var payload formalooCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "api_key", "x_api_key":
			payload.APIKey = value
		case "api_secret":
			payload.APISecret = value
		case "secret":
			payload.Secret = value
		case "authorization_token":
			payload.AuthorizationToken = value
		case "access_token":
			payload.AccessToken = value
		case "jwt":
			payload.JWT = value
		case "token":
			payload.Token = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "workspace_id":
			payload.WorkspaceID = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func normalizeFormalooJWT(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "JWT ")
	token = strings.TrimPrefix(token, "jwt ")
	token = strings.TrimPrefix(token, "Token ")
	token = strings.TrimPrefix(token, "token ")
	return strings.TrimSpace(token)
}

func formalooCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b FormalooRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderFormaloo {
		return SyncRequest{}, fmt.Errorf("Formaloo backfill requires a Formaloo integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("Formaloo credential resolver is not configured")
	}
	formSlug := strings.TrimSpace(firstString(settingString(integration.Settings, "form_slug"), settingString(integration.Settings, "form_id")))
	if formSlug == "" {
		return SyncRequest{}, fmt.Errorf("Formaloo form_slug or form_id is required")
	}
	creds, err := b.Credentials.ResolveFormaloo(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	state, err := decodeFormalooCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.FormSlug != "" && state.FormSlug != formSlug {
		state = formalooCursorState{}
	}
	client := leadEgressClient(b.HTTPClient, ProviderFormaloo, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), formalooDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), formalooDefaultUserAgent)
	token, err := formalooAuthorizationToken(ctx, client, baseURL, creds, userAgent)
	if err != nil {
		return SyncRequest{}, err
	}
	pageSize := formalooPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	pageOut, err := fetchFormalooRows(ctx, client, baseURL, creds.APIKey, token, userAgent, formalooWorkspaceID(creds, integration), formSlug, state, pageSize, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(pageOut.Rows))}
	baseState := state
	highWaterAt := firstString(state.HighWaterSubmittedAt, state.LastSubmittedAt)
	highWaterSlug := firstString(state.HighWaterSlug, state.LastSlug)
	for _, item := range pageOut.Rows {
		rowSlug := formalooRowID(item)
		submittedAt := formalooRowTime(item)
		if !formalooRowAfterCursor(submittedAt, rowSlug, baseState) {
			continue
		}
		submission := mapFormalooRow(item, integration, formSlug)
		if submission.SourceID == "" {
			continue
		}
		req.Submissions = append(req.Submissions, submission)
		if formalooRowAfterCursor(submittedAt, rowSlug, formalooCursorState{LastSubmittedAt: highWaterAt, LastSlug: highWaterSlug}) {
			highWaterAt = submittedAt
			highWaterSlug = rowSlug
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
		req.Cursor = encodeFormalooCursor(formalooCursorState{
			FormSlug:             formSlug,
			Page:                 currentPage + 1,
			LastSubmittedAt:      state.LastSubmittedAt,
			LastSlug:             state.LastSlug,
			HighWaterSubmittedAt: highWaterAt,
			HighWaterSlug:        highWaterSlug,
			NextURL:              pageOut.NextURL,
			Total:                pageOut.Total,
			PageCount:            pageOut.PageCount,
		})
	} else {
		req.Cursor = encodeFormalooCursor(formalooCursorState{
			FormSlug:        formSlug,
			LastSubmittedAt: highWaterAt,
			LastSlug:        highWaterSlug,
			Total:           pageOut.Total,
			PageCount:       pageOut.PageCount,
		})
	}
	return req, nil
}

type formalooCursorState struct {
	FormSlug             string `json:"form_slug,omitempty"`
	Page                 int    `json:"page,omitempty"`
	NextURL              string `json:"next_url,omitempty"`
	LastSubmittedAt      string `json:"last_submitted_at,omitempty"`
	LastSlug             string `json:"last_slug,omitempty"`
	HighWaterSubmittedAt string `json:"high_water_submitted_at,omitempty"`
	HighWaterSlug        string `json:"high_water_slug,omitempty"`
	Total                int    `json:"total,omitempty"`
	PageCount            int    `json:"page_count,omitempty"`
}

func decodeFormalooCursor(cursor string) (formalooCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return formalooCursorState{}, nil
	}
	if !strings.HasPrefix(cursor, formalooCursorPrefix) {
		return formalooCursorState{}, fmt.Errorf("invalid Formaloo cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, formalooCursorPrefix))
	if raw == "" {
		return formalooCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return formalooCursorState{}, fmt.Errorf("invalid Formaloo cursor")
	}
	var out formalooCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return formalooCursorState{}, fmt.Errorf("invalid Formaloo cursor")
	}
	out.FormSlug = strings.TrimSpace(out.FormSlug)
	out.NextURL = strings.TrimSpace(out.NextURL)
	out.LastSubmittedAt = strings.TrimSpace(out.LastSubmittedAt)
	out.LastSlug = strings.TrimSpace(out.LastSlug)
	out.HighWaterSubmittedAt = strings.TrimSpace(out.HighWaterSubmittedAt)
	out.HighWaterSlug = strings.TrimSpace(out.HighWaterSlug)
	if out.Page < 0 {
		out.Page = 0
	}
	if out.Total < 0 {
		out.Total = 0
	}
	if out.PageCount < 0 {
		out.PageCount = 0
	}
	return out, nil
}

func encodeFormalooCursor(state formalooCursorState) string {
	state.FormSlug = strings.TrimSpace(state.FormSlug)
	state.NextURL = strings.TrimSpace(state.NextURL)
	state.LastSubmittedAt = strings.TrimSpace(state.LastSubmittedAt)
	state.LastSlug = strings.TrimSpace(state.LastSlug)
	state.HighWaterSubmittedAt = strings.TrimSpace(state.HighWaterSubmittedAt)
	state.HighWaterSlug = strings.TrimSpace(state.HighWaterSlug)
	if state.Page < 0 {
		state.Page = 0
	}
	if state.Total < 0 {
		state.Total = 0
	}
	if state.PageCount < 0 {
		state.PageCount = 0
	}
	raw, _ := json.Marshal(state)
	return formalooCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type formalooRowsResponse struct {
	Rows        []formalooRow
	CurrentPage int
	PageCount   int
	Total       int
	NextURL     string
	HasMore     bool
	Raw         map[string]any
}

type formalooRow struct {
	Raw map[string]any
}

func formalooAuthorizationToken(ctx context.Context, client *http.Client, baseURL string, creds FormalooCredentials, userAgent string) (string, error) {
	if token := strings.TrimSpace(creds.AuthorizationToken); token != "" {
		return token, nil
	}
	body := strings.NewReader(url.Values{"grant_type": []string{"client_credentials"}}.Encode())
	raw, err := formalooDoRaw(ctx, client, baseURL, creds.APIKey, "", "", userAgent, http.MethodPost, "/v3.0/oauth2/authorization-token/", nil, body, creds.APISecret)
	if err != nil {
		return "", err
	}
	var payload map[string]any
	if err := decodeFormalooJSON(raw, &payload); err != nil {
		return "", fmt.Errorf("decode Formaloo authorization response: %w", err)
	}
	token := normalizeFormalooJWT(formalooMapString(payload, "authorization_token", "access_token", "token", "jwt"))
	if token == "" {
		return "", fmt.Errorf("Formaloo authorization response did not include authorization_token")
	}
	return token, nil
}

func fetchFormalooRows(ctx context.Context, client *http.Client, baseURL, apiKey, token, userAgent, workspaceID, formSlug string, state formalooCursorState, pageSize int, integration Integration) (formalooRowsResponse, error) {
	if strings.TrimSpace(state.NextURL) != "" {
		nextURL := strings.TrimSpace(state.NextURL)
		if strings.HasPrefix(nextURL, "/") {
			nextURL = strings.TrimRight(baseURL, "/") + nextURL
		}
		raw, err := formalooDoRaw(ctx, client, "", apiKey, token, workspaceID, userAgent, http.MethodGet, nextURL, nil, nil, "")
		if err != nil {
			return formalooRowsResponse{}, err
		}
		return decodeFormalooRows(raw, pageSize)
	}
	page := state.Page
	if page <= 0 {
		page = 1
	}
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("page_size", strconv.Itoa(formalooPageSize(pageSize)))
	for _, key := range []string{
		"created_at", "created_at_gt", "created_at_gte", "created_at_lt", "created_at_lte",
		"updated_at", "updated_at_gt", "updated_at_gte", "updated_at_lt", "updated_at_lte",
		"submit_time", "submit_time_gt", "submit_time_gte", "submit_time_lt", "submit_time_lte",
		"submit_number", "tracking_code", "tags", "search",
	} {
		if value := settingString(integration.Settings, key); value != "" {
			query.Set(key, value)
		}
	}
	if state.LastSubmittedAt != "" && !formalooHasConfiguredLowerBound(integration) {
		query.Set("created_at_gte", state.LastSubmittedAt)
	}
	path := "/v3.0/forms/" + url.PathEscape(formSlug) + "/rows/"
	raw, err := formalooDoRaw(ctx, client, baseURL, apiKey, token, workspaceID, userAgent, http.MethodGet, path, query, nil, "")
	if err != nil {
		return formalooRowsResponse{}, err
	}
	out, err := decodeFormalooRows(raw, pageSize)
	if err != nil {
		return formalooRowsResponse{}, err
	}
	if out.CurrentPage <= 0 {
		out.CurrentPage = page
	}
	if out.PageCount > 0 {
		out.HasMore = out.CurrentPage < out.PageCount
	} else if out.NextURL != "" {
		out.HasMore = true
	} else if len(out.Rows) >= formalooPageSize(pageSize) {
		out.HasMore = true
	}
	return out, nil
}

func decodeFormalooRows(raw []byte, pageSize int) (formalooRowsResponse, error) {
	var root any
	if err := decodeFormalooJSON(raw, &root); err != nil {
		return formalooRowsResponse{}, fmt.Errorf("decode Formaloo rows response: %w", err)
	}
	out := formalooRowsResponse{}
	if rawMap, ok := root.(map[string]any); ok {
		out.Raw = nonNilMap(rawMap)
		out.Rows = formalooRowSlice(firstNonNilAny(rawMap["results"], rawMap["data"], rawMap["items"], rawMap["rows"]))
		out.NextURL = formalooMapString(rawMap, "next", "next_url")
		out.Total = formalooInt(firstNonNilAny(rawMap["count"], rawMap["total"]))
		out.CurrentPage = formalooInt(firstNonNilAny(rawMap["current_page"], rawMap["page"]))
		out.PageCount = formalooInt(firstNonNilAny(rawMap["page_count"], rawMap["total_pages"]))
		if meta, ok := rawMap["meta"].(map[string]any); ok {
			out.NextURL = firstString(out.NextURL, formalooMapString(meta, "next", "next_url"))
			out.Total = firstNonZero(out.Total, formalooInt(firstNonNilAny(meta["count"], meta["total"])))
			out.CurrentPage = firstNonZero(out.CurrentPage, formalooInt(firstNonNilAny(meta["current_page"], meta["page"])))
			out.PageCount = firstNonZero(out.PageCount, formalooInt(firstNonNilAny(meta["page_count"], meta["total_pages"])))
		}
		out.HasMore = out.NextURL != ""
	} else {
		out.Rows = formalooRowSlice(root)
	}
	if out.PageCount == 0 && out.Total > 0 && pageSize > 0 {
		out.PageCount = (out.Total + formalooPageSize(pageSize) - 1) / formalooPageSize(pageSize)
	}
	return out, nil
}

func formalooDoRaw(ctx context.Context, client *http.Client, baseURL, apiKey, token, workspaceID, userAgent, method, path string, query url.Values, body io.Reader, basicSecret string) ([]byte, error) {
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
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, formalooDefaultUserAgent))
	if apiKey != "" {
		req.Header.Set("x-api-key", apiKey)
	}
	if workspaceID != "" {
		req.Header.Set("x-workspace", workspaceID)
	}
	if token != "" {
		req.Header.Set("Authorization", "JWT "+strings.TrimSpace(token))
	}
	if basicSecret != "" {
		req.Header.Set("Authorization", "Basic "+strings.TrimSpace(basicSecret))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, formalooResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, FormalooProviderError{Path: path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: formalooResponseSnippet(raw)}
	}
	return raw, nil
}

type FormalooProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e FormalooProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("Formaloo API %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("Formaloo API %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapFormalooRow(item formalooRow, integration Integration, fallbackFormSlug string) SubmissionInput {
	formSlug := firstString(formalooNestedString(item.Raw, "form", "slug"), fallbackFormSlug, settingString(integration.Settings, "form_slug"), settingString(integration.Settings, "form_id"))
	rowSlug := formalooRowID(item)
	if rowSlug == "" {
		rowSlug = formalooRowHash(item.Raw)
	}
	data := formalooRowData(item.Raw)
	fields := map[string]any{
		"formaloo_row_slug":                  rowSlug,
		"formaloo_form_slug":                 formSlug,
		"formaloo_workspace_id":              settingString(integration.Settings, "workspace_id"),
		"formaloo_tracking_code":             formalooMapString(item.Raw, "tracking_code"),
		"formaloo_submit_number":             normalizeLeadpagesValue(item.Raw["submit_number"]),
		"formaloo_created_at":                formalooMapString(item.Raw, "created_at"),
		"formaloo_updated_at":                formalooMapString(item.Raw, "updated_at"),
		"formaloo_submit_time":               formalooMapString(item.Raw, "submit_time"),
		"formaloo_submitter_referer_address": formalooMapString(item.Raw, "submitter_referer_address"),
		"formaloo_status":                    normalizeLeadpagesValue(item.Raw["status"]),
		"formaloo_row_tags":                  normalizeLeadpagesValue(item.Raw["row_tags"]),
		"formaloo_provider_raw":              item.Raw,
		"formaloo_data":                      data,
	}
	identity := typeformIdentity{}
	keys := make([]string, 0, len(data))
	for key := range data {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := data[key]
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		fields["formaloo_field."+normalizedKey] = value
		applyFormalooIdentity(&identity, integration, key, value)
	}
	return SubmissionInput{
		SourceID:    formalooSourceID(formSlug, rowSlug),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formSlug,
		FormName:    firstString(settingString(integration.Settings, "form_name"), formalooNestedString(item.Raw, "form", "title"), formalooNestedString(item.Raw, "form", "name")),
		EventName:   "lead.submitted",
		Tags:        formalooTags(integration, formSlug),
		Fields:      fields,
		SubmittedAt: parseFilloutTime(formalooRowTime(item)),
	}
}

func formalooRowData(raw map[string]any) map[string]any {
	out := map[string]any{}
	for _, key := range []string{"data", "readable_data", "rendered_data", "extra_response"} {
		if nested, ok := raw[key].(map[string]any); ok {
			for field, value := range nested {
				if _, exists := out[field]; !exists {
					out[field] = normalizeLeadpagesValue(value)
				}
			}
		}
	}
	return out
}

func applyFormalooIdentity(identity *typeformIdentity, integration Integration, key string, value any) {
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

func formalooRowAfterCursor(submittedAt, slug string, state formalooCursorState) bool {
	if strings.TrimSpace(state.LastSubmittedAt) == "" {
		return true
	}
	if leadpagesTimeAfter(submittedAt, state.LastSubmittedAt) {
		return true
	}
	return strings.TrimSpace(submittedAt) == strings.TrimSpace(state.LastSubmittedAt) && strings.TrimSpace(slug) > strings.TrimSpace(state.LastSlug)
}

func formalooRowID(item formalooRow) string {
	return firstString(formalooMapString(item.Raw, "slug", "id", "uuid"), formalooMapString(item.Raw, "tracking_code"), formalooMapString(item.Raw, "submit_number"))
}

func formalooRowTime(item formalooRow) string {
	return firstString(formalooMapString(item.Raw, "created_at", "submitted_at", "updated_at"), formalooMapString(item.Raw, "submit_time"))
}

func formalooRowSlice(raw any) []formalooRow {
	switch typed := raw.(type) {
	case []any:
		out := make([]formalooRow, 0, len(typed))
		for _, item := range typed {
			if m, ok := item.(map[string]any); ok {
				out = append(out, formalooRow{Raw: nonNilMap(m)})
			}
		}
		return out
	case map[string]any:
		if nested := firstNonNilAny(typed["results"], typed["data"], typed["items"], typed["rows"]); nested != nil {
			return formalooRowSlice(nested)
		}
		return []formalooRow{{Raw: nonNilMap(typed)}}
	default:
		return nil
	}
}

func formalooMapString(raw map[string]any, keys ...string) string {
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
		default:
			text := strings.TrimSpace(fmt.Sprint(typed))
			if text != "" && text != "<nil>" {
				return text
			}
		}
	}
	return ""
}

func formalooNestedString(raw map[string]any, objectKey string, keys ...string) string {
	if nested, ok := raw[objectKey].(map[string]any); ok {
		return formalooMapString(nested, keys...)
	}
	return ""
}

func formalooWorkspaceID(creds FormalooCredentials, integration Integration) string {
	return firstString(settingString(integration.Settings, "workspace_id"), creds.WorkspaceID)
}

func formalooHasConfiguredLowerBound(integration Integration) bool {
	for _, key := range []string{"created_at", "created_at_gt", "created_at_gte", "updated_at", "updated_at_gt", "updated_at_gte", "submit_time", "submit_time_gt", "submit_time_gte"} {
		if settingString(integration.Settings, key) != "" {
			return true
		}
	}
	return false
}

func formalooInt(value any) int {
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

func formalooPageSize(size int) int {
	if size <= 0 {
		return formalooDefaultPageSize
	}
	if size > formalooMaxPageSize {
		return formalooMaxPageSize
	}
	return size
}

func formalooSourceID(formSlug, rowSlug string) string {
	formSlug = strings.TrimSpace(formSlug)
	rowSlug = strings.TrimSpace(rowSlug)
	if formSlug == "" || rowSlug == "" || rowSlug == "<nil>" {
		return ""
	}
	return "formaloo://row/" + formSlug + "/" + rowSlug
}

func formalooRowHash(raw map[string]any) string {
	encoded, _ := json.Marshal(raw)
	sum := sha256.Sum256(encoded)
	return "sha256-" + hex.EncodeToString(sum[:8])
}

func formalooTags(integration Integration, formSlug string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"formaloo", "formaloo:" + formSlug} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func decodeFormalooJSON(raw []byte, out any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(out); err != nil && err != io.EOF {
		return err
	}
	return nil
}

func formalooResponseSnippet(raw []byte) string {
	snippet := strings.TrimSpace(string(raw))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	return snippet
}
