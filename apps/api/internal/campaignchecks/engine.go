// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

type analysis struct {
	input         Input
	policyVersion string
	findings      []Finding
	deduplicate   map[string]struct{}
	contract      contractAnalysis
	semantic      semanticAnalysis
	html          htmlAnalysis
	images        map[string]ImageMetadata
	truncated     bool
}

type findingSpec struct {
	code        string
	severity    Severity
	blocking    bool
	overridable bool
	dimension   Dimension
	blocks      []BlockReference
	evidence    []EvidenceReference
	expected    any
	observed    any
	explanation string
	remediation Remediation
	patch       *TypedPatchV1
}

// Analyze executes the complete deterministic suite. It is pure with respect
// to its input: it performs no I/O, follows no links, and uses no clock or
// randomness. Invalid or over-limit evidence becomes a finding rather than a
// partial error that a caller might accidentally treat as a pass.
func Analyze(input Input) Report {
	policyVersion := strings.TrimSpace(input.PolicyVersion)
	if policyVersion == "" {
		policyVersion = DefaultPolicyVersion
	}
	policyInvalid := !validBoundedText(policyVersion, 160)
	if policyInvalid {
		policyVersion = DefaultPolicyVersion
	}
	a := &analysis{
		input: input, policyVersion: policyVersion,
		deduplicate: make(map[string]struct{}),
		images:      make(map[string]ImageMetadata),
	}
	if policyInvalid {
		a.add(findingSpec{
			code: "POLICY_VERSION_INVALID", severity: SeverityCritical, blocking: true,
			dimension:   DimensionInput,
			observed:    map[string]any{"sha256": digestBytes([]byte(input.PolicyVersion)), "bytes": len(input.PolicyVersion)},
			explanation: "The supplied policy version is invalid; the report used the default identity and cannot certify the requested policy.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationManifest},
		})
	}
	a.validateInputBounds()
	a.indexImageMetadata()
	a.contract = analyzeContract(a)
	a.semantic = analyzeSemantic(a)
	a.html = analyzeHTML(a)
	analyzeManifest(a)
	analyzeMIME(a)
	analyzeSemantics(a)
	analyzeImageReceipts(a)
	analyzeContractRecovery(a)
	// F06's deterministic half. It runs after contract recovery because it
	// consults the declared primary action when one exists, and it stays inside
	// Analyze because knowing that a button is a picture needs no model.
	analyzeCallToActionLegibility(a)
	// F15's canonical-offer bridge. Last, and from a PRE-RESOLVED input: it is
	// the only rule in this package whose facts come from a database read rather
	// than from the artifact, so the read happens in the caller and Analyze stays
	// pure and deterministic.
	a.evaluateCanonicalOffers(a.input.CanonicalOffers)
	a.finalize()

	return Report{
		DetectorVersion: DetectorVersion,
		PolicyVersion:   policyVersion,
		ScenarioID:      strings.TrimSpace(input.Compilation.Artifact.ScenarioID),
		Capabilities: []Capability{
			imageOCRCapability(a),
			{
				ID: "model_comprehension", Status: CapabilityUnavailable,
				Reason: "this report contains structural and exact-recovery checks only",
			},
		},
		Findings: append([]Finding{}, a.findings...),
	}
}

func (a *analysis) validateInputBounds() {
	if !validSHA256(a.input.Revision.SourceHash) {
		a.add(findingSpec{
			code: "SOURCE_HASH_INVALID", severity: SeverityCritical, blocking: true,
			dimension:   DimensionInput,
			evidence:    []EvidenceReference{{Representation: RepresentationRevision, Location: "/source_hash"}},
			observed:    map[string]any{"bytes": len(a.input.Revision.SourceHash)},
			explanation: "The immutable revision source hash is not a lowercase SHA-256 identity.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationRevision},
		})
	}
	checks := []struct {
		name           string
		representation Representation
		size, maximum  int
	}{
		{"HTML", RepresentationHTMLSource, len(a.input.Compilation.HTML), MaxHTMLBytes},
		{"plain text", RepresentationPlainText, len(a.input.Compilation.Text), MaxTextBytes},
		{"RFC 822 message", RepresentationMIME, len(a.input.Compilation.RFC822), MaxMIMEBytes},
		{"structured data", RepresentationStructuredData, len(a.input.Compilation.StructuredData), MaxStructuredDataBytes},
		{"Fact Contract", RepresentationRevision, len(a.input.Revision.FactContract), MaxFactContractBytes},
		{"artifact compiler receipt", RepresentationManifest, len(a.input.Compilation.Artifact.CompilerReceipt), MaxReceiptJSONBytes},
		{"artifact representation manifest", RepresentationManifest, len(a.input.Compilation.Artifact.RepresentationManifest), MaxReceiptJSONBytes},
	}
	for _, check := range checks {
		if check.size <= check.maximum {
			continue
		}
		a.add(findingSpec{
			code: "INPUT_LIMIT_EXCEEDED", severity: SeverityCritical, blocking: true,
			dimension:   DimensionInput,
			evidence:    []EvidenceReference{{Representation: check.representation, Detail: check.name}},
			expected:    map[string]any{"maximum_bytes": check.maximum},
			observed:    map[string]any{"bytes": check.size},
			explanation: check.name + " exceeds the deterministic analyzer's resource limit and was not parsed.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: check.representation},
		})
	}
	if len(a.input.ImageMetadata) > MaxImages {
		a.add(findingSpec{
			code: "IMAGE_METADATA_LIMIT_EXCEEDED", severity: SeverityError, blocking: true,
			overridable: true, dimension: DimensionImageMeaning,
			expected:    map[string]any{"maximum_entries": MaxImages},
			observed:    map[string]any{"entries": len(a.input.ImageMetadata)},
			explanation: "Image metadata exceeds the bounded campaign inspection limit.",
			remediation: Remediation{Kind: RemediationReviewImageBroker, Representation: RepresentationImageMetadata},
		})
	}
	for name, count := range map[string]int{
		"included_node_ids":   len(a.input.Compilation.Receipt.IncludedNodeIDs),
		"structured_statuses": len(a.input.Compilation.Receipt.StructuredStatuses),
		"utm_parameters":      len(a.input.Compilation.Receipt.Transform.UTMParameters),
		"alternative_order":   len(a.input.Compilation.RepresentationManifest.AlternativeOrder),
	} {
		if count <= MaxReceiptEntries {
			continue
		}
		a.add(findingSpec{
			code: "RECEIPT_ENTRY_LIMIT_EXCEEDED", severity: SeverityCritical, blocking: true,
			dimension: DimensionInput,
			evidence:  []EvidenceReference{{Representation: RepresentationManifest, Location: "/" + name}},
			expected:  map[string]any{"maximum_entries": MaxReceiptEntries}, observed: map[string]any{"entries": count},
			explanation: "A compiler receipt collection exceeds the deterministic analysis limit.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationManifest},
		})
	}
}

func (a *analysis) indexImageMetadata() {
	limit := len(a.input.ImageMetadata)
	if limit > MaxImages {
		limit = MaxImages
	}
	nodeCounts := make(map[string]int, limit)
	for i := 0; i < limit; i++ {
		if nodeID := strings.TrimSpace(a.input.ImageMetadata[i].NodeID); nodeID != "" {
			nodeCounts[nodeID]++
		}
	}
	for i := 0; i < limit; i++ {
		metadata := a.input.ImageMetadata[i]
		if len(metadata.NodeID) > MaxMetadataStringBytes || len(metadata.SourceURLSHA256) > MaxMetadataStringBytes ||
			len(metadata.AssetSHA256) > MaxMetadataStringBytes || len(metadata.MediaType) > MaxMetadataStringBytes ||
			len(metadata.InspectorVersion) > MaxMetadataStringBytes || len(metadata.FailureCode) > MaxMetadataStringBytes ||
			len(metadata.HTMLLocation) > MaxMetadataStringBytes || len(metadata.RasterObjectRef) > MaxImageObjectRefBytes ||
			len(metadata.OCREngine) > MaxMetadataStringBytes || len(metadata.OCREngineVersion) > MaxMetadataStringBytes ||
			len(metadata.OCRRuntimeVersion) > MaxMetadataStringBytes || len(metadata.OCRFailureCode) > MaxMetadataStringBytes ||
			len(metadata.OCRText) > MaxOCRTextBytes {
			a.add(findingSpec{
				code: "IMAGE_METADATA_INVALID", severity: SeverityWarning, dimension: DimensionImageMeaning,
				evidence:    []EvidenceReference{{Representation: RepresentationImageMetadata, Location: fmt.Sprintf("/%d", i), Detail: "string limit exceeded"}},
				observed:    map[string]any{"maximum_string_bytes": MaxMetadataStringBytes},
				explanation: "The supplied image metadata receipt contains an over-limit string and was ignored.",
				remediation: Remediation{Kind: RemediationReviewImageBroker, Representation: RepresentationImageMetadata},
			})
			continue
		}
		metadata.NodeID = strings.TrimSpace(metadata.NodeID)
		metadata.HTMLLocation = strings.TrimSpace(metadata.HTMLLocation)
		metadata.FrozenSourceSHA256 = strings.TrimSpace(metadata.FrozenSourceSHA256)
		metadata.ArtifactSHA256 = strings.TrimSpace(metadata.ArtifactSHA256)
		metadata.HTMLSHA256 = strings.TrimSpace(metadata.HTMLSHA256)
		metadata.SourceURLSHA256 = strings.TrimSpace(metadata.SourceURLSHA256)
		metadata.AssetSHA256 = strings.TrimSpace(metadata.AssetSHA256)
		metadata.RasterSHA256 = strings.TrimSpace(metadata.RasterSHA256)
		metadata.RasterObjectRef = strings.TrimSpace(metadata.RasterObjectRef)
		metadata.MediaType = strings.ToLower(strings.TrimSpace(metadata.MediaType))
		metadata.InspectorVersion = strings.TrimSpace(metadata.InspectorVersion)
		metadata.PolicyHash = strings.TrimSpace(metadata.PolicyHash)
		metadata.FailureCode = strings.TrimSpace(metadata.FailureCode)
		metadata.OCRFailureCode = strings.TrimSpace(metadata.OCRFailureCode)
		metadata.OCRText = strings.TrimSpace(metadata.OCRText)
		metadata.OCRTextSHA256 = strings.TrimSpace(metadata.OCRTextSHA256)
		metadata.OCRLanguage = strings.TrimSpace(metadata.OCRLanguage)
		metadata.OCREngine = strings.TrimSpace(metadata.OCREngine)
		metadata.OCREngineVersion = strings.TrimSpace(metadata.OCREngineVersion)
		metadata.OCRRuntimeVersion = strings.TrimSpace(metadata.OCRRuntimeVersion)
		valid := validImageMetadata(a.input, metadata)
		switch metadata.Status {
		case ImageInspectionUnavailable, ImageInspectionFailed:
		case ImageInspectionVerified:
		default:
			valid = false
		}
		duplicate := metadata.NodeID != "" && nodeCounts[metadata.NodeID] > 1
		if !valid || duplicate {
			a.add(findingSpec{
				code: "IMAGE_METADATA_INVALID", severity: SeverityWarning,
				dimension:   DimensionImageMeaning,
				blocks:      []BlockReference{{BlockID: metadata.NodeID}},
				evidence:    []EvidenceReference{{Representation: RepresentationImageMetadata, Location: fmt.Sprintf("/%d", i), NodeID: metadata.NodeID}},
				observed:    map[string]any{"duplicate_node_id": duplicate, "status": metadata.Status},
				explanation: "The supplied image metadata receipt is malformed or duplicates a node and was ignored.",
				remediation: Remediation{Kind: RemediationReviewImageBroker, Representation: RepresentationImageMetadata, NodeID: metadata.NodeID},
			})
			continue
		}
		if metadata.NodeID != "" {
			a.images[metadata.NodeID] = metadata
		}
		a.input.ImageMetadata[i] = metadata
	}
}

func validImageMetadata(input Input, metadata ImageMetadata) bool {
	bound := metadata.FrozenSourceSHA256 == input.Revision.SourceHash &&
		metadata.ArtifactSHA256 == input.Compilation.Artifact.OutboundMIMEHash &&
		metadata.HTMLSHA256 == input.Compilation.Artifact.HTMLHash &&
		validSHA256(metadata.FrozenSourceSHA256) && validSHA256(metadata.ArtifactSHA256) &&
		validSHA256(metadata.HTMLSHA256) && metadata.EncodedBytes >= 0 && metadata.PixelWidth >= 0 &&
		metadata.PixelHeight >= 0 && metadata.FrameCount >= 0 && metadata.SelectedFrame >= 0
	if !bound || metadata.NodeID == "" && metadata.HTMLLocation == "" {
		return false
	}
	switch metadata.Status {
	case ImageInspectionUnavailable, ImageInspectionFailed:
		return validFailureCode(metadata.FailureCode) && metadata.OCRStatus != ImageOCRComplete &&
			metadata.OCRText == "" && metadata.OCRTextSHA256 == ""
	case ImageInspectionVerified:
		if !validVerifiedImageMetadata(metadata) {
			return false
		}
	default:
		return false
	}
	return validImageOCRMetadata(metadata)
}

// validVerifiedImageMetadata checks the inspection fields a verified image
// must carry: complete content identity plus bounded resource dimensions.
func validVerifiedImageMetadata(metadata ImageMetadata) bool {
	if metadata.NodeID == "" || !validSHA256(metadata.SourceURLSHA256) || !validSHA256(metadata.AssetSHA256) ||
		!validSHA256(metadata.RasterSHA256) || !validSHA256(metadata.PolicyHash) || metadata.MediaType == "" ||
		metadata.InspectorVersion == "" || metadata.EncodedBytes <= 0 || metadata.EncodedBytes > MaxImageEncodedBytes ||
		metadata.PixelWidth <= 0 || metadata.PixelHeight <= 0 || metadata.PixelWidth > MaxImageDimension ||
		metadata.PixelHeight > MaxImageDimension || int64(metadata.PixelWidth)*int64(metadata.PixelHeight) > MaxImagePixels ||
		metadata.FrameCount < 1 || metadata.SelectedFrame >= metadata.FrameCount {
		return false
	}
	return true
}

// validImageOCRMetadata checks the OCR fields of a verified image against its
// OCR status: failures carry a code and no text, completions carry
// content-bound text with engine identity and a bounded language/confidence.
func validImageOCRMetadata(metadata ImageMetadata) bool {
	switch metadata.OCRStatus {
	case ImageOCRUnavailable, ImageOCRFailed:
		return validFailureCode(metadata.OCRFailureCode) && metadata.OCRText == "" && metadata.OCRTextSHA256 == ""
	case ImageOCRComplete:
		if metadata.RasterObjectRef == "" || len(metadata.RasterObjectRef) > MaxImageObjectRefBytes ||
			strings.Contains(metadata.RasterObjectRef, "://") || !validSHA256(metadata.OCRTextSHA256) ||
			digestBytes([]byte(metadata.OCRText)) != metadata.OCRTextSHA256 ||
			!utf8.ValidString(metadata.OCRText) || metadata.OCREngine == "" || metadata.OCREngineVersion == "" ||
			metadata.OCRRuntimeVersion == "" || metadata.OCRFailureCode != "" {
			return false
		}
		if metadata.OCRText == "" {
			return metadata.OCRLanguage == "" && metadata.OCRConfidence == nil
		}
		tag, err := language.Parse(metadata.OCRLanguage)
		if err != nil || tag == language.Und || metadata.OCRConfidence != nil &&
			(math.IsNaN(*metadata.OCRConfidence) || math.IsInf(*metadata.OCRConfidence, 0) ||
				*metadata.OCRConfidence < 0 || *metadata.OCRConfidence > 1) {
			return false
		}
		return true
	default:
		return false
	}
}

func validFailureCode(value string) bool {
	if len(value) < 1 || len(value) > 160 {
		return false
	}
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' {
			continue
		}
		return false
	}
	return true
}

func imageOCRCapability(a *analysis) Capability {
	if len(a.input.ImageMetadata) == 0 {
		return Capability{
			ID: "image_ocr", Status: CapabilityUnavailable,
			Reason: "no evidence-bound image OCR receipts were supplied",
		}
	}
	requiredNodes := make(map[string]struct{}, len(a.html.images))
	for _, image := range a.html.images {
		if image.nodeID == "" {
			return Capability{ID: "image_ocr", Status: CapabilityUnavailable, Reason: "one or more rendered images lack frozen semantic node identity"}
		}
		requiredNodes[image.nodeID] = struct{}{}
	}
	if len(requiredNodes) == 0 {
		return Capability{ID: "image_ocr", Status: CapabilityUnavailable, Reason: "no rendered reviewed image required OCR"}
	}
	version := ""
	for _, receipt := range a.input.ImageMetadata {
		if !validImageMetadata(a.input, receipt) || receipt.Status != ImageInspectionVerified || receipt.OCRStatus != ImageOCRComplete {
			return Capability{
				ID: "image_ocr", Status: CapabilityUnavailable,
				Reason: "one or more reviewed image OCR receipts are unavailable, failed, or invalid",
			}
		}
		if version == "" {
			version = receipt.OCRRuntimeVersion
		} else if version != receipt.OCRRuntimeVersion {
			return Capability{ID: "image_ocr", Status: CapabilityUnavailable, Reason: "OCR runtime identities differ within the artifact"}
		}
	}
	for nodeID := range requiredNodes {
		receipt, exists := a.images[nodeID]
		if !exists || receipt.Status != ImageInspectionVerified || receipt.OCRStatus != ImageOCRComplete {
			return Capability{ID: "image_ocr", Status: CapabilityUnavailable, Reason: "OCR receipts do not cover every rendered reviewed image"}
		}
	}
	for _, image := range a.html.images {
		sourceHash, err := campaignimagebroker.SourceURLSHA256(image.src)
		receipt, exists := a.images[image.nodeID]
		if err != nil || !exists || receipt.SourceURLSHA256 != sourceHash {
			return Capability{ID: "image_ocr", Status: CapabilityUnavailable, Reason: "one or more OCR receipts do not match the exact frozen HTML image source"}
		}
	}
	return Capability{ID: "image_ocr", Status: CapabilityProvided, Version: version}
}

func analyzeImageReceipts(a *analysis) {
	for i, metadata := range a.input.ImageMetadata {
		if !validImageMetadata(a.input, metadata) {
			continue
		}
		evidence := []EvidenceReference{{
			Representation: RepresentationImageMetadata, Location: fmt.Sprintf("/%d", i),
			NodeID: metadata.NodeID, SHA256: metadata.AssetSHA256,
		}}
		if metadata.Status == ImageInspectionFailed || metadata.Status == ImageInspectionUnavailable {
			a.add(findingSpec{
				code: "IMAGE_BROKER_UNAVAILABLE", severity: SeverityWarning, dimension: DimensionImageMeaning,
				blocks: blockRefs(metadata.NodeID, "", ""), evidence: evidence,
				expected:    map[string]any{"status": ImageInspectionVerified},
				observed:    map[string]any{"status": metadata.Status, "failure_code": metadata.FailureCode},
				explanation: "The reviewed image source could not be safely fetched and validated; no image meaning success was inferred.",
				remediation: Remediation{Kind: RemediationReviewImageBroker, Representation: RepresentationImageMetadata, NodeID: metadata.NodeID},
			})
			continue
		}
		if metadata.Status != ImageInspectionVerified {
			continue
		}
		if metadata.OCRStatus != ImageOCRComplete {
			a.add(findingSpec{
				code: "IMAGE_OCR_UNAVAILABLE", severity: SeverityWarning, dimension: DimensionImageMeaning,
				blocks: blockRefs(metadata.NodeID, "", ""), evidence: evidence,
				expected:    map[string]any{"ocr_status": ImageOCRComplete},
				observed:    map[string]any{"ocr_status": metadata.OCRStatus, "failure_code": metadata.OCRFailureCode},
				explanation: "The image was safely validated, but evidence-bound OCR was not completed; no OCR meaning success was inferred.",
				remediation: Remediation{Kind: RemediationReviewImageBroker, Representation: RepresentationImageOCR, NodeID: metadata.NodeID},
			})
			continue
		}
		if pattern := promptPattern(metadata.OCRText); pattern != "" {
			a.add(findingSpec{
				code: "IMAGE_OCR_PROMPT_MANIPULATION", severity: SeverityCritical, blocking: true, overridable: true,
				dimension: DimensionHiddenContent, blocks: blockRefs(metadata.NodeID, "", ""),
				evidence:    []EvidenceReference{{Representation: RepresentationImageOCR, NodeID: metadata.NodeID, SHA256: metadata.OCRTextSHA256}},
				observed:    map[string]any{"pattern": pattern, "ocr_text_sha256": metadata.OCRTextSHA256},
				explanation: "Safely extracted image text contains a high-confidence instruction-like manipulation pattern.",
				remediation: Remediation{Kind: RemediationRemoveManipulation, Representation: RepresentationRevision, NodeID: metadata.NodeID, Field: "content.image"},
			})
		}
	}
}

func (a *analysis) add(spec findingSpec) {
	if len(a.findings) >= MaxFindings-1 && spec.code != "FINDING_LIMIT_EXCEEDED" {
		a.truncated = true
		return
	}
	if spec.overridable && !spec.blocking {
		// Persistence intentionally forbids nonsensical advisory overrides.
		spec.overridable = false
	}
	if definition, exists := findingCatalog[spec.code]; exists {
		spec.dimension = definition.Dimension
	}
	sortBlockReferences(spec.blocks)
	sortEvidenceReferences(spec.evidence)
	if len(spec.blocks) > MaxEvidencePerFinding {
		spec.blocks = spec.blocks[:MaxEvidencePerFinding]
	}
	if len(spec.evidence) > MaxEvidencePerFinding {
		spec.evidence = spec.evidence[:MaxEvidencePerFinding]
	}
	expected := canonicalValue(spec.expected)
	observed := canonicalValue(spec.observed)
	identity := struct {
		Code        string              `json:"code"`
		Severity    Severity            `json:"severity"`
		Blocking    bool                `json:"blocking"`
		Overridable bool                `json:"overridable"`
		Dimension   Dimension           `json:"dimension"`
		ScenarioID  string              `json:"scenario_id"`
		Blocks      []BlockReference    `json:"block_references"`
		Evidence    []EvidenceReference `json:"evidence_references"`
		Expected    json.RawMessage     `json:"expected_value"`
		Observed    json.RawMessage     `json:"observed_value"`
		Detector    string              `json:"detector_version"`
		Policy      string              `json:"policy_version"`
	}{
		Code: spec.code, Severity: spec.severity, Blocking: spec.blocking,
		Overridable: spec.overridable, Dimension: spec.dimension,
		ScenarioID: strings.TrimSpace(a.input.Compilation.Artifact.ScenarioID),
		Blocks:     spec.blocks, Evidence: spec.evidence, Expected: expected,
		Observed: observed, Detector: DetectorVersion, Policy: a.policyVersion,
	}
	raw, _ := json.Marshal(identity)
	fingerprint := digestBytes(raw)
	if _, exists := a.deduplicate[fingerprint]; exists {
		return
	}
	a.deduplicate[fingerprint] = struct{}{}
	a.findings = append(a.findings, Finding{
		Fingerprint: fingerprint, Code: spec.code, SourceClass: "deterministic",
		Severity: spec.severity, Blocking: spec.blocking, Overridable: spec.overridable,
		Dimension: spec.dimension, ScenarioID: identity.ScenarioID,
		BlockReferences:    append([]BlockReference(nil), spec.blocks...),
		EvidenceReferences: append([]EvidenceReference(nil), spec.evidence...),
		ExpectedValue:      expected, ObservedValue: observed,
		Explanation: spec.explanation, Remediation: spec.remediation,
		TypedPatch: spec.patch, DetectorVersion: DetectorVersion, PolicyVersion: a.policyVersion,
	})
}

func (a *analysis) finalize() {
	if a.truncated {
		a.add(findingSpec{
			code: "FINDING_LIMIT_EXCEEDED", severity: SeverityCritical, blocking: true,
			dimension:   DimensionInput,
			expected:    map[string]any{"maximum_findings": MaxFindings},
			explanation: "The deterministic finding limit was reached; omitted checks cannot be interpreted as passing.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationRevision},
		})
	}
	sort.SliceStable(a.findings, func(i, j int) bool {
		left, right := a.findings[i], a.findings[j]
		if left.Code != right.Code {
			return left.Code < right.Code
		}
		if left.Dimension != right.Dimension {
			return left.Dimension < right.Dimension
		}
		return left.Fingerprint < right.Fingerprint
	})
}

func canonicalValue(value any) json.RawMessage {
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	if len(raw) > 32<<10 {
		raw, _ = json.Marshal(map[string]any{
			"bounded_summary": true, "bytes": len(raw), "sha256": digestBytes(raw),
		})
	}
	return raw
}

func sortBlockReferences(values []BlockReference) {
	sort.Slice(values, func(i, j int) bool {
		if values[i].BlockID != values[j].BlockID {
			return values[i].BlockID < values[j].BlockID
		}
		if values[i].FactID != values[j].FactID {
			return values[i].FactID < values[j].FactID
		}
		return values[i].ActionID < values[j].ActionID
	})
}

func sortEvidenceReferences(values []EvidenceReference) {
	sort.Slice(values, func(i, j int) bool {
		left, right := values[i], values[j]
		if left.Representation != right.Representation {
			return left.Representation < right.Representation
		}
		if left.Location != right.Location {
			return left.Location < right.Location
		}
		if left.NodeID != right.NodeID {
			return left.NodeID < right.NodeID
		}
		if left.SHA256 != right.SHA256 {
			return left.SHA256 < right.SHA256
		}
		return left.Detail < right.Detail
	})
}

func digestBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func normalizeText(value string) string {
	value = norm.NFKC.String(value)
	return strings.Join(strings.FieldsFunc(value, unicode.IsSpace), " ")
}

func containsNormalizedText(haystack, needle string) bool {
	haystack, needle = normalizeText(haystack), normalizeText(needle)
	if needle == "" {
		return false
	}
	for offset := 0; ; {
		index := strings.Index(haystack[offset:], needle)
		if index < 0 {
			return false
		}
		index += offset
		end := index + len(needle)
		leftOK := index == 0 || !isWordByte(haystack[index-1]) || !isWordByte(needle[0])
		rightOK := end == len(haystack) || !isWordByte(haystack[end]) || !isWordByte(needle[len(needle)-1])
		if leftOK && rightOK {
			return true
		}
		offset = index + 1
		if offset >= len(haystack) {
			return false
		}
	}
}

func isWordByte(value byte) bool {
	return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') || (value >= '0' && value <= '9') || value == '_'
}

func validBoundedText(value string, maximum int) bool {
	if value == "" || len(value) > maximum || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}
