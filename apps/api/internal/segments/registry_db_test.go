// SPDX-License-Identifier: AGPL-3.0-only
//
// registry_db_test.go — the predicate registry is the builder's only field
// catalogue, so what it advertises has to be both readable and true.

package segments

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var rawCategoryToken = regexp.MustCompile(`^[a-z_]+$`)

func TestPredicateRegistryNamesEveryCategoryForPeople_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, _ := seedPreviewAggregateFixture(t, pool)
	withTenantTx(t, pool, tenantID, func(_ context.Context, exec func(string, ...any)) {
		exec(`INSERT INTO tenant_custom_fields (tenant_id, key, label, type) VALUES ($1::uuid, 'plan', 'Plan', 'string')`, tenantID)
		// One event tracked under two spellings that share a slug, the more
		// common one first.
		for name, times := range map[string]int{"Placed Order": 3, "placed order": 1} {
			for i := 0; i < times; i++ {
				exec(`
INSERT INTO product_events (tenant_id, subscriber_id, event_name)
SELECT $1::uuid, id, $2 FROM subscribers WHERE tenant_id = $1::uuid LIMIT 1`, tenantID, name)
			}
		}
	})
	resp := serveSegments(t, segmentsRouter(&Deps{Repo: &Repo{Pool: pool}}), tenantID, http.MethodGet, "/api/v1/segments/predicate-registry", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("registry = %d %s", resp.Code, resp.Body.String())
	}
	// Decode the wire shape, not the Go struct, so a dropped json tag fails.
	var wire struct {
		Predicates []map[string]any `json:"predicates"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &wire); err != nil {
		t.Fatalf("decode: %v", err)
	}
	byKey := map[string]map[string]any{}
	for _, p := range wire.Predicates {
		key, _ := p["key"].(string)
		label, _ := p["category_label"].(string)
		if strings.TrimSpace(label) == "" || rawCategoryToken.MatchString(label) {
			t.Errorf("%s: category_label %q is not a heading a person reads", key, label)
		}
		if _, repeated := byKey[key]; repeated {
			t.Errorf("%s: the registry lists this key more than once", key)
		}
		byKey[key] = p
	}
	if got := byKey["metric.track.placed_order.count"]["source_ref"]; got != "Placed Order" {
		t.Errorf("metric.track.placed_order.count source_ref = %v, want the most-tracked spelling", got)
	}
	want := map[string]string{
		"email":                 "Profile",
		"last_opened_at":        "Engagement",
		"consent_source":        "Consent",
		"channel_consent.email": "Consent",
		"custom.plan":           "Custom fields",
		"segment_id":            "Segments",
		"rfm.segment_key":       "Predictive & RFM",
	}
	for key, label := range want {
		if got := byKey[key]["category_label"]; got != label {
			t.Errorf("%s: category_label = %v, want %q", key, got, label)
		}
	}
	// The wildcard descriptor is documentation, not a pickable field.
	if wildcard := byKey["custom.*"]; wildcard == nil || wildcard["compiler_status"] == "supported" {
		t.Errorf("custom.* = %v, want present and not supported", wildcard)
	}
}

// representativeValue is a value of the shape each comparator family takes.
func representativeValue(p PredicateDefinition, comparator, segmentID string) any {
	switch comparator {
	case "is_null", "is_not_null", "ever", "never", "exists", "not_exists":
		return nil
	case "in", "not_in":
		if p.ValueType == "number" {
			return []any{1, 2}
		}
		return []any{"a", "b"}
	case "added_in_last_days", "removed_in_last_days":
		return map[string]any{"tag": "vip", "days": 30}
	case "in_last_days", "more_than_days_ago":
		return 30
	case "in_segment", "not_in_segment":
		return segmentID
	}
	switch p.ValueType {
	case "number":
		return 1
	case "boolean":
		return true
	case "date":
		return "2026-01-01T00:00:00Z"
	case "enum":
		if len(p.Options) > 0 {
			return p.Options[0]
		}
	}
	return "x"
}

// Every comparator the registry advertises for a field a builder can pick
// compiles for that field and runs against Postgres: the built-ins and a
// custom field of each type. Builders offer exactly these lists, so one that
// fails here is a rule a user can build and then not save.
func TestBaseFieldComparatorsExecute_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	withTenantTx(t, pool, tenantID, func(_ context.Context, exec func(string, ...any)) {
		for _, kind := range []string{"string", "number", "boolean", "date"} {
			exec(`INSERT INTO tenant_custom_fields (tenant_id, key, label, type) VALUES ($1::uuid, $2, $3, $4)`,
				tenantID, "field_"+kind, "Field "+kind, kind)
		}
	})
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	target, err := repo.Create(ctx, tenantID, CreateInput{Name: "Reference " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create reference segment: %v", err)
	}
	registry, err := repo.PredicateRegistry(ctx, tenantID)
	if err != nil {
		t.Fatalf("registry: %v", err)
	}
	executed, custom := 0, 0
	for _, field := range registry.Predicates {
		if strings.Contains(field.Key, "*") || field.CompilerStatus == "planned" || field.CompilerStatus == "unsupported" {
			continue // descriptors and not-yet-compilable predicates are not offered
		}
		if strings.HasPrefix(field.Key, "custom.") {
			custom++
		}
		for _, comparator := range field.Comparators {
			node := map[string]any{"op": "condition", "field": field.Key, "comparator": comparator}
			if v := representativeValue(field, comparator, target.ID); v != nil {
				node["value"] = v
			}
			raw, err := json.Marshal(node)
			if err != nil {
				t.Fatal(err)
			}
			name := fmt.Sprintf("%s %s", field.Key, comparator)
			predicate, err := CompilePopulation(ctx, raw, tenantID, repo, DefinitionPopulation(false))
			if err != nil {
				t.Errorf("%s: advertised but does not compile: %v", name, err)
				continue
			}
			tx, err := db.WithTenant(ctx, pool, tenantID)
			if err != nil {
				t.Fatal(err)
			}
			var n int
			if err := tx.QueryRow(ctx, "SELECT COUNT(*) FROM subscribers WHERE "+predicate.SQL, predicate.Args...).Scan(&n); err != nil {
				t.Errorf("%s: compiles but fails in Postgres: %v", name, err)
			}
			_ = tx.Rollback(ctx)
			executed++
		}
	}
	if executed < 80 || custom != 4 {
		t.Fatalf("executed %d field/comparator pairs over %d custom fields; the walk is not seeing the registry", executed, custom)
	}
}

// The composed-segment rule the builder now produces ({field: segment_id,
// comparator: in_segment, value: <id>}) saves through the real route. The
// builder used to offer string comparators for it, which the compiler refuses.
func TestCreateSegmentOfSegments_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	router := segmentsRouter(&Deps{Repo: repo})
	inner, err := repo.Create(context.Background(), tenantID, CreateInput{Name: "Inner " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create inner: %v", err)
	}
	resp := serveSegments(t, router, tenantID, http.MethodPost, "/api/v1/segments", map[string]any{
		"name": "Outer " + marker,
		"queryAst": map[string]any{"op": "and", "children": []any{
			map[string]any{"op": "condition", "field": "segment_id", "comparator": "in_segment", "value": inner.ID},
		}},
	})
	if resp.Code != http.StatusCreated {
		t.Fatalf("create composed = %d %s", resp.Code, resp.Body.String())
	}
	if outer := decodeBody[Segment](t, resp); outer.LastCount == nil || *outer.LastCount != 2 {
		t.Fatalf("composed segment counted %s, want the inner segment's 2", intValue(outer.LastCount))
	}
	// What the builder used to send for the same intent is refused.
	resp = serveSegments(t, router, tenantID, http.MethodPost, "/api/v1/segments", map[string]any{
		"name":     "Outer by equals " + marker,
		"queryAst": map[string]any{"op": "condition", "field": "segment_id", "comparator": "equals", "value": inner.ID},
	})
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("segment_id equals = %d %s, want 400", resp.Code, resp.Body.String())
	}
}
