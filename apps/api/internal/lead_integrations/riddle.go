// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
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

const riddleWebhookMaxBodySize = 2 << 20

type RiddleCredentials struct {
	WebhookToken  string
	SigningSecret string
	UserAgent     string
}

type RiddleCredentialResolver interface {
	ResolveRiddle(context.Context, string, Integration) (RiddleCredentials, error)
}

type RiddleRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type RiddleSecretsCredentialResolver struct {
	Secrets RiddleRuntimeSecretResolver
}

func NewRiddleSecretsCredentialResolver(secrets RiddleRuntimeSecretResolver) *RiddleSecretsCredentialResolver {
	return &RiddleSecretsCredentialResolver{Secrets: secrets}
}

func (r *RiddleSecretsCredentialResolver) ResolveRiddle(ctx context.Context, _ string, integration Integration) (RiddleCredentials, error) {
	if r == nil || r.Secrets == nil {
		return RiddleCredentials{}, fmt.Errorf("riddle credential resolver is not configured")
	}
	ref := riddleCredentialRef(integration)
	if ref == "" {
		return RiddleCredentials{}, fmt.Errorf("riddle credentials_ref is required")
	}
	var payload riddleCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return RiddleCredentials{}, fmt.Errorf("resolve riddle credentials %q: %w", ref, err)
		}
		return parseRiddleCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return RiddleCredentials{}, fmt.Errorf("resolve riddle credentials %q: %w", ref, err)
	}
	return parseRiddleCredentialSecret(raw)
}

type riddleCredentialPayload struct {
	WebhookToken    string `json:"webhook_token"`
	RouteToken      string `json:"route_token"`
	Token           string `json:"token"`
	SigningSecret   string `json:"signing_secret"`
	WebhookSecret   string `json:"webhook_secret"`
	SignatureSecret string `json:"signature_secret"`
	SecretKey       string `json:"secret_key"`
	Secret          string `json:"secret"`
	UserAgent       string `json:"user_agent"`
}

func (p riddleCredentialPayload) credentials() (RiddleCredentials, error) {
	token := strings.TrimSpace(firstString(p.WebhookToken, p.RouteToken, p.Token))
	secret := strings.TrimSpace(firstString(p.SigningSecret, p.WebhookSecret, p.SignatureSecret, p.SecretKey, p.Secret))
	if token == "" && secret == "" {
		return RiddleCredentials{}, fmt.Errorf("riddle webhook_token or signing_secret is required")
	}
	return RiddleCredentials{WebhookToken: token, SigningSecret: secret, UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

func parseRiddleCredentialSecret(raw string) (RiddleCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return RiddleCredentials{}, fmt.Errorf("riddle credentials are empty")
	}
	var payload riddleCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return RiddleCredentials{}, fmt.Errorf("parse riddle credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return RiddleCredentials{}, fmt.Errorf("parse riddle credential key-value secret: %w", err)
		}
		return riddleCredentialPayload{
			WebhookToken:    values.Get("webhook_token"),
			RouteToken:      values.Get("route_token"),
			Token:           values.Get("token"),
			SigningSecret:   values.Get("signing_secret"),
			WebhookSecret:   values.Get("webhook_secret"),
			SignatureSecret: values.Get("signature_secret"),
			SecretKey:       values.Get("secret_key"),
			Secret:          values.Get("secret"),
			UserAgent:       values.Get("user_agent"),
		}.credentials()
	}
	return riddleCredentialPayload{WebhookToken: raw}.credentials()
}

func riddleCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) RiddleWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, riddleWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Riddle webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeRiddleWebhookPayload(r, body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	accountID := riddleAccountID(r, payload)
	if accountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "Riddle webhooks must include account_id in headers, query string, or payload")
		return
	}
	quizID := riddleQuizID(r, payload)
	if quizID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_quiz_id", "Riddle webhooks must include riddleId or quiz_id in headers, query string, or JSON payload")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderAccountAndCampaign(r.Context(), ProviderRiddle, accountID, quizID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Riddle integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "Riddle integration is disconnected")
		return
	}
	if configuredCampaignID := settingString(integration.Settings, "campaign_id"); configuredCampaignID != "" {
		if campaignID := riddleCampaignID(r, payload); campaignID != "" && !strings.EqualFold(configuredCampaignID, campaignID) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Riddle integration not found for campaign_id")
			return
		}
	}
	resolver := d.riddleCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Riddle credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveRiddle(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyRiddleWebhookAuth(creds, r, payload, body); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_webhook_auth", "request authentication failed")
		return
	}
	topic := riddleWebhookTopic(payload)
	webhookID := riddleWebhookID(r, payload, accountID, quizID, topic)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderRiddle, webhookID, topic, body)
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
	submission := mapRiddleWebhookSubmission(payload, accountID, quizID, riddleCampaignID(r, payload), webhookID, topic, *integration)
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "riddle-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderRiddle, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "riddle webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderRiddle, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderRiddle, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifyRiddleWebhookAuth(expected RiddleCredentials, r *http.Request, payload riddleWebhookPayload, body []byte) error {
	var reasons []string
	if strings.TrimSpace(expected.WebhookToken) != "" {
		actual := riddleRouteToken(r, payload)
		if actual != "" && VerifyRiddleWebhookToken(expected.WebhookToken, actual) == nil {
			return nil
		}
		if actual == "" {
			reasons = append(reasons, "riddle route token is required")
		} else {
			reasons = append(reasons, "riddle route token does not match")
		}
	}
	if strings.TrimSpace(expected.SigningSecret) != "" {
		if err := VerifyRiddleWebhookSignature(expected.SigningSecret, riddleSignature(r, payload), body); err == nil {
			return nil
		} else {
			reasons = append(reasons, err.Error())
		}
	}
	if len(reasons) == 0 {
		return fmt.Errorf("riddle webhook credentials are not configured")
	}
	return fmt.Errorf("%s", strings.Join(reasons, "; "))
}

func VerifyRiddleWebhookToken(expected, actual string) error {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	if expected == "" {
		return fmt.Errorf("riddle webhook token is not configured")
	}
	if actual == "" {
		return fmt.Errorf("riddle webhook token is required")
	}
	if !hmac.Equal([]byte(expected), []byte(actual)) {
		return fmt.Errorf("riddle webhook token does not match")
	}
	return nil
}

func VerifyRiddleWebhookSignature(secret, actual string, body []byte) error {
	secret = strings.TrimSpace(secret)
	actual = strings.TrimSpace(actual)
	if secret == "" {
		return fmt.Errorf("riddle signing secret is not configured")
	}
	if actual == "" {
		return fmt.Errorf("riddle webhook signature is required")
	}
	values := riddleSignatureValues(actual)
	if len(values) == 0 {
		return fmt.Errorf("riddle webhook signature is required")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	hmacSum := mac.Sum(nil)
	bodyThenSecret := sha256.Sum256(append(append([]byte(nil), body...), []byte(secret)...))
	secretThenBody := sha256.Sum256(append([]byte(secret), body...))
	candidates := []string{
		hex.EncodeToString(hmacSum),
		"sha256=" + hex.EncodeToString(hmacSum),
		base64.StdEncoding.EncodeToString(hmacSum),
		base64.RawStdEncoding.EncodeToString(hmacSum),
		hex.EncodeToString(bodyThenSecret[:]),
		hex.EncodeToString(secretThenBody[:]),
	}
	for _, candidate := range candidates {
		for _, value := range values {
			if hmac.Equal([]byte(candidate), []byte(value)) {
				return nil
			}
		}
	}
	return fmt.Errorf("riddle webhook signature does not match")
}

func riddleSignatureValues(raw string) []string {
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		value := strings.TrimSpace(part)
		if value == "" {
			continue
		}
		if idx := strings.Index(value, "="); idx > 0 {
			key := strings.ToLower(strings.TrimSpace(value[:idx]))
			if key == "sha256" || key == "hmac-sha256" || key == "signature" || key == "v1" {
				value = strings.TrimSpace(value[idx+1:])
			}
		}
		if strings.HasPrefix(strings.ToLower(value), "sha256=") {
			value = strings.TrimSpace(value[len("sha256="):])
		}
		out = append(out, value)
		out = append(out, strings.ToLower(value))
		out = append(out, "sha256="+strings.ToLower(value))
	}
	return out
}

type riddleWebhookPayload struct {
	BodyFields  map[string]any
	QueryFields map[string]any
	Raw         map[string]any
	RawBody     []byte
	Method      string
	ContentType string
}

func decodeRiddleWebhookPayload(r *http.Request, body []byte) (riddleWebhookPayload, error) {
	payload := riddleWebhookPayload{
		BodyFields:  map[string]any{},
		QueryFields: carrdValuesToMap(r.URL.Query()),
		RawBody:     append([]byte(nil), body...),
		Method:      r.Method,
		ContentType: r.Header.Get("Content-Type"),
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return riddleWebhookPayload{}, fmt.Errorf("Riddle webhook JSON body is required")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&payload.BodyFields); err != nil {
		return riddleWebhookPayload{}, fmt.Errorf("decode Riddle webhook JSON payload: %w", err)
	}
	payload.Raw = map[string]any{
		"method":       payload.Method,
		"content_type": payload.ContentType,
		"query":        riddleRedactedMap(payload.QueryFields),
		"body":         riddleRedactedMap(payload.BodyFields),
	}
	return payload, nil
}

func riddleAccountID(r *http.Request, payload riddleWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Account-ID"),
		r.Header.Get("X-Riddle-Account-ID"),
		r.URL.Query().Get("account_id"),
		r.URL.Query().Get("provider_account_id"),
		r.URL.Query().Get("riddle_account_id"),
		mapString(payload.BodyFields, "account_id", "accountId", "provider_account_id", "riddle_account_id"),
		riddleNestedString(payload.BodyFields, "apiInfo.account_id", "apiInfo.accountId", "data.account_id", "data.accountId", "account.id"),
	)
}

func riddleQuizID(r *http.Request, payload riddleWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Quiz-ID"),
		r.Header.Get("X-Riddle-ID"),
		r.Header.Get("X-Riddle-Quiz-ID"),
		r.URL.Query().Get("quiz_id"),
		r.URL.Query().Get("riddle_id"),
		r.URL.Query().Get("riddleId"),
		mapString(payload.BodyFields, "riddleId", "riddle_id", "quiz_id", "quizId"),
		riddleNestedString(payload.BodyFields, "riddleData.ID", "riddleData.id", "data.riddle.id", "data.riddle.riddleId", "apiInfo.riddle_id", "apiInfo.riddleId"),
	)
}

func riddleCampaignID(r *http.Request, payload riddleWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Campaign-ID"),
		r.Header.Get("X-Riddle-Campaign-ID"),
		r.URL.Query().Get("campaign_id"),
		r.URL.Query().Get("campaign"),
		r.URL.Query().Get("provider_campaign_id"),
		mapString(payload.BodyFields, "campaign_id", "campaignId", "campaign", "provider_campaign_id"),
		riddleNestedString(payload.BodyFields, "campaign.id", "data.campaign.id", "apiInfo.campaign_id", "apiInfo.campaignId"),
	)
}

func riddleRouteToken(r *http.Request, payload riddleWebhookPayload) string {
	return firstString(
		bearerToken(r.Header.Get("Authorization")),
		r.Header.Get("X-Postwave-Webhook-Token"),
		r.Header.Get("X-Postwave-Token"),
		r.Header.Get("X-Riddle-Webhook-Token"),
		r.Header.Get("X-Riddle-Token"),
		r.URL.Query().Get("token"),
		r.URL.Query().Get("webhook_token"),
		r.URL.Query().Get("route_token"),
		r.URL.Query().Get("postwave_token"),
		r.URL.Query().Get("riddle_token"),
		mapString(payload.BodyFields, "token", "webhook_token", "route_token", "postwave_token", "riddle_token"),
	)
}

func riddleSignature(r *http.Request, payload riddleWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Riddle-Signature"),
		r.Header.Get("X-Riddle-Signature-SHA256"),
		r.Header.Get("X-Webhook-Signature"),
		r.Header.Get("X-Signature"),
		r.Header.Get("X-Hub-Signature-256"),
		r.URL.Query().Get("signature"),
		r.URL.Query().Get("webhook_signature"),
		mapString(payload.BodyFields, "signature", "webhook_signature"),
	)
}

func riddleWebhookTopic(payload riddleWebhookPayload) string {
	raw := firstString(
		mapString(payload.BodyFields, "event", "event_type", "eventType", "topic", "type", "webhook_event"),
		mapString(payload.QueryFields, "event", "event_type", "eventType", "topic", "type", "webhook_event"),
		riddleNestedString(payload.BodyFields, "event.name", "event.type", "data.event.type"),
	)
	normalized := normalizeTypeformIdentityKey(raw)
	if strings.Contains(normalized, "complete") || strings.Contains(normalized, "result") || strings.Contains(normalized, "outcome") {
		return "riddle.completed"
	}
	return "lead.created"
}

func riddleWebhookID(r *http.Request, payload riddleWebhookPayload, accountID, quizID, topic string) string {
	if id := firstString(
		r.Header.Get("X-Riddle-Delivery-ID"),
		r.Header.Get("X-Webhook-ID"),
		mapString(payload.BodyFields, "event_id", "eventId", "webhook_id", "webhookId", "delivery_id", "deliveryId"),
		mapString(payload.QueryFields, "event_id", "eventId", "webhook_id", "webhookId", "delivery_id", "deliveryId"),
	); id != "" {
		return "riddle_" + normalizeTypeformIdentityKey(id)
	}
	if id := firstString(
		mapString(payload.BodyFields, "uniqueId", "unique_id", "GUID", "guid", "UUID", "uuid", "lead_id", "leadId", "submission_id", "submissionId", "response_id", "responseId", "identifier", "id"),
		mapString(payload.QueryFields, "uniqueId", "unique_id", "GUID", "guid", "UUID", "uuid", "lead_id", "leadId", "submission_id", "submissionId", "response_id", "responseId", "identifier", "id"),
		riddleNestedString(payload.BodyFields, "lead2Data.id", "leadData.id", "data.form.id", "data.lead.id", "form.id", "lead.id"),
	); id != "" {
		return "riddle_" + normalizeTypeformIdentityKey(topic+"_"+id)
	}
	if email := firstString(mapString(payload.BodyFields, "email"), riddleNestedString(payload.BodyFields, "data.form.email", "lead2Data.email", "leadData.email", "form.email")); email != "" {
		return "riddle_" + normalizeTypeformIdentityKey(topic+"_"+email)
	}
	sum := sha256.Sum256([]byte(accountID + "\n" + quizID + "\n" + topic + "\n" + riddleCanonicalWebhookFields(payload)))
	return "riddle_local_" + hex.EncodeToString(sum[:16])
}

func riddleCanonicalWebhookFields(payload riddleWebhookPayload) string {
	fields := riddleMergedSubmissionFields(payload)
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if riddleSecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(fields[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func mapRiddleWebhookSubmission(payload riddleWebhookPayload, accountID, quizID, campaignID, webhookID, topic string, integration Integration) SubmissionInput {
	fields := map[string]any{
		"riddle_account_id":    accountID,
		"riddle_quiz_id":       quizID,
		"riddle_webhook_id":    webhookID,
		"riddle_webhook_topic": topic,
		"riddle_provider_raw":  payload.Raw,
	}
	if campaignID != "" {
		fields["riddle_campaign_id"] = campaignID
	}
	if len(payload.QueryFields) > 0 {
		fields["riddle_query"] = riddleRedactedMap(payload.QueryFields)
	}
	identity := typeformIdentity{}
	for key, value := range riddleMergedSubmissionFields(payload) {
		if riddleControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := riddleRedactedValue(value)
		fields["riddle_field."+normalizedKey] = normalizedValue
		identity.apply(key, carrdIdentityText(normalizedValue))
	}
	riddleApplyConfiguredIdentity(&identity, integration, payload)
	submittedAt := parseFilloutTime(firstString(
		riddleConfiguredFieldString(integration, payload, "submitted_at_field_key"),
		mapString(payload.BodyFields, "submitted_at", "submittedAt", "created_at", "createdAt", "created", "createdAtUtc", "timestamp"),
		riddleNestedString(payload.BodyFields, "data.form.submitted_at", "data.form.createdAt", "lead2Data.createdAt", "leadData.createdAt", "apiInfo.createdAt"),
	))
	formName := firstString(
		settingString(integration.Settings, "quiz_name"),
		settingString(integration.Settings, "riddle_name"),
		riddleNestedString(payload.BodyFields, "data.riddle.title", "data.riddle.name", "riddleData.title", "riddleData.name"),
		quizID,
	)
	return SubmissionInput{
		SourceID:    riddleSourceID(accountID, quizID, webhookID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      quizID,
		FormName:    formName,
		EventName:   riddleEventName(topic),
		Tags:        riddleTags(integration, accountID, quizID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func riddleMergedSubmissionFields(payload riddleWebhookPayload) map[string]any {
	out := make(map[string]any, len(payload.QueryFields)+len(payload.BodyFields))
	for key, value := range payload.QueryFields {
		out[key] = value
	}
	for key, value := range payload.BodyFields {
		out[key] = value
	}
	for _, nestedKey := range []string{"form", "lead", "contact", "fields", "answers", "lead2Data", "leadData", "resultData", "questionData"} {
		nested, ok := payload.BodyFields[nestedKey].(map[string]any)
		if !ok {
			continue
		}
		for key, value := range nested {
			if _, exists := out[key]; !exists {
				out[key] = value
			}
		}
	}
	if data, ok := payload.BodyFields["data"].(map[string]any); ok {
		for _, nestedKey := range []string{"form", "lead", "contact", "fields", "answers", "result"} {
			nested, ok := data[nestedKey].(map[string]any)
			if !ok {
				continue
			}
			for key, value := range nested {
				if _, exists := out[key]; !exists {
					out[key] = value
				}
			}
		}
	}
	return out
}

func riddleApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, payload riddleWebhookPayload) {
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
		if value := riddleConfiguredFieldString(integration, payload, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func riddleConfiguredFieldString(integration Integration, payload riddleWebhookPayload, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	fields := riddleMergedSubmissionFields(payload)
	for key, value := range fields {
		if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
			return carrdIdentityText(value)
		}
	}
	return ""
}

func riddleControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "token", "webhook_token", "route_token", "postwave_token", "riddle_token", "signature", "webhook_signature", "secret", "password", "authorization", "account_id", "provider_account_id", "riddle_account_id", "campaign_id", "campaign", "provider_campaign_id", "quiz_id", "quizid", "riddle_id", "riddleid":
		return true
	default:
		return riddleSecretLikeKey(key)
	}
}

func riddleSecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") || strings.Contains(key, "secret") || strings.Contains(key, "password") || strings.Contains(key, "authorization") || strings.Contains(key, "signature")
}

func riddleRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if riddleSecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = riddleRedactedValue(value)
	}
	return out
}

func riddleRedactedValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return riddleRedactedMap(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, riddleRedactedValue(item))
		}
		return out
	default:
		return carrdNormalizeValue(value)
	}
}

func riddleNestedString(fields map[string]any, paths ...string) string {
	for _, path := range paths {
		current := any(fields)
		for _, part := range strings.Split(path, ".") {
			m, ok := current.(map[string]any)
			if !ok || m == nil {
				current = nil
				break
			}
			value, ok := m[part]
			if !ok {
				value, ok = m[strings.ToLower(part)]
			}
			if !ok {
				current = nil
				break
			}
			current = value
		}
		if text := carrdIdentityText(current); text != "" {
			return text
		}
	}
	return ""
}

func riddleEventName(topic string) string {
	switch topic {
	case "riddle.completed":
		return "lead.riddle.completed"
	default:
		return "lead.submitted"
	}
}

func riddleTags(integration Integration, accountID, quizID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"riddle", "riddle:" + accountID, "riddle:quiz:" + quizID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func riddleSourceID(accountID, quizID, webhookID string) string {
	return "riddle://lead/" + url.PathEscape(strings.TrimSpace(accountID)) + "/" + url.PathEscape(strings.TrimSpace(quizID)) + "/" + url.PathEscape(strings.TrimSpace(webhookID))
}
