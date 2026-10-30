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
	facebookLeadAdsRetryCursorPrefix           = "facebook_lead_ads_retry:"
	facebookLeadAdsBulkBackfillDefaultMaxPages = 10
	facebookLeadAdsRetryInitialDelay           = 15 * time.Minute
	facebookLeadAdsRetryMaxDelay               = 6 * time.Hour
)

type facebookLeadAdsRetryState struct {
	Cursor        string `json:"cursor"`
	After         string `json:"after,omitempty"`
	Attempts      int    `json:"attempts,omitempty"`
	NextAttemptAt string `json:"next_attempt_at,omitempty"`
	LastStatus    string `json:"last_status,omitempty"`
	LastError     string `json:"last_error,omitempty"`
}

type FacebookLeadAdsBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller FacebookLeadAdsBackfiller
	MaxPages   int
	Now        func() time.Time
}

type FacebookLeadAdsBulkBackfillSummary struct {
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

func (r FacebookLeadAdsBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (FacebookLeadAdsBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return FacebookLeadAdsBulkBackfillSummary{}, fmt.Errorf("facebook lead ads bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.facebookLeadAdsBackfiller()
	}
	if backfiller == nil {
		return FacebookLeadAdsBulkBackfillSummary{}, fmt.Errorf("facebook lead ads bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return FacebookLeadAdsBulkBackfillSummary{}, err
	}
	if integration == nil {
		return FacebookLeadAdsBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderFacebookLeadAds {
		return FacebookLeadAdsBulkBackfillSummary{}, fmt.Errorf("facebook lead ads bulk backfill requires a Facebook Lead Ads integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := FacebookLeadAdsBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if leadIntegrationDisconnected(integration) {
		return summary, nil
	}
	if retry, ok, err := decodeFacebookLeadAdsRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !facebookLeadAdsRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := facebookLeadAdsBackfillRetryCursor(cursor, "BACKFILL_FAILED", err, r.now())
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
			retryCursor := facebookLeadAdsBackfillRetryCursor(cursor, "SYNC_FAILED", err, r.now())
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
			if cursor == facebookLeadAdsCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r FacebookLeadAdsBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r FacebookLeadAdsBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return facebookLeadAdsBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r FacebookLeadAdsBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func decodeFacebookLeadAdsRetryCursor(cursor string) (facebookLeadAdsRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, facebookLeadAdsRetryCursorPrefix) {
		return facebookLeadAdsRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, facebookLeadAdsRetryCursorPrefix))
	if err != nil {
		return facebookLeadAdsRetryState{}, true, fmt.Errorf("decode Facebook Lead Ads retry cursor: %w", err)
	}
	var state facebookLeadAdsRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return facebookLeadAdsRetryState{}, true, fmt.Errorf("parse Facebook Lead Ads retry cursor: %w", err)
	}
	state = normalizeFacebookLeadAdsRetryState(state)
	return state, true, nil
}

func encodeFacebookLeadAdsRetryCursor(state facebookLeadAdsRetryState) string {
	state = normalizeFacebookLeadAdsRetryState(state)
	raw, _ := json.Marshal(state)
	return facebookLeadAdsRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func normalizeFacebookLeadAdsRetryState(state facebookLeadAdsRetryState) facebookLeadAdsRetryState {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if underlying, err := decodeFacebookLeadAdsCursor(state.Cursor); err == nil {
			state.After = strings.TrimSpace(underlying.After)
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = truncateTypeformString(strings.TrimSpace(state.LastError), 500)
	return state
}

func facebookLeadAdsRetryCursorDue(state facebookLeadAdsRetryState, now time.Time) bool {
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

func facebookLeadAdsBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := facebookLeadAdsRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeFacebookLeadAdsRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(facebookLeadAdsRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeFacebookLeadAdsRetryCursor(state)
}

func facebookLeadAdsRetryDelay(attempt int, err error) time.Duration {
	var providerErr FacebookLeadAdsProviderError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > facebookLeadAdsRetryMaxDelay {
			return facebookLeadAdsRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return facebookLeadAdsRetryInitialDelay
	}
	delay := facebookLeadAdsRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= facebookLeadAdsRetryMaxDelay {
			return facebookLeadAdsRetryMaxDelay
		}
	}
	return delay
}
