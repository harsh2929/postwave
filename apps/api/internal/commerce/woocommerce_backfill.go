package commerce

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	woocommerceBulkBackfillDefaultMaxPages  = 10
	woocommerceBulkBackfillAbsoluteMaxPages = 100
)

type WooCommerceBackfillStore interface {
	GetIntegration(context.Context, string, string) (*Integration, error)
	Sync(context.Context, string, string, SyncRequest, time.Time) (*SyncSummary, error)
	SetIntegrationSync(context.Context, string, string, string, time.Time, error) error
}

type WooCommerceBulkBackfillRunner struct {
	Store      WooCommerceBackfillStore
	Backfiller WooCommerceBackfiller
	MaxPages   int
	Now        func() time.Time
}

type WooCommerceBulkBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	CustomersUpserted int    `json:"customers_upserted"`
	ProductsUpserted  int    `json:"products_upserted"`
	OrdersUpserted    int    `json:"orders_upserted"`
	EventsRecorded    int    `json:"events_recorded,omitempty"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r WooCommerceBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (WooCommerceBulkBackfillSummary, error) {
	if r.Store == nil {
		return WooCommerceBulkBackfillSummary{}, fmt.Errorf("woocommerce bulk backfill store is required")
	}
	if r.Backfiller == nil {
		return WooCommerceBulkBackfillSummary{}, fmt.Errorf("woocommerce bulk backfiller is required")
	}
	integration, err := r.Store.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return WooCommerceBulkBackfillSummary{}, err
	}
	if integration == nil {
		return WooCommerceBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderWooCommerce {
		return WooCommerceBulkBackfillSummary{}, fmt.Errorf("woocommerce bulk backfill requires a WooCommerce integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := WooCommerceBulkBackfillSummary{
		IntegrationID: integration.ID,
		Cursor:        cursor,
	}
	if strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		return summary, nil
	}
	if retry, ok, err := decodeWooCommerceRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !wooCommerceRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := normalizeWooCommerceBulkBackfillMaxPages(r.MaxPages)
	for summary.Pages < maxPages {
		req, err := r.Backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := wooCommerceBackfillRetryCursor(cursor, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, r.now(), err)
			return summary, err
		}
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		if !syncRequestHasPayload(req) {
			if summary.Cursor == woocommerceCursorComplete {
				summary.Complete = true
			}
			if err := r.Store.SetIntegrationSync(ctx, tenantID, integrationID, summary.Cursor, r.now(), nil); err != nil {
				summary.LastError = err.Error()
				return summary, err
			}
			return summary, nil
		}
		page, err := r.Store.Sync(ctx, tenantID, integrationID, req, r.now())
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := wooCommerceBackfillRetryCursor(cursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, r.now(), err)
			return summary, err
		}
		summary.Pages++
		if page != nil {
			summary.CustomersUpserted += page.CustomersUpserted
			summary.ProductsUpserted += page.ProductsUpserted
			summary.OrdersUpserted += page.OrdersUpserted
			summary.EventsRecorded += page.EventsRecorded
			if strings.TrimSpace(page.Cursor) != "" {
				summary.Cursor = page.Cursor
			}
		}
		cursor = summary.Cursor
		if cursor == woocommerceCursorComplete {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r WooCommerceBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func normalizeWooCommerceBulkBackfillMaxPages(maxPages int) int {
	if maxPages <= 0 {
		return woocommerceBulkBackfillDefaultMaxPages
	}
	if maxPages > woocommerceBulkBackfillAbsoluteMaxPages {
		return woocommerceBulkBackfillAbsoluteMaxPages
	}
	return maxPages
}
