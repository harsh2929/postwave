// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

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
	// SmileBackfiller / LoyaltyLionBackfiller / RivoBackfiller /
	// ReferralCandyBackfiller, when wired, let empty sync/backfill requests pull
	// loyalty members directly from the provider instead of requiring
	// caller-shaped rows.
	SmileBackfiller         LoyaltyBackfiller
	LoyaltyLionBackfiller   LoyaltyBackfiller
	RivoBackfiller          LoyaltyBackfiller
	ReferralCandyBackfiller LoyaltyBackfiller
	FriendbuyBackfiller     LoyaltyBackfiller
	// WebhookSecrets resolves the optional webhook signing secret (via
	// webhook_secret_ref) for the public loyalty webhook ingest endpoint —
	// used by push-only providers (Growave/Marsello/etc.). Optional.
	WebhookSecrets LoyaltyRuntimeSecretResolver
	// NewIngestToken overrides webhook ingest token minting (tests only).
	// Production leaves it nil and uses crypto/rand.
	NewIngestToken func() (string, error)
}

type providerPullMeta struct {
	Provider      string
	Cursor        string
	RetryDeferred bool
}

// providerPull dispatches an empty sync/backfill to a native provider puller.
func (d *Deps) providerPull(ctx context.Context, tenantID string, integration *Integration, cursor string) (SyncRequest, bool, error) {
	if integration == nil {
		return SyncRequest{}, false, nil
	}
	switch integration.Provider {
	case ProviderSmile:
		if d.SmileBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.SmileBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderLoyaltyLion:
		if d.LoyaltyLionBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.LoyaltyLionBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderRivo:
		if d.RivoBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.RivoBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderReferralCandy:
		if d.ReferralCandyBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.ReferralCandyBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderFriendbuy:
		if d.FriendbuyBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.FriendbuyBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
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
	backfiller := loyaltyBackfillerForProvider(d, integration.Provider)
	if backfiller == nil {
		return SyncRequest{}, providerPullMeta{}, false, nil
	}
	retryBaseCursor, effectiveCursor, deferred, err := loyaltyRetryCursorState(integration.Provider, cursor, d.now())
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
		if retryCursor, ok := loyaltyProviderRetryCursor(integration.Provider, retryBaseCursor, "BACKFILL_FAILED", err, d.now()); ok {
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
	return loyaltyProviderRetryCursor(provider, cursor, status, retryErr, now)
}

func (d *Deps) currentLoyaltyIntegrationForSync(ctx context.Context, tenantID string, integration *Integration) (*Integration, error) {
	if d == nil || d.Repo == nil || integration == nil {
		return nil, ErrNotFound
	}
	current, err := d.Repo.GetIntegration(ctx, tenantID, integration.ID)
	if err != nil {
		return nil, err
	}
	if loyaltyIntegrationDisconnected(current) {
		return nil, errIntegrationDisconnected
	}
	return current, nil
}

const loyaltyJSONMaxBodyBytes int64 = 1 << 20

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(admin).Get("/api/v1/loyalty-integrations/providers", d.ListProviders)
	// Webhook-ingest provisioning for push-only desks (Growave/Marsello/…).
	// Registered before the {id} routes; chi matches the static
	// "webhook-ingest" segment ahead of the {id} wildcard.
	r.With(admin).Get("/api/v1/loyalty-integrations/webhook-ingest/providers", d.ListIngestProviders)
	r.With(admin).Get("/api/v1/loyalty-integrations/webhook-ingest", d.ListIngestEndpoints)
	r.With(admin).Post("/api/v1/loyalty-integrations/webhook-ingest", d.ProvisionIngest)
	r.With(admin).Post("/api/v1/loyalty-integrations/webhook-ingest/{id}/rotate", d.RotateIngest)
	r.With(read).Get("/api/v1/loyalty-integrations", d.ListIntegrations)
	r.With(admin).Post("/api/v1/loyalty-integrations", d.CreateIntegration)
	r.With(read).Get("/api/v1/loyalty-integrations/{id}", d.GetIntegration)
	r.With(admin).Post("/api/v1/loyalty-integrations/{id}/sync", d.SyncIntegration)
	r.With(admin).Post("/api/v1/loyalty-integrations/{id}/backfill", d.BackfillIntegration)
	r.With(admin).Post("/api/v1/loyalty-integrations/{id}/ingest", d.IngestEvent)
	r.With(admin).Post("/api/v1/loyalty-integrations/{id}/pause", d.PauseIntegration)
	r.With(admin).Post("/api/v1/loyalty-integrations/{id}/provider-cleanup/acknowledge", d.AcknowledgeProviderCleanup)
	r.With(admin).Delete("/api/v1/loyalty-integrations/{id}", d.DisconnectIntegration)
	r.With(read).Get("/api/v1/loyalty-integrations/{id}/runs", d.ListRuns)
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
	if err := httpbody.DecodeJSON(w, r, loyaltyJSONMaxBodyBytes, &in); err != nil {
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
	if loyaltyIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
		return
	}
	var event LoyaltyEventInput
	if err := httpbody.DecodeJSON(w, r, loyaltyJSONMaxBodyBytes, &event); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	req := normalizeSyncRequest(SyncRequest{
		RunMode: "webhook",
		Events:  []LoyaltyEventInput{event},
	})
	integration, err = d.currentLoyaltyIntegrationForSync(r.Context(), tenantID, integration)
	if err != nil {
		if errors.Is(err, errIntegrationDisconnected) {
			httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
			return
		}
		d.writeRepoError(w, r, tenantID, err)
		return
	}
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
	if loyaltyIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
		return
	}
	var in SyncRequest
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, loyaltyJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
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
	if len(in.Members)+len(in.Events) > d.maxSyncRows() {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "sync payload has too many rows")
		return
	}
	var pullMeta providerPullMeta
	providerPulled := false
	if len(in.Members)+len(in.Events) == 0 {
		pulled, meta, ok, perr := d.providerPullWithRetry(r.Context(), tenantID, integration, in.Cursor)
		if perr != nil {
			httperror.Write(w, http.StatusBadGateway, "provider_sync_failed", httperror.MessageInternal)
			return
		}
		if !ok {
			httperror.Write(w, http.StatusUnprocessableEntity, "payload_required", "loyalty sync/backfill requires canonical members or events; no provider puller is wired for this provider")
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
	integration, err = d.currentLoyaltyIntegrationForSync(r.Context(), tenantID, integration)
	if err != nil {
		if errors.Is(err, errIntegrationDisconnected) {
			httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
			return
		}
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	started := d.now()
	summary := d.executeSync(r.Context(), tenantID, integration, in)
	if providerPulled && loyaltyProviderPulledSyncFailed(in, summary) {
		syncErr := loyaltySyncFailureError(pullMeta.Provider, summary)
		if retryCursor, ok := providerRetryCursor(pullMeta.Provider, pullMeta.Cursor, "SYNC_FAILED", syncErr, d.now()); ok {
			summary.Cursor = retryCursor
			in.Cursor = retryCursor
		}
	}
	completed := d.now()
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
	if loyaltyIntegrationDisconnected(integration) {
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
	if err := httpbody.DecodeJSON(w, r, loyaltyJSONMaxBodyBytes, &in); err != nil {
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
	switch integration.Provider {
	case ProviderSmile:
		return smileDisconnectCleanupEvidence(*integration, recordedAt)
	default:
		if isNativeLoyaltyPullerProvider(integration.Provider) {
			return nativeLoyaltyPullerDisconnectCleanupEvidence(*integration, recordedAt)
		}
		return nil
	}
}

func nativeLoyaltyPullerDisconnectCleanupEvidence(integration Integration, recordedAt time.Time) *DisconnectCleanupEvidence {
	providerName := loyaltyProviderDisplayName(integration.Provider)
	webhookSecretRef := firstString(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
		settingString(integration.Settings, "signing_secret_ref"),
	)
	webhookStatus := "not_configured_in_postwave"
	if webhookSecretRef != "" {
		webhookStatus = "operator_cleanup_required"
	}
	return &DisconnectCleanupEvidence{
		Provider:                integration.Provider,
		Status:                  "operator_action_required",
		RecordedAt:              recordedAt.UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		AccountID:               loyaltyProviderScopeID(integration),
		WebhookSecretRefPresent: webhookSecretRef != "",
		WebhookCleanupStatus:    webhookStatus,
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local loyalty integration is marked disconnected",
			"scheduled " + providerName + " REST pulls exclude disconnected rows",
			"manual " + providerName + " sync and backfill requests reject the disconnected row",
			"loyalty sync and webhook audit history is retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the " + providerName + " API credentials if they are no longer used",
			"remove or disable the Moosewave " + providerName + " webhook target or callback if configured",
			"audit duplicate or manually configured " + providerName + " webhook targets outside Moosewave",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave does not call a " + providerName + " provider-cleanup API on loyalty disconnect",
			providerName + " credential and webhook cleanup remains operator-managed until managed cleanup automation is certified",
		},
	}
}

func loyaltyProviderCleanupEligible(provider string) bool {
	provider = strings.ToLower(strings.TrimSpace(provider))
	return provider == ProviderSmile || isNativeLoyaltyPullerProvider(provider)
}

func loyaltyProviderDisplayName(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case ProviderSmile:
		return "Smile.io"
	case ProviderLoyaltyLion:
		return "LoyaltyLion"
	case ProviderRivo:
		return "Rivo"
	case ProviderReferralCandy:
		return "ReferralCandy"
	case ProviderFriendbuy:
		return "Friendbuy"
	default:
		return strings.TrimSpace(provider)
	}
}

func loyaltyProviderScopeID(integration Integration) string {
	switch integration.Provider {
	case ProviderLoyaltyLion:
		return settingString(integration.Settings, "site_id")
	case ProviderRivo:
		return settingString(integration.Settings, "shop_domain")
	case ProviderReferralCandy:
		return settingString(integration.Settings, "access_id")
	case ProviderFriendbuy:
		return settingString(integration.Settings, "campaign_id")
	default:
		return firstString(settingString(integration.Settings, "account_id"), settingString(integration.Settings, "program_id"), settingString(integration.Settings, "shop_domain"))
	}
}

func smileDisconnectCleanupEvidence(integration Integration, recordedAt time.Time) *DisconnectCleanupEvidence {
	accountID := firstString(
		settingString(integration.Settings, "account_id"),
		settingString(integration.Settings, "smile_account_id"),
	)
	webhookSecretRef := firstString(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "smile_client_secret_ref"),
	)
	webhookStatus := "not_configured_in_postwave"
	if webhookSecretRef != "" && accountID != "" {
		webhookStatus = "operator_cleanup_required"
	} else if webhookSecretRef != "" {
		webhookStatus = "operator_cleanup_required_missing_account_id"
	}
	return &DisconnectCleanupEvidence{
		Provider:                ProviderSmile,
		Status:                  "operator_action_required",
		RecordedAt:              recordedAt.UTC().Format(time.RFC3339),
		PostwaveStatus:          "disconnected",
		ProviderCleanupPosture:  "operator_managed_provider_console",
		ManagedProviderCleanup:  false,
		AccountID:               accountID,
		WebhookSecretRefPresent: webhookSecretRef != "",
		WebhookCleanupStatus:    webhookStatus,
		CredentialCleanupStatus: "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local loyalty integration is marked disconnected",
			"scheduled Smile.io REST pulls exclude disconnected rows",
			"account_id-routed Smile app webhooks no longer resolve this row",
			"loyalty sync and webhook audit history is retained",
		},
		ProviderConsoleActions: []string{
			"revoke or rotate the Smile.io API token if it is no longer used",
			"remove or disable the Moosewave Smile app webhook target/authorization for this account when app webhooks were enabled",
			"rotate the Smile app client secret if it was dedicated to this Moosewave install",
			"audit duplicate or manually configured Smile app webhook targets outside Moosewave",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave does not call a Smile webhook-management API on disconnect",
			"Smile app webhook cleanup remains operator-managed until live provider cleanup automation is certified",
		},
	}
}

func normalizeProviderCleanupAcknowledgementInput(in ProviderCleanupAcknowledgementInput) (ProviderCleanupAcknowledgementInput, error) {
	out := ProviderCleanupAcknowledgementInput{
		Notes:          loyaltyTruncate(strings.TrimSpace(in.Notes), 2000),
		AcknowledgedBy: loyaltyTruncate(strings.TrimSpace(in.AcknowledgedBy), 200),
	}
	seen := map[string]bool{}
	for _, action := range in.CompletedActions {
		action = loyaltyTruncate(strings.ToLower(strings.TrimSpace(action)), 200)
		if action == "" {
			continue
		}
		if !loyaltyProviderCleanupActionKeys[action] {
			return ProviderCleanupAcknowledgementInput{}, errors.New("completed_actions contains unsupported loyalty cleanup action key")
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

var loyaltyProviderCleanupActionKeys = map[string]bool{
	"api_token_revoked_or_rotated":                    true,
	"provider_api_credentials_rotated":                true,
	"provider_webhook_target_or_subscription_removed": true,
	"app_webhook_target_removed_or_disabled":          true,
	"app_client_secret_rotated_if_dedicated":          true,
	"duplicate_or_manual_provider_webhooks_audited":   true,
	"duplicate_or_manual_webhook_targets_audited":     true,
	"provider_console_cleanup_reviewed_no_action_due": true,
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
	_, actorLabel := middleware.ActorFromContext(ctx)
	if strings.TrimSpace(actorLabel) != "" {
		return strings.TrimSpace(actorLabel)
	}
	return fallback
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
		IntegrationID: integration.ID,
		Status:        "completed",
		MembersSeen:   len(in.Members),
		EventsSeen:    len(in.Events),
		Cursor:        in.Cursor,
	}
	for _, member := range in.Members {
		if d.Profiles == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "profile sink unavailable"
			continue
		}
		if _, err := d.Profiles.UpsertLoyaltyMember(ctx, tenantID, integration.Provider, member); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.MembersUpserted++
	}
	for _, event := range in.Events {
		if d.Events == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "event sink unavailable"
			continue
		}
		if _, err := d.Events.TrackLoyaltyEvent(ctx, tenantID, integration.Provider, event); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.EventsTracked++
	}
	if summary.RowsFailed > 0 && summary.MembersUpserted == 0 && summary.EventsTracked == 0 {
		summary.Status = "failed"
	}
	if summary.Cursor == "" {
		summary.Cursor = "loyalty-sync-" + strconv.FormatInt(d.now().Unix(), 10)
	}
	return summary
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "loyalty integration not found")
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
