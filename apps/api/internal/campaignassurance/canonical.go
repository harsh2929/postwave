// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	defaultMaxAttempts    = 3
	maxConfigurations     = 64
	maxJSONReceiptSize    = 128 << 10
	maxWorkerIDRunes      = 200
	objectReferencePrefix = "postwave.tenant-object-ref.v1:"
)

var (
	hashPattern            = regexp.MustCompile(`^[0-9a-f]{64}$`)
	configurationPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,95}$`)
	failureCodePattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)
	findingCodePattern     = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,95}$`)
	dimensionPattern       = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,95}$`)
	objectReferenceSegment = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$`)
)

func canonicalJSON(raw json.RawMessage, expected string, maxBytes int) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, fmt.Errorf("%w: JSON value is required", ErrInvalidInput)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("%w: invalid JSON", ErrInvalidInput)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("%w: trailing JSON data", ErrInvalidInput)
	}
	switch expected {
	case "object":
		if _, ok := value.(map[string]any); !ok {
			return nil, fmt.Errorf("%w: JSON object required", ErrInvalidInput)
		}
	case "array":
		if _, ok := value.([]any); !ok {
			return nil, fmt.Errorf("%w: JSON array required", ErrInvalidInput)
		}
	case "any":
	default:
		return nil, fmt.Errorf("%w: invalid expected JSON kind", ErrInvalidInput)
	}
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) > maxBytes {
		return nil, fmt.Errorf("%w: JSON value exceeds limit", ErrInvalidInput)
	}
	return encoded, nil
}

func digest(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func validText(value string, maxRunes int) bool {
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxRunes {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}

func canonicalUUID(value string) (string, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	return parsed.String(), nil
}

func validObjectReference(value string) bool {
	if !strings.HasPrefix(value, objectReferencePrefix) || !validText(value, 2000) {
		return false
	}
	segments := strings.Split(strings.TrimPrefix(value, objectReferencePrefix), "/")
	if len(segments) < 3 || len(segments) > 32 ||
		segments[0] != "campaign-assurance" || segments[1] != "raw-output" {
		return false
	}
	for _, segment := range segments[2:] {
		if !objectReferenceSegment.MatchString(segment) {
			return false
		}
	}
	return true
}

func validTrigger(value string) bool {
	switch value {
	case TriggerDraft, TriggerExplicit, TriggerQueue, TriggerSeed, TriggerScheduledRecheck:
		return true
	default:
		return false
	}
}

func validProfile(value string) bool {
	switch value {
	case ProfileFast, ProfileFull, ProfileCalibration:
		return true
	default:
		return false
	}
}

func validConfigurationSource(value string) bool {
	switch value {
	case SourceDeterministic, SourceModeled, SourceControlledObservation:
		return true
	default:
		return false
	}
}

func normalizeConfigurations(inputs []ConfigurationInput) ([]ConfigurationInput, []string, string, error) {
	if len(inputs) == 0 || len(inputs) > maxConfigurations {
		return nil, nil, "", fmt.Errorf("%w: 1..%d configurations required", ErrInvalidInput, maxConfigurations)
	}
	normalized := make([]ConfigurationInput, len(inputs))
	hashes := make([]string, len(inputs))
	seen := make(map[string]struct{}, len(inputs))
	type manifestItem struct {
		Ordinal           int    `json:"ordinal"`
		ID                string `json:"id"`
		SourceClass       string `json:"source_class"`
		ConfigurationHash string `json:"configuration_hash"`
	}
	manifest := make([]manifestItem, len(inputs))
	for index, input := range inputs {
		input.ID = strings.TrimSpace(input.ID)
		input.SourceClass = strings.TrimSpace(input.SourceClass)
		if !configurationPattern.MatchString(input.ID) || !validConfigurationSource(input.SourceClass) {
			return nil, nil, "", fmt.Errorf("%w: invalid analyzer configuration identity", ErrInvalidInput)
		}
		if _, duplicate := seen[input.ID]; duplicate {
			return nil, nil, "", fmt.Errorf("%w: duplicate configuration %q", ErrInvalidInput, input.ID)
		}
		seen[input.ID] = struct{}{}
		configuration, err := canonicalJSON(input.Configuration, "object", 64<<10)
		if err != nil {
			return nil, nil, "", fmt.Errorf("configuration %q: %w", input.ID, err)
		}
		hash, err := digest(json.RawMessage(configuration))
		if err != nil {
			return nil, nil, "", err
		}
		input.Configuration = configuration
		normalized[index] = input
		hashes[index] = hash
		manifest[index] = manifestItem{
			Ordinal: index + 1, ID: input.ID, SourceClass: input.SourceClass,
			ConfigurationHash: hash,
		}
	}
	manifestHash, err := digest(manifest)
	return normalized, hashes, manifestHash, err
}

func normalizeCreateInput(input CreateRunInput) (CreateRunInput, []string, string, error) {
	// A struct copy aliases caller-owned slices. Clone before any normalization
	// work so concurrent reuse cannot observe or be affected by our mutations.
	input.Targets = append([]TargetInput(nil), input.Targets...)
	var err error
	if input.CampaignID, err = canonicalUUID(input.CampaignID); err != nil {
		return CreateRunInput{}, nil, "", fmt.Errorf("%w: invalid campaign identity", ErrInvalidInput)
	}
	if input.ContentRevisionID, err = canonicalUUID(input.ContentRevisionID); err != nil {
		return CreateRunInput{}, nil, "", fmt.Errorf("%w: invalid revision identity", ErrInvalidInput)
	}
	if input.SendPlanID, err = canonicalUUID(input.SendPlanID); err != nil {
		return CreateRunInput{}, nil, "", fmt.Errorf("%w: invalid plan identity", ErrInvalidInput)
	}
	if input.RequestID, err = canonicalUUID(input.RequestID); err != nil {
		return CreateRunInput{}, nil, "", fmt.Errorf("%w: invalid campaign/revision/plan/request identity", ErrInvalidInput)
	}
	if strings.TrimSpace(input.CreatedBy) != "" {
		if input.CreatedBy, err = canonicalUUID(input.CreatedBy); err != nil {
			return CreateRunInput{}, nil, "", fmt.Errorf("%w: invalid actor identity", ErrInvalidInput)
		}
	}
	input.TriggerKind = strings.TrimSpace(input.TriggerKind)
	input.Profile = strings.TrimSpace(input.Profile)
	if !validTrigger(input.TriggerKind) || !validProfile(input.Profile) {
		return CreateRunInput{}, nil, "", fmt.Errorf("%w: unsupported trigger or profile", ErrInvalidInput)
	}
	versions := []*string{
		&input.AnalyzerSuiteVersion, &input.ModelSuiteVersion,
		&input.PromptSuiteVersion, &input.NormalizationVersion,
		&input.ScoringVersion, &input.GatePolicyVersion,
		&input.MethodologyVersion,
	}
	for _, version := range versions {
		*version = strings.TrimSpace(*version)
		if !validText(*version, 160) {
			return CreateRunInput{}, nil, "", fmt.Errorf("%w: incomplete methodology identity", ErrInvalidInput)
		}
	}
	if !hashPattern.MatchString(input.PromptSuiteHash) {
		return CreateRunInput{}, nil, "", fmt.Errorf("%w: invalid prompt suite hash", ErrInvalidInput)
	}
	if input.MaxAttempts == 0 {
		input.MaxAttempts = defaultMaxAttempts
	}
	if input.MaxAttempts < 1 || input.MaxAttempts > 20 {
		return CreateRunInput{}, nil, "", fmt.Errorf("%w: max_attempts must be 1..20", ErrInvalidInput)
	}
	configs, hashes, manifestHash, err := normalizeConfigurations(input.Configurations)
	if err != nil {
		return CreateRunInput{}, nil, "", err
	}
	input.Configurations = configs
	if len(input.Targets) > 100000 {
		return CreateRunInput{}, nil, "", fmt.Errorf("%w: too many assurance targets", ErrInvalidInput)
	}
	seenTargets := make(map[string]struct{}, len(input.Targets))
	knownConfigurations := make(map[string]struct{}, len(configs))
	for _, configuration := range configs {
		knownConfigurations[configuration.ID] = struct{}{}
	}
	for index := range input.Targets {
		input.Targets[index].ConfigurationID = strings.TrimSpace(input.Targets[index].ConfigurationID)
		input.Targets[index].ArtifactID, err = canonicalUUID(input.Targets[index].ArtifactID)
		if err != nil || !configurationPattern.MatchString(input.Targets[index].ConfigurationID) {
			return CreateRunInput{}, nil, "", fmt.Errorf("%w: invalid assurance target", ErrInvalidInput)
		}
		if _, exists := knownConfigurations[input.Targets[index].ConfigurationID]; !exists {
			return CreateRunInput{}, nil, "", fmt.Errorf("%w: target references unknown configuration", ErrInvalidInput)
		}
		key := input.Targets[index].ArtifactID + "\x00" + input.Targets[index].ConfigurationID
		if _, duplicate := seenTargets[key]; duplicate {
			return CreateRunInput{}, nil, "", fmt.Errorf("%w: duplicate assurance target", ErrInvalidInput)
		}
		seenTargets[key] = struct{}{}
	}
	return input, hashes, manifestHash, nil
}

func validFiniteRange(value *float64, minimum, maximum float64) bool {
	return value == nil || (!math.IsNaN(*value) && !math.IsInf(*value, 0) && *value >= minimum && *value <= maximum)
}

func normalizeFinalizeInput(input FinalizeInput, evidenceComplete bool) (FinalizeInput, error) {
	if len(bytes.TrimSpace(input.ComponentScores)) > 0 {
		value, err := canonicalJSON(input.ComponentScores, "object", 64<<10)
		if err != nil {
			return FinalizeInput{}, err
		}
		input.ComponentScores = value
	} else {
		input.ComponentScores = nil
	}
	if !validFiniteRange(input.OverallScore, 0, 100) ||
		!validFiniteRange(input.ScoreMin, 0, 100) ||
		!validFiniteRange(input.ScoreMax, 0, 100) ||
		!validFiniteRange(input.Agreement, 0, 1) {
		return FinalizeInput{}, fmt.Errorf("%w: invalid score or agreement", ErrInvalidReceipt)
	}
	if (input.ScoreMin == nil) != (input.ScoreMax == nil) ||
		(input.ScoreMin != nil && *input.ScoreMin > *input.ScoreMax) {
		return FinalizeInput{}, fmt.Errorf("%w: invalid score range", ErrInvalidReceipt)
	}
	if input.OverallScore != nil && input.ScoreMin != nil &&
		(*input.OverallScore < *input.ScoreMin || *input.OverallScore > *input.ScoreMax) {
		return FinalizeInput{}, fmt.Errorf("%w: overall score outside range", ErrInvalidReceipt)
	}
	if evidenceComplete {
		if input.GateDecision != GatePass && input.GateDecision != GateWarn && input.GateDecision != GateBlock {
			return FinalizeInput{}, fmt.Errorf("%w: complete evidence requires a terminal gate decision", ErrInvalidReceipt)
		}
	} else {
		input.GateDecision = GateUnavailable
		input.ComponentScores = nil
		input.OverallScore = nil
		input.ScoreMin = nil
		input.ScoreMax = nil
		input.Agreement = nil
	}
	return input, nil
}

func normalizeFailure(input RunFailure) (RunFailure, error) {
	input.Code = strings.TrimSpace(input.Code)
	input.Message = strings.TrimSpace(input.Message)
	if !failureCodePattern.MatchString(input.Code) || !validText(input.Message, 1000) {
		return RunFailure{}, fmt.Errorf("%w: invalid public failure", ErrInvalidInput)
	}
	return input, nil
}

type extractionReceiptIdentity struct {
	ArtifactID                   string          `json:"artifact_id"`
	ConfigurationID              string          `json:"configuration_id"`
	SourceClass                  string          `json:"source_class"`
	ConfigurationHash            string          `json:"configuration_hash"`
	OutboundMIMEHash             string          `json:"outbound_mime_hash"`
	Status                       string          `json:"status"`
	NormalizedExtraction         json.RawMessage `json:"normalized_extraction"`
	EvidenceManifest             json.RawMessage `json:"evidence_manifest"`
	UnsupportedClaims            json.RawMessage `json:"unsupported_claims"`
	Ambiguities                  json.RawMessage `json:"ambiguities"`
	RawOutputHash                string          `json:"raw_output_hash"`
	ModelProvider                string          `json:"model_provider"`
	ModelID                      string          `json:"model_id"`
	ModelVersion                 string          `json:"model_version"`
	PromptVersion                string          `json:"prompt_version"`
	PromptHash                   string          `json:"prompt_hash"`
	SeedValue                    string          `json:"seed_value"`
	Temperature                  *float64        `json:"temperature"`
	InputTokens                  int64           `json:"input_tokens"`
	OutputTokens                 int64           `json:"output_tokens"`
	CostMicrounits               int64           `json:"cost_microunits"`
	LatencyMS                    int64           `json:"latency_ms"`
	ErrorCode                    string          `json:"error_code"`
	ErrorMessage                 string          `json:"error_message"`
	ModelCacheKey                string          `json:"model_cache_key"`
	ModelInputManifestHash       string          `json:"model_input_manifest_hash"`
	ModelInvocationID            string          `json:"model_invocation_id"`
	ExecutionKind                string          `json:"execution_kind"`
	ReusedFromExtractionID       string          `json:"reused_from_extraction_id"`
	ReusedFromReceiptHash        string          `json:"reused_from_receipt_hash"`
	ReusedOriginalCostMicrounits int64           `json:"reused_original_cost_microunits"`
}

func normalizeExtractionInput(input ExtractionInput) (ExtractionInput, string, error) {
	var err error
	input.ArtifactID, err = canonicalUUID(input.ArtifactID)
	if err != nil || !configurationPattern.MatchString(input.ConfigurationID) ||
		!hashPattern.MatchString(input.ConfigurationHash) || !hashPattern.MatchString(input.OutboundMIMEHash) ||
		!validConfigurationSource(input.SourceClass) {
		return ExtractionInput{}, "", fmt.Errorf("%w: invalid extraction target identity", ErrInvalidReceipt)
	}
	input.ModelProvider = strings.TrimSpace(input.ModelProvider)
	input.ModelID = strings.TrimSpace(input.ModelID)
	input.ModelVersion = strings.TrimSpace(input.ModelVersion)
	input.PromptVersion = strings.TrimSpace(input.PromptVersion)
	input.SeedValue = strings.TrimSpace(input.SeedValue)
	input.ErrorCode = strings.TrimSpace(input.ErrorCode)
	input.ErrorMessage = strings.TrimSpace(input.ErrorMessage)
	input.RawOutputObjectRef = strings.TrimSpace(input.RawOutputObjectRef)
	input.ModelCacheKey = strings.TrimSpace(input.ModelCacheKey)
	input.ModelInputManifestHash = strings.TrimSpace(input.ModelInputManifestHash)
	input.ModelInvocationID = strings.TrimSpace(input.ModelInvocationID)
	input.ExecutionKind = strings.TrimSpace(input.ExecutionKind)
	input.ReusedFromExtractionID = strings.TrimSpace(input.ReusedFromExtractionID)
	input.ReusedFromReceiptHash = strings.TrimSpace(input.ReusedFromReceiptHash)
	if input.InputTokens < 0 || input.OutputTokens < 0 || input.CostMicrounits < 0 || input.LatencyMS < 0 ||
		input.ReusedOriginalCostMicrounits < 0 || !validFiniteRange(input.Temperature, 0, 2) {
		return ExtractionInput{}, "", fmt.Errorf("%w: invalid extraction usage", ErrInvalidReceipt)
	}
	if len(bytes.TrimSpace(input.EvidenceManifest)) == 0 {
		input.EvidenceManifest = json.RawMessage(`{}`)
	}
	if input.EvidenceManifest, err = canonicalJSON(input.EvidenceManifest, "object", 64<<10); err != nil {
		return ExtractionInput{}, "", err
	}
	if len(bytes.TrimSpace(input.UnsupportedClaims)) == 0 {
		input.UnsupportedClaims = json.RawMessage(`[]`)
	}
	if input.UnsupportedClaims, err = canonicalJSON(input.UnsupportedClaims, "array", 64<<10); err != nil {
		return ExtractionInput{}, "", err
	}
	if len(bytes.TrimSpace(input.Ambiguities)) == 0 {
		input.Ambiguities = json.RawMessage(`[]`)
	}
	if input.Ambiguities, err = canonicalJSON(input.Ambiguities, "array", 64<<10); err != nil {
		return ExtractionInput{}, "", err
	}
	switch input.Status {
	case ExtractionComplete:
		if input.NormalizedExtraction, err = canonicalJSON(input.NormalizedExtraction, "object", maxJSONReceiptSize); err != nil {
			return ExtractionInput{}, "", err
		}
		if input.ErrorCode != "" || input.ErrorMessage != "" {
			return ExtractionInput{}, "", fmt.Errorf("%w: complete extraction cannot carry an error", ErrInvalidReceipt)
		}
	case ExtractionError, ExtractionUnavailable:
		if len(bytes.TrimSpace(input.NormalizedExtraction)) != 0 ||
			!failureCodePattern.MatchString(input.ErrorCode) || !validText(input.ErrorMessage, 1000) {
			return ExtractionInput{}, "", fmt.Errorf("%w: failed extraction requires a bounded public error", ErrInvalidReceipt)
		}
		input.NormalizedExtraction = nil
	default:
		return ExtractionInput{}, "", fmt.Errorf("%w: invalid extraction status", ErrInvalidReceipt)
	}
	if input.SourceClass == SourceModeled {
		if input, err = normalizeModeledProvenance(input); err != nil {
			return ExtractionInput{}, "", err
		}
	} else if err = validateNonModeledProvenance(input); err != nil {
		return ExtractionInput{}, "", err
	}
	if input.SeedValue != "" && !validText(input.SeedValue, 160) {
		return ExtractionInput{}, "", fmt.Errorf("%w: invalid seed value", ErrInvalidReceipt)
	}
	hasRaw := input.RawOutputObjectRef != "" || input.RawOutputHash != "" || input.RawOutputExpiresAt != nil
	if hasRaw {
		if !validObjectReference(input.RawOutputObjectRef) ||
			!hashPattern.MatchString(input.RawOutputHash) ||
			input.RawOutputExpiresAt == nil || !input.RawOutputExpiresAt.After(time.Now().Add(-time.Minute)) ||
			input.RawOutputExpiresAt.After(time.Now().Add(30*24*time.Hour+time.Minute)) {
			return ExtractionInput{}, "", fmt.Errorf("%w: invalid raw-output retention reference", ErrInvalidReceipt)
		}
	}
	receiptHash, err := digest(extractionReceiptIdentity{
		ArtifactID: input.ArtifactID, ConfigurationID: input.ConfigurationID,
		SourceClass: input.SourceClass, ConfigurationHash: input.ConfigurationHash,
		OutboundMIMEHash: input.OutboundMIMEHash, Status: input.Status,
		NormalizedExtraction: input.NormalizedExtraction,
		EvidenceManifest:     input.EvidenceManifest, UnsupportedClaims: input.UnsupportedClaims,
		Ambiguities: input.Ambiguities, RawOutputHash: input.RawOutputHash,
		ModelProvider: input.ModelProvider, ModelID: input.ModelID,
		ModelVersion: input.ModelVersion, PromptVersion: input.PromptVersion,
		PromptHash: input.PromptHash, SeedValue: input.SeedValue,
		Temperature: input.Temperature, InputTokens: input.InputTokens,
		OutputTokens: input.OutputTokens, CostMicrounits: input.CostMicrounits,
		LatencyMS: input.LatencyMS, ErrorCode: input.ErrorCode,
		ErrorMessage: input.ErrorMessage, ModelCacheKey: input.ModelCacheKey,
		ModelInputManifestHash: input.ModelInputManifestHash, ModelInvocationID: input.ModelInvocationID,
		ExecutionKind: input.ExecutionKind, ReusedFromExtractionID: input.ReusedFromExtractionID,
		ReusedFromReceiptHash:        input.ReusedFromReceiptHash,
		ReusedOriginalCostMicrounits: input.ReusedOriginalCostMicrounits,
	})
	return input, receiptHash, err
}

// normalizeModeledProvenance validates the runtime identity and execution
// provenance a modeled (SourceModeled) extraction must carry, canonicalizing
// the cache-reuse source identifier in place.
func normalizeModeledProvenance(input ExtractionInput) (ExtractionInput, error) {
	var err error
	if !validText(input.ModelProvider, 100) || !validText(input.ModelID, 200) ||
		!validText(input.ModelVersion, 200) || !validText(input.PromptVersion, 160) ||
		!hashPattern.MatchString(input.PromptHash) {
		return ExtractionInput{}, fmt.Errorf("%w: modeled extraction lacks runtime identity", ErrInvalidReceipt)
	}
	switch input.ExecutionKind {
	case "":
		if input.ModelCacheKey != "" || input.ModelInputManifestHash != "" || input.ModelInvocationID != "" ||
			input.ReusedFromExtractionID != "" || input.ReusedFromReceiptHash != "" || input.ReusedOriginalCostMicrounits != 0 {
			return ExtractionInput{}, fmt.Errorf("%w: incomplete modeled execution provenance", ErrInvalidReceipt)
		}
	case ModeledExecutionInvoked:
		if !hashPattern.MatchString(input.ModelCacheKey) || !hashPattern.MatchString(input.ModelInputManifestHash) ||
			!hashPattern.MatchString(input.ModelInvocationID) || input.ReusedFromExtractionID != "" ||
			input.ReusedFromReceiptHash != "" || input.ReusedOriginalCostMicrounits != 0 {
			return ExtractionInput{}, fmt.Errorf("%w: invalid invoked modeled provenance", ErrInvalidReceipt)
		}
	case ModeledExecutionCacheReuse:
		if input.Status != ExtractionComplete || !hashPattern.MatchString(input.ModelCacheKey) ||
			!hashPattern.MatchString(input.ModelInputManifestHash) || !hashPattern.MatchString(input.ModelInvocationID) ||
			!hashPattern.MatchString(input.ReusedFromReceiptHash) || input.InputTokens != 0 || input.OutputTokens != 0 ||
			input.CostMicrounits != 0 || input.LatencyMS != 0 {
			return ExtractionInput{}, fmt.Errorf("%w: invalid modeled cache-reuse provenance", ErrInvalidReceipt)
		}
		if input.ReusedFromExtractionID, err = canonicalUUID(input.ReusedFromExtractionID); err != nil {
			return ExtractionInput{}, fmt.Errorf("%w: invalid modeled cache source", ErrInvalidReceipt)
		}
	default:
		return ExtractionInput{}, fmt.Errorf("%w: invalid modeled execution kind", ErrInvalidReceipt)
	}
	return input, nil
}

// validateNonModeledProvenance rejects modeled provenance on a non-modeled
// extraction and bounds the optional executor identity it may still carry.
func validateNonModeledProvenance(input ExtractionInput) error {
	if input.ModelCacheKey != "" || input.ModelInputManifestHash != "" || input.ModelInvocationID != "" ||
		input.ExecutionKind != "" || input.ReusedFromExtractionID != "" || input.ReusedFromReceiptHash != "" ||
		input.ReusedOriginalCostMicrounits != 0 {
		return fmt.Errorf("%w: non-modeled extraction has modeled provenance", ErrInvalidReceipt)
	}
	for _, value := range []struct {
		text string
		max  int
	}{{input.ModelProvider, 100}, {input.ModelID, 200}, {input.ModelVersion, 200}, {input.PromptVersion, 160}} {
		if value.text != "" && !validText(value.text, value.max) {
			return fmt.Errorf("%w: invalid optional executor identity", ErrInvalidReceipt)
		}
	}
	if input.PromptHash != "" && !hashPattern.MatchString(input.PromptHash) {
		return fmt.Errorf("%w: invalid optional prompt hash", ErrInvalidReceipt)
	}
	return nil
}

type findingKeyInput struct {
	ArtifactID         string          `json:"artifact_id"`
	ConfigurationID    string          `json:"configuration_id"`
	Code               string          `json:"code"`
	SourceClass        string          `json:"source_class"`
	Severity           string          `json:"severity"`
	Blocking           bool            `json:"blocking"`
	Overridable        bool            `json:"overridable"`
	Dimension          string          `json:"dimension"`
	BlockReferences    json.RawMessage `json:"block_references"`
	EvidenceReferences json.RawMessage `json:"evidence_references"`
	ExpectedValue      json.RawMessage `json:"expected_value"`
	ObservedValue      json.RawMessage `json:"observed_value"`
	DetectorVersion    string          `json:"detector_version"`
	PolicyVersion      string          `json:"policy_version"`
}

type findingReceiptIdentity struct {
	FindingKey              string          `json:"finding_key"`
	ConfigurationHash       string          `json:"configuration_hash"`
	OutboundMIMEHash        string          `json:"outbound_mime_hash"`
	ExtractionID            string          `json:"extraction_id"`
	Explanation             string          `json:"explanation"`
	Remediation             json.RawMessage `json:"remediation"`
	TypedPatch              json.RawMessage `json:"typed_patch"`
	TypedPatchSchemaVersion *int            `json:"typed_patch_schema_version"`
	TypedPatchHash          string          `json:"typed_patch_hash"`
}

func normalizeFindingInput(input FindingInput) (FindingInput, string, error) {
	var err error
	input.ArtifactID, err = canonicalUUID(input.ArtifactID)
	if err != nil {
		return FindingInput{}, "", fmt.Errorf("%w: invalid finding evidence identity", ErrInvalidReceipt)
	}
	if input.ExtractionID != "" {
		input.ExtractionID, err = canonicalUUID(input.ExtractionID)
		if err != nil {
			return FindingInput{}, "", fmt.Errorf("%w: invalid finding evidence identity", ErrInvalidReceipt)
		}
	}
	input.ConfigurationID = strings.TrimSpace(input.ConfigurationID)
	input.Code = strings.TrimSpace(input.Code)
	input.SourceClass = strings.TrimSpace(input.SourceClass)
	input.Severity = strings.TrimSpace(input.Severity)
	input.Dimension = strings.TrimSpace(input.Dimension)
	input.Explanation = strings.TrimSpace(input.Explanation)
	input.DetectorVersion = strings.TrimSpace(input.DetectorVersion)
	input.PolicyVersion = strings.TrimSpace(input.PolicyVersion)
	if !configurationPattern.MatchString(input.ConfigurationID) ||
		!findingCodePattern.MatchString(input.Code) ||
		!dimensionPattern.MatchString(input.Dimension) ||
		!validText(input.Explanation, 4000) ||
		!validText(input.DetectorVersion, 160) || !validText(input.PolicyVersion, 160) {
		return FindingInput{}, "", fmt.Errorf("%w: invalid finding fields", ErrInvalidReceipt)
	}
	switch input.SourceClass {
	case SourceDeterministic, SourceModeled, SourceControlledObservation:
	default:
		return FindingInput{}, "", fmt.Errorf("%w: invalid finding source", ErrInvalidReceipt)
	}
	switch input.Severity {
	case "info", "warning", "error", "critical":
	default:
		return FindingInput{}, "", fmt.Errorf("%w: invalid finding severity", ErrInvalidReceipt)
	}
	if input.BlockReferences, err = canonicalJSON(input.BlockReferences, "array", 32<<10); err != nil {
		return FindingInput{}, "", err
	}
	if input.EvidenceReferences, err = canonicalJSON(input.EvidenceReferences, "array", 32<<10); err != nil {
		return FindingInput{}, "", err
	}
	if input.Remediation, err = canonicalJSON(input.Remediation, "object", 32<<10); err != nil {
		return FindingInput{}, "", err
	}
	if len(bytes.TrimSpace(input.TypedPatch)) > 0 {
		if input.TypedPatch, err = canonicalJSON(input.TypedPatch, "object", 32<<10); err != nil {
			return FindingInput{}, "", err
		}
		if input.TypedPatchSchemaVersion == nil || *input.TypedPatchSchemaVersion < 1 ||
			*input.TypedPatchSchemaVersion > 1000 {
			return FindingInput{}, "", fmt.Errorf("%w: typed patch schema version required", ErrInvalidReceipt)
		}
	} else {
		input.TypedPatch = nil
		if input.TypedPatchSchemaVersion != nil {
			return FindingInput{}, "", fmt.Errorf("%w: typed patch schema without patch", ErrInvalidReceipt)
		}
	}
	if input.Overridable && !input.Blocking {
		return FindingInput{}, "", fmt.Errorf("%w: only blocking findings may be overridable", ErrInvalidReceipt)
	}
	for _, target := range []*json.RawMessage{&input.ExpectedValue, &input.ObservedValue} {
		if len(bytes.TrimSpace(*target)) == 0 {
			*target = nil
			continue
		}
		if *target, err = canonicalJSON(*target, "any", 32<<10); err != nil {
			return FindingInput{}, "", err
		}
	}
	key, err := digest(findingKeyInput{
		ArtifactID: input.ArtifactID, ConfigurationID: input.ConfigurationID,
		Code: input.Code, SourceClass: input.SourceClass, Severity: input.Severity,
		Blocking: input.Blocking, Overridable: input.Overridable, Dimension: input.Dimension,
		BlockReferences: input.BlockReferences, EvidenceReferences: input.EvidenceReferences,
		ExpectedValue: input.ExpectedValue, ObservedValue: input.ObservedValue,
		DetectorVersion: input.DetectorVersion, PolicyVersion: input.PolicyVersion,
	})
	return input, key, err
}

func findingReceiptHash(input FindingInput, findingKey, configurationHash, outboundMIMEHash string) (string, string, error) {
	if !hashPattern.MatchString(findingKey) || !hashPattern.MatchString(configurationHash) ||
		!hashPattern.MatchString(outboundMIMEHash) {
		return "", "", fmt.Errorf("%w: invalid finding target hash", ErrInvalidReceipt)
	}
	typedPatchHash := ""
	var err error
	if len(input.TypedPatch) > 0 {
		typedPatchHash, err = digest(json.RawMessage(input.TypedPatch))
		if err != nil {
			return "", "", err
		}
	}
	receiptHash, err := digest(findingReceiptIdentity{
		FindingKey: findingKey, ConfigurationHash: configurationHash,
		OutboundMIMEHash: outboundMIMEHash, ExtractionID: input.ExtractionID,
		Explanation: input.Explanation, Remediation: input.Remediation,
		TypedPatch: input.TypedPatch, TypedPatchSchemaVersion: input.TypedPatchSchemaVersion,
		TypedPatchHash: typedPatchHash,
	})
	return receiptHash, typedPatchHash, err
}

type overrideRequestIdentity struct {
	FindingID string     `json:"finding_id"`
	ActorID   string     `json:"actor_id"`
	ActorRole string     `json:"actor_role"`
	Decision  string     `json:"decision"`
	Reason    string     `json:"reason"`
	ExpiresAt *time.Time `json:"expires_at"`
}

func normalizeOverrideInput(input OverrideInput, actorID, actorRole string) (OverrideInput, string, error) {
	var err error
	input.FindingID, err = canonicalUUID(input.FindingID)
	if err != nil {
		return OverrideInput{}, "", fmt.Errorf("%w: invalid finding identity", ErrInvalidInput)
	}
	input.RequestID, err = canonicalUUID(input.RequestID)
	if err != nil {
		return OverrideInput{}, "", fmt.Errorf("%w: invalid request identity", ErrInvalidInput)
	}
	actorID, err = canonicalUUID(actorID)
	if err != nil {
		return OverrideInput{}, "", fmt.Errorf("%w: invalid override identity", ErrInvalidInput)
	}
	actorRole = strings.TrimSpace(actorRole)
	input.Decision = strings.TrimSpace(input.Decision)
	input.Reason = strings.TrimSpace(input.Reason)
	if (actorRole != "owner" && actorRole != "admin") ||
		(input.Decision != "allow_send" && input.Decision != "reject") ||
		!validText(input.Reason, 2000) || utf8.RuneCountInString(input.Reason) < 10 {
		return OverrideInput{}, "", fmt.Errorf("%w: invalid governed override", ErrInvalidInput)
	}
	if input.ExpiresAt != nil && !input.ExpiresAt.After(time.Now()) {
		return OverrideInput{}, "", fmt.Errorf("%w: override expiry must be in the future", ErrInvalidInput)
	}
	hash, err := digest(overrideRequestIdentity{
		FindingID: input.FindingID, ActorID: actorID, ActorRole: actorRole,
		Decision: input.Decision, Reason: input.Reason, ExpiresAt: input.ExpiresAt,
	})
	return input, hash, err
}

func stableArtifactOrder(artifacts []RunArtifact) {
	sort.Slice(artifacts, func(left, right int) bool {
		if artifacts[left].ScenarioID == artifacts[right].ScenarioID {
			return artifacts[left].ArtifactID < artifacts[right].ArtifactID
		}
		return artifacts[left].ScenarioID < artifacts[right].ScenarioID
	})
}
