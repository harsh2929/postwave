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
	zohoRetryCursorPrefix             = "zoho_retry:"
	zohoBulkBackfillDefaultMaxPages   = 10
	zohoRetryInitialDelay             = 15 * time.Minute
	zohoRetryMaxDelay                 = 6 * time.Hour
	zohoBackfillWorkerDefaultInterval = 15 * time.Minute
	zohoBackfillWorkerDefaultDueAfter = time.Hour
	zohoBackfillWorkerDefaultLimit    = 10
	zohoBackfillWorkerDefaultMaxPages = 10
)

type zohoRetryState struct {
	Cursor        string `json:"cursor"`
	Object        string `json:"object,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

func decodeZohoRetryCursor(cursor string) (zohoRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, zohoRetryCursorPrefix) {
		return zohoRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, zohoRetryCursorPrefix))
	if err != nil {
		return zohoRetryState{}, true, fmt.Errorf("decode Zoho retry cursor: %w", err)
	}
	var state zohoRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return zohoRetryState{}, true, fmt.Errorf("parse Zoho retry cursor: %w", err)
	}
	zohoNormalizeRetryState(&state)
	return state, true, nil
}

func encodeZohoRetryCursor(state zohoRetryState) string {
	zohoNormalizeRetryState(&state)
	raw, _ := json.Marshal(state)
	return zohoRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func zohoNormalizeRetryState(state *zohoRetryState) {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeZohoCursor(zohoCursorState{Object: "contacts", Page: 1})
	}
	if underlying, err := decodeZohoCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateHubSpotString(strings.TrimSpace(state.LastError), 500)
}

func zohoRetryCursorDue(state zohoRetryState, now time.Time) bool {
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

func zohoBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := zohoRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeZohoRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(zohoRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeZohoRetryCursor(state)
}

func zohoRetryDelay(attempt int, err error) time.Duration {
	var restErr ZohoRESTError
	if err != nil && errors.As(err, &restErr) && restErr.RetryAfter > 0 {
		if restErr.RetryAfter > zohoRetryMaxDelay {
			return zohoRetryMaxDelay
		}
		return restErr.RetryAfter
	}
	if attempt <= 1 {
		return zohoRetryInitialDelay
	}
	delay := zohoRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= zohoRetryMaxDelay {
			return zohoRetryMaxDelay
		}
	}
	return delay
}

func zohoSyncRequestHasPayload(req SyncRequest) bool {
	return len(req.Contacts)+len(req.Events) > 0
}

type ZohoBackfillRunner struct {
	Deps       *Deps
	Backfiller ZohoBackfiller
	MaxPages   int
	Now        func() time.Time
}

type ZohoBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	ContactsSeen      int    `json:"contacts_seen"`
	ContactsUpserted  int    `json:"contacts_upserted"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r ZohoBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (ZohoBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return ZohoBackfillSummary{}, fmt.Errorf("zoho backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.ZohoBackfiller
	}
	if backfiller == nil {
		return ZohoBackfillSummary{}, fmt.Errorf("zoho backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return ZohoBackfillSummary{}, err
	}
	if integration == nil {
		return ZohoBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderZohoCRM {
		return ZohoBackfillSummary{}, fmt.Errorf("zoho backfill requires a Zoho CRM integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := ZohoBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if crmIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor := cursor
	if retry, ok, err := decodeZohoRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !zohoRetryCursorDue(retry, r.now()) {
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
		if current.Provider != ProviderZohoCRM {
			return summary, fmt.Errorf("zoho backfill requires a Zoho CRM integration")
		}
		if crmIntegrationDisconnected(current) {
			return summary, nil
		}
		integration = current
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := zohoBackfillRetryCursor(retryBaseCursor, "BACKFILL_FAILED", err, r.now())
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
			syncErr = crmSyncFailureError(ProviderZohoCRM, pageSummary)
			retryCursor := zohoBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", syncErr, r.now())
			req.Cursor = retryCursor
			pageSummary.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.LastError = syncErr.Error()
		}
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := zohoBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if zohoSyncRequestHasPayload(req) {
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
		if !zohoSyncRequestHasPayload(req) || cursor == zohoCursorComplete {
			if cursor == zohoCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r ZohoBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
	started := r.now()
	completed := r.now()
	req := normalizeSyncRequest(SyncRequest{RunMode: "scheduled", Cursor: cursor})
	summary := SyncSummary{IntegrationID: integrationID, Status: "failed", Cursor: cursor, ErrorMessage: syncErr.Error()}
	_, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integrationID, summary, req, started, completed)
	return err
}

func (r ZohoBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return zohoBulkBackfillDefaultMaxPages
	}
	if r.MaxPages > 100 {
		return 100
	}
	return r.MaxPages
}

func (r ZohoBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

type ZohoBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type ZohoBackfillWorkerStore interface {
	Store
	ListZohoBackfillTargets(context.Context, int, time.Time) ([]ZohoBackfillTarget, error)
}

type ZohoBackfillWorker struct {
	Deps           *Deps
	Store          ZohoBackfillWorkerStore
	Backfiller     ZohoBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type ZohoBackfillWorkerSummary struct {
	Targets          int
	Completed        int
	Failed           int
	Pages            int
	ContactsUpserted int
}

func (w *ZohoBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = zohoBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("zoho backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("zoho backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("zoho backfill tick complete", "targets", summary.Targets, "completed", summary.Completed, "failed", summary.Failed, "pages", summary.Pages, "contacts_upserted", summary.ContactsUpserted)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *ZohoBackfillWorker) tick(ctx context.Context) (ZohoBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return ZohoBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = zohoBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = zohoBackfillWorkerDefaultLimit
	}
	targets, err := store.ListZohoBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return ZohoBackfillWorkerSummary{}, err
	}
	summary := ZohoBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.ZohoBackfiller
	}
	if backfiller == nil {
		return summary, errors.New("zoho backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := ZohoBackfillRunner{Deps: deps, Backfiller: backfiller, MaxPages: w.maxPagesPerRun(), Now: w.now}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("zoho scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "err", err.Error())
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

func (w *ZohoBackfillWorker) storeAndDeps() (ZohoBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("zoho backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(ZohoBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("zoho backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *ZohoBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *ZohoBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return zohoBackfillWorkerDefaultMaxPages
	}
	return w.MaxPagesPerRun
}
