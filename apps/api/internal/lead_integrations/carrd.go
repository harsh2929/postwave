// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

const (
	carrdWebhookMaxBodySize = 8 << 20
	carrdWebhookTopic       = "form.submitted"
)

type CarrdCredentials struct {
	WebhookToken string
	UserAgent    string
}

type CarrdCredentialResolver interface {
	ResolveCarrd(context.Context, string, Integration) (CarrdCredentials, error)
}

type CarrdRuntimeSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

type CarrdSecretsCredentialResolver struct {
	Secrets CarrdRuntimeSecretResolver
}

func NewCarrdSecretsCredentialResolver(secrets CarrdRuntimeSecretResolver) *CarrdSecretsCredentialResolver {
	return &CarrdSecretsCredentialResolver{Secrets: secrets}
}

func (r *CarrdSecretsCredentialResolver) ResolveCarrd(ctx context.Context, _ string, integration Integration) (CarrdCredentials, error) {
	if r == nil || r.Secrets == nil {
		return CarrdCredentials{}, fmt.Errorf("carrd credential resolver is not configured")
	}
	ref := carrdCredentialRef(integration)
	if ref == "" {
		return CarrdCredentials{}, fmt.Errorf("carrd credentials_ref is required")
	}
	var payload carrdCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		return payload.credentials()
	} else if !errors.Is(err, pwsecrets.ErrNotFound) {
		raw, getErr := r.Secrets.Get(ctx, ref)
		if getErr != nil {
			return CarrdCredentials{}, fmt.Errorf("resolve carrd credentials %q: %w", ref, err)
		}
		return parseCarrdCredentialSecret(raw)
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return CarrdCredentials{}, fmt.Errorf("resolve carrd credentials %q: %w", ref, err)
	}
	return parseCarrdCredentialSecret(raw)
}

type carrdCredentialPayload struct {
	WebhookToken string `json:"webhook_token"`
	Token        string `json:"token"`
	RouteToken   string `json:"route_token"`
	Secret       string `json:"secret"`
	UserAgent    string `json:"user_agent"`
}

func (p carrdCredentialPayload) credentials() (CarrdCredentials, error) {
	token := strings.TrimSpace(firstString(p.WebhookToken, p.RouteToken, p.Token, p.Secret))
	if token == "" {
		return CarrdCredentials{}, fmt.Errorf("carrd webhook_token is required")
	}
	return CarrdCredentials{WebhookToken: token, UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

func parseCarrdCredentialSecret(raw string) (CarrdCredentials, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return CarrdCredentials{}, fmt.Errorf("carrd credentials are empty")
	}
	var payload carrdCredentialPayload
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			return CarrdCredentials{}, fmt.Errorf("parse carrd credential JSON: %w", err)
		}
		return payload.credentials()
	}
	if strings.Contains(raw, "=") {
		values, err := url.ParseQuery(strings.ReplaceAll(raw, "\n", "&"))
		if err != nil {
			return CarrdCredentials{}, fmt.Errorf("parse carrd credential key-value secret: %w", err)
		}
		return carrdCredentialPayload{
			WebhookToken: firstString(values.Get("webhook_token"), values.Get("route_token")),
			Token:        values.Get("token"),
			Secret:       values.Get("secret"),
			UserAgent:    values.Get("user_agent"),
		}.credentials()
	}
	return carrdCredentialPayload{WebhookToken: raw}.credentials()
}

func carrdCredentialRef(integration Integration) string {
	return firstString(
		integration.CredentialsRef,
		settingString(integration.Settings, "credentials_ref"),
		settingString(integration.Settings, "credential_ref"),
	)
}

func (d *Deps) CarrdWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, carrdWebhookMaxBodySize)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Carrd webhook payload exceeds 8 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read webhook body")
		return
	}
	payload, err := decodeCarrdWebhookPayload(r, body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	siteID := carrdSiteID(r, payload)
	if siteID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_site_id", "Carrd Custom URL submissions must include site_id in the query string, headers, or hidden fields")
		return
	}
	formID := carrdFormID(r, payload)
	if formID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_form_id", "Carrd Custom URL submissions must include form_id in the query string, headers, or hidden fields")
		return
	}
	integration, err := d.Repo.FindIntegrationByProviderSiteAndForm(r.Context(), ProviderCarrd, siteID, formID, "")
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Carrd integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if leadIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusGone, "integration_disconnected", "Carrd integration is disconnected")
		return
	}
	resolver := d.carrdCredentialResolver()
	if resolver == nil {
		httperror.Write(w, http.StatusInternalServerError, "credentials_not_configured", "Carrd credential resolver is not configured")
		return
	}
	creds, err := resolver.ResolveCarrd(r.Context(), integration.TenantID, *integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyCarrdWebhookToken(creds.WebhookToken, carrdRouteToken(r, payload)); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_token", "request authentication failed")
		return
	}
	webhookID := carrdWebhookID(payload, siteID, formID)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderCarrd, webhookID, carrdWebhookTopic, body)
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
	submission := mapCarrdWebhookSubmission(payload, siteID, formID, webhookID, *integration)
	req := normalizeSyncRequest(SyncRequest{
		RunMode:     "webhook",
		Submissions: []SubmissionInput{submission},
		Cursor:      "carrd-webhook-" + webhookID,
	})
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderCarrd, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "carrd webhook processing failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, ProviderCarrd, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, ProviderCarrd, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func VerifyCarrdWebhookToken(expected, actual string) error {
	expected = strings.TrimSpace(expected)
	actual = strings.TrimSpace(actual)
	if expected == "" {
		return fmt.Errorf("carrd webhook token is not configured")
	}
	if actual == "" {
		return fmt.Errorf("carrd webhook token is required")
	}
	if !hmac.Equal([]byte(expected), []byte(actual)) {
		return fmt.Errorf("carrd webhook token does not match")
	}
	return nil
}

type carrdWebhookPayload struct {
	BodyFields  map[string]any
	QueryFields map[string]any
	Raw         map[string]any
	RawBody     []byte
	Method      string
	ContentType string
}

func decodeCarrdWebhookPayload(r *http.Request, body []byte) (carrdWebhookPayload, error) {
	payload := carrdWebhookPayload{
		BodyFields:  map[string]any{},
		QueryFields: carrdValuesToMap(r.URL.Query()),
		RawBody:     append([]byte(nil), body...),
		Method:      r.Method,
		ContentType: r.Header.Get("Content-Type"),
	}
	if len(bytes.TrimSpace(body)) > 0 {
		fields, err := decodeCarrdBody(r.Header.Get("Content-Type"), body)
		if err != nil {
			return carrdWebhookPayload{}, err
		}
		payload.BodyFields = fields
	}
	payload.Raw = map[string]any{
		"method":       payload.Method,
		"content_type": payload.ContentType,
		"query":        carrdRedactedMap(payload.QueryFields),
		"body":         carrdRedactedMap(payload.BodyFields),
	}
	return payload, nil
}

func decodeCarrdBody(contentType string, body []byte) (map[string]any, error) {
	contentType = strings.TrimSpace(contentType)
	mediaType, params, _ := mime.ParseMediaType(contentType)
	mediaType = strings.ToLower(strings.TrimSpace(mediaType))
	switch mediaType {
	case "application/json", "text/json":
		var out map[string]any
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.UseNumber()
		if err := dec.Decode(&out); err != nil && err != io.EOF {
			return nil, fmt.Errorf("decode carrd JSON webhook: %w", err)
		}
		return carrdNormalizeMap(out), nil
	case "application/x-www-form-urlencoded":
		values, err := url.ParseQuery(string(body))
		if err != nil {
			return nil, fmt.Errorf("decode carrd form webhook: %w", err)
		}
		return carrdValuesToMap(values), nil
	case "multipart/form-data":
		boundary := strings.TrimSpace(params["boundary"])
		if boundary == "" {
			return nil, fmt.Errorf("decode carrd multipart webhook: missing boundary")
		}
		return decodeCarrdMultipartBody(boundary, body)
	case "application/xml", "text/xml":
		return decodeCarrdXMLBody(body)
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return map[string]any{}, nil
	}
	if trimmed[0] == '{' {
		return decodeCarrdBody("application/json", body)
	}
	if trimmed[0] == '<' {
		return decodeCarrdXMLBody(body)
	}
	values, err := url.ParseQuery(string(body))
	if err != nil {
		return nil, fmt.Errorf("decode carrd webhook body: unsupported content type %q", contentType)
	}
	if len(values) == 0 {
		return map[string]any{"body": string(body)}, nil
	}
	return carrdValuesToMap(values), nil
}

func decodeCarrdMultipartBody(boundary string, body []byte) (map[string]any, error) {
	form, err := multipart.NewReader(bytes.NewReader(body), boundary).ReadForm(carrdWebhookMaxBodySize)
	if err != nil {
		return nil, fmt.Errorf("decode carrd multipart webhook: %w", err)
	}
	defer func() { _ = form.RemoveAll() }()
	out := carrdValuesToMap(form.Value)
	for key, files := range form.File {
		items := make([]any, 0, len(files))
		for _, file := range files {
			items = append(items, map[string]any{
				"filename":     file.Filename,
				"size":         file.Size,
				"content_type": file.Header.Get("Content-Type"),
			})
		}
		if len(items) == 1 {
			out[key] = items[0]
		} else if len(items) > 1 {
			out[key] = items
		}
	}
	return out, nil
}

type carrdXMLNode struct {
	XMLName  xml.Name
	Text     string         `xml:",chardata"`
	Children []carrdXMLNode `xml:",any"`
}

func decodeCarrdXMLBody(body []byte) (map[string]any, error) {
	var root carrdXMLNode
	if err := xml.Unmarshal(body, &root); err != nil {
		return nil, fmt.Errorf("decode carrd XML webhook: %w", err)
	}
	out := map[string]any{}
	carrdFlattenXMLNode("", root, out)
	return out, nil
}

func carrdFlattenXMLNode(prefix string, node carrdXMLNode, out map[string]any) {
	name := strings.TrimSpace(node.XMLName.Local)
	path := name
	if prefix != "" && name != "" {
		path = prefix + "." + name
	}
	if len(node.Children) == 0 {
		text := strings.TrimSpace(node.Text)
		if text != "" && name != "" {
			carrdSetMapValue(out, name, text)
			if path != name {
				carrdSetMapValue(out, path, text)
			}
		}
		return
	}
	for _, child := range node.Children {
		carrdFlattenXMLNode(path, child, out)
	}
}

func carrdValuesToMap(values url.Values) map[string]any {
	out := make(map[string]any, len(values))
	for key, list := range values {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		switch len(list) {
		case 0:
			out[key] = ""
		case 1:
			out[key] = strings.TrimSpace(list[0])
		default:
			items := make([]any, 0, len(list))
			for _, value := range list {
				items = append(items, strings.TrimSpace(value))
			}
			out[key] = items
		}
	}
	return out
}

func carrdNormalizeMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if trimmed := strings.TrimSpace(key); trimmed != "" {
			out[trimmed] = carrdNormalizeValue(value)
		}
	}
	return out
}

func carrdNormalizeValue(value any) any {
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
		return carrdNormalizeMap(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, carrdNormalizeValue(item))
		}
		return out
	default:
		return typed
	}
}

func carrdSiteID(r *http.Request, payload carrdWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Site-ID"),
		r.Header.Get("X-Carrd-Site-ID"),
		r.URL.Query().Get("site_id"),
		r.URL.Query().Get("site"),
		r.URL.Query().Get("carrd_site_id"),
		mapString(payload.BodyFields, "site_id", "site", "carrd_site_id", "postwave_site_id"),
	)
}

func carrdFormID(r *http.Request, payload carrdWebhookPayload) string {
	return firstString(
		r.Header.Get("X-Postwave-Form-ID"),
		r.Header.Get("X-Carrd-Form-ID"),
		r.URL.Query().Get("form_id"),
		r.URL.Query().Get("form"),
		r.URL.Query().Get("carrd_form_id"),
		mapString(payload.BodyFields, "form_id", "form", "form_name", "carrd_form_id", "postwave_form_id"),
	)
}

func carrdRouteToken(r *http.Request, payload carrdWebhookPayload) string {
	return firstString(
		bearerToken(r.Header.Get("Authorization")),
		r.Header.Get("X-Postwave-Webhook-Token"),
		r.Header.Get("X-Postwave-Token"),
		r.Header.Get("X-Carrd-Webhook-Token"),
		r.Header.Get("X-Carrd-Token"),
		r.URL.Query().Get("token"),
		r.URL.Query().Get("webhook_token"),
		r.URL.Query().Get("route_token"),
		r.URL.Query().Get("postwave_token"),
		r.URL.Query().Get("carrd_token"),
		mapString(payload.BodyFields, "token", "webhook_token", "route_token", "postwave_token", "carrd_token"),
	)
}

func bearerToken(header string) string {
	header = strings.TrimSpace(header)
	if header == "" {
		return ""
	}
	const prefix = "bearer "
	if strings.HasPrefix(strings.ToLower(header), prefix) {
		return strings.TrimSpace(header[len(prefix):])
	}
	return header
}

func carrdWebhookID(payload carrdWebhookPayload, siteID, formID string) string {
	if id := firstString(
		mapString(payload.BodyFields, "submission_id", "submissionId", "id", "entry_id", "entryId", "response_id", "responseId", "lead_id", "leadId"),
		mapString(payload.QueryFields, "submission_id", "submissionId", "id", "entry_id", "entryId", "response_id", "responseId", "lead_id", "leadId"),
	); id != "" {
		return "carrd_" + normalizeTypeformIdentityKey(id)
	}
	sum := sha256.Sum256([]byte(siteID + "\n" + formID + "\n" + carrdCanonicalWebhookFields(payload)))
	return "carrd_local_" + hex.EncodeToString(sum[:16])
}

func carrdCanonicalWebhookFields(payload carrdWebhookPayload) string {
	fields := carrdMergedSubmissionFields(payload)
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		if carrdSecretLikeKey(key) {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(fields[key]))
		b.WriteByte('\n')
	}
	return b.String()
}

func mapCarrdWebhookSubmission(payload carrdWebhookPayload, siteID, formID, webhookID string, integration Integration) SubmissionInput {
	fields := map[string]any{
		"carrd_site_id":      siteID,
		"carrd_form_id":      formID,
		"carrd_webhook_id":   webhookID,
		"carrd_provider_raw": payload.Raw,
	}
	if len(payload.QueryFields) > 0 {
		fields["carrd_query"] = carrdRedactedMap(payload.QueryFields)
	}
	identity := typeformIdentity{}
	for key, value := range carrdMergedSubmissionFields(payload) {
		if carrdControlKey(key) {
			continue
		}
		normalizedKey := normalizeTypeformIdentityKey(key)
		if normalizedKey == "" {
			continue
		}
		normalizedValue := carrdNormalizeValue(value)
		fields["carrd_field."+normalizedKey] = normalizedValue
		identity.apply(key, carrdIdentityText(normalizedValue))
	}
	carrdApplyConfiguredIdentity(&identity, integration, payload)
	submittedAt := parseFilloutTime(firstString(
		carrdConfiguredFieldString(integration, payload, "submitted_at_field_key"),
		mapString(payload.BodyFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date"),
		mapString(payload.QueryFields, "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date"),
	))
	return SubmissionInput{
		SourceID:    carrdSourceID(siteID, formID, webhookID),
		Email:       strings.ToLower(strings.TrimSpace(identity.Email)),
		FirstName:   strings.TrimSpace(identity.FirstName),
		LastName:    strings.TrimSpace(identity.LastName),
		FullName:    strings.TrimSpace(identity.FullName),
		Phone:       strings.TrimSpace(identity.Phone),
		Company:     strings.TrimSpace(identity.Company),
		FormID:      formID,
		FormName:    firstString(settingString(integration.Settings, "form_name"), mapString(payload.BodyFields, "form_name"), formID),
		EventName:   "lead.submitted",
		Tags:        carrdTags(integration, siteID, formID),
		Fields:      fields,
		SubmittedAt: submittedAt,
	}
}

func carrdMergedSubmissionFields(payload carrdWebhookPayload) map[string]any {
	out := make(map[string]any, len(payload.QueryFields)+len(payload.BodyFields))
	for key, value := range payload.QueryFields {
		out[key] = value
	}
	for key, value := range payload.BodyFields {
		out[key] = value
	}
	return out
}

func carrdApplyConfiguredIdentity(identity *typeformIdentity, integration Integration, payload carrdWebhookPayload) {
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
		if value := carrdConfiguredFieldString(integration, payload, item.setting); value != "" {
			item.apply(value)
		}
	}
}

func carrdConfiguredFieldString(integration Integration, payload carrdWebhookPayload, settingKey string) string {
	fieldKey := settingString(integration.Settings, settingKey)
	if fieldKey == "" {
		return ""
	}
	fields := carrdMergedSubmissionFields(payload)
	for key, value := range fields {
		if strings.EqualFold(strings.TrimSpace(key), fieldKey) {
			return carrdIdentityText(value)
		}
	}
	return ""
}

func carrdIdentityText(value any) string {
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

func carrdControlKey(key string) bool {
	normalized := normalizeTypeformIdentityKey(key)
	switch normalized {
	case "token", "webhook_token", "route_token", "postwave_token", "carrd_token", "secret", "password", "site_id", "site", "carrd_site_id", "postwave_site_id", "form_id", "form", "carrd_form_id", "postwave_form_id":
		return true
	default:
		return carrdSecretLikeKey(key)
	}
}

func carrdSecretLikeKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(key, "token") || strings.Contains(key, "secret") || strings.Contains(key, "password")
}

func carrdRedactedMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		if carrdSecretLikeKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = carrdNormalizeValue(value)
	}
	return out
}

func carrdSetMapValue(out map[string]any, key string, value any) {
	if existing, ok := out[key]; ok {
		switch typed := existing.(type) {
		case []any:
			out[key] = append(typed, value)
		default:
			out[key] = []any{typed, value}
		}
		return
	}
	out[key] = value
}

func carrdTags(integration Integration, siteID, formID string) []string {
	tags := splitTypeformTags(settingString(integration.Settings, "default_tags"))
	for _, tag := range []string{"carrd", "carrd:" + siteID, "carrd:form:" + formID} {
		if !strings.HasSuffix(tag, ":") && !containsFold(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func carrdSourceID(siteID, formID, webhookID string) string {
	siteID = strings.TrimSpace(siteID)
	formID = strings.TrimSpace(formID)
	webhookID = strings.TrimSpace(webhookID)
	return "carrd://" + siteID + "/" + formID + "/" + webhookID
}
