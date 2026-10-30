// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestLoadCalibrationCorpusDirectory(t *testing.T) {
	directory := t.TempDir()
	example := calibrationCorpusExample(Machine, "machine-1")
	manifestBytes, examplesBytes := writeCalibrationCorpus(t, directory, ControlledMachineCorpus, []CalibrationExampleV2{example})

	corpus, err := LoadCalibrationCorpusDirectory(directory)
	require.NoError(t, err)
	manifest, err := corpus.Manifest(context.Background())
	require.NoError(t, err)
	require.Equal(t, "controlled-gmail", manifest.Name)
	require.Equal(t, ControlledMachineCorpus, manifest.Kind)
	require.Equal(t, 1, manifest.SampleCount)
	digest := sha256.Sum256(manifestBytes)
	require.Equal(t, hex.EncodeToString(digest[:]), manifest.ManifestHash)

	var loaded []LabeledExample
	require.NoError(t, corpus.ForEach(context.Background(), func(example LabeledExample) error {
		loaded = append(loaded, example)
		return nil
	}))
	require.Len(t, loaded, 1)
	require.Equal(t, "machine-1", loaded[0].ID)
	require.Equal(t, Machine, loaded[0].GroundTruth)
	require.Equal(t, "gmail", loaded[0].Provider)
	require.Equal(t, int64(1), loaded[0].Observation.ID)
	require.Equal(t, ObservationSchemaV1, loaded[0].Observation.EventSchemaVersion)
	require.Equal(t, 3*time.Second, loaded[0].Aggregate.BurstWindow)
	require.Equal(t, "message_recipient", manifest.SamplingUnit)
	require.Equal(t, calibrationSamplingUnitHash("machine-1"), loaded[0].SamplingUnitHash)
	require.Equal(t, int64(len(manifestBytes)+len(examplesBytes)), corpus.EvidenceBytes())

	// Loading takes an immutable, hash-verified snapshot. A later file change
	// cannot alter a report between Manifest and ForEach.
	require.NoError(t, os.WriteFile(filepath.Join(directory, "examples.jsonl"), []byte("{}\n"), 0o600))
	require.NoError(t, corpus.ForEach(context.Background(), func(example LabeledExample) error {
		require.Equal(t, "machine-1", example.ID)
		return nil
	}))
	require.NotEmpty(t, examplesBytes)
}

func TestFileCalibrationCorpusReturnsMutationIsolatedExamples(t *testing.T) {
	directory := t.TempDir()
	example := calibrationCorpusExample(Machine, "machine-isolated")
	asn := uint32(64512)
	dwell := int64(1250)
	links := 3
	example.NetworkASN = &asn
	example.NetworkASNSource = NetworkASNEdgeMeasured
	example.DwellMilliseconds = &dwell
	example.MessageLinkCount = &links
	example.OrderedHeaders = []Header{{Name: "X-Classifier", Value: "original"}}
	example.ProviderSignals = map[string]any{
		"nested": map[string]any{
			"items": []any{map[string]any{"value": "original"}},
		},
	}
	example.Aggregate.DeliveredAt = example.DeliveredAt
	example.Aggregate.OpenUserAgents = []string{"open-original"}
	example.Aggregate.ClickUserAgents = []string{"click-original"}
	writeCalibrationCorpus(t, directory, ControlledMachineCorpus, []CalibrationExampleV2{example})
	corpus, err := LoadCalibrationCorpusDirectory(directory)
	require.NoError(t, err)

	require.NoError(t, corpus.ForEach(context.Background(), func(exposed LabeledExample) error {
		exposed.Observation.OrderedHeaders[0].Value = "mutated"
		exposed.Observation.ProviderSignals["nested"].(map[string]any)["items"].([]any)[0].(map[string]any)["value"] = "mutated"
		*exposed.Observation.DeliveredAt = time.Time{}
		*exposed.Observation.NetworkASN = 1
		*exposed.Observation.DwellMilliseconds = 2
		*exposed.Observation.MessageLinkCount = 4
		*exposed.Aggregate.DeliveredAt = time.Time{}
		exposed.Aggregate.OpenUserAgents[0] = "mutated"
		exposed.Aggregate.ClickUserAgents[0] = "mutated"
		return nil
	}))

	require.NoError(t, corpus.ForEach(context.Background(), func(exposed LabeledExample) error {
		require.Equal(t, "original", exposed.Observation.OrderedHeaders[0].Value)
		require.Equal(t, "original", exposed.Observation.ProviderSignals["nested"].(map[string]any)["items"].([]any)[0].(map[string]any)["value"])
		require.False(t, exposed.Observation.DeliveredAt.IsZero())
		require.Equal(t, uint32(64512), *exposed.Observation.NetworkASN)
		require.Equal(t, int64(1250), *exposed.Observation.DwellMilliseconds)
		require.Equal(t, 3, *exposed.Observation.MessageLinkCount)
		require.False(t, exposed.Aggregate.DeliveredAt.IsZero())
		require.Equal(t, []string{"open-original"}, exposed.Aggregate.OpenUserAgents)
		require.Equal(t, []string{"click-original"}, exposed.Aggregate.ClickUserAgents)
		return nil
	}))

	bytesValue := []byte{1, 2, 3}
	clonedBytes := cloneCalibrationJSONValue(bytesValue).([]byte)
	clonedBytes[0] = 9
	require.Equal(t, byte(1), bytesValue[0])
}

func TestLoadCalibrationCorpusDirectoryWithEvidenceLimit(t *testing.T) {
	directory := t.TempDir()
	manifestBytes, examplesBytes := writeCalibrationCorpus(
		t,
		directory,
		ControlledMachineCorpus,
		[]CalibrationExampleV2{calibrationCorpusExample(Machine, "machine-budget")},
	)
	exactBytes := int64(len(manifestBytes) + len(examplesBytes))

	corpus, err := LoadCalibrationCorpusDirectoryWithEvidenceLimit(directory, exactBytes)
	require.NoError(t, err)
	require.Equal(t, exactBytes, corpus.EvidenceBytes())

	_, err = LoadCalibrationCorpusDirectoryWithEvidenceLimit(directory, exactBytes-1)
	require.ErrorContains(t, err, "evidence byte limit")
	_, err = LoadCalibrationCorpusDirectoryWithEvidenceLimit(directory, 0)
	require.ErrorContains(t, err, "evidence byte limit must be positive")
}

func TestLoadCalibrationCorpusDirectoryRejectsUnverifiedOrAmbiguousInput(t *testing.T) {
	t.Run("legacy contract without governed sampling units", func(t *testing.T) {
		directory := t.TempDir()
		manifestBytes, _ := writeCalibrationCorpus(t, directory, ControlledMachineCorpus, []CalibrationExampleV2{calibrationCorpusExample(Machine, "machine-1")})
		var manifest CalibrationCorpusManifestV2
		require.NoError(t, json.Unmarshal(manifestBytes, &manifest))
		manifest.ContractVersion = "postwave.engagement-calibration-corpus.v1"
		raw, err := json.Marshal(manifest)
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(directory, calibrationManifestFilename), raw, 0o600))
		_, err = LoadCalibrationCorpusDirectory(directory)
		require.ErrorContains(t, err, "manifest fields are invalid")
	})

	t.Run("missing sampling unit hash", func(t *testing.T) {
		directory := t.TempDir()
		example := calibrationCorpusExample(Machine, "machine-1")
		example.SamplingUnitHash = ""
		writeCalibrationCorpus(t, directory, ControlledMachineCorpus, []CalibrationExampleV2{example})
		_, err := LoadCalibrationCorpusDirectory(directory)
		require.ErrorContains(t, err, "sampling_unit_hash is invalid")
	})

	t.Run("examples digest", func(t *testing.T) {
		directory := t.TempDir()
		writeCalibrationCorpus(t, directory, ControlledMachineCorpus, []CalibrationExampleV2{calibrationCorpusExample(Machine, "machine-1")})
		require.NoError(t, os.WriteFile(filepath.Join(directory, "examples.jsonl"), []byte("{}\n"), 0o600))
		_, err := LoadCalibrationCorpusDirectory(directory)
		require.ErrorContains(t, err, "sha256 mismatch")
	})

	t.Run("unknown manifest field", func(t *testing.T) {
		directory := t.TempDir()
		_, examplesBytes := writeCalibrationCorpus(t, directory, ControlledMachineCorpus, []CalibrationExampleV2{calibrationCorpusExample(Machine, "machine-1")})
		digest := sha256.Sum256(examplesBytes)
		raw := `{"contract_version":"postwave.engagement-calibration-corpus.v2","name":"controlled-gmail","kind":"controlled_machine","version":"corpus.v1","provider":"gmail","sampling_unit":"message_recipient","sample_count":1,"examples_file":"examples.jsonl","examples_sha256":"` + hex.EncodeToString(digest[:]) + `","surprise":true}`
		require.NoError(t, os.WriteFile(filepath.Join(directory, calibrationManifestFilename), []byte(raw), 0o600))
		_, err := LoadCalibrationCorpusDirectory(directory)
		require.ErrorContains(t, err, "unknown field")
	})

	t.Run("duplicate manifest key", func(t *testing.T) {
		directory := t.TempDir()
		examplesBytes := []byte{}
		digest := sha256.Sum256(examplesBytes)
		raw := `{"contract_version":"postwave.engagement-calibration-corpus.v2","name":"first","name":"second","kind":"controlled_machine","version":"corpus.v1","provider":"gmail","sampling_unit":"message_recipient","sample_count":0,"examples_file":"examples.jsonl","examples_sha256":"` + hex.EncodeToString(digest[:]) + `"}`
		require.NoError(t, os.WriteFile(filepath.Join(directory, "examples.jsonl"), examplesBytes, 0o600))
		require.NoError(t, os.WriteFile(filepath.Join(directory, calibrationManifestFilename), []byte(raw), 0o600))
		_, err := LoadCalibrationCorpusDirectory(directory)
		require.ErrorContains(t, err, `duplicate JSON object key "name"`)
	})

	t.Run("unknown example field", func(t *testing.T) {
		directory := t.TempDir()
		examplesBytes := []byte(`{"id":"machine-1","ground_truth":"machine","source":"gmail","event_type":"open","occurred_at":"2026-08-13T00:00:00Z","raw_email":"forbidden"}` + "\n")
		writeCalibrationCorpusBytes(t, directory, ControlledMachineCorpus, 1, "examples.jsonl", examplesBytes)
		_, err := LoadCalibrationCorpusDirectory(directory)
		require.ErrorContains(t, err, "unknown field")
	})

	t.Run("duplicate nested evidence key", func(t *testing.T) {
		directory := t.TempDir()
		examplesBytes := []byte(`{"id":"machine-1","ground_truth":"machine","source":"gmail","event_type":"opened","occurred_at":"2026-08-13T00:00:00Z","provider_signals":{"scanner":true,"scanner":false}}` + "\n")
		writeCalibrationCorpusBytes(t, directory, ControlledMachineCorpus, 1, "examples.jsonl", examplesBytes)
		_, err := LoadCalibrationCorpusDirectory(directory)
		require.ErrorContains(t, err, `duplicate JSON object key "scanner"`)
	})

	t.Run("duplicate id", func(t *testing.T) {
		directory := t.TempDir()
		example := calibrationCorpusExample(Machine, "duplicate")
		writeCalibrationCorpus(t, directory, ControlledMachineCorpus, []CalibrationExampleV2{example, example})
		_, err := LoadCalibrationCorpusDirectory(directory)
		require.ErrorContains(t, err, "duplicate calibration example id")
	})

	t.Run("manifest count", func(t *testing.T) {
		directory := t.TempDir()
		exampleBytes, err := json.Marshal(calibrationCorpusExample(Machine, "machine-1"))
		require.NoError(t, err)
		writeCalibrationCorpusBytes(t, directory, ControlledMachineCorpus, 2, "examples.jsonl", append(exampleBytes, '\n'))
		_, err = LoadCalibrationCorpusDirectory(directory)
		require.ErrorContains(t, err, "manifest count=2 observed=1")
	})

	t.Run("truth contract", func(t *testing.T) {
		directory := t.TempDir()
		writeCalibrationCorpus(t, directory, ControlledMachineCorpus, []CalibrationExampleV2{calibrationCorpusExample(Human, "human-1")})
		_, err := LoadCalibrationCorpusDirectory(directory)
		require.ErrorContains(t, err, "controlled-machine truth must be machine")
	})

	t.Run("path traversal", func(t *testing.T) {
		directory := t.TempDir()
		writeCalibrationCorpusBytes(t, directory, ControlledMachineCorpus, 0, "../examples.jsonl", nil)
		_, err := LoadCalibrationCorpusDirectory(directory)
		require.ErrorContains(t, err, "examples_file")
	})

	t.Run("symbolic link", func(t *testing.T) {
		directory := t.TempDir()
		target := filepath.Join(directory, "target.jsonl")
		require.NoError(t, os.WriteFile(target, nil, 0o600))
		require.NoError(t, os.Symlink("target.jsonl", filepath.Join(directory, "examples.jsonl")))
		writeCalibrationManifest(t, directory, ControlledMachineCorpus, 0, "examples.jsonl", nil)
		_, err := LoadCalibrationCorpusDirectory(directory)
		require.ErrorContains(t, err, "must not be a symbolic link")
	})
}

func TestFileCalibrationCorpusHonorsContextAndVisitorErrors(t *testing.T) {
	directory := t.TempDir()
	writeCalibrationCorpus(t, directory, ControlledMachineCorpus, []CalibrationExampleV2{calibrationCorpusExample(Machine, "machine-1")})
	corpus, err := LoadCalibrationCorpusDirectory(directory)
	require.NoError(t, err)

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = corpus.Manifest(cancelled)
	require.ErrorIs(t, err, context.Canceled)
	err = corpus.ForEach(cancelled, func(LabeledExample) error { return nil })
	require.ErrorIs(t, err, context.Canceled)

	want := context.DeadlineExceeded
	err = corpus.ForEach(context.Background(), func(LabeledExample) error { return want })
	require.ErrorIs(t, err, want)
}

func calibrationCorpusExample(truth Classification, id string) CalibrationExampleV2 {
	deliveredAt := time.Date(2026, 8, 13, 11, 59, 0, 0, time.FixedZone("source", 5*60*60+30*60))
	occurredAt := deliveredAt.Add(2 * time.Second)
	return CalibrationExampleV2{
		ID: id, SamplingUnitHash: calibrationSamplingUnitHash(id),
		GroundTruth: truth, Source: "gmail", EventType: "open",
		OccurredAt: occurredAt, DeliveredAt: &deliveredAt,
		Aggregate: AggregateV1{EventCount: 2, BurstWindowMS: 3000},
	}
}

func calibrationSamplingUnitHash(id string) string {
	digest := sha256.Sum256([]byte("postwave.test.calibration-sampling-unit.v1\x00" + id))
	return hex.EncodeToString(digest[:])
}

func writeCalibrationCorpus(
	t *testing.T,
	directory string,
	kind CorpusKind,
	examples []CalibrationExampleV2,
) ([]byte, []byte) {
	t.Helper()
	var lines []string
	for _, example := range examples {
		raw, err := json.Marshal(example)
		require.NoError(t, err)
		lines = append(lines, string(raw))
	}
	examplesBytes := []byte(strings.Join(lines, "\n"))
	if len(examples) > 0 {
		examplesBytes = append(examplesBytes, '\n')
	}
	manifestBytes := writeCalibrationCorpusBytes(t, directory, kind, len(examples), "examples.jsonl", examplesBytes)
	return manifestBytes, examplesBytes
}

func writeCalibrationCorpusBytes(
	t *testing.T,
	directory string,
	kind CorpusKind,
	sampleCount int,
	examplesFile string,
	examplesBytes []byte,
) []byte {
	t.Helper()
	if examplesFile == "examples.jsonl" {
		require.NoError(t, os.WriteFile(filepath.Join(directory, examplesFile), examplesBytes, 0o600))
	}
	return writeCalibrationManifest(t, directory, kind, sampleCount, examplesFile, examplesBytes)
}

func writeCalibrationManifest(
	t *testing.T,
	directory string,
	kind CorpusKind,
	sampleCount int,
	examplesFile string,
	examplesBytes []byte,
) []byte {
	t.Helper()
	digest := sha256.Sum256(examplesBytes)
	manifest := CalibrationCorpusManifestV2{
		ContractVersion: CalibrationCorpusContractV2,
		Name:            "controlled-gmail",
		Kind:            kind,
		Version:         "corpus.v1",
		Provider:        "gmail",
		SamplingUnit:    "message_recipient",
		SampleCount:     sampleCount,
		ExamplesFile:    examplesFile,
		ExamplesSHA256:  hex.EncodeToString(digest[:]),
	}
	raw, err := json.Marshal(manifest)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(directory, calibrationManifestFilename), raw, 0o600))
	return raw
}
