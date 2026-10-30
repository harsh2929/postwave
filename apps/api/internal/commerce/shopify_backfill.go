package commerce

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	shopifyBulkBackfillDefaultMaxPages  = 25
	shopifyBulkBackfillAbsoluteMaxPages = 250
)

type ShopifyBulkBackfillRunner struct {
	Store      ShopifyBackfillStore
	Backfiller ShopifyBackfiller
	MaxPages   int
	Now        func() time.Time
}

type ShopifyBackfillStore interface {
	GetIntegration(context.Context, string, string) (*Integration, error)
	Sync(context.Context, string, string, SyncRequest, time.Time) (*SyncSummary, error)
	SetIntegrationSync(context.Context, string, string, string, time.Time, error) error
}

func (r ShopifyBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (ShopifyBulkBackfillSummary, error) {
	if r.Store == nil {
		return ShopifyBulkBackfillSummary{}, fmt.Errorf("shopify bulk backfill store is required")
	}
	if r.Backfiller == nil {
		return ShopifyBulkBackfillSummary{}, fmt.Errorf("shopify bulk backfiller is required")
	}
	integration, err := r.Store.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return ShopifyBulkBackfillSummary{}, err
	}
	if integration == nil {
		return ShopifyBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderShopify {
		return ShopifyBulkBackfillSummary{}, fmt.Errorf("shopify bulk backfill requires a Shopify integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := ShopifyBulkBackfillSummary{
		IntegrationID: integration.ID,
		Cursor:        cursor,
	}
	if strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		return summary, nil
	}
	maxPages := normalizeShopifyBulkBackfillMaxPages(r.MaxPages)
	for summary.Pages < maxPages {
		req, err := r.Backfiller.BackfillPage(ctx, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, cursor, r.now(), err)
			return summary, err
		}
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		if !syncRequestHasPayload(req) {
			if summary.Cursor == shopifyBackfillCursorComplete {
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
			_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, cursor, r.now(), err)
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
		if cursor == shopifyBackfillCursorComplete {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r ShopifyBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func normalizeShopifyBulkBackfillMaxPages(maxPages int) int {
	if maxPages <= 0 {
		return shopifyBulkBackfillDefaultMaxPages
	}
	if maxPages > shopifyBulkBackfillAbsoluteMaxPages {
		return shopifyBulkBackfillAbsoluteMaxPages
	}
	return maxPages
}
