// SPDX-License-Identifier: AGPL-3.0-only
package webhooks

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const deliverabilityProviderJSONMaxBodyBytes int64 = 128 << 10

type TenantProviderConfig struct {
	ID          string         `json:"id"`
	TenantID    string         `json:"tenant_id"`
	Provider    string         `json:"provider"`
	DisplayName string         `json:"display_name,omitempty"`
	Config      map[string]any `json:"config,omitempty"`
	Active      bool           `json:"active"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
}

type providerConfigInput struct {
	Provider    string         `json:"provider"`
	DisplayName string         `json:"display_name"`
	Config      map[string]any `json:"config"`
	Active      *bool          `json:"active,omitempty"`
}

func (d *DeliverabilityDeps) MountProviderConfigRoutes(r chi.Router) {
	r.Get("/api/v1/deliverability/providers", d.ListProviderConfigs)
	r.Post("/api/v1/deliverability/providers", d.UpsertProviderConfig)
	r.Patch("/api/v1/deliverability/providers/{id}", d.UpdateProviderConfig)
	r.Delete("/api/v1/deliverability/providers/{id}", d.DeleteProviderConfig)
}

func (d *DeliverabilityDeps) ListProviderConfigs(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErrDeliv(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	rows, err := d.listProviderConfigs(r, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONOK(w, http.StatusOK, map[string]any{"items": rows})
}

func (d *DeliverabilityDeps) UpsertProviderConfig(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErrDeliv(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in providerConfigInput
	if err := httpbody.DecodeJSON(w, r, deliverabilityProviderJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.upsertProviderConfig(r, t.ID, "", in)
	if err != nil {
		httperror.WriteValidation(w, "save_failed", "request could not be processed")
		return
	}
	writeJSONOK(w, http.StatusOK, map[string]any{"item": out})
}

func (d *DeliverabilityDeps) UpdateProviderConfig(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErrDeliv(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in providerConfigInput
	if err := httpbody.DecodeJSON(w, r, deliverabilityProviderJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.upsertProviderConfig(r, t.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONErrDeliv(w, http.StatusNotFound, "not_found", "")
			return
		}
		httperror.WriteValidation(w, "save_failed", "request could not be processed")
		return
	}
	writeJSONOK(w, http.StatusOK, map[string]any{"item": out})
}

func (d *DeliverabilityDeps) DeleteProviderConfig(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErrDeliv(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(), `
DELETE FROM tenant_deliverability_providers
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		t.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSONErrDeliv(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONOK(w, http.StatusOK, map[string]any{"ok": true})
}

func (d *DeliverabilityDeps) listProviderConfigs(r *http.Request, tenantID string) ([]TenantProviderConfig, error) {
	tx, err := db.WithTenant(r.Context(), d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, tenant_id::text, provider, COALESCE(display_name, ''),
       COALESCE(config, '{}'::jsonb), active, created_at, updated_at
  FROM tenant_deliverability_providers
 WHERE tenant_id = $1::uuid
 ORDER BY provider, created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TenantProviderConfig{}
	for rows.Next() {
		item, err := scanProviderConfig(rows, true)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(r.Context())
}

func (d *DeliverabilityDeps) upsertProviderConfig(r *http.Request, tenantID, id string, in providerConfigInput) (TenantProviderConfig, error) {
	provider := normalizeProviderName(in.Provider)
	if provider == "" {
		return TenantProviderConfig{}, errors.New("provider must be one of postmark, mailgun, ses, sendgrid, resend, sparkpost, mailersend, mailchimp")
	}
	if err := validateProviderConfig(provider, in.Config); err != nil {
		return TenantProviderConfig{}, err
	}
	active := true
	if in.Active != nil {
		active = *in.Active
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, tenantID)
	if err != nil {
		return TenantProviderConfig{}, err
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// MERGE the incoming config onto the stored one rather than clobber it:
	// the GET masks every secret as "redacted", and a card that saves one
	// secret (e.g. webhook_token) must not wipe a sibling token. Fetch
	// the existing config, then overlay incoming keys — but a key whose
	// incoming value is the redacted sentinel keeps the stored value (the
	// client echoed the masked read).
	existing := map[string]any{}
	{
		var existingRaw []byte
		var q string
		var args []any
		if strings.TrimSpace(id) == "" {
			q = `SELECT config FROM tenant_deliverability_providers WHERE tenant_id=$1::uuid AND provider=$2`
			args = []any{tenantID, provider}
		} else {
			q = `SELECT config FROM tenant_deliverability_providers WHERE tenant_id=$1::uuid AND id::text=$2`
			args = []any{tenantID, id}
		}
		if err := tx.QueryRow(r.Context(), q, args...).Scan(&existingRaw); err == nil && len(existingRaw) > 0 {
			_ = json.Unmarshal(existingRaw, &existing)
		}
	}
	raw, _ := json.Marshal(prepareProviderConfigForStorage(existing, in.Config))
	var row pgx.Row
	if strings.TrimSpace(id) == "" {
		row = tx.QueryRow(r.Context(), `
INSERT INTO tenant_deliverability_providers (tenant_id, provider, display_name, config, active)
VALUES ($1::uuid, $2, NULLIF($3, ''), $4::jsonb, $5)
ON CONFLICT (tenant_id, provider) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    config = EXCLUDED.config,
    active = EXCLUDED.active,
    updated_at = now()
RETURNING id::text, tenant_id::text, provider, COALESCE(display_name, ''),
          COALESCE(config, '{}'::jsonb), active, created_at, updated_at`,
			tenantID, provider, strings.TrimSpace(in.DisplayName), string(raw), active)
	} else {
		row = tx.QueryRow(r.Context(), `
UPDATE tenant_deliverability_providers SET
    provider = $3,
    display_name = NULLIF($4, ''),
    config = $5::jsonb,
    active = $6,
    updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING id::text, tenant_id::text, provider, COALESCE(display_name, ''),
          COALESCE(config, '{}'::jsonb), active, created_at, updated_at`,
			tenantID, id, provider, strings.TrimSpace(in.DisplayName), string(raw), active)
	}
	out, err := scanProviderConfig(row, true)
	if err != nil {
		return TenantProviderConfig{}, err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return TenantProviderConfig{}, err
	}
	return out, nil
}

type providerConfigScanner interface {
	Scan(dest ...any) error
}

func scanProviderConfig(row providerConfigScanner, redact bool) (TenantProviderConfig, error) {
	var out TenantProviderConfig
	var raw []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Provider, &out.DisplayName, &raw,
		&out.Active, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return TenantProviderConfig{}, err
	}
	_ = json.Unmarshal(raw, &out.Config)
	if redact {
		out.Config = redactProviderConfig(out.Config)
	}
	return out, nil
}

func normalizeProviderName(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "postmark", "mailgun", "ses", "sendgrid", "resend", "sparkpost", "mailersend", "mailchimp":
		return strings.ToLower(strings.TrimSpace(raw))
	default:
		return ""
	}
}

// providerSecretRedacted is the placeholder redactProviderConfig writes for
// secret-ish keys on read; an upsert echoing it back means "keep stored".
const providerSecretRedacted = "redacted"

// mergeProviderConfig overlays incoming onto existing so saving one secret
// never wipes a sibling. A key whose incoming value is the redacted sentinel
// keeps the stored value (the client re-sent the masked read).
func mergeProviderConfig(existing, incoming map[string]any) map[string]any {
	out := make(map[string]any, len(existing)+len(incoming))
	for k, v := range existing {
		out[k] = v
	}
	for k, v := range incoming {
		if s, ok := v.(string); ok && s == providerSecretRedacted {
			continue
		}
		out[k] = v
	}
	if _, canonical := out["credential_ref"]; !canonical {
		if legacyRef, ok := out["credentials_ref"].(string); ok && strings.TrimSpace(legacyRef) != "" {
			out["credential_ref"] = strings.TrimSpace(legacyRef)
		}
	}
	delete(out, "credentials_ref")
	// Saving the secure runtime-vault reference is the migration boundary for
	// old rows that predate the raw-credential ban. The resolver prioritizes
	// credential_ref, and the raw value must not remain at rest afterward.
	if ref, ok := out["credential_ref"].(string); ok && strings.TrimSpace(ref) != "" {
		delete(out, "api_key")
		delete(out, "credentials_ref")
	}
	return out
}

const providerWebhookTokenDigestDomain = "postwave:deliverability-provider-token:v1"

func prepareProviderConfigForStorage(existing, incoming map[string]any) map[string]any {
	out := mergeProviderConfig(existing, incoming)
	token := ""
	for _, key := range []string{"webhook_token", "token"} {
		if value, ok := out[key].(string); ok && strings.TrimSpace(value) != "" && value != providerSecretRedacted {
			token = strings.TrimSpace(value)
			break
		}
	}
	if token != "" {
		out["webhook_token_hash"] = hex.EncodeToString(
			hashHMACSHA256(token, []byte(providerWebhookTokenDigestDomain)),
		)
		delete(out, "webhook_token")
		delete(out, "token")
	}
	return out
}

func validateProviderConfig(provider string, config map[string]any) error {
	if path, ok := firstRawSendCredentialPath(config, "config"); ok {
		return errors.New("raw sending credential " + path + " is not stored in deliverability provider config; use an encrypted credential reference or provider environment configuration")
	}
	for _, key := range []string{"webhook_token", "token"} {
		if value, exists := config[key]; exists {
			token, ok := value.(string)
			token = strings.TrimSpace(token)
			if !ok || (token != providerSecretRedacted && !validProviderWebhookToken(token)) {
				return errors.New(key + " must be a 32-512 character whitespace-free high-entropy token")
			}
		}
	}
	for _, key := range []string{"credential_ref", "credentials_ref"} {
		if value, exists := config[key]; exists {
			ref, ok := value.(string)
			if !ok || !validProviderCredentialRef(ref) {
				return errors.New(key + " must be a bounded tenant-relative runtime-secret name, not credential material")
			}
		}
	}
	return nil
}

func validProviderWebhookToken(token string) bool {
	if len(token) < 32 || len(token) > 512 || strings.ContainsAny(token, " \t\r\n") {
		return false
	}
	for _, r := range token {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return true
}

func validProviderCredentialRef(raw string) bool {
	ref := strings.TrimSpace(raw)
	if ref == "" || len(ref) > 512 || strings.ContainsAny(ref, " \t\r\n") ||
		strings.HasPrefix(ref, "/") || strings.HasSuffix(ref, "/") || strings.Contains(ref, "//") {
		return false
	}
	lower := strings.ToLower(ref)
	if strings.HasPrefix(lower, "tenants/") {
		return false
	}
	if strings.HasPrefix(lower, "{") || strings.HasPrefix(lower, "[") ||
		strings.HasPrefix(lower, "bearer") || strings.HasPrefix(lower, "basic") ||
		strings.HasPrefix(lower, "sk_") || strings.HasPrefix(lower, "sg.") ||
		strings.HasPrefix(lower, "xox") || strings.HasPrefix(lower, "eyj") {
		return false
	}
	if !strings.Contains(ref, "/") && !strings.HasPrefix(lower, "cred_") {
		return false
	}
	for _, r := range ref {
		allowed := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || strings.ContainsRune("/_+=.@-", r)
		if !allowed {
			return false
		}
	}
	for _, segment := range strings.Split(ref, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func firstRawSendCredentialPath(value any, path string) (string, bool) {
	switch typed := value.(type) {
	case map[string]any:
		for k, v := range typed {
			next := k
			if path != "" {
				next = path + "." + k
			}
			if isRawSendCredentialKey(k) && rawConfigValuePresent(v) {
				return next, true
			}
			if found, ok := firstRawSendCredentialPath(v, next); ok {
				return found, true
			}
		}
	case []any:
		for i, v := range typed {
			next := path + "[]"
			if found, ok := firstRawSendCredentialPath(v, next); ok {
				return found, true
			}
			_ = i
		}
	}
	return "", false
}

func isRawSendCredentialKey(key string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "-", "_"), " ", "_"))
	switch normalized {
	case "api_key", "apikey", "server_token", "servertoken", "account_token", "accounttoken",
		"access_key_id", "secret_access_key", "smtp_password", "smtp_pass", "private_key",
		"client_secret", "send_key", "mail_send_key":
		return true
	default:
		return false
	}
}

func rawConfigValuePresent(value any) bool {
	switch typed := value.(type) {
	case string:
		s := strings.TrimSpace(typed)
		return s != "" && s != providerSecretRedacted
	case nil:
		return false
	default:
		return true
	}
}

func redactProviderConfig(in map[string]any) map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		lower := strings.ToLower(k)
		if strings.Contains(lower, "secret") ||
			strings.Contains(lower, "token") ||
			strings.Contains(lower, "key") ||
			strings.Contains(lower, "password") {
			out[k] = "redacted"
			continue
		}
		switch typed := v.(type) {
		case map[string]any:
			out[k] = redactProviderConfig(typed)
		case []any:
			out[k] = redactProviderConfigSlice(typed)
		default:
			out[k] = v
		}
	}
	return out
}

func redactProviderConfigSlice(in []any) []any {
	out := make([]any, len(in))
	for i, v := range in {
		switch typed := v.(type) {
		case map[string]any:
			out[i] = redactProviderConfig(typed)
		case []any:
			out[i] = redactProviderConfigSlice(typed)
		default:
			out[i] = v
		}
	}
	return out
}
