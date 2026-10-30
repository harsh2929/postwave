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
	unbounceCursorPrefix      = "unbounce:"
	unbounceCursorComplete    = "unbounce:complete"
	unbounceDefaultAPIBaseURL = "https://api.unbounce.com"
	unbounceResponseMaxBytes  = 8 << 20
	unbounceDefaultPageSize   = 1000
	unbounceMaxPageSize       = 1000
	unbounceDefaultUserAgent  = "Moosewave Unbounce Integration"
	unbounceAcceptHeader      = "application/vnd.unbounce.api.v0.4+json"
)

type UnbounceCredentials struct {
	AccessToken string
	APIKey      string
	APIBaseURL  string
	UserAgent   string
}

type UnbounceCredentialResolver interface {
	ResolveUnbounce(context.Context, string, Integration) (UnbounceCredentials, error)
}

type UnbounceBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type UnbounceRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials UnbounceCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
	Now         func() time.Time
}

type UnbounceRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type UnbounceSecretsCredentialResolver struct {
	Secrets UnbounceRuntimeSecretResolver
}

func NewUnbounceSecretsCredentialResolver(secrets UnbounceRuntimeSecretResolver) *UnbounceSecretsCredentialResolver {
	return &UnbounceSecretsCredentialResolver{Secrets: secrets}
}

func (r *UnbounceSecretsCredentialResolver) ResolveUnbounce(ctx context.Context, _ string, integration Integration) (UnbounceCredentials, error) {
	if r == nil || r.Secrets == nil {
		return UnbounceCredentials{}, fmt.Errorf("unbounce credential resolver is not configured")
	}
	ref := unbounceCredentialRef(integration)
	if ref == "" {
		return UnbounceCredentials{}, fmt.Errorf("unbounce credentials_ref is required")
	}
	var payload unbounceCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return UnbounceCredentials{}, fmt.Errorf("resolve unbounce credentials %q: %w", ref, err)
		}
		return parseUnbounceCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return UnbounceCredentials{}, fmt.Errorf("resolve unbounce credentials %q: %w", ref, err)
	}
	return parseUnbounceCredentialSecret(raw)
}

type unbounceCredentialPayload struct {
	AccessToken string `json:"access_token"`
	Token       string `json:"token"`
	BearerToken string `json:"bearer_token"`
	APIKey      string `json:"api_key"`
	APIBaseURL  string `json:"api_base_url"`
	UserAgent   string `json:"user_agent"`
}

func (p unbounceCredentialPayload) credentials() (UnbounceCredentials, error) {
	token := normalizeUnbounceBearerToken(firstString(p.AccessToken, p.Token, p.BearerToken))
	apiKey := strings.TrimSpace(p.APIKey)
	if token == "" && apiKey == "" {
		return UnbounceCredentials{}, fmt.Errorf("unbounce access_token or api_key is required")
	}
	return UnbounceCredentials{
		AccessToken: token,
		APIKey:      apiKey,
		APIBaseURL:  strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:   strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseUnbounceCredentialSecret(raw string) (UnbounceCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return UnbounceCredentials{}, fmt.Errorf("unbounce credentials are empty")
	}
	var payload unbounceCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return UnbounceCredentials{}, fmt.Errorf("parse unbounce credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseUnbounceKeyValueSecret(raw).credentials()
	}
	return unbounceCredentialPayload{AccessToken: raw}.credentials()
}

func parseUnbounceKeyValueSecret(raw string) unbounceCredentialPayload {
	var payload unbounceCredentialPayload
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

func normalizeUnbounceBearerToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func unbounceCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func (b UnbounceRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderUnbounce {
		return SyncRequest{}, fmt.Errorf("unbounce backfill requires an Unbounce integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("unbounce credential resolver is not configured")
	}
	pageID := strings.TrimSpace(settingString(integration.Settings, "page_id"))
	if pageID == "" {
		return SyncRequest{}, fmt.Errorf("unbounce page_id is required")
	}
	creds, err := b.Credentials.ResolveUnbounce(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" && strings.TrimSpace(creds.APIKey) == "" {
		return SyncRequest{}, fmt.Errorf("unbounce access_token or api_key is required")
	}
	state, err := decodeUnbounceCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: unbounceCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderUnbounce, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), unbounceDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), unbounceDefaultUserAgent)
	pageSize := unbouncePageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	offset := state.Offset
	if offset < 0 {
		offset = 0
	}
	fields, err := fetchUnbounceFormFields(ctx, client, baseURL, creds, userAgent, pageID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	labels := unbounceFieldMetadata(fields)
	since := firstString(state.Since, settingString(integration.Settings, "from"), settingString(integration.Settings, "start_created_at"), settingString(integration.Settings, "created_from"))
	pageOut, err := fetchUnbounceLeads(ctx, client, baseURL, creds, userAgent, pageID, offset, pageSize, since, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(pageOut.Leads))}
	latest := state.Since
	for _, item := range pageOut.Leads {
		submission := mapUnbounceLead(item, integration, labels, pageID)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
		latest = laterUnbounceTimestamp(latest, item.CreatedAt)
	}
	if len(pageOut.Leads) >= pageSize {
		req.Cursor = encodeUnbounceCursor(unbounceCursorState{Offset: offset + len(pageOut.Leads), Since: firstString(state.Since, since)})
	} else if strings.TrimSpace(latest) != "" {
		req.Cursor = encodeUnbounceCursor(unbounceCursorState{Since: latest})
	} else if strings.TrimSpace(state.Since) != "" {
		req.Cursor = encodeUnbounceCursor(unbounceCursorState{Since: state.Since})
	} else {
		req.Cursor = encodeUnbounceCursor(unbounceCursorState{Since: unbounceNow(b.Now).Format(time.RFC3339Nano)})
	}
	return req, nil
}

type unbounceCursorState struct {
	Offset   int    `json:"offset,omitempty"`
	Since    string `json:"since,omitempty"`
	Complete bool   `json:"complete,omitempty"`
}

func decodeUnbounceCursor(cursor string) (unbounceCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return unbounceCursorState{}, nil
	}
	if cursor == unbounceCursorComplete {
		return unbounceCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, unbounceCursorPrefix) {
		return unbounceCursorState{}, fmt.Errorf("invalid Unbounce cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, unbounceCursorPrefix))
	if raw == "" {
		return unbounceCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return unbounceCursorState{}, fmt.Errorf("invalid Unbounce cursor")
	}
	var out unbounceCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return unbounceCursorState{}, fmt.Errorf("invalid Unbounce cursor")
	}
	out.Since = strings.TrimSpace(out.Since)
	if out.Offset < 0 {
		out.Offset = 0
	}
	return out, nil
}

func encodeUnbounceCursor(state unbounceCursorState) string {
	if state.Complete {
		return unbounceCursorComplete
	}
	state.Since = strings.TrimSpace(state.Since)
	if state.Offset < 0 {
		state.Offset = 0
	}
	raw, _ := json.Marshal(state)
	return unbounceCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type unbounceFormFieldsResponse struct {
	FormFields []unbounceFormField `json:"form_fields"`
	Metadata   unbounceMetadata    `json:"metadata"`
}

type unbounceFormField struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Type        string         `json:"type"`
	Validations map[string]any `json:"validations"`
}

type unbounceLeadsResponse struct {
	Leads    []unbounceLead   `json:"leads"`
	Metadata unbounceMetadata `json:"metadata"`
}

type unbounceMetadata struct {
	Count         int               `json:"count"`
	Location      string            `json:"location"`
	Documentation string            `json:"documentation"`
	Related       map[string]string `json:"related"`
}

type unbounceLead struct {
	CreatedAt   string           `json:"created_at"`
	ID          string           `json:"id"`
	ExtraData   map[string]any   `json:"extra_data"`
	FormData    map[string]any   `json:"form_data"`
	Metadata    unbounceMetadata `json:"metadata"`
	PageID      string           `json:"page_id"`
	SubmitterIP string           `json:"submitter_ip"`
	VariantID   string           `json:"variant_id"`
	Raw         map[string]any   `json:"-"`
}

func (l *unbounceLead) UnmarshalJSON(raw []byte) error {
	type alias unbounceLead
	var out alias
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(raw, &rawMap)
	*l = unbounceLead(out)
	l.Raw = nonNilMap(rawMap)
	l.ExtraData = normalizeUnbounceMap(l.ExtraData)
	l.FormData = normalizeUnbounceMap(l.FormData)
	return nil
}

type unbounceFieldMeta struct {
	Name string
	Type string
}

func unbounceFieldMetadata(fields []unbounceFormField) map[string]unbounceFieldMeta {
	out := map[string]unbounceFieldMeta{}
	for _, field := range fields {
		id := strings.TrimSpace(field.ID)
		if id == "" {
			continue
		}
		out[id] = unbounceFieldMeta{Name: strings.TrimSpace(field.Name), Type: strings.TrimSpace(field.Type)}
	}
	return out
}

func fetchUnbounceFormFields(ctx context.Context, client *http.Client, baseURL string, creds UnbounceCredentials, userAgent, pageID string, integration Integration) ([]unbounceFormField, error) {
	query := url.Values{}
	if value := settingString(integration.Settings, "include_sub_pages"); value != "" {
		query.Set("include_sub_pages", value)
	}
	raw, err := unbounceDoRaw(ctx, client, baseURL, creds, userAgent, http.MethodGet, "/pages/"+url.PathEscape(pageID)+"/form_fields", query, nil)
	if err != nil {
		return nil, err
	}
	var out unbounceFormFieldsResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return nil, fmt.Errorf("decode unbounce form fields: %w", err)
	}
	return out.FormFields, nil
}

func fetchUnbounceLeads(ctx context.Context, client *http.Client, baseURL string, creds UnbounceCredentials, userAgent, pageID string, offset, limit int, since string, integration Integration) (unbounceLeadsResponse, error) {
	query := url.Values{}
	query.Set("sort_order", "asc")
	query.Set("offset", strconv.Itoa(offset))
	query.Set("limit", strconv.Itoa(unbouncePageSize(limit)))
	if strings.TrimSpace(since) != "" {
		query.Set("from", strings.TrimSpace(since))
	}
	if to := firstString(settingString(integration.Settings, "to"), settingString(integration.Settings, "end_created_at"), settingString(integration.Settings, "created_to")); to != "" {
		query.Set("to", to)
	}
	raw, err := unbounceDoRaw(ctx, client, baseURL, creds, userAgent, http.MethodGet, "/pages/"+url.PathEscape(pageID)+"/leads", query, nil)
	if err != nil {
		return unbounceLeadsResponse{}, err
	}
	var out unbounceLeadsResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return unbounceLeadsResponse{}, fmt.Errorf("decode unbounce leads: %w", err)
	}
	return out, nil
}

func unbounceDoRaw(ctx context.Context, client *http.Client, baseURL string, creds UnbounceCredentials, userAgent, method, pathValue string, query url.Values, body io.Reader) ([]byte, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + pathValue)
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
	if token := strings.TrimSpace(creds.AccessToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	} else if apiKey := strings.TrimSpace(creds.APIKey); apiKey != "" {
		req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(apiKey+":")))
	}
	req.Header.Set("Accept", unbounceAcceptHeader)
	req.Header.Set("User-Agent", firstString(userAgent, unbounceDefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", unbounceAcceptHeader)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, unbounceResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, UnbounceProviderError{Path: pathValue, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: unbounceResponseSnippet(raw)}
	}
	return raw, nil
}

type UnbounceProviderError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e UnbounceProviderError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("unbounce REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("unbounce REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

func mapUnbounceLead(item unbounceLead, integration Integration, labels map[string]unbounceFieldMeta, fallbackPageID string) SubmissionInput {
	pageID := firstString(item.PageID, fallbackPageID, settingString(integration.Settings, "page_id"))
	fields := map[string]any{
		"unbounce_lead_id":       item.ID,
		"unbounce_page_id":       pageID,
		"unbounce_variant_id":    item.VariantID,
		"unbounce_created_at":    item.CreatedAt,
		"unbounce_submitter_ip":  item.SubmitterIP,
		"unbounce_extra_data":    item.ExtraData,
		"unbounce_metadata":      item.Metadata,
		"unbounce_provider_raw":  item.Raw,
		"unbounce_api_location":  item.Metadata.Location,
		"unbounce_documentation": item.Metadata.Documentation,
	}
	identity := typeformIdentity{}
	for key, value := range item.FormData {
		meta := labels[strings.TrimSpace(key)]
		label := firstString(meta.Name, key)
		normalizedKey := normalizeTypeformIdentityKey(label)
		normalizedValue := normalizeUnbounceValue(value)
		fields["unbounce_field."+normalizedKey] = normalizedValue
		fields["unbounce_field_id."+normalizedKey] = key
		if strings.TrimSpace(meta.Type) != "" {
			fields["unbounce_field_type."+normalizedKey] = meta.Type
		}
		applyUnbounceIdentity(&identity, integration, key, label, meta.Type, normalizedValue)
	}
	submittedAt := parseFilloutTime(item.CreatedAt)
	return SubmissionInput{
		SourceID:    unbounceSourceID(pageID, item.ID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      firstString(settingString(integration.Settings, "form_id"), pageID),
		FormName:    firstString(settingString(integration.Settings, "form_name"), settingString(integration.Settings, "page_name")),
		EventName:   "lead.submitted",
		Tags:        unbounceTags(integration, pageID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func applyUnbounceIdentity(identity *typeformIdentity, integration Integration, fieldID, label, fieldType string, value any) {
	if identity == nil {
		return
	}
	text := strings.TrimSpace(unbounceValueText(value))
	if text == "" || text == "<nil>" {
		return
	}
	switch {
	case unbounceIdentitySettingMatches(integration, fieldID, label, "email"):
		if identity.Email == "" {
			identity.Email = text
		}
	case unbounceIdentitySettingMatches(integration, fieldID, label, "first_name"):
		if identity.FirstName == "" {
			identity.FirstName = text
		}
	case unbounceIdentitySettingMatches(integration, fieldID, label, "last_name"):
		if identity.LastName == "" {
			identity.LastName = text
		}
	case unbounceIdentitySettingMatches(integration, fieldID, label, "full_name"):
		if identity.FullName == "" {
			identity.FullName = text
		}
	case unbounceIdentitySettingMatches(integration, fieldID, label, "phone"):
		if identity.Phone == "" {
			identity.Phone = text
		}
	case unbounceIdentitySettingMatches(integration, fieldID, label, "company"):
		if identity.Company == "" {
			identity.Company = text
		}
	}
	typ := strings.ToLower(strings.TrimSpace(fieldType))
	if strings.Contains(typ, "email") && identity.Email == "" {
		identity.Email = text
	}
	if strings.Contains(typ, "phone") && identity.Phone == "" {
		identity.Phone = text
	}
	applyFilloutStructuredIdentity(identity, value)
	identity.apply(firstString(label, fieldID), text)
	if label != fieldID {
		identity.apply(fieldID, text)
	}
}

func unbounceIdentitySettingMatches(integration Integration, fieldID, label, prefix string) bool {
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

func normalizeUnbounceMap(in map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range in {
		out[key] = normalizeUnbounceValue(value)
	}
	return out
}

func normalizeUnbounceValue(value any) any {
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
			out = append(out, normalizeUnbounceValue(item))
		}
		if len(out) == 1 {
			return out[0]
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = normalizeUnbounceValue(item)
		}
		return out
	default:
		return typed
	}
}

func unbounceValueText(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			text := strings.TrimSpace(unbounceValueText(item))
			if text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, ", ")
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func unbouncePageSize(size int) int {
	if size <= 0 {
		return unbounceDefaultPageSize
	}
	if size > unbounceMaxPageSize {
		return unbounceMaxPageSize
	}
	return size
}

func unbounceSourceID(pageID, leadID string) string {
	pageID = strings.TrimSpace(pageID)
	leadID = strings.TrimSpace(leadID)
	if pageID == "" || leadID == "" || leadID == "<nil>" {
		return ""
	}
	return "unbounce://lead/" + pageID + "/" + leadID
}

func unbounceTags(integration Integration, pageID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"unbounce", "unbounce:" + pageID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func laterUnbounceTimestamp(current, candidate string) string {
	return laterSurveyMonkeyTimestamp(current, candidate)
}

func unbounceNow(now func() time.Time) time.Time {
	if now != nil {
		return now().UTC()
	}
	return time.Now().UTC()
}

func unbounceResponseSnippet(raw []byte) string {
	snippet := strings.TrimSpace(string(raw))
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	return snippet
}
