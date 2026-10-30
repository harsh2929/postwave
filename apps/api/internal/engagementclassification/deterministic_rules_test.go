// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"testing"
	"time"
)

func testClassifier(t *testing.T, registry []RegistryEntry) *Classifier {
	t.Helper()
	classifier, err := NewClassifier(DefaultConfig(), registry)
	if err != nil {
		t.Fatalf("NewClassifier: %v", err)
	}
	return classifier
}

// Built on the package's existing validObservation so these tests exercise the
// same identity and header shape as the rest of the suite.
func eventAt(eventType string, base time.Time) ObservationInput {
	observation := validObservation()
	observation.EventType = eventType
	observation.OccurredAt = base
	observation.At = base
	// No delivery time: the latency rules are not under test here and a
	// delivered_at would fire them alongside the rule being measured.
	observation.DeliveredAt = nil
	return observation
}

func openAt(base time.Time) ObservationInput { return eventAt("opened", base) }

func firedRule(result ClassificationResult, id string) bool {
	for _, rule := range result.Rules {
		if rule.ID == id {
			return true
		}
	}
	return false
}

// A human cannot open the same message twice inside a second. Two opens that
// close together are one fetcher retrying or a proxy fanning out, and today
// they both count as engagement.
func TestRapidRepeatOpensAreMachineEvidence(t *testing.T) {
	base := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	classifier := testClassifier(t, nil)

	rapid := MessageAggregate{
		Complete: true, EventCount: 3, OpenCount: 3,
		MinOpenGap: 200 * time.Millisecond,
	}
	result, err := classifier.Classify(openAt(base), rapid)
	if err != nil {
		t.Fatal(err)
	}
	if !firedRule(result, "R_RAPID_REPEAT_OPEN") {
		t.Fatalf("three opens 200ms apart did not fire the rapid-repeat rule: %+v", result.Rules)
	}

	// A human re-reading a message minutes later must NOT fire it.
	human := MessageAggregate{
		Complete: true, EventCount: 2, OpenCount: 2, MinOpenGap: 4 * time.Minute,
	}
	result, err = classifier.Classify(openAt(base), human)
	if err != nil {
		t.Fatal(err)
	}
	if firedRule(result, "R_RAPID_REPEAT_OPEN") {
		t.Fatal("a re-read four minutes later was treated as machine")
	}
}

// A single open cannot be a repeat. Without this guard a zero MinOpenGap on a
// one-open message reads as "0ms apart" and flags every ordinary open.
func TestASingleOpenIsNeverARapidRepeat(t *testing.T) {
	classifier := testClassifier(t, nil)
	result, err := classifier.Classify(
		openAt(time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)),
		MessageAggregate{Complete: true, EventCount: 1, OpenCount: 1, MinOpenGap: 0},
	)
	if err != nil {
		t.Fatal(err)
	}
	if firedRule(result, "R_RAPID_REPEAT_OPEN") {
		t.Fatal("a lone open was reported as a rapid repeat")
	}
}

// A click timestamped BEFORE the first open is physically impossible for a
// human: nobody clicks a link in a message they have not rendered. It is the
// signature of a scanner that fetches links first and images second.
func TestClickBeforeFirstOpenIsMachineEvidence(t *testing.T) {
	base := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	classifier := testClassifier(t, nil)

	click := eventAt("clicked", base)
	firstOpen := base.Add(90 * time.Second)
	result, err := classifier.Classify(click, MessageAggregate{
		Complete: true, EventCount: 2, FirstOpenAt: &firstOpen,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !firedRule(result, "R_CLICK_BEFORE_OPEN") {
		t.Fatalf("a click 90s before the first open did not fire: %+v", result.Rules)
	}

	// The ordinary case — open, then click — must not fire.
	earlierOpen := base.Add(-90 * time.Second)
	result, err = classifier.Classify(click, MessageAggregate{
		Complete: true, EventCount: 2, FirstOpenAt: &earlierOpen, HasPrecedingOpen: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if firedRule(result, "R_CLICK_BEFORE_OPEN") {
		t.Fatal("a normal open-then-click sequence was flagged as impossible ordering")
	}
}

// Two opens from regions further apart than any traveller could cross in the
// elapsed time are not one person. Distinct from a burst: these can be hours
// apart and still impossible.
func TestGeographicallyImpossibleOpensAreMachineEvidence(t *testing.T) {
	base := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	classifier := testClassifier(t, nil)

	result, err := classifier.Classify(openAt(base), MessageAggregate{
		Complete: true, EventCount: 2, OpenCount: 2,
		DistinctOpenRegions: 2, RegionSpan: 3 * time.Minute,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !firedRule(result, "R_GEO_IMPOSSIBLE") {
		t.Fatalf("two regions three minutes apart did not fire: %+v", result.Rules)
	}

	// A business traveller opening in two regions a day apart is ordinary.
	result, err = classifier.Classify(openAt(base), MessageAggregate{
		Complete: true, EventCount: 2, OpenCount: 2,
		DistinctOpenRegions: 2, RegionSpan: 26 * time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	if firedRule(result, "R_GEO_IMPOSSIBLE") {
		t.Fatal("a traveller opening in two regions a day apart was flagged")
	}
}

// One region is never impossible, whatever the span.
func TestASingleRegionIsNeverGeographicallyImpossible(t *testing.T) {
	classifier := testClassifier(t, nil)
	result, err := classifier.Classify(
		openAt(time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)),
		MessageAggregate{Complete: true, EventCount: 2, DistinctOpenRegions: 1, RegionSpan: time.Second},
	)
	if err != nil {
		t.Fatal(err)
	}
	if firedRule(result, "R_GEO_IMPOSSIBLE") {
		t.Fatal("a single region was reported as impossible travel")
	}
}

// An incomplete aggregate means the producer could not see every event for the
// message. Fan-out and ordering rules must stay silent rather than judge on a
// partial view — a scanner that fetched ten links looks identical to a human
// who clicked one if the other nine were not loaded.
func TestAggregateRulesStaySilentOnAnIncompleteAggregate(t *testing.T) {
	base := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	classifier := testClassifier(t, nil)
	firstOpen := base.Add(time.Minute)

	result, err := classifier.Classify(openAt(base), MessageAggregate{
		Complete: false, EventCount: 5, OpenCount: 5,
		MinOpenGap: time.Millisecond, DistinctOpenRegions: 4,
		RegionSpan: time.Second, FirstOpenAt: &firstOpen,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"R_RAPID_REPEAT_OPEN", "R_GEO_IMPOSSIBLE", "R_CLICK_BEFORE_OPEN"} {
		if firedRule(result, id) {
			t.Errorf("%s fired on an incomplete aggregate", id)
		}
	}
}

// A JA4 fingerprint survives the two things an operator can trivially change —
// the User-Agent string and the source IP — so automation that rotates both
// still presents the same TLS stack.
func TestJA4RegistryMatcherIdentifiesAutomation(t *testing.T) {
	const fingerprint = "t13d1516h2_8daaf6152771_b0da82dd1658"
	classifier := testClassifier(t, []RegistryEntry{
		registryEntry("R_JA4_SCANNER", MatchJA4, fingerprint, SubtypeSEGScanner, 0.9),
	})

	observation := openAt(time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC))
	observation.TLSJA4 = fingerprint
	result, err := classifier.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if !firedRule(result, "R_JA4_SCANNER") {
		t.Fatalf("a known automation fingerprint did not match: %+v", result.Rules)
	}

	// An absent fingerprint must not match: most deployments do not capture
	// JA4, and an empty value matching an entry would flag every observation.
	observation.TLSJA4 = ""
	result, err = classifier.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if firedRule(result, "R_JA4_SCANNER") {
		t.Fatal("an absent JA4 matched a fingerprint entry")
	}

	// A different fingerprint must not match: JA4 is a digest, so anything but
	// an exact match would widen to every client sharing a TLS library.
	observation.TLSJA4 = "t13d1516h2_000000000000_000000000000"
	result, err = classifier.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if firedRule(result, "R_JA4_SCANNER") {
		t.Fatal("a different fingerprint matched")
	}
}

// The most expensive false positive available in this domain.
//
// Apple Mail sends a bare "Mozilla/5.0" with no platform token whether MPP is
// ON or OFF, so that string identifies Apple Mail, not the privacy proxy. A
// human who declined MPP, genuinely opened the message, and loaded images sends
// byte-identical headers to the prefetch.
//
// Matching it as machine would silently discard the most engaged Apple Mail
// humans from engaged segments, sunset flows and re-engagement suppression —
// the failure the human-engaged reach floor exists to prevent. The registry
// therefore must NOT carry a bare-Mozilla entry, and this test fails if one is
// ever added.
func TestBareMozillaUserAgentIsNotTreatedAsMachine(t *testing.T) {
	classifier := testClassifier(t, []RegistryEntry{
		registryEntry("R_GMAIL_PROXY_UA", MatchUASubstring, "googleimageproxy", SubtypeGmailProxy, 0.99),
		registryEntry("R_APPLE_MPP_UA", MatchUARegex, `(?i)(applemail/mpp|apple-mail-mpp)`, SubtypeAppleMPP, 0.99),
	})

	observation := openAt(time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC))
	observation.UserAgent = "Mozilla/5.0"
	result, err := classifier.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Classification == Machine {
		t.Fatalf("a bare Mozilla/5.0 user agent was classified machine: %+v", result.Rules)
	}
	for _, rule := range result.Rules {
		if rule.Direction == DirectionMachine && rule.Source == "machine_source_registry" {
			t.Fatalf("a registry entry matched a bare Apple Mail user agent (%s); "+
				"this discards engaged Apple Mail humans", rule.ID)
		}
	}
}

// An explicit MPP marker IS machine — the conservative rule must not become so
// conservative that it detects nothing.
func TestExplicitMPPMarkerIsStillMachine(t *testing.T) {
	classifier := testClassifier(t, []RegistryEntry{
		registryEntry("R_APPLE_MPP_UA", MatchUARegex, `(?i)(applemail/mpp|apple-mail-mpp)`, SubtypeAppleMPP, 0.99),
	})
	observation := openAt(time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC))
	observation.UserAgent = "AppleMail/MPP"
	result, err := classifier.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Classification != Machine {
		t.Fatalf("an explicit MPP marker was not classified machine: %+v", result)
	}
	if result.MachineSubtype != SubtypeAppleMPP {
		t.Errorf("subtype = %q, want apple_mpp", result.MachineSubtype)
	}
}

// A shared CDN range must never decide on its own. Between 30% and 95% of each
// Apple relay /16 carries unrelated third-party traffic, so a low-confidence
// range is corroboration — the weighted aggregation is what makes including it
// safe at all.
func TestASharedCDNRangeAloneDoesNotClassifyMachine(t *testing.T) {
	classifier := testClassifier(t, []RegistryEntry{
		registryEntry("R_APPLE_RELAY_EGRESS_CF", MatchCIDR, "104.28.0.0/16", SubtypeAppleMPP, 0.30),
	})
	observation := openAt(time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC))
	observation.IP = "104.28.14.7"
	result, err := classifier.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Classification == Machine {
		t.Fatalf("a shared CDN range alone classified machine: %+v", result.Rules)
	}
}

// "Unknown bot" is an admission of ignorance, not a classification. When a
// specific subtype and the generic one both fire, the specific one must win
// however heavily weighted the generic is — otherwise adding a high-confidence
// provider flag DEGRADES every verdict it touches from "prefetcher" to "some
// bot", which is less information than we had before.
func TestASpecificSubtypeOutranksUnknownBot(t *testing.T) {
	// Asserted in BOTH registry orders. Evaluation order is incidental — the
	// registry is loaded ORDER BY entry_id — so a rule that only holds when the
	// specific entry happens to be seen first is not a rule at all.
	for _, order := range [][]RegistryEntry{
		{
			registryEntry("R_A_GENERIC_FLAG", MatchProviderFlag, "machine_open", SubtypeUnknownBot, 0.995),
			registryEntry("R_B_GMAIL_PROXY", MatchUASubstring, "googleimageproxy", SubtypeGmailProxy, 0.90),
		},
		{
			registryEntry("R_A_GMAIL_PROXY", MatchUASubstring, "googleimageproxy", SubtypeGmailProxy, 0.90),
			registryEntry("R_B_GENERIC_FLAG", MatchProviderFlag, "machine_open", SubtypeUnknownBot, 0.995),
		},
	} {
		classifier := testClassifier(t, order)
		observation := openAt(time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC))
		observation.UserAgent = "Mozilla/5.0 via GoogleImageProxy"
		observation.ProviderSignals = map[string]any{"machine_open": true}

		result, err := classifier.Classify(observation, MessageAggregate{})
		if err != nil {
			t.Fatal(err)
		}
		if result.Classification != Machine {
			t.Fatalf("classification = %q, want machine", result.Classification)
		}
		if result.MachineSubtype != SubtypeGmailProxy {
			t.Fatalf("subtype = %q, want gmail_proxy — the generic unknown_bot "+
				"outranked a specific subtype and threw away what we knew",
				result.MachineSubtype)
		}
	}
}
