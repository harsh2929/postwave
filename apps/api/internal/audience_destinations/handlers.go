// SPDX-License-Identifier: AGPL-3.0-only
package audience_destinations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/activation_firewall"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const audienceDestinationsMaxBody int64 = 64 << 10 // 64 KiB

// Deps wires repo + handlers.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
	// Adapters is the ad-platform adapter registry (SUB-113). Optional:
	// the providers + preview endpoints degrade gracefully when nil.
	Adapters AdapterRegistry
	// Runner gives the preview handler access to source member resolution +
	// the consent firewall. Optional.
	Runner *SyncRunner
	// CredentialResolver lets the readiness preview reflect whether a stored
	// credential_ref resolves to live secrets. Optional.
	CredentialResolver AudienceCredentialResolver
}

// MountRoutes registers the per-tenant audience destinations API.
//
//	GET    /api/v1/audience-destinations
//	POST   /api/v1/audience-destinations
//	GET    /api/v1/audience-destinations/{id}
//	PATCH  /api/v1/audience-destinations/{id}
//	DELETE /api/v1/audience-destinations/{id}
//	POST   /api/v1/audience-destinations/{id}/sync
//	GET    /api/v1/audience-destinations/{id}/jobs
//	GET    /api/v1/audience-destinations/{id}/jobs/{job_id}/diagnostics
//	GET    /api/v1/audience-destinations/providers
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/audience-destinations/providers", d.Providers)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/audience-destinations", d.List)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/audience-destinations", d.Create)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/audience-destinations/{id}", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/audience-destinations/{id}", d.Update)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/audience-destinations/{id}", d.Delete)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/audience-destinations/{id}/sync", d.Sync)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/audience-destinations/{id}/jobs", d.ListJobs)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/audience-destinations/{id}/jobs/{job_id}/diagnostics", d.JobDiagnostics)
	// SUB-113 — platform-adapter readiness + consent-exclusion preview.
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Post("/api/v1/audience-destinations/{provider}/readiness", d.PlatformReadiness)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/audience-destinations/{id}/preview", d.Preview)
}

// PlatformReadiness POST /api/v1/audience-destinations/{provider}/readiness
// — validates a platform-adapter config block and reports readiness +
// the exact missing keys, so the UI can guide OAuth/credential setup
// before a sync is attempted.
func (d *Deps) PlatformReadiness(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "provider")))
	if !IsValidProvider(provider) {
		httperror.WriteValidation(w, "invalid_input", "unknown provider")
		return
	}
	if d.Adapters == nil || d.Adapters[provider] == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "adapter_unavailable",
			"platform adapter not configured on this server")
		return
	}
	var body struct {
		Config map[string]any `json:"config"`
	}
	if err := httpbody.DecodeJSONWith(w, r, audienceDestinationsMaxBody, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	cfg := body.Config
	if d.CredentialResolver != nil {
		if hydrated, err := hydrateAdapterConfig(r.Context(), d.CredentialResolver, cfg); err == nil {
			cfg = hydrated
		}
	}
	writeJSON(w, http.StatusOK, d.Adapters[provider].Readiness(cfg))
}

// Preview GET /api/v1/audience-destinations/{id}/preview — resolves the
// destination's source members and reports how many the consent firewall
// would withhold, WITHOUT shipping anything. Mirrors the activation
// firewall's per-sync preview for the older audience_destinations table.
func (d *Deps) Preview(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	dest, err := d.Repo.Get(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	if d.Runner == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "runner_unavailable",
			"preview requires the sync runner")
		return
	}
	members, truncated, err := d.Runner.ResolveSourceMembers(r.Context(), t.ID, dest.ListID, dest.SegmentID)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	total := len(members)
	excluded := 0
	kept := total
	if d.Runner.Firewall != nil {
		purpose := activation_firewall.ResolvePurpose(string(dest.Provider), "")
		emails := make([]string, 0, total)
		for _, m := range members {
			emails = append(emails, m.Email)
		}
		dec := d.Runner.Firewall.Decide(r.Context(), t.ID, purpose, string(dest.Provider), emails)
		excluded = len(dec.Excluded)
		kept = len(dec.Kept)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"destination_id":  dest.ID,
		"provider":        dest.Provider,
		"total_members":   total,
		"excluded_count":  excluded,
		"deliverable":     kept,
		"truncated":       truncated,
		"firewall_active": d.Runner.Firewall != nil,
	})
}

// Providers returns the catalog of supported destinations.
func (d *Deps) Providers(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"providers":    AllProviders,
		"capabilities": providerCapabilities(d.Adapters),
	})
}

// providerCapabilities is the deployment-specific capability catalog. A
// provider appears in AllProviders because destination rows can be modeled for
// it; diagnostics is advertised only when the registered adapter can actually
// retrieve provider-side state.
func providerCapabilities(adapters AdapterRegistry) map[string]map[string]bool {
	out := make(map[string]map[string]bool, len(AllProviders))
	for _, provider := range AllProviders {
		adapter := adapters[string(provider)]
		_, diagnostics := adapter.(PlatformDiagnosticsAdapter)
		out[string(provider)] = map[string]bool{
			"configured":  adapter != nil,
			"diagnostics": diagnostics,
		}
	}
	return out
}

// List returns destinations for the tenant.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	items, err := d.Repo.List(r.Context(), t.ID, provider)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// Get returns one destination.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	out, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	w.Header().Set("ETag", httpcache.ConcurrencyToken("audience-destination", out.ID, out.UpdatedAt))
	writeJSON(w, http.StatusOK, out)
}

// Create inserts a new destination.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, audienceDestinationsMaxBody, &in); err != nil {
		// httpbody returns operator-safe codes (bad_json / payload_too_large)
		// and its error text is authored by httpbody itself — safe to echo.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	w.Header().Set("ETag", httpcache.ConcurrencyToken("audience-destination", out.ID, out.UpdatedAt))
	writeJSON(w, http.StatusCreated, out)
}

// Update patches an existing destination.
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, audienceDestinationsMaxBody, &in); err != nil {
		// httpbody returns operator-safe codes (bad_json / payload_too_large)
		// and its error text is authored by httpbody itself — safe to echo.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if token, ok := optionalAudienceIfMatch(r); !ok {
		httpcache.WritePreconditionFailed(w)
		return
	} else {
		in.IfMatchToken = token
	}
	out, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	w.Header().Set("ETag", httpcache.ConcurrencyToken("audience-destination", out.ID, out.UpdatedAt))
	writeJSON(w, http.StatusOK, out)
}

// Delete removes a destination.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	ifMatchToken, validIfMatch := optionalAudienceIfMatch(r)
	if !validIfMatch {
		httpcache.WritePreconditionFailed(w)
		return
	}
	dest, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	cleanup := audienceDestinationDisconnectCleanupEvidence(dest)
	if err := d.Repo.DisconnectWithProviderCleanupIfCurrent(r.Context(), t.ID, id, cleanup, ifMatchToken); err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, DisconnectResponse{OK: true, ProviderCleanup: cleanup})
}

func audienceDestinationDisconnectCleanupEvidence(dest *Destination) *DisconnectCleanupEvidence {
	if dest == nil {
		return nil
	}
	cfg := dest.AdapterConfig()
	scopeType, scopeID := audienceDestinationCleanupScope(dest.Provider, dest.ExternalAudienceID, cfg)
	providerName := audienceDestinationProviderName(dest.Provider)
	return &DisconnectCleanupEvidence{
		Provider:                        string(dest.Provider),
		Status:                          "operator_action_required",
		RecordedAt:                      time.Now().UTC().Format(time.RFC3339),
		PostwaveStatus:                  string(StatusDisconnected),
		ProviderCleanupPosture:          "operator_managed_provider_console",
		ManagedProviderCleanup:          false,
		ProviderScopeType:               scopeType,
		ProviderScopeID:                 scopeID,
		ExternalAudienceID:              firstNonEmpty(dest.ExternalAudienceID, scopeID),
		CredentialRefPresent:            credentialReference(cfg) != "",
		AudienceCleanupStatus:           "operator_review_required",
		AudienceMembershipCleanupStatus: "postwave_delivery_stopped",
		CredentialCleanupStatus:         "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local audience destination is marked disconnected",
			"manual and scheduled Moosewave audience delivery for this destination stops",
			"audience sync job history and provider request evidence are retained",
		},
		ProviderConsoleActions: audienceDestinationProviderConsoleActions(dest.Provider),
		ProviderCleanupEvidence: []string{
			"Moosewave did not call " + providerName + " provider-side audience deletion APIs during disconnect",
			"provider audience membership, account links, OAuth grants, app installs, and tokens require operator review in the provider console",
		},
	}
}

func audienceDestinationCleanupScope(provider Provider, externalAudienceID string, cfg map[string]any) (string, string) {
	switch provider {
	case ProviderGoogleAds:
		return "google_ads_user_list_id", firstNonEmpty(externalAudienceID, configString(cfg, "user_list_id"))
	case ProviderLinkedIn:
		return "linkedin_segment_id", firstNonEmpty(externalAudienceID, configString(cfg, "segment_id"))
	case ProviderSnap:
		return "snap_segment_id", firstNonEmpty(externalAudienceID, configString(cfg, "segment_id"))
	case ProviderTikTok:
		return "tiktok_audience_id", firstNonEmpty(externalAudienceID, configString(cfg, "audience_id"))
	default:
		return "meta_audience_id", firstNonEmpty(externalAudienceID, configString(cfg, "audience_id"))
	}
}

func audienceDestinationProviderName(provider Provider) string {
	switch provider {
	case ProviderGoogleAds:
		return "Google Ads"
	case ProviderTikTok:
		return "TikTok"
	case ProviderLinkedIn:
		return "LinkedIn"
	case ProviderSnap:
		return "Snapchat"
	default:
		return "Meta"
	}
}

func audienceDestinationProviderConsoleActions(provider Provider) []string {
	switch provider {
	case ProviderGoogleAds:
		return []string{
			"revoke or rotate Google OAuth/developer-token credentials if they are no longer used",
			"remove or clear the Google Ads Customer Match user list if provider-side audience data should be deleted",
			"audit Google Ads/Data Manager account links and Customer Match permissions",
		}
	case ProviderTikTok:
		return []string{
			"revoke or rotate TikTok Marketing API credentials if they are no longer used",
			"remove or clear the TikTok Custom Audience if provider-side audience data should be deleted",
			"audit TikTok advertiser app permissions and duplicate audience exports",
		}
	case ProviderLinkedIn:
		return []string{
			"revoke or rotate LinkedIn Marketing API credentials if they are no longer used",
			"remove or clear the LinkedIn Matched Audience segment if provider-side audience data should be deleted",
			"audit LinkedIn ad account roles and DMP segment access",
		}
	case ProviderSnap:
		return []string{
			"revoke or rotate Snapchat Marketing API credentials if they are no longer used",
			"remove or clear the Snapchat audience segment if provider-side audience data should be deleted",
			"audit Snapchat ad account access and duplicate audience exports",
		}
	default:
		return []string{
			"revoke or rotate Meta ads access tokens if they are no longer used",
			"remove or clear the Meta Custom Audience if provider-side audience data should be deleted",
			"audit Meta Business app permissions, ad-account access, and duplicate audience exports",
		}
	}
}

// Sync executes one readiness-gated audience sync (SUB-113): it resolves the
// destination's source members, applies the consent-safe activation firewall
// (skipping suppressed / non-consented profiles for the destination's consent
// purpose), hashes PII, routes the kept members to the provider's
// PlatformAdapter, and records the run in the audience_sync_jobs ledger. Live
// provider delivery requires resolved credentials and any platform-specific
// approval/driver prerequisites; missing pieces record a failed job with a
// clear error. The endpoint stays 202 so the UI renders the run outcome.
func (d *Deps) Sync(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	ifMatchToken, validIfMatch := optionalAudienceIfMatch(r)
	if !validIfMatch {
		httpcache.WritePreconditionFailed(w)
		return
	}
	claim, err := d.Repo.beginDestinationOperationIfCurrent(r.Context(), t.ID, id, manualOperationKey(r.Header.Get("Idempotency-Key")), ifMatchToken)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	dest := claim.Destination
	if !claim.Created {
		writeJSON(w, http.StatusAccepted, map[string]any{
			"status":      claim.Job.Status,
			"replayed":    true,
			"destination": dest,
			"job":         claim.Job,
		})
		return
	}
	if d.Runner == nil {
		if _, finishErr := d.Repo.finishDestinationOperation(r.Context(), t.ID, claim, RunStatusFailed,
			"audience sync runner is unavailable", 0, 0, false, ProviderRunEvidence{}); finishErr != nil {
			d.writeRepoErr(w, r.Context(), finishErr)
			return
		}
		httperror.Write(w, http.StatusServiceUnavailable, "runner_unavailable",
			"audience sync runner not configured on this server")
		return
	}
	provider := strings.ToLower(strings.TrimSpace(string(dest.Provider)))
	if d.Adapters == nil || d.Adapters[provider] == nil {
		job, jerr := d.Repo.finishDestinationOperation(r.Context(), t.ID, claim, RunStatusFailed,
			"no platform adapter registered for provider "+provider, 0, 0, false, ProviderRunEvidence{})
		if jerr != nil {
			d.writeRepoErr(w, r.Context(), jerr)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{
			"status":      RunStatusFailed,
			"destination": dest,
			"job":         job,
		})
		return
	}

	// Resolve the destination's source members (list XOR segment).
	members, truncated, err := d.Runner.ResolveSourceMembers(r.Context(), t.ID, dest.ListID, dest.SegmentID)
	if err != nil {
		msg := "audience source could not be resolved"
		if errors.Is(err, ErrNotFound) {
			msg = "source list/segment no longer exists"
		}
		job, jerr := d.Repo.finishDestinationOperation(r.Context(), t.ID, claim, RunStatusFailed, msg, 0, 0, false, ProviderRunEvidence{})
		if jerr != nil {
			d.writeRepoErr(w, r.Context(), jerr)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{
			"status": RunStatusFailed, "destination": dest, "job": job,
		})
		return
	}
	sourceObserved := len(members)
	if truncated {
		sourceObserved = SyncMaxRows + 1
		msg := fmt.Sprintf("audience has at least %d members; maximum is %d; no provider request was sent", sourceObserved, SyncMaxRows)
		job, finishErr := d.Repo.finishDestinationOperation(r.Context(), t.ID, claim, RunStatusRejected, msg, 0, sourceObserved, true, ProviderRunEvidence{})
		if finishErr != nil {
			d.writeRepoErr(w, r.Context(), finishErr)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{
			"status":                  RunStatusRejected,
			"source_members_at_least": sourceObserved,
			"members_sent":            0,
			"cap_exceeded":            true,
			"destination":             dest,
			"job":                     job,
		})
		return
	}

	plan := operationAttemptPlan{
		Sequence:       1,
		Kind:           "provider_operation",
		IdempotencyKey: claim.Job.ID + ":provider:1",
		PayloadSHA256:  membersPayloadSHA256(members),
		RowCount:       len(members),
	}
	if err := d.Repo.planJobAttempt(r.Context(), t.ID, claim.Job.ID, plan); err != nil {
		_, _ = d.Repo.finishDestinationOperation(r.Context(), t.ID, claim, RunStatusFailed, "provider operation plan could not be persisted", 0, sourceObserved, false, ProviderRunEvidence{})
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	if err := d.Repo.markJobAttemptDelivering(r.Context(), t.ID, claim.Job.ID, 1); err != nil {
		_, _ = d.Repo.finishDestinationOperation(r.Context(), t.ID, claim, RunStatusFailed, "provider operation attempt could not be claimed", 0, sourceObserved, false, ProviderRunEvidence{})
		d.writeRepoErr(w, r.Context(), err)
		return
	}

	// Read the destination Config (account id, audience id, credential ref)
	// and hand it to the adapter (gap #4).
	cfg := enrichAudienceDestinationConfig(provider, dest.AdapterConfig(), dest.ExternalAudienceID)

	outcome, syncErr := d.Runner.SyncDestinationRow(r.Context(), t.ID, dest, members, cfg)

	status := destinationTerminalStatus(outcome, syncErr, len(members) > 0)
	errMsg := ""
	if syncErr != nil {
		errMsg = syncErr.Error()
	}
	evidence := ProviderRunEvidence{
		ExternalJobID:      outcome.ExternalJobID,
		ExternalAudienceID: outcome.ExternalAudienceID,
		ProviderMessage:    outcome.Message,
	}
	if err := d.Repo.finishJobAttempt(r.Context(), t.ID, claim.Job.ID, 1, syncErr == nil, errMsg); err != nil && syncErr == nil {
		status = RunStatusNeedsReconciliation
		errMsg = "provider acknowledged the request but local attempt evidence could not be finalized"
	}
	job, jerr := d.Repo.finishDestinationOperation(r.Context(), t.ID, claim, status, errMsg, outcome.MembersSent, sourceObserved, false, evidence)
	if jerr != nil {
		d.writeRepoErr(w, r.Context(), jerr)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"status":               status,
		"provider":             outcome.Provider,
		"external_job_id":      outcome.ExternalJobID,
		"external_audience_id": outcome.ExternalAudienceID,
		"provider_message":     outcome.Message,
		"total_members":        outcome.TotalMembers,
		"excluded_count":       outcome.ExcludedCount,
		"members_sent":         outcome.MembersSent,
		"cap_exceeded":         false,
		"destination":          dest,
		"job":                  job,
	})
}

func destinationTerminalStatus(outcome DestinationSyncOutcome, syncErr error, externalEffectPossible bool) string {
	if syncErr == nil {
		return RunStatusSucceeded
	}
	if outcome.MembersSent > 0 {
		return RunStatusPartial
	}
	if externalEffectPossible && !errors.Is(syncErr, ErrAdapterNotConfigured) {
		return RunStatusNeedsReconciliation
	}
	return RunStatusFailed
}

// ListJobs returns the recent sync jobs for a destination.
func (d *Deps) ListJobs(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	jobs, err := d.Repo.ListSyncJobs(r.Context(), t.ID, id, 25)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": jobs})
}

// JobDiagnostics retrieves provider-side status for a persisted sync job.
func (d *Deps) JobDiagnostics(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	destID := chi.URLParam(r, "id")
	jobID := chi.URLParam(r, "job_id")
	dest, err := d.Repo.Get(r.Context(), t.ID, destID)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	job, err := d.Repo.GetSyncJob(r.Context(), t.ID, destID, jobID)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	if strings.TrimSpace(job.ExternalJobID) == "" {
		httperror.Write(w, http.StatusConflict, "diagnostics_unavailable",
			"this sync job does not have a provider request id")
		return
	}
	provider := strings.ToLower(strings.TrimSpace(string(dest.Provider)))
	adapter, ok := d.Adapters[provider]
	if !ok || adapter == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "adapter_unavailable",
			"platform adapter not configured on this server")
		return
	}
	diagnosticsAdapter, ok := adapter.(PlatformDiagnosticsAdapter)
	if !ok {
		httperror.Write(w, http.StatusConflict, "diagnostics_not_supported",
			"this provider does not advertise diagnostics; inspect the persisted sync job instead")
		return
	}
	cfg := enrichAudienceDestinationConfig(provider, dest.AdapterConfig(), dest.ExternalAudienceID)
	hydrated, err := hydrateAdapterConfig(r.Context(), d.CredentialResolver, cfg)
	if err != nil {
		if d.Logger != nil {
			d.Logger.Warn("audience_destination_diagnostics: credential resolution failed", "tenant_id", t.ID, "destination_id", destID, "job_id", jobID, "err", err.Error())
		}
		httperror.Write(w, http.StatusServiceUnavailable, "credential_resolution_failed",
			"unable to resolve the destination credential reference")
		return
	}
	result, err := diagnosticsAdapter.RetrieveDiagnostics(r.Context(), hydrated, ProviderRunEvidence{
		ExternalJobID:      job.ExternalJobID,
		ExternalAudienceID: firstNonEmpty(job.ExternalAudienceID, dest.ExternalAudienceID),
		ProviderMessage:    job.ProviderMessage,
	})
	if err != nil {
		if d.Logger != nil {
			d.Logger.Warn("audience_destination_diagnostics: provider lookup failed", "tenant_id", t.ID, "destination_id", destID, "job_id", jobID, "provider", provider, "err", err.Error())
		}
		httperror.Write(w, http.StatusBadGateway, "provider_diagnostics_failed",
			"provider diagnostics lookup failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"destination": dest,
		"job":         job,
		"diagnostics": result,
	})
}

// writeRepoErr routes repository errors to the correct httperror helper.
//
//   - ErrNotFound is a stable sentinel; emit a fixed 404 with no error text.
//   - ErrInvalidInput is produced by this package's own validation and the
//     attached message is operator-authored, so it's safe to echo verbatim
//     under the "invalid_input" code (allowlisted in httperror).
//   - Everything else is treated as an unknown infrastructure error: log
//     server-side via WriteInternal and return a generic 500 envelope that
//     does NOT leak err.Error() (pgx text, SQL fragments, etc.).
func (d *Deps) writeRepoErr(w http.ResponseWriter, ctx context.Context, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "resource not found")
	case errors.Is(err, ErrInvalidInput):
		httperror.WriteValidation(w, "invalid_input", err.Error())
	case errors.Is(err, ErrOperationInProgress):
		w.Header().Set("Retry-After", "5")
		httperror.Write(w, http.StatusConflict, "audience_operation_in_progress", "an audience operation is already in progress")
	case errors.Is(err, ErrLifecycleBlocked):
		httperror.Write(w, http.StatusConflict, "audience_operation_blocked", "the resource lifecycle state does not allow this operation")
	case errors.Is(err, ErrOperationLeaseLost):
		httperror.Write(w, http.StatusConflict, "audience_operation_lease_lost", "the audience operation lease is no longer owned by this request; refresh operation history")
	case errors.Is(err, ErrPreconditionFailed):
		httpcache.WritePreconditionFailed(w)
	default:
		httperror.WriteInternal(w, d.Logger, err, ctx)
	}
}

// optionalAudienceIfMatch accepts one exact strong validator. Legacy callers
// may omit the header; callers that opt into concurrency must not be silently
// weakened through wildcards, weak tags, or comma lists.
func optionalAudienceIfMatch(r *http.Request) (string, bool) {
	values := r.Header.Values("If-Match")
	if len(values) == 0 {
		return "", true
	}
	if len(values) != 1 {
		return "", false
	}
	raw := strings.TrimSpace(values[0])
	if raw == "" || raw == "*" || strings.HasPrefix(raw, "W/") || strings.Contains(raw, ",") || len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' {
		return "", false
	}
	return raw, true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
