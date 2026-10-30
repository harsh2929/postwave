package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestAcceptedSequenceIdentifierUsesBoundedSafeGrammar(t *testing.T) {
	for _, id := range []string{
		"550e8400-e29b-41d4-a716-446655440000",
		"seq-legacy_1.imported",
		"A",
	} {
		if !isAcceptedSequenceIdentifier(id) {
			t.Errorf("expected %q to be accepted", id)
		}
	}
	for _, id := range []string{
		"", " ../sequence", "sequence/child", "sequence?debug=true",
		"sequence%2Fchild", "sequence\nchild", "@email", strings.Repeat("a", sequenceIdentifierMaxBytes+1),
	} {
		if isAcceptedSequenceIdentifier(id) {
			t.Errorf("expected unsafe identifier %q to be rejected", id)
		}
	}
}

func TestSequenceIDBoundaryReturnsStableBadRequest(t *testing.T) {
	for _, id := range []string{"bad:id", " sequence", strings.Repeat("x", 129)} {
		req := httptest.NewRequest(http.MethodGet, "/sequences/invalid", nil)
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("id", id)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
		rec := httptest.NewRecorder()
		if got, ok := sequenceIDFromRequest(rec, req); ok || got != "" {
			t.Fatalf("sequenceIDFromRequest(%q) = (%q, %v), want rejection", id, got, ok)
		}
		if rec.Code != http.StatusBadRequest || strings.TrimSpace(rec.Body.String()) != "invalid sequence id" {
			t.Fatalf("sequenceIDFromRequest(%q) response = %d %q", id, rec.Code, rec.Body.String())
		}
	}
}

func TestOpaqueSubscriberIdentifierRejectsPIIAndUnsafeText(t *testing.T) {
	for _, id := range []string{"subscriber_123", "sub.external-42", "A"} {
		if err := validateOpaqueSubscriberID(id); err != nil {
			t.Errorf("validateOpaqueSubscriberID(%q) = %v", id, err)
		}
	}
	for _, id := range []string{
		"", "reader@example.com", "subscriber/123", "subscriber 123",
		strings.Repeat("a", sequenceIdentifierMaxBytes+1),
	} {
		if err := validateOpaqueSubscriberID(id); err == nil {
			t.Errorf("validateOpaqueSubscriberID(%q) unexpectedly succeeded", id)
		}
	}
}
