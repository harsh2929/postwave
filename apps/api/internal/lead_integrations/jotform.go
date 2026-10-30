// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	jotformCursorPrefix       = "jotform:"
	jotformCursorComplete     = "jotform:complete"
	jotformDefaultAPIBaseURL  = "https://api.jotform.com"
	jotformEUAPIBaseURL       = "https://eu-api.jotform.com"
	jotformHIPAAAPIBaseURL    = "https://hipaa-api.jotform.com"
	jotformResponseMaxBytes   = 8 << 20
	jotformDefaultPageSize    = 100
	jotformMaxPageSize        = 1000
	jotformDefaultUserAgent   = "Moosewave Jotform Integration"
	jotformWebhookMaxBodySize = 2 << 20
)

type JotformCredentials struct {
	APIKey        string
	WebhookSecret string
	APIBaseURL    string
	UserAgent     string
}

type JotformCredentialResolver interface {
	ResolveJotform(context.Context, string, Integration) (JotformCredentials, error)
}

type JotformBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type JotformWebhookRegistrar interface {
	ReconcileWebhook(ctx context.Context, integration Integration, appBaseURL string) (JotformWebhookReconcileSummary, error)
	CleanupWebhook(ctx context.Context, integration Integration, appBaseURL string) (JotformWebhookCleanupSummary, error)
}

type JotformWebhookReconcileSummary struct {
	WebhookID    string    `json:"webhook_id"`
	Endpoint     string    `json:"endpoint"`
	RegisteredAt time.Time `json:"registered_at"`
	Created      bool      `json:"created"`
	Reused       bool      `json:"reused"`
}

type JotformWebhookCleanupSummary struct {
	WebhookID   string    `json:"webhook_id"`
	Endpoint    string    `json:"endpoint,omitempty"`
	CleanedUpAt time.Time `json:"cleaned_up_at"`
	Deleted     bool      `json:"deleted"`
	SkipReason  string    `json:"skip_reason,omitempty"`
}

type JotformRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials JotformCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type JotformRESTWebhookRegistrar struct {
	HTTPClient  *http.Client
	Credentials JotformCredentialResolver
	APIBaseURL  string
	UserAgent   string
	Now         func() time.Time
}

type JotformRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type JotformSecretsCredentialResolver struct {
	Secrets JotformRuntimeSecretResolver
}

func NewJotformSecretsCredentialResolver(secrets JotformRuntimeSecretResolver) *JotformSecretsCredentialResolver {
	return &JotformSecretsCredentialResolver{Secrets: secrets}
}

func (r *JotformSecretsCredentialResolver) ResolveJotform(ctx context.Context, _ string, integration Integration) (JotformCredentials, error) {
	if r == nil || r.Secrets == nil {
		return JotformCredentials{}, fmt.Errorf("jotform credential resolver is not configured")
	}
	ref := jotformCredentialRef(integration)
	if ref == "" {
		return JotformCredentials{}, fmt.Errorf("jotform credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return JotformCredentials{}, err
	}
	if webhookRef := jotformWebhookSecretRef(integration); webhookRef != "" && webhookRef != ref {
		secret, err := r.resolveWebhookSecret(ctx, webhookRef)
		if err != nil {
			return JotformCredentials{}, err
		}
		creds.WebhookSecret = secret
	}
	return creds, nil
}

func (r *JotformSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (JotformCredentials, error) {
	var payload jotformCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return JotformCredentials{}, fmt.Errorf("resolve jotform credentials %q: %w", ref, err)
		}
		return parseJotformCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return JotformCredentials{}, fmt.Errorf("resolve jotform credentials %q: %w", ref, err)
	}
	return parseJotformCredentialSecret(raw)
}

func (r *JotformSecretsCredentialResolver) resolveWebhookSecret(ctx context.Context, ref string) (string, error) {
	var payload jotformCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.webhookSecret()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve jotform webhook secret %q: %w", ref, err)
		}
		return parseJotformWebhookSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve jotform webhook secret %q: %w", ref, err)
	}
	return parseJotformWebhookSecret(raw)
}

type jotformCredentialPayload struct {
	APIKey        string `json:"api_key"`
	Key           string `json:"key"`
	Token         string `json:"token"`
	WebhookSecret string `json:"webhook_secret"`
	SigningSecret string `json:"signing_secret"`
	Secret        string `json:"secret"`
	APIBaseURL    string `json:"api_base_url"`
	UserAgent     string `json:"user_agent"`
}

func (p jotformCredentialPayload) credentials() (JotformCredentials, error) {
	apiKey := strings.TrimSpace(firstString(p.APIKey, p.Key, p.Token))
	if apiKey == "" {
		return JotformCredentials{}, fmt.Errorf("jotform api_key is required")
	}
	webhook, _ := p.webhookSecret()
	return JotformCredentials{
		APIKey:        apiKey,
		WebhookSecret: webhook,
		APIBaseURL:    strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:     strings.TrimSpace(p.UserAgent),
	}, nil
}

func (p jotformCredentialPayload) webhookSecret() (string, error) {
	secret := strings.TrimSpace(firstString(p.WebhookSecret, p.SigningSecret, p.Secret))
	if secret == "" {
		return "", fmt.Errorf("jotform webhook secret is required")
	}
	return secret, nil
}

func parseJotformCredentialSecret(raw string) (JotformCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return JotformCredentials{}, fmt.Errorf("jotform credentials are empty")
	}
	var payload jotformCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return JotformCredentials{}, fmt.Errorf("parse jotform credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseJotformKeyValueSecret(raw).credentials()
	}
	return jotformCredentialPayload{APIKey: raw}.credentials()
}

func parseJotformWebhookSecret(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("jotform webhook secret is empty")
	}
	var payload jotformCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse jotform webhook secret JSON: %w", err)
		}
		return payload.webhookSecret()
	}
	if strings.Contains(raw, "=") {
		return parseJotformKeyValueSecret(raw).webhookSecret()
	}
	return raw, nil
}

func parseJotformKeyValueSecret(raw string) jotformCredentialPayload {
	var payload jotformCredentialPayload
	for _, line := range strings.Split(raw, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) != 2 {
			continue
		}
		value := strings.TrimSpace(parts[1])
		switch strings.ToLower(strings.TrimSpace(parts[0])) {
		case "api_key", "apikey":
			payload.APIKey = value
		case "key":
			payload.Key = value
		case "token":
			payload.Token = value
		case "webhook_secret", "webhook_token":
			payload.WebhookSecret = value
		case "signing_secret":
			payload.SigningSecret = value
		case "secret":
			payload.Secret = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func jotformCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func jotformWebhookSecretRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_token_ref"),
		settingString(integration.Settings, "signing_secret_ref"),
	))
}

func (r JotformRESTWebhookRegistrar) ReconcileWebhook(ctx context.Context, integration Integration, appBaseURL string) (JotformWebhookReconcileSummary, error) {
	if integration.Provider != ProviderJotform {
		return JotformWebhookReconcileSummary{}, fmt.Errorf("jotform webhook registration requires a Jotform integration")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return JotformWebhookReconcileSummary{}, fmt.Errorf("jotform form_id is required")
	}
	if _, _, err := jotformWebhookURLs(appBaseURL, formID, ""); err != nil {
		return JotformWebhookReconcileSummary{}, err
	}
	if r.Credentials == nil {
		return JotformWebhookReconcileSummary{}, fmt.Errorf("jotform credential resolver is not configured")
	}
	creds, err := r.Credentials.ResolveJotform(ctx, integration.TenantID, integration)
	if err != nil {
		return JotformWebhookReconcileSummary{}, err
	}
	if strings.TrimSpace(creds.WebhookSecret) == "" {
		return JotformWebhookReconcileSummary{}, fmt.Errorf("jotform webhook secret is required for managed webhook registration")
	}
	endpoint, deliveryURL, err := jotformWebhookURLs(appBaseURL, formID, creds.WebhookSecret)
	if err != nil {
		return JotformWebhookReconcileSummary{}, err
	}
	client := leadEgressClient(r.HTTPClient, ProviderJotform, 30*time.Second)
	baseURL := strings.TrimRight(firstString(r.APIBaseURL, creds.APIBaseURL, jotformRegionBaseURL(settingString(integration.Settings, "api_region")), jotformDefaultAPIBaseURL), "/")
	userAgent := firstString(r.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), jotformDefaultUserAgent)
	existing, err := r.listWebhooks(ctx, client, baseURL, creds.APIKey, userAgent, formID)
	if err != nil {
		return JotformWebhookReconcileSummary{}, err
	}
	if webhookID := jotformFindWebhookID(existing, endpoint); webhookID != "" {
		return JotformWebhookReconcileSummary{
			WebhookID:    webhookID,
			Endpoint:     endpoint,
			RegisteredAt: r.now(),
			Reused:       true,
		}, nil
	}
	created, err := r.createWebhook(ctx, client, baseURL, creds.APIKey, userAgent, formID, deliveryURL)
	if err != nil {
		return JotformWebhookReconcileSummary{}, err
	}
	webhookID := jotformFindWebhookID(created, endpoint)
	if webhookID == "" {
		refreshed, err := r.listWebhooks(ctx, client, baseURL, creds.APIKey, userAgent, formID)
		if err != nil {
			return JotformWebhookReconcileSummary{}, err
		}
		webhookID = jotformFindWebhookID(refreshed, endpoint)
	}
	if webhookID == "" {
		return JotformWebhookReconcileSummary{}, fmt.Errorf("jotform webhook create response missing webhook id")
	}
	return JotformWebhookReconcileSummary{
		WebhookID:    webhookID,
		Endpoint:     endpoint,
		RegisteredAt: r.now(),
		Created:      true,
	}, nil
}

func (r JotformRESTWebhookRegistrar) CleanupWebhook(ctx context.Context, integration Integration, appBaseURL string) (JotformWebhookCleanupSummary, error) {
	if integration.Provider != ProviderJotform {
		return JotformWebhookCleanupSummary{}, fmt.Errorf("jotform webhook cleanup requires a Jotform integration")
	}
	webhookID := strings.TrimSpace(settingString(integration.Settings, "jotform_webhook_id"))
	endpoint := strings.TrimSpace(settingString(integration.Settings, "jotform_webhook_endpoint"))
	if webhookID == "" {
		return JotformWebhookCleanupSummary{
			Endpoint:    endpoint,
			CleanedUpAt: r.now(),
			SkipReason:  "missing_webhook_id",
		}, nil
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return JotformWebhookCleanupSummary{}, fmt.Errorf("jotform form_id is required")
	}
	if endpoint == "" {
		if generated, _, err := jotformWebhookURLs(appBaseURL, formID, ""); err == nil {
			endpoint = generated
		}
	}
	if r.Credentials == nil {
		return JotformWebhookCleanupSummary{}, fmt.Errorf("jotform credential resolver is not configured")
	}
	creds, err := r.Credentials.ResolveJotform(ctx, integration.TenantID, integration)
	if err != nil {
		return JotformWebhookCleanupSummary{}, err
	}
	client := leadEgressClient(r.HTTPClient, ProviderJotform, 30*time.Second)
	baseURL := strings.TrimRight(firstString(r.APIBaseURL, creds.APIBaseURL, jotformRegionBaseURL(settingString(integration.Settings, "api_region")), jotformDefaultAPIBaseURL), "/")
	userAgent := firstString(r.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), jotformDefaultUserAgent)
	if err := r.deleteWebhook(ctx, client, baseURL, creds.APIKey, userAgent, formID, webhookID); err != nil {
		return JotformWebhookCleanupSummary{}, err
	}
	return JotformWebhookCleanupSummary{
		WebhookID:   webhookID,
		Endpoint:    endpoint,
		CleanedUpAt: r.now(),
		Deleted:     true,
	}, nil
}

func (r JotformRESTWebhookRegistrar) listWebhooks(ctx context.Context, client *http.Client, baseURL, apiKey, userAgent, formID string) (map[string]string, error) {
	raw, err := jotformDoContent(ctx, client, baseURL, apiKey, userAgent, http.MethodGet, "/form/"+url.PathEscape(formID)+"/webhooks", nil)
	if err != nil {
		return nil, err
	}
	return decodeJotformWebhookList(raw)
}

func (r JotformRESTWebhookRegistrar) createWebhook(ctx context.Context, client *http.Client, baseURL, apiKey, userAgent, formID, deliveryURL string) (map[string]string, error) {
	form := url.Values{}
	form.Set("webhookURL", deliveryURL)
	raw, err := jotformDoContentWithBody(ctx, client, baseURL, apiKey, userAgent, http.MethodPost, "/form/"+url.PathEscape(formID)+"/webhooks", nil, strings.NewReader(form.Encode()), "application/x-www-form-urlencoded")
	if err != nil {
		return nil, err
	}
	return decodeJotformWebhookList(raw)
}

func (r JotformRESTWebhookRegistrar) deleteWebhook(ctx context.Context, client *http.Client, baseURL, apiKey, userAgent, formID, webhookID string) error {
	_, err := jotformDoRawWithContentType(ctx, client, baseURL, apiKey, userAgent, http.MethodDelete, "/form/"+url.PathEscape(formID)+"/webhooks/"+url.PathEscape(webhookID), nil, nil, "")
	var statusErr jotformHTTPStatusError
	if err != nil && errors.As(err, &statusErr) && statusErr.StatusCode == http.StatusNotFound {
		return nil
	}
	return err
}

func (r JotformRESTWebhookRegistrar) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func (b JotformRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderJotform {
		return SyncRequest{}, fmt.Errorf("jotform backfill requires a Jotform integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("jotform credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("jotform form_id is required")
	}
	creds, err := b.Credentials.ResolveJotform(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.APIKey) == "" {
		return SyncRequest{}, fmt.Errorf("jotform api key is required")
	}
	state, err := decodeJotformCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: jotformCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderJotform, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, jotformRegionBaseURL(settingString(integration.Settings, "api_region")), jotformDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), jotformDefaultUserAgent)
	form, _ := fetchJotformForm(ctx, client, baseURL, creds.APIKey, userAgent, formID)
	questions, _ := fetchJotformQuestions(ctx, client, baseURL, creds.APIKey, userAgent, formID)
	pageSize := jotformPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	items, err := fetchJotformSubmissions(ctx, client, baseURL, creds.APIKey, userAgent, formID, state.Offset, pageSize)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(items))}
	for _, item := range items {
		submission := mapJotformSubmission(form, questions, item, integration)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	if len(items) < pageSize {
		req.Cursor = jotformCursorComplete
	} else {
		req.Cursor = encodeJotformCursor(jotformCursorState{Offset: state.Offset + len(items)})
	}
	return req, nil
}

type jotformCursorState struct {
	Offset   int  `json:"offset,omitempty"`
	Complete bool `json:"complete,omitempty"`
}

func decodeJotformCursor(cursor string) (jotformCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return jotformCursorState{}, nil
	}
	if cursor == jotformCursorComplete {
		return jotformCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, jotformCursorPrefix) {
		return jotformCursorState{}, fmt.Errorf("invalid Jotform cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, jotformCursorPrefix))
	if raw == "" {
		return jotformCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return jotformCursorState{}, fmt.Errorf("invalid Jotform cursor")
	}
	var out jotformCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return jotformCursorState{}, fmt.Errorf("invalid Jotform cursor")
	}
	if out.Offset < 0 {
		out.Offset = 0
	}
	return out, nil
}

func encodeJotformCursor(state jotformCursorState) string {
	if state.Complete {
		return jotformCursorComplete
	}
	if state.Offset < 0 {
		state.Offset = 0
	}
	raw, _ := json.Marshal(state)
	return jotformCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type jotformEnvelope struct {
	ResponseCode int             `json:"responseCode"`
	Message      string          `json:"message"`
	Content      json.RawMessage `json:"content"`
}

type jotformHTTPStatusError struct {
	Path       string
	StatusCode int
	Body       string
}

func (e jotformHTTPStatusError) Error() string {
	return fmt.Sprintf("jotform REST %s failed %d: %s", e.Path, e.StatusCode, e.Body)
}

type jotformForm struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type jotformQuestion struct {
	ID    string `json:"qid"`
	Name  string `json:"name"`
	Text  string `json:"text"`
	Type  string `json:"type"`
	Order string `json:"order"`
}

type jotformSubmission struct {
	ID        string                   `json:"id"`
	FormID    string                   `json:"form_id"`
	CreatedAt string                   `json:"created_at"`
	UpdatedAt string                   `json:"updated_at"`
	Status    string                   `json:"status"`
	IPAddress string                   `json:"ip"`
	Answers   map[string]jotformAnswer `json:"answers"`
	Raw       map[string]any           `json:"-"`
}

type jotformAnswer struct {
	Name         string          `json:"name"`
	Order        string          `json:"order"`
	Text         string          `json:"text"`
	Type         string          `json:"type"`
	Answer       any             `json:"answer"`
	PrettyFormat string          `json:"prettyFormat"`
	Raw          json.RawMessage `json:"-"`
}

func fetchJotformForm(ctx context.Context, client *http.Client, baseURL, apiKey, userAgent, formID string) (jotformForm, error) {
	raw, err := jotformDoContent(ctx, client, baseURL, apiKey, userAgent, http.MethodGet, "/form/"+url.PathEscape(formID), nil)
	if err != nil {
		return jotformForm{ID: formID}, err
	}
	var out jotformForm
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return jotformForm{ID: formID}, fmt.Errorf("decode jotform form response: %w", err)
	}
	if out.ID == "" {
		out.ID = formID
	}
	return out, nil
}

func fetchJotformQuestions(ctx context.Context, client *http.Client, baseURL, apiKey, userAgent, formID string) (map[string]jotformQuestion, error) {
	raw, err := jotformDoContent(ctx, client, baseURL, apiKey, userAgent, http.MethodGet, "/form/"+url.PathEscape(formID)+"/questions", nil)
	if err != nil {
		return nil, err
	}
	var byID map[string]jotformQuestion
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&byID); err != nil && err != io.EOF {
		return nil, fmt.Errorf("decode jotform questions response: %w", err)
	}
	for id, q := range byID {
		if q.ID == "" {
			q.ID = id
			byID[id] = q
		}
	}
	return byID, nil
}

func fetchJotformSubmissions(ctx context.Context, client *http.Client, baseURL, apiKey, userAgent, formID string, offset, limit int) ([]jotformSubmission, error) {
	query := url.Values{}
	query.Set("offset", strconv.Itoa(offset))
	query.Set("limit", strconv.Itoa(jotformPageSize(limit)))
	query.Set("orderby", "created_at")
	raw, err := jotformDoContent(ctx, client, baseURL, apiKey, userAgent, http.MethodGet, "/form/"+url.PathEscape(formID)+"/submissions", query)
	if err != nil {
		return nil, err
	}
	var out []jotformSubmission
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return nil, fmt.Errorf("decode jotform submissions response: %w", err)
	}
	for i := range out {
		var raw map[string]any
		_ = json.Unmarshal(rawSubmissionJSON(out[i]), &raw)
		out[i].Raw = nonNilMap(raw)
	}
	return out, nil
}

func jotformDoContent(ctx context.Context, client *http.Client, baseURL, apiKey, userAgent, method, path string, query url.Values) ([]byte, error) {
	return jotformDoContentWithBody(ctx, client, baseURL, apiKey, userAgent, method, path, query, nil, "")
}

func jotformDoContentWithBody(ctx context.Context, client *http.Client, baseURL, apiKey, userAgent, method, path string, query url.Values, body io.Reader, contentType string) ([]byte, error) {
	raw, err := jotformDoRawWithContentType(ctx, client, baseURL, apiKey, userAgent, method, path, query, body, contentType)
	if err != nil {
		return nil, err
	}
	var env jotformEnvelope
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&env); err != nil && err != io.EOF {
		return nil, fmt.Errorf("decode jotform %s response: %w", path, err)
	}
	if env.ResponseCode != 0 && (env.ResponseCode < 200 || env.ResponseCode > 299) {
		return nil, fmt.Errorf("jotform REST %s failed responseCode=%d: %s", path, env.ResponseCode, env.Message)
	}
	if len(env.Content) == 0 || string(env.Content) == "null" {
		return []byte("null"), nil
	}
	return env.Content, nil
}

func jotformDoRaw(ctx context.Context, client *http.Client, baseURL, apiKey, userAgent, method, path string, query url.Values, body io.Reader) ([]byte, error) {
	return jotformDoRawWithContentType(ctx, client, baseURL, apiKey, userAgent, method, path, query, body, "")
}

func jotformDoRawWithContentType(ctx context.Context, client *http.Client, baseURL, apiKey, userAgent, method, path string, query url.Values, body io.Reader, contentType string) ([]byte, error) {
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
	req.Header.Set("APIKEY", strings.TrimSpace(apiKey))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, jotformDefaultUserAgent))
	if contentType = strings.TrimSpace(contentType); contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, jotformResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, jotformHTTPStatusError{Path: path, StatusCode: resp.StatusCode, Body: strings.TrimSpace(string(raw))}
	}
	return raw, nil
}

func jotformWebhookURLs(appBaseURL, formID, token string) (string, string, error) {
	appBaseURL = strings.TrimRight(strings.TrimSpace(appBaseURL), "/")
	formID = strings.TrimSpace(formID)
	if appBaseURL == "" {
		return "", "", fmt.Errorf("public base URL is required for Jotform webhook registration")
	}
	if formID == "" {
		return "", "", fmt.Errorf("jotform form_id is required")
	}
	u, err := url.Parse(appBaseURL + "/api/public/lead-integrations/jotform/webhooks")
	if err != nil {
		return "", "", err
	}
	q := u.Query()
	q.Set("form_id", formID)
	u.RawQuery = q.Encode()
	endpoint := u.String()
	if strings.TrimSpace(token) != "" {
		q.Set("token", strings.TrimSpace(token))
		u.RawQuery = q.Encode()
	}
	return endpoint, u.String(), nil
}

func decodeJotformWebhookList(raw []byte) (map[string]string, error) {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return map[string]string{}, nil
	}
	var value any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&value); err != nil && err != io.EOF {
		return nil, fmt.Errorf("decode jotform webhooks response: %w", err)
	}
	out := map[string]string{}
	collectJotformWebhookList(value, out)
	return out, nil
}

func collectJotformWebhookList(value any, out map[string]string) {
	switch typed := value.(type) {
	case map[string]any:
		if nested := anyMap(typed["webhooks"]); len(nested) > 0 {
			collectJotformWebhookList(nested, out)
		}
		if nested := anyMap(typed["content"]); len(nested) > 0 {
			collectJotformWebhookList(nested, out)
		}
		id := firstString(mapString(typed, "id", "whid", "webhookID", "webhook_id"))
		hookURL := firstString(mapString(typed, "url", "webhookURL", "webhook_url"))
		if id != "" && hookURL != "" {
			out[id] = hookURL
		}
		for key, raw := range typed {
			key = strings.TrimSpace(key)
			switch v := raw.(type) {
			case string:
				if key != "" && strings.HasPrefix(strings.ToLower(strings.TrimSpace(v)), "http") {
					out[key] = strings.TrimSpace(v)
				}
			case map[string]any, []any:
				before := len(out)
				collectJotformWebhookList(v, out)
				if len(out) == before {
					row := anyMap(v)
					rowID := firstString(mapString(row, "id", "whid", "webhookID", "webhook_id"), key)
					rowURL := firstString(mapString(row, "url", "webhookURL", "webhook_url"))
					if rowID != "" && rowURL != "" {
						out[rowID] = rowURL
					}
				}
			}
		}
	case []any:
		for idx, item := range typed {
			before := len(out)
			collectJotformWebhookList(item, out)
			if len(out) == before {
				if hookURL := strings.TrimSpace(fmt.Sprint(item)); strings.HasPrefix(strings.ToLower(hookURL), "http") {
					out[strconv.Itoa(idx)] = hookURL
				}
			}
		}
	}
}

func jotformFindWebhookID(webhooks map[string]string, endpoint string) string {
	expected := jotformSafeWebhookURL(endpoint)
	for id, hookURL := range webhooks {
		if strings.TrimSpace(id) != "" && jotformSafeWebhookURL(hookURL) == expected {
			return strings.TrimSpace(id)
		}
	}
	return ""
}

func jotformSafeWebhookURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return strings.TrimSpace(raw)
	}
	q := u.Query()
	q.Del("token")
	q.Del("webhook_token")
	u.RawQuery = q.Encode()
	u.Fragment = ""
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	return strings.TrimRight(u.String(), "/")
}

func mapJotformSubmission(form jotformForm, questions map[string]jotformQuestion, item jotformSubmission, integration Integration) SubmissionInput {
	formID := firstString(item.FormID, form.ID, settingString(integration.Settings, "form_id"))
	fields := map[string]any{
		"jotform_submission_id": item.ID,
		"jotform_form_id":       formID,
		"jotform_status":        item.Status,
		"jotform_ip":            item.IPAddress,
		"jotform_provider_raw":  item.Raw,
	}
	identity := typeformIdentity{}
	for qid, answer := range item.Answers {
		question := questions[qid]
		key := jotformAnswerKey(qid, answer, question)
		value := jotformAnswerValue(answer)
		if key != "" {
			fields["jotform_answer."+key] = value
		}
		applyJotformIdentity(&identity, answer, question, value)
	}
	if identity.FullName == "" && identity.FirstName != "" && identity.LastName != "" {
		identity.FullName = strings.TrimSpace(identity.FirstName + " " + identity.LastName)
	}
	submittedAt := parseJotformTime(firstString(item.CreatedAt, item.UpdatedAt))
	return SubmissionInput{
		SourceID:    jotformSourceID("submission", formID, item.ID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    firstString(form.Title, settingString(integration.Settings, "form_name")),
		EventName:   "lead.submitted",
		Tags:        jotformTags(integration, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func jotformAnswerKey(qid string, answer jotformAnswer, question jotformQuestion) string {
	return firstString(answer.Name, question.Name, normalizeTypeformIdentityKey(answer.Text), normalizeTypeformIdentityKey(question.Text), qid)
}

func jotformAnswerValue(answer jotformAnswer) any {
	if answer.Answer != nil {
		return normalizeJotformAnswerValue(answer.Answer)
	}
	if strings.TrimSpace(answer.PrettyFormat) != "" {
		return strings.TrimSpace(answer.PrettyFormat)
	}
	return ""
}

func normalizeJotformAnswerValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		for _, key := range []string{"answer", "value", "prettyFormat"} {
			if v, ok := typed[key]; ok && v != nil {
				return normalizeJotformAnswerValue(v)
			}
		}
		if first, last := mapString(typed, "first", "firstName"), mapString(typed, "last", "lastName"); first != "" || last != "" {
			return strings.TrimSpace(first + " " + last)
		}
		return typed
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, normalizeJotformAnswerValue(item))
		}
		return out
	default:
		return typed
	}
}

func applyJotformIdentity(identity *typeformIdentity, answer jotformAnswer, question jotformQuestion, value any) {
	if identity == nil {
		return
	}
	answerType := strings.ToLower(firstString(answer.Type, question.Type))
	label := firstString(answer.Text, question.Text, answer.Name, question.Name)
	text := strings.TrimSpace(fmt.Sprint(value))
	if answerType == "control_email" || strings.Contains(answerType, "email") {
		if identity.Email == "" {
			identity.Email = text
		}
	}
	if strings.Contains(answerType, "phone") {
		if identity.Phone == "" {
			identity.Phone = text
		}
	}
	if strings.Contains(answerType, "fullname") || strings.Contains(answerType, "name") {
		if typed, ok := answer.Answer.(map[string]any); ok {
			if identity.FirstName == "" {
				identity.FirstName = mapString(typed, "first", "firstName")
			}
			if identity.LastName == "" {
				identity.LastName = mapString(typed, "last", "lastName")
			}
		}
		if identity.FullName == "" {
			identity.FullName = text
		}
	}
	if identity.Email == "" && strings.Contains(text, "@") && strings.Contains(strings.ToLower(label), "email") {
		identity.Email = text
	}
	identity.apply(label, text)
}

func (d *Deps) JotformWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, jotformWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Jotform webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeJotformWebhookPayload(body, r.Header.Get("Content-Type"))
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	formID := firstString(payload.FormID, settingString(payload.Raw, "formID"), settingString(payload.Raw, "form_id"))
	if formID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_form_id", "Jotform webhook formID is required")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderFormID(r.Context(), ProviderJotform, formID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Jotform integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resolver := d.jotformCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Jotform credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveJotform(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyJotformWebhookSecret(creds.WebhookSecret, r.URL.Query().Get("token"), r.Header.Get("X-Postwave-Webhook-Secret"), r.Header.Get("X-Jotform-Webhook-Secret"), r.Header.Get("Authorization")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	submission := mapJotformSubmission(jotformForm{ID: formID, Title: settingString(integration.Settings, "form_name")}, nil, payload.Submission, *integration)
	submission.Fields["jotform_webhook_raw"] = payload.Raw
	req := normalizeSyncRequest(SyncRequest{RunMode: "webhook", Submissions: []SubmissionInput{submission}, Cursor: "jotform-webhook-" + firstString(payload.Submission.ID, localJotformWebhookID(payload.Raw))})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	writeJSON(w, http.StatusAccepted, summary)
}

type jotformWebhookPayload struct {
	FormID     string
	Submission jotformSubmission
	Raw        map[string]any
}

func decodeJotformWebhookPayload(body []byte, contentType string) (jotformWebhookPayload, error) {
	mediaType, params, _ := mime.ParseMediaType(contentType)
	values := map[string]any{}
	switch {
	case mediaType == "multipart/form-data":
		reader := bytes.NewReader(body)
		mr := multipartReader(reader, params["boundary"])
		if mr == nil {
			return jotformWebhookPayload{}, fmt.Errorf("invalid multipart boundary")
		}
		form, err := mr.ReadForm(jotformWebhookMaxBodySize)
		if err != nil {
			return jotformWebhookPayload{}, fmt.Errorf("decode jotform multipart webhook: %w", err)
		}
		defer func() { _ = form.RemoveAll() }()
		for key, vals := range form.Value {
			if len(vals) > 0 {
				values[key] = vals[0]
			}
		}
	case mediaType == "application/x-www-form-urlencoded":
		form, err := url.ParseQuery(string(body))
		if err != nil {
			return jotformWebhookPayload{}, fmt.Errorf("decode jotform form webhook: %w", err)
		}
		for key, vals := range form {
			if len(vals) > 0 {
				values[key] = vals[0]
			}
		}
	default:
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.UseNumber()
		if err := dec.Decode(&values); err != nil && err != io.EOF {
			return jotformWebhookPayload{}, fmt.Errorf("decode jotform JSON webhook: %w", err)
		}
	}
	rawRequest := map[string]any{}
	if raw := mapString(values, "rawRequest", "raw_request"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &rawRequest)
	}
	raw := nonNilMap(values)
	if len(rawRequest) > 0 {
		raw["rawRequestParsed"] = rawRequest
	}
	formID := firstString(mapString(raw, "formID", "form_id"), mapString(rawRequest, "formID", "form_id"))
	submissionID := firstString(mapString(raw, "submissionID", "submission_id"), mapString(rawRequest, "submissionID", "submission_id", "id"))
	submission := jotformSubmission{
		ID:        submissionID,
		FormID:    formID,
		CreatedAt: firstString(mapString(raw, "created_at", "createdAt"), mapString(rawRequest, "created_at", "createdAt")),
		IPAddress: firstString(mapString(raw, "ip"), mapString(rawRequest, "ip")),
		Status:    firstString(mapString(raw, "status"), mapString(rawRequest, "status")),
		Answers:   jotformWebhookAnswers(raw, rawRequest),
		Raw:       raw,
	}
	return jotformWebhookPayload{FormID: formID, Submission: submission, Raw: raw}, nil
}

func multipartReader(reader io.Reader, boundary string) *multipart.Reader {
	boundary = strings.TrimSpace(boundary)
	if boundary == "" {
		return nil
	}
	return multipart.NewReader(reader, boundary)
}

func jotformWebhookAnswers(raw, rawRequest map[string]any) map[string]jotformAnswer {
	if answers := jotformAnswersFromAny(raw["answers"]); len(answers) > 0 {
		return answers
	}
	if answers := jotformAnswersFromAny(rawRequest["answers"]); len(answers) > 0 {
		return answers
	}
	out := map[string]jotformAnswer{}
	source := rawRequest
	if len(source) == 0 {
		source = raw
	}
	skip := map[string]bool{"submissionid": true, "formid": true, "ip": true, "created_at": true, "createdat": true, "rawrequest": true}
	for key, value := range source {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if normalized == "" || skip[normalized] {
			continue
		}
		out[key] = jotformAnswer{Name: key, Text: key, Answer: value}
	}
	return out
}

func jotformAnswersFromAny(value any) map[string]jotformAnswer {
	source := anyMap(value)
	if len(source) == 0 {
		return nil
	}
	out := map[string]jotformAnswer{}
	for key, raw := range source {
		answerMap := anyMap(raw)
		if len(answerMap) == 0 {
			out[key] = jotformAnswer{Name: key, Text: key, Answer: raw}
			continue
		}
		answer := jotformAnswer{
			Name:         mapString(answerMap, "name"),
			Order:        mapString(answerMap, "order"),
			Text:         mapString(answerMap, "text", "label"),
			Type:         mapString(answerMap, "type"),
			Answer:       answerMap["answer"],
			PrettyFormat: mapString(answerMap, "prettyFormat", "pretty_format"),
		}
		out[key] = answer
	}
	return out
}

func VerifyJotformWebhookSecret(secret string, candidates ...string) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingWebhookSecret
	}
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if strings.HasPrefix(strings.ToLower(candidate), "bearer ") {
			candidate = strings.TrimSpace(candidate[len("bearer "):])
		}
		if subtle.ConstantTimeCompare([]byte(secret), []byte(candidate)) == 1 {
			return nil
		}
	}
	return ErrInvalidWebhookSignature
}

func jotformRegionBaseURL(region string) string {
	switch strings.ToLower(strings.TrimSpace(region)) {
	case "eu", "europe":
		return jotformEUAPIBaseURL
	case "hipaa":
		return jotformHIPAAAPIBaseURL
	default:
		return ""
	}
}

func jotformPageSize(size int) int {
	if size <= 0 {
		return jotformDefaultPageSize
	}
	if size > jotformMaxPageSize {
		return jotformMaxPageSize
	}
	return size
}

func jotformSourceID(kind, formID, id string) string {
	kind = strings.TrimSpace(kind)
	formID = strings.TrimSpace(formID)
	id = strings.TrimSpace(id)
	if kind == "" || formID == "" || id == "" || id == "<nil>" {
		return ""
	}
	return "jotform://" + kind + "/" + formID + "/" + id
}

func jotformTags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"jotform", "jotform:" + formID} {
		if strings.TrimSpace(tag) != "jotform:" && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func parseJotformTime(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05", "2006-01-02 15:04"} {
		if t, err := time.Parse(layout, raw); err == nil {
			utc := t.UTC()
			return &utc
		}
	}
	return nil
}

func rawSubmissionJSON(item jotformSubmission) []byte {
	type alias jotformSubmission
	raw, _ := json.Marshal(alias(item))
	return raw
}

func localJotformWebhookID(raw map[string]any) string {
	body, _ := json.Marshal(raw)
	sum := sha256.Sum256(body)
	return "jotform_local_" + base64.RawURLEncoding.EncodeToString(sum[:])
}
