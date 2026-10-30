// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

var provenanceVersionPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,95}$`)

const (
	classificationStatusReady       = "ready"
	classificationStatusUnavailable = "unavailable"
	explicitBrowserReason           = "R_EXPLICIT_BROWSER_CONFIRMATION"
	classifierUnavailableReason     = "R_CLASSIFIER_UNAVAILABLE"
)

// ClassificationRule and ClassificationConflict are the bounded, non-PII
// explanation copied from F01. Raw headers, addresses, and IPs never enter a
// poll receipt; EvidenceSHA256 proves the exact transient input evaluated.
type ClassificationRule struct {
	ID               string  `json:"id"`
	Direction        string  `json:"direction"`
	Weight           float64 `json:"weight"`
	SignalConfidence float64 `json:"signal_confidence"`
	Source           string  `json:"source"`
	MachineSubtype   string  `json:"machine_subtype,omitempty"`
}

type ClassificationConflict struct {
	Code    string   `json:"code"`
	RuleIDs []string `json:"rule_ids"`
}

// ClassificationDecision is the complete attribution boundary persisted for
// every distinct POST. Classification is the poll policy result;
// UpstreamClassification preserves F01's verdict when the explicit browser
// confirmation policy promotes an otherwise unknown request to human.
type ClassificationDecision struct {
	Classification          string                   `json:"classification"`
	UpstreamClassification  string                   `json:"upstream_classification"`
	MachineSubtype          string                   `json:"machine_subtype,omitempty"`
	StableReason            string                   `json:"stable_reason"`
	CalibrationBand         string                   `json:"calibration_band,omitempty"`
	ClassifierVersion       string                   `json:"classifier_version,omitempty"`
	MethodologyVersion      string                   `json:"methodology_version,omitempty"`
	RegistryVersion         string                   `json:"registry_version,omitempty"`
	ConfigurationHash       string                   `json:"configuration_hash,omitempty"`
	ShadowMode              bool                     `json:"shadow_mode"`
	ExplicitBrowserDecision bool                     `json:"explicit_browser_decision"`
	ClassifierStatus        string                   `json:"classifier_status"`
	EvidenceSHA256          string                   `json:"evidence_sha256"`
	Rules                   []ClassificationRule     `json:"rules"`
	Conflicts               []ClassificationConflict `json:"conflicts"`
}

func normalizeClassificationDecision(input ClassificationDecision) ClassificationDecision {
	input.Classification = strings.ToLower(strings.TrimSpace(input.Classification))
	input.UpstreamClassification = strings.ToLower(strings.TrimSpace(input.UpstreamClassification))
	input.MachineSubtype = strings.TrimSpace(input.MachineSubtype)
	input.StableReason = strings.TrimSpace(input.StableReason)
	input.CalibrationBand = strings.TrimSpace(input.CalibrationBand)
	input.ClassifierVersion = strings.TrimSpace(input.ClassifierVersion)
	input.MethodologyVersion = strings.TrimSpace(input.MethodologyVersion)
	input.RegistryVersion = strings.TrimSpace(input.RegistryVersion)
	input.ConfigurationHash = strings.TrimSpace(input.ConfigurationHash)
	input.ClassifierStatus = strings.ToLower(strings.TrimSpace(input.ClassifierStatus))
	if input.Classification != "human" && input.Classification != "machine" {
		input.Classification = "unknown"
	}
	if input.UpstreamClassification != "human" && input.UpstreamClassification != "machine" &&
		input.UpstreamClassification != "unknown" {
		input.UpstreamClassification = input.Classification
	}
	if input.ClassifierStatus == classificationStatusReady &&
		(!provenanceVersionPattern.MatchString(input.ClassifierVersion) ||
			!provenanceVersionPattern.MatchString(input.MethodologyVersion) ||
			!provenanceVersionPattern.MatchString(input.RegistryVersion) ||
			!isLowerHexSHA256(input.ConfigurationHash)) {
		input.ClassifierStatus = classificationStatusUnavailable
	}
	if input.ClassifierStatus != classificationStatusReady {
		input.ClassifierStatus = classificationStatusUnavailable
		input.Classification = "unknown"
		input.UpstreamClassification = "unknown"
		input.ExplicitBrowserDecision = false
		input.MachineSubtype = ""
		input.ClassifierVersion = ""
		input.MethodologyVersion = ""
		input.RegistryVersion = ""
		input.ConfigurationHash = ""
		if input.StableReason == "" {
			input.StableReason = classifierUnavailableReason
		}
	}
	if input.ExplicitBrowserDecision {
		input.Classification = "human"
		if input.StableReason == "" {
			input.StableReason = explicitBrowserReason
		}
	}
	if input.StableReason == "" {
		input.StableReason = "R_NO_CONFIDENT_SIGNAL"
	}
	if input.Rules == nil {
		input.Rules = []ClassificationRule{}
	}
	if input.Conflicts == nil {
		input.Conflicts = []ClassificationConflict{}
	}
	for index := range input.Conflicts {
		input.Conflicts[index].RuleIDs = append([]string(nil), input.Conflicts[index].RuleIDs...)
		sort.Strings(input.Conflicts[index].RuleIDs)
	}
	sort.Slice(input.Rules, func(i, j int) bool {
		if input.Rules[i].ID != input.Rules[j].ID {
			return input.Rules[i].ID < input.Rules[j].ID
		}
		return input.Rules[i].Source < input.Rules[j].Source
	})
	sort.Slice(input.Conflicts, func(i, j int) bool {
		return input.Conflicts[i].Code < input.Conflicts[j].Code
	})
	if !isLowerHexSHA256(input.EvidenceSHA256) {
		copyForHash := input
		copyForHash.EvidenceSHA256 = ""
		encoded, _ := json.Marshal(copyForHash)
		digest := sha256.Sum256(append([]byte("postwave.poll.classification-evidence.v1\x00"), encoded...))
		input.EvidenceSHA256 = hex.EncodeToString(digest[:])
	}
	return input
}
