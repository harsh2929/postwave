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
	postscriptRetryCursorPrefix = "postscript_retry:"
	attentiveRetryCursorPrefix  = "attentive_retry:"

	smsBulkBackfillDefaultMaxPages         = 10
	smsRetryInitialDelay                   = 15 * time.Minute
	smsRetryMaxDelay                       = 6 * time.Hour
	smsBackfillWorkerDefaultInterval       = 15 * time.Minute
	smsBackfillWorkerDefaultDueAfter       = time.Hour
	smsBackfillWorkerDefaultLimit          = 10
	smsBackfillWorkerDefaultMaxPagesPerRun = 10
)

type smsBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type smsCursorConfig struct {
	Provider       string
	Label          string
	CursorPrefix   string
	CompleteCursor string
	RetryPrefix    string
}

func smsCursorConfigForProvider(provider string) (smsCursorConfig, bool) {
	switch strings.TrimSpace(provider) {
	case ProviderPostscript:
		return smsCursorConfig{
			Provider:       ProviderPostscript,
			Label:          "postscript",
			CursorPrefix:   postscriptCursorPrefix,
			CompleteCursor: postscriptCursorComplete,
			RetryPrefix:    postscriptRetryCursorPrefix,
		}, true
	case ProviderAttentive:
		return smsCursorConfig{
			Provider:       ProviderAttentive,
			Label:          "attentive",
			CursorPrefix:   attentiveCursorPrefix,
			CompleteCursor: attentiveCursorComplete,
			RetryPrefix:    attentiveRetryCursorPrefix,
		}, true
	default:
		return smsCursorConfig{}, false
	}
}

type smsRetryState struct {
	Cursor         string `json:"cursor"`
	ProviderCursor string `json:"provider_cursor,omitempty"`
	Attempts       int    `json:"attempts,omitempty"`
	NextAttemptAt  string `json:"next_attempt_at,omitempty"`
	LastStatus     string `json:"last_status,omitempty"`
	LastError      string `json:"last_error,omitempty"`
}

func decodeSMSRetryCursorForProvider(provider, cursor string) (smsRetryState, bool, error) {
	cfg, ok := smsCursorConfigForProvider(provider)
	if !ok {
		return smsRetryState{}, false, nil
	}
	return decodeSMSRetryCursor(cursor, cfg)
}

func decodePostscriptRetryCursor(cursor string) (smsRetryState, bool, error) {
	cfg, _ := smsCursorConfigForProvider(ProviderPostscript)
	return decodeSMSRetryCursor(cursor, cfg)
}

func decodeAttentiveRetryCursor(cursor string) (smsRetryState, bool, error) {
	cfg, _ := smsCursorConfigForProvider(ProviderAttentive)
	return decodeSMSRetryCursor(cursor, cfg)
}

func decodeSMSRetryCursor(cursor string, cfg smsCursorConfig) (smsRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, cfg.RetryPrefix) {
		return smsRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, cfg.RetryPrefix))
	if err != nil {
		return smsRetryState{}, true, fmt.Errorf("decode %s retry cursor: %w", cfg.Label, err)
	}
	var state smsRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return smsRetryState{}, true, fmt.Errorf("parse %s retry cursor: %w", cfg.Label, err)
	}
	smsNormalizeRetryState(&state, cfg)
	return state, true, nil
}

func encodeSMSRetryCursor(state smsRetryState, cfg smsCursorConfig) string {
	smsNormalizeRetryState(&state, cfg)
	raw, _ := json.Marshal(state)
	return cfg.RetryPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func smsNormalizeRetryState(state *smsRetryState, cfg smsCursorConfig) {
	state.Cursor = strings.TrimSpace(state.Cursor)
	state.ProviderCursor = smsDecodeCursor(state.Cursor, cfg.CursorPrefix, cfg.CompleteCursor)
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateSMSString(strings.TrimSpace(state.LastError), 500)
}

func smsRetryCursorDue(state smsRetryState, now time.Time) bool {
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

func smsBackfillRetryCursor(provider, cursor, status string, retryErr error, now time.Time) (string, bool) {
	cfg, ok := smsCursorConfigForProvider(provider)
	if !ok {
		return "", false
	}
	state := smsRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeSMSRetryCursor(cursor, cfg); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(smsRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeSMSRetryCursor(state, cfg), true
}

func smsRetryDelay(attempt int, err error) time.Duration {
	var restErr CRMStaticRESTError
	if err != nil && errors.As(err, &restErr) && restErr.RetryAfter > 0 {
		if restErr.RetryAfter > smsRetryMaxDelay {
			return smsRetryMaxDelay
		}
		return restErr.RetryAfter
	}
	if attempt <= 1 {
		return smsRetryInitialDelay
	}
	delay := smsRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= smsRetryMaxDelay {
			return smsRetryMaxDelay
		}
	}
	return delay
}

func smsSyncRequestHasPayload(req SyncRequest) bool {
	return len(req.Contacts)+len(req.Events) > 0
}

type SMSBackfillSummary struct {
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

type PostscriptBackfillRunner struct {
	Deps       *Deps
	Backfiller PostscriptBackfiller
	MaxPages   int
	Now        func() time.Time
}

func (r PostscriptBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (SMSBackfillSummary, error) {
	var backfiller smsBackfiller
	if r.Backfiller != nil {
		backfiller = r.Backfiller
	} else if r.Deps != nil {
		backfiller = r.Deps.postscriptBackfiller()
	}
	return runSMSBackfill(ctx, ProviderPostscript, r.Deps, backfiller, r.MaxPages, r.Now, tenantID, integrationID, cursor)
}

type AttentiveBackfillRunner struct {
	Deps       *Deps
	Backfiller AttentiveBackfiller
	MaxPages   int
	Now        func() time.Time
}

func (r AttentiveBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (SMSBackfillSummary, error) {
	var backfiller smsBackfiller
	if r.Backfiller != nil {
		backfiller = r.Backfiller
	} else if r.Deps != nil {
		backfiller = r.Deps.attentiveBackfiller()
	}
	return runSMSBackfill(ctx, ProviderAttentive, r.Deps, backfiller, r.MaxPages, r.Now, tenantID, integrationID, cursor)
}

func runSMSBackfill(ctx context.Context, provider string, deps *Deps, backfiller smsBackfiller, maxPages int, nowFunc func() time.Time, tenantID, integrationID, cursor string) (SMSBackfillSummary, error) {
	cfg, ok := smsCursorConfigForProvider(provider)
	if !ok {
		return SMSBackfillSummary{}, fmt.Errorf("unsupported SMS provider %q", provider)
	}
	if deps == nil || deps.Repo == nil {
		return SMSBackfillSummary{}, fmt.Errorf("%s backfill deps are required", cfg.Label)
	}
	if backfiller == nil {
		return SMSBackfillSummary{}, fmt.Errorf("%s backfiller is required", cfg.Label)
	}
	integration, err := deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return SMSBackfillSummary{}, err
	}
	if integration == nil {
		return SMSBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != provider {
		return SMSBackfillSummary{}, fmt.Errorf("%s backfill requires a %s integration", cfg.Label, cfg.Label)
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := SMSBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if crmIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor := cursor
	if retry, ok, err := decodeSMSRetryCursor(cursor, cfg); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !smsRetryCursorDue(retry, smsNow(deps, nowFunc)) {
			return summary, nil
		}
		retryBaseCursor = cursor
		cursor = retry.Cursor
	}
	for summary.Pages < smsMaxPages(maxPages) {
		current, err := deps.Repo.GetIntegration(ctx, tenantID, integrationID)
		if err != nil {
			summary.LastError = err.Error()
			return summary, err
		}
		if current == nil {
			return summary, ErrNotFound
		}
		if current.Provider != provider {
			return summary, fmt.Errorf("%s backfill requires a %s integration", cfg.Label, cfg.Label)
		}
		if crmIntegrationDisconnected(current) {
			return summary, nil
		}
		integration = current
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor, _ := smsBackfillRetryCursor(provider, retryBaseCursor, "BACKFILL_FAILED", err, smsNow(deps, nowFunc))
			summary.Cursor = retryCursor
			_ = recordSMSBackfillFailure(ctx, deps, tenantID, integration.ID, retryCursor, err, nowFunc)
			return summary, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = "scheduled"
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		current, err = deps.Repo.GetIntegration(ctx, tenantID, integrationID)
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
		started := smsNow(deps, nowFunc)
		pageSummary := deps.executeSync(ctx, tenantID, integration, req)
		completed := smsNow(deps, nowFunc)
		run, err := deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor, _ := smsBackfillRetryCursor(provider, retryBaseCursor, "SYNC_FAILED", err, smsNow(deps, nowFunc))
			summary.Cursor = retryCursor
			_ = recordSMSBackfillFailure(ctx, deps, tenantID, integration.ID, retryCursor, err, nowFunc)
			return summary, err
		}
		pageSummary.RunID = run.ID
		summary.Pages++
		summary.ContactsSeen += pageSummary.ContactsSeen
		summary.ContactsUpserted += pageSummary.ContactsUpserted
		summary.EventsSeen += pageSummary.EventsSeen
		summary.EventsTracked += pageSummary.EventsTracked
		cursor = firstString(pageSummary.Cursor, req.Cursor, cursor)
		retryBaseCursor = cursor
		summary.Cursor = cursor
		if cursor == cfg.CompleteCursor {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func recordSMSBackfillFailure(ctx context.Context, deps *Deps, tenantID, integrationID, cursor string, syncErr error, nowFunc func() time.Time) error {
	started := smsNow(deps, nowFunc)
	completed := smsNow(deps, nowFunc)
	req := normalizeSyncRequest(SyncRequest{RunMode: "scheduled", Cursor: cursor})
	summary := SyncSummary{
		IntegrationID: integrationID,
		Status:        "failed",
		Cursor:        cursor,
		ErrorMessage:  syncErr.Error(),
	}
	_, err := deps.Repo.RecordSyncRun(ctx, tenantID, integrationID, summary, req, started, completed)
	return err
}

func smsMaxPages(maxPages int) int {
	if maxPages <= 0 {
		return smsBulkBackfillDefaultMaxPages
	}
	if maxPages > 100 {
		return 100
	}
	return maxPages
}

func smsNow(deps *Deps, nowFunc func() time.Time) time.Time {
	if nowFunc != nil {
		return nowFunc().UTC()
	}
	if deps != nil && deps.Now != nil {
		return deps.Now().UTC()
	}
	return time.Now().UTC()
}

type SMSBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type SMSBackfillWorkerSummary struct {
	Targets          int
	Completed        int
	Failed           int
	Pages            int
	ContactsSeen     int
	ContactsUpserted int
	EventsSeen       int
	EventsTracked    int
}

type PostscriptBackfillWorkerStore interface {
	Store
	ListPostscriptBackfillTargets(context.Context, int, time.Time) ([]SMSBackfillTarget, error)
}

type PostscriptBackfillWorker struct {
	Deps           *Deps
	Store          PostscriptBackfillWorkerStore
	Backfiller     PostscriptBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

func (w *PostscriptBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = smsBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("postscript backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("postscript backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("postscript backfill tick complete", "targets", summary.Targets, "completed", summary.Completed, "failed", summary.Failed, "pages", summary.Pages, "contacts_seen", summary.ContactsSeen, "contacts_upserted", summary.ContactsUpserted)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *PostscriptBackfillWorker) tick(ctx context.Context) (SMSBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return SMSBackfillWorkerSummary{}, err
	}
	targets, err := store.ListPostscriptBackfillTargets(ctx, w.limit(), w.now().Add(-w.dueAfter()))
	if err != nil {
		return SMSBackfillWorkerSummary{}, err
	}
	summary := SMSBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.postscriptBackfiller()
	}
	if backfiller == nil {
		return summary, errors.New("postscript backfill worker: missing backfiller")
	}
	for _, target := range targets {
		out, err := (PostscriptBackfillRunner{Deps: deps, Backfiller: backfiller, MaxPages: w.maxPagesPerRun(), Now: w.now}).Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("postscript scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "err", err.Error())
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

func (w *PostscriptBackfillWorker) storeAndDeps() (PostscriptBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("postscript backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(PostscriptBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("postscript backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *PostscriptBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *PostscriptBackfillWorker) dueAfter() time.Duration {
	if w.DueAfter <= 0 {
		return smsBackfillWorkerDefaultDueAfter
	}
	return w.DueAfter
}

func (w *PostscriptBackfillWorker) limit() int {
	if w.Limit <= 0 {
		return smsBackfillWorkerDefaultLimit
	}
	return w.Limit
}

func (w *PostscriptBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return smsBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

type AttentiveBackfillWorkerStore interface {
	Store
	ListAttentiveBackfillTargets(context.Context, int, time.Time) ([]SMSBackfillTarget, error)
}

type AttentiveBackfillWorker struct {
	Deps           *Deps
	Store          AttentiveBackfillWorkerStore
	Backfiller     AttentiveBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

func (w *AttentiveBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = smsBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("attentive backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("attentive backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("attentive backfill tick complete", "targets", summary.Targets, "completed", summary.Completed, "failed", summary.Failed, "pages", summary.Pages, "contacts_seen", summary.ContactsSeen, "contacts_upserted", summary.ContactsUpserted)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *AttentiveBackfillWorker) tick(ctx context.Context) (SMSBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return SMSBackfillWorkerSummary{}, err
	}
	targets, err := store.ListAttentiveBackfillTargets(ctx, w.limit(), w.now().Add(-w.dueAfter()))
	if err != nil {
		return SMSBackfillWorkerSummary{}, err
	}
	summary := SMSBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.attentiveBackfiller()
	}
	if backfiller == nil {
		return summary, errors.New("attentive backfill worker: missing backfiller")
	}
	for _, target := range targets {
		out, err := (AttentiveBackfillRunner{Deps: deps, Backfiller: backfiller, MaxPages: w.maxPagesPerRun(), Now: w.now}).Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("attentive scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "err", err.Error())
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

func (w *AttentiveBackfillWorker) storeAndDeps() (AttentiveBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("attentive backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(AttentiveBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("attentive backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *AttentiveBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *AttentiveBackfillWorker) dueAfter() time.Duration {
	if w.DueAfter <= 0 {
		return smsBackfillWorkerDefaultDueAfter
	}
	return w.DueAfter
}

func (w *AttentiveBackfillWorker) limit() int {
	if w.Limit <= 0 {
		return smsBackfillWorkerDefaultLimit
	}
	return w.Limit
}

func (w *AttentiveBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return smsBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

func truncateSMSString(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit]
}
