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
	filloutCursorPrefix       = "fillout:"
	filloutCursorComplete     = "fillout:complete"
	filloutDefaultAPIBaseURL  = "https://api.fillout.com/v1/api"
	filloutEUAPIBaseURL       = "https://eu-api.fillout.com/v1/api"
	filloutResponseMaxBytes   = 8 << 20
	filloutDefaultPageSize    = 100
	filloutMaxPageSize        = 150
	filloutDefaultUserAgent   = "Moosewave Fillout Integration"
	filloutWebhookMaxBodySize = 2 << 20
)

type FilloutCredentials struct {
	AccessToken   string
	WebhookSecret string
	APIBaseURL    string
	UserAgent     string
}

type FilloutCredentialResolver interface {
	ResolveFillout(context.Context, string, Integration) (FilloutCredentials, error)
}

type FilloutBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type FilloutRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials FilloutCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type FilloutWebhookRegistrar interface {
	ReconcileWebhook(ctx context.Context, integration Integration, appBaseURL string) (FilloutWebhookReconcileSummary, error)
	CleanupWebhook(ctx context.Context, integration Integration, appBaseURL string) (FilloutWebhookCleanupSummary, error)
}

type FilloutWebhookReconcileSummary struct {
	WebhookID    string    `json:"webhook_id"`
	Endpoint     string    `json:"endpoint"`
	RegisteredAt time.Time `json:"registered_at"`
	Created      bool      `json:"created,omitempty"`
	Reused       bool      `json:"reused,omitempty"`
}

type FilloutWebhookCleanupSummary struct {
	WebhookID   string    `json:"webhook_id"`
	Endpoint    string    `json:"endpoint,omitempty"`
	CleanedUpAt time.Time `json:"cleaned_up_at"`
	Deleted     bool      `json:"deleted,omitempty"`
	Skipped     bool      `json:"skipped,omitempty"`
	SkipReason  string    `json:"skip_reason,omitempty"`
}

type FilloutRESTWebhookRegistrar struct {
	HTTPClient  *http.Client
	Credentials FilloutCredentialResolver
	APIBaseURL  string
	UserAgent   string
	Now         func() time.Time
}

type FilloutRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type FilloutSecretsCredentialResolver struct {
	Secrets FilloutRuntimeSecretResolver
}

func NewFilloutSecretsCredentialResolver(secrets FilloutRuntimeSecretResolver) *FilloutSecretsCredentialResolver {
	return &FilloutSecretsCredentialResolver{Secrets: secrets}
}

func (r *FilloutSecretsCredentialResolver) ResolveFillout(ctx context.Context, _ string, integration Integration) (FilloutCredentials, error) {
	if r == nil || r.Secrets == nil {
		return FilloutCredentials{}, fmt.Errorf("fillout credential resolver is not configured")
	}
	ref := filloutCredentialRef(integration)
	if ref == "" {
		return FilloutCredentials{}, fmt.Errorf("fillout credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return FilloutCredentials{}, err
	}
	if webhookRef := filloutWebhookSecretRef(integration); webhookRef != "" && webhookRef != ref {
		secret, err := r.resolveWebhookSecret(ctx, webhookRef)
		if err != nil {
			return FilloutCredentials{}, err
		}
		creds.WebhookSecret = secret
	}
	return creds, nil
}

func (r *FilloutSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (FilloutCredentials, error) {
	var payload filloutCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return FilloutCredentials{}, fmt.Errorf("resolve fillout credentials %q: %w", ref, err)
		}
		return parseFilloutCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return FilloutCredentials{}, fmt.Errorf("resolve fillout credentials %q: %w", ref, err)
	}
	return parseFilloutCredentialSecret(raw)
}

func (r *FilloutSecretsCredentialResolver) resolveWebhookSecret(ctx context.Context, ref string) (string, error) {
	var payload filloutCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.webhookSecret()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve fillout webhook secret %q: %w", ref, err)
		}
		return parseFilloutWebhookSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve fillout webhook secret %q: %w", ref, err)
	}
	return parseFilloutWebhookSecret(raw)
}

type filloutCredentialPayload struct {
	AccessToken   string `json:"access_token"`
	APIKey        string `json:"api_key"`
	Token         string `json:"token"`
	BearerToken   string `json:"bearer_token"`
	WebhookSecret string `json:"webhook_secret"`
	SigningSecret string `json:"signing_secret"`
	Secret        string `json:"secret"`
	APIBaseURL    string `json:"api_base_url"`
	UserAgent     string `json:"user_agent"`
}

func (p filloutCredentialPayload) credentials() (FilloutCredentials, error) {
	token := normalizeFilloutBearerToken(firstString(p.AccessToken, p.APIKey, p.Token, p.BearerToken))
	if token == "" {
		return FilloutCredentials{}, fmt.Errorf("fillout api_key or access_token is required")
	}
	webhook, _ := p.webhookSecret()
	return FilloutCredentials{
		AccessToken:   token,
		WebhookSecret: webhook,
		APIBaseURL:    strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		UserAgent:     strings.TrimSpace(p.UserAgent),
	}, nil
}

func (p filloutCredentialPayload) webhookSecret() (string, error) {
	secret := strings.TrimSpace(firstString(p.WebhookSecret, p.SigningSecret, p.Secret))
	if secret == "" {
		return "", fmt.Errorf("fillout webhook secret is required")
	}
	return secret, nil
}

func parseFilloutCredentialSecret(raw string) (FilloutCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return FilloutCredentials{}, fmt.Errorf("fillout credentials are empty")
	}
	var payload filloutCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return FilloutCredentials{}, fmt.Errorf("parse fillout credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseFilloutKeyValueSecret(raw).credentials()
	}
	return filloutCredentialPayload{AccessToken: raw}.credentials()
}

func parseFilloutWebhookSecret(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("fillout webhook secret is empty")
	}
	var payload filloutCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse fillout webhook secret JSON: %w", err)
		}
		return payload.webhookSecret()
	}
	if strings.Contains(raw, "=") {
		return parseFilloutKeyValueSecret(raw).webhookSecret()
	}
	return raw, nil
}

func parseFilloutKeyValueSecret(raw string) filloutCredentialPayload {
	var payload filloutCredentialPayload
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

func normalizeFilloutBearerToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.TrimPrefix(token, "Bearer ")
	token = strings.TrimPrefix(token, "bearer ")
	return strings.TrimSpace(token)
}

func filloutCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func filloutWebhookSecretRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_token_ref"),
		settingString(integration.Settings, "signing_secret_ref"),
	))
}

func (r FilloutRESTWebhookRegistrar) ReconcileWebhook(ctx context.Context, integration Integration, appBaseURL string) (FilloutWebhookReconcileSummary, error) {
	if integration.Provider != ProviderFillout {
		return FilloutWebhookReconcileSummary{}, fmt.Errorf("fillout webhook registration requires a Fillout integration")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return FilloutWebhookReconcileSummary{}, fmt.Errorf("fillout form_id is required")
	}
	appBaseURL = strings.TrimRight(strings.TrimSpace(appBaseURL), "/")
	if appBaseURL == "" {
		return FilloutWebhookReconcileSummary{}, fmt.Errorf("public base URL is required for Fillout webhook registration")
	}
	endpoint := filloutWebhookEndpoint(appBaseURL, formID)
	if existingID := strings.TrimSpace(settingString(integration.Settings, "fillout_webhook_id")); existingID != "" &&
		strings.TrimSpace(settingString(integration.Settings, "fillout_webhook_endpoint")) == endpoint {
		return FilloutWebhookReconcileSummary{
			WebhookID:    existingID,
			Endpoint:     endpoint,
			RegisteredAt: r.now(),
			Reused:       true,
		}, nil
	}
	client, baseURL, creds, userAgent, err := r.client(ctx, integration)
	if err != nil {
		return FilloutWebhookReconcileSummary{}, err
	}
	if strings.TrimSpace(creds.WebhookSecret) == "" {
		return FilloutWebhookReconcileSummary{}, fmt.Errorf("fillout webhook secret is required for managed webhook registration")
	}
	deliveryURL := filloutWebhookDeliveryURL(appBaseURL, formID, creds.WebhookSecret)
	webhookID, err := r.createWebhook(ctx, client, baseURL, creds.AccessToken, userAgent, formID, deliveryURL)
	if err != nil {
		return FilloutWebhookReconcileSummary{}, err
	}
	return FilloutWebhookReconcileSummary{
		WebhookID:    webhookID,
		Endpoint:     endpoint,
		RegisteredAt: r.now(),
		Created:      true,
	}, nil
}

func (r FilloutRESTWebhookRegistrar) CleanupWebhook(ctx context.Context, integration Integration, appBaseURL string) (FilloutWebhookCleanupSummary, error) {
	if integration.Provider != ProviderFillout {
		return FilloutWebhookCleanupSummary{}, fmt.Errorf("fillout webhook cleanup requires a Fillout integration")
	}
	webhookID := strings.TrimSpace(settingString(integration.Settings, "fillout_webhook_id"))
	endpoint := strings.TrimSpace(settingString(integration.Settings, "fillout_webhook_endpoint"))
	if webhookID == "" {
		return FilloutWebhookCleanupSummary{
			Endpoint:    endpoint,
			CleanedUpAt: r.now(),
			Skipped:     true,
			SkipReason:  "missing_webhook_id",
		}, nil
	}
	client, baseURL, creds, userAgent, err := r.client(ctx, integration)
	if err != nil {
		return FilloutWebhookCleanupSummary{}, err
	}
	if err := r.deleteWebhook(ctx, client, baseURL, creds.AccessToken, userAgent, webhookID); err != nil {
		return FilloutWebhookCleanupSummary{}, err
	}
	return FilloutWebhookCleanupSummary{
		WebhookID:   webhookID,
		Endpoint:    endpoint,
		CleanedUpAt: r.now(),
		Deleted:     true,
	}, nil
}

func (r FilloutRESTWebhookRegistrar) client(ctx context.Context, integration Integration) (*http.Client, string, FilloutCredentials, string, error) {
	resolver := r.Credentials
	if resolver == nil {
		return nil, "", FilloutCredentials{}, "", fmt.Errorf("fillout credential resolver is not configured")
	}
	creds, err := resolver.ResolveFillout(ctx, integration.TenantID, integration)
	if err != nil {
		return nil, "", FilloutCredentials{}, "", err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return nil, "", FilloutCredentials{}, "", fmt.Errorf("fillout access token is required")
	}
	client := leadEgressClient(r.HTTPClient, ProviderFillout, 30*time.Second)
	baseURL := strings.TrimRight(firstString(r.APIBaseURL, creds.APIBaseURL, filloutRegionBaseURL(settingString(integration.Settings, "api_region")), settingString(integration.Settings, "api_base_url"), filloutDefaultAPIBaseURL), "/")
	userAgent := firstString(r.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), filloutDefaultUserAgent)
	return client, baseURL, creds, userAgent, nil
}

func (r FilloutRESTWebhookRegistrar) createWebhook(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, formID, deliveryURL string) (string, error) {
	body, _ := json.Marshal(map[string]string{
		"formId": formID,
		"url":    deliveryURL,
	})
	raw, err := filloutDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodPost, "/webhook/create", nil, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	var out struct {
		ID any `json:"id"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return "", fmt.Errorf("decode fillout webhook create response: %w", err)
	}
	id := strings.TrimSpace(fmt.Sprint(out.ID))
	if id == "" || id == "<nil>" {
		return "", fmt.Errorf("fillout webhook create response missing id")
	}
	return id, nil
}

func (r FilloutRESTWebhookRegistrar) deleteWebhook(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, webhookID string) error {
	body, _ := json.Marshal(map[string]string{"webhookId": webhookID})
	_, err := filloutDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodPost, "/webhook/delete", nil, bytes.NewReader(body))
	return err
}

func (r FilloutRESTWebhookRegistrar) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func filloutWebhookEndpoint(appBaseURL, formID string) string {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(appBaseURL), "/") + "/api/public/lead-integrations/fillout/webhooks")
	if err != nil {
		return ""
	}
	query := u.Query()
	query.Set("form_id", strings.TrimSpace(formID))
	u.RawQuery = query.Encode()
	return u.String()
}

func filloutWebhookDeliveryURL(appBaseURL, formID, token string) string {
	u, err := url.Parse(filloutWebhookEndpoint(appBaseURL, formID))
	if err != nil {
		return ""
	}
	query := u.Query()
	query.Set("token", strings.TrimSpace(token))
	u.RawQuery = query.Encode()
	return u.String()
}

func (b FilloutRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderFillout {
		return SyncRequest{}, fmt.Errorf("fillout backfill requires a Fillout integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("fillout credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("fillout form_id is required")
	}
	creds, err := b.Credentials.ResolveFillout(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("fillout access token is required")
	}
	state, err := decodeFilloutCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: filloutCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderFillout, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, filloutRegionBaseURL(settingString(integration.Settings, "api_region")), settingString(integration.Settings, "api_base_url"), filloutDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), filloutDefaultUserAgent)
	form, _ := fetchFilloutForm(ctx, client, baseURL, creds.AccessToken, userAgent, formID)
	pageSize := filloutPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	items, total, err := fetchFilloutSubmissions(ctx, client, baseURL, creds.AccessToken, userAgent, formID, integration, state.Offset, pageSize)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(items))}
	for _, item := range items {
		submission := mapFilloutSubmission(form, item, integration)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	nextOffset := state.Offset + len(items)
	if len(items) < pageSize || (total > 0 && nextOffset >= total) {
		req.Cursor = filloutCursorComplete
	} else {
		req.Cursor = encodeFilloutCursor(filloutCursorState{Offset: nextOffset})
	}
	return req, nil
}

type filloutCursorState struct {
	Offset   int  `json:"offset,omitempty"`
	Complete bool `json:"complete,omitempty"`
}

func decodeFilloutCursor(cursor string) (filloutCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return filloutCursorState{}, nil
	}
	if cursor == filloutCursorComplete {
		return filloutCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, filloutCursorPrefix) {
		return filloutCursorState{}, fmt.Errorf("invalid Fillout cursor")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(cursor, filloutCursorPrefix))
	if raw == "" {
		return filloutCursorState{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return filloutCursorState{}, fmt.Errorf("invalid Fillout cursor")
	}
	var out filloutCursorState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return filloutCursorState{}, fmt.Errorf("invalid Fillout cursor")
	}
	if out.Offset < 0 {
		out.Offset = 0
	}
	return out, nil
}

func encodeFilloutCursor(state filloutCursorState) string {
	if state.Complete {
		return filloutCursorComplete
	}
	if state.Offset < 0 {
		state.Offset = 0
	}
	raw, _ := json.Marshal(state)
	return filloutCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

type filloutForm struct {
	ID            string             `json:"id"`
	Name          string             `json:"name"`
	Questions     []filloutFieldMeta `json:"questions"`
	Calculations  []filloutFieldMeta `json:"calculations"`
	URLParameters []filloutFieldMeta `json:"urlParameters"`
	Scheduling    []filloutFieldMeta `json:"scheduling"`
	Payments      []filloutFieldMeta `json:"payments"`
	Quiz          map[string]any     `json:"quiz"`
}

type filloutFieldMeta struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type filloutSubmissionsResponse struct {
	Responses      []filloutSubmission `json:"responses"`
	TotalResponses int                 `json:"totalResponses"`
	PageCount      int                 `json:"pageCount"`
}

type filloutSubmissionEnvelope struct {
	Submission filloutSubmission   `json:"submission"`
	Responses  []filloutSubmission `json:"responses"`
}

type filloutSubmission struct {
	SubmissionID   string         `json:"submissionId"`
	SubmissionTime string         `json:"submissionTime"`
	LastUpdatedAt  string         `json:"lastUpdatedAt"`
	Questions      []filloutField `json:"questions"`
	Calculations   []filloutField `json:"calculations"`
	URLParameters  []filloutField `json:"urlParameters"`
	Scheduling     []filloutField `json:"scheduling"`
	Payments       []filloutField `json:"payments"`
	Quiz           map[string]any `json:"quiz"`
	Login          map[string]any `json:"login"`
	EditLink       string         `json:"editLink"`
	Preview        bool           `json:"preview"`
	Raw            map[string]any `json:"-"`
}

type filloutField struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value any    `json:"value"`
}

func fetchFilloutForm(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, formID string) (filloutForm, error) {
	raw, err := filloutDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, "/forms/"+url.PathEscape(formID), nil, nil)
	if err != nil {
		return filloutForm{ID: formID}, err
	}
	var out filloutForm
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return filloutForm{ID: formID}, fmt.Errorf("decode fillout form response: %w", err)
	}
	if out.ID == "" {
		out.ID = formID
	}
	return out, nil
}

func fetchFilloutSubmissions(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, formID string, integration Integration, offset, limit int) ([]filloutSubmission, int, error) {
	query := url.Values{}
	query.Set("offset", strconv.Itoa(offset))
	query.Set("limit", strconv.Itoa(filloutPageSize(limit)))
	query.Set("sort", firstString(settingString(integration.Settings, "sort"), "asc"))
	for _, key := range []string{"afterDate", "beforeDate", "status", "includeEditLink", "includePreview", "search"} {
		if value := firstString(settingString(integration.Settings, key), settingString(integration.Settings, strings.ToLower(key))); value != "" {
			query.Set(key, value)
		}
	}
	raw, err := filloutDoRaw(ctx, client, baseURL, accessToken, userAgent, http.MethodGet, "/forms/"+url.PathEscape(formID)+"/submissions", query, nil)
	if err != nil {
		return nil, 0, err
	}
	var env filloutSubmissionsResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&env); err != nil && err != io.EOF {
		return nil, 0, fmt.Errorf("decode fillout submissions response: %w", err)
	}
	for i := range env.Responses {
		var rawItem map[string]any
		_ = json.Unmarshal(rawFilloutSubmissionJSON(env.Responses[i]), &rawItem)
		env.Responses[i].Raw = nonNilMap(rawItem)
	}
	return env.Responses, env.TotalResponses, nil
}

func filloutDoRaw(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, method, path string, query url.Values, body io.Reader) ([]byte, error) {
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
	req.Header.Set("User-Agent", firstString(userAgent, filloutDefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, filloutResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("fillout REST %s failed %d: %s", path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return raw, nil
}

func mapFilloutSubmission(form filloutForm, item filloutSubmission, integration Integration) SubmissionInput {
	formID := firstString(form.ID, settingString(integration.Settings, "form_id"))
	fields := map[string]any{
		"fillout_submission_id": item.SubmissionID,
		"fillout_form_id":       formID,
		"fillout_last_updated":  item.LastUpdatedAt,
		"fillout_edit_link":     item.EditLink,
		"fillout_preview":       item.Preview,
		"fillout_provider_raw":  item.Raw,
	}
	identity := typeformIdentity{}
	applyFilloutFields(fields, &identity, "question", item.Questions)
	applyFilloutFields(fields, &identity, "calculation", item.Calculations)
	applyFilloutFields(fields, &identity, "url_parameter", item.URLParameters)
	applyFilloutFields(fields, &identity, "scheduling", item.Scheduling)
	applyFilloutFields(fields, &identity, "payment", item.Payments)
	applyFilloutStructuredIdentity(&identity, item.Login)
	if len(item.Quiz) > 0 {
		fields["fillout_quiz"] = item.Quiz
	}
	submittedAt := parseFilloutTime(firstString(item.SubmissionTime, item.LastUpdatedAt))
	return SubmissionInput{
		SourceID:    filloutSourceID(formID, item.SubmissionID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    firstString(form.Name, settingString(integration.Settings, "form_name")),
		EventName:   "lead.submitted",
		Tags:        filloutTags(integration, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func applyFilloutFields(fields map[string]any, identity *typeformIdentity, prefix string, items []filloutField) {
	for _, item := range items {
		key := firstString(item.Name, item.ID)
		if key == "" {
			continue
		}
		value := normalizeFilloutValue(item.Value)
		fields["fillout_"+prefix+"."+normalizeTypeformIdentityKey(key)] = value
		applyFilloutIdentity(identity, item, value)
	}
}

func applyFilloutIdentity(identity *typeformIdentity, item filloutField, value any) {
	if identity == nil {
		return
	}
	label := firstString(item.Name, item.ID)
	text := strings.TrimSpace(fmt.Sprint(value))
	typ := strings.ToLower(item.Type)
	if strings.Contains(typ, "email") && identity.Email == "" {
		identity.Email = text
	}
	if strings.Contains(typ, "phone") && identity.Phone == "" {
		identity.Phone = text
	}
	applyFilloutStructuredIdentity(identity, value)
	identity.apply(label, text)
}

func applyFilloutStructuredIdentity(identity *typeformIdentity, value any) {
	if identity == nil {
		return
	}
	source := anyMap(value)
	if len(source) == 0 {
		return
	}
	if identity.Email == "" {
		identity.Email = mapString(source, "email", "scheduledUserEmail")
	}
	if identity.FullName == "" {
		identity.FullName = mapString(source, "fullName", "name")
	}
	if identity.FirstName == "" {
		identity.FirstName = mapString(source, "firstName", "first")
	}
	if identity.LastName == "" {
		identity.LastName = mapString(source, "lastName", "last")
	}
	if identity.Phone == "" {
		identity.Phone = mapString(source, "phone", "phoneNumber")
	}
	if identity.Company == "" {
		identity.Company = mapString(source, "company", "organization", "organisation")
	}
}

func normalizeFilloutValue(value any) any {
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
			out = append(out, normalizeFilloutValue(item))
		}
		return out
	default:
		return typed
	}
}

func (d *Deps) FilloutWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, filloutWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Fillout webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeFilloutWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	formID := firstString(r.URL.Query().Get("form_id"), r.URL.Query().Get("formId"), mapString(payload.Raw, "form_id", "formId", "formID"))
	if formID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_form_id", "Fillout webhook form_id query parameter is required")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderFormID(r.Context(), ProviderFillout, formID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Fillout integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resolver := d.filloutCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Fillout credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveFillout(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyFilloutWebhookSecret(creds.WebhookSecret, r.URL.Query().Get("token"), r.Header.Get("X-Postwave-Webhook-Secret"), r.Header.Get("X-Fillout-Webhook-Secret"), r.Header.Get("Authorization")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	submission := mapFilloutSubmission(filloutForm{ID: formID, Name: settingString(integration.Settings, "form_name")}, payload.Submission, *integration)
	submission.Fields["fillout_webhook_raw"] = payload.Raw
	req := normalizeSyncRequest(SyncRequest{RunMode: "webhook", Submissions: []SubmissionInput{submission}, Cursor: "fillout-webhook-" + firstString(payload.Submission.SubmissionID, localFilloutWebhookID(payload.Raw))})
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

type filloutWebhookPayload struct {
	Submission filloutSubmission
	Raw        map[string]any
}

func decodeFilloutWebhookPayload(body []byte) (filloutWebhookPayload, error) {
	var direct filloutSubmission
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&direct); err != nil && err != io.EOF {
		return filloutWebhookPayload{}, fmt.Errorf("decode fillout JSON webhook: %w", err)
	}
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	if direct.SubmissionID != "" {
		direct.Raw = nonNilMap(raw)
		return filloutWebhookPayload{Submission: direct, Raw: nonNilMap(raw)}, nil
	}
	var envelope filloutSubmissionEnvelope
	dec = json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&envelope); err != nil && err != io.EOF {
		return filloutWebhookPayload{}, fmt.Errorf("decode fillout JSON webhook envelope: %w", err)
	}
	submission := envelope.Submission
	if submission.SubmissionID == "" && len(envelope.Responses) > 0 {
		submission = envelope.Responses[0]
	}
	submission.Raw = nonNilMap(raw)
	return filloutWebhookPayload{Submission: submission, Raw: nonNilMap(raw)}, nil
}

func VerifyFilloutWebhookSecret(secret string, candidates ...string) error {
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

func filloutRegionBaseURL(region string) string {
	switch strings.ToLower(strings.TrimSpace(region)) {
	case "eu", "europe":
		return filloutEUAPIBaseURL
	default:
		return ""
	}
}

func filloutPageSize(size int) int {
	if size <= 0 {
		return filloutDefaultPageSize
	}
	if size > filloutMaxPageSize {
		return filloutMaxPageSize
	}
	return size
}

func filloutSourceID(formID, id string) string {
	formID = strings.TrimSpace(formID)
	id = strings.TrimSpace(id)
	if formID == "" || id == "" || id == "<nil>" {
		return ""
	}
	return "fillout://submission/" + formID + "/" + id
}

func filloutTags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"fillout", "fillout:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func parseFilloutTime(raw string) *time.Time {
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

func rawFilloutSubmissionJSON(item filloutSubmission) []byte {
	type alias filloutSubmission
	raw, _ := json.Marshal(alias(item))
	return raw
}

func localFilloutWebhookID(raw map[string]any) string {
	body, _ := json.Marshal(raw)
	sum := sha256.Sum256(body)
	return "fillout_local_" + base64.RawURLEncoding.EncodeToString(sum[:])
}
