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
	wpformsRetryCursorPrefix           = "wpforms_retry:"
	wpformsBulkBackfillDefaultMaxPages = 10
	wpformsRetryInitialDelay           = 15 * time.Minute
	wpformsRetryMaxDelay               = 6 * time.Hour
)

type wpformsRetryState struct {
	Cursor        string `json:"cursor"`
	Page          int    `json:"page,omitempty"`
	TotalPages    int    `json:"total_pages,omitempty"`
	TotalCount    int    `json:"total_count,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type WPFormsBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller WPFormsBackfiller
	MaxPages   int
	Now        func() time.Time
}

type WPFormsBulkBackfillSummary struct {
	IntegrationID       string `json:"integration_id"`
	Pages               int    `json:"pages"`
	SubmissionsSeen     int    `json:"submissions_seen"`
	SubscribersUpserted int    `json:"subscribers_upserted"`
	EventsTracked       int    `json:"events_tracked"`
	Cursor              string `json:"cursor,omitempty"`
	LastError           string `json:"last_error,omitempty"`
	MaxPagesExhausted   bool   `json:"max_pages_exhausted,omitempty"`
}

func (r WPFormsBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (WPFormsBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return WPFormsBulkBackfillSummary{}, fmt.Errorf("WPForms bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.wpformsBackfiller()
	}
	if backfiller == nil {
		return WPFormsBulkBackfillSummary{}, fmt.Errorf("WPForms bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return WPFormsBulkBackfillSummary{}, err
	}
	if integration == nil {
		return WPFormsBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderWPForms {
		return WPFormsBulkBackfillSummary{}, fmt.Errorf("WPForms bulk backfill requires a WPForms integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := WPFormsBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeWPFormsRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !wpformsRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := wpformsBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := wpformsBackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
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
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r WPFormsBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r WPFormsBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return wpformsBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r WPFormsBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeWPFormsRetryCursor(cursor string) (wpformsRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, wpformsRetryCursorPrefix) {
		return wpformsRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, wpformsRetryCursorPrefix))
	if err != nil {
		return wpformsRetryState{}, true, fmt.Errorf("decode WPForms retry cursor: %w", err)
	}
	var state wpformsRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return wpformsRetryState{}, true, fmt.Errorf("parse WPForms retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeWPFormsCursor(state.Cursor); err == nil {
			state.Page = underlying.Page
			state.TotalPages = underlying.TotalPages
			state.TotalCount = underlying.TotalCount
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeWPFormsRetryCursor(state wpformsRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeWPFormsCursor(state.Cursor); err == nil {
			state.Page = underlying.Page
			state.TotalPages = underlying.TotalPages
			state.TotalCount = underlying.TotalCount
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return wpformsRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func wpformsRetryCursorDue(state wpformsRetryState, now time.Time) bool {
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

func wpformsBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := wpformsRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeWPFormsRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(wpformsRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	if state.Cursor == "" {
		state.Cursor = encodeWPFormsCursor(wpformsCursorState{})
	}
	return encodeWPFormsRetryCursor(state)
}

func wpformsRetryDelay(attempt int, err error) time.Duration {
	var providerErr WPFormsProviderError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > wpformsRetryMaxDelay {
			return wpformsRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return wpformsRetryInitialDelay
	}
	delay := wpformsRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= wpformsRetryMaxDelay {
			return wpformsRetryMaxDelay
		}
	}
	return delay
}
