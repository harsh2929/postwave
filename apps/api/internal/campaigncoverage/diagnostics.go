// SPDX-License-Identifier: AGPL-3.0-only

package campaigncoverage

import (
	"fmt"
	"strings"
)

type Severity string

const (
	SeverityError   Severity = "error"
	SeverityWarning Severity = "warning"
)

type DiagnosticCode string

const (
	CodeInvalidInput            DiagnosticCode = "invalid_input"
	CodeUnsupportedSource       DiagnosticCode = "source_mode_unsupported"
	CodeUnsupportedVersion      DiagnosticCode = "version_unsupported"
	CodeInvalidJSON             DiagnosticCode = "invalid_json"
	CodeInvalidReference        DiagnosticCode = "invalid_stable_reference"
	CodeInvalidLocale           DiagnosticCode = "locale_invalid"
	CodeDuplicate               DiagnosticCode = "duplicate"
	CodeCollision               DiagnosticCode = "identity_collision"
	CodeLimitExceeded           DiagnosticCode = "limit_exceeded"
	CodeFactContractInvalid     DiagnosticCode = "fact_contract_invalid"
	CodeFactContractAbsent      DiagnosticCode = "fact_contract_absent"
	CodeSemanticDocumentInvalid DiagnosticCode = "semantic_document_invalid"
	CodeSlotClassConflict       DiagnosticCode = "slot_semantic_class_conflict"
	CodeRecipientPIIForbidden   DiagnosticCode = "recipient_pii_forbidden"
	CodeConditionUnresolved     DiagnosticCode = "condition_unresolved"
	CodeCriticalBranchDead      DiagnosticCode = "critical_branch_unreachable"
	CodeBranchUncovered         DiagnosticCode = "assurance_branch_uncovered"
	CodeContractBlockMissing    DiagnosticCode = "contract_block_missing"
	CodeCriticalSlotUncovered   DiagnosticCode = "critical_slot_uncovered"
	CodeScenarioCompileFailed   DiagnosticCode = "scenario_compile_failed"
	CodeManifestHashMismatch    DiagnosticCode = "manifest_hash_mismatch"
	CodeManifestNotCanonical    DiagnosticCode = "manifest_not_canonical"
)

// Diagnostic paths are RFC 6901 JSON pointers into Input (during enumeration)
// or Manifest (during decoding). IDs remain present when array order changes.
type Diagnostic struct {
	Severity    Severity       `json:"severity"`
	Code        DiagnosticCode `json:"code"`
	Path        string         `json:"path"`
	VariantID   string         `json:"variant_id,omitempty"`
	Locale      string         `json:"locale,omitempty"`
	NodeID      string         `json:"node_id,omitempty"`
	ConditionID string         `json:"condition_id,omitempty"`
	SlotID      string         `json:"slot_id,omitempty"`
	FixtureID   string         `json:"fixture_id,omitempty"`
	Message     string         `json:"message"`
}

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

type diagnosticSink struct {
	items     Diagnostics
	truncated bool
}

func (d *diagnosticSink) add(item Diagnostic) {
	if len(d.items) >= MaxDiagnostics-1 {
		if !d.truncated {
			d.items = append(d.items, Diagnostic{
				Severity: SeverityError,
				Code:     CodeLimitExceeded,
				Path:     "",
				Message:  fmt.Sprintf("diagnostics exceed the hard limit of %d", MaxDiagnostics),
			})
			d.truncated = true
		}
		return
	}
	d.items = append(d.items, item)
}

func (d *diagnosticSink) error(code DiagnosticCode, path, message string) {
	d.add(Diagnostic{Severity: SeverityError, Code: code, Path: path, Message: message})
}

func (d *diagnosticSink) warning(code DiagnosticCode, path, message string) {
	d.add(Diagnostic{Severity: SeverityWarning, Code: code, Path: path, Message: message})
}
