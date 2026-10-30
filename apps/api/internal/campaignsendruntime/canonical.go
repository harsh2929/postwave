// SPDX-License-Identifier: AGPL-3.0-only

package campaignsendruntime

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
)

type revisionHashIdentity struct {
	SourceMode           string          `json:"source_mode"`
	ContentSchemaVersion int             `json:"content_schema_version"`
	Subject              string          `json:"subject"`
	PreviewText          *string         `json:"preview_text"`
	SemanticTree         json.RawMessage `json:"semantic_tree"`
	LegacyHTML           *string         `json:"legacy_html"`
	ReviewedPlainText    *string         `json:"reviewed_plain_text"`
	FactContract         json.RawMessage `json:"fact_contract"`
	Variants             json.RawMessage `json:"variants"`
	Locales              json.RawMessage `json:"locales"`
}

type planRequestHashIdentity struct {
	CampaignID        string          `json:"campaign_id"`
	ContentRevisionID string          `json:"content_revision_id"`
	RendererVersion   string          `json:"renderer_version"`
	CompilerVersion   string          `json:"compiler_version"`
	TransformManifest json.RawMessage `json:"transform_manifest"`
	CoverageManifest  json.RawMessage `json:"coverage_manifest"`
	FixtureSetVersion string          `json:"fixture_set_version"`
	PolicyVersion     string          `json:"policy_version"`
}

type artifactHashIdentity struct {
	ScenarioID             string          `json:"scenario_id"`
	VariantID              string          `json:"variant_id,omitempty"`
	Locale                 string          `json:"locale"`
	BranchKey              string          `json:"branch_key"`
	FixtureID              string          `json:"fixture_id"`
	SourceHash             string          `json:"source_hash"`
	HTMLHash               string          `json:"html_hash"`
	TextHash               string          `json:"text_hash"`
	StructuredDataHash     string          `json:"structured_data_hash,omitempty"`
	MIMEStructureHash      string          `json:"mime_structure_hash"`
	OutboundMIMEHash       string          `json:"outbound_mime_hash"`
	CompilerReceipt        json.RawMessage `json:"compiler_receipt"`
	RepresentationManifest json.RawMessage `json:"representation_manifest"`
}

func verifyRevisionSourceHash(revision campaignartifact.Revision) error {
	semanticTree, err := canonicalJSON(revision.SemanticTree, "array")
	if err != nil {
		return err
	}
	factContract, err := canonicalJSON(revision.FactContract, "object")
	if err != nil {
		return err
	}
	variants, err := canonicalJSON(revision.Variants, "array")
	if err != nil {
		return err
	}
	locales, err := canonicalJSON(revision.Locales, "array")
	if err != nil {
		return err
	}
	actual, err := digestJSON(revisionHashIdentity{
		SourceMode: revision.SourceMode, ContentSchemaVersion: revision.ContentSchemaVersion,
		Subject: revision.Subject, PreviewText: revision.PreviewText,
		SemanticTree: semanticTree, LegacyHTML: revision.LegacyHTML,
		ReviewedPlainText: revision.ReviewedPlainText, FactContract: factContract,
		Variants: variants, Locales: locales,
	})
	if err != nil || actual != revision.SourceHash {
		return fmt.Errorf("revision source hash differs from immutable content")
	}
	return nil
}

func verifyPlanHashes(plan campaignartifact.Plan, artifacts []campaignartifact.Artifact) error {
	transform, err := canonicalJSON(plan.TransformManifest, "object")
	if err != nil {
		return err
	}
	coverage, err := canonicalJSON(plan.CoverageManifest, "object")
	if err != nil {
		return err
	}
	requestHash, err := digestJSON(planRequestHashIdentity{
		CampaignID: plan.CampaignID, ContentRevisionID: plan.ContentRevisionID,
		RendererVersion: plan.RendererVersion, CompilerVersion: plan.CompilerVersion,
		TransformManifest: transform, CoverageManifest: coverage,
		FixtureSetVersion: plan.FixtureSetVersion, PolicyVersion: plan.PolicyVersion,
	})
	if err != nil || requestHash != plan.RequestHash {
		return fmt.Errorf("plan request hash differs from immutable plan input")
	}
	ordered := append([]campaignartifact.Artifact(nil), artifacts...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ScenarioID < ordered[j].ScenarioID })
	identities := make([]artifactHashIdentity, len(ordered))
	for index, artifact := range ordered {
		receipt, canonicalErr := canonicalJSON(artifact.CompilerReceipt, "object")
		if canonicalErr != nil {
			return canonicalErr
		}
		manifest, canonicalErr := canonicalJSON(artifact.RepresentationManifest, "object")
		if canonicalErr != nil {
			return canonicalErr
		}
		identities[index] = artifactHashIdentity{
			ScenarioID: artifact.ScenarioID, VariantID: artifact.VariantID,
			Locale: artifact.Locale, BranchKey: artifact.BranchKey, FixtureID: artifact.FixtureID,
			SourceHash: artifact.SourceHash, HTMLHash: artifact.HTMLHash, TextHash: artifact.TextHash,
			StructuredDataHash: artifact.StructuredDataHash,
			MIMEStructureHash:  artifact.MIMEStructureHash, OutboundMIMEHash: artifact.OutboundMIMEHash,
			CompilerReceipt: receipt, RepresentationManifest: manifest,
		}
	}
	actual, err := digestJSON(struct {
		RequestHash string                 `json:"request_hash"`
		Artifacts   []artifactHashIdentity `json:"artifacts"`
	}{RequestHash: requestHash, Artifacts: identities})
	if err != nil || plan.PlanHash == nil || actual != *plan.PlanHash {
		return fmt.Errorf("plan hash differs from immutable artifact set")
	}
	return nil
}

func canonicalJSON(raw json.RawMessage, kind string) (json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(bytes.TrimSpace(raw)))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing JSON")
	}
	switch kind {
	case "object":
		if _, ok := value.(map[string]any); !ok {
			return nil, errors.New("JSON object required")
		}
	case "array":
		if _, ok := value.([]any); !ok {
			return nil, errors.New("JSON array required")
		}
	default:
		return nil, errors.New("unsupported JSON kind")
	}
	return json.Marshal(value)
}

func digestJSON(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return digestBytes(raw), nil
}

func digestBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && hex.EncodeToString(decoded) == value
}
