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
	hubSpotRetryCursorPrefix             = "hubspot_retry:"
	hubSpotBulkBackfillDefaultMaxPages   = 10
	hubSpotRetryInitialDelay             = 15 * time.Minute
	hubSpotRetryMaxDelay                 = 6 * time.Hour
	hubSpotBackfillWorkerDefaultInterval = 15 * time.Minute
	hubSpotBackfillWorkerDefaultDueAfter = time.Hour
	hubSpotBackfillWorkerDefaultLimit    = 10
	hubSpotBackfillWorkerDefaultMaxPages = 10
)

// hubSpotRetryState is a durable scheduled-backfill retry cursor (`hubspot_retry:`).
type hubSpotRetryState struct {
	Cursor         string `json:"cursor"`
	Object         string `json:"object,omitempty"`
	ProviderCursor string `json:"provider_cursor,omitempty"`
	ListID         string `json:"list_id,omitempty"`
	Attempts       int    `json:"attempts,omitempty"`
	NextAttemptAt  string `json:"next_attempt_at,omitempty"`
	LastStatus     string `json:"last_status,omitempty"`
	LastError      string `json:"last_error,omitempty"`
}

func decodeHubSpotRetryCursor(cursor string) (hubSpotRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, hubSpotRetryCursorPrefix) {
		return hubSpotRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, hubSpotRetryCursorPrefix))
	if err != nil {
		return hubSpotRetryState{}, true, fmt.Errorf("decode HubSpot retry cursor: %w", err)
	}
	var state hubSpotRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return hubSpotRetryState{}, true, fmt.Errorf("parse HubSpot retry cursor: %w", err)
	}
	hubSpotNormalizeRetryState(&state)
	return state, true, nil
}

func encodeHubSpotRetryCursor(state hubSpotRetryState) string {
	hubSpotNormalizeRetryState(&state)
	raw, _ := json.Marshal(state)
	return hubSpotRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func hubSpotNormalizeRetryState(state *hubSpotRetryState) {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodeHubSpotCursor(hubSpotCursorState{Object: "contacts"})
	}
	if underlying, err := decodeHubSpotCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.ProviderCursor = underlying.After
		state.ListID = underlying.ListID
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateHubSpotString(strings.TrimSpace(state.LastError), 500)
}

func hubSpotRetryCursorDue(state hubSpotRetryState, now time.Time) bool {
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

func hubSpotBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := hubSpotRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeHubSpotRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(hubSpotRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeHubSpotRetryCursor(state)
}

func hubSpotRetryDelay(attempt int, err error) time.Duration {
	var rateErr HubSpotRateLimitError
	if err != nil && errors.As(err, &rateErr) && rateErr.RetryAfter > 0 {
		if rateErr.RetryAfter > hubSpotRetryMaxDelay {
			return hubSpotRetryMaxDelay
		}
		return rateErr.RetryAfter
	}
	if attempt <= 1 {
		return hubSpotRetryInitialDelay
	}
	delay := hubSpotRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= hubSpotRetryMaxDelay {
			return hubSpotRetryMaxDelay
		}
	}
	return delay
}

func hubSpotSyncRequestHasPayload(req SyncRequest) bool {
	return len(req.Contacts)+len(req.Events) > 0
}

// HubSpotBackfillRunner walks bounded contact pages for one integration and
// persists durable cursors, storing a `hubspot_retry:` cursor on failure.
type HubSpotBackfillRunner struct {
	Deps       *Deps
	Backfiller HubSpotBackfiller
	MaxPages   int
	Now        func() time.Time
}

type HubSpotBackfillSummary struct {
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

func (r HubSpotBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (HubSpotBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return HubSpotBackfillSummary{}, fmt.Errorf("hubspot backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.HubSpotBackfiller
	}
	if backfiller == nil {
		return HubSpotBackfillSummary{}, fmt.Errorf("hubspot backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return HubSpotBackfillSummary{}, err
	}
	if integration == nil {
		return HubSpotBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderHubSpot {
		return HubSpotBackfillSummary{}, fmt.Errorf("hubspot backfill requires a HubSpot integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := HubSpotBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if crmIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor := cursor
	if retry, ok, err := decodeHubSpotRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !hubSpotRetryCursorDue(retry, r.now()) {
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
			retryCursor := hubSpotBackfillRetryCursor(retryBaseCursor, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := hubSpotBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if hubSpotSyncRequestHasPayload(req) {
			summary.Pages++
		}
		summary.ContactsSeen += pageSummary.ContactsSeen
		summary.ContactsUpserted += pageSummary.ContactsUpserted
		summary.EventsSeen += pageSummary.EventsSeen
		summary.EventsTracked += pageSummary.EventsTracked
		cursor = firstString(pageSummary.Cursor, req.Cursor, cursor)
		retryBaseCursor = cursor
		summary.Cursor = cursor
		if !hubSpotSyncRequestHasPayload(req) || cursor == hubSpotCursorComplete {
			if cursor == hubSpotCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r HubSpotBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r HubSpotBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return hubSpotBulkBackfillDefaultMaxPages
	}
	if r.MaxPages > 100 {
		return 100
	}
	return r.MaxPages
}

func (r HubSpotBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

// HubSpotBackfillTarget is a due integration the scheduled worker should advance.
type HubSpotBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type HubSpotBackfillWorkerStore interface {
	Store
	ListHubSpotBackfillTargets(context.Context, int, time.Time) ([]HubSpotBackfillTarget, error)
}

type HubSpotBackfillWorker struct {
	Deps           *Deps
	Store          HubSpotBackfillWorkerStore
	Backfiller     HubSpotBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type HubSpotBackfillWorkerSummary struct {
	Targets          int
	Completed        int
	Failed           int
	Pages            int
	ContactsSeen     int
	ContactsUpserted int
	EventsSeen       int
	EventsTracked    int
}

func (w *HubSpotBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = hubSpotBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("hubspot backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("hubspot backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("hubspot backfill tick complete",
				"targets", summary.Targets, "completed", summary.Completed, "failed", summary.Failed,
				"pages", summary.Pages, "contacts_seen", summary.ContactsSeen, "contacts_upserted", summary.ContactsUpserted)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *HubSpotBackfillWorker) tick(ctx context.Context) (HubSpotBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return HubSpotBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = hubSpotBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = hubSpotBackfillWorkerDefaultLimit
	}
	targets, err := store.ListHubSpotBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return HubSpotBackfillWorkerSummary{}, err
	}
	summary := HubSpotBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.HubSpotBackfiller
	}
	if backfiller == nil {
		return summary, errors.New("hubspot backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := HubSpotBackfillRunner{Deps: deps, Backfiller: backfiller, MaxPages: w.maxPagesPerRun(), Now: w.now}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("hubspot scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.ContactsSeen += out.ContactsSeen
		summary.ContactsUpserted += out.ContactsUpserted
		summary.EventsSeen += out.EventsSeen
		summary.EventsTracked += out.EventsTracked
	}
	return summary, nil
}

func (w *HubSpotBackfillWorker) storeAndDeps() (HubSpotBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("hubspot backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(HubSpotBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("hubspot backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *HubSpotBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *HubSpotBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return hubSpotBackfillWorkerDefaultMaxPages
	}
	return w.MaxPagesPerRun
}
