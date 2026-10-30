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
	formsiteCursorPrefix     = "formsite:"
	formsiteCursorComplete   = "formsite:complete"
	formsiteResponseMaxBytes = 8 << 20
	formsiteDefaultPageSize  = 100
	formsiteMaxPageSize      = 500
	formsiteDefaultUserAgent = "Moosewave Formsite Integration"
)

type FormsiteCredentials struct {
	AccessToken string
	APIBaseURL  string
	UserAgent   string
}

type FormsiteCredentialResolver interface {
	ResolveFormsite(context.Context, string, Integration) (FormsiteCredentials, error)
}

type FormsiteBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type FormsiteRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials FormsiteCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type FormsiteRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type FormsiteSecretsCredentialResolver struct {
	Secrets FormsiteRuntimeSecretResolver
}

func NewFormsiteSecretsCredentialResolver(secrets FormsiteRuntimeSecretResolver) *FormsiteSecretsCredentialResolver {
	return &FormsiteSecretsCredentialResolver{Secrets: secrets}
}

func (r *FormsiteSecretsCredentialResolver) ResolveFormsite(ctx context.Context, _ string, integration Integration) (FormsiteCredentials, error) {
	if r == nil || r.Secrets == nil {
		return FormsiteCredentials{}, fmt.Errorf("formsite credential resolver is not configured")
	}
	ref := formsiteCredentialRef(integration)
	if ref == "" {
		return FormsiteCredentials{}, fmt.Errorf("formsite credentials_ref is required")
	}
	var payload formsiteCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return FormsiteCredentials{}, fmt.Errorf("resolve formsite credentials %q: %w", ref, err)
		}
		return parseFormsiteCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return FormsiteCredentials{}, fmt.Errorf("resolve formsite credentials %q: %w", ref, err)
	}
	return parseFormsiteCredentialSecret(raw)
}

type formsiteCredentialPayload struct {
	AccessToken string `json:"access_token"`
	APIKey      string `json:"api_key"`
	Token       string `json:"token"`
	BearerToken string `json:"bearer_token"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p formsiteCredentialPayload) credentials() (FormsiteCredentials, error) {
	token := normalizeFormsiteBearerToken(firstString(p.AccessToken, p.APIKey, p.Token, p.BearerToken))
	if token == "" {
		return FormsiteCredentials{}, fmt.Errorf("formsite access_token or api_key is required")
	}
	return FormsiteCredentials{
		AccessToken: token,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseFormsiteCredentialSecret(raw string) (FormsiteCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return FormsiteCredentials{}, fmt.Errorf("formsite credentials are empty")
	}
	var payload formsiteCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return FormsiteCredentials{}, fmt.Errorf("parse formsite credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseFormsiteKeyValueSecret(raw).credentials()
	}
	return formsiteCredentialPayload{AccessToken: raw}.credentials()
}

func parseFormsiteKeyValueSecret(raw string) formsiteCredentialPayload {
	var payload formsiteCredentialPayload
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

func normalizeFormsiteBearerToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func formsiteCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b FormsiteRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderFormsite {
		return SyncRequest{}, fmt.Errorf("formsite backfill requires a Formsite integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("formsite credential resolver is not configured")
	}
	userDir := strings.TrimSpace(firstString(settingString(integration.Settings, "user_dir"), settingString(integration.Settings, "account_id")))
	if userDir == "" {
		return SyncRequest{}, fmt.Errorf("formsite account_id or user_dir is required")
	}
	formDir := strings.TrimSpace(firstString(settingString(integration.Settings, "form_dir"), settingString(integration.Settings, "form_id")))
	if formDir == "" {
		return SyncRequest{}, fmt.Errorf("formsite form_id or form_dir is required")
	}
	creds, err := b.Credentials.ResolveFormsite(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("formsite access token is required")
	}
	state, err := decodeFormsiteCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: formsiteCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderFormsite, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url")), "/")
	if baseURL == "" {
		return SyncRequest{}, fmt.Errorf("formsite api_base_url is required")
	}
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), formsiteDefaultUserAgent)
	pageSize := formsitePageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	page := state.Page
	if page <= 0 {
		page = 1
	}
	pageOut, err := fetchFormsiteResults(ctx, client, baseURL, creds.AccessToken, userAgent, userDir, formDir, page, pageSize, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	items := pageOut.Results
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(items))}
	for _, item := range items {
		submission := mapFormsiteResult(item, integration, userDir, formDir)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	if len(items) == 0 || (pageOut.LastPage > 0 && pageOut.Page >= pageOut.LastPage) || (pageOut.LastPage == 0 && len(items) < pageSize) {
		req.Cursor = formsiteCursorComplete
	} else {
		nextPage := pageOut.Page + 1
		if nextPage <= 1 {
			nextPage = page + 1
		}
		req.Cursor = encodeFormsiteCursor(formsiteCursorState{Page: nextPage})
	}
	return req, nil
}

type formsiteCursorState struct {
	Page     int  `json:"page,omitempty"`
	Complete bool `json:"complete,omitempty"`
}

func decodeFormsiteCursor(cursor string) (formsiteCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return formsiteCursorState{Page: 1}, nil
	}
	if cursor == formsiteCursorComplete {
		return formsiteCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, formsiteCursorPrefix) {
		return formsiteCursorState{}, fmt.Errorf("invalid Formsite cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, formsiteCursorPrefix))
	if raw == "" {
		return formsiteCursorState{Page: 1}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return formsiteCursorState{}, fmt.Errorf("invalid Formsite cursor")
	}
	var out formsiteCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return formsiteCursorState{}, fmt.Errorf("invalid Formsite cursor")
	}
	if out.Page <= 0 {
		out.Page = 1
	}
	return out, nil
}

func encodeFormsiteCursor(state formsiteCursorState) string {
	if state.Complete {
		return formsiteCursorComplete
	}
	if state.Page <= 0 {
		state.Page = 1
	}
	raw, _ := json.Marshal(state)
	return formsiteCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type formsiteResultsResponse struct {
	Results  []formsiteResult `json:"results"`
	Page     int              `json:"-"`
	LastPage int              `json:"-"`
	Limit    int              `json:"-"`
	Raw      map[string]any   `json:"-"`
}

type formsiteResult struct {
	ID            string         `json:"id"`
	DateFinish    string         `json:"date_finish"`
	DateStart     string         `json:"date_start"`
	DateUpdate    string         `json:"date_update"`
	LoginEmail    string         `json:"login_email"`
	LoginUsername string         `json:"login_username"`
	ResultStatus  string         `json:"result_status"`
	UserBrowser   string         `json:"user_browser"`
	UserIP        string         `json:"user_ip"`
	UserDevice    string         `json:"user_device"`
	UserReferrer  string         `json:"user_referrer"`
	PaymentStatus string         `json:"payment_status"`
	PaymentAmount any            `json:"payment_amount"`
	Items         []formsiteItem `json:"items"`
	Raw           map[string]any `json:"-"`
}

type formsiteItem struct {
	ID       string         `json:"id"`
	Position int            `json:"position"`
	Value    any            `json:"value"`
	Values   []any          `json:"values"`
	Raw      map[string]any `json:"-"`
}

func (r *formsiteResultsResponse) UnmarshalJSON(raw []byte) error {
	type alias formsiteResultsResponse
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*r = formsiteResultsResponse(out)
	r.Raw = nonNilMap(rawMap)
	return nil
}

func (r *formsiteResult) UnmarshalJSON(raw []byte) error {
	var rawMap map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&rawMap); err != nil {
		return err
	}
	r.ID = formsiteStringValue(rawMap["id"])
	r.DateFinish = formsiteStringValue(rawMap["date_finish"])
	r.DateStart = formsiteStringValue(rawMap["date_start"])
	r.DateUpdate = formsiteStringValue(rawMap["date_update"])
	r.LoginEmail = formsiteStringValue(rawMap["login_email"])
	r.LoginUsername = formsiteStringValue(rawMap["login_username"])
	r.ResultStatus = formsiteStringValue(rawMap["result_status"])
	r.UserBrowser = formsiteStringValue(rawMap["user_browser"])
	r.UserIP = formsiteStringValue(rawMap["user_ip"])
	r.UserDevice = formsiteStringValue(rawMap["user_device"])
	r.UserReferrer = formsiteStringValue(rawMap["user_referrer"])
	r.PaymentStatus = formsiteStringValue(rawMap["payment_status"])
	r.PaymentAmount = normalizeFormsiteValue(rawMap["payment_amount"])
	r.Items = parseFormsiteItems(rawMap["items"])
	r.Raw = nonNilMap(rawMap)
	return nil
}

func parseFormsiteItems(value any) []formsiteItem {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]formsiteItem, 0, len(items))
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, formsiteItem{
			ID:       formsiteStringValue(m["id"]),
			Position: formsiteIntValue(m["position"]),
			Value:    normalizeFormsiteValue(m["value"]),
			Values:   normalizeFormsiteValues(m["values"]),
			Raw:      nonNilMap(m),
		})
	}
	return out
}

func normalizeFormsiteValues(value any) []any {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]any, 0, len(items))
	for _, item := range items {
		out = append(out, normalizeFormsiteValue(item))
	}
	return out
}

func fetchFormsiteResults(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, userDir, formDir string, page, limit int, integration Integration) (formsiteResultsResponse, error) {
	query := url.Values{}
	query.Set("limit", strconv.Itoa(formsitePageSize(limit)))
	query.Set("page", strconv.Itoa(page))
	query.Set("sort_id", firstString(settingString(integration.Settings, "sort_id"), "result_id"))
	query.Set("sort_direction", firstString(settingString(integration.Settings, "sort_direction"), "asc"))
	for _, key := range []string{"after_date", "before_date", "after_id", "before_id", "results_view", "search_method"} {
		if value := settingString(integration.Settings, key); value != "" {
			query.Set(key, value)
		}
	}
	path := "/" + url.PathEscape(userDir) + "/forms/" + url.PathEscape(formDir) + "/results"
	raw, header, err := formsiteDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, path, query, nil)
	if err != nil {
		return formsiteResultsResponse{}, err
	}
	var out formsiteResultsResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return formsiteResultsResponse{}, fmt.Errorf("decode formsite results response: %w", err)
	}
	out.Page = firstNonZero(formsiteHeaderInt(header, "Pagination-Page-Current"), page)
	out.LastPage = formsiteHeaderInt(header, "Pagination-Page-Last")
	out.Limit = firstNonZero(formsiteHeaderInt(header, "Pagination-Limit"), formsitePageSize(limit))
	return out, nil
}

func formsiteDoRaw(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, method, path string, query url.Values, body io.Reader) ([]byte, http.Header, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + path)
	if err != nil {
		return nil, nil, err
	}
	if query != nil {
		u.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, formsiteDefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, formsiteResponseMaxBytes)
	if err != nil {
		return nil, nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, resp.Header, FormsiteProviderError{Path: path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: formsiteResponseSnippet(raw)}
	}
	return raw, resp.Header, nil
}

type FormsiteProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e FormsiteProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("formsite REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("formsite REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapFormsiteResult(item formsiteResult, integration Integration, userDir, formDir string) SubmissionInput {
	formName := settingString(integration.Settings, "form_name")
	fields := map[string]any{
		"formsite_result_id":      item.ID,
		"formsite_user_dir":       userDir,
		"formsite_form_dir":       formDir,
		"formsite_date_finish":    item.DateFinish,
		"formsite_date_start":     item.DateStart,
		"formsite_date_update":    item.DateUpdate,
		"formsite_login_email":    item.LoginEmail,
		"formsite_login_username": item.LoginUsername,
		"formsite_result_status":  item.ResultStatus,
		"formsite_user_browser":   item.UserBrowser,
		"formsite_user_ip":        item.UserIP,
		"formsite_user_device":    item.UserDevice,
		"formsite_user_referrer":  item.UserReferrer,
		"formsite_payment_status": item.PaymentStatus,
		"formsite_payment_amount": item.PaymentAmount,
		"formsite_provider_raw":   item.Raw,
	}
	identity := typeformIdentity{Email: item.LoginEmail}
	for _, field := range item.Items {
		if strings.TrimSpace(field.ID) == "" {
			continue
		}
		value := formsiteItemValue(field)
		normalizedKey := normalizeTypeformIdentityKey(field.ID)
		fields["formsite_item."+normalizedKey] = value
		fields["formsite_item_position."+normalizedKey] = field.Position
		applyFormsiteIdentity(&identity, field, value, integration)
	}
	submittedAt := parseFilloutTime(firstString(item.DateFinish, item.DateUpdate, item.DateStart))
	return SubmissionInput{
		SourceID:    formsiteSourceID(userDir, formDir, item.ID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formDir,
		FormName:    formName,
		EventName:   "lead.submitted",
		Tags:        formsiteTags(integration, formDir),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func applyFormsiteIdentity(identity *typeformIdentity, field formsiteItem, value any, integration Integration) {
	if identity == nil {
		return
	}
	applyFilloutStructuredIdentity(identity, value)
	text := strings.TrimSpace(fmt.Sprint(value))
	id := strings.TrimSpace(field.ID)
	if id == "" {
		return
	}
	switch {
	case settingMatchesFormsiteItem(integration, id, "email_item_id"):
		identity.Email = text
	case settingMatchesFormsiteItem(integration, id, "first_name_item_id"):
		identity.FirstName = text
	case settingMatchesFormsiteItem(integration, id, "last_name_item_id"):
		identity.LastName = text
	case settingMatchesFormsiteItem(integration, id, "full_name_item_id"):
		identity.FullName = text
	case settingMatchesFormsiteItem(integration, id, "phone_item_id"):
		identity.Phone = text
	case settingMatchesFormsiteItem(integration, id, "company_item_id"):
		identity.Company = text
	case identity.Email == "" && strings.Contains(text, "@"):
		identity.Email = text
	}
}

func settingMatchesFormsiteItem(integration Integration, id, key string) bool {
	for _, part := range strings.Split(settingString(integration.Settings, key), ",") {
		if strings.TrimSpace(part) == id {
			return true
		}
	}
	return false
}

func formsiteItemValue(field formsiteItem) any {
	if len(field.Values) > 0 {
		return field.Values
	}
	return field.Value
}

func normalizeFormsiteValue(value any) any {
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
			out = append(out, normalizeFormsiteValue(item))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = normalizeFormsiteValue(item)
		}
		return out
	default:
		return typed
	}
}

func formsitePageSize(size int) int {
	if size <= 0 {
		return formsiteDefaultPageSize
	}
	if size > formsiteMaxPageSize {
		return formsiteMaxPageSize
	}
	return size
}

func formsiteStringValue(value any) string {
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

func formsiteIntValue(value any) int {
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
		i, _ := strconv.Atoi(strings.TrimSpace(typed))
		return i
	}
	return 0
}

func formsiteHeaderInt(header http.Header, key string) int {
	value := strings.TrimSpace(header.Get(key))
	if value == "" {
		return 0
	}
	i, _ := strconv.Atoi(value)
	return i
}

func formsiteSourceID(userDir, formDir, id string) string {
	userDir = strings.TrimSpace(userDir)
	formDir = strings.TrimSpace(formDir)
	id = strings.TrimSpace(id)
	if userDir == "" || formDir == "" || id == "" || id == "<nil>" {
		return ""
	}
	return "formsite://result/" + userDir + "/" + formDir + "/" + id
}

func formsiteTags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"formsite", "formsite:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func formsiteResponseSnippet(raw []byte) string {
	snippet := strings.TrimSpace(string(raw))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	return snippet
}
