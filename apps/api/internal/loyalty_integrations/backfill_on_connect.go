// SPDX-License-Identifier: AGPL-3.0-only
//
// backfill_on_connect.go — Klaviyo-style automatic history import when a loyalty
// provider (Smile, LoyaltyLion, Rivo, ReferralCandy, Friendbuy, …) is connected,
// instead of requiring the operator to manually POST /backfill page by page.
// Gated per integration by settings["backfill_on_connect"] (default on); a no-op
// for providers with no native puller (providerPull returns ok=false before any
// HTTP call, so the drain stops on its first, free, iteration).
package loyalty_integrations

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_backfill"
	"github.com/postwave/postwave/apps/api/internal/safego"
)

const loyaltyBackfillOnConnectPageDelay = 300 * time.Millisecond

// maybeBackfillOnConnect starts a bounded background history import for a freshly
// connected loyalty integration unless the tenant opted out.
func (d *Deps) maybeBackfillOnConnect(integration *Integration) {
	if d == nil || d.Repo == nil || integration == nil {
		return
	}
	if settingDisabled(integration.Settings, "backfill_on_connect") {
		return
	}
	tenantID := integration.TenantID
	snapshot := *integration
	safego.Go(d.Logger, "loyalty_integrations.backfill_on_connect", func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		res := integration_backfill.Drain(ctx, integration_backfill.Options{
			StartCursor: snapshot.SyncCursor,
			PageDelay:   loyaltyBackfillOnConnectPageDelay,
		}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
			return d.backfillPageOnce(ctx, tenantID, &snapshot, cursor)
		})
		if d.Logger != nil {
			d.Logger.Info("loyalty backfill-on-connect finished",
				"provider", snapshot.Provider, "integration_id", snapshot.ID,
				"pages", res.PagesRun, "rows", res.RowsTotal, "stop", string(res.Stop))
		}
	})
}

// backfillPageOnce pulls + applies one provider page and records the run,
// returning rows SEEN (members + events) and the next cursor. ok==false (no
// puller) yields an empty page so the drain stops immediately.
func (d *Deps) backfillPageOnce(ctx context.Context, tenantID string, integration *Integration, cursor string) (integration_backfill.PageResult, error) {
	if integration == nil {
		return integration_backfill.PageResult{}, nil
	}
	current, err := d.Repo.GetIntegration(ctx, tenantID, integration.ID)
	if err != nil {
		return integration_backfill.PageResult{}, err
	}
	if loyaltyIntegrationDisconnected(current) {
		return integration_backfill.PageResult{}, nil
	}
	pulled, meta, ok, err := d.providerPullWithRetry(ctx, tenantID, current, cursor)
	if err != nil {
		return integration_backfill.PageResult{}, err
	}
	if !ok {
		return integration_backfill.PageResult{}, nil
	}
	if meta.RetryDeferred {
		return integration_backfill.PageResult{NextCursor: pulled.Cursor}, nil
	}
	current, err = d.currentLoyaltyIntegrationForSync(ctx, tenantID, current)
	if err != nil {
		if errors.Is(err, errIntegrationDisconnected) {
			return integration_backfill.PageResult{}, nil
		}
		return integration_backfill.PageResult{}, err
	}
	in := normalizeSyncRequest(pulled)
	in.RunMode = "backfill"
	started := d.now()
	summary := d.executeSync(ctx, tenantID, current, in)
	completed := d.now()
	seen := summary.MembersSeen + summary.EventsSeen
	syncFailed := loyaltyProviderPulledSyncFailed(in, summary)
	var syncErr error
	if syncFailed {
		syncErr = loyaltySyncFailureError(meta.Provider, summary)
		if retryCursor, ok := providerRetryCursor(meta.Provider, meta.Cursor, "SYNC_FAILED", syncErr, d.now()); ok {
			summary.Cursor = retryCursor
			in.Cursor = retryCursor
		}
	}
	cursorChanged := strings.TrimSpace(summary.Cursor) != "" && summary.Cursor != current.SyncCursor
	if seen > 0 || summary.Status != "completed" || cursorChanged {
		if _, err := d.Repo.RecordSyncRun(ctx, tenantID, current.ID, summary, in, started, completed); err != nil {
			if retryCursor, ok := providerRetryCursor(meta.Provider, meta.Cursor, "SYNC_FAILED", err, d.now()); ok {
				_ = d.recordProviderFailure(ctx, tenantID, current.ID, retryCursor, err)
			}
			return integration_backfill.PageResult{}, fmt.Errorf("record backfill run: %w", err)
		}
	}
	if syncFailed {
		return integration_backfill.PageResult{}, syncErr
	}
	integration.SyncCursor = summary.Cursor
	return integration_backfill.PageResult{Rows: seen, NextCursor: summary.Cursor}, nil
}

// settingDisabled reports whether a boolean-ish setting is explicitly off.
// Absent = enabled (opt-out semantics).
func settingDisabled(settings map[string]any, key string) bool {
	if settings == nil {
		return false
	}
	v, ok := settings[key]
	if !ok || v == nil {
		return false
	}
	switch t := v.(type) {
	case bool:
		return !t
	case string:
		switch t {
		case "false", "0", "no", "off", "disabled":
			return true
		}
	}
	return false
}
