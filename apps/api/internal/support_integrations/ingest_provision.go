// SPDX-License-Identifier: AGPL-3.0-only
//
// ingest_provision.go — authenticated provisioning for the support webhook
// ingest runtime (support_ingest.go).
//
// Push-only support desks deliver conversations
// only via webhooks — they expose no ticket-shaped bulk-list API. The public
// ingest endpoint (SupportWebhookIngest) resolves the owning tenant from an
// opaque per-integration URL token via an RLS lookup policy. These handlers mint
// that token server-side (high entropy, so it cannot be guessed into a
// cross-tenant write), persist a webhook-ingest integration row with no outbound
// credential, and return the assembled ingest URL the merchant pastes into the
// provider's webhook settings. Mirrors loyalty_integrations/ingest_provision.go.
package support_integrations

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const supportIngestTokenSetting = "support_ingest_token"

// IngestProvisionInput is the request body for provisioning a webhook-ingest
// integration. Only the provider is required; the token is minted server-side.
type IngestProvisionInput struct {
	Provider         string `json:"provider"`
	Name             string `json:"name,omitempty"`
	WebhookSecretRef string `json:"webhook_secret_ref,omitempty"`
}

// IngestProviderOption is one selectable provider for the webhook-ingest setup
// UI. PushOnly marks desks that have no provider puller yet and can only be
// integrated via the generic webhook ingest fallback.
type IngestProviderOption struct {
	Provider      string `json:"provider"`
	Name          string `json:"name"`
	Category      string `json:"category"`
	PushOnly      bool   `json:"push_only"`
	DocsURL       string `json:"docs_url,omitempty"`
	RuntimeStatus string `json:"runtime_status"`
	HoldCode      string `json:"hold_code,omitempty"`
}

// IngestEndpoint is the UI-facing view of a provisioned webhook-ingest
// integration: the assembled public URL + token the merchant pastes into the
// provider. The token is the URL bearer credential, returned to the
// authenticated admin who needs the URL.
type IngestEndpoint struct {
	IntegrationID string    `json:"integration_id"`
	Provider      string    `json:"provider"`
	ProviderName  string    `json:"provider_name"`
	Name          string    `json:"name"`
	Status        string    `json:"status"`
	PushOnly      bool      `json:"push_only"`
	IngestPath    string    `json:"ingest_path"`
	IngestURL     string    `json:"ingest_url,omitempty"`
	IngestToken   string    `json:"ingest_token"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// isPushOnlySupportProvider reports desks whose current local runtime is generic
// webhook ingest only. Providers with a native OpenAPI/REST puller stay listed
// for backward-compatible ingest URLs but are not push-only.
func isPushOnlySupportProvider(provider string) bool {
	switch provider {
	default:
		return false
	}
}

// ListIngestProviders returns every support provider that can be wired via
// webhook ingest, flagged so the UI can surface push-only desks prominently.
func (d *Deps) ListIngestProviders(w http.ResponseWriter, r *http.Request) {
	specs := ProviderSpecs()
	out := make([]IngestProviderOption, 0, len(specs))
	for _, spec := range specs {
		out = append(out, IngestProviderOption{
			Provider:      spec.Provider,
			Name:          spec.Name,
			Category:      spec.Category,
			PushOnly:      isPushOnlySupportProvider(spec.Provider),
			DocsURL:       spec.DocsURL,
			RuntimeStatus: "held",
			HoldCode:      "support_ingest_release_held",
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// ListIngestEndpoints returns the tenant's provisioned webhook-ingest
// integrations with their assembled public URLs.
func (d *Deps) ListIngestEndpoints(w http.ResponseWriter, r *http.Request) {
	if !archivedSupportRuntimeFixture(r) {
		d.RuntimeHeld(w, r)
		return
	}
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	integrations, err := d.Repo.ListIntegrations(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	out := make([]IngestEndpoint, 0)
	for i := range integrations {
		integ := integrations[i]
		if settingString(integ.Settings, supportIngestTokenSetting) == "" {
			continue
		}
		out = append(out, d.buildIngestEndpoint(r, &integ))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// ProvisionIngest mints an ingest token (if one does not already exist for the
// provider) and persists a webhook-ingest integration, returning the public URL.
// Idempotent: re-requesting a provider already wired returns the existing
// endpoint rather than rotating the live token.
func (d *Deps) ProvisionIngest(w http.ResponseWriter, r *http.Request) {
	if !archivedSupportRuntimeFixture(r) {
		d.RuntimeHeld(w, r)
		return
	}

	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in IngestProvisionInput
	if err := httpbody.DecodeJSON(w, r, supportJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	// Webhook ingest is a generic inbound path: any support/chat tool that can
	// POST a webhook is set-up-able, not just curated pullers. The single
	// per-package RLS lookup policy matches ANY provider carrying the token, so
	// accept any sanitized slug.
	provider := sanitizeIngestProvider(in.Provider)
	if provider == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "provider is required")
		return
	}
	in.WebhookSecretRef = strings.TrimSpace(in.WebhookSecretRef)
	if in.WebhookSecretRef != "" && looksLikeRawCredentialRef(in.WebhookSecretRef) {
		httperror.Write(w, http.StatusUnprocessableEntity, "raw_credentials_rejected", "webhook_secret_ref looks like raw credential material")
		return
	}

	existing, err := d.Repo.ListIntegrations(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	for i := range existing {
		integ := existing[i]
		if integ.Provider == provider &&
			integ.Status != "disconnected" &&
			settingString(integ.Settings, supportIngestTokenSetting) != "" {
			writeJSON(w, http.StatusOK, d.buildIngestEndpoint(r, &integ))
			return
		}
	}

	token, err := d.newIngestToken()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	in.Provider = provider
	out, err := d.Repo.ProvisionIngestIntegration(r.Context(), tenantID, in, token)
	if err != nil {
		if errors.Is(err, ErrIngestNameConflict) {
			httperror.Write(w, http.StatusConflict, "name_conflict", "an integration with this provider and name already exists and is not a webhook-ingest endpoint")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusCreated, d.buildIngestEndpoint(r, out))
}

// RotateIngest issues a fresh ingest token for an existing webhook-ingest
// integration, invalidating the old URL.
func (d *Deps) RotateIngest(w http.ResponseWriter, r *http.Request) {
	if !archivedSupportRuntimeFixture(r) {
		d.RuntimeHeld(w, r)
		return
	}

	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	token, err := d.newIngestToken()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	out, err := d.Repo.RotateIngestToken(r.Context(), tenantID, id, token)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, d.buildIngestEndpoint(r, out))
}

// newIngestToken mints a high-entropy, URL-safe ingest token (24 random bytes =
// 192 bits). The token is the pre-tenant routing key AND the bearer credential
// for the public ingest URL, so it must be unguessable. Overridable for tests.
func (d *Deps) newIngestToken() (string, error) {
	if d != nil && d.NewIngestToken != nil {
		return d.NewIngestToken()
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "swhk_" + hex.EncodeToString(buf), nil
}

func (d *Deps) buildIngestEndpoint(r *http.Request, integ *Integration) IngestEndpoint {
	token := settingString(integ.Settings, supportIngestTokenSetting)
	path := supportIngestPath(integ.Provider, token)
	name := integ.Name
	providerName := integ.Provider
	if spec, ok := ProviderSpecByKey(integ.Provider); ok {
		providerName = spec.Name
		if name == "" {
			name = spec.Name
		}
	}
	return IngestEndpoint{
		IntegrationID: integ.ID,
		Provider:      integ.Provider,
		ProviderName:  providerName,
		Name:          name,
		Status:        integ.Status,
		PushOnly:      isPushOnlySupportProvider(integ.Provider),
		IngestPath:    path,
		IngestURL:     ingestURLFromRequest(r, path),
		IngestToken:   token,
		CreatedAt:     integ.CreatedAt,
		UpdatedAt:     integ.UpdatedAt,
	}
}

// redactIngestToken returns a copy of the integration with the ingest token
// stripped from settings. The token is the public URL's bearer credential, so
// the general read-scoped list/get endpoints must not leak it; admins read it
// from the dedicated webhook-ingest endpoints instead.
func redactIngestToken(integ Integration) Integration {
	if integ.Settings == nil {
		return integ
	}
	if _, ok := integ.Settings[supportIngestTokenSetting]; !ok {
		return integ
	}
	cp := make(map[string]any, len(integ.Settings))
	for k, v := range integ.Settings {
		if k == supportIngestTokenSetting {
			continue
		}
		cp[k] = v
	}
	integ.Settings = cp
	return integ
}

// sanitizeIngestProvider lowercases and slug-normalizes a provider label to a
// URL-safe token (matching the catalog's slugify). Returns "" when nothing
// usable remains.
func sanitizeIngestProvider(raw string) string {
	raw = strings.ToLower(strings.TrimSpace(raw))
	var b strings.Builder
	prevDash := false
	for _, r := range raw {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevDash = false
		case r == '-' || r == '_' || r == ' ' || r == '.' || r == '/':
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
		if b.Len() >= 64 {
			break
		}
	}
	return strings.Trim(b.String(), "-")
}

func supportIngestPath(provider, token string) string {
	return "/api/public/support-integrations/" + url.PathEscape(provider) + "/ingest/" + url.PathEscape(token)
}

// ingestURLFromRequest best-effort assembles the absolute public ingest URL from
// the inbound request host (same public API host the admin is calling). Empty
// when the host is unknown — the client then composes from its own API base.
func ingestURLFromRequest(r *http.Request, path string) string {
	if r == nil || r.Host == "" {
		return ""
	}
	scheme := "https"
	if r.TLS == nil {
		scheme = "http"
	}
	// Trust the proxy's forwarded scheme only when it is a known value; never
	// echo an arbitrary header into the URL shown to the admin.
	switch strings.ToLower(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))) {
	case "https":
		scheme = "https"
	case "http":
		scheme = "http"
	}
	return scheme + "://" + r.Host + path
}
