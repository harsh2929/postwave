// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
)

func TestReclassificationDeltaHeadlineAttributesMovementRatherThanStatingIt(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		report ReclassificationDeltaReport
		want   string
	}{
		{
			name:   "no supersession at all",
			report: ReclassificationDeltaReport{},
			want:   "any movement in human-engaged reach is audience movement",
		},
		{
			name: "re-examined and confirmed",
			report: ReclassificationDeltaReport{
				SupersededEvents: 40000, ChangedEvents: 0, ReachFloorDelta: 0,
			},
			want: "human-engaged reach floor unmoved by the classifier",
		},
		{
			name: "the classifier moved it down",
			report: ReclassificationDeltaReport{
				SupersededEvents: 900, ChangedEvents: 120, ReachFloorDelta: -37,
			},
			want: "moved -37 recipients because of the classifier, not the audience",
		},
		{
			name: "the classifier moved it up",
			report: ReclassificationDeltaReport{
				SupersededEvents: 900, ChangedEvents: 120, ReachFloorDelta: 8,
			},
			want: "moved +8 recipients because of the classifier, not the audience",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			headline := test.report.Headline()
			if !strings.Contains(headline, test.want) {
				t.Fatalf("headline = %q, want it to contain %q", headline, test.want)
			}
			// The delta must never be renderable as a bare engagement claim.
			for _, forbidden := range []string{"read the message", "opened by a human", "verified human"} {
				if strings.Contains(strings.ToLower(headline), forbidden) {
					t.Fatalf("headline overclaims: %q", headline)
				}
			}
		})
	}
}

func TestClassificationBucketDeltaCountsOnlyRealMovement(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		from, to, bucket string
		want             int64
	}{
		{from: "unknown", to: "human", bucket: "human", want: 1},
		{from: "human", to: "unknown", bucket: "human", want: -1},
		{from: "human", to: "human", bucket: "human", want: 0},
		{from: "unknown", to: "machine", bucket: "human", want: 0},
		{from: "unknown", to: "machine", bucket: "machine", want: 1},
		{from: "unknown", to: "machine", bucket: "unknown", want: -1},
		{from: "machine", to: "machine", bucket: "unknown", want: 0},
	} {
		got := classificationBucketDelta(
			ClassificationTransition{From: test.from, To: test.to}, test.bucket,
		)
		if got != test.want {
			t.Fatalf("%s→%s for %q = %d, want %d", test.from, test.to, test.bucket, got, test.want)
		}
	}
}

// Map iteration order is random. Two delta reports over identical data must
// serialise identically or an operator diffing two downloads sees noise.
func TestSortedClassificationTransitionsIsStableAndPutsRealChangesFirst(t *testing.T) {
	t.Parallel()
	counts := map[ClassificationTransition]int64{
		{From: "machine", To: "machine", FromMachineSubtype: "gmail_proxy", ToMachineSubtype: "gmail_proxy"}: 5,
		{From: "unknown", To: "machine", ToMachineSubtype: "prefetcher", Changed: true}:                      9,
		{From: "unknown", To: "human", Changed: true}:                                                        2,
	}
	first := sortedClassificationTransitions(counts)
	second := sortedClassificationTransitions(counts)
	if len(first) != 3 {
		t.Fatalf("transitions = %d, want 3", len(first))
	}
	for index := range first {
		if first[index] != second[index] {
			t.Fatalf("ordering is not stable at %d: %+v vs %+v", index, first[index], second[index])
		}
	}
	if !first[0].Changed || !first[1].Changed || first[2].Changed {
		t.Fatalf("changed transitions must sort before restatements: %+v", first)
	}
	// Guard the guard: the counts must actually be carried across.
	total := int64(0)
	for _, item := range first {
		total += item.Events
	}
	if total != 16 {
		t.Fatalf("events carried into the sorted slice = %d, want 16", total)
	}
}

func TestHumanEngagedReachDeltaResponseCarriesAttributionAndNeverANakedNumber(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	since := now.Add(-48 * time.Hour)
	store := &fakeReportReader{delta: &ReclassificationDeltaReport{
		TenantID: testTenantID, CampaignID: testCampaignID,
		WindowStart: since, WindowEnd: now, GeneratedAt: now,
		EligibleEvents: 40, ClassifiedEvents: 40,
		SupersededEvents: 24, ChangedEvents: 16, RestatedEvents: 8,
		MaxSupersessionDepth:          2,
		UnlinkedMultipleVerdictEvents: 3,
		Transitions: []ClassificationTransition{{
			From: "unknown", To: "machine", ToMachineSubtype: "prefetcher",
			FromMethodologyVersion: "method-v2",
			ToMethodologyVersion:   "method-v2.stage2-delayed",
			Changed:                true, Events: 16,
		}},
		HumanEventDelta: 0, MachineEventDelta: 16, UnknownEventDelta: -16,
		RecipientsConsidered: 10,
		ReachFloorBefore:     4, ReachFloorAfter: 3, ReachFloorDelta: -1,
		UnknownBandBefore: 5, UnknownBandAfter: 2, UnknownBandDelta: -3,
		MachineOnlyBefore: 1, MachineOnlyAfter: 5, MachineOnlyDelta: 4,
		Methodology: reclassificationDeltaMethodology,
	}}
	router := chi.NewRouter()
	releasedHandlerDeps(store, func() time.Time { return now }).MountRoutes(router)

	rec := serveEngagementReport(router,
		"/api/v1/analytics/human-engaged-reach/delta?campaign_id="+testCampaignID,
		testTenantID, apikeys.ScopeReadReports)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
	if store.deltaCalls != 1 {
		t.Fatalf("delta store calls = %d, want 1", store.deltaCalls)
	}
	if store.deltaQuery.TenantID != testTenantID || store.deltaQuery.CampaignID != testCampaignID {
		t.Fatalf("delta query scope = %+v", store.deltaQuery)
	}
	// The tenant scope must come from authentication, never the query string.
	if store.deltaQuery.Until != now || store.deltaQuery.Since != now.Add(-defaultReportWindow) {
		t.Fatalf("delta query window = %v..%v", store.deltaQuery.Since, store.deltaQuery.Until)
	}

	var body HumanEngagedReachDeltaResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode delta response: %v", err)
	}
	if body.HumanEngagedReachFloorBefore != 4 || body.HumanEngagedReachFloorAfter != 3 ||
		body.HumanEngagedReachFloorDelta != -1 {
		t.Fatalf("reach floor attribution = %+v", body)
	}
	if body.SupersededEvents != 24 || body.ChangedEvents != 16 || body.RestatedEvents != 8 {
		t.Fatalf("supersession counters = %+v", body)
	}
	if body.UnlinkedMultipleVerdictEvents != 3 {
		t.Fatalf("unlinked verdict events = %d, want 3", body.UnlinkedMultipleVerdictEvents)
	}
	if len(body.Transitions) != 1 || body.Transitions[0].Events != 16 ||
		body.Transitions[0].ToMachineSubtype != "prefetcher" ||
		body.Transitions[0].FromMethodologyVersion == body.Transitions[0].ToMethodologyVersion {
		t.Fatalf("transition detail = %+v", body.Transitions)
	}
	// A delta without its derivation is an unfalsifiable claim about somebody
	// else's numbers, so the methodology is part of the payload.
	if !strings.Contains(body.Methodology, "supersedes_id") ||
		!strings.Contains(body.Methodology, "audience") {
		t.Fatalf("methodology does not state the attribution rule: %q", body.Methodology)
	}
	if !strings.Contains(body.Headline, "because of the classifier, not the audience") {
		t.Fatalf("headline = %q", body.Headline)
	}
	// Never render a floor without the unknown band that qualifies it.
	raw := rec.Body.String()
	for _, required := range []string{
		`"unknown_band_before":5`, `"unknown_band_after":2`,
		`"recipients_considered":10`, `"classifier_version":"classifier-v2"`,
	} {
		if !strings.Contains(raw, required) {
			t.Fatalf("delta response missing %s: %s", required, raw)
		}
	}
}

func TestHumanEngagedReachDeltaRejectsInvalidWindowBeforeReachingTheStore(t *testing.T) {
	t.Parallel()
	store := &fakeReportReader{}
	router := chi.NewRouter()
	(&HandlerDeps{Store: store}).MountRoutes(router)
	rec := serveEngagementReport(router,
		"/api/v1/analytics/human-engaged-reach/delta?since=2026-08-13T12%3A00%3A00Z&until=2026-08-12T12%3A00%3A00Z",
		testTenantID, apikeys.ScopeReadReports)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_window") {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
	if store.deltaCalls != 0 {
		t.Fatalf("invalid delta query reached the store %d times", store.deltaCalls)
	}
}

func TestHumanEngagedReachDeltaSanitizesRepositoryErrors(t *testing.T) {
	t.Parallel()
	store := &fakeReportReader{err: ErrCampaignNotFound}
	router := chi.NewRouter()
	releasedHandlerDeps(store, nil).MountRoutes(router)
	rec := serveEngagementReport(router, "/api/v1/analytics/human-engaged-reach/delta",
		testTenantID, apikeys.ScopeReadReports)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "campaign_not_found") {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
}
