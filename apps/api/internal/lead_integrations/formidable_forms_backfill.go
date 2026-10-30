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
	formidableFormsRetryCursorPrefix           = "formidable_forms_retry:"
	formidableFormsBulkBackfillDefaultMaxPages = 10
	formidableFormsRetryInitialDelay           = 15 * time.Minute
	formidableFormsRetryMaxDelay               = 6 * time.Hour
)

type formidableFormsRetryState struct {
	Cursor        string `json:"cursor"`
	Page          int    `json:"page,omitempty"`
	TotalPages    int    `json:"total_pages,omitempty"`
	TotalCount    int    `json:"total_count,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type FormidableFormsBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller FormidableFormsBackfiller
	MaxPages   int
	Now        func() time.Time
}

type FormidableFormsBulkBackfillSummary struct {
	IntegrationID       string `json:"integration_id"`
	Pages               int    `json:"pages"`
	SubmissionsSeen     int    `json:"submissions_seen"`
	SubscribersUpserted int    `json:"subscribers_upserted"`
	EventsTracked       int    `json:"events_tracked"`
	Cursor              string `json:"cursor,omitempty"`
	LastError           string `json:"last_error,omitempty"`
	MaxPagesExhausted   bool   `json:"max_pages_exhausted,omitempty"`
}

func (r FormidableFormsBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (FormidableFormsBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return FormidableFormsBulkBackfillSummary{}, fmt.Errorf("Formidable Forms bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.formidableFormsBackfiller()
	}
	if backfiller == nil {
		return FormidableFormsBulkBackfillSummary{}, fmt.Errorf("Formidable Forms bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return FormidableFormsBulkBackfillSummary{}, err
	}
	if integration == nil {
		return FormidableFormsBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderFormidableForms {
		return FormidableFormsBulkBackfillSummary{}, fmt.Errorf("Formidable Forms bulk backfill requires a Formidable Forms integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := FormidableFormsBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeFormidableFormsRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !formidableFormsRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := formidableFormsBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := formidableFormsBackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
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

func (r FormidableFormsBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r FormidableFormsBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return formidableFormsBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r FormidableFormsBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeFormidableFormsRetryCursor(cursor string) (formidableFormsRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, formidableFormsRetryCursorPrefix) {
		return formidableFormsRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, formidableFormsRetryCursorPrefix))
	if err != nil {
		return formidableFormsRetryState{}, true, fmt.Errorf("decode Formidable Forms retry cursor: %w", err)
	}
	var state formidableFormsRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return formidableFormsRetryState{}, true, fmt.Errorf("parse Formidable Forms retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeFormidableFormsCursor(state.Cursor); err == nil {
			state.Page = underlying.Page
			state.TotalPages = underlying.TotalPages
			state.TotalCount = underlying.TotalCount
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeFormidableFormsRetryCursor(state formidableFormsRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeFormidableFormsCursor(state.Cursor); err == nil {
			state.Page = underlying.Page
			state.TotalPages = underlying.TotalPages
			state.TotalCount = underlying.TotalCount
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return formidableFormsRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func formidableFormsRetryCursorDue(state formidableFormsRetryState, now time.Time) bool {
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

func formidableFormsBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := formidableFormsRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeFormidableFormsRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(formidableFormsRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	if state.Cursor == "" {
		state.Cursor = encodeFormidableFormsCursor(formidableFormsCursorState{})
	}
	return encodeFormidableFormsRetryCursor(state)
}

func formidableFormsRetryDelay(attempt int, err error) time.Duration {
	var providerErr FormidableFormsProviderError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > formidableFormsRetryMaxDelay {
			return formidableFormsRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return formidableFormsRetryInitialDelay
	}
	delay := formidableFormsRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= formidableFormsRetryMaxDelay {
			return formidableFormsRetryMaxDelay
		}
	}
	return delay
}
