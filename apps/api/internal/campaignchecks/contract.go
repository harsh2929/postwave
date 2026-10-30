// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/factcontract"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

type contractAnalysis struct {
	available bool
	valid     bool
	contract  factcontract.ContractV1
}

type semanticAnalysis struct {
	valid              bool
	nodes              map[string]semanticemail.Node
	included           map[string]struct{}
	structuredNodeRefs map[string]struct{}
}

func analyzeContract(a *analysis) contractAnalysis {
	raw := bytes.TrimSpace(a.input.Revision.FactContract)
	if len(raw) == 0 || bytes.Equal(raw, []byte(`{}`)) {
		a.add(findingSpec{
			code: "FACT_CONTRACT_UNAVAILABLE", severity: SeverityInfo,
			dimension:   DimensionFactContract,
			evidence:    []EvidenceReference{{Representation: RepresentationRevision, Location: "/fact_contract"}},
			explanation: "No Fact Contract is frozen for this revision; exact fact and action recovery cannot be certified.",
			remediation: Remediation{Kind: RemediationProvideFactContract, Representation: RepresentationRevision, Field: "fact_contract"},
		})
		return contractAnalysis{}
	}
	result := contractAnalysis{available: true}
	if len(raw) > MaxFactContractBytes {
		return result
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var contract factcontract.ContractV1
	if err := decoder.Decode(&contract); err != nil {
		a.invalidContract("decode_failed", err)
		return result
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		a.invalidContract("trailing_json", err)
		return result
	}
	normalized, validationErrors := factcontract.NormalizeAndValidateV1(contract)
	if validationErrors.HasErrors() {
		a.add(findingSpec{
			code: "FACT_CONTRACT_INVALID", severity: SeverityCritical, blocking: true,
			dimension:   DimensionFactContract,
			evidence:    []EvidenceReference{{Representation: RepresentationRevision, Location: "/fact_contract"}},
			observed:    map[string]any{"validation_errors": validationErrors},
			explanation: "The frozen Fact Contract fails the closed v1 schema and cannot serve as an assurance oracle.",
			remediation: Remediation{Kind: RemediationProvideFactContract, Representation: RepresentationRevision, Field: "fact_contract"},
		})
		return result
	}
	result.valid = true
	result.contract = normalized
	return result
}

func (a *analysis) invalidContract(reason string, err error) {
	observed := map[string]any{"reason": reason}
	if err != nil {
		observed["error_class"] = fmt.Sprintf("%T", err)
	}
	a.add(findingSpec{
		code: "FACT_CONTRACT_INVALID", severity: SeverityCritical, blocking: true,
		dimension:   DimensionFactContract,
		evidence:    []EvidenceReference{{Representation: RepresentationRevision, Location: "/fact_contract"}},
		observed:    observed,
		explanation: "The frozen Fact Contract is not one strict, closed v1 JSON object.",
		remediation: Remediation{Kind: RemediationProvideFactContract, Representation: RepresentationRevision, Field: "fact_contract"},
	})
}

func analyzeSemantic(a *analysis) semanticAnalysis {
	result := semanticAnalysis{
		nodes: make(map[string]semanticemail.Node), included: make(map[string]struct{}),
		structuredNodeRefs: make(map[string]struct{}),
	}
	if a.input.Revision.SourceMode != campaignartifact.SourceModeSemantic {
		return result
	}
	if a.input.Revision.ContentSchemaVersion != semanticemail.SchemaVersionV2 ||
		len(a.input.Revision.SemanticTree) > semanticemail.MaxDocumentJSONBytes {
		a.add(findingSpec{
			code: "SEMANTIC_TREE_INVALID", severity: SeverityCritical, blocking: true,
			dimension:   DimensionInput,
			evidence:    []EvidenceReference{{Representation: RepresentationRevision, Location: "/semantic_tree"}},
			expected:    map[string]any{"schema_version": semanticemail.SchemaVersionV2, "maximum_bytes": semanticemail.MaxDocumentJSONBytes},
			observed:    map[string]any{"schema_version": a.input.Revision.ContentSchemaVersion, "bytes": len(a.input.Revision.SemanticTree)},
			explanation: "The frozen semantic tree has an unsupported schema version or exceeds its resource bound.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationRevision},
		})
		return result
	}
	decoder := json.NewDecoder(bytes.NewReader(a.input.Revision.SemanticTree))
	decoder.DisallowUnknownFields()
	var nodes []semanticemail.Node
	if err := decoder.Decode(&nodes); err != nil {
		a.semanticDecodeFailure(err)
		return result
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		a.semanticDecodeFailure(err)
		return result
	}
	languageTag := strings.TrimSpace(a.input.Compilation.Artifact.Locale)
	if a.contract.valid {
		languageTag = string(a.contract.contract.Language)
	}
	document, diagnostics := semanticemail.NormalizeAndValidateV2(semanticemail.DocumentV2{
		SchemaVersion: semanticemail.SchemaVersionV2,
		Language:      languageTag, Direction: semanticemail.DirectionAuto, Nodes: nodes,
	})
	if diagnostics.HasErrors() {
		a.add(findingSpec{
			code: "SEMANTIC_TREE_INVALID", severity: SeverityCritical, blocking: true,
			dimension:   DimensionInput,
			evidence:    []EvidenceReference{{Representation: RepresentationRevision, Location: "/semantic_tree"}},
			observed:    map[string]any{"diagnostics": diagnostics},
			explanation: "The frozen semantic tree fails deterministic v2 validation.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationRevision},
		})
		return result
	}
	result.valid = true
	includedLimit := len(a.input.Compilation.Receipt.IncludedNodeIDs)
	if includedLimit > MaxReceiptEntries {
		includedLimit = MaxReceiptEntries
	}
	for _, nodeID := range a.input.Compilation.Receipt.IncludedNodeIDs[:includedLimit] {
		result.included[string(nodeID)] = struct{}{}
	}
	for _, node := range document.Nodes {
		result.nodes[string(node.ID)] = node
		if node.Type != semanticemail.NodeStructuredData || node.Content.StructuredData == nil {
			continue
		}
		if _, included := result.included[string(node.ID)]; !included || !structuredStatusEmitted(a, node.ID) {
			continue
		}
		for _, reference := range structuredReferences(node.Content.StructuredData.Declaration) {
			result.structuredNodeRefs[string(reference)] = struct{}{}
		}
	}
	return result
}

func (a *analysis) semanticDecodeFailure(err error) {
	observed := map[string]any{"error_class": "strict_decode_failed"}
	if err != nil {
		observed["go_error_type"] = fmt.Sprintf("%T", err)
	}
	a.add(findingSpec{
		code: "SEMANTIC_TREE_INVALID", severity: SeverityCritical, blocking: true,
		dimension:   DimensionInput,
		evidence:    []EvidenceReference{{Representation: RepresentationRevision, Location: "/semantic_tree"}},
		observed:    observed,
		explanation: "The semantic node array is not valid closed-schema JSON.",
		remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationRevision},
	})
}

func structuredStatusEmitted(a *analysis, nodeID semanticemail.NodeID) bool {
	for _, status := range a.input.Compilation.Receipt.StructuredStatuses {
		if status.NodeID == nodeID {
			return status.Valid && status.Emitted
		}
	}
	return false
}

func structuredReferences(declaration semanticemail.StructuredDeclaration) []semanticemail.NodeID {
	result := make([]semanticemail.NodeID, 0, 16)
	add := func(values ...semanticemail.NodeID) {
		for _, value := range values {
			if value != "" {
				result = append(result, value)
			}
		}
	}
	if value := declaration.DiscountOffer; value != nil {
		add(value.OfferNodeID)
	}
	if value := declaration.PromotionCard; value != nil {
		add(value.ImageNodeID, value.ActionNodeID, value.HeadlineNodeID, value.PriceNodeID, value.DiscountValueNodeID)
	}
	if value := declaration.EventReservation; value != nil {
		add(value.ReservationNumberNodeID, value.UnderNameNodeID, value.EventNameNodeID,
			value.StartDateTimeNodeID, value.LocationNodeID, value.StatusNodeID, value.ActionNodeID)
	}
	if value := declaration.Order; value != nil {
		add(value.MerchantNodeID, value.OrderNumberNodeID, value.TotalNodeID, value.ActionNodeID)
		for _, item := range value.Items {
			add(item.ProductNodeID, item.PriceNodeID, item.QuantityNodeID)
		}
	}
	return result
}
