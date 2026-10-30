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
	crmStaticBackfillWorkerDefaultInterval       = 15 * time.Minute
	crmStaticBackfillWorkerDefaultDueAfter       = time.Hour
	crmStaticBackfillWorkerDefaultLimit          = 10
	crmStaticBackfillWorkerMaxCandidateScan      = 1000
	crmStaticBackfillWorkerDefaultMaxPagesPerRun = 10
	crmStaticBulkBackfillDefaultMaxPages         = 10
	crmStaticRetryInitialDelay                   = 15 * time.Minute
	crmStaticRetryMaxDelay                       = 6 * time.Hour
)

type CRMStaticBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type CRMStaticBackfillWorkerStore interface {
	Store
	ListCRMStaticBackfillTargets(context.Context, string, int, time.Time) ([]CRMStaticBackfillTarget, error)
}

type CRMStaticBackfillWorker struct {
	Provider       string
	Deps           *Deps
	Store          CRMStaticBackfillWorkerStore
	Backfiller     crmStaticBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type CRMStaticBackfillWorkerSummary struct {
	Provider         string
	Targets          int
	Completed        int
	Failed           int
	Pages            int
	ContactsSeen     int
	ContactsUpserted int
	EventsSeen       int
	EventsTracked    int
}

func (w *CRMStaticBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	provider := w.provider()
	if provider == "" {
		return errors.New("static CRM backfill worker: provider is required")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = crmStaticBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info(provider+" CRM backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn(provider+" CRM backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info(provider+" CRM backfill tick complete",
				"provider", summary.Provider,
				"targets", summary.Targets,
				"completed", summary.Completed,
				"failed", summary.Failed,
				"pages", summary.Pages,
				"contacts_seen", summary.ContactsSeen,
				"contacts_upserted", summary.ContactsUpserted,
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

func (w *CRMStaticBackfillWorker) tick(ctx context.Context) (CRMStaticBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return CRMStaticBackfillWorkerSummary{}, err
	}
	provider := w.provider()
	if provider == "" {
		return CRMStaticBackfillWorkerSummary{}, errors.New("static CRM backfill worker: provider is required")
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = crmStaticBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = crmStaticBackfillWorkerDefaultLimit
	}
	targets, err := store.ListCRMStaticBackfillTargets(ctx, provider, crmStaticBackfillWorkerCandidateLimit(limit), now.Add(-dueAfter))
	if err != nil {
		return CRMStaticBackfillWorkerSummary{}, err
	}
	summary := CRMStaticBackfillWorkerSummary{Provider: provider}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = crmStaticBackfillerForProvider(deps, provider)
	}
	if backfiller == nil {
		return summary, fmt.Errorf("%s CRM backfill worker: missing backfiller", provider)
	}
	for _, target := range targets {
		if summary.Targets >= limit {
			break
		}
		if crmStaticBackfillTargetRetryNotDue(provider, target.Cursor, now) {
			continue
		}
		summary.Targets++
		runner := CRMStaticBulkBackfillRunner{
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
				w.Logger.Warn(provider+" scheduled CRM backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
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

func (w *CRMStaticBackfillWorker) storeAndDeps() (CRMStaticBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("static CRM backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(CRMStaticBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("static CRM backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *CRMStaticBackfillWorker) provider() string {
	if w == nil {
		return ""
	}
	return strings.TrimSpace(w.Provider)
}

func (w *CRMStaticBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *CRMStaticBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return crmStaticBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

func crmStaticBackfillWorkerCandidateLimit(limit int) int {
	if limit <= 0 {
		limit = crmStaticBackfillWorkerDefaultLimit
	}
	if limit >= crmStaticBackfillWorkerMaxCandidateScan {
		return limit
	}
	return crmStaticBackfillWorkerMaxCandidateScan
}

type crmStaticBackfiller interface {
	BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
}

type CRMStaticBulkBackfillRunner struct {
	Provider   string
	Deps       *Deps
	Backfiller crmStaticBackfiller
	MaxPages   int
	Now        func() time.Time
}

type CRMStaticBulkBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Provider          string `json:"provider"`
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

func (r CRMStaticBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (CRMStaticBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return CRMStaticBulkBackfillSummary{}, fmt.Errorf("static CRM bulk backfill deps are required")
	}
	provider := strings.TrimSpace(r.Provider)
	backfiller := r.Backfiller
	if backfiller == nil && provider != "" {
		backfiller = crmStaticBackfillerForProvider(r.Deps, provider)
	}
	if backfiller == nil {
		return CRMStaticBulkBackfillSummary{}, fmt.Errorf("static CRM bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return CRMStaticBulkBackfillSummary{}, err
	}
	if integration == nil {
		return CRMStaticBulkBackfillSummary{}, ErrNotFound
	}
	if provider == "" {
		provider = integration.Provider
	}
	if integration.Provider != provider {
		return CRMStaticBulkBackfillSummary{}, fmt.Errorf("static CRM bulk backfill requires a %s integration", provider)
	}
	if crmIntegrationDisconnected(integration) {
		return CRMStaticBulkBackfillSummary{IntegrationID: integration.ID, Provider: provider, Cursor: cursor}, nil
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := CRMStaticBulkBackfillSummary{IntegrationID: integration.ID, Provider: provider, Cursor: cursor}
	retryBaseCursor, effectiveCursor, deferred, err := crmStaticRetryCursorState(provider, cursor, r.now())
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
		current, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
		if err != nil {
			summary.LastError = err.Error()
			return summary, err
		}
		if current == nil {
			return summary, ErrNotFound
		}
		if current.Provider != provider {
			return summary, fmt.Errorf("static CRM bulk backfill requires a %s integration", provider)
		}
		if crmIntegrationDisconnected(current) {
			return summary, nil
		}
		integration = current
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor, _ := crmStaticBackfillRetryCursor(provider, retryBaseCursor, "BACKFILL_FAILED", err, r.now())
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
			syncErr = crmSyncFailureError(provider, pageSummary)
			retryCursor, _ := crmStaticBackfillRetryCursor(provider, retryBaseCursor, "SYNC_FAILED", syncErr, r.now())
			req.Cursor = retryCursor
			pageSummary.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.LastError = syncErr.Error()
		}
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor, _ := crmStaticBackfillRetryCursor(provider, retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if crmSyncRequestHasPayload(req) {
			summary.Pages++
		}
		summary.ContactsSeen += pageSummary.ContactsSeen
		summary.ContactsUpserted += pageSummary.ContactsUpserted
		summary.EventsSeen += pageSummary.EventsSeen
		summary.EventsTracked += pageSummary.EventsTracked
		if syncFailed {
			return summary, syncErr
		}
		cursor = firstString(pageSummary.Cursor, req.Cursor, cursor)
		retryBaseCursor = cursor
		summary.Cursor = cursor
		if !crmSyncRequestHasPayload(req) || crmStaticCursorComplete(provider, cursor) {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r CRMStaticBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r CRMStaticBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return crmStaticBulkBackfillDefaultMaxPages
	}
	if r.MaxPages > 100 {
		return 100
	}
	return r.MaxPages
}

func (r CRMStaticBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

type crmStaticRetryState struct {
	Cursor        string `json:"cursor"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

func crmStaticRetryCursorState(provider, cursor string, now time.Time) (string, string, bool, error) {
	cursor = strings.TrimSpace(cursor)
	retryBaseCursor := cursor
	retry, ok, err := decodeCRMStaticRetryCursor(provider, cursor)
	if err != nil || !ok {
		return retryBaseCursor, cursor, false, err
	}
	if !crmStaticRetryCursorDue(retry, now) {
		return retryBaseCursor, cursor, true, nil
	}
	return retryBaseCursor, retry.Cursor, false, nil
}

func crmStaticBackfillTargetRetryNotDue(provider, cursor string, now time.Time) bool {
	_, _, deferred, err := crmStaticRetryCursorState(provider, cursor, now)
	return err == nil && deferred
}

func crmStaticBackfillRetryCursor(provider, cursor, status string, retryErr error, now time.Time) (string, bool) {
	if _, ok := crmStaticRetryPrefix(provider); !ok {
		return "", false
	}
	return encodeCRMStaticRetryCursor(provider, crmStaticRetryStateFromCursor(provider, cursor, status, retryErr, now)), true
}

func crmStaticRetryStateFromCursor(provider, cursor, status string, retryErr error, now time.Time) crmStaticRetryState {
	state := crmStaticRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeCRMStaticRetryCursor(provider, cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(crmStaticRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return normalizeCRMStaticRetryState(state)
}

func decodeCRMStaticRetryCursor(provider, cursor string) (crmStaticRetryState, bool, error) {
	prefix, ok := crmStaticRetryPrefix(provider)
	if !ok {
		return crmStaticRetryState{}, false, nil
	}
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, prefix) {
		return crmStaticRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, prefix))
	if err != nil {
		return crmStaticRetryState{}, true, fmt.Errorf("decode %s retry cursor: %w", provider, err)
	}
	var state crmStaticRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return crmStaticRetryState{}, true, fmt.Errorf("parse %s retry cursor: %w", provider, err)
	}
	return normalizeCRMStaticRetryState(state), true, nil
}

func encodeCRMStaticRetryCursor(provider string, state crmStaticRetryState) string {
	prefix, _ := crmStaticRetryPrefix(provider)
	state = normalizeCRMStaticRetryState(state)
	raw, _ := json.Marshal(state)
	return prefix + base64.RawURLEncoding.EncodeToString(raw)
}

func normalizeCRMStaticRetryState(state crmStaticRetryState) crmStaticRetryState {
	state.Cursor = strings.TrimSpace(state.Cursor)
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateHubSpotString(strings.TrimSpace(state.LastError), 500)
	return state
}

func crmStaticRetryCursorDue(state crmStaticRetryState, now time.Time) bool {
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

func crmStaticRetryDelay(attempt int, err error) time.Duration {
	var restErr CRMStaticRESTError
	if err != nil && errors.As(err, &restErr) && restErr.RetryAfter > 0 {
		if restErr.RetryAfter > crmStaticRetryMaxDelay {
			return crmStaticRetryMaxDelay
		}
		return restErr.RetryAfter
	}
	if attempt <= 1 {
		return crmStaticRetryInitialDelay
	}
	delay := crmStaticRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= crmStaticRetryMaxDelay {
			return crmStaticRetryMaxDelay
		}
	}
	return delay
}

func crmStaticRetryPrefix(provider string) (string, bool) {
	switch provider {
	case ProviderClose, ProviderCopper, ProviderFreshsales:
		return strings.ReplaceAll(provider, "-", "_") + "_retry:", true
	default:
		return "", false
	}
}

func crmStaticBackfillerForProvider(d *Deps, provider string) crmStaticBackfiller {
	if d == nil {
		return nil
	}
	switch provider {
	case ProviderClose:
		return d.closeBackfiller()
	case ProviderCopper:
		return d.copperBackfiller()
	case ProviderFreshsales:
		return d.freshsalesBackfiller()
	default:
		return nil
	}
}

func crmSyncRequestHasPayload(req SyncRequest) bool {
	return len(req.Contacts)+len(req.Events) > 0
}

func crmProviderPulledSyncFailed(req SyncRequest, summary SyncSummary) bool {
	return crmSyncRequestHasPayload(req) && strings.EqualFold(strings.TrimSpace(summary.Status), "failed")
}

func crmSyncFailureError(provider string, summary SyncSummary) error {
	msg := strings.TrimSpace(summary.ErrorMessage)
	if msg == "" {
		msg = strings.TrimSpace(provider) + " CRM sync failed"
	}
	return errors.New(msg)
}

func crmStaticCursorComplete(provider, cursor string) bool {
	switch provider {
	case ProviderClose:
		return strings.TrimSpace(cursor) == closeCursorComplete
	case ProviderCopper:
		return strings.TrimSpace(cursor) == copperCursorComplete
	case ProviderFreshsales:
		return strings.TrimSpace(cursor) == freshsalesCursorComplete
	default:
		return false
	}
}
