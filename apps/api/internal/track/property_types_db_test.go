// SPDX-License-Identifier: AGPL-3.0-only

package track

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The harm this exists for: a `value` that arrives as "10" on Monday and 10 on
// Tuesday. A numeric segment condition silently stops matching the string rows,
// a revenue sum quietly drops them, and nothing anywhere says the shape changed.

func typesPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping property type test")
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

func seedTypesTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'pt', 'studio')`,
		tenantID, "pt-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		// Fatal, never Skip. See scripts/check-test-skip-honesty.mjs.
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	// One tenant delete removes everything the test wrote through ON DELETE
	// CASCADE. The teardown used to delete the child rows first, in the same
	// transaction and with every error discarded, but the application role
	// has no DELETE on product_event_property_types or product_events. The
	// first statement failed, the transaction was aborted, the tenant delete
	// that followed could never run, and every run leaked its tenant.
	t.Cleanup(func() { deleteTrackTestTenant(t, pool, tenantID) })
	return tenantID
}

// seedTypesSubscriber creates a real subscriber. product_events.subscriber_id
// carries a foreign key, so a generated uuid is rejected.
func seedTypesSubscriber(t *testing.T, pool *db.Pool, tenantID string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'import')
RETURNING id::text`, tenantID, "pt-"+uuid.NewString()[:8]+"@example.test").Scan(&id); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber: %v", err)
	}
	return id
}

type propertyRow struct {
	JSONType     string
	Conflicts    int64
	LastConflict string
}

func readPropertyType(t *testing.T, pool *db.Pool, tenantID, event, property string) propertyRow {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var row propertyRow
	if err := tx.QueryRow(ctx, `
SELECT json_type, conflict_count, last_conflict_type
  FROM product_event_property_types
 WHERE tenant_id = $1::uuid AND event_name = $2 AND property = $3`,
		tenantID, event, property).Scan(&row.JSONType, &row.Conflicts, &row.LastConflict); err != nil {
		t.Fatalf("read %s.%s: %v", event, property, err)
	}
	return row
}

func recordVia(t *testing.T, pool *db.Pool, tenantID, event string, body []byte) {
	t.Helper()
	ctx := context.Background()
	types, err := PropertyTypes(body)
	if err != nil {
		t.Fatalf("PropertyTypes: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := RecordPropertyTypes(ctx, tx, tenantID, event, types); err != nil {
		t.Fatalf("RecordPropertyTypes: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

// The whole point of the table.
func TestAPropertyChangingTypeIsCountedAsDrift(t *testing.T) {
	pool := typesPool(t)
	tenantID := seedTypesTenant(t, pool)

	recordVia(t, pool, tenantID, "purchase", []byte(`{"value": 10, "sku": "abc"}`))
	first := readPropertyType(t, pool, tenantID, "purchase", "value")
	if first.JSONType != TypeNumber || first.Conflicts != 0 {
		t.Fatalf("first observation = %+v, want number with no conflicts", first)
	}

	// Monday's 10 becomes Tuesday's "10".
	recordVia(t, pool, tenantID, "purchase", []byte(`{"value": "10", "sku": "abc"}`))
	after := readPropertyType(t, pool, tenantID, "purchase", "value")
	if after.Conflicts != 1 {
		t.Fatalf("conflict_count = %d after the type changed, want 1. A numeric "+
			"segment condition has silently stopped matching and nothing says so.",
			after.Conflicts)
	}
	if after.LastConflict != TypeString {
		t.Errorf("last_conflict_type = %q, want %q", after.LastConflict, TypeString)
	}
	// The BASELINE must not move. A most-common baseline eventually becomes the
	// bad type and the drift disappears from the report exactly when it has done
	// the most damage.
	if after.JSONType != TypeNumber {
		t.Fatalf("the baseline moved to %q; once enough bad rows arrive the drift "+
			"stops being reported at all", after.JSONType)
	}
	// A property that did NOT change must not be counted.
	if sku := readPropertyType(t, pool, tenantID, "purchase", "sku"); sku.Conflicts != 0 {
		t.Errorf("a stable property recorded %d conflicts; every ordinary event "+
			"would read as drift", sku.Conflicts)
	}
}

// A null establishes nothing. If it did, the first real value would be drift.
func TestANullDoesNotEstablishAType(t *testing.T) {
	pool := typesPool(t)
	tenantID := seedTypesTenant(t, pool)

	recordVia(t, pool, tenantID, "signup", []byte(`{"plan": null}`))
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM product_event_property_types
 WHERE tenant_id = $1::uuid AND property = 'plan'`, tenantID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback(ctx)
	if n != 0 {
		t.Fatal("a null established a type. Every subsequent real value would be " +
			"reported as drift, and the report would be loudest about the events " +
			"with the least wrong with them.")
	}

	// And the first real value becomes the baseline with no conflict.
	recordVia(t, pool, tenantID, "signup", []byte(`{"plan": "pro"}`))
	if got := readPropertyType(t, pool, tenantID, "signup", "plan"); got.Conflicts != 0 || got.JSONType != TypeString {
		t.Fatalf("after a null then a string: %+v, want string with no conflicts", got)
	}
}

// Every JSON type, and the one that must NOT split.
func TestTheTypeVocabularyMatchesJSONsOwn(t *testing.T) {
	types, err := PropertyTypes([]byte(`{
		"s": "x", "n": 10, "f": 10.5, "b": true, "o": {"a":1}, "a": [1,2], "z": null
	}`))
	if err != nil {
		t.Fatalf("PropertyTypes: %v", err)
	}
	for property, want := range map[string]string{
		"s": TypeString, "n": TypeNumber, "f": TypeNumber,
		"b": TypeBoolean, "o": TypeObject, "a": TypeArray,
	} {
		if got := types[property]; got != want {
			t.Errorf("%s = %q, want %q", property, got, want)
		}
	}
	if _, present := types["z"]; present {
		t.Error("a null was given a type")
	}
	// JSON has ONE number type. Splitting integer from float would flag ordinary
	// data as drift on the first decimal, and it is string-versus-number that
	// actually breaks comparison.
	if types["n"] != types["f"] {
		t.Fatalf("10 is %q and 10.5 is %q; an amount that gains a decimal would "+
			"be reported as a type change", types["n"], types["f"])
	}
}

// The ingestion path must record shape, not just the event.
//
// Tests the WIRING, not the helper: a helper that works and a call that never
// happens is the failure mode this whole registry is meant to end.
func TestTheTrackInsertPathRecordsShape(t *testing.T) {
	pool := typesPool(t)
	tenantID := seedTypesTenant(t, pool)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	subscriber := seedTypesSubscriber(t, pool, tenantID)
	if _, err := repo.Insert(ctx, tenantID, subscriber, "checkout",
		[]byte(`{"total": 42}`), time.Now().UTC(), ""); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if got := readPropertyType(t, pool, tenantID, "checkout", "total"); got.JSONType != TypeNumber {
		t.Fatalf("the ingestion path recorded %+v; the derivation works and "+
			"nothing calls it", got)
	}

	if _, err := repo.Insert(ctx, tenantID, subscriber, "checkout",
		[]byte(`{"total": "42"}`), time.Now().UTC(), ""); err != nil {
		t.Fatalf("second Insert: %v", err)
	}
	if got := readPropertyType(t, pool, tenantID, "checkout", "total"); got.Conflicts != 1 {
		t.Fatalf("conflicts = %d through the real insert path, want 1", got.Conflicts)
	}
}

// A retried event is the SAME event and must not inflate the drift figure.
func TestARetriedEventIsNotCountedTwice(t *testing.T) {
	pool := typesPool(t)
	tenantID := seedTypesTenant(t, pool)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	subscriber := seedTypesSubscriber(t, pool, tenantID)
	eventID := "evt-" + uuid.NewString()

	for i := 0; i < 3; i++ {
		if _, err := repo.Insert(ctx, tenantID, subscriber, "retried",
			[]byte(`{"amount": 5}`), time.Now().UTC(), eventID); err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
	}
	ctx2 := context.Background()
	tx, err := db.WithTenant(ctx2, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx2) }()
	var lastSeen, firstSeen time.Time
	if err := tx.QueryRow(ctx2, `
SELECT first_seen_at, last_seen_at FROM product_event_property_types
 WHERE tenant_id = $1::uuid AND event_name = 'retried' AND property = 'amount'`,
		tenantID).Scan(&firstSeen, &lastSeen); err != nil {
		t.Fatalf("read: %v", err)
	}
	// Three calls, one genuine insert: last_seen must not have been bumped by
	// the two deduplicated retries.
	if !lastSeen.Equal(firstSeen) {
		t.Fatalf("last_seen_at moved on a deduplicated retry (first=%s last=%s); "+
			"the summary is counting observations the log did not record",
			firstSeen, lastSeen)
	}
}
