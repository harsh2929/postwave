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
	cognitoFormsRetryCursorPrefix           = "cognito_forms_retry:"
	cognitoFormsBulkBackfillDefaultMaxPages = 5
	cognitoFormsRetryInitialDelay           = 15 * time.Minute
	cognitoFormsRetryMaxDelay               = 6 * time.Hour
)

type cognitoFormsRetryState struct {
	Cursor        string `json:"cursor"`
	FormID        string `json:"form_id,omitempty"`
	ViewID        string `json:"view_id,omitempty"`
	LastID        string `json:"last_id,omitempty"`
	TotalCount    int    `json:"total_count,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type CognitoFormsBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller CognitoFormsBackfiller
	MaxPages   int
	Now        func() time.Time
}

type CognitoFormsBulkBackfillSummary struct {
	IntegrationID       string `json:"integration_id"`
	Pages               int    `json:"pages"`
	SubmissionsSeen     int    `json:"submissions_seen"`
	SubscribersUpserted int    `json:"subscribers_upserted"`
	EventsTracked       int    `json:"events_tracked"`
	Cursor              string `json:"cursor,omitempty"`
	LastError           string `json:"last_error,omitempty"`
	MaxPagesExhausted   bool   `json:"max_pages_exhausted,omitempty"`
}

func (r CognitoFormsBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (CognitoFormsBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return CognitoFormsBulkBackfillSummary{}, fmt.Errorf("Cognito Forms bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.cognitoFormsBackfiller()
	}
	if backfiller == nil {
		return CognitoFormsBulkBackfillSummary{}, fmt.Errorf("Cognito Forms bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return CognitoFormsBulkBackfillSummary{}, err
	}
	if integration == nil {
		return CognitoFormsBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderCognitoForms {
		return CognitoFormsBulkBackfillSummary{}, fmt.Errorf("Cognito Forms bulk backfill requires a Cognito Forms integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := CognitoFormsBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeCognitoFormsRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !cognitoFormsRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := cognitoFormsBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := cognitoFormsBackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
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

func (r CognitoFormsBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r CognitoFormsBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return cognitoFormsBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r CognitoFormsBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeCognitoFormsRetryCursor(cursor string) (cognitoFormsRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, cognitoFormsRetryCursorPrefix) {
		return cognitoFormsRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, cognitoFormsRetryCursorPrefix))
	if err != nil {
		return cognitoFormsRetryState{}, true, fmt.Errorf("decode Cognito Forms retry cursor: %w", err)
	}
	var state cognitoFormsRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return cognitoFormsRetryState{}, true, fmt.Errorf("parse Cognito Forms retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeCognitoFormsCursor(state.Cursor); err == nil {
			state.FormID = underlying.FormID
			state.ViewID = underlying.ViewID
			state.LastID = underlying.LastID
			state.TotalCount = underlying.TotalCount
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeCognitoFormsRetryCursor(state cognitoFormsRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeCognitoFormsCursor(state.Cursor); err == nil {
			state.FormID = underlying.FormID
			state.ViewID = underlying.ViewID
			state.LastID = underlying.LastID
			state.TotalCount = underlying.TotalCount
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return cognitoFormsRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func cognitoFormsRetryCursorDue(state cognitoFormsRetryState, now time.Time) bool {
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

func cognitoFormsBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := cognitoFormsRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeCognitoFormsRetryCursor(cursor); err == nil && ok {
		state = existing
	}
	state.Attempts++
	state.LastStatus = strings.ToUpper(strings.TrimSpace(status))
	if retryErr != nil {
		state.LastError = retryErr.Error()
	}
	delay := cognitoFormsRetryDelay(state.Attempts, retryErr)
	state.NextAttemptAt = now.UTC().Add(delay).Format(time.RFC3339)
	return encodeCognitoFormsRetryCursor(state)
}

func cognitoFormsRetryDelay(attempts int, err error) time.Duration {
	var providerErr CognitoFormsProviderError
	if errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		return providerErr.RetryAfter
	}
	if attempts <= 0 {
		attempts = 1
	}
	delay := cognitoFormsRetryInitialDelay
	for i := 1; i < attempts; i++ {
		delay *= 2
		if delay >= cognitoFormsRetryMaxDelay {
			return cognitoFormsRetryMaxDelay
		}
	}
	return delay
}
