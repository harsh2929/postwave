// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

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
	loyaltyBackfillWorkerDefaultInterval       = 15 * time.Minute
	loyaltyBackfillWorkerDefaultDueAfter       = time.Hour
	loyaltyBackfillWorkerDefaultLimit          = 10
	loyaltyBackfillWorkerMaxCandidateScan      = 1000
	loyaltyBackfillWorkerDefaultMaxPagesPerRun = 10
	loyaltyBulkBackfillDefaultMaxPages         = 10
)

type LoyaltyBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type LoyaltyBackfillWorkerStore interface {
	Store
	ListLoyaltyBackfillTargets(context.Context, string, int, time.Time) ([]LoyaltyBackfillTarget, error)
}

type LoyaltyBackfillWorker struct {
	Provider       string
	Deps           *Deps
	Store          LoyaltyBackfillWorkerStore
	Backfiller     LoyaltyBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type LoyaltyBackfillWorkerSummary struct {
	Provider        string
	Targets         int
	Completed       int
	Failed          int
	Pages           int
	MembersSeen     int
	MembersUpserted int
	EventsSeen      int
	EventsTracked   int
}

func (w *LoyaltyBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	provider := w.provider()
	if provider == "" {
		return errors.New("loyalty backfill worker: provider is required")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = loyaltyBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info(provider+" loyalty backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn(provider+" loyalty backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info(provider+" loyalty backfill tick complete",
				"provider", summary.Provider,
				"targets", summary.Targets,
				"completed", summary.Completed,
				"failed", summary.Failed,
				"pages", summary.Pages,
				"members_seen", summary.MembersSeen,
				"members_upserted", summary.MembersUpserted,
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

func (w *LoyaltyBackfillWorker) tick(ctx context.Context) (LoyaltyBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return LoyaltyBackfillWorkerSummary{}, err
	}
	provider := w.provider()
	if provider == "" {
		return LoyaltyBackfillWorkerSummary{}, errors.New("loyalty backfill worker: provider is required")
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = loyaltyBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = loyaltyBackfillWorkerDefaultLimit
	}
	targets, err := store.ListLoyaltyBackfillTargets(ctx, provider, loyaltyBackfillWorkerCandidateLimit(limit), now.Add(-dueAfter))
	if err != nil {
		return LoyaltyBackfillWorkerSummary{}, err
	}
	summary := LoyaltyBackfillWorkerSummary{Provider: provider}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = loyaltyBackfillerForProvider(deps, provider)
	}
	if backfiller == nil {
		return summary, fmt.Errorf("%s loyalty backfill worker: missing backfiller", provider)
	}
	for _, target := range targets {
		if summary.Targets >= limit {
			break
		}
		if loyaltyBackfillTargetRetryNotDue(provider, target.Cursor, now) {
			continue
		}
		summary.Targets++
		runner := LoyaltyBulkBackfillRunner{
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
				w.Logger.Warn(provider+" scheduled loyalty backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.MembersSeen += out.MembersSeen
		summary.MembersUpserted += out.MembersUpserted
		summary.EventsSeen += out.EventsSeen
		summary.EventsTracked += out.EventsTracked
	}
	return summary, nil
}

func (w *LoyaltyBackfillWorker) storeAndDeps() (LoyaltyBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("loyalty backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(LoyaltyBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("loyalty backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *LoyaltyBackfillWorker) provider() string {
	if w == nil {
		return ""
	}
	return strings.TrimSpace(w.Provider)
}

func (w *LoyaltyBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *LoyaltyBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return loyaltyBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

func loyaltyBackfillWorkerCandidateLimit(limit int) int {
	if limit <= 0 {
		limit = loyaltyBackfillWorkerDefaultLimit
	}
	if limit >= loyaltyBackfillWorkerMaxCandidateScan {
		return limit
	}
	return loyaltyBackfillWorkerMaxCandidateScan
}

type LoyaltyBulkBackfillRunner struct {
	Provider   string
	Deps       *Deps
	Backfiller LoyaltyBackfiller
	MaxPages   int
	Now        func() time.Time
}

type LoyaltyBulkBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Provider          string `json:"provider"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	MembersSeen       int    `json:"members_seen"`
	MembersUpserted   int    `json:"members_upserted"`
	EventsSeen        int    `json:"events_seen"`
	EventsTracked     int    `json:"events_tracked"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r LoyaltyBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (LoyaltyBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return LoyaltyBulkBackfillSummary{}, fmt.Errorf("loyalty bulk backfill deps are required")
	}
	provider := strings.TrimSpace(r.Provider)
	backfiller := r.Backfiller
	if backfiller == nil && provider != "" {
		backfiller = loyaltyBackfillerForProvider(r.Deps, provider)
	}
	if backfiller == nil {
		return LoyaltyBulkBackfillSummary{}, fmt.Errorf("loyalty bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return LoyaltyBulkBackfillSummary{}, err
	}
	if integration == nil {
		return LoyaltyBulkBackfillSummary{}, ErrNotFound
	}
	if provider == "" {
		provider = integration.Provider
	}
	if integration.Provider != provider {
		return LoyaltyBulkBackfillSummary{}, fmt.Errorf("loyalty bulk backfill requires a %s integration", provider)
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := LoyaltyBulkBackfillSummary{IntegrationID: integration.ID, Provider: provider, Cursor: cursor}
	if loyaltyIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor, effectiveCursor, deferred, err := loyaltyRetryCursorState(provider, cursor, r.now())
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
		current, err := r.Deps.currentLoyaltyIntegrationForSync(ctx, tenantID, integration)
		if err != nil {
			if errors.Is(err, errIntegrationDisconnected) {
				return summary, nil
			}
			summary.LastError = err.Error()
			return summary, err
		}
		integration = current
		if integration.Provider != provider {
			return summary, fmt.Errorf("loyalty bulk backfill requires a %s integration", provider)
		}
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor, _ := loyaltyProviderRetryCursor(provider, retryBaseCursor, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = "scheduled"
		current, err = r.Deps.currentLoyaltyIntegrationForSync(ctx, tenantID, integration)
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
		syncFailed := loyaltyProviderPulledSyncFailed(req, pageSummary)
		var syncErr error
		if syncFailed {
			syncErr = loyaltySyncFailureError(provider, pageSummary)
			retryCursor, _ := loyaltyProviderRetryCursor(provider, retryBaseCursor, "SYNC_FAILED", syncErr, r.now())
			req.Cursor = retryCursor
			pageSummary.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.LastError = syncErr.Error()
		}
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor, _ := loyaltyProviderRetryCursor(provider, retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if syncRequestHasLoyaltyRows(req) {
			summary.Pages++
		}
		summary.MembersSeen += pageSummary.MembersSeen
		summary.MembersUpserted += pageSummary.MembersUpserted
		summary.EventsSeen += pageSummary.EventsSeen
		summary.EventsTracked += pageSummary.EventsTracked
		if syncFailed {
			return summary, syncErr
		}
		cursor = firstString(pageSummary.Cursor, req.Cursor, cursor)
		retryBaseCursor = cursor
		summary.Cursor = cursor
		if !syncRequestHasLoyaltyRows(req) {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r LoyaltyBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r LoyaltyBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return loyaltyBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r LoyaltyBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

type loyaltyProviderRetryState struct {
	Cursor        string `json:"cursor"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

func loyaltyRetryCursorState(provider, cursor string, now time.Time) (string, string, bool, error) {
	cursor = strings.TrimSpace(cursor)
	retryBaseCursor := cursor
	switch provider {
	case ProviderSmile:
		retry, ok, err := decodeSmileRetryCursor(cursor)
		if err != nil || !ok {
			return retryBaseCursor, cursor, false, err
		}
		if !smileRetryCursorDue(retry, now) {
			return retryBaseCursor, cursor, true, nil
		}
		return retryBaseCursor, retry.Cursor, false, nil
	default:
		retry, ok, err := decodeLoyaltyProviderRetryCursor(provider, cursor)
		if err != nil || !ok {
			return retryBaseCursor, cursor, false, err
		}
		if !loyaltyProviderRetryCursorDue(retry, now) {
			return retryBaseCursor, cursor, true, nil
		}
		return retryBaseCursor, retry.Cursor, false, nil
	}
}

func loyaltyBackfillTargetRetryNotDue(provider, cursor string, now time.Time) bool {
	_, _, deferred, err := loyaltyRetryCursorState(provider, cursor, now)
	return err == nil && deferred
}

func loyaltyProviderRetryCursor(provider, cursor, status string, retryErr error, now time.Time) (string, bool) {
	switch provider {
	case ProviderSmile:
		return smileBackfillRetryCursor(cursor, status, retryErr, now), true
	case ProviderLoyaltyLion, ProviderRivo, ProviderReferralCandy, ProviderFriendbuy:
		return encodeLoyaltyProviderRetryCursor(provider, loyaltyProviderRetryStateFromCursor(provider, cursor, status, retryErr, now)), true
	default:
		return "", false
	}
}

func loyaltyProviderRetryStateFromCursor(provider, cursor, status string, retryErr error, now time.Time) loyaltyProviderRetryState {
	state := loyaltyProviderRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeLoyaltyProviderRetryCursor(provider, cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(loyaltyProviderRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return normalizeLoyaltyProviderRetryState(state)
}

func decodeLoyaltyProviderRetryCursor(provider, cursor string) (loyaltyProviderRetryState, bool, error) {
	prefix, ok := loyaltyProviderRetryPrefix(provider)
	if !ok {
		return loyaltyProviderRetryState{}, false, nil
	}
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, prefix) {
		return loyaltyProviderRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, prefix))
	if err != nil {
		return loyaltyProviderRetryState{}, true, fmt.Errorf("decode %s retry cursor: %w", provider, err)
	}
	var state loyaltyProviderRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return loyaltyProviderRetryState{}, true, fmt.Errorf("parse %s retry cursor: %w", provider, err)
	}
	return normalizeLoyaltyProviderRetryState(state), true, nil
}

func encodeLoyaltyProviderRetryCursor(provider string, state loyaltyProviderRetryState) string {
	prefix, _ := loyaltyProviderRetryPrefix(provider)
	state = normalizeLoyaltyProviderRetryState(state)
	raw, _ := json.Marshal(state)
	return prefix + base64.RawURLEncoding.EncodeToString(raw)
}

func normalizeLoyaltyProviderRetryState(state loyaltyProviderRetryState) loyaltyProviderRetryState {
	state.Cursor = strings.TrimSpace(state.Cursor)
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = loyaltyTruncate(strings.TrimSpace(state.LastError), 500)
	return state
}

func loyaltyProviderRetryCursorDue(state loyaltyProviderRetryState, now time.Time) bool {
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

func loyaltyProviderRetryDelay(attempt int, err error) time.Duration {
	var providerErr LoyaltyRESTError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > smileRetryMaxDelay {
			return smileRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return smileRetryInitialDelay
	}
	delay := smileRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= smileRetryMaxDelay {
			return smileRetryMaxDelay
		}
	}
	return delay
}

func loyaltyProviderRetryPrefix(provider string) (string, bool) {
	switch provider {
	case ProviderLoyaltyLion, ProviderRivo, ProviderReferralCandy, ProviderFriendbuy:
		return strings.ReplaceAll(provider, "-", "_") + "_retry:", true
	default:
		return "", false
	}
}

func loyaltyBackfillerForProvider(d *Deps, provider string) LoyaltyBackfiller {
	if d == nil {
		return nil
	}
	switch provider {
	case ProviderSmile:
		return d.SmileBackfiller
	case ProviderLoyaltyLion:
		return d.LoyaltyLionBackfiller
	case ProviderRivo:
		return d.RivoBackfiller
	case ProviderReferralCandy:
		return d.ReferralCandyBackfiller
	case ProviderFriendbuy:
		return d.FriendbuyBackfiller
	default:
		return nil
	}
}

func loyaltyProviderPulledSyncFailed(req SyncRequest, summary SyncSummary) bool {
	return syncRequestHasLoyaltyRows(req) && strings.EqualFold(strings.TrimSpace(summary.Status), "failed")
}

func loyaltySyncFailureError(provider string, summary SyncSummary) error {
	msg := strings.TrimSpace(summary.ErrorMessage)
	if msg == "" {
		msg = strings.TrimSpace(provider) + " loyalty sync failed"
	}
	return errors.New(msg)
}
