// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

var classifierTestNow = time.Date(2026, 8, 10, 3, 0, 0, 0, time.UTC)

func validObservation() ObservationInput {
	delivered := classifierTestNow
	return ObservationInput{
		EventRef:           EventRef{ID: 41, At: classifierTestNow.Add(time.Minute)},
		Source:             "listmonk",
		IdempotencyKey:     "provider-event-41",
		EventSchemaVersion: ObservationSchemaV1,
		EventType:          "opened",
		OccurredAt:         classifierTestNow.Add(time.Minute),
		DeliveredAt:        &delivered,
		OrderedHeaders: []Header{
			{Name: "User-Agent", Value: "Mozilla/5.0"},
			{Name: "Accept-Language", Value: "en-US"},
		},
		ProviderSignals: map[string]any{},
		PrivacyExpiryAt: classifierTestNow.Add(90 * 24 * time.Hour),
	}
}

func registryEntry(id string, matcher MatcherType, value string, subtype MachineSubtype, confidence float64) RegistryEntry {
	return RegistryEntry{
		RegistryVersion: CurrentRegistryV2,
		EntryID:         id,
		MatcherType:     matcher,
		MatcherValue:    value,
		MachineSubtype:  subtype,
		Confidence:      confidence,
		SourceNote:      "controlled regression fixture",
		LastVerified:    classifierTestNow,
	}
}

func mustClassifier(t *testing.T, config Config, entries ...RegistryEntry) *Classifier {
	t.Helper()
	classifier, err := NewClassifier(config, entries)
	if err != nil {
		t.Fatalf("NewClassifier: %v", err)
	}
	return classifier
}

func hasRule(result ClassificationResult, wanted string) bool {
	for _, rule := range result.Rules {
		if rule.ID == wanted {
			return true
		}
	}
	return false
}

func TestClassifierKeepsNoSignalUnknown(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	observation := validObservation()
	observation.DeliveredAt = nil
	result, err := classifier.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Classification != Unknown || result.StableReason != ReasonNoConfidentSignal ||
		result.MachineSubtype != "" || !result.ShadowMode || len(result.Rules) == 0 {
		t.Fatalf("unknown result = %+v", result)
	}
}

func TestClassifierDistinguishesMissingCaptureFromCapturedAbsence(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	observation := validObservation()
	observation.DeliveredAt = nil
	observation.OrderedHeaders = nil
	observation.OrderedHeadersComplete = false
	missing, err := classifier.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if hasRule(missing, "R_NO_ACCEPT_LANGUAGE") {
		t.Fatalf("missing header capture was treated as captured absence: %+v", missing)
	}
	observation.OrderedHeadersComplete = true
	complete, err := classifier.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if !hasRule(complete, "R_NO_ACCEPT_LANGUAGE") {
		t.Fatalf("complete capture did not record absent Accept-Language: %+v", complete)
	}
}

func TestClassifierSeedOriginIsAbsoluteButKeepsConflict(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	observation := validObservation()
	observation.IsSeed = true
	dwell := int64(45_000)
	observation.DwellMilliseconds = &dwell
	result, err := classifier.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Classification != Machine || result.MachineSubtype != SubtypeSeedAutomation ||
		result.HumanConfidence != 0 || result.StableReason != "R_SEED_ORIGIN" {
		t.Fatalf("seed result = %+v", result)
	}
	if len(result.Conflicts) == 0 || !hasRule(result, "R_ENGAGEMENT_DEPTH") {
		t.Fatalf("seed conflict was discarded: %+v", result)
	}
}

func TestClassifierMatchesDataBackedRegistry(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig(), registryEntry(
		"R_GMAIL_PROXY_UA", MatchUASubstring, "GoogleImageProxy", SubtypeGmailProxy, 0.99,
	))
	observation := validObservation()
	observation.DeliveredAt = nil
	observation.UserAgent = "Mozilla/5.0 via GoogleImageProxy"
	result, err := classifier.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Classification != Machine || result.MachineSubtype != SubtypeGmailProxy ||
		result.StableReason != "R_GMAIL_PROXY_UA" {
		t.Fatalf("registry result = %+v", result)
	}
}

func TestClassifierCombinesHumanEvidence(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	observation := validObservation()
	dwell := int64(30_000)
	observation.DwellMilliseconds = &dwell
	result, err := classifier.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Classification != Human || result.MachineSubtype != "" ||
		result.HumanConfidence != 0.95 || result.CalibrationBand != "calibrated_human" {
		t.Fatalf("human result = %+v", result)
	}
}

func TestClassifierAdmitsOnlyCompleteTrustedHumanReplyReceipts(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	valid := validObservation()
	valid.EventType = "replied"
	valid.Source = "reply.postmark"
	valid.ProviderSignals = map[string]any{
		"reply_classification":       "human_reply",
		"reply_classifier_version":   "postwave.reply-classifier.v1",
		"reply_classifier_reason":    "R_REPLY_HUMAN_AFTER_EXCLUSIONS",
		"reply_classifier_evidence":  []string{"R_REPLY_HUMAN_AFTER_EXCLUSIONS"},
		"reply_correlation_method":   "in_reply_to",
		"reply_correlation_strength": "strong",
	}
	result, err := classifier.Classify(valid, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Classification != Human || !hasRule(result, "R_TRUSTED_HUMAN_REPLY") {
		t.Fatalf("trusted reply receipt = %+v, want explicit human rule", result)
	}

	cases := map[string]func(ObservationInput) ObservationInput{
		"wrong event type": func(input ObservationInput) ObservationInput {
			input.EventType = "opened"
			return input
		},
		"untrusted source": func(input ObservationInput) ObservationInput {
			input.Source = "postmark"
			return input
		},
		"automatic class": func(input ObservationInput) ObservationInput {
			input.ProviderSignals["reply_classification"] = "auto_reply"
			return input
		},
		"unknown version": func(input ObservationInput) ObservationInput {
			input.ProviderSignals["reply_classifier_version"] = "postwave.reply-classifier.future"
			return input
		},
		"weak sender match": func(input ObservationInput) ObservationInput {
			input.ProviderSignals["reply_correlation_method"] = "from_subscriber"
			return input
		},
		"wrong stable reason": func(input ObservationInput) ObservationInput {
			input.ProviderSignals["reply_classifier_reason"] = "R_REPLY_AUTO_SUBMITTED"
			return input
		},
		"missing match": func(input ObservationInput) ObservationInput {
			delete(input.ProviderSignals, "reply_correlation_method")
			return input
		},
		"missing evidence": func(input ObservationInput) ObservationInput {
			delete(input.ProviderSignals, "reply_classifier_evidence")
			return input
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			input := valid
			input.ProviderSignals = cloneProviderSignals(valid.ProviderSignals)
			input = mutate(input)
			got, err := classifier.Classify(input, MessageAggregate{})
			if err != nil {
				t.Fatal(err)
			}
			if got.Classification == Human || hasRule(got, "R_TRUSTED_HUMAN_REPLY") {
				t.Fatalf("untrusted reply evidence was admitted as human: %+v", got)
			}
		})
	}
}

func TestClassifierPreservesContradictoryRegistryAndHumanEvidence(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig(), registryEntry(
		"R_GMAIL_PROXY_UA", MatchUASubstring, "GoogleImageProxy", SubtypeGmailProxy, 0.99,
	))
	observation := validObservation()
	observation.UserAgent = "GoogleImageProxy"
	dwell := int64(30_000)
	observation.DwellMilliseconds = &dwell
	result, err := classifier.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Classification != Unknown || result.StableReason != ReasonConflictingEvidence ||
		len(result.Conflicts) == 0 || result.MachineSubtype != "" {
		t.Fatalf("conflicting result = %+v", result)
	}
}

func TestClassifierAllLinksScannerCascade(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	observation := validObservation()
	observation.EventType = "clicked"
	observation.DeliveredAt = nil
	result, err := classifier.Classify(observation, MessageAggregate{
		Complete: true, TotalLinks: 5, DistinctLinksFetched: 5, EventCount: 6,
		BurstWindow: 20 * time.Second, HasPrecedingOpen: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Classification != Machine || result.MachineSubtype != SubtypeSEGScanner ||
		!hasRule(result, "R_ALL_LINKS_FETCHED") || !hasRule(result, "R_CLICK_WITHOUT_OPEN") {
		t.Fatalf("scanner result = %+v", result)
	}
}

func TestClassifierResultDoesNotDependOnRegistryOrder(t *testing.T) {
	first := registryEntry("R_PROXY_UA", MatchUASubstring, "proxy", SubtypeGmailProxy, 0.95)
	second := registryEntry("R_PROXY_SOURCE", MatchSource, "listmonk", SubtypeUnknownBot, 0.40)
	a := mustClassifier(t, DefaultConfig(), first, second)
	b := mustClassifier(t, DefaultConfig(), second, first)
	observation := validObservation()
	observation.DeliveredAt = nil
	observation.UserAgent = "proxy"
	resultA, err := a.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	resultB, err := b.Classify(observation, MessageAggregate{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(resultA, resultB) {
		t.Fatalf("registry order changed result:\nA=%+v\nB=%+v", resultA, resultB)
	}
}

func TestObservationFingerprintIgnoresReceiptTimeButNotEvidence(t *testing.T) {
	first, err := normalizeObservation(validObservation(), classifierTestNow)
	if err != nil {
		t.Fatal(err)
	}
	second := first
	second.IngestedAt = second.IngestedAt.Add(time.Hour)
	second.PrivacyExpiryAt = second.PrivacyExpiryAt.Add(time.Hour)
	firstHash, _ := observationFingerprint(first)
	secondHash, _ := observationFingerprint(second)
	if firstHash != secondHash {
		t.Fatal("server receipt time changed provider idempotency fingerprint")
	}
	second.UserAgent = "changed"
	secondHash, _ = observationFingerprint(second)
	if firstHash == secondHash {
		t.Fatal("evidence mutation did not change observation fingerprint")
	}
}

func TestConfigValidationRejectsCollapsedUnknownBand(t *testing.T) {
	config := DefaultConfig()
	config.MachineThreshold = config.HumanThreshold
	if _, err := NewClassifier(config, nil); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("NewClassifier error = %v, want ErrInvalidInput", err)
	}
}

func TestConfigValidationRejectsPrematureAuthoritativeMode(t *testing.T) {
	config := DefaultConfig()
	config.ShadowMode = false
	if _, err := NewClassifier(config, nil); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("NewClassifier error = %v, want shadow-only ErrInvalidInput", err)
	}
}
