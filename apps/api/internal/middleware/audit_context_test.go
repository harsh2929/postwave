// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_context_test.go — coverage for the AuditMeta context stash
// + the AuditAspect/AuditAttach handler-side primitives. We test the
// context plumbing only (no DB) so the suite runs in every package's
// `go test ./...` budget.
package middleware

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestAuditMetaContext_RoundTrip exercises the happy path: stash a
// meta, pull it back out, the values match. Covers the common case
// audit.Emit relies on at every call site.
func TestAuditMetaContext_RoundTrip(t *testing.T) {
	uid := "user-1"
	want := db.AuditMeta{
		TenantID:   "tenant-1",
		UserID:     &uid,
		IP:         "10.0.0.1",
		UserAgent:  "ua",
		ActorType:  "human",
		ActorLabel: "vt@example.com",
		SessionID:  "sess-1",
	}
	ctx := WithAuditMeta(context.Background(), want)
	got, ok := AuditMetaFromContext(ctx)
	if !ok {
		t.Fatal("AuditMetaFromContext returned ok=false on stashed meta")
	}
	if got.TenantID != want.TenantID || got.ActorLabel != want.ActorLabel {
		t.Errorf("AuditMetaFromContext = %+v, want %+v", got, want)
	}
}

func TestAuditMetaFromRequestAttributesUnlabelledAPIKey(t *testing.T) {
	req := httptest.NewRequest("POST", "/api/v1/campaigns", nil)
	ctx := WithActor(req.Context(), "human", "")
	ctx = WithAPIKeyID(ctx, "key-42")
	req = req.WithContext(ctx)
	got := AuditMetaFromRequest(req)
	if got.ActorType != "human" || got.ActorLabel != "api-key:key-42" {
		t.Fatalf("API-key audit actor = (%q, %q), want (human, api-key:key-42)", got.ActorType, got.ActorLabel)
	}
}

// TestAuditMetaContext_EmptyTenantReportsNotOK guards the contract
// that audit.Emit can short-circuit on ok=false: a stashed-but-empty
// AuditMeta is useless (RLS would reject) so we expose it as "not
// present" rather than "present but bad".
func TestAuditMetaContext_EmptyTenantReportsNotOK(t *testing.T) {
	ctx := WithAuditMeta(context.Background(), db.AuditMeta{ActorType: "human"})
	_, ok := AuditMetaFromContext(ctx)
	if ok {
		t.Fatal("expected ok=false for tenant-less meta")
	}
}

// TestAuditMetaContext_UnstashedReportsNotOK covers the cold-path
// caller that never went through the apikey/session middleware.
// Should be safe to call (no panic), just empty + ok=false.
func TestAuditMetaContext_UnstashedReportsNotOK(t *testing.T) {
	_, ok := AuditMetaFromContext(context.Background())
	if ok {
		t.Fatal("expected ok=false on unstashed ctx")
	}
}

// TestAuditAttach_NoHolderIsSafe asserts AuditAttach is a no-op
// when no MutatingAspect wraps the route. Handlers can call it
// unconditionally without guarding every call site.
func TestAuditAttach_NoHolderIsSafe(t *testing.T) {
	// Should not panic, should not modify ctx in a way that
	// alters subsequent reads.
	ctx := AuditAttach(context.Background(), "rid", nil, nil, nil)
	if ctx == nil {
		t.Fatal("AuditAttach returned nil ctx")
	}
	if _, ok := auditAspectFromContext(ctx); ok {
		t.Fatal("AuditAttach should not create a holder when none exists")
	}
}

// TestAuditAttach_PopulatesHolder is the round-trip test: install a
// holder, attach, harvest, values match.
func TestAuditAttach_PopulatesHolder(t *testing.T) {
	h := &AuditAspect{}
	ctx := withAuditAspect(context.Background(), h)

	before := map[string]any{"name": "old"}
	after := map[string]any{"name": "new"}
	meta := map[string]any{"diff": 1}

	_ = AuditAttach(ctx, "res-123", before, after, meta)

	if h.ResourceID != "res-123" {
		t.Errorf("ResourceID = %q, want %q", h.ResourceID, "res-123")
	}
	if h.Before == nil || h.After == nil {
		t.Fatalf("Before/After not populated: %+v", h)
	}
	if h.Metadata["diff"] != 1 {
		t.Errorf("Metadata = %+v, want diff:1", h.Metadata)
	}
}

// TestAuditAttach_LastWriteWins asserts the holder is mutable so a
// handler can refine the payload mid-flight (e.g. after an inner
// transaction commits with the final id).
func TestAuditAttach_LastWriteWins(t *testing.T) {
	h := &AuditAspect{}
	ctx := withAuditAspect(context.Background(), h)

	_ = AuditAttach(ctx, "first", nil, nil, nil)
	_ = AuditAttach(ctx, "second", nil, nil, nil)

	if h.ResourceID != "second" {
		t.Errorf("ResourceID = %q, want %q", h.ResourceID, "second")
	}
}

// TestAuditSkip_FlagsHolder asserts a handler can opt out of the
// MutatingAspect emit (e.g. bulk handlers that wrote per-item rows
// themselves).
func TestAuditSkip_FlagsHolder(t *testing.T) {
	h := &AuditAspect{}
	ctx := withAuditAspect(context.Background(), h)

	AuditSkip(ctx)

	if !h.Skip {
		t.Fatal("AuditSkip did not flag holder")
	}
}

// TestAuditSkip_NoHolderIsSafe asserts AuditSkip is a no-op when no
// holder is present (same safety guarantee as AuditAttach).
func TestAuditSkip_NoHolderIsSafe(t *testing.T) {
	// Should not panic.
	AuditSkip(context.Background())
}
