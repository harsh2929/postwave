// SPDX-License-Identifier: AGPL-3.0-only
//
// saved_segments_preview_test.go — SUB-026: full predicate AST
// persistence + the /segments/saved/{id}/preview surface. Covers the
// predicate-resolution helper (ast > filters > legacy) and the handler
// guard paths that do not require a DB.
package segments

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSavedSegmentASTPrefersTopLevelAST(t *testing.T) {
	pred := json.RawMessage(`{"filters":{"status":"subscribed"},"ast":{"op":"condition","field":"status","comparator":"equals","value":"bounced"}}`)
	ast, err := savedSegmentAST(pred)
	if err != nil {
		t.Fatal(err)
	}
	// The top-level ast (bounced) must win over filters.status (subscribed).
	frag, args, err := CompileAST(ast)
	if err != nil {
		t.Fatalf("compile resolved ast: %v", err)
	}
	if len(args) != 1 || args[0] != "bounced" {
		t.Fatalf("expected ast to compile with 'bounced', got frag=%s args=%#v", frag, args)
	}
}

func TestSavedSegmentASTFromFilters(t *testing.T) {
	pred := json.RawMessage(`{"filters":{"status":"subscribed","q":"acme"}}`)
	ast, err := savedSegmentAST(pred)
	if err != nil {
		t.Fatal(err)
	}
	frag, args, err := CompileAST(ast)
	if err != nil {
		t.Fatalf("compile filters ast: %v", err)
	}
	if len(args) != 2 {
		t.Fatalf("expected status + q args, got frag=%s args=%#v", frag, args)
	}
	if args[0] != "enabled" {
		t.Fatalf("expected normalized status arg 'enabled', got %#v", args[0])
	}
	if args[1] != "%acme%" {
		t.Fatalf("expected q arg '%%acme%%', got %#v", args[1])
	}
}

func TestSavedSegmentASTLegacyFlatShape(t *testing.T) {
	// The historic {status, q} blob (no filters/ast wrapper) still resolves.
	pred := json.RawMessage(`{"status":"unsubscribed","q":""}`)
	ast, err := savedSegmentAST(pred)
	if err != nil {
		t.Fatal(err)
	}
	_, args, err := CompileAST(ast)
	if err != nil {
		t.Fatalf("compile legacy ast: %v", err)
	}
	if len(args) != 1 || args[0] != "blocklisted" {
		t.Fatalf("expected normalized status arg 'blocklisted', got %#v", args)
	}
}

func TestSavedSegmentASTAllStatusIsMatchAll(t *testing.T) {
	// status="all" + empty q → explicit match-all AST. Email is NOT NULL
	// in the subscribers schema, avoiding an invalid empty boolean group.
	pred := json.RawMessage(`{"filters":{"status":"all","q":""}}`)
	ast, err := savedSegmentAST(pred)
	if err != nil {
		t.Fatal(err)
	}
	frag, args, err := CompileAST(ast)
	if err != nil {
		t.Fatalf("compile match-all ast: %v", err)
	}
	if len(args) != 0 {
		t.Fatalf("expected no args for match-all, got %#v", args)
	}
	if frag != "(subscribers.email IS NOT NULL)" {
		t.Fatalf("expected explicit match-all email predicate, got %q", frag)
	}
}

func TestSavedSegmentArchiveScopeDefaultsClosedAndHonorsSnapshot(t *testing.T) {
	if savedSegmentIncludesArchived(json.RawMessage(`{"filters":{"status":"enabled"}}`)) {
		t.Fatal("legacy predicate must default to active subscribers only")
	}
	predicate := json.RawMessage(`{"snapshot":{"include_archived":true}}`)
	if !savedSegmentIncludesArchived(predicate) {
		t.Fatal("authoritative include_archived=true was ignored")
	}
	if got := savedSegmentAudienceFragment("a OR b", predicate); got != "a OR b" {
		t.Fatalf("included archive fragment = %q", got)
	}
	if got := savedSegmentAudienceFragment("a OR b", json.RawMessage(`{}`)); got != "(a OR b) AND subscribers.archived_at IS NULL" {
		t.Fatalf("active-only fragment = %q", got)
	}
}

func TestSavedSegmentASTEmptyPredicate(t *testing.T) {
	ast, err := savedSegmentAST(json.RawMessage(``))
	if err != nil {
		t.Fatal(err)
	}
	if len(ast) != 0 {
		t.Fatalf("expected nil ast for empty predicate, got %s", string(ast))
	}
}

func TestPreviewSavedRequiresTenant(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/segments/saved/abc/preview", nil)
	rec := httptest.NewRecorder()

	deps.PreviewSaved(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestPreviewSavedMissingID(t *testing.T) {
	// Tenant present but no {id} URL param → 400 missing_id (handler bails
	// before touching the DB).
	deps := &Deps{}
	req := withTenantCtx(httptest.NewRequest(http.MethodPost, "/api/v1/segments/saved//preview", nil))
	rec := httptest.NewRecorder()

	deps.PreviewSaved(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}
