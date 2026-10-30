// SPDX-License-Identifier: AGPL-3.0-only
//
// backfill_on_connect.go — Klaviyo-style "import your order history the moment
// you connect" for commerce. When a managed-puller store integration is created
// we kick off a bounded background drain that walks the provider's backfill pages
// (customers / products / orders) to completion instead of requiring the operator
// to manually POST /backfill repeatedly. Gated per integration by
// settings["backfill_on_connect"] (default on).
package commerce

import (
	"context"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_backfill"
	"github.com/postwave/postwave/apps/api/internal/safego"
)

const commerceBackfillOnConnectPageDelay = 300 * time.Millisecond

// commercePullerProviders are the providers providerBackfillRequest can pull
// history for (its switch arms). Membership decides whether connecting kicks off
// an automatic history import.
var commercePullerProviders = map[string]bool{
	ProviderShopify:       true,
	ProviderWooCommerce:   true,
	ProviderBigCommerce:   true,
	ProviderStripe:        true,
	ProviderSquare:        true,
	ProviderPayPal:        true,
	ProviderRazorpay:      true,
	ProviderAdobeCommerce: true,
	ProviderWixStores:     true,
	ProviderSquarespace:   true,
}

// maybeBackfillOnConnect starts a bounded background history import for a freshly
// connected store, unless the tenant opted out or the provider has no puller.
func (d *Deps) maybeBackfillOnConnect(integration *Integration) {
	if d == nil || d.Repo == nil || integration == nil {
		return
	}
	if commerceSettingDisabled(integration.Settings, "backfill_on_connect") {
		return
	}
	if !commercePullerProviders[integration.Provider] {
		return
	}
	tenantID := integration.TenantID
	integrationID := integration.ID
	provider := integration.Provider
	startCursor := integration.SyncCursor
	safego.Go(d.Logger, "commerce.backfill_on_connect", func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		res := integration_backfill.Drain(ctx, integration_backfill.Options{
			StartCursor: startCursor,
			PageDelay:   commerceBackfillOnConnectPageDelay,
		}, func(ctx context.Context, cursor string) (integration_backfill.PageResult, error) {
			return d.backfillPageOnce(ctx, tenantID, integrationID, cursor)
		})
		if d.Logger != nil {
			d.Logger.Info("commerce backfill-on-connect finished",
				"provider", provider, "integration_id", integrationID,
				"pages", res.PagesRun, "rows", res.RowsTotal, "stop", string(res.Stop))
		}
	})
}

// backfillPageOnce pulls one provider page and applies it via Repo.Sync (which
// upserts and records the run + advances the cursor), returning the rows SEEN in
// the page and the next cursor. Continuation is keyed on rows seen, not rows
// upserted, so an all-duplicate page still advances rather than ending the walk.
func (d *Deps) backfillPageOnce(ctx context.Context, tenantID, integrationID, cursor string) (integration_backfill.PageResult, error) {
	pulled, meta, ok, err := d.providerBackfillRequest(ctx, tenantID, integrationID, cursor)
	if err != nil {
		return integration_backfill.PageResult{}, err
	}
	if !ok || !syncRequestHasPayload(pulled) {
		return integration_backfill.PageResult{NextCursor: pulled.Cursor}, nil // exhausted
	}
	out, err := d.Repo.Sync(ctx, tenantID, integrationID, pulled, d.now())
	if err != nil {
		if retryCursor, ok := commerceProviderRetryCursor(meta.Provider, meta.Cursor, "SYNC_FAILED", err, d.now()); ok {
			_ = d.Repo.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, d.now(), err)
		}
		return integration_backfill.PageResult{}, err
	}
	seen := len(pulled.Customers) + len(pulled.Products) + len(pulled.ProductDeletions) + len(pulled.Orders) + len(pulled.ProviderEvents)
	next := pulled.Cursor
	if out != nil && out.Cursor != "" {
		next = out.Cursor
	}
	return integration_backfill.PageResult{Rows: seen, NextCursor: next}, nil
}

// commerceSettingDisabled reports whether a boolean-ish setting is explicitly
// off. Absent = enabled (opt-out semantics).
func commerceSettingDisabled(settings map[string]any, key string) bool {
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
