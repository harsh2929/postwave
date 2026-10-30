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

const (
	privyWebhookMaxBodySize = 2 << 20
	privyDefaultTopic       = "signup.created"
)

type PrivyCredentials struct {
	Username  string
	Password  string
	UserAgent string
}

type PrivyCredentialResolver interface {
	ResolvePrivy(context.Context, string, Integration) (PrivyCredentials, error)
}

type PrivyRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type PrivySecretsCredentialResolver struct {
	Secrets PrivyRuntimeSecretResolver
}

func NewPrivySecretsCredentialResolver(secrets PrivyRuntimeSecretResolver) *PrivySecretsCredentialResolver {
	return &PrivySecretsCredentialResolver{Secrets: secrets}
}

func (r *PrivySecretsCredentialResolver) ResolvePrivy(ctx context.Context, _ string, integration Integration) (PrivyCredentials, error) {
	if r == nil || r.Secrets == nil {
		return PrivyCredentials{}, fmt.Errorf("privy credential resolver is not configured")
	}
	ref := privyCredentialRef(integration)
	if ref == "" {
		return PrivyCredentials{}, fmt.Errorf("privy credentials_ref is required")
	}
	var payload privyCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return PrivyCredentials{}, fmt.Errorf("resolve privy credentials %q: %w", ref, err)
		}
		return parsePrivyCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return PrivyCredentials{}, fmt.Errorf("resolve privy credentials %q: %w", ref, err)
	}
	return parsePrivyCredentialSecret(raw)
}

type privyCredentialPayload struct {
	Username        string `json:"username"`
	WebhookUsername string `json:"webhook_username"`
	BasicUsername   string `json:"basic_username"`
	Password        string `json:"password"`
	WebhookPassword string `json:"webhook_password"`
	BasicPassword   string `json:"basic_password"`
	Token           string `json:"token"`
	Secret          string `json:"secret"`
	WebhookToken    string `json:"webhook_token"`
	UserAgent       string `json:"user_agent"`
}

func (p privyCredentialPayload) credentials() (PrivyCredentials, error) {
	username := strings.TrimSpace(firstString(p.Username, p.WebhookUsername, p.BasicUsername))
	password := strings.TrimSpace(firstString(p.Password, p.WebhookPassword, p.BasicPassword, p.Token, p.Secret, p.WebhookToken))
	if username == "" && password != "" {
		username = "postwave"
	}
	if username == "" || password == "" {
		return PrivyCredentials{}, fmt.Errorf("privy basic auth username and password are required")
	}
	return PrivyCredentials{Username: username, Password: password, UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

func parsePrivyCredentialSecret(raw string) (PrivyCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return PrivyCredentials{}, fmt.Errorf("privy credentials are empty")
	}
	var payload privyCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return PrivyCredentials{}, fmt.Errorf("parse privy credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return PrivyCredentials{}, fmt.Errorf("parse privy credential key-value secret: %w", err)
		}
		return privyCredentialPayload{
			Username:     firstString(values.Get("username"), values.Get("webhook_username"), values.Get("basic_username")),
			Password:     firstString(values.Get("password"), values.Get("webhook_password"), values.Get("basic_password")),
			Token:        values.Get("token"),
			Secret:       values.Get("secret"),
			WebhookToken: values.Get("webhook_token"),
			UserAgent:    values.Get("user_agent"),
		}.credentials()
	}
	parts := strings.SplitN(raw, ":", 2)
	if len(parts) == 2 {
		return privyCredentialPayload{Username: parts[0], Password: parts[1]}.credentials()
	}
	return privyCredentialPayload{Token: raw}.credentials()
}

func privyCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) PrivyWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, privyWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Privy webhook payload exceeds 2 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodePrivyWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	accountID := privyAccountID(r, payload)
	if accountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "Privy webhooks must include account_id in the query string, headers, or JSON payload")
		return
	}
	campaignID := privyCampaignID(r, payload)
	if campaignID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_campaign_id", "Privy webhooks must include campaign_id or campaign.id in the query string, headers, or JSON payload")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderAccountAndCampaign(r.Context(), ProviderPrivy, accountID, campaignID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Privy integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "Privy integration is disconnected")
		return
	}
	resolver := d.privyCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Privy credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolvePrivy(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyPrivyBasicAuth(creds, r.Header.Get("Authorization")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_basic_auth", "request authentication failed")
		return
	}
	webhookID := privyWebhookID(r, payload, accountID, campaignID)
	topic := privyTopic(r, payload)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderPrivy, webhookID, topic, body)
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
	submission := mapPrivyWebhookSubmission(payload, accountID, campaignID, webhookID, *integration)
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "privy-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderPrivy, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "privy webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderPrivy, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderPrivy, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifyPrivyBasicAuth(expected PrivyCredentials, authorization string) error {
	expected.Username = strings.TrimSpace(expected.Username)
	expected.Password = strings.TrimSpace(expected.Password)
	if expected.Username == "" || expected.Password == "" {
		return fmt.Errorf("privy basic auth credentials are not configured")
	}
	authorization = strings.TrimSpace(authorization)
	if authorization == "" {
		return fmt.Errorf("privy basic Authorization header is required")
	}
	if !strings.HasPrefix(strings.ToLower(authorization), "basic ") {
		return fmt.Errorf("privy Authorization header must use Basic auth")
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(authorization[len("Basic "):]))
	if err != nil {
		return fmt.Errorf("decode privy Basic auth header: %w", err)
	}
	parts := strings.SplitN(string(decoded), ":", 2)
	if len(parts) != 2 {
		return fmt.Errorf("privy Basic auth header is malformed")
	}
	if !hmac.Equal([]byte(expected.Username), []byte(parts[0])) || !hmac.Equal([]byte(expected.Password), []byte(parts[1])) {
		return fmt.Errorf("privy Basic auth credentials do not match")
	}
	return nil
}

type privyWebhookPayload struct {
	Raw      map[string]any
	Lead     map[string]any
	Campaign map[string]any
	RawBody  []byte
}

func decodePrivyWebhookPayload(body []byte) (privyWebhookPayload, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return privyWebhookPayload{}, fmt.Errorf("Privy webhook JSON body is required")
	}
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return privyWebhookPayload{}, fmt.Errorf("decode Privy webhook JSON: %w", err)
	}
	if len(raw) == 0 {
		return privyWebhookPayload{}, fmt.Errorf("Privy webhook JSON object is required")
	}
	normalized := privyNormalizeMap(raw)
	payload := privyWebhookPayload{
		Raw:      normalized,
		Lead:     privyMap(normalized, "contact", "customer", "signup", "user", "data", "lead"),
		Campaign: privyMap(normalized, "campaign", "display", "popup"),
		RawBody:  append([]byte(nil), body...),
	}
	if len(payload.Campaign) == 0 {
		payload.Campaign = privyMap(payload.Lead, "campaign", "display", "popup")
	}
	if len(payload.Lead) == 0 {
		payload.Lead = privyFlatLeadFields(normalized)
	}
	return payload, nil
}

func privyMap(raw map[string]any, keys ...string) map[string]any {
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

func privyFlatLeadFields(raw map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range raw {
		normalized := normalizeTypeformIdentityKey(key)
		switch normalized {
		case "contact", "customer", "signup", "user", "data", "lead", "campaign", "display", "popup":
			continue
		}
		if privyControlKey(key) {
			continue
		}
		out[key] = value
	}
	return out
}

func privyNormalizeMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			out[trimmed] = privyNormalizeValue(value)
		}
	}
	return out
}

func privyNormalizeValue(value any) any {
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
		return privyNormalizeMap(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, privyNormalizeValue(item))
		}
		return out
	default:
		return typed
	}
}

func privyAccountID(r *http.Request, payload privyWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Account-ID"),
		r.Header.Get("X-Privy-Account-ID"),
		r.Header.Get("X-Privy-Site-ID"),
		r.Header.Get("X-Privy-Shop-ID"),
		r.URL.Query().Get("account_id"),
		r.URL.Query().Get("accountId"),
		r.URL.Query().Get("site_id"),
		r.URL.Query().Get("siteId"),
		r.URL.Query().Get("shop_id"),
		r.URL.Query().Get("shopId"),
		mapString(payload.Raw, "account_id", "accountId", "site_id", "siteId", "shop_id", "shopId", "store_id", "storeId"),
		mapString(payload.Lead, "account_id", "accountId", "site_id", "siteId", "shop_id", "shopId", "store_id", "storeId"),
	)
}

func privyCampaignID(r *http.Request, payload privyWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Campaign-ID"),
		r.Header.Get("X-Privy-Campaign-ID"),
		r.Header.Get("X-Privy-Display-ID"),
		r.URL.Query().Get("campaign_id"),
		r.URL.Query().Get("campaignId"),
		r.URL.Query().Get("display_id"),
		r.URL.Query().Get("displayId"),
		mapString(payload.Raw, "campaign_id", "campaignId", "display_id", "displayId", "popup_id", "popupId"),
		mapString(payload.Campaign, "id", "campaign_id", "campaignId", "display_id", "displayId", "popup_id", "popupId"),
		mapString(payload.Lead, "campaign_id", "campaignId", "display_id", "displayId", "popup_id", "popupId"),
	)
}

func privyTopic(r *http.Request, payload privyWebhookPayload) string {
	value := strings.ToLower(firstString(
		r.Header.Get("X-Privy-Event"),
		r.URL.Query().Get("event"),
		mapString(payload.Raw, "event", "event_type", "eventType", "topic", "type"),
		mapString(payload.Lead, "event", "event_type", "eventType", "topic", "type"),
	))
	switch {
	case strings.Contains(value, "contact"):
		return "contact.created"
	case strings.Contains(value, "coupon"):
		return "coupon.redeemed"
	default:
		return privyDefaultTopic
	}
}

func privyWebhookID(r *http.Request, payload privyWebhookPayload, accountID, campaignID string) string {
	if id := firstString(
		r.Header.Get("X-Privy-Delivery-ID"),
		r.Header.Get("X-Postwave-Delivery-ID"),
		r.Header.Get("X-Request-ID"),
		r.URL.Query().Get("delivery_id"),
		r.URL.Query().Get("webhook_id"),
		mapString(payload.Lead, "id", "signup_id", "signupId", "contact_id", "contactId", "customer_id", "customerId", "uuid"),
		mapString(payload.Raw, "id", "event_id", "eventId", "signup_id", "signupId", "contact_id", "contactId", "customer_id", "customerId", "uuid"),
	); id != "" {
		return "privy_" + normalizeTypeformIdentityKey(id)
	}
	sum := sha256.Sum256([]byte(accountID + "\n" + campaignID + "\n" + privyCanonicalWebhookFields(payload)))
	return "privy_local_" + hex.EncodeToString(sum[:16])
}

func privyCanonicalWebhookFields(payload privyWebhookPayload) string {
	keys := make([]string, 0, len(payload.Raw))
	for key := range payload.Raw {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if privySecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(payload.Raw[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func mapPrivyWebhookSubmission(payload privyWebhookPayload, accountID, campaignID, webhookID string, integration Integration) SubmissionInput {
	leadFields := privyLeadFields(payload.Lead)
	campaignName := firstString(
		mapString(payload.Campaign, "title", "name", "campaign_name", "campaignName"),
		settingString(integration.Settings, "campaign_name"),
		settingString(integration.Settings, "form_name"),
		campaignID,
	)
	fields := map[string]any{
		"privy_account_id":    accountID,
		"privy_campaign_id":   campaignID,
		"privy_campaign_name": campaignName,
		"privy_webhook_id":    webhookID,
		"privy_provider_raw":  privyRedactedMap(payload.Raw),
	}
	if len(payload.Campaign) > 0 {
		fields["privy_campaign"] = privyRedactedMap(payload.Campaign)
	}
	if len(payload.Lead) > 0 {
		fields["privy_signup"] = privyRedactedMap(payload.Lead)
	}
	identity := typeformIdentity{}
	for key, value := range leadFields {
		if privyControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := privyNormalizeValue(value)
		fields["privy_field."+normalizedKey] = normalizedValue
		identity.apply(key, privyIdentityText(normalizedValue))
	}
	privyApplyConfiguredIdentity(&identity, integration, leadFields)
	submittedAt := parseFilloutTime(firstString(
		privyConfiguredFieldString(integration, leadFields, "submitted_at_field_key"),
		mapString(payload.Lead, "created_at", "createdAt", "signup_at", "signupAt", "submitted_at", "submittedAt", "timestamp", "date"),
		mapString(payload.Raw, "created_at", "createdAt", "signup_at", "signupAt", "submitted_at", "submittedAt", "timestamp", "date"),
	))
	return SubmissionInput{
		SourceID:    privySourceID(accountID, campaignID, webhookID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      campaignID,
		FormName:    campaignName,
		EventName:   "lead.submitted",
		Tags:        privyTags(integration, accountID, campaignID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func privyLeadFields(lead map[string]any) map[string]any {
	out := make(map[string]any, len(lead)+8)
	for key, value := range lead {
		if nested, ok := value.(map[string]any); ok {
			switch normalizeTypeformIdentityKey(key) {
			case "fields", "properties", "custom_fields", "customfields", "customproperties", "attributes":
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

func privyApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, fields map[string]any) {
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
		if value := privyConfiguredFieldString(integration, fields, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func privyConfiguredFieldString(integration Integration, fields map[string]any, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	for key, value := range fields {
		if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
			return privyIdentityText(value)
		}
	}
	return ""
}

func privyIdentityText(value any) string {
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

func privyControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "authorization", "basic_auth", "basicauth", "token", "webhook_token", "secret", "password", "api_key", "apikey", "account_id", "accountid", "site_id", "siteid", "shop_id", "shopid", "store_id", "storeid", "campaign_id", "campaignid", "display_id", "displayid", "popup_id", "popupid", "campaign", "display", "popup":
		return true
	default:
		return privySecretLikeKey(key)
	}
}

func privySecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") ||
		strings.Contains(key, "secret") ||
		strings.Contains(key, "password") ||
		strings.Contains(key, "api_key") ||
		strings.Contains(key, "apikey") ||
		strings.Contains(key, "signature") ||
		strings.Contains(key, "authorization") ||
		strings.Contains(key, "basic_auth")
}

func privyRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if privySecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = privyRedactedValue(value)
	}
	return out
}

func privyRedactedValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return privyRedactedMap(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, privyRedactedValue(item))
		}
		return out
	default:
		return privyNormalizeValue(typed)
	}
}

func privyTags(integration Integration, accountID, campaignID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"privy", "privy:" + accountID, "privy:campaign:" + campaignID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func privySourceID(accountID, campaignID, webhookID string) string {
	accountID = strings.TrimSpace(accountID)
	campaignID = strings.TrimSpace(campaignID)
	webhookID = strings.TrimSpace(webhookID)
	return "privy://signup/" + accountID + "/" + campaignID + "/" + webhookID
}
