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
	googleFormsRetryCursorPrefix           = "google_forms_retry:"
	googleFormsBulkBackfillDefaultMaxPages = 10
	googleFormsRetryInitialDelay           = 15 * time.Minute
	googleFormsRetryMaxDelay               = 6 * time.Hour
)

type googleFormsRetryState struct {
	Cursor        string `json:"cursor"`
	PageToken     string `json:"page_token,omitempty"`
	Since         string `json:"since,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type GoogleFormsBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller GoogleFormsBackfiller
	MaxPages   int
	Now        func() time.Time
}

type GoogleFormsBulkBackfillSummary struct {
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

func (r GoogleFormsBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (GoogleFormsBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return GoogleFormsBulkBackfillSummary{}, fmt.Errorf("google forms bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.googleFormsBackfiller()
	}
	if backfiller == nil {
		return GoogleFormsBulkBackfillSummary{}, fmt.Errorf("google forms bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return GoogleFormsBulkBackfillSummary{}, err
	}
	if integration == nil {
		return GoogleFormsBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderGoogleForms {
		return GoogleFormsBulkBackfillSummary{}, fmt.Errorf("google forms bulk backfill requires a Google Forms integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := GoogleFormsBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeGoogleFormsRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !googleFormsRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := googleFormsBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := googleFormsBackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
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
			if cursor == googleFormsCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r GoogleFormsBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r GoogleFormsBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return googleFormsBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r GoogleFormsBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeGoogleFormsRetryCursor(cursor string) (googleFormsRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, googleFormsRetryCursorPrefix) {
		return googleFormsRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, googleFormsRetryCursorPrefix))
	if err != nil {
		return googleFormsRetryState{}, true, fmt.Errorf("decode Google Forms retry cursor: %w", err)
	}
	var state googleFormsRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return googleFormsRetryState{}, true, fmt.Errorf("parse Google Forms retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeGoogleFormsCursor(state.Cursor); err == nil {
			state.PageToken = underlying.PageToken
			state.Since = underlying.Since
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeGoogleFormsRetryCursor(state googleFormsRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeGoogleFormsCursor(state.Cursor); err == nil {
			state.PageToken = underlying.PageToken
			state.Since = underlying.Since
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return googleFormsRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func googleFormsRetryCursorDue(state googleFormsRetryState, now time.Time) bool {
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

func googleFormsBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := googleFormsRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeGoogleFormsRetryCursor(cursor); err == nil && ok {
		state = existing
	}
	state.Attempts++
	state.LastStatus = strings.ToUpper(strings.TrimSpace(status))
	if retryErr != nil {
		state.LastError = retryErr.Error()
	}
	delay := googleFormsRetryDelay(state.Attempts)
	var providerErr GoogleFormsProviderError
	if errors.As(retryErr, &providerErr) && providerErr.RetryAfter > 0 {
		delay = providerErr.RetryAfter
	}
	state.NextAttemptAt = now.UTC().Add(delay).Format(time.RFC3339)
	if state.Cursor == "" {
		state.Cursor = encodeGoogleFormsCursor(googleFormsCursorState{})
	}
	return encodeGoogleFormsRetryCursor(state)
}

func googleFormsRetryDelay(attempts int) time.Duration {
	if attempts <= 1 {
		return googleFormsRetryInitialDelay
	}
	delay := googleFormsRetryInitialDelay
	for i := 1; i < attempts; i++ {
		delay *= 2
		if delay >= googleFormsRetryMaxDelay {
			return googleFormsRetryMaxDelay
		}
	}
	return delay
}
