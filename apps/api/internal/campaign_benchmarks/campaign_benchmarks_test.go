// SPDX-License-Identifier: AGPL-3.0-only

package campaign_benchmarks

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func benchmarkRequest(
	t *testing.T,
	scopes []apikeys.Scope,
	session bool,
	withTenant bool,
	path string,
) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	MountRoutes(router, &Deps{Pool: &db.Pool{}})
	req := httptest.NewRequest(http.MethodGet, path, nil)
	ctx := req.Context()
	if session {
		ctx = middleware.WithUser(ctx, &middleware.User{
			ID:       "viewer-1",
			TenantID: "tenant-1",
			Role:     "viewer",
		})
	} else {
		ctx = middleware.WithAPIKeyAuth(ctx)
		ctx = apikeys.WithScopes(ctx, scopes)
	}
	if withTenant {
		ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-1"})
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))
	return rec
}

func TestBenchmarkRouteRequiresReadReportsForAPIKeysAndAdmitsSessions(t *testing.T) {
	path := "/api/v1/campaigns/campaign-1/benchmark"
	rec := benchmarkRequest(t, []apikeys.Scope{apikeys.ScopeReadCampaigns}, false, false, path)
	if rec.Code != http.StatusForbidden ||
		!strings.Contains(rec.Body.String(), "insufficient_scope") {
		t.Fatalf("unrelated API-key scope: status=%d body=%q", rec.Code, rec.Body.String())
	}

	rec = benchmarkRequest(t, []apikeys.Scope{apikeys.ScopeReadReports}, false, false, path)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("read:reports did not reach handler: status=%d body=%q", rec.Code, rec.Body.String())
	}

	rec = benchmarkRequest(t, nil, true, false, path)
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("viewer session did not reach handler: status=%d body=%q", rec.Code, rec.Body.String())
	}
}

func TestBenchmarkRejectsAmbiguousBaselineWindow(t *testing.T) {
	rec := benchmarkRequest(
		t,
		[]apikeys.Scope{apikeys.ScopeReadReports},
		false,
		true,
		"/api/v1/campaigns/campaign-1/benchmark?baseline_days=thirty",
	)
	if rec.Code != http.StatusBadRequest ||
		!strings.Contains(rec.Body.String(), "invalid_baseline_days") {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
}

func TestBuildMetricSuppressesJudgementUntilSampleIsTrustworthy(t *testing.T) {
	unavailable := buildMetric("open_rate", 0.4, 0.2, []float64{0.1, 0.2, 0.3, 0.4})
	if unavailable.Available || unavailable.Percentile != nil || unavailable.Verdict != "" {
		t.Fatalf("insufficient sample leaked judgement: %+v", unavailable)
	}
	if unavailable.Reason != "insufficient_baseline_sample" ||
		unavailable.DeltaPct == nil ||
		*unavailable.DeltaPct != 100 {
		t.Fatalf("insufficient sample metadata = %+v", unavailable)
	}
	raw, err := json.Marshal(unavailable)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"percentile":null`) ||
		!strings.Contains(string(raw), `"available":false`) {
		t.Fatalf("unavailable wire shape is not explicit: %s", raw)
	}

	available := buildMetric("open_rate", 0.6, 0.4, []float64{0.1, 0.2, 0.3, 0.4, 0.5})
	if !available.Available || available.Percentile == nil ||
		*available.Percentile != 100 || available.Verdict != "above" {
		t.Fatalf("available metric = %+v", available)
	}

	inverse := buildMetric("bounce_rate", 0.06, 0.03, []float64{0.01, 0.02, 0.03, 0.04, 0.05})
	if inverse.Verdict != "below" {
		t.Fatalf("higher bounce rate should be an adverse/below verdict: %+v", inverse)
	}

	zeroBaseline := buildMetric("open_rate", 0.2, 0,
		[]float64{0, 0, 0, 0, 0})
	if !zeroBaseline.Available || zeroBaseline.DeltaPct != nil ||
		zeroBaseline.Verdict != "above" {
		t.Fatalf("zero baseline must not invent a percentage: %+v", zeroBaseline)
	}
}

func TestMetricDistributionPreservesEveryBaselineSample(t *testing.T) {
	samples := []rates{{OpenRate: 0.3}, {OpenRate: 0.1}, {OpenRate: 0.2}}
	got := metricDistribution(samples, func(r rates) float64 { return r.OpenRate })
	if len(got) != 3 || got[0] != 0.3 || got[1] != 0.1 || got[2] != 0.2 {
		t.Fatalf("distribution=%v", got)
	}
}
