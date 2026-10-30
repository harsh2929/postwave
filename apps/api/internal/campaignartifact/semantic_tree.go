// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

// SemanticTreeValidationError preserves stable, field-addressable AST
// diagnostics for authoring clients. Warnings do not make a tree invalid and
// are returned separately by NormalizeSemanticTreeV2.
type SemanticTreeValidationError struct {
	Diagnostics semanticemail.Diagnostics
}

func (e *SemanticTreeValidationError) Error() string {
	if e == nil {
		return "campaign artifact: invalid semantic tree"
	}
	return "campaign artifact: invalid semantic tree: " + e.Diagnostics.Error()
}

func (e *SemanticTreeValidationError) Unwrap() error { return ErrInvalidInput }

// NormalizeSemanticTreeV2 is the single authoring/freeze boundary for the
// semantic node array stored in campaigns.content_blocks. It rejects unknown
// fields and trailing JSON, validates the closed v2 union, and returns the
// normalized node array that must be persisted and hashed.
//
// Language and direction live outside content_blocks today. They do not alter
// node normalization, so this boundary uses a valid neutral document context;
// the exact Fact Contract/scenario language is supplied again at compilation.
func NormalizeSemanticTreeV2(raw json.RawMessage, schemaVersion int) (json.RawMessage, semanticemail.Diagnostics, error) {
	if schemaVersion != semanticemail.SchemaVersionV2 {
		return nil, nil, fmt.Errorf("%w: semantic source requires content_schema_version %d", ErrInvalidInput, semanticemail.SchemaVersionV2)
	}
	if len(raw) == 0 {
		return semanticTreeJSONError(semanticemail.CodeRequired, "semantic node JSON is required")
	}
	if len(raw) > semanticemail.MaxDocumentJSONBytes {
		return semanticTreeJSONError(semanticemail.CodeLimitExceeded,
			fmt.Sprintf("semantic node JSON exceeds %d bytes", semanticemail.MaxDocumentJSONBytes))
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var nodes []semanticemail.Node
	if err := decoder.Decode(&nodes); err != nil {
		return semanticTreeJSONError(semanticemail.CodeInvalidJSON, "semantic node JSON could not be decoded: "+err.Error())
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return semanticTreeJSONError(semanticemail.CodeInvalidJSON, "semantic node JSON must contain exactly one value")
	}
	normalized, diagnostics := semanticemail.NormalizeAndValidateV2(semanticemail.DocumentV2{
		SchemaVersion: semanticemail.SchemaVersionV2,
		Language:      "en",
		Direction:     semanticemail.DirectionAuto,
		Nodes:         nodes,
	})
	if diagnostics.HasErrors() {
		return nil, diagnostics, &SemanticTreeValidationError{Diagnostics: diagnostics}
	}
	encoded, err := json.Marshal(normalized.Nodes)
	if err != nil {
		return nil, diagnostics, fmt.Errorf("encode normalized semantic tree v2: %w", err)
	}
	canonical, err := canonicalJSON(encoded, "array")
	if err != nil {
		return nil, diagnostics, err
	}
	return canonical, diagnostics, nil
}

func semanticTreeJSONError(code semanticemail.DiagnosticCode, message string) (json.RawMessage, semanticemail.Diagnostics, error) {
	diagnostics := semanticemail.Diagnostics{{
		Severity: semanticemail.SeverityError,
		Code:     code,
		Path:     "/",
		Message:  message,
	}}
	return nil, diagnostics, &SemanticTreeValidationError{Diagnostics: diagnostics}
}

// ImportLegacyRevisionV2 converts a stored legacy_html revision into a semantic
// node array.
//
// This is the caller the importer needs to matter. Every campaign authored
// before the semantic tree existed is legacy HTML, so without a conversion path
// the F06/F07/F11 checks — all of which read the tree — are structurally unable
// to see the customer's existing library. The importer was the hard half; this
// is the half that decides whether the feature applies to new work or to the
// product.
//
// A LOSSY IMPORT IS AN ERROR, NOT A PARTIAL RESULT. The unmapped report is
// returned alongside so a caller can tell the operator exactly what could not be
// represented, but no node array is produced. Persisting a partial tree as
// source_mode='semantic' would assert that the tree describes the message, and
// every downstream check would then report confidently about a document the
// customer never sent — which is worse than not checking at all, because it
// looks like a verdict.
func ImportLegacyRevisionV2(
	legacyHTML, language, revisionID string,
) (json.RawMessage, []semanticemail.UnmappedConstruct, semanticemail.Diagnostics, error) {
	result := semanticemail.ImportLegacyHTML(legacyHTML, semanticemail.ImportOptions{
		Language: language,
		SourceID: revisionID,
	})
	document, ok := result.Document()
	if !ok {
		return nil, result.Unmapped, result.Diagnostics,
			&SemanticTreeValidationError{Diagnostics: result.Diagnostics}
	}
	encoded, err := json.Marshal(document.Nodes)
	if err != nil {
		return nil, result.Unmapped, result.Diagnostics,
			fmt.Errorf("campaignartifact: encode imported semantic nodes: %w", err)
	}
	return encoded, result.Unmapped, result.Diagnostics, nil
}
