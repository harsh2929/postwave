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
	jotformRetryCursorPrefix           = "jotform_retry:"
	jotformBulkBackfillDefaultMaxPages = 10
	jotformRetryInitialDelay           = 15 * time.Minute
	jotformRetryMaxDelay               = 6 * time.Hour
)

type jotformRetryState struct {
	Cursor        string `json:"cursor"`
	Offset        int    `json:"offset,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type JotformBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller JotformBackfiller
	MaxPages   int
	Now        func() time.Time
}

type JotformBulkBackfillSummary struct {
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

func (r JotformBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (JotformBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return JotformBulkBackfillSummary{}, fmt.Errorf("jotform bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.jotformBackfiller()
	}
	if backfiller == nil {
		return JotformBulkBackfillSummary{}, fmt.Errorf("jotform bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return JotformBulkBackfillSummary{}, err
	}
	if integration == nil {
		return JotformBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderJotform {
		return JotformBulkBackfillSummary{}, fmt.Errorf("jotform bulk backfill requires a Jotform integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := JotformBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	if retry, ok, err := decodeJotformRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !jotformRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := jotformBackfillRetryCursor(cursor, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := jotformBackfillRetryCursor(cursor, "SYNC_FAILED", err, r.now())
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
			if cursor == jotformCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r JotformBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r JotformBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return jotformBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r JotformBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeJotformRetryCursor(cursor string) (jotformRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, jotformRetryCursorPrefix) {
		return jotformRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, jotformRetryCursorPrefix))
	if err != nil {
		return jotformRetryState{}, true, fmt.Errorf("decode Jotform retry cursor: %w", err)
	}
	var state jotformRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return jotformRetryState{}, true, fmt.Errorf("parse Jotform retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeJotformCursor(state.Cursor); err == nil {
			state.Offset = underlying.Offset
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeJotformRetryCursor(state jotformRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeJotformCursor(state.Cursor); err == nil {
			state.Offset = underlying.Offset
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return jotformRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func jotformRetryCursorDue(state jotformRetryState, now time.Time) bool {
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

func jotformBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := jotformRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeJotformRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(jotformRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeJotformRetryCursor(state)
}

func jotformRetryDelay(attempt int, _ error) time.Duration {
	if attempt <= 1 {
		return jotformRetryInitialDelay
	}
	delay := jotformRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= jotformRetryMaxDelay {
			return jotformRetryMaxDelay
		}
	}
	return delay
}
