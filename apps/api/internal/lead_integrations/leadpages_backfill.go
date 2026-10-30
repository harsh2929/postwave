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
	leadpagesRetryCursorPrefix           = "leadpages_retry:"
	leadpagesBulkBackfillDefaultMaxPages = 10
	leadpagesRetryInitialDelay           = 15 * time.Minute
	leadpagesRetryMaxDelay               = 6 * time.Hour
)

type leadpagesRetryState struct {
	Cursor          string `json:"cursor"`
	NextCursor      string `json:"next_cursor,omitempty"`
	NextURL         string `json:"next_url,omitempty"`
	Page            int    `json:"page,omitempty"`
	LastSubmittedAt string `json:"last_submitted_at,omitempty"`
	LastID          string `json:"last_id,omitempty"`
	Attempts        int    `json:"attempts,omitempty"`
	NextAttemptAt   string `json:"next_attempt_at,omitempty"`
	LastStatus      string `json:"last_status,omitempty"`
	LastError       string `json:"last_error,omitempty"`
}

type LeadpagesBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller LeadpagesBackfiller
	MaxPages   int
	Now        func() time.Time
}

type LeadpagesBulkBackfillSummary struct {
	IntegrationID       string `json:"integration_id"`
	Pages               int    `json:"pages"`
	SubmissionsSeen     int    `json:"submissions_seen"`
	SubscribersUpserted int    `json:"subscribers_upserted"`
	EventsTracked       int    `json:"events_tracked"`
	Cursor              string `json:"cursor,omitempty"`
	LastError           string `json:"last_error,omitempty"`
	MaxPagesExhausted   bool   `json:"max_pages_exhausted,omitempty"`
}

func (r LeadpagesBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (LeadpagesBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return LeadpagesBulkBackfillSummary{}, fmt.Errorf("leadpages bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.leadpagesBackfiller()
	}
	if backfiller == nil {
		return LeadpagesBulkBackfillSummary{}, fmt.Errorf("leadpages bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return LeadpagesBulkBackfillSummary{}, err
	}
	if integration == nil {
		return LeadpagesBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderLeadpages {
		return LeadpagesBulkBackfillSummary{}, fmt.Errorf("leadpages bulk backfill requires a Leadpages integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := LeadpagesBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeLeadpagesRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !leadpagesRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := leadpagesBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := leadpagesBackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
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

func (r LeadpagesBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r LeadpagesBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return leadpagesBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r LeadpagesBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeLeadpagesRetryCursor(cursor string) (leadpagesRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, leadpagesRetryCursorPrefix) {
		return leadpagesRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, leadpagesRetryCursorPrefix))
	if err != nil {
		return leadpagesRetryState{}, true, fmt.Errorf("decode Leadpages retry cursor: %w", err)
	}
	var state leadpagesRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return leadpagesRetryState{}, true, fmt.Errorf("parse Leadpages retry cursor: %w", err)
	}
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeLeadpagesCursor(state.Cursor); err == nil {
			state.NextCursor = underlying.NextCursor
			state.NextURL = underlying.NextURL
			state.Page = underlying.Page
			state.LastSubmittedAt = underlying.LastSubmittedAt
			state.LastID = underlying.LastID
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state, true, nil
}

func encodeLeadpagesRetryCursor(state leadpagesRetryState) string {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeLeadpagesCursor(state.Cursor); err == nil {
			state.NextCursor = underlying.NextCursor
			state.NextURL = underlying.NextURL
			state.Page = underlying.Page
			state.LastSubmittedAt = underlying.LastSubmittedAt
			state.LastID = underlying.LastID
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	raw, _ := json.Marshal(state)
	return leadpagesRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func leadpagesRetryCursorDue(state leadpagesRetryState, now time.Time) bool {
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

func leadpagesBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := leadpagesRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeLeadpagesRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(leadpagesRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	if state.Cursor == "" {
		state.Cursor = encodeLeadpagesCursor(leadpagesCursorState{})
	}
	return encodeLeadpagesRetryCursor(state)
}

func leadpagesRetryDelay(attempt int, err error) time.Duration {
	var providerErr LeadpagesProviderError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > leadpagesRetryMaxDelay {
			return leadpagesRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return leadpagesRetryInitialDelay
	}
	delay := leadpagesRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= leadpagesRetryMaxDelay {
			return leadpagesRetryMaxDelay
		}
	}
	return delay
}
