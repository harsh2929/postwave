// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"context"
	"encoding/json"
	"errors"
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
	ProvisionIngestIntegration(context.Context, string, IngestProvisionInput, string) (*Integration, error)
	RotateIngestToken(context.Context, string, string, string) (*Integration, error)
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
	Repo        Store
	Profiles    ProfileSink
	Events      EventSink
	Logger      *slog.Logger
	Now         func() time.Time
	MaxSyncRows int
	// RechargeBackfiller / AfterShipBackfiller / ShipStationBackfiller /
	// SkioBackfiller, when wired, let empty sync/backfill requests pull
	// subscriptions/shipments directly from the provider instead of requiring
	// caller-shaped rows.
	RechargeBackfiller          RechargeBackfiller
	AfterShipBackfiller         AfterShipBackfiller
	ShipStationBackfiller       ShipStationBackfiller
	SkioBackfiller              SkioBackfiller
	ChargebeeBackfiller         ChargebeeBackfiller
	LoopSubscriptionsBackfiller LoopSubscriptionsBackfiller
	SealBackfiller              SealBackfiller
	AppstleBackfiller           AppstleBackfiller
	BoldBackfiller              BoldBackfiller
	// WebhookSecrets resolves the optional webhook signing secret (via
	// webhook_secret_ref) for the public subscription webhook ingest endpoint —
	// used by push-only providers (Ordergroove/Wonderment/etc.). Optional; when
	// nil, the per-integration URL token is the sole auth.
	WebhookSecrets SubscriptionRuntimeSecretResolver
	// NewIngestToken overrides webhook ingest token minting (tests only).
	// Production leaves it nil and uses crypto/rand.
	NewIngestToken func() (string, error)
}

type providerPullMeta struct {
	Provider      string
	Cursor        string
	RetryDeferred bool
}

const subscriptionJSONMaxBodyBytes int64 = 1 << 20

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(admin).Get("/api/v1/subscription-integrations/providers", d.ListProviders)
	// Webhook-ingest provisioning for push-only desks (Ordergroove/Wonderment/…).
	// Registered before the {id} routes; chi matches the static "webhook-ingest"
	// segment ahead of the {id} wildcard.
	r.With(admin).Get("/api/v1/subscription-integrations/webhook-ingest/providers", d.ListIngestProviders)
	r.With(admin).Get("/api/v1/subscription-integrations/webhook-ingest", d.ListIngestEndpoints)
	r.With(admin).Post("/api/v1/subscription-integrations/webhook-ingest", d.ProvisionIngest)
	r.With(admin).Post("/api/v1/subscription-integrations/webhook-ingest/{id}/rotate", d.RotateIngest)
	r.With(read).Get("/api/v1/subscription-integrations", d.ListIntegrations)
	r.With(admin).Post("/api/v1/subscription-integrations", d.CreateIntegration)
	r.With(read).Get("/api/v1/subscription-integrations/{id}", d.GetIntegration)
	r.With(admin).Post("/api/v1/subscription-integrations/{id}/sync", d.SyncIntegration)
	r.With(admin).Post("/api/v1/subscription-integrations/{id}/backfill", d.BackfillIntegration)
	r.With(admin).Post("/api/v1/subscription-integrations/{id}/ingest", d.IngestEvent)
	r.With(admin).Post("/api/v1/subscription-integrations/{id}/pause", d.PauseIntegration)
	r.With(admin).Post("/api/v1/subscription-integrations/{id}/provider-cleanup/acknowledge", d.AcknowledgeProviderCleanup)
	r.With(admin).Delete("/api/v1/subscription-integrations/{id}", d.DisconnectIntegration)
	r.With(read).Get("/api/v1/subscription-integrations/{id}/runs", d.ListRuns)
}

func (d *Deps) ListProviders(w http.ResponseWriter, r *http.Request) {
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
	for i := range out {
		out[i] = redactIngestToken(out[i])
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
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
	redacted := redactIngestToken(*out)
	writeJSON(w, http.StatusOK, redacted)
}

func (d *Deps) CreateIntegration(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in IntegrationInput
	if err := httpbody.DecodeJSON(w, r, subscriptionJSONMaxBodyBytes, &in); err != nil {
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
	out, err := d.Repo.UpsertIntegration(r.Context(), tenantID, normalized)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	// Klaviyo-style: import the provider's trailing history immediately on
	// connect (background, bounded). No-op for non-puller providers / opt-out.
	writeJSON(w, http.StatusCreated, out)
	d.maybeBackfillOnConnect(out)
}

func (d *Deps) SyncIntegration(w http.ResponseWriter, r *http.Request) {
	d.sync(w, r, "")
}

func (d *Deps) BackfillIntegration(w http.ResponseWriter, r *http.Request) {
	d.sync(w, r, "backfill")
}

func (d *Deps) IngestEvent(w http.ResponseWriter, r *http.Request) {
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
	if subscriptionIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
		return
	}
	var event LifecycleEventInput
	if err := httpbody.DecodeJSON(w, r, subscriptionJSONMaxBodyBytes, &event); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	req := normalizeSyncRequest(SyncRequest{
		RunMode: "webhook",
		Events:  []LifecycleEventInput{event},
	})
	started := d.now()
	summary := d.executeSync(r.Context(), tenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), tenantID, id, summary, req, started, completed)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	summary.RunID = run.ID
	writeJSON(w, http.StatusAccepted, summary)
}

// providerPull dispatches an empty sync/backfill to a native provider puller.
// Returns ok=false when no puller is wired for the integration's provider.
func (d *Deps) providerPull(ctx context.Context, tenantID string, integration *Integration, cursor string) (SyncRequest, bool, error) {
	if integration == nil {
		return SyncRequest{}, false, nil
	}
	switch integration.Provider {
	case ProviderRecharge:
		if d.RechargeBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.RechargeBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderAfterShip:
		if d.AfterShipBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.AfterShipBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderShipStation:
		if d.ShipStationBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.ShipStationBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderSkio:
		if d.SkioBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.SkioBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderChargebee:
		if d.ChargebeeBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.ChargebeeBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderLoopSubscriptions:
		if d.LoopSubscriptionsBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.LoopSubscriptionsBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderSealSubscriptions:
		if d.SealBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.SealBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderAppstle:
		if d.AppstleBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.AppstleBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderBoldSubscriptions:
		if d.BoldBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.BoldBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	default:
		return SyncRequest{}, false, nil
	}
}

func (d *Deps) providerPullWithRetry(ctx context.Context, tenantID string, integration *Integration, cursor string) (SyncRequest, providerPullMeta, bool, error) {
	if integration == nil {
		return SyncRequest{}, providerPullMeta{}, false, nil
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	meta := providerPullMeta{Provider: integration.Provider, Cursor: cursor}
	backfiller := subscriptionBackfillerForProvider(d, integration.Provider)
	if backfiller == nil {
		return SyncRequest{}, providerPullMeta{}, false, nil
	}
	retryBaseCursor, effectiveCursor, deferred, err := subscriptionRetryCursorState(integration.Provider, cursor, d.now())
	if err != nil {
		return SyncRequest{}, meta, true, err
	}
	if deferred {
		meta.RetryDeferred = true
		return SyncRequest{RunMode: "backfill", Cursor: strings.TrimSpace(cursor)}, meta, true, nil
	}
	meta.Cursor = retryBaseCursor
	req, err := backfiller.BackfillPage(ctx, tenantID, *integration, effectiveCursor)
	if err != nil {
		if retryCursor, ok := subscriptionProviderRetryCursor(integration.Provider, retryBaseCursor, "BACKFILL_FAILED", err, d.now()); ok {
			_ = d.recordProviderFailure(ctx, tenantID, integration.ID, retryCursor, err)
		}
		return SyncRequest{}, meta, true, err
	}
	return req, meta, true, nil
}

func (d *Deps) recordProviderFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
	started := d.now()
	completed := d.now()
	req := normalizeSyncRequest(SyncRequest{RunMode: "backfill", Cursor: cursor})
	summary := SyncSummary{
		IntegrationID: integrationID,
		Status:        "failed",
		Cursor:        cursor,
		ErrorMessage:  syncErr.Error(),
	}
	_, err := d.Repo.RecordSyncRun(ctx, tenantID, integrationID, summary, req, started, completed)
	return err
}

func providerRetryCursor(provider, cursor, status string, retryErr error, now time.Time) (string, bool) {
	return subscriptionProviderRetryCursor(provider, cursor, status, retryErr, now)
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
	if subscriptionIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
		return
	}
	var in SyncRequest
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, subscriptionJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
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
	if len(in.Subscriptions)+len(in.Shipments)+len(in.Events) > d.maxSyncRows() {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "sync payload has too many rows")
		return
	}
	var pullMeta providerPullMeta
	providerPulled := false
	if len(in.Subscriptions)+len(in.Shipments)+len(in.Events) == 0 {
		pulled, meta, ok, perr := d.providerPullWithRetry(r.Context(), tenantID, integration, in.Cursor)
		if perr != nil {
			httperror.Write(w, http.StatusBadGateway, "provider_sync_failed", httperror.MessageInternal)
			return
		}
		if !ok {
			httperror.Write(w, http.StatusUnprocessableEntity, "payload_required", "subscription sync/backfill requires canonical subscriptions, shipments, or events; no provider puller is wired for this provider")
			return
		}
		pullMeta = meta
		providerPulled = true
		if meta.RetryDeferred {
			writeJSON(w, http.StatusAccepted, SyncSummary{IntegrationID: id, Cursor: pulled.Cursor})
			return
		}
		in = normalizeSyncRequest(pulled)
		if forcedMode != "" {
			in.RunMode = forcedMode
		}
	}
	started := d.now()
	summary := d.executeSync(r.Context(), tenantID, integration, in)
	completed := d.now()
	if providerPulled && subscriptionProviderPulledSyncFailed(in, summary) {
		syncErr := subscriptionSyncFailureError(pullMeta.Provider, summary)
		if retryCursor, ok := providerRetryCursor(pullMeta.Provider, pullMeta.Cursor, "SYNC_FAILED", syncErr, d.now()); ok {
			summary.Cursor = retryCursor
			in.Cursor = retryCursor
		}
	}
	run, err := d.Repo.RecordSyncRun(r.Context(), tenantID, id, summary, in, started, completed)
	if err != nil {
		if providerPulled {
			if retryCursor, ok := providerRetryCursor(pullMeta.Provider, pullMeta.Cursor, "SYNC_FAILED", err, d.now()); ok {
				_ = d.recordProviderFailure(r.Context(), tenantID, id, retryCursor, err)
			}
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	summary.RunID = run.ID
	writeJSON(w, http.StatusAccepted, summary)
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
	if subscriptionIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
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
	if err := httpbody.DecodeJSON(w, r, subscriptionJSONMaxBodyBytes, &in); err != nil {
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
	redacted := redactIngestToken(*out)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"provider_cleanup": redacted.Settings["provider_cleanup"],
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
	cleanup := disconnectCleanupEvidence(integration, d.now())
	if cleanup != nil {
		if recorder, ok := d.Repo.(providerCleanupDisconnectStore); ok {
			err = recorder.DisconnectIntegrationWithProviderCleanup(r.Context(), tenantID, id, cleanup)
		} else {
			err = d.Repo.DisconnectIntegration(r.Context(), tenantID, id)
		}
	} else {
		err = d.Repo.DisconnectIntegration(r.Context(), tenantID, id)
	}
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	out := map[string]any{"ok": true}
	if cleanup != nil {
		out["provider_cleanup"] = cleanup
	}
	writeJSON(w, http.StatusOK, out)
}

func disconnectCleanupEvidence(integration *Integration, recordedAt time.Time) *DisconnectCleanupEvidence {
	if integration == nil {
		return nil
	}
	spec, ok := ProviderSpecByKey(integration.Provider)
	if !ok {
		return nil
	}
	provider := strings.TrimSpace(integration.Provider)
	providerName := strings.TrimSpace(spec.Name)
	if providerName == "" {
		providerName = provider
	}
	webhookSecretRef := firstString(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, provider+"_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
		settingString(integration.Settings, "signing_secret_ref"),
	)
	ingestTokenPresent := settingString(integration.Settings, subscriptionIngestTokenSetting) != ""
	providerWebhookID := firstString(
		settingString(integration.Settings, "provider_webhook_id"),
		settingString(integration.Settings, provider+"_webhook_id"),
		settingString(integration.Settings, "webhook_id"),
	)
	webhookStatus := "not_configured_in_postwave"
	if webhookSecretRef != "" || ingestTokenPresent || providerWebhookID != "" {
		webhookStatus = "operator_cleanup_required"
	}
	scopeType, scopeID := subscriptionProviderCleanupScope(*integration)
	postwaveEffects := []string{
		"local subscription integration is marked disconnected",
		"scheduled " + providerName + " provider pulls exclude disconnected rows",
		"subscription sync and webhook audit history is retained",
	}
	if ingestTokenPresent {
		postwaveEffects = append(postwaveEffects, "tokenized "+providerName+" webhook ingest no longer resolves this row")
	}
	return &DisconnectCleanupEvidence{
		Provider:                    provider,
		Status:                      "operator_action_required",
		RecordedAt:                  recordedAt.UTC().Format(time.RFC3339),
		PostwaveStatus:              "disconnected",
		ProviderCleanupPosture:      "operator_managed_provider_console",
		ManagedProviderCleanup:      false,
		ProviderScopeType:           scopeType,
		ProviderScopeID:             scopeID,
		ProviderWebhookID:           providerWebhookID,
		CredentialRefPresent:        strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent:     webhookSecretRef != "",
		TokenizedIngestTokenPresent: ingestTokenPresent,
		WebhookCleanupStatus:        webhookStatus,
		CredentialCleanupStatus:     "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects:             postwaveEffects,
		ProviderConsoleActions: []string{
			"revoke or rotate the " + providerName + " API token if it is no longer used",
			"delete or disable the Moosewave " + providerName + " webhook target or subscription if configured",
			"remove tokenized Moosewave subscription ingest URLs from " + providerName + " if push delivery was configured",
			"audit duplicate or manually configured " + providerName + " webhook targets outside Moosewave",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave does not call a " + providerName + " provider-cleanup API on subscription disconnect",
			providerName + " API-token and webhook cleanup remains operator-managed until managed cleanup automation is certified",
		},
	}
}

func subscriptionProviderCleanupScope(integration Integration) (string, string) {
	provider := strings.TrimSpace(integration.Provider)
	switch provider {
	case ProviderChargebee:
		return "chargebee_site", firstString(
			settingString(integration.Settings, "site_id"),
			settingString(integration.Settings, "site"),
			settingString(integration.Settings, "api_base_url"),
		)
	case ProviderBoldSubscriptions:
		return "bold_store", firstString(
			settingString(integration.Settings, "shop_identifier"),
			settingString(integration.Settings, "shop"),
			settingString(integration.Settings, "store_domain"),
		)
	default:
		return provider + "_store", firstString(
			settingString(integration.Settings, "store_domain"),
			settingString(integration.Settings, "shop_domain"),
			settingString(integration.Settings, "myshopify_domain"),
			settingString(integration.Settings, "account_id"),
			settingString(integration.Settings, "merchant_id"),
		)
	}
}

func normalizeProviderCleanupAcknowledgementInput(in ProviderCleanupAcknowledgementInput) (ProviderCleanupAcknowledgementInput, error) {
	out := ProviderCleanupAcknowledgementInput{
		Notes:          rechargeTruncate(strings.TrimSpace(in.Notes), 2000),
		AcknowledgedBy: rechargeTruncate(strings.TrimSpace(in.AcknowledgedBy), 200),
	}
	seen := map[string]bool{}
	for _, action := range in.CompletedActions {
		action = rechargeTruncate(strings.ToLower(strings.TrimSpace(action)), 200)
		if action == "" {
			continue
		}
		if !subscriptionProviderCleanupActionKeys[action] {
			return ProviderCleanupAcknowledgementInput{}, errors.New("completed_actions contains unsupported subscription cleanup action key")
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

var subscriptionProviderCleanupActionKeys = map[string]bool{
	"api_token_revoked_or_rotated":                       true,
	"webhook_target_or_subscription_removed_or_disabled": true,
	"tokenized_ingest_urls_removed":                      true,
	"duplicate_or_manual_webhook_targets_audited":        true,
	"provider_console_cleanup_reviewed_no_action_due":    true,
}

func providerCleanupAcknowledgedBy(ctx context.Context, fallback string) string {
	if u, ok := middleware.UserFromContext(ctx); ok && u != nil {
		if strings.TrimSpace(u.Email) != "" {
			return strings.TrimSpace(u.Email)
		}
		if strings.TrimSpace(u.ID) != "" {
			return strings.TrimSpace(u.ID)
		}
	}
	return strings.TrimSpace(fallback)
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

func (d *Deps) executeSync(ctx context.Context, tenantID string, integration *Integration, in SyncRequest) SyncSummary {
	summary := SyncSummary{
		IntegrationID:     integration.ID,
		Status:            "completed",
		SubscriptionsSeen: len(in.Subscriptions),
		ShipmentsSeen:     len(in.Shipments),
		EventsSeen:        len(in.Events),
		Cursor:            in.Cursor,
	}
	for _, subscription := range in.Subscriptions {
		if d.Profiles == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "profile sink unavailable"
			continue
		}
		if _, err := d.Profiles.UpsertSubscription(ctx, tenantID, integration.Provider, subscription); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.SubscriptionsUpserted++
		if d.Events != nil {
			if _, err := d.Events.TrackLifecycleEvent(ctx, tenantID, integration.Provider, subscriptionEvent(subscription)); err != nil {
				summary.RowsFailed++
				summary.Status = "partial"
				summary.ErrorMessage = err.Error()
				continue
			}
			summary.EventsTracked++
		}
	}
	for _, shipment := range in.Shipments {
		if d.Profiles == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "profile sink unavailable"
			continue
		}
		if _, err := d.Profiles.UpsertShipment(ctx, tenantID, integration.Provider, shipment); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.ShipmentsUpserted++
		if d.Events != nil {
			if _, err := d.Events.TrackLifecycleEvent(ctx, tenantID, integration.Provider, shipmentEvent(shipment)); err != nil {
				summary.RowsFailed++
				summary.Status = "partial"
				summary.ErrorMessage = err.Error()
				continue
			}
			summary.EventsTracked++
		}
	}
	for _, event := range in.Events {
		if d.Events == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "event sink unavailable"
			continue
		}
		if _, err := d.Events.TrackLifecycleEvent(ctx, tenantID, integration.Provider, event); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.EventsTracked++
	}
	if summary.RowsFailed > 0 &&
		summary.SubscriptionsUpserted == 0 &&
		summary.ShipmentsUpserted == 0 &&
		summary.EventsTracked == 0 {
		summary.Status = "failed"
	}
	if summary.Cursor == "" {
		summary.Cursor = "subscription-sync-" + strconv.FormatInt(d.now().Unix(), 10)
	}
	return summary
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "subscription integration not found")
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

func (d *Deps) maxSyncRows() int {
	if d != nil && d.MaxSyncRows > 0 {
		return d.MaxSyncRows
	}
	return 1000
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
