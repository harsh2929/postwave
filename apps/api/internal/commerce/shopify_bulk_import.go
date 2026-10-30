package commerce

import (
	"context"
	"fmt"
	"strings"
	"time"
)

type shopifyAsyncBulkResultImportRunner struct {
	Store    ShopifyBackfillStore
	Importer ShopifyBulkResultImporter
	Now      func() time.Time
}

func (r shopifyAsyncBulkResultImportRunner) Import(ctx context.Context, tenantID, integrationID string, integration Integration, summary ShopifyAsyncBulkBackfillSummary) (ShopifyAsyncBulkBackfillSummary, error) {
	if r.Store == nil {
		return ShopifyAsyncBulkBackfillSummary{}, fmt.Errorf("shopify bulk import store is required")
	}
	importer := r.Importer
	if importer == nil {
		importer = ShopifyJSONLBulkResultImporter{}
	}
	object := normalizeShopifyBackfillObject(summary.Object)
	state := shopifyBulkOperationImportState(integration, summary, object)
	nextCursor := encodeShopifyBackfillCursor(shopifyBackfillState{Object: nextShopifyBackfillObject(object)})
	if batchImporter, ok := importer.(ShopifyBulkResultBatchImporter); ok {
		return r.importBatches(ctx, tenantID, integrationID, integration, summary, state, nextCursor, batchImporter)
	}
	return r.importLegacy(ctx, tenantID, integrationID, integration, summary, state, nextCursor, importer)
}

func (r shopifyAsyncBulkResultImportRunner) importBatches(ctx context.Context, tenantID, integrationID string, integration Integration, summary ShopifyAsyncBulkBackfillSummary, state shopifyBulkOperationCursor, nextCursor string, importer ShopifyBulkResultBatchImporter) (ShopifyAsyncBulkBackfillSummary, error) {
	object := normalizeShopifyBackfillObject(summary.Object)
	importSummary, err := importer.ImportBulkResultBatches(ctx, integration, object, summary.ResultURL, ShopifyBulkResultBatchImportOptions{
		SkipLines: state.LineOffset,
		BatchSize: shopifyBulkResultDefaultBatchSize,
		OnBatch: func(req SyncRequest, lineOffset int64) error {
			state.LineOffset = lineOffset
			state.Attempts = 0
			state.NextAttemptAt = ""
			state.LastStatus = "IMPORTING"
			state.LastError = ""
			req.Cursor = encodeShopifyBulkOperationCursor(state)
			syncSummary, err := r.Store.Sync(ctx, tenantID, integrationID, req, r.now())
			if err != nil {
				return err
			}
			summary.Imported = true
			summary.BatchesImported++
			summary.LinesProcessed = lineOffset
			summary.CustomersUpserted += syncSummary.CustomersUpserted
			summary.ProductsUpserted += syncSummary.ProductsUpserted
			summary.OrdersUpserted += syncSummary.OrdersUpserted
			summary.Cursor = syncSummary.Cursor
			return nil
		},
	})
	summary.LinesProcessed = maxInt64(summary.LinesProcessed, importSummary.LinesProcessed)
	if err != nil {
		retryCursor := shopifyBulkOperationRetryCursor(state, "IMPORT_FAILED", err, r.now())
		_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, r.now(), err)
		return summary, err
	}
	summary.Cursor = nextCursor
	if err := r.Store.SetIntegrationSync(ctx, tenantID, integrationID, nextCursor, r.now(), nil); err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	if summary.Imported {
		summary.Message = "Shopify bulk operation completed and JSONL result was imported in resumable batches."
		return summary, nil
	}
	summary.Message = "Shopify bulk operation completed with no importable records."
	return summary, nil
}

func (r shopifyAsyncBulkResultImportRunner) importLegacy(ctx context.Context, tenantID, integrationID string, integration Integration, summary ShopifyAsyncBulkBackfillSummary, state shopifyBulkOperationCursor, nextCursor string, importer ShopifyBulkResultImporter) (ShopifyAsyncBulkBackfillSummary, error) {
	object := normalizeShopifyBackfillObject(summary.Object)
	req, err := importer.ImportBulkResult(ctx, integration, object, summary.ResultURL)
	if err != nil {
		retryCursor := shopifyBulkOperationRetryCursor(state, "IMPORT_FAILED", err, r.now())
		_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, r.now(), err)
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	req.Cursor = nextCursor
	if syncRequestHasPayload(req) {
		syncSummary, err := r.Store.Sync(ctx, tenantID, integrationID, req, r.now())
		if err != nil {
			retryCursor := shopifyBulkOperationRetryCursor(state, "IMPORT_FAILED", err, r.now())
			_ = r.Store.SetIntegrationSync(ctx, tenantID, integrationID, retryCursor, r.now(), err)
			return ShopifyAsyncBulkBackfillSummary{}, err
		}
		summary.Imported = true
		summary.BatchesImported = 1
		summary.CustomersUpserted = syncSummary.CustomersUpserted
		summary.ProductsUpserted = syncSummary.ProductsUpserted
		summary.OrdersUpserted = syncSummary.OrdersUpserted
		summary.Cursor = syncSummary.Cursor
		summary.Message = "Shopify bulk operation completed and JSONL result was imported."
		return summary, nil
	}
	if err := r.Store.SetIntegrationSync(ctx, tenantID, integrationID, nextCursor, r.now(), nil); err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	summary.Cursor = nextCursor
	summary.Message = "Shopify bulk operation completed with no importable records."
	return summary, nil
}

func shopifyBulkOperationImportState(integration Integration, summary ShopifyAsyncBulkBackfillSummary, object string) shopifyBulkOperationCursor {
	object = normalizeShopifyBackfillObject(object)
	state, ok, _ := decodeShopifyBulkOperationCursor(integration.SyncCursor)
	if !ok || !sameShopifyBulkOperation(state, summary, object) {
		state, ok, _ = decodeShopifyBulkOperationCursor(summary.Cursor)
	}
	if !ok {
		state = shopifyBulkOperationCursor{}
	}
	state.Object = firstNonEmpty(object, state.Object, summary.Object, "customers")
	state.OperationID = firstNonEmpty(summary.OperationID, state.OperationID)
	state.Attempts = 0
	state.NextAttemptAt = ""
	state.LastError = ""
	state.LastStatus = "COMPLETED"
	return state
}

func sameShopifyBulkOperation(state shopifyBulkOperationCursor, summary ShopifyAsyncBulkBackfillSummary, object string) bool {
	if normalizeShopifyBackfillObject(state.Object) != normalizeShopifyBackfillObject(object) {
		return false
	}
	opID := strings.TrimSpace(firstNonEmpty(summary.OperationID, state.OperationID))
	return opID == "" || opID == strings.TrimSpace(state.OperationID)
}

func (r shopifyAsyncBulkResultImportRunner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}
