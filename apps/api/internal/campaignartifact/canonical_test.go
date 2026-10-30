// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestCanonicalJSONIgnoresObjectKeyOrderAndWhitespace(t *testing.T) {
	t.Parallel()
	left, err := canonicalJSON(json.RawMessage(" { \"b\": 2, \"a\": [1, true] } "), "object")
	if err != nil {
		t.Fatalf("canonicalize left: %v", err)
	}
	right, err := canonicalJSON(json.RawMessage(`{"a":[1,true],"b":2}`), "object")
	if err != nil {
		t.Fatalf("canonicalize right: %v", err)
	}
	if string(left) != string(right) {
		t.Fatalf("canonical JSON differs: %s != %s", left, right)
	}
	leftHash, _ := digestJSON(left)
	rightHash, _ := digestJSON(right)
	if leftHash != rightHash || !validHash(leftHash) {
		t.Fatalf("canonical hashes differ or invalid: %q %q", leftHash, rightHash)
	}
}

func TestCanonicalJSONRejectsWrongShapeAndTrailingValue(t *testing.T) {
	t.Parallel()
	for name, input := range map[string]json.RawMessage{
		"wrong shape":    json.RawMessage(`[]`),
		"trailing value": json.RawMessage(`{} {}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := canonicalJSON(input, "object"); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error = %v, want ErrInvalidInput", err)
			}
		})
	}
}

func TestNormalizeArtifactInputsIsDeterministicAndClosed(t *testing.T) {
	t.Parallel()
	hash := strings.Repeat("a", 64)
	now := time.Now().UTC().Add(time.Hour)
	inputs := []ArtifactInput{
		{
			ScenarioID:             "z-last",
			Locale:                 "en-IN",
			FixtureID:              "default",
			SourceHash:             hash,
			HTMLHash:               hash,
			TextHash:               hash,
			MIMEStructureHash:      hash,
			OutboundMIMEHash:       hash,
			CompilerReceipt:        json.RawMessage(`{"b":2,"a":1}`),
			RepresentationManifest: json.RawMessage(`{}`),
			ExpiresAt:              &now,
		},
		{
			ScenarioID:             "a-first",
			Locale:                 "en-US",
			BranchKey:              "base",
			FixtureID:              "long-name",
			SourceHash:             hash,
			HTMLHash:               hash,
			TextHash:               hash,
			MIMEStructureHash:      hash,
			OutboundMIMEHash:       hash,
			CompilerReceipt:        json.RawMessage(`{}`),
			RepresentationManifest: json.RawMessage(`{}`),
		},
	}
	normalized, err := normalizeArtifactInputs(inputs)
	if err != nil {
		t.Fatalf("normalize artifacts: %v", err)
	}
	if normalized[0].ScenarioID != "a-first" || normalized[1].ScenarioID != "z-last" {
		t.Fatalf("artifacts not sorted by stable scenario identity: %+v", normalized)
	}
	if normalized[1].BranchKey != "default" {
		t.Fatalf("blank branch did not normalize: %+v", normalized[1])
	}
	if string(normalized[1].CompilerReceipt) != `{"a":1,"b":2}` {
		t.Fatalf("receipt not canonical: %s", normalized[1].CompilerReceipt)
	}

	duplicate := append([]ArtifactInput(nil), inputs[0], inputs[0])
	if _, err := normalizeArtifactInputs(duplicate); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("duplicate scenario error = %v, want ErrInvalidInput", err)
	}
	broken := inputs[0]
	broken.OutboundMIMEHash = "not-a-hash"
	if _, err := normalizeArtifactInputs([]ArtifactInput{broken}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid hash error = %v, want ErrInvalidInput", err)
	}
}

func TestComputePlanHashBindsContentButNotStorageOrRetention(t *testing.T) {
	t.Parallel()
	hash := strings.Repeat("a", 64)
	expires := time.Date(2026, time.August, 10, 12, 0, 0, 0, time.UTC)
	artifacts, err := normalizeArtifactInputs([]ArtifactInput{{
		ScenarioID:             "base-en-US",
		Locale:                 "en-US",
		FixtureID:              "default",
		SourceHash:             hash,
		HTMLHash:               hash,
		TextHash:               hash,
		MIMEStructureHash:      hash,
		OutboundMIMEHash:       hash,
		MIMEObjectRef:          "s3://evidence/original",
		CompilerReceipt:        json.RawMessage(`{"compiler":"v1"}`),
		RepresentationManifest: json.RawMessage(`{"plain_first":true}`),
		ExpiresAt:              &expires,
	}})
	if err != nil {
		t.Fatalf("normalize artifact: %v", err)
	}
	original, err := computePlanHash(strings.Repeat("b", 64), artifacts)
	if err != nil {
		t.Fatalf("compute original plan hash: %v", err)
	}

	moved := append([]ArtifactInput(nil), artifacts...)
	moved[0].MIMEObjectRef = "s3://rotated-bucket/same-bytes"
	later := expires.Add(24 * time.Hour)
	moved[0].ExpiresAt = &later
	afterMove, err := computePlanHash(strings.Repeat("b", 64), moved)
	if err != nil {
		t.Fatalf("compute moved plan hash: %v", err)
	}
	if afterMove != original {
		t.Fatalf("storage metadata changed plan identity: %s != %s", afterMove, original)
	}

	changed := append([]ArtifactInput(nil), artifacts...)
	changed[0].OutboundMIMEHash = strings.Repeat("c", 64)
	afterContentChange, err := computePlanHash(strings.Repeat("b", 64), changed)
	if err != nil {
		t.Fatalf("compute changed plan hash: %v", err)
	}
	if afterContentChange == original {
		t.Fatal("outbound MIME identity did not change plan hash")
	}
}
