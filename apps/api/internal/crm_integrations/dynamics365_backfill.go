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
	dynamics365RetryCursorPrefix             = "dynamics365_retry:"
	dynamics365BulkBackfillDefaultMaxPages   = 10
	dynamics365RetryInitialDelay             = 15 * time.Minute
	dynamics365RetryMaxDelay                 = 6 * time.Hour
	dynamics365BackfillWorkerDefaultInterval = 15 * time.Minute
	dynamics365BackfillWorkerDefaultDueAfter = time.Hour
	dynamics365BackfillWorkerDefaultLimit    = 10
	dynamics365BackfillWorkerDefaultMaxPages = 10
)

type dynamics365RetryState struct {
	Cursor        string `json:"cursor"`
	Object        string `json:"object,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

func decodeDynamics365RetryCursor(cursor string) (dynamics365RetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, dynamics365RetryCursorPrefix) {
		return dynamics365RetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, dynamics365RetryCursorPrefix))
	if err != nil {
		return dynamics365RetryState{}, true, fmt.Errorf("decode Dynamics365 retry cursor: %w", err)
	}
	var state dynamics365RetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return dynamics365RetryState{}, true, fmt.Errorf("parse Dynamics365 retry cursor: %w", err)
	}
	dynamics365NormalizeRetryState(&state)
	return state, true, nil
}

func encodeDynamics365RetryCursor(state dynamics365RetryState) string {
	dynamics365NormalizeRetryState(&state)
	raw, _ := json.Marshal(state)
	return dynamics365RetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func dynamics365NormalizeRetryState(state *dynamics365RetryState) {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeDynamics365Cursor(dynamics365CursorState{Object: "contacts"})
	}
	if underlying, err := decodeDynamics365Cursor(state.Cursor); err == nil {
		state.Object = underlying.Object
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateHubSpotString(strings.TrimSpace(state.LastError), 500)
}

func dynamics365RetryCursorDue(state dynamics365RetryState, now time.Time) bool {
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

func dynamics365BackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := dynamics365RetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeDynamics365RetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(dynamics365RetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeDynamics365RetryCursor(state)
}

func dynamics365RetryDelay(attempt int, err error) time.Duration {
	var restErr Dynamics365RESTError
	if err != nil && errors.As(err, &restErr) && restErr.RetryAfter > 0 {
		if restErr.RetryAfter > dynamics365RetryMaxDelay {
			return dynamics365RetryMaxDelay
		}
		return restErr.RetryAfter
	}
	if attempt <= 1 {
		return dynamics365RetryInitialDelay
	}
	delay := dynamics365RetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= dynamics365RetryMaxDelay {
			return dynamics365RetryMaxDelay
		}
	}
	return delay
}

func dynamics365SyncRequestHasPayload(req SyncRequest) bool {
	return len(req.Contacts)+len(req.Events) > 0
}

type Dynamics365BackfillRunner struct {
	Deps       *Deps
	Backfiller Dynamics365Backfiller
	MaxPages   int
	Now        func() time.Time
}

type Dynamics365BackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	ContactsSeen      int    `json:"contacts_seen"`
	ContactsUpserted  int    `json:"contacts_upserted"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r Dynamics365BackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (Dynamics365BackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return Dynamics365BackfillSummary{}, fmt.Errorf("dynamics365 backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.Dynamics365Backfiller
	}
	if backfiller == nil {
		return Dynamics365BackfillSummary{}, fmt.Errorf("dynamics365 backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return Dynamics365BackfillSummary{}, err
	}
	if integration == nil {
		return Dynamics365BackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderDynamics365 {
		return Dynamics365BackfillSummary{}, fmt.Errorf("dynamics365 backfill requires a Dynamics365 CRM integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := Dynamics365BackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if crmIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor := cursor
	if retry, ok, err := decodeDynamics365RetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !dynamics365RetryCursorDue(retry, r.now()) {
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
		if current.Provider != ProviderDynamics365 {
			return summary, fmt.Errorf("dynamics365 backfill requires a Dynamics365 CRM integration")
		}
		if crmIntegrationDisconnected(current) {
			return summary, nil
		}
		integration = current
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := dynamics365BackfillRetryCursor(retryBaseCursor, "BACKFILL_FAILED", err, r.now())
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
			syncErr = crmSyncFailureError(ProviderDynamics365, pageSummary)
			retryCursor := dynamics365BackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", syncErr, r.now())
			req.Cursor = retryCursor
			pageSummary.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.LastError = syncErr.Error()
		}
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := dynamics365BackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if dynamics365SyncRequestHasPayload(req) {
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
		if !dynamics365SyncRequestHasPayload(req) || cursor == dynamics365CursorComplete {
			if cursor == dynamics365CursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r Dynamics365BackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
	started := r.now()
	completed := r.now()
	req := normalizeSyncRequest(SyncRequest{RunMode: "scheduled", Cursor: cursor})
	summary := SyncSummary{IntegrationID: integrationID, Status: "failed", Cursor: cursor, ErrorMessage: syncErr.Error()}
	_, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integrationID, summary, req, started, completed)
	return err
}

func (r Dynamics365BackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return dynamics365BulkBackfillDefaultMaxPages
	}
	if r.MaxPages > 100 {
		return 100
	}
	return r.MaxPages
}

func (r Dynamics365BackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

type Dynamics365BackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type Dynamics365BackfillWorkerStore interface {
	Store
	ListDynamics365BackfillTargets(context.Context, int, time.Time) ([]Dynamics365BackfillTarget, error)
}

type Dynamics365BackfillWorker struct {
	Deps           *Deps
	Store          Dynamics365BackfillWorkerStore
	Backfiller     Dynamics365Backfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type Dynamics365BackfillWorkerSummary struct {
	Targets          int
	Completed        int
	Failed           int
	Pages            int
	ContactsUpserted int
}

func (w *Dynamics365BackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = dynamics365BackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("dynamics365 backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("dynamics365 backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("dynamics365 backfill tick complete", "targets", summary.Targets, "completed", summary.Completed, "failed", summary.Failed, "pages", summary.Pages, "contacts_upserted", summary.ContactsUpserted)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *Dynamics365BackfillWorker) tick(ctx context.Context) (Dynamics365BackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return Dynamics365BackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = dynamics365BackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = dynamics365BackfillWorkerDefaultLimit
	}
	targets, err := store.ListDynamics365BackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return Dynamics365BackfillWorkerSummary{}, err
	}
	summary := Dynamics365BackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.Dynamics365Backfiller
	}
	if backfiller == nil {
		return summary, errors.New("dynamics365 backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := Dynamics365BackfillRunner{Deps: deps, Backfiller: backfiller, MaxPages: w.maxPagesPerRun(), Now: w.now}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("dynamics365 scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "err", err.Error())
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

func (w *Dynamics365BackfillWorker) storeAndDeps() (Dynamics365BackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("dynamics365 backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(Dynamics365BackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("dynamics365 backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *Dynamics365BackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *Dynamics365BackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return dynamics365BackfillWorkerDefaultMaxPages
	}
	return w.MaxPagesPerRun
}
