// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	pipedriveRetryCursorPrefix           = "pipedrive_retry:"
	pipedriveBulkBackfillDefaultMaxPages = 10
	pipedriveRetryInitialDelay           = 15 * time.Minute
	pipedriveRetryMaxDelay               = 6 * time.Hour
)

type pipedriveRetryState struct {
	Cursor         string `json:"cursor"`
	Object         string `json:"object,omitempty"`
	ProviderCursor string `json:"provider_cursor,omitempty"`
	Attempts       int    `json:"attempts,omitempty"`
	NextAttemptAt  string `json:"next_attempt_at,omitempty"`
	LastStatus     string `json:"last_status,omitempty"`
	LastError      string `json:"last_error,omitempty"`
}

type PipedriveBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller PipedriveBackfiller
	MaxPages   int
	Now        func() time.Time
}

type PipedriveBulkBackfillSummary struct {
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

func (r PipedriveBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (PipedriveBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return PipedriveBulkBackfillSummary{}, fmt.Errorf("pipedrive bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.pipedriveBackfiller()
	}
	if backfiller == nil {
		return PipedriveBulkBackfillSummary{}, fmt.Errorf("pipedrive bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return PipedriveBulkBackfillSummary{}, err
	}
	if integration == nil {
		return PipedriveBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderPipedrive {
		return PipedriveBulkBackfillSummary{}, fmt.Errorf("pipedrive bulk backfill requires a Pipedrive integration")
	}
	if crmIntegrationDisconnected(integration) {
		return PipedriveBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}, nil
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := PipedriveBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	retryBaseCursor := cursor
	if retry, ok, err := decodePipedriveRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !pipedriveRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		retryBaseCursor = cursor
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		current, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
		if err != nil {
			return summary, err
		}
		if current == nil {
			return summary, ErrNotFound
		}
		if current.Provider != ProviderPipedrive {
			return summary, fmt.Errorf("pipedrive bulk backfill requires a Pipedrive integration")
		}
		if crmIntegrationDisconnected(current) {
			return summary, nil
		}
		integration = current
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := pipedriveBackfillRetryCursor(retryBaseCursor, "BACKFILL_FAILED", err, r.now())
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
		syncFailed := pipedriveProviderPulledSyncFailed(req, pageSummary)
		var syncErr error
		if syncFailed {
			syncErr = pipedriveSyncFailureError(pageSummary)
			retryCursor := pipedriveBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", syncErr, r.now())
			req.Cursor = retryCursor
			pageSummary.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.LastError = syncErr.Error()
		}
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := pipedriveBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if pipedriveSyncRequestHasPayload(req) {
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
		if !pipedriveSyncRequestHasPayload(req) {
			if cursor == pipedriveCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
		if cursor == pipedriveCursorComplete {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r PipedriveBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r PipedriveBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return pipedriveBulkBackfillDefaultMaxPages
	}
	if r.MaxPages > 100 {
		return 100
	}
	return r.MaxPages
}

func (r PipedriveBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func pipedriveSyncRequestHasPayload(req SyncRequest) bool {
	return len(req.Contacts)+len(req.Events) > 0
}

func pipedriveProviderPulledSyncFailed(req SyncRequest, summary SyncSummary) bool {
	return pipedriveSyncRequestHasPayload(req) && strings.EqualFold(strings.TrimSpace(summary.Status), "failed")
}

func pipedriveSyncFailureError(summary SyncSummary) error {
	msg := strings.TrimSpace(summary.ErrorMessage)
	if msg == "" {
		msg = "pipedrive sync failed"
	}
	return errors.New(msg)
}

func decodePipedriveRetryCursor(cursor string) (pipedriveRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, pipedriveRetryCursorPrefix) {
		return pipedriveRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, pipedriveRetryCursorPrefix))
	if err != nil {
		return pipedriveRetryState{}, true, fmt.Errorf("decode Pipedrive retry cursor: %w", err)
	}
	var state pipedriveRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return pipedriveRetryState{}, true, fmt.Errorf("parse Pipedrive retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodePipedriveCursor(pipedriveCursorState{Object: "persons"})
	}
	if underlying, err := decodePipedriveCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.ProviderCursor = underlying.Cursor
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncatePipedriveString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodePipedriveRetryCursor(state pipedriveRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor == "" {
		state.Cursor = encodePipedriveCursor(pipedriveCursorState{Object: "persons"})
	}
	if underlying, err := decodePipedriveCursor(state.Cursor); err == nil {
		state.Object = underlying.Object
		state.ProviderCursor = underlying.Cursor
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncatePipedriveString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return pipedriveRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func pipedriveRetryCursorDue(state pipedriveRetryState, now time.Time) bool {
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

func pipedriveBackfillTargetRetryNotDue(cursor string, now time.Time) bool {
	if !strings.HasPrefix(strings.TrimSpace(cursor), pipedriveRetryCursorPrefix) {
		return false
	}
	retry, ok, err := decodePipedriveRetryCursor(cursor)
	if err != nil || !ok {
		return false
	}
	return !pipedriveRetryCursorDue(retry, now)
}

func pipedriveBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := pipedriveRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodePipedriveRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(pipedriveRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodePipedriveRetryCursor(state)
}

func pipedriveRetryDelay(attempt int, err error) time.Duration {
	var restErr PipedriveRESTError
	if err != nil && errors.As(err, &restErr) && restErr.RetryAfter > 0 {
		if restErr.RetryAfter > pipedriveRetryMaxDelay {
			return pipedriveRetryMaxDelay
		}
		return restErr.RetryAfter
	}
	if attempt <= 1 {
		return pipedriveRetryInitialDelay
	}
	delay := pipedriveRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= pipedriveRetryMaxDelay {
			return pipedriveRetryMaxDelay
		}
	}
	return delay
}

func truncatePipedriveString(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit]
}
