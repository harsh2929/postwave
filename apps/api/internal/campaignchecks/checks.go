// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
	"github.com/postwave/postwave/apps/api/internal/factcontract"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

func analyzeSemantics(a *analysis) {
	if strings.TrimSpace(a.input.Compilation.Text) == "" {
		a.add(findingSpec{
			code: "PLAIN_TEXT_REPRESENTATION_MISSING", severity: SeverityCritical, blocking: true,
			dimension:   DimensionParity,
			evidence:    []EvidenceReference{{Representation: RepresentationPlainText, Location: "/"}},
			explanation: "The canonical semantic plain-text representation is empty.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationPlainText},
		})
	}
	if a.html.valid && strings.TrimSpace(a.html.visibleText) == "" {
		a.add(findingSpec{
			code: "VISIBLE_HTML_TEXT_MISSING", severity: SeverityCritical, blocking: true,
			dimension:   DimensionParity,
			evidence:    []EvidenceReference{{Representation: RepresentationVisibleHTML, Location: "/"}},
			explanation: "The HTML projection has no recoverable visible live text.",
			remediation: Remediation{Kind: RemediationRestoreLiveText, Representation: RepresentationRevision},
		})
	}
	wantPlainOrigin := "reviewed_legacy_plain_text"
	if a.input.Revision.SourceMode == campaignartifact.SourceModeSemantic {
		wantPlainOrigin = "semantic_projection"
	}
	if a.input.Compilation.RepresentationManifest.PlainTextOrigin != wantPlainOrigin {
		a.add(findingSpec{
			code: "PLAIN_TEXT_ORIGIN_INVALID", severity: SeverityCritical, blocking: true,
			dimension:   DimensionParity,
			evidence:    []EvidenceReference{{Representation: RepresentationManifest, Location: "/plain_text_origin"}},
			expected:    map[string]any{"plain_text_origin": wantPlainOrigin},
			observed:    map[string]any{"plain_text_origin": a.input.Compilation.RepresentationManifest.PlainTextOrigin},
			explanation: "The plain-text part is not certified as the expected semantic or reviewed legacy projection.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationPlainText},
		})
	}

	primaryActions := make([]htmlAction, 0)
	for _, action := range a.html.actions {
		if action.role == string(semanticemail.RolePrimaryAction) && !action.hidden {
			primaryActions = append(primaryActions, action)
		}
		if action.href == "" {
			a.add(findingSpec{
				code: "CTA_DESTINATION_MISSING", severity: SeverityError, blocking: action.role == string(semanticemail.RolePrimaryAction),
				overridable: action.role == string(semanticemail.RolePrimaryAction), dimension: DimensionPrimaryAction,
				blocks:      blockRefs(action.nodeID, "", action.actionID),
				evidence:    []EvidenceReference{{Representation: RepresentationVisibleHTML, Location: elementLocation(action.index), NodeID: action.nodeID}},
				explanation: "An anchor has no destination; a primary action without a destination cannot be recovered.",
				remediation: Remediation{Kind: RemediationFixPrimaryAction, Representation: RepresentationRevision, NodeID: action.nodeID, Field: "content.action.canonical_url"},
			})
		}
		if action.label == "" && !action.hidden {
			a.add(findingSpec{
				code: "CTA_LABEL_MISSING", severity: SeverityWarning, dimension: DimensionAccessibility,
				blocks:      blockRefs(action.nodeID, "", action.actionID),
				evidence:    []EvidenceReference{{Representation: RepresentationVisibleHTML, Location: elementLocation(action.index), NodeID: action.nodeID}},
				explanation: "An anchor has no live-text label and may be available only through an image or inaccessible markup.",
				remediation: Remediation{Kind: RemediationFixPrimaryAction, Representation: RepresentationRevision, NodeID: action.nodeID, Field: "content.action.label"},
			})
		}
	}
	if a.input.Revision.SourceMode == campaignartifact.SourceModeSemantic && len(primaryActions) != 1 {
		a.add(findingSpec{
			code: "SEMANTIC_PRIMARY_ACTION_COUNT_INVALID", severity: SeverityCritical, blocking: true,
			overridable: true, dimension: DimensionPrimaryAction,
			evidence:    []EvidenceReference{{Representation: RepresentationVisibleHTML, Location: "/actions"}},
			expected:    map[string]any{"visible_primary_actions": 1},
			observed:    map[string]any{"visible_primary_actions": len(primaryActions)},
			explanation: "A semantic-native campaign must expose exactly one visible primary action.",
			remediation: Remediation{Kind: RemediationFixPrimaryAction, Representation: RepresentationRevision, Field: "nodes"},
		})
	}

	for _, image := range a.html.images {
		metadata, exists := a.images[image.nodeID]
		if !exists || metadata.Status != ImageInspectionVerified {
			continue
		}
		wantHTMLSourceHash, htmlSourceErr := campaignimagebroker.SourceURLSHA256(image.src)
		if htmlSourceErr != nil || metadata.SourceURLSHA256 != wantHTMLSourceHash {
			a.add(findingSpec{
				code: "IMAGE_METADATA_SOURCE_MISMATCH", severity: SeverityError,
				dimension: DimensionImageMeaning, blocks: blockRefs(image.nodeID, "", ""),
				evidence:    []EvidenceReference{{Representation: RepresentationImageMetadata, NodeID: image.nodeID, SHA256: metadata.AssetSHA256}},
				expected:    map[string]any{"source_url_sha256": wantHTMLSourceHash},
				observed:    map[string]any{"source_url_sha256": metadata.SourceURLSHA256},
				explanation: "The image receipt is bound to a different normalized URL than the exact frozen HTML image source.",
				remediation: Remediation{Kind: RemediationReviewImageBroker, Representation: RepresentationImageMetadata, NodeID: image.nodeID},
			})
			continue
		}
		if node, nodeExists := a.semantic.nodes[image.nodeID]; nodeExists && node.Type == semanticemail.NodeImage {
			content := localizedContent(node, a.input.Compilation.Artifact.Locale)
			if content.Image == nil {
				continue
			}
			wantSourceHash, sourceErr := campaignimagebroker.SourceURLSHA256(content.Image.URL)
			if sourceErr != nil || metadata.SourceURLSHA256 != wantSourceHash {
				a.add(findingSpec{
					code: "IMAGE_METADATA_SOURCE_MISMATCH", severity: SeverityError,
					dimension:   DimensionImageMeaning,
					blocks:      blockRefs(image.nodeID, "", ""),
					evidence:    []EvidenceReference{{Representation: RepresentationImageMetadata, NodeID: image.nodeID, SHA256: metadata.AssetSHA256}},
					expected:    map[string]any{"source_url_sha256": wantSourceHash},
					observed:    map[string]any{"source_url_sha256": metadata.SourceURLSHA256},
					explanation: "The image metadata receipt is bound to a different source URL and cannot cover this semantic image.",
					remediation: Remediation{Kind: RemediationReviewImageBroker, Representation: RepresentationImageMetadata, NodeID: image.nodeID},
				})
				continue
			}
		}
		if (image.width > 0 && metadata.PixelWidth > 0 && image.width != metadata.PixelWidth) ||
			(image.height > 0 && metadata.PixelHeight > 0 && image.height != metadata.PixelHeight) {
			a.add(findingSpec{
				code: "IMAGE_DIMENSION_METADATA_MISMATCH", severity: SeverityWarning,
				dimension:   DimensionImageMeaning,
				blocks:      blockRefs(image.nodeID, "", ""),
				evidence:    []EvidenceReference{{Representation: RepresentationImageMetadata, NodeID: image.nodeID, SHA256: metadata.AssetSHA256}},
				expected:    map[string]any{"html_width": image.width, "html_height": image.height},
				observed:    map[string]any{"pixel_width": metadata.PixelWidth, "pixel_height": metadata.PixelHeight},
				explanation: "Inspected pixel dimensions differ from the dimensions declared in semantic HTML.",
				remediation: Remediation{Kind: RemediationReviewImageBroker, Representation: RepresentationImageMetadata, NodeID: image.nodeID},
			})
		}
	}
}

func analyzeContractRecovery(a *analysis) {
	if !a.contract.valid {
		return
	}
	contract := a.contract.contract
	analyzeCoreClaim(a, contract)
	analyzePrimaryAction(a, contract.PrimaryAction)
	for _, fact := range contract.RequiredFacts {
		analyzeRequiredFact(a, fact)
	}
	for _, claim := range contract.ForbiddenClaims {
		present := containsNormalizedText(a.input.Compilation.Text, claim.Statement) ||
			containsNormalizedText(a.html.visibleText, claim.Statement) || structuredContains(a.html.structuredScalars, []string{claim.Statement}) ||
			ocrContains(a.images, claim.Statement)
		if !present {
			continue
		}
		a.add(findingSpec{
			code: "FORBIDDEN_CLAIM_PRESENT", severity: SeverityCritical, blocking: true,
			overridable: true, dimension: DimensionFactContract,
			blocks: []BlockReference{{FactID: string(claim.ID)}},
			evidence: []EvidenceReference{
				{Representation: RepresentationPlainText, SHA256: digestBytes([]byte(a.input.Compilation.Text))},
				{Representation: RepresentationVisibleHTML, SHA256: digestBytes([]byte(a.html.visibleText))},
			},
			expected:    map[string]any{"forbidden_claim_id": claim.ID, "present": false},
			observed:    map[string]any{"present": true},
			explanation: "A statement explicitly forbidden by the Fact Contract is present in a compiled representation.",
			remediation: Remediation{Kind: RemediationAlignFact, Representation: RepresentationRevision, Field: "nodes"},
		})
	}
}

func analyzeCoreClaim(a *analysis, contract factcontract.ContractV1) {
	claim := contract.CoreClaim.Statement
	textFound := containsNormalizedText(a.input.Compilation.Text, claim)
	htmlFound := containsNormalizedText(a.html.visibleText, claim)
	if textFound && htmlFound {
		return
	}
	blocks := make([]BlockReference, 0, len(contract.CoreClaim.SourceBlockIDs))
	for _, id := range contract.CoreClaim.SourceBlockIDs {
		blocks = append(blocks, BlockReference{BlockID: string(id)})
	}
	a.add(findingSpec{
		code: "CORE_CLAIM_RECOVERY_FAILED", severity: SeverityCritical, blocking: true,
		overridable: true, dimension: DimensionFactContract, blocks: blocks,
		evidence:    representationRecoveryEvidence(a, textFound, htmlFound, false),
		expected:    map[string]any{"statement": claim, "text_plain": true, "visible_html": true},
		observed:    map[string]any{"text_plain": textFound, "visible_html": htmlFound},
		explanation: "The declared core claim is not exactly recoverable from every required live-text representation.",
		remediation: Remediation{Kind: RemediationAlignFact, Representation: RepresentationRevision, Field: "core_claim"},
	})
}

func analyzePrimaryAction(a *analysis, expected factcontract.PrimaryAction) {
	blockID, actionID := string(expected.BlockID), string(expected.ActionID)
	blocks := blockRefs(blockID, "", actionID)
	if a.semantic.valid {
		if _, included := a.semantic.included[blockID]; !included {
			a.add(findingSpec{
				code: "PRIMARY_ACTION_BLOCK_NOT_IN_SCENARIO", severity: SeverityCritical, blocking: true,
				overridable: true, dimension: DimensionPrimaryAction, blocks: blocks,
				evidence: []EvidenceReference{{Representation: RepresentationManifest, Location: "/compiler_receipt/included_node_ids", NodeID: blockID}},
				expected: map[string]any{"included": true}, observed: map[string]any{"included": false},
				explanation: "The Fact Contract primary-action block is excluded from this required scenario.",
				remediation: Remediation{Kind: RemediationFixPrimaryAction, Representation: RepresentationRevision, NodeID: blockID, Field: "conditions"},
			})
		}
	}
	textLabel := containsNormalizedText(a.input.Compilation.Text, expected.Label)
	textURL := expected.CanonicalURL == "" || containsCanonicalURL(a.input.Compilation.Text, expected.CanonicalURL)
	textFound := textLabel && textURL

	candidates := make([]htmlAction, 0)
	for _, action := range a.html.actions {
		if action.hidden {
			continue
		}
		if action.actionID == actionID || (action.actionID == "" && action.nodeID == blockID) ||
			(action.actionID == "" && canonicalURL(action.href) == canonicalURL(expected.CanonicalURL) && containsNormalizedText(action.label, expected.Label)) {
			candidates = append(candidates, action)
		}
	}
	htmlFound := false
	observedActions := make([]map[string]any, 0, len(candidates))
	for _, candidate := range candidates {
		labelOK := containsNormalizedText(candidate.label, expected.Label)
		urlOK := expected.CanonicalURL == "" || canonicalURL(candidate.href) == canonicalURL(expected.CanonicalURL)
		roleOK := a.input.Revision.SourceMode != campaignartifact.SourceModeSemantic || candidate.role == string(semanticemail.RolePrimaryAction)
		htmlFound = htmlFound || (labelOK && urlOK && roleOK)
		observedActions = append(observedActions, map[string]any{
			"action_id": candidate.actionID, "node_id": candidate.nodeID, "label": candidate.label,
			"canonical_url": canonicalURL(candidate.href), "role": candidate.role,
		})
	}

	semanticContradiction := false
	if node, exists := a.semantic.nodes[blockID]; exists && node.Type == semanticemail.NodeAction {
		content := localizedContent(node, a.input.Compilation.Artifact.Locale)
		if content.Action == nil || string(content.Action.ActionID) != actionID ||
			content.Action.Label != expected.Label || canonicalURL(content.Action.CanonicalURL) != canonicalURL(expected.CanonicalURL) {
			semanticContradiction = true
		}
	} else if a.input.Revision.SourceMode == campaignartifact.SourceModeSemantic {
		semanticContradiction = true
	}
	if semanticContradiction {
		a.add(findingSpec{
			code: "PRIMARY_ACTION_CONTRACT_CONTRADICTION", severity: SeverityCritical, blocking: true,
			overridable: true, dimension: DimensionPrimaryAction, blocks: blocks,
			evidence:    []EvidenceReference{{Representation: RepresentationRevision, Location: "/semantic_tree", NodeID: blockID}},
			expected:    map[string]any{"action_id": actionID, "label": expected.Label, "canonical_url": expected.CanonicalURL, "role": expected.Role},
			observed:    map[string]any{"source_node_matches": false},
			explanation: "The semantic source action contradicts the Fact Contract action identity, label, or destination.",
			remediation: Remediation{Kind: RemediationFixPrimaryAction, Representation: RepresentationRevision, NodeID: blockID, Field: "content.action"},
		})
	}

	structuredRelevant := hasSet(a.semantic.structuredNodeRefs, blockID) && len(a.input.Compilation.StructuredData) != 0
	structuredFound := true
	if structuredRelevant {
		structuredFound = expected.CanonicalURL == "" || structuredContainsURL(a.html.structuredScalars, expected.CanonicalURL)
		if !structuredFound {
			a.add(findingSpec{
				code: "PRIMARY_ACTION_SCHEMA_CONTRADICTION", severity: SeverityCritical, blocking: true,
				overridable: true, dimension: DimensionStructuredData, blocks: blocks,
				evidence:    []EvidenceReference{{Representation: RepresentationStructuredData, Location: "/", NodeID: blockID}},
				expected:    map[string]any{"canonical_url": expected.CanonicalURL},
				observed:    map[string]any{"url_values": structuredURLValues(a.html.structuredScalars)},
				explanation: "Structured data references the primary action block but does not carry its canonical destination.",
				remediation: Remediation{Kind: RemediationFixPrimaryAction, Representation: RepresentationRevision, NodeID: blockID, Field: "content.action.canonical_url", Replacement: expected.CanonicalURL},
			})
		}
	}

	if !textFound || !htmlFound {
		imageOnly := false
		for _, image := range a.html.images {
			if image.nodeID == blockID && image.alt != "" {
				imageOnly = true
			}
		}
		code := "PRIMARY_ACTION_RECOVERY_FAILED"
		if imageOnly || actionOnlyImage(candidates) {
			code = "PRIMARY_ACTION_IMAGE_ONLY"
		}
		a.add(findingSpec{
			code: code, severity: SeverityCritical, blocking: true,
			overridable: true, dimension: DimensionPrimaryAction, blocks: blocks,
			evidence: representationRecoveryEvidence(a, textFound, htmlFound, structuredRelevant && structuredFound),
			expected: map[string]any{
				"action_id": actionID, "label": expected.Label, "canonical_url": expected.CanonicalURL,
				"text_plain": true, "visible_html": true,
			},
			observed: map[string]any{
				"text_plain": textFound, "visible_html": htmlFound, "structured_data": structuredFound,
				"html_candidates": observedActions,
			},
			explanation: "The declared primary action is absent, wrong, hidden, or available only through image content in a required representation.",
			remediation: Remediation{Kind: RemediationFixPrimaryAction, Representation: RepresentationRevision, NodeID: blockID, Field: "content.action"},
		})
	}
}

func analyzeRequiredFact(a *analysis, fact factcontract.RequiredFact) {
	factID := string(fact.ID)
	blocks := make([]BlockReference, 0, len(fact.SourceBlockIDs))
	blockIDs := make([]string, 0, len(fact.SourceBlockIDs))
	for _, blockID := range fact.SourceBlockIDs {
		blocks = append(blocks, BlockReference{BlockID: string(blockID), FactID: factID})
		blockIDs = append(blockIDs, string(blockID))
	}
	if a.semantic.valid {
		for _, blockID := range blockIDs {
			if _, included := a.semantic.included[blockID]; included {
				continue
			}
			a.add(findingSpec{
				code: "FACT_SOURCE_BLOCK_NOT_IN_SCENARIO", severity: factSeverity(fact),
				blocking:    fact.Criticality == factcontract.CriticalityCritical,
				overridable: fact.Criticality == factcontract.CriticalityCritical,
				dimension:   DimensionFactContract,
				blocks:      []BlockReference{{BlockID: blockID, FactID: factID}},
				evidence:    []EvidenceReference{{Representation: RepresentationManifest, Location: "/compiler_receipt/included_node_ids", NodeID: blockID}},
				expected:    map[string]any{"included": true}, observed: map[string]any{"included": false},
				explanation: "A Fact Contract source block is excluded from this required scenario.",
				remediation: Remediation{Kind: RemediationAlignFact, Representation: RepresentationRevision, NodeID: blockID, Field: "conditions"},
			})
		}
	}
	sourceCandidates := sourceFactCandidates(a.semantic, blockIDs, a.input.Compilation.Artifact.Locale)
	if len(sourceCandidates) != 0 && !candidatesRecoverFact(sourceCandidates, fact) {
		a.add(findingSpec{
			code: "FACT_SOURCE_CONTRACT_CONTRADICTION", severity: factSeverity(fact),
			blocking:    fact.Criticality == factcontract.CriticalityCritical,
			overridable: fact.Criticality == factcontract.CriticalityCritical,
			dimension:   DimensionFactContract, blocks: blocks,
			evidence:    []EvidenceReference{{Representation: RepresentationRevision, Location: "/semantic_tree", Detail: "typed source values"}},
			expected:    map[string]any{"fact_id": factID, "display_value": fact.DisplayValue, "aliases": factAliases(fact)},
			observed:    map[string]any{"source_values": sourceCandidates},
			explanation: "The typed semantic source blocks carry a value that contradicts the Fact Contract declaration.",
			remediation: Remediation{Kind: RemediationAlignFact, Representation: RepresentationRevision, Field: "required_facts", Replacement: fact.DisplayValue},
		})
	}
	textFound := containsNormalizedText(a.input.Compilation.Text, fact.DisplayValue)
	htmlFound := containsNormalizedText(a.html.visibleText, fact.DisplayValue)
	blockHTMLFound, altFound := false, false
	for _, blockID := range blockIDs {
		blockHTMLFound = blockHTMLFound || containsNormalizedText(a.html.blockVisibleText[blockID], fact.DisplayValue)
		for _, alt := range a.html.blockAltText[blockID] {
			altFound = altFound || containsNormalizedText(alt, fact.DisplayValue)
		}
	}
	if htmlFound && !blockHTMLFound && len(blockIDs) != 0 {
		a.add(findingSpec{
			code: "FACT_SOURCE_BLOCK_DRIFT", severity: SeverityWarning,
			dimension: DimensionFactContract, blocks: blocks,
			evidence:    []EvidenceReference{{Representation: RepresentationVisibleHTML, Location: "/", SHA256: digestBytes([]byte(a.html.visibleText))}},
			expected:    map[string]any{"fact_id": factID, "display_value": fact.DisplayValue, "source_block_ids": blockIDs},
			observed:    map[string]any{"found_globally": true, "found_in_source_blocks": false},
			explanation: "The fact is visible, but not inside any semantic source block declared by the Fact Contract.",
			remediation: Remediation{Kind: RemediationAlignFact, Representation: RepresentationRevision, Field: "required_facts.source_block_ids"},
		})
	}

	structuredRelevant := false
	for _, blockID := range blockIDs {
		structuredRelevant = structuredRelevant || hasSet(a.semantic.structuredNodeRefs, blockID)
	}
	structuredRelevant = structuredRelevant && len(a.input.Compilation.StructuredData) != 0
	structuredFound := true
	if structuredRelevant {
		structuredFound = structuredRecoversFact(a.html.structuredScalars, fact)
		if !structuredFound {
			a.add(findingSpec{
				code: "FACT_STRUCTURED_DATA_CONTRADICTION", severity: factSeverity(fact),
				blocking:    fact.Criticality == factcontract.CriticalityCritical,
				overridable: fact.Criticality == factcontract.CriticalityCritical,
				dimension:   DimensionStructuredData, blocks: blocks,
				evidence:    []EvidenceReference{{Representation: RepresentationStructuredData, Location: "/", SHA256: digestBytes(a.input.Compilation.StructuredData)}},
				expected:    map[string]any{"fact_id": factID, "display_value": fact.DisplayValue, "aliases": factAliases(fact)},
				observed:    map[string]any{"candidate_values": structuredCandidatesForFact(a.html.structuredScalars, fact.Type)},
				explanation: "Structured data references this fact's semantic source but does not recover its declared normalized value.",
				remediation: Remediation{Kind: RemediationAlignFact, Representation: RepresentationRevision, Field: "required_facts", Replacement: fact.DisplayValue},
			})
		}
	}

	if textFound != htmlFound {
		a.add(findingSpec{
			code: "FACT_REPRESENTATION_DIVERGENCE", severity: factSeverity(fact),
			blocking:    fact.Criticality == factcontract.CriticalityCritical,
			overridable: fact.Criticality == factcontract.CriticalityCritical,
			dimension:   DimensionParity, blocks: blocks,
			evidence:    representationRecoveryEvidence(a, textFound, htmlFound, structuredRelevant && structuredFound),
			expected:    map[string]any{"fact_id": factID, "display_value": fact.DisplayValue, "text_plain": true, "visible_html": true},
			observed:    map[string]any{"text_plain": textFound, "visible_html": htmlFound},
			explanation: "A required display fact survives in one live-text representation but not the other.",
			remediation: Remediation{Kind: RemediationAlignFact, Representation: RepresentationRevision, Field: "required_facts", Replacement: fact.DisplayValue},
		})
	}
	imageSource := allSourceBlocksAreImages(a.semantic, blockIDs)
	if imageSource && !htmlFound {
		a.add(findingSpec{
			code: "FACT_MEANING_IMAGE_ONLY", severity: factSeverity(fact),
			blocking:    fact.Criticality == factcontract.CriticalityCritical,
			overridable: fact.Criticality == factcontract.CriticalityCritical,
			dimension:   DimensionImageMeaning, blocks: blocks,
			evidence:    representationRecoveryEvidence(a, textFound, htmlFound, structuredRelevant && structuredFound),
			expected:    map[string]any{"fact_id": factID, "display_value": fact.DisplayValue, "visible_live_text": true},
			observed:    map[string]any{"text_plain": textFound, "visible_html": htmlFound, "image_alt": altFound, "image_source_blocks": true},
			explanation: "The Fact Contract points only to image content; plain-text alt projection does not replace visible live HTML meaning.",
			remediation: Remediation{Kind: RemediationMoveMeaningOutOfImage, Representation: RepresentationRevision, Field: "nodes", Replacement: fact.DisplayValue},
		})
		analyzeCriticalImageCoverage(a, fact, blockIDs, blocks)
	}
	if !textFound && !htmlFound && !imageSource {
		code, dimension := "REQUIRED_FACT_DISPLAY_MISSING", DimensionFactContract
		remediation := RemediationAlignFact
		if imageSource || altFound {
			code, dimension, remediation = "FACT_MEANING_IMAGE_ONLY", DimensionImageMeaning, RemediationMoveMeaningOutOfImage
		}
		a.add(findingSpec{
			code: code, severity: factSeverity(fact),
			blocking:    fact.Criticality == factcontract.CriticalityCritical,
			overridable: fact.Criticality == factcontract.CriticalityCritical,
			dimension:   dimension, blocks: blocks,
			evidence:    representationRecoveryEvidence(a, false, false, structuredRelevant && structuredFound),
			expected:    map[string]any{"fact_id": factID, "display_value": fact.DisplayValue, "text_plain": true, "visible_html": true},
			observed:    map[string]any{"text_plain": false, "visible_html": false, "image_alt": altFound, "image_source_blocks": imageSource},
			explanation: "A required display fact is missing from live HTML and semantic plain text; image alternatives do not replace live critical meaning.",
			remediation: Remediation{Kind: remediation, Representation: RepresentationRevision, Field: "nodes", Replacement: fact.DisplayValue},
		})
		if a.input.Revision.SourceMode == campaignartifact.SourceModeLegacyHTML && len(a.html.images) != 0 {
			a.add(findingSpec{
				code: "IMAGE_TEXT_RECOVERY_UNAVAILABLE", severity: factSeverity(fact),
				blocking:    fact.Criticality == factcontract.CriticalityCritical,
				overridable: fact.Criticality == factcontract.CriticalityCritical,
				dimension:   DimensionImageMeaning, blocks: blocks,
				evidence:    []EvidenceReference{{Representation: RepresentationImageMetadata, Location: "/", Detail: "legacy HTML images present"}},
				expected:    map[string]any{"fact_id": factID, "display_value": fact.DisplayValue, "image_text_recovery": "available"},
				observed:    map[string]any{"image_count": len(a.html.images), "image_ocr": CapabilityUnavailable},
				explanation: "A required fact is missing from live text while legacy images are present; this offline engine cannot determine whether pixels carry it.",
				remediation: Remediation{Kind: RemediationReviewImageBroker, Representation: RepresentationImageMetadata},
			})
		}
	}
}

func analyzeCriticalImageCoverage(a *analysis, fact factcontract.RequiredFact, blockIDs []string, blocks []BlockReference) {
	if fact.Criticality != factcontract.CriticalityCritical {
		return
	}
	for _, blockID := range blockIDs {
		node := a.semantic.nodes[blockID]
		if node.Type != semanticemail.NodeImage {
			continue
		}
		metadata, exists := a.images[blockID]
		matchesSource := exists && imageMetadataMatchesNode(a.semantic, blockID, metadata, a.input.Compilation.Artifact.Locale)
		if matchesSource && metadata.Status == ImageInspectionVerified && metadata.OCRStatus == ImageOCRComplete &&
			ocrRecoversFact(metadata.OCRText, fact) {
			continue
		}
		status, failure := ImageInspectionUnavailable, ""
		if exists {
			status, failure = metadata.Status, metadata.FailureCode
		}
		code := "CRITICAL_IMAGE_INSPECTION_UNAVAILABLE"
		explanation := "A critical fact points only to an image, but safe evidence-bound OCR is unavailable; image metadata alone cannot establish meaning coverage."
		if matchesSource && metadata.Status == ImageInspectionVerified && metadata.OCRStatus == ImageOCRComplete {
			code = "CRITICAL_IMAGE_OCR_RECOVERY_FAILED"
			explanation = "Safe evidence-bound OCR completed, but it did not recover the critical Fact Contract value from the image."
		}
		a.add(findingSpec{
			code: code, severity: SeverityCritical,
			blocking: true, overridable: true, dimension: DimensionImageMeaning, blocks: blocks,
			evidence: []EvidenceReference{
				{Representation: RepresentationImageMetadata, NodeID: blockID, SHA256: metadata.AssetSHA256},
				{Representation: RepresentationImageOCR, NodeID: blockID, SHA256: metadata.OCRTextSHA256},
			},
			expected:    map[string]any{"status": ImageInspectionVerified, "ocr_status": ImageOCRComplete, "fact_recovered": true},
			observed:    map[string]any{"status": status, "failure_code": failure, "ocr_status": metadata.OCRStatus, "ocr_failure_code": metadata.OCRFailureCode, "fact_recovered": exists && ocrRecoversFact(metadata.OCRText, fact)},
			explanation: explanation,
			remediation: Remediation{Kind: RemediationReviewImageBroker, Representation: RepresentationImageMetadata, NodeID: blockID},
		})
	}
}

func imageMetadataMatchesNode(semantic semanticAnalysis, blockID string, metadata ImageMetadata, locale string) bool {
	node, exists := semantic.nodes[blockID]
	if !exists || node.Type != semanticemail.NodeImage {
		return false
	}
	content := localizedContent(node, locale)
	if content.Image == nil {
		return false
	}
	want, err := campaignimagebroker.SourceURLSHA256(content.Image.URL)
	return err == nil && metadata.SourceURLSHA256 == want
}

func ocrContains(images map[string]ImageMetadata, value string) bool {
	for _, metadata := range images {
		if metadata.OCRStatus == ImageOCRComplete && containsNormalizedText(metadata.OCRText, value) {
			return true
		}
	}
	return false
}

func ocrRecoversFact(text string, fact factcontract.RequiredFact) bool {
	if containsNormalizedText(text, fact.DisplayValue) {
		return true
	}
	for _, alias := range factAliases(fact) {
		if containsNormalizedText(text, alias) {
			return true
		}
	}
	return false
}

func localizedContent(node semanticemail.Node, locale string) semanticemail.NodeContent {
	locale = strings.TrimSpace(locale)
	if content, exists := node.Localizations[locale]; exists {
		return content
	}
	return node.Content
}

func allSourceBlocksAreImages(semantic semanticAnalysis, blockIDs []string) bool {
	if len(blockIDs) == 0 || !semantic.valid {
		return false
	}
	for _, blockID := range blockIDs {
		node, exists := semantic.nodes[blockID]
		if !exists || node.Type != semanticemail.NodeImage {
			return false
		}
	}
	return true
}

func sourceFactCandidates(semantic semanticAnalysis, blockIDs []string, locale string) []string {
	values := make([]string, 0)
	for _, blockID := range blockIDs {
		if _, included := semantic.included[blockID]; !included {
			continue
		}
		node, exists := semantic.nodes[blockID]
		if !exists {
			continue
		}
		content := localizedContent(node, locale)
		switch node.Type {
		case semanticemail.NodeHeading:
			if content.Heading != nil {
				values = append(values, semanticRichText(content.Heading.Text))
			}
		case semanticemail.NodeParagraph:
			if content.Paragraph != nil {
				values = append(values, semanticRichText(content.Paragraph.Text))
			}
		case semanticemail.NodeFact:
			if content.Fact != nil {
				values = append(values, content.Fact.Value)
			}
		case semanticemail.NodeDateTime:
			if content.DateTime != nil {
				values = append(values, content.DateTime.DisplayValue, content.DateTime.RFC3339, content.DateTime.Timezone)
			}
		case semanticemail.NodeDeadline:
			if content.Deadline != nil {
				values = append(values, content.Deadline.DisplayValue, content.Deadline.RFC3339, content.Deadline.Timezone)
			}
		case semanticemail.NodeMoney:
			if content.Money != nil {
				values = append(values, content.Money.DisplayValue, content.Money.Amount, content.Money.Currency)
			}
		case semanticemail.NodeLocation:
			if content.Location != nil {
				values = append(values, content.Location.Name, content.Location.Address.StreetAddress,
					content.Location.Address.AddressLocality, content.Location.Address.AddressRegion,
					content.Location.Address.PostalCode, content.Location.Address.AddressCountry)
			}
		case semanticemail.NodeOffer:
			if content.Offer != nil {
				values = append(values, semanticRichText(content.Offer.Description), content.Offer.Code, semanticRichText(content.Offer.Terms))
				if content.Offer.AvailabilityStarts != nil {
					values = append(values, content.Offer.AvailabilityStarts.DisplayValue, content.Offer.AvailabilityStarts.RFC3339)
				}
				if content.Offer.AvailabilityEnds != nil {
					values = append(values, content.Offer.AvailabilityEnds.DisplayValue, content.Offer.AvailabilityEnds.RFC3339)
				}
			}
		case semanticemail.NodeProduct:
			if content.Product != nil {
				values = append(values, content.Product.Name, content.Product.SKU, content.Product.CanonicalURL)
			}
		case semanticemail.NodeImage:
			if content.Image != nil {
				values = append(values, content.Image.Alt)
			}
		}
	}
	return uniqueSortedNonEmpty(values)
}

func candidatesRecoverFact(candidates []string, fact factcontract.RequiredFact) bool {
	contains := func(value string) bool {
		for _, candidate := range candidates {
			if containsNormalizedText(candidate, value) || containsNormalizedText(value, candidate) {
				return true
			}
		}
		return false
	}
	if contains(fact.DisplayValue) {
		return true
	}
	switch fact.Type {
	case factcontract.FactTypeDateTime:
		return fact.DateTimeValue != nil && contains(fact.DateTimeValue.RFC3339)
	case factcontract.FactTypeMoney:
		return fact.MoneyValue != nil && contains(fact.MoneyValue.Amount) && contains(string(fact.MoneyValue.Currency))
	case factcontract.FactTypePercentage, factcontract.FactTypeQuantity:
		return fact.NumberValue != nil && contains(fact.NumberValue.Value)
	case factcontract.FactTypeURL:
		if fact.URLValue == nil {
			return false
		}
		for _, candidate := range candidates {
			if canonicalURL(candidate) == canonicalURL(*fact.URLValue) {
				return true
			}
		}
		return false
	default:
		return fact.TextValue != nil && contains(*fact.TextValue)
	}
}

func semanticRichText(value semanticemail.RichText) string {
	parts := make([]string, 0, len(value.Runs))
	for _, run := range value.Runs {
		switch run.Kind {
		case semanticemail.InlineText, semanticemail.InlineStrong, semanticemail.InlineEmphasis, semanticemail.InlineLink:
			parts = append(parts, run.Text)
		case semanticemail.InlineSlot:
			if run.Slot != nil {
				parts = append(parts, run.Slot.Fallback)
			}
		}
	}
	return normalizeText(strings.Join(parts, " "))
}

func factSeverity(fact factcontract.RequiredFact) Severity {
	switch fact.Criticality {
	case factcontract.CriticalityCritical:
		return SeverityCritical
	case factcontract.CriticalityImportant:
		return SeverityError
	default:
		return SeverityWarning
	}
}

func factAliases(fact factcontract.RequiredFact) []string {
	values := []string{fact.DisplayValue}
	if fact.TextValue != nil {
		values = append(values, *fact.TextValue)
	}
	if fact.DateTimeValue != nil {
		values = append(values, fact.DateTimeValue.RFC3339, fact.DateTimeValue.Timezone)
	}
	if fact.MoneyValue != nil {
		values = append(values, fact.MoneyValue.Amount, string(fact.MoneyValue.Currency),
			fact.MoneyValue.Amount+" "+string(fact.MoneyValue.Currency))
	}
	if fact.NumberValue != nil {
		values = append(values, fact.NumberValue.Value, fact.NumberValue.Value+fact.NumberValue.Unit,
			fact.NumberValue.Value+" "+fact.NumberValue.Unit)
	}
	if fact.URLValue != nil {
		values = append(values, *fact.URLValue)
	}
	return uniqueSortedNonEmpty(values)
}

func structuredContains(scalars []jsonScalar, aliases []string) bool {
	for _, scalar := range scalars {
		for _, alias := range aliases {
			if normalizeText(scalar.value) == normalizeText(alias) {
				return true
			}
		}
	}
	return false
}

func structuredRecoversFact(scalars []jsonScalar, fact factcontract.RequiredFact) bool {
	if structuredContains(scalars, []string{fact.DisplayValue}) {
		return true
	}
	switch fact.Type {
	case factcontract.FactTypeDateTime:
		return fact.DateTimeValue != nil && structuredContains(scalars, []string{fact.DateTimeValue.RFC3339})
	case factcontract.FactTypeMoney:
		return fact.MoneyValue != nil &&
			structuredContains(scalars, []string{fact.MoneyValue.Amount}) &&
			structuredContains(scalars, []string{string(fact.MoneyValue.Currency)})
	case factcontract.FactTypePercentage, factcontract.FactTypeQuantity:
		return fact.NumberValue != nil && structuredContains(scalars, []string{fact.NumberValue.Value})
	case factcontract.FactTypeURL:
		return fact.URLValue != nil && structuredContainsURL(scalars, *fact.URLValue)
	default:
		if fact.TextValue != nil {
			return structuredContains(scalars, []string{*fact.TextValue})
		}
		return false
	}
}

func structuredContainsURL(scalars []jsonScalar, expected string) bool {
	want := canonicalURL(expected)
	for _, scalar := range scalars {
		if canonicalURL(scalar.value) == want && want != "" {
			return true
		}
	}
	return false
}

func structuredURLValues(scalars []jsonScalar) []string {
	values := make([]string, 0)
	for _, scalar := range scalars {
		if strings.HasSuffix(scalar.path, "/url") {
			values = append(values, canonicalURL(scalar.value))
		}
		if len(values) == 16 {
			break
		}
	}
	return uniqueSortedNonEmpty(values)
}

func structuredCandidatesForFact(scalars []jsonScalar, factType factcontract.FactType) []string {
	var keys []string
	switch factType {
	case factcontract.FactTypeDateTime:
		keys = []string{"date", "start", "end"}
	case factcontract.FactTypeMoney:
		keys = []string{"price", "currency", "discount"}
	case factcontract.FactTypeLocation:
		keys = []string{"location", "address", "name"}
	case factcontract.FactTypeCode:
		keys = []string{"code", "number"}
	case factcontract.FactTypePercentage, factcontract.FactTypeQuantity:
		keys = []string{"value", "quantity", "discount"}
	case factcontract.FactTypeURL:
		keys = []string{"url"}
	default:
		keys = []string{"name", "description", "text"}
	}
	values := make([]string, 0)
	for _, scalar := range scalars {
		lowerPath := strings.ToLower(scalar.path)
		for _, key := range keys {
			if strings.Contains(lowerPath, key) {
				values = append(values, scalar.value)
				break
			}
		}
		if len(values) == 16 {
			break
		}
	}
	return uniqueSortedNonEmpty(values)
}

func representationRecoveryEvidence(a *analysis, textFound, htmlFound, structuredFound bool) []EvidenceReference {
	return []EvidenceReference{
		{Representation: RepresentationPlainText, Location: "/", SHA256: digestBytes([]byte(a.input.Compilation.Text)), Detail: fmt.Sprintf("recovered=%t", textFound)},
		{Representation: RepresentationVisibleHTML, Location: "/", SHA256: digestBytes([]byte(a.html.visibleText)), Detail: fmt.Sprintf("recovered=%t", htmlFound)},
		{Representation: RepresentationStructuredData, Location: "/", SHA256: digestBytes(a.input.Compilation.StructuredData), Detail: fmt.Sprintf("recovered=%t", structuredFound)},
	}
}

func canonicalURL(value string) string {
	value = strings.TrimSpace(value)
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return value
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	query := parsed.Query()
	for _, key := range []string{"utm_source", "utm_medium", "utm_campaign"} {
		query.Del(key)
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func containsCanonicalURL(text, expected string) bool {
	want := canonicalURL(expected)
	if want == "" {
		return false
	}
	for _, field := range strings.Fields(text) {
		candidate := strings.Trim(field, "<>[](){}\"'.,;:")
		if canonicalURL(candidate) == want {
			return true
		}
	}
	return strings.Contains(text, expected)
}

func actionOnlyImage(actions []htmlAction) bool {
	if len(actions) == 0 {
		return false
	}
	for _, action := range actions {
		if action.label != "" {
			return false
		}
	}
	return true
}

func hasSet(values map[string]struct{}, key string) bool {
	_, exists := values[key]
	return exists
}

func uniqueSortedNonEmpty(values []string) []string {
	result := values[:0]
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			result = append(result, value)
		}
	}
	sort.Strings(result)
	unique := result[:0]
	for _, value := range result {
		if len(unique) == 0 || unique[len(unique)-1] != value {
			unique = append(unique, value)
		}
	}
	return unique
}
