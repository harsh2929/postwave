// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	testTenantID   = "00000000-0000-4000-8000-000000000101"
	testCampaignID = "00000000-0000-4000-8000-000000000202"
)

type fakeReportReader struct {
	summary      *ClassificationSummary
	reach        *ReachReport
	delta        *ReclassificationDeltaReport
	err          error
	summaryQuery SummaryQuery
	reachQuery   ReachQuery
	deltaQuery   ReclassificationDeltaQuery
	summaryCalls int
	reachCalls   int
	deltaCalls   int
}

type fakePoweredLiftReader struct {
	lift  *PoweredIncrementalLift
	err   error
	query PoweredIncrementalLiftQuery
	calls int
}

type fakeReachReleaseGate struct {
	status ReachReleaseStatus
	err    error
	calls  int
}

func (f *fakeReachReleaseGate) HumanEngagedReachRelease(context.Context) (ReachReleaseStatus, error) {
	f.calls++
	return f.status, f.err
}

func releasedHandlerDeps(store *fakeReportReader, now func() time.Time) *HandlerDeps {
	defaultCoverage := ClassifierVersionCoverage{
		ClassifierVersion: "classifier-v2", MethodologyVersion: "method-v2",
		RegistryVersion: "registry-v2", ConfigurationHash: strings.Repeat("b", 64),
		EventCount: 1,
	}
	coverage := []ClassifierVersionCoverage{defaultCoverage}
	if store != nil && store.reach != nil {
		if len(store.reach.ClassifierVersionCoverage) == 0 {
			store.reach.ClassifierVersionCoverage = append([]ClassifierVersionCoverage(nil), defaultCoverage)
		}
		for index := range store.reach.ClassifierVersionCoverage {
			store.reach.ClassifierVersionCoverage[index].ShadowMode = false
		}
		store.reach.ShadowMode = false
		coverage = store.reach.ClassifierVersionCoverage
	}
	if store != nil && store.delta != nil {
		if len(store.delta.ClassifierVersionCoverage) == 0 {
			store.delta.ClassifierVersionCoverage = append([]ClassifierVersionCoverage(nil), defaultCoverage)
		}
		for index := range store.delta.ClassifierVersionCoverage {
			store.delta.ClassifierVersionCoverage[index].ShadowMode = false
		}
		coverage = append(coverage, store.delta.ClassifierVersionCoverage...)
	}
	approvals := make([]ReachClassifierApproval, 0, len(coverage))
	seen := map[reachClassifierIdentity]bool{}
	for _, item := range coverage {
		if item.Unclassified {
			continue
		}
		identity := reachClassifierIdentity{
			classifierVersion: item.ClassifierVersion, methodologyVersion: item.MethodologyVersion,
			registryVersion: item.RegistryVersion, configurationHash: item.ConfigurationHash,
		}
		if !identity.valid() || seen[identity] {
			continue
		}
		seen[identity] = true
		approvals = append(approvals, ReachClassifierApproval{
			ApprovalID: "00000000-0000-4000-8000-000000000401", CalibrationReportID: "00000000-0000-4000-8000-000000000402",
			ClassifierVersion: item.ClassifierVersion, MethodologyVersion: item.MethodologyVersion,
			RegistryVersion: item.RegistryVersion, ConfigurationHash: item.ConfigurationHash,
			ApprovedAt: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
		})
	}
	return &HandlerDeps{
		Store:        store,
		ReachRelease: &fakeReachReleaseGate{status: ReachReleaseStatus{Approved: approvals}},
		Now:          now,
	}
}

func (f *fakePoweredLiftReader) PoweredIncrementalLiftFor(
	_ context.Context,
	query PoweredIncrementalLiftQuery,
) (*PoweredIncrementalLift, error) {
	f.calls++
	f.query = query
	return f.lift, f.err
}

func (f *fakeReportReader) ClassificationSummaryFor(_ context.Context, query SummaryQuery) (*ClassificationSummary, error) {
	f.summaryCalls++
	f.summaryQuery = query
	return f.summary, f.err
}

func (f *fakeReportReader) HumanEngagedReachFor(_ context.Context, query ReachQuery) (*ReachReport, error) {
	f.reachCalls++
	f.reachQuery = query
	return f.reach, f.err
}

func (f *fakeReportReader) ReclassificationDeltaFor(
	_ context.Context,
	query ReclassificationDeltaQuery,
) (*ReclassificationDeltaReport, error) {
	f.deltaCalls++
	f.deltaQuery = query
	return f.delta, f.err
}

func TestEngagementReportingRoutesRequireReadReportsAndTenant(t *testing.T) {
	store := &fakeReportReader{}
	router := chi.NewRouter()
	(&HandlerDeps{Store: store}).MountRoutes(router)
	paths := []string{
		"/api/v1/analytics/engagement-classification/summary",
		"/api/v1/analytics/human-engaged-reach",
		"/api/v1/analytics/human-engaged-reach/export",
		"/api/v1/analytics/human-engaged-reach/delta",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			rec := serveEngagementReport(router, path, "", apikeys.ScopeReadCampaigns)
			if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "insufficient_scope") {
				t.Fatalf("unrelated scope: status=%d body=%q", rec.Code, rec.Body.String())
			}

			rec = serveEngagementReport(router, path, "", apikeys.ScopeReadReports)
			if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "no_tenant") {
				t.Fatalf("read:reports without tenant: status=%d body=%q", rec.Code, rec.Body.String())
			}
		})
	}
	if store.summaryCalls != 0 || store.reachCalls != 0 || store.deltaCalls != 0 {
		t.Fatalf("unauthorized requests reached store: summary=%d reach=%d delta=%d",
			store.summaryCalls, store.reachCalls, store.deltaCalls)
	}
}

func TestHumanEngagedReachRoutesFailClosedWithoutDurableReleaseEvidence(t *testing.T) {
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	since := now.Add(-24 * time.Hour)
	store := &fakeReportReader{}
	router := chi.NewRouter()
	(&HandlerDeps{Store: store, Now: func() time.Time { return now }}).MountRoutes(router)
	window := "?campaign_id=" + testCampaignID +
		"&since=" + since.Format(time.RFC3339) + "&until=" + now.Format(time.RFC3339)
	for _, path := range []string{
		"/api/v1/analytics/human-engaged-reach" + window,
		"/api/v1/analytics/human-engaged-reach/export" + window,
		"/api/v1/analytics/human-engaged-reach/delta" + window,
		"/api/v1/analytics/human-engaged-reach/delta/export" + window,
	} {
		t.Run(path, func(t *testing.T) {
			rec := serveEngagementReport(router, path, testTenantID, apikeys.ScopeReadReports)
			if rec.Code != http.StatusConflict ||
				!strings.Contains(rec.Body.String(), `"code":"`+ReachUnavailableCode+`"`) ||
				!strings.Contains(rec.Body.String(), "passing dual-corpus calibration") {
				t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
			}
			if rec.Header().Get("Cache-Control") != "private, no-store" {
				t.Fatalf("release denial cache policy=%q", rec.Header().Get("Cache-Control"))
			}
		})
	}
	if store.reachCalls != 0 || store.deltaCalls != 0 {
		t.Fatalf("unreleased routes reached report storage: reach=%d delta=%d", store.reachCalls, store.deltaCalls)
	}
}

func TestHumanEngagedReachRejectsShadowCoverageAfterApproval(t *testing.T) {
	coverage := ClassifierVersionCoverage{
		ClassifierVersion: "classifier-v2", MethodologyVersion: "method-v2",
		RegistryVersion: "registry-v2", ConfigurationHash: strings.Repeat("b", 64),
		ShadowMode: true, EventCount: 1,
	}
	store := &fakeReportReader{reach: &ReachReport{
		MachineBySubtype: map[string]int64{}, Methodology: reachMethodology,
		ShadowMode: true, ClassifierVersionCoverage: []ClassifierVersionCoverage{coverage},
	}}
	gate := &fakeReachReleaseGate{status: ReachReleaseStatus{Approved: []ReachClassifierApproval{{
		ApprovalID: "00000000-0000-4000-8000-000000000401", CalibrationReportID: "00000000-0000-4000-8000-000000000402",
		ClassifierVersion: coverage.ClassifierVersion, MethodologyVersion: coverage.MethodologyVersion,
		RegistryVersion: coverage.RegistryVersion, ConfigurationHash: coverage.ConfigurationHash,
		ApprovedAt: time.Now().UTC(),
	}}}}
	router := chi.NewRouter()
	(&HandlerDeps{Store: store, ReachRelease: gate}).MountRoutes(router)
	rec := serveEngagementReport(router, "/api/v1/analytics/human-engaged-reach", testTenantID, apikeys.ScopeReadReports)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), ReachUnavailableCode) {
		t.Fatalf("shadow report status=%d body=%q", rec.Code, rec.Body.String())
	}
	if gate.calls != 1 || store.reachCalls != 1 {
		t.Fatalf("gate/store calls=%d/%d, want 1/1", gate.calls, store.reachCalls)
	}
}

func TestHumanEngagedReachEvidenceExportIsDeterministicAndVerifiable(t *testing.T) {
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	since := now.Add(-48 * time.Hour)
	store := &fakeReportReader{reach: &ReachReport{
		TenantID: testTenantID, CampaignID: testCampaignID,
		WindowStart: since, WindowEnd: now, GeneratedAt: now,
		Delivered: 20, HumanEngagedReachFloor: 7, UnknownBand: 3,
		MachineOnly: 4, NoInteraction: 6,
		MachineBySubtype: map[string]int64{"security_scanner": 1, "gmail_proxy": 3},
		ClassifierVersionCoverage: []ClassifierVersionCoverage{
			{ClassifierVersion: "classifier-v1", MethodologyVersion: "method-v1", RegistryVersion: "registry-v1", ConfigurationHash: strings.Repeat("a", 64), EventCount: 1},
			{ClassifierVersion: "classifier-v2", MethodologyVersion: "method-v2", RegistryVersion: "registry-v2", ConfigurationHash: strings.Repeat("b", 64), ShadowMode: true, EventCount: 13},
		},
		MixedClassifierVersions: true, ShadowMode: true,
		Methodology: reachMethodology,
	}}
	router := chi.NewRouter()
	releasedHandlerDeps(store, func() time.Time { return now }).MountRoutes(router)
	path := "/api/v1/analytics/human-engaged-reach/export?campaign_id=" + testCampaignID +
		"&since=" + since.Format(time.RFC3339) + "&until=" + now.Format(time.RFC3339)

	first := serveEngagementReport(router, path, testTenantID, apikeys.ScopeReadReports)
	second := serveEngagementReport(router, path, testTenantID, apikeys.ScopeReadReports)
	compressedRouter := chi.NewRouter()
	compressedRouter.Use(middleware.Compress())
	releasedHandlerDeps(store, func() time.Time { return now }).MountRoutes(compressedRouter)
	compressed := serveEngagementReportWithAcceptEncoding(
		compressedRouter, path, testTenantID, "gzip, br", apikeys.ScopeReadReports,
	)
	if first.Code != http.StatusOK {
		t.Fatalf("status=%d body=%q", first.Code, first.Body.String())
	}
	if first.Body.String() != second.Body.String() {
		t.Fatalf("same fixed evidence query produced different artifacts:\nfirst=%s\nsecond=%s",
			first.Body.String(), second.Body.String())
	}
	if compressed.Code != http.StatusOK || compressed.Header().Get("Content-Encoding") != "" ||
		compressed.Body.String() != first.Body.String() ||
		compressed.Header().Get("Content-Digest") != first.Header().Get("Content-Digest") {
		t.Fatalf("transport compression changed evidence bytes/digest: status=%d headers=%v body=%q",
			compressed.Code, compressed.Header(), compressed.Body.String())
	}
	if store.reachCalls != 3 || store.reachQuery.TenantID != testTenantID ||
		store.reachQuery.CampaignID != testCampaignID ||
		!store.reachQuery.Since.Equal(since) || !store.reachQuery.Until.Equal(now) {
		t.Fatalf("export lost authenticated/fixed scope: calls=%d query=%+v", store.reachCalls, store.reachQuery)
	}

	var artifact HumanEngagedReachEvidenceArtifact
	if err := json.Unmarshal(first.Body.Bytes(), &artifact); err != nil {
		t.Fatalf("decode evidence artifact: %v", err)
	}
	if artifact.ArtifactSchemaVersion != reachEvidenceSchema ||
		artifact.ArtifactKind != "human_engaged_reach_evidence" ||
		!artifact.GeneratedAt.Equal(now) ||
		artifact.Integrity.Algorithm != "sha-256" ||
		artifact.Integrity.Scope != "evidence_payload" ||
		artifact.Integrity.Canonicalization != reachEvidenceCanonicalization ||
		artifact.Integrity.Authenticity != "not_signed" {
		t.Fatalf("artifact identity/integrity contract=%+v", artifact)
	}
	payloadJSON, err := json.Marshal(artifact.EvidencePayload)
	if err != nil {
		t.Fatalf("marshal evidence payload: %v", err)
	}
	payloadDigest := sha256.Sum256(payloadJSON)
	wantPayloadDigest := fmt.Sprintf("%x", payloadDigest)
	const goldenPayloadDigest = "90f464199fd21138ada2f3b45accb838c052a77133ff5ac80d3825f4f96434d3"
	if wantPayloadDigest != goldenPayloadDigest {
		t.Fatalf("fixed-schema evidence serialization drifted: got=%s want=%s",
			wantPayloadDigest, goldenPayloadDigest)
	}
	if artifact.Integrity.DigestSHA256 != wantPayloadDigest ||
		artifact.ArtifactID != "sha256:"+wantPayloadDigest ||
		first.Header().Get("X-Postwave-Artifact-SHA256") != wantPayloadDigest {
		t.Fatalf("payload digest mismatch: artifact=%+v header=%q want=%q",
			artifact.Integrity, first.Header().Get("X-Postwave-Artifact-SHA256"), wantPayloadDigest)
	}
	laterBody, laterPayloadDigest, err := marshalReachEvidenceArtifact(
		testTenantID, testCampaignID, since, now, now.Add(time.Minute), store.reach, nil,
	)
	if err != nil {
		t.Fatalf("regenerate evidence at a later time: %v", err)
	}
	var laterArtifact HumanEngagedReachEvidenceArtifact
	if err := json.Unmarshal(laterBody, &laterArtifact); err != nil {
		t.Fatalf("decode later evidence artifact: %v", err)
	}
	if laterPayloadDigest != wantPayloadDigest || laterArtifact.ArtifactID != artifact.ArtifactID ||
		!laterArtifact.GeneratedAt.Equal(now.Add(time.Minute)) ||
		!reflect.DeepEqual(laterArtifact.EvidencePayload, artifact.EvidencePayload) {
		t.Fatalf("regeneration changed content-addressed evidence: first=%+v later=%+v",
			artifact, laterArtifact)
	}
	firstWithoutTime := artifact
	laterWithoutTime := laterArtifact
	firstWithoutTime.GeneratedAt = time.Time{}
	laterWithoutTime.GeneratedAt = time.Time{}
	firstNormalized, _ := json.Marshal(firstWithoutTime)
	laterNormalized, _ := json.Marshal(laterWithoutTime)
	if !bytes.Equal(firstNormalized, laterNormalized) || bytes.Equal(first.Body.Bytes(), laterBody) {
		t.Fatalf("regenerated artifacts must differ only by generated_at")
	}
	bodyDigest := sha256.Sum256(first.Body.Bytes())
	wantContentDigest := "sha-256=:" + base64.StdEncoding.EncodeToString(bodyDigest[:]) + ":"
	if first.Header().Get("Content-Digest") != wantContentDigest {
		t.Fatalf("content digest=%q want=%q", first.Header().Get("Content-Digest"), wantContentDigest)
	}
	if !strings.HasPrefix(first.Header().Get("Content-Disposition"), "attachment; filename=\"human-engaged-reach-"+testCampaignID) ||
		first.Header().Get("Cache-Control") != "private, no-store, no-transform" ||
		first.Header().Get("Content-Encoding") != "" ||
		first.Header().Get("Content-Type") != reachEvidenceMediaType+"; charset=utf-8" {
		t.Fatalf("download/cache headers=%v", first.Header())
	}

	report := artifact.EvidencePayload.Report
	if report.TenantID != testTenantID || report.CampaignID != testCampaignID ||
		report.ProviderAcceptedRecipients != 20 || report.HumanEngagedReachFloor != 7 ||
		report.UnknownBand != 3 || report.HumanEngagedReachUpperBound != 10 ||
		len(report.MachineBySubtype) != 2 || report.MachineBySubtype[0].Subtype != "gmail_proxy" ||
		len(report.ClassifierVersionCoverage) != 2 || report.ClassifierVersionCoverage[0].Unclassified {
		t.Fatalf("evidence report was not normalized: %+v", report)
	}
	semantics := artifact.EvidencePayload.EvidenceSemantics
	if len(semantics.ObservedEvidence) == 0 || len(semantics.InferredEvidence) == 0 ||
		len(semantics.NotObserved) == 0 ||
		!strings.Contains(semantics.InferredEvidence[0], "predictions") ||
		!strings.Contains(semantics.AcceptanceBoundary, "not inbox placement") {
		t.Fatalf("observed/inferred claim boundary is incomplete: %+v", semantics)
	}
	lower := strings.ToLower(first.Body.String())
	payloadLower := strings.ToLower(string(payloadJSON))
	if strings.Contains(lower, "verified human") || strings.Contains(lower, "verified_human") ||
		strings.Contains(payloadLower, "generated_at") {
		t.Fatalf("artifact overclaims or puts generation time inside the evidence payload: %s", first.Body.String())
	}
}

func TestHumanEngagedReachEvidenceExportRequiresFixedCampaignScope(t *testing.T) {
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		raw  string
		code string
	}{
		{name: "campaign", raw: "since=2026-08-01T00%3A00%3A00Z&until=2026-08-13T12%3A00%3A00Z", code: "campaign_scope_required"},
		{name: "since", raw: "campaign_id=" + testCampaignID + "&until=2026-08-13T12%3A00%3A00Z", code: "fixed_window_required"},
		{name: "until", raw: "campaign_id=" + testCampaignID + "&since=2026-08-01T00%3A00%3A00Z", code: "fixed_window_required"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeReportReader{}
			router := chi.NewRouter()
			(&HandlerDeps{Store: store, Now: func() time.Time { return now }}).MountRoutes(router)
			rec := serveEngagementReport(router,
				"/api/v1/analytics/human-engaged-reach/export?"+test.raw,
				testTenantID, apikeys.ScopeReadReports)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("status=%d body=%q, want code %q", rec.Code, rec.Body.String(), test.code)
			}
			if store.reachCalls != 0 || store.summaryCalls != 0 {
				t.Fatalf("incomplete evidence scope reached store: %+v", store)
			}
		})
	}
}

func TestHumanEngagedReachIncludesOnlyFinalPoweredLiftEvidence(t *testing.T) {
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	since := now.Add(-7 * 24 * time.Hour)
	relative := 50.0
	lift := &PoweredIncrementalLift{
		EvidencePointer: IncrementalLiftEvidencePointer{
			ResultID:       "00000000-0000-4000-8000-000000000303",
			EvidenceSHA256: strings.Repeat("d", 64),
		},
		Powered: true, ResultVersion: "f02-lift-result-v1", Metric: "purchase",
		WindowStart: since, WindowEnd: now,
		NTreatment: 1000, NControl: 1000,
		ConversionsTreatment: 150, ConversionsControl: 100,
		RateTreatment: 0.15, RateControl: 0.10,
		AbsoluteLift: 0.05, RelativeLift: &relative, IncrementalConversions: 50,
		PValue: 0.001, CILow: 0.02, CIHigh: 0.08,
		MinimumDetectableEffect: 0.02, MethodologyVersion: "two-proportion-z-v1",
		MethodologyStatement: "Intent-to-treat two-proportion comparison over the frozen assignment set.",
		GeneratedAt:          now,
	}
	store := &fakeReportReader{reach: &ReachReport{
		WindowStart: since, WindowEnd: now, GeneratedAt: now,
		Delivered: 10, HumanEngagedReachFloor: 4, UnknownBand: 2,
		MachineOnly: 2, NoInteraction: 2,
		MachineBySubtype: map[string]int64{"security_scanner": 2},
		Methodology:      reachMethodology,
	}}
	lifts := &fakePoweredLiftReader{lift: lift}
	router := chi.NewRouter()
	deps := releasedHandlerDeps(store, func() time.Time { return now })
	deps.PoweredLift = lifts
	deps.MountRoutes(router)
	query := "?campaign_id=" + testCampaignID + "&since=" + since.Format(time.RFC3339) + "&until=" + now.Format(time.RFC3339)

	reachRec := serveEngagementReport(router,
		"/api/v1/analytics/human-engaged-reach"+query,
		testTenantID, apikeys.ScopeReadReports)
	if reachRec.Code != http.StatusOK {
		t.Fatalf("reach status=%d body=%q", reachRec.Code, reachRec.Body.String())
	}
	var reach HumanEngagedReachResponse
	if err := json.Unmarshal(reachRec.Body.Bytes(), &reach); err != nil {
		t.Fatal(err)
	}
	if reach.IncrementalLift == nil || !reach.IncrementalLift.Powered ||
		reach.IncrementalLift.EvidencePointer.ResultID != lift.EvidencePointer.ResultID {
		t.Fatalf("powered lift missing from reach response: %+v", reach.IncrementalLift)
	}

	exportRec := serveEngagementReport(router,
		"/api/v1/analytics/human-engaged-reach/export"+query,
		testTenantID, apikeys.ScopeReadReports)
	if exportRec.Code != http.StatusOK {
		t.Fatalf("export status=%d body=%q", exportRec.Code, exportRec.Body.String())
	}
	var artifact HumanEngagedReachEvidenceArtifact
	if err := json.Unmarshal(exportRec.Body.Bytes(), &artifact); err != nil {
		t.Fatal(err)
	}
	got := artifact.EvidencePayload.Report.IncrementalLift
	if got == nil || !got.Powered || got.EvidencePointer.EvidenceSHA256 != strings.Repeat("d", 64) ||
		!strings.Contains(artifact.EvidencePayload.EvidenceSemantics.ObservedEvidence[2], "immutable final powered F02") {
		t.Fatalf("powered lift evidence missing from artifact: %+v", artifact)
	}
	if lifts.calls != 2 || lifts.query.TenantID != testTenantID || lifts.query.CampaignID != testCampaignID ||
		!lifts.query.Since.Equal(since) || !lifts.query.Until.Equal(now) {
		t.Fatalf("lift reader lost fixed authenticated scope: calls=%d query=%+v", lifts.calls, lifts.query)
	}
}

func TestHumanEngagedReachRejectsUnpoweredLiftFromConfiguredReader(t *testing.T) {
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	since := now.Add(-24 * time.Hour)
	store := &fakeReportReader{reach: &ReachReport{
		WindowStart: since, WindowEnd: now, GeneratedAt: now,
		Delivered: 1, NoInteraction: 1,
		MachineBySubtype: map[string]int64{}, Methodology: reachMethodology,
	}}
	lifts := &fakePoweredLiftReader{lift: &PoweredIncrementalLift{
		EvidencePointer: IncrementalLiftEvidencePointer{
			ResultID:       "00000000-0000-4000-8000-000000000303",
			EvidenceSHA256: strings.Repeat("d", 64),
		},
		Powered: false, ResultVersion: "f02-lift-result-v1", Metric: "purchase",
		WindowStart: since, WindowEnd: now, NTreatment: 1, NControl: 1,
		MethodologyVersion: "two-proportion-z-v1", GeneratedAt: now,
	}}
	router := chi.NewRouter()
	deps := releasedHandlerDeps(store, func() time.Time { return now })
	deps.PoweredLift = lifts
	deps.MountRoutes(router)
	rec := serveEngagementReport(router,
		"/api/v1/analytics/human-engaged-reach?campaign_id="+testCampaignID+
			"&since="+since.Format(time.RFC3339)+"&until="+now.Format(time.RFC3339),
		testTenantID, apikeys.ScopeReadReports)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"internal_error"`) {
		t.Fatalf("unpowered result surfaced: status=%d body=%q", rec.Code, rec.Body.String())
	}
}

func TestPoweredIncrementalLiftEvidenceMustReconcile(t *testing.T) {
	until := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	since := until.Add(-7 * 24 * time.Hour)
	relative := 50.0
	valid := PoweredIncrementalLift{
		EvidencePointer: IncrementalLiftEvidencePointer{
			ResultID:       "00000000-0000-4000-8000-000000000303",
			EvidenceSHA256: strings.Repeat("d", 64),
		},
		Powered: true, ResultVersion: "f02-lift-result-v1", Metric: "purchase",
		WindowStart: since, WindowEnd: until,
		NTreatment: 1000, NControl: 1000,
		ConversionsTreatment: 150, ConversionsControl: 100,
		RateTreatment: 0.15, RateControl: 0.10,
		AbsoluteLift: 0.05, RelativeLift: &relative, IncrementalConversions: 50,
		PValue: 0.001, CILow: 0.02, CIHigh: 0.08,
		MinimumDetectableEffect: 0.02, MethodologyVersion: "two-proportion-z-v1",
		MethodologyStatement: "Intent-to-treat two-proportion comparison over the frozen assignment set.",
		GeneratedAt:          until,
	}
	query := PoweredIncrementalLiftQuery{Since: since, Until: until}
	if err := validatePoweredIncrementalLift(query, &valid); err != nil {
		t.Fatalf("valid powered result rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*PoweredIncrementalLift)
	}{
		{name: "nil result UUID", mutate: func(result *PoweredIncrementalLift) {
			result.EvidencePointer.ResultID = "00000000-0000-0000-0000-000000000000"
		}},
		{name: "rate does not match counts", mutate: func(result *PoweredIncrementalLift) {
			result.RateTreatment = 0.14
		}},
		{name: "absolute lift does not match rates", mutate: func(result *PoweredIncrementalLift) {
			result.AbsoluteLift = 0.04
		}},
		{name: "incremental conversions do not match lift", mutate: func(result *PoweredIncrementalLift) {
			result.IncrementalConversions = 49
		}},
		{name: "relative lift is a ratio instead of a percentage", mutate: func(result *PoweredIncrementalLift) {
			ratio := 0.5
			result.RelativeLift = &ratio
		}},
		{name: "relative lift missing with a control baseline", mutate: func(result *PoweredIncrementalLift) {
			result.RelativeLift = nil
		}},
		{name: "finalized before the measurement window closed", mutate: func(result *PoweredIncrementalLift) {
			result.GeneratedAt = result.WindowEnd.Add(-time.Nanosecond)
		}},
		{name: "padded provenance", mutate: func(result *PoweredIncrementalLift) {
			result.MethodologyVersion = " two-proportion-z-v1"
		}},
		{name: "missing methodology statement", mutate: func(result *PoweredIncrementalLift) {
			result.MethodologyStatement = ""
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := valid
			candidateRelative := *valid.RelativeLift
			candidate.RelativeLift = &candidateRelative
			test.mutate(&candidate)
			if err := validatePoweredIncrementalLift(query, &candidate); err == nil {
				t.Fatalf("inconsistent powered result was accepted: %+v", candidate)
			}
		})
	}
}

func TestPoweredIncrementalLiftAllowsUndefinedRelativeLiftAtZeroControlRate(t *testing.T) {
	until := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	since := until.Add(-7 * 24 * time.Hour)
	result := &PoweredIncrementalLift{
		EvidencePointer: IncrementalLiftEvidencePointer{
			ResultID:       "00000000-0000-4000-8000-000000000303",
			EvidenceSHA256: strings.Repeat("d", 64),
		},
		Powered: true, ResultVersion: "f02-lift-result-v1", Metric: "purchase",
		WindowStart: since, WindowEnd: until,
		NTreatment: 5000, NControl: 5000,
		ConversionsTreatment: 250, ConversionsControl: 0,
		RateTreatment: 0.05, RateControl: 0,
		AbsoluteLift: 0.05, IncrementalConversions: 250,
		PValue: 0.001, CILow: 0.04, CIHigh: 0.06,
		MinimumDetectableEffect: 0.01, MethodologyVersion: "two-proportion-z-v1",
		MethodologyStatement: "Intent-to-treat two-proportion comparison over the frozen assignment set.",
		GeneratedAt:          until,
	}
	if err := validatePoweredIncrementalLift(
		PoweredIncrementalLiftQuery{Since: since, Until: until}, result,
	); err != nil {
		t.Fatalf("zero-control powered result with undefined relative lift rejected: %v", err)
	}
}

func TestHumanEngagedReachEvidenceExportRejectsUnreconciledEvidence(t *testing.T) {
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	since := now.Add(-24 * time.Hour)
	store := &fakeReportReader{reach: &ReachReport{
		Delivered: 2, HumanEngagedReachFloor: 2, UnknownBand: 1,
		MachineBySubtype: map[string]int64{}, Methodology: reachMethodology,
	}}
	router := chi.NewRouter()
	releasedHandlerDeps(store, func() time.Time { return now }).MountRoutes(router)
	path := "/api/v1/analytics/human-engaged-reach/export?campaign_id=" + testCampaignID +
		"&since=" + since.Format(time.RFC3339) + "&until=" + now.Format(time.RFC3339)
	rec := serveEngagementReport(router, path, testTenantID, apikeys.ScopeReadReports)
	if rec.Code != http.StatusInternalServerError ||
		!strings.Contains(rec.Body.String(), `"code":"internal_error"`) {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Content-Digest") != "" ||
		rec.Header().Get("X-Postwave-Artifact-SHA256") != "" {
		t.Fatalf("invalid evidence received integrity headers: %v", rec.Header())
	}
}

func TestClassificationSummaryRouteIsTenantScopedAndCarriesMixedProvenance(t *testing.T) {
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	since := now.Add(-48 * time.Hour)
	store := &fakeReportReader{summary: &ClassificationSummary{
		Human: 3, Machine: 2, Unknown: 1, Total: 6,
		MachineBySubtype: map[string]int64{"apple_mpp": 2},
		ClassifierVersionCoverage: []ClassifierVersionCoverage{
			{ClassifierVersion: "classifier-v2", MethodologyVersion: "method-v2", RegistryVersion: "registry-v2", ConfigurationHash: strings.Repeat("a", 64), ShadowMode: true, EventCount: 5},
			{ShadowMode: true, EventCount: 1, Unclassified: true},
		},
		MixedClassifierVersions: true, ShadowMode: true,
		WindowStart: since, WindowEnd: now,
	}}
	router := chi.NewRouter()
	releasedHandlerDeps(store, func() time.Time { return now }).MountRoutes(router)
	path := "/api/v1/analytics/engagement-classification/summary?campaign_id=" + testCampaignID +
		"&since=" + since.Format(time.RFC3339) + "&until=" + now.Format(time.RFC3339)
	rec := serveEngagementReport(router, path, testTenantID, apikeys.ScopeReadReports)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
	if store.summaryQuery.TenantID != testTenantID || store.summaryQuery.CampaignID != testCampaignID ||
		!store.summaryQuery.Since.Equal(since) || !store.summaryQuery.Until.Equal(now) {
		t.Fatalf("store query lost authenticated scope/window: %+v", store.summaryQuery)
	}

	var response ClassificationSummaryResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.TenantID != testTenantID || response.CampaignID != testCampaignID ||
		response.Human != 3 || response.Machine != 2 || response.Unknown != 1 || response.Total != 6 {
		t.Fatalf("summary response=%+v", response)
	}
	if !response.MixedClassifierVersions || len(response.ClassifierVersionCoverage) != 2 ||
		response.ClassifierVersion != "" || response.ConfigurationHash != "" {
		t.Fatalf("mixed provenance was collapsed: %+v", response)
	}
	if response.Unit != "interaction_events" || !strings.Contains(response.Methodology, "unknown events are never allocated") {
		t.Fatalf("summary unit/methodology is ambiguous: %+v", response)
	}
	if strings.Contains(strings.ToLower(rec.Body.String()), "verified_human") {
		t.Fatalf("response uses overclaiming terminology: %s", rec.Body.String())
	}
}

func TestHumanEngagedReachRouteKeepsFloorAndUnknownBandTogether(t *testing.T) {
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	since := now.Add(-30 * 24 * time.Hour)
	store := &fakeReportReader{reach: &ReachReport{
		TenantID: testTenantID, CampaignID: testCampaignID,
		WindowStart: since, WindowEnd: now, GeneratedAt: now,
		Delivered: 20, HumanEngagedReachFloor: 7, UnknownBand: 3,
		MachineOnly: 4, NoInteraction: 6,
		MachineBySubtype: map[string]int64{"gmail_proxy": 4},
		ClassifierVersionCoverage: []ClassifierVersionCoverage{
			{ClassifierVersion: "classifier-v2", MethodologyVersion: "method-v2", RegistryVersion: "registry-v2", ConfigurationHash: strings.Repeat("b", 64), ShadowMode: true, EventCount: 14},
		},
		ClassifierVersion: "classifier-v2", MethodologyVersion: "method-v2",
		RegistryVersion: "registry-v2", ConfigurationHash: strings.Repeat("b", 64),
		ShadowMode: true, Methodology: reachMethodology,
	}}
	router := chi.NewRouter()
	releasedHandlerDeps(store, func() time.Time { return now }).MountRoutes(router)
	rec := serveEngagementReport(router,
		"/api/v1/analytics/human-engaged-reach?campaign_id="+testCampaignID,
		testTenantID, apikeys.ScopeReadReports)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
	if store.reachQuery.TenantID != testTenantID || store.reachQuery.CampaignID != testCampaignID ||
		!store.reachQuery.Since.Equal(since) || !store.reachQuery.Until.Equal(now) ||
		store.reachQuery.Now == nil || !store.reachQuery.Now().Equal(now) {
		t.Fatalf("store query lost authenticated/default scope: %+v", store.reachQuery)
	}

	var response HumanEngagedReachResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.ProviderAcceptedRecipients != 20 || response.HumanEngagedReachFloor != 7 ||
		response.UnknownBand != 3 || response.HumanEngagedReachUpperBound != 10 ||
		response.MachineOnlyRecipients != 4 || response.NoInteractionRecipients != 6 {
		t.Fatalf("reach populations=%+v", response)
	}
	if !strings.Contains(response.Headline, "human-engaged reach floor: 7") ||
		!strings.Contains(response.Headline, "3 additional unclassified") {
		t.Fatalf("headline dropped floor or unknown band: %q", response.Headline)
	}
	for _, required := range []string{
		`"provider_accepted_recipients":20`,
		`"human_engaged_reach_floor":7`,
		`"unknown_band":3`,
		`"human_engaged_reach_upper_bound":10`,
		`"classifier_version_coverage"`,
	} {
		if !strings.Contains(rec.Body.String(), required) {
			t.Fatalf("response dropped %q: %s", required, rec.Body.String())
		}
	}
	if strings.Contains(strings.ReplaceAll(strings.ToLower(rec.Body.String()), "_", " "), "verified human reach") {
		t.Fatalf("response uses overclaiming terminology: %s", rec.Body.String())
	}
}

func TestEngagementReportQueryValidationFailsBeforeStoreAccess(t *testing.T) {
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		raw  string
		code string
	}{
		{name: "unknown", raw: "tenant_id=" + testTenantID, code: "unknown_query_parameter"},
		{name: "duplicate", raw: "since=2026-08-01T00%3A00%3A00Z&since=2026-08-02T00%3A00%3A00Z", code: "duplicate_query_parameter"},
		{name: "bad campaign", raw: "campaign_id=not-a-uuid", code: "invalid_campaign_id"},
		{name: "nil campaign", raw: "campaign_id=00000000-0000-0000-0000-000000000000", code: "invalid_campaign_id"},
		{name: "bad since", raw: "since=yesterday", code: "invalid_since"},
		{name: "bad until", raw: "until=tomorrow", code: "invalid_until"},
		{name: "inverted", raw: "since=2026-08-13T12%3A00%3A00Z&until=2026-08-12T12%3A00%3A00Z", code: "invalid_window"},
		{name: "too large", raw: "since=2025-08-12T11%3A59%3A59Z&until=2026-08-13T12%3A00%3A00Z", code: "window_too_large"},
		{name: "malformed query", raw: "since=2026-08-01T00%3A00%3A00Z;until=bad", code: "invalid_query"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeReportReader{}
			router := chi.NewRouter()
			(&HandlerDeps{Store: store, Now: func() time.Time { return now }}).MountRoutes(router)
			rec := serveEngagementReport(router,
				"/api/v1/analytics/human-engaged-reach?"+test.raw,
				testTenantID, apikeys.ScopeReadReports)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("status=%d body=%q, want code %q", rec.Code, rec.Body.String(), test.code)
			}
			if store.reachCalls != 0 || store.summaryCalls != 0 {
				t.Fatalf("invalid query reached store: %+v", store)
			}
		})
	}
}

func TestEngagementReportReadErrorsAreSanitized(t *testing.T) {
	for _, test := range []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{name: "campaign scope", err: ErrCampaignNotFound, wantStatus: http.StatusNotFound, wantCode: "campaign_not_found"},
		{name: "repository validation", err: ErrInvalidInput, wantStatus: http.StatusBadRequest, wantCode: "invalid_report_query"},
		{name: "database detail", err: errors.New("postgres password=canary relation=secret"), wantStatus: http.StatusInternalServerError, wantCode: "internal_error"},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeReportReader{err: test.err}
			router := chi.NewRouter()
			releasedHandlerDeps(store, nil).MountRoutes(router)
			rec := serveEngagementReport(router, "/api/v1/analytics/human-engaged-reach", testTenantID, apikeys.ScopeReadReports)
			if rec.Code != test.wantStatus || !strings.Contains(rec.Body.String(), `"code":"`+test.wantCode+`"`) {
				t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "password") || strings.Contains(rec.Body.String(), "secret") {
				t.Fatalf("internal detail leaked: %q", rec.Body.String())
			}
		})
	}
}

func serveEngagementReport(router http.Handler, path, tenantID string, scopes ...apikeys.Scope) *httptest.ResponseRecorder {
	return serveEngagementReportWithAcceptEncoding(router, path, tenantID, "", scopes...)
}

func serveEngagementReportWithAcceptEncoding(
	router http.Handler,
	path string,
	tenantID string,
	acceptEncoding string,
	scopes ...apikeys.Scope,
) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if acceptEncoding != "" {
		req.Header.Set("Accept-Encoding", acceptEncoding)
	}
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	if tenantID != "" {
		ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))
	return rec
}
