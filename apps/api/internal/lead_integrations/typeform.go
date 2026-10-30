// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"bytes"
	"context"
	"crypto/sha256"
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

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	typeformCursorPrefix       = "typeform:"
	typeformCursorComplete     = "typeform:complete"
	typeformDefaultAPIBaseURL  = "https://api.typeform.com"
	typeformResponseMaxBytes   = 8 << 20
	typeformDefaultPageSize    = 100
	typeformAbsolutePageSize   = 1000
	typeformDefaultWebhookTag  = "postwave"
	typeformDefaultUserAgent   = "Moosewave Typeform Integration"
	typeformWebhookMaxBodySize = 1 << 20
)

type TypeformCredentials struct {
	AccessToken         string
	WebhookSecret       string
	APIBaseURL          string
	ResponsesAPIBaseURL string
	UserAgent           string
}

type TypeformCredentialResolver interface {
	ResolveTypeform(context.Context, string, Integration) (TypeformCredentials, error)
}

type TypeformBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type TypeformRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials TypeformCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type TypeformWebhookRegistrar interface {
	ReconcileWebhook(ctx context.Context, integration Integration, appBaseURL string) (TypeformWebhookReconcileSummary, error)
	CleanupWebhook(ctx context.Context, integration Integration, appBaseURL string) (TypeformWebhookCleanupSummary, error)
}

type TypeformWebhookReconcileSummary struct {
	WebhookID    string          `json:"webhook_id"`
	Tag          string          `json:"tag"`
	Endpoint     string          `json:"endpoint"`
	EventTypes   map[string]bool `json:"event_types,omitempty"`
	RegisteredAt time.Time       `json:"registered_at"`
	Upserted     bool            `json:"upserted,omitempty"`
	Verified     bool            `json:"verified,omitempty"`
	VerifiedAt   time.Time       `json:"verified_at,omitempty"`
}

type TypeformWebhookCleanupSummary struct {
	WebhookID   string    `json:"webhook_id,omitempty"`
	Tag         string    `json:"tag"`
	Endpoint    string    `json:"endpoint,omitempty"`
	CleanedUpAt time.Time `json:"cleaned_up_at"`
	Deleted     bool      `json:"deleted,omitempty"`
	NotFound    bool      `json:"not_found,omitempty"`
}

type TypeformRESTWebhookRegistrar struct {
	HTTPClient  *http.Client
	Credentials TypeformCredentialResolver
	APIBaseURL  string
	UserAgent   string
	Now         func() time.Time
}

type TypeformRateLimitError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e TypeformRateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("typeform REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("typeform REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

type TypeformRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type TypeformSecretsCredentialResolver struct {
	Secrets TypeformRuntimeSecretResolver
}

func NewTypeformSecretsCredentialResolver(secrets TypeformRuntimeSecretResolver) *TypeformSecretsCredentialResolver {
	return &TypeformSecretsCredentialResolver{Secrets: secrets}
}

func (r *TypeformSecretsCredentialResolver) ResolveTypeform(ctx context.Context, _ string, integration Integration) (TypeformCredentials, error) {
	if r == nil || r.Secrets == nil {
		return TypeformCredentials{}, fmt.Errorf("typeform credential resolver is not configured")
	}
	ref := typeformCredentialRef(integration)
	if ref == "" {
		return TypeformCredentials{}, fmt.Errorf("typeform credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return TypeformCredentials{}, err
	}
	webhookRef := typeformWebhookSecretRef(integration)
	if webhookRef != "" && webhookRef != ref {
		webhookSecret, err := r.resolveWebhookSecret(ctx, webhookRef)
		if err != nil {
			return TypeformCredentials{}, err
		}
		creds.WebhookSecret = webhookSecret
	}
	return creds, nil
}

func (r *TypeformSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (TypeformCredentials, error) {
	var payload typeformCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return TypeformCredentials{}, fmt.Errorf("resolve typeform credentials %q: %w", ref, err)
		}
		return parseTypeformCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return TypeformCredentials{}, fmt.Errorf("resolve typeform credentials %q: %w", ref, err)
	}
	return parseTypeformCredentialSecret(raw)
}

func (r *TypeformSecretsCredentialResolver) resolveWebhookSecret(ctx context.Context, ref string) (string, error) {
	var payload typeformCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.webhookSecret()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve typeform webhook secret %q: %w", ref, err)
		}
		return parseTypeformWebhookSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve typeform webhook secret %q: %w", ref, err)
	}
	return parseTypeformWebhookSecret(raw)
}

type typeformCredentialPayload struct {
	AccessToken         string `json:"access_token"`
	APIKey              string `json:"api_key"`
	Token               string `json:"token"`
	BearerToken         string `json:"bearer_token"`
	WebhookSecret       string `json:"webhook_secret"`
	SigningSecret       string `json:"signing_secret"`
	Secret              string `json:"secret"`
	APIBaseURL          string `json:"api_base_url"`
	ResponsesAPIBaseURL string `json:"responses_api_base_url"`
	UserAgent           string `json:"user_agent"`
}

func (p typeformCredentialPayload) credentials() (TypeformCredentials, error) {
	token := normalizeTypeformBearerToken(firstString(p.AccessToken, p.APIKey, p.Token, p.BearerToken))
	if token == "" {
		return TypeformCredentials{}, fmt.Errorf("typeform access_token or api_key is required")
	}
	webhook, _ := p.webhookSecret()
	return TypeformCredentials{
		AccessToken:         token,
		WebhookSecret:       webhook,
		APIBaseURL:          strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		ResponsesAPIBaseURL: strings.TrimRight(strings.TrimSpace(p.ResponsesAPIBaseURL), "/"),
		UserAgent:           strings.TrimSpace(p.UserAgent),
	}, nil
}

func (p typeformCredentialPayload) webhookSecret() (string, error) {
	secret := strings.TrimSpace(firstString(p.WebhookSecret, p.SigningSecret, p.Secret))
	if secret == "" {
		return "", fmt.Errorf("typeform webhook secret is required")
	}
	return secret, nil
}

func parseTypeformCredentialSecret(raw string) (TypeformCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return TypeformCredentials{}, fmt.Errorf("typeform credentials are empty")
	}
	var payload typeformCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return TypeformCredentials{}, fmt.Errorf("parse typeform credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseTypeformKeyValueSecret(raw).credentials()
	}
	return typeformCredentialPayload{AccessToken: normalizeTypeformBearerToken(raw)}.credentials()
}

func parseTypeformWebhookSecret(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("typeform webhook secret is empty")
	}
	var payload typeformCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse typeform webhook secret JSON: %w", err)
		}
		return payload.webhookSecret()
	}
	if strings.Contains(raw, "=") {
		return parseTypeformKeyValueSecret(raw).webhookSecret()
	}
	return raw, nil
}

func parseTypeformKeyValueSecret(raw string) typeformCredentialPayload {
	var payload typeformCredentialPayload
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
		case "webhook_secret", "webhook_signing_secret":
			payload.WebhookSecret = value
		case "signing_secret":
			payload.SigningSecret = value
		case "secret":
			payload.Secret = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "responses_api_base_url":
			payload.ResponsesAPIBaseURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func normalizeTypeformBearerToken(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(raw), "bearer ") {
		return strings.TrimSpace(raw[len("bearer "):])
	}
	return raw
}

func typeformCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func typeformWebhookSecretRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signing_secret_ref"),
		settingString(integration.Settings, "signing_secret_ref"),
		typeformCredentialRef(integration),
	))
}

func (r TypeformRESTWebhookRegistrar) ReconcileWebhook(ctx context.Context, integration Integration, appBaseURL string) (TypeformWebhookReconcileSummary, error) {
	if integration.Provider != ProviderTypeform {
		return TypeformWebhookReconcileSummary{}, fmt.Errorf("typeform webhook registration requires a Typeform integration")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return TypeformWebhookReconcileSummary{}, fmt.Errorf("typeform form_id is required")
	}
	appBaseURL = strings.TrimRight(strings.TrimSpace(appBaseURL), "/")
	if appBaseURL == "" {
		return TypeformWebhookReconcileSummary{}, fmt.Errorf("public base URL is required for Typeform webhook registration")
	}
	client, baseURL, creds, userAgent, err := r.client(ctx, integration)
	if err != nil {
		return TypeformWebhookReconcileSummary{}, err
	}
	if strings.TrimSpace(creds.WebhookSecret) == "" {
		return TypeformWebhookReconcileSummary{}, fmt.Errorf("typeform webhook secret is required for managed webhook registration")
	}
	tag := typeformWebhookTag(integration)
	endpoint := typeformWebhookEndpoint(appBaseURL)
	eventTypes := typeformWebhookEventTypes(integration)
	hook, err := r.upsertWebhook(ctx, client, baseURL, creds.AccessToken, userAgent, formID, tag, endpoint, creds.WebhookSecret, eventTypes, typeformWebhookVerifySSL(integration))
	if err != nil {
		return TypeformWebhookReconcileSummary{}, err
	}
	verified, err := r.retrieveWebhook(ctx, client, baseURL, creds.AccessToken, userAgent, formID, tag)
	if err != nil {
		return TypeformWebhookReconcileSummary{}, err
	}
	if err := validateTypeformWebhookRegistration(verified, formID, tag, endpoint, eventTypes); err != nil {
		return TypeformWebhookReconcileSummary{}, err
	}
	now := r.now()
	return TypeformWebhookReconcileSummary{
		WebhookID:    firstString(verified.ID, hook.ID, settingString(integration.Settings, "typeform_webhook_id")),
		Tag:          firstString(verified.Tag, hook.Tag, tag),
		Endpoint:     firstString(verified.URL, hook.URL, endpoint),
		EventTypes:   eventTypes,
		RegisteredAt: now,
		Upserted:     true,
		Verified:     true,
		VerifiedAt:   now,
	}, nil
}

func (r TypeformRESTWebhookRegistrar) CleanupWebhook(ctx context.Context, integration Integration, appBaseURL string) (TypeformWebhookCleanupSummary, error) {
	if integration.Provider != ProviderTypeform {
		return TypeformWebhookCleanupSummary{}, fmt.Errorf("typeform webhook cleanup requires a Typeform integration")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return TypeformWebhookCleanupSummary{}, fmt.Errorf("typeform form_id is required")
	}
	tag := typeformWebhookTag(integration)
	client, baseURL, creds, userAgent, err := r.client(ctx, integration)
	if err != nil {
		return TypeformWebhookCleanupSummary{}, err
	}
	status, err := r.deleteWebhook(ctx, client, baseURL, creds.AccessToken, userAgent, formID, tag)
	if err != nil {
		return TypeformWebhookCleanupSummary{}, err
	}
	return TypeformWebhookCleanupSummary{
		WebhookID:   settingString(integration.Settings, "typeform_webhook_id"),
		Tag:         tag,
		Endpoint:    settingString(integration.Settings, "typeform_webhook_endpoint"),
		CleanedUpAt: r.now(),
		Deleted:     status == http.StatusNoContent,
		NotFound:    status == http.StatusNotFound,
	}, nil
}

func (r TypeformRESTWebhookRegistrar) client(ctx context.Context, integration Integration) (*http.Client, string, TypeformCredentials, string, error) {
	resolver := r.Credentials
	if resolver == nil {
		return nil, "", TypeformCredentials{}, "", fmt.Errorf("typeform credential resolver is not configured")
	}
	creds, err := resolver.ResolveTypeform(ctx, integration.TenantID, integration)
	if err != nil {
		return nil, "", TypeformCredentials{}, "", err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return nil, "", TypeformCredentials{}, "", fmt.Errorf("typeform access token is required")
	}
	client := leadEgressClient(r.HTTPClient, ProviderTypeform, 30*time.Second)
	baseURL := strings.TrimRight(firstString(r.APIBaseURL, creds.APIBaseURL, typeformRegionBaseURL(settingString(integration.Settings, "api_region")), typeformDefaultAPIBaseURL), "/")
	userAgent := firstString(r.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), typeformDefaultUserAgent)
	return client, baseURL, creds, userAgent, nil
}

type typeformWebhookResponse struct {
	ID         string          `json:"id"`
	Tag        string          `json:"tag"`
	FormID     string          `json:"form_id"`
	URL        string          `json:"url"`
	Enabled    bool            `json:"enabled"`
	EventTypes map[string]bool `json:"event_types"`
	VerifySSL  bool            `json:"verify_ssl"`
	CreatedAt  string          `json:"created_at"`
	UpdatedAt  string          `json:"updated_at"`
}

func (r TypeformRESTWebhookRegistrar) upsertWebhook(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, formID, tag, endpoint, secret string, eventTypes map[string]bool, verifySSL bool) (typeformWebhookResponse, error) {
	body, _ := json.Marshal(map[string]any{
		"enabled":     true,
		"event_types": eventTypes,
		"secret":      secret,
		"url":         endpoint,
		"verify_ssl":  verifySSL,
	})
	rawURL := strings.TrimRight(baseURL, "/") + "/forms/" + url.PathEscape(formID) + "/webhooks/" + url.PathEscape(tag)
	raw, err := typeformDoRawBody(ctx, client, http.MethodPut, rawURL, accessToken, userAgent, bytes.NewReader(body))
	if err != nil {
		return typeformWebhookResponse{}, err
	}
	return decodeTypeformWebhookResponse(raw)
}

func (r TypeformRESTWebhookRegistrar) retrieveWebhook(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, formID, tag string) (typeformWebhookResponse, error) {
	rawURL := strings.TrimRight(baseURL, "/") + "/forms/" + url.PathEscape(formID) + "/webhooks/" + url.PathEscape(tag)
	raw, err := typeformDoRawBody(ctx, client, http.MethodGet, rawURL, accessToken, userAgent, nil)
	if err != nil {
		return typeformWebhookResponse{}, err
	}
	return decodeTypeformWebhookResponse(raw)
}

func decodeTypeformWebhookResponse(raw []byte) (typeformWebhookResponse, error) {
	var out typeformWebhookResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return typeformWebhookResponse{}, fmt.Errorf("decode typeform webhook response: %w", err)
	}
	return out, nil
}

func validateTypeformWebhookRegistration(hook typeformWebhookResponse, formID, tag, endpoint string, eventTypes map[string]bool) error {
	if hook.ID == "" {
		return fmt.Errorf("verify typeform webhook %q: missing webhook id", tag)
	}
	if hook.Tag != "" && hook.Tag != tag {
		return fmt.Errorf("verify typeform webhook %q: provider returned tag %q", tag, hook.Tag)
	}
	if hook.FormID != "" && hook.FormID != formID {
		return fmt.Errorf("verify typeform webhook %q: provider returned form_id %q", tag, hook.FormID)
	}
	if hook.URL != "" && hook.URL != endpoint {
		return fmt.Errorf("verify typeform webhook %q: provider returned url %q", tag, hook.URL)
	}
	for eventType, enabled := range eventTypes {
		if !enabled {
			continue
		}
		if hook.EventTypes == nil || !hook.EventTypes[eventType] {
			return fmt.Errorf("verify typeform webhook %q: missing event type %q", tag, eventType)
		}
	}
	return nil
}

func (r TypeformRESTWebhookRegistrar) deleteWebhook(ctx context.Context, client *http.Client, baseURL, accessToken, userAgent, formID, tag string) (int, error) {
	rawURL := strings.TrimRight(baseURL, "/") + "/forms/" + url.PathEscape(formID) + "/webhooks/" + url.PathEscape(tag)
	status, _, err := typeformDoRawBodyStatus(ctx, client, http.MethodDelete, rawURL, accessToken, userAgent, nil)
	if err != nil {
		return status, err
	}
	return status, nil
}

func (r TypeformRESTWebhookRegistrar) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func typeformWebhookTag(integration Integration) string {
	tag := firstString(
		settingString(integration.Settings, "typeform_webhook_tag"),
		settingString(integration.Settings, "webhook_tag"),
		typeformDefaultWebhookTag,
	)
	return strings.TrimSpace(tag)
}

func typeformWebhookEndpoint(appBaseURL string) string {
	return strings.TrimRight(strings.TrimSpace(appBaseURL), "/") + "/api/public/lead-integrations/typeform/webhooks"
}

func typeformWebhookEventTypes(integration Integration) map[string]bool {
	out := map[string]bool{"form_response": true}
	if strings.EqualFold(settingString(integration.Settings, "response_type"), "partial") ||
		strings.EqualFold(settingString(integration.Settings, "include_partial_responses"), "true") {
		out["form_response_partial"] = true
	}
	return out
}

func typeformWebhookVerifySSL(integration Integration) bool {
	raw := strings.ToLower(strings.TrimSpace(settingString(integration.Settings, "verify_ssl")))
	if raw == "false" || raw == "0" || raw == "no" {
		return false
	}
	return true
}

func (b TypeformRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderTypeform {
		return SyncRequest{}, fmt.Errorf("typeform backfill requires a Typeform integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("typeform credential resolver is not configured")
	}
	formID := strings.TrimSpace(settingString(integration.Settings, "form_id"))
	if formID == "" {
		return SyncRequest{}, fmt.Errorf("typeform form_id is required")
	}
	creds, err := b.Credentials.ResolveTypeform(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, fmt.Errorf("typeform access token is required")
	}
	state, err := decodeTypeformCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: typeformCursorComplete}, nil
	}
	client := leadEgressClient(b.HTTPClient, ProviderTypeform, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, typeformRegionBaseURL(settingString(integration.Settings, "api_region")), typeformDefaultAPIBaseURL), "/")
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), typeformDefaultUserAgent)
	form, err := fetchTypeformForm(ctx, client, baseURL, creds.AccessToken, userAgent, formID)
	if err != nil {
		return SyncRequest{}, err
	}
	pageURL := typeformResponsesURL(form, creds, integration, baseURL, formID)
	page, err := fetchTypeformResponses(ctx, client, pageURL, creds.AccessToken, userAgent, state.After, typeformPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size"))), settingString(integration.Settings, "response_type"))
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: make([]SubmissionInput, 0, len(page.Items))}
	for _, item := range page.Items {
		submission := mapTypeformResponse(form, item, integration)
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	req.Cursor = nextTypeformCursor(page, state.After)
	return req, nil
}

type typeformCursorState struct {
	After    string
	Complete bool
}

func decodeTypeformCursor(cursor string) (typeformCursorState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return typeformCursorState{}, nil
	}
	if cursor == typeformCursorComplete {
		return typeformCursorState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, typeformCursorPrefix) {
		return typeformCursorState{}, fmt.Errorf("invalid Typeform cursor")
	}
	after := strings.TrimSpace(strings.TrimPrefix(cursor, typeformCursorPrefix))
	if after == "" {
		return typeformCursorState{}, nil
	}
	if decoded, err := base64.RawURLEncoding.DecodeString(after); err == nil {
		after = string(decoded)
	}
	return typeformCursorState{After: after}, nil
}

func encodeTypeformCursor(after string) string {
	after = strings.TrimSpace(after)
	if after == "" {
		return typeformCursorComplete
	}
	return typeformCursorPrefix + base64.RawURLEncoding.EncodeToString([]byte(after))
}

func nextTypeformCursor(page typeformResponsesPage, previousAfter string) string {
	if len(page.Items) == 0 {
		if strings.TrimSpace(previousAfter) != "" {
			return encodeTypeformCursor(previousAfter)
		}
		return typeformCursorComplete
	}
	last := strings.TrimSpace(page.Items[len(page.Items)-1].Token)
	if last == "" {
		last = strings.TrimSpace(page.Items[len(page.Items)-1].ResponseID)
	}
	if last == "" {
		return typeformCursorComplete
	}
	return encodeTypeformCursor(last)
}

type typeformForm struct {
	ID     string            `json:"id"`
	Title  string            `json:"title"`
	Fields []typeformField   `json:"fields"`
	Hidden []string          `json:"hidden"`
	Links  map[string]string `json:"_links"`
}

type typeformField struct {
	ID    string `json:"id"`
	Ref   string `json:"ref"`
	Title string `json:"title"`
	Type  string `json:"type"`
}

type typeformResponsesPage struct {
	Items      []typeformResponseItem `json:"items"`
	PageCount  int                    `json:"page_count"`
	TotalItems int                    `json:"total_items"`
}

type typeformResponseItem struct {
	LandingID   string           `json:"landing_id"`
	Token       string           `json:"token"`
	ResponseID  string           `json:"response_id"`
	SubmittedAt string           `json:"submitted_at"`
	LandedAt    string           `json:"landed_at"`
	Answers     []typeformAnswer `json:"answers"`
	Hidden      map[string]any   `json:"hidden"`
	Metadata    map[string]any   `json:"metadata"`
	Calculated  map[string]any   `json:"calculated"`
	Variables   []map[string]any `json:"variables"`
}

type typeformAnswer struct {
	Field       typeformAnswerField   `json:"field"`
	Type        string                `json:"type"`
	Text        string                `json:"text"`
	Email       string                `json:"email"`
	PhoneNumber string                `json:"phone_number"`
	URL         string                `json:"url"`
	FileURL     string                `json:"file_url"`
	Date        string                `json:"date"`
	Number      json.Number           `json:"number"`
	Boolean     *bool                 `json:"boolean"`
	Choice      typeformChoiceAnswer  `json:"choice"`
	Choices     typeformChoicesAnswer `json:"choices"`
	Payment     map[string]any        `json:"payment"`
}

type typeformAnswerField struct {
	ID   string `json:"id"`
	Ref  string `json:"ref"`
	Type string `json:"type"`
}

type typeformChoiceAnswer struct {
	Label string `json:"label"`
	Other string `json:"other"`
}

type typeformChoicesAnswer struct {
	Labels []string `json:"labels"`
	Other  string   `json:"other"`
}

func fetchTypeformForm(ctx context.Context, client *http.Client, baseURL, token, userAgent, formID string) (typeformForm, error) {
	rawURL := strings.TrimRight(baseURL, "/") + "/forms/" + url.PathEscape(formID)
	raw, err := typeformDoRaw(ctx, client, http.MethodGet, rawURL, token, userAgent)
	if err != nil {
		return typeformForm{}, err
	}
	var out typeformForm
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return typeformForm{}, fmt.Errorf("decode typeform form response: %w", err)
	}
	if out.ID == "" {
		out.ID = formID
	}
	return out, nil
}

func fetchTypeformResponses(ctx context.Context, client *http.Client, rawURL, token, userAgent, after string, pageSize int, responseType string) (typeformResponsesPage, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return typeformResponsesPage{}, err
	}
	query := u.Query()
	query.Set("page_size", strconv.Itoa(typeformPageSize(pageSize)))
	responseType = strings.TrimSpace(responseType)
	if responseType == "" {
		responseType = "completed"
	}
	query.Set("response_type", responseType)
	if after = strings.TrimSpace(after); after != "" {
		query.Set("after", after)
	}
	u.RawQuery = query.Encode()
	raw, err := typeformDoRaw(ctx, client, http.MethodGet, u.String(), token, userAgent)
	if err != nil {
		return typeformResponsesPage{}, err
	}
	var out typeformResponsesPage
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return typeformResponsesPage{}, fmt.Errorf("decode typeform responses response: %w", err)
	}
	return out, nil
}

func typeformDoRaw(ctx context.Context, client *http.Client, method, rawURL, token, userAgent string) ([]byte, error) {
	return typeformDoRawBody(ctx, client, method, rawURL, token, userAgent, nil)
}

func typeformDoRawBody(ctx context.Context, client *http.Client, method, rawURL, token, userAgent string, body io.Reader) ([]byte, error) {
	_, raw, err := typeformDoRawBodyStatus(ctx, client, method, rawURL, token, userAgent, body)
	return raw, err
}

func typeformDoRawBodyStatus(ctx context.Context, client *http.Client, method, rawURL, token, userAgent string, body io.Reader) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, typeformDefaultUserAgent))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, typeformResponseMaxBytes)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	if resp.StatusCode == http.StatusNotFound && method == http.MethodDelete {
		return resp.StatusCode, raw, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return resp.StatusCode, nil, TypeformRateLimitError{Path: req.URL.Path, StatusCode: resp.StatusCode, RetryAfter: typeformRetryAfter(resp.Header), Snippet: responseTypeformSnippet(raw)}
		}
		return resp.StatusCode, nil, fmt.Errorf("typeform REST %s failed %d: %s", req.URL.Path, resp.StatusCode, responseTypeformSnippet(raw))
	}
	return resp.StatusCode, raw, nil
}

func typeformRetryAfter(headers http.Header) time.Duration {
	if raw := strings.TrimSpace(headers.Get("Retry-After")); raw != "" {
		if seconds, err := strconv.Atoi(raw); err == nil && seconds > 0 {
			return time.Duration(seconds) * time.Second
		}
		if at, err := http.ParseTime(raw); err == nil {
			wait := time.Until(at)
			if wait > 0 {
				return wait
			}
		}
	}
	return 0
}

func responseTypeformSnippet(raw []byte) string {
	value := strings.TrimSpace(string(raw))
	if len(value) > 500 {
		return value[:500]
	}
	return value
}

func typeformResponsesURL(form typeformForm, creds TypeformCredentials, integration Integration, baseURL, formID string) string {
	if raw := strings.TrimSpace(form.Links["responses"]); raw != "" {
		return raw
	}
	if raw := strings.TrimSpace(firstString(creds.ResponsesAPIBaseURL, typeformRegionBaseURL(settingString(integration.Settings, "responses_api_region")))); raw != "" {
		return strings.TrimRight(raw, "/") + "/forms/" + url.PathEscape(formID) + "/responses"
	}
	return strings.TrimRight(baseURL, "/") + "/forms/" + url.PathEscape(formID) + "/responses"
}

func typeformRegionBaseURL(region string) string {
	switch strings.ToLower(strings.TrimSpace(region)) {
	case "eu", "europe":
		return "https://api.eu.typeform.com"
	case "us", "default", "":
		return ""
	default:
		return ""
	}
}

func typeformPageSize(size int) int {
	if size <= 0 {
		return typeformDefaultPageSize
	}
	if size > typeformAbsolutePageSize {
		return typeformAbsolutePageSize
	}
	return size
}

func mapTypeformResponse(form typeformForm, item typeformResponseItem, integration Integration) SubmissionInput {
	formID := firstString(form.ID, settingString(integration.Settings, "form_id"))
	token := firstString(item.Token, item.ResponseID, item.LandingID)
	fields := map[string]any{
		"typeform_token":       token,
		"typeform_landing_id":  item.LandingID,
		"typeform_response_id": item.ResponseID,
		"typeform_form_id":     formID,
	}
	if len(item.Metadata) > 0 {
		fields["typeform_metadata"] = item.Metadata
	}
	if len(item.Calculated) > 0 {
		fields["typeform_calculated"] = item.Calculated
	}
	if len(item.Variables) > 0 {
		fields["typeform_variables"] = item.Variables
	}
	identity := typeformIdentity{}
	for key, value := range item.Hidden {
		trimmed := strings.TrimSpace(key)
		if trimmed == "" {
			continue
		}
		fields["hidden."+trimmed] = value
		identity.apply(trimmed, fmt.Sprint(value))
	}
	fieldLookup := typeformFieldLookup(form)
	for idx, answer := range item.Answers {
		key, label := typeformAnswerKey(answer, fieldLookup, idx)
		value := typeformAnswerValue(answer)
		if key != "" {
			fields[key] = value
		}
		identity.applyFromAnswer(label, answer, value)
	}
	submittedAt := parseTypeformTime(firstString(item.SubmittedAt, item.LandedAt))
	return SubmissionInput{
		SourceID:    typeformSourceID("response", formID, token),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    firstString(form.Title, settingString(integration.Settings, "form_name")),
		EventName:   "lead.submitted",
		Tags:        typeformTags(integration, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

type typeformIdentity struct {
	Email     string
	FirstName string
	LastName  string
	FullName  string
	Phone     string
	Company   string
}

func (i *typeformIdentity) applyFromAnswer(label string, answer typeformAnswer, value any) {
	answerType := strings.ToLower(firstString(answer.Type, answer.Field.Type))
	text := strings.TrimSpace(fmt.Sprint(value))
	switch answerType {
	case "email":
		if i.Email == "" {
			i.Email = firstString(answer.Email, text)
		}
	case "phone_number", "phone":
		if i.Phone == "" {
			i.Phone = firstString(answer.PhoneNumber, text)
		}
	}
	i.apply(label, text)
}

func (i *typeformIdentity) apply(label, value string) {
	key := normalizeTypeformIdentityKey(label)
	value = strings.TrimSpace(value)
	if value == "" || value == "<nil>" {
		return
	}
	switch {
	case key == "email" || strings.Contains(key, "email"):
		if i.Email == "" {
			i.Email = value
		}
	case key == "firstname" || key == "first_name" || strings.Contains(key, "givenname"):
		if i.FirstName == "" {
			i.FirstName = value
		}
	case key == "lastname" || key == "last_name" || strings.Contains(key, "surname") || strings.Contains(key, "familyname"):
		if i.LastName == "" {
			i.LastName = value
		}
	case key == "name" || key == "fullname" || key == "full_name" || strings.Contains(key, "yourname"):
		if i.FullName == "" {
			i.FullName = value
		}
	case key == "phone" || strings.Contains(key, "phone") || strings.Contains(key, "mobile"):
		if i.Phone == "" {
			i.Phone = value
		}
	case key == "company" || strings.Contains(key, "company") || strings.Contains(key, "organization") || strings.Contains(key, "organisation"):
		if i.Company == "" {
			i.Company = value
		}
	}
	if i.FullName == "" && i.FirstName != "" && i.LastName != "" {
		i.FullName = strings.TrimSpace(i.FirstName + " " + i.LastName)
	}
}

func normalizeTypeformIdentityKey(key string) string {
	key = strings.ToLower(strings.TrimSpace(key))
	replacer := strings.NewReplacer(" ", "", "-", "_", ".", "_")
	return replacer.Replace(key)
}

func typeformAnswerKey(answer typeformAnswer, fields map[string]typeformField, idx int) (string, string) {
	for _, candidate := range []string{answer.Field.Ref, answer.Field.ID} {
		if field, ok := fields[strings.ToLower(strings.TrimSpace(candidate))]; ok {
			return firstString(field.Ref, field.ID, fmt.Sprintf("answer_%d", idx+1)), firstString(field.Title, field.Ref, field.ID)
		}
	}
	return firstString(answer.Field.Ref, answer.Field.ID, fmt.Sprintf("answer_%d", idx+1)), firstString(answer.Field.Ref, answer.Field.ID)
}

func typeformAnswerValue(answer typeformAnswer) any {
	switch strings.ToLower(firstString(answer.Type, answer.Field.Type)) {
	case "email":
		return strings.TrimSpace(answer.Email)
	case "phone_number", "phone":
		return strings.TrimSpace(answer.PhoneNumber)
	case "text", "short_text", "long_text":
		return strings.TrimSpace(answer.Text)
	case "url", "website":
		return strings.TrimSpace(answer.URL)
	case "file_url", "file_upload":
		return strings.TrimSpace(answer.FileURL)
	case "date":
		return strings.TrimSpace(answer.Date)
	case "number", "rating", "opinion_scale":
		if answer.Number.String() != "" {
			if n, err := answer.Number.Float64(); err == nil {
				return n
			}
			return answer.Number.String()
		}
	case "boolean", "yes_no", "legal":
		if answer.Boolean != nil {
			return *answer.Boolean
		}
	case "choice", "multiple_choice", "picture_choice", "dropdown":
		return firstString(answer.Choice.Label, answer.Choice.Other)
	case "choices":
		values := append([]string(nil), answer.Choices.Labels...)
		if answer.Choices.Other != "" {
			values = append(values, answer.Choices.Other)
		}
		return values
	case "payment":
		return nonNilMap(answer.Payment)
	}
	return firstString(answer.Text, answer.Email, answer.PhoneNumber, answer.URL, answer.FileURL, answer.Date)
}

func typeformFieldLookup(form typeformForm) map[string]typeformField {
	out := map[string]typeformField{}
	for _, field := range form.Fields {
		if key := strings.ToLower(strings.TrimSpace(field.ID)); key != "" {
			out[key] = field
		}
		if key := strings.ToLower(strings.TrimSpace(field.Ref)); key != "" {
			out[key] = field
		}
	}
	return out
}

func typeformTags(integration Integration, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"typeform", "typeform:" + formID} {
		if !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func splitTypeformTags(raw string) []string {
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		if tag := strings.TrimSpace(part); tag != "" && !containsFold(out, tag) {
			out = append(out, tag)
		}
	}
	return out
}

func typeformSourceID(kind, formID, id string) string {
	id = strings.TrimSpace(id)
	formID = strings.TrimSpace(formID)
	if id == "" || formID == "" || id == "<nil>" {
		return ""
	}
	return "typeform://" + strings.TrimSpace(kind) + "/" + formID + "/" + id
}

func parseTypeformTime(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		utc := t.UTC()
		return &utc
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		utc := t.UTC()
		return &utc
	}
	return nil
}

type typeformWebhookPayload struct {
	EventID      string              `json:"event_id"`
	EventType    string              `json:"event_type"`
	FormResponse typeformWebhookForm `json:"form_response"`
	Raw          map[string]any      `json:"-"`
}

type typeformWebhookForm struct {
	FormID      string           `json:"form_id"`
	Token       string           `json:"token"`
	ResponseID  string           `json:"response_id"`
	LandedAt    string           `json:"landed_at"`
	SubmittedAt string           `json:"submitted_at"`
	Definition  typeformForm     `json:"definition"`
	Answers     []typeformAnswer `json:"answers"`
	Hidden      map[string]any   `json:"hidden"`
	Metadata    map[string]any   `json:"metadata"`
	Calculated  map[string]any   `json:"calculated"`
	Variables   []map[string]any `json:"variables"`
}

func MountPublicRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Post("/api/public/lead-integrations/typeform/webhooks", d.TypeformWebhook)
	r.Post("/api/public/lead-integrations/wix/webhooks", d.WixWebhook)
	r.Post("/api/public/lead-integrations/jotform/webhooks", d.JotformWebhook)
	r.Post("/api/public/lead-integrations/webflow/webhooks", d.WebflowWebhook)
	r.Post("/api/public/lead-integrations/fillout/webhooks", d.FilloutWebhook)
	r.Get("/api/public/lead-integrations/carrd/webhooks", d.CarrdWebhook)
	r.Post("/api/public/lead-integrations/carrd/webhooks", d.CarrdWebhook)
	r.Post("/api/public/lead-integrations/optinmonster/webhooks", d.OptinMonsterWebhook)
	r.Post("/api/public/lead-integrations/privy/webhooks", d.PrivyWebhook)
	r.Post("/api/public/lead-integrations/convertflow/webhooks", d.ConvertFlowWebhook)
	r.Get("/api/public/lead-integrations/sleeknote/webhooks", d.SleeknoteWebhook)
	r.Post("/api/public/lead-integrations/sleeknote/webhooks", d.SleeknoteWebhook)
	r.Post("/api/public/lead-integrations/wisepops/webhooks", d.WisepopsWebhook)
	r.Get("/api/public/lead-integrations/poptin/webhooks", d.PoptinWebhook)
	r.Post("/api/public/lead-integrations/poptin/webhooks", d.PoptinWebhook)
	r.Get("/api/public/lead-integrations/hello-bar/webhooks", d.HelloBarWebhook)
	r.Post("/api/public/lead-integrations/hello-bar/webhooks", d.HelloBarWebhook)
	r.Get("/api/public/lead-integrations/landingi/webhooks", d.LandingiWebhook)
	r.Post("/api/public/lead-integrations/landingi/webhooks", d.LandingiWebhook)
	r.Get("/api/public/lead-integrations/kickofflabs/webhooks", d.KickoffLabsWebhook)
	r.Post("/api/public/lead-integrations/kickofflabs/webhooks", d.KickoffLabsWebhook)
	r.Get("/api/public/lead-integrations/ninja-forms/webhooks", d.NinjaFormsWebhook)
	r.Post("/api/public/lead-integrations/ninja-forms/webhooks", d.NinjaFormsWebhook)
	r.Post("/api/public/lead-integrations/outgrow/webhooks", d.OutgrowWebhook)
	r.Post("/api/public/lead-integrations/shortstack/webhooks", d.ShortStackWebhook)
	r.Post("/api/public/lead-integrations/riddle/webhooks", d.RiddleWebhook)
	r.Get("/api/public/lead-integrations/facebook-lead-ads/webhooks", d.FacebookLeadAdsWebhookChallenge)
	r.Post("/api/public/lead-integrations/facebook-lead-ads/webhooks", d.FacebookLeadAdsWebhook)
}

func (d *Deps) TypeformWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, typeformWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Typeform webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeTypeformWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	formID := strings.TrimSpace(payload.FormResponse.FormID)
	if formID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_form_id", "Typeform webhook form_response.form_id is required")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderFormID(r.Context(), ProviderTypeform, formID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Typeform integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resolver := d.typeformCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Typeform credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveTypeform(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyTypeformWebhookSignature(creds.WebhookSecret, body, r.Header.Get("Typeform-Signature")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	webhookID := typeformWebhookID(payload)
	topic := typeformWebhookTopic(payload)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderTypeform, webhookID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		w.WriteHeader(http.StatusOK)
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "webhook is already being processed")
		return
	}
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{mapTypeformWebhookSubmission(payload, *integration)},
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderTypeform, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "typeform webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderTypeform, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderTypeform, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func decodeTypeformWebhookPayload(body []byte) (typeformWebhookPayload, error) {
	var out typeformWebhookPayload
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return typeformWebhookPayload{}, fmt.Errorf("decode typeform webhook body: %w", err)
	}
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	out.Raw = nonNilMap(raw)
	if out.FormResponse.Definition.ID == "" {
		out.FormResponse.Definition.ID = out.FormResponse.FormID
	}
	if strings.TrimSpace(out.EventID) == "" {
		out.EventID = fallbackTypeformWebhookID(out, body)
	}
	return out, nil
}

func mapTypeformWebhookSubmission(payload typeformWebhookPayload, integration Integration) SubmissionInput {
	form := payload.FormResponse.Definition
	if form.ID == "" {
		form.ID = payload.FormResponse.FormID
	}
	item := typeformResponseItem{
		Token:       firstString(payload.FormResponse.Token, payload.FormResponse.ResponseID, payload.EventID),
		ResponseID:  payload.FormResponse.ResponseID,
		SubmittedAt: payload.FormResponse.SubmittedAt,
		LandedAt:    payload.FormResponse.LandedAt,
		Answers:     payload.FormResponse.Answers,
		Hidden:      payload.FormResponse.Hidden,
		Metadata:    payload.FormResponse.Metadata,
		Calculated:  payload.FormResponse.Calculated,
		Variables:   payload.FormResponse.Variables,
	}
	submission := mapTypeformResponse(form, item, integration)
	if submission.SourceID == "" {
		submission.SourceID = typeformSourceID("response", payload.FormResponse.FormID, payload.EventID)
	}
	submission.Fields["typeform_event_id"] = payload.EventID
	submission.Fields["typeform_event_type"] = payload.EventType
	submission.Fields["typeform_provider_raw"] = payload.Raw
	return submission
}

func typeformWebhookID(payload typeformWebhookPayload) string {
	formID := strings.TrimSpace(firstString(payload.FormResponse.FormID, payload.FormResponse.Definition.ID))
	deliveryID := strings.TrimSpace(firstString(payload.EventID, payload.FormResponse.ResponseID, payload.FormResponse.Token))
	if formID == "" {
		return deliveryID
	}
	return "form:" + formID + ":delivery:" + deliveryID
}

func typeformWebhookTopic(payload typeformWebhookPayload) string {
	return firstString(strings.TrimSpace(payload.EventType), "form_response")
}

func localTypeformWebhookID(body []byte) string {
	sum := sha256.Sum256(body)
	return "typeform_local_" + base64.RawURLEncoding.EncodeToString(sum[:])
}

func fallbackTypeformWebhookID(payload typeformWebhookPayload, body []byte) string {
	eventType := strings.TrimSpace(payload.EventType)
	if strings.EqualFold(eventType, "form_response") {
		formID := strings.TrimSpace(firstString(payload.FormResponse.FormID, payload.FormResponse.Definition.ID))
		responseID := strings.TrimSpace(firstString(payload.FormResponse.ResponseID, payload.FormResponse.Token))
		if formID != "" && responseID != "" {
			stable := strings.Join([]string{"typeform", "form_response", formID, responseID}, "\x1f")
			sum := sha256.Sum256([]byte(stable))
			return "typeform_stable_" + base64.RawURLEncoding.EncodeToString(sum[:])
		}
	}
	return localTypeformWebhookID(body)
}

func intSetting(settings map[string]any, key string) int {
	raw := settingString(settings, key)
	if raw == "" {
		return 0
	}
	out, err := strconv.Atoi(raw)
	if err != nil {
		return 0
	}
	return out
}

func firstNonZero(values ...int) int {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}
