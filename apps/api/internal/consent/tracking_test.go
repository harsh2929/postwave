// SPDX-License-Identifier: AGPL-3.0-only
package consent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// withEmailParam injects the chi {email} URL param so handlers that
// pull it via chi.URLParam can be exercised without a real router.
func withEmailParam(r *http.Request, email string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("email", email)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

func withTrackingIDParam(r *http.Request, id string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

func TestIsOpenTrackingOptedOut(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name string
		p    *TrackingPrefs
		want bool
	}{
		{"nil", nil, false},
		{"no opt-out timestamp", &TrackingPrefs{}, false},
		{"opted out", &TrackingPrefs{OpenOptOutAt: &now}, true},
		{"GPC overrides missing timestamp", &TrackingPrefs{GPC: true}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsOpenTrackingOptedOut(tc.p); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestIsClickTrackingOptedOut(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name string
		p    *TrackingPrefs
		want bool
	}{
		{"nil", nil, false},
		{"no opt-out timestamp", &TrackingPrefs{}, false},
		{"opted out", &TrackingPrefs{ClickOptOutAt: &now}, true},
		{"GPC overrides missing timestamp", &TrackingPrefs{GPC: true}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsClickTrackingOptedOut(tc.p); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestPatchTrackingRejectsMissingTenant(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPatch,
		"/api/v1/consent/subscribers/foo@example.com/tracking",
		strings.NewReader(`{"open_opt_out":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	deps.PatchTracking(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestPatchTrackingRejectsEmptyBody(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPatch,
		"/api/v1/consent/subscribers/foo@example.com/tracking",
		strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(),
		&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"}))
	req = withEmailParam(req, "foo@example.com")
	rec := httptest.NewRecorder()
	deps.PatchTracking(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	// Empty patch ({} with neither open_opt_out nor click_opt_out) is rejected
	// with the standard validation code, not a bespoke one-off.
	if !strings.Contains(rec.Body.String(), "invalid_input") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestGetTrackingRejectsMissingTenant(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/consent/subscribers/foo@example.com/tracking", nil)
	rec := httptest.NewRecorder()
	deps.GetTracking(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestPatchTrackingRejectsOversizedBody(t *testing.T) {
	deps := &Deps{}
	body := `{"source":"` + strings.Repeat("x", int(trackingJSONMaxBodyBytes)) + `","open_opt_out":true}`
	req := httptest.NewRequest(http.MethodPatch,
		"/api/v1/consent/subscribers/foo@example.com/tracking",
		strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(),
		&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"}))
	req = withEmailParam(req, "foo@example.com")
	rec := httptest.NewRecorder()
	deps.PatchTracking(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("got %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
}

func TestStableTrackingPatchRejectsAmbiguousOrConfusedJSON(t *testing.T) {
	for _, tc := range []struct {
		name        string
		body        string
		contentType string
		wantStatus  int
		wantCode    string
	}{
		{"unknown field", `{"open_opt_out":true,"unexpected":true}`, "application/json", http.StatusBadRequest, "unknown_field"},
		{"trailing value", `{"open_opt_out":true}{"gpc":true}`, "application/json", http.StatusBadRequest, "multiple_json_values"},
		{"wrong media type", `{"open_opt_out":true}`, "text/plain", http.StatusUnsupportedMediaType, "unsupported_media_type"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deps := &Deps{}
			req := httptest.NewRequest(http.MethodPatch,
				"/api/v1/subscribers/22222222-2222-2222-2222-222222222222/tracking-consent",
				strings.NewReader(tc.body))
			req.Header.Set("Content-Type", tc.contentType)
			req = req.WithContext(middleware.WithTenant(req.Context(),
				&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"}))
			req = withTrackingIDParam(req, "22222222-2222-2222-2222-222222222222")
			rec := httptest.NewRecorder()
			deps.PatchTrackingByID(rec, req)
			if rec.Code != tc.wantStatus || !strings.Contains(rec.Body.String(), tc.wantCode) {
				t.Fatalf("status=%d body=%s; want %d/%s", rec.Code, rec.Body.String(), tc.wantStatus, tc.wantCode)
			}
		})
	}
}

func TestSendTrackingFilterFailsClosedWhenUnconfiguredOrInputInvalid(t *testing.T) {
	filter := &SendTrackingFilter{}
	for _, tc := range []struct {
		name, tenant, email string
	}{
		{"unconfigured", "11111111-1111-1111-1111-111111111111", "person@example.com"},
		{"invalid tenant", "not-a-uuid", "person@example.com"},
		{"invalid email", "11111111-1111-1111-1111-111111111111", "not an email"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			open, click, err := filter.Lookup(context.Background(), tc.tenant, tc.email)
			if err == nil {
				t.Fatal("expected uncertainty error")
			}
			if !open || !click {
				t.Fatalf("uncertainty returned open=%v click=%v; want both suppressed", open, click)
			}
		})
	}
}

func TestSendTrackingBatchValidationReturnsFailClosedEntriesForEveryAddress(t *testing.T) {
	filter := &SendTrackingFilter{}
	got, err := filter.LookupBatch(context.Background(),
		"11111111-1111-1111-1111-111111111111",
		[]string{"Valid@Example.com", "not an email"})
	if err == nil {
		t.Fatal("expected invalid batch error")
	}
	for _, key := range []string{"valid@example.com", "not an email"} {
		entry, ok := got[key]
		if !ok || !entry.SkipOpen || !entry.SkipClick {
			t.Fatalf("%q decision=%+v exists=%v; want fail closed", key, entry, ok)
		}
	}
}

func TestNormalizeTrackingPatchHonoursGPCAndRejectsHostileEvidence(t *testing.T) {
	t.Run("Sec-GPC forces both signal and source", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPatch, "/", nil)
		r.Header.Set("Sec-GPC", "1")
		in := TrackingPatchInput{}
		if err := normalizeTrackingPatch(r, &in); err != nil {
			t.Fatal(err)
		}
		if in.GPC == nil || !*in.GPC || in.Source == nil || *in.Source != "gpc" {
			t.Fatalf("normalized GPC input = %+v", in)
		}
	})

	for _, tc := range []struct {
		name string
		body TrackingPatchInput
	}{
		{"empty source", TrackingPatchInput{OpenOptOut: boolPointer(true), Source: stringPointer(" ")}},
		{"source control", TrackingPatchInput{OpenOptOut: boolPointer(true), Source: stringPointer("admin\nforged")}},
		{"source format", TrackingPatchInput{OpenOptOut: boolPointer(true), Source: stringPointer("adm\u200bin")}},
		{"policy control", TrackingPatchInput{OpenOptOut: boolPointer(true), PolicyVersion: stringPointer("v1\u0000x")}},
		{"policy line separator", TrackingPatchInput{OpenOptOut: boolPointer(true), PolicyVersion: stringPointer("v1\u2028forged")}},
		{"policy too long", TrackingPatchInput{OpenOptOut: boolPointer(true), PolicyVersion: stringPointer(strings.Repeat("x", trackingPolicyMaxBytes+1))}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := normalizeTrackingPatch(httptest.NewRequest(http.MethodPatch, "/", nil), &tc.body); err == nil {
				t.Fatal("hostile evidence was accepted")
			}
		})
	}
}

func TestStableTrackingRouteRejectsMalformedIDBeforeDatabase(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/subscribers/not-a-uuid/tracking-consent", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(),
		&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"}))
	req = withTrackingIDParam(req, "not-a-uuid")
	rec := httptest.NewRecorder()
	deps.GetTrackingByID(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_subscriber_id") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestTrackingPatchesRequireOneFreshStrongETag(t *testing.T) {
	for _, route := range []struct {
		name   string
		path   string
		invoke func(*Deps, http.ResponseWriter, *http.Request)
		param  func(*http.Request) *http.Request
	}{
		{
			name:   "stable subscriber id",
			path:   "/api/v1/subscribers/22222222-2222-2222-2222-222222222222/tracking-consent",
			invoke: (*Deps).PatchTrackingByID,
			param: func(req *http.Request) *http.Request {
				return withTrackingIDParam(req, "22222222-2222-2222-2222-222222222222")
			},
		},
		{
			name:   "deprecated email",
			path:   "/api/v1/consent/subscribers/person@example.com/tracking",
			invoke: (*Deps).PatchTracking,
			param: func(req *http.Request) *http.Request {
				return withEmailParam(req, "person@example.com")
			},
		},
	} {
		for _, header := range []string{"", "*", `W/"tracking:v1"`, `"tracking:v1", "tracking:v2"`, "tracking:v1"} {
			t.Run(route.name+"/"+header, func(t *testing.T) {
				deps := &Deps{}
				req := httptest.NewRequest(http.MethodPatch, route.path,
					strings.NewReader(`{"open_opt_out":true}`))
				req.Header.Set("Content-Type", "application/json")
				if header != "" {
					req.Header.Set("If-Match", header)
				}
				req = req.WithContext(middleware.WithTenant(req.Context(),
					&middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"}))
				req = route.param(req)
				rec := httptest.NewRecorder()
				route.invoke(deps, rec, req)
				if rec.Code != http.StatusPreconditionRequired || !strings.Contains(rec.Body.String(), "precondition_required") {
					t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
				}
			})
		}
	}
}

func boolPointer(value bool) *bool       { return &value }
func stringPointer(value string) *string { return &value }
