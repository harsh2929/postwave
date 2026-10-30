// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/campaigntransform"
	"github.com/postwave/postwave/apps/api/internal/mimecomposer"
)

func analyzeManifest(a *analysis) {
	result := a.input.Compilation
	manifest := result.RepresentationManifest
	artifact := result.Artifact
	var persistedReceipt campaigncompiler.Receipt
	var persistedManifest campaigncompiler.RepresentationManifest
	receiptShapeBounded := len(result.Receipt.IncludedNodeIDs) <= MaxReceiptEntries &&
		len(result.Receipt.StructuredStatuses) <= MaxReceiptEntries &&
		len(result.Receipt.Transform.UTMParameters) <= MaxReceiptEntries
	manifestShapeBounded := len(manifest.AlternativeOrder) <= MaxReceiptEntries
	receiptValid := receiptShapeBounded && len(artifact.CompilerReceipt) <= MaxReceiptJSONBytes &&
		decodeStrictJSON(artifact.CompilerReceipt, &persistedReceipt) == nil && reflect.DeepEqual(persistedReceipt, result.Receipt)
	manifestValid := manifestShapeBounded && len(artifact.RepresentationManifest) <= MaxReceiptJSONBytes &&
		decodeStrictJSON(artifact.RepresentationManifest, &persistedManifest) == nil && reflect.DeepEqual(persistedManifest, manifest)
	if !receiptValid || !manifestValid {
		a.add(findingSpec{
			code: "ARTIFACT_RECEIPT_MISMATCH", severity: SeverityCritical,
			blocking: true, dimension: DimensionParity,
			evidence: []EvidenceReference{
				{Representation: RepresentationManifest, Location: "/artifact/compiler_receipt", SHA256: digestBytes(artifact.CompilerReceipt)},
				{Representation: RepresentationManifest, Location: "/artifact/representation_manifest", SHA256: digestBytes(artifact.RepresentationManifest)},
			},
			expected:    map[string]any{"compiler_receipt_matches": true, "representation_manifest_matches": true},
			observed:    map[string]any{"compiler_receipt_matches": receiptValid, "representation_manifest_matches": manifestValid},
			explanation: "The artifact's persisted JSON receipts do not match the typed compiler result being analyzed.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationManifest},
		})
	}

	if strings.TrimSpace(result.Receipt.CompilerVersion) != campaigncompiler.Version ||
		strings.TrimSpace(result.Receipt.MIMEFormat) != mimecomposer.FormatVersion ||
		strings.TrimSpace(result.Receipt.MIMEContentHash) != mimecomposer.ContentHashVersion ||
		strings.TrimSpace(result.Receipt.Transform.Version) != campaigntransform.Version {
		a.add(findingSpec{
			code: "COMPILER_RECEIPT_VERSION_MISMATCH", severity: SeverityCritical,
			blocking: true, dimension: DimensionParity,
			evidence: []EvidenceReference{{Representation: RepresentationManifest, Location: "/compiler_receipt"}},
			expected: map[string]any{
				"compiler": campaigncompiler.Version, "mime": mimecomposer.FormatVersion,
				"mime_content_hash": mimecomposer.ContentHashVersion, "transform": campaigntransform.Version,
			},
			observed: map[string]any{
				"compiler": result.Receipt.CompilerVersion, "mime": result.Receipt.MIMEFormat,
				"mime_content_hash": result.Receipt.MIMEContentHash, "transform": result.Receipt.Transform.Version,
			},
			explanation: "The compiler receipt does not identify the exact supported deterministic implementation suite.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationManifest},
		})
	}

	if manifest.Version != "postwave.representation-manifest.v1" ||
		manifest.SourceMode != a.input.Revision.SourceMode ||
		manifest.Locale != artifact.Locale ||
		!reflect.DeepEqual(manifest.AlternativeOrder, []string{"text/plain", "text/html"}) {
		a.add(findingSpec{
			code: "REPRESENTATION_MANIFEST_INVALID", severity: SeverityCritical,
			blocking: true, dimension: DimensionParity,
			evidence: []EvidenceReference{{Representation: RepresentationManifest, Location: "/"}},
			expected: map[string]any{
				"version": "postwave.representation-manifest.v1", "source_mode": a.input.Revision.SourceMode,
				"locale": artifact.Locale, "alternative_order": []string{"text/plain", "text/html"},
			},
			observed: map[string]any{
				"version": manifest.Version, "source_mode": manifest.SourceMode,
				"locale": manifest.Locale, "alternative_order": manifest.AlternativeOrder,
			},
			explanation: "The representation manifest is missing or contradicts the frozen compiler scenario.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationManifest},
		})
	}

	structuredHash := ""
	if len(result.StructuredData) != 0 {
		structuredHash = digestBytes(result.StructuredData)
	}
	actual := map[string]string{
		"source":     a.input.Revision.SourceHash,
		"html":       digestBytes([]byte(result.HTML)),
		"text":       digestBytes([]byte(result.Text)),
		"structured": structuredHash,
		"mime":       digestBytes(result.RFC822),
	}
	expected := map[string][]string{
		"source":     {artifact.SourceHash, result.Receipt.SourceHash},
		"html":       {manifest.HTMLSHA256, artifact.HTMLHash, result.Receipt.Transform.OutputHTMLSHA256},
		"text":       {manifest.TextSHA256, artifact.TextHash},
		"structured": {manifest.StructuredDataSHA256, artifact.StructuredDataHash},
		"mime":       {manifest.OutboundMIMESHA256, artifact.OutboundMIMEHash},
	}
	for representation, values := range expected {
		mismatch := false
		for _, value := range values {
			if value != actual[representation] {
				mismatch = true
				break
			}
		}
		if !mismatch {
			continue
		}
		a.add(findingSpec{
			code: "REPRESENTATION_HASH_MISMATCH", severity: SeverityCritical,
			blocking: true, dimension: DimensionParity,
			evidence:    []EvidenceReference{{Representation: RepresentationManifest, Location: "/hashes/" + representation}},
			expected:    map[string]any{"representation": representation, "content_sha256": actual[representation]},
			observed:    map[string]any{"manifest_hashes": values},
			explanation: "A compiled representation does not match its immutable hash receipt.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: representationFromName(representation)},
		})
	}

	wantStructureHash := digestMIMEStructure()
	if manifest.MIMEStructureSHA256 != wantStructureHash || artifact.MIMEStructureHash != wantStructureHash {
		a.add(findingSpec{
			code: "MIME_STRUCTURE_RECEIPT_MISMATCH", severity: SeverityCritical,
			blocking: true, dimension: DimensionMIME,
			evidence:    []EvidenceReference{{Representation: RepresentationManifest, Location: "/mime_structure_sha256"}},
			expected:    map[string]any{"mime_structure_sha256": wantStructureHash},
			observed:    map[string]any{"manifest": manifest.MIMEStructureSHA256, "artifact": artifact.MIMEStructureHash},
			explanation: "The MIME structure receipt is not the certified multipart/alternative shape.",
			remediation: Remediation{Kind: RemediationRecompileMIME, Representation: RepresentationMIME},
		})
	}

	present := len(result.StructuredData) != 0
	if manifest.StructuredDataPresent != present || (present && structuredHash == "") {
		a.add(findingSpec{
			code: "STRUCTURED_DATA_MANIFEST_MISMATCH", severity: SeverityCritical,
			blocking: true, dimension: DimensionStructuredData,
			evidence:    []EvidenceReference{{Representation: RepresentationManifest, Location: "/structured_data_present"}},
			expected:    map[string]any{"present": present},
			observed:    map[string]any{"present": manifest.StructuredDataPresent},
			explanation: "The structured-data presence flag contradicts the compiled representation.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationStructuredData},
		})
	}
	emittedStatuses := 0
	overclaimedStatuses := make([]string, 0)
	statusLimit := len(result.Receipt.StructuredStatuses)
	if statusLimit > MaxReceiptEntries {
		statusLimit = MaxReceiptEntries
	}
	for _, status := range result.Receipt.StructuredStatuses[:statusLimit] {
		if status.Valid && status.Emitted {
			emittedStatuses++
		}
		if status.ObservedDisplay != "unknown" || status.ComprehensionEffect != "unproven" {
			overclaimedStatuses = append(overclaimedStatuses, string(status.NodeID))
		}
	}
	if (present && emittedStatuses == 0) || (!present && emittedStatuses != 0) {
		a.add(findingSpec{
			code: "STRUCTURED_DATA_STATUS_MISMATCH", severity: SeverityCritical,
			blocking: true, dimension: DimensionStructuredData,
			evidence:    []EvidenceReference{{Representation: RepresentationManifest, Location: "/compiler_receipt/structured_statuses"}},
			expected:    map[string]any{"structured_data_present": present, "emitted_status_present": present},
			observed:    map[string]any{"structured_data_present": present, "emitted_status_count": emittedStatuses},
			explanation: "Structured-data bytes and compiler declaration statuses disagree about what was emitted.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationStructuredData},
		})
	}
	if len(overclaimedStatuses) != 0 {
		a.add(findingSpec{
			code: "STRUCTURED_STATUS_EVIDENCE_OVERCLAIM", severity: SeverityCritical,
			blocking: true, dimension: DimensionStructuredData,
			evidence:    []EvidenceReference{{Representation: RepresentationManifest, Location: "/compiler_receipt/structured_statuses"}},
			expected:    map[string]any{"observed_display": "unknown", "comprehension_effect": "unproven"},
			observed:    map[string]any{"overclaiming_node_ids": overclaimedStatuses},
			explanation: "A compiler receipt improperly claims provider display or comprehension evidence that deterministic compilation cannot observe.",
			remediation: Remediation{Kind: RemediationRegenerateProjection, Representation: RepresentationManifest},
		})
	}
}

func decodeStrictJSON(raw []byte, target any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		return errors.New("empty JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("trailing JSON")
		}
		return err
	}
	return nil
}

func digestMIMEStructure() string {
	value := struct {
		Version   string   `json:"version"`
		MediaType string   `json:"media_type"`
		Parts     []string `json:"parts"`
		Encoding  string   `json:"transfer_encoding"`
	}{
		Version: mimecomposer.FormatVersion, MediaType: "multipart/alternative",
		Parts:    []string{"text/plain; charset=UTF-8", "text/html; charset=UTF-8"},
		Encoding: "quoted-printable",
	}
	raw, _ := json.Marshal(value)
	return digestBytes(raw)
}

func representationFromName(value string) Representation {
	switch value {
	case "html":
		return RepresentationHTMLSource
	case "text":
		return RepresentationPlainText
	case "structured":
		return RepresentationStructuredData
	case "mime":
		return RepresentationMIME
	default:
		return RepresentationRevision
	}
}
