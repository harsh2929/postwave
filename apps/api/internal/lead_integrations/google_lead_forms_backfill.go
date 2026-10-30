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
	googleLeadFormsRetryCursorPrefix           = "google_lead_forms_retry:"
	googleLeadFormsBulkBackfillDefaultMaxPages = 10
	googleLeadFormsRetryInitialDelay           = 15 * time.Minute
	googleLeadFormsRetryMaxDelay               = 6 * time.Hour
)

type googleLeadFormsRetryState struct {
	Cursor             string `json:"cursor"`
	PageToken          string `json:"page_token,omitempty"`
	LastSubmissionTime string `json:"last_submission_time,omitempty"`
	LastID             string `json:"last_id,omitempty"`
	Attempts           int    `json:"attempts,omitempty"`
	NextAttemptAt      string `json:"next_attempt_at,omitempty"`
	LastStatus         string `json:"last_status,omitempty"`
	LastError          string `json:"last_error,omitempty"`
}

type GoogleLeadFormsBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller GoogleLeadFormsBackfiller
	MaxPages   int
	Now        func() time.Time
}

type GoogleLeadFormsBulkBackfillSummary struct {
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

func (r GoogleLeadFormsBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (GoogleLeadFormsBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return GoogleLeadFormsBulkBackfillSummary{}, fmt.Errorf("google lead form extensions bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.googleLeadFormsBackfiller()
	}
	if backfiller == nil {
		return GoogleLeadFormsBulkBackfillSummary{}, fmt.Errorf("google lead form extensions bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return GoogleLeadFormsBulkBackfillSummary{}, err
	}
	if integration == nil {
		return GoogleLeadFormsBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderGoogleLeadForms {
		return GoogleLeadFormsBulkBackfillSummary{}, fmt.Errorf("google lead form extensions bulk backfill requires a Google Lead Form Extensions integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := GoogleLeadFormsBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	if retry, ok, err := decodeGoogleLeadFormsRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !googleLeadFormsRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := googleLeadFormsBackfillRetryCursor(cursor, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := googleLeadFormsBackfillRetryCursor(cursor, "SYNC_FAILED", err, r.now())
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
			if cursor == googleLeadFormsCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r GoogleLeadFormsBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r GoogleLeadFormsBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return googleLeadFormsBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r GoogleLeadFormsBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeGoogleLeadFormsRetryCursor(cursor string) (googleLeadFormsRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, googleLeadFormsRetryCursorPrefix) {
		return googleLeadFormsRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, googleLeadFormsRetryCursorPrefix))
	if err != nil {
		return googleLeadFormsRetryState{}, true, fmt.Errorf("decode Google Lead Form Extensions retry cursor: %w", err)
	}
	var state googleLeadFormsRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return googleLeadFormsRetryState{}, true, fmt.Errorf("parse Google Lead Form Extensions retry cursor: %w", err)
	}
	state = normalizeGoogleLeadFormsRetryState(state)
	return state, true, nil
}

func encodeGoogleLeadFormsRetryCursor(state googleLeadFormsRetryState) string {
	state = normalizeGoogleLeadFormsRetryState(state)
	raw, _ := json.Marshal(state)
	return googleLeadFormsRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func normalizeGoogleLeadFormsRetryState(state googleLeadFormsRetryState) googleLeadFormsRetryState {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeGoogleLeadFormsCursor(state.Cursor); err == nil {
			state.PageToken = strings.TrimSpace(underlying.PageToken)
			state.LastSubmissionTime = strings.TrimSpace(underlying.LastSubmissionTime)
			state.LastID = strings.TrimSpace(underlying.LastID)
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state
}

func googleLeadFormsRetryCursorDue(state googleLeadFormsRetryState, now time.Time) bool {
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

func googleLeadFormsBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := googleLeadFormsRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeGoogleLeadFormsRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(googleLeadFormsRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeGoogleLeadFormsRetryCursor(state)
}

func googleLeadFormsRetryDelay(attempt int, err error) time.Duration {
	var providerErr GoogleLeadFormsProviderError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > googleLeadFormsRetryMaxDelay {
			return googleLeadFormsRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return googleLeadFormsRetryInitialDelay
	}
	delay := googleLeadFormsRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= googleLeadFormsRetryMaxDelay {
			return googleLeadFormsRetryMaxDelay
		}
	}
	return delay
}
