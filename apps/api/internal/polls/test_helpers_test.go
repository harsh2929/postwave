// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"
)

func testTokenKeyring(now time.Time) TokenKeyring {
	now = now.UTC()
	return TokenKeyring{
		ActiveKeyID: "poll-test-2026",
		TokenTTL:    defaultLinkTokenValidity,
		Keys: []TokenKey{{
			ID: "poll-test-2026", Secret: []byte("poll-token-secret-for-tests-only"),
			MintNotBefore:  now.Add(-365 * 24 * time.Hour),
			MintNotAfter:   now.Add(365 * 24 * time.Hour),
			VerifyNotAfter: now.Add(500 * 24 * time.Hour),
		}},
	}
}

func testDecision(classification string) ClassificationDecision {
	digest := sha256.Sum256([]byte("poll-test-evidence:" + classification))
	return ClassificationDecision{
		Classification: classification, UpstreamClassification: classification,
		StableReason: "R_TEST_FIXTURE", CalibrationBand: "test",
		ClassifierVersion:  "postwave.engagement-classifier.v2",
		MethodologyVersion: "postwave.engagement-methodology.v2",
		RegistryVersion:    "postwave.machine-source-registry.v1",
		ConfigurationHash:  strings.Repeat("a", 64),
		ClassifierStatus:   classificationStatusReady,
		EvidenceSHA256:     hex.EncodeToString(digest[:]),
		Rules:              []ClassificationRule{}, Conflicts: []ClassificationConflict{},
	}
}
