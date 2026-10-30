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
	gravityFormsCursorPrefix     = "gravity_forms:"
	gravityFormsResponseMaxBytes = 8 << 20
	gravityFormsDefaultPageSize  = 100
	gravityFormsMaxPageSize      = 200
	gravityFormsDefaultUserAgent = "Moosewave Gravity Forms Integration"
)

type GravityFormsCredentials struct {
	Username       string
	Password       string
	ConsumerKey    string
	ConsumerSecret string
	SiteURL        string
	UserAgent      string
}

type GravityFormsCredentialResolver interface {
	ResolveGravityForms(context.Context, string, Integration) (GravityFormsCredentials, error)
}

type GravityFormsBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type GravityFormsRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials GravityFormsCredentialResolver
	SiteURL     string
	UserAgent   string
	PageSize    int
}

type GravityFormsRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type GravityFormsSecretsCredentialResolver struct {
	Secrets GravityFormsRuntimeSecretResolver
}

func NewGravityFormsSecretsCredentialResolver(secrets GravityFormsRuntimeSecretResolver) *GravityFormsSecretsCredentialResolver {
	return &GravityFormsSecretsCredentialResolver{Secrets: secrets}
}

func (r *GravityFormsSecretsCredentialResolver) ResolveGravityForms(ctx context.Context, _ string, integration Integration) (GravityFormsCredentials, error) {
	if r == nil || r.Secrets == nil {
		return GravityFormsCredentials{}, fmt.Errorf("gravity forms credential resolver is not configured")
	}
	ref := gravityFormsCredentialRef(integration)
	if ref == "" {
		return GravityFormsCredentials{}, fmt.Errorf("gravity forms credentials_ref is required")
	}
	var payload gravityFormsCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return GravityFormsCredentials{}, fmt.Errorf("resolve gravity forms credentials %q: %w", ref, err)
		}
		return parseGravityFormsCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return GravityFormsCredentials{}, fmt.Errorf("resolve gravity forms credentials %q: %w", ref, err)
	}
	return parseGravityFormsCredentialSecret(raw)
}

type gravityFormsCredentialPayload struct {
	Username            string `json:"username"`
	Password            string `json:"password"`
	ApplicationPassword string `json:"application_password"`
	AppPassword         string `json:"app_password"`
	ConsumerKey         string `json:"consumer_key"`
	ConsumerSecret      string `json:"consumer_secret"`
	SiteURL             string `json:"site_url"`
	UserAgent           string `json:"user_agent"`
}

func (p gravityFormsCredentialPayload) credentials() (GravityFormsCredentials, error) {
	username := strings.TrimSpace(p.Username)
	password := strings.TrimSpace(firstString(p.ApplicationPassword, p.AppPassword, p.Password))
	consumerKey := strings.TrimSpace(p.ConsumerKey)
	consumerSecret := strings.TrimSpace(p.ConsumerSecret)
	if (username == "" || password == "") && (consumerKey == "" || consumerSecret == "") {
		return GravityFormsCredentials{}, fmt.Errorf("gravity forms username/application_password or consumer_key/consumer_secret is required")
	}
	return GravityFormsCredentials{
		Username:       username,
		Password:       password,
		ConsumerKey:    consumerKey,
		ConsumerSecret: consumerSecret,
		SiteURL:        strings.TrimRight(strings.TrimSpace(p.SiteURL), "/"),
		UserAgent:      strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseGravityFormsCredentialSecret(raw string) (GravityFormsCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return GravityFormsCredentials{}, fmt.Errorf("gravity forms credentials are empty")
	}
	var payload gravityFormsCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return GravityFormsCredentials{}, fmt.Errorf("parse gravity forms credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseGravityFormsKeyValueSecret(raw).credentials()
	}
	return GravityFormsCredentials{}, fmt.Errorf("gravity forms credentials must include username/application_password or consumer_key/consumer_secret")
}

func parseGravityFormsKeyValueSecret(raw string) gravityFormsCredentialPayload {
	var payload gravityFormsCredentialPayload
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
		case "consumer_key":
			payload.ConsumerKey = value
		case "consumer_secret":
			payload.ConsumerSecret = value
		case "site_url":
			payload.SiteURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func gravityFormsCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b GravityFormsRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderGravityForms {
		return SyncRequest{}, fmt.Errorf("gravity forms backfill requires a Gravity Forms integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("gravity forms credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("gravity forms form_id is required")
	}
	creds, err := b.Credentials.ResolveGravityForms(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	state, err := decodeGravityFormsCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	client := leadEgressClient(b.HTTPClient, ProviderGravityForms, 30*time.Second)
	siteURL := strings.TrimRight(firstString(b.SiteURL, creds.SiteURL, settingString(integration.Settings, "site_url")), "/")
	if siteURL == "" {
		return SyncRequest{}, fmt.Errorf("gravity forms site_url is required")
	}
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), gravityFormsDefaultUserAgent)
	pageSize := gravityFormsPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	offset := state.Offset
	if offset < 0 {
		offset = 0
	}
	pageOut, err := fetchGravityFormsEntries(ctx, client, siteURL, creds, userAgent, formID, offset, pageSize, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(pageOut.Entries))}
	for _, item := range pageOut.Entries {
		submission := mapGravityFormsEntry(item, integration, siteURL, formID)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	nextOffset := offset + len(pageOut.Entries)
	if pageOut.TotalCount > nextOffset {
		req.Cursor = encodeGravityFormsCursor(gravityFormsCursorState{Offset: nextOffset, TotalCount: pageOut.TotalCount})
	} else if pageOut.TotalCount > offset {
		req.Cursor = encodeGravityFormsCursor(gravityFormsCursorState{Offset: pageOut.TotalCount, TotalCount: pageOut.TotalCount})
	} else {
		req.Cursor = encodeGravityFormsCursor(gravityFormsCursorState{Offset: offset, TotalCount: pageOut.TotalCount})
	}
	return req, nil
}

type gravityFormsCursorState struct {
	Offset     int `json:"offset,omitempty"`
	TotalCount int `json:"total_count,omitempty"`
}

func decodeGravityFormsCursor(cursor string) (gravityFormsCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return gravityFormsCursorState{}, nil
	}
	if !strings.HasPrefix(cursor, gravityFormsCursorPrefix) {
		return gravityFormsCursorState{}, fmt.Errorf("invalid Gravity Forms cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, gravityFormsCursorPrefix))
	if raw == "" {
		return gravityFormsCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return gravityFormsCursorState{}, fmt.Errorf("invalid Gravity Forms cursor")
	}
	var out gravityFormsCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return gravityFormsCursorState{}, fmt.Errorf("invalid Gravity Forms cursor")
	}
	if out.Offset < 0 {
		out.Offset = 0
	}
	if out.TotalCount < 0 {
		out.TotalCount = 0
	}
	return out, nil
}

func encodeGravityFormsCursor(state gravityFormsCursorState) string {
	if state.Offset < 0 {
		state.Offset = 0
	}
	if state.TotalCount < 0 {
		state.TotalCount = 0
	}
	raw, _ := json.Marshal(state)
	return gravityFormsCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type gravityFormsEntriesResponse struct {
	TotalCount int                 `json:"total_count"`
	Entries    []gravityFormsEntry `json:"entries"`
}

type gravityFormsEntry struct {
	ID          string
	FormID      string
	DateCreated string
	DateUpdated string
	Status      string
	IPAddress   string
	SourceURL   string
	UserAgent   string
	Labels      map[string]string
	Fields      map[string]any
	Raw         map[string]any
}

func (e *gravityFormsEntry) UnmarshalJSON(raw []byte) error {
	var payload map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&payload); err != nil {
		return err
	}
	e.Raw = nonNilMap(payload)
	e.ID = gravityFormsFindString(payload, "id")
	e.FormID = gravityFormsFindString(payload, "form_id")
	e.DateCreated = gravityFormsFindString(payload, "date_created")
	e.DateUpdated = gravityFormsFindString(payload, "date_updated")
	e.Status = gravityFormsFindString(payload, "status")
	e.IPAddress = gravityFormsFindString(payload, "ip")
	e.SourceURL = gravityFormsFindString(payload, "source_url")
	e.UserAgent = gravityFormsFindString(payload, "user_agent")
	e.Labels = gravityFormsLabels(payload["_labels"])
	e.Fields = gravityFormsEntryFields(payload)
	return nil
}

func fetchGravityFormsEntries(ctx context.Context, client *http.Client, siteURL string, creds GravityFormsCredentials, userAgent, formID string, offset, pageSize int, integration Integration) (gravityFormsEntriesResponse, error) {
	query := url.Values{}
	query.Set("_labels", "1")
	query.Set("paging[page_size]", strconv.Itoa(gravityFormsPageSize(pageSize)))
	query.Set("paging[offset]", strconv.Itoa(offset))
	query.Set("sorting[key]", firstString(settingString(integration.Settings, "sort_key"), "id"))
	query.Set("sorting[direction]", firstString(settingString(integration.Settings, "sort_direction"), "ASC"))
	query.Set("sorting[is_numeric]", firstString(settingString(integration.Settings, "sort_is_numeric"), "true"))
	if status := strings.TrimSpace(settingString(integration.Settings, "status")); status != "" {
		query.Set("status", status)
	}
	if search := strings.TrimSpace(settingString(integration.Settings, "search")); search != "" {
		query.Set("search", search)
	}
	raw, err := gravityFormsDoRaw(ctx, client, siteURL, creds, userAgent, http.MethodGet, "/wp-json/gf/v2/forms/"+url.PathEscape(formID)+"/entries", query)
	if err != nil {
		return gravityFormsEntriesResponse{}, err
	}
	var out gravityFormsEntriesResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return gravityFormsEntriesResponse{}, fmt.Errorf("decode gravity forms entries: %w", err)
	}
	if out.TotalCount < len(out.Entries) {
		out.TotalCount = len(out.Entries)
	}
	return out, nil
}

func gravityFormsDoRaw(ctx context.Context, client *http.Client, siteURL string, creds GravityFormsCredentials, userAgent, method, pathValue string, query url.Values) ([]byte, error) {
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
	username, password := gravityFormsBasicCredentials(creds)
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(username+":"+password)))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, gravityFormsDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, gravityFormsResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, GravityFormsProviderError{Path: pathValue, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: gravityFormsResponseSnippet(raw)}
	}
	return raw, nil
}

func gravityFormsBasicCredentials(creds GravityFormsCredentials) (string, string) {
	if strings.TrimSpace(creds.Username) != "" || strings.TrimSpace(creds.Password) != "" {
		return strings.TrimSpace(creds.Username), strings.TrimSpace(creds.Password)
	}
	return strings.TrimSpace(creds.ConsumerKey), strings.TrimSpace(creds.ConsumerSecret)
}

type GravityFormsProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e GravityFormsProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("gravity forms REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("gravity forms REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapGravityFormsEntry(item gravityFormsEntry, integration Integration, siteURL, fallbackFormID string) SubmissionInput {
	formID := firstString(item.FormID, fallbackFormID, settingString(integration.Settings, "form_id"))
	fields := map[string]any{
		"gravity_forms_entry_id":     item.ID,
		"gravity_forms_form_id":      formID,
		"gravity_forms_site_url":     strings.TrimRight(siteURL, "/"),
		"gravity_forms_date_created": item.DateCreated,
		"gravity_forms_date_updated": item.DateUpdated,
		"gravity_forms_status":       item.Status,
		"gravity_forms_ip":           item.IPAddress,
		"gravity_forms_source_url":   item.SourceURL,
		"gravity_forms_user_agent":   item.UserAgent,
		"gravity_forms_provider_raw": item.Raw,
	}
	identity := typeformIdentity{}
	for key, value := range item.Fields {
		label := firstString(item.Labels[key], key)
		normalizedKey := normalizeTypeformIdentityKey(label)
		normalizedValue := gravityFormsNormalizeValue(value)
		fields["gravity_forms_field."+normalizedKey] = normalizedValue
		fields["gravity_forms_field_id."+normalizedKey] = key
		applyGravityFormsIdentity(&identity, integration, key, label, normalizedValue)
	}
	submittedAt := gravityFormsSubmittedAt(item.DateCreated)
	return SubmissionInput{
		SourceID:    gravityFormsSourceID(siteURL, formID, item.ID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    settingString(integration.Settings, "form_name"),
		EventName:   "lead.submitted",
		Tags:        gravityFormsTags(integration, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func applyGravityFormsIdentity(identity *typeformIdentity, integration Integration, fieldID, label string, value any) {
	if identity == nil {
		return
	}
	text := strings.TrimSpace(gravityFormsValueText(value))
	if text == "" || text == "<nil>" {
		return
	}
	switch {
	case gravityFormsIdentitySettingMatches(integration, fieldID, label, "email"):
		if identity.Email == "" {
			identity.Email = text
		}
	case gravityFormsIdentitySettingMatches(integration, fieldID, label, "first_name"):
		if identity.FirstName == "" {
			identity.FirstName = text
		}
	case gravityFormsIdentitySettingMatches(integration, fieldID, label, "last_name"):
		if identity.LastName == "" {
			identity.LastName = text
		}
	case gravityFormsIdentitySettingMatches(integration, fieldID, label, "full_name"):
		if identity.FullName == "" {
			identity.FullName = text
		}
	case gravityFormsIdentitySettingMatches(integration, fieldID, label, "phone"):
		if identity.Phone == "" {
			identity.Phone = text
		}
	case gravityFormsIdentitySettingMatches(integration, fieldID, label, "company"):
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

func gravityFormsIdentitySettingMatches(integration Integration, fieldID, label, prefix string) bool {
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

func gravityFormsLabels(value any) map[string]string {
	out := map[string]string{}
	labels, ok := value.(map[string]any)
	if !ok {
		return out
	}
	for key, raw := range labels {
		if text := strings.TrimSpace(gravityFormsValueText(raw)); text != "" && text != "<nil>" {
			out[key] = text
		}
	}
	return out
}

func gravityFormsEntryFields(payload map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range payload {
		if gravityFormsCoreEntryKey(key) || strings.HasPrefix(key, "_") {
			continue
		}
		out[key] = gravityFormsNormalizeValue(value)
	}
	return out
}

func gravityFormsCoreEntryKey(key string) bool {
	switch key {
	case "id", "form_id", "date_created", "date_updated", "is_starred", "is_read", "ip", "source_url", "post_id", "currency", "payment_status", "payment_date", "payment_amount", "payment_method", "transaction_id", "is_fulfilled", "created_by", "transaction_type", "status", "source_id", "user_agent":
		return true
	default:
		return false
	}
}

func gravityFormsNormalizeValue(value any) any {
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
			out = append(out, gravityFormsNormalizeValue(item))
		}
		if len(out) == 1 {
			return out[0]
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = gravityFormsNormalizeValue(item)
		}
		return out
	default:
		return typed
	}
}

func gravityFormsValueText(value any) string {
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
			text := strings.TrimSpace(gravityFormsValueText(item))
			if text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, ", ")
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func gravityFormsFindString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		text := strings.TrimSpace(gravityFormsValueText(values[key]))
		if text != "" && text != "<nil>" {
			return text
		}
	}
	return ""
}

func gravityFormsSubmittedAt(raw string) *time.Time {
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

func gravityFormsPageSize(size int) int {
	if size <= 0 {
		return gravityFormsDefaultPageSize
	}
	if size > gravityFormsMaxPageSize {
		return gravityFormsMaxPageSize
	}
	return size
}

func gravityFormsSourceID(siteURL, formID, entryID string) string {
	formID = strings.TrimSpace(formID)
	entryID = strings.TrimSpace(entryID)
	if formID == "" || entryID == "" || entryID == "<nil>" {
		return ""
	}
	host := "site"
	if parsed, err := url.Parse(strings.TrimSpace(siteURL)); err == nil && parsed.Host != "" {
		host = parsed.Host
	}
	return "gravity-forms://entry/" + host + "/" + formID + "/" + entryID
}

func gravityFormsTags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"gravity-forms", "gravity-forms:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func gravityFormsResponseSnippet(raw []byte) string {
	snippet := strings.TrimSpace(string(raw))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	return snippet
}
