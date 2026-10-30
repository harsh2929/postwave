// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
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
	shortStackWebhookMaxBodySize = 2 << 20
	shortStackWebhookTopic       = "entry.created"
)

type ShortStackCredentials struct {
	WebhookSecret string
	UserAgent     string
}

type ShortStackCredentialResolver interface {
	ResolveShortStack(context.Context, string, Integration) (ShortStackCredentials, error)
}

type ShortStackRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type ShortStackSecretsCredentialResolver struct {
	Secrets ShortStackRuntimeSecretResolver
}

func NewShortStackSecretsCredentialResolver(secrets ShortStackRuntimeSecretResolver) *ShortStackSecretsCredentialResolver {
	return &ShortStackSecretsCredentialResolver{Secrets: secrets}
}

func (r *ShortStackSecretsCredentialResolver) ResolveShortStack(ctx context.Context, _ string, integration Integration) (ShortStackCredentials, error) {
	if r == nil || r.Secrets == nil {
		return ShortStackCredentials{}, fmt.Errorf("shortstack credential resolver is not configured")
	}
	ref := shortStackCredentialRef(integration)
	if ref == "" {
		return ShortStackCredentials{}, fmt.Errorf("shortstack credentials_ref is required")
	}
	var payload shortStackCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return ShortStackCredentials{}, fmt.Errorf("resolve shortstack credentials %q: %w", ref, err)
		}
		return parseShortStackCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return ShortStackCredentials{}, fmt.Errorf("resolve shortstack credentials %q: %w", ref, err)
	}
	return parseShortStackCredentialSecret(raw)
}

type shortStackCredentialPayload struct {
	WebhookSecret string `json:"webhook_secret"`
	SigningSecret string `json:"signing_secret"`
	SecretKey     string `json:"secret_key"`
	Secret        string `json:"secret"`
	UserAgent     string `json:"user_agent"`
}

func (p shortStackCredentialPayload) credentials() (ShortStackCredentials, error) {
	secret := strings.TrimSpace(firstString(p.WebhookSecret, p.SigningSecret, p.SecretKey, p.Secret))
	if secret == "" {
		return ShortStackCredentials{}, fmt.Errorf("shortstack webhook_secret is required")
	}
	return ShortStackCredentials{WebhookSecret: secret, UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

func parseShortStackCredentialSecret(raw string) (ShortStackCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ShortStackCredentials{}, fmt.Errorf("shortstack credentials are empty")
	}
	var payload shortStackCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return ShortStackCredentials{}, fmt.Errorf("parse shortstack credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return ShortStackCredentials{}, fmt.Errorf("parse shortstack credential key-value secret: %w", err)
		}
		return shortStackCredentialPayload{
			WebhookSecret: values.Get("webhook_secret"),
			SigningSecret: values.Get("signing_secret"),
			SecretKey:     values.Get("secret_key"),
			Secret:        values.Get("secret"),
			UserAgent:     values.Get("user_agent"),
		}.credentials()
	}
	return shortStackCredentialPayload{WebhookSecret: raw}.credentials()
}

func shortStackCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) ShortStackWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, shortStackWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "ShortStack webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeShortStackWebhookPayload(r, body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	accountID := shortStackAccountID(r, payload)
	if accountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "ShortStack webhooks must include account_id in headers, query string, or payload")
		return
	}
	campaignID := shortStackCampaignID(r, payload)
	if campaignID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_campaign_id", "ShortStack webhooks must include campaign_id in headers, query string, or payload")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderAccountAndCampaign(r.Context(), ProviderShortStack, accountID, campaignID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "ShortStack integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "ShortStack integration is disconnected")
		return
	}
	formID := shortStackFormID(r, payload)
	if configuredFormID := settingString(integration.Settings, "form_id"); configuredFormID != "" && formID != "" && !strings.EqualFold(configuredFormID, formID) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "ShortStack integration not found for form_id")
		return
	}
	resolver := d.shortStackCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "ShortStack credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveShortStack(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyShortStackWebhookSignature(creds.WebhookSecret, shortStackSignature(r), body); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	webhookID := shortStackWebhookID(payload, accountID, campaignID)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderShortStack, webhookID, shortStackWebhookTopic, body)
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
	submission := mapShortStackWebhookSubmission(payload, accountID, campaignID, firstString(formID, settingString(integration.Settings, "form_id")), webhookID, *integration)
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "shortstack-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderShortStack, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "shortstack webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderShortStack, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderShortStack, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifyShortStackWebhookSignature(secret, actual string, body []byte) error {
	secret = strings.TrimSpace(secret)
	actual = strings.TrimSpace(actual)
	if secret == "" {
		return fmt.Errorf("shortstack webhook secret is not configured")
	}
	if actual == "" {
		return fmt.Errorf("shortstack webhook signature is required")
	}
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write(body)
	expected := "sha1=" + hex.EncodeToString(mac.Sum(nil))
	actual = strings.ToLower(actual)
	if !strings.HasPrefix(actual, "sha1=") {
		actual = "sha1=" + actual
	}
	if !hmac.Equal([]byte(expected), []byte(actual)) {
		return fmt.Errorf("shortstack webhook signature does not match")
	}
	return nil
}

type shortStackWebhookPayload struct {
	BodyFields  map[string]any
	QueryFields map[string]any
	Raw         map[string]any
	RawBody     []byte
	Method      string
	ContentType string
}

func decodeShortStackWebhookPayload(r *http.Request, body []byte) (shortStackWebhookPayload, error) {
	payload := shortStackWebhookPayload{
		BodyFields:  map[string]any{},
		QueryFields: carrdValuesToMap(r.URL.Query()),
		RawBody:     append([]byte(nil), body...),
		Method:      r.Method,
		ContentType: r.Header.Get("Content-Type"),
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		fields, err := decodeCarrdBody(r.Header.Get("Content-Type"), body)
		if err != nil {
			return shortStackWebhookPayload{}, fmt.Errorf("decode ShortStack webhook payload: %w", err)
		}
		payload.BodyFields = fields
	}
	payload.Raw = map[string]any{
		"method":       payload.Method,
		"content_type": payload.ContentType,
		"query":        shortStackRedactedMap(payload.QueryFields),
		"body":         shortStackRedactedMap(payload.BodyFields),
	}
	return payload, nil
}

func shortStackAccountID(r *http.Request, payload shortStackWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Account-ID"),
		r.Header.Get("X-ShortStack-Account-ID"),
		r.URL.Query().Get("account_id"),
		r.URL.Query().Get("provider_account_id"),
		mapString(payload.BodyFields, "account_id", "provider_account_id", "shortstack_account_id"),
	)
}

func shortStackCampaignID(r *http.Request, payload shortStackWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Campaign-ID"),
		r.Header.Get("X-ShortStack-Campaign-ID"),
		r.URL.Query().Get("campaign_id"),
		r.URL.Query().Get("campaign"),
		mapString(payload.BodyFields, "campaign_id", "campaign", "campaignId", "shortstack_campaign_id"),
	)
}

func shortStackFormID(r *http.Request, payload shortStackWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Form-ID"),
		r.Header.Get("X-ShortStack-Form-ID"),
		r.URL.Query().Get("form_id"),
		r.URL.Query().Get("form"),
		mapString(payload.BodyFields, "form_id", "form", "formId", "shortstack_form_id"),
	)
}

func shortStackSignature(r *http.Request) string {
	return firstString(
		r.Header.Get("X-SS-Signature"),
		r.Header.Get("X-Ss-Signature"),
		r.Header.Get("X-ShortStack-Signature"),
		r.Header.Get("X-Shortstack-Signature"),
	)
}

func shortStackWebhookID(payload shortStackWebhookPayload, accountID, campaignID string) string {
	if id := firstString(
		mapString(payload.BodyFields, "entry_id", "entryId", "submission_id", "submissionId", "lead_id", "leadId", "contact_id", "contactId", "id", "guid"),
		mapString(payload.QueryFields, "entry_id", "entryId", "submission_id", "submissionId", "lead_id", "leadId", "contact_id", "contactId", "id", "guid"),
	); id != "" {
		return "shortstack_" + normalizeTypeformIdentityKey(id)
	}
	sum := sha256.Sum256([]byte(accountID + "\n" + campaignID + "\n" + shortStackCanonicalWebhookFields(payload)))
	return "shortstack_local_" + hex.EncodeToString(sum[:16])
}

func shortStackCanonicalWebhookFields(payload shortStackWebhookPayload) string {
	fields := shortStackMergedSubmissionFields(payload)
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if shortStackSecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(fields[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func mapShortStackWebhookSubmission(payload shortStackWebhookPayload, accountID, campaignID, formID, webhookID string, integration Integration) SubmissionInput {
	fields := map[string]any{
		"shortstack_account_id":   accountID,
		"shortstack_campaign_id":  campaignID,
		"shortstack_webhook_id":   webhookID,
		"shortstack_provider_raw": payload.Raw,
	}
	if formID != "" {
		fields["shortstack_form_id"] = formID
	}
	if len(payload.QueryFields) > 0 {
		fields["shortstack_query"] = shortStackRedactedMap(payload.QueryFields)
	}
	identity := typeformIdentity{}
	for key, value := range shortStackMergedSubmissionFields(payload) {
		if shortStackControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := carrdNormalizeValue(value)
		fields["shortstack_field."+normalizedKey] = normalizedValue
		identity.apply(key, carrdIdentityText(normalizedValue))
	}
	shortStackApplyConfiguredIdentity(&identity, integration, payload)
	submittedAt := parseFilloutTime(firstString(
		shortStackConfiguredFieldString(integration, payload, "submitted_at_field_key"),
		mapString(payload.BodyFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "received", "date"),
		mapString(payload.QueryFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "received", "date"),
	))
	formName := firstString(
		settingString(integration.Settings, "form_name"),
		settingString(integration.Settings, "campaign_name"),
		mapString(payload.BodyFields, "form_name", "campaign_name", "campaign"),
		mapString(payload.QueryFields, "form_name", "campaign_name", "campaign"),
		formID,
		campaignID,
	)
	return SubmissionInput{
		SourceID:    shortStackSourceID(accountID, campaignID, webhookID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      firstString(formID, campaignID),
		FormName:    formName,
		EventName:   "entry.submitted",
		Tags:        shortStackTags(integration, accountID, campaignID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func shortStackMergedSubmissionFields(payload shortStackWebhookPayload) map[string]any {
	out := make(map[string]any, len(payload.QueryFields)+len(payload.BodyFields))
	for key, value := range payload.QueryFields {
		out[key] = value
	}
	for key, value := range payload.BodyFields {
		out[key] = value
	}
	return out
}

func shortStackApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, payload shortStackWebhookPayload) {
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
		if value := shortStackConfiguredFieldString(integration, payload, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func shortStackConfiguredFieldString(integration Integration, payload shortStackWebhookPayload, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	fields := shortStackMergedSubmissionFields(payload)
	for key, value := range fields {
		if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
			return carrdIdentityText(value)
		}
	}
	return ""
}

func shortStackControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "webhooktoken", "webhook_token", "token", "secret", "secret_key", "signing_secret", "webhook_secret", "account_id", "provider_account_id", "shortstack_account_id", "campaign_id", "campaign", "shortstack_campaign_id", "form_id", "form", "shortstack_form_id":
		return true
	default:
		return shortStackSecretLikeKey(key)
	}
}

func shortStackSecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") || strings.Contains(key, "secret") || strings.Contains(key, "password") || strings.Contains(key, "signature")
}

func shortStackRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if shortStackSecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = carrdNormalizeValue(value)
	}
	return out
}

func shortStackTags(integration Integration, accountID, campaignID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"shortstack", "shortstack:" + accountID, "shortstack:campaign:" + campaignID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func shortStackSourceID(accountID, campaignID, webhookID string) string {
	accountID = strings.TrimSpace(accountID)
	campaignID = strings.TrimSpace(campaignID)
	webhookID = strings.TrimSpace(webhookID)
	return "shortstack://entry/" + accountID + "/" + campaignID + "/" + webhookID
}
