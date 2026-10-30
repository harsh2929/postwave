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
	featheryRetryCursorPrefix           = "feathery_retry:"
	featheryBulkBackfillDefaultMaxPages = 10
	featheryRetryInitialDelay           = 15 * time.Minute
	featheryRetryMaxDelay               = 6 * time.Hour
)

type featheryRetryState struct {
	Cursor        string `json:"cursor"`
	NextURL       string `json:"next_url,omitempty"`
	Since         string `json:"since,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type FeatheryBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller FeatheryBackfiller
	MaxPages   int
	Now        func() time.Time
}

type FeatheryBulkBackfillSummary struct {
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

func (r FeatheryBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (FeatheryBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return FeatheryBulkBackfillSummary{}, fmt.Errorf("feathery bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.featheryBackfiller()
	}
	if backfiller == nil {
		return FeatheryBulkBackfillSummary{}, fmt.Errorf("feathery bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return FeatheryBulkBackfillSummary{}, err
	}
	if integration == nil {
		return FeatheryBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderFeathery {
		return FeatheryBulkBackfillSummary{}, fmt.Errorf("feathery bulk backfill requires a Feathery integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := FeatheryBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeFeatheryRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !featheryRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := featheryBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := featheryBackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
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
			if cursor == featheryCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r FeatheryBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r FeatheryBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return featheryBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r FeatheryBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeFeatheryRetryCursor(cursor string) (featheryRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, featheryRetryCursorPrefix) {
		return featheryRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, featheryRetryCursorPrefix))
	if err != nil {
		return featheryRetryState{}, true, fmt.Errorf("decode Feathery retry cursor: %w", err)
	}
	var state featheryRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return featheryRetryState{}, true, fmt.Errorf("parse Feathery retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeFeatheryCursor(state.Cursor); err == nil {
			state.NextURL = underlying.NextURL
			state.Since = underlying.Since
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeFeatheryRetryCursor(state featheryRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeFeatheryCursor(state.Cursor); err == nil {
			state.NextURL = underlying.NextURL
			state.Since = underlying.Since
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return featheryRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func featheryRetryCursorDue(state featheryRetryState, now time.Time) bool {
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

func featheryBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := featheryRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeFeatheryRetryCursor(cursor); err == nil && ok {
		state = existing
	}
	state.Attempts++
	state.LastStatus = strings.ToUpper(strings.TrimSpace(status))
	if retryErr != nil {
		state.LastError = retryErr.Error()
	}
	delay := featheryRetryDelay(state.Attempts)
	var providerErr FeatheryProviderError
	if errors.As(retryErr, &providerErr) && providerErr.RetryAfter > 0 {
		delay = providerErr.RetryAfter
	}
	state.NextAttemptAt = now.UTC().Add(delay).Format(time.RFC3339)
	if state.Cursor == "" {
		state.Cursor = encodeFeatheryCursor(featheryCursorState{})
	}
	return encodeFeatheryRetryCursor(state)
}

func featheryRetryDelay(attempts int) time.Duration {
	if attempts <= 1 {
		return featheryRetryInitialDelay
	}
	delay := featheryRetryInitialDelay
	for i := 1; i < attempts; i++ {
		delay *= 2
		if delay >= featheryRetryMaxDelay {
			return featheryRetryMaxDelay
		}
	}
	return delay
}
