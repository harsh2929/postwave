package subscribers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func subscriberTenantRequest(method, path, body string) *http.Request {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestCreateRejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"email":"person@example.com","custom_fields":{"blob":"` + strings.Repeat("a", int(subscriberJSONMaxBodyBytes)+1) + `"}}`
	rec := httptest.NewRecorder()
	d.Create(rec, subscriberTenantRequest(http.MethodPost, "/api/v1/subscribers", body))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

func TestMergeRejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"primary_id":"a","duplicate_id":"` + strings.Repeat("b", int(subscriberJSONMaxBodyBytes)+1) + `"}`
	rec := httptest.NewRecorder()
	d.MergeHandler(rec, subscriberTenantRequest(http.MethodPost, "/api/v1/subscribers/merge", body))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

// --- SUB-101: bulk endpoints enforce MaxBytes + unknown-field + single-value
// rejection. Each case is decoded BEFORE any DB access, so a nil pool stays
// untouched — the test proves the body guard gates the persistence path.

// bulkBodyHandler names a bulk handler + a body-carrying request for it.
type bulkBodyCase struct {
	name    string
	handler func(*Deps) http.HandlerFunc
	path    string
}

func bulkBodyCases() []bulkBodyCase {
	return []bulkBodyCase{
		{"delete", func(d *Deps) http.HandlerFunc { return d.BulkDelete }, "/api/v1/subscribers/bulk/delete"},
		{"unsubscribe", func(d *Deps) http.HandlerFunc { return d.BulkUnsubscribe }, "/api/v1/subscribers/bulk/unsubscribe"},
		{"tag", func(d *Deps) http.HandlerFunc { return d.BulkTag }, "/api/v1/subscribers/bulk/tag"},
		{"untag", func(d *Deps) http.HandlerFunc { return d.BulkUntag }, "/api/v1/subscribers/bulk/untag"},
		{"move-to-list", func(d *Deps) http.HandlerFunc { return d.BulkMoveToList }, "/api/v1/subscribers/bulk/move-to-list"},
		// SUB-101 — the 6 EXTENDED verbs (bulk_verbs.go). The body guard runs
		// before any verb-specific field validation, so the shared BulkTarget
		// bodies below exercise MaxBytes/unknown-field/single-value on each.
		{"resubscribe", func(d *Deps) http.HandlerFunc { return d.BulkResubscribe }, "/api/v1/subscribers/bulk/resubscribe"},
		{"set-custom-field", func(d *Deps) http.HandlerFunc { return d.BulkSetCustomField }, "/api/v1/subscribers/bulk/set-custom-field"},
		{"update-merge-field", func(d *Deps) http.HandlerFunc { return d.BulkUpdateMergeField }, "/api/v1/subscribers/bulk/update-merge-field"},
		{"grant-consent", func(d *Deps) http.HandlerFunc { return d.BulkGrantConsent }, "/api/v1/subscribers/bulk/grant-consent"},
		{"revoke-consent", func(d *Deps) http.HandlerFunc { return d.BulkRevokeConsent }, "/api/v1/subscribers/bulk/revoke-consent"},
		{"export-by-segment", func(d *Deps) http.HandlerFunc { return d.BulkExportBySegment }, "/api/v1/subscribers/bulk/export-by-segment"},
	}
}

func TestBulkEndpointsRejectOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	oversize := strings.Repeat("a", int(subscriberJSONMaxBodyBytes)+1)
	for _, c := range bulkBodyCases() {
		body := `{"subscriber_ids":["` + oversize + `"]}`
		rec := httptest.NewRecorder()
		c.handler(d)(rec, subscriberTenantRequest(http.MethodPost, c.path, body))
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("%s: status = %d, want 413", c.name, rec.Code)
		}
	}
}

func TestBulkEndpointsRejectUnknownFields(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	for _, c := range bulkBodyCases() {
		// A typo'd camelCase key would otherwise silently affect zero rows.
		body := `{"subscriberIds":["11111111-1111-1111-1111-111111111111"]}`
		rec := httptest.NewRecorder()
		c.handler(d)(rec, subscriberTenantRequest(http.MethodPost, c.path, body))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400 for unknown field", c.name, rec.Code)
		}
	}
}

func TestBulkEndpointsRejectMultipleJSONValues(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	for _, c := range bulkBodyCases() {
		body := `{"subscriber_ids":[]}{"subscriber_ids":[]}`
		rec := httptest.NewRecorder()
		c.handler(d)(rec, subscriberTenantRequest(http.MethodPost, c.path, body))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400 for multiple JSON values", c.name, rec.Code)
		}
	}
}
