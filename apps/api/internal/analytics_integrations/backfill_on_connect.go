// SPDX-License-Identifier: AGPL-3.0-only
//
// backfill_on_connect.go — Klaviyo-style automatic history import when an
// analytics/CDP provider (PostHog, Triple Whale, Mixpanel, Amplitude) is
// connected, instead of requiring the operator to manually POST /backfill page
// by page. Gated per integration by settings["backfill_on_connect"] (default
// on); a no-op for providers with no native puller.
package analytics_integrations

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_backfill"
	"github.com/postwave/postwave/apps/api/internal/safego"
)

const analyticsBackfillOnConnectPageDelay = 300 * time.Millisecond

// maybeBackfillOnConnect starts a bounded background history import for a freshly
// connected analytics integration, unless opted out or the provider has no puller.
func (d *Deps) maybeBackfillOnConnect(integration *Integration) {
	if d == nil || d.Repo == nil || integration == nil {
		return
	}
	if settingDisabled(integration.Settings, "backfill_on_connect") {
		return
	}
	if !d.hasProviderPuller(integration.Provider) {
		return
	}
	tenantID := integration.TenantID
	snapshot := *integration
	safego.Go(d.Logger, "analytics_integrations.backfill_on_connect", func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		res := integration_backfill.Drain(ctx, integration_backfill.Options{
			StartCursor: snapshot.SyncCursor,
			PageDelay:   analyticsBackfillOnConnectPageDelay,
		}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
			return d.backfillPageOnce(ctx, tenantID, &snapshot, cursor)
		})
		if d.Logger != nil {
			d.Logger.Info("analytics backfill-on-connect finished",
				"provider", snapshot.Provider, "integration_id", snapshot.ID,
				"pages", res.PagesRun, "rows", res.RowsTotal, "stop", string(res.Stop))
		}
	})
}

// backfillPageOnce pulls + applies one provider page and records the run,
// returning rows SEEN (profiles + events) and the next cursor.
func (d *Deps) backfillPageOnce(ctx context.Context, tenantID string, integration *Integration, cursor string) (integration_backfill.PageResult, error) {
	pulled, pullMeta, ok, err := d.providerPullWithRetry(ctx, tenantID, integration, cursor)
	if err != nil {
		return integration_backfill.PageResult{}, err
	}
	if !ok {
		return integration_backfill.PageResult{}, nil
	}
	if pullMeta.RetryDeferred {
		return integration_backfill.PageResult{NextCursor: pulled.Cursor}, nil
	}
	in := normalizeSyncRequest(pulled)
	in.RunMode = "backfill"
	current, err := d.currentAnalyticsIntegrationForSync(ctx, tenantID, integration)
	if err != nil {
		if errors.Is(err, ErrDisconnected) {
			return integration_backfill.PageResult{}, nil
		}
		return integration_backfill.PageResult{}, err
	}
	integration = current
	started := d.now()
	summary := d.executeSync(ctx, tenantID, integration, in)
	var syncErr error
	if analyticsProviderPulledSyncFailed(in, summary) {
		syncErr = analyticsSyncFailureError(integration.Provider, summary)
		retryCursor, _ := analyticsProviderRetryCursor(integration.Provider, pullMeta.Cursor, "SYNC_FAILED", syncErr, d.now())
		in.Cursor = retryCursor
		summary.Cursor = retryCursor
	}
	completed := d.now()
	seen := summary.ProfilesSeen + summary.EventsSeen
	if seen > 0 || summary.Status != "completed" || in.Cursor != "" && in.Cursor != cursor {
		if _, err := d.Repo.RecordSyncRun(ctx, tenantID, integration.ID, summary, in, started, completed); err != nil {
			return integration_backfill.PageResult{}, fmt.Errorf("record backfill run: %w", err)
		}
	}
	if syncErr != nil {
		return integration_backfill.PageResult{}, syncErr
	}
	integration.SyncCursor = summary.Cursor
	rows := seen
	if rows == 0 && in.Cursor != "" && in.Cursor != cursor && !analyticsProviderCursorComplete(integration.Provider, in.Cursor) {
		rows = 1
	}
	return integration_backfill.PageResult{Rows: rows, NextCursor: summary.Cursor}, nil
}

// hasProviderPuller reports whether the provider has a native puller wired.
func (d *Deps) hasProviderPuller(provider string) bool {
	switch provider {
	case ProviderPostHog:
		return d.PostHogBackfiller != nil
	case ProviderTripleWhale:
		return d.TripleWhaleBackfiller != nil
	case ProviderMixpanel:
		return d.MixpanelBackfiller != nil
	case ProviderAmplitude:
		return d.AmplitudeBackfiller != nil
	default:
		return false
	}
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
