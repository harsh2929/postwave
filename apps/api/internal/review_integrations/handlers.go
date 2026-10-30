// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

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
	Reviews     ReviewSink
	Profiles    ProfileSink
	Events      EventSink
	Products    ReviewProductResolver
	Logger      *slog.Logger
	Now         func() time.Time
	MaxSyncRows int
	// JudgeMeBackfiller / YotpoBackfiller / OkendoBackfiller / LooxBackfiller /
	// TrustpilotBackfiller, when wired, let empty sync/backfill requests pull
	// reviews directly from the provider instead of requiring caller-shaped rows.
	JudgeMeBackfiller      ReviewBackfiller
	YotpoBackfiller        ReviewBackfiller
	OkendoBackfiller       ReviewBackfiller
	LooxBackfiller         ReviewBackfiller
	TrustpilotBackfiller   ReviewBackfiller
	StampedBackfiller      ReviewBackfiller
	ReviewsIOBackfiller    ReviewBackfiller
	BazaarvoiceBackfiller  ReviewBackfiller
	PowerReviewsBackfiller ReviewBackfiller
	// WebhookSecrets resolves the optional webhook signing secret (via
	// webhook_secret_ref) for the public review webhook ingest endpoint — used
	// by webhook-ingest desks. Optional; a nil resolver skips verification.
	WebhookSecrets ReviewRuntimeSecretResolver
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
	case ProviderJudgeMe:
		if d.JudgeMeBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.JudgeMeBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderYotpo:
		if d.YotpoBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.YotpoBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderOkendo:
		if d.OkendoBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.OkendoBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderLoox:
		if d.LooxBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.LooxBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderTrustpilot:
		if d.TrustpilotBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.TrustpilotBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderStamped:
		if d.StampedBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.StampedBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderReviewsIO:
		if d.ReviewsIOBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.ReviewsIOBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderBazaarvoice:
		if d.BazaarvoiceBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.BazaarvoiceBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderPowerReviews:
		if d.PowerReviewsBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.PowerReviewsBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
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
	backfiller := reviewBackfillerForProvider(d, integration.Provider)
	if backfiller == nil {
		return SyncRequest{}, providerPullMeta{}, false, nil
	}
	retryBaseCursor, effectiveCursor, deferred, err := reviewRetryCursorState(integration.Provider, cursor, d.now())
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
		if retryCursor, ok := reviewProviderRetryCursor(integration.Provider, retryBaseCursor, "BACKFILL_FAILED", err, d.now()); ok {
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
	return reviewProviderRetryCursor(provider, cursor, status, retryErr, now)
}

func (d *Deps) currentReviewIntegrationForSync(ctx context.Context, tenantID string, integration *Integration) (*Integration, error) {
	if d == nil || d.Repo == nil || integration == nil {
		return nil, ErrNotFound
	}
	current, err := d.Repo.GetIntegration(ctx, tenantID, integration.ID)
	if err != nil {
		return nil, err
	}
	if reviewIntegrationDisconnected(current) {
		return nil, errIntegrationDisconnected
	}
	return current, nil
}

const reviewJSONMaxBodyBytes int64 = 1 << 20

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(admin).Get("/api/v1/review-integrations/providers", d.ListProviders)
	// Webhook-ingest provisioning for push-only desks. Registered before the
	// {id} routes; chi matches the static "webhook-ingest" segment ahead of the
	// {id} wildcard.
	r.With(admin).Get("/api/v1/review-integrations/webhook-ingest/providers", d.ListIngestProviders)
	r.With(admin).Get("/api/v1/review-integrations/webhook-ingest", d.ListIngestEndpoints)
	r.With(admin).Post("/api/v1/review-integrations/webhook-ingest", d.ProvisionIngest)
	r.With(admin).Post("/api/v1/review-integrations/webhook-ingest/{id}/rotate", d.RotateIngest)
	r.With(read).Get("/api/v1/review-integrations", d.ListIntegrations)
	r.With(admin).Post("/api/v1/review-integrations", d.CreateIntegration)
	r.With(read).Get("/api/v1/review-integrations/{id}", d.GetIntegration)
	r.With(admin).Post("/api/v1/review-integrations/{id}/sync", d.SyncIntegration)
	r.With(admin).Post("/api/v1/review-integrations/{id}/backfill", d.BackfillIntegration)
	r.With(admin).Post("/api/v1/review-integrations/{id}/ingest", d.IngestReview)
	r.With(admin).Post("/api/v1/review-integrations/{id}/pause", d.PauseIntegration)
	r.With(admin).Post("/api/v1/review-integrations/{id}/provider-cleanup/acknowledge", d.AcknowledgeProviderCleanup)
	r.With(admin).Delete("/api/v1/review-integrations/{id}", d.DisconnectIntegration)
	r.With(read).Get("/api/v1/review-integrations/{id}/runs", d.ListRuns)
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
	if err := httpbody.DecodeJSON(w, r, reviewJSONMaxBodyBytes, &in); err != nil {
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

func (d *Deps) IngestReview(w http.ResponseWriter, r *http.Request) {
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
	if reviewIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
		return
	}
	var review ReviewInput
	if err := httpbody.DecodeJSON(w, r, reviewJSONMaxBodyBytes, &review); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	req := normalizeSyncRequest(SyncRequest{
		RunMode: "webhook",
		Reviews: []ReviewInput{review},
	})
	integration, err = d.currentReviewIntegrationForSync(r.Context(), tenantID, integration)
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
	if reviewIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", errIntegrationDisconnected.Error())
		return
	}
	var in SyncRequest
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, reviewJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
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
	if len(in.Reviews) > d.maxSyncRows() {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "sync payload has too many rows")
		return
	}
	var pullMeta providerPullMeta
	providerPulled := false
	if len(in.Reviews) == 0 {
		pulled, meta, ok, perr := d.providerPullWithRetry(r.Context(), tenantID, integration, in.Cursor)
		if perr != nil {
			httperror.Write(w, http.StatusBadGateway, "provider_sync_failed", httperror.MessageInternal)
			return
		}
		if !ok {
			httperror.Write(w, http.StatusUnprocessableEntity, "payload_required", "review sync/backfill requires canonical reviews; no provider puller is wired for this provider")
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
	integration, err = d.currentReviewIntegrationForSync(r.Context(), tenantID, integration)
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
	if providerPulled && reviewProviderPulledSyncFailed(in, summary) {
		syncErr := reviewSyncFailureError(pullMeta.Provider, summary)
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
	if reviewIntegrationDisconnected(integration) {
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
	if err := httpbody.DecodeJSON(w, r, reviewJSONMaxBodyBytes, &in); err != nil {
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
	if integration == nil || !reviewProviderCleanupEligible(integration.Provider) {
		return nil
	}
	providerName := reviewProviderDisplayName(integration.Provider)
	scopeType, scopeID := reviewProviderScope(integration)
	webhookSecretRef := firstString(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
		settingString(integration.Settings, "signing_secret_ref"),
	)
	ingestTokenPresent := settingString(integration.Settings, reviewIngestTokenSetting) != ""
	webhookStatus := "not_configured_in_postwave"
	if webhookSecretRef != "" || ingestTokenPresent {
		webhookStatus = "operator_cleanup_required"
	}
	credentialAction := "rotate the " + providerName + " API credentials if they are no longer used"
	if integration.Provider == ProviderYotpo {
		credentialAction = "rotate the Yotpo app secret or API credentials if they are no longer used"
	}
	return &DisconnectCleanupEvidence{
		Provider:                    integration.Provider,
		Status:                      "operator_action_required",
		RecordedAt:                  recordedAt.UTC().Format(time.RFC3339),
		PostwaveStatus:              "disconnected",
		ProviderCleanupPosture:      "operator_managed_provider_console",
		ManagedProviderCleanup:      false,
		ProviderScopeType:           scopeType,
		ProviderScopeID:             scopeID,
		CredentialRefPresent:        strings.TrimSpace(integration.CredentialsRef) != "",
		WebhookSecretRefPresent:     webhookSecretRef != "",
		TokenizedIngestTokenPresent: ingestTokenPresent,
		WebhookCleanupStatus:        webhookStatus,
		CredentialCleanupStatus:     "operator_revoke_or_rotate_if_no_longer_used",
		PostwaveEffects: []string{
			"local review integration is marked disconnected",
			"scheduled " + providerName + " review pulls exclude disconnected rows",
			"tokenized " + providerName + " review webhook ingest no longer resolves this row",
			"review sync and webhook audit history is retained",
		},
		ProviderConsoleActions: []string{
			credentialAction,
			"delete or disable the Moosewave " + providerName + " webhook target, filter, or subscription",
			"remove tokenized Moosewave review ingest URLs from " + providerName + " if push delivery was configured",
			"audit duplicate or manually configured " + providerName + " webhook targets outside Moosewave",
		},
		ProviderCleanupEvidence: []string{
			"Moosewave does not call a " + providerName + " provider-cleanup API on review disconnect",
			providerName + " webhook and credential cleanup remains operator-managed until managed cleanup automation is certified",
		},
	}
}

func reviewProviderCleanupEligible(provider string) bool {
	provider = strings.ToLower(strings.TrimSpace(provider))
	return provider == ProviderYotpo || isNativeReviewPullerProvider(provider)
}

func reviewProviderDisplayName(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case ProviderYotpo:
		return "Yotpo"
	case ProviderJudgeMe:
		return "Judge.me"
	case ProviderOkendo:
		return "Okendo"
	case ProviderLoox:
		return "Loox"
	case ProviderStamped:
		return "Stamped"
	case ProviderTrustpilot:
		return "Trustpilot"
	case ProviderReviewsIO:
		return "Reviews.io"
	case ProviderBazaarvoice:
		return "Bazaarvoice"
	case ProviderPowerReviews:
		return "PowerReviews"
	default:
		return strings.TrimSpace(provider)
	}
}

func reviewProviderScope(integration *Integration) (string, string) {
	if integration == nil {
		return "", ""
	}
	settings := integration.Settings
	switch integration.Provider {
	case ProviderYotpo:
		return "yotpo_store_id", firstString(settingString(settings, "store_id"), settingString(settings, "yotpo_store_id"), settingString(settings, "account_id"))
	case ProviderJudgeMe, ProviderLoox:
		return "shop_domain", settingString(settings, "shop_domain")
	case ProviderOkendo, ProviderStamped, ProviderReviewsIO:
		return "store_id", settingString(settings, "store_id")
	case ProviderTrustpilot:
		return "business_unit_id", settingString(settings, "business_unit_id")
	case ProviderBazaarvoice:
		return "client_name", settingString(settings, "client_name")
	case ProviderPowerReviews:
		return "merchant_id", settingString(settings, "merchant_id")
	default:
		return "provider_account", firstString(settingString(settings, "store_id"), settingString(settings, "shop_domain"), settingString(settings, "account_id"))
	}
}

func normalizeProviderCleanupAcknowledgementInput(in ProviderCleanupAcknowledgementInput) (ProviderCleanupAcknowledgementInput, error) {
	out := ProviderCleanupAcknowledgementInput{
		Notes:          reviewTruncate(strings.TrimSpace(in.Notes), 2000),
		AcknowledgedBy: reviewTruncate(strings.TrimSpace(in.AcknowledgedBy), 200),
	}
	seen := map[string]bool{}
	for _, action := range in.CompletedActions {
		action = reviewTruncate(strings.ToLower(strings.TrimSpace(action)), 200)
		if action == "" {
			continue
		}
		if !reviewProviderCleanupActionKeys[action] {
			return ProviderCleanupAcknowledgementInput{}, errors.New("completed_actions contains unsupported review cleanup action key")
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

var reviewProviderCleanupActionKeys = map[string]bool{
	"app_secret_or_api_credentials_rotated":                     true,
	"provider_api_credentials_rotated":                          true,
	"provider_webhook_target_or_subscription_removed":           true,
	"webhook_target_filter_or_subscription_removed_or_disabled": true,
	"tokenized_ingest_urls_removed":                             true,
	"duplicate_or_manual_provider_webhooks_audited":             true,
	"duplicate_or_manual_webhook_targets_audited":               true,
	"provider_console_cleanup_reviewed_no_action_due":           true,
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
		IntegrationID: integration.ID,
		Status:        "completed",
		ReviewsSeen:   len(in.Reviews),
		Cursor:        in.Cursor,
	}
	for _, review := range in.Reviews {
		var err error
		review, err = d.enrichReviewCommerce(ctx, tenantID, integration, review)
		if err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		if d.Profiles != nil && review.ReviewerEmail != "" {
			if _, err := d.Profiles.UpsertReviewer(ctx, tenantID, integration.Provider, review); err != nil {
				summary.RowsFailed++
				summary.Status = "partial"
				summary.ErrorMessage = err.Error()
				continue
			}
			summary.ProfilesUpserted++
		}
		if d.Reviews == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "review sink unavailable"
			continue
		}
		if _, err := d.Reviews.ImportReview(ctx, tenantID, integration.Provider, review); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.ReviewsImported++
		if d.Events == nil || review.ReviewerEmail == "" {
			continue
		}
		if _, err := d.Events.TrackReviewEvent(ctx, tenantID, integration.Provider, review); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.EventsTracked++
	}
	if summary.RowsFailed > 0 && summary.ReviewsImported == 0 && summary.ProfilesUpserted == 0 && summary.EventsTracked == 0 {
		summary.Status = "failed"
	}
	if summary.Cursor == "" {
		summary.Cursor = "review-sync-" + strconv.FormatInt(d.now().Unix(), 10)
	}
	return summary
}

func (d *Deps) enrichReviewCommerce(ctx context.Context, tenantID string, integration *Integration, review ReviewInput) (ReviewInput, error) {
	var err error
	review, err = d.enrichReviewProduct(ctx, tenantID, integration, review)
	if err != nil {
		return review, err
	}
	review, err = d.enrichReviewOrder(ctx, tenantID, integration, review)
	if err != nil {
		return review, err
	}
	review, err = d.enrichReviewProductFromOrderLine(ctx, tenantID, integration, review)
	if err != nil {
		return review, err
	}
	if review.ProductID == "" {
		review = annotateYotpoProductLookupMiss(integration, review)
	}
	return d.enrichReviewCustomer(ctx, tenantID, integration, review)
}

func (d *Deps) enrichReviewProduct(ctx context.Context, tenantID string, integration *Integration, review ReviewInput) (ReviewInput, error) {
	if d == nil || d.Products == nil || integration == nil || review.ProductID != "" {
		return review, nil
	}
	productID, err := d.Products.ResolveReviewProductID(ctx, tenantID, *integration, review)
	if err != nil || productID == "" {
		if err != nil {
			return review, err
		}
		return review, nil
	}
	review.ProductID = productID
	if review.Metadata == nil {
		review.Metadata = map[string]any{}
	}
	review.Metadata["resolved_product_id"] = productID
	review.Metadata["product_resolution"] = "commerce_products"
	return review, nil
}

func (d *Deps) enrichReviewProductFromOrderLine(ctx context.Context, tenantID string, integration *Integration, review ReviewInput) (ReviewInput, error) {
	if d == nil || d.Products == nil || integration == nil || review.ProductID != "" || review.OrderID == "" {
		return review, nil
	}
	resolver, ok := d.Products.(ReviewOrderLineProductResolver)
	if !ok {
		return review, nil
	}
	productID, err := resolver.ResolveReviewProductIDFromOrderLine(ctx, tenantID, *integration, review)
	if err != nil || productID == "" {
		return review, err
	}
	review.ProductID = productID
	if review.Metadata == nil {
		review.Metadata = map[string]any{}
	}
	review.Metadata["resolved_product_id"] = productID
	review.Metadata["product_resolution"] = "commerce_order_line_items"
	return review, nil
}

func annotateYotpoProductLookupMiss(integration *Integration, review ReviewInput) ReviewInput {
	if integration == nil || integration.Provider != ProviderYotpo || review.ProductID != "" {
		return review
	}
	commerceIntegrationID := reviewCommerceIntegrationID(integration.Settings)
	if commerceIntegrationID == "" {
		return review
	}
	candidates := reviewProductSourceCandidates(review)
	if len(candidates) == 0 {
		return review
	}
	if review.Metadata == nil {
		review.Metadata = map[string]any{}
	}
	review.Metadata["product_resolution"] = "commerce_products_lookup_miss"
	review.Metadata["product_refresh_required"] = true
	review.Metadata["product_refresh_owner"] = "commerce_integration"
	review.Metadata["product_refresh_reason"] = "commerce_product_lookup_miss"
	review.Metadata["product_refresh_target_integration_id"] = commerceIntegrationID
	review.Metadata["product_refresh_candidates"] = candidates
	return review
}

func (d *Deps) enrichReviewOrder(ctx context.Context, tenantID string, integration *Integration, review ReviewInput) (ReviewInput, error) {
	if d == nil || d.Products == nil || integration == nil || review.OrderID != "" {
		return review, nil
	}
	resolver, ok := d.Products.(ReviewOrderResolver)
	if !ok {
		return review, nil
	}
	orderID, err := resolver.ResolveReviewOrderID(ctx, tenantID, *integration, review)
	if err != nil || orderID == "" {
		return review, err
	}
	review.OrderID = orderID
	if review.Metadata == nil {
		review.Metadata = map[string]any{}
	}
	review.Metadata["resolved_order_id"] = orderID
	review.Metadata["order_resolution"] = "commerce_orders"
	return review, nil
}

func (d *Deps) enrichReviewCustomer(ctx context.Context, tenantID string, integration *Integration, review ReviewInput) (ReviewInput, error) {
	if d == nil || d.Products == nil || integration == nil || review.CustomerID != "" {
		return review, nil
	}
	resolver, ok := d.Products.(ReviewCustomerResolver)
	if !ok {
		return review, nil
	}
	customerID, err := resolver.ResolveReviewCustomerID(ctx, tenantID, *integration, review)
	if err != nil || customerID == "" {
		return review, err
	}
	review.CustomerID = customerID
	if review.Metadata == nil {
		review.Metadata = map[string]any{}
	}
	review.Metadata["resolved_customer_id"] = customerID
	review.Metadata["customer_resolution"] = "commerce_customers"
	return review, nil
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "review integration not found")
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
