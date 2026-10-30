package commerce

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestShopifyBulkResultBatchImporterSkipsAndFlushesProducts(t *testing.T) {
	body := strings.Join([]string{
		`{"id":"gid://shopify/Product/1","title":"One"}`,
		`{"id":"gid://shopify/Product/2","title":"Two"}`,
		`{"id":"gid://shopify/Product/3","title":"Three"}`,
		`{"id":"gid://shopify/Product/4","title":"Four"}`,
		`{"id":"gid://shopify/Product/5","title":"Five"}`,
	}, "\n")
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/jsonl")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	offsets := []int64{}
	counts := []int{}
	importer := ShopifyJSONLBulkResultImporter{
		HTTPClient:           srv.Client(),
		AllowUnsafeLocalURLs: true,
	}
	summary, err := importer.ImportBulkResultBatches(context.Background(), Integration{}, "products", srv.URL, ShopifyBulkResultBatchImportOptions{
		SkipLines: 2,
		BatchSize: 2,
		OnBatch: func(req SyncRequest, lineOffset int64) error {
			offsets = append(offsets, lineOffset)
			counts = append(counts, len(req.Products))
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if summary.LinesSkipped != 2 || summary.LinesProcessed != 5 || summary.BatchesImported != 2 || summary.Products != 3 {
		t.Fatalf("summary = %+v", summary)
	}
	if got := strings.Trim(strings.Join([]string{int64s(offsets), ints(counts)}, " / "), " "); got != "4,5 / 2,1" {
		t.Fatalf("offsets/counts = %s", got)
	}
}

func TestShopifyBulkResultBatchImporterKeepsOrderChildrenWithParent(t *testing.T) {
	body := strings.Join([]string{
		`{"id":"gid://shopify/Order/1","email":"a@example.com","currencyCode":"USD"}`,
		`{"id":"gid://shopify/LineItem/1","title":"Hat","quantity":1,"__parentId":"gid://shopify/Order/1"}`,
		`{"id":"gid://shopify/Order/2","email":"b@example.com","currencyCode":"USD"}`,
	}, "\n")
	var batches []SyncRequest
	var offsets []int64
	summary, err := decodeShopifyBulkResultJSONLBatches(strings.NewReader(body), "orders", 0, ShopifyBulkResultBatchImportOptions{
		BatchSize: 1,
		OnBatch: func(req SyncRequest, lineOffset int64) error {
			batches = append(batches, req)
			offsets = append(offsets, lineOffset)
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if summary.BatchesImported != 2 || summary.Orders != 2 || len(batches) != 2 {
		t.Fatalf("summary=%+v batches=%d", summary, len(batches))
	}
	if offsets[0] != 2 || offsets[1] != 3 {
		t.Fatalf("offsets=%v", offsets)
	}
	if len(batches[0].Orders) != 1 || len(batches[0].Orders[0].LineItems) != 1 {
		t.Fatalf("first order batch = %+v", batches[0])
	}
	if len(batches[1].Orders) != 1 || len(batches[1].Orders[0].LineItems) != 0 {
		t.Fatalf("second order batch = %+v", batches[1])
	}
}

func TestShopifyBulkImportRunnerPreservesCheckpointOnBatchFailure(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	cursor := encodeShopifyBulkOperationCursor(shopifyBulkOperationCursor{
		Object:      "products",
		OperationID: "gid://shopify/BulkOperation/900",
	})
	store := &fakeStore{integration: &Integration{
		ID:          "int_1",
		TenantID:    "tenant-1",
		Provider:    ProviderShopify,
		ShopDomain:  "demo.myshopify.com",
		AccessToken: "shpat_123",
		SyncCursor:  cursor,
	}}
	importErr := errors.New("network dropped after checkpoint")
	out, err := shopifyAsyncBulkResultImportRunner{
		Store:    store,
		Importer: checkpointFailingShopifyBulkImporter{err: importErr},
		Now:      func() time.Time { return now },
	}.Import(context.Background(), "tenant-1", "int_1", *store.integration, ShopifyAsyncBulkBackfillSummary{
		IntegrationID:    "int_1",
		OperationID:      "gid://shopify/BulkOperation/900",
		Object:           "products",
		Status:           "COMPLETED",
		ResultURLPresent: true,
		ResultURL:        "https://storage.googleapis.com/shopify/products.jsonl",
	})
	if !errors.Is(err, importErr) {
		t.Fatalf("err=%v out=%+v", err, out)
	}
	if len(store.lastSyncRequests) != 1 {
		t.Fatalf("sync requests=%d", len(store.lastSyncRequests))
	}
	checkpoint, ok, err := decodeShopifyBulkOperationCursor(store.lastSyncRequest.Cursor)
	if err != nil || !ok || checkpoint.LineOffset != 2 {
		t.Fatalf("batch checkpoint cursor=%q state=%+v ok=%v err=%v", store.lastSyncRequest.Cursor, checkpoint, ok, err)
	}
	retry, ok, err := decodeShopifyBulkOperationCursor(store.lastSyncCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastSyncCursor, ok, err)
	}
	if retry.LineOffset != 2 || retry.Attempts != 1 || retry.LastStatus != "IMPORT_FAILED" || !strings.Contains(retry.LastError, importErr.Error()) {
		t.Fatalf("retry state=%+v syncErr=%v", retry, store.lastSyncErr)
	}
}

type checkpointFailingShopifyBulkImporter struct {
	err error
}

func (i checkpointFailingShopifyBulkImporter) ImportBulkResult(context.Context, Integration, string, string) (SyncRequest, error) {
	return SyncRequest{}, i.err
}

func (i checkpointFailingShopifyBulkImporter) ImportBulkResultBatches(_ context.Context, _ Integration, _ string, _ string, opts ShopifyBulkResultBatchImportOptions) (ShopifyBulkResultImportSummary, error) {
	if err := opts.OnBatch(SyncRequest{
		Products: []ProductInput{{SourceID: "gid://shopify/Product/1", Title: "Desk lamp"}},
	}, 2); err != nil {
		return ShopifyBulkResultImportSummary{}, err
	}
	return ShopifyBulkResultImportSummary{LinesProcessed: 3, BatchesImported: 1, Products: 1}, i.err
}

func int64s(items []int64) string {
	parts := make([]string, 0, len(items))
	for _, item := range items {
		parts = append(parts, strconvFormatInt(item))
	}
	return strings.Join(parts, ",")
}

func ints(items []int) string {
	parts := make([]string, 0, len(items))
	for _, item := range items {
		parts = append(parts, strconvFormatInt(int64(item)))
	}
	return strings.Join(parts, ",")
}

func strconvFormatInt(item int64) string {
	return strconv.FormatInt(item, 10)
}
