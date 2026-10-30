package commerce

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	squareBulkBackfillDefaultMaxPages  = 10
	squareBulkBackfillAbsoluteMaxPages = 100
)

type SquareBackfillStore interface {
	GetIntegration(context.Context, string, string) (*Integration, error)
	Sync(context.Context, string, string, SyncRequest, time.Time) (*SyncSummary, error)
	SetIntegrationSync(context.Context, string, string, string, time.Time, error) error
}

type SquareBulkBackfillRunner struct {
	Store      SquareBackfillStore
	Backfiller SquareBackfiller
	MaxPages   int
	Now        func() time.Time
}

type SquareBulkBackfillSummary struct {
	IntegrationID     string `json:"integration_id"`
	Pages             int    `json:"pages"`
	Complete          bool   `json:"complete"`
	CustomersUpserted int    `json:"customers_upserted"`
	ProductsUpserted  int    `json:"products_upserted"`
	ProductsDeleted   int    `json:"products_deleted,omitempty"`
	OrdersUpserted    int    `json:"orders_upserted"`
	EventsRecorded    int    `json:"events_recorded,omitempty"`
	Cursor            string `json:"cursor,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	MaxPagesExhausted bool   `json:"max_pages_exhausted,omitempty"`
}

func (r SquareBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (SquareBulkBackfillSummary, error) {
	if r.Store == nil {
		return SquareBulkBackfillSummary{}, fmt.Errorf("square bulk backfill store is required")
	}
	if r.Backfiller == nil {
		return SquareBulkBackfillSummary{}, fmt.Errorf("square bulk backfiller is required")
	}
	integration, err := r.Store.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return SquareBulkBackfillSummary{}, err
	}
	if integration == nil {
		return SquareBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderSquare {
		return SquareBulkBackfillSummary{}, fmt.Errorf("square bulk backfill requires a Square integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := SquareBulkBackfillSummary{
		IntegrationID: integration.ID,
		Cursor:        cursor,
	}
	if strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		return summary, nil
	}
	retryCursorBase := cursor
	if retry, ok, err := decodeSquareRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !squareRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := normalizeSquareBulkBackfillMaxPages(r.MaxPages)
	for summary.Pages < maxPages {
		req, err := r.Backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := squareBackfillRetryCursor(retryCursorBase, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, r.now(), err)
			return summary, err
		}
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		if !syncRequestHasPayload(req) {
			if summary.Cursor == squareCursorComplete {
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
			retryCursor := squareBackfillRetryCursor(retryCursorBase, "SYNC_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, r.now(), err)
			return summary, err
		}
		summary.Pages++
		if page != nil {
			summary.CustomersUpserted += page.CustomersUpserted
			summary.ProductsUpserted += page.ProductsUpserted
			summary.ProductsDeleted += page.ProductsDeleted
			summary.OrdersUpserted += page.OrdersUpserted
			summary.EventsRecorded += page.EventsRecorded
			if strings.TrimSpace(page.Cursor) != "" {
				summary.Cursor = page.Cursor
			}
		}
		cursor = summary.Cursor
		retryCursorBase = cursor
		if cursor == squareCursorComplete {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r SquareBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func normalizeSquareBulkBackfillMaxPages(maxPages int) int {
	if maxPages <= 0 {
		return squareBulkBackfillDefaultMaxPages
	}
	if maxPages > squareBulkBackfillAbsoluteMaxPages {
		return squareBulkBackfillAbsoluteMaxPages
	}
	return maxPages
}
