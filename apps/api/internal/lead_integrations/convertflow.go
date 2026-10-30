// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"bytes"
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
	convertFlowWebhookMaxBodySize = 2 << 20
	convertFlowDefaultTopic       = "fields.submitted"
)

type ConvertFlowCredentials struct {
	WebhookToken string
	UserAgent    string
}

type ConvertFlowCredentialResolver interface {
	ResolveConvertFlow(context.Context, string, Integration) (ConvertFlowCredentials, error)
}

type ConvertFlowRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type ConvertFlowSecretsCredentialResolver struct {
	Secrets ConvertFlowRuntimeSecretResolver
}

func NewConvertFlowSecretsCredentialResolver(secrets ConvertFlowRuntimeSecretResolver) *ConvertFlowSecretsCredentialResolver {
	return &ConvertFlowSecretsCredentialResolver{Secrets: secrets}
}

func (r *ConvertFlowSecretsCredentialResolver) ResolveConvertFlow(ctx context.Context, _ string, integration Integration) (ConvertFlowCredentials, error) {
	if r == nil || r.Secrets == nil {
		return ConvertFlowCredentials{}, fmt.Errorf("convertflow credential resolver is not configured")
	}
	ref := convertFlowCredentialRef(integration)
	if ref == "" {
		return ConvertFlowCredentials{}, fmt.Errorf("convertflow credentials_ref is required")
	}
	var payload convertFlowCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return ConvertFlowCredentials{}, fmt.Errorf("resolve convertflow credentials %q: %w", ref, err)
		}
		return parseConvertFlowCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return ConvertFlowCredentials{}, fmt.Errorf("resolve convertflow credentials %q: %w", ref, err)
	}
	return parseConvertFlowCredentialSecret(raw)
}

type convertFlowCredentialPayload struct {
	WebhookToken string `json:"webhook_token"`
	RouteToken   string `json:"route_token"`
	Token        string `json:"token"`
	Secret       string `json:"secret"`
	UserAgent    string `json:"user_agent"`
}

func (p convertFlowCredentialPayload) credentials() (ConvertFlowCredentials, error) {
	token := strings.TrimSpace(firstString(p.WebhookToken, p.RouteToken, p.Token, p.Secret))
	if token == "" {
		return ConvertFlowCredentials{}, fmt.Errorf("convertflow webhook_token is required")
	}
	return ConvertFlowCredentials{WebhookToken: token, UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

func parseConvertFlowCredentialSecret(raw string) (ConvertFlowCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ConvertFlowCredentials{}, fmt.Errorf("convertflow credentials are empty")
	}
	var payload convertFlowCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return ConvertFlowCredentials{}, fmt.Errorf("parse convertflow credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return ConvertFlowCredentials{}, fmt.Errorf("parse convertflow credential key-value secret: %w", err)
		}
		return convertFlowCredentialPayload{
			WebhookToken: firstString(values.Get("webhook_token"), values.Get("route_token")),
			Token:        values.Get("token"),
			Secret:       values.Get("secret"),
			UserAgent:    values.Get("user_agent"),
		}.credentials()
	}
	return convertFlowCredentialPayload{WebhookToken: raw}.credentials()
}

func convertFlowCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) ConvertFlowWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, convertFlowWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "ConvertFlow webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeConvertFlowWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	accountID := convertFlowAccountID(r, payload)
	if accountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "ConvertFlow webhooks must include account_id in the query string, headers, or JSON payload")
		return
	}
	campaignID := convertFlowCampaignID(r, payload)
	if campaignID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_campaign_id", "ConvertFlow webhooks must include campaign_id, cta_id, or form_id in the query string, headers, or JSON payload")
		return
	}
	actualToken := convertFlowRouteToken(r, payload)
	if actualToken == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_token", "ConvertFlow route token is required")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderAccountAndCampaign(r.Context(), ProviderConvertFlow, accountID, campaignID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "ConvertFlow integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "ConvertFlow integration is disconnected")
		return
	}
	resolver := d.convertFlowCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "ConvertFlow credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveConvertFlow(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyConvertFlowWebhookToken(creds.WebhookToken, actualToken); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_token", "request authentication failed")
		return
	}
	webhookID := convertFlowWebhookID(r, payload, accountID, campaignID)
	topic := convertFlowTopic(r, payload)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderConvertFlow, webhookID, topic, body)
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
	submission := mapConvertFlowWebhookSubmission(payload, accountID, campaignID, webhookID, *integration)
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "convertflow-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderConvertFlow, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "convertflow webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderConvertFlow, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderConvertFlow, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifyConvertFlowWebhookToken(expected, actual string) error {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	if expected == "" {
		return fmt.Errorf("convertflow webhook token is not configured")
	}
	if actual == "" {
		return fmt.Errorf("convertflow webhook token is required")
	}
	if !hmac.Equal([]byte(expected), []byte(actual)) {
		return fmt.Errorf("convertflow webhook token does not match")
	}
	return nil
}

type convertFlowWebhookPayload struct {
	Raw      map[string]any
	Contact  map[string]any
	Fields   map[string]any
	Campaign map[string]any
	Meta     map[string]any
	RawBody  []byte
}

func decodeConvertFlowWebhookPayload(body []byte) (convertFlowWebhookPayload, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return convertFlowWebhookPayload{}, fmt.Errorf("ConvertFlow webhook JSON body is required")
	}
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return convertFlowWebhookPayload{}, fmt.Errorf("decode ConvertFlow webhook JSON: %w", err)
	}
	if len(raw) == 0 {
		return convertFlowWebhookPayload{}, fmt.Errorf("ConvertFlow webhook JSON object is required")
	}
	normalized := convertFlowNormalizeMap(raw)
	payload := convertFlowWebhookPayload{
		Raw:      normalized,
		Contact:  convertFlowMap(normalized, "contact", "person", "visitor", "lead", "subscriber", "customer"),
		Fields:   convertFlowMap(normalized, "fields", "form_fields", "formFields", "custom_fields", "customFields", "answers", "properties"),
		Campaign: convertFlowMap(normalized, "campaign", "cta", "form", "funnel", "quiz", "survey"),
		Meta:     convertFlowMap(normalized, "meta", "metadata", "event"),
		RawBody:  append([]byte(nil), body...),
	}
	if len(payload.Contact) == 0 {
		payload.Contact = convertFlowMap(normalized, "data")
	}
	if len(payload.Fields) == 0 {
		payload.Fields = convertFlowMap(payload.Contact, "fields", "form_fields", "formFields", "custom_fields", "customFields", "answers", "properties")
	}
	if len(payload.Contact) == 0 {
		payload.Contact = convertFlowFlatLeadFields(normalized)
	}
	return payload, nil
}

func convertFlowMap(raw map[string]any, keys ...string) map[string]any {
	for _, key := range keys {
		value, ok := raw[key]
		if !ok {
			value, ok = raw[strings.ToLower(key)]
		}
		if !ok {
			continue
		}
		if typed, ok := value.(map[string]any); ok {
			return typed
		}
	}
	return map[string]any{}
}

func convertFlowFlatLeadFields(raw map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range raw {
		normalized := normalizeTypeformIdentityKey(key)
		switch normalized {
		case "contact", "person", "visitor", "lead", "subscriber", "customer", "fields", "form_fields", "formfields", "custom_fields", "customfields", "answers", "properties", "campaign", "cta", "form", "funnel", "quiz", "survey", "meta", "metadata", "event":
			continue
		}
		if convertFlowControlKey(key) {
			continue
		}
		out[key] = value
	}
	return out
}

func convertFlowNormalizeMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			out[trimmed] = convertFlowNormalizeValue(value)
		}
	}
	return out
}

func convertFlowNormalizeValue(value any) any {
	switch typed := value.(type) {
	case json.Number:
		if i, err := typed.Int64(); err == nil {
			return i
		}
		if f, err := typed.Float64(); err == nil {
			return f
		}
		return typed.String()
	case map[string]any:
		return convertFlowNormalizeMap(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, convertFlowNormalizeValue(item))
		}
		return out
	default:
		return typed
	}
}

func convertFlowAccountID(r *http.Request, payload convertFlowWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Account-ID"),
		r.Header.Get("X-ConvertFlow-Account-ID"),
		r.Header.Get("X-ConvertFlow-Site-ID"),
		r.URL.Query().Get("account_id"),
		r.URL.Query().Get("accountId"),
		r.URL.Query().Get("site_id"),
		r.URL.Query().Get("siteId"),
		mapString(payload.Raw, "account_id", "accountId", "site_id", "siteId", "team_id", "teamId"),
		mapString(payload.Contact, "account_id", "accountId", "site_id", "siteId", "team_id", "teamId"),
		mapString(payload.Meta, "account_id", "accountId", "site_id", "siteId", "team_id", "teamId"),
	)
}

func convertFlowCampaignID(r *http.Request, payload convertFlowWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Campaign-ID"),
		r.Header.Get("X-ConvertFlow-Campaign-ID"),
		r.Header.Get("X-ConvertFlow-CTA-ID"),
		r.URL.Query().Get("campaign_id"),
		r.URL.Query().Get("campaignId"),
		r.URL.Query().Get("cta_id"),
		r.URL.Query().Get("ctaId"),
		r.URL.Query().Get("form_id"),
		r.URL.Query().Get("formId"),
		mapString(payload.Raw, "campaign_id", "campaignId", "cta_id", "ctaId", "form_id", "formId", "funnel_id", "funnelId"),
		mapString(payload.Campaign, "id", "campaign_id", "campaignId", "cta_id", "ctaId", "form_id", "formId", "funnel_id", "funnelId"),
		mapString(payload.Meta, "campaign_id", "campaignId", "cta_id", "ctaId", "form_id", "formId", "funnel_id", "funnelId"),
	)
}

func convertFlowRouteToken(r *http.Request, payload convertFlowWebhookPayload) string {
	return firstString(
		bearerToken(r.Header.Get("Authorization")),
		r.Header.Get("X-Postwave-Webhook-Token"),
		r.Header.Get("X-Postwave-Token"),
		r.Header.Get("X-ConvertFlow-Webhook-Token"),
		r.Header.Get("X-ConvertFlow-Token"),
		r.URL.Query().Get("token"),
		r.URL.Query().Get("webhook_token"),
		r.URL.Query().Get("route_token"),
		r.URL.Query().Get("postwave_token"),
		r.URL.Query().Get("convertflow_token"),
		mapString(payload.Raw, "token", "webhook_token", "route_token", "postwave_token", "convertflow_token"),
		mapString(payload.Meta, "token", "webhook_token", "route_token", "postwave_token", "convertflow_token"),
	)
}

func convertFlowTopic(r *http.Request, payload convertFlowWebhookPayload) string {
	value := strings.ToLower(firstString(
		r.Header.Get("X-ConvertFlow-Event"),
		r.URL.Query().Get("event"),
		mapString(payload.Raw, "event", "event_type", "eventType", "topic", "type", "action"),
		mapString(payload.Meta, "event", "event_type", "eventType", "topic", "type", "action"),
	))
	switch {
	case strings.Contains(value, "contact"):
		return "contact.updated"
	case strings.Contains(value, "conversion") || strings.Contains(value, "converted"):
		return "cta.converted"
	case strings.Contains(value, "webhook"):
		return "webhook.automation"
	default:
		return convertFlowDefaultTopic
	}
}

func convertFlowWebhookID(r *http.Request, payload convertFlowWebhookPayload, accountID, campaignID string) string {
	if id := firstString(
		r.Header.Get("X-ConvertFlow-Delivery-ID"),
		r.Header.Get("X-Postwave-Delivery-ID"),
		r.Header.Get("X-Request-ID"),
		r.URL.Query().Get("delivery_id"),
		r.URL.Query().Get("webhook_id"),
		mapString(payload.Raw, "id", "event_id", "eventId", "submission_id", "submissionId", "conversion_id", "conversionId"),
		mapString(payload.Contact, "id", "contact_id", "contactId", "person_id", "personId", "uuid"),
		mapString(payload.Meta, "id", "event_id", "eventId", "submission_id", "submissionId"),
	); id != "" {
		return "convertflow_" + normalizeTypeformIdentityKey(id)
	}
	sum := sha256.Sum256([]byte(accountID + "\n" + campaignID + "\n" + convertFlowCanonicalWebhookFields(payload)))
	return "convertflow_local_" + hex.EncodeToString(sum[:16])
}

func convertFlowCanonicalWebhookFields(payload convertFlowWebhookPayload) string {
	keys := make([]string, 0, len(payload.Raw))
	for key := range payload.Raw {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if convertFlowSecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(payload.Raw[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func mapConvertFlowWebhookSubmission(payload convertFlowWebhookPayload, accountID, campaignID, webhookID string, integration Integration) SubmissionInput {
	leadFields := convertFlowLeadFields(payload.Contact, payload.Fields)
	campaignName := firstString(
		mapString(payload.Campaign, "name", "title", "campaign_name", "campaignName", "cta_name", "ctaName", "form_name", "formName"),
		settingString(integration.Settings, "campaign_name"),
		settingString(integration.Settings, "form_name"),
		campaignID,
	)
	fields := map[string]any{
		"convertflow_account_id":    accountID,
		"convertflow_campaign_id":   campaignID,
		"convertflow_campaign_name": campaignName,
		"convertflow_webhook_id":    webhookID,
		"convertflow_provider_raw":  convertFlowRedactedMap(payload.Raw),
	}
	if len(payload.Contact) > 0 {
		fields["convertflow_contact"] = convertFlowRedactedMap(payload.Contact)
	}
	if len(payload.Campaign) > 0 {
		fields["convertflow_campaign"] = convertFlowRedactedMap(payload.Campaign)
	}
	if len(payload.Fields) > 0 {
		fields["convertflow_fields"] = convertFlowRedactedMap(payload.Fields)
	}
	identity := typeformIdentity{}
	for key, value := range leadFields {
		if convertFlowControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := convertFlowNormalizeValue(value)
		fields["convertflow_field."+normalizedKey] = normalizedValue
		identity.apply(key, convertFlowIdentityText(normalizedValue))
	}
	convertFlowApplyConfiguredIdentity(&identity, integration, leadFields)
	submittedAt := parseFilloutTime(firstString(
		convertFlowConfiguredFieldString(integration, leadFields, "submitted_at_field_key"),
		mapString(payload.Raw, "submitted_at", "submittedAt", "created_at", "createdAt", "converted_at", "convertedAt", "timestamp", "date"),
		mapString(payload.Contact, "submitted_at", "submittedAt", "created_at", "createdAt", "converted_at", "convertedAt", "timestamp", "date"),
		mapString(payload.Meta, "submitted_at", "submittedAt", "created_at", "createdAt", "converted_at", "convertedAt", "timestamp", "date"),
	))
	return SubmissionInput{
		SourceID:    convertFlowSourceID(accountID, campaignID, webhookID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      campaignID,
		FormName:    campaignName,
		EventName:   "lead.submitted",
		Tags:        convertFlowTags(integration, accountID, campaignID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func convertFlowLeadFields(contact, fields map[string]any) map[string]any {
	out := make(map[string]any, len(contact)+len(fields)+8)
	for key, value := range contact {
		if nested, ok := value.(map[string]any); ok {
			switch normalizeTypeformIdentityKey(key) {
			case "fields", "form_fields", "formfields", "custom_fields", "customfields", "answers", "properties", "traits":
				for nestedKey, nestedValue := range nested {
					out[nestedKey] = nestedValue
				}
				continue
			}
		}
		out[key] = value
	}
	for key, value := range fields {
		out[key] = value
	}
	return out
}

func convertFlowApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, fields map[string]any) {
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
		if value := convertFlowConfiguredFieldString(integration, fields, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func convertFlowConfiguredFieldString(integration Integration, fields map[string]any, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	for key, value := range fields {
		if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
			return convertFlowIdentityText(value)
		}
	}
	return ""
}

func convertFlowIdentityText(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	case []any, map[string]any:
		return ""
	default:
		text := strings.TrimSpace(fmt.Sprint(typed))
		if text == "<nil>" {
			return ""
		}
		return text
	}
}

func convertFlowControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "authorization", "token", "webhook_token", "route_token", "postwave_token", "convertflow_token", "secret", "password", "api_key", "apikey", "account_id", "accountid", "site_id", "siteid", "team_id", "teamid", "campaign_id", "campaignid", "cta_id", "ctaid", "form_id", "formid", "funnel_id", "funnelid", "campaign", "cta", "form", "funnel":
		return true
	default:
		return convertFlowSecretLikeKey(key)
	}
}

func convertFlowSecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") ||
		strings.Contains(key, "secret") ||
		strings.Contains(key, "password") ||
		strings.Contains(key, "api_key") ||
		strings.Contains(key, "apikey") ||
		strings.Contains(key, "signature") ||
		strings.Contains(key, "authorization")
}

func convertFlowRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if convertFlowSecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = convertFlowRedactedValue(value)
	}
	return out
}

func convertFlowRedactedValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return convertFlowRedactedMap(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, convertFlowRedactedValue(item))
		}
		return out
	default:
		return convertFlowNormalizeValue(typed)
	}
}

func convertFlowTags(integration Integration, accountID, campaignID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"convertflow", "convertflow:" + accountID, "convertflow:campaign:" + campaignID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func convertFlowSourceID(accountID, campaignID, webhookID string) string {
	accountID = strings.TrimSpace(accountID)
	campaignID = strings.TrimSpace(campaignID)
	webhookID = strings.TrimSpace(webhookID)
	return "convertflow://submission/" + accountID + "/" + campaignID + "/" + webhookID
}
