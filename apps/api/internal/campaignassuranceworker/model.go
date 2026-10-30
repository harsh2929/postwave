// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaigncomprehension"
	"github.com/postwave/postwave/apps/api/internal/factcontract"
)

const (
	ModeledConfigurationSchemaVersionV1 = 1
	maxModeledScenariosV1               = 256

	defaultMaxModelTimeout = 60 * time.Second
	maximumModelTimeout    = 5 * time.Minute
	defaultRawOutputTTL    = 7 * 24 * time.Hour
	maximumRawOutputTTL    = 30 * 24 * time.Hour

	ModelFailureRetryable   ModelFailureKind = "retryable"
	ModelFailureError       ModelFailureKind = "error"
	ModelFailureUnavailable ModelFailureKind = "unavailable"
)

var (
	ErrModelExecution = errors.New("campaign assurance worker: modeled execution failed")

	modelConfigurationIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,95}$`)
	modelFailureCodePattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)
)

// ModeledConfigurationV1 is the closed, frozen configuration accepted by the
// modeled executor boundary. It intentionally has no tool, URL-fetch, mailbox,
// or free-form provider-options field. Each material option requires a new
// reviewed schema version instead of silently changing analyzer behavior.
type ModeledConfigurationV1 struct {
	SchemaVersion         int     `json:"schema_version"`
	ExecutorID            string  `json:"executor_id"`
	ExecutorVersion       string  `json:"executor_version"`
	ModelSuiteVersion     string  `json:"model_suite_version"`
	ModelProvider         string  `json:"model_provider"`
	ModelID               string  `json:"model_id"`
	ModelVersion          string  `json:"model_version"`
	PromptSuiteVersion    string  `json:"prompt_suite_version"`
	PromptVersion         string  `json:"prompt_version"`
	PromptHash            string  `json:"prompt_hash"`
	SeedValue             string  `json:"seed_value"`
	Temperature           float64 `json:"temperature"`
	TimeoutMS             int64   `json:"timeout_ms"`
	MaximumCostMicrounits int64   `json:"maximum_cost_microunits"`
}

// NewModeledConfiguration canonicalizes one suite configuration. Run-level
// suite identities are checked again after the immutable run is claimed.
func NewModeledConfiguration(id string, configuration ModeledConfigurationV1) (campaignassurance.ConfigurationInput, error) {
	id = strings.TrimSpace(id)
	if !modelConfigurationIDPattern.MatchString(id) {
		return campaignassurance.ConfigurationInput{}, ErrUnsupportedAnalyzer
	}
	if err := validateModeledConfigurationShape(configuration, maximumModelTimeout); err != nil {
		return campaignassurance.ConfigurationInput{}, err
	}
	raw, err := json.Marshal(configuration)
	if err != nil {
		return campaignassurance.ConfigurationInput{}, err
	}
	return campaignassurance.ConfigurationInput{
		ID: id, SourceClass: campaignassurance.SourceModeled, Configuration: raw,
	}, nil
}

// ModelExecutorIdentity identifies the reviewed adapter implementation, not a
// provider model. The identity must exactly match every configuration routed
// to the injected executor.
type ModelExecutorIdentity struct {
	ID                    string `json:"id"`
	Version               string `json:"version"`
	MaximumCostMicrounits int64  `json:"maximum_cost_microunits"`
}

// ModelExecutor is deliberately data-only. Implementations must use the exact
// frozen prompt/model identities in Request, disable provider tools, browsing,
// URL retrieval, and mailbox access, and be safe for concurrent callers. The
// worker supplies a per-call deadline and never exposes repositories or object
// stores through this interface. Identity must be side-effect-free and must not
// perform provider or network discovery.
type ModelExecutor interface {
	Identity() ModelExecutorIdentity
	Execute(context.Context, ModelRequest) (ModelResult, error)
}

// ModelRequest binds one invocation to the exact durable run target. Artifact
// representations are already bounded, hash-verified, and synthetic-only.
// Vocabulary contains identifiers and types only; sender expected values,
// forbidden claims, and intent statements are never disclosed to the model.
type ModelRequest struct {
	InvocationID         string                 `json:"invocation_id"`
	BudgetInvocationID   string                 `json:"budget_invocation_id"`
	CacheKey             string                 `json:"model_cache_key"`
	TenantID             string                 `json:"tenant_id"`
	RunID                string                 `json:"run_id"`
	AttemptCount         int                    `json:"attempt_count"`
	CampaignID           string                 `json:"campaign_id"`
	ContentRevisionID    string                 `json:"content_revision_id"`
	SendPlanID           string                 `json:"send_plan_id"`
	ArtifactID           string                 `json:"artifact_id"`
	ScenarioID           string                 `json:"scenario_id"`
	ConfigurationID      string                 `json:"configuration_id"`
	ConfigurationHash    string                 `json:"configuration_hash"`
	OutboundMIMEHash     string                 `json:"outbound_mime_hash"`
	SourceHash           string                 `json:"source_hash"`
	PlanHash             string                 `json:"plan_hash"`
	ArtifactSetHash      string                 `json:"artifact_set_hash"`
	AnalyzerSuiteVersion string                 `json:"analyzer_suite_version"`
	ModelSuiteVersion    string                 `json:"model_suite_version"`
	PromptSuiteVersion   string                 `json:"prompt_suite_version"`
	NormalizationVersion string                 `json:"normalization_version"`
	ScoringVersion       string                 `json:"scoring_version"`
	GatePolicyVersion    string                 `json:"gate_policy_version"`
	MethodologyVersion   string                 `json:"methodology_version"`
	InputManifestHash    string                 `json:"input_manifest_hash"`
	Configuration        ModeledConfigurationV1 `json:"configuration"`
	Vocabulary           RecoveryVocabularyV1   `json:"vocabulary"`
	Evidence             []ModelEvidence        `json:"evidence"`
	AllowedEvidenceIDs   []string               `json:"allowed_evidence_ids"`
	ExtractionSchema     json.RawMessage        `json:"extraction_schema"`
	MaxOutputBytes       int                    `json:"max_output_bytes"`
	// SummaryRun is the 1-based index of one run of the reviewed summarisation
	// configuration, and is zero for every other configuration.
	//
	// It is an ordinal, not a knob. It exists because the summary-stability
	// member of the frozen suite is asked the SAME reviewed question N times and
	// an executor needs to vary its own sampling between those runs; nothing
	// about the prompt, model, or policy travels through it, and its only
	// accepted values are 1..campaignchecks.SummaryRunCount.
	SummaryRun int           `json:"summary_run,omitempty"`
	Artifact   ModelArtifact `json:"-"`
}

// ModelArtifact is the complete closed input surface. There are no callbacks,
// URLs to dereference, recipient records, or Fact Contract answer values.
type ModelArtifact struct {
	Subject        string
	HTML           string
	PlainText      string
	StructuredData json.RawMessage
	RFC822         []byte
}

type RecoveryVocabularyV1 struct {
	SchemaVersion int                `json:"schema_version"`
	PrimaryAction RecoveryActionSlot `json:"primary_action"`
	FactSlots     []RecoveryFactSlot `json:"fact_slots"`
}

type RecoveryActionSlot struct {
	ActionID string `json:"action_id"`
	BlockID  string `json:"block_id"`
}

type RecoveryFactSlot struct {
	FactID string `json:"fact_id"`
	Type   string `json:"type"`
}

type ModelEvidence struct {
	ID             string `json:"id"`
	Representation string `json:"representation"`
	Location       string `json:"location,omitempty"`
	SHA256         string `json:"sha256"`
}

type ModelProvenance struct {
	ExecutorID      string  `json:"executor_id"`
	ExecutorVersion string  `json:"executor_version"`
	ModelProvider   string  `json:"model_provider"`
	ModelID         string  `json:"model_id"`
	ModelVersion    string  `json:"model_version"`
	PromptVersion   string  `json:"prompt_version"`
	PromptHash      string  `json:"prompt_hash"`
	SeedValue       string  `json:"seed_value"`
	Temperature     float64 `json:"temperature"`
}

// ModelResult contains only the provider's structured output and metering.
// RawExtraction is rejected above campaigncomprehension.MaxExtractionBytes.
type ModelResult struct {
	RawExtraction  []byte          `json:"raw_extraction"`
	Provenance     ModelProvenance `json:"provenance"`
	InputTokens    int64           `json:"input_tokens"`
	OutputTokens   int64           `json:"output_tokens"`
	CostMicrounits int64           `json:"cost_microunits"`
}

type ModelFailureKind string

// ModelExecutionFailure is the only terminal error an executor may classify.
// Code is a bounded public reason; provider error text must not be placed here.
// Unknown errors are treated as retryable infrastructure failures.
type ModelExecutionFailure struct {
	Code string
	Kind ModelFailureKind
}

func (e *ModelExecutionFailure) Error() string {
	if e == nil {
		return "modeled execution failure"
	}
	return "modeled execution failure: " + strings.TrimSpace(e.Code)
}

type modeledPreparation struct {
	configuration ModeledConfigurationV1
	unavailable   *unavailableSpec
}

type modeledPreparationSet struct {
	byConfiguration map[string]modeledPreparation
	// targetConfigurations holds only the ANALYZER configurations per artifact.
	//
	// The summary-stability configuration is modeled but is not an ensemble
	// member: it answers a different question and produces no comprehension
	// extraction. Counting it here would let one analyzer plus one summariser
	// satisfy the two-distinct-analyzer rule, which is the rule that stops a
	// single model's opinion from being scored as agreement.
	targetConfigurations  map[string][]string
	summaryConfigurations map[string]struct{}
	scenarioLimitExceeded bool
}

func (p modeledPreparationSet) isSummaryStability(configurationID string) bool {
	_, exists := p.summaryConfigurations[configurationID]
	return exists
}

type modeledAnalyzerIdentity struct {
	ModelProvider string
	ModelID       string
	ModelVersion  string
	PromptVersion string
	PromptHash    string
	SeedValue     string
	Temperature   float64
}

func (w *Worker) prepareModeledConfigurations(claimed *campaignassurance.ClaimedRun) modeledPreparationSet {
	prepared := modeledPreparationSet{
		byConfiguration:       make(map[string]modeledPreparation),
		targetConfigurations:  make(map[string][]string),
		summaryConfigurations: make(map[string]struct{}),
	}
	// Identify the summary-stability configurations before the ensemble map is
	// built. A configuration that fails to decode is not classified here at all;
	// it falls through to the shape validation below and becomes unavailable,
	// so an unparseable configuration can never be mistaken for a summariser.
	for _, configuration := range claimed.Configurations {
		if configuration.SourceClass != campaignassurance.SourceModeled {
			continue
		}
		decoded, err := decodeModeledConfiguration(configuration.Configuration)
		if err == nil && isSummaryStabilityConfiguration(decoded) {
			prepared.summaryConfigurations[configuration.ID] = struct{}{}
		}
	}
	hasModeled := false
	for _, target := range claimed.Targets {
		if target.SourceClass == campaignassurance.SourceModeled {
			hasModeled = true
			if prepared.isSummaryStability(target.ConfigurationID) {
				continue
			}
			prepared.targetConfigurations[target.ArtifactID] = append(
				prepared.targetConfigurations[target.ArtifactID], target.ConfigurationID,
			)
		}
	}
	if !hasModeled {
		return prepared
	}
	prepared.scenarioLimitExceeded = len(prepared.targetConfigurations) > maxModeledScenariosV1
	if prepared.scenarioLimitExceeded {
		return prepared
	}
	if w.ModelExecutor == nil {
		spec := unsupportedSourceSpec(campaignassurance.SourceModeled)
		for _, configuration := range claimed.Configurations {
			if configuration.SourceClass == campaignassurance.SourceModeled {
				copy := spec
				prepared.byConfiguration[configuration.ID] = modeledPreparation{unavailable: &copy}
			}
		}
		return prepared
	}
	if w.RawOutputs == nil {
		spec := modeledRawOutputStoreUnavailableSpec()
		for _, configuration := range claimed.Configurations {
			if configuration.SourceClass == campaignassurance.SourceModeled {
				copy := spec
				prepared.byConfiguration[configuration.ID] = modeledPreparation{unavailable: &copy}
			}
		}
		return prepared
	}

	identity := w.ModelExecutor.Identity()
	identityValid := validModelText(identity.ID, 100) && validModelText(identity.Version, 160)
	for _, configuration := range claimed.Configurations {
		if configuration.SourceClass != campaignassurance.SourceModeled {
			continue
		}
		decoded, err := decodeModeledConfiguration(configuration.Configuration)
		if err == nil {
			err = validateModeledConfigurationForRun(decoded, claimed.Run, w.Config.MaxModelTimeout)
		}
		if err == nil && (!identityValid || decoded.ExecutorID != identity.ID || decoded.ExecutorVersion != identity.Version) {
			err = ErrUnsupportedAnalyzer
		}
		if err == nil && decoded.MaximumCostMicrounits != identity.MaximumCostMicrounits {
			err = ErrUnsupportedAnalyzer
		}
		if err != nil {
			spec := modeledConfigurationUnavailableSpec()
			prepared.byConfiguration[configuration.ID] = modeledPreparation{unavailable: &spec}
			continue
		}
		prepared.byConfiguration[configuration.ID] = modeledPreparation{configuration: decoded}
	}
	return prepared
}

func (p modeledPreparationSet) forTarget(target campaignassurance.RunTarget) modeledPreparation {
	if p.scenarioLimitExceeded {
		spec := modeledScenarioLimitUnavailableSpec()
		return modeledPreparation{unavailable: &spec}
	}
	prepared, ok := p.byConfiguration[target.ConfigurationID]
	if !ok {
		spec := modeledConfigurationUnavailableSpec()
		return modeledPreparation{unavailable: &spec}
	}
	if prepared.unavailable != nil {
		return prepared
	}
	if p.isSummaryStability(target.ConfigurationID) {
		// The analyzer-robustness rubric is about two analyzers disagreeing
		// about one artifact. Summary stability measures one summariser
		// disagreeing with itself across N runs, which is its own robustness
		// argument and does not need a second configuration to be meaningful.
		return prepared
	}
	required := p.targetConfigurations[target.ArtifactID]
	if len(required) < 2 {
		spec := modeledEnsembleUnavailableSpec()
		return modeledPreparation{unavailable: &spec}
	}
	identities := make(map[modeledAnalyzerIdentity]struct{}, len(required))
	for _, configurationID := range required {
		member, exists := p.byConfiguration[configurationID]
		if !exists || member.unavailable != nil {
			spec := modeledEnsembleUnavailableSpec()
			return modeledPreparation{unavailable: &spec}
		}
		identity := modeledAnalyzerIdentity{
			ModelProvider: member.configuration.ModelProvider,
			ModelID:       member.configuration.ModelID,
			ModelVersion:  member.configuration.ModelVersion,
			PromptVersion: member.configuration.PromptVersion,
			PromptHash:    member.configuration.PromptHash,
			SeedValue:     member.configuration.SeedValue,
			Temperature:   member.configuration.Temperature,
		}
		if _, duplicate := identities[identity]; duplicate {
			spec := modeledEnsembleUnavailableSpec()
			return modeledPreparation{unavailable: &spec}
		}
		identities[identity] = struct{}{}
	}
	return prepared
}

func modeledScenarioLimitUnavailableSpec() unavailableSpec {
	return unavailableSpec{
		errorCode: "modeled_scenario_limit_exceeded",
		message:   "the modeled scenario set exceeds the pinned score-v1 bound",
		code:      "MODELED_SCENARIO_LIMIT_UNAVAILABLE", severity: "critical", blocking: true,
		dimension:   "modeled_comprehension",
		explanation: "The required scenario set is larger than the reviewed score-v1 aggregation bound; no partial model subset was executed and no aggregate was fabricated.",
		remediation: "reduce_or_partition_modeled_scenarios",
	}
}

func decodeModeledConfiguration(raw json.RawMessage) (ModeledConfigurationV1, error) {
	var configuration ModeledConfigurationV1
	if len(raw) > 64<<10 || decodeStrict(raw, &configuration) != nil {
		return ModeledConfigurationV1{}, ErrUnsupportedAnalyzer
	}
	return configuration, nil
}

func validateModeledConfigurationForRun(configuration ModeledConfigurationV1, run campaignassurance.Run, maxTimeout time.Duration) error {
	if err := validateModeledConfigurationShape(configuration, maxTimeout); err != nil {
		return err
	}
	if !validModelText(run.AnalyzerSuiteVersion, 200) || !validModelText(run.ModelSuiteVersion, 200) ||
		!validModelText(run.PromptSuiteVersion, 160) || !validHash(run.PromptSuiteHash) ||
		!validModelText(run.GatePolicyVersion, 160) || !validModelText(run.MethodologyVersion, 200) ||
		configuration.ModelSuiteVersion != run.ModelSuiteVersion ||
		configuration.PromptSuiteVersion != run.PromptSuiteVersion ||
		configuration.PromptHash != run.PromptSuiteHash ||
		run.NormalizationVersion != campaigncomprehension.ExtractionNormalizationVersionV1 ||
		run.ScoringVersion != campaigncomprehension.ScoreVersionV1 {
		return ErrUnsupportedAnalyzer
	}
	return nil
}

func validateModeledConfigurationShape(configuration ModeledConfigurationV1, maxTimeout time.Duration) error {
	if maxTimeout <= 0 || maxTimeout > maximumModelTimeout {
		maxTimeout = maximumModelTimeout
	}
	if configuration.SchemaVersion != ModeledConfigurationSchemaVersionV1 ||
		!validModelText(configuration.ExecutorID, 100) ||
		!validModelText(configuration.ExecutorVersion, 160) ||
		!validModelText(configuration.ModelSuiteVersion, 200) ||
		!validModelText(configuration.ModelProvider, 100) ||
		!validModelText(configuration.ModelID, 200) ||
		!validModelText(configuration.ModelVersion, 200) ||
		!validModelText(configuration.PromptSuiteVersion, 160) ||
		!validModelText(configuration.PromptVersion, 160) ||
		!validHash(configuration.PromptHash) ||
		!validModelText(configuration.SeedValue, 160) ||
		math.IsNaN(configuration.Temperature) || math.IsInf(configuration.Temperature, 0) ||
		configuration.Temperature < 0 || configuration.Temperature > 2 ||
		configuration.TimeoutMS < 100 || configuration.TimeoutMS > maxTimeout.Milliseconds() ||
		configuration.MaximumCostMicrounits < 1 ||
		configuration.MaximumCostMicrounits > campaignassurance.MaximumModeledInvocationCostMicrounits {
		return ErrUnsupportedAnalyzer
	}
	return nil
}

func validModelText(value string, maxRunes int) bool {
	if value == "" || value != strings.TrimSpace(value) || !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxRunes {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}

func modeledConfigurationUnavailableSpec() unavailableSpec {
	return unavailableSpec{
		errorCode: "modeled_configuration_unsupported",
		message:   "the frozen modeled configuration or run methodology is not executable by this worker",
		code:      "MODELED_CONFIGURATION_UNAVAILABLE", severity: "warning", dimension: "modeled_comprehension",
		explanation: "The frozen model, prompt, normalization, scoring, timeout, or executor identity is unsupported; no model was invoked and no comprehension success was inferred.",
		remediation: "rerun_with_supported_modeled_suite",
	}
}

func modeledRawOutputStoreUnavailableSpec() unavailableSpec {
	return unavailableSpec{
		errorCode: "modeled_raw_output_store_unavailable",
		message:   "modeled execution requires tenant-scoped encrypted raw-output retention",
		code:      "MODELED_RAW_OUTPUT_STORE_UNAVAILABLE", severity: "critical", blocking: true,
		dimension:   "modeled_comprehension",
		explanation: "No durable encrypted raw-output writer is configured, so a model was not invoked and an unauditable extraction was not accepted.",
		remediation: "configure_raw_output_store",
	}
}

func modeledEnsembleUnavailableSpec() unavailableSpec {
	return unavailableSpec{
		errorCode: "modeled_ensemble_incomplete",
		message:   "predicted comprehension scoring requires at least two distinct frozen modeled configurations for this scenario",
		code:      "MODELED_ENSEMBLE_UNAVAILABLE", severity: "warning", dimension: "modeled_comprehension",
		explanation: "A single or duplicate modeled configuration cannot satisfy the pinned analyzer-robustness rubric; no model was invoked and no score was fabricated.",
		remediation: "configure_modeled_ensemble",
	}
}

func normalizedFactContract(raw json.RawMessage) (factcontract.ContractV1, error) {
	var contract factcontract.ContractV1
	if len(raw) == 0 || len(raw) > 256<<10 || decodeStrict(raw, &contract) != nil {
		return factcontract.ContractV1{}, ErrUnsupportedAnalyzer
	}
	normalized, diagnostics := factcontract.NormalizeAndValidateV1(contract)
	if len(diagnostics) != 0 {
		return factcontract.ContractV1{}, ErrUnsupportedAnalyzer
	}
	return normalized, nil
}

func recoveryVocabulary(contract factcontract.ContractV1) RecoveryVocabularyV1 {
	result := RecoveryVocabularyV1{
		SchemaVersion: 1,
		PrimaryAction: RecoveryActionSlot{
			ActionID: string(contract.PrimaryAction.ActionID),
			BlockID:  string(contract.PrimaryAction.BlockID),
		},
		FactSlots: make([]RecoveryFactSlot, 0, len(contract.RequiredFacts)),
	}
	for _, fact := range contract.RequiredFacts {
		result.FactSlots = append(result.FactSlots, RecoveryFactSlot{FactID: string(fact.ID), Type: string(fact.Type)})
	}
	sort.Slice(result.FactSlots, func(i, j int) bool { return result.FactSlots[i].FactID < result.FactSlots[j].FactID })
	return result
}

func validatedExecutionFailure(err error) (*ModelExecutionFailure, bool) {
	var failure *ModelExecutionFailure
	if !errors.As(err, &failure) || failure == nil {
		return nil, false
	}
	failure = &ModelExecutionFailure{Code: strings.TrimSpace(failure.Code), Kind: failure.Kind}
	if !modelFailureCodePattern.MatchString(failure.Code) {
		return nil, false
	}
	switch failure.Kind {
	case ModelFailureRetryable, ModelFailureError, ModelFailureUnavailable:
		return failure, true
	default:
		return nil, false
	}
}

func validModelResultUsage(result ModelResult) bool {
	const maximum = int64(1_000_000_000_000)
	return result.InputTokens >= 0 && result.InputTokens <= maximum &&
		result.OutputTokens >= 0 && result.OutputTokens <= maximum &&
		result.CostMicrounits >= 0 && result.CostMicrounits <= maximum
}

func provenanceMatches(actual ModelProvenance, expected ModeledConfigurationV1) bool {
	return actual.ExecutorID == expected.ExecutorID &&
		actual.ExecutorVersion == expected.ExecutorVersion &&
		actual.ModelProvider == expected.ModelProvider &&
		actual.ModelID == expected.ModelID &&
		actual.ModelVersion == expected.ModelVersion &&
		actual.PromptVersion == expected.PromptVersion &&
		actual.PromptHash == expected.PromptHash &&
		actual.SeedValue == expected.SeedValue &&
		actual.Temperature == expected.Temperature
}

func modeledFactContractUnavailableSpec() unavailableSpec {
	return unavailableSpec{
		errorCode: "modeled_fact_contract_invalid",
		message:   "the frozen Fact Contract cannot support predicted comprehension scoring",
		code:      "MODELED_FACT_CONTRACT_UNAVAILABLE", severity: "critical", blocking: true,
		dimension:   "modeled_comprehension",
		explanation: "The sender oracle is absent or invalid, so model output cannot be scored without inventing expected intent, action, or facts.",
		remediation: "repair_fact_contract",
	}
}

func retryableModelError(code string) error {
	return fmt.Errorf("%w: %s", ErrModelExecution, code)
}
