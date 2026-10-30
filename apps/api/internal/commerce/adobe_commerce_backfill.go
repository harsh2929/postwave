package commerce

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	adobeCommerceBulkBackfillDefaultMaxPages  = 10
	adobeCommerceBulkBackfillAbsoluteMaxPages = 100
)

type AdobeCommerceBackfillStore interface {
	GetIntegration(context.Context, string, string) (*Integration, error)
	Sync(context.Context, string, string, SyncRequest, time.Time) (*SyncSummary, error)
	SetIntegrationSync(context.Context, string, string, string, time.Time, error) error
}

type AdobeCommerceBulkBackfillRunner struct {
	Store      AdobeCommerceBackfillStore
	Backfiller AdobeCommerceBackfiller
	MaxPages   int
	Now        func() time.Time
}

type AdobeCommerceBulkBackfillSummary struct {
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

func (r AdobeCommerceBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (AdobeCommerceBulkBackfillSummary, error) {
	if r.Store == nil {
		return AdobeCommerceBulkBackfillSummary{}, fmt.Errorf("adobe commerce bulk backfill store is required")
	}
	if r.Backfiller == nil {
		return AdobeCommerceBulkBackfillSummary{}, fmt.Errorf("adobe commerce bulk backfiller is required")
	}
	integration, err := r.Store.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return AdobeCommerceBulkBackfillSummary{}, err
	}
	if integration == nil {
		return AdobeCommerceBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderAdobeCommerce {
		return AdobeCommerceBulkBackfillSummary{}, fmt.Errorf("adobe commerce bulk backfill requires an Adobe Commerce integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := AdobeCommerceBulkBackfillSummary{
		IntegrationID: integration.ID,
		Cursor:        cursor,
	}
	if strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		return summary, nil
	}
	if retry, ok, err := decodeAdobeCommerceRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !adobeCommerceRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := normalizeAdobeCommerceBulkBackfillMaxPages(r.MaxPages)
	for summary.Pages < maxPages {
		req, err := r.Backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := adobeCommerceBackfillRetryCursor(cursor, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, r.now(), err)
			return summary, err
		}
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		if !syncRequestHasPayload(req) {
			if summary.Cursor == adobeCommerceCursorComplete {
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
			retryCursor := adobeCommerceBackfillRetryCursor(cursor, "SYNC_FAILED", err, r.now())
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
		if cursor == adobeCommerceCursorComplete {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r AdobeCommerceBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func normalizeAdobeCommerceBulkBackfillMaxPages(maxPages int) int {
	if maxPages <= 0 {
		return adobeCommerceBulkBackfillDefaultMaxPages
	}
	if maxPages > adobeCommerceBulkBackfillAbsoluteMaxPages {
		return adobeCommerceBulkBackfillAbsoluteMaxPages
	}
	return maxPages
}
