// SPDX-License-Identifier: AGPL-3.0-only
package customobjects

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// TestLiquidCustomObjects_ShapesLinksForTemplates pins SUB-011 Liquid access:
// a subscriber's linked custom objects surface under a type-keyed map with
// parsed properties, so templates can reference
// {{ custom_objects.order.first.properties.total }} and
// {% for o in custom_objects.order.items %}.
func TestLiquidCustomObjects_ShapesLinksForTemplates(t *testing.T) {
	ctx := context.Background()
	now := func() time.Time { return time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC) }
	store := NewMemoryStore(now)
	const tenantID = "11111111-1111-4111-8111-111111111111"
	const subID = "22222222-2222-4222-8222-222222222222"

	orderType, err := store.CreateType(ctx, tenantID, CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatalf("create type: %v", err)
	}
	rec, err := store.UpsertRecord(ctx, tenantID, orderType.ID, UpsertRecordParams{
		ExternalID: "ORD-1001",
		Properties: json.RawMessage(`{"total":250,"status":"shipped"}`),
	})
	if err != nil {
		t.Fatalf("upsert record: %v", err)
	}
	if _, err := store.CreateProfileLink(ctx, tenantID, subID, CreateProfileLinkParams{
		ObjectRecordID: rec.ID,
		Relationship:   "purchased",
	}); err != nil {
		t.Fatalf("create link: %v", err)
	}

	objs, err := LiquidCustomObjects(ctx, store, tenantID, subID)
	if err != nil {
		t.Fatalf("LiquidCustomObjects: %v", err)
	}
	orderEntry, ok := objs["order"].(map[string]any)
	if !ok {
		t.Fatalf("custom_objects.order missing or wrong shape: %#v", objs)
	}
	if orderEntry["count"] != 1 {
		t.Fatalf("order count = %v, want 1", orderEntry["count"])
	}
	first, ok := orderEntry["first"].(map[string]any)
	if !ok {
		t.Fatalf("custom_objects.order.first missing: %#v", orderEntry)
	}
	if first["external_id"] != "ORD-1001" {
		t.Fatalf("first.external_id = %v, want ORD-1001", first["external_id"])
	}
	if first["relationship"] != "purchased" {
		t.Fatalf("first.relationship = %v, want purchased", first["relationship"])
	}
	props, ok := first["properties"].(map[string]any)
	if !ok {
		t.Fatalf("first.properties not a parsed map: %#v", first["properties"])
	}
	// JSON numbers decode to float64.
	if props["status"] != "shipped" || props["total"].(float64) != 250 {
		t.Fatalf("first.properties = %#v, want status=shipped total=250", props)
	}
}

// TestInjectMergeVars_AlwaysDefinesKey mirrors nbp.InjectMergeVars contract:
// the custom_objects key is always defined so {% for %} never errors on a
// missing variable, even with a nil store.
func TestInjectMergeVars_AlwaysDefinesKey(t *testing.T) {
	vars := map[string]any{}
	InjectMergeVars(context.Background(), nil, vars, "t", "s")
	if _, ok := vars[MergeVarKey]; !ok {
		t.Fatalf("InjectMergeVars must define %q even with a nil store", MergeVarKey)
	}

	// A nil vars bag is a safe no-op (no panic).
	InjectMergeVars(context.Background(), nil, nil, "t", "s")
}
