// SPDX-License-Identifier: AGPL-3.0-only
package activation_firewall

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// fakeSource implements MemberSource.
type fakeSource struct {
	emails   []string
	destType string
	override string
	ok       bool
	err      error
}

func (f *fakeSource) SyncActivationContext(_ context.Context, _, _ string) ([]string, string, string, bool, error) {
	return f.emails, f.destType, f.override, f.ok, f.err
}

func reqWithParams(method, target string, params map[string]string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tid, Slug: "t1"})
	if len(params) > 0 {
		rctx := chi.NewRouteContext()
		for k, v := range params {
			rctx.URLParams.Add(k, v)
		}
		ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	}
	return req.WithContext(ctx)
}

func TestPreviewExclusions_Shape(t *testing.T) {
	// a@x.com consented; b@x.com not; c@x.com suppressed.
	f := New(
		&fakeConsent{granted: map[string]bool{"a@x.com": true}},
		&fakeSuppression{suppressed: map[string]*suppressions.Entry{"c@x.com": entry(suppressions.ReasonHardBounce)}},
	)
	d := &SyncDeps{
		Filter: f,
		Source: &fakeSource{emails: []string{"a@x.com", "b@x.com", "c@x.com"}, destType: "meta", ok: true},
	}
	rec := httptest.NewRecorder()
	d.PreviewExclusions(rec, reqWithParams(http.MethodGet, "/api/v1/audience-syncs/s1/exclusion-preview", map[string]string{"id": "s1"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	var p SyncExclusionPreview
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if p.AudienceCount != 3 {
		t.Errorf("audience_count = %d, want 3", p.AudienceCount)
	}
	if p.ExcludedTotal != 2 {
		t.Errorf("excluded_total = %d, want 2", p.ExcludedTotal)
	}
	if p.ExcludedConsent != 1 || p.ExcludedSuppression != 1 {
		t.Errorf("breakdown wrong: consent=%d suppression=%d", p.ExcludedConsent, p.ExcludedSuppression)
	}
	if p.Purpose != "targeted_ads" {
		t.Errorf("purpose = %q, want targeted_ads (meta default)", p.Purpose)
	}
}

func TestPreviewExclusions_UnavailableSentinel(t *testing.T) {
	d := &SyncDeps{
		Filter: New(&fakeConsent{}, &fakeSuppression{}),
		Source: &fakeSource{ok: false, destType: "warehouse"}, // ghost source
	}
	rec := httptest.NewRecorder()
	d.PreviewExclusions(rec, reqWithParams(http.MethodGet, "/api/v1/audience-syncs/s1/exclusion-preview", map[string]string{"id": "s1"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var p SyncExclusionPreview
	_ = json.Unmarshal(rec.Body.Bytes(), &p)
	if p.AudienceCount != -1 || p.ExcludedTotal != -1 {
		t.Fatalf("unresolvable source must return -1 sentinels, got %+v", p)
	}
	if p.Purpose != "profiling" {
		t.Errorf("purpose should still be the warehouse default, got %q", p.Purpose)
	}
}

func TestPreviewExclusions_PurposeOverrideQuery(t *testing.T) {
	d := &SyncDeps{
		Filter: New(&fakeConsent{granted: map[string]bool{"a@x.com": true}}, &fakeSuppression{}),
		Source: &fakeSource{emails: []string{"a@x.com"}, destType: "webhook", ok: true},
	}
	rec := httptest.NewRecorder()
	d.PreviewExclusions(rec, reqWithParams(http.MethodGet, "/api/v1/audience-syncs/s1/exclusion-preview?purpose=profiling", map[string]string{"id": "s1"}))
	var p SyncExclusionPreview
	_ = json.Unmarshal(rec.Body.Bytes(), &p)
	if p.Purpose != "profiling" {
		t.Fatalf("query override should win, got %q", p.Purpose)
	}
}

func TestDownloadExclusionReceipt_SignedCSV(t *testing.T) {
	fs := &fakeStore{forRun: map[string][]ExclusionReceipt{
		"run-1": {
			{SubscriberEmail: "b@x.com", RuleClass: RuleClassConsent, RuleReason: "consent_targeted_ads_at null", Purpose: "targeted_ads", Signature: "abc"},
			{SubscriberEmail: "c@x.com", RuleClass: RuleClassSuppression, RuleReason: "hard_bounce", Purpose: "targeted_ads", Signature: "def"},
		},
	}}
	d := &SyncDeps{Store: fs, Filter: New(nil, nil), Source: &fakeSource{}, SignKey: "k"}
	rec := httptest.NewRecorder()
	d.DownloadExclusionReceipt(rec, reqWithParams(http.MethodGet, "/api/v1/audience-sync-runs/run-1/exclusion-receipt", map[string]string{"run_id": "run-1"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Errorf("content-type = %q, want text/csv", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "exclusion-receipt-run-1.csv") {
		t.Errorf("content-disposition = %q", cd)
	}
	if sig := rec.Header().Get(ReceiptSignatureHeader); !strings.HasPrefix(sig, "t=") {
		t.Errorf("missing/invalid receipt signature header: %q", sig)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "subscriber_email,rule_class,rule_reason,purpose,consent_event_id,excluded_at,signature") {
		t.Errorf("CSV header missing: %q", body)
	}
	if !strings.Contains(body, "b@x.com") || !strings.Contains(body, "hard_bounce") {
		t.Errorf("CSV rows missing: %q", body)
	}
}

func TestDownloadExclusionReceipt_NoSignKeyNoHeader(t *testing.T) {
	fs := &fakeStore{forRun: map[string][]ExclusionReceipt{"run-2": {{SubscriberEmail: "a@x.com"}}}}
	d := &SyncDeps{Store: fs, Filter: New(nil, nil), Source: &fakeSource{}, SignKey: ""}
	rec := httptest.NewRecorder()
	d.DownloadExclusionReceipt(rec, reqWithParams(http.MethodGet, "/api/v1/audience-sync-runs/run-2/exclusion-receipt", map[string]string{"run_id": "run-2"}))
	if rec.Header().Get(ReceiptSignatureHeader) != "" {
		t.Error("no sign key configured → no signature header")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
}
