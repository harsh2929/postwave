// SPDX-License-Identifier: AGPL-3.0-only

package regions

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestValidate(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		wantErr bool
	}{
		{"us-east-1 ok", "us-east-1", false},
		{"us-west-2 ok", "us-west-2", false},
		{"eu-central-1 ok", "eu-central-1", false},
		{"eu-west-1 ok", "eu-west-1", false},
		{"ap-southeast-1 ok", "ap-southeast-1", false},
		{"ap-northeast-1 ok", "ap-northeast-1", false},
		{"empty string is rejected", "", true},
		{"unknown region rejected", "mars-1", true},
		{"capitalised rejected (case sensitive)", "US-EAST-1", true},
		{"trailing whitespace rejected", "us-east-1 ", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := Validate(tc.in)
			if tc.wantErr && err == nil {
				t.Fatalf("Validate(%q) = nil, want error", tc.in)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("Validate(%q) = %v, want nil", tc.in, err)
			}
		})
	}
}

func TestAllowed_CoversAllConstants(t *testing.T) {
	got := Allowed()
	if len(got) != 6 {
		t.Fatalf("Allowed() len = %d, want 6", len(got))
	}
	want := map[Region]bool{
		USEast1: true, USWest2: true,
		EUCentral1: true, EUWest1: true,
		APSoutheast1: true, APNortheast1: true,
	}
	for _, r := range got {
		if !want[r] {
			t.Errorf("unexpected region %q", r)
		}
		delete(want, r)
	}
	if len(want) != 0 {
		t.Errorf("missing regions: %v", want)
	}
}

func TestCurrent_DefaultsToUSEast1(t *testing.T) {
	t.Setenv("POSTWAVE_DEPLOYMENT_REGION", "")
	if got := Current(); got != USEast1 {
		t.Fatalf("Current() = %q, want %q", got, USEast1)
	}
}

func TestCurrent_HonorsEnv(t *testing.T) {
	t.Setenv("POSTWAVE_DEPLOYMENT_REGION", "eu-central-1")
	if got := Current(); got != EUCentral1 {
		t.Fatalf("Current() = %q, want eu-central-1", got)
	}
}

func TestProvisioningFallsBackForLocalSentinel(t *testing.T) {
	t.Setenv("POSTWAVE_DEPLOYMENT_REGION", "local")
	if got := Provisioning(); got != USEast1 {
		t.Fatalf("Provisioning() = %q, want %q", got, USEast1)
	}
}

func TestProvisioningHonorsSupportedRegion(t *testing.T) {
	t.Setenv("POSTWAVE_DEPLOYMENT_REGION", "eu-central-1")
	if got := Provisioning(); got != EUCentral1 {
		t.Fatalf("Provisioning() = %q, want %q", got, EUCentral1)
	}
}

func TestHostFor(t *testing.T) {
	got := HostFor(EUCentral1)
	if got != "https://eu-central-1.api.moosewave.com" {
		t.Fatalf("HostFor(eu-central-1) = %q", got)
	}
}

func TestRegionContextRoundTrip(t *testing.T) {
	ctx := WithRegion(httptest.NewRequest("GET", "/", nil).Context(), USWest2)
	got, ok := RegionFromContext(ctx)
	if !ok || got != USWest2 {
		t.Fatalf("RegionFromContext = %q, %v; want us-west-2, true", got, ok)
	}
	// Empty ctx returns false.
	if _, ok := RegionFromContext(httptest.NewRequest("GET", "/", nil).Context()); ok {
		t.Fatalf("RegionFromContext on empty ctx returned ok=true")
	}
}

// staticLookup returns the same region for every tenant id; sentinel
// "missing" id returns an error so we exercise the failure path.
func staticLookup(r Region) LookupTenantRegion {
	return func(tenantID string) (Region, error) {
		if tenantID == "missing" {
			return "", errors.New("not found")
		}
		return r, nil
	}
}

func TestEnforceRegion_MatchPassesThrough(t *testing.T) {
	t.Setenv("POSTWAVE_DEPLOYMENT_REGION", "us-east-1")

	called := false
	handler := EnforceRegion(staticLookup(USEast1))(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			called = true
			got, ok := RegionFromContext(r.Context())
			if !ok || got != USEast1 {
				t.Fatalf("region not on ctx: got %q ok=%v", got, ok)
			}
			w.WriteHeader(http.StatusNoContent)
		},
	))

	req := httptest.NewRequest("GET", "/api/v1/anything", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatalf("inner handler not called")
	}
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
}

func TestEnforceRegion_MismatchReturns421(t *testing.T) {
	t.Setenv("POSTWAVE_DEPLOYMENT_REGION", "us-east-1")

	handler := EnforceRegion(staticLookup(EUCentral1))(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			t.Fatalf("inner handler should not be called on region mismatch")
		},
	))

	req := httptest.NewRequest("GET", "/api/v1/anything", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMisdirectedRequest {
		t.Fatalf("status = %d, want 421", rec.Code)
	}
	if got := rec.Header().Get("Location"); got != "https://eu-central-1.api.moosewave.com" {
		t.Fatalf("Location = %q", got)
	}
	if got := rec.Header().Get("X-Postwave-Region"); got != "eu-central-1" {
		t.Fatalf("X-Postwave-Region = %q", got)
	}
	var body struct {
		Error struct {
			Code            string `json:"code"`
			Message         string `json:"message"`
			CorrectEndpoint string `json:"correct_endpoint"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Error.Code != "wrong_region" {
		t.Fatalf("error.code = %q, want wrong_region", body.Error.Code)
	}
	if body.Error.CorrectEndpoint != "https://eu-central-1.api.moosewave.com" {
		t.Fatalf("correct_endpoint = %q", body.Error.CorrectEndpoint)
	}
	if !strings.Contains(body.Error.Message, "eu-central-1") {
		t.Fatalf("message missing region hint: %q", body.Error.Message)
	}
}

func TestEnforceRegion_NoTenantPassesThrough(t *testing.T) {
	t.Setenv("POSTWAVE_DEPLOYMENT_REGION", "us-east-1")

	called := false
	handler := EnforceRegion(staticLookup(EUCentral1))(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			called = true
			w.WriteHeader(http.StatusOK)
		},
	))

	req := httptest.NewRequest("GET", "/api/v1/healthz", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatalf("inner handler should run when no tenant on ctx")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestEnforceRegion_LookupErrorFailsClosed(t *testing.T) {
	t.Setenv("POSTWAVE_DEPLOYMENT_REGION", "us-east-1")

	handler := EnforceRegion(staticLookup(USEast1))(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			t.Fatalf("inner handler should not run when lookup fails")
		},
	))

	req := httptest.NewRequest("GET", "/api/v1/anything", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "missing"}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "region_lookup_failed") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
