// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

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
	rechargeRetryCursorPrefix           = "recharge_retry:"
	rechargeBulkBackfillDefaultMaxPages = 10
	rechargeRetryInitialDelay           = 15 * time.Minute
	rechargeRetryMaxDelay               = 6 * time.Hour
)

var errIntegrationDisconnected = errors.New("subscription integration is disconnected")

type rechargeRetryState struct {
	Cursor         string `json:"cursor"`
	ProviderCursor string `json:"provider_cursor,omitempty"`
	Attempts       int    `json:"attempts,omitempty"`
	NextAttemptAt  string `json:"next_attempt_at,omitempty"`
	LastStatus     string `json:"last_status,omitempty"`
	LastError      string `json:"last_error,omitempty"`
}

type RechargeBulkBackfillRunner struct {
	Deps       *Deps
	Backfiller RechargeBackfiller
	MaxPages   int
	Now        func() time.Time
}

type RechargeBulkBackfillSummary struct {
	IntegrationID         string `json:"integration_id"`
	Pages                 int    `json:"pages"`
	Complete              bool   `json:"complete"`
	SubscriptionsSeen     int    `json:"subscriptions_seen"`
	SubscriptionsUpserted int    `json:"subscriptions_upserted"`
	ShipmentsSeen         int    `json:"shipments_seen"`
	ShipmentsUpserted     int    `json:"shipments_upserted"`
	EventsSeen            int    `json:"events_seen"`
	EventsTracked         int    `json:"events_tracked"`
	Cursor                string `json:"cursor,omitempty"`
	LastError             string `json:"last_error,omitempty"`
	MaxPagesExhausted     bool   `json:"max_pages_exhausted,omitempty"`
}

func (r RechargeBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (RechargeBulkBackfillSummary, error) {
	if r.Deps == nil || r.Deps.Repo == nil {
		return RechargeBulkBackfillSummary{}, fmt.Errorf("recharge bulk backfill deps are required")
	}
	backfiller := r.Backfiller
	if backfiller == nil {
		backfiller = r.Deps.RechargeBackfiller
	}
	if backfiller == nil {
		return RechargeBulkBackfillSummary{}, fmt.Errorf("recharge bulk backfiller is required")
	}
	integration, err := r.Deps.Repo.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return RechargeBulkBackfillSummary{}, err
	}
	if integration == nil {
		return RechargeBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderRecharge {
		return RechargeBulkBackfillSummary{}, fmt.Errorf("recharge bulk backfill requires a Recharge integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := RechargeBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if subscriptionIntegrationDisconnected(integration) {
		return summary, nil
	}
	retryBaseCursor := cursor
	if retry, ok, err := decodeRechargeRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !rechargeRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		retryBaseCursor = cursor
		cursor = retry.Cursor
	}
	maxPages := r.maxPages()
	for summary.Pages < maxPages {
		req, err := backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := rechargeBackfillRetryCursor(retryBaseCursor, "BACKFILL_FAILED", err, r.now())
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
		syncFailed := rechargeProviderPulledSyncFailed(req, pageSummary)
		var syncErr error
		if syncFailed {
			syncErr = rechargeSyncFailureError(pageSummary)
			retryCursor := rechargeBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", syncErr, r.now())
			pageSummary.Cursor = retryCursor
			req.Cursor = retryCursor
			summary.Cursor = retryCursor
			summary.LastError = syncErr.Error()
		}
		run, err := r.Deps.Repo.RecordSyncRun(ctx, tenantID, integration.ID, pageSummary, req, started, completed)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := rechargeBackfillRetryCursor(retryBaseCursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.recordFailure(ctx, tenantID, integration.ID, retryCursor, err)
			return summary, err
		}
		pageSummary.RunID = run.ID
		if syncRequestHasRows(req) {
			summary.Pages++
		}
		summary.SubscriptionsSeen += pageSummary.SubscriptionsSeen
		summary.SubscriptionsUpserted += pageSummary.SubscriptionsUpserted
		summary.ShipmentsSeen += pageSummary.ShipmentsSeen
		summary.ShipmentsUpserted += pageSummary.ShipmentsUpserted
		summary.EventsSeen += pageSummary.EventsSeen
		summary.EventsTracked += pageSummary.EventsTracked
		if syncFailed {
			return summary, syncErr
		}
		cursor = firstString(pageSummary.Cursor, req.Cursor, cursor)
		retryBaseCursor = cursor
		summary.Cursor = cursor
		if !syncRequestHasRows(req) {
			if cursor == rechargeCursorComplete {
				summary.Complete = true
			}
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r RechargeBulkBackfillRunner) recordFailure(ctx context.Context, tenantID, integrationID, cursor string, syncErr error) error {
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

func (r RechargeBulkBackfillRunner) maxPages() int {
	if r.MaxPages <= 0 {
		return rechargeBulkBackfillDefaultMaxPages
	}
	return r.MaxPages
}

func (r RechargeBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	if r.Deps != nil && r.Deps.Now != nil {
		return r.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func syncRequestHasRows(req SyncRequest) bool {
	return len(req.Subscriptions)+len(req.Shipments)+len(req.Events) > 0
}

func rechargeProviderPulledSyncFailed(req SyncRequest, summary SyncSummary) bool {
	return syncRequestHasRows(req) && strings.EqualFold(strings.TrimSpace(summary.Status), "failed")
}

func rechargeSyncFailureError(summary SyncSummary) error {
	return errors.New(firstString(summary.ErrorMessage, "recharge sync failed"))
}

func subscriptionIntegrationDisconnected(integration *Integration) bool {
	return integration != nil && strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected")
}

func decodeRechargeRetryCursor(cursor string) (rechargeRetryState, bool, error) {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" || !strings.HasPrefix(cursor, rechargeRetryCursorPrefix) {
		return rechargeRetryState{}, false, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, rechargeRetryCursorPrefix))
	if err != nil {
		return rechargeRetryState{}, true, fmt.Errorf("decode Recharge retry cursor: %w", err)
	}
	var state rechargeRetryState
	if err := json.Unmarshal(raw, &state); err != nil {
		return rechargeRetryState{}, true, fmt.Errorf("parse Recharge retry cursor: %w", err)
	}
	state = normalizeRechargeRetryState(state)
	return state, true, nil
}

func encodeRechargeRetryCursor(state rechargeRetryState) string {
	state = normalizeRechargeRetryState(state)
	raw, _ := json.Marshal(state)
	return rechargeRetryCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func normalizeRechargeRetryState(state rechargeRetryState) rechargeRetryState {
	state.Cursor = strings.TrimSpace(state.Cursor)
	if state.Cursor != "" {
		if providerCursor := decodeRechargeCursor(state.Cursor); providerCursor != rechargeCursorComplete {
			state.ProviderCursor = strings.TrimSpace(providerCursor)
		}
	}
	state.LastStatus = strings.ToUpper(strings.TrimSpace(state.LastStatus))
	state.LastError = rechargeTruncate(strings.TrimSpace(state.LastError), 500)
	return state
}

func rechargeRetryCursorDue(state rechargeRetryState, now time.Time) bool {
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

func rechargeBackfillRetryCursor(cursor, status string, retryErr error, now time.Time) string {
	state := rechargeRetryState{Cursor: strings.TrimSpace(cursor)}
	if existing, ok, err := decodeRechargeRetryCursor(cursor); err == nil && ok {
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
	state.NextAttemptAt = now.UTC().Add(rechargeRetryDelay(state.Attempts, retryErr)).Format(time.RFC3339)
	return encodeRechargeRetryCursor(state)
}

func rechargeRetryDelay(attempt int, err error) time.Duration {
	var providerErr RechargeRESTError
	if err != nil && errors.As(err, &providerErr) && providerErr.RetryAfter > 0 {
		if providerErr.RetryAfter > rechargeRetryMaxDelay {
			return rechargeRetryMaxDelay
		}
		return providerErr.RetryAfter
	}
	if attempt <= 1 {
		return rechargeRetryInitialDelay
	}
	delay := rechargeRetryInitialDelay
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= rechargeRetryMaxDelay {
			return rechargeRetryMaxDelay
		}
	}
	return delay
}
