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
	ninjaFormsWebhookMaxBodySize = 2 << 20
	ninjaFormsWebhookTopic       = "submission.created"
)

type NinjaFormsCredentials struct {
	WebhookToken string
	UserAgent    string
}

type NinjaFormsCredentialResolver interface {
	ResolveNinjaForms(context.Context, string, Integration) (NinjaFormsCredentials, error)
}

type NinjaFormsRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type NinjaFormsSecretsCredentialResolver struct {
	Secrets NinjaFormsRuntimeSecretResolver
}

func NewNinjaFormsSecretsCredentialResolver(secrets NinjaFormsRuntimeSecretResolver) *NinjaFormsSecretsCredentialResolver {
	return &NinjaFormsSecretsCredentialResolver{Secrets: secrets}
}

func (r *NinjaFormsSecretsCredentialResolver) ResolveNinjaForms(ctx context.Context, _ string, integration Integration) (NinjaFormsCredentials, error) {
	if r == nil || r.Secrets == nil {
		return NinjaFormsCredentials{}, fmt.Errorf("ninja forms credential resolver is not configured")
	}
	ref := ninjaFormsCredentialRef(integration)
	if ref == "" {
		return NinjaFormsCredentials{}, fmt.Errorf("ninja forms credentials_ref is required")
	}
	var payload ninjaFormsCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return NinjaFormsCredentials{}, fmt.Errorf("resolve ninja forms credentials %q: %w", ref, err)
		}
		return parseNinjaFormsCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return NinjaFormsCredentials{}, fmt.Errorf("resolve ninja forms credentials %q: %w", ref, err)
	}
	return parseNinjaFormsCredentialSecret(raw)
}

type ninjaFormsCredentialPayload struct {
	WebhookToken string `json:"webhook_token"`
	RouteToken   string `json:"route_token"`
	Token        string `json:"token"`
	Secret       string `json:"secret"`
	UserAgent    string `json:"user_agent"`
}

func (p ninjaFormsCredentialPayload) credentials() (NinjaFormsCredentials, error) {
	token := strings.TrimSpace(firstString(p.WebhookToken, p.RouteToken, p.Token, p.Secret))
	if token == "" {
		return NinjaFormsCredentials{}, fmt.Errorf("ninja forms webhook_token is required")
	}
	return NinjaFormsCredentials{WebhookToken: token, UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

func parseNinjaFormsCredentialSecret(raw string) (NinjaFormsCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return NinjaFormsCredentials{}, fmt.Errorf("ninja forms credentials are empty")
	}
	var payload ninjaFormsCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return NinjaFormsCredentials{}, fmt.Errorf("parse ninja forms credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return NinjaFormsCredentials{}, fmt.Errorf("parse ninja forms credential key-value secret: %w", err)
		}
		return ninjaFormsCredentialPayload{
			WebhookToken: firstString(values.Get("webhook_token"), values.Get("route_token")),
			Token:        values.Get("token"),
			Secret:       values.Get("secret"),
			UserAgent:    values.Get("user_agent"),
		}.credentials()
	}
	return ninjaFormsCredentialPayload{WebhookToken: raw}.credentials()
}

func ninjaFormsCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) NinjaFormsWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, ninjaFormsWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Ninja Forms webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeNinjaFormsWebhookPayload(r, body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	siteURL := ninjaFormsSiteURL(r, payload)
	if siteURL == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_site_url", "Ninja Forms webhooks must include site_url in the query string, headers, or payload")
		return
	}
	formID := ninjaFormsFormID(r, payload)
	if formID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_form_id", "Ninja Forms webhooks must include form_id in the query string, headers, or payload")
		return
	}
	actualToken := ninjaFormsRouteToken(r, payload)
	if actualToken == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_token", "Ninja Forms route token is required")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderSiteAndForm(r.Context(), ProviderNinjaForms, siteURL, formID, "")
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Ninja Forms integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "Ninja Forms integration is disconnected")
		return
	}
	resolver := d.ninjaFormsCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Ninja Forms credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveNinjaForms(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyNinjaFormsWebhookToken(creds.WebhookToken, actualToken); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_token", "request authentication failed")
		return
	}
	webhookID := ninjaFormsWebhookID(payload, siteURL, formID)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderNinjaForms, webhookID, ninjaFormsWebhookTopic, body)
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
	submission := mapNinjaFormsWebhookSubmission(payload, siteURL, formID, webhookID, *integration)
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "ninja-forms-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderNinjaForms, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "ninja forms webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderNinjaForms, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderNinjaForms, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifyNinjaFormsWebhookToken(expected, actual string) error {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	if expected == "" {
		return fmt.Errorf("ninja forms webhook token is not configured")
	}
	if actual == "" {
		return fmt.Errorf("ninja forms webhook token is required")
	}
	if !hmac.Equal([]byte(expected), []byte(actual)) {
		return fmt.Errorf("ninja forms webhook token does not match")
	}
	return nil
}

type ninjaFormsWebhookPayload struct {
	BodyFields  map[string]any
	QueryFields map[string]any
	Raw         map[string]any
	RawBody     []byte
	Method      string
	ContentType string
}

func decodeNinjaFormsWebhookPayload(r *http.Request, body []byte) (ninjaFormsWebhookPayload, error) {
	payload := ninjaFormsWebhookPayload{
		BodyFields:  map[string]any{},
		QueryFields: carrdValuesToMap(r.URL.Query()),
		RawBody:     append([]byte(nil), body...),
		Method:      r.Method,
		ContentType: r.Header.Get("Content-Type"),
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		fields, err := decodeCarrdBody(r.Header.Get("Content-Type"), body)
		if err != nil {
			return ninjaFormsWebhookPayload{}, fmt.Errorf("decode Ninja Forms webhook payload: %w", err)
		}
		payload.BodyFields = fields
	}
	payload.Raw = map[string]any{
		"method":       payload.Method,
		"content_type": payload.ContentType,
		"query":        ninjaFormsRedactedMap(payload.QueryFields),
		"body":         ninjaFormsRedactedMap(payload.BodyFields),
	}
	return payload, nil
}

func ninjaFormsSiteURL(r *http.Request, payload ninjaFormsWebhookPayload) string {
	return normalizeNinjaFormsSiteURL(firstString(
		r.Header.Get("X-Postwave-Site-URL"),
		r.Header.Get("X-NinjaForms-Site-URL"),
		r.URL.Query().Get("site_url"),
		r.URL.Query().Get("wordpress_site_url"),
		r.URL.Query().Get("provider_site_url"),
		mapString(payload.BodyFields, "site_url", "siteUrl", "wordpress_site_url", "wordpressSiteUrl", "provider_site_url", "providerSiteUrl", "url"),
	))
}

func ninjaFormsFormID(r *http.Request, payload ninjaFormsWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Form-ID"),
		r.Header.Get("X-NinjaForms-Form-ID"),
		r.URL.Query().Get("form_id"),
		r.URL.Query().Get("form"),
		r.URL.Query().Get("ninja_forms_form_id"),
		r.URL.Query().Get("ninja_form_id"),
		mapString(payload.BodyFields, "form_id", "formId", "form", "ninja_forms_form_id", "ninjaFormsFormId", "ninja_form_id", "ninjaFormId"),
	)
}

func ninjaFormsRouteToken(r *http.Request, payload ninjaFormsWebhookPayload) string {
	return firstString(
		bearerToken(r.Header.Get("Authorization")),
		r.Header.Get("X-Postwave-Webhook-Token"),
		r.Header.Get("X-Postwave-Token"),
		r.Header.Get("X-NinjaForms-Webhook-Token"),
		r.URL.Query().Get("token"),
		r.URL.Query().Get("webhook_token"),
		r.URL.Query().Get("route_token"),
		r.URL.Query().Get("postwave_token"),
		r.URL.Query().Get("ninja_forms_token"),
		mapString(payload.BodyFields, "token", "webhook_token", "route_token", "postwave_token", "ninja_forms_token"),
	)
}

func ninjaFormsWebhookID(payload ninjaFormsWebhookPayload, siteURL, formID string) string {
	if id := firstString(
		mapString(payload.BodyFields, "submission_id", "submissionId", "entry_id", "entryId", "lead_id", "leadId", "webhook_id", "webhookId", "id", "uuid"),
		mapString(payload.QueryFields, "submission_id", "submissionId", "entry_id", "entryId", "lead_id", "leadId", "webhook_id", "webhookId", "id", "uuid"),
	); id != "" {
		return "ninja_forms_" + normalizeTypeformIdentityKey(id)
	}
	if email := firstString(mapString(payload.BodyFields, "email"), mapString(payload.QueryFields, "email")); email != "" {
		return "ninja_forms_" + normalizeTypeformIdentityKey(email)
	}
	sum := sha256.Sum256([]byte(siteURL + "\n" + formID + "\n" + ninjaFormsCanonicalWebhookFields(payload)))
	return "ninja_forms_local_" + hex.EncodeToString(sum[:16])
}

func ninjaFormsCanonicalWebhookFields(payload ninjaFormsWebhookPayload) string {
	fields := ninjaFormsMergedSubmissionFields(payload)
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if ninjaFormsSecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(fields[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func mapNinjaFormsWebhookSubmission(payload ninjaFormsWebhookPayload, siteURL, formID, webhookID string, integration Integration) SubmissionInput {
	fields := map[string]any{
		"ninja_forms_site_url":      siteURL,
		"ninja_forms_form_id":       formID,
		"ninja_forms_webhook_id":    webhookID,
		"ninja_forms_webhook_topic": ninjaFormsWebhookTopic,
		"ninja_forms_provider_raw":  payload.Raw,
	}
	if len(payload.QueryFields) > 0 {
		fields["ninja_forms_query"] = ninjaFormsRedactedMap(payload.QueryFields)
	}
	identity := typeformIdentity{}
	for key, value := range ninjaFormsMergedSubmissionFields(payload) {
		if ninjaFormsControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := carrdNormalizeValue(value)
		fields["ninja_forms_field."+normalizedKey] = normalizedValue
		identity.apply(key, carrdIdentityText(normalizedValue))
	}
	ninjaFormsApplyConfiguredIdentity(&identity, integration, payload)
	submittedAt := parseFilloutTime(firstString(
		ninjaFormsConfiguredFieldString(integration, payload, "submitted_at_field_key"),
		mapString(payload.BodyFields, "submitted_at", "submittedAt", "created_at", "createdAt", "date", "timestamp"),
		mapString(payload.QueryFields, "submitted_at", "submittedAt", "created_at", "createdAt", "date", "timestamp"),
	))
	formName := firstString(
		settingString(integration.Settings, "form_name"),
		mapString(payload.BodyFields, "form_name", "formName", "ninja_forms_form_name"),
		mapString(payload.QueryFields, "form_name", "formName", "ninja_forms_form_name"),
		formID,
	)
	return SubmissionInput{
		SourceID:    ninjaFormsSourceID(siteURL, formID, webhookID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    formName,
		EventName:   "lead.submitted",
		Tags:        ninjaFormsTags(integration, siteURL, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func ninjaFormsMergedSubmissionFields(payload ninjaFormsWebhookPayload) map[string]any {
	out := make(map[string]any, len(payload.QueryFields)+len(payload.BodyFields))
	for key, value := range payload.QueryFields {
		out[key] = value
	}
	for key, value := range payload.BodyFields {
		out[key] = value
	}
	if nested, ok := payload.BodyFields["fields"].(map[string]any); ok {
		for key, value := range nested {
			if _, exists := out[key]; !exists {
				out[key] = value
			}
		}
	}
	return out
}

func ninjaFormsApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, payload ninjaFormsWebhookPayload) {
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
		if value := ninjaFormsConfiguredFieldString(integration, payload, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func ninjaFormsConfiguredFieldString(integration Integration, payload ninjaFormsWebhookPayload, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	fields := ninjaFormsMergedSubmissionFields(payload)
	for key, value := range fields {
		if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
			return carrdIdentityText(value)
		}
	}
	return ""
}

func ninjaFormsControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "token", "webhook_token", "route_token", "postwave_token", "ninja_forms_token", "secret", "password", "site_url", "siteurl", "wordpress_site_url", "provider_site_url", "form_id", "formid", "form", "ninja_forms_form_id", "ninja_form_id":
		return true
	default:
		return ninjaFormsSecretLikeKey(key)
	}
}

func ninjaFormsSecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") || strings.Contains(key, "secret") || strings.Contains(key, "password")
}

func ninjaFormsRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if ninjaFormsSecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = carrdNormalizeValue(value)
	}
	return out
}

func ninjaFormsTags(integration Integration, siteURL, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	siteTag := normalizeTypeformIdentityKey(strings.TrimPrefix(strings.TrimPrefix(siteURL, "https://"), "http://"))
	for _, tag := range []string{"ninja-forms", "ninja-forms:" + siteTag, "ninja-forms:form:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func ninjaFormsSourceID(siteURL, formID, webhookID string) string {
	return "ninja-forms://submission/" + url.PathEscape(normalizeNinjaFormsSiteURL(siteURL)) + "/" + url.PathEscape(strings.TrimSpace(formID)) + "/" + url.PathEscape(strings.TrimSpace(webhookID))
}

func normalizeNinjaFormsSiteURL(raw string) string {
	return strings.TrimRight(strings.TrimSpace(raw), "/")
}
