// SPDX-License-Identifier: AGPL-3.0-only
package mailchimpv3

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

// The compatibility surface must respect the editing lease.
//
// `PUT/PATCH /3.0/campaigns/{id}/content` updates body_html, plain_text,
// body_mjml and content_blocks — the campaign body itself — and this file's own
// header notes the surface is reachable by anyone holding an API key. It sat
// outside the single-writer rule that covers the first-party PATCH, which made
// it the way AROUND the lease rather than a gap in it.

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

func contentRequest(t *testing.T, body string) (*httptest.ResponseRecorder, *http.Request) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPatch, "/3.0/campaigns/c-1/content",
		strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("campaign_id", "c-1")
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{
		ID: "11111111-1111-1111-1111-111111111111", Slug: "acme",
	})
	return httptest.NewRecorder(), req.WithContext(ctx)
}

func TestCompatContentWriteIsRefusedWhileAnotherEditorHoldsTheLease(t *testing.T) {
	guard := &refusingGuard{}
	deps := &Deps{EditLease: guard}
	rec, req := contentRequest(t, `{"html":"<p>rewritten by someone else</p>"}`)

	deps.UpdateCampaignContent(rec, req)

	if guard.called == 0 {
		t.Fatal("the compatibility surface never consulted the editing lease — " +
			"the campaign body is writable straight past the single-writer rule " +
			"by anyone holding an API key")
	}
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "edit_lease_held") {
		t.Errorf("the refusal does not carry the lease code: %s", rec.Body.String())
	}
}

func TestCompatContentWriteProceedsWhenTheLeaseAllows(t *testing.T) {
	// The mirror failure: refusing every compatibility write would break every
	// Mailchimp-compatible integration.
	//
	// Sends a body the decoder rejects, so the failure that follows the lease
	// check proves both that the guard ran and that it did not stop the request
	// — without a database, and without a recovered panic standing in for an
	// assertion.
	guard := &allowingGuard{}
	deps := &Deps{EditLease: guard}
	rec, req := contentRequest(t, `not json`)

	deps.UpdateCampaignContent(rec, req)

	if guard.called == 0 {
		t.Fatal("the guard was not consulted at all")
	}
	if rec.Code == http.StatusConflict {
		t.Fatalf("an allowed write was refused as lease-held: %s", rec.Body.String())
	}
}
