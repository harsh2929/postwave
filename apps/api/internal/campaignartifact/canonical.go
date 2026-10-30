// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	sha256Pattern      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	failureCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,95}$`)
)

const (
	maxVersionLength  = 160
	maxScenarioLength = 200
)

// canonicalJSON rejects trailing data and normalizes maps/number tokens through
// encoding/json. Go's encoder sorts map keys, so the same semantic value has a
// stable source hash independent of client key order or whitespace.
func canonicalJSON(raw json.RawMessage, expectedKind string) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		if expectedKind == "array" {
			raw = json.RawMessage(`[]`)
		} else {
			raw = json.RawMessage(`{}`)
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("%w: invalid JSON: %v", ErrInvalidInput, err)
	}
	if decoder.More() {
		return nil, fmt.Errorf("%w: trailing JSON data", ErrInvalidInput)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return nil, fmt.Errorf("%w: trailing JSON value", ErrInvalidInput)
	}
	switch expectedKind {
	case "object":
		if _, ok := value.(map[string]any); !ok {
			return nil, fmt.Errorf("%w: expected JSON object", ErrInvalidInput)
		}
	case "array":
		if _, ok := value.([]any); !ok {
			return nil, fmt.Errorf("%w: expected JSON array", ErrInvalidInput)
		}
	default:
		return nil, fmt.Errorf("%w: unsupported JSON kind", ErrInvalidInput)
	}
	normalized, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("%w: canonicalize JSON: %v", ErrInvalidInput, err)
	}
	return normalized, nil
}

func digestJSON(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func validVersion(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxVersionLength {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}

func validHash(value string) bool { return sha256Pattern.MatchString(value) }

func normalizeArtifactInputs(inputs []ArtifactInput) ([]ArtifactInput, error) {
	if len(inputs) == 0 {
		return nil, fmt.Errorf("%w: at least one artifact is required", ErrInvalidInput)
	}
	normalized := append([]ArtifactInput(nil), inputs...)
	seen := make(map[string]struct{}, len(normalized))
	for index := range normalized {
		artifact := &normalized[index]
		artifact.ScenarioID = strings.TrimSpace(artifact.ScenarioID)
		artifact.VariantID = strings.TrimSpace(artifact.VariantID)
		artifact.Locale = strings.TrimSpace(artifact.Locale)
		artifact.BranchKey = strings.TrimSpace(artifact.BranchKey)
		artifact.FixtureID = strings.TrimSpace(artifact.FixtureID)
		if artifact.BranchKey == "" {
			artifact.BranchKey = "default"
		}
		if artifact.ScenarioID == "" || len(artifact.ScenarioID) > maxScenarioLength ||
			artifact.Locale == "" || len(artifact.Locale) > 35 ||
			artifact.BranchKey == "" || len(artifact.BranchKey) > maxScenarioLength ||
			artifact.FixtureID == "" || len(artifact.FixtureID) > maxScenarioLength {
			return nil, fmt.Errorf("%w: invalid artifact scenario coordinate", ErrInvalidInput)
		}
		if _, duplicate := seen[artifact.ScenarioID]; duplicate {
			return nil, fmt.Errorf("%w: duplicate scenario_id %q", ErrInvalidInput, artifact.ScenarioID)
		}
		seen[artifact.ScenarioID] = struct{}{}
		for name, value := range map[string]string{
			"source_hash":         artifact.SourceHash,
			"html_hash":           artifact.HTMLHash,
			"text_hash":           artifact.TextHash,
			"mime_structure_hash": artifact.MIMEStructureHash,
			"outbound_mime_hash":  artifact.OutboundMIMEHash,
		} {
			if !validHash(value) {
				return nil, fmt.Errorf("%w: invalid %s", ErrInvalidInput, name)
			}
		}
		if artifact.StructuredDataHash != "" && !validHash(artifact.StructuredDataHash) {
			return nil, fmt.Errorf("%w: invalid structured_data_hash", ErrInvalidInput)
		}
		var err error
		artifact.CompilerReceipt, err = canonicalJSON(artifact.CompilerReceipt, "object")
		if err != nil {
			return nil, fmt.Errorf("compiler_receipt: %w", err)
		}
		artifact.RepresentationManifest, err = canonicalJSON(artifact.RepresentationManifest, "object")
		if err != nil {
			return nil, fmt.Errorf("representation_manifest: %w", err)
		}
	}
	sort.Slice(normalized, func(left, right int) bool {
		return normalized[left].ScenarioID < normalized[right].ScenarioID
	})
	return normalized, nil
}

// artifactHashInput is the durable identity of a compiled scenario. Object
// locations and retention timestamps are deliberately excluded: moving an
// encrypted object between buckets, rotating its wrapping key, or extending a
// synthetic fixture's retention must not make the compiled message a different
// plan. The hashes and receipts still bind every byte and compiler decision.
type artifactHashInput struct {
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

func computePlanHash(requestHash string, artifacts []ArtifactInput) (string, error) {
	identities := make([]artifactHashInput, len(artifacts))
	for index, artifact := range artifacts {
		identities[index] = artifactHashInput{
			ScenarioID:             artifact.ScenarioID,
			VariantID:              artifact.VariantID,
			Locale:                 artifact.Locale,
			BranchKey:              artifact.BranchKey,
			FixtureID:              artifact.FixtureID,
			SourceHash:             artifact.SourceHash,
			HTMLHash:               artifact.HTMLHash,
			TextHash:               artifact.TextHash,
			StructuredDataHash:     artifact.StructuredDataHash,
			MIMEStructureHash:      artifact.MIMEStructureHash,
			OutboundMIMEHash:       artifact.OutboundMIMEHash,
			CompilerReceipt:        artifact.CompilerReceipt,
			RepresentationManifest: artifact.RepresentationManifest,
		}
	}
	return digestJSON(struct {
		RequestHash string              `json:"request_hash"`
		Artifacts   []artifactHashInput `json:"artifacts"`
	}{RequestHash: requestHash, Artifacts: identities})
}
