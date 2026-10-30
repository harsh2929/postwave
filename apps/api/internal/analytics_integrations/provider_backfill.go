// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

const (
	analyticsBackfillWorkerDefaultInterval       = 15 * time.Minute
	analyticsBackfillWorkerDefaultDueAfter       = time.Hour
	analyticsBackfillWorkerDefaultLimit          = 10
	analyticsBackfillWorkerMaxCandidateScan      = 1000
	analyticsBackfillWorkerDefaultMaxPagesPerRun = 10
	analyticsBulkBackfillDefaultMaxPages         = 10
	analyticsRetryInitialDelay                   = 3 * time.Minute
	analyticsRetryMaxDelay                       = time.Hour
)

type AnalyticsBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type AnalyticsBackfillWorkerStore interface {
	Store
	ListAnalyticsBackfillTargets(context.Context, string, int, time.Time) ([]AnalyticsBackfillTarget, error)
}

type AnalyticsBackfillWorker struct {
	Provider       string
	Deps           *Deps
	Store          AnalyticsBackfillWorkerStore
	Backfiller     AnalyticsBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type AnalyticsBackfillWorkerSummary struct {
	Provider         string
	Targets          int
	Completed        int
	Failed           int
	Pages            int
	ProfilesSeen     int
	ProfilesUpserted int
	EventsSeen       int
	EventsTracked    int
}

func (w *AnalyticsBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	provider := w.provider()
	if provider == "" {
		return errors.New("analytics backfill worker: provider is required")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = analyticsBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info(provider+" analytics backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn(provider+" analytics backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info(provider+" analytics backfill tick complete",
				"provider", summary.Provider,
				"targets", summary.Targets,
				"completed", summary.Completed,
				"failed", summary.Failed,
				"pages", summary.Pages,
				"profiles_seen", summary.ProfilesSeen,
				"profiles_upserted", summary.ProfilesUpserted,
				"events_seen", summary.EventsSeen,
				"events_tracked", summary.EventsTracked)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *AnalyticsBackfillWorker) tick(ctx context.Context) (AnalyticsBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return AnalyticsBackfillWorkerSummary{}, err
	}
	provider := w.provider()
	if provider == "" {
		return AnalyticsBackfillWorkerSummary{}, errors.New("analytics backfill worker: provider is required")
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = analyticsBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = analyticsBackfillWorkerDefaultLimit
	}
	targets, err := store.ListAnalyticsBackfillTargets(ctx, provider, analyticsBackfillWorkerCandidateLimit(limit), now.Add(-dueAfter))
	if err != nil {
		return AnalyticsBackfillWorkerSummary{}, err
	}
	summary := AnalyticsBackfillWorkerSummary{Provider: provider}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = analyticsBackfillerForProvider(deps, provider)
	}
	if backfiller == nil {
		return summary, fmt.Errorf("%s analytics backfill worker: missing backfiller", provider)
	}
	for _, target := range targets {
		if summary.Targets >= limit {
			break
		}
		if analyticsBackfillTargetRetryNotDue(provider, target.Cursor, now) {
			continue
		}
		summary.Targets++
		runner := AnalyticsBulkBackfillRunner{
			Provider:   provider,
			Deps:       deps,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn(provider+" scheduled analytics backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.ProfilesSeen += out.ProfilesSeen
		summary.ProfilesUpserted += out.ProfilesUpserted
		summary.EventsSeen += out.EventsSeen
		summary.EventsTracked += out.EventsTracked
	}
	return summary, nil
}

func (w *AnalyticsBackfillWorker) storeAndDeps() (AnalyticsBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("analytics backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(AnalyticsBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("analytics backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *AnalyticsBackfillWorker) provider() string {
	if w == nil {
		return ""
	}
	return strings.TrimSpace(w.Provider)
}

func (w *AnalyticsBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *AnalyticsBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return analyticsBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

func analyticsBackfillWorkerCandidateLimit(limit int) int {
	if limit <= 0 {
		limit = analyticsBackfillWorkerDefaultLimit
	}
	if limit >= analyticsBackfillWorkerMaxCandidateScan {
		return limit
	}
	return analyticsBackfillWorkerMaxCandidateScan
}

type AnalyticsBulkBackfillRunner struct {
	Provider   string
	Deps       *Deps
	Backfiller AnalyticsBackfiller
	MaxPages   int
	Now        func() time.Time
}

type AnalyticsBulkBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Provider          string `json:"provider"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	ProfilesSeen      int    `json:"profiles_seen"`
	ProfilesUpserted  int    `json:"profiles_upserted"`
	EventsSeen        int    `json:"events_seen"`
	EventsTracked     int    `json:"events_tracked"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r AnalyticsBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (AnalyticsBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return AnalyticsBulkBackfillSummary{}, fmt.Errorf("analytics bulk backfill deps are required")
	}
	provider := strings.TrimSpace(r.Provider)
	backfiller := r.Backfiller
	if backfiller == nil && provider != "" {
		backfiller = analyticsBackfillerForProvider(r.Deps, provider)
	}
	if backfiller == nil {
		return AnalyticsBulkBackfillSummary{}, fmt.Errorf("analytics bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return AnalyticsBulkBackfillSummary{}, err
	}
	if integration == nil {
		return AnalyticsBulkBackfillSummary{}, ErrNotFound
	}
	if provider == "" {
		provider = integration.Provider
	}
	if integration.Provider != provider {
		return AnalyticsBulkBackfillSummary{}, fmt.Errorf("analytics bulk backfill requires a %s integration", provider)
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := AnalyticsBulkBackfillSummary{IntegrationID: integration.ID, Provider: provider, Cursor: cursor}
	if analyticsIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor, effectiveCursor, deferred, err := analyticsRetryCursorState(provider, cursor, r.now())
	if err != nil {
		summary.LastError = err.Error()
		return summary, err
	}
	if deferred {
		return summary, nil
	}
	cursor = effectiveCursor
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		current, err := r.Deps.currentAnalyticsIntegrationForSync(ctx, tenantID, integration)
		if err != nil {
			if errors.Is(err, ErrDisconnected) {
				return summary, nil
			}
			summary.LastError = err.Error()
			return summary, err
		}
		integration = current
		if integration.Provider != provider {
			return summary, fmt.Errorf("analytics bulk backfill requires a %s integration", provider)
		}
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor, _ := analyticsProviderRetryCursor(provider, retryBaseCursor, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = "scheduled"
		current, err = r.Deps.currentAnalyticsIntegrationForSync(ctx, tenantID, integration)
		if err != nil {
			if errors.Is(err, ErrDisconnected) {
				return summary, nil
			}
			summary.LastError = err.Error()
			return summary, err
		}
		integration = current
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		started := r.now()
		pageSummary := r.Deps.executeSync(ctx, tenantID, integration, req)
		syncFailed := analyticsProviderPulledSyncFailed(req, pageSummary)
		var syncErr error
		if syncFailed {
			syncErr = analyticsSyncFailureError(provider, pageSummary)
			retryCursor, _ := analyticsProviderRetryCursor(provider, retryBaseCursor, "SYNC_FAILED", syncErr, r.now())
			req.Cursor = retryCursor
			pageSummary.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.LastError = syncErr.Error()
		}
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor, _ := analyticsProviderRetryCursor(provider, retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if analyticsSyncRequestMadeProgress(provider, cursor, req) {
			summary.Pages++
		}
		summary.ProfilesSeen += pageSummary.ProfilesSeen
		summary.ProfilesUpserted += pageSummary.ProfilesUpserted
		summary.EventsSeen += pageSummary.EventsSeen
		summary.EventsTracked += pageSummary.EventsTracked
		if syncFailed {
			return summary, syncErr
		}
		nextCursor := firstString(pageSummary.Cursor, req.Cursor, cursor)
		complete := analyticsProviderCursorComplete(provider, nextCursor)
		noRows := !analyticsSyncRequestHasRows(req)
		noAdvance := strings.TrimSpace(nextCursor) == "" || nextCursor == cursor
		cursor = nextCursor
		retryBaseCursor = cursor
		summary.Cursor = cursor
		if complete || (noRows && noAdvance) {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r AnalyticsBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
	started := r.now()
	completed := r.now()
	req := normalizeSyncRequest(SyncRequest{RunMode: "scheduled", Cursor: cursor})
	summary := SyncSummary{
		IntegrationID: integrationID,
		Status:        "failed",
		Cursor:        cursor,
		ErrorMessage:  syncErr.Error(),
	}
	_, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integrationID, summary, req, started, completed)
	return err
}

func (r AnalyticsBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return analyticsBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r AnalyticsBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

type analyticsProviderRetryState struct {
	Cursor        string `json:"cursor"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

func analyticsRetryCursorState(provider, cursor string, now time.Time) (string, string, bool, error) {
	cursor = strings.TrimSpace(cursor)
	retryBaseCursor := cursor
	retry, ok, err := decodeAnalyticsProviderRetryCursor(provider, cursor)
	if err != nil || !ok {
		return retryBaseCursor, cursor, false, err
	}
	if !analyticsProviderRetryCursorDue(retry, now) {
		return retryBaseCursor, cursor, true, nil
	}
	return retryBaseCursor, retry.Cursor, false, nil
}

func analyticsBackfillTargetRetryNotDue(provider, cursor string, now time.Time) bool {
	_, _, deferred, err := analyticsRetryCursorState(provider, cursor, now)
	return err == nil && deferred
}

func analyticsProviderRetryCursor(provider, cursor, status string, retryErr error, now time.Time) (string, bool) {
	if _, ok := analyticsProviderRetryPrefix(provider); !ok {
		return "", false
	}
	return encodeAnalyticsProviderRetryCursor(provider, analyticsProviderRetryStateFromCursor(provider, cursor, status, retryErr, now)), true
}

func analyticsProviderRetryStateFromCursor(provider, cursor, status string, retryErr error, now time.Time) analyticsProviderRetryState {
	state := analyticsProviderRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeAnalyticsProviderRetryCursor(provider, cursor); err == nil && ok {
		state = existing
	}
	state.Attempts++
	state.LastStatus = strings.ToUpper(strings.TrimSpace(status))
	if state.LastStatus == "" {
		state.LastStatus = "ERROR"
	}
	if retryErr != nil {
		state.LastError = retryErr.Error()
	}
	state.NextAttemptAt = now.UTC().Add(analyticsProviderRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return normalizeAnalyticsProviderRetryState(state)
}

func decodeAnalyticsProviderRetryCursor(provider, cursor string) (analyticsProviderRetryState, bool, error) {
	prefix, ok := analyticsProviderRetryPrefix(provider)
	if !ok {
		return analyticsProviderRetryState{}, false, nil
	}
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, prefix) {
		return analyticsProviderRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, prefix))
	if err != nil {
		return analyticsProviderRetryState{}, true, fmt.Errorf("decode %s retry cursor: %w", provider, err)
	}
	var state analyticsProviderRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return analyticsProviderRetryState{}, true, fmt.Errorf("parse %s retry cursor: %w", provider, err)
	}
	return normalizeAnalyticsProviderRetryState(state), true, nil
}

func encodeAnalyticsProviderRetryCursor(provider string, state analyticsProviderRetryState) string {
	prefix, _ := analyticsProviderRetryPrefix(provider)
	state = normalizeAnalyticsProviderRetryState(state)
	raw, _ := json.Marshal(state)
	return prefix + base64.RawURLEncoding.EncodeToString(raw)
}

func normalizeAnalyticsProviderRetryState(state analyticsProviderRetryState) analyticsProviderRetryState {
	state.Cursor = strings.TrimSpace(state.Cursor)
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = analyticsTruncate(strings.TrimSpace(state.LastError), 500)
	return state
}

func analyticsProviderRetryCursorDue(state analyticsProviderRetryState, now time.Time) bool {
	next := strings.TrimSpace(state.NextAttemptAt)
	if next == "" {
		return true
	}
	at, err := time.Parse(time.RFC3339, next)
	if err != nil {
		return true
	}
	return !at.After(now.UTC())
}

func analyticsProviderRetryDelay(attempt int, err error) time.Duration {
	var providerErr AnalyticsRESTError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > analyticsRetryMaxDelay {
			return analyticsRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return analyticsRetryInitialDelay
	}
	delay := analyticsRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= analyticsRetryMaxDelay {
			return analyticsRetryMaxDelay
		}
	}
	return delay
}

func analyticsProviderRetryPrefix(provider string) (string, bool) {
	switch strings.TrimSpace(provider) {
	case ProviderPostHog, ProviderTripleWhale, ProviderMixpanel, ProviderAmplitude:
		return strings.ReplaceAll(provider, "-", "_") + "_retry:", true
	default:
		return "", false
	}
}

func analyticsBackfillerForProvider(d *Deps, provider string) AnalyticsBackfiller {
	if d == nil {
		return nil
	}
	switch provider {
	case ProviderPostHog:
		return d.PostHogBackfiller
	case ProviderTripleWhale:
		return d.TripleWhaleBackfiller
	case ProviderMixpanel:
		return d.MixpanelBackfiller
	case ProviderAmplitude:
		return d.AmplitudeBackfiller
	default:
		return nil
	}
}

func analyticsProviderPulledSyncFailed(req SyncRequest, summary SyncSummary) bool {
	return analyticsSyncRequestHasRows(req) && (summary.RowsFailed > 0 || strings.EqualFold(strings.TrimSpace(summary.Status), "failed") || strings.EqualFold(strings.TrimSpace(summary.Status), "partial"))
}

func analyticsSyncFailureError(provider string, summary SyncSummary) error {
	msg := strings.TrimSpace(summary.ErrorMessage)
	if msg == "" {
		msg = strings.TrimSpace(provider) + " analytics sync failed"
	}
	return errors.New(msg)
}

func analyticsSyncRequestHasRows(req SyncRequest) bool {
	return len(req.Profiles)+len(req.Events) > 0
}

func analyticsSyncRequestMadeProgress(provider, previousCursor string, req SyncRequest) bool {
	if analyticsSyncRequestHasRows(req) {
		return true
	}
	next := strings.TrimSpace(req.Cursor)
	return next != "" && next != strings.TrimSpace(previousCursor) && !analyticsProviderCursorComplete(provider, next)
}

func analyticsProviderCursorComplete(provider, cursor string) bool {
	cursor = strings.TrimSpace(cursor)
	switch provider {
	case ProviderPostHog:
		return cursor == postHogCursorComplete
	case ProviderTripleWhale:
		return cursor == tripleWhaleCursorComplete
	case ProviderMixpanel:
		return cursor == mixpanelCursorComplete
	case ProviderAmplitude:
		return cursor == amplitudeCursorComplete
	default:
		return false
	}
}

func analyticsIntegrationDisconnected(integration *Integration) bool {
	return integration == nil || strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected")
}
