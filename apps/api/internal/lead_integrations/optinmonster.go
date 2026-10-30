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
	optinMonsterWebhookMaxBodySize = 2 << 20
	optinMonsterWebhookTopic       = "lead.created"
)

type OptinMonsterCredentials struct {
	WebhookToken string
	UserAgent    string
}

type OptinMonsterCredentialResolver interface {
	ResolveOptinMonster(context.Context, string, Integration) (OptinMonsterCredentials, error)
}

type OptinMonsterRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type OptinMonsterSecretsCredentialResolver struct {
	Secrets OptinMonsterRuntimeSecretResolver
}

func NewOptinMonsterSecretsCredentialResolver(secrets OptinMonsterRuntimeSecretResolver) *OptinMonsterSecretsCredentialResolver {
	return &OptinMonsterSecretsCredentialResolver{Secrets: secrets}
}

func (r *OptinMonsterSecretsCredentialResolver) ResolveOptinMonster(ctx context.Context, _ string, integration Integration) (OptinMonsterCredentials, error) {
	if r == nil || r.Secrets == nil {
		return OptinMonsterCredentials{}, fmt.Errorf("optinmonster credential resolver is not configured")
	}
	ref := optinMonsterCredentialRef(integration)
	if ref == "" {
		return OptinMonsterCredentials{}, fmt.Errorf("optinmonster credentials_ref is required")
	}
	var payload optinMonsterCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return OptinMonsterCredentials{}, fmt.Errorf("resolve optinmonster credentials %q: %w", ref, err)
		}
		return parseOptinMonsterCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return OptinMonsterCredentials{}, fmt.Errorf("resolve optinmonster credentials %q: %w", ref, err)
	}
	return parseOptinMonsterCredentialSecret(raw)
}

type optinMonsterCredentialPayload struct {
	WebhookToken string `json:"webhook_token"`
	RouteToken   string `json:"route_token"`
	Token        string `json:"token"`
	Secret       string `json:"secret"`
	UserAgent    string `json:"user_agent"`
}

func (p optinMonsterCredentialPayload) credentials() (OptinMonsterCredentials, error) {
	token := strings.TrimSpace(firstString(p.WebhookToken, p.RouteToken, p.Token, p.Secret))
	if token == "" {
		return OptinMonsterCredentials{}, fmt.Errorf("optinmonster webhook_token is required")
	}
	return OptinMonsterCredentials{WebhookToken: token, UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

func parseOptinMonsterCredentialSecret(raw string) (OptinMonsterCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return OptinMonsterCredentials{}, fmt.Errorf("optinmonster credentials are empty")
	}
	var payload optinMonsterCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return OptinMonsterCredentials{}, fmt.Errorf("parse optinmonster credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return OptinMonsterCredentials{}, fmt.Errorf("parse optinmonster credential key-value secret: %w", err)
		}
		return optinMonsterCredentialPayload{
			WebhookToken: firstString(values.Get("webhook_token"), values.Get("route_token")),
			Token:        values.Get("token"),
			Secret:       values.Get("secret"),
			UserAgent:    values.Get("user_agent"),
		}.credentials()
	}
	return optinMonsterCredentialPayload{WebhookToken: raw}.credentials()
}

func optinMonsterCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) OptinMonsterWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, optinMonsterWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "OptinMonster webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeOptinMonsterWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	accountID := optinMonsterAccountID(r, payload)
	if accountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "OptinMonster webhooks must include account_id in the query string, headers, or JSON payload")
		return
	}
	campaignID := optinMonsterCampaignID(r, payload)
	if campaignID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_campaign_id", "OptinMonster webhooks must include campaign_id in the query string, headers, or JSON payload")
		return
	}
	actualToken := optinMonsterRouteToken(r, payload)
	if actualToken == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_token", "OptinMonster route token is required")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderAccountAndCampaign(r.Context(), ProviderOptinMonster, accountID, campaignID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "OptinMonster integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "OptinMonster integration is disconnected")
		return
	}
	resolver := d.optinMonsterCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "OptinMonster credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveOptinMonster(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyOptinMonsterWebhookToken(creds.WebhookToken, actualToken); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_token", "request authentication failed")
		return
	}
	webhookID := optinMonsterWebhookID(payload, accountID, campaignID)
	topic := optinMonsterTopic(payload)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderOptinMonster, webhookID, topic, body)
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
	submission := mapOptinMonsterWebhookSubmission(payload, accountID, campaignID, webhookID, *integration)
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "optinmonster-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderOptinMonster, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "optinmonster webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderOptinMonster, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderOptinMonster, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifyOptinMonsterWebhookToken(expected, actual string) error {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	if expected == "" {
		return fmt.Errorf("optinmonster webhook token is not configured")
	}
	if actual == "" {
		return fmt.Errorf("optinmonster webhook token is required")
	}
	if !hmac.Equal([]byte(expected), []byte(actual)) {
		return fmt.Errorf("optinmonster webhook token does not match")
	}
	return nil
}

type optinMonsterWebhookPayload struct {
	Raw       map[string]any
	Lead      map[string]any
	Campaign  map[string]any
	Meta      map[string]any
	SmartTags map[string]any
	RawBody   []byte
}

func decodeOptinMonsterWebhookPayload(body []byte) (optinMonsterWebhookPayload, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return optinMonsterWebhookPayload{}, fmt.Errorf("OptinMonster webhook JSON body is required")
	}
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return optinMonsterWebhookPayload{}, fmt.Errorf("decode OptinMonster webhook JSON: %w", err)
	}
	if len(raw) == 0 {
		return optinMonsterWebhookPayload{}, fmt.Errorf("OptinMonster webhook JSON object is required")
	}
	normalized := optinMonsterNormalizeMap(raw)
	payload := optinMonsterWebhookPayload{
		Raw:       normalized,
		Lead:      optinMonsterMap(normalized, "lead", "contact", "subscriber"),
		Campaign:  optinMonsterMap(normalized, "campaign"),
		Meta:      optinMonsterMap(normalized, "meta", "metadata"),
		SmartTags: optinMonsterMap(normalized, "smart_tags", "smartTags", "smarttags"),
		RawBody:   append([]byte(nil), body...),
	}
	if len(payload.Lead) == 0 {
		payload.Lead = optinMonsterFlatLeadFields(normalized)
	}
	return payload, nil
}

func optinMonsterMap(raw map[string]any, keys ...string) map[string]any {
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

func optinMonsterFlatLeadFields(raw map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range raw {
		normalized := normalizeTypeformIdentityKey(key)
		switch normalized {
		case "lead", "contact", "subscriber", "campaign", "meta", "metadata", "smart_tags", "smarttags":
			continue
		}
		if optinMonsterControlKey(key) {
			continue
		}
		out[key] = value
	}
	return out
}

func optinMonsterNormalizeMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			out[trimmed] = optinMonsterNormalizeValue(value)
		}
	}
	return out
}

func optinMonsterNormalizeValue(value any) any {
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
		return optinMonsterNormalizeMap(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, optinMonsterNormalizeValue(item))
		}
		return out
	default:
		return typed
	}
}

func optinMonsterAccountID(r *http.Request, payload optinMonsterWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Account-ID"),
		r.Header.Get("X-OptinMonster-Account-ID"),
		r.URL.Query().Get("account_id"),
		r.URL.Query().Get("accountId"),
		r.URL.Query().Get("account"),
		mapString(payload.Raw, "account_id", "accountId", "account"),
		mapString(payload.Campaign, "account_id", "accountId", "account"),
		mapString(payload.Meta, "account_id", "accountId", "account"),
		mapString(payload.Lead, "account_id", "accountId", "account"),
	)
}

func optinMonsterCampaignID(r *http.Request, payload optinMonsterWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Campaign-ID"),
		r.Header.Get("X-OptinMonster-Campaign-ID"),
		r.URL.Query().Get("campaign_id"),
		r.URL.Query().Get("campaignId"),
		r.URL.Query().Get("campaign"),
		mapString(payload.Raw, "campaign_id", "campaignId", "campaign"),
		mapString(payload.Campaign, "id", "campaign_id", "campaignId", "campaign"),
		mapString(payload.Meta, "campaign_id", "campaignId"),
		mapString(payload.Lead, "campaign_id", "campaignId"),
	)
}

func optinMonsterRouteToken(r *http.Request, payload optinMonsterWebhookPayload) string {
	return firstString(
		bearerToken(r.Header.Get("Authorization")),
		r.Header.Get("X-Postwave-Webhook-Token"),
		r.Header.Get("X-Postwave-Token"),
		r.Header.Get("X-OptinMonster-Webhook-Token"),
		r.Header.Get("X-OptinMonster-Token"),
		r.URL.Query().Get("token"),
		r.URL.Query().Get("webhook_token"),
		r.URL.Query().Get("route_token"),
		r.URL.Query().Get("postwave_token"),
		r.URL.Query().Get("optinmonster_token"),
		mapString(payload.Raw, "token", "webhook_token", "route_token", "postwave_token", "optinmonster_token"),
		mapString(payload.Meta, "token", "webhook_token", "route_token", "postwave_token", "optinmonster_token"),
	)
}

func optinMonsterTopic(payload optinMonsterWebhookPayload) string {
	raw := strings.ToLower(firstString(
		mapString(payload.Raw, "event", "event_type", "eventType", "topic", "type"),
		mapString(payload.Meta, "event", "event_type", "eventType", "topic", "type"),
	))
	if strings.Contains(raw, "convert") || strings.Contains(raw, "conversion") {
		return "campaign.converted"
	}
	return optinMonsterWebhookTopic
}

func optinMonsterWebhookID(payload optinMonsterWebhookPayload, accountID, campaignID string) string {
	if id := firstString(
		mapString(payload.Lead, "id", "lead_id", "leadId", "uuid", "submission_id", "submissionId"),
		mapString(payload.Raw, "id", "lead_id", "leadId", "uuid", "submission_id", "submissionId"),
		mapString(payload.Meta, "id", "event_id", "eventId", "submission_id", "submissionId"),
	); id != "" {
		return "optinmonster_" + normalizeTypeformIdentityKey(id)
	}
	sum := sha256.Sum256([]byte(accountID + "\n" + campaignID + "\n" + optinMonsterCanonicalWebhookFields(payload)))
	return "optinmonster_local_" + hex.EncodeToString(sum[:16])
}

func optinMonsterCanonicalWebhookFields(payload optinMonsterWebhookPayload) string {
	keys := make([]string, 0, len(payload.Raw))
	for key := range payload.Raw {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if optinMonsterSecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(payload.Raw[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func mapOptinMonsterWebhookSubmission(payload optinMonsterWebhookPayload, accountID, campaignID, webhookID string, integration Integration) SubmissionInput {
	campaignName := firstString(
		mapString(payload.Campaign, "name", "title", "campaign_name", "campaignName"),
		settingString(integration.Settings, "campaign_name"),
		settingString(integration.Settings, "form_name"),
		campaignID,
	)
	fields := map[string]any{
		"optinmonster_account_id":    accountID,
		"optinmonster_campaign_id":   campaignID,
		"optinmonster_campaign_name": campaignName,
		"optinmonster_webhook_id":    webhookID,
		"optinmonster_provider_raw":  optinMonsterRedactedMap(payload.Raw),
	}
	if len(payload.Lead) > 0 {
		fields["optinmonster_lead"] = optinMonsterRedactedMap(payload.Lead)
	}
	if len(payload.Meta) > 0 {
		fields["optinmonster_meta"] = optinMonsterRedactedMap(payload.Meta)
	}
	if len(payload.SmartTags) > 0 {
		fields["optinmonster_smart_tags"] = optinMonsterRedactedMap(payload.SmartTags)
	}
	identity := typeformIdentity{}
	for key, value := range payload.Lead {
		if optinMonsterControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := optinMonsterNormalizeValue(value)
		fields["optinmonster_lead."+normalizedKey] = normalizedValue
		identity.apply(key, optinMonsterIdentityText(normalizedValue))
	}
	for key, value := range payload.SmartTags {
		identity.apply(key, optinMonsterIdentityText(value))
	}
	optinMonsterApplyConfiguredIdentity(&identity, integration, payload)
	submittedAt := parseFilloutTime(firstString(
		optinMonsterConfiguredFieldString(integration, payload, "submitted_at_field_key"),
		mapString(payload.Lead, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date"),
		mapString(payload.Meta, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date"),
		mapString(payload.Raw, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date"),
	))
	return SubmissionInput{
		SourceID:    optinMonsterSourceID(accountID, campaignID, webhookID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      campaignID,
		FormName:    campaignName,
		EventName:   "lead.submitted",
		Tags:        optinMonsterTags(integration, accountID, campaignID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func optinMonsterApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, payload optinMonsterWebhookPayload) {
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
		if value := optinMonsterConfiguredFieldString(integration, payload, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func optinMonsterConfiguredFieldString(integration Integration, payload optinMonsterWebhookPayload, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	for _, fields := range []map[string]any{payload.Lead, payload.SmartTags, payload.Meta, payload.Raw} {
		for key, value := range fields {
			if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
				return optinMonsterIdentityText(value)
			}
		}
	}
	return ""
}

func optinMonsterIdentityText(value any) string {
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

func optinMonsterControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "token", "webhook_token", "route_token", "postwave_token", "optinmonster_token", "secret", "password", "account_id", "accountid", "account", "campaign_id", "campaignid", "campaign":
		return true
	default:
		return optinMonsterSecretLikeKey(key)
	}
}

func optinMonsterSecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") ||
		strings.Contains(key, "secret") ||
		strings.Contains(key, "password") ||
		strings.Contains(key, "api_key") ||
		strings.Contains(key, "apikey") ||
		strings.Contains(key, "authorization")
}

func optinMonsterRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if optinMonsterSecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = optinMonsterRedactedValue(value)
	}
	return out
}

func optinMonsterRedactedValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return optinMonsterRedactedMap(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, optinMonsterRedactedValue(item))
		}
		return out
	default:
		return optinMonsterNormalizeValue(typed)
	}
}

func optinMonsterTags(integration Integration, accountID, campaignID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"optinmonster", "optinmonster:" + accountID, "optinmonster:campaign:" + campaignID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func optinMonsterSourceID(accountID, campaignID, webhookID string) string {
	accountID = strings.TrimSpace(accountID)
	campaignID = strings.TrimSpace(campaignID)
	webhookID = strings.TrimSpace(webhookID)
	return "optinmonster://lead/" + accountID + "/" + campaignID + "/" + webhookID
}
