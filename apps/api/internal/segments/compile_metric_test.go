// SPDX-License-Identifier: AGPL-3.0-only
//
// compile_metric_test.go — SUB-028: metric.* event-aggregate predicate
// compilation. Verifies the compiler routes metric fields through
// predicates.CompileAggregate, derives the event name + aggregation,
// parses the windowed value shape, and supports the in_last_days /
// more_than_days_ago comparators.
package segments

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCompileASTMetricCountAllTime(t *testing.T) {
	// Bare-number value → all-time count, event name derived from slug.
	raw := json.RawMessage(`{"op":"condition","field":"metric.track.added_to_cart.count","comparator":"gte","value":3}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "FROM product_events") {
		t.Fatalf("fragment did not reference product_events: %s", frag)
	}
	if strings.Contains(frag, "subscriber_email") {
		t.Fatalf("fragment must NOT reference subscriber_email (bug fix): %s", frag)
	}
	if !strings.Contains(frag, "subscriber_id = subscribers.id") {
		t.Fatalf("fragment did not scope by subscriber_id: %s", frag)
	}
	if !strings.Contains(frag, "count(*)") {
		t.Fatalf("expected count(*) aggregation: %s", frag)
	}
	if !strings.Contains(frag, ">=") {
		t.Fatalf("expected >= comparator: %s", frag)
	}
	// args: event_name, threshold (no window arg for all-time).
	if len(args) != 2 {
		t.Fatalf("expected 2 args (event, threshold), got %d: %#v", len(args), args)
	}
	if args[0] != "added_to_cart" {
		t.Fatalf("expected event name slug 'added_to_cart', got %#v", args[0])
	}
	if args[1] != int64(3) {
		t.Fatalf("expected threshold int64(3), got %#v", args[1])
	}
}

func TestCompileASTMetricWindowedWithExplicitEventName(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"metric.track.added_to_cart.count","comparator":"gt","value":{"count":2,"days":30,"event_name":"Added to Cart"}}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "occurred_at >= now() -") {
		t.Fatalf("expected windowed predicate, got: %s", frag)
	}
	// args: event_name, windowDays, threshold.
	if len(args) != 3 {
		t.Fatalf("expected 3 args (event, days, threshold), got %d: %#v", len(args), args)
	}
	if args[0] != "Added to Cart" {
		t.Fatalf("expected explicit event_name 'Added to Cart', got %#v", args[0])
	}
	if args[1] != 30 {
		t.Fatalf("expected windowDays 30, got %#v", args[1])
	}
	if args[2] != int64(2) {
		t.Fatalf("expected threshold int64(2), got %#v", args[2])
	}
}

func TestCompileASTMetricInLastDays(t *testing.T) {
	// in_last_days pins count>=1 within the window taken from the value.
	raw := json.RawMessage(`{"op":"condition","field":"metric.track.opened.count","comparator":"in_last_days","value":14}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "occurred_at >= now() -") {
		t.Fatalf("expected windowed predicate, got: %s", frag)
	}
	if !strings.Contains(frag, ">= ") {
		t.Fatalf("expected gte comparator, got: %s", frag)
	}
	// args: event_name, windowDays(14), threshold(1).
	if len(args) != 3 {
		t.Fatalf("expected 3 args, got %d: %#v", len(args), args)
	}
	if args[0] != "opened" {
		t.Fatalf("expected event 'opened', got %#v", args[0])
	}
	if args[1] != 14 {
		t.Fatalf("expected windowDays 14, got %#v", args[1])
	}
	if args[2] != 1 {
		t.Fatalf("expected threshold 1 for in_last_days, got %#v", args[2])
	}
}

func TestCompileASTMetricMoreThanDaysAgo(t *testing.T) {
	// more_than_days_ago = "has NOT happened in the last N days" → count==0.
	raw := json.RawMessage(`{"op":"condition","field":"metric.track.opened.count","comparator":"more_than_days_ago","value":30}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "occurred_at >= now() -") {
		t.Fatalf("expected windowed predicate, got: %s", frag)
	}
	if !strings.Contains(frag, "= ") {
		t.Fatalf("expected equals comparator, got: %s", frag)
	}
	if len(args) != 3 {
		t.Fatalf("expected 3 args, got %d: %#v", len(args), args)
	}
	if args[1] != 30 {
		t.Fatalf("expected windowDays 30, got %#v", args[1])
	}
	if args[2] != 0 {
		t.Fatalf("expected threshold 0 for more_than_days_ago, got %#v", args[2])
	}
}

func TestCompileASTMetricSumProperty(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"metric.track.order.sum","comparator":"gte","value":{"value":100,"days":90,"aggregation":"sum","property":"total"}}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "sum(NULLIF(properties#>>") {
		t.Fatalf("expected sum over property extract, got: %s", frag)
	}
	if !strings.Contains(frag, "{total}") {
		t.Fatalf("expected property path {total}, got: %s", frag)
	}
	if len(args) != 3 {
		t.Fatalf("expected 3 args, got %d: %#v", len(args), args)
	}
}

// TestCompileASTMetricComposes ensures a metric predicate placeholder
// index composes cleanly inside an AND with another condition (the
// metric handler must not collide $-placeholders with sibling fragments).
func TestCompileASTMetricComposes(t *testing.T) {
	raw := json.RawMessage(`{"op":"and","children":[
        {"op":"condition","field":"status","comparator":"equals","value":"subscribed"},
        {"op":"condition","field":"metric.track.purchase.count","comparator":"gte","value":{"count":1,"days":60}}
    ]}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	// status arg ($1), then event/days/threshold ($2,$3,$4).
	if len(args) != 4 {
		t.Fatalf("expected 4 args total, got %d: %#v", len(args), args)
	}
	if args[0] != "subscribed" {
		t.Fatalf("expected first arg status 'subscribed', got %#v", args[0])
	}
	// The metric fragment's placeholders must start at $2 (after status).
	if !strings.Contains(frag, "$2") || !strings.Contains(frag, "$4") {
		t.Fatalf("metric placeholders did not renumber after the status arg: %s", frag)
	}
}
