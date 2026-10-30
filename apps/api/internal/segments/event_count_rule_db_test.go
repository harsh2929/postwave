// SPDX-License-Identifier: AGPL-3.0-only

package segments

import (
	"context"
	"net/http"
	"testing"
)

// An event-count rule counts the event it was built from. The predicate key
// carries only the event's slug (metric.track.placed_order.count), and the
// compiler used to look for events literally named "placed_order", so every
// rule saved from the builder matched nobody. The builder now also names the
// event as tracked (value.event_name, from the predicate's source_ref), and a
// rule without one, saved before or sent by an API, MCP or desktop client,
// counts every spelling that shares the slug.
func TestEventCountRuleFromTheBuilderCountsTheTrackedEvent_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	withTenantTx(t, pool, tenantID, func(_ context.Context, exec func(string, ...any)) {
		track := func(who, event string, times int) {
			for i := 0; i < times; i++ {
				exec(`
INSERT INTO product_events (tenant_id, subscriber_id, event_name)
SELECT $1::uuid, id, $3 FROM subscribers
 WHERE tenant_id = $1::uuid AND email = $2`, tenantID, who+"-"+marker+"@example.test", event)
			}
		}
		track("consented", "Placed Order", 2)
		track("consented", "Placed Orders", 1) // another event: another slug
		track("unconsented", "Placed Order", 1)
		track("unconsented", "placed-order", 1) // the same event, spelt differently
		track("archived", "Placed Order", 3)
	})
	repo := &Repo{Pool: pool}

	registry, err := repo.PredicateRegistry(context.Background(), tenantID)
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	const field = "metric.track.placed_order.count"
	var sourceRef string
	for _, p := range registry.Predicates {
		if p.Key == field {
			sourceRef = p.SourceRef
		}
	}
	if sourceRef != "Placed Order" {
		t.Fatalf("registry %s source_ref = %q, want the tracked name the builder sends", field, sourceRef)
	}

	router := segmentsRouter(&Deps{Repo: repo})
	create := func(name, comparator string, value map[string]any) *int {
		t.Helper()
		resp := serveSegments(t, router, tenantID, http.MethodPost, "/api/v1/segments", map[string]any{
			"name": name + " " + marker,
			"queryAst": map[string]any{"op": "and", "children": []any{
				map[string]any{"op": "condition", "field": field, "comparator": comparator, "value": value},
			}},
		})
		if resp.Code != http.StatusCreated {
			t.Fatalf("%s: create = %d %s", name, resp.Code, resp.Body.String())
		}
		return decodeBody[Segment](t, resp).LastCount
	}

	if got := create("Repeat buyers", "gte", map[string]any{"count": 2, "event_name": sourceRef}); got == nil || *got != 1 {
		t.Fatalf("placed at least twice counted %s, want 1 (archived buyers are outside the scope)", intValue(got))
	}
	if got := create("Recent buyers", "in_last_days", map[string]any{"days": 30, "event_name": sourceRef}); got == nil || *got != 2 {
		t.Fatalf("placed in the last 30 days counted %s, want 2", intValue(got))
	}
	// Without the event name the key's slug decides: both spellings of the
	// event count, "Placed Orders" does not, so both active buyers have two.
	if got := create("Slug only", "gte", map[string]any{"count": 2}); got == nil || *got != 2 {
		t.Fatalf("slug-only rule counted %s, want 2 (every spelling of the event, and only that event)", intValue(got))
	}
}
