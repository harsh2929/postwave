// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"testing"
	"time"
)

func FuzzClassifierClosedWorldAndExplainable(f *testing.F) {
	f.Add("GoogleImageProxy", "opened", true, int64(0))
	f.Add("Mozilla/5.0", "clicked", false, int64(35000))
	classifier, err := NewClassifier(DefaultConfig(), []RegistryEntry{
		registryEntry("R_GMAIL_PROXY_UA", MatchUASubstring, "GoogleImageProxy", SubtypeGmailProxy, 0.99),
	})
	if err != nil {
		f.Fatal(err)
	}
	f.Fuzz(func(t *testing.T, userAgent, eventType string, seed bool, dwell int64) {
		if len(userAgent) > 512 {
			userAgent = userAgent[:512]
		}
		if eventType != "opened" && eventType != "clicked" {
			eventType = "opened"
		}
		if dwell < 0 {
			dwell = -dwell
		}
		dwell %= 86400001
		observation := validObservation()
		observation.UserAgent = userAgent
		observation.EventType = eventType
		observation.IsSeed = seed
		observation.DwellMilliseconds = &dwell
		result, err := classifier.Classify(observation, MessageAggregate{
			EventCount: 2, BurstWindow: 3 * time.Second,
		})
		if err != nil {
			return
		}
		if !result.Classification.Valid() || len(result.Rules) == 0 ||
			!rulePattern.MatchString(result.StableReason) {
			t.Fatalf("classifier escaped closed contract: %+v", result)
		}
		if result.Classification != Human && result.HumanConfidence >= 0.80 && !seed {
			t.Fatalf("non-human result crossed human threshold: %+v", result)
		}
	})
}

func FuzzObservationFingerprintDeterministic(f *testing.F) {
	f.Add("ua", "value")
	f.Fuzz(func(t *testing.T, userAgent, signal string) {
		if len(userAgent) > 512 {
			userAgent = userAgent[:512]
		}
		if len(signal) > 512 {
			signal = signal[:512]
		}
		observation := validObservation()
		observation.UserAgent = userAgent
		observation.ProviderSignals = map[string]any{"signal": signal}
		normalized, err := normalizeObservation(observation, classifierTestNow)
		if err != nil {
			return
		}
		first, err := observationFingerprint(normalized)
		if err != nil {
			t.Fatal(err)
		}
		second, err := observationFingerprint(normalized)
		if err != nil || first != second || !hashPattern.MatchString(first) {
			t.Fatalf("fingerprint is not deterministic: first=%q second=%q err=%v", first, second, err)
		}
	})
}
