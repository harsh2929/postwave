package main

import (
	"os"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/routeauth"
)

func TestCampaignAssuranceOpsRoutesStayInsidePrivilegedInventory(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("ops_console_wiring.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	outer := strings.Index(source, `router.Route("/api/internal/ops"`)
	noStore := strings.Index(source, "r.Use(opsNoStoreHeaders)")
	rateLimit := strings.Index(source, "r.Use(rateLimit.Middleware)")
	operator := strings.Index(source, "r.Use(ops.RequirePlatformOperator")
	csrf := strings.Index(source, "r.Use(ops.RequireWriteCSRF)")
	viewsRoute := strings.Index(source, `r.Route("/views"`)
	if outer < 0 || noStore <= outer || rateLimit <= noStore || operator <= rateLimit ||
		csrf <= operator || viewsRoute <= csrf {
		t.Fatalf("ops middleware order is unsafe: outer=%d noStore=%d rate=%d operator=%d csrf=%d views=%d",
			outer, noStore, rateLimit, operator, csrf, viewsRoute)
	}
	for _, mount := range []string{
		`r.Get("/campaign-assurance/runs", views.CampaignAssuranceRunsHandler(reader))`,
		`r.Get("/campaign-assurance/runs/{id}", views.CampaignAssuranceRunDetailHandler(reader))`,
		`r.Get("/campaign-assurance/runs/{id}/timeline", views.CampaignAssuranceRunTimelineHandler(reader))`,
	} {
		index := strings.Index(source, mount)
		if index <= viewsRoute {
			t.Errorf("Campaign Assurance ops mount is absent or outside privileged /views group: %s", mount)
		}
	}

	for _, path := range []string{
		"/api/internal/ops/views/campaign-assurance/runs",
		"/api/internal/ops/views/campaign-assurance/runs/71000000-0000-4000-8000-000000000001",
		"/api/internal/ops/views/campaign-assurance/runs/71000000-0000-4000-8000-000000000001/timeline",
	} {
		policy, ok := routeauth.PolicyFor("GET", path)
		if !ok || policy.Exposure != routeauth.ExposureInternal ||
			policy.ReviewStatus != "handler_boundary" {
			t.Errorf("routeauth policy GET %s = %+v found=%v", path, policy, ok)
		}
	}
}
