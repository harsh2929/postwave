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
	tallyRetryCursorPrefix           = "tally_retry:"
	tallyBulkBackfillDefaultMaxPages = 10
	tallyRetryInitialDelay           = 15 * time.Minute
	tallyRetryMaxDelay               = 6 * time.Hour
)

type tallyRetryState struct {
	Cursor        string `json:"cursor"`
	Page          int    `json:"page,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type TallyBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller TallyBackfiller
	MaxPages   int
	Now        func() time.Time
}

type TallyBulkBackfillSummary struct {
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

func (r TallyBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (TallyBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return TallyBulkBackfillSummary{}, fmt.Errorf("tally bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.tallyBackfiller()
	}
	if backfiller == nil {
		return TallyBulkBackfillSummary{}, fmt.Errorf("tally bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return TallyBulkBackfillSummary{}, err
	}
	if integration == nil {
		return TallyBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderTally {
		return TallyBulkBackfillSummary{}, fmt.Errorf("tally bulk backfill requires a Tally integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := TallyBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeTallyRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !tallyRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := tallyBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := tallyBackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
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
			if cursor == tallyCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r TallyBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r TallyBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return tallyBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r TallyBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeTallyRetryCursor(cursor string) (tallyRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, tallyRetryCursorPrefix) {
		return tallyRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, tallyRetryCursorPrefix))
	if err != nil {
		return tallyRetryState{}, true, fmt.Errorf("decode Tally retry cursor: %w", err)
	}
	var state tallyRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return tallyRetryState{}, true, fmt.Errorf("parse Tally retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeTallyCursor(state.Cursor); err == nil {
			state.Page = underlying.Page
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeTallyRetryCursor(state tallyRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeTallyCursor(state.Cursor); err == nil {
			state.Page = underlying.Page
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return tallyRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func tallyRetryCursorDue(state tallyRetryState, now time.Time) bool {
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

func tallyBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := tallyRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeTallyRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(tallyRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeTallyRetryCursor(state)
}

func tallyRetryDelay(attempt int, err error) time.Duration {
	var providerErr TallyProviderError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > tallyRetryMaxDelay {
			return tallyRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return tallyRetryInitialDelay
	}
	delay := tallyRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= tallyRetryMaxDelay {
			return tallyRetryMaxDelay
		}
	}
	return delay
}
