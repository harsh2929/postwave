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
	wisepopsWebhookMaxBodySize = 2 << 20
	wisepopsDefaultTopic       = "email.collected"
)

type WisepopsCredentials struct {
	APIKey    string
	UserAgent string
}

type WisepopsCredentialResolver interface {
	ResolveWisepops(context.Context, string, Integration) (WisepopsCredentials, error)
}

type WisepopsRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type WisepopsSecretsCredentialResolver struct {
	Secrets WisepopsRuntimeSecretResolver
}

func NewWisepopsSecretsCredentialResolver(secrets WisepopsRuntimeSecretResolver) *WisepopsSecretsCredentialResolver {
	return &WisepopsSecretsCredentialResolver{Secrets: secrets}
}

func (r *WisepopsSecretsCredentialResolver) ResolveWisepops(ctx context.Context, _ string, integration Integration) (WisepopsCredentials, error) {
	if r == nil || r.Secrets == nil {
		return WisepopsCredentials{}, fmt.Errorf("wisepops credential resolver is not configured")
	}
	ref := wisepopsCredentialRef(integration)
	if ref == "" {
		return WisepopsCredentials{}, fmt.Errorf("wisepops credentials_ref is required")
	}
	var payload wisepopsCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return WisepopsCredentials{}, fmt.Errorf("resolve wisepops credentials %q: %w", ref, err)
		}
		return parseWisepopsCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return WisepopsCredentials{}, fmt.Errorf("resolve wisepops credentials %q: %w", ref, err)
	}
	return parseWisepopsCredentialSecret(raw)
}

type wisepopsCredentialPayload struct {
	APIKey    string `json:"api_key"`
	Key       string `json:"key"`
	Token     string `json:"token"`
	Secret    string `json:"secret"`
	UserAgent string `json:"user_agent"`
}

func (p wisepopsCredentialPayload) credentials() (WisepopsCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Key, p.Token, p.Secret))
	if key == "" {
		return WisepopsCredentials{}, fmt.Errorf("wisepops api_key is required")
	}
	return WisepopsCredentials{APIKey: key, UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

func parseWisepopsCredentialSecret(raw string) (WisepopsCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return WisepopsCredentials{}, fmt.Errorf("wisepops credentials are empty")
	}
	var payload wisepopsCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return WisepopsCredentials{}, fmt.Errorf("parse wisepops credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return WisepopsCredentials{}, fmt.Errorf("parse wisepops credential key-value secret: %w", err)
		}
		return wisepopsCredentialPayload{
			APIKey:    firstString(values.Get("api_key"), values.Get("key")),
			Token:     values.Get("token"),
			Secret:    values.Get("secret"),
			UserAgent: values.Get("user_agent"),
		}.credentials()
	}
	return wisepopsCredentialPayload{APIKey: raw}.credentials()
}

func wisepopsCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) WisepopsWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, wisepopsWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Wisepops webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeWisepopsWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	accountID := wisepopsAccountID(r, payload)
	if accountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "Wisepops webhooks must include account_id in the query string, headers, or JSON payload")
		return
	}
	campaignID := wisepopsCampaignID(r, payload)
	if campaignID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_campaign_id", "Wisepops webhooks must include campaign_id or wisepop_id in the query string, headers, or JSON payload")
		return
	}
	signature := wisepopsSignature(r)
	if signature == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature", "X-Wisepops-Signature is required")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderAccountAndCampaign(r.Context(), ProviderWisepops, accountID, campaignID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Wisepops integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "Wisepops integration is disconnected")
		return
	}
	resolver := d.wisepopsCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Wisepops credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveWisepops(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyWisepopsSignature(creds.APIKey, body, signature); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	webhookID := wisepopsWebhookID(r, payload, accountID, campaignID)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderWisepops, webhookID, wisepopsTopic(r, payload, *integration), body)
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
	submissions := mapWisepopsWebhookSubmissions(payload, accountID, campaignID, webhookID, *integration)
	if len(submissions) == 0 {
		err := errors.New("wisepops webhook contained no contacts")
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderWisepops, webhookID, err)
		httperror.Write(w, http.StatusBadRequest, "empty_payload", err.Error())
		return
	}
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: submissions,
		Cursor:      "wisepops-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderWisepops, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "wisepops webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderWisepops, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderWisepops, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifyWisepopsSignature(apiKey string, body []byte, signature string) error {
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		return fmt.Errorf("wisepops api key is not configured")
	}
	signature = strings.TrimSpace(signature)
	signature = strings.TrimPrefix(strings.ToLower(signature), "sha256=")
	if signature == "" {
		return fmt.Errorf("wisepops signature is required")
	}
	mac := hmac.New(sha256.New, []byte(apiKey))
	_, _ = mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return fmt.Errorf("wisepops signature does not match")
	}
	return nil
}

type wisepopsWebhookPayload struct {
	Contacts []map[string]any
	Raw      any
	RawBody  []byte
}

func decodeWisepopsWebhookPayload(body []byte) (wisepopsWebhookPayload, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return wisepopsWebhookPayload{}, fmt.Errorf("Wisepops webhook JSON body is required")
	}
	var raw any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return wisepopsWebhookPayload{}, fmt.Errorf("decode Wisepops webhook JSON: %w", err)
	}
	normalized := wisepopsNormalizeValue(raw)
	contacts := wisepopsExtractContacts(normalized)
	if len(contacts) == 0 {
		return wisepopsWebhookPayload{}, fmt.Errorf("Wisepops webhook must contain at least one contact")
	}
	return wisepopsWebhookPayload{Contacts: contacts, Raw: normalized, RawBody: append([]byte(nil), body...)}, nil
}

func wisepopsExtractContacts(raw any) []map[string]any {
	switch typed := raw.(type) {
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if m, ok := item.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	case map[string]any:
		for _, key := range []string{"contacts", "leads", "items", "data"} {
			if arr, ok := typed[key].([]any); ok {
				return wisepopsExtractContacts(arr)
			}
		}
		return []map[string]any{typed}
	default:
		return nil
	}
}

func wisepopsNormalizeMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			out[trimmed] = wisepopsNormalizeValue(value)
		}
	}
	return out
}

func wisepopsNormalizeValue(value any) any {
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
		return wisepopsNormalizeMap(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, wisepopsNormalizeValue(item))
		}
		return out
	default:
		return typed
	}
}

func wisepopsAccountID(r *http.Request, payload wisepopsWebhookPayload) string {
	first := wisepopsFirstContact(payload)
	root := wisepopsRootMap(payload)
	return firstString(
		r.Header.Get("X-Postwave-Account-ID"),
		r.Header.Get("X-Wisepops-Account-ID"),
		r.Header.Get("X-Wisepops-Site-ID"),
		r.URL.Query().Get("account_id"),
		r.URL.Query().Get("accountId"),
		r.URL.Query().Get("site_id"),
		r.URL.Query().Get("siteId"),
		mapString(root, "account_id", "accountId", "site_id", "siteId", "website_id", "websiteId"),
		mapString(first, "account_id", "accountId", "site_id", "siteId", "website_id", "websiteId"),
	)
}

func wisepopsCampaignID(r *http.Request, payload wisepopsWebhookPayload) string {
	first := wisepopsFirstContact(payload)
	root := wisepopsRootMap(payload)
	return firstString(
		r.Header.Get("X-Postwave-Campaign-ID"),
		r.Header.Get("X-Wisepops-Campaign-ID"),
		r.URL.Query().Get("campaign_id"),
		r.URL.Query().Get("campaignId"),
		r.URL.Query().Get("wisepop_id"),
		r.URL.Query().Get("wisepopId"),
		mapString(root, "campaign_id", "campaignId", "wisepop_id", "wisepopId", "popup_id", "popupId"),
		mapString(first, "campaign_id", "campaignId", "wisepop_id", "wisepopId", "popup_id", "popupId"),
	)
}

func wisepopsRootMap(payload wisepopsWebhookPayload) map[string]any {
	if typed, ok := payload.Raw.(map[string]any); ok {
		return typed
	}
	return nil
}

func wisepopsFirstContact(payload wisepopsWebhookPayload) map[string]any {
	if len(payload.Contacts) == 0 {
		return nil
	}
	return payload.Contacts[0]
}

func wisepopsSignature(r *http.Request) string {
	return firstString(
		r.Header.Get("X-Wisepops-Signature"),
		r.Header.Get("X-Wisepops-Hmac-Sha256"),
		r.Header.Get("X-Postwave-Signature"),
		r.URL.Query().Get("signature"),
		r.URL.Query().Get("hmac"),
	)
}

func wisepopsTopic(r *http.Request, payload wisepopsWebhookPayload, integration Integration) string {
	value := strings.ToLower(firstString(
		r.Header.Get("X-Wisepops-Event"),
		r.URL.Query().Get("event"),
		settingString(integration.Settings, "hook_event"),
		mapString(wisepopsFirstContact(payload), "event", "event_type", "eventType"),
	))
	first := wisepopsLeadFields(wisepopsFirstContact(payload))
	switch {
	case strings.Contains(value, "survey"):
		return "survey.collected"
	case strings.Contains(value, "phone"):
		return "phone.collected"
	case mapString(first, "phone", "phone_number", "phoneNumber") != "" && mapString(first, "email") == "":
		return "phone.collected"
	default:
		return wisepopsDefaultTopic
	}
}

func wisepopsWebhookID(r *http.Request, payload wisepopsWebhookPayload, accountID, campaignID string) string {
	if id := firstString(
		r.Header.Get("X-Wisepops-Delivery-ID"),
		r.Header.Get("X-Postwave-Delivery-ID"),
		r.Header.Get("X-Request-ID"),
		r.URL.Query().Get("delivery_id"),
		r.URL.Query().Get("webhook_id"),
	); id != "" {
		return "wisepops_delivery_" + normalizeTypeformIdentityKey(id)
	}
	sum := sha256.Sum256([]byte(accountID + "\n" + campaignID + "\n" + string(payload.RawBody)))
	return "wisepops_delivery_" + hex.EncodeToString(sum[:16])
}

func mapWisepopsWebhookSubmissions(payload wisepopsWebhookPayload, accountID, campaignID, webhookID string, integration Integration) []SubmissionInput {
	out := make([]SubmissionInput, 0, len(payload.Contacts))
	for idx, contact := range payload.Contacts {
		out = append(out, mapWisepopsWebhookSubmission(contact, accountID, campaignID, webhookID, idx, integration))
	}
	return out
}

func mapWisepopsWebhookSubmission(contact map[string]any, accountID, campaignID, webhookID string, idx int, integration Integration) SubmissionInput {
	leadFields := wisepopsLeadFields(contact)
	campaignName := firstString(
		mapString(contact, "campaign_name", "campaignName", "wisepop_name", "wisepopName", "name"),
		settingString(integration.Settings, "campaign_name"),
		settingString(integration.Settings, "form_name"),
		campaignID,
	)
	contactID := wisepopsContactID(contact, leadFields, accountID, campaignID, idx)
	fields := map[string]any{
		"wisepops_account_id":     accountID,
		"wisepops_campaign_id":    campaignID,
		"wisepops_campaign_name":  campaignName,
		"wisepops_delivery_id":    webhookID,
		"wisepops_contact_id":     contactID,
		"wisepops_delivery_index": idx,
		"wisepops_provider_raw":   wisepopsRedactedMap(contact),
	}
	identity := typeformIdentity{}
	for key, value := range leadFields {
		if wisepopsControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := wisepopsNormalizeValue(value)
		fields["wisepops_field."+normalizedKey] = normalizedValue
		identity.apply(key, wisepopsIdentityText(normalizedValue))
	}
	wisepopsApplyConfiguredIdentity(&identity, integration, leadFields)
	submittedAt := parseFilloutTime(firstString(
		wisepopsConfiguredFieldString(integration, leadFields, "submitted_at_field_key"),
		mapString(contact, "collected_at", "collectedAt", "created_at", "createdAt", "timestamp", "date"),
		mapString(leadFields, "collected_at", "collectedAt", "created_at", "createdAt", "timestamp", "date"),
	))
	return SubmissionInput{
		SourceID:    wisepopsSourceID(accountID, campaignID, contactID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      campaignID,
		FormName:    campaignName,
		EventName:   "lead.submitted",
		Tags:        wisepopsTags(integration, accountID, campaignID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func wisepopsLeadFields(contact map[string]any) map[string]any {
	out := make(map[string]any, len(contact)+8)
	for key, value := range contact {
		if nested, ok := value.(map[string]any); ok {
			switch normalizeTypeformIdentityKey(key) {
			case "fields", "form", "properties", "custom_fields", "customfields":
				for nestedKey, nestedValue := range nested {
					out[nestedKey] = nestedValue
				}
				continue
			}
		}
		out[key] = value
	}
	return out
}

func wisepopsContactID(contact, leadFields map[string]any, accountID, campaignID string, idx int) string {
	if id := firstString(
		mapString(contact, "contact_id", "contactId", "id", "form_session", "formSession", "session_id", "sessionId"),
		mapString(leadFields, "contact_id", "contactId", "id", "form_session", "formSession", "session_id", "sessionId"),
	); id != "" {
		return "wisepops_" + normalizeTypeformIdentityKey(id)
	}
	sum := sha256.Sum256([]byte(accountID + "\n" + campaignID + "\n" + fmt.Sprint(idx) + "\n" + wisepopsCanonicalFields(leadFields)))
	return "wisepops_local_" + hex.EncodeToString(sum[:16])
}

func wisepopsCanonicalFields(fields map[string]any) string {
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if wisepopsSecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(fields[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func wisepopsApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, fields map[string]any) {
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
		if value := wisepopsConfiguredFieldString(integration, fields, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func wisepopsConfiguredFieldString(integration Integration, fields map[string]any, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	for key, value := range fields {
		if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
			return wisepopsIdentityText(value)
		}
	}
	return ""
}

func wisepopsIdentityText(value any) string {
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

func wisepopsControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "signature", "token", "secret", "password", "api_key", "apikey", "account_id", "accountid", "site_id", "siteid", "website_id", "websiteid", "campaign_id", "campaignid", "wisepop_id", "wisepopid", "hook_id", "hookid":
		return true
	default:
		return wisepopsSecretLikeKey(key)
	}
}

func wisepopsSecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") ||
		strings.Contains(key, "secret") ||
		strings.Contains(key, "password") ||
		strings.Contains(key, "api_key") ||
		strings.Contains(key, "apikey") ||
		strings.Contains(key, "signature") ||
		strings.Contains(key, "authorization")
}

func wisepopsRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if wisepopsSecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = wisepopsRedactedValue(value)
	}
	return out
}

func wisepopsRedactedValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return wisepopsRedactedMap(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, wisepopsRedactedValue(item))
		}
		return out
	default:
		return wisepopsNormalizeValue(typed)
	}
}

func wisepopsTags(integration Integration, accountID, campaignID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"wisepops", "wisepops:" + accountID, "wisepops:campaign:" + campaignID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func wisepopsSourceID(accountID, campaignID, contactID string) string {
	accountID = strings.TrimSpace(accountID)
	campaignID = strings.TrimSpace(campaignID)
	contactID = strings.TrimSpace(contactID)
	return "wisepops://lead/" + accountID + "/" + campaignID + "/" + contactID
}
