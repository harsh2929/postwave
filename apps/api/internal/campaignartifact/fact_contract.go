// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/factcontract"
)

// FactContractValidationError preserves the closed, field-addressable v1
// validation receipts for an API handler. It is safe to return to an author.
type FactContractValidationError struct {
	Errors factcontract.ValidationErrors
}

func (e *FactContractValidationError) Error() string {
	if e == nil {
		return "campaign artifact: invalid Fact Contract"
	}
	return "campaign artifact: invalid Fact Contract: " + e.Errors.Error()
}

// FactContractReferenceError reports syntactically valid semantic block
// references that do not exist in the source tree being frozen.
type FactContractReferenceError struct {
	MissingBlockIDs []string
}

func (e *FactContractReferenceError) Error() string {
	if e == nil {
		return "campaign artifact: Fact Contract references are invalid"
	}
	return fmt.Sprintf("campaign artifact: Fact Contract references missing semantic blocks: %s",
		strings.Join(e.MissingBlockIDs, ", "))
}

// normalizeFactContract turns a non-empty v1 object into the exact normalized
// JSON frozen in a revision. An empty object remains a deliberate "no contract"
// state: legacy campaigns may receive structural diagnostics but no score.
func normalizeFactContract(raw json.RawMessage, sourceMode string, semanticTree json.RawMessage) (json.RawMessage, error) {
	canonical, err := canonicalJSON(raw, "object")
	if err != nil {
		return nil, err
	}
	if bytes.Equal(canonical, []byte(`{}`)) {
		return canonical, nil
	}

	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	var contract factcontract.ContractV1
	if err := decoder.Decode(&contract); err != nil {
		return nil, fmt.Errorf("%w: decode Fact Contract v1: %v", ErrInvalidInput, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: trailing Fact Contract value", ErrInvalidInput)
	}
	normalized, validationErrors := factcontract.NormalizeAndValidateV1(contract)
	if validationErrors.HasErrors() {
		return nil, &FactContractValidationError{Errors: validationErrors}
	}
	if sourceMode == SourceModeSemantic {
		if err := validateFactContractBlockReferences(normalized, semanticTree); err != nil {
			return nil, err
		}
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return nil, fmt.Errorf("encode normalized Fact Contract: %w", err)
	}
	return canonicalJSON(encoded, "object")
}

// NormalizeFactContractV1 is the authoring/freeze boundary shared by campaign
// draft persistence and immutable revision capture. Persist only its returned
// bytes. An empty object is the explicit no-contract state.
func NormalizeFactContractV1(raw json.RawMessage, sourceMode string, semanticTree json.RawMessage) (json.RawMessage, error) {
	return normalizeFactContract(raw, sourceMode, semanticTree)
}

func validateFactContractBlockReferences(contract factcontract.ContractV1, semanticTree json.RawMessage) error {
	var tree []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(semanticTree, &tree); err != nil {
		return fmt.Errorf("%w: decode semantic tree for Fact Contract references: %v", ErrInvalidInput, err)
	}
	known := make(map[string]struct{}, len(tree))
	for _, node := range tree {
		if id := strings.TrimSpace(node.ID); id != "" {
			known[id] = struct{}{}
		}
	}
	referenced := make(map[string]struct{})
	referenced[string(contract.PrimaryAction.BlockID)] = struct{}{}
	for _, blockID := range contract.CoreClaim.SourceBlockIDs {
		referenced[string(blockID)] = struct{}{}
	}
	for _, fact := range contract.RequiredFacts {
		for _, blockID := range fact.SourceBlockIDs {
			referenced[string(blockID)] = struct{}{}
		}
	}
	missing := make([]string, 0)
	for blockID := range referenced {
		if _, exists := known[blockID]; !exists {
			missing = append(missing, blockID)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	sort.Strings(missing)
	return &FactContractReferenceError{MissingBlockIDs: missing}
}
