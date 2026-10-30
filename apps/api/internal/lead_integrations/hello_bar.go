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
	helloBarWebhookMaxBodySize = 2 << 20
	helloBarWebhookTopic       = "lead.created"
)

type HelloBarCredentials struct {
	WebhookToken string
	UserAgent    string
}

type HelloBarCredentialResolver interface {
	ResolveHelloBar(context.Context, string, Integration) (HelloBarCredentials, error)
}

type HelloBarRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type HelloBarSecretsCredentialResolver struct {
	Secrets HelloBarRuntimeSecretResolver
}

func NewHelloBarSecretsCredentialResolver(secrets HelloBarRuntimeSecretResolver) *HelloBarSecretsCredentialResolver {
	return &HelloBarSecretsCredentialResolver{Secrets: secrets}
}

func (r *HelloBarSecretsCredentialResolver) ResolveHelloBar(ctx context.Context, _ string, integration Integration) (HelloBarCredentials, error) {
	if r == nil || r.Secrets == nil {
		return HelloBarCredentials{}, fmt.Errorf("hello bar credential resolver is not configured")
	}
	ref := helloBarCredentialRef(integration)
	if ref == "" {
		return HelloBarCredentials{}, fmt.Errorf("hello bar credentials_ref is required")
	}
	var payload helloBarCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return HelloBarCredentials{}, fmt.Errorf("resolve hello bar credentials %q: %w", ref, err)
		}
		return parseHelloBarCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return HelloBarCredentials{}, fmt.Errorf("resolve hello bar credentials %q: %w", ref, err)
	}
	return parseHelloBarCredentialSecret(raw)
}

type helloBarCredentialPayload struct {
	WebhookToken string `json:"webhook_token"`
	RouteToken   string `json:"route_token"`
	Token        string `json:"token"`
	Secret       string `json:"secret"`
	UserAgent    string `json:"user_agent"`
}

func (p helloBarCredentialPayload) credentials() (HelloBarCredentials, error) {
	token := strings.TrimSpace(firstString(p.WebhookToken, p.RouteToken, p.Token, p.Secret))
	if token == "" {
		return HelloBarCredentials{}, fmt.Errorf("hello bar webhook_token is required")
	}
	return HelloBarCredentials{WebhookToken: token, UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

func parseHelloBarCredentialSecret(raw string) (HelloBarCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return HelloBarCredentials{}, fmt.Errorf("hello bar credentials are empty")
	}
	var payload helloBarCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return HelloBarCredentials{}, fmt.Errorf("parse hello bar credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return HelloBarCredentials{}, fmt.Errorf("parse hello bar credential key-value secret: %w", err)
		}
		return helloBarCredentialPayload{
			WebhookToken: firstString(values.Get("webhook_token"), values.Get("route_token")),
			Token:        values.Get("token"),
			Secret:       values.Get("secret"),
			UserAgent:    values.Get("user_agent"),
		}.credentials()
	}
	return helloBarCredentialPayload{WebhookToken: raw}.credentials()
}

func helloBarCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) HelloBarWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, helloBarWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Hello Bar webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeHelloBarWebhookPayload(r, body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	siteID := helloBarSiteID(r, payload)
	if siteID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_site_id", "Hello Bar webhooks must include site_id in the query string, headers, or payload")
		return
	}
	campaignID := helloBarCampaignID(r, payload)
	if campaignID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_campaign_id", "Hello Bar webhooks must include campaign_id, bar_id, or form_id in the query string, headers, or payload")
		return
	}
	actualToken := helloBarRouteToken(r, payload)
	if actualToken == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_token", "Hello Bar route token is required")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderSiteAndForm(r.Context(), ProviderHelloBar, siteID, campaignID, "")
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Hello Bar integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "Hello Bar integration is disconnected")
		return
	}
	resolver := d.helloBarCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Hello Bar credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveHelloBar(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyHelloBarWebhookToken(creds.WebhookToken, actualToken); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_token", "request authentication failed")
		return
	}
	webhookID := helloBarWebhookID(payload, siteID, campaignID)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderHelloBar, webhookID, helloBarWebhookTopic, body)
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
	submission := mapHelloBarWebhookSubmission(payload, siteID, campaignID, webhookID, *integration)
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "hello-bar-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderHelloBar, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "hello bar webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderHelloBar, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderHelloBar, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifyHelloBarWebhookToken(expected, actual string) error {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	if expected == "" {
		return fmt.Errorf("hello bar webhook token is not configured")
	}
	if actual == "" {
		return fmt.Errorf("hello bar webhook token is required")
	}
	if !hmac.Equal([]byte(expected), []byte(actual)) {
		return fmt.Errorf("hello bar webhook token does not match")
	}
	return nil
}

type helloBarWebhookPayload struct {
	BodyFields  map[string]any
	QueryFields map[string]any
	Raw         map[string]any
	RawBody     []byte
	Method      string
	ContentType string
}

func decodeHelloBarWebhookPayload(r *http.Request, body []byte) (helloBarWebhookPayload, error) {
	payload := helloBarWebhookPayload{
		BodyFields:  map[string]any{},
		QueryFields: carrdValuesToMap(r.URL.Query()),
		RawBody:     append([]byte(nil), body...),
		Method:      r.Method,
		ContentType: r.Header.Get("Content-Type"),
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		fields, err := decodeCarrdBody(r.Header.Get("Content-Type"), body)
		if err != nil {
			return helloBarWebhookPayload{}, fmt.Errorf("decode Hello Bar webhook payload: %w", err)
		}
		payload.BodyFields = fields
	}
	payload.Raw = map[string]any{
		"method":       payload.Method,
		"content_type": payload.ContentType,
		"query":        helloBarRedactedMap(payload.QueryFields),
		"body":         helloBarRedactedMap(payload.BodyFields),
	}
	return payload, nil
}

func helloBarSiteID(r *http.Request, payload helloBarWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Site-ID"),
		r.Header.Get("X-HelloBar-Site-ID"),
		r.Header.Get("X-Hello-Bar-Site-ID"),
		r.URL.Query().Get("site_id"),
		r.URL.Query().Get("site"),
		r.URL.Query().Get("hello_bar_site_id"),
		mapString(payload.BodyFields, "site_id", "site", "hello_bar_site_id"),
	)
}

func helloBarCampaignID(r *http.Request, payload helloBarWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Campaign-ID"),
		r.Header.Get("X-HelloBar-Campaign-ID"),
		r.Header.Get("X-Hello-Bar-Campaign-ID"),
		r.URL.Query().Get("campaign_id"),
		r.URL.Query().Get("bar_id"),
		r.URL.Query().Get("form_id"),
		mapString(payload.BodyFields, "campaign_id", "bar_id", "barId", "form_id", "formId", "campaign"),
	)
}

func helloBarRouteToken(r *http.Request, payload helloBarWebhookPayload) string {
	return firstString(
		bearerToken(r.Header.Get("Authorization")),
		r.Header.Get("X-Postwave-Webhook-Token"),
		r.Header.Get("X-Postwave-Token"),
		r.Header.Get("X-HelloBar-Webhook-Token"),
		r.Header.Get("X-Hello-Bar-Webhook-Token"),
		r.URL.Query().Get("token"),
		r.URL.Query().Get("webhook_token"),
		r.URL.Query().Get("route_token"),
		r.URL.Query().Get("postwave_token"),
		r.URL.Query().Get("hello_bar_token"),
		mapString(payload.BodyFields, "token", "webhook_token", "route_token", "postwave_token", "hello_bar_token"),
	)
}

func helloBarWebhookID(payload helloBarWebhookPayload, siteID, campaignID string) string {
	if id := firstString(
		mapString(payload.BodyFields, "lead_id", "leadId", "subscriber_id", "subscriberId", "submission_id", "submissionId", "contact_id", "contactId", "id", "guid"),
		mapString(payload.QueryFields, "lead_id", "leadId", "subscriber_id", "subscriberId", "submission_id", "submissionId", "contact_id", "contactId", "id", "guid"),
	); id != "" {
		return "hello_bar_" + normalizeTypeformIdentityKey(id)
	}
	sum := sha256.Sum256([]byte(siteID + "\n" + campaignID + "\n" + helloBarCanonicalWebhookFields(payload)))
	return "hello_bar_local_" + hex.EncodeToString(sum[:16])
}

func helloBarCanonicalWebhookFields(payload helloBarWebhookPayload) string {
	fields := helloBarMergedSubmissionFields(payload)
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if helloBarSecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(fields[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func mapHelloBarWebhookSubmission(payload helloBarWebhookPayload, siteID, campaignID, webhookID string, integration Integration) SubmissionInput {
	fields := map[string]any{
		"hello_bar_site_id":      siteID,
		"hello_bar_campaign_id":  campaignID,
		"hello_bar_webhook_id":   webhookID,
		"hello_bar_provider_raw": payload.Raw,
	}
	if len(payload.QueryFields) > 0 {
		fields["hello_bar_query"] = helloBarRedactedMap(payload.QueryFields)
	}
	identity := typeformIdentity{}
	for key, value := range helloBarMergedSubmissionFields(payload) {
		if helloBarControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := carrdNormalizeValue(value)
		fields["hello_bar_field."+normalizedKey] = normalizedValue
		identity.apply(key, carrdIdentityText(normalizedValue))
	}
	helloBarApplyConfiguredIdentity(&identity, integration, payload)
	submittedAt := parseFilloutTime(firstString(
		helloBarConfiguredFieldString(integration, payload, "submitted_at_field_key"),
		mapString(payload.BodyFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date"),
		mapString(payload.QueryFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date"),
	))
	formName := firstString(
		settingString(integration.Settings, "form_name"),
		settingString(integration.Settings, "campaign_name"),
		settingString(integration.Settings, "bar_name"),
		mapString(payload.BodyFields, "bar_name", "campaign_name", "form_name"),
		mapString(payload.QueryFields, "bar_name", "campaign_name", "form_name"),
		campaignID,
	)
	return SubmissionInput{
		SourceID:    helloBarSourceID(siteID, campaignID, webhookID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      campaignID,
		FormName:    formName,
		EventName:   "lead.submitted",
		Tags:        helloBarTags(integration, siteID, campaignID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func helloBarMergedSubmissionFields(payload helloBarWebhookPayload) map[string]any {
	out := make(map[string]any, len(payload.QueryFields)+len(payload.BodyFields))
	for key, value := range payload.QueryFields {
		out[key] = value
	}
	for key, value := range payload.BodyFields {
		out[key] = value
	}
	return out
}

func helloBarApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, payload helloBarWebhookPayload) {
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
		if value := helloBarConfiguredFieldString(integration, payload, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func helloBarConfiguredFieldString(integration Integration, payload helloBarWebhookPayload, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	fields := helloBarMergedSubmissionFields(payload)
	for key, value := range fields {
		if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
			return carrdIdentityText(value)
		}
	}
	return ""
}

func helloBarControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "token", "webhook_token", "route_token", "postwave_token", "hello_bar_token", "secret", "password", "site_id", "site", "hello_bar_site_id", "campaign_id", "bar_id", "form_id", "campaign":
		return true
	default:
		return helloBarSecretLikeKey(key)
	}
}

func helloBarSecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") || strings.Contains(key, "secret") || strings.Contains(key, "password")
}

func helloBarRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if helloBarSecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = carrdNormalizeValue(value)
	}
	return out
}

func helloBarTags(integration Integration, siteID, campaignID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"hello-bar", "hello-bar:" + siteID, "hello-bar:campaign:" + campaignID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func helloBarSourceID(siteID, campaignID, webhookID string) string {
	siteID = strings.TrimSpace(siteID)
	campaignID = strings.TrimSpace(campaignID)
	webhookID = strings.TrimSpace(webhookID)
	return "hello-bar://lead/" + siteID + "/" + campaignID + "/" + webhookID
}
