// SPDX-License-Identifier: AGPL-3.0-only

package warehouse

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/track"
)

// Two ingestion boundaries, one contract.
//
// `internal/track/event_name.go` describes its rule as enforced "at the
// ingestion boundary" — singular. There are two. `POST /api/v1/track` called it
// and this importer, which writes straight into `product_events` from a
// customer's own warehouse tables, did not.
//
// The failure is silent and durable. An imported `Purchase` is a product_events
// row the API would have refused, and it is then unaddressable: a flow trigger
// on `purchase` never fires for it, a segment condition never matches it, and
// the event catalog gains a row that reads as a real, separate event. Nothing
// reports a mismatch, because from every downstream point of view the event
// simply does not exist.

func TestBothIngestionBoundariesShareOneEventNameRule(t *testing.T) {
	// The names a warehouse column plausibly holds, which the API rejects.
	for _, name := range []string{
		"Purchase",            // a capitalised source column
		"purchase completed",  // a space
		"purchase-completed",  // a hyphen
		"Purchase.Completed",  // both
		"1purchase",           // leading digit
		"purchase..completed", // empty segment
		"purchase.",           // trailing dot
		"",                    // empty
	} {
		if track.ValidEventName(name) {
			t.Errorf("ValidEventName(%q) = true; that name cannot be addressed by a "+
				"flow trigger or a segment condition", name)
		}
	}
	for _, name := range []string{
		"purchase", "purchase_completed", "commerce.purchase.completed", "a", "a1_b2.c3",
	} {
		if !track.ValidEventName(name) {
			t.Errorf("ValidEventName(%q) = false; refusing a legitimate name makes "+
				"the importer drop real data", name)
		}
	}
	// The bound is readable from the second boundary so its error message can
	// state the limit without restating the number — a restated constant is the
	// next thing to drift.
	if track.MaxEventNameLength != 128 {
		t.Fatalf("MaxEventNameLength = %d, want 128", track.MaxEventNameLength)
	}
}

func importPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping warehouse import contract test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// Driving the real importer, not asserting on its source text.
//
// The first draft of this test grepped imports.go for `track.ValidEventName`,
// which proves the call is present and nothing about whether it runs on the
// path that inserts. `materializeImportRows` takes a transaction, so there is
// no reason to settle for that.
func TestTheImporterRefusesAnUnaddressableEventName(t *testing.T) {
	pool := importPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'wh', 'studio')`,
		tenantID, "wh-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	var connectionID string
	if err := tx.QueryRow(ctx, `
INSERT INTO warehouse_connections (tenant_id, provider, name, status)
VALUES ($1::uuid, 'snowflake', 'fixture', 'active') RETURNING id::text`,
		tenantID).Scan(&connectionID); err != nil {
		t.Fatalf("seed warehouse_connection: %v", err)
	}

	var subscriberID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'import') RETURNING id::text`,
		tenantID, "wh-"+tenantID[:8]+"@example.test").Scan(&subscriberID); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	// warehouse_sync_runs, which is what warehouse_row_errors.run_id references.
	//
	// A t.Skip here would be worse than a failure: this ledger already records a
	// test that skipped on a NOT NULL violation and reported PASS, so the
	// assertion never ran and nobody knew. If the fixture cannot be built, that
	// is a failure to fix, not a reason to report success.
	var runID string
	if err := tx.QueryRow(ctx, `
INSERT INTO warehouse_sync_runs (tenant_id, connection_id, direction, status)
VALUES ($1::uuid, $2::uuid, 'import', 'running') RETURNING id::text`,
		tenantID, connectionID).Scan(&runID); err != nil {
		t.Fatalf("seed warehouse_sync_run: %v", err)
	}

	rows := []ImportRow{
		{SourceObject: "orders", EventName: "purchase", SubscriberID: subscriberID},
		{SourceObject: "orders", EventName: "Purchase", SubscriberID: subscriberID},
		{SourceObject: "orders", EventName: "purchase completed", SubscriberID: subscriberID},
	}
	imported, failed, err := materializeImportRows(ctx, tx, tenantID, runID, rows, nil)
	if err != nil {
		t.Fatalf("materializeImportRows: %v", err)
	}
	if imported != 1 {
		t.Errorf("imported = %d, want 1 (only the addressable name)", imported)
	}
	if failed != 2 {
		t.Errorf("failed = %d, want 2; an unaddressable event name was written to "+
			"product_events, where nothing downstream can ever match it", failed)
	}

	// Only the valid name reached the table.
	var names []string
	got, err := tx.Query(ctx, `
SELECT event_name FROM product_events WHERE tenant_id = $1::uuid`, tenantID)
	if err != nil {
		t.Fatalf("read product_events: %v", err)
	}
	for got.Next() {
		var n string
		if err := got.Scan(&n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		names = append(names, n)
	}
	got.Close()
	if len(names) != 1 || names[0] != "purchase" {
		t.Fatalf("product_events holds %v, want exactly [purchase]", names)
	}

	// And the refusal is VISIBLE to the operator, with a code they can act on.
	// A dropped row that reports nothing is worse than the bad write: the data
	// is missing and there is no record of why.
	var errorCodes []string
	errRows, err := tx.Query(ctx, `
SELECT error_code FROM warehouse_row_errors WHERE tenant_id = $1::uuid`, tenantID)
	if err != nil {
		t.Fatalf("read warehouse_row_errors: %v", err)
	}
	for errRows.Next() {
		var code string
		if err := errRows.Scan(&code); err != nil {
			t.Fatalf("scan: %v", err)
		}
		errorCodes = append(errorCodes, code)
	}
	errRows.Close()
	if len(errorCodes) != 2 {
		t.Fatalf("row errors = %v, want two invalid_event_name entries", errorCodes)
	}
	for _, code := range errorCodes {
		if code != "invalid_event_name" {
			t.Errorf("row error code = %q, want invalid_event_name", code)
		}
	}
}
