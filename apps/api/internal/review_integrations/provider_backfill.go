// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

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
	reviewBackfillWorkerDefaultInterval       = 15 * time.Minute
	reviewBackfillWorkerDefaultDueAfter       = time.Hour
	reviewBackfillWorkerDefaultLimit          = 10
	reviewBackfillWorkerMaxCandidateScan      = 1000
	reviewBackfillWorkerDefaultMaxPagesPerRun = 10
	reviewBulkBackfillDefaultMaxPages         = 10
)

type ReviewBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type ReviewBackfillWorkerStore interface {
	Store
	ListReviewBackfillTargets(context.Context, string, int, time.Time) ([]ReviewBackfillTarget, error)
}

type ReviewBackfillWorker struct {
	Provider       string
	Deps           *Deps
	Store          ReviewBackfillWorkerStore
	Backfiller     ReviewBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type ReviewBackfillWorkerSummary struct {
	Provider         string
	Targets          int
	Completed        int
	Failed           int
	Pages            int
	ReviewsSeen      int
	ReviewsImported  int
	ProfilesUpserted int
	EventsTracked    int
}

func (w *ReviewBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	provider := w.provider()
	if provider == "" {
		return errors.New("review backfill worker: provider is required")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = reviewBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info(provider+" review backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn(provider+" review backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info(provider+" review backfill tick complete",
				"provider", summary.Provider,
				"targets", summary.Targets,
				"completed", summary.Completed,
				"failed", summary.Failed,
				"pages", summary.Pages,
				"reviews_seen", summary.ReviewsSeen,
				"reviews_imported", summary.ReviewsImported,
				"profiles_upserted", summary.ProfilesUpserted,
				"events_tracked", summary.EventsTracked)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *ReviewBackfillWorker) tick(ctx context.Context) (ReviewBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return ReviewBackfillWorkerSummary{}, err
	}
	provider := w.provider()
	if provider == "" {
		return ReviewBackfillWorkerSummary{}, errors.New("review backfill worker: provider is required")
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = reviewBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = reviewBackfillWorkerDefaultLimit
	}
	targets, err := store.ListReviewBackfillTargets(ctx, provider, reviewBackfillWorkerCandidateLimit(limit), now.Add(-dueAfter))
	if err != nil {
		return ReviewBackfillWorkerSummary{}, err
	}
	summary := ReviewBackfillWorkerSummary{Provider: provider}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = reviewBackfillerForProvider(deps, provider)
	}
	if backfiller == nil {
		return summary, fmt.Errorf("%s review backfill worker: missing backfiller", provider)
	}
	for _, target := range targets {
		if summary.Targets >= limit {
			break
		}
		if reviewBackfillTargetRetryNotDue(provider, target.Cursor, now) {
			continue
		}
		summary.Targets++
		runner := ReviewBulkBackfillRunner{
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
				w.Logger.Warn(provider+" scheduled review backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.ReviewsSeen += out.ReviewsSeen
		summary.ReviewsImported += out.ReviewsImported
		summary.ProfilesUpserted += out.ProfilesUpserted
		summary.EventsTracked += out.EventsTracked
	}
	return summary, nil
}

func (w *ReviewBackfillWorker) storeAndDeps() (ReviewBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("review backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(ReviewBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("review backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *ReviewBackfillWorker) provider() string {
	if w == nil {
		return ""
	}
	return strings.TrimSpace(w.Provider)
}

func (w *ReviewBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *ReviewBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return reviewBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

func reviewBackfillWorkerCandidateLimit(limit int) int {
	if limit <= 0 {
		limit = reviewBackfillWorkerDefaultLimit
	}
	if limit >= reviewBackfillWorkerMaxCandidateScan {
		return limit
	}
	return reviewBackfillWorkerMaxCandidateScan
}

type ReviewBulkBackfillRunner struct {
	Provider   string
	Deps       *Deps
	Backfiller ReviewBackfiller
	MaxPages   int
	Now        func() time.Time
}

type ReviewBulkBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Provider          string `json:"provider"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	ReviewsSeen       int    `json:"reviews_seen"`
	ReviewsImported   int    `json:"reviews_imported"`
	ProfilesUpserted  int    `json:"profiles_upserted"`
	EventsTracked     int    `json:"events_tracked"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r ReviewBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (ReviewBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return ReviewBulkBackfillSummary{}, fmt.Errorf("review bulk backfill deps are required")
	}
	provider := strings.TrimSpace(r.Provider)
	backfiller := r.Backfiller
	if backfiller == nil && provider != "" {
		backfiller = reviewBackfillerForProvider(r.Deps, provider)
	}
	if backfiller == nil {
		return ReviewBulkBackfillSummary{}, fmt.Errorf("review bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return ReviewBulkBackfillSummary{}, err
	}
	if integration == nil {
		return ReviewBulkBackfillSummary{}, ErrNotFound
	}
	if provider == "" {
		provider = integration.Provider
	}
	if integration.Provider != provider {
		return ReviewBulkBackfillSummary{}, fmt.Errorf("review bulk backfill requires a %s integration", provider)
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := ReviewBulkBackfillSummary{IntegrationID: integration.ID, Provider: provider, Cursor: cursor}
	if reviewIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor, effectiveCursor, deferred, err := reviewRetryCursorState(provider, cursor, r.now())
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
		current, err := r.Deps.currentReviewIntegrationForSync(ctx, tenantID, integration)
		if err != nil {
			if errors.Is(err, errIntegrationDisconnected) {
				return summary, nil
			}
			summary.LastError = err.Error()
			return summary, err
		}
		integration = current
		if integration.Provider != provider {
			return summary, fmt.Errorf("review bulk backfill requires a %s integration", provider)
		}
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor, _ := reviewProviderRetryCursor(provider, retryBaseCursor, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = "scheduled"
		current, err = r.Deps.currentReviewIntegrationForSync(ctx, tenantID, integration)
		if err != nil {
			if errors.Is(err, errIntegrationDisconnected) {
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
		syncFailed := reviewProviderPulledSyncFailed(req, pageSummary)
		var syncErr error
		if syncFailed {
			syncErr = reviewSyncFailureError(provider, pageSummary)
			retryCursor, _ := reviewProviderRetryCursor(provider, retryBaseCursor, "SYNC_FAILED", syncErr, r.now())
			req.Cursor = retryCursor
			pageSummary.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.LastError = syncErr.Error()
		}
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor, _ := reviewProviderRetryCursor(provider, retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if syncRequestHasReviews(req) {
			summary.Pages++
		}
		summary.ReviewsSeen += pageSummary.ReviewsSeen
		summary.ReviewsImported += pageSummary.ReviewsImported
		summary.ProfilesUpserted += pageSummary.ProfilesUpserted
		summary.EventsTracked += pageSummary.EventsTracked
		if syncFailed {
			return summary, syncErr
		}
		cursor = firstString(pageSummary.Cursor, req.Cursor, cursor)
		retryBaseCursor = cursor
		summary.Cursor = cursor
		if !syncRequestHasReviews(req) {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r ReviewBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r ReviewBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return reviewBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r ReviewBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

type reviewProviderRetryState struct {
	Cursor        string `json:"cursor"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

func reviewRetryCursorState(provider, cursor string, now time.Time) (string, string, bool, error) {
	cursor = strings.TrimSpace(cursor)
	retryBaseCursor := cursor
	switch provider {
	case ProviderYotpo:
		retry, ok, err := decodeYotpoRetryCursor(cursor)
		if err != nil || !ok {
			return retryBaseCursor, cursor, false, err
		}
		if !yotpoRetryCursorDue(retry, now) {
			return retryBaseCursor, cursor, true, nil
		}
		return retryBaseCursor, retry.Cursor, false, nil
	default:
		retry, ok, err := decodeReviewProviderRetryCursor(provider, cursor)
		if err != nil || !ok {
			return retryBaseCursor, cursor, false, err
		}
		if !reviewProviderRetryCursorDue(retry, now) {
			return retryBaseCursor, cursor, true, nil
		}
		return retryBaseCursor, retry.Cursor, false, nil
	}
}

func reviewBackfillTargetRetryNotDue(provider, cursor string, now time.Time) bool {
	_, _, deferred, err := reviewRetryCursorState(provider, cursor, now)
	return err == nil && deferred
}

func reviewProviderRetryCursor(provider, cursor, status string, retryErr error, now time.Time) (string, bool) {
	switch provider {
	case ProviderYotpo:
		return yotpoBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderJudgeMe, ProviderOkendo, ProviderLoox, ProviderStamped,
		ProviderTrustpilot, ProviderReviewsIO, ProviderBazaarvoice, ProviderPowerReviews:
		return encodeReviewProviderRetryCursor(provider, reviewProviderRetryStateFromCursor(provider, cursor, status, retryErr, now)), true
	default:
		return "", false
	}
}

func reviewProviderRetryStateFromCursor(provider, cursor, status string, retryErr error, now time.Time) reviewProviderRetryState {
	state := reviewProviderRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeReviewProviderRetryCursor(provider, cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(reviewProviderRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return normalizeReviewProviderRetryState(state)
}

func decodeReviewProviderRetryCursor(provider, cursor string) (reviewProviderRetryState, bool, error) {
	prefix, ok := reviewProviderRetryPrefix(provider)
	if !ok {
		return reviewProviderRetryState{}, false, nil
	}
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, prefix) {
		return reviewProviderRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, prefix))
	if err != nil {
		return reviewProviderRetryState{}, true, fmt.Errorf("decode %s retry cursor: %w", provider, err)
	}
	var state reviewProviderRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return reviewProviderRetryState{}, true, fmt.Errorf("parse %s retry cursor: %w", provider, err)
	}
	return normalizeReviewProviderRetryState(state), true, nil
}

func encodeReviewProviderRetryCursor(provider string, state reviewProviderRetryState) string {
	prefix, _ := reviewProviderRetryPrefix(provider)
	state = normalizeReviewProviderRetryState(state)
	raw, _ := json.Marshal(state)
	return prefix + base64.RawURLEncoding.EncodeToString(raw)
}

func normalizeReviewProviderRetryState(state reviewProviderRetryState) reviewProviderRetryState {
	state.Cursor = strings.TrimSpace(state.Cursor)
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = reviewTruncate(strings.TrimSpace(state.LastError), 500)
	return state
}

func reviewProviderRetryCursorDue(state reviewProviderRetryState, now time.Time) bool {
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

func reviewProviderRetryDelay(attempt int, err error) time.Duration {
	var providerErr ReviewRESTError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > yotpoRetryMaxDelay {
			return yotpoRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return yotpoRetryInitialDelay
	}
	delay := yotpoRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= yotpoRetryMaxDelay {
			return yotpoRetryMaxDelay
		}
	}
	return delay
}

func reviewProviderRetryPrefix(provider string) (string, bool) {
	switch provider {
	case ProviderJudgeMe, ProviderOkendo, ProviderLoox, ProviderStamped,
		ProviderTrustpilot, ProviderReviewsIO, ProviderBazaarvoice, ProviderPowerReviews:
		return strings.ReplaceAll(provider, "-", "_") + "_retry:", true
	default:
		return "", false
	}
}

func reviewBackfillerForProvider(d *Deps, provider string) ReviewBackfiller {
	if d == nil {
		return nil
	}
	switch provider {
	case ProviderYotpo:
		return d.YotpoBackfiller
	case ProviderJudgeMe:
		return d.JudgeMeBackfiller
	case ProviderOkendo:
		return d.OkendoBackfiller
	case ProviderLoox:
		return d.LooxBackfiller
	case ProviderTrustpilot:
		return d.TrustpilotBackfiller
	case ProviderStamped:
		return d.StampedBackfiller
	case ProviderReviewsIO:
		return d.ReviewsIOBackfiller
	case ProviderBazaarvoice:
		return d.BazaarvoiceBackfiller
	case ProviderPowerReviews:
		return d.PowerReviewsBackfiller
	default:
		return nil
	}
}

func reviewProviderPulledSyncFailed(req SyncRequest, summary SyncSummary) bool {
	return syncRequestHasReviews(req) && strings.EqualFold(strings.TrimSpace(summary.Status), "failed")
}

func reviewSyncFailureError(provider string, summary SyncSummary) error {
	msg := strings.TrimSpace(summary.ErrorMessage)
	if msg == "" {
		msg = strings.TrimSpace(provider) + " review sync failed"
	}
	return errors.New(msg)
}
