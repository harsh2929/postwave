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
	salesforceRetryCursorPrefix             = "salesforce_retry:"
	salesforceBulkBackfillDefaultMaxPages   = 10
	salesforceRetryInitialDelay             = 15 * time.Minute
	salesforceRetryMaxDelay                 = 6 * time.Hour
	salesforceBackfillWorkerDefaultInterval = 15 * time.Minute
	salesforceBackfillWorkerDefaultDueAfter = time.Hour
	salesforceBackfillWorkerDefaultLimit    = 10
	salesforceBackfillWorkerDefaultMaxPages = 10
)

type salesforceRetryState struct {
	Cursor         string `json:"cursor"`
	Object         string `json:"object,omitempty"`
	ProviderCursor string `json:"provider_cursor,omitempty"`
	Attempts       int    `json:"attempts,omitempty"`
	NextAttemptAt  string `json:"next_attempt_at,omitempty"`
	LastStatus     string `json:"last_status,omitempty"`
	LastError      string `json:"last_error,omitempty"`
}

func decodeSalesforceRetryCursor(cursor string) (salesforceRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, salesforceRetryCursorPrefix) {
		return salesforceRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, salesforceRetryCursorPrefix))
	if err != nil {
		return salesforceRetryState{}, true, fmt.Errorf("decode Salesforce retry cursor: %w", err)
	}
	var state salesforceRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return salesforceRetryState{}, true, fmt.Errorf("parse Salesforce retry cursor: %w", err)
	}
	salesforceNormalizeRetryState(&state)
	return state, true, nil
}

func encodeSalesforceRetryCursor(state salesforceRetryState) string {
	salesforceNormalizeRetryState(&state)
	raw, _ := json.Marshal(state)
	return salesforceRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func salesforceNormalizeRetryState(state *salesforceRetryState) {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeSalesforceCursor(salesforceCursorState{Object: "contacts"})
	}
	if underlying, err := decodeSalesforceCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.ProviderCursor = underlying.NextRecordsURL
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateHubSpotString(strings.TrimSpace(state.LastError), 500)
}

func salesforceRetryCursorDue(state salesforceRetryState, now time.Time) bool {
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

func salesforceBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := salesforceRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeSalesforceRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(salesforceRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeSalesforceRetryCursor(state)
}

func salesforceRetryDelay(attempt int, err error) time.Duration {
	var restErr SalesforceRESTError
	if err != nil && errors.As(err, &restErr) && restErr.RetryAfter > 0 {
		if restErr.RetryAfter > salesforceRetryMaxDelay {
			return salesforceRetryMaxDelay
		}
		return restErr.RetryAfter
	}
	if attempt <= 1 {
		return salesforceRetryInitialDelay
	}
	delay := salesforceRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= salesforceRetryMaxDelay {
			return salesforceRetryMaxDelay
		}
	}
	return delay
}

func salesforceSyncRequestHasPayload(req SyncRequest) bool {
	return len(req.Contacts)+len(req.Events) > 0
}

// SalesforceBackfillRunner walks bounded SOQL pages for one integration and
// stores a `salesforce_retry:` cursor on failure.
type SalesforceBackfillRunner struct {
	Deps       *Deps
	Backfiller SalesforceBackfiller
	MaxPages   int
	Now        func() time.Time
}

type SalesforceBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	ContactsSeen      int    `json:"contacts_seen"`
	ContactsUpserted  int    `json:"contacts_upserted"`
	EventsSeen        int    `json:"events_seen"`
	EventsTracked     int    `json:"events_tracked"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r SalesforceBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (SalesforceBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return SalesforceBackfillSummary{}, fmt.Errorf("salesforce backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.SalesforceBackfiller
	}
	if backfiller == nil {
		return SalesforceBackfillSummary{}, fmt.Errorf("salesforce backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return SalesforceBackfillSummary{}, err
	}
	if integration == nil {
		return SalesforceBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderSalesforce {
		return SalesforceBackfillSummary{}, fmt.Errorf("salesforce backfill requires a Salesforce integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := SalesforceBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if crmIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor := cursor
	if retry, ok, err := decodeSalesforceRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !salesforceRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		retryBaseCursor = cursor
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := salesforceBackfillRetryCursor(retryBaseCursor, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = "scheduled"
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		started := r.now()
		pageSummary := r.Deps.executeSync(ctx, tenantID, integration, req)
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := salesforceBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if salesforceSyncRequestHasPayload(req) {
			summary.Pages++
		}
		summary.ContactsSeen += pageSummary.ContactsSeen
		summary.ContactsUpserted += pageSummary.ContactsUpserted
		summary.EventsSeen += pageSummary.EventsSeen
		summary.EventsTracked += pageSummary.EventsTracked
		cursor = firstString(pageSummary.Cursor, req.Cursor, cursor)
		retryBaseCursor = cursor
		summary.Cursor = cursor
		if !salesforceSyncRequestHasPayload(req) || cursor == salesforceCursorComplete {
			if cursor == salesforceCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r SalesforceBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r SalesforceBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return salesforceBulkBackfillDefaultMaxPages
	}
	if r.MaxPages > 100 {
		return 100
	}
	return r.MaxPages
}

func (r SalesforceBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

type SalesforceBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type SalesforceBackfillWorkerStore interface {
	Store
	ListSalesforceBackfillTargets(context.Context, int, time.Time) ([]SalesforceBackfillTarget, error)
}

type SalesforceBackfillWorker struct {
	Deps           *Deps
	Store          SalesforceBackfillWorkerStore
	Backfiller     SalesforceBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type SalesforceBackfillWorkerSummary struct {
	Targets          int
	Completed        int
	Failed           int
	Pages            int
	ContactsSeen     int
	ContactsUpserted int
}

func (w *SalesforceBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = salesforceBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("salesforce backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("salesforce backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("salesforce backfill tick complete",
				"targets", summary.Targets, "completed", summary.Completed, "failed", summary.Failed,
				"pages", summary.Pages, "contacts_upserted", summary.ContactsUpserted)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *SalesforceBackfillWorker) tick(ctx context.Context) (SalesforceBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return SalesforceBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = salesforceBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = salesforceBackfillWorkerDefaultLimit
	}
	targets, err := store.ListSalesforceBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return SalesforceBackfillWorkerSummary{}, err
	}
	summary := SalesforceBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.SalesforceBackfiller
	}
	if backfiller == nil {
		return summary, errors.New("salesforce backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := SalesforceBackfillRunner{Deps: deps, Backfiller: backfiller, MaxPages: w.maxPagesPerRun(), Now: w.now}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("salesforce scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.ContactsSeen += out.ContactsSeen
		summary.ContactsUpserted += out.ContactsUpserted
	}
	return summary, nil
}

func (w *SalesforceBackfillWorker) storeAndDeps() (SalesforceBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("salesforce backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(SalesforceBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("salesforce backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *SalesforceBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *SalesforceBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return salesforceBackfillWorkerDefaultMaxPages
	}
	return w.MaxPagesPerRun
}
