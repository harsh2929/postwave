// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancemodelsandbox

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
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
	"github.com/postwave/postwave/apps/api/internal/campaigncomprehension"
)

var (
	requestIDPattern   = regexp.MustCompile(`^[a-f0-9]{64}$`)
	protocolIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$`)
	failureCodePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)
)

func modelInputFromRequest(request campaignassuranceworker.ModelRequest) wireModelInput {
	return wireModelInput{
		Disposition:        InputDispositionQuotedUntrusted,
		InvocationID:       request.InvocationID,
		InputManifestHash:  request.InputManifestHash,
		OutboundMIMEHash:   request.OutboundMIMEHash,
		Configuration:      request.Configuration,
		Vocabulary:         request.Vocabulary,
		Evidence:           append([]campaignassuranceworker.ModelEvidence(nil), request.Evidence...),
		AllowedEvidenceIDs: append([]string(nil), request.AllowedEvidenceIDs...),
		ExtractionSchema:   append(json.RawMessage(nil), request.ExtractionSchema...),
		MaxOutputBytes:     request.MaxOutputBytes,
		SummaryRun:         request.SummaryRun,
		QuotedArtifact: wireQuotedArtifact{
			Subject: request.Artifact.Subject, HTML: request.Artifact.HTML,
			PlainText:      request.Artifact.PlainText,
			StructuredData: append(json.RawMessage(nil), request.Artifact.StructuredData...),
			RFC822:         append([]byte(nil), request.Artifact.RFC822...),
		},
	}
}

func (input wireModelInput) modelRequest() campaignassuranceworker.ModelRequest {
	return campaignassuranceworker.ModelRequest{
		InvocationID:       input.InvocationID,
		CacheKey:           input.InvocationID,
		InputManifestHash:  input.InputManifestHash,
		OutboundMIMEHash:   input.OutboundMIMEHash,
		Configuration:      input.Configuration,
		Vocabulary:         input.Vocabulary,
		Evidence:           append([]campaignassuranceworker.ModelEvidence(nil), input.Evidence...),
		AllowedEvidenceIDs: append([]string(nil), input.AllowedEvidenceIDs...),
		ExtractionSchema:   append(json.RawMessage(nil), input.ExtractionSchema...),
		MaxOutputBytes:     input.MaxOutputBytes,
		SummaryRun:         input.SummaryRun,
		Artifact: campaignassuranceworker.ModelArtifact{
			Subject: input.QuotedArtifact.Subject, HTML: input.QuotedArtifact.HTML,
			PlainText:      input.QuotedArtifact.PlainText,
			StructuredData: append(json.RawMessage(nil), input.QuotedArtifact.StructuredData...),
			RFC822:         append([]byte(nil), input.QuotedArtifact.RFC822...),
		},
	}
}

func validateModelInput(input wireModelInput, identity campaignassuranceworker.ModelExecutorIdentity) error {
	if input.Disposition != InputDispositionQuotedUntrusted ||
		!requestIDPattern.MatchString(input.InvocationID) ||
		!validSHA256(input.InputManifestHash) || !validSHA256(input.OutboundMIMEHash) {
		return fmt.Errorf("%w: invalid input identity", ErrRequestRejected)
	}
	if !validExecutorIdentity(identity) || input.Configuration.ExecutorID != identity.ID ||
		input.Configuration.ExecutorVersion != identity.Version ||
		input.Configuration.MaximumCostMicrounits != identity.MaximumCostMicrounits {
		return fmt.Errorf("%w: executor identity mismatch", ErrRequestRejected)
	}
	if _, err := campaignassuranceworker.NewModeledConfiguration(
		"sandbox.boundary.validation.v1", input.Configuration,
	); err != nil {
		return fmt.Errorf("%w: invalid frozen configuration", ErrRequestRejected)
	}
	if input.MaxOutputBytes < 1 || input.MaxOutputBytes > campaigncomprehension.MaxExtractionBytes {
		return fmt.Errorf("%w: invalid output bound", ErrRequestRejected)
	}
	expectedSchema := campaigncomprehension.ExtractionJSONSchemaV1()
	var compactInputSchema, compactExpectedSchema bytes.Buffer
	if rejectDuplicateJSONKeys(input.ExtractionSchema) != nil ||
		json.Compact(&compactInputSchema, input.ExtractionSchema) != nil ||
		json.Compact(&compactExpectedSchema, expectedSchema) != nil ||
		!bytes.Equal(compactInputSchema.Bytes(), compactExpectedSchema.Bytes()) {
		return fmt.Errorf("%w: extraction schema drift", ErrRequestRejected)
	}
	if input.SummaryRun < 0 || input.SummaryRun > campaignchecks.SummaryRunCount {
		return fmt.Errorf("%w: invalid summary run", ErrRequestRejected)
	}
	if err := validateVocabulary(input.Vocabulary); err != nil {
		return err
	}
	if err := validateEvidence(input.Evidence, input.AllowedEvidenceIDs); err != nil {
		return err
	}
	if err := validateQuotedArtifact(input.QuotedArtifact, input.OutboundMIMEHash); err != nil {
		return err
	}
	return nil
}

func validateVocabulary(vocabulary campaignassuranceworker.RecoveryVocabularyV1) error {
	if vocabulary.SchemaVersion != 1 || len(vocabulary.FactSlots) > maximumFactSlots {
		return fmt.Errorf("%w: invalid recovery vocabulary", ErrRequestRejected)
	}
	if (vocabulary.PrimaryAction.ActionID == "") != (vocabulary.PrimaryAction.BlockID == "") ||
		(vocabulary.PrimaryAction.ActionID != "" &&
			(!validProtocolText(vocabulary.PrimaryAction.ActionID, maximumProtocolTextBytes) ||
				!validProtocolText(vocabulary.PrimaryAction.BlockID, maximumProtocolTextBytes))) {
		return fmt.Errorf("%w: invalid inert action vocabulary", ErrRequestRejected)
	}
	seen := make(map[string]struct{}, len(vocabulary.FactSlots))
	for _, slot := range vocabulary.FactSlots {
		if !validProtocolText(slot.FactID, maximumProtocolTextBytes) ||
			!validProtocolText(slot.Type, maximumProtocolTextBytes) {
			return fmt.Errorf("%w: invalid fact vocabulary", ErrRequestRejected)
		}
		if _, exists := seen[slot.FactID]; exists {
			return fmt.Errorf("%w: duplicate fact vocabulary", ErrRequestRejected)
		}
		seen[slot.FactID] = struct{}{}
	}
	return nil
}

func validateEvidence(
	evidence []campaignassuranceworker.ModelEvidence,
	allowed []string,
) error {
	if len(evidence) == 0 || len(evidence) > maximumEvidenceItems || len(allowed) != len(evidence) {
		return fmt.Errorf("%w: invalid evidence bounds", ErrRequestRejected)
	}
	byID := make(map[string]struct{}, len(evidence))
	for _, item := range evidence {
		if !validProtocolText(item.ID, 512) || !validProtocolText(item.Representation, 64) ||
			!validSHA256(item.SHA256) ||
			(item.Location != "" && !validProtocolText(item.Location, 1024)) {
			return fmt.Errorf("%w: invalid evidence", ErrRequestRejected)
		}
		if _, duplicate := byID[item.ID]; duplicate {
			return fmt.Errorf("%w: duplicate evidence", ErrRequestRejected)
		}
		byID[item.ID] = struct{}{}
	}
	if !sort.StringsAreSorted(allowed) {
		return fmt.Errorf("%w: unsorted evidence allowlist", ErrRequestRejected)
	}
	for index, id := range allowed {
		if !validProtocolText(id, 512) {
			return fmt.Errorf("%w: invalid evidence allowlist", ErrRequestRejected)
		}
		if index > 0 && allowed[index-1] == id {
			return fmt.Errorf("%w: duplicate evidence allowlist", ErrRequestRejected)
		}
		if _, exists := byID[id]; !exists {
			return fmt.Errorf("%w: foreign evidence allowlist entry", ErrRequestRejected)
		}
	}
	return nil
}

func validateQuotedArtifact(artifact wireQuotedArtifact, outboundMIMEHash string) error {
	if len(artifact.Subject) > 64<<10 || len(artifact.HTML) > 2<<20 ||
		len(artifact.PlainText) > 1<<20 || len(artifact.StructuredData) > 256<<10 ||
		len(artifact.RFC822) == 0 || len(artifact.RFC822) > 4<<20 ||
		!utf8.ValidString(artifact.Subject) || !utf8.ValidString(artifact.HTML) ||
		!utf8.ValidString(artifact.PlainText) || !utf8.Valid(artifact.StructuredData) ||
		!utf8.Valid(artifact.RFC822) {
		return fmt.Errorf("%w: invalid quoted artifact bounds", ErrRequestRejected)
	}
	if sha256Hex(artifact.RFC822) != outboundMIMEHash {
		return fmt.Errorf("%w: quoted MIME integrity mismatch", ErrRequestRejected)
	}
	if len(artifact.StructuredData) != 0 && !json.Valid(artifact.StructuredData) {
		return fmt.Errorf("%w: invalid quoted structured data", ErrRequestRejected)
	}
	return nil
}

func validateModelResult(
	result campaignassuranceworker.ModelResult,
	input wireModelInput,
	identity campaignassuranceworker.ModelExecutorIdentity,
) error {
	limit := input.MaxOutputBytes
	if input.SummaryRun != 0 && limit > 4*campaignchecks.MaxSummaryFieldBytes {
		limit = 4 * campaignchecks.MaxSummaryFieldBytes
	}
	if len(result.RawExtraction) == 0 || len(result.RawExtraction) > limit ||
		!utf8.Valid(result.RawExtraction) || !validateResultProvenance(result.Provenance, input.Configuration, identity) ||
		result.InputTokens <= 0 || result.OutputTokens < 0 || result.CostMicrounits < 0 ||
		result.CostMicrounits > identity.MaximumCostMicrounits {
		return ErrOutputRejected
	}
	if input.SummaryRun != 0 {
		if err := validateSummaryOutput(result.RawExtraction); err != nil {
			return fmt.Errorf("%w: summary schema", ErrOutputRejected)
		}
		return nil
	}
	if _, diagnostics := campaigncomprehension.DecodeAndNormalizeV1(
		result.RawExtraction, input.AllowedEvidenceIDs,
	); len(diagnostics) != 0 {
		return fmt.Errorf("%w: extraction schema", ErrOutputRejected)
	}
	return nil
}

func validateResultProvenance(
	provenance campaignassuranceworker.ModelProvenance,
	configuration campaignassuranceworker.ModeledConfigurationV1,
	identity campaignassuranceworker.ModelExecutorIdentity,
) bool {
	return provenance.ExecutorID == identity.ID && provenance.ExecutorVersion == identity.Version &&
		provenance.ExecutorID == configuration.ExecutorID &&
		provenance.ExecutorVersion == configuration.ExecutorVersion &&
		provenance.ModelProvider == configuration.ModelProvider &&
		provenance.ModelID == configuration.ModelID &&
		provenance.ModelVersion == configuration.ModelVersion &&
		provenance.PromptVersion == configuration.PromptVersion &&
		provenance.PromptHash == configuration.PromptHash &&
		provenance.SeedValue == configuration.SeedValue &&
		!math.IsNaN(provenance.Temperature) && !math.IsInf(provenance.Temperature, 0) &&
		provenance.Temperature == configuration.Temperature
}

func validateSummaryOutput(raw []byte) error {
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var draft campaignchecks.SummaryDraft
	if err := decoder.Decode(&draft); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return ErrProtocol
	}
	if strings.TrimSpace(draft.OneLineSummary) == "" ||
		len(draft.OneLineSummary) > campaignchecks.MaxSummaryFieldBytes ||
		len(draft.PrimaryIntent) > campaignchecks.MaxSummaryFieldBytes ||
		len(draft.PrimaryAction) > campaignchecks.MaxSummaryFieldBytes {
		return ErrProtocol
	}
	switch strings.TrimSpace(draft.PrimaryIntent) {
	case "event_invite", "offer", "newsletter", "transactional", "announcement", "other":
	default:
		return ErrProtocol
	}
	for _, value := range []string{draft.OneLineSummary, draft.PrimaryIntent, draft.PrimaryAction} {
		if !validOutputText(value) {
			return ErrProtocol
		}
	}
	return nil
}

func validExecutorIdentity(identity campaignassuranceworker.ModelExecutorIdentity) bool {
	return validProtocolText(identity.ID, 100) && validProtocolText(identity.Version, 160) &&
		identity.MaximumCostMicrounits > 0 &&
		identity.MaximumCostMicrounits <= campaignassurance.MaximumModeledInvocationCostMicrounits
}

func validProtocolText(value string, maximum int) bool {
	if value == "" || len(value) > maximum || value != strings.TrimSpace(value) || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func validOutputText(value string) bool {
	if !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if character == 0 || (unicode.IsControl(character) && character != '\n' && character != '\r' && character != '\t') {
			return false
		}
	}
	return true
}

func validSHA256(value string) bool {
	if !requestIDPattern.MatchString(value) {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

func sha256Hex(body []byte) string {
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

func rejectDuplicateJSONKeys(body []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := scanJSONValue(decoder); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return ErrProtocol
	}
	return nil
}

func scanJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return ErrProtocol
			}
			if _, duplicate := seen[key]; duplicate {
				return ErrProtocol
			}
			seen[key] = struct{}{}
			if err := scanJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return ErrProtocol
		}
	case '[':
		for decoder.More() {
			if err := scanJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return ErrProtocol
		}
	default:
		return ErrProtocol
	}
	return nil
}
