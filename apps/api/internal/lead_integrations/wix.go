// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
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
	wixCursorPrefix          = "wix:"
	wixRetryCursorPrefix     = "wix_retry:"
	wixCursorComplete        = "wix:complete"
	wixDefaultAPIBaseURL     = "https://www.wixapis.com"
	wixDefaultFormsNamespace = "wix.form_app.form"
	wixResponseMaxBytes      = 8 << 20
	wixDefaultPageSize       = 100
	wixMaxPageSize           = 100
	wixRetryInitialDelay     = 15 * time.Minute
	wixRetryMaxDelay         = 6 * time.Hour
	wixDefaultUserAgent      = "Moosewave Wix Integration"
	wixWebhookMaxBodySize    = 1 << 20
)

var wixBackfillObjectOrder = []string{"submissions", "contacts"}

type WixCredentials struct {
	AccessToken      string
	ClientID         string
	ClientSecret     string
	InstanceID       string
	WebhookSecret    string
	WebhookPublicKey string
	APIBaseURL       string
	TokenURL         string
	UserAgent        string
	AppID            string
}

type WixCredentialResolver interface {
	ResolveWix(context.Context, string, Integration) (WixCredentials, error)
}

type WixBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type WixRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials WixCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type WixRateLimitError struct {
	Path       string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e WixRateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("wix REST %s failed %d; retry after %s: %s", e.Path, e.StatusCode, e.RetryAfter.String(), e.Snippet)
	}
	return fmt.Sprintf("wix REST %s failed %d: %s", e.Path, e.StatusCode, e.Snippet)
}

type WixRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type WixSecretsCredentialResolver struct {
	Secrets WixRuntimeSecretResolver
}

func NewWixSecretsCredentialResolver(secrets WixRuntimeSecretResolver) *WixSecretsCredentialResolver {
	return &WixSecretsCredentialResolver{Secrets: secrets}
}

func (r *WixSecretsCredentialResolver) ResolveWix(ctx context.Context, _ string, integration Integration) (WixCredentials, error) {
	if r == nil || r.Secrets == nil {
		return WixCredentials{}, fmt.Errorf("wix credential resolver is not configured")
	}
	ref := wixCredentialRef(integration)
	if ref == "" {
		return WixCredentials{}, fmt.Errorf("wix credentials_ref is required")
	}
	creds, err := r.resolveCredentialSecret(ctx, ref)
	if err != nil {
		return WixCredentials{}, err
	}
	if webhookRef := wixWebhookSecretRef(integration); webhookRef != "" && webhookRef != ref {
		secret, err := r.resolveWebhookSecret(ctx, webhookRef)
		if err != nil {
			return WixCredentials{}, err
		}
		creds.WebhookSecret = secret
	}
	if publicKeyRef := wixWebhookPublicKeyRef(integration); publicKeyRef != "" && publicKeyRef != ref {
		publicKey, err := r.resolveWebhookPublicKey(ctx, publicKeyRef)
		if err != nil {
			return WixCredentials{}, err
		}
		creds.WebhookPublicKey = publicKey
	}
	return creds, nil
}

func (r *WixSecretsCredentialResolver) resolveCredentialSecret(ctx context.Context, ref string) (WixCredentials, error) {
	var payload wixCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return WixCredentials{}, fmt.Errorf("resolve wix credentials %q: %w", ref, err)
		}
		return parseWixCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return WixCredentials{}, fmt.Errorf("resolve wix credentials %q: %w", ref, err)
	}
	return parseWixCredentialSecret(raw)
}

func (r *WixSecretsCredentialResolver) resolveWebhookSecret(ctx context.Context, ref string) (string, error) {
	var payload wixCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.webhookSecret()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve wix webhook secret %q: %w", ref, err)
		}
		return parseWixWebhookSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve wix webhook secret %q: %w", ref, err)
	}
	return parseWixWebhookSecret(raw)
}

func (r *WixSecretsCredentialResolver) resolveWebhookPublicKey(ctx context.Context, ref string) (string, error) {
	var payload wixCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.webhookPublicKey()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return "", fmt.Errorf("resolve wix webhook public key %q: %w", ref, err)
		}
		return parseWixWebhookPublicKey(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return "", fmt.Errorf("resolve wix webhook public key %q: %w", ref, err)
	}
	return parseWixWebhookPublicKey(raw)
}

type wixCredentialPayload struct {
	AccessToken         string `json:"access_token"`
	Token               string `json:"token"`
	BearerToken         string `json:"bearer_token"`
	ClientID            string `json:"client_id"`
	ClientSecret        string `json:"client_secret"`
	InstanceID          string `json:"instance_id"`
	WebhookSecret       string `json:"webhook_secret"`
	SigningSecret       string `json:"signing_secret"`
	Secret              string `json:"secret"`
	WebhookPublicKey    string `json:"webhook_public_key"`
	WebhookPublicKeyPEM string `json:"webhook_public_key_pem"`
	PublicKey           string `json:"public_key"`
	APIBaseURL          string `json:"api_base_url"`
	TokenURL            string `json:"token_url"`
	UserAgent           string `json:"user_agent"`
	AppID               string `json:"app_id"`
}

func (p wixCredentialPayload) credentials() (WixCredentials, error) {
	token := normalizeWixBearerToken(firstString(p.AccessToken, p.Token, p.BearerToken))
	clientID := strings.TrimSpace(p.ClientID)
	clientSecret := strings.TrimSpace(p.ClientSecret)
	instanceID := strings.TrimSpace(p.InstanceID)
	if token == "" && (clientID == "" || clientSecret == "" || instanceID == "") {
		return WixCredentials{}, fmt.Errorf("wix access_token or client_id/client_secret/instance_id is required")
	}
	webhookSecret, _ := p.webhookSecret()
	publicKey, _ := p.webhookPublicKey()
	return WixCredentials{
		AccessToken:      token,
		ClientID:         clientID,
		ClientSecret:     clientSecret,
		InstanceID:       instanceID,
		WebhookSecret:    webhookSecret,
		WebhookPublicKey: publicKey,
		APIBaseURL:       strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"),
		TokenURL:         strings.TrimSpace(p.TokenURL),
		UserAgent:        strings.TrimSpace(p.UserAgent),
		AppID:            strings.TrimSpace(p.AppID),
	}, nil
}

func (p wixCredentialPayload) webhookSecret() (string, error) {
	secret := strings.TrimSpace(firstString(p.WebhookSecret, p.SigningSecret, p.Secret))
	if secret == "" {
		return "", fmt.Errorf("wix webhook secret is required")
	}
	return secret, nil
}

func (p wixCredentialPayload) webhookPublicKey() (string, error) {
	publicKey := strings.TrimSpace(firstString(p.WebhookPublicKey, p.WebhookPublicKeyPEM, p.PublicKey))
	if publicKey == "" {
		return "", fmt.Errorf("wix webhook public key is required")
	}
	return publicKey, nil
}

func parseWixCredentialSecret(raw string) (WixCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return WixCredentials{}, fmt.Errorf("wix credentials are empty")
	}
	var payload wixCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return WixCredentials{}, fmt.Errorf("parse wix credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		return parseWixKeyValueSecret(raw).credentials()
	}
	return wixCredentialPayload{AccessToken: normalizeWixBearerToken(raw)}.credentials()
}

func parseWixWebhookSecret(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("wix webhook secret is empty")
	}
	var payload wixCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse wix webhook secret JSON: %w", err)
		}
		return payload.webhookSecret()
	}
	if strings.Contains(raw, "=") {
		return parseWixKeyValueSecret(raw).webhookSecret()
	}
	return raw, nil
}

func parseWixWebhookPublicKey(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("wix webhook public key is empty")
	}
	var payload wixCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return "", fmt.Errorf("parse wix webhook public key JSON: %w", err)
		}
		return payload.webhookPublicKey()
	}
	if strings.Contains(raw, "=") && !strings.Contains(raw, "BEGIN PUBLIC KEY") && !strings.Contains(raw, "BEGIN RSA PUBLIC KEY") && !strings.Contains(raw, "BEGIN CERTIFICATE") {
		return parseWixKeyValueSecret(raw).webhookPublicKey()
	}
	return raw, nil
}

func parseWixKeyValueSecret(raw string) wixCredentialPayload {
	var payload wixCredentialPayload
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
		case "client_id", "app_id":
			payload.ClientID = value
			if strings.EqualFold(strings.TrimSpace(parts[0]), "app_id") {
				payload.AppID = value
			}
		case "client_secret", "app_secret", "app_secret_key":
			payload.ClientSecret = value
		case "instance_id":
			payload.InstanceID = value
		case "webhook_secret", "webhook_signing_secret":
			payload.WebhookSecret = value
		case "signing_secret":
			payload.SigningSecret = value
		case "secret":
			payload.Secret = value
		case "webhook_public_key", "webhook_public_key_pem":
			payload.WebhookPublicKey = value
		case "public_key":
			payload.PublicKey = value
		case "api_base_url":
			payload.APIBaseURL = value
		case "token_url":
			payload.TokenURL = value
		case "user_agent":
			payload.UserAgent = value
		}
	}
	return payload
}

func normalizeWixBearerToken(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(raw), "bearer ") {
		return strings.TrimSpace(raw[len("bearer "):])
	}
	return raw
}

func wixCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	))
}

func wixWebhookSecretRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signing_secret_ref"),
		settingString(integration.Settings, "signing_secret_ref"),
	))
}

func wixWebhookPublicKeyRef(integration Integration) string {
	return strings.TrimSpace(firstString(
		settingString(integration.Settings, "webhook_public_key_ref"),
		settingString(integration.Settings, "webhook_jwt_public_key_ref"),
		settingString(integration.Settings, "public_key_ref"),
	))
}

func (b WixRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderWix {
		return SyncRequest{}, fmt.Errorf("wix backfill requires a Wix integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("wix credential resolver is not configured")
	}
	creds, err := b.Credentials.ResolveWix(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := leadEgressClient(b.HTTPClient, ProviderWix, 30*time.Second)
	baseURL := strings.TrimRight(firstString(b.APIBaseURL, creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), wixDefaultAPIBaseURL), "/")
	token := strings.TrimSpace(creds.AccessToken)
	if token == "" {
		token, err = wixAccessToken(ctx, client, baseURL, creds, integration)
		if err != nil {
			return SyncRequest{}, err
		}
	}
	state, err := decodeWixBackfillCursor(cursor)
	if err != nil {
		return SyncRequest{}, err
	}
	if state.Complete {
		return SyncRequest{RunMode: "backfill", Cursor: wixCursorComplete}, nil
	}
	if state.Object == "" {
		state.Object = wixBackfillObjectOrder[0]
	}
	page, err := b.fetchPage(ctx, client, baseURL, token, creds, integration, state)
	if err != nil {
		return SyncRequest{}, err
	}
	req := SyncRequest{RunMode: "backfill", Submissions: []SubmissionInput{}}
	for _, item := range page.items(state.Object) {
		var submission SubmissionInput
		switch state.Object {
		case "contacts":
			submission = wixContactSubmission(item, integration)
		case "submissions":
			submission = wixFormSubmission(item, integration)
		default:
			return SyncRequest{}, fmt.Errorf("unsupported Wix object %q", state.Object)
		}
		if submission.SourceID != "" {
			req.Submissions = append(req.Submissions, submission)
		}
	}
	if next := page.nextCursor(); next != "" {
		req.Cursor = encodeWixBackfillCursor(wixBackfillState{Object: state.Object, Cursor: next})
	} else {
		nextObject := nextWixBackfillObject(state.Object)
		if nextObject == "complete" {
			req.Cursor = wixCursorComplete
		} else {
			req.Cursor = encodeWixBackfillCursor(wixBackfillState{Object: nextObject})
		}
	}
	return req, nil
}

func (b WixRESTBackfiller) fetchPage(ctx context.Context, client *http.Client, baseURL, token string, creds WixCredentials, integration Integration, state wixBackfillState) (wixListResponse, error) {
	pageSize := wixPageSize(firstNonZero(b.PageSize, intSetting(integration.Settings, "page_size")))
	userAgent := firstString(b.UserAgent, creds.UserAgent, settingString(integration.Settings, "user_agent"), wixDefaultUserAgent)
	switch state.Object {
	case "contacts":
		body := wixContactsQueryBody(state.Cursor, pageSize)
		return wixDoJSON(ctx, client, baseURL, token, integration, http.MethodPost, "/contacts/v4/contacts/query", nil, body, userAgent)
	case "submissions":
		body := wixSubmissionsQueryBody(integration, state.Cursor, pageSize)
		return wixDoJSON(ctx, client, baseURL, token, integration, http.MethodPost, "/form-submission-service/v4/submissions/namespace/query", nil, body, userAgent)
	default:
		return wixListResponse{}, fmt.Errorf("unsupported Wix object %q", state.Object)
	}
}

type wixBackfillState struct {
	Object   string `json:"object,omitempty"`
	Cursor   string `json:"cursor,omitempty"`
	Complete bool   `json:"complete,omitempty"`
}

func decodeWixBackfillCursor(cursor string) (wixBackfillState, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return wixBackfillState{Object: wixBackfillObjectOrder[0]}, nil
	}
	if cursor == wixCursorComplete {
		return wixBackfillState{Complete: true}, nil
	}
	if !strings.HasPrefix(cursor, wixCursorPrefix) {
		return wixBackfillState{}, fmt.Errorf("invalid Wix cursor")
	}
	raw := strings.TrimPrefix(cursor, wixCursorPrefix)
	if raw == "" {
		return wixBackfillState{Object: wixBackfillObjectOrder[0]}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return wixBackfillState{}, fmt.Errorf("invalid Wix cursor")
	}
	var out wixBackfillState
	if err := json.Unmarshal(decoded, &out); err != nil {
		return wixBackfillState{}, fmt.Errorf("invalid Wix cursor")
	}
	out.Object = normalizeWixBackfillObject(out.Object)
	if out.Object == "" {
		out.Object = wixBackfillObjectOrder[0]
	}
	return out, nil
}

func encodeWixBackfillCursor(state wixBackfillState) string {
	state.Object = normalizeWixBackfillObject(state.Object)
	if state.Complete || state.Object == "complete" {
		return wixCursorComplete
	}
	raw, _ := json.Marshal(state)
	return wixCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func normalizeWixBackfillObject(object string) string {
	switch strings.ToLower(strings.TrimSpace(object)) {
	case "", "submission", "submissions", "forms", "responses":
		if object == "" {
			return ""
		}
		return "submissions"
	case "contact", "contacts", "profiles", "subscribers":
		return "contacts"
	case "complete", "done":
		return "complete"
	default:
		return strings.ToLower(strings.TrimSpace(object))
	}
}

func nextWixBackfillObject(object string) string {
	object = normalizeWixBackfillObject(object)
	for i, candidate := range wixBackfillObjectOrder {
		if candidate == object {
			if i+1 < len(wixBackfillObjectOrder) {
				return wixBackfillObjectOrder[i+1]
			}
			return "complete"
		}
	}
	return "complete"
}

type wixListResponse struct {
	Contacts       []map[string]any `json:"contacts"`
	Submissions    []map[string]any `json:"submissions"`
	Items          []map[string]any `json:"items"`
	Data           []map[string]any `json:"data"`
	PagingMetadata map[string]any   `json:"pagingMetadata"`
	Metadata       map[string]any   `json:"metadata"`
}

func (p wixListResponse) items(object string) []map[string]any {
	switch normalizeWixBackfillObject(object) {
	case "contacts":
		if len(p.Contacts) > 0 {
			return p.Contacts
		}
	case "submissions":
		if len(p.Submissions) > 0 {
			return p.Submissions
		}
	}
	if len(p.Items) > 0 {
		return p.Items
	}
	return p.Data
}

func (p wixListResponse) nextCursor() string {
	for _, root := range []map[string]any{p.PagingMetadata, p.Metadata} {
		if len(root) == 0 {
			continue
		}
		if cursor := mapString(root, "nextCursor", "next_cursor", "cursor"); cursor != "" {
			return cursor
		}
		if cursors := mapAnyMap(root, "cursors"); len(cursors) > 0 {
			if cursor := mapString(cursors, "next", "nextCursor", "next_cursor"); cursor != "" {
				return cursor
			}
		}
	}
	return ""
}

func wixContactsQueryBody(cursor string, pageSize int) map[string]any {
	query := map[string]any{
		"paging": map[string]any{"limit": pageSize},
		"sort": []map[string]any{{
			"fieldName": "createdDate",
			"order":     "DESC",
		}},
	}
	if cursor = strings.TrimSpace(cursor); cursor != "" {
		query["paging"].(map[string]any)["cursor"] = cursor
	}
	return map[string]any{"query": query}
}

func wixSubmissionsQueryBody(integration Integration, cursor string, pageSize int) map[string]any {
	namespace := firstString(settingString(integration.Settings, "namespace"), settingString(integration.Settings, "forms_namespace"), wixDefaultFormsNamespace)
	filter := map[string]any{"namespace": map[string]any{"$eq": namespace}}
	if formID := strings.TrimSpace(settingString(integration.Settings, "form_id")); formID != "" {
		filter["formId"] = map[string]any{"$eq": formID}
	}
	if status := strings.TrimSpace(settingString(integration.Settings, "submission_status")); status != "" {
		filter["status"] = map[string]any{"$eq": status}
	}
	query := map[string]any{
		"filter": filter,
		"paging": map[string]any{"limit": pageSize},
		"sort": []map[string]any{{
			"fieldName": "createdDate",
			"order":     "DESC",
		}},
	}
	if cursor = strings.TrimSpace(cursor); cursor != "" {
		query["paging"].(map[string]any)["cursor"] = cursor
	}
	return map[string]any{"query": query}
}

func wixDoJSON(ctx context.Context, client *http.Client, baseURL, token string, integration Integration, method, path string, query url.Values, body any, userAgent string) (wixListResponse, error) {
	raw, err := wixDoRaw(ctx, client, baseURL, token, integration, method, path, query, body, userAgent)
	if err != nil {
		return wixListResponse{}, err
	}
	var out wixListResponse
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return wixListResponse{}, fmt.Errorf("decode wix %s response: %w", path, err)
	}
	return out, nil
}

func wixDoMapJSON(ctx context.Context, client *http.Client, baseURL, token string, integration Integration, method, path string, query url.Values, body any, userAgent string) (map[string]any, error) {
	raw, err := wixDoRaw(ctx, client, baseURL, token, integration, method, path, query, body, userAgent)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil && err != io.EOF {
		return nil, fmt.Errorf("decode wix %s response: %w", path, err)
	}
	return nonNilMap(out), nil
}

func wixDoRaw(ctx context.Context, client *http.Client, baseURL, token string, integration Integration, method, path string, query url.Values, body any, userAgent string) ([]byte, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + path)
	if err != nil {
		return nil, err
	}
	if query != nil {
		u.RawQuery = query.Encode()
	}
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, wixDefaultUserAgent))
	if siteID := strings.TrimSpace(settingString(integration.Settings, "site_id")); siteID != "" {
		req.Header.Set("wix-site-id", siteID)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := httpbody.ReadAtMost(resp.Body, wixResponseMaxBytes)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return nil, WixRateLimitError{Path: path, StatusCode: resp.StatusCode, RetryAfter: wixRetryAfter(resp.Header), Snippet: responseWixSnippet(raw)}
		}
		return nil, fmt.Errorf("wix REST %s failed %d: %s", path, resp.StatusCode, responseWixSnippet(raw))
	}
	return raw, nil
}

func wixAccessToken(ctx context.Context, client *http.Client, baseURL string, creds WixCredentials, integration Integration) (string, error) {
	instanceID := firstString(creds.InstanceID, settingString(integration.Settings, "instance_id"))
	if strings.TrimSpace(creds.ClientID) == "" || strings.TrimSpace(creds.ClientSecret) == "" || strings.TrimSpace(instanceID) == "" {
		return "", fmt.Errorf("wix app client_id, client_secret, and instance_id are required to mint an access token")
	}
	payload := map[string]any{
		"grant_type":    "client_credentials",
		"client_id":     strings.TrimSpace(creds.ClientID),
		"client_secret": strings.TrimSpace(creds.ClientSecret),
		"instance_id":   strings.TrimSpace(instanceID),
	}
	raw, _ := json.Marshal(payload)
	tokenURL := strings.TrimSpace(firstString(creds.TokenURL, settingString(integration.Settings, "token_url")))
	if tokenURL == "" {
		tokenURL = strings.TrimRight(baseURL, "/") + "/oauth2/token"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := httpbody.ReadAtMost(resp.Body, wixResponseMaxBytes)
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			return "", WixRateLimitError{Path: "/oauth2/token", StatusCode: resp.StatusCode, RetryAfter: wixRetryAfter(resp.Header), Snippet: responseWixSnippet(body)}
		}
		return "", fmt.Errorf("wix token failed %d: %s", resp.StatusCode, responseWixSnippet(body))
	}
	return decodeWixToken(body)
}

func wixRetryAfter(headers http.Header) time.Duration {
	if raw := strings.TrimSpace(headers.Get("Retry-After")); raw != "" {
		if seconds, err := strconv.Atoi(raw); err == nil && seconds > 0 {
			return time.Duration(seconds) * time.Second
		}
		if at, err := http.ParseTime(raw); err == nil {
			delay := time.Until(at)
			if delay > 0 {
				return delay
			}
		}
	}
	return 0
}

func responseWixSnippet(raw []byte) string {
	return truncateTypeformString(strings.TrimSpace(string(raw)), 500)
}

func decodeWixToken(raw []byte) (string, error) {
	var out struct {
		AccessToken      string `json:"access_token"`
		AccessTokenCamel string `json:"accessToken"`
		Token            string `json:"token"`
		Body             any    `json:"body"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("decode wix token response: %w", err)
	}
	if token := normalizeWixTokenValue(firstString(out.AccessToken, out.AccessTokenCamel, out.Token)); token != "" {
		return token, nil
	}
	switch body := out.Body.(type) {
	case string:
		var nested map[string]any
		if err := json.Unmarshal([]byte(body), &nested); err == nil {
			if token := wixTokenValueFromMap(nested); token != "" {
				return token, nil
			}
		}
	case map[string]any:
		if token := wixTokenValueFromMap(body); token != "" {
			return token, nil
		}
	}
	return "", fmt.Errorf("wix token response missing access_token")
}

func wixTokenValueFromMap(values map[string]any) string {
	for _, key := range []string{"access_token", "accessToken", "token"} {
		if token := normalizeWixTokenValue(fmt.Sprint(values[key])); token != "" {
			return token
		}
	}
	return ""
}

func normalizeWixTokenValue(raw string) string {
	token := strings.TrimSpace(raw)
	if token == "" || token == "<nil>" {
		return ""
	}
	return normalizeWixBearerToken(token)
}

func wixContactSubmission(contact map[string]any, integration Integration) SubmissionInput {
	id := firstString(mapString(contact, "id", "_id", "contactId", "contact_id"), mapString(mapAnyMap(contact, "contact"), "id", "_id"))
	info := mapAnyMap(contact, "info")
	primaryInfo := mapAnyMap(contact, "primaryInfo", "primary_info")
	primaryEmail := mapAnyMap(contact, "primaryEmail", "primary_email")
	primaryPhone := mapAnyMap(contact, "primaryPhone", "primary_phone")
	name := mapAnyMap(info, "name")
	email := firstString(
		mapString(primaryInfo, "email"),
		mapString(primaryEmail, "email"),
		wixEmailFromInfo(info),
		mapString(contact, "email"),
	)
	phone := firstString(
		mapString(primaryInfo, "phone"),
		mapString(primaryPhone, "e164Phone", "formattedPhone", "phone"),
		wixPhoneFromInfo(info),
	)
	formID := firstString(settingString(integration.Settings, "form_id"), "wix-contacts")
	fields := map[string]any{
		"wix_contact_id":           id,
		"wix_contact_revision":     mapString(contact, "revision"),
		"wix_primary_email_status": mapString(primaryEmail, "subscriptionStatus", "subscription_status"),
		"wix_primary_phone_status": mapString(primaryPhone, "subscriptionStatus", "subscription_status"),
		"wix_provider_raw":         contact,
	}
	if labels := stringSliceFromAny(mapAnyMap(info, "labelKeys", "label_keys")["items"]); len(labels) > 0 {
		fields["wix_label_keys"] = labels
	}
	submittedAt := parseWixTime(firstString(mapString(contact, "createdDate", "_createdDate", "updatedDate", "_updatedDate"), mapString(mapAnyMap(contact, "lastActivity"), "activityDate")))
	return SubmissionInput{
		SourceID:    wixLeadSourceID("contact", "", id),
		Email:       strings.ToLower(strings.TrimSpace(email)),
		FirstName:   mapString(name, "first", "firstName", "first_name"),
		LastName:    mapString(name, "last", "lastName", "last_name"),
		Phone:       phone,
		Company:     mapString(info, "company"),
		FormID:      formID,
		FormName:    firstString(settingString(integration.Settings, "form_name"), "Wix contacts"),
		EventName:   "lead.contact_synced",
		Tags:        wixTags(integration, formID, ""),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func wixFormSubmission(raw map[string]any, integration Integration) SubmissionInput {
	submission := raw
	if nested := mapAnyMap(raw, "submission"); len(nested) > 0 {
		submission = nested
	}
	id := mapString(submission, "id", "_id", "submissionId", "submission_id")
	formID := firstString(mapString(submission, "formId", "form_id"), settingString(integration.Settings, "form_id"))
	namespace := firstString(mapString(submission, "namespace"), settingString(integration.Settings, "namespace"), wixDefaultFormsNamespace)
	values := wixSubmissionValues(submission)
	fields := map[string]any{
		"wix_submission_id": id,
		"wix_form_id":       formID,
		"wix_namespace":     namespace,
		"wix_contact_id":    firstString(mapString(submission, "contactId", "contact_id"), mapString(mapAnyMap(submission, "submitter"), "contactId", "contact_id")),
		"wix_status":        mapString(submission, "status"),
		"wix_provider_raw":  raw,
	}
	identity := typeformIdentity{}
	for key, value := range values {
		if strings.TrimSpace(key) == "" {
			continue
		}
		fields["wix_submission."+key] = value
		text := strings.TrimSpace(fmt.Sprint(value))
		identity.apply(key, text)
		if identity.Email == "" && strings.Contains(text, "@") {
			identity.Email = text
		}
	}
	if identity.FullName == "" && identity.FirstName != "" && identity.LastName != "" {
		identity.FullName = strings.TrimSpace(identity.FirstName + " " + identity.LastName)
	}
	submittedAt := parseWixTime(firstString(mapString(submission, "createdDate", "submittedAt", "updatedDate"), mapString(raw, "eventTime")))
	return SubmissionInput{
		SourceID:    wixLeadSourceID("submission", formID, id),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    firstString(settingString(integration.Settings, "form_name"), mapString(submission, "formName", "form_name"), "Wix form"),
		EventName:   "lead.submitted",
		Tags:        wixTags(integration, formID, namespace),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func wixSubmissionValues(submission map[string]any) map[string]any {
	raw := mapAnyMap(submission, "submissions", "values", "fields")
	out := map[string]any{}
	for key, value := range raw {
		out[key] = wixFieldValue(value)
	}
	return out
}

func wixFieldValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		for _, key := range []string{"stringValue", "numberValue", "boolValue", "dateValue", "datetimeValue", "email", "phone", "value"} {
			if v, ok := typed[key]; ok && v != nil {
				return wixFieldValue(v)
			}
		}
		if list := mapAnyMap(typed, "listValue"); len(list) > 0 {
			values := anySliceFromAny(list["values"])
			out := make([]any, 0, len(values))
			for _, item := range values {
				out = append(out, wixFieldValue(item))
			}
			return out
		}
		if structure := mapAnyMap(typed, "structValue"); len(structure) > 0 {
			return structure
		}
		return typed
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, wixFieldValue(item))
		}
		return out
	default:
		return typed
	}
}

func (d *Deps) WixWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, wixWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Wix webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	event, integration, creds, err := d.decodeAndVerifyWixWebhook(r.Context(), body, r)
	if err != nil {
		status := http.StatusBadRequest
		code := "invalid_payload"
		if errors.Is(err, ErrMissingWebhookSecret) || errors.Is(err, ErrMissingWebhookSignature) || errors.Is(err, ErrInvalidWebhookSignature) {
			status = http.StatusUnauthorized
			code = "invalid_signature"
		} else if errors.Is(err, ErrNotFound) {
			status = http.StatusNotFound
			code = "integration_not_found"
		}
		httperror.Write(w, status, code, httperror.MessageForStatus(status))
		return
	}
	webhookID := wixWebhookID(r, event)
	topic := wixWebhookTopic(event)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderWix, webhookID, topic, body)
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
	lifecycleHandled, err := d.handleWixLifecycleWebhook(r.Context(), integration, creds, event)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderWix, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if lifecycleHandled {
		if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderWix, webhookID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "event_id": event.ID, "lifecycle": true})
		return
	}
	if strings.TrimSpace(integration.Status) != "" && !strings.EqualFold(strings.TrimSpace(integration.Status), "connected") {
		if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderWix, webhookID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true, "event_id": event.ID, "reason": "integration_not_connected"})
		return
	}
	req, handled, err := d.wixWebhookSyncRequest(r.Context(), *integration, creds, event)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderWix, webhookID, err)
		httperror.Write(w, http.StatusBadGateway, "provider_fetch_failed", httperror.MessageInternal)
		return
	}
	if !handled {
		if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderWix, webhookID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true, "event_id": event.ID})
		return
	}
	req = normalizeSyncRequest(req)
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderWix, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderWix, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func wixWebhookID(r *http.Request, event wixWebhookEvent) string {
	if r != nil {
		if id := firstString(r.Header.Get("X-Wix-Event-Id"), r.Header.Get("X-Request-Id")); id != "" {
			return id
		}
	}
	return firstString(event.ID, event.EntityID, "wix-webhook-"+strconv.FormatInt(time.Now().UTC().UnixNano(), 10))
}

func wixWebhookTopic(event wixWebhookEvent) string {
	if topic := strings.TrimSpace(event.EventType); topic != "" {
		return topic
	}
	if event.EntityFQDN != "" && event.Slug != "" {
		return event.EntityFQDN + "." + event.Slug
	}
	return "wix.unknown"
}

func (d *Deps) decodeAndVerifyWixWebhook(ctx context.Context, body []byte, r *http.Request) (wixWebhookEvent, *Integration, WixCredentials, error) {
	if d == nil || d.Repo == nil {
		return wixWebhookEvent{}, nil, WixCredentials{}, fmt.Errorf("wix webhook repo is not configured")
	}
	resolver := d.wixCredentialResolver()
	if resolver == nil {
		return wixWebhookEvent{}, nil, WixCredentials{}, fmt.Errorf("wix credential resolver is not configured")
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return wixWebhookEvent{}, nil, WixCredentials{}, fmt.Errorf("empty Wix webhook body")
	}
	if trimmed[0] != '{' {
		claims, err := decodeWixWebhookJWTUnverified(string(trimmed))
		if err != nil {
			return wixWebhookEvent{}, nil, WixCredentials{}, err
		}
		event := wixWebhookEventFromMap(claims)
		integration, err := d.findWixIntegration(ctx, event, "")
		if err != nil {
			return wixWebhookEvent{}, nil, WixCredentials{}, err
		}
		creds, err := resolver.ResolveWix(ctx, integration.TenantID, *integration)
		if err != nil {
			return wixWebhookEvent{}, nil, WixCredentials{}, err
		}
		verified, err := VerifyWixWebhookJWT(creds.WebhookPublicKey, string(trimmed), d.now(), firstString(creds.AppID, creds.ClientID, settingString(integration.Settings, "app_id"), settingString(integration.Settings, "client_id")))
		if err != nil {
			return wixWebhookEvent{}, nil, WixCredentials{}, err
		}
		event = wixWebhookEventFromMap(verified)
		return event, integration, creds, nil
	}
	var payload map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&payload); err != nil && err != io.EOF {
		return wixWebhookEvent{}, nil, WixCredentials{}, fmt.Errorf("decode wix webhook body: %w", err)
	}
	event := wixWebhookEventFromMap(payload)
	integration, err := d.findWixIntegration(ctx, event, wixWebhookFormIDFromMap(payload))
	if err != nil {
		return wixWebhookEvent{}, nil, WixCredentials{}, err
	}
	creds, err := resolver.ResolveWix(ctx, integration.TenantID, *integration)
	if err != nil {
		return wixWebhookEvent{}, nil, WixCredentials{}, err
	}
	if err := VerifyWixWebhookSharedSecret(creds.WebhookSecret, r.Header.Get("X-Wix-Webhook-Secret"), r.Header.Get("X-Postwave-Webhook-Secret"), r.Header.Get("Authorization")); err != nil {
		return wixWebhookEvent{}, nil, WixCredentials{}, err
	}
	return event, integration, creds, nil
}

func (d *Deps) findWixIntegration(ctx context.Context, event wixWebhookEvent, fallbackFormID string) (*Integration, error) {
	if event.InstanceID != "" {
		integration, err := d.Repo.FindIntegrationByProviderInstanceID(ctx, ProviderWix, event.InstanceID)
		if err == nil || !errors.Is(err, ErrNotFound) {
			return integration, err
		}
	}
	if event.SiteID != "" {
		integration, err := d.Repo.FindIntegrationByProviderSiteID(ctx, ProviderWix, event.SiteID)
		if err == nil || !errors.Is(err, ErrNotFound) {
			return integration, err
		}
	}
	if formID := firstString(event.FormID, fallbackFormID); formID != "" {
		return d.Repo.FindIntegrationByProviderFormID(ctx, ProviderWix, formID)
	}
	return nil, ErrNotFound
}

func (d *Deps) handleWixLifecycleWebhook(ctx context.Context, integration *Integration, creds WixCredentials, event wixWebhookEvent) (bool, error) {
	if integration == nil {
		return false, nil
	}
	topic := strings.ToLower(strings.TrimSpace(wixWebhookTopic(event)))
	switch {
	case wixWebhookIsAppInstalled(topic):
		return true, d.recordWixAppInstalled(ctx, integration, creds, event)
	case wixWebhookIsAppRemoved(topic):
		return true, d.recordWixAppRemoved(ctx, integration, event)
	default:
		return false, nil
	}
}

func wixWebhookIsAppInstalled(topic string) bool {
	topic = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(topic, "/", ".")))
	return (strings.Contains(topic, "app") || strings.Contains(topic, "instance")) &&
		(strings.Contains(topic, "installed") || strings.Contains(topic, ".created"))
}

func wixWebhookIsAppRemoved(topic string) bool {
	topic = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(topic, "/", ".")))
	return (strings.Contains(topic, "app") || strings.Contains(topic, "instance")) &&
		(strings.Contains(topic, "removed") || strings.Contains(topic, "uninstalled") || strings.Contains(topic, ".deleted"))
}

func (d *Deps) recordWixAppInstalled(ctx context.Context, integration *Integration, creds WixCredentials, event wixWebhookEvent) error {
	settings := copySettings(integration.Settings)
	if event.SiteID != "" {
		settings["site_id"] = event.SiteID
	}
	if event.InstanceID != "" {
		settings["instance_id"] = event.InstanceID
	}
	if event.AppID != "" {
		settings["app_id"] = event.AppID
	}
	settings["wix_app_instance_status"] = "installed"
	settings["wix_app_instance_last_event_id"] = event.ID
	settings["wix_app_instance_seen_at"] = d.now().UTC().Format(time.RFC3339)
	settings["wix_app_instance_event"] = nonNilMap(event.Raw)
	if appInstance, err := d.fetchWixAppInstance(ctx, integration, creds); err == nil && len(appInstance) > 0 {
		settings["wix_app_instance"] = appInstance
		if siteID := wixAppInstanceSiteID(appInstance); siteID != "" {
			settings["site_id"] = siteID
		}
		if instanceID := wixAppInstanceID(appInstance); instanceID != "" {
			settings["instance_id"] = instanceID
		}
	}
	_, err := d.Repo.UpsertIntegration(ctx, integration.TenantID, IntegrationInput{
		Provider:       ProviderWix,
		Name:           integration.Name,
		Status:         "connected",
		Scopes:         integration.Scopes,
		CredentialsRef: firstString(integration.CredentialsRef, settingString(settings, "credentials_ref")),
		Settings:       settings,
	})
	return err
}

func (d *Deps) recordWixAppRemoved(ctx context.Context, integration *Integration, event wixWebhookEvent) error {
	settings := copySettings(integration.Settings)
	if event.SiteID != "" {
		settings["site_id"] = event.SiteID
	}
	if event.InstanceID != "" {
		settings["instance_id"] = event.InstanceID
	}
	if event.AppID != "" {
		settings["app_id"] = event.AppID
	}
	settings["wix_app_instance_status"] = "removed"
	settings["wix_app_instance_last_event_id"] = event.ID
	settings["wix_app_instance_seen_at"] = d.now().UTC().Format(time.RFC3339)
	settings["wix_app_instance_event"] = nonNilMap(event.Raw)
	_, err := d.Repo.UpsertIntegration(ctx, integration.TenantID, IntegrationInput{
		Provider:       ProviderWix,
		Name:           integration.Name,
		Status:         "needs_auth",
		Scopes:         integration.Scopes,
		CredentialsRef: firstString(integration.CredentialsRef, settingString(settings, "credentials_ref")),
		Settings:       settings,
	})
	return err
}

func (d *Deps) wixWebhookSyncRequest(ctx context.Context, integration Integration, creds WixCredentials, event wixWebhookEvent) (SyncRequest, bool, error) {
	topic := strings.ToLower(strings.TrimSpace(firstString(event.EventType, event.EntityFQDN+"."+event.Slug)))
	switch {
	case strings.Contains(topic, "submission") && (strings.Contains(topic, "created") || strings.Contains(topic, "updated") || strings.Contains(topic, "confirmed")):
		entity := event.Entity
		if len(entity) == 0 && event.EntityID != "" {
			fetched, err := d.fetchWixWebhookEntity(ctx, integration, creds, "submission", event.EntityID)
			if err != nil {
				return SyncRequest{}, false, err
			}
			entity = fetched
		}
		if len(entity) == 0 {
			return SyncRequest{}, false, fmt.Errorf("wix submission webhook missing entity")
		}
		submission := wixFormSubmission(entity, integration)
		submission.Fields["wix_event_id"] = event.ID
		submission.Fields["wix_event_type"] = topic
		return SyncRequest{RunMode: "webhook", Submissions: []SubmissionInput{submission}, Cursor: wixWebhookCursor(event)}, true, nil
	case strings.Contains(topic, "contact") && (strings.Contains(topic, "created") || strings.Contains(topic, "updated")):
		entity := event.Entity
		if len(entity) == 0 && event.EntityID != "" {
			fetched, err := d.fetchWixWebhookEntity(ctx, integration, creds, "contact", event.EntityID)
			if err != nil {
				return SyncRequest{}, false, err
			}
			entity = fetched
		}
		if len(entity) == 0 {
			return SyncRequest{}, false, fmt.Errorf("wix contact webhook missing entity")
		}
		submission := wixContactSubmission(entity, integration)
		submission.Fields["wix_event_id"] = event.ID
		submission.Fields["wix_event_type"] = topic
		return SyncRequest{RunMode: "webhook", Submissions: []SubmissionInput{submission}, Cursor: wixWebhookCursor(event)}, true, nil
	case strings.Contains(topic, "deleted"):
		return SyncRequest{}, false, nil
	default:
		return SyncRequest{}, false, nil
	}
}

func (d *Deps) fetchWixWebhookEntity(ctx context.Context, integration Integration, creds WixCredentials, kind, id string) (map[string]any, error) {
	client := leadEgressClient(nil, ProviderWix, 30*time.Second)
	baseURL := strings.TrimRight(firstString(creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), wixDefaultAPIBaseURL), "/")
	token := strings.TrimSpace(creds.AccessToken)
	var err error
	if token == "" {
		token, err = wixAccessToken(ctx, client, baseURL, creds, integration)
		if err != nil {
			return nil, err
		}
	}
	userAgent := firstString(creds.UserAgent, settingString(integration.Settings, "user_agent"), wixDefaultUserAgent)
	var path string
	switch kind {
	case "submission":
		path = "/form-submission-service/v4/submissions/" + url.PathEscape(id)
	case "contact":
		path = "/contacts/v4/contacts/" + url.PathEscape(id)
	default:
		return nil, fmt.Errorf("unsupported Wix webhook entity kind %q", kind)
	}
	raw, err := wixDoMapJSON(ctx, client, baseURL, token, integration, http.MethodGet, path, nil, nil, userAgent)
	if err != nil {
		return nil, err
	}
	return wixEntityFromResponse(raw, kind), nil
}

func (d *Deps) fetchWixAppInstance(ctx context.Context, integration *Integration, creds WixCredentials) (map[string]any, error) {
	if integration == nil {
		return nil, fmt.Errorf("wix app instance fetch missing integration")
	}
	client := leadEgressClient(nil, ProviderWix, 30*time.Second)
	baseURL := strings.TrimRight(firstString(creds.APIBaseURL, settingString(integration.Settings, "api_base_url"), wixDefaultAPIBaseURL), "/")
	token := strings.TrimSpace(creds.AccessToken)
	var err error
	if token == "" {
		token, err = wixAccessToken(ctx, client, baseURL, creds, *integration)
		if err != nil {
			return nil, err
		}
	}
	userAgent := firstString(creds.UserAgent, settingString(integration.Settings, "user_agent"), wixDefaultUserAgent)
	return wixDoMapJSON(ctx, client, baseURL, token, *integration, http.MethodGet, "/apps/v1/instance", nil, nil, userAgent)
}

func wixAppInstanceSiteID(raw map[string]any) string {
	for _, root := range []map[string]any{raw, mapAnyMap(raw, "instance"), mapAnyMap(raw, "appInstance", "app_instance")} {
		if len(root) == 0 {
			continue
		}
		if id := firstString(mapString(root, "siteId", "site_id"), mapString(mapAnyMap(root, "site"), "id", "siteId", "site_id")); id != "" {
			return id
		}
	}
	return firstString(mapString(mapAnyMap(raw, "site"), "id", "siteId", "site_id"))
}

func wixAppInstanceID(raw map[string]any) string {
	for _, root := range []map[string]any{raw, mapAnyMap(raw, "instance"), mapAnyMap(raw, "appInstance", "app_instance")} {
		if len(root) == 0 {
			continue
		}
		if id := mapString(root, "instanceId", "instance_id", "id"); id != "" {
			return id
		}
	}
	return ""
}

type wixWebhookEvent struct {
	ID         string
	EventType  string
	EntityFQDN string
	Slug       string
	EntityID   string
	SiteID     string
	InstanceID string
	AppID      string
	FormID     string
	Entity     map[string]any
	Raw        map[string]any
}

func wixWebhookEventFromMap(raw map[string]any) wixWebhookEvent {
	raw = nonNilMap(raw)
	data := mapAnyMap(raw, "data", "event")
	created := mapAnyMap(raw, "createdEvent", "created_event")
	updated := mapAnyMap(raw, "updatedEvent", "updated_event")
	deleted := mapAnyMap(raw, "deletedEvent", "deleted_event")
	eventRoot := firstNonEmptyMap(created, updated, deleted, data, raw)
	entity := firstNonEmptyMap(
		mapAnyMap(created, "entity"),
		mapAnyMap(updated, "currentEntity", "current_entity", "entity"),
		mapAnyMap(data, "entity", "submission", "contact"),
		mapAnyMap(raw, "entity", "submission", "contact"),
	)
	formID := firstString(
		mapString(entity, "formId", "form_id"),
		mapString(eventRoot, "formId", "form_id"),
		mapString(raw, "formId", "form_id"),
	)
	event := wixWebhookEvent{
		ID:         firstString(mapString(raw, "id", "eventId", "event_id"), mapString(eventRoot, "id", "eventId", "event_id")),
		EventType:  firstString(mapString(raw, "eventType", "event_type", "topic"), mapString(eventRoot, "eventType", "event_type", "topic")),
		EntityFQDN: firstString(mapString(raw, "entityFqdn", "entity_fqdn"), mapString(eventRoot, "entityFqdn", "entity_fqdn")),
		Slug:       firstString(mapString(raw, "slug"), mapString(eventRoot, "slug")),
		EntityID:   firstString(mapString(raw, "entityId", "entity_id"), mapString(eventRoot, "entityId", "entity_id"), mapString(entity, "id", "_id")),
		SiteID: firstString(
			mapString(raw, "siteId", "site_id"),
			mapString(data, "siteId", "site_id"),
			mapString(eventRoot, "siteId", "site_id"),
			mapString(mapAnyMap(raw, "site"), "id", "siteId", "site_id"),
			mapString(mapAnyMap(data, "site"), "id", "siteId", "site_id"),
			mapString(mapAnyMap(raw, "instance"), "siteId", "site_id"),
			mapString(mapAnyMap(data, "instance"), "siteId", "site_id"),
		),
		InstanceID: firstString(mapString(raw, "instanceId", "instance_id"), mapString(data, "instanceId", "instance_id"), mapString(eventRoot, "instanceId", "instance_id")),
		AppID:      firstString(mapString(raw, "appId", "app_id"), mapString(data, "appId", "app_id"), mapString(eventRoot, "appId", "app_id")),
		FormID:     formID,
		Entity:     entity,
		Raw:        raw,
	}
	if event.ID == "" {
		event.ID = localWixWebhookID(raw)
	}
	if event.EventType == "" && event.EntityFQDN != "" && event.Slug != "" {
		event.EventType = event.EntityFQDN + "." + event.Slug
	}
	return event
}

func wixWebhookFormIDFromMap(raw map[string]any) string {
	event := wixWebhookEventFromMap(raw)
	return event.FormID
}

func wixEntityFromResponse(raw map[string]any, kind string) map[string]any {
	for _, key := range []string{kind, "entity", "item", "data"} {
		if nested := mapAnyMap(raw, key); len(nested) > 0 {
			return nested
		}
	}
	return raw
}

func wixWebhookCursor(event wixWebhookEvent) string {
	return "wix-webhook-" + firstString(event.ID, event.EntityID, strconv.FormatInt(time.Now().UTC().Unix(), 10))
}

func localWixWebhookID(raw map[string]any) string {
	body, _ := json.Marshal(raw)
	sum := sha256.Sum256(body)
	return "wix_local_" + base64.RawURLEncoding.EncodeToString(sum[:])
}

type wixWebhookJWTHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
}

func VerifyWixWebhookJWT(publicKeyPEM, token string, now time.Time, audience string) (map[string]any, error) {
	publicKeyPEM = strings.TrimSpace(publicKeyPEM)
	if publicKeyPEM == "" {
		return nil, ErrMissingWebhookSecret
	}
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return nil, ErrMissingWebhookSignature
	}
	enc := base64.RawURLEncoding
	headerBytes, err := enc.DecodeString(parts[0])
	if err != nil {
		return nil, ErrInvalidWebhookSignature
	}
	var header wixWebhookJWTHeader
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return nil, ErrInvalidWebhookSignature
	}
	if !strings.EqualFold(strings.TrimSpace(header.Alg), "RS256") {
		return nil, ErrInvalidWebhookSignature
	}
	signature, err := enc.DecodeString(parts[2])
	if err != nil {
		return nil, ErrInvalidWebhookSignature
	}
	pub, err := parseWixRSAPublicKey([]byte(publicKeyPEM))
	if err != nil {
		return nil, ErrInvalidWebhookSignature
	}
	signingInput := []byte(parts[0] + "." + parts[1])
	digest := sha256.Sum256(signingInput)
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], signature); err != nil {
		return nil, ErrInvalidWebhookSignature
	}
	claims, err := decodeWixWebhookJWTUnverified(token)
	if err != nil {
		return nil, ErrInvalidWebhookSignature
	}
	if err := validateWixWebhookClaims(claims, now, audience); err != nil {
		return nil, err
	}
	return claims, nil
}

func decodeWixWebhookJWTUnverified(token string) (map[string]any, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return nil, ErrMissingWebhookSignature
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrInvalidWebhookSignature
	}
	var claims map[string]any
	dec := json.NewDecoder(bytes.NewReader(payloadBytes))
	dec.UseNumber()
	if err := dec.Decode(&claims); err != nil && err != io.EOF {
		return nil, ErrInvalidWebhookSignature
	}
	return nonNilMap(claims), nil
}

func validateWixWebhookClaims(claims map[string]any, now time.Time, audience string) error {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if iss := mapString(claims, "iss", "issuer"); iss != "" && iss != "wix.com" {
		return ErrInvalidWebhookSignature
	}
	if exp, ok := numericClaim(claims["exp"]); ok && now.Unix() > exp+300 {
		return ErrInvalidWebhookSignature
	}
	if iat, ok := numericClaim(claims["iat"]); ok && iat > now.Add(5*time.Minute).Unix() {
		return ErrInvalidWebhookSignature
	}
	if audience = strings.TrimSpace(audience); audience != "" {
		if rawAud, ok := claims["aud"]; ok && !claimAudienceContains(rawAud, audience) {
			return ErrInvalidWebhookSignature
		}
	}
	return nil
}

func parseWixRSAPublicKey(material []byte) (*rsa.PublicKey, error) {
	block, _ := pem.Decode(bytes.TrimSpace(material))
	if block == nil {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(material)))
		if err != nil {
			return nil, errors.New("wix webhook public key is not PEM or base64 DER")
		}
		return parseWixRSAPublicKeyDER(decoded)
	}
	switch block.Type {
	case "PUBLIC KEY":
		pub, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		key, ok := pub.(*rsa.PublicKey)
		if !ok {
			return nil, errors.New("wix webhook public key is not RSA")
		}
		return key, nil
	case "RSA PUBLIC KEY":
		return x509.ParsePKCS1PublicKey(block.Bytes)
	case "CERTIFICATE":
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, err
		}
		key, ok := cert.PublicKey.(*rsa.PublicKey)
		if !ok {
			return nil, errors.New("wix webhook certificate public key is not RSA")
		}
		return key, nil
	default:
		return nil, fmt.Errorf("unsupported Wix public key PEM type %q", block.Type)
	}
}

func parseWixRSAPublicKeyDER(der []byte) (*rsa.PublicKey, error) {
	pub, err := x509.ParsePKIXPublicKey(der)
	if err == nil {
		if key, ok := pub.(*rsa.PublicKey); ok {
			return key, nil
		}
	}
	return x509.ParsePKCS1PublicKey(der)
}

func VerifyWixWebhookSharedSecret(secret string, headers ...string) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingWebhookSecret
	}
	for _, header := range headers {
		header = strings.TrimSpace(header)
		if header == "" {
			continue
		}
		if strings.HasPrefix(strings.ToLower(header), "bearer ") {
			header = strings.TrimSpace(header[len("bearer "):])
		}
		if subtle.ConstantTimeCompare([]byte(secret), []byte(header)) == 1 {
			return nil
		}
	}
	return ErrInvalidWebhookSignature
}

func wixEmailFromInfo(info map[string]any) string {
	emails := mapAnyMap(info, "emails")
	var fallback string
	for _, item := range anySliceFromAny(emails["items"]) {
		row := anyMap(item)
		if len(row) == 0 {
			continue
		}
		email := mapString(row, "email")
		if email == "" {
			continue
		}
		if fallback == "" {
			fallback = email
		}
		if boolFromAny(row["primary"]) {
			return email
		}
	}
	return fallback
}

func wixPhoneFromInfo(info map[string]any) string {
	phones := mapAnyMap(info, "phones")
	var fallback string
	for _, item := range anySliceFromAny(phones["items"]) {
		row := anyMap(item)
		if len(row) == 0 {
			continue
		}
		phone := firstString(mapString(row, "e164Phone", "formattedPhone", "phone"))
		if phone == "" {
			continue
		}
		if fallback == "" {
			fallback = phone
		}
		if boolFromAny(row["primary"]) {
			return phone
		}
	}
	return fallback
}

func wixLeadSourceID(kind, parentID, id string) string {
	kind = strings.TrimSpace(kind)
	parentID = strings.TrimSpace(parentID)
	id = strings.TrimSpace(id)
	if kind == "" || id == "" || id == "<nil>" {
		return ""
	}
	if parentID != "" {
		return "wix://" + kind + "/" + parentID + "/" + id
	}
	return "wix://" + kind + "/" + id
}

func wixTags(integration Integration, formID, namespace string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"wix", "wix:" + formID, "wix:" + namespace} {
		if strings.TrimSpace(tag) != "wix:" && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func parseWixTime(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, raw); err == nil {
			utc := t.UTC()
			return &utc
		}
	}
	return nil
}

func wixPageSize(size int) int {
	if size <= 0 {
		return wixDefaultPageSize
	}
	if size > wixMaxPageSize {
		return wixMaxPageSize
	}
	return size
}

func mapString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if m == nil {
			continue
		}
		value, ok := m[key]
		if !ok {
			value, ok = m[strings.ToLower(key)]
		}
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case string:
			if trimmed := strings.TrimSpace(typed); trimmed != "" {
				return trimmed
			}
		case json.Number:
			if trimmed := strings.TrimSpace(typed.String()); trimmed != "" {
				return trimmed
			}
		default:
			if trimmed := strings.TrimSpace(fmt.Sprint(typed)); trimmed != "" && trimmed != "<nil>" {
				return trimmed
			}
		}
	}
	return ""
}

func mapAnyMap(m map[string]any, keys ...string) map[string]any {
	for _, key := range keys {
		value, ok := m[key]
		if !ok {
			value, ok = m[strings.ToLower(key)]
		}
		if !ok {
			continue
		}
		if out := anyMap(value); len(out) > 0 {
			return out
		}
	}
	return nil
}

func anyMap(value any) map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		return typed
	case map[string]string:
		out := make(map[string]any, len(typed))
		for k, v := range typed {
			out[k] = v
		}
		return out
	case string:
		trimmed := strings.TrimSpace(typed)
		if !strings.HasPrefix(trimmed, "{") {
			return nil
		}
		var out map[string]any
		dec := json.NewDecoder(strings.NewReader(trimmed))
		dec.UseNumber()
		if err := dec.Decode(&out); err != nil {
			return nil
		}
		return out
	default:
		return nil
	}
}

func anySliceFromAny(value any) []any {
	switch typed := value.(type) {
	case []any:
		return typed
	case []map[string]any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, item)
		}
		return out
	case []string:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, item)
		}
		return out
	default:
		return nil
	}
}

func stringSliceFromAny(value any) []string {
	items := anySliceFromAny(value)
	out := make([]string, 0, len(items))
	for _, item := range items {
		if value := strings.TrimSpace(fmt.Sprint(item)); value != "" && value != "<nil>" {
			out = append(out, value)
		}
	}
	return out
}

func boolFromAny(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		out, _ := strconv.ParseBool(strings.TrimSpace(typed))
		return out
	default:
		return false
	}
}

func firstNonEmptyMap(values ...map[string]any) map[string]any {
	for _, value := range values {
		if len(value) > 0 {
			return value
		}
	}
	return nil
}

func numericClaim(value any) (int64, bool) {
	switch typed := value.(type) {
	case json.Number:
		out, err := typed.Int64()
		return out, err == nil
	case float64:
		return int64(typed), true
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	case string:
		out, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return out, err == nil
	default:
		return 0, false
	}
}

func claimAudienceContains(raw any, audience string) bool {
	switch typed := raw.(type) {
	case string:
		return typed == audience
	case []any:
		for _, item := range typed {
			if strings.TrimSpace(fmt.Sprint(item)) == audience {
				return true
			}
		}
	case []string:
		for _, item := range typed {
			if strings.TrimSpace(item) == audience {
				return true
			}
		}
	}
	return false
}
