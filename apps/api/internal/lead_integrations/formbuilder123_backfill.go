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
	formBuilder123RetryCursorPrefix           = "123formbuilder_retry:"
	formBuilder123BulkBackfillDefaultMaxPages = 5
	formBuilder123RetryInitialDelay           = 15 * time.Minute
	formBuilder123RetryMaxDelay               = 6 * time.Hour
)

type formBuilder123RetryState struct {
	Cursor               string `json:"cursor"`
	FormID               string `json:"form_id,omitempty"`
	Page                 int    `json:"page,omitempty"`
	LastID               string `json:"last_id,omitempty"`
	LastSubmittedAt      string `json:"last_submitted_at,omitempty"`
	HighWaterID          string `json:"high_water_id,omitempty"`
	HighWaterSubmittedAt string `json:"high_water_submitted_at,omitempty"`
	Total                int    `json:"total,omitempty"`
	TotalPages           int    `json:"total_pages,omitempty"`
	Attempts             int    `json:"attempts,omitempty"`
	NextAttemptAt        string `json:"next_attempt_at,omitempty"`
	LastStatus           string `json:"last_status,omitempty"`
	LastError            string `json:"last_error,omitempty"`
}

type FormBuilder123BulkBackfillRunner struct {
	Deps       *Deps
	Backfiller FormBuilder123Backfiller
	MaxPages   int
	Now        func() time.Time
}

type FormBuilder123BulkBackfillSummary struct {
	IntegrationID       string `json:"integration_id"`
	Pages               int    `json:"pages"`
	SubmissionsSeen     int    `json:"submissions_seen"`
	SubscribersUpserted int    `json:"subscribers_upserted"`
	EventsTracked       int    `json:"events_tracked"`
	Cursor              string `json:"cursor,omitempty"`
	LastError           string `json:"last_error,omitempty"`
	MaxPagesExhausted   bool   `json:"max_pages_exhausted,omitempty"`
}

func (r FormBuilder123BulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (FormBuilder123BulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return FormBuilder123BulkBackfillSummary{}, fmt.Errorf("123FormBuilder bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.formBuilder123Backfiller()
	}
	if backfiller == nil {
		return FormBuilder123BulkBackfillSummary{}, fmt.Errorf("123FormBuilder bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return FormBuilder123BulkBackfillSummary{}, err
	}
	if integration == nil {
		return FormBuilder123BulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != Provider123FormBuilder {
		return FormBuilder123BulkBackfillSummary{}, fmt.Errorf("123FormBuilder bulk backfill requires a 123FormBuilder integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := FormBuilder123BulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeFormBuilder123RetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !formBuilder123RetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := formBuilder123BackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := formBuilder123BackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
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

func (r FormBuilder123BulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r FormBuilder123BulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return formBuilder123BulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r FormBuilder123BulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeFormBuilder123RetryCursor(cursor string) (formBuilder123RetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, formBuilder123RetryCursorPrefix) {
		return formBuilder123RetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, formBuilder123RetryCursorPrefix))
	if err != nil {
		return formBuilder123RetryState{}, true, fmt.Errorf("decode 123FormBuilder retry cursor: %w", err)
	}
	var state formBuilder123RetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return formBuilder123RetryState{}, true, fmt.Errorf("parse 123FormBuilder retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeFormBuilder123Cursor(state.Cursor); err == nil {
			state.FormID = underlying.FormID
			state.Page = underlying.Page
			state.LastID = underlying.LastID
			state.LastSubmittedAt = underlying.LastSubmittedAt
			state.HighWaterID = underlying.HighWaterID
			state.HighWaterSubmittedAt = underlying.HighWaterSubmittedAt
			state.Total = underlying.Total
			state.TotalPages = underlying.TotalPages
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeFormBuilder123RetryCursor(state formBuilder123RetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeFormBuilder123Cursor(state.Cursor); err == nil {
			state.FormID = underlying.FormID
			state.Page = underlying.Page
			state.LastID = underlying.LastID
			state.LastSubmittedAt = underlying.LastSubmittedAt
			state.HighWaterID = underlying.HighWaterID
			state.HighWaterSubmittedAt = underlying.HighWaterSubmittedAt
			state.Total = underlying.Total
			state.TotalPages = underlying.TotalPages
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return formBuilder123RetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func formBuilder123RetryCursorDue(state formBuilder123RetryState, now time.Time) bool {
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

func formBuilder123BackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := formBuilder123RetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeFormBuilder123RetryCursor(cursor); err == nil && ok {
		state = existing
	}
	state.Attempts++
	if state.Attempts <= 0 {
		state.Attempts = 1
	}
	delay := formBuilder123RetryInitialDelay
	if retryErr != nil {
		var providerErr FormBuilder123ProviderError
		if errors.As(retryErr, &providerErr) && providerErr.RetryAfter > 0 {
			delay = providerErr.RetryAfter
		}
	}
	if delay <= 0 {
		delay = formBuilder123RetryInitialDelay
	}
	for i := 1; i < state.Attempts && delay < formBuilder123RetryMaxDelay; i++ {
		delay *= 2
		if delay > formBuilder123RetryMaxDelay {
			delay = formBuilder123RetryMaxDelay
			break
		}
	}
	state.NextAttemptAt = now.UTC().Add(delay).Format(time.RFC3339)
	state.LastStatus = strings.ToUpper(strings.TrimSpace(status))
	if retryErr != nil {
		state.LastError = truncateTypeformString(retryErr.Error(), 500)
	}
	return encodeFormBuilder123RetryCursor(state)
}
