// SPDX-License-Identifier: AGPL-3.0-only
//
// decision_explanations_test.go — SUB-070: right-to-explanation for automated
// decisions (migration 0951). Pure-function coverage of the segment-AST leaf
// extractor, comparator humanizer, placeholder shifter, and decision-type
// taxonomy, plus a pg-backed round-trip that a recorded explanation survives
// GetDecisionExplanations. Skips cleanly without DATABASE_URL, matching the
// package convention.

package subscribers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestValidDecisionType pins the decision_type allow-list to the migration-0951
// CHECK constraint.
func TestValidDecisionType(t *testing.T) {
	for _, v := range []string{DecisionTypeSegment, DecisionTypeCampaign} {
		if !ValidDecisionType(v) {
			t.Errorf("ValidDecisionType(%q) = false; want true", v)
		}
	}
	for _, v := range []string{"", "automation", "SEGMENT", "list", "flow"} {
		if ValidDecisionType(v) {
			t.Errorf("ValidDecisionType(%q) = true; want false", v)
		}
	}
}

// TestExtractLeafConditions walks a nested AND/OR/NOT AST and pins that every
// leaf condition is surfaced with its field/comparator/value. Production
// compilation is resolver-aware and covered by the segment evaluator tests.
func TestExtractLeafConditions(t *testing.T) {
	ast := json.RawMessage(`{
      "op":"and",
      "children":[
        {"op":"condition","field":"engagement_score","comparator":"gte","value":70},
        {"op":"or","children":[
          {"op":"condition","field":"status","comparator":"equals","value":"enabled"},
          {"op":"not","child":{"op":"condition","field":"signup_source","comparator":"equals","value":"import"}}
        ]}
      ]
    }`)
	conds := extractLeafConditions(ast)
	if len(conds) != 3 {
		t.Fatalf("extractLeafConditions returned %d leaves; want 3", len(conds))
	}
	fields := map[string]bool{}
	for _, c := range conds {
		fields[c.field] = true
	}
	for _, want := range []string{"engagement_score", "status", "signup_source"} {
		if !fields[want] {
			t.Errorf("missing leaf field %q in %#v", want, fields)
		}
	}
}

// TestExtractLeafConditions_Empty handles an empty / malformed AST gracefully.
func TestExtractLeafConditions_Empty(t *testing.T) {
	if got := extractLeafConditions(nil); got != nil {
		t.Errorf("nil AST -> %#v; want nil", got)
	}
	if got := extractLeafConditions(json.RawMessage(`{bad`)); got != nil {
		t.Errorf("malformed AST -> %#v; want nil", got)
	}
}

// TestHumanComparator pins a few representative mappings to readable phrases.
func TestHumanComparator(t *testing.T) {
	cases := map[string]string{
		"gte":        "is at least",
		"equals":     "is",
		"not_equals": "is not",
		"contains":   "contains",
		"in":         "is one of",
	}
	for tok, want := range cases {
		if got := humanComparator(tok); got != want {
			t.Errorf("humanComparator(%q) = %q; want %q", tok, got, want)
		}
	}
	// Unknown token round-trips unchanged.
	if got := humanComparator("between"); got != "between" {
		t.Errorf("humanComparator(unknown) = %q; want passthrough", got)
	}
}

// TestShiftPlaceholders pins the right-to-left rewrite so a $1-based fragment
// can be spliced after N leading params without re-matching rewritten indices.
func TestShiftPlaceholders(t *testing.T) {
	in := "a = $1 AND b > $2 OR c = $10"
	got := shiftPlaceholders(in, 2)
	want := "a = $3 AND b > $4 OR c = $12"
	if got != want {
		t.Errorf("shiftPlaceholders = %q; want %q", got, want)
	}
	if got := shiftPlaceholders("x = $1", 0); got != "x = $1" {
		t.Errorf("shiftPlaceholders by 0 changed fragment: %q", got)
	}
}

// TestRecordDecisionExplanation_Validation pins the input guards: an invalid
// decision_type and a missing target_id are rejected before the tenant tx, so
// no DB is required.
func TestRecordDecisionExplanation_Validation(t *testing.T) {
	r := &Repo{Pool: nil}
	ctx := context.Background()
	if _, err := r.RecordDecisionExplanation(ctx, "t", "s", RecordDecisionExplanationInput{
		DecisionType: "flow", TargetID: "x",
	}); err == nil {
		t.Fatalf("invalid decision_type accepted; want ErrInvalidInput")
	}
	if _, err := r.RecordDecisionExplanation(ctx, "t", "s", RecordDecisionExplanationInput{
		DecisionType: DecisionTypeSegment, TargetID: "  ",
	}); err == nil {
		t.Fatalf("blank target_id accepted; want ErrInvalidInput")
	}
}

func newDecisionTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed decision_explanations test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedDecisionTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`, tenantID).Scan(&exists); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read tenants: %v", err)
	}
	if !exists {
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'decision-test', 'decision-test-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// TestDecisionExplanation_RoundTrips pins the stored-snapshot path end-to-end:
// record a segment explanation, read it back, then re-record (replace in place,
// no second row).
func TestDecisionExplanation_RoundTrips(t *testing.T) {
	pool := newDecisionTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c70010"
	seedDecisionTenant(t, pool, tenantID)

	r := &Repo{Pool: pool}
	email := fmt.Sprintf("decision-%d@example.test", time.Now().UnixNano())
	created, err := r.Upsert(ctx, tenantID, CreateInput{
		Email: email,
	})
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	target := "00000000-0000-4000-8000-0099a2c70099"
	list, err := r.RecordDecisionExplanation(ctx, tenantID, created.ID, RecordDecisionExplanationInput{
		DecisionType: DecisionTypeSegment,
		TargetID:     target,
		ReasoningSnapshot: map[string]any{
			"matched": 3.0, "total": 5.0, "summary": "matched 3 of 5",
		},
	})
	if err != nil {
		t.Fatalf("RecordDecisionExplanation: %v", err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("after record items = %d; want 1", len(list.Items))
	}
	if list.Items[0].DecisionType != DecisionTypeSegment {
		t.Errorf("decision_type = %q; want segment", list.Items[0].DecisionType)
	}
	if list.Items[0].ReasoningSnapshot["summary"] != "matched 3 of 5" {
		t.Errorf("snapshot lost: %#v", list.Items[0].ReasoningSnapshot)
	}

	// Re-record same (decision_type, target) → replace in place.
	list, err = r.RecordDecisionExplanation(ctx, tenantID, created.ID, RecordDecisionExplanationInput{
		DecisionType:      DecisionTypeSegment,
		TargetID:          target,
		ReasoningSnapshot: map[string]any{"summary": "matched 4 of 5"},
	})
	if err != nil {
		t.Fatalf("re-record: %v", err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("after re-record items = %d; want 1 (replace in place)", len(list.Items))
	}
	if list.Items[0].ReasoningSnapshot["summary"] != "matched 4 of 5" {
		t.Errorf("re-record did not replace snapshot: %#v", list.Items[0].ReasoningSnapshot)
	}
}
