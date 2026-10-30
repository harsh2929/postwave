package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMeReturnsCanonicalMFAPolicyAndSessionState(t *testing.T) {
	t.Parallel()

	d := &Deps{
		MeContextLookup: func(*http.Request) (MeContext, bool) {
			return MeContext{
				TenantID:      "tenant-1",
				UserID:        "user-1",
				UserEmail:     "owner@example.com",
				UserRole:      "owner",
				MFASatisfied:  false,
				EffectiveRole: "owner",
			}, true
		},
		MFARequirementLookup: func(_ context.Context, tenantID, role string) (bool, bool) {
			if tenantID != "tenant-1" || role != "owner" {
				t.Fatalf("lookup got tenant=%q role=%q", tenantID, role)
			}
			return true, true
		},
	}

	req := httptest.NewRequest("GET", "/api/v1/auth/me", nil)
	rec := httptest.NewRecorder()
	d.Me(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var got MeResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !got.MFARequired {
		t.Fatal("mfa_required = false, want true")
	}
	if got.MFASatisfied {
		t.Fatal("mfa_satisfied = true, want false")
	}
	if got.AuthProvider != "password" {
		t.Fatalf("auth_provider = %q, want password fallback", got.AuthProvider)
	}
}

func TestMeFailsClosedWhenMFAPolicyCannotBeResolved(t *testing.T) {
	t.Parallel()

	d := &Deps{
		MeContextLookup: func(*http.Request) (MeContext, bool) {
			return MeContext{
				TenantID:  "tenant-1",
				UserID:    "user-1",
				UserEmail: "owner@example.com",
				UserRole:  "owner",
			}, true
		},
		MFARequirementLookup: func(context.Context, string, string) (bool, bool) {
			return false, false
		},
	}

	req := httptest.NewRequest("GET", "/api/v1/auth/me", nil)
	rec := httptest.NewRecorder()
	d.Me(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body=%s; want 503", rec.Code, rec.Body.String())
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Error.Code != "mfa_policy_unavailable" {
		t.Fatalf("error code = %q, want mfa_policy_unavailable", body.Error.Code)
	}
}

func TestTOTPDisableCannotRemoveFactorRequiredByPolicy(t *testing.T) {
	t.Parallel()

	d := &Deps{
		MeContextLookup: func(*http.Request) (MeContext, bool) {
			return MeContext{
				TenantID:     "tenant-1",
				UserID:       "user-1",
				UserRole:     "owner",
				MFASatisfied: true,
			}, true
		},
		MFARequirementLookup: func(context.Context, string, string) (bool, bool) {
			return true, true
		},
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/totp", nil)
	rec := httptest.NewRecorder()
	d.TOTPDisable(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body=%s; want 403", rec.Code, rec.Body.String())
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Error.Code != "mfa_policy_required" {
		t.Fatalf("error code = %q, want mfa_policy_required", body.Error.Code)
	}
}
