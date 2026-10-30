// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
)

// This is the HTTP-to-RLS contract, not another repository-only test. It
// proves the mounted handler passes the authenticated tenant into both reads,
// returns mixed-version provenance intact, and cannot read the same campaign
// through a different tenant context.
func TestEngagementReportingHTTPContract_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
			fixture.TenantID, fixture.ForeignTenantID)
	})

	repo := &Repo{Pool: app}
	configV2 := DefaultConfig()
	configV3 := DefaultConfig()
	configV3.MethodologyVersion = "postwave.engagement-methodology.http-contract.v3"
	configV3.HumanLatencyWeight = 0.14
	for index, classifier := range []*Classifier{
		mustClassifier(t, configV2),
		mustClassifier(t, configV3),
	} {
		if _, err := repo.Record(ctx, fixture.TenantID,
			classifierDBObservation(fixture, index), MessageAggregate{}, classifier); err != nil {
			t.Fatalf("record classifier version %d: %v", index, err)
		}
	}
	if _, err := admin.Exec(ctx, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, campaign_id, source,
    provider_event_id, source_event_id, message_id, metadata, at
)
SELECT tenant_id, subscriber_email, 'delivered', campaign_id,
       'f12-http-contract', 'delivery-' || id::text,
       'delivery-' || id::text, message_id, '{}'::jsonb,
       at - interval '250 milliseconds'
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND event_type = 'opened'`, fixture.TenantID, fixture.CampaignID); err != nil {
		t.Fatalf("seed provider-accepted deliveries: %v", err)
	}

	router := chi.NewRouter()
	now := fixture.At.Add(time.Minute)
	(&HandlerDeps{Store: repo, ReachRelease: repo, Now: func() time.Time { return now }}).MountRoutes(router)
	window := "?campaign_id=" + fixture.CampaignID +
		"&since=" + fixture.At.Add(-time.Minute).Format(time.RFC3339) +
		"&until=" + now.Format(time.RFC3339)

	summaryRec := serveEngagementReport(router,
		"/api/v1/analytics/engagement-classification/summary"+window,
		fixture.TenantID, apikeys.ScopeReadReports)
	if summaryRec.Code != http.StatusOK {
		t.Fatalf("summary status=%d body=%q", summaryRec.Code, summaryRec.Body.String())
	}
	var summary ClassificationSummaryResponse
	if err := json.Unmarshal(summaryRec.Body.Bytes(), &summary); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	if summary.TenantID != fixture.TenantID || summary.CampaignID != fixture.CampaignID || summary.Total != 2 {
		t.Fatalf("summary scope/count=%+v", summary)
	}
	if !summary.MixedClassifierVersions || len(summary.ClassifierVersionCoverage) != 2 {
		t.Fatalf("HTTP summary hid mixed provenance: %+v", summary)
	}
	var covered int64
	for _, item := range summary.ClassifierVersionCoverage {
		covered += item.EventCount
	}
	if covered != summary.Total {
		t.Fatalf("summary provenance covers %d of %d events", covered, summary.Total)
	}

	reachRec := serveEngagementReport(router,
		"/api/v1/analytics/human-engaged-reach"+window,
		fixture.TenantID, apikeys.ScopeReadReports)
	if reachRec.Code != http.StatusConflict ||
		!strings.Contains(reachRec.Body.String(), `"code":"`+ReachUnavailableCode+`"`) {
		t.Fatalf("shadow reach status=%d body=%q", reachRec.Code, reachRec.Body.String())
	}

	exportRec := serveEngagementReport(router,
		"/api/v1/analytics/human-engaged-reach/export"+window,
		fixture.TenantID, apikeys.ScopeReadReports)
	if exportRec.Code != http.StatusConflict ||
		!strings.Contains(exportRec.Body.String(), `"code":"`+ReachUnavailableCode+`"`) {
		t.Fatalf("shadow evidence export status=%d body=%q", exportRec.Code, exportRec.Body.String())
	}
	if exportRec.Header().Get("Content-Digest") != "" ||
		exportRec.Header().Get("X-Postwave-Artifact-SHA256") != "" {
		t.Fatalf("unreleased export received integrity headers: %v", exportRec.Header())
	}

	foreignRec := serveEngagementReport(router,
		"/api/v1/analytics/engagement-classification/summary"+window,
		fixture.ForeignTenantID, apikeys.ScopeReadReports)
	if foreignRec.Code != http.StatusOK {
		t.Fatalf("foreign summary status=%d body=%q", foreignRec.Code, foreignRec.Body.String())
	}
	var foreign ClassificationSummaryResponse
	if err := json.Unmarshal(foreignRec.Body.Bytes(), &foreign); err != nil {
		t.Fatalf("decode foreign summary: %v", err)
	}
	if foreign.TenantID != fixture.ForeignTenantID || foreign.Total != 0 ||
		len(foreign.ClassifierVersionCoverage) != 0 {
		t.Fatalf("cross-tenant classification data leaked: %+v", foreign)
	}

	foreignExportRec := serveEngagementReport(router,
		"/api/v1/analytics/human-engaged-reach/export"+window,
		fixture.ForeignTenantID, apikeys.ScopeReadReports)
	if foreignExportRec.Code != http.StatusConflict ||
		!strings.Contains(foreignExportRec.Body.String(), `"code":"`+ReachUnavailableCode+`"`) {
		t.Fatalf("foreign evidence export status=%d body=%q, want the same release hold",
			foreignExportRec.Code, foreignExportRec.Body.String())
	}
	if foreignExportRec.Header().Get("Content-Digest") != "" ||
		foreignExportRec.Header().Get("X-Postwave-Artifact-SHA256") != "" {
		t.Fatalf("foreign campaign received evidence integrity headers: %v", foreignExportRec.Header())
	}
}
