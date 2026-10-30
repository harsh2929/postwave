// SPDX-License-Identifier: AGPL-3.0-only

package campaigncomprehension

import (
	"encoding/json"

	"github.com/postwave/postwave/apps/api/internal/factcontract"
)

const (
	// ExtractionSchemaVersionV1 is the only accepted extraction schema.
	ExtractionSchemaVersionV1 = 1
	// ExtractionNormalizationVersionV1 pins all normalization and receipt-hash
	// behavior implemented by this package.
	ExtractionNormalizationVersionV1 = "campaign-comprehension-extraction-normalization-v1"
	// ScoreVersionV1 pins the deterministic rubric and weights.
	ScoreVersionV1 = "campaign-comprehension-score-v1"
)

// ExtractionV1 is a strict normalized statement of what one analyzer
// recovered from one frozen artifact. Confidence is deliberately absent.
type ExtractionV1 struct {
	SchemaVersion     int                `json:"schema_version"`
	Summary           string             `json:"summary"`
	PrimaryIntent     ExtractedIntent    `json:"primary_intent"`
	CoreClaim         ExtractedStatement `json:"core_claim"`
	PrimaryAction     ExtractedAction    `json:"primary_action"`
	Facts             []ExtractedFact    `json:"facts"`
	UnsupportedClaims []UnsupportedClaim `json:"unsupported_claims"`
	Ambiguities       []Ambiguity        `json:"ambiguities"`
	// WouldSurfaceInDigest is the analyzer's judgement that an AI inbox would
	// mention this message at all.
	//
	// It is the PRD's first scoring dimension and the one the whole feature is
	// named for: a message can be delivered, land in the inbox, and still be
	// invisible because the summariser did not consider it worth mentioning.
	// Every other dimension measures how WELL the message was understood; this
	// one measures whether it was seen.
	//
	// A pointer because the honest third state exists. An analyzer that did not
	// answer must not be recorded as "no" — absence of a judgement and a
	// judgement of absence are different facts, and averaging a missing answer
	// as 0 would quietly depress every campaign an older analyzer scored.
	// omitempty is load-bearing and safe here BECAUSE it is a pointer: nil is
	// omitted, &false serialises as false. So "not answered" leaves the canonical
	// form byte-identical to what it was before this field existed, and every
	// receipt hash minted by an older analyzer still verifies. A value field with
	// omitempty could not express the difference.
	WouldSurfaceInDigest *bool `json:"would_surface_in_digest,omitempty"`
}

type ExtractedIntent struct {
	Kind        factcontract.IntentKind `json:"kind"`
	Value       string                  `json:"value"`
	EvidenceIDs []string                `json:"evidence_ids"`
}

type ExtractedStatement struct {
	Value       string   `json:"value"`
	EvidenceIDs []string `json:"evidence_ids"`
}

type ExtractedAction struct {
	ActionID     factcontract.ActionID          `json:"action_id"`
	BlockID      factcontract.BlockID           `json:"block_id"`
	Role         factcontract.PrimaryActionRole `json:"role"`
	Label        string                         `json:"label"`
	CanonicalURL string                         `json:"canonical_url,omitempty"`
	EvidenceIDs  []string                       `json:"evidence_ids"`
}

// ExtractedFact is a closed discriminated value. Normalized contains text,
// code, location, decimal, timestamp, or canonical URL according to Type.
// The companion field required by datetime/money/number types is explicit.
type ExtractedFact struct {
	FactID      factcontract.FactID   `json:"fact_id"`
	Type        factcontract.FactType `json:"type"`
	Raw         string                `json:"raw"`
	Normalized  string                `json:"normalized"`
	Timezone    string                `json:"timezone,omitempty"`
	Currency    string                `json:"currency,omitempty"`
	Unit        string                `json:"unit,omitempty"`
	EvidenceIDs []string              `json:"evidence_ids"`
}

type UnsupportedClaim struct {
	Statement   string   `json:"statement"`
	EvidenceIDs []string `json:"evidence_ids"`
}

type Ambiguity struct {
	Field       string   `json:"field"`
	Description string   `json:"description"`
	EvidenceIDs []string `json:"evidence_ids"`
}

// ExtractionReceiptV1 binds the normalized extraction to the exact versioned
// hash preimage. CanonicalExtraction is ready for durable JSON storage.
type ExtractionReceiptV1 struct {
	SchemaVersion        int             `json:"schema_version"`
	NormalizationVersion string          `json:"normalization_version"`
	Extraction           ExtractionV1    `json:"extraction"`
	CanonicalExtraction  json.RawMessage `json:"canonical_extraction"`
	ReceiptHash          string          `json:"receipt_hash"`
}

// MatchClass is the closed deterministic comparison result.
type MatchClass string

const (
	MatchExact      MatchClass = "exact"
	MatchEquivalent MatchClass = "equivalent"
	MatchWrong      MatchClass = "wrong"
	MatchMissing    MatchClass = "missing"
)

// AnalyzerOutputV1 is one required configuration's terminal result. A nil
// receipt with a public FailureCode represents an unavailable/error output.
type AnalyzerOutputV1 struct {
	ConfigurationID string               `json:"configuration_id"`
	Receipt         *ExtractionReceiptV1 `json:"receipt,omitempty"`
	FailureCode     string               `json:"failure_code,omitempty"`
}

type ScenarioScoreInputV1 struct {
	ScenarioID        string                  `json:"scenario_id"`
	Contract          factcontract.ContractV1 `json:"contract"`
	RequiredOutputIDs []string                `json:"required_output_ids"`
	Outputs           []AnalyzerOutputV1      `json:"outputs"`
}

type ScoreFailureV1 struct {
	Code            string `json:"code"`
	ConfigurationID string `json:"configuration_id,omitempty"`
	Detail          string `json:"detail"`
}

type CoverageV1 struct {
	Required   int      `json:"required"`
	Terminal   int      `json:"terminal"`
	Successful int      `json:"successful"`
	Ratio      float64  `json:"ratio"`
	MissingIDs []string `json:"missing_ids"`
	FailedIDs  []string `json:"failed_ids"`
}

type ComponentScoresV1 struct {
	IntentFidelity     *float64 `json:"intent_fidelity"`
	PrimaryAction      *float64 `json:"primary_action_fidelity"`
	EntityRecovery     *float64 `json:"entity_recovery"`
	AnalyzerRobustness *float64 `json:"analyzer_robustness"`
	// Surfaceability is the share of runs that said the message would be
	// mentioned at all. nil when no run answered.
	Surfaceability *float64 `json:"surfaceability"`
}

type ComponentWeightsV1 struct {
	IntentFidelity     float64 `json:"intent_fidelity"`
	PrimaryAction      float64 `json:"primary_action_fidelity"`
	EntityRecovery     float64 `json:"entity_recovery"`
	AnalyzerRobustness float64 `json:"analyzer_robustness"`
	Surfaceability     float64 `json:"surfaceability"`
}

type FactMatchResultV1 struct {
	ConfigurationID string                   `json:"configuration_id"`
	FactID          factcontract.FactID      `json:"fact_id"`
	Type            factcontract.FactType    `json:"type"`
	Criticality     factcontract.Criticality `json:"criticality"`
	Weight          float64                  `json:"weight"`
	Match           MatchClass               `json:"match"`
	Credit          float64                  `json:"credit"`
	Expected        string                   `json:"expected"`
	Observed        string                   `json:"observed,omitempty"`
	Reason          string                   `json:"reason"`
}

type OutputScoreV1 struct {
	ConfigurationID string   `json:"configuration_id"`
	IntentFidelity  float64  `json:"intent_fidelity"`
	PrimaryAction   float64  `json:"primary_action_fidelity"`
	EntityRecovery  *float64 `json:"entity_recovery"`
	Overall         float64  `json:"overall"`
}

type PairAgreementV1 struct {
	LeftConfigurationID  string  `json:"left_configuration_id"`
	RightConfigurationID string  `json:"right_configuration_id"`
	Agreement            float64 `json:"agreement"`
	ComparedItems        int     `json:"compared_items"`
}

type ScoreRangeV1 struct {
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
	Spread float64 `json:"spread"`
}

// UnsupportedClaimResultV1 remains outside every numeric component. A match
// to a sender-declared forbidden claim is an explicit contradiction.
type UnsupportedClaimResultV1 struct {
	ConfigurationID   string                          `json:"configuration_id"`
	Statement         string                          `json:"statement"`
	EvidenceIDs       []string                        `json:"evidence_ids"`
	ForbiddenClaimIDs []factcontract.ForbiddenClaimID `json:"forbidden_claim_ids"`
	Contradiction     bool                            `json:"contradiction"`
	RequiresReview    bool                            `json:"requires_review"`
}

type UndeclaredFactResultV1 struct {
	ConfigurationID string        `json:"configuration_id"`
	Fact            ExtractedFact `json:"fact"`
}

type ScenarioScoreV1 struct {
	ScoreVersion      string                        `json:"score_version"`
	ScenarioID        string                        `json:"scenario_id"`
	Complete          bool                          `json:"complete"`
	Overall           *float64                      `json:"overall"`
	Components        ComponentScoresV1             `json:"components"`
	AppliedWeights    ComponentWeightsV1            `json:"applied_weights"`
	OmittedDimensions []string                      `json:"omitted_dimensions"`
	Range             *ScoreRangeV1                 `json:"range"`
	Agreement         *float64                      `json:"agreement"`
	Coverage          CoverageV1                    `json:"coverage"`
	OutputScores      []OutputScoreV1               `json:"output_scores"`
	PairwiseAgreement []PairAgreementV1             `json:"pairwise_agreement"`
	FactResults       []FactMatchResultV1           `json:"fact_results"`
	UnsupportedClaims []UnsupportedClaimResultV1    `json:"unsupported_claims"`
	UndeclaredFacts   []UndeclaredFactResultV1      `json:"undeclared_facts"`
	HasContradictions bool                          `json:"has_contradictions"`
	Failures          []ScoreFailureV1              `json:"failures"`
	ContractErrors    factcontract.ValidationErrors `json:"contract_errors,omitempty"`
}

type ScenarioAggregateV1 struct {
	ScoreVersion      string           `json:"score_version"`
	Complete          bool             `json:"complete"`
	Worst             *float64         `json:"worst"`
	Mean              *float64         `json:"mean"`
	Range             *ScoreRangeV1    `json:"range"`
	Coverage          CoverageV1       `json:"coverage"`
	WorstScenarioIDs  []string         `json:"worst_scenario_ids"`
	HasContradictions bool             `json:"has_contradictions"`
	Failures          []ScoreFailureV1 `json:"failures"`
}
