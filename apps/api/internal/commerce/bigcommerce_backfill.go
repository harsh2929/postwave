package commerce

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	bigCommerceBulkBackfillDefaultMaxPages  = 10
	bigCommerceBulkBackfillAbsoluteMaxPages = 100
)

type BigCommerceBackfillStore interface {
	GetIntegration(context.Context, string, string) (*Integration, error)
	Sync(context.Context, string, string, SyncRequest, time.Time) (*SyncSummary, error)
	SetIntegrationSync(context.Context, string, string, string, time.Time, error) error
}

type BigCommerceBulkBackfillRunner struct {
	Store      BigCommerceBackfillStore
	Backfiller BigCommerceBackfiller
	MaxPages   int
	Now        func() time.Time
}

type BigCommerceBulkBackfillSummary struct {
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

func (r BigCommerceBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (BigCommerceBulkBackfillSummary, error) {
	if r.Store == nil {
		return BigCommerceBulkBackfillSummary{}, fmt.Errorf("bigcommerce bulk backfill store is required")
	}
	if r.Backfiller == nil {
		return BigCommerceBulkBackfillSummary{}, fmt.Errorf("bigcommerce bulk backfiller is required")
	}
	integration, err := r.Store.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return BigCommerceBulkBackfillSummary{}, err
	}
	if integration == nil {
		return BigCommerceBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderBigCommerce {
		return BigCommerceBulkBackfillSummary{}, fmt.Errorf("bigcommerce bulk backfill requires a BigCommerce integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := BigCommerceBulkBackfillSummary{
		IntegrationID: integration.ID,
		Cursor:        cursor,
	}
	if strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeBigCommerceRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !bigCommerceRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := normalizeBigCommerceBulkBackfillMaxPages(r.MaxPages)
	for summary.Pages < maxPages {
		req, err := r.Backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := bigCommerceBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, r.now(), err)
			return summary, err
		}
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		if !syncRequestHasPayload(req) {
			if summary.Cursor == bigCommerceCursorComplete {
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
			retryCursor := bigCommerceBackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
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
		retryCursorBase = cursor
		if cursor == bigCommerceCursorComplete {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r BigCommerceBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func normalizeBigCommerceBulkBackfillMaxPages(maxPages int) int {
	if maxPages <= 0 {
		return bigCommerceBulkBackfillDefaultMaxPages
	}
	if maxPages > bigCommerceBulkBackfillAbsoluteMaxPages {
		return bigCommerceBulkBackfillAbsoluteMaxPages
	}
	return maxPages
}
