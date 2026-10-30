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
	formalooRetryCursorPrefix           = "formaloo_retry:"
	formalooBulkBackfillDefaultMaxPages = 5
	formalooRetryInitialDelay           = 15 * time.Minute
	formalooRetryMaxDelay               = 6 * time.Hour
)

type formalooRetryState struct {
	Cursor               string `json:"cursor"`
	FormSlug             string `json:"form_slug,omitempty"`
	Page                 int    `json:"page,omitempty"`
	NextURL              string `json:"next_url,omitempty"`
	LastSubmittedAt      string `json:"last_submitted_at,omitempty"`
	LastSlug             string `json:"last_slug,omitempty"`
	HighWaterSubmittedAt string `json:"high_water_submitted_at,omitempty"`
	HighWaterSlug        string `json:"high_water_slug,omitempty"`
	Total                int    `json:"total,omitempty"`
	PageCount            int    `json:"page_count,omitempty"`
	Attempts             int    `json:"attempts,omitempty"`
	NextAttemptAt        string `json:"next_attempt_at,omitempty"`
	LastStatus           string `json:"last_status,omitempty"`
	LastError            string `json:"last_error,omitempty"`
}

type FormalooBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller FormalooBackfiller
	MaxPages   int
	Now        func() time.Time
}

type FormalooBulkBackfillSummary struct {
	IntegrationID       string `json:"integration_id"`
	Pages               int    `json:"pages"`
	SubmissionsSeen     int    `json:"submissions_seen"`
	SubscribersUpserted int    `json:"subscribers_upserted"`
	EventsTracked       int    `json:"events_tracked"`
	Cursor              string `json:"cursor,omitempty"`
	LastError           string `json:"last_error,omitempty"`
	MaxPagesExhausted   bool   `json:"max_pages_exhausted,omitempty"`
}

func (r FormalooBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (FormalooBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return FormalooBulkBackfillSummary{}, fmt.Errorf("Formaloo bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.formalooBackfiller()
	}
	if backfiller == nil {
		return FormalooBulkBackfillSummary{}, fmt.Errorf("Formaloo bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return FormalooBulkBackfillSummary{}, err
	}
	if integration == nil {
		return FormalooBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderFormaloo {
		return FormalooBulkBackfillSummary{}, fmt.Errorf("Formaloo bulk backfill requires a Formaloo integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := FormalooBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeFormalooRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !formalooRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := formalooBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := formalooBackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
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

func (r FormalooBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r FormalooBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return formalooBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r FormalooBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeFormalooRetryCursor(cursor string) (formalooRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, formalooRetryCursorPrefix) {
		return formalooRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, formalooRetryCursorPrefix))
	if err != nil {
		return formalooRetryState{}, true, fmt.Errorf("decode Formaloo retry cursor: %w", err)
	}
	var state formalooRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return formalooRetryState{}, true, fmt.Errorf("parse Formaloo retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeFormalooCursor(state.Cursor); err == nil {
			state.FormSlug = underlying.FormSlug
			state.Page = underlying.Page
			state.NextURL = underlying.NextURL
			state.LastSubmittedAt = underlying.LastSubmittedAt
			state.LastSlug = underlying.LastSlug
			state.HighWaterSubmittedAt = underlying.HighWaterSubmittedAt
			state.HighWaterSlug = underlying.HighWaterSlug
			state.Total = underlying.Total
			state.PageCount = underlying.PageCount
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeFormalooRetryCursor(state formalooRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeFormalooCursor(state.Cursor); err == nil {
			state.FormSlug = underlying.FormSlug
			state.Page = underlying.Page
			state.NextURL = underlying.NextURL
			state.LastSubmittedAt = underlying.LastSubmittedAt
			state.LastSlug = underlying.LastSlug
			state.HighWaterSubmittedAt = underlying.HighWaterSubmittedAt
			state.HighWaterSlug = underlying.HighWaterSlug
			state.Total = underlying.Total
			state.PageCount = underlying.PageCount
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return formalooRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func formalooRetryCursorDue(state formalooRetryState, now time.Time) bool {
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

func formalooBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := formalooRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeFormalooRetryCursor(cursor); err == nil && ok {
		state = existing
	}
	state.Attempts++
	if state.Attempts <= 0 {
		state.Attempts = 1
	}
	delay := formalooRetryInitialDelay
	if retryErr != nil {
		var providerErr FormalooProviderError
		if errors.As(retryErr, &providerErr) && providerErr.RetryAfter > 0 {
			delay = providerErr.RetryAfter
		}
	}
	if delay <= 0 {
		delay = formalooRetryInitialDelay
	}
	for i := 1; i < state.Attempts && delay < formalooRetryMaxDelay; i++ {
		delay *= 2
		if delay > formalooRetryMaxDelay {
			delay = formalooRetryMaxDelay
			break
		}
	}
	state.NextAttemptAt = now.UTC().Add(delay).Format(time.RFC3339)
	state.LastStatus = strings.ToUpper(strings.TrimSpace(status))
	if retryErr != nil {
		state.LastError = truncateTypeformString(retryErr.Error(), 500)
	}
	return encodeFormalooRetryCursor(state)
}
