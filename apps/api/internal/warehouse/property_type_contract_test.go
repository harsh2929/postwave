// SPDX-License-Identifier: AGPL-3.0-only

package warehouse

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/track"
)

// The SHAPE contract, on the second boundary.
//
// The naming rule shipped with one enforcer and one bypass, and this importer
// was the bypass — for long enough that unaddressable event names had been
// written. The property-type rule is written with both callers from the start,
// and this test is what stops that being a claim rather than a fact. Asserting
// on the real `materializeImportRows`, not on the presence of a call in source.
//
// Drift is MORE likely here than on the API: a client library usually settles a
// property's type, whereas a warehouse column whose upstream definition changed
// — an amount stored as text after a schema migration — arrives exactly as it
// is found.
func TestTheImporterRecordsPropertyTypesAndCountsDrift(t *testing.T) {
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
		tenantID, "wp-"+tenantID[:8]); err != nil {
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
		tenantID, "wp-"+tenantID[:8]+"@example.test").Scan(&subscriberID); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	var runID string
	if err := tx.QueryRow(ctx, `
INSERT INTO warehouse_sync_runs (tenant_id, connection_id, direction, status)
VALUES ($1::uuid, $2::uuid, 'import', 'running') RETURNING id::text`,
		tenantID, connectionID).Scan(&runID); err != nil {
		t.Fatalf("seed warehouse_sync_run: %v", err)
	}

	// The same property, twice, with the type changing between imports — the
	// upstream column went from a number to text.
	rows := []ImportRow{
		{SourceObject: "orders", EventName: "purchase", SubscriberID: subscriberID,
			Properties: map[string]any{"amount": 19.99}},
		{SourceObject: "orders", EventName: "purchase", SubscriberID: subscriberID,
			Properties: map[string]any{"amount": "19.99"}},
	}
	imported, failed, err := materializeImportRows(ctx, tx, tenantID, runID, rows, nil)
	if err != nil {
		t.Fatalf("materializeImportRows: %v", err)
	}
	if imported != 2 || failed != 0 {
		t.Fatalf("imported=%d failed=%d, want 2/0. A type change must NOT refuse "+
			"the row — it is still a usable event, and dropping real customer data "+
			"because an upstream schema moved is worse than the drift.", imported, failed)
	}

	var jsonType, lastConflict string
	var conflicts int64
	if err := tx.QueryRow(ctx, `
SELECT json_type, conflict_count, last_conflict_type
  FROM product_event_property_types
 WHERE tenant_id = $1::uuid AND event_name = 'purchase' AND property = 'amount'`,
		tenantID).Scan(&jsonType, &conflicts, &lastConflict); err != nil {
		t.Fatalf("the importer recorded no property type at all: %v. The rule has "+
			"one enforcer and one bypass again, which is the failure the naming "+
			"contract already went through.", err)
	}
	if jsonType != track.TypeNumber {
		t.Errorf("baseline json_type = %q, want %q", jsonType, track.TypeNumber)
	}
	if conflicts != 1 {
		t.Fatalf("conflict_count = %d, want 1; the type changed between two "+
			"imported rows and the report does not say so", conflicts)
	}
	if lastConflict != track.TypeString {
		t.Errorf("last_conflict_type = %q, want %q", lastConflict, track.TypeString)
	}
}
