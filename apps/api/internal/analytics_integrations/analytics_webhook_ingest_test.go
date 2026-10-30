// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

type analyticsRouteProbeStore struct{ *fakeStore }

func (s *analyticsRouteProbeStore) FindAnalyticsIntegrationByIngestToken(context.Context, string) (*Integration, error) {
	return nil, ErrNotFound
}

func (s *analyticsRouteProbeStore) FindSegmentIntegrationByIngestToken(context.Context, string) (*Integration, error) {
	return nil, ErrNotFound
}

// MountPublicRoutes must register the static segment/rudderstack ingest paths AND
// the generic {provider} wildcard without a chi conflict, and a non-CDP provider
// path must dispatch to AnalyticsWebhookIngest (not the Segment handler).
func TestAnalyticsPublicRoutesPrecedenceNoPanic(t *testing.T) {
	defer func() {
		if rec := recover(); rec != nil {
			t.Fatalf("MountPublicRoutes panicked (route conflict?): %v", rec)
		}
	}()
	r := chi.NewRouter()
	MountPublicRoutes(r, &Deps{Repo: &analyticsRouteProbeStore{fakeStore: newFakeStore()}})

	// Both probe lookups return ErrNotFound. Their safe 404 messages remain
	// intentionally distinct, which proves dispatch without depending on the
	// caller-supplied 5xx detail that the central error boundary now redacts.
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/public/analytics-integrations/stripe/ingest/tok123", strings.NewReader(`{}`)))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "analytics integration not found") {
		t.Fatalf("generic provider not dispatched to AnalyticsWebhookIngest: %d %s", rec.Code, rec.Body.String())
	}

	// The static segment path still dispatches to the CDP-specific handler.
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/public/analytics-integrations/segment/ingest/tok123", strings.NewReader(`{}`)))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Segment integration not found") {
		t.Fatalf("segment path not dispatched to SegmentIngest: %d %s", rec.Code, rec.Body.String())
	}
}

// A generic (non-CDP) provider webhook — e.g. a payments or webinar tool — lands
// as a profile + event keyed on the customer email.
func TestMapGenericAnalyticsWebhookProfileAndEvent(t *testing.T) {
	body := []byte(`{"event":"payment.succeeded","customer":{"email":"Buyer@Example.com"},"properties":{"amount":4200,"currency":"usd"}}`)
	req, ok := mapGenericAnalyticsWebhook(body)
	if !ok || len(req.Profiles) != 1 || len(req.Events) != 1 {
		t.Fatalf("generic webhook not mapped: ok=%v req=%+v", ok, req)
	}
	if req.Profiles[0].Email != "buyer@example.com" {
		t.Fatalf("email not extracted/lowercased: %q", req.Profiles[0].Email)
	}
	if req.Events[0].EventName != "payment.succeeded" {
		t.Fatalf("event name not extracted: %q", req.Events[0].EventName)
	}
	if req.Events[0].Properties["amount"] != float64(4200) {
		t.Fatalf("properties not carried through: %+v", req.Events[0].Properties)
	}
}

// Still honors the Segment identify/track spec (many tools emit it).
func TestMapGenericAnalyticsWebhookSegmentSpecPassthrough(t *testing.T) {
	body := []byte(`{"type":"track","event":"Order Completed","userId":"u1","properties":{"email":"x@y.com"},"traits":{"email":"x@y.com"}}`)
	if _, ok := mapGenericAnalyticsWebhook(body); !ok {
		t.Fatal("segment-spec body should map via the CDP fallback")
	}
}

// No email anywhere -> no-op (don't land anonymous/cross-tenant data).
func TestMapGenericAnalyticsWebhookNoEmailIgnored(t *testing.T) {
	body := []byte(`{"event":"page.viewed","properties":{"path":"/pricing"}}`)
	if _, ok := mapGenericAnalyticsWebhook(body); ok {
		t.Fatal("emailless generic webhook must be ignored")
	}
}
