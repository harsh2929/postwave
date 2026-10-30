// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type Store interface {
	ListIntegrations(context.Context, string) ([]Integration, error)
	GetIntegration(context.Context, string, string) (*Integration, error)
	UpsertIntegration(context.Context, string, IntegrationInput) (*Integration, error)
	PauseIntegration(context.Context, string, string) (*Integration, error)
	DisconnectIntegration(context.Context, string, string) error
	RecordSyncRun(context.Context, string, string, SyncSummary, SyncRequest, time.Time, time.Time) (*SyncRun, error)
	ListRuns(context.Context, string, string, int) ([]SyncRun, error)
}

type providerCleanupDisconnectStore interface {
	DisconnectIntegrationWithProviderCleanup(context.Context, string, string, *DisconnectCleanupEvidence) error
}

type providerCleanupAcknowledgementStore interface {
	AcknowledgeProviderCleanup(context.Context, string, string, ProviderCleanupAcknowledgementInput, time.Time) (*Integration, error)
}

type Deps struct {
	Repo               Store
	KlaviyoPuller      KlaviyoProviderPuller
	KlaviyoCredentials KlaviyoCredentialResolver
	KlaviyoWebhooks    KlaviyoWebhookRegistrar
	KlaviyoOAuth       KlaviyoOAuthConfig
	KlaviyoOAuthClient KlaviyoOAuthClient
	WebhookSecrets     KlaviyoWebhookSecretResolver
	PublicBaseURL      string
	Logger             *slog.Logger
	Now                func() time.Time
	MaxSyncRows        int
}

const marketingJSONMaxBodyBytes int64 = 1 << 20

const (
	klaviyoDelegatedHandoffCursorPrefix  = "klaviyo_handoff:"
	klaviyoDelegatedHandoffCursorVersion = 1
	klaviyoDefaultAPIRevision            = "2026-04-15"
)

type providerHandoffRuntime struct {
	DelegatedTo                string
	CursorType                 string
	DefaultRevision            string
	BackfillEndpoint           string
	SourceEventsEndpoint       string
	SourceEventsStatusEndpoint string
	SupportsSourceEvents       bool
}

type delegatedHandoffCursor struct {
	Version                    int    `json:"version"`
	Provider                   string `json:"provider"`
	CursorType                 string `json:"cursor_type"`
	RunMode                    string `json:"run_mode,omitempty"`
	DelegatedTo                string `json:"delegated_to"`
	MigrationJobID             string `json:"migration_job_id,omitempty"`
	ImportCursor               string `json:"import_cursor,omitempty"`
	ImportHighWatermark        string `json:"import_high_watermark,omitempty"`
	SourceEventJobID           string `json:"source_event_job_id,omitempty"`
	SourceEventCursor          string `json:"source_event_cursor,omitempty"`
	SourceEventHighWatermark   string `json:"source_event_high_watermark,omitempty"`
	Revision                   string `json:"revision,omitempty"`
	PollIntervalSeconds        int    `json:"poll_interval_seconds,omitempty"`
	Attempt                    int    `json:"attempt,omitempty"`
	PreviousCursor             string `json:"previous_cursor,omitempty"`
	GeneratedAt                string `json:"generated_at,omitempty"`
	BackfillEndpoint           string `json:"backfill_endpoint,omitempty"`
	SourceEventsEndpoint       string `json:"source_events_endpoint,omitempty"`
	SourceEventsStatusEndpoint string `json:"source_events_status_endpoint,omitempty"`
}

type klaviyoDelegatedHandoffCursor = delegatedHandoffCursor

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(admin).Get("/api/v1/marketing-integrations/providers", d.ListProviders)
	r.With(read).Get("/api/v1/marketing-integrations", d.ListIntegrations)
	r.With(admin).Post("/api/v1/marketing-integrations", d.CreateIntegration)
	r.With(read).Get("/api/v1/marketing-integrations/{id}", d.GetIntegration)
	r.With(admin).Post("/api/v1/marketing-integrations/{id}/sync", d.SyncIntegration)
	r.With(admin).Post("/api/v1/marketing-integrations/{id}/backfill", d.BackfillIntegration)
	r.With(admin).Post("/api/v1/marketing-integrations/{id}/pause", d.PauseIntegration)
	r.With(admin).Delete("/api/v1/marketing-integrations/{id}", d.DisconnectIntegration)
	r.With(admin).Post("/api/v1/marketing-integrations/{id}/provider-cleanup/acknowledge", d.AcknowledgeProviderCleanup)
	r.With(read).Get("/api/v1/marketing-integrations/{id}/runs", d.ListRuns)
	r.With(read).Get("/api/v1/marketing-integrations/klaviyo/oauth/availability", d.KlaviyoOAuthAvailability)
	r.With(admin).Get("/api/v1/marketing-integrations/klaviyo/oauth/start", d.KlaviyoOAuthStart)
	r.Get("/api/v1/marketing-integrations/klaviyo/oauth/callback", d.KlaviyoOAuthCallback)
}

func MountPublicRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Post("/api/public/marketing-integrations/klaviyo/webhooks/{token}", d.KlaviyoWebhook)
}

func (d *Deps) ListProviders(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"items": ProviderSpecs()})
}

func (d *Deps) ListIntegrations(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListIntegrations(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": filterListableMarketingIntegrations(out)})
}

func (d *Deps) GetIntegration(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.GetIntegration(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateIntegration(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in IntegrationInput
	if err := httpbody.DecodeJSON(w, r, marketingJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	normalized, _, err := normalizeIntegrationInput(in)
	if err != nil {
		if errors.Is(err, errRawCredentialSetting) {
			httperror.Write(w, http.StatusUnprocessableEntity, "raw_credentials_rejected", err.Error())
			return
		}
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	var createRollbacks []marketingCreateRollback
	if normalized.Provider == ProviderKlaviyo && wantsManagedKlaviyoWebhook(normalized.Settings) {
		registrar := d.klaviyoWebhookRegistrar()
		if registrar == nil {
			httperror.Write(w, http.StatusServiceUnavailable, "webhook_registration_unavailable", "klaviyo webhook registration is not configured")
			return
		}
		existing := d.existingIntegrationByProviderName(r.Context(), tenantID, normalized.Provider, normalized.Name)
		if existing != nil {
			merged := cloneMap(existing.Settings)
			for key, value := range normalized.Settings {
				merged[key] = value
			}
			normalized.Settings = merged
		}
		delete(normalized.Settings, "provider_cleanup")
		summary, err := registrar.ReconcileWebhook(r.Context(), Integration{
			TenantID:       tenantID,
			Provider:       ProviderKlaviyo,
			Name:           normalized.Name,
			Status:         normalized.Status,
			Scopes:         normalized.Scopes,
			CredentialsRef: normalized.CredentialsRef,
			Settings:       normalized.Settings,
		}, d.publicBaseURL(r))
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "webhook_registration_failed", httperror.MessageInternal)
			return
		}
		applyKlaviyoWebhookReconcileSummary(normalized.Settings, summary)
		if existing == nil && summary.Created {
			createRollbacks = append(createRollbacks, marketingCreateRollback{integration: Integration{
				TenantID:       tenantID,
				Provider:       ProviderKlaviyo,
				Name:           normalized.Name,
				Status:         normalized.Status,
				Scopes:         normalized.Scopes,
				CredentialsRef: normalized.CredentialsRef,
				Settings:       cloneMap(normalized.Settings),
			}})
		}
	}
	delete(normalized.Settings, "provider_cleanup")
	out, err := d.Repo.UpsertIntegration(r.Context(), tenantID, normalized)
	if err != nil {
		d.rollbackMarketingCreateResources(r.Context(), tenantID, normalized.Name, d.publicBaseURL(r), createRollbacks)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

type marketingCreateRollback struct {
	integration Integration
}

func (d *Deps) rollbackMarketingCreateResources(ctx context.Context, tenantID, name, appBaseURL string, rollbacks []marketingCreateRollback) {
	for _, rollback := range rollbacks {
		var err error
		switch rollback.integration.Provider {
		case ProviderKlaviyo:
			if registrar := d.klaviyoWebhookRegistrar(); registrar != nil {
				_, err = registrar.CleanupWebhook(ctx, rollback.integration, appBaseURL)
			}
		}
		if err != nil && d.Logger != nil {
			d.Logger.Warn("rollback marketing provider resource after integration persistence failure failed",
				"tenant_id", tenantID,
				"provider", rollback.integration.Provider,
				"name", name,
				"error", err)
		}
	}
}

func (d *Deps) SyncIntegration(w http.ResponseWriter, r *http.Request) {
	d.sync(w, r, "")
}

func (d *Deps) BackfillIntegration(w http.ResponseWriter, r *http.Request) {
	d.sync(w, r, "backfill")
}

func (d *Deps) sync(w http.ResponseWriter, r *http.Request, forcedMode string) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	integration, err := d.Repo.GetIntegration(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	if marketingIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", "marketing integration is disconnected; reconnect it before syncing")
		return
	}
	var in SyncRequest
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, marketingJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	in = normalizeSyncRequest(in)
	if forcedMode != "" {
		in.RunMode = forcedMode
	}
	if !allowedRunMode(in.RunMode) {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "run_mode must be manual, scheduled, backfill, retry, dry_run, or webhook")
		return
	}
	summary, err := d.executeAndRecordSync(r.Context(), tenantID, id, integration, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) executeAndRecordSync(ctx context.Context, tenantID, id string, integration *Integration, in SyncRequest) (SyncSummary, error) {
	started := d.now()
	summary := d.executeSync(ctx, tenantID, integration, in)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(ctx, tenantID, id, summary, in, started, completed)
	if err != nil {
		return SyncSummary{}, err
	}
	summary.RunID = run.ID
	return summary, nil
}

func (d *Deps) executeSync(ctx context.Context, tenantID string, integration *Integration, in SyncRequest) SyncSummary {
	if integration != nil && integration.Provider == ProviderKlaviyo {
		if puller := d.klaviyoProviderPuller(); puller != nil {
			summary, err := puller.Pull(ctx, tenantID, *integration, in, d.maxSyncRows())
			if err != nil {
				return d.failedNativeSyncSummary(integration, in, err)
			}
			return summary
		}
	}
	return d.executeDelegatedSync(integration, in)
}

func (d *Deps) failedNativeSyncSummary(integration *Integration, in SyncRequest, err error) SyncSummary {
	spec, _ := specAndRuntimeForIntegration(integration)
	metadata := cloneMap(in.Metadata)
	metadata["provider"] = spec.Provider
	metadata["sync_model"] = spec.SyncModel
	metadata["verification_mode"] = spec.VerificationMode
	metadata["native_provider_row"] = true
	metadata["native_provider_pull_failed"] = true
	return SyncSummary{
		IntegrationID: integration.ID,
		Status:        "failed",
		RowsFailed:    1,
		Cursor:        firstString(in.Cursor, integration.SyncCursor),
		ErrorMessage:  err.Error(),
		Metadata:      metadata,
	}
}

func (d *Deps) klaviyoProviderPuller() KlaviyoProviderPuller {
	if d == nil {
		return nil
	}
	return d.KlaviyoPuller
}

func (d *Deps) klaviyoWebhookRegistrar() KlaviyoWebhookRegistrar {
	if d == nil {
		return nil
	}
	return d.KlaviyoWebhooks
}

func (d *Deps) maxSyncRows() int {
	if d != nil && d.MaxSyncRows > 0 {
		return d.MaxSyncRows
	}
	return 100
}

func (d *Deps) executeDelegatedSync(integration *Integration, in SyncRequest) SyncSummary {
	spec, runtime := specAndRuntimeForIntegration(integration)
	cursor, handoff := d.buildDelegatedHandoffCursor(integration, in)
	metadata := cloneMap(in.Metadata)
	metadata["provider"] = spec.Provider
	metadata["sync_model"] = spec.SyncModel
	metadata["verification_mode"] = spec.VerificationMode
	metadata["delegated_to"] = runtime.DelegatedTo
	metadata["native_provider_row"] = true
	metadata["provider_row_retry_cursor"] = true
	metadata["handoff_cursor_prefix"] = strings.TrimSuffix(handoffCursorPrefixForProvider(spec.Provider), ":")
	metadata["delegated_handoff"] = handoff.metadata()
	return SyncSummary{
		IntegrationID: integration.ID,
		Status:        "partial",
		Cursor:        cursor,
		ErrorMessage:  partialRunMessageForProvider(spec, runtime),
		Metadata:      metadata,
	}
}

func (d *Deps) PauseIntegration(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	integration, err := d.Repo.GetIntegration(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	if marketingIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", "marketing integration is disconnected; reconnect it before pausing")
		return
	}
	out, err := d.Repo.PauseIntegration(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) AcknowledgeProviderCleanup(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	store, ok := d.Repo.(providerCleanupAcknowledgementStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "provider_cleanup_unavailable", "provider cleanup acknowledgement is not configured")
		return
	}
	var in ProviderCleanupAcknowledgementInput
	if err := httpbody.DecodeJSON(w, r, marketingJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.AcknowledgedBy = providerCleanupAcknowledgedBy(r.Context(), in.AcknowledgedBy)
	normalized, err := normalizeProviderCleanupAcknowledgementInput(in)
	if err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	out, err := store.AcknowledgeProviderCleanup(r.Context(), tenantID, chi.URLParam(r, "id"), normalized, d.now())
	if err != nil {
		if errors.Is(err, ErrProviderCleanupMissing) {
			httperror.Write(w, http.StatusConflict, "provider_cleanup_missing", "provider cleanup evidence has not been recorded for this integration")
			return
		}
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"provider_cleanup": out.Settings["provider_cleanup"],
	})
}

func (d *Deps) DisconnectIntegration(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	integration, err := d.Repo.GetIntegration(r.Context(), tenantID, id)
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	if marketingIntegrationDisconnected(integration) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "provider_cleanup": cleanupFromSettings(integration.Settings)})
		return
	}
	cleanup := marketingDisconnectCleanupEvidence(integration, d.now())
	if integration != nil &&
		integration.Provider == ProviderKlaviyo &&
		hasManagedKlaviyoWebhook(*integration) {
		if registrar := d.klaviyoWebhookRegistrar(); registrar != nil {
			summary, err := registrar.CleanupWebhook(r.Context(), *integration, d.publicBaseURL(r))
			if err != nil {
				httperror.Write(w, http.StatusBadGateway, "webhook_cleanup_failed", httperror.MessageInternal)
				return
			}
			cleanup = klaviyoDisconnectCleanupEvidence(*integration, summary)
		}
	}
	var klaviyoOAuthRevocation KlaviyoOAuthRevocationSummary
	if integration != nil && integration.Provider == ProviderKlaviyo && klaviyoIsStoredCredentialRef(klaviyoCredentialRef(*integration)) {
		klaviyoOAuthRevocation, err = d.revokeKlaviyoOAuthOnDisconnect(r.Context(), tenantID, *integration)
		if err != nil {
			httperror.Write(w, http.StatusBadGateway, "klaviyo_oauth_revoke_failed", httperror.MessageInternal)
			return
		}
		cleanup = applyKlaviyoOAuthRevocationToCleanup(cleanup, klaviyoOAuthRevocation)
	}
	if recorder, ok := d.Repo.(providerCleanupDisconnectStore); ok {
		err = recorder.DisconnectIntegrationWithProviderCleanup(r.Context(), tenantID, id, cleanup)
	} else {
		err = d.Repo.DisconnectIntegration(r.Context(), tenantID, id)
	}
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	if integration != nil && integration.Provider == ProviderKlaviyo && klaviyoIsStoredCredentialRef(klaviyoCredentialRef(*integration)) {
		if deleter := d.klaviyoCredentialDeleter(); deleter != nil {
			if err := deleter.DeleteKlaviyoCredentialSecret(r.Context(), tenantID, klaviyoCredentialRef(*integration)); err != nil {
				httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
				return
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "provider_cleanup": cleanup})
}

func (d *Deps) ListRuns(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListRuns(r.Context(), tenantID, chi.URLParam(r, "id"), queryInt(r, "limit", 25))
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func marketingDisconnectCleanupEvidence(integration *Integration, recordedAt time.Time) *DisconnectCleanupEvidence {
	spec, _ := specAndRuntimeForIntegration(integration)
	credentialRefPresent := integration != nil && strings.TrimSpace(integration.CredentialsRef) != ""
	providerName := spec.Name
	providerKey := spec.Provider
	return &DisconnectCleanupEvidence{
		Provider:                providerKey,
		Status:                  "operator_action_required",
		RecordedAt:              recordedAt.UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		CredentialRefPresent:    credentialRefPresent,
		CredentialCleanupStatus: "operator_revoke_or_rotate_" + providerKey + "_credential_if_no_longer_used",
		WebhookCleanupStatus:    marketingWebhookCleanupStatus(integration),
		PostwaveEffects: []string{
			"local marketing integration is marked disconnected",
			"manual " + providerName + " native foundation sync/backfill rejects disconnected rows",
			"marketing sync run history and delegated migration evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the " + providerName + " credential if it was dedicated to this Moosewave install",
			"stop any temporary " + providerName + " migration or source-event job that should no longer run",
			"audit the " + providerName + " account for duplicate or manually configured Moosewave connections",
			"review provider-side webhook subscription and writeback cleanup once those runtimes are certified",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave does not call " + providerName + " credential revocation or provider-side cleanup APIs in this partial foundation",
			providerName + " provider-side cleanup remains operator-managed until live cleanup automation is certified",
		},
	}
}

func marketingWebhookCleanupStatus(integration *Integration) string {
	if integration == nil || integration.Provider != ProviderKlaviyo {
		return "native_webhook_subscription_not_configured"
	}
	if hasManagedKlaviyoWebhook(*integration) {
		return "postwave_managed_klaviyo_system_webhook_cleanup_ready"
	}
	if settingString(integration.Settings, "klaviyo_webhook_token") != "" ||
		settingString(integration.Settings, "webhook_token") != "" ||
		settingString(integration.Settings, "marketing_webhook_token") != "" ||
		settingString(integration.Settings, "klaviyo_webhook_id") != "" {
		return "operator_review_klaviyo_system_webhook_subscription"
	}
	return "native_webhook_receiver_not_configured"
}

func wantsManagedKlaviyoWebhook(settings map[string]any) bool {
	if truthySetting(settings, "klaviyo_webhook_managed_by_postwave") ||
		truthySetting(settings, "klaviyo_webhook_provision") ||
		truthySetting(settings, "webhook_managed_by_postwave") {
		return true
	}
	return len(klaviyoWebhookConfiguredTopics(Integration{Provider: ProviderKlaviyo, Settings: settings})) > 0
}

func hasManagedKlaviyoWebhook(integration Integration) bool {
	settings := integration.Settings
	for _, key := range []string{"klaviyo_webhook_id", "klaviyo_webhook_endpoint", "klaviyo_webhook_reconciled_at"} {
		if strings.TrimSpace(settingString(settings, key)) != "" {
			return true
		}
	}
	return truthySetting(settings, "klaviyo_webhook_managed_by_postwave") ||
		truthySetting(settings, "webhook_managed_by_postwave")
}

func applyKlaviyoWebhookReconcileSummary(settings map[string]any, summary KlaviyoWebhookReconcileSummary) {
	if settings == nil {
		return
	}
	settings["klaviyo_webhook_id"] = summary.WebhookID
	if summary.WebhookToken != "" {
		settings["klaviyo_webhook_token"] = summary.WebhookToken
	}
	settings["klaviyo_webhook_endpoint"] = summary.Endpoint
	settings["klaviyo_webhook_topics"] = append([]string(nil), summary.Topics...)
	settings["klaviyo_webhook_managed_by_postwave"] = true
	settings["klaviyo_webhook_created"] = summary.Created
	settings["klaviyo_webhook_reused"] = summary.Reused
	settings["klaviyo_webhook_updated"] = summary.Updated
	settings["klaviyo_webhook_repaired"] = summary.Repaired
	settings["klaviyo_webhook_verified"] = summary.Verified
	if summary.Name != "" {
		settings["klaviyo_webhook_name"] = summary.Name
	}
	if !summary.RegisteredAt.IsZero() {
		settings["klaviyo_webhook_registered_at"] = summary.RegisteredAt.UTC().Format(time.RFC3339)
		settings["klaviyo_webhook_reconciled_at"] = summary.RegisteredAt.UTC().Format(time.RFC3339)
	}
	if !summary.VerifiedAt.IsZero() {
		settings["klaviyo_webhook_verified_at"] = summary.VerifiedAt.UTC().Format(time.RFC3339)
	}
	if summary.RepairReason != "" {
		settings["klaviyo_webhook_repair_reason"] = summary.RepairReason
	} else {
		delete(settings, "klaviyo_webhook_repair_reason")
	}
	if summary.PreviousWebhookID != "" {
		settings["klaviyo_webhook_previous_id"] = summary.PreviousWebhookID
	} else {
		delete(settings, "klaviyo_webhook_previous_id")
	}
}

func klaviyoDisconnectCleanupEvidence(integration Integration, summary KlaviyoWebhookCleanupSummary) *DisconnectCleanupEvidence {
	recordedAt := summary.CleanedUpAt
	if recordedAt.IsZero() {
		recordedAt = time.Now().UTC()
	}
	return &DisconnectCleanupEvidence{
		Provider:                ProviderKlaviyo,
		Status:                  marketingCleanupStatus(summary.Deleted, summary.NotFound, summary.Skipped),
		RecordedAt:              recordedAt.UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "postwave_managed_provider_api",
		ManagedProviderCleanup:  true,
		CleanupKind:             "system_webhook",
		ProviderScopeType:       "klaviyo_account_id",
		ProviderScopeID:         firstString(settingString(integration.Settings, "account_id"), settingString(integration.Settings, "klaviyo_account_id")),
		ProviderWebhookID:       summary.WebhookID,
		Endpoint:                summary.Endpoint,
		Deleted:                 summary.Deleted,
		NotFound:                summary.NotFound,
		Skipped:                 summary.Skipped,
		SkipReason:              summary.SkipReason,
		CleanupReason:           summary.CleanupReason,
		Topics:                  append([]string(nil), summary.Topics...),
		CredentialRefPresent:    strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent: firstString(settingString(integration.Settings, "klaviyo_webhook_secret_ref"), settingString(integration.Settings, "webhook_secret_ref")) != "",
		CredentialCleanupStatus: "operator_revoke_or_rotate_klaviyo_credential_if_no_longer_used",
		WebhookCleanupStatus:    marketingManagedWebhookCleanupStatus(summary.Deleted, summary.NotFound, summary.Skipped),
		PostwaveEffects: []string{
			"local marketing integration is marked disconnected",
			"manual Klaviyo native foundation sync/backfill rejects disconnected rows",
			"token-routed Klaviyo webhook resolution excludes disconnected rows",
			"marketing sync run, webhook delivery, and source-event evidence are retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Klaviyo private API key if it was dedicated to this Moosewave install",
			"audit duplicate or manually configured Klaviyo system webhooks outside the Moosewave-managed subscription",
			"rotate Klaviyo webhook signing secrets if shared with other integrations",
			"review provider-side writeback cleanup once that runtime is certified",
		},
		ProviderCleanupEvidence: marketingManagedWebhookCleanupEvidence(summary),
	}
}

func applyKlaviyoOAuthRevocationToCleanup(cleanup *DisconnectCleanupEvidence, summary KlaviyoOAuthRevocationSummary) *DisconnectCleanupEvidence {
	if cleanup == nil {
		cleanup = &DisconnectCleanupEvidence{
			Provider:               ProviderKlaviyo,
			Status:                 "operator_action_required",
			PostwaveStatus:         "disconnected",
			ProviderCleanupPosture: "operator_managed_provider_console",
		}
	}
	if summary.RevokedAccess || summary.RevokedRefresh {
		cleanup.CredentialCleanupStatus = "postwave_managed_klaviyo_oauth_revoked"
		cleanup.ManagedProviderCleanup = true
		if cleanup.ProviderCleanupPosture == "operator_managed_provider_console" {
			cleanup.ProviderCleanupPosture = "postwave_managed_provider_api"
		}
		if cleanup.CleanupKind == "" {
			cleanup.CleanupKind = "oauth_token"
		} else if !strings.Contains(cleanup.CleanupKind, "oauth_token") {
			cleanup.CleanupKind += "+oauth_token"
		}
		cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence, "Moosewave called the Klaviyo OAuth revoke endpoint before deleting the local credential envelope")
		if summary.RevokedAccess {
			cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence, "Klaviyo OAuth access token revocation completed")
		}
		if summary.RevokedRefresh {
			cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence, "Klaviyo OAuth refresh token revocation completed")
		}
		return cleanup
	}
	if summary.Skipped {
		cleanup.CredentialCleanupStatus = "klaviyo_oauth_revocation_skipped_" + summary.Reason
		cleanup.ProviderCleanupEvidence = append(cleanup.ProviderCleanupEvidence, "Klaviyo OAuth revocation skipped: "+summary.Reason)
	}
	return cleanup
}

func marketingCleanupStatus(deleted, notFound, skipped bool) string {
	switch {
	case skipped:
		return "provider_cleanup_skipped"
	case deleted:
		return "provider_cleanup_completed"
	case notFound:
		return "provider_cleanup_already_absent"
	default:
		return "provider_cleanup_noop"
	}
}

func marketingManagedWebhookCleanupStatus(deleted, notFound, skipped bool) string {
	switch {
	case skipped:
		return "provider_cleanup_skipped"
	case deleted:
		return "provider_deleted"
	case notFound:
		return "provider_already_absent"
	default:
		return "provider_cleanup_not_required_or_missing_evidence"
	}
}

func marketingManagedWebhookCleanupEvidence(summary KlaviyoWebhookCleanupSummary) []string {
	action := "Moosewave called the Klaviyo Webhooks API before disconnect"
	switch {
	case summary.Skipped:
		return []string{action, "provider cleanup did not run to completion: " + summary.SkipReason}
	case summary.Deleted:
		return []string{action, "provider reported the managed system webhook cleanup completed"}
	case summary.NotFound:
		return []string{action, "provider reported the managed system webhook was already absent"}
	default:
		return []string{action, "provider cleanup completed without a deletion confirmation"}
	}
}

func normalizeProviderCleanupAcknowledgementInput(in ProviderCleanupAcknowledgementInput) (ProviderCleanupAcknowledgementInput, error) {
	out := ProviderCleanupAcknowledgementInput{
		Notes:          marketingTruncate(strings.TrimSpace(in.Notes), 2000),
		AcknowledgedBy: marketingTruncate(strings.TrimSpace(in.AcknowledgedBy), 200),
	}
	seen := map[string]bool{}
	for _, action := range in.CompletedActions {
		action = marketingTruncate(strings.ToLower(strings.TrimSpace(action)), 200)
		if action == "" {
			continue
		}
		if !klaviyoProviderCleanupActionKeys[action] {
			return ProviderCleanupAcknowledgementInput{}, errors.New("completed_actions contains unsupported Klaviyo cleanup action key")
		}
		if seen[action] {
			continue
		}
		seen[action] = true
		out.CompletedActions = append(out.CompletedActions, action)
		if len(out.CompletedActions) >= 20 {
			break
		}
	}
	if len(out.CompletedActions) == 0 && out.Notes == "" {
		return ProviderCleanupAcknowledgementInput{}, errors.New("completed_actions or notes is required")
	}
	return out, nil
}

var klaviyoProviderCleanupActionKeys = map[string]bool{
	"private_api_key_revoked_or_rotated":              true,
	"managed_oauth_revocation_reviewed":               true,
	"managed_webhook_cleanup_reviewed":                true,
	"manual_or_duplicate_webhooks_audited":            true,
	"writeback_targets_or_list_memberships_reviewed":  true,
	"provider_console_cleanup_reviewed_no_action_due": true,
}

func providerCleanupAcknowledgedBy(ctx context.Context, fallback string) string {
	if u, ok := middleware.UserFromContext(ctx); ok && u != nil {
		return firstString(u.Email, u.ID, fallback)
	}
	return fallback
}

func marketingTruncate(value string, max int) string {
	if max <= 0 || len(value) <= max {
		return value
	}
	return value[:max]
}

func cleanupFromSettings(settings map[string]any) any {
	if settings == nil {
		return nil
	}
	return settings["provider_cleanup"]
}

func filterListableMarketingIntegrations(items []Integration) []Integration {
	out := make([]Integration, 0, len(items))
	for _, item := range items {
		if marketingIntegrationDisconnected(&item) {
			continue
		}
		out = append(out, item)
	}
	return out
}

func normalizeSyncRequest(in SyncRequest) SyncRequest {
	in.RunMode = strings.ToLower(strings.TrimSpace(firstString(in.RunMode, "manual")))
	in.Cursor = strings.TrimSpace(in.Cursor)
	in.Metadata = cloneMap(in.Metadata)
	return in
}

func marketingIntegrationDisconnected(integration *Integration) bool {
	return integration != nil && strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected")
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "marketing integration not found")
		return
	}
	httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
}

func (d *Deps) now() time.Time {
	if d != nil && d.Now != nil {
		return d.Now().UTC()
	}
	return time.Now().UTC()
}

func (d *Deps) publicBaseURL(r *http.Request) string {
	if d != nil && strings.TrimSpace(d.PublicBaseURL) != "" {
		return strings.TrimRight(strings.TrimSpace(d.PublicBaseURL), "/")
	}
	if r == nil {
		return ""
	}
	host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = strings.TrimSpace(r.Host)
	}
	if host == "" {
		return ""
	}
	proto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
	if proto == "" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	return strings.TrimRight(proto+"://"+host, "/")
}

func (d *Deps) existingIntegrationByProviderName(ctx context.Context, tenantID, provider, name string) *Integration {
	if d == nil || d.Repo == nil {
		return nil
	}
	items, err := d.Repo.ListIntegrations(ctx, tenantID)
	if err != nil {
		return nil
	}
	provider = strings.TrimSpace(provider)
	name = strings.TrimSpace(name)
	for _, item := range items {
		if item.Provider == provider && item.Name == name && !marketingIntegrationDisconnected(&item) {
			copy := item
			return &copy
		}
	}
	return nil
}

func tenantID(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t.ID == "" {
		return "", false
	}
	return t.ID, true
}

func allowedRunMode(value string) bool {
	switch value {
	case "manual", "scheduled", "backfill", "retry", "dry_run", "webhook":
		return true
	default:
		return false
	}
}

func specAndRuntimeForIntegration(integration *Integration) (ProviderSpec, providerHandoffRuntime) {
	provider := ProviderKlaviyo
	if integration != nil && strings.TrimSpace(integration.Provider) != "" {
		provider = integration.Provider
	}
	spec, ok := ProviderSpecByKey(provider)
	if !ok {
		spec, _ = ProviderSpecByKey(ProviderKlaviyo)
	}
	return spec, handoffRuntimeForProvider(spec.Provider)
}

func handoffRuntimeForProvider(provider string) providerHandoffRuntime {
	provider = strings.ToLower(strings.TrimSpace(provider))
	runtime := providerHandoffRuntime{
		DelegatedTo:      delegatedDataPlaneForProvider(provider),
		CursorType:       "delegated_import_handoff",
		BackfillEndpoint: "POST /api/v1/migrations/" + provider + "/commit",
	}
	switch provider {
	case ProviderKlaviyo:
		runtime.CursorType = "delegated_source_event_handoff"
		runtime.DefaultRevision = klaviyoDefaultAPIRevision
		runtime.SourceEventsEndpoint = "POST /api/v1/migrations/sources/klaviyo/source-events"
		runtime.SourceEventsStatusEndpoint = "GET /api/v1/migrations/{job_id}/source-events"
		runtime.SupportsSourceEvents = true
	case ProviderActiveCampaign:
		runtime.CursorType = "delegated_source_event_handoff"
		runtime.SourceEventsEndpoint = "POST /api/v1/migrations/sources/activecampaign/source-events"
		runtime.SourceEventsStatusEndpoint = "GET /api/v1/migrations/{job_id}/source-events"
		runtime.SupportsSourceEvents = true
	}
	return runtime
}

func handoffCursorPrefixForProvider(provider string) string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "" {
		provider = ProviderKlaviyo
	}
	return provider + "_handoff:"
}

func partialRunMessageForProvider(spec ProviderSpec, runtime providerHandoffRuntime) string {
	if spec.Provider == ProviderKlaviyo {
		return spec.Name + " native provider-row lifecycle is attached; public-app OAuth availability/start/callback stores managed marketing:klaviyo credential refs with refresh/revoke support, API-backed import and changed-record polling use native provider-row pulls when configured, signed webhook receipt records marketing_webhook_events when token/secret refs are configured, allowlisted Webhooks API credentials can reconcile provider-side system-webhook subscriptions, Klaviyo writeback targets update existing profiles/list membership/events without creating profiles, and delegated fallback handoff/retry cursor evidence is recorded when the native puller is unavailable. Broader managed cleanup automation and live account certification remain future work."
	}
	if runtime.SupportsSourceEvents {
		return spec.Name + " native provider-row lifecycle is attached; API-backed import and changed-record polling remain delegated to the migration/source-event adapter, with provider-row handoff/retry cursor evidence recorded. OAuth app install, native webhooks, writeback, managed cleanup automation, and live account certification remain future work."
	}
	return spec.Name + " native provider-row lifecycle is attached; API-backed import and source-archive evidence remain delegated to the migration adapter, with provider-row handoff/retry cursor evidence recorded. Incremental source-event polling, native webhooks, writeback, managed cleanup automation, and live account certification remain future work."
}

func (d *Deps) buildDelegatedHandoffCursor(integration *Integration, in SyncRequest) (string, delegatedHandoffCursor) {
	spec, runtime := specAndRuntimeForIntegration(integration)
	settings := map[string]any{}
	previousRaw := ""
	if integration != nil {
		settings = integration.Settings
		previousRaw = strings.TrimSpace(integration.SyncCursor)
	}
	requestedRaw := strings.TrimSpace(in.Cursor)
	metadata := cloneMap(in.Metadata)
	state := delegatedHandoffCursor{
		Version:                    klaviyoDelegatedHandoffCursorVersion,
		Provider:                   spec.Provider,
		CursorType:                 runtime.CursorType,
		RunMode:                    in.RunMode,
		DelegatedTo:                runtime.DelegatedTo,
		Revision:                   runtime.DefaultRevision,
		Attempt:                    1,
		GeneratedAt:                d.now().Format(time.RFC3339),
		BackfillEndpoint:           runtime.BackfillEndpoint,
		SourceEventsEndpoint:       runtime.SourceEventsEndpoint,
		SourceEventsStatusEndpoint: runtime.SourceEventsStatusEndpoint,
	}
	if previous, ok := decodeDelegatedHandoffCursor(previousRaw, spec.Provider); ok {
		mergeDelegatedHandoff(&state, previous, false)
		state.Attempt = positiveInt(previous.Attempt, state.Attempt)
		if previous.SourceEventCursor != "" {
			state.PreviousCursor = previous.SourceEventCursor
		} else if previous.ImportCursor != "" {
			state.PreviousCursor = previous.ImportCursor
		}
	} else if previousRaw != "" {
		state.PreviousCursor = truncateCursorEvidence(previousRaw)
	}

	applyHandoffSettings(&state, settings, spec.Provider, true)
	if requested, ok := decodeDelegatedHandoffCursor(requestedRaw, spec.Provider); ok {
		mergeDelegatedHandoff(&state, requested, true)
		state.Attempt = positiveInt(requested.Attempt, state.Attempt)
	} else if requestedRaw != "" {
		if state.PreviousCursor == "" && previousRaw != "" && previousRaw != requestedRaw {
			state.PreviousCursor = truncateCursorEvidence(previousRaw)
		}
		if runtime.SupportsSourceEvents {
			state.SourceEventCursor = requestedRaw
		} else {
			state.ImportCursor = requestedRaw
		}
	}
	applyHandoffMetadata(&state, metadata, spec.Provider, true)
	if in.RunMode == "retry" {
		state.Attempt++
	} else if state.Attempt <= 0 {
		state.Attempt = 1
	}
	if state.RunMode == "" {
		state.RunMode = "manual"
	}
	return encodeDelegatedHandoffCursor(state), state
}

func (d *Deps) buildKlaviyoDelegatedHandoffCursor(integration *Integration, in SyncRequest) (string, klaviyoDelegatedHandoffCursor) {
	return d.buildDelegatedHandoffCursor(integration, in)
}

func applyHandoffSettings(state *delegatedHandoffCursor, settings map[string]any, provider string, overwrite bool) {
	if state == nil {
		return
	}
	setHandoffString(&state.MigrationJobID, settingString(settings, "migration_job_id"), overwrite)
	setHandoffString(&state.ImportCursor, settingString(settings, "import_cursor"), overwrite)
	setHandoffString(&state.ImportHighWatermark, settingString(settings, "import_high_watermark"), overwrite)
	setHandoffString(&state.SourceEventJobID, settingString(settings, "source_event_job_id"), overwrite)
	setHandoffString(&state.SourceEventCursor, settingString(settings, "source_event_cursor"), overwrite)
	setHandoffString(&state.SourceEventHighWatermark, settingString(settings, "source_event_high_watermark"), overwrite)
	setHandoffString(&state.Revision, firstString(settingString(settings, "revision"), settingString(settings, "api_revision")), overwrite)
	setHandoffInt(&state.PollIntervalSeconds, anyInt(settings["poll_interval_seconds"]), overwrite)
	providerPrefix := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(provider)), "-", "_")
	if providerPrefix != "" {
		setHandoffString(&state.MigrationJobID, settingString(settings, providerPrefix+"_migration_job_id"), overwrite)
		setHandoffString(&state.ImportCursor, settingString(settings, providerPrefix+"_import_cursor"), overwrite)
		setHandoffString(&state.SourceEventJobID, settingString(settings, providerPrefix+"_source_event_job_id"), overwrite)
		setHandoffString(&state.SourceEventCursor, settingString(settings, providerPrefix+"_source_event_cursor"), overwrite)
		setHandoffString(&state.SourceEventHighWatermark, settingString(settings, providerPrefix+"_source_event_high_watermark"), overwrite)
	}
}

func applyHandoffMetadata(state *delegatedHandoffCursor, metadata map[string]any, provider string, overwrite bool) {
	if state == nil {
		return
	}
	providerPrefix := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(provider)), "-", "_")
	setHandoffString(&state.MigrationJobID, firstString(anyString(metadata["migration_job_id"]), anyString(metadata[providerPrefix+"_migration_job_id"])), overwrite)
	setHandoffString(&state.ImportCursor, firstString(anyString(metadata["import_cursor"]), anyString(metadata[providerPrefix+"_import_cursor"])), overwrite)
	setHandoffString(&state.ImportHighWatermark, firstString(anyString(metadata["import_high_watermark"]), anyString(metadata["high_watermark"]), anyString(metadata[providerPrefix+"_import_high_watermark"])), overwrite)
	setHandoffString(&state.SourceEventJobID, firstString(anyString(metadata["source_event_job_id"]), anyString(metadata[providerPrefix+"_source_event_job_id"])), overwrite)
	setHandoffString(&state.SourceEventCursor, firstString(anyString(metadata["source_event_cursor"]), anyString(metadata[providerPrefix+"_source_event_cursor"])), overwrite)
	setHandoffString(&state.SourceEventHighWatermark, firstString(anyString(metadata["source_event_high_watermark"]), anyString(metadata[providerPrefix+"_source_event_high_watermark"])), overwrite)
	setHandoffString(&state.Revision, firstString(anyString(metadata["revision"]), anyString(metadata["api_revision"])), overwrite)
	setHandoffInt(&state.PollIntervalSeconds, anyInt(metadata["poll_interval_seconds"]), overwrite)
}

func mergeDelegatedHandoff(dst *delegatedHandoffCursor, src delegatedHandoffCursor, overwrite bool) {
	if dst == nil {
		return
	}
	setHandoffString(&dst.MigrationJobID, src.MigrationJobID, overwrite)
	setHandoffString(&dst.ImportCursor, src.ImportCursor, overwrite)
	setHandoffString(&dst.ImportHighWatermark, src.ImportHighWatermark, overwrite)
	setHandoffString(&dst.SourceEventJobID, src.SourceEventJobID, overwrite)
	setHandoffString(&dst.SourceEventCursor, src.SourceEventCursor, overwrite)
	setHandoffString(&dst.SourceEventHighWatermark, src.SourceEventHighWatermark, overwrite)
	setHandoffString(&dst.Revision, src.Revision, overwrite)
	setHandoffString(&dst.PreviousCursor, src.PreviousCursor, overwrite)
	setHandoffInt(&dst.PollIntervalSeconds, src.PollIntervalSeconds, overwrite)
	setHandoffInt(&dst.Attempt, src.Attempt, overwrite)
}

func setHandoffString(dst *string, value string, overwrite bool) {
	if dst == nil {
		return
	}
	value = strings.TrimSpace(value)
	if value == "" || (!overwrite && strings.TrimSpace(*dst) != "") {
		return
	}
	*dst = value
}

func setHandoffInt(dst *int, value int, overwrite bool) {
	if dst == nil || value <= 0 || (!overwrite && *dst > 0) {
		return
	}
	*dst = value
}

func encodeDelegatedHandoffCursor(state delegatedHandoffCursor) string {
	raw, _ := json.Marshal(state)
	return handoffCursorPrefixForProvider(state.Provider) + base64.RawURLEncoding.EncodeToString(raw)
}

func encodeKlaviyoDelegatedHandoffCursor(state klaviyoDelegatedHandoffCursor) string {
	if strings.TrimSpace(state.Provider) == "" {
		state.Provider = ProviderKlaviyo
	}
	return encodeDelegatedHandoffCursor(state)
}

func decodeDelegatedHandoffCursor(raw, provider string) (delegatedHandoffCursor, bool) {
	raw = strings.TrimSpace(raw)
	prefix := handoffCursorPrefixForProvider(provider)
	if !strings.HasPrefix(raw, prefix) {
		return delegatedHandoffCursor{}, false
	}
	payload := strings.TrimPrefix(raw, prefix)
	decoded, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return delegatedHandoffCursor{}, false
	}
	var out delegatedHandoffCursor
	if err := json.Unmarshal(decoded, &out); err != nil {
		return delegatedHandoffCursor{}, false
	}
	if out.Provider != "" && out.Provider != strings.ToLower(strings.TrimSpace(provider)) {
		return delegatedHandoffCursor{}, false
	}
	return out, true
}

func decodeKlaviyoDelegatedHandoffCursor(raw string) (klaviyoDelegatedHandoffCursor, bool) {
	return decodeDelegatedHandoffCursor(raw, ProviderKlaviyo)
}

func (state delegatedHandoffCursor) metadata() map[string]any {
	raw, _ := json.Marshal(state)
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	return out
}

func truncateCursorEvidence(value string) string {
	const maxCursorEvidenceBytes = 256
	value = strings.TrimSpace(value)
	if len(value) <= maxCursorEvidenceBytes {
		return value
	}
	return value[:maxCursorEvidenceBytes]
}

func positiveInt(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func queryInt(r *http.Request, key string, fallback int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback
	}
	out, err := strconv.Atoi(raw)
	if err != nil || out <= 0 {
		return fallback
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func firstString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func settingString(settings map[string]any, key string) string {
	if settings == nil {
		return ""
	}
	return anyString(settings[key])
}

func anyString(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(v)
	case fmt.Stringer:
		return strings.TrimSpace(v.String())
	default:
		return strings.TrimSpace(fmt.Sprint(value))
	}
}

func anyInt(value any) int {
	switch v := value.(type) {
	case nil:
		return 0
	case int:
		return v
	case int8:
		return int(v)
	case int16:
		return int(v)
	case int32:
		return int(v)
	case int64:
		return int(v)
	case uint:
		return int(v)
	case uint8:
		return int(v)
	case uint16:
		return int(v)
	case uint32:
		return int(v)
	case uint64:
		return int(v)
	case float32:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		out, err := strconv.Atoi(v.String())
		if err == nil {
			return out
		}
	case string:
		out, err := strconv.Atoi(strings.TrimSpace(v))
		if err == nil {
			return out
		}
	}
	return 0
}

func truthySetting(settings map[string]any, key string) bool {
	if settings == nil {
		return false
	}
	switch v := settings[key].(type) {
	case bool:
		return v
	case string:
		value := strings.TrimSpace(v)
		return strings.EqualFold(value, "true") ||
			strings.EqualFold(value, "yes") ||
			value == "1"
	default:
		return false
	}
}

func cloneMap(in map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range in {
		out[key] = value
	}
	return out
}
