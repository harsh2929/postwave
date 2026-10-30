package commerce

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	squarespaceBulkBackfillDefaultMaxPages  = 10
	squarespaceBulkBackfillAbsoluteMaxPages = 100
)

type SquarespaceBackfillStore interface {
	GetIntegration(context.Context, string, string) (*Integration, error)
	Sync(context.Context, string, string, SyncRequest, time.Time) (*SyncSummary, error)
	SetIntegrationSync(context.Context, string, string, string, time.Time, error) error
}

type SquarespaceBulkBackfillRunner struct {
	Store      SquarespaceBackfillStore
	Backfiller SquarespaceBackfiller
	MaxPages   int
	Now        func() time.Time
}

type SquarespaceBulkBackfillSummary struct {
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

func (r SquarespaceBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (SquarespaceBulkBackfillSummary, error) {
	if r.Store == nil {
		return SquarespaceBulkBackfillSummary{}, fmt.Errorf("squarespace bulk backfill store is required")
	}
	if r.Backfiller == nil {
		return SquarespaceBulkBackfillSummary{}, fmt.Errorf("squarespace bulk backfiller is required")
	}
	integration, err := r.Store.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return SquarespaceBulkBackfillSummary{}, err
	}
	if integration == nil {
		return SquarespaceBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderSquarespace {
		return SquarespaceBulkBackfillSummary{}, fmt.Errorf("squarespace bulk backfill requires a Squarespace Commerce integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := SquarespaceBulkBackfillSummary{IntegrationID: integration.ID, Cursor: cursor}
	if strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		return summary, nil
	}
	if retry, ok, err := decodeSquarespaceRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !squarespaceRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := normalizeSquarespaceBulkBackfillMaxPages(r.MaxPages)
	for summary.Pages < maxPages {
		req, err := r.Backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := squarespaceBackfillRetryCursor(cursor, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, r.now(), err)
			return summary, err
		}
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		if !syncRequestHasPayload(req) {
			if summary.Cursor == squarespaceCursorComplete {
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
			retryCursor := squarespaceBackfillRetryCursor(cursor, "SYNC_FAILED", err, r.now())
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
		if cursor == squarespaceCursorComplete {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r SquarespaceBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func normalizeSquarespaceBulkBackfillMaxPages(maxPages int) int {
	if maxPages <= 0 {
		return squarespaceBulkBackfillDefaultMaxPages
	}
	if maxPages > squarespaceBulkBackfillAbsoluteMaxPages {
		return squarespaceBulkBackfillAbsoluteMaxPages
	}
	return maxPages
}
