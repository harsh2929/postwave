// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
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

const outgrowWebhookMaxBodySize = 2 << 20

type OutgrowCredentials struct {
	WebhookToken string
	Username     string
	Password     string
	UserAgent    string
}

type OutgrowCredentialResolver interface {
	ResolveOutgrow(context.Context, string, Integration) (OutgrowCredentials, error)
}

type OutgrowRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type OutgrowSecretsCredentialResolver struct {
	Secrets OutgrowRuntimeSecretResolver
}

func NewOutgrowSecretsCredentialResolver(secrets OutgrowRuntimeSecretResolver) *OutgrowSecretsCredentialResolver {
	return &OutgrowSecretsCredentialResolver{Secrets: secrets}
}

func (r *OutgrowSecretsCredentialResolver) ResolveOutgrow(ctx context.Context, _ string, integration Integration) (OutgrowCredentials, error) {
	if r == nil || r.Secrets == nil {
		return OutgrowCredentials{}, fmt.Errorf("outgrow credential resolver is not configured")
	}
	ref := outgrowCredentialRef(integration)
	if ref == "" {
		return OutgrowCredentials{}, fmt.Errorf("outgrow credentials_ref is required")
	}
	var payload outgrowCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return OutgrowCredentials{}, fmt.Errorf("resolve outgrow credentials %q: %w", ref, err)
		}
		return parseOutgrowCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return OutgrowCredentials{}, fmt.Errorf("resolve outgrow credentials %q: %w", ref, err)
	}
	return parseOutgrowCredentialSecret(raw)
}

type outgrowCredentialPayload struct {
	WebhookToken    string `json:"webhook_token"`
	RouteToken      string `json:"route_token"`
	Token           string `json:"token"`
	Secret          string `json:"secret"`
	Username        string `json:"username"`
	WebhookUsername string `json:"webhook_username"`
	BasicUsername   string `json:"basic_username"`
	Password        string `json:"password"`
	WebhookPassword string `json:"webhook_password"`
	BasicPassword   string `json:"basic_password"`
	UserAgent       string `json:"user_agent"`
}

func (p outgrowCredentialPayload) credentials() (OutgrowCredentials, error) {
	token := strings.TrimSpace(firstString(p.WebhookToken, p.RouteToken, p.Token, p.Secret))
	username := strings.TrimSpace(firstString(p.Username, p.WebhookUsername, p.BasicUsername))
	password := strings.TrimSpace(firstString(p.Password, p.WebhookPassword, p.BasicPassword))
	if username == "" && password != "" {
		username = "postwave"
	}
	if token == "" && (username == "" || password == "") {
		return OutgrowCredentials{}, fmt.Errorf("outgrow webhook_token or basic auth username/password is required")
	}
	return OutgrowCredentials{
		WebhookToken: token,
		Username:     username,
		Password:     password,
		UserAgent:    strings.TrimSpace(p.UserAgent),
	}, nil
}

func parseOutgrowCredentialSecret(raw string) (OutgrowCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return OutgrowCredentials{}, fmt.Errorf("outgrow credentials are empty")
	}
	var payload outgrowCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return OutgrowCredentials{}, fmt.Errorf("parse outgrow credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return OutgrowCredentials{}, fmt.Errorf("parse outgrow credential key-value secret: %w", err)
		}
		return outgrowCredentialPayload{
			WebhookToken:    firstString(values.Get("webhook_token"), values.Get("route_token")),
			Token:           values.Get("token"),
			Secret:          values.Get("secret"),
			Username:        firstString(values.Get("username"), values.Get("webhook_username"), values.Get("basic_username")),
			Password:        firstString(values.Get("password"), values.Get("webhook_password"), values.Get("basic_password")),
			WebhookPassword: values.Get("webhook_auth_password"),
			UserAgent:       values.Get("user_agent"),
		}.credentials()
	}
	if parts := strings.SplitN(raw, ":", 2); len(parts) == 2 {
		return outgrowCredentialPayload{Username: parts[0], Password: parts[1]}.credentials()
	}
	return outgrowCredentialPayload{WebhookToken: raw}.credentials()
}

func outgrowCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) OutgrowWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, outgrowWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Outgrow webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeOutgrowWebhookPayload(r, body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	accountID := outgrowAccountID(r, payload)
	if accountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "Outgrow webhooks must include account_id in headers, query string, or payload")
		return
	}
	campaignID := outgrowCampaignID(r, payload)
	if campaignID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_campaign_id", "Outgrow webhooks must include campaign_id, content_id, calculator_id, quiz_id, or experience_id in headers, query string, or payload")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderAccountAndCampaign(r.Context(), ProviderOutgrow, accountID, campaignID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Outgrow integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "Outgrow integration is disconnected")
		return
	}
	experienceID := outgrowExperienceID(r, payload)
	if configuredCalculatorID := settingString(integration.Settings, "calculator_id"); configuredCalculatorID != "" && experienceID != "" && !strings.EqualFold(configuredCalculatorID, experienceID) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Outgrow integration not found for calculator_id")
		return
	}
	if configuredQuizID := settingString(integration.Settings, "quiz_id"); configuredQuizID != "" && experienceID != "" && !strings.EqualFold(configuredQuizID, experienceID) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Outgrow integration not found for quiz_id")
		return
	}
	resolver := d.outgrowCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Outgrow credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveOutgrow(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyOutgrowWebhookAuth(creds, r, payload); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_webhook_auth", "request authentication failed")
		return
	}
	topic := outgrowWebhookTopic(payload)
	webhookID := outgrowWebhookID(payload, accountID, campaignID, topic)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderOutgrow, webhookID, topic, body)
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
	submission := mapOutgrowWebhookSubmission(payload, accountID, campaignID, firstString(experienceID, settingString(integration.Settings, "quiz_id"), settingString(integration.Settings, "calculator_id")), webhookID, topic, *integration)
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "outgrow-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderOutgrow, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "outgrow webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderOutgrow, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderOutgrow, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifyOutgrowWebhookAuth(expected OutgrowCredentials, r *http.Request, payload outgrowWebhookPayload) error {
	var reasons []string
	if strings.TrimSpace(expected.WebhookToken) != "" {
		actual := outgrowRouteToken(r, payload)
		if actual != "" && VerifyOutgrowWebhookToken(expected.WebhookToken, actual) == nil {
			return nil
		}
		if actual == "" {
			reasons = append(reasons, "outgrow route token is required")
		} else {
			reasons = append(reasons, "outgrow route token does not match")
		}
	}
	if strings.TrimSpace(expected.Username) != "" || strings.TrimSpace(expected.Password) != "" {
		if err := VerifyOutgrowBasicAuth(expected, r.Header.Get("Authorization")); err == nil {
			return nil
		} else {
			reasons = append(reasons, err.Error())
		}
	}
	if len(reasons) == 0 {
		return fmt.Errorf("outgrow webhook credentials are not configured")
	}
	return fmt.Errorf("%s", strings.Join(reasons, "; "))
}

func VerifyOutgrowWebhookToken(expected, actual string) error {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	if expected == "" {
		return fmt.Errorf("outgrow webhook token is not configured")
	}
	if actual == "" {
		return fmt.Errorf("outgrow webhook token is required")
	}
	if !hmac.Equal([]byte(expected), []byte(actual)) {
		return fmt.Errorf("outgrow webhook token does not match")
	}
	return nil
}

func VerifyOutgrowBasicAuth(expected OutgrowCredentials, authorization string) error {
	expected.Username = strings.TrimSpace(expected.Username)
	expected.Password = strings.TrimSpace(expected.Password)
	if expected.Username == "" || expected.Password == "" {
		return fmt.Errorf("outgrow basic auth credentials are not configured")
	}
	authorization = strings.TrimSpace(authorization)
	if authorization == "" {
		return fmt.Errorf("outgrow Basic Authorization header is required")
	}
	if !strings.HasPrefix(strings.ToLower(authorization), "basic ") {
		return fmt.Errorf("outgrow Authorization header must use Basic auth")
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(authorization[len("Basic "):]))
	if err != nil {
		return fmt.Errorf("decode outgrow Basic auth header: %w", err)
	}
	parts := strings.SplitN(string(decoded), ":", 2)
	if len(parts) != 2 {
		return fmt.Errorf("outgrow Basic auth header is malformed")
	}
	if !hmac.Equal([]byte(expected.Username), []byte(parts[0])) || !hmac.Equal([]byte(expected.Password), []byte(parts[1])) {
		return fmt.Errorf("outgrow Basic auth credentials do not match")
	}
	return nil
}

type outgrowWebhookPayload struct {
	BodyFields  map[string]any
	QueryFields map[string]any
	Raw         map[string]any
	RawBody     []byte
	Method      string
	ContentType string
}

func decodeOutgrowWebhookPayload(r *http.Request, body []byte) (outgrowWebhookPayload, error) {
	payload := outgrowWebhookPayload{
		BodyFields:  map[string]any{},
		QueryFields: carrdValuesToMap(r.URL.Query()),
		RawBody:     append([]byte(nil), body...),
		Method:      r.Method,
		ContentType: r.Header.Get("Content-Type"),
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		fields, err := decodeCarrdBody(r.Header.Get("Content-Type"), body)
		if err != nil {
			return outgrowWebhookPayload{}, fmt.Errorf("decode Outgrow webhook payload: %w", err)
		}
		payload.BodyFields = fields
	}
	payload.Raw = map[string]any{
		"method":       payload.Method,
		"content_type": payload.ContentType,
		"query":        outgrowRedactedMap(payload.QueryFields),
		"body":         outgrowRedactedMap(payload.BodyFields),
	}
	return payload, nil
}

func outgrowAccountID(r *http.Request, payload outgrowWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Account-ID"),
		r.Header.Get("X-Outgrow-Account-ID"),
		r.URL.Query().Get("account_id"),
		r.URL.Query().Get("provider_account_id"),
		r.URL.Query().Get("outgrow_account_id"),
		mapString(payload.BodyFields, "account_id", "provider_account_id", "outgrow_account_id"),
		outgrowNestedString(payload.BodyFields, "account.id", "account.uid", "workspace.id", "company.id"),
	)
}

func outgrowCampaignID(r *http.Request, payload outgrowWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Campaign-ID"),
		r.Header.Get("X-Outgrow-Campaign-ID"),
		r.URL.Query().Get("campaign_id"),
		r.URL.Query().Get("campaign"),
		r.URL.Query().Get("provider_campaign_id"),
		r.URL.Query().Get("outgrow_campaign_id"),
		r.URL.Query().Get("content_id"),
		r.URL.Query().Get("calculator_id"),
		r.URL.Query().Get("quiz_id"),
		r.URL.Query().Get("experience_id"),
		mapString(payload.BodyFields, "campaign_id", "campaignId", "campaign", "provider_campaign_id", "outgrow_campaign_id", "content_id", "contentId", "calculator_id", "calculatorId", "quiz_id", "quizId", "experience_id", "experienceId"),
		outgrowNestedString(payload.BodyFields, "campaign.id", "campaign.uid", "content.id", "calculator.id", "quiz.id", "experience.id"),
	)
}

func outgrowExperienceID(r *http.Request, payload outgrowWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Experience-ID"),
		r.Header.Get("X-Outgrow-Experience-ID"),
		r.URL.Query().Get("experience_id"),
		r.URL.Query().Get("calculator_id"),
		r.URL.Query().Get("quiz_id"),
		r.URL.Query().Get("content_id"),
		mapString(payload.BodyFields, "experience_id", "experienceId", "calculator_id", "calculatorId", "quiz_id", "quizId", "content_id", "contentId"),
		outgrowNestedString(payload.BodyFields, "experience.id", "calculator.id", "quiz.id", "content.id"),
	)
}

func outgrowRouteToken(r *http.Request, payload outgrowWebhookPayload) string {
	return firstString(
		bearerToken(r.Header.Get("Authorization")),
		r.Header.Get("X-Postwave-Webhook-Token"),
		r.Header.Get("X-Postwave-Token"),
		r.Header.Get("X-Outgrow-Webhook-Token"),
		r.Header.Get("X-Outgrow-Token"),
		r.URL.Query().Get("token"),
		r.URL.Query().Get("webhook_token"),
		r.URL.Query().Get("route_token"),
		r.URL.Query().Get("postwave_token"),
		r.URL.Query().Get("outgrow_token"),
		mapString(payload.BodyFields, "token", "webhook_token", "route_token", "postwave_token", "outgrow_token"),
	)
}

func outgrowWebhookTopic(payload outgrowWebhookPayload) string {
	raw := firstString(
		mapString(payload.BodyFields, "event", "event_type", "eventType", "topic", "type", "webhook_event"),
		mapString(payload.QueryFields, "event", "event_type", "eventType", "topic", "type", "webhook_event"),
		outgrowNestedString(payload.BodyFields, "event.name", "event.type"),
	)
	normalized := normalizeTypeformIdentityKey(raw)
	switch {
	case strings.Contains(normalized, "visit"):
		return "visit.created"
	case strings.Contains(normalized, "result") || strings.Contains(normalized, "calculate") || strings.Contains(normalized, "outcome") || strings.Contains(normalized, "complete"):
		return "result.calculated"
	default:
		return "lead.created"
	}
}

func outgrowWebhookID(payload outgrowWebhookPayload, accountID, campaignID, topic string) string {
	if id := firstString(
		mapString(payload.BodyFields, "event_id", "eventId", "webhook_id", "webhookId", "delivery_id", "deliveryId"),
		mapString(payload.QueryFields, "event_id", "eventId", "webhook_id", "webhookId", "delivery_id", "deliveryId"),
	); id != "" {
		return "outgrow_" + normalizeTypeformIdentityKey(id)
	}
	if id := firstString(
		mapString(payload.BodyFields, "lead_id", "leadId", "submission_id", "submissionId", "response_id", "responseId", "contact_id", "contactId", "id", "uuid", "uid"),
		mapString(payload.QueryFields, "lead_id", "leadId", "submission_id", "submissionId", "response_id", "responseId", "contact_id", "contactId", "id", "uuid", "uid"),
		outgrowNestedString(payload.BodyFields, "lead.id", "contact.id", "response.id", "submission.id"),
	); id != "" {
		return "outgrow_" + normalizeTypeformIdentityKey(topic+"_"+id)
	}
	if email := firstString(mapString(payload.BodyFields, "email"), mapString(payload.QueryFields, "email"), outgrowNestedString(payload.BodyFields, "lead.email", "contact.email", "data.email")); email != "" {
		return "outgrow_" + normalizeTypeformIdentityKey(topic+"_"+email)
	}
	sum := sha256.Sum256([]byte(accountID + "\n" + campaignID + "\n" + topic + "\n" + outgrowCanonicalWebhookFields(payload)))
	return "outgrow_local_" + hex.EncodeToString(sum[:16])
}

func outgrowCanonicalWebhookFields(payload outgrowWebhookPayload) string {
	fields := outgrowMergedSubmissionFields(payload)
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if outgrowSecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(fields[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func mapOutgrowWebhookSubmission(payload outgrowWebhookPayload, accountID, campaignID, experienceID, webhookID, topic string, integration Integration) SubmissionInput {
	fields := map[string]any{
		"outgrow_account_id":    accountID,
		"outgrow_campaign_id":   campaignID,
		"outgrow_webhook_id":    webhookID,
		"outgrow_webhook_topic": topic,
		"outgrow_provider_raw":  payload.Raw,
	}
	if experienceID != "" {
		fields["outgrow_experience_id"] = experienceID
	}
	if len(payload.QueryFields) > 0 {
		fields["outgrow_query"] = outgrowRedactedMap(payload.QueryFields)
	}
	identity := typeformIdentity{}
	for key, value := range outgrowMergedSubmissionFields(payload) {
		if outgrowControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := carrdNormalizeValue(value)
		fields["outgrow_field."+normalizedKey] = normalizedValue
		identity.apply(key, carrdIdentityText(normalizedValue))
	}
	outgrowApplyConfiguredIdentity(&identity, integration, payload)
	submittedAt := parseFilloutTime(firstString(
		outgrowConfiguredFieldString(integration, payload, "submitted_at_field_key"),
		mapString(payload.BodyFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date", "lead_created_at"),
		mapString(payload.QueryFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date", "lead_created_at"),
		outgrowNestedString(payload.BodyFields, "lead.created_at", "contact.created_at", "response.created_at", "event.created_at"),
	))
	formName := firstString(
		settingString(integration.Settings, "campaign_name"),
		settingString(integration.Settings, "calculator_name"),
		settingString(integration.Settings, "quiz_name"),
		mapString(payload.BodyFields, "campaign_name", "campaignName", "calculator_name", "calculatorName", "quiz_name", "quizName", "experience_name", "experienceName", "content_name", "contentName"),
		outgrowNestedString(payload.BodyFields, "campaign.name", "calculator.name", "quiz.name", "experience.name", "content.name"),
		campaignID,
	)
	return SubmissionInput{
		SourceID:    outgrowSourceID(accountID, campaignID, webhookID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      firstString(experienceID, campaignID),
		FormName:    formName,
		EventName:   outgrowEventName(topic),
		Tags:        outgrowTags(integration, accountID, campaignID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func outgrowMergedSubmissionFields(payload outgrowWebhookPayload) map[string]any {
	out := make(map[string]any, len(payload.QueryFields)+len(payload.BodyFields))
	for key, value := range payload.QueryFields {
		out[key] = value
	}
	for key, value := range payload.BodyFields {
		out[key] = value
	}
	for _, nestedKey := range []string{"lead", "contact", "fields", "answers", "data", "response", "submission"} {
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
	return out
}

func outgrowApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, payload outgrowWebhookPayload) {
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
		if value := outgrowConfiguredFieldString(integration, payload, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func outgrowConfiguredFieldString(integration Integration, payload outgrowWebhookPayload, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	fields := outgrowMergedSubmissionFields(payload)
	for key, value := range fields {
		if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
			return carrdIdentityText(value)
		}
	}
	return ""
}

func outgrowControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "token", "webhook_token", "route_token", "postwave_token", "outgrow_token", "secret", "password", "authorization", "account_id", "provider_account_id", "outgrow_account_id", "campaign_id", "campaign", "provider_campaign_id", "outgrow_campaign_id", "content_id", "calculator_id", "quiz_id", "experience_id":
		return true
	default:
		return outgrowSecretLikeKey(key)
	}
}

func outgrowSecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") || strings.Contains(key, "secret") || strings.Contains(key, "password") || strings.Contains(key, "authorization")
}

func outgrowRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if outgrowSecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = outgrowRedactedValue(value)
	}
	return out
}

func outgrowRedactedValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return outgrowRedactedMap(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, outgrowRedactedValue(item))
		}
		return out
	default:
		return carrdNormalizeValue(value)
	}
}

func outgrowNestedString(fields map[string]any, paths ...string) string {
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

func outgrowEventName(topic string) string {
	switch topic {
	case "visit.created":
		return "lead.visit.created"
	case "result.calculated":
		return "lead.result.calculated"
	default:
		return "lead.submitted"
	}
}

func outgrowTags(integration Integration, accountID, campaignID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"outgrow", "outgrow:" + accountID, "outgrow:campaign:" + campaignID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func outgrowSourceID(accountID, campaignID, webhookID string) string {
	return "outgrow://lead/" + url.PathEscape(strings.TrimSpace(accountID)) + "/" + url.PathEscape(strings.TrimSpace(campaignID)) + "/" + url.PathEscape(strings.TrimSpace(webhookID))
}
