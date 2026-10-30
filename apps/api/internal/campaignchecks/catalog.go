// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import "sort"

type FeatureID string

const (
	// FeatureF06 is predicted agent comprehension: whether an AI summariser can
	// faithfully represent this message. Two of its codes are deterministic and
	// come out of Analyze; SUMMARY_UNSTABLE requires an injected summariser and
	// comes out of AssessSummaryStability.
	FeatureF06 FeatureID = "F06"
	FeatureF07 FeatureID = "F07"
	FeatureF09 FeatureID = "F09"
	FeatureF10 FeatureID = "F10"
	FeatureF11 FeatureID = "F11"
	// FeatureF15 is the canonical offer: the message's in-email offer block
	// resolved against the entity an agent can query. Its findings are the only
	// ones in this package whose input is a database read rather than the
	// artifact, which is why the read happens in the caller and arrives
	// pre-resolved on Input.CanonicalOffers.
	FeatureF15 FeatureID = "F15"
)

// FindingDefinition is the stable product-taxonomy mapping for an emitted
// code. Dimension is copied to the persistence finding; Features records which
// PRD acceptance surface owns the detector.
type FindingDefinition struct {
	Code      string      `json:"code"`
	Features  []FeatureID `json:"features"`
	Dimension Dimension   `json:"dimension"`
}

var findingCatalog = map[string]FindingDefinition{
	"ARTIFACT_RECEIPT_MISMATCH":             definition(DimensionParity, FeatureF07),
	"COMPILER_RECEIPT_VERSION_MISMATCH":     definition(DimensionParity, FeatureF07),
	"FINDING_LIMIT_EXCEEDED":                definition(DimensionInput, FeatureF07, FeatureF09, FeatureF10, FeatureF11),
	"HTML_ANALYSIS_WORK_LIMIT_EXCEEDED":     definition(DimensionInput, FeatureF07, FeatureF10, FeatureF11),
	"HTML_PARSE_FAILED":                     definition(DimensionParity, FeatureF07),
	"HTML_REPRESENTATION_MISSING":           definition(DimensionParity, FeatureF07),
	"HTML_TREE_LIMIT_EXCEEDED":              definition(DimensionInput, FeatureF07, FeatureF10, FeatureF11),
	"INPUT_LIMIT_EXCEEDED":                  definition(DimensionInput, FeatureF07, FeatureF09, FeatureF10, FeatureF11),
	"MIME_ALTERNATIVE_INVALID":              definition(DimensionMIME, FeatureF07),
	"MIME_ALTERNATIVE_ORDER_INVALID":        definition(DimensionMIME, FeatureF07),
	"MIME_LINE_ENDINGS_INVALID":             definition(DimensionMIME, FeatureF07),
	"MIME_MESSAGE_INVALID":                  definition(DimensionMIME, FeatureF07),
	"MIME_MESSAGE_MISSING":                  definition(DimensionMIME, FeatureF07),
	"MIME_PART_BODY_INVALID":                definition(DimensionMIME, FeatureF07),
	"MIME_PART_CONTENT_MISMATCH":            definition(DimensionParity, FeatureF07),
	"MIME_PART_COUNT_INVALID":               definition(DimensionMIME, FeatureF07),
	"MIME_PART_HEADERS_INVALID":             definition(DimensionMIME, FeatureF07),
	"MIME_PART_INVALID":                     definition(DimensionMIME, FeatureF07),
	"MIME_STRUCTURE_RECEIPT_MISMATCH":       definition(DimensionMIME, FeatureF07),
	"MIME_SUBJECT_MISMATCH":                 definition(DimensionParity, FeatureF07),
	"MIME_VERSION_INVALID":                  definition(DimensionMIME, FeatureF07),
	"PLAIN_TEXT_ORIGIN_INVALID":             definition(DimensionParity, FeatureF07),
	"PLAIN_TEXT_REPRESENTATION_MISSING":     definition(DimensionParity, FeatureF07),
	"POLICY_VERSION_INVALID":                definition(DimensionInput, FeatureF07, FeatureF09, FeatureF10, FeatureF11),
	"RECEIPT_ENTRY_LIMIT_EXCEEDED":          definition(DimensionInput, FeatureF07, FeatureF10),
	"REPRESENTATION_HASH_MISMATCH":          definition(DimensionParity, FeatureF07),
	"REPRESENTATION_MANIFEST_INVALID":       definition(DimensionParity, FeatureF07),
	"VISIBLE_HTML_TEXT_MISSING":             definition(DimensionParity, FeatureF07, FeatureF10),
	"CRITICAL_IMAGE_INSPECTION_UNAVAILABLE": definition(DimensionImageMeaning, FeatureF09),
	"CRITICAL_IMAGE_OCR_RECOVERY_FAILED":    definition(DimensionImageMeaning, FeatureF09, FeatureF10),
	"DECORATIVE_IMAGE_ALT_NONEMPTY":         definition(DimensionAccessibility, FeatureF09),
	"FACT_MEANING_IMAGE_ONLY":               definition(DimensionImageMeaning, FeatureF09, FeatureF10),
	"IMAGE_ALT_MISSING":                     definition(DimensionAccessibility, FeatureF09),
	"IMAGE_BROKER_UNAVAILABLE":              definition(DimensionImageMeaning, FeatureF09),
	"IMAGE_DIMENSION_METADATA_MISMATCH":     definition(DimensionImageMeaning, FeatureF09),
	"IMAGE_METADATA_INVALID":                definition(DimensionImageMeaning, FeatureF09),
	"IMAGE_METADATA_LIMIT_EXCEEDED":         definition(DimensionImageMeaning, FeatureF09),
	"IMAGE_METADATA_SOURCE_MISMATCH":        definition(DimensionImageMeaning, FeatureF09),
	"IMAGE_OCR_PROMPT_MANIPULATION":         definition(DimensionHiddenContent, FeatureF09, FeatureF11),
	"IMAGE_OCR_UNAVAILABLE":                 definition(DimensionImageMeaning, FeatureF09),
	"IMAGE_TEXT_RECOVERY_UNAVAILABLE":       definition(DimensionImageMeaning, FeatureF09, FeatureF10),
	"INFORMATIVE_IMAGE_ALT_EMPTY":           definition(DimensionAccessibility, FeatureF09),
	"ZERO_SIZE_IMAGE":                       definition(DimensionHiddenContent, FeatureF09, FeatureF11),
	"CTA_ONLY_IN_IMAGE":                     definition(DimensionPrimaryAction, FeatureF06, FeatureF09),
	"OFFER_CANONICAL_MISSING":               definition(DimensionFactContract, FeatureF15),
	"OFFER_CANONICAL_DISAGREEMENT":          definition(DimensionFactContract, FeatureF15),
	"SUMMARY_STABILITY_NOT_ASSESSED":        definition(DimensionAgentComprehension, FeatureF06),
	"SUMMARY_UNSTABLE":                      definition(DimensionAgentComprehension, FeatureF06),
	"CORE_CLAIM_RECOVERY_FAILED":            definition(DimensionFactContract, FeatureF10),
	"CTA_DESTINATION_MISSING":               definition(DimensionPrimaryAction, FeatureF10),
	"CTA_LABEL_MISSING":                     definition(DimensionAccessibility, FeatureF10),
	"FACT_CONTRACT_INVALID":                 definition(DimensionFactContract, FeatureF10),
	"FACT_CONTRACT_UNAVAILABLE":             definition(DimensionFactContract, FeatureF10),
	"FACT_REPRESENTATION_DIVERGENCE":        definition(DimensionParity, FeatureF10),
	"FACT_SOURCE_BLOCK_DRIFT":               definition(DimensionFactContract, FeatureF10),
	"FACT_SOURCE_BLOCK_NOT_IN_SCENARIO":     definition(DimensionFactContract, FeatureF10),
	"FACT_SOURCE_CONTRACT_CONTRADICTION":    definition(DimensionFactContract, FeatureF10),
	"FACT_STRUCTURED_DATA_CONTRADICTION":    definition(DimensionStructuredData, FeatureF10),
	"FORBIDDEN_CLAIM_PRESENT":               definition(DimensionFactContract, FeatureF10),
	"HEADING_EMPTY":                         definition(DimensionAccessibility, FeatureF10),
	"HEADING_LEVEL_SKIPPED":                 definition(DimensionAccessibility, FeatureF10),
	"PRIMARY_ACTION_BLOCK_NOT_IN_SCENARIO":  definition(DimensionPrimaryAction, FeatureF10),
	"PRIMARY_ACTION_CONTRACT_CONTRADICTION": definition(DimensionPrimaryAction, FeatureF10),
	"PRIMARY_ACTION_IMAGE_ONLY":             definition(DimensionPrimaryAction, FeatureF09, FeatureF10),
	"PRIMARY_ACTION_RECOVERY_FAILED":        definition(DimensionPrimaryAction, FeatureF10),
	"PRIMARY_ACTION_SCHEMA_CONTRADICTION":   definition(DimensionStructuredData, FeatureF10),
	"REQUIRED_FACT_DISPLAY_MISSING":         definition(DimensionFactContract, FeatureF10),
	"SEMANTIC_PRIMARY_ACTION_COUNT_INVALID": definition(DimensionPrimaryAction, FeatureF10),
	"SEMANTIC_TREE_INVALID":                 definition(DimensionInput, FeatureF07, FeatureF10),
	"SOURCE_HASH_INVALID":                   definition(DimensionInput, FeatureF07, FeatureF10),
	"STRUCTURED_DATA_EMBEDDING_MISMATCH":    definition(DimensionParity, FeatureF10),
	"STRUCTURED_DATA_INVALID":               definition(DimensionStructuredData, FeatureF10),
	"STRUCTURED_DATA_MANIFEST_MISMATCH":     definition(DimensionStructuredData, FeatureF10),
	"STRUCTURED_DATA_SCRIPT_COUNT_INVALID":  definition(DimensionStructuredData, FeatureF10),
	"STRUCTURED_DATA_STATUS_MISMATCH":       definition(DimensionStructuredData, FeatureF10),
	"STRUCTURED_DATA_TYPE_UNSUPPORTED":      definition(DimensionStructuredData, FeatureF10),
	"STRUCTURED_STATUS_EVIDENCE_OVERCLAIM":  definition(DimensionStructuredData, FeatureF10),
	"TOP_LEVEL_HEADING_COUNT_INVALID":       definition(DimensionAccessibility, FeatureF10),
	"TOP_LEVEL_HEADING_MISSING":             definition(DimensionAccessibility, FeatureF10),
	"UNDECLARED_STRUCTURED_DATA":            definition(DimensionStructuredData, FeatureF10),
	"COMPILER_PREHEADER_MISSING":            definition(DimensionParity, FeatureF11),
	"COMPLEX_CSS_VISIBILITY_UNAVAILABLE":    definition(DimensionHiddenContent, FeatureF11),
	"EXECUTABLE_SCRIPT_PRESENT":             definition(DimensionHiddenContent, FeatureF11),
	"EXTERNAL_STYLESHEET_NOT_ANALYZED":      definition(DimensionHiddenContent, FeatureF11),
	"HIDDEN_PROMPT_MANIPULATION":            definition(DimensionHiddenContent, FeatureF11),
	"HIDDEN_TEXT_DETECTED":                  definition(DimensionHiddenContent, FeatureF11),
	"HTML_ENTITY_OBFUSCATION_PATTERN":       definition(DimensionHiddenContent, FeatureF11),
	"INTERACTIVE_HTML_PRESENT":              definition(DimensionHiddenContent, FeatureF11),
	"PREHEADER_PROVENANCE_INVALID":          definition(DimensionHiddenContent, FeatureF11),
	"TEXT_OBFUSCATION_CONTROL":              definition(DimensionHiddenContent, FeatureF11),
	"TINY_TEXT_DETECTED":                    definition(DimensionHiddenContent, FeatureF11),
	"VISIBLE_PROMPT_MANIPULATION_PATTERN":   definition(DimensionHiddenContent, FeatureF11),
}

func definition(dimension Dimension, features ...FeatureID) FindingDefinition {
	return FindingDefinition{Features: append([]FeatureID(nil), features...), Dimension: dimension}
}

// FindingDefinitions returns the full sorted code-to-PRD taxonomy. The map is
// not exposed so callers cannot mutate process-global detector behavior.
func FindingDefinitions() []FindingDefinition {
	codes := make([]string, 0, len(findingCatalog))
	for code := range findingCatalog {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	result := make([]FindingDefinition, 0, len(codes))
	for _, code := range codes {
		item := findingCatalog[code]
		item.Code = code
		item.Features = append([]FeatureID(nil), item.Features...)
		result = append(result, item)
	}
	return result
}
