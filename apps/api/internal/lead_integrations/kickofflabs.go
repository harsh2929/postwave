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

const kickoffLabsWebhookMaxBodySize = 2 << 20

type KickoffLabsCredentials struct {
	WebhookToken string
	UserAgent    string
}

type KickoffLabsCredentialResolver interface {
	ResolveKickoffLabs(context.Context, string, Integration) (KickoffLabsCredentials, error)
}

type KickoffLabsRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type KickoffLabsSecretsCredentialResolver struct {
	Secrets KickoffLabsRuntimeSecretResolver
}

func NewKickoffLabsSecretsCredentialResolver(secrets KickoffLabsRuntimeSecretResolver) *KickoffLabsSecretsCredentialResolver {
	return &KickoffLabsSecretsCredentialResolver{Secrets: secrets}
}

func (r *KickoffLabsSecretsCredentialResolver) ResolveKickoffLabs(ctx context.Context, _ string, integration Integration) (KickoffLabsCredentials, error) {
	if r == nil || r.Secrets == nil {
		return KickoffLabsCredentials{}, fmt.Errorf("kickofflabs credential resolver is not configured")
	}
	ref := kickoffLabsCredentialRef(integration)
	if ref == "" {
		return KickoffLabsCredentials{}, fmt.Errorf("kickofflabs credentials_ref is required")
	}
	var payload kickoffLabsCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return KickoffLabsCredentials{}, fmt.Errorf("resolve kickofflabs credentials %q: %w", ref, err)
		}
		return parseKickoffLabsCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return KickoffLabsCredentials{}, fmt.Errorf("resolve kickofflabs credentials %q: %w", ref, err)
	}
	return parseKickoffLabsCredentialSecret(raw)
}

type kickoffLabsCredentialPayload struct {
	WebhookToken string `json:"webhook_token"`
	RouteToken   string `json:"route_token"`
	Token        string `json:"token"`
	Secret       string `json:"secret"`
	UserAgent    string `json:"user_agent"`
}

func (p kickoffLabsCredentialPayload) credentials() (KickoffLabsCredentials, error) {
	token := strings.TrimSpace(firstString(p.WebhookToken, p.RouteToken, p.Token, p.Secret))
	if token == "" {
		return KickoffLabsCredentials{}, fmt.Errorf("kickofflabs webhook_token is required")
	}
	return KickoffLabsCredentials{WebhookToken: token, UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

func parseKickoffLabsCredentialSecret(raw string) (KickoffLabsCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return KickoffLabsCredentials{}, fmt.Errorf("kickofflabs credentials are empty")
	}
	var payload kickoffLabsCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return KickoffLabsCredentials{}, fmt.Errorf("parse kickofflabs credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return KickoffLabsCredentials{}, fmt.Errorf("parse kickofflabs credential key-value secret: %w", err)
		}
		return kickoffLabsCredentialPayload{
			WebhookToken: firstString(values.Get("webhook_token"), values.Get("route_token")),
			Token:        values.Get("token"),
			Secret:       values.Get("secret"),
			UserAgent:    values.Get("user_agent"),
		}.credentials()
	}
	return kickoffLabsCredentialPayload{WebhookToken: raw}.credentials()
}

func kickoffLabsCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) KickoffLabsWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, kickoffLabsWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "KickoffLabs webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeKickoffLabsWebhookPayload(r, body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	accountID := kickoffLabsAccountID(r, payload)
	if accountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "KickoffLabs webhooks must include account_id in headers, query string, or payload")
		return
	}
	campaignID := kickoffLabsCampaignID(r, payload)
	if campaignID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_campaign_id", "KickoffLabs webhooks must include campaign_id in headers, query string, or payload")
		return
	}
	actualToken := kickoffLabsRouteToken(r, payload)
	if actualToken == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_token", "KickoffLabs route token is required")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderAccountAndCampaign(r.Context(), ProviderKickoffLabs, accountID, campaignID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "KickoffLabs integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "KickoffLabs integration is disconnected")
		return
	}
	pageID := kickoffLabsPageID(r, payload)
	if configuredPageID := settingString(integration.Settings, "page_id"); configuredPageID != "" && pageID != "" && !strings.EqualFold(configuredPageID, pageID) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "KickoffLabs integration not found for page_id")
		return
	}
	resolver := d.kickoffLabsCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "KickoffLabs credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveKickoffLabs(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyKickoffLabsWebhookToken(creds.WebhookToken, actualToken); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_token", "request authentication failed")
		return
	}
	topic := kickoffLabsWebhookTopic(payload)
	webhookID := kickoffLabsWebhookID(payload, accountID, campaignID, topic)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderKickoffLabs, webhookID, topic, body)
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
	submission := mapKickoffLabsWebhookSubmission(payload, accountID, campaignID, firstString(pageID, settingString(integration.Settings, "page_id")), webhookID, topic, *integration)
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "kickofflabs-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderKickoffLabs, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "kickofflabs webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderKickoffLabs, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderKickoffLabs, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifyKickoffLabsWebhookToken(expected, actual string) error {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	if expected == "" {
		return fmt.Errorf("kickofflabs webhook token is not configured")
	}
	if actual == "" {
		return fmt.Errorf("kickofflabs webhook token is required")
	}
	if !hmac.Equal([]byte(expected), []byte(actual)) {
		return fmt.Errorf("kickofflabs webhook token does not match")
	}
	return nil
}

type kickoffLabsWebhookPayload struct {
	BodyFields  map[string]any
	QueryFields map[string]any
	Raw         map[string]any
	RawBody     []byte
	Method      string
	ContentType string
}

func decodeKickoffLabsWebhookPayload(r *http.Request, body []byte) (kickoffLabsWebhookPayload, error) {
	payload := kickoffLabsWebhookPayload{
		BodyFields:  map[string]any{},
		QueryFields: carrdValuesToMap(r.URL.Query()),
		RawBody:     append([]byte(nil), body...),
		Method:      r.Method,
		ContentType: r.Header.Get("Content-Type"),
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		fields, err := decodeCarrdBody(r.Header.Get("Content-Type"), body)
		if err != nil {
			return kickoffLabsWebhookPayload{}, fmt.Errorf("decode KickoffLabs webhook payload: %w", err)
		}
		payload.BodyFields = fields
	}
	payload.Raw = map[string]any{
		"method":       payload.Method,
		"content_type": payload.ContentType,
		"query":        kickoffLabsRedactedMap(payload.QueryFields),
		"body":         kickoffLabsRedactedMap(payload.BodyFields),
	}
	return payload, nil
}

func kickoffLabsAccountID(r *http.Request, payload kickoffLabsWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Account-ID"),
		r.Header.Get("X-KickoffLabs-Account-ID"),
		r.URL.Query().Get("account_id"),
		r.URL.Query().Get("provider_account_id"),
		r.URL.Query().Get("kickofflabs_account_id"),
		mapString(payload.BodyFields, "account_id", "provider_account_id", "kickofflabs_account_id"),
		kickoffLabsNestedString(payload.BodyFields, "account.id", "account.uid"),
	)
}

func kickoffLabsCampaignID(r *http.Request, payload kickoffLabsWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Campaign-ID"),
		r.Header.Get("X-KickoffLabs-Campaign-ID"),
		r.URL.Query().Get("campaign_id"),
		r.URL.Query().Get("campaign"),
		r.URL.Query().Get("provider_campaign_id"),
		r.URL.Query().Get("landing_page_id"),
		mapString(payload.BodyFields, "campaign_id", "campaignId", "campaign", "provider_campaign_id", "kickofflabs_campaign_id", "landing_page_id", "landingPageId"),
		kickoffLabsNestedString(payload.BodyFields, "campaign.id", "campaign.uid", "landing_page.id", "page.campaign_id"),
	)
}

func kickoffLabsPageID(r *http.Request, payload kickoffLabsWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Page-ID"),
		r.Header.Get("X-KickoffLabs-Page-ID"),
		r.URL.Query().Get("page_id"),
		r.URL.Query().Get("landing_page_id"),
		mapString(payload.BodyFields, "page_id", "pageId", "landing_page_id", "landingPageId", "landing_page", "page"),
		kickoffLabsNestedString(payload.BodyFields, "page.id", "landing_page.id"),
	)
}

func kickoffLabsRouteToken(r *http.Request, payload kickoffLabsWebhookPayload) string {
	return firstString(
		bearerToken(r.Header.Get("Authorization")),
		r.Header.Get("X-Postwave-Webhook-Token"),
		r.Header.Get("X-Postwave-Token"),
		r.Header.Get("X-KickoffLabs-Webhook-Token"),
		r.URL.Query().Get("token"),
		r.URL.Query().Get("webhook_token"),
		r.URL.Query().Get("route_token"),
		r.URL.Query().Get("postwave_token"),
		r.URL.Query().Get("kickofflabs_token"),
		mapString(payload.BodyFields, "token", "webhook_token", "route_token", "postwave_token", "kickofflabs_token"),
	)
}

func kickoffLabsWebhookTopic(payload kickoffLabsWebhookPayload) string {
	raw := firstString(
		mapString(payload.BodyFields, "event", "event_type", "eventType", "topic", "type", "webhook_event"),
		mapString(payload.QueryFields, "event", "event_type", "eventType", "topic", "type", "webhook_event"),
	)
	normalized := normalizeTypeformIdentityKey(raw)
	switch {
	case strings.Contains(normalized, "referral") || strings.Contains(normalized, "viral"):
		return "referral.created"
	case strings.Contains(normalized, "reward"):
		return "reward.earned"
	case strings.Contains(normalized, "tag"):
		return "lead.tagged"
	case strings.Contains(normalized, "optout") || strings.Contains(normalized, "opt_out") || strings.Contains(normalized, "unsubscribe"):
		return "lead.opted_out"
	case strings.Contains(normalized, "fraud"):
		return "lead.fraud.flagged"
	default:
		return "lead.created"
	}
}

func kickoffLabsWebhookID(payload kickoffLabsWebhookPayload, accountID, campaignID, topic string) string {
	if id := firstString(
		mapString(payload.BodyFields, "event_id", "eventId", "webhook_id", "webhookId", "delivery_id", "deliveryId"),
		mapString(payload.QueryFields, "event_id", "eventId", "webhook_id", "webhookId", "delivery_id", "deliveryId"),
	); id != "" {
		return "kickofflabs_" + normalizeTypeformIdentityKey(id)
	}
	if id := firstString(
		mapString(payload.BodyFields, "lead_id", "leadId", "subscriber_id", "subscriberId", "person_id", "personId", "id", "uuid", "uid"),
		mapString(payload.QueryFields, "lead_id", "leadId", "subscriber_id", "subscriberId", "person_id", "personId", "id", "uuid", "uid"),
		kickoffLabsNestedString(payload.BodyFields, "lead.id", "lead.uid", "person.id"),
	); id != "" {
		return "kickofflabs_" + normalizeTypeformIdentityKey(topic+"_"+id)
	}
	if email := firstString(mapString(payload.BodyFields, "email"), mapString(payload.QueryFields, "email"), kickoffLabsNestedString(payload.BodyFields, "lead.email", "person.email")); email != "" {
		return "kickofflabs_" + normalizeTypeformIdentityKey(topic+"_"+email)
	}
	sum := sha256.Sum256([]byte(accountID + "\n" + campaignID + "\n" + topic + "\n" + kickoffLabsCanonicalWebhookFields(payload)))
	return "kickofflabs_local_" + hex.EncodeToString(sum[:16])
}

func kickoffLabsCanonicalWebhookFields(payload kickoffLabsWebhookPayload) string {
	fields := kickoffLabsMergedSubmissionFields(payload)
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if kickoffLabsSecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(fields[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func mapKickoffLabsWebhookSubmission(payload kickoffLabsWebhookPayload, accountID, campaignID, pageID, webhookID, topic string, integration Integration) SubmissionInput {
	fields := map[string]any{
		"kickofflabs_account_id":    accountID,
		"kickofflabs_campaign_id":   campaignID,
		"kickofflabs_webhook_id":    webhookID,
		"kickofflabs_webhook_topic": topic,
		"kickofflabs_provider_raw":  payload.Raw,
	}
	if pageID != "" {
		fields["kickofflabs_page_id"] = pageID
	}
	if len(payload.QueryFields) > 0 {
		fields["kickofflabs_query"] = kickoffLabsRedactedMap(payload.QueryFields)
	}
	identity := typeformIdentity{}
	for key, value := range kickoffLabsMergedSubmissionFields(payload) {
		if kickoffLabsControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := carrdNormalizeValue(value)
		fields["kickofflabs_field."+normalizedKey] = normalizedValue
		identity.apply(key, carrdIdentityText(normalizedValue))
	}
	kickoffLabsApplyConfiguredIdentity(&identity, integration, payload)
	submittedAt := parseFilloutTime(firstString(
		kickoffLabsConfiguredFieldString(integration, payload, "submitted_at_field_key"),
		mapString(payload.BodyFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date", "signed_up_at", "signup_time"),
		mapString(payload.QueryFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date", "signed_up_at", "signup_time"),
		kickoffLabsNestedString(payload.BodyFields, "lead.created_at", "lead.signed_up_at"),
	))
	formName := firstString(
		settingString(integration.Settings, "campaign_name"),
		settingString(integration.Settings, "page_name"),
		mapString(payload.BodyFields, "campaign_name", "campaignName", "page_name", "landing_page_name"),
		kickoffLabsNestedString(payload.BodyFields, "campaign.name", "page.name", "landing_page.name"),
		campaignID,
	)
	return SubmissionInput{
		SourceID:    kickoffLabsSourceID(accountID, campaignID, webhookID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      firstString(pageID, campaignID),
		FormName:    formName,
		EventName:   kickoffLabsEventName(topic),
		Tags:        kickoffLabsTags(integration, accountID, campaignID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func kickoffLabsMergedSubmissionFields(payload kickoffLabsWebhookPayload) map[string]any {
	out := make(map[string]any, len(payload.QueryFields)+len(payload.BodyFields))
	for key, value := range payload.QueryFields {
		out[key] = value
	}
	for key, value := range payload.BodyFields {
		out[key] = value
	}
	return out
}

func kickoffLabsApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, payload kickoffLabsWebhookPayload) {
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
		if value := kickoffLabsConfiguredFieldString(integration, payload, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func kickoffLabsConfiguredFieldString(integration Integration, payload kickoffLabsWebhookPayload, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	fields := kickoffLabsMergedSubmissionFields(payload)
	for key, value := range fields {
		if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
			return carrdIdentityText(value)
		}
	}
	return ""
}

func kickoffLabsControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "token", "webhook_token", "route_token", "postwave_token", "kickofflabs_token", "secret", "password", "account_id", "provider_account_id", "kickofflabs_account_id", "campaign_id", "campaign", "provider_campaign_id", "kickofflabs_campaign_id", "page_id", "page", "landing_page", "landing_page_id":
		return true
	default:
		return kickoffLabsSecretLikeKey(key)
	}
}

func kickoffLabsSecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") || strings.Contains(key, "secret") || strings.Contains(key, "password")
}

func kickoffLabsRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if kickoffLabsSecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = carrdNormalizeValue(value)
	}
	return out
}

func kickoffLabsNestedString(fields map[string]any, paths ...string) string {
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

func kickoffLabsEventName(topic string) string {
	switch topic {
	case "referral.created":
		return "lead.referral.created"
	case "reward.earned":
		return "lead.reward.earned"
	case "lead.tagged":
		return "lead.tagged"
	case "lead.opted_out":
		return "lead.opted_out"
	case "lead.fraud.flagged":
		return "lead.fraud.flagged"
	default:
		return "lead.submitted"
	}
}

func kickoffLabsTags(integration Integration, accountID, campaignID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"kickofflabs", "kickofflabs:" + accountID, "kickofflabs:campaign:" + campaignID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func kickoffLabsSourceID(accountID, campaignID, webhookID string) string {
	accountID = strings.TrimSpace(accountID)
	campaignID = strings.TrimSpace(campaignID)
	webhookID = strings.TrimSpace(webhookID)
	return "kickofflabs://lead/" + accountID + "/" + campaignID + "/" + webhookID
}
