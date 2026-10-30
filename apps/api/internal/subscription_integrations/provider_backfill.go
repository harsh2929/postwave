// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

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
	subscriptionBackfillWorkerDefaultInterval       = 15 * time.Minute
	subscriptionBackfillWorkerDefaultDueAfter       = time.Hour
	subscriptionBackfillWorkerDefaultLimit          = 10
	subscriptionBackfillWorkerDefaultMaxPagesPerRun = 10
	subscriptionBackfillWorkerMaxCandidateScan      = 1000
	subscriptionBulkBackfillDefaultMaxPages         = 10
)

type SubscriptionBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type SubscriptionBackfillWorkerStore interface {
	Store
	ListSubscriptionBackfillTargets(context.Context, string, int, time.Time) ([]SubscriptionBackfillTarget, error)
}

type SubscriptionBackfillWorker struct {
	Provider       string
	Deps           *Deps
	Store          SubscriptionBackfillWorkerStore
	Backfiller     subscriptionBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type SubscriptionBackfillWorkerSummary struct {
	Provider              string
	Targets               int
	Completed             int
	Failed                int
	Pages                 int
	SubscriptionsSeen     int
	SubscriptionsUpserted int
	ShipmentsSeen         int
	ShipmentsUpserted     int
	EventsSeen            int
	EventsTracked         int
}

func (w *SubscriptionBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	provider := w.provider()
	if provider == "" {
		return errors.New("subscription backfill worker: provider is required")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = subscriptionBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info(provider+" subscription backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn(provider+" subscription backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info(provider+" subscription backfill tick complete",
				"provider", summary.Provider,
				"targets", summary.Targets,
				"completed", summary.Completed,
				"failed", summary.Failed,
				"pages", summary.Pages,
				"subscriptions_seen", summary.SubscriptionsSeen,
				"subscriptions_upserted", summary.SubscriptionsUpserted,
				"shipments_seen", summary.ShipmentsSeen,
				"shipments_upserted", summary.ShipmentsUpserted,
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

func (w *SubscriptionBackfillWorker) tick(ctx context.Context) (SubscriptionBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return SubscriptionBackfillWorkerSummary{}, err
	}
	provider := w.provider()
	if provider == "" {
		return SubscriptionBackfillWorkerSummary{}, errors.New("subscription backfill worker: provider is required")
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = subscriptionBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = subscriptionBackfillWorkerDefaultLimit
	}
	targets, err := store.ListSubscriptionBackfillTargets(ctx, provider, subscriptionBackfillWorkerCandidateLimit(limit), now.Add(-dueAfter))
	if err != nil {
		return SubscriptionBackfillWorkerSummary{}, err
	}
	summary := SubscriptionBackfillWorkerSummary{Provider: provider}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = subscriptionBackfillerForProvider(deps, provider)
	}
	if backfiller == nil {
		return summary, fmt.Errorf("%s subscription backfill worker: missing backfiller", provider)
	}
	for _, target := range targets {
		if summary.Targets >= limit {
			break
		}
		if subscriptionBackfillTargetRetryNotDue(provider, target.Cursor, now) {
			continue
		}
		summary.Targets++
		runner := SubscriptionBulkBackfillRunner{
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
				w.Logger.Warn(provider+" scheduled subscription backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.SubscriptionsSeen += out.SubscriptionsSeen
		summary.SubscriptionsUpserted += out.SubscriptionsUpserted
		summary.ShipmentsSeen += out.ShipmentsSeen
		summary.ShipmentsUpserted += out.ShipmentsUpserted
		summary.EventsSeen += out.EventsSeen
		summary.EventsTracked += out.EventsTracked
	}
	return summary, nil
}

func (w *SubscriptionBackfillWorker) storeAndDeps() (SubscriptionBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("subscription backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(SubscriptionBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("subscription backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *SubscriptionBackfillWorker) provider() string {
	if w == nil {
		return ""
	}
	return strings.TrimSpace(w.Provider)
}

func (w *SubscriptionBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *SubscriptionBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return subscriptionBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

func subscriptionBackfillWorkerCandidateLimit(limit int) int {
	if limit <= 0 {
		limit = subscriptionBackfillWorkerDefaultLimit
	}
	if limit >= subscriptionBackfillWorkerMaxCandidateScan {
		return limit
	}
	return subscriptionBackfillWorkerMaxCandidateScan
}

type subscriptionBackfiller interface {
	BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
}

type SubscriptionBulkBackfillRunner struct {
	Provider   string
	Deps       *Deps
	Backfiller subscriptionBackfiller
	MaxPages   int
	Now        func() time.Time
}

type SubscriptionBulkBackfillSummary struct {
	IntegrationID         string `json:"integration_id"`
	Provider              string `json:"provider"`
	Pages                 int    `json:"pages"`
	Complete              bool   `json:"complete"`
	SubscriptionsSeen     int    `json:"subscriptions_seen"`
	SubscriptionsUpserted int    `json:"subscriptions_upserted"`
	ShipmentsSeen         int    `json:"shipments_seen"`
	ShipmentsUpserted     int    `json:"shipments_upserted"`
	EventsSeen            int    `json:"events_seen"`
	EventsTracked         int    `json:"events_tracked"`
	Cursor                string `json:"cursor,omitempty"`
	LastError             string `json:"last_error,omitempty"`
	MaxPagesExhausted     bool   `json:"max_pages_exhausted,omitempty"`
}

func (r SubscriptionBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (SubscriptionBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return SubscriptionBulkBackfillSummary{}, fmt.Errorf("subscription bulk backfill deps are required")
	}
	provider := strings.TrimSpace(r.Provider)
	backfiller := r.Backfiller
	if backfiller == nil && provider != "" {
		backfiller = subscriptionBackfillerForProvider(r.Deps, provider)
	}
	if backfiller == nil {
		return SubscriptionBulkBackfillSummary{}, fmt.Errorf("subscription bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return SubscriptionBulkBackfillSummary{}, err
	}
	if integration == nil {
		return SubscriptionBulkBackfillSummary{}, ErrNotFound
	}
	if provider == "" {
		provider = integration.Provider
	}
	if integration.Provider != provider {
		return SubscriptionBulkBackfillSummary{}, fmt.Errorf("subscription bulk backfill requires a %s integration", provider)
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := SubscriptionBulkBackfillSummary{IntegrationID: integration.ID, Provider: provider, Cursor: cursor}
	if subscriptionIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor, effectiveCursor, deferred, err := subscriptionRetryCursorState(provider, cursor, r.now())
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
		current, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integration.ID)
		if err != nil {
			summary.LastError = err.Error()
			return summary, err
		}
		if current == nil {
			return summary, ErrNotFound
		}
		if subscriptionIntegrationDisconnected(current) {
			return summary, nil
		}
		integration = current
		if integration.Provider != provider {
			return summary, fmt.Errorf("subscription bulk backfill requires a %s integration", provider)
		}
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor, _ := subscriptionProviderRetryCursor(provider, retryBaseCursor, "BACKFILL_FAILED", err, r.now())
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
		syncFailed := subscriptionProviderPulledSyncFailed(req, pageSummary)
		var syncErr error
		if syncFailed {
			syncErr = subscriptionSyncFailureError(provider, pageSummary)
			retryCursor, _ := subscriptionProviderRetryCursor(provider, retryBaseCursor, "SYNC_FAILED", syncErr, r.now())
			pageSummary.Cursor = retryCursor
			req.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.LastError = syncErr.Error()
		}
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor, _ := subscriptionProviderRetryCursor(provider, retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if syncRequestHasRows(req) {
			summary.Pages++
		}
		summary.SubscriptionsSeen += pageSummary.SubscriptionsSeen
		summary.SubscriptionsUpserted += pageSummary.SubscriptionsUpserted
		summary.ShipmentsSeen += pageSummary.ShipmentsSeen
		summary.ShipmentsUpserted += pageSummary.ShipmentsUpserted
		summary.EventsSeen += pageSummary.EventsSeen
		summary.EventsTracked += pageSummary.EventsTracked
		if syncFailed {
			return summary, syncErr
		}
		cursor = firstString(pageSummary.Cursor, req.Cursor, cursor)
		retryBaseCursor = cursor
		summary.Cursor = cursor
		if !syncRequestHasRows(req) {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r SubscriptionBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r SubscriptionBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return subscriptionBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r SubscriptionBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

type subscriptionProviderRetryState struct {
	Cursor        string `json:"cursor"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

func subscriptionRetryCursorState(provider, cursor string, now time.Time) (string, string, bool, error) {
	cursor = strings.TrimSpace(cursor)
	retryBaseCursor := cursor
	switch provider {
	case ProviderRecharge:
		retry, ok, err := decodeRechargeRetryCursor(cursor)
		if err != nil || !ok {
			return retryBaseCursor, cursor, false, err
		}
		if !rechargeRetryCursorDue(retry, now) {
			return retryBaseCursor, cursor, true, nil
		}
		return retryBaseCursor, retry.Cursor, false, nil
	default:
		retry, ok, err := decodeSubscriptionProviderRetryCursor(provider, cursor)
		if err != nil || !ok {
			return retryBaseCursor, cursor, false, err
		}
		if !subscriptionProviderRetryCursorDue(retry, now) {
			return retryBaseCursor, cursor, true, nil
		}
		return retryBaseCursor, retry.Cursor, false, nil
	}
}

func subscriptionBackfillTargetRetryNotDue(provider, cursor string, now time.Time) bool {
	_, _, deferred, err := subscriptionRetryCursorState(provider, cursor, now)
	return err == nil && deferred
}

func subscriptionProviderRetryCursor(provider, cursor, status string, retryErr error, now time.Time) (string, bool) {
	switch provider {
	case ProviderRecharge:
		return rechargeBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderSkio, ProviderAfterShip, ProviderShipStation, ProviderChargebee,
		ProviderLoopSubscriptions, ProviderSealSubscriptions, ProviderAppstle, ProviderBoldSubscriptions:
		return encodeSubscriptionProviderRetryCursor(provider, subscriptionProviderRetryStateFromCursor(provider, cursor, status, retryErr, now)), true
	default:
		return "", false
	}
}

func subscriptionProviderRetryStateFromCursor(provider, cursor, status string, retryErr error, now time.Time) subscriptionProviderRetryState {
	state := subscriptionProviderRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeSubscriptionProviderRetryCursor(provider, cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(subscriptionProviderRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return normalizeSubscriptionProviderRetryState(state)
}

func decodeSubscriptionProviderRetryCursor(provider, cursor string) (subscriptionProviderRetryState, bool, error) {
	prefix, ok := subscriptionProviderRetryPrefix(provider)
	if !ok {
		return subscriptionProviderRetryState{}, false, nil
	}
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, prefix) {
		return subscriptionProviderRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, prefix))
	if err != nil {
		return subscriptionProviderRetryState{}, true, fmt.Errorf("decode %s retry cursor: %w", provider, err)
	}
	var state subscriptionProviderRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return subscriptionProviderRetryState{}, true, fmt.Errorf("parse %s retry cursor: %w", provider, err)
	}
	return normalizeSubscriptionProviderRetryState(state), true, nil
}

func encodeSubscriptionProviderRetryCursor(provider string, state subscriptionProviderRetryState) string {
	prefix, _ := subscriptionProviderRetryPrefix(provider)
	state = normalizeSubscriptionProviderRetryState(state)
	raw, _ := json.Marshal(state)
	return prefix + base64.RawURLEncoding.EncodeToString(raw)
}

func normalizeSubscriptionProviderRetryState(state subscriptionProviderRetryState) subscriptionProviderRetryState {
	state.Cursor = strings.TrimSpace(state.Cursor)
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = rechargeTruncate(strings.TrimSpace(state.LastError), 500)
	return state
}

func subscriptionProviderRetryCursorDue(state subscriptionProviderRetryState, now time.Time) bool {
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

func subscriptionProviderRetryDelay(attempt int, err error) time.Duration {
	var providerErr RechargeRESTError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > rechargeRetryMaxDelay {
			return rechargeRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return rechargeRetryInitialDelay
	}
	delay := rechargeRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= rechargeRetryMaxDelay {
			return rechargeRetryMaxDelay
		}
	}
	return delay
}

func subscriptionProviderRetryPrefix(provider string) (string, bool) {
	switch provider {
	case ProviderSkio, ProviderAfterShip, ProviderShipStation, ProviderChargebee,
		ProviderLoopSubscriptions, ProviderSealSubscriptions, ProviderAppstle, ProviderBoldSubscriptions:
		return strings.ReplaceAll(provider, "-", "_") + "_retry:", true
	default:
		return "", false
	}
}

func subscriptionBackfillerForProvider(d *Deps, provider string) subscriptionBackfiller {
	if d == nil {
		return nil
	}
	switch provider {
	case ProviderRecharge:
		return d.RechargeBackfiller
	case ProviderAfterShip:
		return d.AfterShipBackfiller
	case ProviderShipStation:
		return d.ShipStationBackfiller
	case ProviderSkio:
		return d.SkioBackfiller
	case ProviderChargebee:
		return d.ChargebeeBackfiller
	case ProviderLoopSubscriptions:
		return d.LoopSubscriptionsBackfiller
	case ProviderSealSubscriptions:
		return d.SealBackfiller
	case ProviderAppstle:
		return d.AppstleBackfiller
	case ProviderBoldSubscriptions:
		return d.BoldBackfiller
	default:
		return nil
	}
}

func subscriptionProviderPulledSyncFailed(req SyncRequest, summary SyncSummary) bool {
	return syncRequestHasRows(req) && strings.EqualFold(strings.TrimSpace(summary.Status), "failed")
}

func subscriptionSyncFailureError(provider string, summary SyncSummary) error {
	msg := strings.TrimSpace(summary.ErrorMessage)
	if msg == "" {
		msg = strings.TrimSpace(provider) + " subscription sync failed"
	}
	return errors.New(msg)
}
