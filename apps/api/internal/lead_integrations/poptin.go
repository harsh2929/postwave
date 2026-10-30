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
	poptinWebhookMaxBodySize = 2 << 20
	poptinWebhookTopic       = "lead.created"
)

type PoptinCredentials struct {
	WebhookToken string
	UserAgent    string
}

type PoptinCredentialResolver interface {
	ResolvePoptin(context.Context, string, Integration) (PoptinCredentials, error)
}

type PoptinRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type PoptinSecretsCredentialResolver struct {
	Secrets PoptinRuntimeSecretResolver
}

func NewPoptinSecretsCredentialResolver(secrets PoptinRuntimeSecretResolver) *PoptinSecretsCredentialResolver {
	return &PoptinSecretsCredentialResolver{Secrets: secrets}
}

func (r *PoptinSecretsCredentialResolver) ResolvePoptin(ctx context.Context, _ string, integration Integration) (PoptinCredentials, error) {
	if r == nil || r.Secrets == nil {
		return PoptinCredentials{}, fmt.Errorf("poptin credential resolver is not configured")
	}
	ref := poptinCredentialRef(integration)
	if ref == "" {
		return PoptinCredentials{}, fmt.Errorf("poptin credentials_ref is required")
	}
	var payload poptinCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return PoptinCredentials{}, fmt.Errorf("resolve poptin credentials %q: %w", ref, err)
		}
		return parsePoptinCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return PoptinCredentials{}, fmt.Errorf("resolve poptin credentials %q: %w", ref, err)
	}
	return parsePoptinCredentialSecret(raw)
}

type poptinCredentialPayload struct {
	WebhookToken string `json:"webhook_token"`
	RouteToken   string `json:"route_token"`
	Token        string `json:"token"`
	Secret       string `json:"secret"`
	UserAgent    string `json:"user_agent"`
}

func (p poptinCredentialPayload) credentials() (PoptinCredentials, error) {
	token := strings.TrimSpace(firstString(p.WebhookToken, p.RouteToken, p.Token, p.Secret))
	if token == "" {
		return PoptinCredentials{}, fmt.Errorf("poptin webhook_token is required")
	}
	return PoptinCredentials{WebhookToken: token, UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

func parsePoptinCredentialSecret(raw string) (PoptinCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return PoptinCredentials{}, fmt.Errorf("poptin credentials are empty")
	}
	var payload poptinCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return PoptinCredentials{}, fmt.Errorf("parse poptin credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return PoptinCredentials{}, fmt.Errorf("parse poptin credential key-value secret: %w", err)
		}
		return poptinCredentialPayload{
			WebhookToken: firstString(values.Get("webhook_token"), values.Get("route_token")),
			Token:        values.Get("token"),
			Secret:       values.Get("secret"),
			UserAgent:    values.Get("user_agent"),
		}.credentials()
	}
	return poptinCredentialPayload{WebhookToken: raw}.credentials()
}

func poptinCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) PoptinWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, poptinWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Poptin webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodePoptinWebhookPayload(r, body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	accountID := poptinAccountID(r, payload)
	if accountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "Poptin webhooks must include account_id in the query string, headers, or payload")
		return
	}
	popupID := poptinPopupID(r, payload)
	if popupID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_popup_id", "Poptin webhooks must include popup_id, campaign_id, or form_id in the query string, headers, or payload")
		return
	}
	actualToken := poptinRouteToken(r, payload)
	if actualToken == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_token", "Poptin route token is required")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderAccountAndCampaign(r.Context(), ProviderPoptin, accountID, popupID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Poptin integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "Poptin integration is disconnected")
		return
	}
	resolver := d.poptinCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Poptin credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolvePoptin(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyPoptinWebhookToken(creds.WebhookToken, actualToken); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_token", "request authentication failed")
		return
	}
	webhookID := poptinWebhookID(payload, accountID, popupID)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderPoptin, webhookID, poptinWebhookTopic, body)
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
	submission := mapPoptinWebhookSubmission(payload, accountID, popupID, webhookID, *integration)
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "poptin-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderPoptin, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "poptin webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderPoptin, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderPoptin, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifyPoptinWebhookToken(expected, actual string) error {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	if expected == "" {
		return fmt.Errorf("poptin webhook token is not configured")
	}
	if actual == "" {
		return fmt.Errorf("poptin webhook token is required")
	}
	if !hmac.Equal([]byte(expected), []byte(actual)) {
		return fmt.Errorf("poptin webhook token does not match")
	}
	return nil
}

type poptinWebhookPayload struct {
	BodyFields  map[string]any
	QueryFields map[string]any
	Raw         map[string]any
	RawBody     []byte
	Method      string
	ContentType string
}

func decodePoptinWebhookPayload(r *http.Request, body []byte) (poptinWebhookPayload, error) {
	payload := poptinWebhookPayload{
		BodyFields:  map[string]any{},
		QueryFields: carrdValuesToMap(r.URL.Query()),
		RawBody:     append([]byte(nil), body...),
		Method:      r.Method,
		ContentType: r.Header.Get("Content-Type"),
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		fields, err := decodeCarrdBody(r.Header.Get("Content-Type"), body)
		if err != nil {
			return poptinWebhookPayload{}, fmt.Errorf("decode Poptin webhook payload: %w", err)
		}
		payload.BodyFields = fields
	}
	payload.Raw = map[string]any{
		"method":       payload.Method,
		"content_type": payload.ContentType,
		"query":        poptinRedactedMap(payload.QueryFields),
		"body":         poptinRedactedMap(payload.BodyFields),
	}
	return payload, nil
}

func poptinAccountID(r *http.Request, payload poptinWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Account-ID"),
		r.Header.Get("X-Poptin-Account-ID"),
		r.URL.Query().Get("account_id"),
		r.URL.Query().Get("customer_id"),
		r.URL.Query().Get("poptin_account_id"),
		mapString(payload.BodyFields, "account_id", "customer_id", "accountId", "poptin_account_id"),
	)
}

func poptinPopupID(r *http.Request, payload poptinWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Popup-ID"),
		r.Header.Get("X-Poptin-Popup-ID"),
		r.URL.Query().Get("popup_id"),
		r.URL.Query().Get("poptin_id"),
		r.URL.Query().Get("campaign_id"),
		r.URL.Query().Get("form_id"),
		mapString(payload.BodyFields, "popup_id", "poptin_id", "poptinId", "campaign_id", "form_id", "formId"),
	)
}

func poptinRouteToken(r *http.Request, payload poptinWebhookPayload) string {
	return firstString(
		bearerToken(r.Header.Get("Authorization")),
		r.Header.Get("X-Postwave-Webhook-Token"),
		r.Header.Get("X-Postwave-Token"),
		r.Header.Get("X-Poptin-Webhook-Token"),
		r.Header.Get("X-Poptin-Token"),
		r.URL.Query().Get("token"),
		r.URL.Query().Get("webhook_token"),
		r.URL.Query().Get("route_token"),
		r.URL.Query().Get("postwave_token"),
		r.URL.Query().Get("poptin_token"),
		mapString(payload.BodyFields, "token", "webhook_token", "route_token", "postwave_token", "poptin_token"),
	)
}

func poptinWebhookID(payload poptinWebhookPayload, accountID, popupID string) string {
	if id := firstString(
		mapString(payload.BodyFields, "lead_id", "leadId", "submission_id", "submissionId", "contact_id", "contactId", "id", "guid"),
		mapString(payload.QueryFields, "lead_id", "leadId", "submission_id", "submissionId", "contact_id", "contactId", "id", "guid"),
	); id != "" {
		return "poptin_" + normalizeTypeformIdentityKey(id)
	}
	sum := sha256.Sum256([]byte(accountID + "\n" + popupID + "\n" + poptinCanonicalWebhookFields(payload)))
	return "poptin_local_" + hex.EncodeToString(sum[:16])
}

func poptinCanonicalWebhookFields(payload poptinWebhookPayload) string {
	fields := poptinMergedSubmissionFields(payload)
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if poptinSecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(fields[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func mapPoptinWebhookSubmission(payload poptinWebhookPayload, accountID, popupID, webhookID string, integration Integration) SubmissionInput {
	fields := map[string]any{
		"poptin_account_id":   accountID,
		"poptin_popup_id":     popupID,
		"poptin_webhook_id":   webhookID,
		"poptin_provider_raw": payload.Raw,
	}
	if len(payload.QueryFields) > 0 {
		fields["poptin_query"] = poptinRedactedMap(payload.QueryFields)
	}
	identity := typeformIdentity{}
	for key, value := range poptinMergedSubmissionFields(payload) {
		if poptinControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := carrdNormalizeValue(value)
		fields["poptin_field."+normalizedKey] = normalizedValue
		identity.apply(key, carrdIdentityText(normalizedValue))
	}
	poptinApplyConfiguredIdentity(&identity, integration, payload)
	submittedAt := parseFilloutTime(firstString(
		poptinConfiguredFieldString(integration, payload, "submitted_at_field_key"),
		mapString(payload.BodyFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date"),
		mapString(payload.QueryFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date"),
	))
	formName := firstString(
		settingString(integration.Settings, "form_name"),
		settingString(integration.Settings, "popup_name"),
		settingString(integration.Settings, "campaign_name"),
		mapString(payload.BodyFields, "popup_name", "poptin_name", "campaign_name", "form_name"),
		mapString(payload.QueryFields, "popup_name", "poptin_name", "campaign_name", "form_name"),
		popupID,
	)
	return SubmissionInput{
		SourceID:    poptinSourceID(accountID, popupID, webhookID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      popupID,
		FormName:    formName,
		EventName:   "lead.submitted",
		Tags:        poptinTags(integration, accountID, popupID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func poptinMergedSubmissionFields(payload poptinWebhookPayload) map[string]any {
	out := make(map[string]any, len(payload.QueryFields)+len(payload.BodyFields))
	for key, value := range payload.QueryFields {
		out[key] = value
	}
	for key, value := range payload.BodyFields {
		out[key] = value
	}
	return out
}

func poptinApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, payload poptinWebhookPayload) {
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
		if value := poptinConfiguredFieldString(integration, payload, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func poptinConfiguredFieldString(integration Integration, payload poptinWebhookPayload, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	fields := poptinMergedSubmissionFields(payload)
	for key, value := range fields {
		if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
			return carrdIdentityText(value)
		}
	}
	return ""
}

func poptinControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "token", "webhook_token", "route_token", "postwave_token", "poptin_token", "secret", "password", "account_id", "customer_id", "poptin_account_id", "popup_id", "poptin_id", "poptinid", "campaign_id", "form_id":
		return true
	default:
		return poptinSecretLikeKey(key)
	}
}

func poptinSecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") || strings.Contains(key, "secret") || strings.Contains(key, "password")
}

func poptinRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if poptinSecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = carrdNormalizeValue(value)
	}
	return out
}

func poptinTags(integration Integration, accountID, popupID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"poptin", "poptin:" + accountID, "poptin:popup:" + popupID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func poptinSourceID(accountID, popupID, webhookID string) string {
	accountID = strings.TrimSpace(accountID)
	popupID = strings.TrimSpace(popupID)
	webhookID = strings.TrimSpace(webhookID)
	return "poptin://lead/" + accountID + "/" + popupID + "/" + webhookID
}
