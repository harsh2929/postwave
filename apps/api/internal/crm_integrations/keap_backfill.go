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
	keapRetryCursorPrefix             = "keap_retry:"
	keapBulkBackfillDefaultMaxPages   = 10
	keapRetryInitialDelay             = 15 * time.Minute
	keapRetryMaxDelay                 = 6 * time.Hour
	keapBackfillWorkerDefaultInterval = 15 * time.Minute
	keapBackfillWorkerDefaultDueAfter = time.Hour
	keapBackfillWorkerDefaultLimit    = 10
	keapBackfillWorkerDefaultMaxPages = 10
)

type keapRetryState struct {
	Cursor        string `json:"cursor"`
	Object        string `json:"object,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

func decodeKeapRetryCursor(cursor string) (keapRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, keapRetryCursorPrefix) {
		return keapRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, keapRetryCursorPrefix))
	if err != nil {
		return keapRetryState{}, true, fmt.Errorf("decode Keap retry cursor: %w", err)
	}
	var state keapRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return keapRetryState{}, true, fmt.Errorf("parse Keap retry cursor: %w", err)
	}
	keapNormalizeRetryState(&state)
	return state, true, nil
}

func encodeKeapRetryCursor(state keapRetryState) string {
	keapNormalizeRetryState(&state)
	raw, _ := json.Marshal(state)
	return keapRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func keapNormalizeRetryState(state *keapRetryState) {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeKeapCursor(keapCursorState{Object: "contacts"})
	}
	if underlying, err := decodeKeapCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateHubSpotString(strings.TrimSpace(state.LastError), 500)
}

func keapRetryCursorDue(state keapRetryState, now time.Time) bool {
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

func keapBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := keapRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeKeapRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(keapRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeKeapRetryCursor(state)
}

func keapRetryDelay(attempt int, err error) time.Duration {
	var restErr KeapRESTError
	if err != nil && errors.As(err, &restErr) && restErr.RetryAfter > 0 {
		if restErr.RetryAfter > keapRetryMaxDelay {
			return keapRetryMaxDelay
		}
		return restErr.RetryAfter
	}
	if attempt <= 1 {
		return keapRetryInitialDelay
	}
	delay := keapRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= keapRetryMaxDelay {
			return keapRetryMaxDelay
		}
	}
	return delay
}

func keapSyncRequestHasPayload(req SyncRequest) bool {
	return len(req.Contacts)+len(req.Events) > 0
}

type KeapBackfillRunner struct {
	Deps       *Deps
	Backfiller KeapBackfiller
	MaxPages   int
	Now        func() time.Time
}

type KeapBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	ContactsSeen      int    `json:"contacts_seen"`
	ContactsUpserted  int    `json:"contacts_upserted"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r KeapBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (KeapBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return KeapBackfillSummary{}, fmt.Errorf("keap backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.KeapBackfiller
	}
	if backfiller == nil {
		return KeapBackfillSummary{}, fmt.Errorf("keap backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return KeapBackfillSummary{}, err
	}
	if integration == nil {
		return KeapBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderKeap {
		return KeapBackfillSummary{}, fmt.Errorf("keap backfill requires a Keap CRM integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := KeapBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if crmIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor := cursor
	if retry, ok, err := decodeKeapRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !keapRetryCursorDue(retry, r.now()) {
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
		if current.Provider != ProviderKeap {
			return summary, fmt.Errorf("keap backfill requires a Keap CRM integration")
		}
		if crmIntegrationDisconnected(current) {
			return summary, nil
		}
		integration = current
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := keapBackfillRetryCursor(retryBaseCursor, "BACKFILL_FAILED", err, r.now())
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
			syncErr = crmSyncFailureError(ProviderKeap, pageSummary)
			retryCursor := keapBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", syncErr, r.now())
			req.Cursor = retryCursor
			pageSummary.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.LastError = syncErr.Error()
		}
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := keapBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if keapSyncRequestHasPayload(req) {
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
		if !keapSyncRequestHasPayload(req) || cursor == keapCursorComplete {
			if cursor == keapCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r KeapBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
	started := r.now()
	completed := r.now()
	req := normalizeSyncRequest(SyncRequest{RunMode: "scheduled", Cursor: cursor})
	summary := SyncSummary{IntegrationID: integrationID, Status: "failed", Cursor: cursor, ErrorMessage: syncErr.Error()}
	_, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integrationID, summary, req, started, completed)
	return err
}

func (r KeapBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return keapBulkBackfillDefaultMaxPages
	}
	if r.MaxPages > 100 {
		return 100
	}
	return r.MaxPages
}

func (r KeapBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

type KeapBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type KeapBackfillWorkerStore interface {
	Store
	ListKeapBackfillTargets(context.Context, int, time.Time) ([]KeapBackfillTarget, error)
}

type KeapBackfillWorker struct {
	Deps           *Deps
	Store          KeapBackfillWorkerStore
	Backfiller     KeapBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type KeapBackfillWorkerSummary struct {
	Targets          int
	Completed        int
	Failed           int
	Pages            int
	ContactsUpserted int
}

func (w *KeapBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = keapBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("keap backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("keap backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("keap backfill tick complete", "targets", summary.Targets, "completed", summary.Completed, "failed", summary.Failed, "pages", summary.Pages, "contacts_upserted", summary.ContactsUpserted)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *KeapBackfillWorker) tick(ctx context.Context) (KeapBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return KeapBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = keapBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = keapBackfillWorkerDefaultLimit
	}
	targets, err := store.ListKeapBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return KeapBackfillWorkerSummary{}, err
	}
	summary := KeapBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.KeapBackfiller
	}
	if backfiller == nil {
		return summary, errors.New("keap backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := KeapBackfillRunner{Deps: deps, Backfiller: backfiller, MaxPages: w.maxPagesPerRun(), Now: w.now}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("keap scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "err", err.Error())
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

func (w *KeapBackfillWorker) storeAndDeps() (KeapBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("keap backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(KeapBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("keap backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *KeapBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *KeapBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return keapBackfillWorkerDefaultMaxPages
	}
	return w.MaxPagesPerRun
}
