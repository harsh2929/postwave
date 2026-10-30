// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

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
	highLevelRetryCursorPrefix             = "highLevel_retry:"
	highLevelBulkBackfillDefaultMaxPages   = 10
	highLevelRetryInitialDelay             = 15 * time.Minute
	highLevelRetryMaxDelay                 = 6 * time.Hour
	highLevelBackfillWorkerDefaultInterval = 15 * time.Minute
	highLevelBackfillWorkerDefaultDueAfter = time.Hour
	highLevelBackfillWorkerDefaultLimit    = 10
	highLevelBackfillWorkerDefaultMaxPages = 10
)

type highLevelRetryState struct {
	Cursor        string `json:"cursor"`
	Object        string `json:"object,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

func decodeHighLevelRetryCursor(cursor string) (highLevelRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, highLevelRetryCursorPrefix) {
		return highLevelRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, highLevelRetryCursorPrefix))
	if err != nil {
		return highLevelRetryState{}, true, fmt.Errorf("decode HighLevel retry cursor: %w", err)
	}
	var state highLevelRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return highLevelRetryState{}, true, fmt.Errorf("parse HighLevel retry cursor: %w", err)
	}
	highLevelNormalizeRetryState(&state)
	return state, true, nil
}

func encodeHighLevelRetryCursor(state highLevelRetryState) string {
	highLevelNormalizeRetryState(&state)
	raw, _ := json.Marshal(state)
	return highLevelRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func highLevelNormalizeRetryState(state *highLevelRetryState) {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeHighLevelCursor(highLevelCursorState{Object: "contacts"})
	}
	if underlying, err := decodeHighLevelCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateHubSpotString(strings.TrimSpace(state.LastError), 500)
}

func highLevelRetryCursorDue(state highLevelRetryState, now time.Time) bool {
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

func highLevelBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := highLevelRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeHighLevelRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(highLevelRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeHighLevelRetryCursor(state)
}

func highLevelRetryDelay(attempt int, err error) time.Duration {
	var restErr HighLevelRESTError
	if err != nil && errors.As(err, &restErr) && restErr.RetryAfter > 0 {
		if restErr.RetryAfter > highLevelRetryMaxDelay {
			return highLevelRetryMaxDelay
		}
		return restErr.RetryAfter
	}
	if attempt <= 1 {
		return highLevelRetryInitialDelay
	}
	delay := highLevelRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= highLevelRetryMaxDelay {
			return highLevelRetryMaxDelay
		}
	}
	return delay
}

func highLevelSyncRequestHasPayload(req SyncRequest) bool {
	return len(req.Contacts)+len(req.Events) > 0
}

type HighLevelBackfillRunner struct {
	Deps       *Deps
	Backfiller HighLevelBackfiller
	MaxPages   int
	Now        func() time.Time
}

type HighLevelBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	ContactsSeen      int    `json:"contacts_seen"`
	ContactsUpserted  int    `json:"contacts_upserted"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r HighLevelBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (HighLevelBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return HighLevelBackfillSummary{}, fmt.Errorf("highLevel backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.HighLevelBackfiller
	}
	if backfiller == nil {
		return HighLevelBackfillSummary{}, fmt.Errorf("highLevel backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return HighLevelBackfillSummary{}, err
	}
	if integration == nil {
		return HighLevelBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderHighLevel {
		return HighLevelBackfillSummary{}, fmt.Errorf("highLevel backfill requires a HighLevel CRM integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := HighLevelBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if crmIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor := cursor
	if retry, ok, err := decodeHighLevelRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !highLevelRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		current, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
		if err != nil {
			summary.LastError = err.Error()
			return summary, err
		}
		if current == nil {
			return summary, ErrNotFound
		}
		if current.Provider != ProviderHighLevel {
			return summary, fmt.Errorf("highLevel backfill requires a HighLevel CRM integration")
		}
		if crmIntegrationDisconnected(current) {
			return summary, nil
		}
		integration = current
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := highLevelBackfillRetryCursor(retryBaseCursor, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = "scheduled"
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		current, err = r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
		if err != nil {
			summary.LastError = err.Error()
			return summary, err
		}
		if current == nil {
			return summary, ErrNotFound
		}
		if crmIntegrationDisconnected(current) {
			return summary, nil
		}
		integration = current
		started := r.now()
		pageSummary := r.Deps.executeSync(ctx, tenantID, integration, req)
		syncFailed := crmProviderPulledSyncFailed(req, pageSummary)
		var syncErr error
		if syncFailed {
			syncErr = crmSyncFailureError(ProviderHighLevel, pageSummary)
			retryCursor := highLevelBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", syncErr, r.now())
			req.Cursor = retryCursor
			pageSummary.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.LastError = syncErr.Error()
		}
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := highLevelBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if highLevelSyncRequestHasPayload(req) {
			summary.Pages++
		}
		summary.ContactsSeen += pageSummary.ContactsSeen
		summary.ContactsUpserted += pageSummary.ContactsUpserted
		if syncFailed {
			return summary, syncErr
		}
		cursor = firstString(pageSummary.Cursor, req.Cursor, cursor)
		retryBaseCursor = cursor
		summary.Cursor = cursor
		if !highLevelSyncRequestHasPayload(req) || cursor == highLevelCursorComplete {
			if cursor == highLevelCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r HighLevelBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
	started := r.now()
	completed := r.now()
	req := normalizeSyncRequest(SyncRequest{RunMode: "scheduled", Cursor: cursor})
	summary := SyncSummary{IntegrationID: integrationID, Status: "failed", Cursor: cursor, ErrorMessage: syncErr.Error()}
	_, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integrationID, summary, req, started, completed)
	return err
}

func (r HighLevelBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return highLevelBulkBackfillDefaultMaxPages
	}
	if r.MaxPages > 100 {
		return 100
	}
	return r.MaxPages
}

func (r HighLevelBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

type HighLevelBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type HighLevelBackfillWorkerStore interface {
	Store
	ListHighLevelBackfillTargets(context.Context, int, time.Time) ([]HighLevelBackfillTarget, error)
}

type HighLevelBackfillWorker struct {
	Deps           *Deps
	Store          HighLevelBackfillWorkerStore
	Backfiller     HighLevelBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type HighLevelBackfillWorkerSummary struct {
	Targets          int
	Completed        int
	Failed           int
	Pages            int
	ContactsUpserted int
}

func (w *HighLevelBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = highLevelBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("highLevel backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("highLevel backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("highLevel backfill tick complete", "targets", summary.Targets, "completed", summary.Completed, "failed", summary.Failed, "pages", summary.Pages, "contacts_upserted", summary.ContactsUpserted)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *HighLevelBackfillWorker) tick(ctx context.Context) (HighLevelBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return HighLevelBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = highLevelBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = highLevelBackfillWorkerDefaultLimit
	}
	targets, err := store.ListHighLevelBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return HighLevelBackfillWorkerSummary{}, err
	}
	summary := HighLevelBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.HighLevelBackfiller
	}
	if backfiller == nil {
		return summary, errors.New("highLevel backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := HighLevelBackfillRunner{Deps: deps, Backfiller: backfiller, MaxPages: w.maxPagesPerRun(), Now: w.now}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("highLevel scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.ContactsUpserted += out.ContactsUpserted
	}
	return summary, nil
}

func (w *HighLevelBackfillWorker) storeAndDeps() (HighLevelBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("highLevel backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(HighLevelBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("highLevel backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *HighLevelBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *HighLevelBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return highLevelBackfillWorkerDefaultMaxPages
	}
	return w.MaxPagesPerRun
}
