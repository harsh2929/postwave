// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

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
	webflowRetryCursorPrefix           = "webflow_retry:"
	webflowBulkBackfillDefaultMaxPages = 10
	webflowRetryInitialDelay           = 15 * time.Minute
	webflowRetryMaxDelay               = 6 * time.Hour
)

type webflowRetryState struct {
	Cursor        string `json:"cursor"`
	Offset        int    `json:"offset,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type WebflowBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller WebflowBackfiller
	MaxPages   int
	Now        func() time.Time
}

type WebflowBulkBackfillSummary struct {
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

func (r WebflowBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (WebflowBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return WebflowBulkBackfillSummary{}, fmt.Errorf("webflow bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.webflowBackfiller()
	}
	if backfiller == nil {
		return WebflowBulkBackfillSummary{}, fmt.Errorf("webflow bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return WebflowBulkBackfillSummary{}, err
	}
	if integration == nil {
		return WebflowBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderWebflow {
		return WebflowBulkBackfillSummary{}, fmt.Errorf("webflow bulk backfill requires a Webflow integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := WebflowBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeWebflowRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !webflowRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := webflowBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := webflowBackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
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
		retryCursorBase = cursor
		if !syncRequestHasSubmissions(req) {
			if cursor == webflowCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r WebflowBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r WebflowBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return webflowBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r WebflowBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeWebflowRetryCursor(cursor string) (webflowRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, webflowRetryCursorPrefix) {
		return webflowRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, webflowRetryCursorPrefix))
	if err != nil {
		return webflowRetryState{}, true, fmt.Errorf("decode Webflow retry cursor: %w", err)
	}
	var state webflowRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return webflowRetryState{}, true, fmt.Errorf("parse Webflow retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeWebflowCursor(state.Cursor); err == nil {
			state.Offset = underlying.Offset
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeWebflowRetryCursor(state webflowRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeWebflowCursor(state.Cursor); err == nil {
			state.Offset = underlying.Offset
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return webflowRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func webflowRetryCursorDue(state webflowRetryState, now time.Time) bool {
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

func webflowBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := webflowRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeWebflowRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(webflowRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeWebflowRetryCursor(state)
}

func webflowRetryDelay(attempt int, err error) time.Duration {
	var statusErr webflowHTTPStatusError
	if err != nil && errors.As(err, &statusErr) && statusErr.RetryAfter > 0 {
		if statusErr.RetryAfter > webflowRetryMaxDelay {
			return webflowRetryMaxDelay
		}
		return statusErr.RetryAfter
	}
	if attempt <= 1 {
		return webflowRetryInitialDelay
	}
	delay := webflowRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= webflowRetryMaxDelay {
			return webflowRetryMaxDelay
		}
	}
	return delay
}
