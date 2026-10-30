// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	landingiWebhookMaxBodySize = 2 << 20
	landingiWebhookTopic       = "lead.created"
)

type LandingiCredentials struct {
	WebhookToken string
	UserAgent    string
}

type LandingiCredentialResolver interface {
	ResolveLandingi(context.Context, string, Integration) (LandingiCredentials, error)
}

type LandingiRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type LandingiSecretsCredentialResolver struct {
	Secrets LandingiRuntimeSecretResolver
}

func NewLandingiSecretsCredentialResolver(secrets LandingiRuntimeSecretResolver) *LandingiSecretsCredentialResolver {
	return &LandingiSecretsCredentialResolver{Secrets: secrets}
}

func (r *LandingiSecretsCredentialResolver) ResolveLandingi(ctx context.Context, _ string, integration Integration) (LandingiCredentials, error) {
	if r == nil || r.Secrets == nil {
		return LandingiCredentials{}, fmt.Errorf("landingi credential resolver is not configured")
	}
	ref := landingiCredentialRef(integration)
	if ref == "" {
		return LandingiCredentials{}, fmt.Errorf("landingi credentials_ref is required")
	}
	var payload landingiCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return LandingiCredentials{}, fmt.Errorf("resolve landingi credentials %q: %w", ref, err)
		}
		return parseLandingiCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return LandingiCredentials{}, fmt.Errorf("resolve landingi credentials %q: %w", ref, err)
	}
	return parseLandingiCredentialSecret(raw)
}

type landingiCredentialPayload struct {
	WebhookToken string `json:"webhook_token"`
	RouteToken   string `json:"route_token"`
	Token        string `json:"token"`
	Secret       string `json:"secret"`
	UserAgent    string `json:"user_agent"`
}

func (p landingiCredentialPayload) credentials() (LandingiCredentials, error) {
	token := strings.TrimSpace(firstString(p.WebhookToken, p.RouteToken, p.Token, p.Secret))
	if token == "" {
		return LandingiCredentials{}, fmt.Errorf("landingi webhook_token is required")
	}
	return LandingiCredentials{WebhookToken: token, UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

func parseLandingiCredentialSecret(raw string) (LandingiCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return LandingiCredentials{}, fmt.Errorf("landingi credentials are empty")
	}
	var payload landingiCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return LandingiCredentials{}, fmt.Errorf("parse landingi credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return LandingiCredentials{}, fmt.Errorf("parse landingi credential key-value secret: %w", err)
		}
		return landingiCredentialPayload{
			WebhookToken: firstString(values.Get("webhook_token"), values.Get("route_token")),
			Token:        values.Get("token"),
			Secret:       values.Get("secret"),
			UserAgent:    values.Get("user_agent"),
		}.credentials()
	}
	return landingiCredentialPayload{WebhookToken: raw}.credentials()
}

func landingiCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) LandingiWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, landingiWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Landingi webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeLandingiWebhookPayload(r, body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	accountID := landingiAccountID(r, payload)
	if accountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "Landingi webhooks must include account_id in headers, query string, or payload")
		return
	}
	pageID := landingiPageID(r, payload)
	if pageID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_page_id", "Landingi webhooks must include page_id or landing_page_id in headers, query string, or payload")
		return
	}
	actualToken := landingiRouteToken(r, payload)
	if actualToken == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_token", "Landingi route token is required")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderAccountAndCampaign(r.Context(), ProviderLandingi, accountID, pageID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Landingi integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "Landingi integration is disconnected")
		return
	}
	formID := landingiFormID(r, payload)
	if configuredFormID := settingString(integration.Settings, "form_id"); configuredFormID != "" && formID != "" && !strings.EqualFold(configuredFormID, formID) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Landingi integration not found for form_id")
		return
	}
	resolver := d.landingiCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Landingi credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveLandingi(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyLandingiWebhookToken(creds.WebhookToken, actualToken); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_token", "request authentication failed")
		return
	}
	webhookID := landingiWebhookID(payload, accountID, pageID)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderLandingi, webhookID, landingiWebhookTopic, body)
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
	submission := mapLandingiWebhookSubmission(payload, accountID, pageID, firstString(formID, settingString(integration.Settings, "form_id")), webhookID, *integration)
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "landingi-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderLandingi, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "landingi webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderLandingi, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderLandingi, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifyLandingiWebhookToken(expected, actual string) error {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	if expected == "" {
		return fmt.Errorf("landingi webhook token is not configured")
	}
	if actual == "" {
		return fmt.Errorf("landingi webhook token is required")
	}
	if !hmac.Equal([]byte(expected), []byte(actual)) {
		return fmt.Errorf("landingi webhook token does not match")
	}
	return nil
}

type landingiWebhookPayload struct {
	BodyFields  map[string]any
	QueryFields map[string]any
	Raw         map[string]any
	RawBody     []byte
	Method      string
	ContentType string
}

func decodeLandingiWebhookPayload(r *http.Request, body []byte) (landingiWebhookPayload, error) {
	payload := landingiWebhookPayload{
		BodyFields:  map[string]any{},
		QueryFields: carrdValuesToMap(r.URL.Query()),
		RawBody:     append([]byte(nil), body...),
		Method:      r.Method,
		ContentType: r.Header.Get("Content-Type"),
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		fields, err := decodeCarrdBody(r.Header.Get("Content-Type"), body)
		if err != nil {
			return landingiWebhookPayload{}, fmt.Errorf("decode Landingi webhook payload: %w", err)
		}
		payload.BodyFields = fields
	}
	payload.Raw = map[string]any{
		"method":       payload.Method,
		"content_type": payload.ContentType,
		"query":        landingiRedactedMap(payload.QueryFields),
		"body":         landingiRedactedMap(payload.BodyFields),
	}
	return payload, nil
}

func landingiAccountID(r *http.Request, payload landingiWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Account-ID"),
		r.Header.Get("X-Landingi-Account-ID"),
		r.URL.Query().Get("account_id"),
		r.URL.Query().Get("provider_account_id"),
		mapString(payload.BodyFields, "account_id", "provider_account_id", "landingi_account_id"),
	)
}

func landingiPageID(r *http.Request, payload landingiWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Page-ID"),
		r.Header.Get("X-Landingi-Page-ID"),
		r.URL.Query().Get("page_id"),
		r.URL.Query().Get("landing_page_id"),
		r.URL.Query().Get("landing_id"),
		mapString(payload.BodyFields, "page_id", "landing_page_id", "landingId", "landing_id", "page"),
	)
}

func landingiFormID(r *http.Request, payload landingiWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Form-ID"),
		r.Header.Get("X-Landingi-Form-ID"),
		r.URL.Query().Get("form_id"),
		r.URL.Query().Get("form"),
		mapString(payload.BodyFields, "form_id", "form", "formId", "landingi_form_id"),
	)
}

func landingiRouteToken(r *http.Request, payload landingiWebhookPayload) string {
	return firstString(
		bearerToken(r.Header.Get("Authorization")),
		r.Header.Get("X-Postwave-Webhook-Token"),
		r.Header.Get("X-Postwave-Token"),
		r.Header.Get("X-Landingi-Webhook-Token"),
		r.URL.Query().Get("token"),
		r.URL.Query().Get("webhook_token"),
		r.URL.Query().Get("route_token"),
		r.URL.Query().Get("postwave_token"),
		r.URL.Query().Get("landingi_token"),
		mapString(payload.BodyFields, "token", "webhook_token", "route_token", "postwave_token", "landingi_token"),
	)
}

func landingiWebhookID(payload landingiWebhookPayload, accountID, pageID string) string {
	if id := firstString(
		mapString(payload.BodyFields, "lead_id", "leadId", "submission_id", "submissionId", "entry_id", "entryId", "contact_id", "contactId", "id", "guid"),
		mapString(payload.QueryFields, "lead_id", "leadId", "submission_id", "submissionId", "entry_id", "entryId", "contact_id", "contactId", "id", "guid"),
	); id != "" {
		return "landingi_" + normalizeTypeformIdentityKey(id)
	}
	sum := sha256.Sum256([]byte(accountID + "\n" + pageID + "\n" + landingiCanonicalWebhookFields(payload)))
	return "landingi_local_" + hex.EncodeToString(sum[:16])
}

func landingiCanonicalWebhookFields(payload landingiWebhookPayload) string {
	fields := landingiMergedSubmissionFields(payload)
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if landingiSecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(fields[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func mapLandingiWebhookSubmission(payload landingiWebhookPayload, accountID, pageID, formID, webhookID string, integration Integration) SubmissionInput {
	fields := map[string]any{
		"landingi_account_id":   accountID,
		"landingi_page_id":      pageID,
		"landingi_webhook_id":   webhookID,
		"landingi_provider_raw": payload.Raw,
	}
	if formID != "" {
		fields["landingi_form_id"] = formID
	}
	if len(payload.QueryFields) > 0 {
		fields["landingi_query"] = landingiRedactedMap(payload.QueryFields)
	}
	identity := typeformIdentity{}
	for key, value := range landingiMergedSubmissionFields(payload) {
		if landingiControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := carrdNormalizeValue(value)
		fields["landingi_field."+normalizedKey] = normalizedValue
		identity.apply(key, carrdIdentityText(normalizedValue))
	}
	landingiApplyConfiguredIdentity(&identity, integration, payload)
	submittedAt := parseFilloutTime(firstString(
		landingiConfiguredFieldString(integration, payload, "submitted_at_field_key"),
		mapString(payload.BodyFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date"),
		mapString(payload.QueryFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date"),
	))
	formName := firstString(
		settingString(integration.Settings, "form_name"),
		settingString(integration.Settings, "page_name"),
		mapString(payload.BodyFields, "form_name", "page_name", "landing_page_name"),
		mapString(payload.QueryFields, "form_name", "page_name", "landing_page_name"),
		formID,
		pageID,
	)
	return SubmissionInput{
		SourceID:    landingiSourceID(accountID, pageID, webhookID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      firstString(formID, pageID),
		FormName:    formName,
		EventName:   "lead.submitted",
		Tags:        landingiTags(integration, accountID, pageID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func landingiMergedSubmissionFields(payload landingiWebhookPayload) map[string]any {
	out := make(map[string]any, len(payload.QueryFields)+len(payload.BodyFields))
	for key, value := range payload.QueryFields {
		out[key] = value
	}
	for key, value := range payload.BodyFields {
		out[key] = value
	}
	return out
}

func landingiApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, payload landingiWebhookPayload) {
	if identity == nil {
		return
	}
	for _, item := range []struct {
		setting string
		apply   func(string)
	}{
		{"email_field_key", func(v string) { identity.Email = firstString(identity.Email, v) }},
		{"first_name_field_key", func(v string) { identity.FirstName = firstString(identity.FirstName, v) }},
		{"last_name_field_key", func(v string) { identity.LastName = firstString(identity.LastName, v) }},
		{"full_name_field_key", func(v string) { identity.FullName = firstString(identity.FullName, v) }},
		{"phone_field_key", func(v string) { identity.Phone = firstString(identity.Phone, v) }},
		{"company_field_key", func(v string) { identity.Company = firstString(identity.Company, v) }},
	} {
		if value := landingiConfiguredFieldString(integration, payload, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func landingiConfiguredFieldString(integration Integration, payload landingiWebhookPayload, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	fields := landingiMergedSubmissionFields(payload)
	for key, value := range fields {
		if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
			return carrdIdentityText(value)
		}
	}
	return ""
}

func landingiControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "token", "webhook_token", "route_token", "postwave_token", "landingi_token", "secret", "password", "account_id", "provider_account_id", "landingi_account_id", "page_id", "landing_page_id", "landing_id", "page", "form_id", "form", "landingi_form_id":
		return true
	default:
		return landingiSecretLikeKey(key)
	}
}

func landingiSecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") || strings.Contains(key, "secret") || strings.Contains(key, "password")
}

func landingiRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if landingiSecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = carrdNormalizeValue(value)
	}
	return out
}

func landingiTags(integration Integration, accountID, pageID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"landingi", "landingi:" + accountID, "landingi:page:" + pageID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func landingiSourceID(accountID, pageID, webhookID string) string {
	accountID = strings.TrimSpace(accountID)
	pageID = strings.TrimSpace(pageID)
	webhookID = strings.TrimSpace(webhookID)
	return "landingi://lead/" + accountID + "/" + pageID + "/" + webhookID
}
