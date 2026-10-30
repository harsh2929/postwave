// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

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

type providerPullMeta struct {
	Provider      string
	Cursor        string
	RetryDeferred bool
}

type Deps struct {
	Repo        Store
	Profiles    ProfileSink
	Events      EventSink
	Logger      *slog.Logger
	Now         func() time.Time
	MaxSyncRows int
	// SegmentSecrets resolves the optional Segment webhook signing secret from a
	// webhook_secret_ref for the public ingest endpoint. Optional.
	SegmentSecrets AnalyticsRuntimeSecretResolver
	// PostHogBackfiller / TripleWhaleBackfiller, when wired, let empty
	// sync/backfill requests pull profiles/events directly from the provider —
	// the first OUTBOUND pullers in this package (Segment/RudderStack are
	// inbound ingest only).
	PostHogBackfiller     AnalyticsBackfiller
	TripleWhaleBackfiller AnalyticsBackfiller
	MixpanelBackfiller    AnalyticsBackfiller
	AmplitudeBackfiller   AnalyticsBackfiller
	// NewIngestToken overrides webhook ingest token minting (tests only).
	// Production leaves it nil and uses crypto/rand.
	NewIngestToken func() (string, error)
}

// AnalyticsBackfiller pulls a page of canonical profiles/events from a provider.
type AnalyticsBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

// providerPull dispatches an empty sync/backfill to a native provider puller.
func (d *Deps) providerPull(ctx context.Context, tenantID string, integration *Integration, cursor string) (SyncRequest, bool, error) {
	if integration == nil {
		return SyncRequest{}, false, nil
	}
	switch integration.Provider {
	case ProviderPostHog:
		if d.PostHogBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.PostHogBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderTripleWhale:
		if d.TripleWhaleBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.TripleWhaleBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderMixpanel:
		if d.MixpanelBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.MixpanelBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			return SyncRequest{}, false, err
		}
		return req, true, nil
	case ProviderAmplitude:
		if d.AmplitudeBackfiller == nil {
			return SyncRequest{}, false, nil
		}
		req, err := d.AmplitudeBackfiller.BackfillPage(ctx, tenantID, *integration, cursor)
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
	backfiller := analyticsBackfillerForProvider(d, integration.Provider)
	if backfiller == nil {
		return SyncRequest{}, providerPullMeta{}, false, nil
	}
	retryBaseCursor, effectiveCursor, deferred, err := analyticsRetryCursorState(integration.Provider, cursor, d.now())
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
		if retryCursor, ok := analyticsProviderRetryCursor(integration.Provider, retryBaseCursor, "BACKFILL_FAILED", err, d.now()); ok {
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

func (d *Deps) currentAnalyticsIntegrationForSync(ctx context.Context, tenantID string, integration *Integration) (*Integration, error) {
	if d == nil || d.Repo == nil || integration == nil {
		return nil, ErrNotFound
	}
	current, err := d.Repo.GetIntegration(ctx, tenantID, integration.ID)
	if err != nil {
		return nil, err
	}
	if analyticsIntegrationDisconnected(current) {
		return nil, ErrDisconnected
	}
	return current, nil
}

const analyticsJSONMaxBodyBytes int64 = 1 << 20

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(admin).Get("/api/v1/analytics-integrations/providers", d.ListProviders)
	// Webhook-ingest provisioning for CDP sources (Segment/RudderStack).
	// Registered before the {id} routes; chi matches the static
	// "webhook-ingest" segment ahead of the {id} wildcard.
	r.With(admin).Get("/api/v1/analytics-integrations/webhook-ingest/providers", d.ListIngestProviders)
	r.With(admin).Get("/api/v1/analytics-integrations/webhook-ingest", d.ListIngestEndpoints)
	r.With(admin).Post("/api/v1/analytics-integrations/webhook-ingest", d.ProvisionIngest)
	r.With(admin).Post("/api/v1/analytics-integrations/webhook-ingest/{id}/rotate", d.RotateIngest)
	r.With(read).Get("/api/v1/analytics-integrations", d.ListIntegrations)
	r.With(admin).Post("/api/v1/analytics-integrations", d.CreateIntegration)
	r.With(read).Get("/api/v1/analytics-integrations/{id}", d.GetIntegration)
	r.With(admin).Post("/api/v1/analytics-integrations/{id}/sync", d.SyncIntegration)
	r.With(admin).Post("/api/v1/analytics-integrations/{id}/backfill", d.BackfillIntegration)
	r.With(admin).Post("/api/v1/analytics-integrations/{id}/ingest", d.IngestEvent)
	r.With(admin).Post("/api/v1/analytics-integrations/{id}/pause", d.PauseIntegration)
	r.With(admin).Post("/api/v1/analytics-integrations/{id}/provider-cleanup/acknowledge", d.AcknowledgeProviderCleanup)
	r.With(admin).Delete("/api/v1/analytics-integrations/{id}", d.DisconnectIntegration)
	r.With(read).Get("/api/v1/analytics-integrations/{id}/runs", d.ListRuns)
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
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateIntegration(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in IntegrationInput
	if err := httpbody.DecodeJSON(w, r, analyticsJSONMaxBodyBytes, &in); err != nil {
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
	if analyticsIntegrationDisconnected(integration) {
		d.writeRepoError(w, r, tenantID, ErrDisconnected)
		return
	}
	var event EventInput
	if err := httpbody.DecodeJSON(w, r, analyticsJSONMaxBodyBytes, &event); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	req := normalizeSyncRequest(SyncRequest{
		RunMode: "webhook",
		Events:  []EventInput{event},
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
	if analyticsIntegrationDisconnected(integration) {
		d.writeRepoError(w, r, tenantID, ErrDisconnected)
		return
	}
	var in SyncRequest
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, analyticsJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
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
	if len(in.Profiles)+len(in.Events) > d.maxSyncRows() {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "sync payload has too many rows")
		return
	}
	var pullMeta providerPullMeta
	providerPulled := false
	if len(in.Profiles)+len(in.Events) == 0 {
		pulled, meta, ok, perr := d.providerPullWithRetry(r.Context(), tenantID, integration, in.Cursor)
		if perr != nil {
			httperror.Write(w, http.StatusBadGateway, "provider_sync_failed", httperror.MessageInternal)
			return
		}
		if !ok {
			httperror.Write(w, http.StatusUnprocessableEntity, "payload_required", "analytics sync/backfill requires canonical profiles or events; no provider puller is wired for this provider")
			return
		}
		if meta.RetryDeferred {
			// A retry that is not due performs no provider work. Recording it
			// as completed would clear the real error and falsify run history.
			writeJSON(w, http.StatusAccepted, SyncSummary{IntegrationID: id, Status: "deferred", Cursor: meta.Cursor})
			return
		}
		pullMeta = meta
		providerPulled = true
		in = normalizeSyncRequest(pulled)
		if forcedMode != "" {
			in.RunMode = forcedMode
		}
		if current, err := d.currentAnalyticsIntegrationForSync(r.Context(), tenantID, integration); err != nil {
			d.writeRepoError(w, r, tenantID, err)
			return
		} else {
			integration = current
		}
	}
	started := d.now()
	summary := d.executeSync(r.Context(), tenantID, integration, in)
	if providerPulled && analyticsProviderPulledSyncFailed(in, summary) {
		syncErr := analyticsSyncFailureError(pullMeta.Provider, summary)
		if retryCursor, ok := analyticsProviderRetryCursor(pullMeta.Provider, pullMeta.Cursor, "SYNC_FAILED", syncErr, d.now()); ok {
			in.Cursor = retryCursor
			summary.Cursor = retryCursor
		}
	}
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), tenantID, id, summary, in, started, completed)
	if err != nil {
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
	out, err := d.Repo.PauseIntegration(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
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
	var cleanup map[string]any
	if analyticsProviderCleanupEligible(integration.Provider) {
		cleanup = analyticsDisconnectCleanupEvidence(*integration, d.now())
	}
	if cleanup != nil {
		if store, ok := d.Repo.(providerCleanupDisconnectStore); ok {
			err = store.DisconnectIntegrationWithProviderCleanup(r.Context(), tenantID, id, cleanup)
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

func (d *Deps) AcknowledgeProviderCleanup(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	store, ok := d.Repo.(providerCleanupAcknowledgementStore)
	if !ok {
		httperror.Write(w, http.StatusNotFound, "not_found", "provider cleanup acknowledgement is not available")
		return
	}
	var in ProviderCleanupAcknowledgementInput
	if err := httpbody.DecodeJSON(w, r, analyticsJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	normalized, err := normalizeProviderCleanupAcknowledgementInput(in)
	if err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	if normalized.AcknowledgedBy == "" {
		normalized.AcknowledgedBy = analyticsProviderCleanupAcknowledgedBy(r.Context(), in.AcknowledgedBy)
	}
	out, err := store.AcknowledgeProviderCleanup(r.Context(), tenantID, chi.URLParam(r, "id"), normalized, d.now())
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
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
		ProfilesSeen:  len(in.Profiles),
		EventsSeen:    len(in.Events),
		Cursor:        in.Cursor,
	}
	for _, profile := range in.Profiles {
		if d.Profiles == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "profile sink unavailable"
			continue
		}
		if _, err := d.Profiles.UpsertAnalyticsProfile(ctx, tenantID, integration.Provider, profile); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.ProfilesUpserted++
	}
	for _, event := range in.Events {
		if d.Events == nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = "event sink unavailable"
			continue
		}
		if _, err := d.Events.TrackAnalyticsEvent(ctx, tenantID, integration.Provider, event); err != nil {
			summary.RowsFailed++
			summary.Status = "partial"
			summary.ErrorMessage = err.Error()
			continue
		}
		summary.EventsTracked++
	}
	if summary.RowsFailed > 0 && summary.ProfilesUpserted == 0 && summary.EventsTracked == 0 {
		summary.Status = "failed"
	}
	if summary.Cursor == "" {
		summary.Cursor = "analytics-sync-" + strconv.FormatInt(d.now().Unix(), 10)
	}
	return summary
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "analytics integration not found")
		return
	}
	if errors.Is(err, ErrDisconnected) {
		httperror.Write(w, http.StatusConflict, "integration_disconnected", "analytics integration is disconnected; reconnect it before syncing or mutating it")
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
