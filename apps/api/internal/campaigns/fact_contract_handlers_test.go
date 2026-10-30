// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func factContractRequest(body string) *http.Request {
	req := httptest.NewRequest(http.MethodPut,
		"/api/v1/campaigns/"+revisionTestCampaign+"/fact-contract", strings.NewReader(body))
	route := chi.NewRouteContext()
	route.URLParams.Add("id", revisionTestCampaign)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, route)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: revisionTestTenant})
	return req.WithContext(ctx)
}

func TestFactContractRouteIsMountedWithCampaignWrites(t *testing.T) {
	t.Parallel()
	router := chi.NewRouter()
	MountWrite(router, &Deps{})
	found := false
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		found = found || method == http.MethodPut && route == "/api/v1/campaigns/{id}/fact-contract"
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	if !found {
		t.Fatal("PUT /api/v1/campaigns/{id}/fact-contract is not mounted")
	}
}

func TestFactContractReplayBodyLimitIsNarrow(t *testing.T) {
	t.Parallel()
	tests := []struct {
		method string
		path   string
		want   int64
	}{
		{http.MethodPut, "/api/v1/campaigns/" + revisionTestCampaign + "/fact-contract", factContractJSONMaxBodyBytes},
		{http.MethodPost, "/api/v1/campaigns/" + revisionTestCampaign + "/fact-contract", 0},
		{http.MethodPut, "/api/v1/campaigns/" + revisionTestCampaign, 0},
		{http.MethodPut, "/api/v1/other/" + revisionTestCampaign + "/fact-contract", 0},
	}
	for _, test := range tests {
		req := httptest.NewRequest(test.method, test.path, nil)
		if got := FactContractReplayBodyLimit(req); got != test.want {
			t.Errorf("%s %s limit=%d, want %d", test.method, test.path, got, test.want)
		}
	}
}

func TestSetFactContractRequiresExactlyOneValidIdempotencyKey(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		values []string
		code   string
	}{
		{name: "missing", code: "idempotency_key_required"},
		{name: "blank", values: []string{" "}, code: "invalid_idempotency_key"},
		{name: "padded", values: []string{" key "}, code: "invalid_idempotency_key"},
		{name: "duplicate", values: []string{"key-a", "key-b"}, code: "invalid_idempotency_key"},
		{name: "control", values: []string{"key\n"}, code: "invalid_idempotency_key"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := factContractRequest(`{}`)
			for _, value := range test.values {
				req.Header.Add(idempotency.HeaderName, value)
			}
			rec := httptest.NewRecorder()
			(&Deps{}).SetFactContract(rec, req)
			if rec.Code != http.StatusBadRequest || !bytes.Contains(rec.Body.Bytes(), []byte(`"code":"`+test.code+`"`)) {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestSetFactContractFailsClosedWithoutReplayMiddleware(t *testing.T) {
	t.Parallel()
	req := factContractRequest(`{}`)
	req.Header.Set(idempotency.HeaderName, "fact-contract-1")
	req.Header.Set("If-Match", `"campaign-version"`)
	rec := httptest.NewRecorder()
	(&Deps{}).SetFactContract(rec, req)
	if rec.Code != http.StatusServiceUnavailable ||
		!bytes.Contains(rec.Body.Bytes(), []byte(`"code":"idempotency_boundary_unavailable"`)) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store, max-age=0" {
		t.Fatalf("Cache-Control=%q", got)
	}
}

func TestRequireFactContractIfMatchIsStrict(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		values []string
		status int
		want   string
		ok     bool
	}{
		{name: "missing", status: http.StatusPreconditionRequired},
		{name: "blank", values: []string{""}, status: http.StatusPreconditionRequired},
		{name: "wildcard", values: []string{"*"}, status: http.StatusPreconditionRequired},
		{name: "weak", values: []string{`W/"version"`}, status: http.StatusPreconditionFailed},
		{name: "list", values: []string{`"one", "two"`}, status: http.StatusPreconditionFailed},
		{name: "duplicate", values: []string{`"one"`, `"two"`}, status: http.StatusPreconditionFailed},
		{name: "unquoted", values: []string{"version"}, status: http.StatusPreconditionFailed},
		{name: "padded", values: []string{` "version"`}, status: http.StatusPreconditionFailed},
		{name: "strong", values: []string{`"version"`}, status: http.StatusOK, want: `"version"`, ok: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, "/", nil)
			for _, value := range test.values {
				req.Header.Add("If-Match", value)
			}
			rec := httptest.NewRecorder()
			got, ok := requireFactContractIfMatch(rec, req)
			if got != test.want || ok != test.ok {
				t.Fatalf("got=(%q,%v), want=(%q,%v)", got, ok, test.want, test.ok)
			}
			if test.status != http.StatusOK && rec.Code != test.status {
				t.Fatalf("status=%d, want %d; body=%s", rec.Code, test.status, rec.Body.String())
			}
		})
	}
}

func TestSetFactContractRejectsInvalidCampaignIDAfterReplayBoundary(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/campaigns/not-a-uuid/fact-contract", strings.NewReader(`{}`))
	route := chi.NewRouteContext()
	route.URLParams.Add("id", "not-a-uuid")
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, route)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: revisionTestTenant})
	req = req.WithContext(ctx)
	req.Header.Set(idempotency.HeaderName, "fact-contract-invalid-id")
	req.Header.Set("If-Match", `"version"`)

	// Without the replay middleware, the fail-closed boundary deliberately wins
	// before path parsing. This assertion protects the security ordering.
	rec := httptest.NewRecorder()
	(&Deps{}).SetFactContract(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("ETag") != "" {
		t.Fatal("an unsuccessful write must not emit a campaign ETag")
	}
}

func TestFactContractPreconditionErrorWritersRemainCanonical(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	httpcache.WritePreconditionRequired(rec)
	if rec.Code != http.StatusPreconditionRequired || !strings.Contains(rec.Body.String(), "precondition_required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}
