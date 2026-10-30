// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

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
	yotpoRetryCursorPrefix           = "yotpo_retry:"
	yotpoBulkBackfillDefaultMaxPages = 10
	yotpoRetryInitialDelay           = 15 * time.Minute
	yotpoRetryMaxDelay               = 6 * time.Hour
)

var errIntegrationDisconnected = errors.New("review integration is disconnected")

type yotpoRetryState struct {
	Cursor         string `json:"cursor"`
	ProviderCursor string `json:"provider_cursor,omitempty"`
	Attempts       int    `json:"attempts,omitempty"`
	NextAttemptAt  string `json:"next_attempt_at,omitempty"`
	LastStatus     string `json:"last_status,omitempty"`
	LastError      string `json:"last_error,omitempty"`
}

type YotpoBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller ReviewBackfiller
	MaxPages   int
	Now        func() time.Time
}

type YotpoBulkBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	ReviewsSeen       int    `json:"reviews_seen"`
	ReviewsImported   int    `json:"reviews_imported"`
	ProfilesUpserted  int    `json:"profiles_upserted"`
	EventsTracked     int    `json:"events_tracked"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r YotpoBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (YotpoBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return YotpoBulkBackfillSummary{}, fmt.Errorf("yotpo bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.YotpoBackfiller
	}
	if backfiller == nil {
		return YotpoBulkBackfillSummary{}, fmt.Errorf("yotpo bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return YotpoBulkBackfillSummary{}, err
	}
	if integration == nil {
		return YotpoBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderYotpo {
		return YotpoBulkBackfillSummary{}, fmt.Errorf("yotpo bulk backfill requires a Yotpo integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := YotpoBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if reviewIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor := cursor
	if retry, ok, err := decodeYotpoRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !yotpoRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		retryBaseCursor = cursor
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		current, err := r.Deps.currentReviewIntegrationForSync(ctx, tenantID, integration)
		if err != nil {
			if errors.Is(err, errIntegrationDisconnected) {
				return summary, nil
			}
			summary.LastError = err.Error()
			return summary, err
		}
		integration = current
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := yotpoBackfillRetryCursor(retryBaseCursor, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = "scheduled"
		current, err = r.Deps.currentReviewIntegrationForSync(ctx, tenantID, integration)
		if err != nil {
			if errors.Is(err, errIntegrationDisconnected) {
				return summary, nil
			}
			summary.LastError = err.Error()
			return summary, err
		}
		integration = current
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		started := r.now()
		pageSummary := r.Deps.executeSync(ctx, tenantID, integration, req)
		syncFailed := yotpoProviderPulledSyncFailed(req, pageSummary)
		var syncErr error
		if syncFailed {
			syncErr = yotpoSyncFailureError(pageSummary)
			retryCursor := yotpoBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", syncErr, r.now())
			req.Cursor = retryCursor
			pageSummary.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.LastError = syncErr.Error()
		}
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := yotpoBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if syncRequestHasReviews(req) {
			summary.Pages++
		}
		summary.ReviewsSeen += pageSummary.ReviewsSeen
		summary.ReviewsImported += pageSummary.ReviewsImported
		summary.ProfilesUpserted += pageSummary.ProfilesUpserted
		summary.EventsTracked += pageSummary.EventsTracked
		if syncFailed {
			return summary, syncErr
		}
		cursor = firstString(pageSummary.Cursor, req.Cursor, cursor)
		retryBaseCursor = cursor
		summary.Cursor = cursor
		if !syncRequestHasReviews(req) {
			if cursor == yotpoCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r YotpoBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r YotpoBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return yotpoBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r YotpoBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func syncRequestHasReviews(req SyncRequest) bool {
	return len(req.Reviews) > 0
}

func yotpoProviderPulledSyncFailed(req SyncRequest, summary SyncSummary) bool {
	return syncRequestHasReviews(req) && strings.EqualFold(strings.TrimSpace(summary.Status), "failed")
}

func yotpoSyncFailureError(summary SyncSummary) error {
	msg := strings.TrimSpace(summary.ErrorMessage)
	if msg == "" {
		msg = "yotpo sync failed"
	}
	return errors.New(msg)
}

func reviewIntegrationDisconnected(integration *Integration) bool {
	return integration != nil && strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected")
}

func decodeYotpoRetryCursor(cursor string) (yotpoRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, yotpoRetryCursorPrefix) {
		return yotpoRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, yotpoRetryCursorPrefix))
	if err != nil {
		return yotpoRetryState{}, true, fmt.Errorf("decode Yotpo retry cursor: %w", err)
	}
	var state yotpoRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return yotpoRetryState{}, true, fmt.Errorf("parse Yotpo retry cursor: %w", err)
	}
	state = normalizeYotpoRetryState(state)
	return state, true, nil
}

func encodeYotpoRetryCursor(state yotpoRetryState) string {
	state = normalizeYotpoRetryState(state)
	raw, _ := json.Marshal(state)
	return yotpoRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func normalizeYotpoRetryState(state yotpoRetryState) yotpoRetryState {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if providerCursor := decodeYotpoCursor(state.Cursor); providerCursor != yotpoCursorComplete {
			state.ProviderCursor = strings.TrimSpace(providerCursor)
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = reviewTruncate(strings.TrimSpace(state.LastError), 500)
	return state
}

func yotpoRetryCursorDue(state yotpoRetryState, now time.Time) bool {
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

func yotpoBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := yotpoRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeYotpoRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(yotpoRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeYotpoRetryCursor(state)
}

func yotpoRetryDelay(attempt int, err error) time.Duration {
	var providerErr ReviewRESTError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > yotpoRetryMaxDelay {
			return yotpoRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return yotpoRetryInitialDelay
	}
	delay := yotpoRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= yotpoRetryMaxDelay {
			return yotpoRetryMaxDelay
		}
	}
	return delay
}

func decodeYotpoCursor(cursor string) string {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return ""
	}
	if cursor == yotpoCursorComplete {
		return yotpoCursorComplete
	}
	return strings.TrimPrefix(cursor, yotpoCursorPrefix)
}
