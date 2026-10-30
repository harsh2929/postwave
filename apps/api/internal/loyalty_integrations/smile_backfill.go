// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

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
	smileRetryCursorPrefix           = "smile_retry:"
	smileBulkBackfillDefaultMaxPages = 10
	smileRetryInitialDelay           = 15 * time.Minute
	smileRetryMaxDelay               = 6 * time.Hour
)

var errIntegrationDisconnected = errors.New("loyalty integration is disconnected")

type smileRetryState struct {
	Cursor         string `json:"cursor"`
	ProviderCursor string `json:"provider_cursor,omitempty"`
	Attempts       int    `json:"attempts,omitempty"`
	NextAttemptAt  string `json:"next_attempt_at,omitempty"`
	LastStatus     string `json:"last_status,omitempty"`
	LastError      string `json:"last_error,omitempty"`
}

type SmileBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller LoyaltyBackfiller
	MaxPages   int
	Now        func() time.Time
}

type SmileBulkBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	MembersSeen       int    `json:"members_seen"`
	MembersUpserted   int    `json:"members_upserted"`
	EventsSeen        int    `json:"events_seen"`
	EventsTracked     int    `json:"events_tracked"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r SmileBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (SmileBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return SmileBulkBackfillSummary{}, fmt.Errorf("smile bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.SmileBackfiller
	}
	if backfiller == nil {
		return SmileBulkBackfillSummary{}, fmt.Errorf("smile bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return SmileBulkBackfillSummary{}, err
	}
	if integration == nil {
		return SmileBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderSmile {
		return SmileBulkBackfillSummary{}, fmt.Errorf("smile bulk backfill requires a Smile.io integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := SmileBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if loyaltyIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor := cursor
	if retry, ok, err := decodeSmileRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !smileRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		retryBaseCursor = cursor
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		current, err := r.Deps.currentLoyaltyIntegrationForSync(ctx, tenantID, integration)
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
			retryCursor := smileBackfillRetryCursor(retryBaseCursor, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		req = normalizeSyncRequest(req)
		req.RunMode = "scheduled"
		current, err = r.Deps.currentLoyaltyIntegrationForSync(ctx, tenantID, integration)
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
		syncFailed := smileProviderPulledSyncFailed(req, pageSummary)
		var syncErr error
		if syncFailed {
			syncErr = smileSyncFailureError(pageSummary)
			retryCursor := smileBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", syncErr, r.now())
			req.Cursor = retryCursor
			pageSummary.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.LastError = syncErr.Error()
		}
		completed := r.now()
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := smileBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if syncRequestHasLoyaltyRows(req) {
			summary.Pages++
		}
		summary.MembersSeen += pageSummary.MembersSeen
		summary.MembersUpserted += pageSummary.MembersUpserted
		summary.EventsSeen += pageSummary.EventsSeen
		summary.EventsTracked += pageSummary.EventsTracked
		if syncFailed {
			return summary, syncErr
		}
		cursor = firstString(pageSummary.Cursor, req.Cursor, cursor)
		retryBaseCursor = cursor
		summary.Cursor = cursor
		if !syncRequestHasLoyaltyRows(req) {
			if cursor == smileCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r SmileBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r SmileBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return smileBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r SmileBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func syncRequestHasLoyaltyRows(req SyncRequest) bool {
	return len(req.Members)+len(req.Events) > 0
}

func smileProviderPulledSyncFailed(req SyncRequest, summary SyncSummary) bool {
	return syncRequestHasLoyaltyRows(req) && strings.EqualFold(strings.TrimSpace(summary.Status), "failed")
}

func smileSyncFailureError(summary SyncSummary) error {
	msg := strings.TrimSpace(summary.ErrorMessage)
	if msg == "" {
		msg = "smile sync failed"
	}
	return errors.New(msg)
}

func loyaltyIntegrationDisconnected(integration *Integration) bool {
	return integration != nil && strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected")
}

func decodeSmileRetryCursor(cursor string) (smileRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, smileRetryCursorPrefix) {
		return smileRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, smileRetryCursorPrefix))
	if err != nil {
		return smileRetryState{}, true, fmt.Errorf("decode Smile retry cursor: %w", err)
	}
	var state smileRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return smileRetryState{}, true, fmt.Errorf("parse Smile retry cursor: %w", err)
	}
	state = normalizeSmileRetryState(state)
	return state, true, nil
}

func encodeSmileRetryCursor(state smileRetryState) string {
	state = normalizeSmileRetryState(state)
	raw, _ := json.Marshal(state)
	return smileRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func normalizeSmileRetryState(state smileRetryState) smileRetryState {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if providerCursor := decodeSmileCursor(state.Cursor); providerCursor != smileCursorComplete {
			state.ProviderCursor = strings.TrimSpace(providerCursor)
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = loyaltyTruncate(strings.TrimSpace(state.LastError), 500)
	return state
}

func smileRetryCursorDue(state smileRetryState, now time.Time) bool {
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

func smileBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := smileRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeSmileRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(smileRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeSmileRetryCursor(state)
}

func smileRetryDelay(attempt int, err error) time.Duration {
	var providerErr LoyaltyRESTError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > smileRetryMaxDelay {
			return smileRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return smileRetryInitialDelay
	}
	delay := smileRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= smileRetryMaxDelay {
			return smileRetryMaxDelay
		}
	}
	return delay
}

func decodeSmileCursor(cursor string) string {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return ""
	}
	if cursor == smileCursorComplete {
		return smileCursorComplete
	}
	if cursor == smilePointsCursor {
		return "points"
	}
	if state, ok := decodeSmilePointsCursorState(cursor); ok {
		out := "points"
		if state.Cursor != "" {
			out += ":" + state.Cursor
		}
		if state.UpdatedAtMin != "" {
			out += ":updated_at_min=" + state.UpdatedAtMin
		}
		return out
	}
	if cursor == smileRewardsCursor {
		return "rewards"
	}
	if state, ok := decodeSmileRewardsCursorState(cursor); ok {
		out := "rewards"
		if state.Cursor != "" {
			out += ":" + state.Cursor
		}
		if state.UpdatedAtMin != "" {
			out += ":updated_at_min=" + state.UpdatedAtMin
		}
		return out
	}
	return strings.TrimPrefix(cursor, smileCursorPrefix)
}
