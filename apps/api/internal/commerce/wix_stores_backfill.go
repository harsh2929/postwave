package commerce

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	wixStoresBulkBackfillDefaultMaxPages  = 10
	wixStoresBulkBackfillAbsoluteMaxPages = 100
)

type WixStoresBackfillStore interface {
	GetIntegration(context.Context, string, string) (*Integration, error)
	Sync(context.Context, string, string, SyncRequest, time.Time) (*SyncSummary, error)
	SetIntegrationSync(context.Context, string, string, string, time.Time, error) error
}

type WixStoresBulkBackfillRunner struct {
	Store      WixStoresBackfillStore
	Backfiller WixStoresBackfiller
	MaxPages   int
	Now        func() time.Time
}

type WixStoresBulkBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	CustomersUpserted int    `json:"customers_upserted"`
	ProductsUpserted  int    `json:"products_upserted"`
	OrdersUpserted    int    `json:"orders_upserted"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r WixStoresBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (WixStoresBulkBackfillSummary, error) {
	if r.Store == nil {
		return WixStoresBulkBackfillSummary{}, fmt.Errorf("wix stores bulk backfill store is required")
	}
	if r.Backfiller == nil {
		return WixStoresBulkBackfillSummary{}, fmt.Errorf("wix stores bulk backfiller is required")
	}
	integration, err := r.Store.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return WixStoresBulkBackfillSummary{}, err
	}
	if integration == nil {
		return WixStoresBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderWixStores {
		return WixStoresBulkBackfillSummary{}, fmt.Errorf("wix stores bulk backfill requires a Wix Stores integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := WixStoresBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		return summary, nil
	}
	if retry, ok, err := decodeWixStoresRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !wixStoresRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := normalizeWixStoresBulkBackfillMaxPages(r.MaxPages)
	for summary.Pages < maxPages {
		req, err := r.Backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := wixStoresBackfillRetryCursor(cursor, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, r.now(), err)
			return summary, err
		}
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		if !syncRequestHasPayload(req) {
			if summary.Cursor == wixStoresCursorComplete {
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
			retryCursor := wixStoresBackfillRetryCursor(cursor, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, r.now(), err)
			return summary, err
		}
		summary.Pages++
		if page != nil {
			summary.CustomersUpserted += page.CustomersUpserted
			summary.ProductsUpserted += page.ProductsUpserted
			summary.OrdersUpserted += page.OrdersUpserted
			if strings.TrimSpace(page.Cursor) != "" {
				summary.Cursor = page.Cursor
			}
		}
		cursor = summary.Cursor
		if cursor == wixStoresCursorComplete {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r WixStoresBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func normalizeWixStoresBulkBackfillMaxPages(maxPages int) int {
	if maxPages <= 0 {
		return wixStoresBulkBackfillDefaultMaxPages
	}
	if maxPages > wixStoresBulkBackfillAbsoluteMaxPages {
		return wixStoresBulkBackfillAbsoluteMaxPages
	}
	return maxPages
}
