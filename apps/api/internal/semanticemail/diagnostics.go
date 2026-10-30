// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"fmt"
	"strings"
)

type Severity string

const (
	SeverityError   Severity = "error"
	SeverityWarning Severity = "warning"
)

// DiagnosticCode is stable machine-readable policy. Paths are RFC 6901 JSON
// Pointers, so clients must not parse Message.
type DiagnosticCode string

const (
	CodeRequired                   DiagnosticCode = "required"
	CodeUnsupportedSchemaVersion   DiagnosticCode = "schema_version_unsupported"
	CodeUnsupportedNodeVersion     DiagnosticCode = "node_version_unsupported"
	CodeInvalidEnum                DiagnosticCode = "invalid_enum"
	CodeInvalidLanguage            DiagnosticCode = "invalid_language"
	CodeInvalidStableReference     DiagnosticCode = "invalid_stable_reference"
	CodeDuplicate                  DiagnosticCode = "duplicate"
	CodeLimitExceeded              DiagnosticCode = "limit_exceeded"
	CodeInvalidText                DiagnosticCode = "invalid_text"
	CodeTextTooLong                DiagnosticCode = "text_too_long"
	CodeContentCardinality         DiagnosticCode = "content_cardinality"
	CodeContentTypeMismatch        DiagnosticCode = "content_type_mismatch"
	CodeRoleTypeMismatch           DiagnosticCode = "role_type_mismatch"
	CodeInlineCardinality          DiagnosticCode = "inline_cardinality"
	CodeInvalidURL                 DiagnosticCode = "invalid_url"
	CodeURLCredentialsForbidden    DiagnosticCode = "url_credentials_forbidden"
	CodeURLFragmentForbidden       DiagnosticCode = "url_fragment_forbidden"
	CodeHTTPSRequired              DiagnosticCode = "https_required"
	CodeInvalidDateTime            DiagnosticCode = "datetime_invalid_rfc3339"
	CodeTimezoneUnknown            DiagnosticCode = "timezone_unknown"
	CodeTimezoneOffsetMismatch     DiagnosticCode = "timezone_offset_mismatch"
	CodeInvalidDecimal             DiagnosticCode = "decimal_invalid"
	CodeDecimalPrecisionExceeded   DiagnosticCode = "decimal_precision_exceeded"
	CodeNumberOutOfRange           DiagnosticCode = "number_out_of_range"
	CodeInvalidCurrency            DiagnosticCode = "currency_invalid_iso4217"
	CodeInvalidCountry             DiagnosticCode = "country_invalid_iso3166_1"
	CodeImageDimensionsIncomplete  DiagnosticCode = "image_dimensions_incomplete"
	CodeImageAltRequired           DiagnosticCode = "image_alt_required"
	CodeDecorativeAltForbidden     DiagnosticCode = "decorative_alt_forbidden"
	CodeConditionValueForbidden    DiagnosticCode = "condition_value_forbidden"
	CodeConditionValueRequired     DiagnosticCode = "condition_value_required"
	CodeNodeReferenceMissing       DiagnosticCode = "node_reference_missing"
	CodeNodeReferenceTypeMismatch  DiagnosticCode = "node_reference_type_mismatch"
	CodeStructuredKindMismatch     DiagnosticCode = "structured_kind_mismatch"
	CodeRegistryVersionUnsupported DiagnosticCode = "registry_version_unsupported"
	CodeLocaleUnavailable          DiagnosticCode = "locale_unavailable"
	CodeConditionUnresolved        DiagnosticCode = "condition_unresolved"
	CodeSlotUnresolved             DiagnosticCode = "slot_unresolved"
	CodeSlotValueInvalid           DiagnosticCode = "slot_value_invalid"
	CodeStructuredSourceAbsent     DiagnosticCode = "structured_source_absent"
	CodeStructuredDataUnverified   DiagnosticCode = "structured_data_unverified"
	CodeNoVisibleContent           DiagnosticCode = "no_visible_content"
	CodeMultiplePrimaryActions     DiagnosticCode = "multiple_primary_actions"
	CodeHeadingLevelSkipped        DiagnosticCode = "heading_level_skipped"
	CodeMultipleTopLevelHeadings   DiagnosticCode = "multiple_top_level_headings"
	CodeInvalidJSON                DiagnosticCode = "invalid_json"
	// CodeInvalidCanonicalOfferReference is a malformed bridge from an in-email
	// offer node to the canonical offer entity (PRD F15).
	CodeInvalidCanonicalOfferReference DiagnosticCode = "canonical_offer_reference_invalid"
)

// Diagnostic identifies one deterministic authoring or compilation issue.
// NodeID is populated for node-scoped paths and survives array reordering.
type Diagnostic struct {
	Severity Severity       `json:"severity"`
	Code     DiagnosticCode `json:"code"`
	Path     string         `json:"path"`
	NodeID   NodeID         `json:"node_id,omitempty"`
	Message  string         `json:"message"`
}

// Diagnostics preserves deterministic document order. Validation accumulates
// bounded failures so an editor can annotate every affected field at once.
type Diagnostics []Diagnostic

func (d Diagnostics) Error() string {
	parts := make([]string, 0, len(d))
	for _, item := range d {
		parts = append(parts, fmt.Sprintf("%s %s [%s]: %s", item.Severity, item.Path, item.Code, item.Message))
	}
	return strings.Join(parts, "; ")
}

func (d Diagnostics) HasErrors() bool {
	for _, item := range d {
		if item.Severity == SeverityError {
			return true
		}
	}
	return false
}

func (d Diagnostics) HasCode(code DiagnosticCode) bool {
	for _, item := range d {
		if item.Code == code {
			return true
		}
	}
	return false
}

func (d *Diagnostics) add(severity Severity, path string, nodeID NodeID, code DiagnosticCode, message string) {
	*d = append(*d, Diagnostic{Severity: severity, Path: path, NodeID: nodeID, Code: code, Message: message})
}

func (d *Diagnostics) error(path string, nodeID NodeID, code DiagnosticCode, message string) {
	d.add(SeverityError, path, nodeID, code, message)
}

func (d *Diagnostics) warning(path string, nodeID NodeID, code DiagnosticCode, message string) {
	d.add(SeverityWarning, path, nodeID, code, message)
}
