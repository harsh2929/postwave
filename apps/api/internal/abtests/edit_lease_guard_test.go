// SPDX-License-Identifier: AGPL-3.0-only
package abtests

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The variants route must consult the editing lease.
//
// `campaign_variants` IS the delivered A/B content — sendloop resolves each
// recipient's subject and body from it — so this route changes what people
// receive just as directly as editing the campaign body, and it was outside the
// lease that covers PATCH.
//
// Driven through `CreateVariants` itself. A test of the guard helper cannot
// tell whether this handler calls it, which is exactly how the first version of
// this wiring passed with the call disabled.

type refusingGuard struct{ called int }

func (g *refusingGuard) AssertRequestEditable(_ *http.Request, _, _ string) error {
	g.called++
	return errors.New("campaign is being edited by ada@example.test until later")
}

type allowingGuard struct{ called int }

func (g *allowingGuard) AssertRequestEditable(_ *http.Request, _, _ string) error {
	g.called++
	return nil
}

func variantsRequest(t *testing.T, body string) (*httptest.ResponseRecorder, *http.Request) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/c-1/variants",
		strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "c-1")
	ctx := req.Context()
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111", Slug: "acme"})
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	return httptest.NewRecorder(), req.WithContext(ctx)
}

func TestCreateVariantsRefusesWhileAnotherEditorHoldsTheLease(t *testing.T) {
	guard := &refusingGuard{}
	deps := &Deps{EditLease: guard}
	rec, req := variantsRequest(t, `[{"variant_label":"A","subject":"Rewritten"}]`)

	deps.CreateVariants(rec, req)

	if guard.called == 0 {
		t.Fatal("CreateVariants never consulted the editing lease — the delivered " +
			"A/B content a share of the audience receives is writable straight " +
			"past the single-writer rule")
	}
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "edit_lease_held") {
		t.Errorf("the refusal does not carry the lease code: %s", rec.Body.String())
	}
}

func TestCreateVariantsProceedsWhenTheLeaseAllows(t *testing.T) {
	// The mirror failure: refusing every variant write would make A/B unusable.
	//
	// Deliberately sends an EMPTY variant list, which the handler rejects with
	// 400 AFTER the lease check. That proves both things this test is for —
	// the guard ran, and it did not stop the request — without needing a
	// database, and without using a recovered panic as the assertion, which
	// would only prove the repo was nil.
	guard := &allowingGuard{}
	deps := &Deps{EditLease: guard}
	rec, req := variantsRequest(t, `[]`)

	deps.CreateVariants(rec, req)

	if guard.called == 0 {
		t.Fatal("the guard was not consulted at all")
	}
	if rec.Code == http.StatusConflict {
		t.Fatalf("an allowed write was refused as lease-held: %s", rec.Body.String())
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (the validation that follows the lease "+
			"check); anything else means the two ran in the wrong order",
			rec.Code)
	}
}
