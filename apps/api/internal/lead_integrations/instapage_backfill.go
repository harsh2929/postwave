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
	instapageRetryCursorPrefix           = "instapage_retry:"
	instapageBulkBackfillDefaultMaxPages = 10
	instapageRetryInitialDelay           = 15 * time.Minute
	instapageRetryMaxDelay               = 6 * time.Hour
)

type instapageRetryState struct {
	Cursor        string `json:"cursor"`
	NextPageToken string `json:"next_page_token,omitempty"`
	Since         int64  `json:"since,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type InstapageBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller InstapageBackfiller
	MaxPages   int
	Now        func() time.Time
}

type InstapageBulkBackfillSummary struct {
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

func (r InstapageBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (InstapageBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return InstapageBulkBackfillSummary{}, fmt.Errorf("instapage bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.instapageBackfiller()
	}
	if backfiller == nil {
		return InstapageBulkBackfillSummary{}, fmt.Errorf("instapage bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return InstapageBulkBackfillSummary{}, err
	}
	if integration == nil {
		return InstapageBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderInstapage {
		return InstapageBulkBackfillSummary{}, fmt.Errorf("instapage bulk backfill requires an Instapage integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := InstapageBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeInstapageRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !instapageRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := instapageBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := instapageBackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
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
			if cursor == instapageCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r InstapageBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r InstapageBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return instapageBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r InstapageBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeInstapageRetryCursor(cursor string) (instapageRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, instapageRetryCursorPrefix) {
		return instapageRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, instapageRetryCursorPrefix))
	if err != nil {
		return instapageRetryState{}, true, fmt.Errorf("decode Instapage retry cursor: %w", err)
	}
	var state instapageRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return instapageRetryState{}, true, fmt.Errorf("parse Instapage retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeInstapageCursor(state.Cursor); err == nil {
			state.NextPageToken = underlying.NextPageToken
			state.Since = underlying.Since
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeInstapageRetryCursor(state instapageRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeInstapageCursor(state.Cursor); err == nil {
			state.NextPageToken = underlying.NextPageToken
			state.Since = underlying.Since
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return instapageRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func instapageRetryCursorDue(state instapageRetryState, now time.Time) bool {
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

func instapageBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := instapageRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeInstapageRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(instapageRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	if state.Cursor == "" {
		state.Cursor = encodeInstapageCursor(instapageCursorState{})
	}
	return encodeInstapageRetryCursor(state)
}

func instapageRetryDelay(attempt int, err error) time.Duration {
	var providerErr InstapageProviderError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > instapageRetryMaxDelay {
			return instapageRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return instapageRetryInitialDelay
	}
	delay := instapageRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= instapageRetryMaxDelay {
			return instapageRetryMaxDelay
		}
	}
	return delay
}
