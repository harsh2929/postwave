// SPDX-License-Identifier: AGPL-3.0-only
package deliverability_hub

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestBounceClassBreakdownRejectsUnsupportedWindowOnce(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/deliverability/bounce-class-breakdown?window=365d", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	res := httptest.NewRecorder()
	(&Deps{}).getBounceClassBreakdown(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", res.Code, res.Body.String())
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decoder := json.NewDecoder(strings.NewReader(res.Body.String()))
	if err := decoder.Decode(&envelope); err != nil {
		t.Fatalf("decode validation envelope: %v", err)
	}
	if envelope.Error.Code != "bad_window" {
		t.Fatalf("error code = %q, want bad_window", envelope.Error.Code)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		t.Fatalf("handler wrote more than one response envelope: %v; body=%q", err, res.Body.String())
	}
}

func TestBlocklistEvidenceIsBoundedAndNoStore(t *testing.T) {
	t.Parallel()
	normalized := strings.ToUpper(strings.Join(strings.Fields(blocklistLatestRowsSQL), " "))
	if !strings.Contains(normalized, "ORDER BY CHECKED_AT DESC LIMIT 200") {
		t.Fatalf("blocklist latest-row projection lacks LIMIT 200: %s", normalized)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/deliverability/blocklist-hits", nil)
	res := httptest.NewRecorder()
	(&Deps{}).getBlocklistHits(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.Code)
	}
	if got := res.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestProtectResponsesMakesEveryHubDenialPrivateAndPreservesCapOutcome(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		set    string
		want   string
	}{
		{name: "canonical repair default", method: http.MethodPost, path: "/api/v1/deliverability/hub/repair-override", want: "not-committed"},
		{name: "legacy repair default", method: http.MethodPost, path: "/api/v1/deliverability/repair/override", want: "not-committed"},
		{name: "repair method refusal default", method: http.MethodGet, path: "/api/v1/deliverability/hub/repair-override", want: "not-committed"},
		{name: "repair invalid clobber repaired", method: http.MethodPost, path: "/api/v1/deliverability/hub/repair-override", set: "success-ish", want: "not-committed"},
		{name: "committed evidence survives write wrapper", method: http.MethodPost, path: "/api/v1/deliverability/hub/repair-override", set: "committed-conservatively-fenced", want: "committed-conservatively-fenced"},
		{name: "hub read", method: http.MethodGet, path: "/api/v1/deliverability/hub", want: ""},
		{name: "campaign health", method: http.MethodGet, path: "/api/v1/campaigns/00000000-0000-4000-8000-000000000001/health", want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			request := httptest.NewRequest(test.method, test.path, nil)
			ProtectResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				// Model authorization middleware weakening the initial cache header.
				w.Header().Set("Cache-Control", "no-store")
				if test.set != "" {
					w.Header().Set("X-Postwave-Sending-Cap-Outcome", test.set)
				}
				w.WriteHeader(http.StatusForbidden)
			})).ServeHTTP(response, request)

			if got := response.Header().Get("Cache-Control"); got != "private, no-store, max-age=0" {
				t.Fatalf("Cache-Control = %q", got)
			}
			if response.Header().Get("Pragma") != "no-cache" ||
				response.Header().Get("Expires") != "0" ||
				response.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatalf("private denial headers = %#v", response.Header())
			}
			if got := response.Header().Get("X-Postwave-Sending-Cap-Outcome"); got != test.want {
				t.Fatalf("cap outcome = %q, want %q", got, test.want)
			}
		})
	}
}

func TestRepairOverrideRejectsDelegatedAdminAuthorityBeforeDatabaseAccess(t *testing.T) {
	previousResolver := apikeys.StoredScopeResolver
	apikeys.StoredScopeResolver = func(context.Context, string, string) ([]apikeys.Scope, error) {
		return []apikeys.Scope{apikeys.ScopeAdmin}, nil
	}
	t.Cleanup(func() { apikeys.StoredScopeResolver = previousResolver })

	for _, path := range []string{
		"/api/v1/deliverability/hub/repair-override",
		"/api/v1/deliverability/repair/override",
	} {
		t.Run(path, func(t *testing.T) {
			router := chi.NewRouter()
			MountRoutes(router, &Deps{Pool: new(db.Pool)})
			request := httptest.NewRequest(http.MethodPost, path, nil)
			ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{
				ID: "00000000-0000-4000-8000-000000000001",
			})
			ctx = middleware.WithUser(ctx, &middleware.User{
				ID:            "00000000-0000-4000-8000-000000000002",
				TenantID:      "00000000-0000-4000-8000-000000000001",
				Role:          "custom-deliverability-operator",
				EffectiveRole: "custom-deliverability-operator",
			})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request.WithContext(ctx))

			if response.Code != http.StatusForbidden ||
				!strings.Contains(response.Body.String(), `"code":"insufficient_role"`) {
				t.Fatalf("delegated admin response = %d %s", response.Code, response.Body.String())
			}
			if response.Header().Get("Cache-Control") != "private, no-store, max-age=0" ||
				response.Header().Get("X-Postwave-Sending-Cap-Outcome") != "not-committed" {
				t.Fatalf("delegated admin denial headers = %#v", response.Header())
			}
		})
	}
}

func TestRepairOverrideReplayBypassIsPathExactAndBodyIndependent(t *testing.T) {
	for _, test := range []struct {
		name string
		path string
		want bool
	}{
		{name: "canonical", path: "/api/v1/deliverability/hub/repair-override", want: true},
		{name: "legacy", path: "/api/v1/deliverability/repair/override", want: true},
		{name: "canonical trailing slash", path: "/api/v1/deliverability/hub/repair-override/", want: false},
		{name: "nearby", path: "/api/v1/deliverability/hub/history", want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(`{"ignored":true}`))
			if got := RepairOverrideGlobalReplayBypass(request, nil); got != test.want {
				t.Fatalf("nil-body bypass = %v, want %v", got, test.want)
			}
			if got := RepairOverrideGlobalReplayBypass(request, []byte(`different`)); got != test.want {
				t.Fatalf("body-bearing bypass = %v, want %v", got, test.want)
			}
		})
	}
}

func TestRepairOverrideForbidsEveryIdempotencyKeyBeforeMutation(t *testing.T) {
	for _, path := range []string{
		"/api/v1/deliverability/hub/repair-override",
		"/api/v1/deliverability/repair/override",
	} {
		t.Run(path, func(t *testing.T) {
			for _, values := range [][]string{{"sdk-auto-key"}, {""}, {"one", "two"}} {
				request := httptest.NewRequest(http.MethodPost, path, nil)
				for _, value := range values {
					request.Header.Add("Idempotency-Key", value)
				}
				response := httptest.NewRecorder()
				ProtectResponses(http.HandlerFunc((&Deps{}).postRepairOverride)).ServeHTTP(response, request)

				if response.Code != http.StatusBadRequest ||
					!strings.Contains(response.Body.String(), `"code":"idempotency_forbidden"`) {
					t.Fatalf("values=%q response=%d %s", values, response.Code, response.Body.String())
				}
				if response.Header().Get("X-Postwave-Sending-Cap-Outcome") != "not-committed" ||
					response.Header().Get("Cache-Control") != "private, no-store, max-age=0" ||
					response.Header().Get("Expires") != "0" {
					t.Fatalf("values=%q headers=%#v", values, response.Header())
				}
			}
		})
	}
}

func TestRepairOverrideControlErrorsKeepCanonicalNestedEvidence(t *testing.T) {
	for _, test := range []struct {
		code, message, outcome string
		ok, cleared            bool
	}{
		{
			code: "sending_cap_coordination_unavailable", message: "not changed",
			outcome: "not-committed",
		},
		{
			code: "sending_cap_commit_outcome_unknown", message: "unknown",
			outcome: "commit-outcome-unknown-conservatively-fenced",
		},
		{
			code: "sending_cap_convergence_pending", message: "committed",
			outcome: "committed-conservatively-fenced", ok: true, cleared: true,
		},
	} {
		t.Run(test.code, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeRepairOverrideControlError(
				response, test.code, test.message, test.outcome, test.ok, test.cleared,
			)
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d", response.Code)
			}
			var body struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
				OK      bool   `json:"ok"`
				Cleared bool   `json:"cleared"`
				Outcome string `json:"cap_coordination_outcome"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if body.Error.Code != test.code || body.Error.Message != test.message ||
				body.OK != test.ok || body.Cleared != test.cleared || body.Outcome != test.outcome {
				t.Fatalf("control evidence = %+v", body)
			}
		})
	}
}
