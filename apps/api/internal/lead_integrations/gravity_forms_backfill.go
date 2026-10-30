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
	gravityFormsRetryCursorPrefix           = "gravity_forms_retry:"
	gravityFormsBulkBackfillDefaultMaxPages = 10
	gravityFormsRetryInitialDelay           = 15 * time.Minute
	gravityFormsRetryMaxDelay               = 6 * time.Hour
)

type gravityFormsRetryState struct {
	Cursor        string `json:"cursor"`
	Offset        int    `json:"offset,omitempty"`
	TotalCount    int    `json:"total_count,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type GravityFormsBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller GravityFormsBackfiller
	MaxPages   int
	Now        func() time.Time
}

type GravityFormsBulkBackfillSummary struct {
	IntegrationID       string `json:"integration_id"`
	Pages               int    `json:"pages"`
	SubmissionsSeen     int    `json:"submissions_seen"`
	SubscribersUpserted int    `json:"subscribers_upserted"`
	EventsTracked       int    `json:"events_tracked"`
	Cursor              string `json:"cursor,omitempty"`
	LastError           string `json:"last_error,omitempty"`
	MaxPagesExhausted   bool   `json:"max_pages_exhausted,omitempty"`
}

func (r GravityFormsBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (GravityFormsBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return GravityFormsBulkBackfillSummary{}, fmt.Errorf("gravity forms bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.gravityFormsBackfiller()
	}
	if backfiller == nil {
		return GravityFormsBulkBackfillSummary{}, fmt.Errorf("gravity forms bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return GravityFormsBulkBackfillSummary{}, err
	}
	if integration == nil {
		return GravityFormsBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderGravityForms {
		return GravityFormsBulkBackfillSummary{}, fmt.Errorf("gravity forms bulk backfill requires a Gravity Forms integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := GravityFormsBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeGravityFormsRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !gravityFormsRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := gravityFormsBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := gravityFormsBackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
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

func (r GravityFormsBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r GravityFormsBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return gravityFormsBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r GravityFormsBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeGravityFormsRetryCursor(cursor string) (gravityFormsRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, gravityFormsRetryCursorPrefix) {
		return gravityFormsRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, gravityFormsRetryCursorPrefix))
	if err != nil {
		return gravityFormsRetryState{}, true, fmt.Errorf("decode Gravity Forms retry cursor: %w", err)
	}
	var state gravityFormsRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return gravityFormsRetryState{}, true, fmt.Errorf("parse Gravity Forms retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeGravityFormsCursor(state.Cursor); err == nil {
			state.Offset = underlying.Offset
			state.TotalCount = underlying.TotalCount
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeGravityFormsRetryCursor(state gravityFormsRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeGravityFormsCursor(state.Cursor); err == nil {
			state.Offset = underlying.Offset
			state.TotalCount = underlying.TotalCount
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return gravityFormsRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func gravityFormsRetryCursorDue(state gravityFormsRetryState, now time.Time) bool {
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

func gravityFormsBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := gravityFormsRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeGravityFormsRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(gravityFormsRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	if state.Cursor == "" {
		state.Cursor = encodeGravityFormsCursor(gravityFormsCursorState{})
	}
	return encodeGravityFormsRetryCursor(state)
}

func gravityFormsRetryDelay(attempt int, err error) time.Duration {
	var providerErr GravityFormsProviderError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > gravityFormsRetryMaxDelay {
			return gravityFormsRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return gravityFormsRetryInitialDelay
	}
	delay := gravityFormsRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= gravityFormsRetryMaxDelay {
			return gravityFormsRetryMaxDelay
		}
	}
	return delay
}
