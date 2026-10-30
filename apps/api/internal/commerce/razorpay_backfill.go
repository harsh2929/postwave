package commerce

import (
	"context"
	"fmt"
	"strings"
	"time"
)

const (
	razorpayBulkBackfillDefaultMaxPages  = 10
	razorpayBulkBackfillAbsoluteMaxPages = 100
)

type RazorpayBackfillStore interface {
	GetIntegration(context.Context, string, string) (*Integration, error)
	Sync(context.Context, string, string, SyncRequest, time.Time) (*SyncSummary, error)
	SetIntegrationSync(context.Context, string, string, string, time.Time, error) error
}

type RazorpayBulkBackfillRunner struct {
	Store      RazorpayBackfillStore
	Backfiller RazorpayBackfiller
	MaxPages   int
	Now        func() time.Time
}

type RazorpayBulkBackfillSummary struct {
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

func (r RazorpayBulkBackfillRunner) Run(ctx context.Context, tenantID, integrationID, cursor string) (RazorpayBulkBackfillSummary, error) {
	if r.Store == nil {
		return RazorpayBulkBackfillSummary{}, fmt.Errorf("razorpay bulk backfill store is required")
	}
	if r.Backfiller == nil {
		return RazorpayBulkBackfillSummary{}, fmt.Errorf("razorpay bulk backfiller is required")
	}
	integration, err := r.Store.GetIntegration(ctx, tenantID, integrationID)
	if err != nil {
		return RazorpayBulkBackfillSummary{}, err
	}
	if integration == nil {
		return RazorpayBulkBackfillSummary{}, ErrNotFound
	}
	if integration.Provider != ProviderRazorpay {
		return RazorpayBulkBackfillSummary{}, fmt.Errorf("razorpay bulk backfill requires a Razorpay integration")
	}
	if strings.TrimSpace(cursor) == "" {
		cursor = integration.SyncCursor
	}
	summary := RazorpayBulkBackfillSummary{
		IntegrationID: integration.ID,
		Cursor:        cursor,
	}
	if strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		return summary, nil
	}
	if retry, ok, err := decodeRazorpayRetryCursor(cursor); err != nil {
		summary.LastError = err.Error()
		return summary, err
	} else if ok {
		if !razorpayRetryCursorDue(retry, r.now()) {
			return summary, nil
		}
		cursor = retry.Cursor
	}
	maxPages := normalizeRazorpayBulkBackfillMaxPages(r.MaxPages)
	for summary.Pages < maxPages {
		req, err := r.Backfiller.BackfillPage(ctx, tenantID, *integration, cursor)
		if err != nil {
			summary.LastError = err.Error()
			retryCursor := razorpayBackfillRetryCursor(cursor, "BACKFILL_FAILED", err, r.now())
			summary.Cursor = retryCursor
			_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, r.now(), err)
			return summary, err
		}
		if strings.TrimSpace(req.Cursor) != "" {
			summary.Cursor = req.Cursor
		}
		if !syncRequestHasPayload(req) {
			if summary.Cursor == razorpayCursorComplete {
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
			retryCursor := razorpayBackfillRetryCursor(cursor, "SYNC_FAILED", err, r.now())
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
		if cursor == razorpayCursorComplete {
			summary.Complete = true
			return summary, nil
		}
	}
	summary.MaxPagesExhausted = true
	return summary, nil
}

func (r RazorpayBulkBackfillRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func normalizeRazorpayBulkBackfillMaxPages(maxPages int) int {
	if maxPages <= 0 {
		return razorpayBulkBackfillDefaultMaxPages
	}
	if maxPages > razorpayBulkBackfillAbsoluteMaxPages {
		return razorpayBulkBackfillAbsoluteMaxPages
	}
	return maxPages
}
