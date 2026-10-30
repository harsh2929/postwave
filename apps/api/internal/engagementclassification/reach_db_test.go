// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// The headline never states a human figure without its band.
//
// This is the PRD's §14 rule and the whole reason the feature exists: a single
// confident number that overstates is what the human-engaged reach floor replaces. Making
// the SENTENCE the unit of output is what stops a caller rendering the floor
// alone — there is no way to obtain the number without the qualifier attached.
func TestTheHeadlineAlwaysCarriesTheUnknownBand(t *testing.T) {
	withBand := ReachReport{HumanEngagedReachFloor: 12400, UnknownBand: 3100}
	got := withBand.Headline()
	if !strings.Contains(got, "12400") {
		t.Fatalf("headline %q omits the floor figure", got)
	}
	if !strings.Contains(got, "3100") {
		t.Fatalf("headline %q states a human figure with no unclassified band — "+
			"exactly the overstatement this feature replaces", got)
	}

	// With nothing unclassified there is no band to state, and inventing one
	// would be its own dishonesty.
	clean := ReachReport{HumanEngagedReachFloor: 500}
	if strings.Contains(clean.Headline(), "additional") {
		t.Errorf("headline %q invents a band over fully-classified data", clean.Headline())
	}
}

// The external contract calls this a floor, never verified human reach. The
// latter wording would promise more certainty than the classifier can prove.
func TestReachReportJSONAndHeadlineUseHumanEngagedReachFloorTerminology(t *testing.T) {
	report := ReachReport{HumanEngagedReachFloor: 42, UnknownBand: 7}

	raw, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal reach report: %v", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("decode reach report fields: %v", err)
	}
	if value, exists := fields["human_engaged_reach_floor"]; !exists {
		t.Fatalf("JSON %s omits human_engaged_reach_floor", raw)
	} else if string(value) != "42" {
		t.Fatalf("human_engaged_reach_floor = %s, want 42", value)
	}
	if _, exists := fields["verified_human_reach"]; exists {
		t.Fatalf("JSON %s exposes the overclaiming verified_human_reach field", raw)
	}

	headline := report.Headline()
	if !strings.HasPrefix(headline, "human-engaged reach floor: 42") {
		t.Fatalf("headline %q does not lead with human-engaged reach floor", headline)
	}
	for surface, value := range map[string]string{
		"JSON":     string(raw),
		"headline": headline,
	} {
		normalized := strings.ReplaceAll(strings.ToLower(value), "_", " ")
		if strings.Contains(normalized, "verified human reach") {
			t.Fatalf("%s %q uses the overclaiming verified human reach terminology", surface, value)
		}
	}
}

// The machine breakdown is ordered, so two reports over the same data match.
//
// "Two reports generated from the same data at the same classifier version are
// byte-identical apart from timestamp" is an acceptance criterion, and Go's
// randomised map iteration breaks it silently — the reports differ only in key
// order, which no reviewer notices until an auditor diffs two exports.
func TestTheMachineBreakdownIsDeterministicallyOrdered(t *testing.T) {
	report := ReachReport{MachineBySubtype: map[string]int64{
		"seg_scanner": 4, "apple_mpp": 9, "gmail_proxy": 2, "unattributed": 1,
	}}
	first := report.SortedMachineSubtypes()
	for i := 0; i < 20; i++ {
		if got := report.SortedMachineSubtypes(); !equalStrings(first, got) {
			t.Fatalf("subtype order is not stable: %v then %v", first, got)
		}
	}
	if first[0] != "apple_mpp" || first[len(first)-1] != "unattributed" {
		t.Errorf("order = %v, want lexicographic", first)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Every report states how its number was derived.
func TestEveryReportCarriesItsMethodologyAndVersions(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)

	repo := &Repo{Pool: app}
	classifier := mustClassifier(t, DefaultConfig(),
		registryEntry("R_GMAIL_PROXY_UA", MatchUASubstring, "googleimageproxy",
			SubtypeGmailProxy, 0.99))
	for i := range fixture.Events {
		observation := classifierDBObservation(fixture, i)
		if i == 0 {
			observation.UserAgent = "Mozilla/5.0 (compatible; GoogleImageProxy)"
		}
		if _, err := repo.Record(ctx, fixture.TenantID, observation,
			MessageAggregate{}, classifier); err != nil {
			t.Fatalf("record %d: %v", i, err)
		}
	}
	// Reach is explicitly a population of delivered recipients. Give each
	// classified opener a canonical delivery in the same report window; without
	// this boundary an orphaned/open-only event must not enter any reach bucket.
	if _, err := admin.Exec(ctx, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, campaign_id, source,
    provider_event_id, source_event_id, message_id, metadata, at
)
SELECT tenant_id, subscriber_email, 'delivered', campaign_id,
       'f01-reach-delivery-fixture',
       'delivery-' || id::text, 'delivery-' || id::text,
       message_id, '{}'::jsonb, at - interval '250 milliseconds'
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND event_type = 'opened'`, fixture.TenantID, fixture.CampaignID); err != nil {
		t.Fatalf("seed reach deliveries: %v", err)
	}

	report, err := repo.HumanEngagedReachFor(ctx, ReachQuery{
		TenantID: fixture.TenantID,
		Since:    fixture.At.Add(-24 * time.Hour),
		Until:    fixture.At.Add(24 * time.Hour),
	})
	if err != nil {
		t.Fatalf("HumanEngagedReachFor: %v", err)
	}

	if report.Methodology == "" {
		t.Error("no methodology statement; a human-engaged floor without one is " +
			"worthless the first time somebody asks how it was derived")
	}
	if !strings.Contains(report.Methodology, "floor") {
		t.Error("the methodology does not say the figure is a floor, which is the " +
			"single most misreadable property of this number")
	}
	if report.ClassifierVersion == "" {
		t.Error("no classifier version accompanies the report")
	}

	// The four populations must account for every delivered recipient, or the
	// report is describing a different population than it claims.
	accounted := report.HumanEngagedReachFloor + report.UnknownBand +
		report.MachineOnly + report.NoInteraction
	if report.Delivered > 0 && accounted != report.Delivered {
		t.Errorf("populations sum to %d against %d delivered; some recipients are "+
			"in no bucket or in two", accounted, report.Delivered)
	}

	// The unknown population must land in the BAND, not in the floor.
	//
	// Asserted directly rather than via the sum above, which is skipped when the
	// fixture records no `delivered` events — and was therefore vacuous: a
	// mutation moving every unknown recipient into HumanEngagedReachFloor passed it.
	// This fixture's observations classify as unknown apart from the seeded
	// proxy, so the band is where they belong.
	if report.UnknownBand == 0 && report.MachineOnly == 0 {
		t.Fatal("no classified recipients at all; the assertions below are vacuous")
	}
	if report.HumanEngagedReachFloor != 0 {
		t.Errorf("human-engaged reach floor = %d, but nothing in this fixture classifies "+
			"as human — unclassifiable recipients have been allocated into the floor, "+
			"which is the overstatement this report exists to prevent",
			report.HumanEngagedReachFloor)
	}
}

// An interaction is not allowed to expand the population beyond recipients
// whose delivery is in the same bounded report. This also keeps the four reach
// buckets arithmetically reconcilable with Delivered under retention and
// partial-provider-history conditions.
func TestReachExcludesInteractionsWithoutAnInWindowDelivery_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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
	classifier := mustClassifier(t, DefaultConfig())
	for i := range fixture.Events {
		observation := classifierDBObservation(fixture, i)
		dwell := int64(30_000)
		observation.DwellMilliseconds = &dwell
		if _, err := repo.Record(ctx, fixture.TenantID, observation,
			MessageAggregate{}, classifier); err != nil {
			t.Fatalf("record orphaned interaction %d: %v", i, err)
		}
	}

	report, err := repo.HumanEngagedReachFor(ctx, ReachQuery{
		TenantID: fixture.TenantID, CampaignID: fixture.CampaignID,
		Since: fixture.At.Add(-time.Minute), Until: fixture.At.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("HumanEngagedReachFor: %v", err)
	}
	if report.Delivered != 0 || report.HumanEngagedReachFloor != 0 ||
		report.UnknownBand != 0 || report.MachineOnly != 0 || report.NoInteraction != 0 {
		t.Fatalf("orphaned interactions entered reach population: %+v", report)
	}
	if len(report.ClassifierVersionCoverage) != 0 {
		t.Fatalf("orphaned interaction versions entered reach provenance: %+v",
			report.ClassifierVersionCoverage)
	}
}

// Only direct engagement can enter the three interaction buckets. Provider
// acceptance, negative-delivery, consent, and arbitrary lifecycle events may
// themselves have classifier rows, but those rows are not evidence that a
// recipient engaged with the message.
func TestReachBucketsOnlyIncludeOpenedClickedAndRepliedClassifications_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedClassifierDBFixture(t, ctx, admin)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
			fixture.TenantID, fixture.ForeignTenantID); err != nil {
			t.Errorf("clean reach eligibility fixture: %v", err)
		}
	})

	classifier := mustClassifier(t, DefaultConfig(), registryEntry(
		"R_REACH_GMAIL_PROXY_UA", MatchUASubstring, "reach-google-image-proxy",
		SubtypeGmailProxy, 0.99,
	))
	repo := &Repo{Pool: app, Now: func() time.Time { return fixture.At }}
	type reachCase struct {
		eventType      string
		classification Classification
		eligible       bool
	}
	eventTypes := []struct {
		name     string
		eligible bool
	}{
		{name: "opened", eligible: true},
		{name: "clicked", eligible: true},
		{name: "replied", eligible: true},
		{name: "delivered", eligible: false},
		{name: "bounced", eligible: false},
		{name: "complained", eligible: false},
		{name: "unsubscribed", eligible: false},
		{name: "custom", eligible: false},
	}
	classes := []Classification{Human, Unknown, Machine}
	cases := make([]reachCase, 0, len(eventTypes)*len(classes))
	for _, eventType := range eventTypes {
		for _, classification := range classes {
			cases = append(cases, reachCase{
				eventType: eventType.name, classification: classification,
				eligible: eventType.eligible,
			})
		}
	}

	// Keep each case in its own two-second report window. That makes every
	// assertion independent: an accidentally included excluded event cannot be
	// cancelled out by an accidentally omitted eligible event elsewhere.
	base := fixture.At.Add(-3 * time.Hour).Truncate(time.Second)
	for index, testCase := range cases {
		testCase := testCase
		t.Run(testCase.eventType+"_"+string(testCase.classification), func(t *testing.T) {
			caseAt := base.Add(time.Duration(index) * time.Minute)
			email := fmt.Sprintf("reach-%02d-%s-%s@example.test", index,
				testCase.eventType, testCase.classification)
			insertEvent := func(label, eventType string, at time.Time) EventRef {
				t.Helper()
				sourceID := fmt.Sprintf("reach-eligibility-%s-%02d-%s", label, index, fixture.TenantID)
				var event EventRef
				if err := admin.QueryRow(ctx, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, campaign_id, source,
    provider_event_id, source_event_id, message_id, metadata, at
) VALUES (
    $1::uuid, $2, $3, $4::uuid, 'reach-eligibility-fixture',
    $5, $5, $6, '{}'::jsonb, $7
)
RETURNING id, at`, fixture.TenantID, email, eventType, fixture.CampaignID,
					sourceID, "<"+sourceID+"@example.test>", at).Scan(&event.ID, &event.At); err != nil {
					t.Fatalf("seed %s event: %v", eventType, err)
				}
				return event
			}

			// Every case has exactly one delivered recipient. For the delivered
			// classification case, the classified event is the delivery itself.
			if testCase.eventType != "delivered" {
				insertEvent("delivery", "delivered", caseAt.Add(-250*time.Millisecond))
			}
			event := insertEvent("classified", testCase.eventType, caseAt)

			observation := validObservation()
			observation.EventRef = event
			observation.Source = "reach-eligibility-fixture"
			observation.SourceEventID = fmt.Sprintf("reach-source-%02d", index)
			observation.IdempotencyKey = fmt.Sprintf("reach-observation-%s-%02d", fixture.TenantID, index)
			observation.EventType = testCase.eventType
			observation.OccurredAt = event.At
			observation.DeliveredAt = nil
			observation.IngestedAt = event.At
			observation.PrivacyExpiryAt = event.At.AddDate(1, 0, 0)
			observation.OrderedHeaders = nil
			observation.OrderedHeadersComplete = false
			observation.UserAgent = ""
			observation.DwellMilliseconds = nil
			switch testCase.classification {
			case Human:
				dwell := int64(30_000)
				observation.DwellMilliseconds = &dwell
			case Machine:
				observation.UserAgent = "Mozilla/5.0 reach-google-image-proxy"
			}
			receipt, err := repo.Record(ctx, fixture.TenantID, observation,
				MessageAggregate{}, classifier)
			if err != nil {
				t.Fatalf("record %s classification: %v", testCase.classification, err)
			}
			if receipt.Result.Classification != testCase.classification {
				t.Fatalf("fixture classified as %q, want %q", receipt.Result.Classification,
					testCase.classification)
			}

			report, err := repo.HumanEngagedReachFor(ctx, ReachQuery{
				TenantID: fixture.TenantID, CampaignID: fixture.CampaignID,
				Since: caseAt.Add(-time.Second), Until: caseAt.Add(time.Second),
			})
			if err != nil {
				t.Fatalf("HumanEngagedReachFor: %v", err)
			}
			if report.Delivered != 1 {
				t.Fatalf("delivered = %d, want isolated denominator 1", report.Delivered)
			}
			wantHuman, wantUnknown, wantMachine := int64(0), int64(0), int64(0)
			if testCase.eligible {
				switch testCase.classification {
				case Human:
					wantHuman = 1
				case Unknown:
					wantUnknown = 1
				case Machine:
					wantMachine = 1
				}
			}
			if report.HumanEngagedReachFloor != wantHuman ||
				report.UnknownBand != wantUnknown || report.MachineOnly != wantMachine {
				t.Fatalf("interaction buckets floor/unknown/machine = %d/%d/%d, want %d/%d/%d",
					report.HumanEngagedReachFloor, report.UnknownBand, report.MachineOnly,
					wantHuman, wantUnknown, wantMachine)
			}
			wantNoInteraction := int64(1)
			if testCase.eligible {
				wantNoInteraction = 0
			}
			if report.NoInteraction != wantNoInteraction {
				t.Fatalf("no_interaction = %d, want %d", report.NoInteraction, wantNoInteraction)
			}
			wantSubtypeCount := wantMachine
			if report.MachineBySubtype[string(SubtypeGmailProxy)] != wantSubtypeCount {
				t.Fatalf("gmail_proxy subtype = %d, want %d; breakdown=%v",
					report.MachineBySubtype[string(SubtypeGmailProxy)], wantSubtypeCount,
					report.MachineBySubtype)
			}
		})
	}
}

// A recipient who never interacted is not counted as reached.
func TestAbsenceOfEvidenceIsNotCountedAsHuman(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_, app := classifierDBPools(t, ctx)

	report, err := (&Repo{Pool: app}).HumanEngagedReachFor(ctx, ReachQuery{
		TenantID: "00000000-0000-0000-0000-000000000000",
		Since:    time.Now().UTC().AddDate(0, 0, -1),
		Until:    time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("HumanEngagedReachFor: %v", err)
	}
	if report.HumanEngagedReachFloor != 0 {
		t.Fatalf("human-engaged reach floor = %d over a tenant with no interactions",
			report.HumanEngagedReachFloor)
	}
	if !report.ShadowMode || len(report.ClassifierVersionCoverage) != 0 {
		t.Fatalf("empty-interaction report lost fail-closed shadow provenance: %+v", report)
	}
	if report.MachineBySubtype == nil {
		t.Error("nil breakdown serialises as null; a reader cannot tell 'no machine " +
			"traffic' from 'not computed'")
	}
}
