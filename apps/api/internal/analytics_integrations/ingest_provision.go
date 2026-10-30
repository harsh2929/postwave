// SPDX-License-Identifier: AGPL-3.0-only
//
// ingest_provision.go — authenticated provisioning for the CDP webhook ingest
// runtime (segment_ingest.go / rudderstack.go).
//
// Segment and RudderStack are inbound CDP sources: their native integration path
// is a Webhook destination that pushes identify/track events to a per-integration
// public ingest URL. The public ingest endpoints (SegmentIngest / RudderStackIngest)
// resolve the owning tenant from an opaque per-integration URL token via an RLS
// lookup policy. Before this file, the only way to stand one up was the generic
// create endpoint, which demands a credentials_ref + provider-specific required
// settings (wrong for an inbound CDP source that needs no outbound credential) and
// never minted the token. These handlers close that gap: they mint a high-entropy
// ingest token server-side (so it cannot be guessed into a cross-tenant write),
// persist a webhook-ingest integration row with no outbound credential, and return
// the assembled ingest URL the merchant pastes into the provider's webhook
// destination. Mirrors loyalty_integrations/ingest_provision.go and
// support_integrations/ingest_provision.go.
//
// Deviation from the loyalty/support templates: the lookup token lives under a
// provider-specific settings key (segment_ingest_token / rudderstack_ingest_token,
// the keys the public lookups already read) rather than one shared key, and the
// selectable-provider flag is CDP (Segment + RudderStack) rather than push-only.
package analytics_integrations

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

const (
	segmentIngestTokenSetting     = "segment_ingest_token"
	rudderStackIngestTokenSetting = "rudderstack_ingest_token"
	// analyticsIngestTokenKey is the shared key for the GENERIC webhook-ingest
	// path (any non-CDP provider: payments/events/cms and other profile+event
	// tools), resolved by FindAnalyticsIntegrationByIngestToken (migration 1617).
	analyticsIngestTokenKey = "analytics_ingest_token"
)

// IngestProvisionInput is the request body for provisioning a webhook-ingest
// integration. Only the provider is required; the token is minted server-side.
type IngestProvisionInput struct {
	Provider string `json:"provider"`
	Name     string `json:"name,omitempty"`
}

// IngestProviderOption is one selectable provider for the webhook-ingest setup
// UI. CDP marks the inbound CDP sources (Segment + RudderStack) whose native
// integration path is webhook ingest.
type IngestProviderOption struct {
	Provider string `json:"provider"`
	Name     string `json:"name"`
	Category string `json:"category"`
	CDP      bool   `json:"cdp"`
	DocsURL  string `json:"docs_url,omitempty"`
}

// IngestEndpoint is the UI-facing view of a provisioned webhook-ingest
// integration: the assembled public URL + token the merchant pastes into the
// provider. The token is the URL bearer credential (stored verbatim for the RLS
// lookup), so it is returned to the authenticated admin who needs the URL.
type IngestEndpoint struct {
	IntegrationID string    `json:"integration_id"`
	Provider      string    `json:"provider"`
	ProviderName  string    `json:"provider_name"`
	Name          string    `json:"name"`
	Status        string    `json:"status"`
	CDP           bool      `json:"cdp"`
	IngestPath    string    `json:"ingest_path"`
	IngestURL     string    `json:"ingest_url,omitempty"`
	IngestToken   string    `json:"ingest_token"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// isCDPProvider reports whether the provider is an inbound CDP source (Segment +
// RudderStack) whose native integration path is webhook ingest.
func isCDPProvider(provider string) bool {
	switch provider {
	case ProviderSegment, ProviderRudderStack:
		return true
	default:
		return false
	}
}

// analyticsIngestTokenSetting returns the settings key the public ingest lookup
// reads: the per-provider CDP key for Segment/RudderStack, else the shared
// analytics_ingest_token for the GENERIC webhook-ingest path (any other tool).
func analyticsIngestTokenSetting(provider string) string {
	switch provider {
	case ProviderSegment:
		return segmentIngestTokenSetting
	case ProviderRudderStack:
		return rudderStackIngestTokenSetting
	default:
		return analyticsIngestTokenKey
	}
}

// sanitizeIngestProvider lowercases and slug-normalizes a provider label to a
// URL-safe token (matching the catalog slugify). Returns "" when nothing usable
// remains.
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

// ListIngestProviders returns every analytics provider that can be wired via
// webhook ingest, flagged so the UI can surface CDP sources prominently.
func (d *Deps) ListIngestProviders(w http.ResponseWriter, r *http.Request) {
	specs := ProviderSpecs()
	out := make([]IngestProviderOption, 0, len(specs))
	for _, spec := range specs {
		out = append(out, IngestProviderOption{
			Provider: spec.Provider,
			Name:     spec.Name,
			Category: spec.Category,
			CDP:      isCDPProvider(spec.Provider),
			DocsURL:  spec.DocsURL,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// ListIngestEndpoints returns the tenant's provisioned webhook-ingest
// integrations with their assembled public URLs.
func (d *Deps) ListIngestEndpoints(w http.ResponseWriter, r *http.Request) {
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
		if integrationIngestToken(&integ) == "" {
			continue
		}
		out = append(out, d.buildIngestEndpoint(r, &integ))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// ProvisionIngest mints an ingest token (if one does not already exist for the
// provider) and persists a webhook-ingest integration, returning the public URL.
// Provisioning is idempotent: re-requesting a provider already wired returns the
// existing endpoint rather than rotating the live token. Only CDP providers
// (Segment + RudderStack) accept ingest provisioning.
func (d *Deps) ProvisionIngest(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in IngestProvisionInput
	if err := httpbody.DecodeJSON(w, r, analyticsJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	// CDP sources (Segment/RudderStack) use the Segment-spec ingest; every other
	// provider uses the GENERIC webhook ingest (any tool that can POST a webhook,
	// landed as a profile + event). Accept any sanitized slug.
	provider := sanitizeIngestProvider(in.Provider)
	if provider == "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "provider is required")
		return
	}

	// Idempotent: return the existing ingest endpoint if one is already wired.
	existing, err := d.Repo.ListIntegrations(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	for i := range existing {
		integ := existing[i]
		if integ.Provider == provider &&
			integ.Status != "disconnected" &&
			integrationIngestToken(&integ) != "" {
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

// newIngestToken mints a high-entropy, URL-safe ingest token. The token is the
// pre-tenant routing key AND the bearer credential for the public ingest URL, so
// it must be unguessable — 24 random bytes (192 bits). Overridable for tests.
func (d *Deps) newIngestToken() (string, error) {
	if d != nil && d.NewIngestToken != nil {
		return d.NewIngestToken()
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "awhk_" + hex.EncodeToString(buf), nil
}

func (d *Deps) buildIngestEndpoint(r *http.Request, integ *Integration) IngestEndpoint {
	token := integrationIngestToken(integ)
	path := analyticsIngestPath(integ.Provider, token)
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
		CDP:           isCDPProvider(integ.Provider),
		IngestPath:    path,
		IngestURL:     ingestURLFromRequest(r, path),
		IngestToken:   token,
		CreatedAt:     integ.CreatedAt,
		UpdatedAt:     integ.UpdatedAt,
	}
}

// integrationIngestToken returns the provider-specific ingest token stored on an
// integration's settings, empty when the integration is not webhook-ingest wired.
func integrationIngestToken(integ *Integration) string {
	if integ == nil {
		return ""
	}
	key := analyticsIngestTokenSetting(integ.Provider)
	if key == "" {
		return ""
	}
	return settingString(integ.Settings, key)
}

func analyticsIngestPath(provider, token string) string {
	return "/api/public/analytics-integrations/" + url.PathEscape(provider) + "/ingest/" + url.PathEscape(token)
}

// ingestURLFromRequest best-effort assembles the absolute public ingest URL from
// the inbound request host. Webhook ingest is served on the same public API host
// the admin is calling, so the proxied Host header is the externally reachable
// host. Empty when the host is unknown — the client then composes from its own
// API base + ingest_path.
func ingestURLFromRequest(r *http.Request, path string) string {
	if r == nil || r.Host == "" {
		return ""
	}
	scheme := "https"
	if proto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); proto != "" {
		scheme = proto
	} else if r.TLS == nil {
		scheme = "http"
	}
	return scheme + "://" + r.Host + path
}
