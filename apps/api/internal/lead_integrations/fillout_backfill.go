// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	filloutRetryCursorPrefix           = "fillout_retry:"
	filloutBulkBackfillDefaultMaxPages = 10
	filloutRetryInitialDelay           = 15 * time.Minute
	filloutRetryMaxDelay               = 6 * time.Hour
)

type filloutRetryState struct {
	Cursor        string `json:"cursor"`
	Offset        int    `json:"offset,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type FilloutBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller FilloutBackfiller
	MaxPages   int
	Now        func() time.Time
}

type FilloutBulkBackfillSummary struct {
	IntegrationID       string `json:"integration_id"`
	Pages               int    `json:"pages"`
	Complete            bool   `json:"complete"`
	SubmissionsSeen     int    `json:"submissions_seen"`
	SubscribersUpserted int    `json:"subscribers_upserted"`
	EventsTracked       int    `json:"events_tracked"`
	Cursor              string `json:"cursor,omitempty"`
	LastError           string `json:"last_error,omitempty"`
	MaxPagesExhausted   bool   `json:"max_pages_exhausted,omitempty"`
}

func (r FilloutBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (FilloutBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return FilloutBulkBackfillSummary{}, fmt.Errorf("fillout bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.filloutBackfiller()
	}
	if backfiller == nil {
		return FilloutBulkBackfillSummary{}, fmt.Errorf("fillout bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return FilloutBulkBackfillSummary{}, err
	}
	if integration == nil {
		return FilloutBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderFillout {
		return FilloutBulkBackfillSummary{}, fmt.Errorf("fillout bulk backfill requires a Fillout integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := FilloutBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	if retry, ok, err := decodeFilloutRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !filloutRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := filloutBackfillRetryCursor(cursor, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := filloutBackfillRetryCursor(cursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if syncRequestHasSubmissions(req) {
			summary.Pages++
		}
		summary.SubmissionsSeen += pageSummary.SubmissionsSeen
		summary.SubscribersUpserted += pageSummary.SubscribersUpserted
		summary.EventsTracked += pageSummary.EventsTracked
		cursor = firstString(pageSummary.Cursor, req.Cursor, cursor)
		summary.Cursor = cursor
		if !syncRequestHasSubmissions(req) {
			if cursor == filloutCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r FilloutBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r FilloutBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return filloutBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r FilloutBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeFilloutRetryCursor(cursor string) (filloutRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, filloutRetryCursorPrefix) {
		return filloutRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, filloutRetryCursorPrefix))
	if err != nil {
		return filloutRetryState{}, true, fmt.Errorf("decode Fillout retry cursor: %w", err)
	}
	var state filloutRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return filloutRetryState{}, true, fmt.Errorf("parse Fillout retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeFilloutCursor(state.Cursor); err == nil {
			state.Offset = underlying.Offset
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeFilloutRetryCursor(state filloutRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeFilloutCursor(state.Cursor); err == nil {
			state.Offset = underlying.Offset
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return filloutRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func filloutRetryCursorDue(state filloutRetryState, now time.Time) bool {
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

func filloutBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := filloutRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeFilloutRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(filloutRetryDelay(state.Attempts)).Format(time.RFC3339)
	return encodeFilloutRetryCursor(state)
}

func filloutRetryDelay(attempt int) time.Duration {
	if attempt <= 1 {
		return filloutRetryInitialDelay
	}
	delay := filloutRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= filloutRetryMaxDelay {
			return filloutRetryMaxDelay
		}
	}
	return delay
}
