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
	sleeknoteWebhookMaxBodySize = 2 << 20
	sleeknoteWebhookTopic       = "signup.created"
)

type SleeknoteCredentials struct {
	WebhookToken string
	UserAgent    string
}

type SleeknoteCredentialResolver interface {
	ResolveSleeknote(context.Context, string, Integration) (SleeknoteCredentials, error)
}

type SleeknoteRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type SleeknoteSecretsCredentialResolver struct {
	Secrets SleeknoteRuntimeSecretResolver
}

func NewSleeknoteSecretsCredentialResolver(secrets SleeknoteRuntimeSecretResolver) *SleeknoteSecretsCredentialResolver {
	return &SleeknoteSecretsCredentialResolver{Secrets: secrets}
}

func (r *SleeknoteSecretsCredentialResolver) ResolveSleeknote(ctx context.Context, _ string, integration Integration) (SleeknoteCredentials, error) {
	if r == nil || r.Secrets == nil {
		return SleeknoteCredentials{}, fmt.Errorf("sleeknote credential resolver is not configured")
	}
	ref := sleeknoteCredentialRef(integration)
	if ref == "" {
		return SleeknoteCredentials{}, fmt.Errorf("sleeknote credentials_ref is required")
	}
	var payload sleeknoteCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return SleeknoteCredentials{}, fmt.Errorf("resolve sleeknote credentials %q: %w", ref, err)
		}
		return parseSleeknoteCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return SleeknoteCredentials{}, fmt.Errorf("resolve sleeknote credentials %q: %w", ref, err)
	}
	return parseSleeknoteCredentialSecret(raw)
}

type sleeknoteCredentialPayload struct {
	WebhookToken string `json:"webhook_token"`
	RouteToken   string `json:"route_token"`
	Token        string `json:"token"`
	Secret       string `json:"secret"`
	UserAgent    string `json:"user_agent"`
}

func (p sleeknoteCredentialPayload) credentials() (SleeknoteCredentials, error) {
	token := strings.TrimSpace(firstString(p.WebhookToken, p.RouteToken, p.Token, p.Secret))
	if token == "" {
		return SleeknoteCredentials{}, fmt.Errorf("sleeknote webhook_token is required")
	}
	return SleeknoteCredentials{WebhookToken: token, UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

func parseSleeknoteCredentialSecret(raw string) (SleeknoteCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return SleeknoteCredentials{}, fmt.Errorf("sleeknote credentials are empty")
	}
	var payload sleeknoteCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return SleeknoteCredentials{}, fmt.Errorf("parse sleeknote credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return SleeknoteCredentials{}, fmt.Errorf("parse sleeknote credential key-value secret: %w", err)
		}
		return sleeknoteCredentialPayload{
			WebhookToken: firstString(values.Get("webhook_token"), values.Get("route_token")),
			Token:        values.Get("token"),
			Secret:       values.Get("secret"),
			UserAgent:    values.Get("user_agent"),
		}.credentials()
	}
	return sleeknoteCredentialPayload{WebhookToken: raw}.credentials()
}

func sleeknoteCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) SleeknoteWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, sleeknoteWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Sleeknote custom integration payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeSleeknoteWebhookPayload(r, body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	accountID := sleeknoteAccountID(r, payload)
	if accountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "Sleeknote custom integrations must include account_id or customer_id in the query string, headers, or payload")
		return
	}
	campaignID := sleeknoteCampaignID(r, payload)
	if campaignID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_campaign_id", "Sleeknote custom integrations must include campaign_id or SleeknoteId in the query string, headers, or payload")
		return
	}
	actualToken := sleeknoteRouteToken(r, payload)
	if actualToken == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_token", "Sleeknote route token is required")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderAccountAndCampaign(r.Context(), ProviderSleeknote, accountID, campaignID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Sleeknote integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "Sleeknote integration is disconnected")
		return
	}
	resolver := d.sleeknoteCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Sleeknote credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveSleeknote(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifySleeknoteWebhookToken(creds.WebhookToken, actualToken); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_token", "request authentication failed")
		return
	}
	webhookID := sleeknoteWebhookID(payload, accountID, campaignID)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderSleeknote, webhookID, sleeknoteWebhookTopic, body)
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
	submission := mapSleeknoteWebhookSubmission(payload, accountID, campaignID, webhookID, *integration)
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "sleeknote-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderSleeknote, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "sleeknote webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderSleeknote, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderSleeknote, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifySleeknoteWebhookToken(expected, actual string) error {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	if expected == "" {
		return fmt.Errorf("sleeknote webhook token is not configured")
	}
	if actual == "" {
		return fmt.Errorf("sleeknote webhook token is required")
	}
	if !hmac.Equal([]byte(expected), []byte(actual)) {
		return fmt.Errorf("sleeknote webhook token does not match")
	}
	return nil
}

type sleeknoteWebhookPayload struct {
	BodyFields  map[string]any
	QueryFields map[string]any
	Raw         map[string]any
	RawBody     []byte
	Method      string
	ContentType string
}

func decodeSleeknoteWebhookPayload(r *http.Request, body []byte) (sleeknoteWebhookPayload, error) {
	payload := sleeknoteWebhookPayload{
		BodyFields:  map[string]any{},
		QueryFields: carrdValuesToMap(r.URL.Query()),
		RawBody:     append([]byte(nil), body...),
		Method:      r.Method,
		ContentType: r.Header.Get("Content-Type"),
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		fields, err := decodeCarrdBody(r.Header.Get("Content-Type"), body)
		if err != nil {
			return sleeknoteWebhookPayload{}, fmt.Errorf("decode Sleeknote custom integration payload: %w", err)
		}
		payload.BodyFields = fields
	}
	payload.Raw = map[string]any{
		"method":       payload.Method,
		"content_type": payload.ContentType,
		"query":        sleeknoteRedactedMap(payload.QueryFields),
		"body":         sleeknoteRedactedMap(payload.BodyFields),
	}
	return payload, nil
}

func sleeknoteAccountID(r *http.Request, payload sleeknoteWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Account-ID"),
		r.Header.Get("X-Sleeknote-Account-ID"),
		r.Header.Get("X-Sleeknote-Customer-ID"),
		r.URL.Query().Get("account_id"),
		r.URL.Query().Get("customer_id"),
		r.URL.Query().Get("CustomerId"),
		r.URL.Query().Get("sleeknote_customer_id"),
		mapString(payload.BodyFields, "account_id", "customer_id", "CustomerId", "customerId", "sleeknote_customer_id"),
	)
}

func sleeknoteCampaignID(r *http.Request, payload sleeknoteWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Campaign-ID"),
		r.Header.Get("X-Sleeknote-Campaign-ID"),
		r.Header.Get("X-Sleeknote-ID"),
		r.URL.Query().Get("campaign_id"),
		r.URL.Query().Get("SleeknoteId"),
		r.URL.Query().Get("sleeknote_id"),
		r.URL.Query().Get("form_id"),
		mapString(payload.BodyFields, "campaign_id", "SleeknoteId", "sleeknote_id", "sleeknoteId", "form_id", "formId"),
	)
}

func sleeknoteRouteToken(r *http.Request, payload sleeknoteWebhookPayload) string {
	return firstString(
		bearerToken(r.Header.Get("Authorization")),
		r.Header.Get("X-Postwave-Webhook-Token"),
		r.Header.Get("X-Postwave-Token"),
		r.Header.Get("X-Sleeknote-Webhook-Token"),
		r.Header.Get("X-Sleeknote-Token"),
		r.URL.Query().Get("token"),
		r.URL.Query().Get("webhook_token"),
		r.URL.Query().Get("route_token"),
		r.URL.Query().Get("postwave_token"),
		r.URL.Query().Get("sleeknote_token"),
		mapString(payload.BodyFields, "token", "webhook_token", "route_token", "postwave_token", "sleeknote_token"),
	)
}

func sleeknoteWebhookID(payload sleeknoteWebhookPayload, accountID, campaignID string) string {
	if id := firstString(
		mapString(payload.BodyFields, "guid", "Guid", "signup_guid", "submission_id", "id", "lead_id"),
		mapString(payload.QueryFields, "guid", "Guid", "signup_guid", "submission_id", "id", "lead_id"),
	); id != "" {
		return "sleeknote_" + normalizeTypeformIdentityKey(id)
	}
	sum := sha256.Sum256([]byte(accountID + "\n" + campaignID + "\n" + sleeknoteCanonicalWebhookFields(payload)))
	return "sleeknote_local_" + hex.EncodeToString(sum[:16])
}

func sleeknoteCanonicalWebhookFields(payload sleeknoteWebhookPayload) string {
	fields := sleeknoteMergedSubmissionFields(payload)
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if sleeknoteSecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(fields[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func mapSleeknoteWebhookSubmission(payload sleeknoteWebhookPayload, accountID, campaignID, webhookID string, integration Integration) SubmissionInput {
	fields := map[string]any{
		"sleeknote_account_id":   accountID,
		"sleeknote_campaign_id":  campaignID,
		"sleeknote_webhook_id":   webhookID,
		"sleeknote_provider_raw": payload.Raw,
	}
	if len(payload.QueryFields) > 0 {
		fields["sleeknote_query"] = sleeknoteRedactedMap(payload.QueryFields)
	}
	identity := typeformIdentity{}
	for key, value := range sleeknoteMergedSubmissionFields(payload) {
		if sleeknoteControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := carrdNormalizeValue(value)
		fields["sleeknote_field."+normalizedKey] = normalizedValue
		identity.apply(key, carrdIdentityText(normalizedValue))
	}
	sleeknoteApplyConfiguredIdentity(&identity, integration, payload)
	submittedAt := parseFilloutTime(firstString(
		sleeknoteConfiguredFieldString(integration, payload, "submitted_at_field_key"),
		mapString(payload.BodyFields, "submitted_at", "submittedAt", "CreatedDate", "created_at", "createdAt", "timestamp", "date"),
		mapString(payload.QueryFields, "submitted_at", "submittedAt", "CreatedDate", "created_at", "createdAt", "timestamp", "date"),
	))
	formName := firstString(
		settingString(integration.Settings, "form_name"),
		settingString(integration.Settings, "campaign_name"),
		mapString(payload.BodyFields, "SignupPage", "signup_page", "campaign_name", "form_name"),
		mapString(payload.QueryFields, "SignupPage", "signup_page", "campaign_name", "form_name"),
		campaignID,
	)
	return SubmissionInput{
		SourceID:    sleeknoteSourceID(accountID, campaignID, webhookID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      campaignID,
		FormName:    formName,
		EventName:   "lead.submitted",
		Tags:        sleeknoteTags(integration, accountID, campaignID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func sleeknoteMergedSubmissionFields(payload sleeknoteWebhookPayload) map[string]any {
	out := make(map[string]any, len(payload.QueryFields)+len(payload.BodyFields))
	for key, value := range payload.QueryFields {
		out[key] = value
	}
	for key, value := range payload.BodyFields {
		out[key] = value
	}
	return out
}

func sleeknoteApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, payload sleeknoteWebhookPayload) {
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
		if value := sleeknoteConfiguredFieldString(integration, payload, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func sleeknoteConfiguredFieldString(integration Integration, payload sleeknoteWebhookPayload, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	fields := sleeknoteMergedSubmissionFields(payload)
	for key, value := range fields {
		if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
			return carrdIdentityText(value)
		}
	}
	return ""
}

func sleeknoteControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "token", "webhook_token", "route_token", "postwave_token", "sleeknote_token", "secret", "password", "account_id", "customer_id", "customerid", "sleeknote_customer_id", "campaign_id", "sleeknoteid", "sleeknote_id", "form_id":
		return true
	default:
		return sleeknoteSecretLikeKey(key)
	}
}

func sleeknoteSecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") || strings.Contains(key, "secret") || strings.Contains(key, "password")
}

func sleeknoteRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if sleeknoteSecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = carrdNormalizeValue(value)
	}
	return out
}

func sleeknoteTags(integration Integration, accountID, campaignID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"sleeknote", "sleeknote:" + accountID, "sleeknote:campaign:" + campaignID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func sleeknoteSourceID(accountID, campaignID, webhookID string) string {
	accountID = strings.TrimSpace(accountID)
	campaignID = strings.TrimSpace(campaignID)
	webhookID = strings.TrimSpace(webhookID)
	return "sleeknote://signup/" + accountID + "/" + campaignID + "/" + webhookID
}
